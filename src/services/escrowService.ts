// src/services/escrowService.ts
// Handles automated escrow operations via cron jobs
// - Auto-cancel unshipped orders after 5 days
// - Auto-release funds 3 days after delivery (buyer has 3 days to raise issues)
// - Flag potentially lost orders after 14 days
// UPDATED: Added push notifications

import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { sendEscrowReleased } from './emailService';
import { sendPushNotification } from '../controllers/pushNotificationController';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// CONSTANTS
// ============================================
const SHIPPING_DEADLINE_DAYS = 5;
const ESCROW_RELEASE_DAYS = 3;
const LOST_IN_TRANSIT_DAYS = 14;

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
        console.log(`[ESCROW] Auto-cancelling order ${order.id} - seller didn't ship within ${SHIPPING_DEADLINE_DAYS} days`);

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
            });
            console.log(`[ESCROW] Refund created: ${refund.id} for order ${order.id}`);
          } catch (refundError: any) {
            console.error(`[ESCROW] Refund failed for order ${order.id}:`, refundError.message);
          }
        }

        // 2. Update order status
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: 'cancelled',
            cancelled_at: now,
            cancel_reason: 'auto_cancelled_not_shipped',
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

        console.log(`[ESCROW] Order ${order.id} cancelled successfully`);
      } catch (orderError: any) {
        console.error(`[ESCROW] Failed to cancel order ${order.id}:`, orderError.message);
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
// ============================================
export async function autoReleaseEscrow(): Promise<void> {
  console.log('[ESCROW] Running escrow release check...');

  try {
    const now = new Date();

    const ordersToRelease = await prisma.orders.findMany({
      where: {
        status: 'delivered',
        escrow_release_at: {
          lte: now,
          not: null,
        },
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
          },
        },
      },
    });

    console.log(`[ESCROW] Found ${ordersToRelease.length} orders ready for escrow release`);

    for (const order of ordersToRelease) {
      try {
        console.log(`[ESCROW] Releasing escrow for order ${order.id}`);

        const seller = order.users_orders_seller_idTousers;

        // Transfer funds to seller's Connect account
        if (seller.stripe_connect_id && order.seller_payout) {
          const transferAmount = Math.round(parseFloat(order.seller_payout.toString()) * 100);

          try {
            const transfer = await stripe.transfers.create({
              amount: transferAmount,
              currency: 'gbp',
              destination: seller.stripe_connect_id,
              metadata: {
                order_id: order.id,
                type: 'escrow_release',
                released_at: now.toISOString(),
              },
            });

            console.log(`[ESCROW] Transfer ${transfer.id} created for £${(transferAmount / 100).toFixed(2)} to ${seller.stripe_connect_id}`);
          } catch (transferError: any) {
            console.error(`[ESCROW] Transfer failed for order ${order.id}:`, transferError.message);
            continue;
          }
        }

        // Update order status to completed
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: 'completed',
            completed_at: now,
            updated_at: now,
          },
        });

        // Update seller's total_sales count
        await prisma.users.update({
          where: { id: seller.id },
          data: {
            total_sales: { increment: 1 },
            updated_at: now,
          },
        });

        // Notify seller
        const listingImage = order.listings?.images?.[0]?.image_url || null;
        const listingTitle = order.listings?.title || 'Your item';
        const payoutAmount = order.seller_payout ? parseFloat(order.seller_payout.toString()).toFixed(2) : '0.00';

        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: seller.id,
            type: 'payout',
            title: 'Payment Released!',
            message: `£${payoutAmount} for "${listingTitle}" has been transferred to your account.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });

        // PUSH: Notify seller of payout
        try {
          await sendPushNotification(
            seller.id,
            'Payment Released!',
            `£${payoutAmount} for "${listingTitle}" is on its way to your bank.`,
            { type: 'payout', order_id: order.id }
          );
        } catch (pushErr) {
          console.error('[ESCROW] Push to seller failed:', pushErr);
        }

        // Send escrow released EMAIL to seller
        const sellerEmailRecord = await prisma.users.findUnique({
          where: { id: seller.id },
          select: { email: true },
        });
        
        if (sellerEmailRecord?.email) {
          try {
            const salePrice = parseFloat(order.amount.toString()).toFixed(2);
            const fees = (parseFloat(order.amount.toString()) - parseFloat(order.seller_payout?.toString() || '0')).toFixed(2);
            
            await sendEscrowReleased(sellerEmailRecord.email, {
              itemTitle: listingTitle,
              orderNumber: order.id,
              salePrice: salePrice,
              fees: fees,
              payoutAmount: payoutAmount,
            });
            console.log('[ESCROW] Escrow released email sent to seller:', sellerEmailRecord.email);
          } catch (emailError) {
            console.error('[ESCROW] Failed to send escrow released email:', emailError);
          }
        }

        console.log(`[ESCROW] Escrow released for order ${order.id}`);
      } catch (orderError: any) {
        console.error(`[ESCROW] Failed to release escrow for order ${order.id}:`, orderError.message);
      }
    }

    console.log('[ESCROW] Escrow release check complete');
  } catch (error: any) {
    console.error('[ESCROW] Escrow release job failed:', error.message);
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
        reported_lost_at: null,
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
// RUN ALL ESCROW JOBS
// Called by cron scheduler
// ============================================
export async function runEscrowJobs(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] Starting escrow jobs at', new Date().toISOString());
  console.log('═══════════════════════════════════════════');

  await autoCancelUnshippedOrders();
  await autoReleaseEscrow();
  await checkLostInTransit();

  console.log('═══════════════════════════════════════════');
  console.log('[ESCROW] All escrow jobs completed');
  console.log('═══════════════════════════════════════════');
}

export default {
  autoCancelUnshippedOrders,
  autoReleaseEscrow,
  checkLostInTransit,
  runEscrowJobs,
};