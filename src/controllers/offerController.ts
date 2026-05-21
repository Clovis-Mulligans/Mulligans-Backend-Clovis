// src/controllers/offerController.ts
// Offer system for negotiable listings
// - Buyers can make up to 3 offers per listing
// - Sellers can accept, decline, or counter (once per offer)
// - Buyers can accept/decline counters or withdraw offers
// - 24-hour expiry on offers and accepted offers
// - In-app + push notifications on all state changes
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #3]  CRITICAL: Race condition fix — all status-changing endpoints now use
//             prisma.offers.updateMany with conditional where clause instead of
//             read-then-update. Returns 409 Conflict if another request changed status first.
// [Issue #9]  HIGH: acceptOffer now checks expires_at before accepting.
// [Issue #10] HIGH: counterOffer, declineOffer, acceptCounter, declineCounter also
//             check expires_at before proceeding.
// [Issue #13] Removed offer_price from destructured request body — validated price
//             comes from the offer object only.
// [Issue #19] Replaced `new PrismaClient()` with shared singleton `import { prisma }`.
// [Issue #20] Replaced Math.random() ID generation with crypto.randomUUID().
// [Issue #21] acceptOffer now voids all OTHER active offers on the same listing
//             after accepting one.
// [Issue #22] All notification messages now include the £ symbol before amounts.
// [Issue #35] getOfferCounts now filters out expired offers from pending counts.

import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { sendPushNotification } from './pushNotificationController';

// ============================================
// CONSTANTS
// ============================================
const OFFER_EXPIRY_HOURS = 24;
const OFFER_EXPIRY_MS = OFFER_EXPIRY_HOURS * 60 * 60 * 1000;
const ACCEPTANCE_EXPIRY_HOURS = 24;
const ACCEPTANCE_EXPIRY_MS = ACCEPTANCE_EXPIRY_HOURS * 60 * 60 * 1000;
const MIN_OFFER_PERCENTAGE = 0.5; // 50% of list price
const MAX_OFFERS_PER_LISTING = 3;

// Statuses that count as "active" (not terminal)
const ACTIVE_OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'COUNTERED', 'COUNTER_ACCEPTED'];

// ============================================
// HELPER: Generate notification ID
// [Issue #20] crypto.randomUUID replaces Math.random
// ============================================
function generateNotificationId(): string {
  return `notif_${crypto.randomUUID()}`;
}

// ============================================
// HELPER: Generate offer ID
// [Issue #20] crypto.randomUUID replaces Math.random
// ============================================
function generateOfferId(): string {
  return `offer_${crypto.randomUUID()}`;
}

// ============================================
// HELPER: Send in-app + push notification
// ============================================
async function notifyUser(
  userId: string,
  title: string,
  message: string,
  relatedId: string,
  imageUrl: string | null,
  offerId: string,
  listingId?: string
): Promise<void> {
  const notifId = generateNotificationId();
  // In-app notification
  await prisma.notifications.create({
    data: {
      id: notifId,
      user_id: userId,
      type: 'offer',
      title,
      message,
      related_id: relatedId,
      image_url: imageUrl,
    },
  });

  // Push notification
  try {
    await sendPushNotification(userId, title, message, {
      notification_id: notifId,
      type: 'offer',
      offer_id: offerId,
      listing_id: listingId,
    });
  } catch (e) {
    console.error('[OFFERS] Push failed:', e);
  }
}

// ============================================
// OFFER CONTROLLER
// ============================================
export class OfferController {
  // ============================================
  // CREATE OFFER
  // POST /api/offers
  // ============================================
  static async createOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { listing_id, offer_amount } = req.body;

      // Validate required fields
      if (!listing_id || offer_amount === undefined || offer_amount === null) {
        return res.status(400).json({ error: 'listing_id and offer_amount are required' });
      }

      const offerAmount = parseFloat(offer_amount);
      if (isNaN(offerAmount) || offerAmount <= 0) {
        return res.status(400).json({ error: 'offer_amount must be a positive number' });
      }

      // Get the listing
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: {
            take: 1,
            orderBy: PRIMARY_IMAGE_ORDER,
          },
          users: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      if (listing.status !== 'active') {
        return res.status(400).json({ error: 'This listing is no longer active' });
      }

      if (!listing.is_negotiable) {
        return res.status(400).json({ error: 'This listing does not accept offers' });
      }

      // Cannot offer on own listing
      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot make an offer on your own listing' });
      }

      const listPrice = parseFloat(listing.price.toString());
      const minOffer = listPrice * MIN_OFFER_PERCENTAGE;

      // Validate offer amount range
      if (offerAmount < minOffer) {
        return res.status(400).json({
          error: `Your offer of £${offerAmount.toFixed(2)} is below the minimum of £${minOffer.toFixed(2)}. Sellers won't see offers below 50% of the listing price.`,
          min_offer: Number(minOffer.toFixed(2)),
          list_price: listPrice,
        });
      }

      if (offerAmount > listPrice) {
        return res.status(400).json({
          error: 'Offer cannot exceed the list price',
          max_offer: listPrice,
          list_price: listPrice,
        });
      }

      // Count existing offers by this buyer on this listing
      const existingOffers = await prisma.offers.findMany({
        where: {
          listing_id,
          buyer_id: userId,
        },
        orderBy: { created_at: 'desc' },
      });

      const offersUsed = existingOffers.length;

      if (offersUsed >= MAX_OFFERS_PER_LISTING) {
        return res.status(400).json({
          error: 'You have used all 3 offers for this listing',
          offers_used: offersUsed,
          offers_remaining: 0,
        });
      }

      // Check if buyer already has an active offer on this listing
      const activeOffer = existingOffers.find((o) =>
        ACTIVE_OFFER_STATUSES.includes(o.status)
      );

      if (activeOffer) {
        return res.status(400).json({
          error: 'You already have an active offer on this listing',
          active_offer_id: activeOffer.id,
          active_offer_status: activeOffer.status,
        });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + OFFER_EXPIRY_MS);
      const offerNumber = offersUsed + 1;

      // Create the offer
      const offer = await prisma.offers.create({
        data: {
          id: generateOfferId(),
          listing_id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          list_price: listPrice,
          offer_amount: offerAmount,
          status: 'PENDING',
          offer_number: offerNumber,
          created_at: now,
          expires_at: expiresAt,
        },
      });

      const listingImage = listing.images[0]?.image_url || null;

      // Get buyer display name for the notification
      const buyer = await prisma.users.findUnique({
        where: { id: userId },
        select: { display_name: true },
      });

      // [Issue #22] £ symbol in notification
      // Notify seller
      await notifyUser(
        listing.seller_id,
        'New Offer Received',
        `${buyer?.display_name || 'A buyer'} offered £${offerAmount.toFixed(2)} for "${listing.title}"`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Offer created: ${offer.id} - £${offerAmount.toFixed(2)} on listing ${listing_id}`);

      res.status(201).json({
        success: true,
        offer: {
          id: offer.id,
          listing_id: offer.listing_id,
          offer_amount: Number(offer.offer_amount),
          status: offer.status,
          offer_number: offer.offer_number,
          expires_at: offer.expires_at.toISOString(),
          created_at: offer.created_at!.toISOString(),
        },
        offers_remaining: MAX_OFFERS_PER_LISTING - offerNumber,
      });
    } catch (error: any) {
      console.error('[OFFERS] Create offer error:', error);
      res.status(500).json({ error: 'Failed to create offer' });
    }
  }

  // ============================================
  // GET MY OFFERS (offers I made as buyer)
  // GET /api/offers/my-offers
  // ============================================
  static async getMyOffers(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const offers = await prisma.offers.findMany({
        where: { buyer_id: userId },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              status: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
          seller: {
            select: {
              id: true,
              display_name: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      const formattedOffers = offers.map((offer) => ({
        id: offer.id,
        listing_id: offer.listing_id,
        seller_id: offer.seller_id,
        offer_amount: Number(offer.offer_amount),
        counter_amount: offer.counter_amount ? Number(offer.counter_amount) : null,
        final_amount: offer.final_amount ? Number(offer.final_amount) : null,
        list_price: Number(offer.list_price),
        status: offer.status,
        offer_number: offer.offer_number,
        created_at: offer.created_at!.toISOString(),
        expires_at: offer.expires_at.toISOString(),
        responded_at: offer.responded_at?.toISOString() || null,
        acceptance_expires_at: offer.acceptance_expires_at?.toISOString() || null,
        listing: {
          id: offer.listings.id,
          title: offer.listings.title,
          price: Number(offer.listings.price),
          status: offer.listings.status,
          image: offer.listings.images[0]?.image_url || null,
        },
        seller: offer.seller ? {
          id: offer.seller.id,
          display_name: offer.seller.display_name,
          is_pro_store: offer.seller.is_pro_store,
          pro_store_name: offer.seller.pro_store_name,
        } : undefined,
      }));

      res.json({ offers: formattedOffers });
    } catch (error: any) {
      console.error('[OFFERS] Get my offers error:', error);
      res.status(500).json({ error: 'Failed to get offers' });
    }
  }

  // ============================================
  // GET RECEIVED OFFERS (offers on my listings)
  // GET /api/offers/received
  // ============================================
  static async getReceivedOffers(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const offers = await prisma.offers.findMany({
        where: { seller_id: userId },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              status: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
          buyer: {
            select: {
              id: true,
              display_name: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      const formattedOffers = offers.map((offer) => ({
        id: offer.id,
        listing_id: offer.listing_id,
        buyer_id: offer.buyer_id,
        offer_amount: Number(offer.offer_amount),
        counter_amount: offer.counter_amount ? Number(offer.counter_amount) : null,
        final_amount: offer.final_amount ? Number(offer.final_amount) : null,
        list_price: Number(offer.list_price),
        status: offer.status,
        offer_number: offer.offer_number,
        created_at: offer.created_at!.toISOString(),
        expires_at: offer.expires_at.toISOString(),
        responded_at: offer.responded_at?.toISOString() || null,
        acceptance_expires_at: offer.acceptance_expires_at?.toISOString() || null,
        listing: {
          id: offer.listings.id,
          title: offer.listings.title,
          price: Number(offer.listings.price),
          status: offer.listings.status,
          image: offer.listings.images[0]?.image_url || null,
        },
        buyer: {
          id: offer.buyer.id,
          display_name: offer.buyer.display_name,
          is_pro_store: offer.buyer.is_pro_store,
          pro_store_name: offer.buyer.pro_store_name,
        },
      }));

      res.json({ offers: formattedOffers });
    } catch (error: any) {
      console.error('[OFFERS] Get received offers error:', error);
      res.status(500).json({ error: 'Failed to get received offers' });
    }
  }

  // ============================================
  // GET OFFER BY ID
  // GET /api/offers/:id
  // ============================================
  static async getOfferById(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              status: true,
              is_negotiable: true,
              quantity: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
          buyer: {
            select: {
              id: true,
              display_name: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
          seller: {
            select: {
              id: true,
              display_name: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Must be buyer or seller
      if (offer.buyer_id !== userId && offer.seller_id !== userId) {
        return res.status(403).json({ error: 'You are not authorized to view this offer' });
      }

      const isBuyer = offer.buyer_id === userId;

      res.json({
        offer: {
          id: offer.id,
          listing_id: offer.listing_id,
          buyer_id: offer.buyer_id,
          seller_id: offer.seller_id,
          list_price: Number(offer.list_price),
          offer_amount: Number(offer.offer_amount),
          counter_amount: offer.counter_amount ? Number(offer.counter_amount) : null,
          final_amount: offer.final_amount ? Number(offer.final_amount) : null,
          status: offer.status,
          offer_number: offer.offer_number,
          created_at: offer.created_at!.toISOString(),
          expires_at: offer.expires_at.toISOString(),
          responded_at: offer.responded_at?.toISOString() || null,
          acceptance_expires_at: offer.acceptance_expires_at?.toISOString() || null,
          purchased_at: offer.purchased_at?.toISOString() || null,
          listing: {
            id: offer.listings.id,
            title: offer.listings.title,
            price: Number(offer.listings.price),
            status: offer.listings.status,
            is_negotiable: offer.listings.is_negotiable,
            quantity: offer.listings.quantity,
            image: offer.listings.images[0]?.image_url || null,
          },
          buyer: {
            id: offer.buyer.id,
            display_name: offer.buyer.display_name,
            is_pro_store: offer.buyer.is_pro_store,
            pro_store_name: offer.buyer.pro_store_name,
          },
          seller: {
            id: offer.seller.id,
            display_name: offer.seller.display_name,
            is_pro_store: offer.seller.is_pro_store,
            pro_store_name: offer.seller.pro_store_name,
          },
          is_buyer: isBuyer,
          is_seller: !isBuyer,
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Get offer by ID error:', error);
      res.status(500).json({ error: 'Failed to get offer' });
    }
  }

  // ============================================
  // ACCEPT OFFER (seller accepts buyer's offer)
  // PUT /api/offers/:id/accept
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #9]  Expiry check before accepting
  // [Issue #21] Void other active offers on same listing
  // [Issue #22] £ symbol in notification
  // ============================================
  static async acceptOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
          buyer: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only seller can accept
      if (offer.seller_id !== userId) {
        return res.status(403).json({ error: 'Only the seller can accept this offer' });
      }

      if (offer.status !== 'PENDING') {
        return res.status(400).json({ error: `Cannot accept an offer with status "${offer.status}"` });
      }

      // [Issue #9] Check if offer has expired
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This offer has expired' });
      }

      const now = new Date();
      const acceptanceExpiresAt = new Date(now.getTime() + ACCEPTANCE_EXPIRY_MS);
      const offerAmount = Number(offer.offer_amount);

      // [Issue #3] Atomic conditional update — only update if status is still PENDING
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          responded_at: now,
          acceptance_expires_at: acceptanceExpiresAt,
          final_amount: offerAmount,
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      // [Issue #21] Void all OTHER active offers on the same listing
      await prisma.offers.updateMany({
        where: {
          listing_id: offer.listing_id,
          id: { not: offer.id },
          status: { in: ['PENDING', 'COUNTERED'] },
        },
        data: {
          status: 'VOID',
          responded_at: now,
        },
      });

      const listingImage = offer.listings.images[0]?.image_url || null;

      // [Issue #22] £ symbol in notification
      // Notify buyer
      await notifyUser(
        offer.buyer_id,
        'Offer Accepted!',
        `Your offer of £${offerAmount.toFixed(2)} for "${offer.listings.title}" has been accepted! Complete your purchase within 24 hours.`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Offer accepted: ${offer.id}`);

      res.json({
        success: true,
        message: 'Offer accepted',
        offer: {
          id: offer.id,
          status: 'ACCEPTED',
          final_amount: offerAmount,
          acceptance_expires_at: acceptanceExpiresAt.toISOString(),
          responded_at: now.toISOString(),
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Accept offer error:', error);
      res.status(500).json({ error: 'Failed to accept offer' });
    }
  }

  // ============================================
  // DECLINE OFFER (seller declines buyer's offer)
  // PUT /api/offers/:id/decline
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #10] Expiry check before declining
  // [Issue #22] £ symbol in notification
  // ============================================
  static async declineOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
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
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only seller can decline
      if (offer.seller_id !== userId) {
        return res.status(403).json({ error: 'Only the seller can decline this offer' });
      }

      if (offer.status !== 'PENDING') {
        return res.status(400).json({ error: `Cannot decline an offer with status "${offer.status}"` });
      }

      // [Issue #10] Check if offer has expired
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This offer has expired' });
      }

      const now = new Date();

      // [Issue #3] Atomic conditional update
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'DECLINED',
          responded_at: now,
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      const listingImage = offer.listings.images[0]?.image_url || null;
      const offerAmount = Number(offer.offer_amount);

      // [Issue #22] £ symbol in notification
      // Notify buyer
      await notifyUser(
        offer.buyer_id,
        'Offer Declined',
        `Your offer of £${offerAmount.toFixed(2)} for "${offer.listings.title}" was declined by the seller.`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Offer declined: ${offer.id}`);

      res.json({
        success: true,
        message: 'Offer declined',
        offer: {
          id: offer.id,
          status: 'DECLINED',
          responded_at: now.toISOString(),
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Decline offer error:', error);
      res.status(500).json({ error: 'Failed to decline offer' });
    }
  }

  // ============================================
  // COUNTER OFFER (seller counters buyer's offer)
  // PUT /api/offers/:id/counter
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #10] Expiry check before countering
  // [Issue #22] £ symbol in notification
  // ============================================
  static async counterOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;
      const { counter_amount } = req.body;

      if (counter_amount === undefined || counter_amount === null) {
        return res.status(400).json({ error: 'counter_amount is required' });
      }

      const counterAmount = parseFloat(counter_amount);
      if (isNaN(counterAmount) || counterAmount <= 0) {
        return res.status(400).json({ error: 'counter_amount must be a positive number' });
      }

      const offer = await prisma.offers.findUnique({
        where: { id },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only seller can counter
      if (offer.seller_id !== userId) {
        return res.status(403).json({ error: 'Only the seller can counter this offer' });
      }

      if (offer.status !== 'PENDING') {
        return res.status(400).json({ error: `Cannot counter an offer with status "${offer.status}"` });
      }

      // [Issue #10] Check if offer has expired
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This offer has expired' });
      }

      const offerAmount = Number(offer.offer_amount);
      const listPrice = Number(offer.listings.price);

      // Counter must be between offer amount and list price
      if (counterAmount <= offerAmount) {
        return res.status(400).json({
          error: 'Counter amount must be greater than the offer amount',
          offer_amount: offerAmount,
          counter_amount: counterAmount,
        });
      }

      if (counterAmount > listPrice) {
        return res.status(400).json({
          error: 'Counter amount cannot exceed the list price',
          list_price: listPrice,
          counter_amount: counterAmount,
        });
      }

      const now = new Date();
      const newExpiresAt = new Date(now.getTime() + OFFER_EXPIRY_MS);

      // [Issue #3] Atomic conditional update
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'COUNTERED',
          counter_amount: counterAmount,
          responded_at: now,
          expires_at: newExpiresAt,
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      const listingImage = offer.listings.images[0]?.image_url || null;

      // [Issue #22] £ symbol in notification
      // Notify buyer
      await notifyUser(
        offer.buyer_id,
        'Counter Offer Received',
        `The seller has countered your offer with £${counterAmount.toFixed(2)} for "${offer.listings.title}". You have 24 hours to respond.`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Offer countered: ${offer.id} - counter: £${counterAmount.toFixed(2)}`);

      res.json({
        success: true,
        message: 'Counter offer sent',
        offer: {
          id: offer.id,
          status: 'COUNTERED',
          counter_amount: counterAmount,
          expires_at: newExpiresAt.toISOString(),
          responded_at: now.toISOString(),
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Counter offer error:', error);
      res.status(500).json({ error: 'Failed to counter offer' });
    }
  }

  // ============================================
  // ACCEPT COUNTER (buyer accepts seller's counter)
  // PUT /api/offers/:id/accept-counter
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #10] Expiry check before accepting counter
  // [Issue #22] £ symbol in notification
  // ============================================
  static async acceptCounter(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
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
          seller: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only buyer can accept counter
      if (offer.buyer_id !== userId) {
        return res.status(403).json({ error: 'Only the buyer can accept a counter offer' });
      }

      if (offer.status !== 'COUNTERED') {
        return res.status(400).json({ error: `Cannot accept counter on an offer with status "${offer.status}"` });
      }

      // [Issue #10] Check if countered offer has expired
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This offer has expired' });
      }

      const now = new Date();
      const acceptanceExpiresAt = new Date(now.getTime() + ACCEPTANCE_EXPIRY_MS);
      const counterAmount = Number(offer.counter_amount);

      // [Issue #3] Atomic conditional update
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: 'COUNTERED' },
        data: {
          status: 'COUNTER_ACCEPTED',
          acceptance_expires_at: acceptanceExpiresAt,
          final_amount: counterAmount,
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      const listingImage = offer.listings.images[0]?.image_url || null;

      // [Issue #22] £ symbol in notification
      // Notify seller
      await notifyUser(
        offer.seller_id,
        'Counter Offer Accepted!',
        `The buyer accepted your counter offer of £${counterAmount.toFixed(2)} for "${offer.listings.title}". Waiting for them to complete the purchase.`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Counter accepted: ${offer.id}`);

      res.json({
        success: true,
        message: 'Counter offer accepted',
        offer: {
          id: offer.id,
          status: 'COUNTER_ACCEPTED',
          final_amount: counterAmount,
          acceptance_expires_at: acceptanceExpiresAt.toISOString(),
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Accept counter error:', error);
      res.status(500).json({ error: 'Failed to accept counter offer' });
    }
  }

  // ============================================
  // DECLINE COUNTER (buyer declines seller's counter)
  // PUT /api/offers/:id/decline-counter
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #10] Expiry check before declining counter
  // [Issue #22] £ symbol in notification
  // ============================================
  static async declineCounter(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
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
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only buyer can decline counter
      if (offer.buyer_id !== userId) {
        return res.status(403).json({ error: 'Only the buyer can decline a counter offer' });
      }

      if (offer.status !== 'COUNTERED') {
        return res.status(400).json({ error: `Cannot decline counter on an offer with status "${offer.status}"` });
      }

      // [Issue #10] Check if countered offer has expired
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This offer has expired' });
      }

      // [Issue #3] Atomic conditional update
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: 'COUNTERED' },
        data: {
          status: 'COUNTER_DECLINED',
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      const listingImage = offer.listings.images[0]?.image_url || null;
      const counterAmount = Number(offer.counter_amount);

      // [Issue #22] £ symbol in notification
      // Notify seller
      await notifyUser(
        offer.seller_id,
        'Counter Offer Declined',
        `The buyer declined your counter offer of £${counterAmount.toFixed(2)} for "${offer.listings.title}".`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Counter declined: ${offer.id}`);

      res.json({
        success: true,
        message: 'Counter offer declined',
        offer: {
          id: offer.id,
          status: 'COUNTER_DECLINED',
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Decline counter error:', error);
      res.status(500).json({ error: 'Failed to decline counter offer' });
    }
  }

  // ============================================
  // WITHDRAW OFFER (buyer withdraws their offer)
  // PUT /api/offers/:id/withdraw
  // [Issue #3]  Race condition fix: conditional updateMany
  // [Issue #22] £ symbol in notification
  // ============================================
  static async withdrawOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id } = req.params;

      const offer = await prisma.offers.findUnique({
        where: { id },
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
        },
      });

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }

      // Only buyer can withdraw
      if (offer.buyer_id !== userId) {
        return res.status(403).json({ error: 'Only the buyer can withdraw this offer' });
      }

      if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') {
        return res.status(400).json({ error: `Cannot withdraw an offer with status "${offer.status}"` });
      }

      // [Issue #3] Atomic conditional update — match either PENDING or COUNTERED
      const updateResult = await prisma.offers.updateMany({
        where: { id, status: { in: ['PENDING', 'COUNTERED'] } },
        data: {
          status: 'WITHDRAWN',
        },
      });

      if (updateResult.count === 0) {
        return res.status(409).json({ error: 'Offer status has already changed. Please refresh and try again.' });
      }

      const listingImage = offer.listings.images[0]?.image_url || null;
      const offerAmount = Number(offer.offer_amount);

      // [Issue #22] £ symbol in notification
      // Notify seller
      await notifyUser(
        offer.seller_id,
        'Offer Withdrawn',
        `The buyer withdrew their offer of £${offerAmount.toFixed(2)} for "${offer.listings.title}".`,
        offer.id,
        listingImage,
        offer.id,
        offer.listing_id
      );

      console.log(`[OFFERS] Offer withdrawn: ${offer.id}`);

      res.json({
        success: true,
        message: 'Offer withdrawn',
        offer: {
          id: offer.id,
          status: 'WITHDRAWN',
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Withdraw offer error:', error);
      res.status(500).json({ error: 'Failed to withdraw offer' });
    }
  }

  // ============================================
  // GET MY OFFER ON LISTING (buyer's latest active offer)
  // GET /api/listings/:listingId/my-offer
  // ============================================
  static async getMyOfferOnListing(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { listingId } = req.params;

      const offer = await prisma.offers.findFirst({
        where: {
          listing_id: listingId,
          buyer_id: userId,
          status: { in: ACTIVE_OFFER_STATUSES },
        },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      if (!offer) {
        return res.json({ offer: null });
      }

      res.json({
        offer: {
          id: offer.id,
          listing_id: offer.listing_id,
          offer_amount: Number(offer.offer_amount),
          counter_amount: offer.counter_amount ? Number(offer.counter_amount) : null,
          final_amount: offer.final_amount ? Number(offer.final_amount) : null,
          status: offer.status,
          offer_number: offer.offer_number,
          created_at: offer.created_at!.toISOString(),
          expires_at: offer.expires_at.toISOString(),
          responded_at: offer.responded_at?.toISOString() || null,
          acceptance_expires_at: offer.acceptance_expires_at?.toISOString() || null,
          listing: {
            id: offer.listings.id,
            title: offer.listings.title,
            price: Number(offer.listings.price),
            image: offer.listings.images[0]?.image_url || null,
          },
        },
      });
    } catch (error: any) {
      console.error('[OFFERS] Get my offer on listing error:', error);
      res.status(500).json({ error: 'Failed to get offer' });
    }
  }

  // ============================================
  // GET OFFER STATUS (can buyer make an offer?)
  // GET /api/listings/:listingId/offer-status
  // ============================================
  static async getOfferStatus(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { listingId } = req.params;

      // Get the listing
      const listing = await prisma.listings.findUnique({
        where: { id: listingId },
        select: {
          id: true,
          seller_id: true,
          status: true,
          is_negotiable: true,
          price: true,
        },
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      // Check if it's the user's own listing
      if (listing.seller_id === userId) {
        return res.json({
          can_make_offer: false,
          reason: 'own_listing',
          offers_used: 0,
          offers_remaining: 0,
          active_offer: null,
        });
      }

      // Check if listing is negotiable
      if (!listing.is_negotiable) {
        return res.json({
          can_make_offer: false,
          reason: 'not_negotiable',
          offers_used: 0,
          offers_remaining: 0,
          active_offer: null,
        });
      }

      // Check if listing is active
      if (listing.status !== 'active') {
        return res.json({
          can_make_offer: false,
          reason: 'listing_inactive',
          offers_used: 0,
          offers_remaining: 0,
          active_offer: null,
        });
      }

      // Count all offers by this buyer on this listing
      const allOffers = await prisma.offers.findMany({
        where: {
          listing_id: listingId,
          buyer_id: userId,
        },
        orderBy: { created_at: 'desc' },
      });

      const offersUsed = allOffers.length;
      const offersRemaining = Math.max(0, MAX_OFFERS_PER_LISTING - offersUsed);

      // Check for active offer
      const activeOffer = allOffers.find((o) =>
        ACTIVE_OFFER_STATUSES.includes(o.status)
      );

      let formattedActiveOffer = null;
      if (activeOffer) {
        formattedActiveOffer = {
          id: activeOffer.id,
          offer_amount: Number(activeOffer.offer_amount),
          counter_amount: activeOffer.counter_amount ? Number(activeOffer.counter_amount) : null,
          final_amount: activeOffer.final_amount ? Number(activeOffer.final_amount) : null,
          status: activeOffer.status,
          offer_number: activeOffer.offer_number,
          expires_at: activeOffer.expires_at.toISOString(),
          acceptance_expires_at: activeOffer.acceptance_expires_at?.toISOString() || null,
        };
      }

      // Can make offer if: has remaining offers AND no active offer
      const canMakeOffer = offersRemaining > 0 && !activeOffer;

      let reason: string | null = null;
      if (!canMakeOffer) {
        if (activeOffer) {
          reason = 'active_offer_exists';
        } else if (offersRemaining === 0) {
          reason = 'max_offers_reached';
        }
      }

      res.json({
        can_make_offer: canMakeOffer,
        reason,
        offers_used: offersUsed,
        offers_remaining: offersRemaining,
        active_offer: formattedActiveOffer,
        min_offer: Number((Number(listing.price) * MIN_OFFER_PERCENTAGE).toFixed(2)),
        list_price: Number(listing.price),
      });
    } catch (error: any) {
      console.error('[OFFERS] Get offer status error:', error);
      res.status(500).json({ error: 'Failed to get offer status' });
    }
  }

  // ============================================
  // GET OFFER COUNTS (for notification badges)
  // GET /api/offers/counts
  // [Issue #35] Filter out expired offers from counts
  // ============================================
  static async getOfferCounts(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const now = new Date();

      // [Issue #35] Offers I made that need MY action — exclude expired
      // Countered offers expire based on expires_at (the counter expiry)
      const counteredCount = await prisma.offers.count({
        where: {
          buyer_id: userId,
          status: 'COUNTERED',
          expires_at: { gt: now },
        },
      });
      // Accepted offers expire based on acceptance_expires_at (the 24h payment window)
      const acceptedCount = await prisma.offers.count({
        where: {
          buyer_id: userId,
          status: { in: ['ACCEPTED', 'COUNTER_ACCEPTED'] },
          acceptance_expires_at: { gt: now },
        },
      });
      const offersMadePending = counteredCount + acceptedCount;

      // [Issue #35] Offers I received that need MY action — exclude expired
      const offersReceivedPending = await prisma.offers.count({
        where: {
          seller_id: userId,
          status: 'PENDING',
          expires_at: { gt: now },
        },
      });

      res.json({
        offers_made_pending: offersMadePending,
        offers_received_pending: offersReceivedPending,
        total: offersMadePending + offersReceivedPending,
      });
    } catch (error: any) {
      console.error('[OFFERS] Get offer counts error:', error);
      res.status(500).json({ error: 'Failed to get offer counts' });
    }
  }
}
