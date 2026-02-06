// src/jobs/offerJobs.ts
// Background jobs for the offer system - handles expiry, voiding, and warning notifications
// Called by the cron scheduler at regular intervals

import { PrismaClient } from '@prisma/client';
import { sendPushNotification } from '../controllers/pushNotificationController';

const prisma = new PrismaClient();

// Helper to generate notification IDs matching existing convention
const generateNotifId = (): string =>
  `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Helper to format price for display (e.g. "£45.00")
const formatPrice = (amount: any): string => {
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount));
  return `\u00A3${num.toFixed(2)}`;
};

// ============================================
// JOB 1: Expire pending offers past their deadline
// Runs every 5 minutes
// ============================================
export const expirePendingOffers = async (): Promise<number> => {
  try {
    const now = new Date();

    const expiredOffers = await prisma.offers.findMany({
      where: {
        status: 'PENDING',
        expires_at: { lt: now },
      },
      include: {
        listings: {
          select: { title: true, images: true },
        },
        buyer: { select: { display_name: true } },
        seller: { select: { display_name: true } },
      },
    });

    if (expiredOffers.length === 0) return 0;

    console.log(`[OFFER JOBS] Expiring ${expiredOffers.length} pending offer(s)`);

    for (const offer of expiredOffers) {
      try {
        // Update status to EXPIRED
        await prisma.offers.update({
          where: { id: offer.id },
          data: { status: 'EXPIRED' },
        });

        const listingTitle = offer.listings?.title || 'Unknown item';
        const imageUrl = (offer.listings?.images as any)?.[0]?.image_url || null;

        // Notify buyer - their offer expired
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.buyer_id,
            type: 'offer_expired',
            title: 'Offer Expired',
            message: `Your offer of ${formatPrice(offer.offer_amount)} on "${listingTitle}" has expired.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.buyer_id,
          'Offer Expired',
          `Your offer of ${formatPrice(offer.offer_amount)} on "${listingTitle}" has expired.`,
          { type: 'offer_expired', offerId: offer.id, listingId: offer.listing_id }
        );

        // Notify seller - offer on their item expired
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.seller_id,
            type: 'offer_expired',
            title: 'Offer Expired',
            message: `The offer of ${formatPrice(offer.offer_amount)} from ${offer.buyer?.display_name || 'a buyer'} on "${listingTitle}" has expired.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.seller_id,
          'Offer Expired',
          `The offer of ${formatPrice(offer.offer_amount)} from ${offer.buyer?.display_name || 'a buyer'} on "${listingTitle}" has expired.`,
          { type: 'offer_expired', offerId: offer.id, listingId: offer.listing_id }
        );

        console.log(`[OFFER JOBS] Expired pending offer ${offer.id} for listing "${listingTitle}"`);
      } catch (err) {
        console.error(`[OFFER JOBS] Error expiring pending offer ${offer.id}:`, err);
      }
    }

    return expiredOffers.length;
  } catch (error) {
    console.error('[OFFER JOBS] expirePendingOffers failed:', error);
    return 0;
  }
};

// ============================================
// JOB 2: Expire countered offers past their deadline
// Runs every 5 minutes
// ============================================
export const expireCounteredOffers = async (): Promise<number> => {
  try {
    const now = new Date();

    const expiredOffers = await prisma.offers.findMany({
      where: {
        status: 'COUNTERED',
        expires_at: { lt: now },
      },
      include: {
        listings: {
          select: { title: true, images: true },
        },
        buyer: { select: { display_name: true } },
        seller: { select: { display_name: true } },
      },
    });

    if (expiredOffers.length === 0) return 0;

    console.log(`[OFFER JOBS] Expiring ${expiredOffers.length} countered offer(s)`);

    for (const offer of expiredOffers) {
      try {
        await prisma.offers.update({
          where: { id: offer.id },
          data: { status: 'EXPIRED' },
        });

        const listingTitle = offer.listings?.title || 'Unknown item';
        const imageUrl = (offer.listings?.images as any)?.[0]?.image_url || null;

        // Notify buyer - the counter offer they received has expired
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.buyer_id,
            type: 'offer_expired',
            title: 'Counter Offer Expired',
            message: `The counter offer of ${formatPrice(offer.counter_amount)} on "${listingTitle}" has expired.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.buyer_id,
          'Counter Offer Expired',
          `The counter offer of ${formatPrice(offer.counter_amount)} on "${listingTitle}" has expired.`,
          { type: 'offer_expired', offerId: offer.id, listingId: offer.listing_id }
        );

        // Notify seller - their counter offer expired without response
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.seller_id,
            type: 'offer_expired',
            title: 'Counter Offer Expired',
            message: `Your counter offer of ${formatPrice(offer.counter_amount)} on "${listingTitle}" to ${offer.buyer?.display_name || 'a buyer'} has expired.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.seller_id,
          'Counter Offer Expired',
          `Your counter offer of ${formatPrice(offer.counter_amount)} on "${listingTitle}" has expired.`,
          { type: 'offer_expired', offerId: offer.id, listingId: offer.listing_id }
        );

        console.log(`[OFFER JOBS] Expired countered offer ${offer.id} for listing "${listingTitle}"`);
      } catch (err) {
        console.error(`[OFFER JOBS] Error expiring countered offer ${offer.id}:`, err);
      }
    }

    return expiredOffers.length;
  } catch (error) {
    console.error('[OFFER JOBS] expireCounteredOffers failed:', error);
    return 0;
  }
};

// ============================================
// JOB 3: Void accepted offers that weren't purchased in time
// Runs every 5 minutes
// ============================================
export const voidUnpurchasedOffers = async (): Promise<number> => {
  try {
    const now = new Date();

    const voidOffers = await prisma.offers.findMany({
      where: {
        status: { in: ['ACCEPTED', 'COUNTER_ACCEPTED'] },
        acceptance_expires_at: { lt: now },
      },
      include: {
        listings: {
          select: { title: true, images: true },
        },
        buyer: { select: { display_name: true } },
        seller: { select: { display_name: true } },
      },
    });

    if (voidOffers.length === 0) return 0;

    console.log(`[OFFER JOBS] Voiding ${voidOffers.length} unpurchased offer(s)`);

    for (const offer of voidOffers) {
      try {
        // Update status to VOID
        await prisma.offers.update({
          where: { id: offer.id },
          data: { status: 'VOID' },
        });

        // Remove any cart items referencing this offer
        const deletedCartItems = await prisma.cart_items.deleteMany({
          where: { offer_id: offer.id },
        });

        if (deletedCartItems.count > 0) {
          console.log(`[OFFER JOBS] Removed ${deletedCartItems.count} cart item(s) for voided offer ${offer.id}`);
        }

        const listingTitle = offer.listings?.title || 'Unknown item';
        const finalPrice = offer.final_amount || offer.counter_amount || offer.offer_amount;
        const imageUrl = (offer.listings?.images as any)?.[0]?.image_url || null;

        // Notify buyer - they didn't complete the purchase in time
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.buyer_id,
            type: 'offer_void',
            title: 'Offer Voided',
            message: `Your accepted offer of ${formatPrice(finalPrice)} on "${listingTitle}" has been voided because the purchase wasn't completed in time.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.buyer_id,
          'Offer Voided',
          `Your accepted offer on "${listingTitle}" has been voided - purchase window expired.`,
          { type: 'offer_void', offerId: offer.id, listingId: offer.listing_id }
        );

        // Notify seller - the buyer didn't complete the purchase
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.seller_id,
            type: 'offer_void',
            title: 'Offer Voided',
            message: `The accepted offer of ${formatPrice(finalPrice)} from ${offer.buyer?.display_name || 'a buyer'} on "${listingTitle}" has been voided - they didn't complete the purchase in time. Your item is available for other buyers.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.seller_id,
          'Offer Voided',
          `The accepted offer on "${listingTitle}" has been voided - buyer didn't purchase in time. Your item is available again.`,
          { type: 'offer_void', offerId: offer.id, listingId: offer.listing_id }
        );

        console.log(`[OFFER JOBS] Voided offer ${offer.id} for listing "${listingTitle}"`);
      } catch (err) {
        console.error(`[OFFER JOBS] Error voiding offer ${offer.id}:`, err);
      }
    }

    return voidOffers.length;
  } catch (error) {
    console.error('[OFFER JOBS] voidUnpurchasedOffers failed:', error);
    return 0;
  }
};

// ============================================
// JOB 4: Send expiry warnings for accepted offers approaching deadline
// Runs every 15 minutes
// ============================================
export const sendExpiryWarnings = async (): Promise<number> => {
  try {
    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const expiringOffers = await prisma.offers.findMany({
      where: {
        status: { in: ['ACCEPTED', 'COUNTER_ACCEPTED'] },
        acceptance_expires_at: {
          gt: now,
          lte: twoHoursFromNow,
        },
        warning_sent: false,
      },
      include: {
        listings: {
          select: { title: true, images: true },
        },
      },
    });

    if (expiringOffers.length === 0) return 0;

    console.log(`[OFFER JOBS] Sending ${expiringOffers.length} expiry warning(s)`);

    for (const offer of expiringOffers) {
      try {
        // Mark warning as sent first to avoid duplicate warnings
        await prisma.offers.update({
          where: { id: offer.id },
          data: { warning_sent: true },
        });

        const listingTitle = offer.listings?.title || 'Unknown item';
        const finalPrice = offer.final_amount || offer.counter_amount || offer.offer_amount;
        const imageUrl = (offer.listings?.images as any)?.[0]?.image_url || null;

        // Notify buyer - time is running out to complete purchase
        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.buyer_id,
            type: 'offer_expiring',
            title: 'Hurry! Offer Expiring Soon',
            message: `2 hours left to purchase "${listingTitle}" at ${formatPrice(finalPrice)}. Complete your purchase before the offer expires!`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.buyer_id,
          'Hurry! Offer Expiring Soon',
          `2 hours left to purchase "${listingTitle}" at ${formatPrice(finalPrice)}!`,
          { type: 'offer_expiring', offerId: offer.id, listingId: offer.listing_id }
        );

        console.log(`[OFFER JOBS] Sent expiry warning for offer ${offer.id} on "${listingTitle}"`);
      } catch (err) {
        console.error(`[OFFER JOBS] Error sending expiry warning for offer ${offer.id}:`, err);
      }
    }

    return expiringOffers.length;
  } catch (error) {
    console.error('[OFFER JOBS] sendExpiryWarnings failed:', error);
    return 0;
  }
};

// ============================================
// JOB 5: Expire all active offers when an item is sold
// Called directly when a purchase completes - not on a schedule
// ============================================
export const expireOffersForSoldItem = async (listingId: string): Promise<number> => {
  try {
    const activeOffers = await prisma.offers.findMany({
      where: {
        listing_id: listingId,
        status: { in: ['PENDING', 'ACCEPTED', 'COUNTERED', 'COUNTER_ACCEPTED'] },
      },
      include: {
        listings: {
          select: { title: true, images: true },
        },
        seller: { select: { display_name: true } },
      },
    });

    if (activeOffers.length === 0) return 0;

    console.log(`[OFFER JOBS] Expiring ${activeOffers.length} offer(s) for sold listing ${listingId}`);

    // Collect all offer IDs for batch cart item removal
    const offerIds = activeOffers.map((o) => o.id);

    // Batch update all offers to EXPIRED
    await prisma.offers.updateMany({
      where: {
        id: { in: offerIds },
      },
      data: { status: 'EXPIRED' },
    });

    // Batch remove all cart items referencing any of these offers
    const deletedCartItems = await prisma.cart_items.deleteMany({
      where: { offer_id: { in: offerIds } },
    });

    if (deletedCartItems.count > 0) {
      console.log(`[OFFER JOBS] Removed ${deletedCartItems.count} cart item(s) for sold listing ${listingId}`);
    }

    // Notify each affected buyer individually
    for (const offer of activeOffers) {
      try {
        const listingTitle = offer.listings?.title || 'Unknown item';
        const imageUrl = (offer.listings?.images as any)?.[0]?.image_url || null;

        await prisma.notifications.create({
          data: {
            id: generateNotifId(),
            user_id: offer.buyer_id,
            type: 'offer_expired',
            title: 'Item Sold',
            message: `"${listingTitle}" has been sold to another buyer. Your offer has been cancelled.`,
            related_id: offer.id,
            image_url: imageUrl,
          },
        });

        await sendPushNotification(
          offer.buyer_id,
          'Item Sold',
          `"${listingTitle}" has been sold. Your offer has been cancelled.`,
          { type: 'offer_expired', offerId: offer.id, listingId: offer.listing_id }
        );
      } catch (err) {
        console.error(`[OFFER JOBS] Error notifying buyer for offer ${offer.id} on sold item:`, err);
      }
    }

    return activeOffers.length;
  } catch (error) {
    console.error(`[OFFER JOBS] expireOffersForSoldItem failed for listing ${listingId}:`, error);
    return 0;
  }
};

// ============================================
// MAIN ENTRY POINT: Run all scheduled offer jobs
// Called by cron scheduler every 5 minutes
// NOTE: sendExpiryWarnings runs on its own 15-min cron — NOT included here
// ============================================
export const runOfferJobs = async (): Promise<void> => {
  const startTime = Date.now();
  console.log(`[OFFER JOBS] === Starting offer jobs at ${new Date().toISOString()} ===`);

  let expiredPending = 0;
  let expiredCountered = 0;
  let voided = 0;

  // Run jobs in sequence to avoid race conditions on overlapping data
  try {
    expiredPending = await expirePendingOffers();
  } catch (error) {
    console.error('[OFFER JOBS] expirePendingOffers threw unexpected error:', error);
  }

  try {
    expiredCountered = await expireCounteredOffers();
  } catch (error) {
    console.error('[OFFER JOBS] expireCounteredOffers threw unexpected error:', error);
  }

  try {
    voided = await voidUnpurchasedOffers();
  } catch (error) {
    console.error('[OFFER JOBS] voidUnpurchasedOffers threw unexpected error:', error);
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[OFFER JOBS] === Completed in ${elapsed}ms | ` +
    `Expired pending: ${expiredPending}, ` +
    `Expired countered: ${expiredCountered}, ` +
    `Voided: ${voided} ===`
  );
};
