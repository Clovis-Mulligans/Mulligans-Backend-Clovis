// src/services/escrowService.ts
// ============================================
// BULLETPROOF ESCROW SERVICE
// ============================================
// Handles automated escrow operations via cron jobs:
// - Auto-cancel unshipped orders after 5 days
// - Auto-release funds 3 days after delivery (with dispute/return checks)
// - Auto-process return refunds after 3 days
// - Auto-expire returns if buyer doesn't ship within 5 days
// - Flag potentially lost orders after 14 days
//
// SAFETY FEATURES:
// ✅ Dispute check - never release if dispute active
// ✅ Return check - never release if return in progress
// ✅ Idempotency keys - prevent double Stripe operations
// ✅ Transfer/Refund ID tracking - prevent duplicate processing
// ✅ Status verification - re-check before money movement
// ✅ Comprehensive logging for audit trail

import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import Stripe from 'stripe';
import { Shippo } from 'shippo';
import { sendEscrowReleased, sendReturnRefundProcessed, sendOrderCancellation } from './emailService';
import { sendPushNotification } from '../controllers/pushNotificationController';
import { ESCROW_RELEASE_DAYS, SHIPPING_DEADLINE_DAYS, RETURN_SHIPPING_DEADLINE_DAYS } from '../config/constants';
import { sendInspectionReminders } from './inspectionReminder';
import crypto from 'crypto';

const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// CONSTANTS
// ============================================
const LOST_IN_TRANSIT_DAYS = 14;         // Flag as potentially lost after 14 days
const PAYOUT_REMINDER_INTERVAL_DAYS = 3; // Re-remind seller every 3 days while payout blocked
const PAYOUT_ADMIN_ESCALATION_DAYS = 14; // Escalate to admin after 14 days blocked
const GRACE_WINDOW_DAYS = 3;             // Days after deadline before admin escalation

// Forced return auto-confirm deadlines (imported from forcedReturnService for reference)
import { FORCED_RETURN_SELLER_CONFIRM_DAYS, FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS } from './forcedReturnService';

// Dispute statuses that BLOCK escrow release
const BLOCKING_DISPUTE_STATUSES = ['open', 'counter_offered', 'escalated'];

// Return statuses that BLOCK escrow release
const BLOCKING_RETURN_STATUSES = ['pending', 'approved', 'awaiting_address', 'label_created', 'shipped', 'delivered', 'refund_processing'];

// ============================================
// HELPER: Check if order has blocking dispute
// ============================================
export async function hasBlockingDispute(orderId: string): Promise<boolean> {
  const dispute = await prisma.disputes.findUnique({
    where: { order_id: orderId },
    select: { status: true },
  });
  
  if (!dispute) return false;
  return BLOCKING_DISPUTE_STATUSES.includes(dispute.status);
}

// ============================================
// HELPER: Check if order has blocking return
// ============================================
export async function hasBlockingReturn(orderId: string): Promise<boolean> {
  const returnRequest = await prisma.return_requests.findFirst({
    where: { 
      order_id: orderId,
      status: { in: BLOCKING_RETURN_STATUSES },
    },
    select: { status: true },
  });
  
  return !!returnRequest;
}

// ============================================
// HELPER: Check if return has blocking dispute
// (Seller disputes the returned item condition)
// ============================================
async function returnHasBlockingDispute(orderId: string): Promise<boolean> {
  // Check if there's a dispute on this order that was created AFTER return was delivered
  const returnRequest = await prisma.return_requests.findFirst({
    where: { 
      order_id: orderId,
      status: 'delivered',
    },
    select: { delivered_at: true },
  });

  if (!returnRequest?.delivered_at) return false;

  const dispute = await prisma.disputes.findUnique({
    where: { order_id: orderId },
    select: { status: true, created_at: true },
  });

  if (!dispute) return false;
  
  // If dispute was created after return delivery and is still active
  if (dispute.created_at > returnRequest.delivered_at && 
      BLOCKING_DISPUTE_STATUSES.includes(dispute.status)) {
    return true;
  }

  return false;
}

// ============================================
// HELPER: Update user's average rating
// ============================================
async function updateUserRating(userId: string): Promise<void> {
  try {
    const reviews = await prisma.reviews.findMany({
      where: {
        reviewed_user_id: userId,
        is_public: true,
      },
      select: { rating: true },
    });

    if (reviews.length === 0) return;

    const averageRating = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

    await prisma.users.update({
      where: { id: userId },
      data: {
        rating: Math.round(averageRating * 100) / 100,
        updated_at: new Date(),
      },
    });

    console.log(`[ESCROW] Updated rating for user ${userId}: ${averageRating.toFixed(2)}`);
  } catch (error: any) {
    console.error(`[ESCROW] Failed to update rating for user ${userId}:`, error.message);
  }
}

// ============================================
// HELPER: Check if seller can receive a payout
// ============================================
function sellerCanReceivePayout(seller: { stripe_connect_id: string | null; stripe_connect_status?: string | null }): boolean {
  return !!seller.stripe_connect_id && seller.stripe_connect_status === 'active';
}

// ============================================
// AUTO-CANCEL UNSHIPPED ORDERS
// Runs daily - cancels orders not shipped within 5 days
// ============================================
export async function autoCancelUnshippedOrders(): Promise<void> {
  console.log('[ESCROW] Running auto-cancel check for unshipped orders...');

  try {
    const now = new Date();

    const overdueOrders = await prisma.orders.findMany({
      where: {
        status: 'to_ship',
        auto_cancel_at: {
          lte: now,
        },
        // Safety: Don't cancel if already refunded
        refunded_at: null,
      },
      include: {
        listings: {
          select: {
            id: true,
            title: true,
            images: {
              take: 1,
              orderBy: PRIMARY_IMAGE_ORDER,
            },
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            email: true,
            shipping_strikes: true,
            display_name: true,
          },
        },
        users_orders_buyer_idTousers: {
          select: {
            id: true,
            email: true,
            display_name: true,
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${overdueOrders.length} overdue orders to cancel`);

    for (const order of overdueOrders) {
      try {
        console.log(`[ESCROW] Processing auto-cancel for order ${order.id}`);

        // ✅ SAFETY: Re-verify status hasn't changed
        const freshOrder = await prisma.orders.findUnique({
          where: { id: order.id },
          select: { status: true, refunded_at: true, stripe_refund_id: true },
        });

        if (freshOrder?.status !== 'to_ship') {
          console.log(`[ESCROW] ⚠️ Order ${order.id} status changed to ${freshOrder?.status}, skipping`);
          continue;
        }

        if (freshOrder?.refunded_at || freshOrder?.stripe_refund_id) {
          console.log(`[ESCROW] ⚠️ Order ${order.id} already refunded, skipping`);
          continue;
        }

        console.log(`[ESCROW] Auto-cancelling order ${order.id} - seller didn't ship within ${SHIPPING_DEADLINE_DAYS} days`);

        let refundId: string | null = null;

        // 1. Refund the buyer via Stripe
        if (order.stripe_payment_intent_id) {
          try {
            const refund = await stripe.refunds.create({
              payment_intent: order.stripe_payment_intent_id,
              reason: 'requested_by_customer',
              metadata: {
                order_id: order.id,
                reason: 'seller_did_not_ship',
                auto_cancelled: 'true',
              },
            }, {
              idempotencyKey: `auto_cancel_refund_${order.id}`, // ✅ Prevent double refund
            });
            
            refundId = refund.id;
            console.log(`[ESCROW] ✅ Refund created: ${refund.id} for order ${order.id}`);
          } catch (refundError: any) {
            // Check if it's a duplicate (already refunded)
            if (refundError.code === 'charge_already_refunded') {
              console.log(`[ESCROW] ⚠️ Order ${order.id} already refunded in Stripe`);
            } else {
              console.error(`[ESCROW] ❌ Refund failed for order ${order.id}:`, refundError.message);
              continue; // Don't update status if refund failed
            }
          }
        }

        // 2. Update order status (ONLY after successful refund)
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: 'cancelled',
            cancelled_at: now,
            cancel_reason: 'auto_cancelled_not_shipped',
            refunded_at: now,
            refund_amount: order.amount,
            stripe_refund_id: refundId,
            updated_at: now,
          },
        });

        // 2b. Fire-and-forget Shippo label refund if a label was purchased
        if (order.shippo_transaction_id) {
          shippo.refunds.create({ transaction: order.shippo_transaction_id })
            .then((refund: any) => {
              console.log(JSON.stringify({
                event: 'shippo_label_refund',
                order_id: order.id,
                transaction_id: order.shippo_transaction_id,
                success: true,
                refund_id: refund.objectId,
                trigger: 'auto_cancel',
              }));
            })
            .catch((error: any) => {
              console.log(JSON.stringify({
                event: 'shippo_label_refund',
                order_id: order.id,
                transaction_id: order.shippo_transaction_id,
                success: false,
                error: error.message,
                trigger: 'auto_cancel',
              }));
            });
        }

        // 3. Relist the item
        if (order.listing_id) {
          await prisma.listings.update({
            where: { id: order.listing_id },
            data: {
              status: 'active',
              updated_at: now,
            },
          });
          console.log(`[ESCROW] Relisted item: ${order.listing_id}`);
        }

        // 4. Increment seller's shipping strikes
        const seller = order.users_orders_seller_idTousers;
        const newStrikeCount = (seller.shipping_strikes || 0) + 1;

        await prisma.users.update({
          where: { id: seller.id },
          data: {
            shipping_strikes: newStrikeCount,
            updated_at: now,
          },
        });

        // 5. If this is 2nd+ strike, create automatic 1-star review
       if (newStrikeCount >= 2) {
          try {
            console.log(`[ESCROW] Seller ${seller.id} has ${newStrikeCount} strikes - creating auto-review`);
            await prisma.reviews.create({
              data: {
                id: `review_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                order_id: order.id,
                reviewer_id: 'system',
                reviewed_user_id: seller.id,
                rating: 1,
                review_text: 'Order automatically cancelled - seller did not ship within the required timeframe.',
                review_type: 'seller',
                is_public: true,
                created_at: now,
              },
            });
            await updateUserRating(seller.id);
            console.log(`[ESCROW] Auto-review created for seller ${seller.id}`);
          } catch (reviewError) {
            console.error(`[ESCROW] ⚠️ Failed to create auto-review for seller ${seller.id}, continuing with cancellation:`, reviewError);
          }
        }

        // 6. Notify buyer
        const listingImage = order.listings?.images?.[0]?.image_url || null;
        const listingTitle = order.listings?.title || 'Your item';

        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: order.buyer_id,
            type: 'order_cancelled',
            title: 'Order Cancelled - Full Refund Issued',
            message: `Your order for "${listingTitle}" was cancelled because the seller didn't ship in time. A full refund has been processed.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            order.buyer_id,
            'Order Cancelled - Refund Issued',
            `Your order for "${listingTitle}" was cancelled. Full refund processed.`,
            { type: 'order_cancelled', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to buyer failed:', pushErr);
        }

        // 7. Notify seller
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'order_cancelled',
            title: 'Order Cancelled - Shipping Deadline Missed',
            message: `Your order for "${listingTitle}" was automatically cancelled because it wasn't shipped within ${SHIPPING_DEADLINE_DAYS} days. ${newStrikeCount >= 2 ? 'A 1-star review has been added to your profile.' : 'This is your first warning.'}`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify seller
        try {
          await sendPushNotification(
            seller.id,
            'Order Cancelled - Deadline Missed',
            `Your order for "${listingTitle}" was cancelled. Ship within ${SHIPPING_DEADLINE_DAYS} days next time.`,
            { type: 'order_cancelled', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        // EMAIL: Send cancellation emails to both parties
        try {
          const buyer = order.users_orders_buyer_idTousers;
          if (buyer?.email) {
            await sendOrderCancellation(buyer.email, {
              recipientName: buyer.display_name || 'there',
              orderNumber: order.id,
              itemTitle: listingTitle,
              cancelReason: 'Seller did not ship within the required timeframe',
              cancellationMessage: `Your order for "${listingTitle}" was automatically cancelled because the seller didn't ship it within ${SHIPPING_DEADLINE_DAYS} days.`,
              refundMessage: 'A full refund has been issued to your original payment method. Please allow 5-10 business days for it to appear.',
              itemImageUrl: listingImage || order.listing_image || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
            });
            console.log(`[ESCROW] ✅ Cancellation email sent to buyer: ${buyer.email}`);
          }

          if (seller?.email) {
            await sendOrderCancellation(seller.email, {
              recipientName: seller.display_name || 'there',
              orderNumber: order.id,
              itemTitle: listingTitle,
              cancelReason: 'Shipping deadline missed',
              cancellationMessage: `Your order for "${listingTitle}" was automatically cancelled because it wasn't shipped within ${SHIPPING_DEADLINE_DAYS} days.`,
              refundMessage: 'A refund has been issued to the buyer.',
              itemImageUrl: listingImage || order.listing_image || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
            });
            console.log(`[ESCROW] ✅ Cancellation email sent to seller: ${seller.email}`);
          }
        } catch (emailErr) {
          console.error('[ESCROW] Cancellation email failed (non-fatal):', emailErr);
        }

        console.log(`[ESCROW] ✅ Order ${order.id} cancelled successfully`);
      } catch (orderError: any) {
        console.error(`[ESCROW] ❌ Failed to cancel order ${order.id}:`, orderError.message);
      }
    }

    console.log('[ESCROW] Auto-cancel check complete');
  } catch (error: any) {
    console.error('[ESCROW] Auto-cancel job failed:', error.message);
  }
}

// ============================================
// AUTO-RELEASE ESCROW
// Runs daily - releases funds for delivered orders after 3 days
// ✅ BULLETPROOF: Checks for disputes AND returns before releasing
// ✅ FIXED: Groups orders by tracking_number to prevent double shipping charges
// ============================================
export async function autoReleaseEscrow(): Promise<void> {
  console.log('[ESCROW] Running escrow release check...');

  try {
    const now = new Date();

    // Query orders ready for release
    const ordersToRelease = await prisma.orders.findMany({
      where: {
        status: 'delivered',
        escrow_release_at: {
          lte: now,
          not: null,
        },
        // ✅ SAFETY: Must not already have a transfer
        stripe_transfer_id: null,
      },
      include: {
        listings: {
          select: {
            title: true,
            images: {
              take: 1,
              orderBy: PRIMARY_IMAGE_ORDER,
            },
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            stripe_connect_id: true,
            stripe_connect_status: true,
            display_name: true,
            email: true,
          },
        },
        disputes: {
          select: { status: true },
        },
        return_requests: {
          select: { status: true },
        },
      },
    });

    console.log(`[ESCROW] Found ${ordersToRelease.length} orders to check for escrow release`);

    if (ordersToRelease.length === 0) {
      console.log('[ESCROW] No orders to release');
      return;
    }

    // ============================================
    // GROUP ORDERS BY TRACKING NUMBER
    // Orders shipped together should be paid out together
    // ============================================
    const ordersByTracking: { [key: string]: typeof ordersToRelease } = {};
    
    for (const order of ordersToRelease) {
      // Use tracking_number if available, otherwise use order.id as fallback
      // This handles legacy orders without tracking numbers
      const groupKey = order.tracking_number || `single_${order.id}`;
      
      if (!ordersByTracking[groupKey]) {
        ordersByTracking[groupKey] = [];
      }
      ordersByTracking[groupKey].push(order);
    }

    console.log(`[ESCROW] Grouped into ${Object.keys(ordersByTracking).length} tracking groups`);

    // ============================================
    // PROCESS EACH TRACKING GROUP
    // ============================================
    for (const [trackingKey, orders] of Object.entries(ordersByTracking)) {
      const isMultiOrderGroup = !trackingKey.startsWith('single_');
      const firstOrder = orders[0];
      const seller = firstOrder.users_orders_seller_idTousers;
      
      console.log(`[ESCROW] Processing group "${trackingKey}" with ${orders.length} order(s)`);

      try {
        // ✅ SAFETY CHECK 1: Re-verify ALL orders in group still ready
        let allOrdersReady = true;
        for (const order of orders) {
          const freshOrder = await prisma.orders.findUnique({
            where: { id: order.id },
            select: { 
              status: true, 
              stripe_transfer_id: true,
              escrow_release_at: true,
            },
          });

          if (freshOrder?.status !== 'delivered') {
            console.log(`[ESCROW] ⚠️ Order ${order.id} status changed to ${freshOrder?.status}, skipping group`);
            allOrdersReady = false;
            break;
          }

          if (freshOrder?.stripe_transfer_id) {
            console.log(`[ESCROW] ⚠️ Order ${order.id} already has transfer, skipping group`);
            allOrdersReady = false;
            break;
          }
        }

        if (!allOrdersReady) continue;

        // ✅ SAFETY CHECK 2: Check for active disputes on ANY order in group
        let hasDispute = false;
        for (const order of orders) {
          if (await hasBlockingDispute(order.id)) {
            console.log(`[ESCROW] ⚠️ Order ${order.id} has active dispute, skipping group`);
            hasDispute = true;
            break;
          }
        }
        if (hasDispute) continue;

        // ✅ SAFETY CHECK 3: Check for active returns on ANY order in group
        let hasReturn = false;
        for (const order of orders) {
          if (await hasBlockingReturn(order.id)) {
            console.log(`[ESCROW] ⚠️ Order ${order.id} has active return, skipping group`);
            hasReturn = true;
            break;
          }
        }
        if (hasReturn) continue;

        console.log(`[ESCROW] ✅ Group "${trackingKey}" passed all safety checks`);

        // ============================================
        // CALCULATE CORRECT PAYOUT FOR GROUP
        // ============================================
        // Seller receives item price only — platform retains shipping and pays label cost
        const actualPayout = orders.reduce((sum, o) => {
          const payout = o.seller_payout ? parseFloat(o.seller_payout.toString()) : parseFloat(o.amount.toString());
          return sum + payout;
        }, 0);

        const isAutoShipped = orders.some(o => (o as any).label_auto_generated === true);

        console.log(`[ESCROW] Payout calculation for group "${trackingKey}" (${isAutoShipped ? 'AUTO-SHIPPED' : 'MANUAL'}):`);
        console.log(`  - Items total (${orders.length} orders): £${actualPayout.toFixed(2)}`);
        console.log(`  - Seller receives (item price only): £${actualPayout.toFixed(2)}`);

        // Safety check: Don't transfer negative or zero amounts
        if (actualPayout <= 0) {
          console.error(`[ESCROW] ❌ Cannot transfer £${actualPayout.toFixed(2)} - marking group as completed without transfer`);
          
          // Mark all orders as completed
          for (const order of orders) {
            await prisma.orders.update({
              where: { id: order.id },
              data: {
                status: 'completed',
                completed_at: now,
                updated_at: now,
              },
            });
          }

          // Notify seller about the issue
          await prisma.notifications.create({
            data: {
              id: crypto.randomUUID(),
              user_id: seller.id,
              type: 'payout',
              title: 'Order Completed - No Payout Due',
              message: 'Order completed but the payout amount was zero — no transfer created.',
              related_id: firstOrder.id,
            },
          });

          continue;
        }

        // ============================================
        // BLOCKED PAYOUT CHECK — SAFETY NET
        // If seller cannot receive payout, track it, remind, escalate
        // ============================================
        if (!sellerCanReceivePayout(seller)) {
          const blockedReason = !seller.stripe_connect_id
            ? 'no_stripe_connect_id'
            : `stripe_status_${seller.stripe_connect_status || 'null'}`;

          console.warn(`[ESCROW] Seller ${seller.id} cannot receive payout (${blockedReason}) — processing blocked-payout safety net`);

          for (const order of orders) {
            const wasAlreadyBlocked = !!(order as any).payout_blocked_at;
            const blockedAt = wasAlreadyBlocked
              ? new Date((order as any).payout_blocked_at)
              : now;
            const daysSinceBlocked = wasAlreadyBlocked
              ? Math.floor((now.getTime() - blockedAt.getTime()) / (24 * 60 * 60 * 1000))
              : 0;

            const lastReminderAt = (order as any).payout_reminder_sent_at
              ? new Date((order as any).payout_reminder_sent_at)
              : null;
            const daysSinceReminder = lastReminderAt
              ? Math.floor((now.getTime() - lastReminderAt.getTime()) / (24 * 60 * 60 * 1000))
              : Infinity;

            // First time blocked: set the payout_blocked_at timestamp
            if (!wasAlreadyBlocked) {
              await prisma.orders.update({
                where: { id: order.id },
                data: {
                  payout_blocked_at: now,
                  payout_reminder_sent_at: now,
                  updated_at: now,
                },
              });
            }

            // Send notification if first time OR 3+ days since last reminder
            const shouldRemind = !wasAlreadyBlocked || daysSinceReminder >= PAYOUT_REMINDER_INTERVAL_DAYS;

            if (shouldRemind) {
              const listingTitle = order.listings?.title || order.listing_title || 'your item';
              const payoutAmount = actualPayout.toFixed(2);

              try {
                await prisma.notifications.create({
                  data: {
                    id: crypto.randomUUID(),
                    user_id: seller.id,
                    type: 'payout',
                    title: wasAlreadyBlocked ? 'Reminder: Complete Payment Setup' : 'Action Required: Set Up Payment',
                    message: `£${payoutAmount} for "${listingTitle}" is ready for you — complete your payment setup to withdraw it.`,
                    related_id: order.id,
                  },
                });

                await sendPushNotification(
                  seller.id,
                  wasAlreadyBlocked ? 'Reminder: Complete Payment Setup' : 'Action Required: Set Up Payment',
                  `£${payoutAmount} is ready — complete your payment setup to withdraw.`,
                  { type: 'payout_blocked', order_id: order.id }
                ).catch(err => console.error('[ESCROW] Push to seller failed:', err));

                if (wasAlreadyBlocked) {
                  await prisma.orders.update({
                    where: { id: order.id },
                    data: { payout_reminder_sent_at: now, updated_at: now },
                  });
                }

                console.log(`[ESCROW] ${wasAlreadyBlocked ? 'Reminder' : 'Initial'} notification sent to seller ${seller.id} for blocked payout on order ${order.id}`);
              } catch (notifErr) {
                console.error('[ESCROW] Failed to notify seller about blocked payout:', notifErr);
              }
            } else {
              console.log(`[ESCROW] Skipping reminder for order ${order.id} — last sent ${daysSinceReminder} day(s) ago`);
            }

            // 14-day admin escalation
            if (daysSinceBlocked >= PAYOUT_ADMIN_ESCALATION_DAYS) {
              const existingTicket = await prisma.support_tickets.findFirst({
                where: { order_id: order.id, type: 'payout_blocked' },
              });

              if (!existingTicket) {
                try {
                  await prisma.support_tickets.create({
                    data: {
                      id: crypto.randomUUID(),
                      user_id: seller.id,
                      type: 'payout_blocked',
                      order_id: order.id,
                      subject: `[STUCK PAYOUT] Order ${order.id} — seller payout blocked ${daysSinceBlocked}+ days`,
                      message: `Order ${order.id} has had its payout blocked for ${daysSinceBlocked} days.\n\nSeller: ${seller.display_name || 'Unknown'} (${seller.id})\nSeller email: ${seller.email || 'N/A'}\nSeller Stripe status: ${seller.stripe_connect_status || 'none'}\nStripe Connect ID: ${seller.stripe_connect_id ? 'exists' : 'missing'}\nOrder amount: £${parseFloat(order.amount.toString()).toFixed(2)}\nPayout amount: £${actualPayout.toFixed(2)}\nBlocked since: ${blockedAt.toISOString()}\n\nThe seller has not completed Stripe Connect onboarding. Manual follow-up required.`,
                      status: 'open',
                      priority: 'high',
                      created_at: now,
                    },
                  });
                  console.log(`[ESCROW] ⚠️ Admin ticket created for stuck payout on order ${order.id} (${daysSinceBlocked} days blocked)`);
                } catch (ticketErr) {
                  console.error('[ESCROW] Failed to create admin ticket for stuck payout:', ticketErr);
                }
              }
            }
          }

          // Do NOT mark as completed — leave in delivered so cron retries next run
          continue;
        }

        // ============================================
        // CREATE STRIPE TRANSFER
        // (Seller has active Stripe Connect — proceed with payout)
        // ============================================
        const transferAmountPence = Math.round(actualPayout * 100);
        let transferId: string | null = null;
        const orderIds = orders.map(o => o.id).join(',');

        // Belt-and-braces: sellerCanReceivePayout() already guarantees this is non-null,
        // but guard the money path explicitly so TS narrows the type and future refactors stay safe.
        if (!seller.stripe_connect_id) {
          console.error(`[ESCROW] Unexpected: reached transfer with no stripe_connect_id for seller ${seller.id} — skipping`);
          continue;
        }

        try {
          const transfer = await stripe.transfers.create({
            amount: transferAmountPence,
            currency: 'gbp',
            destination: seller.stripe_connect_id,
            metadata: {
              tracking_number: trackingKey.startsWith('single_') ? 'none' : trackingKey,
              order_ids: orderIds,
              order_count: orders.length.toString(),
              actual_payout: actualPayout.toFixed(2),
              released_at: now.toISOString(),
            },
          }, {
            idempotencyKey: `escrow_release_group_${trackingKey}`, // ✅ Prevent double transfer
          });

          transferId = transfer.id;
          console.log(`[ESCROW] ✅ Transfer ${transfer.id} created for £${actualPayout.toFixed(2)} (${orders.length} orders)`);
        } catch (transferError: any) {
          console.error(`[ESCROW] ❌ Transfer failed for group ${trackingKey}:`, transferError.message);
          continue; // Don't update status if transfer failed
        }

        // ============================================
        // UPDATE ALL ORDERS IN GROUP
        // ============================================
        for (const order of orders) {
          await prisma.orders.update({
            where: { id: order.id },
            data: {
              status: 'completed',
              completed_at: now,
              stripe_transfer_id: transferId, // ✅ Same transfer ID for all orders
              payout_blocked_at: null,
              payout_reminder_sent_at: null,
              updated_at: now,
            },
          });
        }

        // Update seller's total_sales count (once per order, not per group)
        await prisma.users.update({
          where: { id: seller.id },
          data: {
            total_sales: { increment: orders.length },
            updated_at: now,
          },
        });

        // Update buyer's total_purchases count
        await prisma.users.update({
          where: { id: firstOrder.buyer_id },
          data: {
            total_purchases: { increment: orders.length },
            updated_at: now,
          },
        });

        // ============================================
        // NOTIFY SELLER
        // ============================================
        const listingImage = firstOrder.listings?.images?.[0]?.image_url || null;
        const payoutAmount = actualPayout.toFixed(2);
        
        // Build notification message
        let itemDescription: string;
        if (orders.length === 1) {
          itemDescription = firstOrder.listings?.title || 'Your item';
        } else {
          itemDescription = `${orders.length} items`;
        }

        const notificationMessage = `£${payoutAmount} for "${itemDescription}" has been transferred to your account.`;

        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'payout',
            title: 'Payment Released!',
            message: notificationMessage,
            image_url: listingImage,
            related_id: firstOrder.id,
          },
        });

        // PUSH: Notify seller of payout
        try {
          await sendPushNotification(
            seller.id,
            'Payment Released!',
            `£${payoutAmount} for "${itemDescription}" is on its way to your bank.`,
            { type: 'payout', order_id: firstOrder.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        // EMAIL: Send escrow released email to seller
        if (seller.email) {
          try {
            await sendEscrowReleased(seller.email, {
              itemTitle: itemDescription,
              orderNumber: orders.length === 1 ? firstOrder.id : `${orders.length} orders`,
              salePrice: actualPayout.toFixed(2),
              fees: '0.00',
              payoutAmount: payoutAmount,
              sellerName: seller.display_name || 'Seller',
              itemName: itemDescription,
              itemImageUrl: firstOrder.listings?.images?.[0]?.image_url || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${actualPayout.toFixed(2)}`,
              earningsUrl: '#',
            });
            console.log('[ESCROW] Escrow released email sent to seller:', seller.email);
          } catch (emailError) {
            console.error('[ESCROW] Failed to send escrow released email:', emailError);
          }
        }

        console.log(`[ESCROW] ✅ Escrow released for group "${trackingKey}" (${orders.length} orders)`);

      } catch (groupError: any) {
        console.error(`[ESCROW] ❌ Failed to release escrow for group ${trackingKey}:`, groupError.message);
      }
    }

    console.log('[ESCROW] Escrow release check complete');
  } catch (error: any) {
    console.error('[ESCROW] Escrow release job failed:', error.message);
  }
}

// ============================================
// AUTO-PROCESS RETURN REFUNDS
// Runs daily - refunds buyer after return escrow period (3 days)
// ✅ BULLETPROOF: Checks for seller disputes on returned item
// ============================================
export async function autoProcessReturnRefunds(): Promise<void> {
  console.log('[ESCROW] Running return refund processing...');

  try {
    const now = new Date();

    // Find return requests ready for refund
    const returnsToProcess = await prisma.return_requests.findMany({
      where: {
        status: 'delivered',
        escrow_release_at: {
          lte: now,
          not: null,
        },
        // ✅ SAFETY: Must not already have a refund
        stripe_refund_id: null,
      },
      include: {
        orders: {
          include: {
            listings: {
              select: {
                id: true,
                title: true,
                images: {
                  take: 1,
                  orderBy: PRIMARY_IMAGE_ORDER,
                },
              },
            },
            users_orders_buyer_idTousers: {
              select: {
                id: true,
                email: true,
                display_name: true,
              },
            },
            users_orders_seller_idTousers: {
              select: {
                id: true,
                email: true,
                display_name: true,
              },
            },
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${returnsToProcess.length} returns to check for refund processing`);

    for (const returnRequest of returnsToProcess) {
      try {
        const order = returnRequest.orders;
        console.log(`[ESCROW] Processing return ${returnRequest.id} for order ${order.id}`);

        // Claim-the-row: lock + transition to 'refund_processing' atomically.
        // Once committed, no concurrent run (cron or admin) can claim this return.
        const claimedReturn = await prisma.$transaction(async (tx) => {
          const rows: any[] = await tx.$queryRaw`
            SELECT id FROM return_requests WHERE id = ${returnRequest.id} AND status = 'delivered' AND stripe_refund_id IS NULL FOR UPDATE`;
          if (rows.length === 0) return null;
          await tx.return_requests.update({
            where: { id: returnRequest.id },
            data: { status: 'refund_processing', updated_at: now },
          });
          return tx.return_requests.findUnique({
            where: { id: returnRequest.id },
            select: { id: true, refund_amount: true, shipping_deducted: true },
          });
        });

        if (!claimedReturn) {
          console.log(`[ESCROW] ⚠️ Return ${returnRequest.id} already claimed or status changed, skipping`);
          continue;
        }

        if (await returnHasBlockingDispute(order.id)) {
          console.log(`[ESCROW] ⚠️ Return ${returnRequest.id} has active dispute from seller, reverting claim`);
          await prisma.return_requests.update({ where: { id: returnRequest.id }, data: { status: 'delivered', updated_at: now } });
          continue;
        }

        console.log(`[ESCROW] ✅ Return ${returnRequest.id} claimed, processing refund`);

        const buyer = order.users_orders_buyer_idTousers;
        const seller = order.users_orders_seller_idTousers;
        const listingTitle = order.listing_title || order.listings?.title || 'Item';
        const listingImage = order.listings?.images?.[0]?.image_url || order.listing_image || null;

        const refundAmount = parseFloat(claimedReturn.refund_amount?.toString() || '0');
        const shippingDeducted = parseFloat(claimedReturn.shipping_deducted?.toString() || '0');

        console.log(`[ESCROW] Refund calculation:`);
        console.log(`  - Refund amount: £${refundAmount.toFixed(2)}`);
        console.log(`  - Shipping deducted: £${shippingDeducted.toFixed(2)}`);

        if (refundAmount <= 0) {
          console.error(`[ESCROW] ❌ Invalid refund amount, reverting claim for return ${returnRequest.id}`);
          await prisma.return_requests.update({ where: { id: returnRequest.id }, data: { status: 'delivered', updated_at: now } });
          continue;
        }

        let refundId: string | null = null;

        if (order.stripe_payment_intent_id) {
          const refundAmountPence = Math.round(refundAmount * 100);

          try {
            const refund = await stripe.refunds.create({
              payment_intent: order.stripe_payment_intent_id,
              amount: refundAmountPence,
              reason: 'requested_by_customer',
              metadata: {
                order_id: order.id,
                return_id: returnRequest.id,
                reason: 'return_completed',
                original_amount: order.amount.toString(),
                refund_amount: refundAmount.toFixed(2),
                shipping_deducted: shippingDeducted.toFixed(2),
              },
            }, {
              idempotencyKey: `return_refund_${returnRequest.id}`,
            });

            refundId = refund.id;
            console.log(`[ESCROW] ✅ Refund ${refund.id} created for £${refundAmount.toFixed(2)}`);
          } catch (refundError: any) {
            if (refundError.code === 'charge_already_refunded') {
              console.log(`[ESCROW] ⚠️ Order ${order.id} already fully refunded in Stripe`);
            } else {
              console.error(`[ESCROW] ❌ Refund failed for return ${returnRequest.id}, reverting claim:`, refundError.message);
              await prisma.return_requests.update({ where: { id: returnRequest.id }, data: { status: 'delivered', updated_at: now } });
              continue;
            }
          }
        }

        // Final state: persist refund ID on both tables
        await prisma.$transaction([
          prisma.return_requests.update({
            where: { id: returnRequest.id },
            data: {
              status: 'completed',
              completed_at: now,
              stripe_refund_id: refundId,
              updated_at: now,
            },
          }),
          prisma.orders.update({
            where: { id: order.id },
            data: {
              status: 'returned',
              refunded_at: now,
              refund_amount: refundAmount,
              stripe_refund_id: refundId,
              updated_at: now,
            },
          }),
        ]);

        // Relist the item (seller can sell it again)
        if (order.listing_id) {
          await prisma.listings.update({
            where: { id: order.listing_id },
            data: {
              status: 'active',
              updated_at: now,
            },
          });
          console.log(`[ESCROW] Relisted item: ${order.listing_id}`);
        }

        // Notify buyer - refund processed
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'return_refunded',
            title: '✅ Refund Processed',
            message: shippingDeducted > 0
              ? `Your refund of £${refundAmount.toFixed(2)} for "${listingTitle}" has been processed (£${shippingDeducted.toFixed(2)} return shipping deducted).`
              : `Your refund of £${refundAmount.toFixed(2)} for "${listingTitle}" has been processed.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            buyer.id,
            '✅ Refund Processed',
            `£${refundAmount.toFixed(2)} refund for "${listingTitle}" is on its way.`,
            { type: 'return_refunded', order_id: order.id, return_id: returnRequest.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to buyer failed:', pushErr);
        }

        // EMAIL: Notify buyer
        try {
          if (buyer.email) {
            await sendReturnRefundProcessed(buyer.email, {
              buyerName: buyer.display_name || 'there',
              itemTitle: listingTitle,
              refundAmount: refundAmount.toFixed(2),
              shippingDeducted: shippingDeducted > 0 ? shippingDeducted.toFixed(2) : undefined,
              orderNumber: order.id.slice(-8).toUpperCase(),
              itemImageUrl: listingImage || order.listing_image || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
            });
            console.log(`[ESCROW] Refund email sent to buyer: ${buyer.email}`);
          }
        } catch (emailErr) {
          console.error('[ESCROW] Email to buyer failed:', emailErr);
        }

        // Notify seller - return completed
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'return_completed',
            title: 'Return Completed',
            message: `The return for "${listingTitle}" has been completed. The buyer has been refunded £${refundAmount.toFixed(2)}. Your item has been relisted.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify seller
        try {
          await sendPushNotification(
            seller.id,
            'Return Completed',
            `Return for "${listingTitle}" completed. Item has been relisted.`,
            { type: 'return_completed', order_id: order.id, return_id: returnRequest.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        console.log(`[ESCROW] ✅ Return ${returnRequest.id} completed successfully`);

      } catch (returnError: any) {
        console.error(`[ESCROW] ❌ Failed to process return ${returnRequest.id}:`, returnError.message);
      }
    }

    console.log('[ESCROW] Return refund processing complete');
  } catch (error: any) {
    console.error('[ESCROW] Return refund job failed:', error.message);
  }
}

// ============================================
// SEND RETURN SHIP REMINDERS
// Runs daily - reminds buyer 24h before return_ship_deadline (48h after label created)
// ============================================
export async function sendReturnShipReminders(): Promise<void> {
  console.log('[ESCROW] Running return ship reminder check...');

  try {
    const now = new Date();
    const reminderThreshold = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const returnsNeedingReminder = await prisma.return_requests.findMany({
      where: {
        status: 'label_created',
        reminder_sent_at: null,
        return_ship_deadline: {
          lte: reminderThreshold,
          gt: now,
          not: null,
        },
      },
      include: {
        orders: {
          include: {
            listings: {
              select: {
                title: true,
                images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
              },
            },
            users_orders_buyer_idTousers: {
              select: { id: true, display_name: true },
            },
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${returnsNeedingReminder.length} returns needing ship reminder`);

    for (const returnRequest of returnsNeedingReminder) {
      try {
        const order = returnRequest.orders;
        const buyer = order.users_orders_buyer_idTousers;
        const listingTitle = order.listing_title || order.listings?.title || 'Item';
        const listingImage = order.listings?.images?.[0]?.image_url || order.listing_image || null;

        await prisma.return_requests.update({
          where: { id: returnRequest.id },
          data: { reminder_sent_at: now },
        });

        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'return_reminder',
            title: 'Return Shipping Reminder',
            message: `You have 24 hours left to ship your return for "${listingTitle}". If not shipped by the deadline, the return will be cancelled and the seller will receive payment.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        try {
          await sendPushNotification(
            buyer.id,
            'Ship Your Return — 24h Left',
            `Return for "${listingTitle}" must be shipped within 24 hours or it will be cancelled.`,
            { type: 'return_reminder', order_id: order.id, return_id: returnRequest.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push reminder failed:', pushErr);
        }

        console.log(`[ESCROW] ✅ Sent return ship reminder for return ${returnRequest.id}`);
      } catch (reminderErr: any) {
        console.error(`[ESCROW] ❌ Failed to send reminder for return ${returnRequest.id}:`, reminderErr.message);
      }
    }

    console.log('[ESCROW] Return ship reminder check complete');
  } catch (error: any) {
    console.error('[ESCROW] Return ship reminder job failed:', error.message);
  }
}

// ============================================
// AUTO-EXPIRE RETURNS
// Runs daily - cancels returns if buyer doesn't ship within deadline
// ============================================
export async function autoExpireReturns(): Promise<void> {
  console.log('[ESCROW] Running return expiry check...');

  try {
    const now = new Date();

    // Find returns where buyer hasn't shipped in time
    const expiredReturns = await prisma.return_requests.findMany({
      where: {
        status: 'label_created',
        return_ship_deadline: {
          lte: now,
          not: null,
        },
      },
      include: {
        orders: {
          include: {
            listings: {
              select: {
                title: true,
                images: {
                  take: 1,
                  orderBy: PRIMARY_IMAGE_ORDER,
                },
              },
            },
            users_orders_buyer_idTousers: {
              select: { id: true, display_name: true },
            },
            users_orders_seller_idTousers: {
              select: { id: true, display_name: true, stripe_connect_id: true },
            },
          },
        },
        disputes: {
          select: { id: true, status: true },
        },
      },
    });

    console.log(`[ESCROW] Found ${expiredReturns.length} expired returns to process`);

    for (const returnRequest of expiredReturns) {
      try {
        const order = returnRequest.orders;
        const buyer = order.users_orders_buyer_idTousers;
        const seller = order.users_orders_seller_idTousers;
        const listingTitle = order.listing_title || order.listings?.title || 'Item';
        const listingImage = order.listings?.images?.[0]?.image_url || order.listing_image || null;

        console.log(`[ESCROW] Expiring return ${returnRequest.id} - buyer didn't ship within ${RETURN_SHIPPING_DEADLINE_DAYS} days`);

        // Cancel the return
        await prisma.return_requests.update({
          where: { id: returnRequest.id },
          data: {
            status: 'cancelled',
            updated_at: now,
          },
        });

        // Close the dispute in seller's favor if it exists
        if (returnRequest.disputes) {
          await prisma.disputes.update({
            where: { id: returnRequest.disputes.id },
            data: {
              status: 'admin_resolved',
              resolution_type: 'no_refund',
              resolution_amount: 0,
              resolution_notes: 'Return expired - buyer did not ship within deadline',
              resolved_by: 'system',
              resolved_at: now,
              updated_at: now,
            },
          });
        }

        // Set order back to delivered with escrow release
        // (Seller gets paid since buyer didn't follow through)
        const escrowReleaseAt = new Date(now.getTime() + ESCROW_RELEASE_DAYS * 24 * 60 * 60 * 1000);
        
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: 'delivered',
            escrow_release_at: escrowReleaseAt,
            updated_at: now,
          },
        });

        // Notify buyer - return expired
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'return_expired',
            title: 'Return Expired',
            message: `Your return for "${listingTitle}" has been cancelled because you didn't ship within ${RETURN_SHIPPING_DEADLINE_DAYS} days. The seller will receive payment.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            buyer.id,
            'Return Expired',
            `Return for "${listingTitle}" cancelled - shipping deadline missed.`,
            { type: 'return_expired', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to buyer failed:', pushErr);
        }

        // Notify seller - return expired, they'll get paid
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'return_expired',
            title: 'Return Cancelled - Buyer Missed Deadline',
            message: `The return for "${listingTitle}" was cancelled because the buyer didn't ship in time. Your payment will be released in ${ESCROW_RELEASE_DAYS} days.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify seller
        try {
          await sendPushNotification(
            seller.id,
            'Return Cancelled',
            `Buyer didn't ship return for "${listingTitle}". Payment releasing soon.`,
            { type: 'return_expired', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        console.log(`[ESCROW] ✅ Return ${returnRequest.id} expired and cancelled`);

      } catch (expireError: any) {
        console.error(`[ESCROW] ❌ Failed to expire return ${returnRequest.id}:`, expireError.message);
      }
    }

    console.log('[ESCROW] Return expiry check complete');
  } catch (error: any) {
    console.error('[ESCROW] Return expiry job failed:', error.message);
  }
}

// ============================================
// CHECK FOR LOST IN TRANSIT
// Runs daily - flags orders that may be lost
// ============================================
export async function checkLostInTransit(): Promise<void> {
  console.log('[ESCROW] Running lost-in-transit check...');

  try {
    const now = new Date();
    const lostThreshold = new Date(now.getTime() - LOST_IN_TRANSIT_DAYS * 24 * 60 * 60 * 1000);

    const potentiallyLostOrders = await prisma.orders.findMany({
      where: {
        status: 'in_transit',
        shipped_at: {
          lte: lostThreshold,
        },
        // ✅ Don't notify again if we already did
        lost_notification_sent_at: null,
      },
      include: {
        listings: {
          select: {
            title: true,
            images: {
              take: 1,
              orderBy: PRIMARY_IMAGE_ORDER,
            },
          },
        },
        users_orders_buyer_idTousers: {
          select: {
            id: true,
            display_name: true,
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${potentiallyLostOrders.length} potentially lost orders`);

    for (const order of potentiallyLostOrders) {
      try {
        const listingImage = order.listings?.images?.[0]?.image_url || null;
        const listingTitle = order.listings?.title || 'Your item';

        // ✅ Mark that we sent the notification (prevent duplicates)
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            lost_notification_sent_at: now,
            updated_at: now,
          },
        });

        // Notify buyer they can report as lost
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: order.buyer_id,
            type: 'delivery_delayed',
            title: 'Delivery Taking Longer Than Expected',
            message: `Your order for "${listingTitle}" was shipped ${LOST_IN_TRANSIT_DAYS}+ days ago but hasn't been delivered. If it hasn't arrived, you can report it as lost.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            order.buyer_id,
            'Delivery Delayed',
            `Your order for "${listingTitle}" may be delayed. You can report it as lost if needed.`,
            { type: 'delivery_delayed', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to buyer failed:', pushErr);
        }

        console.log(`[ESCROW] Sent lost-in-transit notification for order ${order.id}`);
      } catch (notifyError: any) {
        console.error(`[ESCROW] Failed to notify about order ${order.id}:`, notifyError.message);
      }
    }

    console.log('[ESCROW] Lost-in-transit check complete');
  } catch (error: any) {
    console.error('[ESCROW] Lost-in-transit check failed:', error.message);
  }
}

// ============================================
// AUTO-ESCALATE DISPUTES
// Runs daily - escalates disputes if seller doesn't respond within 72 hours
// ============================================
export async function autoEscalateDisputes(): Promise<void> {
  console.log('[ESCROW] Running dispute auto-escalation check...');

  try {
    const now = new Date();

    // Find open disputes past seller_deadline OR counter_offered past buyer_deadline
    const overdueDisputes = await prisma.disputes.findMany({
      where: {
        OR: [
          { status: 'open', seller_deadline: { lte: now } },
          { status: 'counter_offered', buyer_deadline: { lte: now, not: null } },
        ],
      },
      include: {
        orders: {
          include: {
            listings: {
              select: {
                title: true,
                images: {
                  take: 1,
                  orderBy: PRIMARY_IMAGE_ORDER,
                },
              },
            },
            users_orders_buyer_idTousers: {
              select: { id: true, display_name: true, email: true },
            },
            users_orders_seller_idTousers: {
              select: { id: true, display_name: true, email: true },
            },
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${overdueDisputes.length} disputes to auto-escalate`);

    for (const dispute of overdueDisputes) {
      try {
        const order = dispute.orders;
        const buyer = order.users_orders_buyer_idTousers;
        const seller = order.users_orders_seller_idTousers;
        const listingTitle = order.listing_title || order.listings?.title || 'Item';
        const listingImage = order.listings?.images?.[0]?.image_url || order.listing_image || null;

        const isBuyerTimeout = dispute.status === 'counter_offered';
        const escalationReason = isBuyerTimeout
          ? 'Buyer did not respond to counter-offer within 72 hours'
          : 'Seller did not respond within 72 hours';

        console.log(`[ESCROW] Auto-escalating dispute ${dispute.id} - ${escalationReason}`);

        await prisma.disputes.update({
          where: { id: dispute.id },
          data: {
            status: 'escalated',
            escalated_at: now,
            escalation_reason: escalationReason,
            auto_escalated: true,
            updated_at: now,
          },
        });

        // Notify buyer - dispute escalated
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'dispute_escalated',
            title: 'Dispute Escalated to Mulligans',
            message: `Your dispute for "${listingTitle}" has been escalated because the seller didn't respond in time. Our team will review and make a decision.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            buyer.id,
            'Dispute Escalated',
            `Your dispute for "${listingTitle}" is now being reviewed by Mulligans.`,
            { type: 'dispute_escalated', order_id: order.id, dispute_id: dispute.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to buyer failed:', pushErr);
        }

        // Notify seller - dispute escalated (their fault for not responding)
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'dispute_escalated',
            title: '⚠️ Dispute Escalated - No Response',
            message: `The dispute for "${listingTitle}" has been escalated because you didn't respond within 72 hours. Mulligans will now make a decision.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify seller
        try {
          await sendPushNotification(
            seller.id,
            '⚠️ Dispute Escalated',
            `Dispute for "${listingTitle}" escalated due to no response. Mulligans will decide.`,
            { type: 'dispute_escalated', order_id: order.id, dispute_id: dispute.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        // Create admin support ticket for review
        await prisma.support_tickets.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'dispute_escalation',
            order_id: order.id,
            subject: `[AUTO-ESCALATED] Dispute for "${listingTitle}"`,
            message: `This dispute was automatically escalated: ${escalationReason}.\n\nOrder ID: ${order.id}\nDispute ID: ${dispute.id}\nBuyer: ${buyer.display_name}\nSeller: ${seller.display_name}\nRequested: ${dispute.requested_refund_percent}% refund - £${dispute.requested_refund_amount}\nReason: ${dispute.reason_type} - ${dispute.reason_text}`,
            status: 'open',
            priority: 'high',
            created_at: now,
          },
        });

        console.log(`[ESCROW] ✅ Dispute ${dispute.id} auto-escalated successfully`);

      } catch (disputeError: any) {
        console.error(`[ESCROW] ❌ Failed to escalate dispute ${dispute.id}:`, disputeError.message);
      }
    }

    console.log('[ESCROW] Dispute auto-escalation check complete');
  } catch (error: any) {
    console.error('[ESCROW] Dispute auto-escalation job failed:', error.message);
  }
}

// ============================================
// AUTO-CONFIRM FORCED RETURNS
// Runs daily — if seller doesn't confirm receipt of a forced return:
// - 3 days after carrier DELIVERED → auto-confirm + refund 100%
// - 14 days after shipped (fallback if no DELIVERED signal) → same
// ============================================
export async function autoConfirmForcedReturns(): Promise<void> {
  console.log('[ESCROW] Running forced-return auto-confirm check...');

  try {
    const now = new Date();
    const threeDAgo = new Date(now.getTime() - FORCED_RETURN_SELLER_CONFIRM_DAYS * 24 * 60 * 60 * 1000);
    const fourteenDAgo = new Date(now.getTime() - FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS * 24 * 60 * 60 * 1000);

    const staleReturns = await prisma.return_requests.findMany({
      where: {
        is_forced: true,
        status: 'shipped',
        stripe_refund_id: null,
        OR: [
          { delivered_at: { not: null, lte: threeDAgo } },
          { delivered_at: null, shipped_at: { not: null, lte: fourteenDAgo } },
        ],
      },
      include: {
        orders: {
          select: {
            id: true,
            amount: true,
            buyer_id: true,
            seller_id: true,
            listing_id: true,
            listing_title: true,
            listing_image: true,
            stripe_payment_intent_id: true,
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${staleReturns.length} forced returns to auto-confirm`);

    for (const returnRequest of staleReturns) {
      try {
        const order = returnRequest.orders;
        const isDeliveryBased = !!returnRequest.delivered_at;
        console.log(`[ESCROW] Auto-confirming forced return ${returnRequest.id} (${isDeliveryBased ? 'delivery+3d' : 'shipped+14d fallback'})`);

        // Claim-the-row
        const claimed = await prisma.$transaction(async (tx) => {
          const rows: any[] = await tx.$queryRaw`
            SELECT id FROM return_requests
            WHERE id = ${returnRequest.id} AND status = 'shipped' AND stripe_refund_id IS NULL
            FOR UPDATE`;
          if (rows.length === 0) return null;
          await tx.return_requests.update({
            where: { id: returnRequest.id },
            data: { status: 'refund_processing', delivered_at: returnRequest.delivered_at || now, updated_at: now },
          });
          return true;
        });

        if (!claimed) {
          console.log(`[ESCROW] ⚠️ Forced return ${returnRequest.id} already claimed, skipping`);
          continue;
        }

        const refundAmount = parseFloat(returnRequest.refund_amount?.toString() || '0');

        if (!order.stripe_payment_intent_id || refundAmount <= 0) {
          console.error(`[ESCROW] ❌ Cannot refund forced return ${returnRequest.id}: PI=${order.stripe_payment_intent_id}, amount=${refundAmount}`);
          await prisma.return_requests.update({ where: { id: returnRequest.id }, data: { status: 'shipped', updated_at: now } });
          continue;
        }

        let refundId: string;
        try {
          const refund = await stripe.refunds.create({
            payment_intent: order.stripe_payment_intent_id,
            amount: Math.round(refundAmount * 100),
            reason: 'requested_by_customer',
            metadata: {
              return_id: returnRequest.id,
              order_id: order.id,
              resolution: 'forced_return_auto_confirmed',
            },
          }, { idempotencyKey: `forced_return_refund_${returnRequest.id}` });

          refundId = refund.id;
          console.log(`[ESCROW] ✅ Forced return refund ${refund.id}: £${refundAmount.toFixed(2)}`);
        } catch (refundErr: any) {
          console.error(`[ESCROW] ❌ Forced return refund failed, reverting:`, refundErr.message);
          await prisma.return_requests.update({ where: { id: returnRequest.id }, data: { status: 'shipped', updated_at: now } });
          continue;
        }

        // Finalise
        await prisma.$transaction([
          prisma.return_requests.update({
            where: { id: returnRequest.id },
            data: { status: 'completed', completed_at: now, stripe_refund_id: refundId, updated_at: now },
          }),
          prisma.orders.update({
            where: { id: order.id },
            data: { status: 'returned', refunded_at: now, refund_amount: refundAmount, stripe_refund_id: refundId, updated_at: now },
          }),
        ]);

        // Relist item
        if (order.listing_id) {
          await prisma.listings.update({
            where: { id: order.listing_id },
            data: { status: 'active', updated_at: now },
          }).catch(err => console.error('[ESCROW] Relist failed:', err));
        }

        // Notify seller
        const listingTitle = order.listing_title || 'Item';
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: order.seller_id,
            type: 'return_completed',
            title: 'Return Auto-Confirmed',
            message: `You did not confirm receipt of the return for "${listingTitle}" within the deadline. The return has been auto-confirmed and the buyer refunded £${refundAmount.toFixed(2)}.`,
            image_url: order.listing_image,
            related_id: returnRequest.id,
          },
        });

        // Notify buyer
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: order.buyer_id,
            type: 'return_refunded',
            title: 'Refund Processed',
            message: `Your refund of £${refundAmount.toFixed(2)} for "${listingTitle}" has been processed.`,
            image_url: order.listing_image,
            related_id: returnRequest.id,
          },
        });

        await sendPushNotification(
          order.buyer_id,
          'Refund Processed',
          `£${refundAmount.toFixed(2)} refund for "${listingTitle}" is on its way.`,
          { type: 'return_refunded', return_id: returnRequest.id, order_id: order.id }
        ).catch(err => console.error('[ESCROW] Push to buyer failed:', err));

        console.log(`[ESCROW] ✅ Forced return ${returnRequest.id} auto-confirmed — buyer refunded £${refundAmount.toFixed(2)}`);
      } catch (returnErr: any) {
        console.error(`[ESCROW] ❌ Failed to auto-confirm forced return ${returnRequest.id}:`, returnErr.message);
      }
    }

    console.log('[ESCROW] Forced-return auto-confirm check complete');
  } catch (error: any) {
    console.error('[ESCROW] Forced-return auto-confirm job failed:', error.message);
  }
}

// ============================================
// CHECK SHIPMENT NOT SCANNED
// Runs daily — flags orders where label was created but carrier
// never scanned the parcel (no TRANSIT webhook).
// Sub-check A: grace entry (~day 5) — notify both parties.
// Sub-check B: escalation (~day 8) — poll Shippo, then admin ticket.
// ============================================
export async function checkShipmentNotScanned(): Promise<void> {
  console.log('[ESCROW] Running shipment-not-scanned check...');

  try {
    const now = new Date();
    const graceThreshold = new Date(now.getTime() - GRACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // ── Sub-check A: Grace entry (deadline elapsed, label exists, not yet notified) ──
    const graceEntryOrders = await prisma.orders.findMany({
      where: {
        status: 'to_ship',
        shipment_deadline_at: { lte: now },
        shippo_transaction_id: { not: null },
        grace_notified_at: null,
        refunded_at: null,
        cancelled_at: null,
      },
      include: {
        listings: {
          select: {
            title: true,
            images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
          },
        },
        users_orders_buyer_idTousers: {
          select: { id: true, email: true, display_name: true },
        },
        users_orders_seller_idTousers: {
          select: { id: true, email: true, display_name: true },
        },
      },
    });

    console.log(`[ESCROW] Found ${graceEntryOrders.length} orders entering shipment grace period`);

    // Group by tracking_number for multi-item shipments
    const graceByTracking = new Map<string, typeof graceEntryOrders>();
    for (const order of graceEntryOrders) {
      const key = order.tracking_number || order.id;
      if (!graceByTracking.has(key)) graceByTracking.set(key, []);
      graceByTracking.get(key)!.push(order);
    }

    for (const [trackingKey, orders] of graceByTracking) {
      try {
        const firstOrder = orders[0];
        const listingTitle = firstOrder.listings?.title || 'Your item';
        const listingImage = firstOrder.listings?.images?.[0]?.image_url || null;
        const buyer = firstOrder.users_orders_buyer_idTousers;
        const seller = firstOrder.users_orders_seller_idTousers;

        // Set grace_notified_at on all orders in this shipment
        await prisma.orders.updateMany({
          where: { id: { in: orders.map(o => o.id) } },
          data: { grace_notified_at: now, updated_at: now },
        });

        // Buyer notification
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'shipment_under_review',
            title: 'Shipping Update — Under Review',
            message: `We've noticed your order for "${listingTitle}" hasn't been scanned by the carrier yet. Our team is reviewing it — we aim to get back to you within a few days.`,
            image_url: listingImage,
            related_id: firstOrder.id,
          },
        });

        // Seller notification
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'shipment_under_review',
            title: 'Shipping Update — Under Review',
            message: `Your sale of "${listingTitle}" hasn't been scanned by the carrier yet. Our team is reviewing it. If you've already posted the item, no action is needed — carrier scans can sometimes take a day or two to register.`,
            image_url: listingImage,
            related_id: firstOrder.id,
          },
        });

        // Push notifications
        try {
          await sendPushNotification(buyer.id, 'Shipping Under Review',
            `Your order for "${listingTitle}" is being reviewed by our team.`,
            { type: 'shipment_under_review', order_id: firstOrder.id });
        } catch (pushErr) { console.error('[ESCROW] Grace push to buyer failed:', pushErr); }

        try {
          await sendPushNotification(seller.id, 'Shipping Under Review',
            `Your sale of "${listingTitle}" is being reviewed by our team.`,
            { type: 'shipment_under_review', order_id: firstOrder.id });
        } catch (pushErr) { console.error('[ESCROW] Grace push to seller failed:', pushErr); }

        // Email sends are wired in Commit 6
        console.log(`[ESCROW] Grace notification sent for tracking ${trackingKey} (${orders.length} order(s))`);
      } catch (graceErr: any) {
        console.error(`[ESCROW] ❌ Grace notification failed for tracking ${trackingKey}:`, graceErr.message);
      }
    }

    // ── Sub-check B: Escalation (grace elapsed, still no scan) ──
    const escalationOrders = await prisma.orders.findMany({
      where: {
        status: 'to_ship',
        grace_notified_at: { lte: graceThreshold },
        shipment_escalated_at: null,
        grace_recovered_at: null,
        refunded_at: null,
        cancelled_at: null,
      },
      include: {
        listings: {
          select: {
            title: true,
            images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
          },
        },
        users_orders_buyer_idTousers: {
          select: { id: true, email: true, display_name: true },
        },
        users_orders_seller_idTousers: {
          select: { id: true, email: true, display_name: true },
        },
      },
    });

    console.log(`[ESCROW] Found ${escalationOrders.length} orders to potentially escalate`);

    // Group by tracking_number
    const escByTracking = new Map<string, typeof escalationOrders>();
    for (const order of escalationOrders) {
      const key = order.tracking_number || order.id;
      if (!escByTracking.has(key)) escByTracking.set(key, []);
      escByTracking.get(key)!.push(order);
    }

    for (const [trackingKey, orders] of escByTracking) {
      try {
        const firstOrder = orders[0];
        const listingTitle = firstOrder.listings?.title || 'Your item';
        const listingImage = firstOrder.listings?.images?.[0]?.image_url || null;
        const buyer = firstOrder.users_orders_buyer_idTousers;
        const seller = firstOrder.users_orders_seller_idTousers;

        // Poll Shippo to check for missed webhooks before escalating
        if (firstOrder.tracking_number && firstOrder.carrier) {
          try {
            const tracking = await shippo.trackingStatus.get(
              firstOrder.carrier.toLowerCase(),
              firstOrder.tracking_number,
            );

            const shippoStatus = tracking.trackingStatus?.status;
            if (shippoStatus === 'TRANSIT' || shippoStatus === 'DELIVERED') {
              console.log(`[ESCROW] Shippo poll recovered tracking ${trackingKey} (status: ${shippoStatus}) — skipping escalation`);

              const recoveryStatus = shippoStatus === 'DELIVERED' ? 'delivered' : 'in_transit';
              const recoveryData: any = {
                status: recoveryStatus,
                grace_recovered_at: now,
                shipped_at: firstOrder.shipped_at || now,
                updated_at: now,
              };
              if (shippoStatus === 'DELIVERED') {
                recoveryData.delivered_at = now;
                const escrowRelease = new Date(now);
                escrowRelease.setDate(escrowRelease.getDate() + ESCROW_RELEASE_DAYS);
                recoveryData.escrow_release_at = escrowRelease;
              }

              await prisma.orders.updateMany({
                where: { id: { in: orders.map(o => o.id) } },
                data: recoveryData,
              });

              // Send recovery comms
              await prisma.notifications.create({
                data: {
                  id: crypto.randomUUID(),
                  user_id: buyer.id,
                  type: 'shipment_recovered',
                  title: 'Good News — Your Order Is On Its Way',
                  message: `"${listingTitle}" has been confirmed ${shippoStatus === 'DELIVERED' ? 'delivered' : 'in transit'} by the carrier.`,
                  image_url: listingImage,
                  related_id: firstOrder.id,
                },
              });
              await prisma.notifications.create({
                data: {
                  id: crypto.randomUUID(),
                  user_id: seller.id,
                  type: 'shipment_recovered',
                  title: 'Good News — Your Sale Is On Its Way',
                  message: `"${listingTitle}" has been confirmed ${shippoStatus === 'DELIVERED' ? 'delivered' : 'in transit'} by the carrier.`,
                  image_url: listingImage,
                  related_id: firstOrder.id,
                },
              });

              try {
                await sendPushNotification(buyer.id, 'Your Order Is On Its Way',
                  `"${listingTitle}" is confirmed ${shippoStatus === 'DELIVERED' ? 'delivered' : 'in transit'}.`,
                  { type: 'shipment_recovered', order_id: firstOrder.id });
              } catch (pushErr) { console.error('[ESCROW] Recovery push to buyer failed:', pushErr); }
              try {
                await sendPushNotification(seller.id, 'Your Sale Is On Its Way',
                  `"${listingTitle}" is confirmed ${shippoStatus === 'DELIVERED' ? 'delivered' : 'in transit'}.`,
                  { type: 'shipment_recovered', order_id: firstOrder.id });
              } catch (pushErr) { console.error('[ESCROW] Recovery push to seller failed:', pushErr); }

              continue;
            }
          } catch (pollErr: any) {
            // On poll failure, defer — do NOT escalate on bad data
            console.error(`[ESCROW] ⚠️ Shippo poll failed for ${trackingKey} — deferring escalation:`, pollErr.message);
            continue;
          }
        }

        // Shippo confirmed still PRE_TRANSIT (or no tracking info) — escalate
        await prisma.orders.updateMany({
          where: { id: { in: orders.map(o => o.id) } },
          data: { shipment_escalated_at: now, updated_at: now },
        });

        // Create support ticket (idempotency: check for existing)
        const existingTicket = await prisma.support_tickets.findFirst({
          where: { order_id: firstOrder.id, type: 'shipment_not_scanned' },
        });

        if (!existingTicket) {
          const daysSinceOrder = Math.floor((now.getTime() - firstOrder.created_at.getTime()) / (24 * 60 * 60 * 1000));
          await prisma.support_tickets.create({
            data: {
              id: crypto.randomUUID(),
              user_id: seller.id,
              type: 'shipment_not_scanned',
              order_id: firstOrder.id,
              subject: `[SHIPMENT NOT SCANNED] Order ${firstOrder.id.substring(0, 14)} — no carrier scan after ${daysSinceOrder} days`,
              message: `Order ${firstOrder.id} has a label but the carrier has not scanned the parcel.\n\nSeller: ${seller.display_name || 'Unknown'} (${seller.id})\nSeller email: ${seller.email || 'N/A'}\nBuyer: ${buyer.display_name || 'Unknown'} (${buyer.id})\nTracking: ${firstOrder.tracking_number || 'N/A'}\nCarrier: ${firstOrder.carrier || 'N/A'}\nOrder amount: £${parseFloat(firstOrder.amount.toString()).toFixed(2)}\nOrder created: ${firstOrder.created_at.toISOString()}\nLabel created (Shippo TX): ${firstOrder.shippo_transaction_id}\nItems in shipment: ${orders.length}\n\nShippo poll confirmed parcel is still PRE_TRANSIT. Manual admin review required — decide whether to grant an extension, contact the seller, or refund the buyer.`,
              status: 'open',
              priority: 'high',
              created_at: now,
            },
          });
        }

        // Notify buyer
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: buyer.id,
            type: 'shipment_escalated',
            title: 'Order Escalated to Support',
            message: `Your order for "${listingTitle}" has been escalated to our team for review. We'll be in touch — no action needed from you.`,
            image_url: listingImage,
            related_id: firstOrder.id,
          },
        });

        // Notify seller
        await prisma.notifications.create({
          data: {
            id: crypto.randomUUID(),
            user_id: seller.id,
            type: 'shipment_escalated',
            title: 'Sale Escalated to Support',
            message: `Your sale of "${listingTitle}" has been escalated to our team because the carrier hasn't scanned the parcel. If you've posted the item, please check with the carrier.`,
            image_url: listingImage,
            related_id: firstOrder.id,
          },
        });

        try {
          await sendPushNotification(buyer.id, 'Order Escalated to Support',
            `Your order for "${listingTitle}" is being handled by our team.`,
            { type: 'shipment_escalated', order_id: firstOrder.id });
        } catch (pushErr) { console.error('[ESCROW] Escalation push to buyer failed:', pushErr); }
        try {
          await sendPushNotification(seller.id, 'Sale Escalated to Support',
            `Your sale of "${listingTitle}" has been escalated — carrier hasn't scanned.`,
            { type: 'shipment_escalated', order_id: firstOrder.id });
        } catch (pushErr) { console.error('[ESCROW] Escalation push to seller failed:', pushErr); }

        // Email sends are wired in Commit 6
        console.log(`[ESCROW] ⚠️ Escalated tracking ${trackingKey} (${orders.length} order(s)) — admin ticket created`);
      } catch (escErr: any) {
        console.error(`[ESCROW] ❌ Escalation failed for tracking ${trackingKey}:`, escErr.message);
      }
    }

    console.log('[ESCROW] Shipment-not-scanned check complete');
  } catch (error: any) {
    console.error('[ESCROW] Shipment-not-scanned check failed:', error.message);
  }
}

// ============================================
// RUN ALL ESCROW JOBS
// Called by cron scheduler
// ============================================
export async function runEscrowJobs(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] Starting escrow jobs at', new Date().toISOString());
  console.log('═══════════════════════════════════════════');

  await autoCancelUnshippedOrders();
  await autoReleaseEscrow();
  await sendInspectionReminders();
  await autoProcessReturnRefunds();
  await sendReturnShipReminders();
  await autoExpireReturns();
  await autoConfirmForcedReturns();
  await autoEscalateDisputes();
  await checkLostInTransit();
  await checkShipmentNotScanned();

  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] All escrow jobs completed');
  console.log('═══════════════════════════════════════════');
}

export default {
  autoCancelUnshippedOrders,
  autoReleaseEscrow,
  autoProcessReturnRefunds,
  sendReturnShipReminders,
  autoExpireReturns,
  autoConfirmForcedReturns,
  autoEscalateDisputes,
  checkLostInTransit,
  checkShipmentNotScanned,
  runEscrowJobs,
};