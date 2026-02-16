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
import Stripe from 'stripe';
import { sendEscrowReleased, sendReturnRefundProcessed } from './emailService';
import { sendPushNotification } from '../controllers/pushNotificationController';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// CONSTANTS
// ============================================
const SHIPPING_DEADLINE_DAYS = 5;        // Seller must ship within 5 days
const RETURN_SHIPPING_DEADLINE_DAYS = 5; // Buyer must ship return within 5 days
const ESCROW_RELEASE_DAYS = 3;           // 3 days after delivery to release funds
const LOST_IN_TRANSIT_DAYS = 14;         // Flag as potentially lost after 14 days

// Dispute statuses that BLOCK escrow release
const BLOCKING_DISPUTE_STATUSES = ['open', 'counter_offered', 'escalated'];

// Return statuses that BLOCK escrow release
const BLOCKING_RETURN_STATUSES = ['pending', 'approved', 'awaiting_address', 'label_created', 'shipped', 'delivered'];

// ============================================
// HELPER: Check if order has blocking dispute
// ============================================
async function hasBlockingDispute(orderId: string): Promise<boolean> {
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
async function hasBlockingReturn(orderId: string): Promise<boolean> {
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
              orderBy: { display_order: 'asc' },
            },
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
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
        }

        // 6. Notify buyer
        const listingImage = order.listings?.images?.[0]?.image_url || null;
        const listingTitle = order.listings?.title || 'Your item';

        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
              orderBy: { display_order: 'asc' },
            },
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            stripe_connect_id: true,
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
        // Items: sum of all order amounts
        const itemsTotal = orders.reduce((sum, o) => sum + parseFloat(o.amount.toString()), 0);
        
        // Check if any order in the group was auto-shipped
        const isAutoShipped = orders.some(o => (o as any).label_auto_generated === true);
        
        let actualPayout: number;
        let shippingAmount = 0;
        let labelCostTotal = 0;
        
        if (isAutoShipped) {
          // AUTO-SHIPPED: Seller gets items only (platform keeps shipping margin)
          actualPayout = itemsTotal;
        } else {
          // MANUAL SHIP: Old formula — items + shipping - label cost
          shippingAmount = Math.max(...orders.map(o => parseFloat((o.shipping_cost || 0).toString())));
          labelCostTotal = orders.reduce((sum, o) => sum + parseFloat((o.label_cost || 0).toString()), 0);
          actualPayout = itemsTotal + shippingAmount - labelCostTotal;
        }

        console.log(`[ESCROW] Payout calculation for group "${trackingKey}" (${isAutoShipped ? 'AUTO-SHIPPED' : 'MANUAL'}):`);
        console.log(`  - Items total (${orders.length} orders): £${itemsTotal.toFixed(2)}`);
        if (!isAutoShipped) {
          console.log(`  - Shipping (once): £${shippingAmount.toFixed(2)}`);
          console.log(`  - Label cost deducted: £${labelCostTotal.toFixed(2)}`);
        }
        console.log(`  - Actual transfer amount: £${actualPayout.toFixed(2)}`);

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
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller.id,
              type: 'payout',
              title: 'Order Completed - No Payout Due',
              message: `Order completed but shipping label cost (£${labelCostTotal.toFixed(2)}) exceeded the payout amount.`,
              related_id: firstOrder.id,
            },
          });

          continue;
        }

        // ============================================
        // CREATE STRIPE TRANSFER
        // ============================================
        if (!seller.stripe_connect_id) {
          console.log(`[ESCROW] ⚠️ Seller has no Stripe Connect, marking orders as completed without transfer`);
          
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
          continue;
        }

        const transferAmountPence = Math.round(actualPayout * 100);
        let transferId: string | null = null;
        const orderIds = orders.map(o => o.id).join(',');

        try {
          const transfer = await stripe.transfers.create({
            amount: transferAmountPence,
            currency: 'gbp',
            destination: seller.stripe_connect_id,
            metadata: {
              tracking_number: trackingKey.startsWith('single_') ? 'none' : trackingKey,
              order_ids: orderIds,
              order_count: orders.length.toString(),
              items_total: itemsTotal.toFixed(2),
              shipping_included: shippingAmount.toFixed(2),
              label_cost_deducted: labelCostTotal.toFixed(2),
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

        let notificationMessage = `£${payoutAmount} for "${itemDescription}" has been transferred to your account.`;
        if (labelCostTotal > 0) {
          notificationMessage = `£${payoutAmount} for "${itemDescription}" has been transferred (£${labelCostTotal.toFixed(2)} label cost deducted).`;
        }

        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
              salePrice: itemsTotal.toFixed(2),
              fees: labelCostTotal.toFixed(2),
              payoutAmount: payoutAmount,
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
                  orderBy: { display_order: 'asc' },
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

        // ✅ SAFETY CHECK 1: Re-verify return status
        const freshReturn = await prisma.return_requests.findUnique({
          where: { id: returnRequest.id },
          select: { status: true, stripe_refund_id: true },
        });

        if (freshReturn?.status !== 'delivered') {
          console.log(`[ESCROW] ⚠️ Return ${returnRequest.id} status changed to ${freshReturn?.status}, skipping`);
          continue;
        }

        if (freshReturn?.stripe_refund_id) {
          console.log(`[ESCROW] ⚠️ Return ${returnRequest.id} already has refund ${freshReturn.stripe_refund_id}, skipping`);
          continue;
        }

        // ✅ SAFETY CHECK 2: Check if seller disputed the returned item
        if (await returnHasBlockingDispute(order.id)) {
          console.log(`[ESCROW] ⚠️ Return ${returnRequest.id} has active dispute from seller, skipping refund`);
          continue;
        }

        console.log(`[ESCROW] ✅ Return ${returnRequest.id} passed all safety checks, processing refund`);

        const buyer = order.users_orders_buyer_idTousers;
        const seller = order.users_orders_seller_idTousers;
        const listingTitle = order.listing_title || order.listings?.title || 'Item';
        const listingImage = order.listings?.images?.[0]?.image_url || order.listing_image || null;

        // Calculate refund amount
        const refundAmount = parseFloat(returnRequest.refund_amount?.toString() || '0');
        const shippingDeducted = parseFloat(returnRequest.shipping_deducted?.toString() || '0');

        console.log(`[ESCROW] Refund calculation:`);
        console.log(`  - Refund amount: £${refundAmount.toFixed(2)}`);
        console.log(`  - Shipping deducted: £${shippingDeducted.toFixed(2)}`);

        if (refundAmount <= 0) {
          console.error(`[ESCROW] ❌ Invalid refund amount £${refundAmount.toFixed(2)} for return ${returnRequest.id}`);
          continue;
        }

        let refundId: string | null = null;

        // Process Stripe refund
        if (order.stripe_payment_intent_id) {
          const refundAmountPence = Math.round(refundAmount * 100);

          try {
            const refund = await stripe.refunds.create({
              payment_intent: order.stripe_payment_intent_id,
              amount: refundAmountPence, // Partial refund (excludes shipping if buyer paid)
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
              idempotencyKey: `return_refund_${returnRequest.id}`, // ✅ Prevent double refund
            });

            refundId = refund.id;
            console.log(`[ESCROW] ✅ Refund ${refund.id} created for £${refundAmount.toFixed(2)}`);
          } catch (refundError: any) {
            if (refundError.code === 'charge_already_refunded') {
              console.log(`[ESCROW] ⚠️ Order ${order.id} already fully refunded in Stripe`);
            } else {
              console.error(`[ESCROW] ❌ Refund failed for return ${returnRequest.id}:`, refundError.message);
              continue; // Don't update status if refund failed
            }
          }
        }

        // ✅ Update return request status IMMEDIATELY after successful refund
        await prisma.return_requests.update({
          where: { id: returnRequest.id },
          data: {
            status: 'completed',
            completed_at: now,
            stripe_refund_id: refundId, // ✅ Store refund ID to prevent double processing
            updated_at: now,
          },
        });

        // Update order status to returned
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: 'returned',
            refunded_at: now,
            refund_amount: refundAmount,
            stripe_refund_id: refundId,
            updated_at: now,
          },
        });

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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
            });
            console.log(`[ESCROW] Refund email sent to buyer: ${buyer.email}`);
          }
        } catch (emailErr) {
          console.error('[ESCROW] Email to buyer failed:', emailErr);
        }

        // Notify seller - return completed
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
// AUTO-EXPIRE RETURNS
// Runs daily - cancels returns if buyer doesn't ship within 5 days
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
                  orderBy: { display_order: 'asc' },
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
              status: 'resolved',
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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
              orderBy: { display_order: 'asc' },
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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
    const escalationThreshold = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72 hours ago

    // Find disputes that are still 'open' and older than 72 hours
    const overdueDisputes = await prisma.disputes.findMany({
      where: {
        status: 'open',
        created_at: {
          lte: escalationThreshold,
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
                  orderBy: { display_order: 'asc' },
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

        console.log(`[ESCROW] Auto-escalating dispute ${dispute.id} - seller didn't respond within 72 hours`);

        // Update dispute status to escalated
        await prisma.disputes.update({
          where: { id: dispute.id },
          data: {
            status: 'escalated',
            escalated_at: now,
            escalation_reason: 'Seller did not respond within 72 hours',
            auto_escalated: true,
            updated_at: now,
          },
        });

        // Notify buyer - dispute escalated
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
            id: `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: buyer.id,
            type: 'dispute_escalation',
            order_id: order.id,
            subject: `[AUTO-ESCALATED] Dispute for "${listingTitle}"`,
            message: `This dispute was automatically escalated because the seller (${seller.display_name}) did not respond within 72 hours.\n\nOrder ID: ${order.id}\nDispute ID: ${dispute.id}\nBuyer: ${buyer.display_name}\nSeller: ${seller.display_name}\nRequested: ${dispute.requested_refund_percent}% refund - £${dispute.requested_refund_amount}\nReason: ${dispute.reason_type} - ${dispute.reason_text}`,
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
// RUN ALL ESCROW JOBS
// Called by cron scheduler
// ============================================
export async function runEscrowJobs(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] Starting escrow jobs at', new Date().toISOString());
  console.log('═══════════════════════════════════════════');

  await autoCancelUnshippedOrders();
  await autoReleaseEscrow();
  await autoProcessReturnRefunds();
  await autoExpireReturns();
  await autoEscalateDisputes();
  await checkLostInTransit();

  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] All escrow jobs completed');
  console.log('═══════════════════════════════════════════');
}

export default {
  autoCancelUnshippedOrders,
  autoReleaseEscrow,
  autoProcessReturnRefunds,
  autoExpireReturns,
  autoEscalateDisputes, 
  checkLostInTransit,
  runEscrowJobs,
};