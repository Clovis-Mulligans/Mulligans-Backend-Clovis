// ==========================================
// OFFER SYSTEM CHANGES (5 Feb 2026)
// ==========================================
// - Line ~283-286: itemsTotal now uses offer_price when available
// - Line ~301-302: FIXED £0.99 fee from PER SELLER to PER ITEM
// - Line ~333: unit_amount now uses offer_price when available
// - Line ~395-406: Added offer_id/offer_price to Stripe metadata
// - Line ~658-661: Added offer_id/original_list_price/discount_amount to order creation
// ==========================================

// ==========================================
// OFFER SYSTEM FIXES (6 Feb 2026)
// ==========================================
// [Issue #2]  Import and call expireOffersForSoldItem after cart fulfillment when listing stock hits zero
// [Issue #11] Fix offer_map metadata truncation: store per-listing offer data as separate metadata keys
//             (offer_${listing_id} = offerId|price|origPrice) instead of a single JSON blob
// [Issue #12] Fix listing_ids truncation: validate that the last listing_id in the split array is a
//             valid full ID before processing; skip truncated entries
// [Issue #19] Replaced `new PrismaClient()` with shared singleton `import { prisma } from '../lib/prisma'`
// [Issue #23] Added `purchased_at: new Date()` when marking offers as PURCHASED in cart fulfillment
// ==========================================

// ==========================================
// CRITICAL FIXES (9 Feb 2026)
// ==========================================
// [E-C3]  Removed non-null assertion on session.metadata; added explicit null checks
// [P-C2]  seller_payout now includes shipping: (effectivePrice * orderQuantity) + orderShipping
// [D-C2]  Order ID generation changed from Math.random() to crypto.randomUUID()
// [D-C1]  Atomic stock update with updateMany WHERE guard for non-size-variant listings
// ==========================================

// src/controllers/cartCheckoutController.ts
// Handles checkout for cart with multiple items (potentially from multiple sellers)
// ESCROW UPDATE: Removed immediate transfers - funds held until escrow releases
// ESCROW UPDATE: Shipping deadline changed from 7 to 5 days
// FIXED: Now includes image_url in notifications
// UPDATED: Sends order confirmation email to buyer
// QUANTITY UPDATE: Now handles quantities in cart items
// PUSH: Added push notifications

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { sendOrderConfirmation, sendSaleNotification } from '../services/emailService';
import { sendPushNotification } from './pushNotificationController';
import { expireOffersForSoldItem } from '../jobs/offerJobs';
import crypto from 'crypto';
import { autoPurchaseLabel } from '../services/autoShippingService';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    sub?: string;
  };
}

// Platform fee calculation
const PLATFORM_FEE_PERCENT = 0.075; // 7.5%
const PLATFORM_FEE_FIXED = 0.99; // £0.99
const INSURANCE_RATE = 0.0125; // 1.25% shipping insurance (Shippo/XCover)

// Escrow constants
const SHIPPING_DEADLINE_DAYS = 5;

// SIZE VARIANT: Helper to get stock for a specific size
function getStockForSize(listing: any, selectedSize: string | null): number {
  if (!selectedSize) {
    return listing.quantity || 1;
  }
  const specs = listing.specifications as any;
  if (specs?.sizeQuantities && typeof specs.sizeQuantities === 'object') {
    return specs.sizeQuantities[selectedSize] || 0;
  }
  return listing.quantity || 1;
}

// SIZE VARIANT: Helper to decrement stock for a specific size
function decrementSizeStock(specifications: any, selectedSize: string, quantity: number): any {
  if (!specifications || !selectedSize) return specifications;

  const specs = { ...specifications };
  if (specs.sizeQuantities && typeof specs.sizeQuantities === 'object') {
    const currentStock = specs.sizeQuantities[selectedSize] || 0;
    specs.sizeQuantities = {
      ...specs.sizeQuantities,
      [selectedSize]: Math.max(0, currentStock - quantity)
    };
  }
  return specs;
}

// SIZE VARIANT: Helper to calculate total stock from all sizes
function getTotalStockFromSizes(specifications: any): number {
  if (!specifications?.sizeQuantities) return 0;
  return Object.values(specifications.sizeQuantities).reduce((sum: number, qty: any) => sum + (qty || 0), 0);
}

export class CartCheckoutController {
  /**
   * Create Stripe Checkout Session for Cart
   * POST /api/stripe/create-cart-checkout
   */
  static async createCartCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[CART] Creating cart checkout session for user:', userId);

      // Get all cart items for this user
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() },
        },
        include: {
          listings: {
            include: {
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
              users: {
                select: {
                  id: true,
                  email: true,
                  display_name: true,
                  stripe_connect_id: true,
                  stripe_connect_status: true,
                },
              },
            },
          },
        },
      });

      if (cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
      }

      // Validate all items are still available
      const unavailableItems = cartItems.filter(
        (item) => item.listings.status !== 'active'
      );

      if (unavailableItems.length > 0) {
        await prisma.cart_items.deleteMany({
          where: {
            id: { in: unavailableItems.map((item) => item.id) },
          },
        });

        return res.status(400).json({
          error: 'Some items are no longer available',
          unavailable: unavailableItems.map((item) => ({
            listing_id: item.listing_id,
            title: item.listings.title,
          })),
        });
      }

      // SIZE VARIANT: Validate quantities against size-specific stock
      const overStockItems: any[] = [];
      for (const item of cartItems) {
        const selectedSize = item.selected_size;
        const requestedQty = item.quantity || 1;
        const availableStock = getStockForSize(item.listings, selectedSize);

        if (requestedQty > availableStock) {
          overStockItems.push({
            listing_id: item.listing_id,
            title: item.listings.title,
            selected_size: selectedSize,
            requested: requestedQty,
            available: availableStock,
          });
        }
      }

      if (overStockItems.length > 0) {
        return res.status(400).json({
          error: 'Some items exceed available stock',
          over_stock: overStockItems,
        });
      }

      // Check buyer isn't buying their own items
      const ownItems = cartItems.filter(
        (item) => item.listings.seller_id === userId
      );

      if (ownItems.length > 0) {
        return res.status(400).json({
          error: 'You cannot buy your own listings',
          own_items: ownItems.map((item) => item.listings.title),
        });
      }

      // Group items by seller for order creation later
      const sellerGroups: {
        [sellerId: string]: {
          seller: any;
          items: any[];
          subtotal: number;
          shippingTotal: number;
          totalQuantity: number;
        };
      } = {};

      for (const item of cartItems) {
        const sellerId = item.listings.seller_id;
        const seller = item.listings.users;
        const quantity = item.quantity || 1;

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = {
            seller,
            items: [],
            subtotal: 0,
            shippingTotal: 0,
            totalQuantity: 0,
          };
        }

        // OFFER SYSTEM: Use offer_price if available, otherwise listing price
        const price = parseFloat((item.offer_price || item.listings.price).toString());
        const shippingCost = parseFloat((item.listings as any).shipping_cost?.toString() || '0');

        const listingShipping = Math.ceil(quantity / 5) * shippingCost;

        sellerGroups[sellerId].items.push({
          listing_id: item.listing_id,
          title: item.listings.title,
          price,
          quantity,
          selected_size: item.selected_size || null,
          shipping_cost: shippingCost,
          image_url: item.listings.images[0]?.image_url || null,
          // OFFER SYSTEM: Pass offer metadata through
          offer_id: item.offer_id || null,
          offer_price: item.offer_price ? parseFloat(item.offer_price.toString()) : null,
          original_list_price: parseFloat(item.listings.price.toString()),
        });
        sellerGroups[sellerId].subtotal += price * quantity;
        sellerGroups[sellerId].shippingTotal = Math.max(sellerGroups[sellerId].shippingTotal, listingShipping);
        sellerGroups[sellerId].totalQuantity += quantity;
      }

      // Ensure all sellers have Connect accounts (auto-create if needed)
      for (const sellerId of Object.keys(sellerGroups)) {
        const seller = sellerGroups[sellerId].seller;

        if (!seller.stripe_connect_id) {
          console.log('[CART] Auto-creating Connect account for seller:', sellerId);

          try {
            const account = await stripe.accounts.create({
              type: 'express',
              country: 'GB',
              email: seller.email,
              capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
              },
              business_type: 'individual',
              business_profile: {
                mcc: '5699',
                product_description: 'Selling golf equipment on Mulligans',
              },
              settings: {
                payouts: {
                  schedule: {
                    delay_days: 'minimum',
                  },
                },
              },
              metadata: {
                user_id: sellerId,
                platform: 'mulligans',
                auto_created: 'true',
              },
            });

            await prisma.users.update({
              where: { id: sellerId },
              data: {
                stripe_connect_id: account.id,
                stripe_connect_status: 'pending',
                updated_at: new Date(),
              },
            });

            seller.stripe_connect_id = account.id;
            console.log('[CART] Connect account created:', account.id);
          } catch (error: any) {
            console.error('[CART] Failed to create Connect account for seller:', sellerId, error);
            return res.status(500).json({
              error: 'Failed to set up seller payments',
              details: error.message,
            });
          }
        }
      }

      // Calculate totals with quantity support
      // OFFER SYSTEM: Use offer_price when available for accurate totals
      const itemsTotal = cartItems.reduce(
        (sum, item) => sum + parseFloat((item.offer_price || item.listings.price).toString()) * (item.quantity || 1),
        0
      );
      const baseShippingTotal = Object.values(sellerGroups).reduce(
        (sum, group) => sum + group.shippingTotal,
        0
      );

      // INSURANCE: Calculate insurance premium (1.25% of item value)
      const insurancePremium = itemsTotal * INSURANCE_RATE;
      const insuredValue = itemsTotal;
      const insuredShippingTotal = baseShippingTotal + insurancePremium;
      const totalQuantity = cartItems.reduce(
        (sum, item) => sum + (item.quantity || 1),
        0
      );

      // FIXED: £0.99 fee applies PER ITEM, always (not per seller)
      const platformFee = itemsTotal * PLATFORM_FEE_PERCENT + (PLATFORM_FEE_FIXED * totalQuantity);
      const grandTotal = itemsTotal + insuredShippingTotal + platformFee;

      const grandTotalPence = Math.round(grandTotal * 100);
      const platformFeePence = Math.round(platformFee * 100);
      const insuredShippingPence = Math.round(insuredShippingTotal * 100);

      console.log('[CART] Cart checkout price breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        baseShipping: baseShippingTotal.toFixed(2),
        insurancePremium: insurancePremium.toFixed(2),
        insuredShippingTotal: insuredShippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        itemCount: cartItems.length,
        totalQuantity: totalQuantity,
        sellerCount: Object.keys(sellerGroups).length,
      });

      // Build line items for Stripe Checkout with quantities
      // OFFER SYSTEM: Use offer_price when available for Stripe line items
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = cartItems.map(
        (item) => ({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: item.listings.title,
              description: `Sold by ${item.listings.users.display_name}`,
              images: item.listings.images[0]?.image_url
                ? [item.listings.images[0].image_url]
                : undefined,
            },
            unit_amount: Math.round(
              parseFloat((item.offer_price || item.listings.price).toString()) * 100
            ),
          },
          quantity: item.quantity || 1,
        })
      );

      // Add platform fee as a line item
      lineItems.push({
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Buyer Protection Fee',
            description: 'Secure payment processing and buyer protection',
          },
          unit_amount: platformFeePence,
        },
        quantity: 1,
      });

      // INSURANCE: Add "Insured Shipping" as line item
      if (insuredShippingPence > 0) {
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Insured Shipping',
              description: `Delivery for ${totalQuantity} item${totalQuantity > 1 ? 's' : ''} with full loss & damage protection`,
            },
            unit_amount: insuredShippingPence,
          },
          quantity: 1,
        });
      }

      // Build listing quantities map for metadata
      const listingQuantities: Record<string, number> = {};
      for (const item of cartItems) {
        listingQuantities[item.listing_id] = item.quantity || 1;
      }

      // [Issue #11] OFFER SYSTEM: Store per-listing offer data as individual metadata keys
      // Format: offer_${listing_id} = "offerId|offerPrice|originalPrice"
      // This avoids the truncation issue with JSON.stringify(offerMap).substring(0, 490)
      const offerMetadataKeys: Record<string, string> = {};
      let hasOffers = false;
      for (const item of cartItems) {
        if (item.offer_id && item.offer_price) {
          const offerPrice = parseFloat(item.offer_price.toString()).toFixed(2);
          const originalPrice = parseFloat(item.listings.price.toString()).toFixed(2);
          offerMetadataKeys[`offer_${item.listing_id}`] = `${item.offer_id}|${offerPrice}|${originalPrice}`;
          hasOffers = true;
        }
      }

      // Create seller breakdown for metadata
      const sellerBreakdown = Object.entries(sellerGroups).map(([sellerId, data]) => ({
        seller_id: sellerId,
        seller_connect_id: data.seller?.stripe_connect_id || null,
        subtotal: data.subtotal,
        shipping_total: data.shippingTotal,
        cart_items: data.items.map((item: any) => ({
          listing_id: item.listing_id,
          quantity: item.quantity || 1,
          selected_size: item.selected_size || null,
        })),
        first_image: data.items[0]?.image_url || null,
      }));

      // Create Stripe Checkout Session
      // [Issue #11] Per-listing offer data stored as individual keys instead of truncated JSON blob
      // [Issue #12] listing_ids still stored but validated on read in fulfillCartOrder
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: lineItems,
        shipping_address_collection: {
          allowed_countries: ['GB'],
        },
        metadata: {
          type: 'cart_checkout',
          buyer_id: userId,
          items_total: itemsTotal.toFixed(2),
          shipping_total: insuredShippingTotal.toFixed(2),
          base_shipping: baseShippingTotal.toFixed(2),
          insurance_premium: insurancePremium.toFixed(2),
          insured_value: insuredValue.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          item_count: cartItems.length.toString(),
          total_quantity: totalQuantity.toString(),
          // [Issue #12] Store listing_ids — validated on read in fulfillCartOrder
          listing_ids: cartItems.map((item) => item.listing_id).join(',').substring(0, 490),
          // Store quantities separately, truncated
          listing_quantities: JSON.stringify(listingQuantities).substring(0, 490),
          // Simplified seller breakdown (just IDs and totals)
          seller_ids: Object.keys(sellerGroups).join(',').substring(0, 490),
          first_item_image: (cartItems[0]?.listings.images[0]?.image_url || '').substring(0, 490),
          escrow: 'true',
          // [Issue #11] OFFER SYSTEM: Store per-listing offer data as individual keys
          has_offers: hasOffers ? 'true' : 'false',
          ...offerMetadataKeys,
        },
        success_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-cancelled`,
      });

      console.log('[CART] Cart checkout session created:', session.id);

      res.json({
        sessionId: session.id,
        url: session.url,
       summary: {
          itemCount: cartItems.length,
          totalQuantity: totalQuantity,
          itemsTotal: itemsTotal.toFixed(2),
          baseShipping: baseShippingTotal.toFixed(2),
          insurancePremium: insurancePremium.toFixed(2),
          insuredShippingTotal: insuredShippingTotal.toFixed(2),
          platformFee: platformFee.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
        },
      });
    } catch (error: any) {
      console.error('[CART] Cart checkout session error:', error);
      res.status(500).json({
        error: 'Failed to create checkout session',
        details: error.message,
      });
    }
  }

  /**
   * Fulfill Cart Order (called from webhook)
   * Creates separate orders for each seller
   */
  static async fulfillCartOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('[CART] Fulfilling cart order for session:', session.id);

      // [E-C3] Removed non-null assertion; added explicit null checks for required metadata fields
      const metadata = session.metadata;
      if (!metadata || !metadata.buyer_id || !metadata.listing_ids) {
        throw new Error(`[CART] Session ${session.id} missing required metadata fields (buyer_id: ${metadata?.buyer_id}, listing_ids: ${metadata?.listing_ids})`);
      }
      const buyerId = metadata.buyer_id;
      const rawListingIds = metadata.listing_ids.split(',');

      // [Issue #12] Validate listing IDs — the last one may be truncated if the metadata
      // hit the 500-char limit. We fetch all matching listings from DB and only process
      // those that actually exist, which safely handles any truncated trailing ID.
      const listingQuantities = JSON.parse(metadata.listing_quantities || '{}');
      // Reconstruct seller breakdown from database instead of metadata
      const sellerIds = (metadata.seller_ids || '').split(',').filter(Boolean);
      const firstItemImage = metadata.first_item_image || null;

      // INSURANCE: Get insurance values from metadata
      const insurancePremium = parseFloat(metadata.insurance_premium || '0');
      const insuredValue = parseFloat(metadata.insured_value || '0');

      // [Issue #11] OFFER SYSTEM: Parse per-listing offer data from individual metadata keys
      // Format: offer_${listing_id} = "offerId|offerPrice|originalPrice"
      const offerMap: Record<string, { offer_id: string; offer_price: string; original_price: string }> = {};
      for (const key of Object.keys(metadata)) {
        if (key.startsWith('offer_')) {
          const listingId = key.substring(6); // Remove 'offer_' prefix
          const parts = metadata[key].split('|');
          if (parts.length === 3) {
            offerMap[listingId] = {
              offer_id: parts[0],
              offer_price: parts[1],
              original_price: parts[2],
            };
          }
        }
      }

      // Fetch listings to reconstruct seller breakdown
      // [Issue #12] We query by the raw IDs; any truncated/invalid ID simply won't match
      const listings = await prisma.listings.findMany({
        where: { id: { in: rawListingIds } },
        include: {
          images: {
            take: 1,
            orderBy: PRIMARY_IMAGE_ORDER,
          },
          users: {
            select: {
              id: true,
              stripe_connect_id: true,
            },
          },
        },
      });

      // [Issue #12] Use the IDs that were actually found in the database as the canonical list
      const listingIds = listings.map(l => l.id);
      if (listingIds.length < rawListingIds.length) {
        console.warn(`[CART] Only ${listingIds.length} of ${rawListingIds.length} listing IDs matched in DB (possible metadata truncation)`);
      }

      // Build sellerBreakdown from fetched listings
      const sellerBreakdown: {
        seller_id: string;
        seller_connect_id: string | null;
        subtotal: number;
        shipping_total: number;
        cart_items: { listing_id: string; quantity: number; selected_size: string | null }[];
        first_image: string | null;
      }[] = [];

      // Group listings by seller
      const sellerMap: Record<string, typeof sellerBreakdown[0]> = {};

      for (const listing of listings) {
        const sellerId = listing.seller_id;
        const quantity = listingQuantities[listing.id] || 1;
        // Parse selected_size from metadata if stored, otherwise null
        const selectedSize = null; // Will be populated from cart_items if needed

        if (!sellerMap[sellerId]) {
          sellerMap[sellerId] = {
            seller_id: sellerId,
            seller_connect_id: listing.users?.stripe_connect_id || null,
            subtotal: 0,
            shipping_total: 0,
            cart_items: [],
            first_image: listing.images[0]?.image_url || null,
          };
        }

        // OFFER SYSTEM: Use offer price if available for seller subtotal calculation
        const offerData = offerMap[listing.id];
        const price = offerData
          ? parseFloat(offerData.offer_price)
          : parseFloat(listing.price.toString());
        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');

        sellerMap[sellerId].subtotal += price * quantity;
        sellerMap[sellerId].shipping_total = Math.max(
          sellerMap[sellerId].shipping_total,
          Math.ceil(quantity / 5) * shippingCost
        );
        sellerMap[sellerId].cart_items.push({
          listing_id: listing.id,
          quantity,
          selected_size: selectedSize,
        });
      }

      // Convert map to array
      for (const sellerId of Object.keys(sellerMap)) {
        sellerBreakdown.push(sellerMap[sellerId]);
      }
      const grandTotal = metadata.grand_total;
      const shippingTotal = metadata.shipping_total || '0';
      const totalQuantity = parseInt(metadata.total_quantity || '0');

      // Get shipping address from session
      const collectedInfo = (session as any).collected_information;
      const shippingDetails = collectedInfo?.shipping_details || (session as any).shipping_details;
      const shippingAddress = shippingDetails?.address;
      const shippingName = shippingDetails?.name;

      console.log('[CART] Shipping details:', { name: shippingName, address: shippingAddress });

      // Build shipping address JSON for storage
      const shippingAddressJson = shippingAddress ? {
        name: shippingName || '',
        line1: shippingAddress.line1 || '',
        line2: shippingAddress.line2 || null,
        city: shippingAddress.city || '',
        postal_code: shippingAddress.postal_code || '',
        country: shippingAddress.country || 'GB',
      } : null;

      // Check if orders already exist (idempotency)
      const existingOrders = await prisma.orders.findMany({
        where: {
          stripe_payment_intent_id: session.payment_intent as string,
        },
      });

      if (existingOrders.length > 0) {
        console.log('[CART] Orders already exist for this session');
        return;
      }

      // Get buyer info for email
      const buyer = await prisma.users.findUnique({
        where: { id: buyerId },
        select: {
          email: true,
          display_name: true,
        },
      });

      // Auto-cancel date (5 days)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      // Create orders for each seller
      const createdOrders: any[] = [];
      const orderItems: { name: string; price: string; quantity: number }[] = [];
      const soldListingIds: string[] = [];

      // Use transaction to ensure atomicity for stock updates
      await prisma.$transaction(async (tx) => {

        // H1 cosmetic fix: only highest-shipping listing per seller carries the cost
      const allListingIds = sellerBreakdown.flatMap(s => (s.cart_items || []).map((ci: any) => ci.listing_id));
      const shippingLookup = await tx.listings.findMany({
        where: { id: { in: allListingIds } },
        select: { id: true, shipping_cost: true },
      });
      const shippingCostMap: Record<string, number> = {};
      for (const l of shippingLookup) {
        shippingCostMap[l.id] = parseFloat((l as any).shipping_cost?.toString() || '0');
      }
      const sellerShippingWinner: Record<string, string> = {};
      for (const sd of sellerBreakdown) {
        let maxCost = -1;
        for (const ci of (sd.cart_items || [])) {
          const cost = shippingCostMap[ci.listing_id] || 0;
          if (cost > maxCost) {
            maxCost = cost;
            sellerShippingWinner[sd.seller_id] = ci.listing_id;
          }
        }
      }

        // INSURANCE: Calculate total items value for proportional insurance split
      const totalItemsValue = sellerBreakdown.reduce((sum, s) => sum + s.subtotal, 0);

        for (const sellerData of sellerBreakdown) {
          const { seller_id, seller_connect_id, subtotal, shipping_total, cart_items, first_image } = sellerData;

          for (const cartItem of (cart_items || [])) {
            const listingId = cartItem.listing_id;
            const orderQuantity = cartItem.quantity || 1;
            const selectedSize = cartItem.selected_size || null;

            // Get listing details
            const listing = await tx.listings.findUnique({
              where: { id: listingId },
              select: {
                price: true,
                shipping_cost: true,
                quantity: true,
                specifications: true,
                title: true,
                images: {
                  take: 1,
                  orderBy: PRIMARY_IMAGE_ORDER,
                },
              },
            });

            if (!listing) continue;

            // OFFER SYSTEM: Determine the effective price (offer or list)
            const offerData = offerMap[listingId];
            const effectivePrice = offerData
              ? parseFloat(offerData.offer_price)
              : parseFloat(listing.price.toString());
            const originalListPrice = parseFloat(listing.price.toString());
            const discountAmount = offerData
              ? originalListPrice - effectivePrice
              : 0;

            const itemShippingCost = parseFloat((listing.shipping_cost || 0).toString());
            const listingImage = listing.images[0]?.image_url || null;

            const currentStock = getStockForSize(listing, selectedSize);
            // H1 cosmetic fix: only the max-shipping listing per seller carries shipping
            const isShippingWinner = sellerShippingWinner[seller_id] === listingId;
            const orderShipping = isShippingWinner ? Math.ceil(orderQuantity / 5) * itemShippingCost : 0;

            // Validate stock
            if (currentStock < orderQuantity) {
              console.error(`[CART] Insufficient stock for ${listingId}: requested ${orderQuantity}, available ${currentStock}`);
              throw new Error(`Insufficient stock for ${listing.title}`);
            }

            // Calculate new stock
            let newTotalStock: number;
            let updatedSpecs = listing.specifications;

            if (selectedSize && (listing.specifications as any)?.sizeQuantities) {
              updatedSpecs = decrementSizeStock(listing.specifications, selectedSize, orderQuantity);
              newTotalStock = getTotalStockFromSizes(updatedSpecs);
            } else {
              newTotalStock = listing.quantity - orderQuantity;
            }

            const shouldMarkSold = newTotalStock <= 0;

            // Add to email items list
            const sizeText = selectedSize ? ` (${selectedSize})` : '';
            const offerText = offerData ? ' (offer accepted)' : '';
            orderItems.push({
              name: `${listing.title}${sizeText}${offerText}`,
              price: `£${(effectivePrice * orderQuantity).toFixed(2)}`,
              quantity: orderQuantity,
            });

            // INSURANCE: Calculate this order's item total for insurance proportion
            const orderItemTotal = effectivePrice * orderQuantity;

            // Create order
            // OFFER SYSTEM: Include offer_id, original_list_price, discount_amount
            // [D-C2] Order ID now uses crypto.randomUUID() instead of Math.random()
            // [P-C2] seller_payout now includes shipping cost
            const order = await tx.orders.create({
              data: {
                id: `order_${crypto.randomUUID()}`,
                listing_id: listingId,
                buyer_id: buyerId,
                seller_id: seller_id,
                amount: effectivePrice * orderQuantity,
                quantity: orderQuantity,
                selected_size: selectedSize,
                shipping_cost: orderShipping,
                seller_payout: (effectivePrice * orderQuantity) + orderShipping,
                buyer_total: parseFloat(((orderItemTotal / totalItemsValue) * parseFloat(grandTotal)).toFixed(2)),
                listing_title: listing.title,
                listing_image: listingImage,
                listing_price: effectivePrice,
                currency: 'GBP',
                stripe_payment_intent_id: session.payment_intent as string,
                status: 'to_ship',
                paid_at: new Date(),
                auto_cancel_at: autoCancelAt,
                shipping_address: shippingAddressJson ?? Prisma.JsonNull,
                updated_at: new Date(),
                // INSURANCE: Store insurance values on order
                insurance_premium: (orderItemTotal / totalItemsValue) * insurancePremium,
                insured_value: orderItemTotal,
                // OFFER SYSTEM: Store offer details on order
                offer_id: offerData?.offer_id || null,
                original_list_price: offerData ? originalListPrice : null,
                discount_amount: offerData ? discountAmount * orderQuantity : 0,
              },
            });

            createdOrders.push({ ...order, image_url: listingImage, title: listing.title, quantity: orderQuantity });
            console.log(`[CART] Order created: ${order.id} for listing: ${listingId} (qty: ${orderQuantity})${offerData ? ` [offer: ${offerData.offer_id}]` : ''}`);

            // [D-C1] ATOMIC stock update with WHERE guard (optimistic locking)
            // For non-size-variant: use updateMany with quantity check to prevent race conditions
            // For size-variant: use standard update (JSON field can't be checked atomically in WHERE)
            if (!selectedSize || !(listing.specifications as any)?.sizeQuantities) {
              // Non-size-variant: atomic check prevents race condition
              const stockResult = await tx.listings.updateMany({
                where: {
                  id: listingId,
                  quantity: { gte: orderQuantity },
                },
                data: {
                  quantity: { decrement: orderQuantity },
                  status: shouldMarkSold ? 'sold' : 'active',
                  updated_at: new Date(),
                },
              });

              if (stockResult.count === 0) {
                throw new Error(`Stock race condition detected for listing ${listingId}`);
              }
            } else {
              // Size-variant: update with computed values (race window minimised by being inside tx)
              await tx.listings.update({
                where: { id: listingId },
                data: {
                  quantity: Math.max(0, newTotalStock),
                  specifications: updatedSpecs ?? undefined,
                  status: shouldMarkSold ? 'sold' : 'active',
                  updated_at: new Date(),
                },
              });
            }

            // [Issue #2] Track listings that sold out for offer expiry
            if (shouldMarkSold) {
              soldListingIds.push(listingId);
            }

            // OFFER SYSTEM: Mark the offer as PURCHASED if this was an offer purchase
            // [Issue #23] Added purchased_at: new Date() when marking as PURCHASED
            if (offerData?.offer_id) {
              try {
                await tx.offers.update({
                  where: { id: offerData.offer_id },
                  data: {
                    status: 'PURCHASED',
                    purchased_at: new Date(),
                  },
                });
                console.log(`[CART] Offer ${offerData.offer_id} marked as PURCHASED`);
              } catch (offerUpdateErr) {
                // Non-fatal: offer might not exist or already be completed
                console.warn(`[CART] Could not update offer ${offerData.offer_id}:`, offerUpdateErr);
              }
            }
          }
        }

        // Remove items from cart
        await tx.cart_items.deleteMany({
          where: {
            user_id: buyerId,
            listing_id: { in: listingIds },
          },
        });
      });

      // [Issue #2] Expire all other active offers for sold listings (outside transaction)
      for (const soldListingId of soldListingIds) {
        try {
          const expiredCount = await expireOffersForSoldItem(soldListingId);
          if (expiredCount > 0) {
            console.log(`[CART] Expired ${expiredCount} other offer(s) for sold listing ${soldListingId}`);
          }
        } catch (expireErr) {
          console.error(`[CART] Error expiring offers for sold listing ${soldListingId} (non-fatal):`, expireErr);
        }
      }

      // AUTO-SHIP: Purchase shipping labels for each order
      const autoLabelResults: Record<string, boolean> = {};
      for (const order of createdOrders) {
        try {
          const result = await autoPurchaseLabel(order.id);
          autoLabelResults[order.id] = result.success;
        } catch (autoShipErr) {
          console.error(`[CART] Auto-label failed for order ${order.id} (non-fatal):`, autoShipErr);
          autoLabelResults[order.id] = false;
        }
      }

      // Process seller notifications (outside transaction)
      for (const sellerData of sellerBreakdown) {
        const { seller_id, seller_connect_id, subtotal, shipping_total, cart_items, first_image } = sellerData;
        const listing_ids = (cart_items || []).map((item: any) => item.listing_id);

        const sellerSubtotal = subtotal;
        const sellerShipping = shipping_total || 0;
        console.log('[CART] Seller payout scheduled (after escrow):', {
          seller_id,
          subtotal: sellerSubtotal.toFixed(2),
          shipping: sellerShipping.toFixed(2),
          totalPayout: (sellerSubtotal + sellerShipping).toFixed(2),
        });

        // Get first listing image for this seller's notification
        const sellerFirstImage = first_image || createdOrders.find(o => o.image_url)?.image_url || null;

        // Notify seller
        const sellerUser = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { stripe_connect_status: true },
        });

        const needsVerification = sellerUser?.stripe_connect_status !== 'active';

        // Calculate total quantity for this seller
        const sellerTotalQty = createdOrders
          .filter((o: any) => listing_ids.includes(o.listing_id))
          .reduce((sum: number, o: any) => sum + (o.quantity || 1), 0);
        const qtyText = sellerTotalQty > 1 ? ` (${sellerTotalQty} items)` : '';

        if (needsVerification) {
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'payout',
              title: 'Congratulations on your sale!',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal.toFixed(2)}. Add your bank details to receive payment after delivery.`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });

          // PUSH: Notify seller (needs verification)
          try {
            await sendPushNotification(
              seller_id,
              'Congratulations on your sale!',
              `You sold ${listing_ids.length} item(s) for £${subtotal}. Add bank details to get paid.`,
              { type: 'sale', order_id: createdOrders[0]?.id }
            );
          } catch (pushErr) {
            console.error('[CART] Push to seller failed:', pushErr);
          }
        } else {
          const sellerOrderIds = createdOrders.filter((o: any) => listing_ids.includes(o.listing_id)).map((o: any) => o.id);
          const allLabelsReady = sellerOrderIds.every((id: string) => autoLabelResults[id]);
          const cartAutoMsg = allLabelsReady ? 'Your shipping labels are ready — print and ship!' : `Ship within ${SHIPPING_DEADLINE_DAYS} days. Payment released after delivery confirmed.`;
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'sale',
             title: allLabelsReady ? 'Items Sold — Labels Ready!' : 'Item Sold!',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal}. ${cartAutoMsg}`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });

          // PUSH: Notify seller
          try {
            await sendPushNotification(
              seller_id,
              allLabelsReady ? 'Items Sold — Labels Ready!' : 'Item Sold!',
              `You sold ${listing_ids.length} item(s) for £${subtotal}. ${cartAutoMsg}`,
              { type: 'sale', order_id: createdOrders[0]?.id }
            );
          } catch (pushErr) {
            console.error('[CART] Push to seller failed:', pushErr);
          }
        }

        // Send sale notification EMAIL to seller
        const sellerEmailRecord = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { email: true, display_name: true },
        });

        if (sellerEmailRecord?.email) {
          try {
            const shippingAddr = shippingAddressJson
              ? `${shippingAddressJson.name}<br>${shippingAddressJson.line1}${shippingAddressJson.line2 ? '<br>' + shippingAddressJson.line2 : ''}<br>${shippingAddressJson.city}<br>${shippingAddressJson.postal_code}`
              : 'See app for details';

            await sendSaleNotification(sellerEmailRecord.email, {
              itemTitle: listing_ids.length === 1 ? createdOrders[0]?.title : `${listing_ids.length} items`,
              salePrice: subtotal.toFixed(2),
              orderNumber: createdOrders[0]?.id || 'N/A',
              buyerName: buyer?.display_name || 'Buyer',
              shippingAddress: shippingAddr,
              sellerName: sellerEmailRecord?.display_name || 'Seller',
              itemName: listing_ids.length === 1 ? (createdOrders[0]?.listing_title || 'Item') : `${listing_ids.length} items`,
              itemImageUrl: createdOrders[0]?.listing_image || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${subtotal.toFixed(2)}`,
              buyerProtectionFee: '0.00',
              sellerEarnings: subtotal.toFixed(2),
              shippingDeadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
              shipUrl: '#',
            });
            console.log('[CART] Sale notification email sent to seller:', sellerEmailRecord.email);
          } catch (emailError) {
            console.error('[CART] Failed to send sale notification email:', emailError);
          }
        }
      }

      // Get first item image for buyer notification
      const buyerNotificationImage = firstItemImage || createdOrders[0]?.image_url || null;

      // Calculate total items including quantities
      const totalItems = totalQuantity || createdOrders.reduce((sum, o) => sum + (o.quantity || 1), 0);
      const itemText = totalItems === 1 ? '1 item' : `${totalItems} items`;

      // Notify buyer with image
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyerId,
          type: 'order',
          title: 'Payment Successful!',
          message: `Your order of ${itemText} has been confirmed. Sellers will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: buyerNotificationImage,
          related_id: createdOrders[0]?.id,
        },
      });

      // PUSH: Notify buyer
      try {
        await sendPushNotification(
          buyerId,
          'Payment Successful!',
          `Your order of ${itemText} is confirmed. Sellers will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          { type: 'order', order_id: createdOrders[0]?.id }
        );
      } catch (pushErr) {
        console.error('[CART] Push to buyer failed:', pushErr);
      }

      // Send order confirmation email to buyer
      if (buyer?.email) {
        try {
          const formattedAddress = shippingAddressJson
            ? `${shippingAddressJson.name}\n${shippingAddressJson.line1}${shippingAddressJson.line2 ? '\n' + shippingAddressJson.line2 : ''}\n${shippingAddressJson.city}\n${shippingAddressJson.postal_code}`
            : 'Address not available';

          const itemsListHtml = orderItems.map(item =>
            `<tr><td style="padding: 8px; border-bottom: 1px solid #E5E7EB;">${item.name}${item.quantity > 1 ? ` (x${item.quantity})` : ''}</td><td style="padding: 8px; border-bottom: 1px solid #E5E7EB; text-align: right;">${item.price}</td></tr>`
          ).join('');

          await sendOrderConfirmation(buyer.email, {
            buyerName: buyer.display_name || 'there',
            orderId: createdOrders[0]?.id || session.id,
            itemsList: itemsListHtml,
            totalAmount: `£${grandTotal}`,
            shippingAddress: formattedAddress.replace(/\n/g, '<br>'),
            orderReference: createdOrders[0]?.id || session.id,
            itemName: orderItems.length === 1 ? orderItems[0].name : `${orderItems.length} items`,
            itemImageUrl: createdOrders[0]?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: orderItems.length === 1 ? `£${orderItems[0].price.replace('£', '')}` : `£${grandTotal}`,
            itemSubtotal: metadata.items_total || grandTotal,
            buyerProtectionFee: metadata.platform_fee || '0.00',
            serviceFee: '0.00',
            shippingCost: metadata.shipping_total || '0.00',
            orderTotal: grandTotal,
            paymentMethod: 'Card payment',
            orderUrl: '#',
          });

          console.log('[CART] Order confirmation email sent to:', buyer.email);
        } catch (emailError) {
          console.error('[CART] Failed to send order confirmation email:', emailError);
        }
      }

      console.log('[CART] Cart order fulfilled successfully');
      console.log(`[CART] Orders created: ${createdOrders.length}, Total items: ${totalItems}`);
    } catch (error: any) {
      console.error('[CART] Error fulfilling cart order:', error);

      // Auto-refund on cart fulfillment failure (matching D-C4 pattern from fulfillOrder)
      if (session.payment_intent) {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: session.payment_intent as string,
            reason: 'requested_by_customer',
            metadata: {
              reason: 'cart_fulfillment_failed',
              session_id: session.id,
              error: error.message?.substring(0, 200) || 'Unknown error',
            },
          });
          console.log(`[CART] Auto-refund issued: ${refund.id} for session ${session.id}`);
        } catch (refundError: any) {
          console.error(`[CRITICAL] Cart auto-refund ALSO FAILED for session ${session.id}:`, refundError);
        }
      }

      throw error;
    }
  }
}
