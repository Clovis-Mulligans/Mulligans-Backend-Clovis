// src/controllers/nativePaymentController.ts
// Handles native in-app payments (Apple Pay / Google Pay)
// Uses Payment Intents instead of Checkout Sessions
// UPDATED: Added push notifications

// ==========================================
// OFFER SYSTEM FIXES (6 Feb 2026)
// ==========================================
// [Issue #1]  CRITICAL: Full offer support added to createSingleItemPaymentIntent and fulfillSingleItem/fulfillCart.
//             - Accepts offer_id in request body, validates offer, uses offer.final_amount as price
//             - Stores offer_id, original_list_price, discount_amount on orders
//             - Marks offers as PURCHASED with purchased_at after fulfillment
//             - Cart path reads offer data from cart_items with offer_id set
// [Issue #2]  CRITICAL: Import and call expireOffersForSoldItem after fulfillment when shouldMarkSold is true
// [Issue #19] Replaced `new PrismaClient()` with shared singleton `import { prisma } from '../lib/prisma'`
// [Issue #24] Added shipping cost to the payment amount (was missing from grand total)
// ==========================================
// CRITICAL FIXES (9 Feb 2026)
// ==========================================
// [D-C1]  Race condition fix: stock reads and validation moved inside transaction; atomic updateMany with WHERE guard
// [D-C2]  Order ID generation uses crypto.randomUUID() instead of Math.random()
// [E-C2]  Connect account auto-creation wrapped in try/catch
// [EC-C1] Cart query filters out expired cart items (expires_at > now)
// ==========================================

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { BUYER_PROTECTION_RATE, SERVICE_FEE_PER_ITEM, INSURANCE_RATE, buildFeeSnapshot, calculateBuyerFees, CartItem as FeeCartItem } from '../lib/feeCalculations';
import { SHIPPING_DEADLINE_DAYS } from '../config/constants';
import { sendPushNotification } from './pushNotificationController';
import { expireOffersForSoldItem } from '../jobs/offerJobs';
import crypto from 'crypto';
import { autoPurchaseLabel } from '../services/autoShippingService';
import { sendOrderConfirmation, sendSaleNotification } from '../services/emailService';
import { validateShippingAddress, AddressValidationError } from '../utils/addressValidation';
import { logStockDecrement, getStockForSize } from '../lib/stockUtils';
import { calculateShippingDeadline, formatShippingDeadline } from '../utils/shippingDeadline';
import { sendMetaPurchaseEvent } from '../services/metaCapi';
import { issueFailureRefund } from '../lib/issueFailureRefund';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

export function resolveNativeRoute(type: string | undefined): 'single' | 'cart' | 'unknown' {
  if (type === 'native_single_item') return 'single';
  if (type === 'native_cart' || type === 'seller_native') return 'cart';
  return 'unknown';
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

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    sub?: string;
  };
}

export class NativePaymentController {
  /**
   * Create Payment Intent for single item (Apple Pay on listing detail)
   * POST /api/stripe/native-payment/single-item
   * OFFER SYSTEM: Supports offer_id in request body for offer-based purchases
   */
  static async createSingleItemPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id, quantity = 1, selected_size, offer_id } = req.body;
      const userId = req.user?.id || req.user?.sub;
      let orderQuantity = Math.max(1, parseInt(quantity) || 1);

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[PAY] Creating native payment intent for listing:', listing_id, 'qty:', orderQuantity, offer_id ? `offer: ${offer_id}` : '');

      // Get listing details
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
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
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      if (listing.status !== 'active') {
        return res.status(400).json({ error: 'This item is no longer available' });
      }

      // SIZE VARIANT: Check if size selection is required
      const specs = listing.specifications as any;
      const hasSizeVariants = specs?.sizeQuantities && Object.keys(specs.sizeQuantities).length > 0;

      if (hasSizeVariants && !selected_size) {
        return res.status(400).json({
          error: 'Size selection required',
          message: 'Please select a size before purchasing',
          available_sizes: Object.keys(specs.sizeQuantities).filter(size => specs.sizeQuantities[size] > 0)
        });
      }

      // SIZE VARIANT: Validate stock for specific size
      const availableStock = getStockForSize(listing, selected_size);
      if (availableStock < orderQuantity) {
        return res.status(400).json({
          error: 'Not enough stock available',
          available: availableStock,
          requested: orderQuantity,
          selected_size: selected_size || null,
        });
      }

      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot buy your own listing' });
      }

      // OFFER SYSTEM: Check if this is an offer-based purchase
      const originalUnitPrice = parseFloat(listing.price.toString());
      let effectiveUnitPrice = originalUnitPrice;
      let validatedOfferId: string | null = null;

      if (offer_id) {
        const offer = await prisma.offers.findUnique({
          where: { id: offer_id },
        });

        if (!offer) {
          return res.status(404).json({ error: 'Offer not found' });
        }

        if (offer.buyer_id !== userId) {
          return res.status(403).json({ error: 'This offer does not belong to you' });
        }

        if (offer.status !== 'ACCEPTED' && offer.status !== 'COUNTER_ACCEPTED') {
          return res.status(400).json({ error: 'This offer is not in an accepted state' });
        }

        if (offer.listing_id !== listing_id) {
          return res.status(400).json({ error: 'Offer does not match this listing' });
        }

        // Check acceptance window hasn't expired
        if (offer.acceptance_expires_at && new Date() > offer.acceptance_expires_at) {
          return res.status(400).json({ error: 'The acceptance window for this offer has expired' });
        }

        effectiveUnitPrice = parseFloat(offer.final_amount!.toString());
        validatedOfferId = offer.id;

        // [Issue #8] Force quantity = 1 for offer-based purchases to prevent manipulation
        orderQuantity = 1;

        console.log(`[PAY] Offer-based checkout: list price £${originalUnitPrice.toFixed(2)} -> offer price £${effectiveUnitPrice.toFixed(2)}`);
      }

      const seller = listing.users;

      // [E-C2] Auto-create Connect account if needed — wrapped in try/catch
      let sellerConnectId = seller.stripe_connect_id;
      if (!sellerConnectId) {
        console.log('[PAY] Auto-creating Connect account for seller:', seller.id);
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
            metadata: {
              user_id: seller.id,
              platform: 'mulligans',
              auto_created: 'true',
            },
          });

          sellerConnectId = account.id;

          await prisma.users.update({
            where: { id: seller.id },
            data: {
              stripe_connect_id: account.id,
              stripe_connect_status: 'pending',
              updated_at: new Date(),
            },
          });
          console.log('[PAY] Connect account auto-created:', account.id);
        } catch (error: any) {
          console.error('[PAY] Failed to create Connect account for seller:', seller.id, error.message);
          return res.status(500).json({
            error: 'Failed to set up seller payments',
            details: error.message,
          });
        }
      }

      // Calculate prices (using effective price which may be offer price)
      const unitPrice = effectiveUnitPrice;
      const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
      const itemTotal = unitPrice * orderQuantity;
      const baseShipping = shippingCost;
      const insurancePremium = itemTotal * INSURANCE_RATE;
      const shippingTotal = parseFloat((baseShipping + insurancePremium).toFixed(2));
      const platformFee = (itemTotal * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
      // [Issue #24] Grand total now includes shipping
      const grandTotal = itemTotal + shippingTotal + platformFee;

      const totalAmountPence = Math.round(grandTotal * 100);

      // OFFER SYSTEM: Calculate discount for metadata
      const discountAmount = validatedOfferId
        ? (originalUnitPrice - effectiveUnitPrice) * orderQuantity
        : 0;

      console.log('[PAY] Native payment breakdown:', {
        originalUnitPrice: originalUnitPrice.toFixed(2),
        effectiveUnitPrice: unitPrice.toFixed(2),
        quantity: orderQuantity,
        itemTotal: itemTotal.toFixed(2),
        shipping: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        offerId: validatedOfferId || 'none',
        discount: discountAmount.toFixed(2),
      });

      // Create Payment Intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          type: 'native_single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId || '',
          quantity: orderQuantity.toString(),
          selected_size: selected_size || '',
          unit_price: originalUnitPrice.toFixed(2),
          effective_unit_price: effectiveUnitPrice.toFixed(2),
          item_total: itemTotal.toFixed(2),
          shipping_cost: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          buyer_protection_fee: platformFee.toFixed(2),
          service_fee: '0.00',
          seller_payout: itemTotal.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          offer_id: validatedOfferId || '',
          insurance_premium: insurancePremium.toFixed(2),
          discount_amount: discountAmount.toFixed(2),
        },
      });

      console.log('[PAY] Payment Intent created:', paymentIntent.id);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: grandTotal,
        currency: 'gbp',
        breakdown: {
          items: itemTotal,
          shipping: shippingTotal,
          buyerProtection: platformFee,
          total: grandTotal,
        },
      });
    } catch (error: any) {
      console.error('[PAY] Error creating payment intent:', error);
      res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
  }

  /**
   * Create Payment Intent for cart checkout
   * POST /api/stripe/native-payment/cart
   * OFFER SYSTEM: Reads offer data from cart_items that have offer_id set
   */
  static async createCartPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[PAY] Creating cart payment intent for user:', userId);

      // [EC-C1] Get user's cart items (exclude expired)
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() },
        },
        include: {
          listings: {
            include: {
              images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
              users: {
                select: {
                  id: true,
                  stripe_connect_id: true,
                },
              },
            },
          },
        },
      });

      if (cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
      }

      // Validate all items are available
      const unavailableItems = cartItems.filter(
        item => !item.listings || item.listings.status !== 'active'
      );
      if (unavailableItems.length > 0) {
        return res.status(400).json({
          error: 'Some items are no longer available',
          unavailable: unavailableItems.map(i => i.listing_id),
        });
      }

      // Check for own items
      const ownItems = cartItems.filter(item => item.listings?.seller_id === userId);
      if (ownItems.length > 0) {
        return res.status(400).json({
          error: 'You cannot buy your own listings',
          own_items: ownItems.map(i => i.listing_id),
        });
      }

      // Calculate totals
      // OFFER SYSTEM: Use offer_price from cart_items when available
      // H1 FIX: Shipping = max shipping cost per seller (not additive per item)
      let itemsTotal = 0;
      const sellerMaxShipping: Record<string, number> = {};
      const itemsMetadata: string[] = [];
      const offerMetadata: Record<string, string> = {};

      for (const cartItem of cartItems) {
        const listing = cartItem.listings!;
        const quantity = cartItem.quantity || 1;
        // OFFER SYSTEM: Use offer_price if available, otherwise listing price
        const unitPrice = cartItem.offer_price
          ? parseFloat(cartItem.offer_price.toString())
          : parseFloat(listing.price.toString());
        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');

        itemsTotal += unitPrice * quantity;

        // H1: Track highest shipping cost per seller
        const sellerId = listing.seller_id;
        sellerMaxShipping[sellerId] = Math.max(sellerMaxShipping[sellerId] || 0, shippingCost);

        itemsMetadata.push(`${listing.id}:${quantity}`);

        // OFFER SYSTEM: Collect offer metadata for fulfillment
        if (cartItem.offer_id && cartItem.offer_price) {
          const originalPrice = parseFloat(listing.price.toString());
          offerMetadata[`offer_${listing.id}`] = `${cartItem.offer_id}|${unitPrice.toFixed(2)}|${originalPrice.toFixed(2)}`;
        }
      }

      // H1: Sum the max shipping cost across all sellers
      const baseShippingTotal = Object.values(sellerMaxShipping).reduce((sum, cost) => sum + cost, 0);

      const insurancePremium = itemsTotal * INSURANCE_RATE;
      const shippingTotal = parseFloat((baseShippingTotal + insurancePremium).toFixed(2));

      const sellerCount = Object.keys(sellerMaxShipping).length;
      const platformFee = (itemsTotal * BUYER_PROTECTION_RATE) + (SERVICE_FEE_PER_ITEM * sellerCount);
      const grandTotal = itemsTotal + shippingTotal + platformFee;
      const totalAmountPence = Math.round(grandTotal * 100);

      console.log('[PAY] Cart payment breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
      });

      // Create Payment Intent
      // OFFER SYSTEM: Store per-listing offer data as individual metadata keys
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          type: 'native_cart',
          buyer_id: userId,
          items: itemsMetadata.join(','),
          items_total: itemsTotal.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          insurance_premium: insurancePremium.toFixed(2),
          has_offers: Object.keys(offerMetadata).length > 0 ? 'true' : 'false',
          ...offerMetadata,
        },
      });

      console.log('[PAY] Cart Payment Intent created:', paymentIntent.id);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: grandTotal,
        currency: 'gbp',
        breakdown: {
          items: itemsTotal,
          shipping: shippingTotal,
          buyerProtection: platformFee,
          total: grandTotal,
        },
        itemCount: cartItems.length,
      });
    } catch (error: any) {
      console.error('[PAY] Error creating cart payment intent:', error);
      res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
  }

  /**
   * Create PaymentIntent for a SINGLE SELLER's cart items (Apple Pay / Google Pay).
   * POST /api/stripe/native-payment/seller
   * Body: { seller_id: string }
   *
   * Independent per-seller native pay (Depop model). Each seller's items
   * get their own PaymentIntent — no chaining, no sequence.
   */
  static async createSellerPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;
      const { seller_id } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!seller_id || typeof seller_id !== 'string') {
        return res.status(400).json({ error: 'seller_id is required' });
      }

      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() },
        },
        include: {
          listings: {
            include: {
              images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
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

      const sellerItems = cartItems.filter(
        (item) => item.listings.seller_id === seller_id && item.listings.status === 'active'
      );

      if (sellerItems.length === 0) {
        return res.status(400).json({ error: 'No active cart items found for this seller' });
      }

      if (seller_id === userId) {
        return res.status(400).json({ error: 'You cannot buy your own listings' });
      }

      // Validate stock for size variants
      const overStockItems: any[] = [];
      for (const item of sellerItems) {
        const requestedQty = item.quantity || 1;
        const availableStock = getStockForSize(item.listings, item.selected_size);
        if (requestedQty > availableStock) {
          overStockItems.push({
            listing_id: item.listing_id,
            title: item.listings.title,
            selected_size: item.selected_size,
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

      const seller = sellerItems[0].listings.users;

      // Auto-create Connect account if needed (mirrors SC-01 pattern)
      let sellerConnectId = seller.stripe_connect_id;
      if (!sellerConnectId) {
        console.log('[SELLER-NATIVE] Auto-creating Connect account for seller:', seller_id);
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
            metadata: {
              user_id: seller_id,
              platform: 'mulligans',
              auto_created: 'true',
            },
          });

          sellerConnectId = account.id;
          await prisma.users.update({
            where: { id: seller_id },
            data: {
              stripe_connect_id: account.id,
              stripe_connect_status: 'pending',
              updated_at: new Date(),
            },
          });
          console.log('[SELLER-NATIVE] Connect account created:', account.id);
        } catch (error: any) {
          console.error('[SELLER-NATIVE] Failed to create Connect account:', error);
          return res.status(500).json({
            error: 'Failed to set up seller payments',
            details: error.message,
          });
        }
      }

      // Calculate fees via single source of truth
      const feeItems: FeeCartItem[] = sellerItems.map((item) => ({
        sellerId: seller_id,
        listingPrice: parseFloat(item.listings.price.toString()),
        offerPrice: item.offer_price ? parseFloat(item.offer_price.toString()) : null,
        quantity: item.quantity || 1,
        shippingCost: parseFloat((item.listings as any).shipping_cost?.toString() || '0'),
      }));

      const fees = calculateBuyerFees(feeItems);
      const totalAmountPence = Math.round(fees.grandTotal * 100);

      console.log('[SELLER-NATIVE] Price breakdown for seller', seller_id, {
        itemsTotal: fees.itemsTotal.toFixed(2),
        baseShipping: fees.baseShipping.toFixed(2),
        insurancePremium: fees.insurancePremium.toFixed(2),
        insuredShipping: fees.insuredShipping.toFixed(2),
        platformFee: fees.platformFee.toFixed(2),
        grandTotal: fees.grandTotal.toFixed(2),
        itemCount: fees.itemCount,
      });

      // Build items metadata in same format as native_cart: "listing_id:qty,listing_id:qty"
      const itemsMetadata = sellerItems.map(
        (item) => `${item.listing_id}:${item.quantity || 1}`
      );

      // Offer metadata (same format as native_cart)
      const offerMetadata: Record<string, string> = {};
      for (const item of sellerItems) {
        if (item.offer_id && item.offer_price) {
          const originalPrice = parseFloat(item.listings.price.toString());
          offerMetadata[`offer_${item.listing_id}`] = `${item.offer_id}|${parseFloat(item.offer_price.toString()).toFixed(2)}|${originalPrice.toFixed(2)}`;
        }
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          type: 'seller_native',
          buyer_id: userId,
          seller_id: seller_id,
          seller_connect_id: sellerConnectId || '',
          items: itemsMetadata.join(','),
          items_total: fees.itemsTotal.toFixed(2),
          shipping_total: fees.insuredShipping.toFixed(2),
          platform_fee: fees.platformFee.toFixed(2),
          grand_total: fees.grandTotal.toFixed(2),
          insurance_premium: fees.insurancePremium.toFixed(2),
          has_offers: Object.keys(offerMetadata).length > 0 ? 'true' : 'false',
          ...offerMetadata,
        },
      });

      console.log('[SELLER-NATIVE] PaymentIntent created:', paymentIntent.id, 'for seller:', seller_id);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: fees.grandTotal,
        currency: 'gbp',
        breakdown: {
          items: fees.itemsTotal,
          shipping: fees.insuredShipping,
          buyerProtection: fees.platformFee,
          total: fees.grandTotal,
        },
        sellerSummary: {
          sellerId: seller_id,
          sellerName: seller.display_name,
          itemCount: fees.itemCount,
          totalQuantity: fees.totalQuantity,
          itemsTotal: fees.itemsTotal.toFixed(2),
          baseShipping: fees.baseShipping.toFixed(2),
          insurancePremium: fees.insurancePremium.toFixed(2),
          insuredShippingTotal: fees.insuredShipping.toFixed(2),
          platformFee: fees.platformFee.toFixed(2),
          grandTotal: fees.grandTotal.toFixed(2),
        },
      });
    } catch (error: any) {
      console.error('[SELLER-NATIVE] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
  }

  /**
   * Confirm payment and create order (called after Apple Pay succeeds)
   * POST /api/stripe/native-payment/confirm
   */
  static async confirmPayment(req: AuthenticatedRequest, res: Response) {
    try {
      const { paymentIntentId, shippingAddress } = req.body;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[PAY] Confirming payment:', paymentIntentId);

      // Retrieve the payment intent
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      // SERVER-SIDE ADDRESS RESOLUTION
      // Primary: Stripe PaymentIntent.shipping (normalised by Stripe, reliable for all wallets)
      // Fallback: client-sent address (may have missing fields, e.g. Apple Pay postalCode bug)
      // This mirrors the card checkout flow (stripeController.ts:640-655) and unifies
      // card + Apple Pay + Google Pay onto one address path.
      const stripeAddr = paymentIntent.shipping?.address;
      const clientAddr = shippingAddress;

      const resolvedAddress = (stripeAddr || clientAddr) ? {
        name: paymentIntent.shipping?.name || clientAddr?.name || '',
        line1: stripeAddr?.line1 || clientAddr?.line1 || clientAddr?.street1 || '',
        line2: stripeAddr?.line2 || clientAddr?.line2 || clientAddr?.street2 || '',
        city: stripeAddr?.city || clientAddr?.city || '',
        state: stripeAddr?.state || clientAddr?.state || clientAddr?.county || '',
        postal_code: stripeAddr?.postal_code
          || clientAddr?.postal_code || clientAddr?.postalCode || clientAddr?.postcode || '',
        country: stripeAddr?.country || clientAddr?.country || 'GB',
      } : null;

      // Validation per Q1 decision (Hybrid: reject critical fields, allow optional)
      try {
        validateShippingAddress(resolvedAddress);
      } catch (err) {
        if (err instanceof AddressValidationError) {
          console.error('[PAY] Address validation failed:', {
            paymentIntentId,
            userId,
            missingFields: err.missingFields,
            stripeHadAddress: !!stripeAddr,
            clientHadAddress: !!clientAddr,
          });
          return res.status(400).json({
            error: 'Shipping address incomplete',
            missing_fields: err.missingFields,
            message: 'Please ensure your shipping address includes a valid street, city, and postcode.',
          });
        }
        throw err;
      }

      console.log('[PAY] Shipping address:', resolvedAddress ? 'YES' : 'NONE',
        stripeAddr ? '(from Stripe)' : '(from client)');
      if (resolvedAddress) {
        console.log('[PAY] Address postal_code:', resolvedAddress.postal_code || 'MISSING');
      }

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({
          error: 'Payment not successful',
          status: paymentIntent.status,
        });
      }

      // Verify this payment belongs to this user
      if (paymentIntent.metadata.buyer_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Calculate auto-cancel date (5 weekday deadline)
      const autoCancelAt = calculateShippingDeadline(new Date());

      // Create order based on type
      const metadata = paymentIntent.metadata;
      let orders: any;

      const route = resolveNativeRoute(metadata.type);
      if (route === 'single') {
        orders = await NativePaymentController.fulfillSingleItem(
          paymentIntent,
          resolvedAddress,
          autoCancelAt
        );
      } else if (route === 'cart') {
        orders = await NativePaymentController.fulfillCart(
          paymentIntent,
          resolvedAddress,
          autoCancelAt
        );
      } else {
        return res.status(400).json({ error: 'Unknown payment type' });
      }

      if (orders?.skipped) {
        return res.json({
          success: true,
          order_id: orders.existing.id || orders.existing[0]?.id,
          message: 'Order already created',
        });
      }

      res.json({
        success: true,
        order_id: Array.isArray(orders) ? orders[0]?.id : orders?.id,
        orders: Array.isArray(orders) ? orders.map((o: any) => o.id) : [orders?.id],
      });
    } catch (error: any) {
      console.error('[PAY] Error confirming payment:', error);

      const { paymentIntentId } = req.body;
      let refundIssued = false;

      if (paymentIntentId) {
        refundIssued = await issueFailureRefund(stripe, paymentIntentId, 'native_fulfillment_failed', {
          reason: 'native_fulfillment_failed',
          buyer_id: req.user?.id || req.user?.sub || 'unknown',
          error: error.message?.substring(0, 200) || 'Unknown error',
        });
      }

      const userMessage = error.message?.includes('Insufficient stock')
        ? (refundIssued
            ? 'This item is no longer available. Your payment has been refunded.'
            : 'This item is no longer available. Your refund is being processed.')
        : (error.message || 'Failed to confirm payment');
      res.status(500).json({ error: userMessage });
    }
  }

  /**
   * Fulfill single item order
   * OFFER SYSTEM: Stores offer data on order, marks offer as PURCHASED
   * [Issue #2]: Expires other offers when item is sold
   * [D-C1]: Race condition fix — stock read and validation inside transaction with atomic updateMany
   * [D-C2]: Order ID uses crypto.randomUUID()
   */
  private static async fulfillSingleItem(
    paymentIntent: Stripe.PaymentIntent,
    shippingAddress: any,
    autoCancelAt: Date
  ) {
    const metadata = paymentIntent.metadata;
    const listingId = metadata.listing_id;
    const buyerId = metadata.buyer_id;
    const sellerId = metadata.seller_id;
    const orderQuantity = parseInt(metadata.quantity) || 1;
    const selectedSize = metadata.selected_size || null;
    const offerId = metadata.offer_id || null;
    const insurancePremium = parseFloat(metadata.insurance_premium || '0');
    const insuredValue = parseFloat(metadata.item_total || '0');

    // Initial listing read for metadata only (image, title, price) — NOT for stock decisions
    const listing = await prisma.listings.findUnique({
      where: { id: listingId },
      include: { images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER } },
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    const listingImage = listing.images?.[0]?.image_url || null;

    // OFFER SYSTEM: Calculate prices based on offer or list price (safe outside tx — based on metadata, not stock)
    const originalListPrice = parseFloat(listing.price.toString());
    const effectiveUnitPrice = metadata.effective_unit_price
      ? parseFloat(metadata.effective_unit_price)
      : originalListPrice;
    const discountAmount = offerId
      ? (originalListPrice - effectiveUnitPrice) * orderQuantity
      : 0;

    // [D-C1] Transaction with fresh stock read and atomic decrement
    const txResult = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.orders.findFirst({
        where: { stripe_payment_intent_id: paymentIntent.id },
      });
      if (existingOrder) {
        console.log('[PAY] Order already exists (in-tx check):', existingOrder.id);
        return { skipped: true as const, existing: existingOrder };
      }

      // Row lock: prevents concurrent size-variant oversell (plain-quantity
      // path uses atomic decrement, but JSON sizeQuantities needs a lock).
      await (tx as any).$queryRawUnsafe(
        `SELECT id FROM listings WHERE id = $1 FOR UPDATE`,
        listingId,
      );

      const freshListing = await tx.listings.findUnique({
        where: { id: listingId },
        select: { quantity: true, specifications: true, status: true },
      });

      if (!freshListing || freshListing.status === 'sold') {
        throw new Error(`Listing ${listingId} is no longer available`);
      }

      const currentStock = getStockForSize(freshListing, selectedSize);
      if (currentStock < orderQuantity) {
        throw new Error(
          `Insufficient stock for listing ${listingId}: requested ${orderQuantity}, available ${currentStock}`
        );
      }

      // SIZE VARIANT: Calculate new stock from fresh data
      let newTotalStock: number;
      let updatedSpecs = freshListing.specifications;

      if (selectedSize && (freshListing.specifications as any)?.sizeQuantities) {
        updatedSpecs = decrementSizeStock(freshListing.specifications, selectedSize, orderQuantity);
        newTotalStock = getTotalStockFromSizes(updatedSpecs);
      } else {
        newTotalStock = freshListing.quantity - orderQuantity;
      }

      const shouldMarkSold = newTotalStock <= 0;

      // [D-C2] Create order with crypto.randomUUID() and offer data
      const createdOrder = await tx.orders.create({
        data: {
          id: `order_${crypto.randomUUID()}`,
          listing_id: listingId,
          buyer_id: buyerId,
          seller_id: sellerId,
          amount: parseFloat(metadata.item_total),
          quantity: orderQuantity,
          selected_size: selectedSize,
          shipping_cost: parseFloat(metadata.shipping_cost || '0'),
          seller_payout: parseFloat(metadata.seller_payout),
          buyer_total: parseFloat(metadata.grand_total),
          listing_title: listing.title,
          listing_image: listingImage,
          listing_price: effectiveUnitPrice,
          currency: 'GBP',
          stripe_payment_intent_id: paymentIntent.id,
          status: 'to_ship',
          paid_at: new Date(),
          auto_cancel_at: autoCancelAt,
          shipping_address: shippingAddress ?? Prisma.JsonNull,
          updated_at: new Date(),
          insurance_premium: insurancePremium,
          insured_value: insuredValue,
          // OFFER SYSTEM: Store offer details on the order
          offer_id: offerId || null,
          original_list_price: offerId ? originalListPrice : null,
          discount_amount: offerId ? discountAmount : 0,
          // SB-07: Fee snapshot — what was charged at point of sale
          ...buildFeeSnapshot(parseFloat(metadata.item_total), true, paymentIntent.id),
        },
      });

      console.log('[PAY] Listing snapshot saved:', listing.title, '@ £' + effectiveUnitPrice, selectedSize ? `(${selectedSize})` : '');

      // Atomic stock update with WHERE guard (optimistic locking)
      if (!selectedSize || !(freshListing.specifications as any)?.sizeQuantities) {
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
          console.log(`[STOCK] GUARD_FAILED listing=${listingId} requested=${orderQuantity} cause=native_checkout`);
          throw new Error(`Insufficient stock for listing ${listingId}`);
        }
        logStockDecrement(listingId, freshListing.quantity, orderQuantity, 'native_checkout');
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
        logStockDecrement(listingId, freshListing.quantity, orderQuantity, 'native_checkout');
      }

      // Remove from cart if present
      await tx.cart_items.deleteMany({
        where: { user_id: buyerId, listing_id: listingId },
      });

      // OFFER SYSTEM: Mark the offer as PURCHASED with timestamp
      if (offerId) {
        await tx.offers.update({
          where: { id: offerId },
          data: {
            status: 'PURCHASED',
            purchased_at: new Date(),
          },
        });
        console.log(`[PAY] Offer ${offerId} marked as PURCHASED`);
      }

      return { skipped: false as const, createdOrder, shouldMarkSold };
    });

    if (txResult.skipped) return txResult;
    const { createdOrder, shouldMarkSold } = txResult;

    // [Issue #2] Expire all other active offers for this listing when item is sold
    if (shouldMarkSold) {
      try {
        const expiredCount = await expireOffersForSoldItem(listingId);
        if (expiredCount > 0) {
          console.log(`[PAY] Expired ${expiredCount} other offer(s) for sold listing ${listingId}`);
        }
      } catch (expireErr) {
        console.error('[PAY] Error expiring offers for sold item (non-fatal):', expireErr);
      }
    }

    // AUTO-SHIP: Purchase shipping label automatically
    let autoLabelResult: { success: boolean; labelUrl?: string; trackingNumber?: string } = { success: false };
    try {
      autoLabelResult = await autoPurchaseLabel(createdOrder.id);
    } catch (autoShipErr) {
      console.error('[PAY] Auto-label purchase failed (non-fatal):', autoShipErr);
    }

    // Create notifications
    const sizeText = selectedSize ? ` (${selectedSize})` : '';
    const qtyText = orderQuantity > 1 ? ` (x${orderQuantity})` : '';
    const offerText = offerId ? ` at your offer price of £${effectiveUnitPrice.toFixed(2)}` : '';

    const nativeSingleBuyerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await prisma.notifications.create({
      data: {
        id: nativeSingleBuyerNotifId,
        user_id: buyerId,
        type: 'order',
        title: 'Payment Successful!',
        message: `Your order for "${listing.title}"${sizeText}${qtyText}${offerText} has been confirmed. The seller will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        image_url: listingImage,
        related_id: createdOrder.id,
      },
    });

    // PUSH: Notify buyer
    try {
      await sendPushNotification(
        buyerId,
        'Payment Successful!',
        `Your order for "${listing.title}" is confirmed. Shipping within ${SHIPPING_DEADLINE_DAYS} days.`,
        { notification_id: nativeSingleBuyerNotifId, type: 'purchase_paid', order_id: createdOrder.id }
      );
    } catch (pushErr) {
      console.error('[PAY] Push to buyer failed:', pushErr);
    }

    const sellerNotifType = autoLabelResult.success ? 'sale_label_ready' : 'sale_action_required';
    const sellerNotifTitle = autoLabelResult.success ? 'Item sold!' : 'Item sold — action needed';
    const sellerNotifBody = autoLabelResult.success
      ? 'Your shipping label is ready. Tap to view your QR code.'
      : 'Tap to complete shipping details for your sale.';
    const nativeSingleSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await prisma.notifications.create({
      data: {
        id: nativeSingleSellerNotifId,
        user_id: sellerId,
        type: sellerNotifType,
        title: sellerNotifTitle,
        message: sellerNotifBody,
        image_url: listingImage,
        related_id: createdOrder.id,
      },
    });

    // PUSH: Notify seller of sale
    try {
      await sendPushNotification(
        sellerId,
        sellerNotifTitle,
        sellerNotifBody,
        { notification_id: nativeSingleSellerNotifId, type: sellerNotifType, order_id: createdOrder.id }
      );
    } catch (pushErr) {
      console.error('[PAY] Push to seller failed:', pushErr);
    }

    // Send emails (non-fatal)
    try {
      const buyerRecord = await prisma.users.findUnique({
        where: { id: buyerId },
        select: { email: true, display_name: true },
      });
      const sellerRecord = await prisma.users.findUnique({
        where: { id: sellerId },
        select: { email: true, display_name: true },
      });

      if (buyerRecord?.email) {
        const addr = shippingAddress
          ? `${shippingAddress.name || ''}<br>${shippingAddress.line1 || ''}<br>${shippingAddress.city || ''}<br>${shippingAddress.postal_code || ''}`
          : 'See app for details';

        await sendOrderConfirmation(buyerRecord.email, {
          buyerName: buyerRecord.display_name || 'there',
          orderId: createdOrder.id,
          itemsList: `<tr><td style="padding: 8px; border-bottom: 1px solid #E5E7EB;">${listing.title}${orderQuantity > 1 ? ` (x${orderQuantity})` : ''}</td><td style="padding: 8px; border-bottom: 1px solid #E5E7EB; text-align: right;">£${metadata.item_total}</td></tr>`,
          totalAmount: `£${metadata.grand_total}`,
          shippingAddress: addr,
          orderReference: createdOrder.id,
          itemName: listing.title,
          itemImageUrl: listing.images?.[0]?.image_url || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(listing.price?.toString() || '0').toFixed(2)}`,
          itemSubtotal: metadata.item_total,
          buyerProtectionFee: metadata.buyer_protection_fee || '0.00',
          serviceFee: metadata.service_fee || '0.00',
          shippingCost: metadata.shipping_cost || '0.00',
          orderTotal: metadata.grand_total,
          paymentMethod: 'Apple Pay',
          orderUrl: '#',
        });
      }

      if (sellerRecord?.email) {
        const addr = shippingAddress
          ? `${shippingAddress.name || ''}<br>${shippingAddress.line1 || ''}<br>${shippingAddress.city || ''}<br>${shippingAddress.postal_code || ''}`
          : 'See app for details';

        await sendSaleNotification(sellerRecord.email, {
          itemTitle: listing.title,
          salePrice: metadata.item_total,
          orderNumber: createdOrder.id,
          buyerName: buyerRecord?.display_name || 'A buyer',
          shippingAddress: addr,
          sellerName: sellerRecord?.display_name || 'Seller',
          itemName: listing.title,
          itemImageUrl: listing.images?.[0]?.image_url || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(listing.price?.toString() || '0').toFixed(2)}`,
          buyerProtectionFee: '0.00',
          sellerEarnings: metadata.seller_payout || metadata.item_total,
          shippingDeadline: formatShippingDeadline(calculateShippingDeadline(new Date())),
          shipUrl: '#',
        });
      }
    } catch (emailErr) {
      console.error('[PAY] Email send failed (non-fatal):', emailErr);
    }

    // Meta CAPI Purchase event (fire-and-forget)
    try {
      const buyerForCapi = await prisma.users.findUnique({
        where: { id: buyerId },
        select: { email: true },
      });
      if (buyerForCapi?.email) {
        sendMetaPurchaseEvent({
          orderId: createdOrder.id,
          amount: parseFloat(metadata.grand_total || '0'),
          currency: 'GBP',
          buyerEmail: buyerForCapi.email,
          testEventCode: process.env.META_TEST_EVENT_CODE,
        });
      }
    } catch (capiErr) {
      console.error('[META_CAPI] Native single-item buyer lookup failed (non-fatal):', (capiErr as any).message);
    }

    console.log('[PAY] Single item order fulfilled:', createdOrder.id);
    if (offerId) {
      console.log(`[PAY] Offer-based purchase: original £${originalListPrice.toFixed(2)} -> paid £${effectiveUnitPrice.toFixed(2)} (saved £${discountAmount.toFixed(2)})`);
    }
    return createdOrder;
  }

  /**
   * Fulfill cart order
   * OFFER SYSTEM: Reads per-listing offer metadata, stores on orders, marks as PURCHASED
   * [Issue #2]: Expires other offers when listings are sold
   * [D-C1]: Race condition fix — stock validation and atomic updateMany added
   * [D-C2]: Order ID uses crypto.randomUUID()
   */
  private static async fulfillCart(
    paymentIntent: Stripe.PaymentIntent,
    shippingAddress: any,
    autoCancelAt: Date
  ) {
    const metadata = paymentIntent.metadata;
    const buyerId = metadata.buyer_id;
    const totalInsurancePremium = parseFloat(metadata.insurance_premium || '0');
    const totalItemsValue = parseFloat(metadata.items_total || '0');

    // Parse items from metadata (format: "listing_id:qty,listing_id:qty")
    const itemsData = metadata.items.split(',').map((item: string) => {
      const [listing_id, quantity] = item.split(':');
      return { listing_id, quantity: parseInt(quantity) || 1 };
    });

    // OFFER SYSTEM: Extract per-listing offer data from metadata
    // Format: offer_${listing_id} = "offerId|offerPrice|originalPrice"
    const offerDataMap: Record<string, { offer_id: string; offer_price: number; original_price: number }> = {};
    for (const key of Object.keys(metadata)) {
      if (key.startsWith('offer_')) {
        const listingId = key.substring(6); // Remove 'offer_' prefix
        const parts = metadata[key].split('|');
        if (parts.length === 3) {
          offerDataMap[listingId] = {
            offer_id: parts[0],
            offer_price: parseFloat(parts[1]),
            original_price: parseFloat(parts[2]),
          };
        }
      }
    }

    const orders: any[] = [];
    const soldListingIds: string[] = [];
    const sellerFixedFeeApplied = new Set<string>();

    const cartTxResult = await prisma.$transaction(async (tx) => {
      const existingOrders = await tx.orders.findMany({
        where: { stripe_payment_intent_id: paymentIntent.id },
      });
      if (existingOrders.length > 0) {
        console.log('[PAY] Cart orders already exist (in-tx check)');
        return { skipped: true as const, existing: existingOrders };
      }

      // H1 cosmetic fix: only highest-shipping listing per seller carries the cost
      const shippingLookup = await tx.listings.findMany({
        where: { id: { in: itemsData.map((i: any) => i.listing_id) } },
        select: { id: true, seller_id: true, shipping_cost: true },
      });
      const sellerShippingWinner: Record<string, string> = {};
      for (const l of shippingLookup) {
        const cost = parseFloat((l as any).shipping_cost?.toString() || '0');
        const currentId = sellerShippingWinner[l.seller_id];
        const currentCost = currentId
          ? parseFloat((shippingLookup.find(x => x.id === currentId) as any)?.shipping_cost?.toString() || '0')
          : -1;
        if (cost > currentCost) {
          sellerShippingWinner[l.seller_id] = l.id;
        }
      }

      for (const itemData of itemsData) {
        const listing = await tx.listings.findUnique({
          where: { id: itemData.listing_id },
          include: { images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER } },
        });

        if (!listing) {
          throw new Error(`Listing ${itemData.listing_id} not found during cart fulfillment — rolling back transaction`);
        }

        // OFFER SYSTEM: Use offer price if available
        const offerInfo = offerDataMap[itemData.listing_id];
        const effectiveUnitPrice = offerInfo
          ? offerInfo.offer_price
          : parseFloat(listing.price.toString());
        const originalListPrice = parseFloat(listing.price.toString());
        const discountAmount = offerInfo
          ? (originalListPrice - effectiveUnitPrice) * itemData.quantity
          : 0;

        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
        const itemTotal = effectiveUnitPrice * itemData.quantity;
        // H1 cosmetic fix: only the max-shipping listing per seller carries shipping
        const isShippingWinner = sellerShippingWinner[listing.seller_id] === itemData.listing_id;
        const orderShipping = isShippingWinner ? shippingCost : 0;
        const sellerPayout = itemTotal;
        const listingImage = listing.images?.[0]?.image_url || null;

        // [D-C1] STOCK VALIDATION: Check before decrementing
        if (listing.quantity < itemData.quantity) {
          console.error(`[PAY-CART] Insufficient stock for ${itemData.listing_id}: requested ${itemData.quantity}, available ${listing.quantity}`);
          throw new Error(`Insufficient stock for ${listing.title}`);
        }

        const newStock = listing.quantity - itemData.quantity;
        const shouldMarkSold = newStock <= 0;

        // [D-C2] Create order with crypto.randomUUID()
        const order = await tx.orders.create({
          data: {
            id: `order_${crypto.randomUUID()}`,
            listing_id: itemData.listing_id,
            buyer_id: buyerId,
            seller_id: listing.seller_id,
            amount: itemTotal,
            quantity: itemData.quantity,
            shipping_cost: orderShipping,
            seller_payout: sellerPayout,
            buyer_total: parseFloat(((itemTotal / parseFloat(metadata.items_total)) * parseFloat(metadata.grand_total)).toFixed(2)),
            listing_title: listing.title,
            listing_image: listingImage,
            listing_price: effectiveUnitPrice,
            currency: 'GBP',
            stripe_payment_intent_id: paymentIntent.id,
            status: 'to_ship',
            paid_at: new Date(),
            auto_cancel_at: autoCancelAt,
            shipping_address: shippingAddress ?? Prisma.JsonNull,
            updated_at: new Date(),
            insurance_premium: totalItemsValue > 0 ? (itemTotal / totalItemsValue) * totalInsurancePremium : 0,
            insured_value: itemTotal,
            // OFFER SYSTEM: Store offer details on order
            offer_id: offerInfo?.offer_id || null,
            original_list_price: offerInfo ? originalListPrice : null,
            discount_amount: offerInfo ? discountAmount : 0,
            // SB-07: Fee snapshot — per-order share of what was charged
            ...buildFeeSnapshot(
              itemTotal,
              !sellerFixedFeeApplied.has(listing.seller_id),
              paymentIntent.id,
            ),
          },
        });
        sellerFixedFeeApplied.add(listing.seller_id);

        console.log('[PAY] Listing snapshot saved:', listing.title, '@ £' + effectiveUnitPrice, offerInfo ? `[offer: ${offerInfo.offer_id}]` : '');
        orders.push({ ...order, listing });

        // [D-C1] Atomic stock update with WHERE guard (optimistic locking)
        const stockResult = await tx.listings.updateMany({
          where: {
            id: itemData.listing_id,
            quantity: { gte: itemData.quantity },
          },
          data: {
            quantity: { decrement: itemData.quantity },
            status: shouldMarkSold ? 'sold' : 'active',
            updated_at: new Date(),
          },
        });

        if (stockResult.count === 0) {
          console.log(`[STOCK] GUARD_FAILED listing=${itemData.listing_id} requested=${itemData.quantity} cause=native_checkout`);
          throw new Error(`Insufficient stock for listing ${itemData.listing_id}`);
        }
        logStockDecrement(itemData.listing_id, listing.quantity, itemData.quantity, 'native_checkout');

        // Track sold listings for offer expiry
        if (shouldMarkSold) {
          soldListingIds.push(itemData.listing_id);
        }

        // OFFER SYSTEM: Mark the offer as PURCHASED with timestamp
        if (offerInfo?.offer_id) {
          try {
            await tx.offers.update({
              where: { id: offerInfo.offer_id },
              data: {
                status: 'PURCHASED',
                purchased_at: new Date(),
              },
            });
            console.log(`[PAY] Offer ${offerInfo.offer_id} marked as PURCHASED`);
          } catch (offerUpdateErr) {
            console.warn(`[PAY] Could not update offer ${offerInfo.offer_id}:`, offerUpdateErr);
          }
        }
      }

      // SB-07: Reconciliation — snapshot sum must match charged platform fee
      const chargedPlatformFee = parseFloat(paymentIntent.metadata?.platform_fee || '0');
      const snapshotSum = orders.reduce((s, o) => s + (parseFloat(o.platform_fee_amount?.toString() || '0')), 0);
      const reconDiff = Math.abs(snapshotSum - chargedPlatformFee);
      if (reconDiff > 0.01) {
        console.error(`[SB-07] RECONCILIATION MISMATCH native cart: snapshot_sum=${snapshotSum.toFixed(2)} charged=${chargedPlatformFee.toFixed(2)} diff=${reconDiff.toFixed(2)} pi=${paymentIntent.id}`);
      }

      // Clear cart
      await tx.cart_items.deleteMany({
        where: {
          user_id: buyerId,
          listing_id: { in: itemsData.map((i: any) => i.listing_id) },
        },
      });

      return null;
    });

    if (cartTxResult?.skipped) return cartTxResult;

    // [Issue #2] Expire all other active offers for sold listings (outside transaction)
    for (const soldListingId of soldListingIds) {
      try {
        const expiredCount = await expireOffersForSoldItem(soldListingId);
        if (expiredCount > 0) {
          console.log(`[PAY] Expired ${expiredCount} other offer(s) for sold listing ${soldListingId}`);
        }
      } catch (expireErr) {
        console.error(`[PAY] Error expiring offers for sold listing ${soldListingId} (non-fatal):`, expireErr);
      }
    }

    // AUTO-SHIP: Purchase shipping labels for each order
    const autoLabelResults: Record<string, boolean> = {};
    for (const order of orders) {
      try {
        const result = await autoPurchaseLabel(order.id);
        autoLabelResults[order.id] = result.success;
      } catch (autoShipErr) {
        console.error(`[PAY] Auto-label failed for order ${order.id} (non-fatal):`, autoShipErr);
        autoLabelResults[order.id] = false;
      }
    }

    // Create notifications
    const firstImage = orders[0]?.listing?.images?.[0]?.image_url || null;
    const totalItems = orders.reduce((sum, o) => sum + o.quantity, 0);

    const nativeCartBuyerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await prisma.notifications.create({
      data: {
        id: nativeCartBuyerNotifId,
        user_id: buyerId,
        type: 'order',
        title: 'Payment Successful!',
        message: `Your order of ${totalItems} item${totalItems > 1 ? 's' : ''} has been confirmed.`,
        image_url: firstImage,
        related_id: orders[0]?.id,
      },
    });

    // PUSH: Notify buyer
    try {
      await sendPushNotification(
        buyerId,
        'Payment Successful!',
        `Your order of ${totalItems} item${totalItems > 1 ? 's' : ''} is confirmed.`,
        { notification_id: nativeCartBuyerNotifId, type: 'purchase_paid', order_id: orders[0]?.id }
      );
    } catch (pushErr) {
      console.error('[PAY] Push to buyer failed:', pushErr);
    }

    // Notify each seller
    const sellerOrders: { [sellerId: string]: any[] } = {};
    for (const order of orders) {
      if (!sellerOrders[order.seller_id]) {
        sellerOrders[order.seller_id] = [];
      }
      sellerOrders[order.seller_id].push(order);
    }

    for (const sellerId of Object.keys(sellerOrders)) {
      const sellerOrderList = sellerOrders[sellerId];
      const sellerTotal = sellerOrderList.reduce((sum, o) => sum + parseFloat(o.amount.toString()), 0);
      const sellerQty = sellerOrderList.reduce((sum, o) => sum + o.quantity, 0);
      const sellerImage = sellerOrderList[0]?.listing?.images?.[0]?.image_url || null;


const allLabelsReady = sellerOrderList.every(o => autoLabelResults[o.id]);
      const sellerNotifType = allLabelsReady ? 'sale_label_ready' : 'sale_action_required';
      const sellerNotifTitle = allLabelsReady ? 'Items sold!' : 'Items sold — action needed';
      const sellerNotifBody = allLabelsReady
        ? 'Your shipping labels are ready. Tap to view your QR codes.'
        : 'Tap to complete shipping details for your sales.';
      const nativeCartSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: nativeCartSellerNotifId,
          user_id: sellerId,
          type: sellerNotifType,
          title: sellerNotifTitle,
          message: sellerNotifBody,
          image_url: sellerImage,
          related_id: sellerOrderList[0]?.id,
        },
      });

      // PUSH: Notify seller of sale
      try {
        await sendPushNotification(
          sellerId,
          sellerNotifTitle,
          sellerNotifBody,
          { notification_id: nativeCartSellerNotifId, type: sellerNotifType, order_id: sellerOrderList[0]?.id }
        );
      } catch (pushErr) {
        console.error('[PAY] Push to seller failed:', pushErr);
      }
    }

    // Send order confirmation email to buyer
    try {
      const buyerRecord = await prisma.users.findUnique({
        where: { id: buyerId },
        select: { email: true, display_name: true },
      });

      if (buyerRecord?.email) {
        const itemsListHtml = orders.map(o =>
          `<tr><td style="padding: 8px; border-bottom: 1px solid #E5E7EB;">${o.listing_title}${o.quantity > 1 ? ` (x${o.quantity})` : ''}</td><td style="padding: 8px; border-bottom: 1px solid #E5E7EB; text-align: right;">£${parseFloat(o.amount.toString()).toFixed(2)}</td></tr>`
        ).join('');

        const totalAmount = orders.reduce((sum, o) => sum + parseFloat(o.amount.toString()), 0);
        const shippingAddr = paymentIntent.shipping?.address
          ? `${paymentIntent.shipping.name || ''}<br>${paymentIntent.shipping.address.line1 || ''}<br>${paymentIntent.shipping.address.city || ''}<br>${paymentIntent.shipping.address.postal_code || ''}`
          : 'See app for details';

        const shipping_total = parseFloat(paymentIntent.metadata?.shipping_total || '0');
        const platform_fee = parseFloat(paymentIntent.metadata?.platform_fee || '0');

        await sendOrderConfirmation(buyerRecord.email, {
          buyerName: buyerRecord.display_name || 'there',
          orderId: orders[0]?.id || 'N/A',
          itemsList: itemsListHtml,
          totalAmount: `£${(totalAmount + shipping_total + platform_fee).toFixed(2)}`,
          shippingAddress: shippingAddr,
          orderReference: orders[0]?.id || 'N/A',
          itemName: orders.length === 1 ? (orders[0]?.listing_title || 'Your item') : `${orders.length} items`,
          itemImageUrl: orders[0]?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(orders[0]?.amount?.toString() || '0').toFixed(2)}`,
          itemSubtotal: totalAmount.toFixed(2),
          buyerProtectionFee: platform_fee.toFixed(2),
          serviceFee: '0.00',
          shippingCost: shipping_total.toFixed(2),
          orderTotal: (totalAmount + shipping_total + platform_fee).toFixed(2),
          paymentMethod: 'Apple Pay',
          orderUrl: '#',
        });
      }

      // Send sale emails to each seller
      for (const sellerId of Object.keys(sellerOrders)) {
        const sellerOrderList = sellerOrders[sellerId];
        const sellerRecord = await prisma.users.findUnique({
          where: { id: sellerId },
          select: { email: true, display_name: true },
        });

        if (sellerRecord?.email) {
          const sellerTotal = sellerOrderList.reduce((sum: number, o: any) => sum + parseFloat(o.amount.toString()), 0);

          await sendSaleNotification(sellerRecord.email, {
            itemTitle: sellerOrderList.length === 1
              ? sellerOrderList[0].listing_title
              : `${sellerOrderList.length} items`,
            salePrice: sellerTotal.toFixed(2),
            orderNumber: sellerOrderList[0]?.id || 'N/A',
            buyerName: buyerRecord?.display_name || 'A buyer',
            shippingAddress: paymentIntent.shipping?.address
              ? `${paymentIntent.shipping.name || ''}<br>${paymentIntent.shipping.address.line1 || ''}<br>${paymentIntent.shipping.address.city || ''}<br>${paymentIntent.shipping.address.postal_code || ''}`
              : 'See app for details',
            sellerName: sellerRecord?.display_name || 'Seller',
            itemName: sellerOrderList.length === 1 ? (sellerOrderList[0].listing_title || 'Item') : `${sellerOrderList.length} items`,
            itemImageUrl: sellerOrderList[0]?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${sellerTotal.toFixed(2)}`,
            buyerProtectionFee: '0.00',
            sellerEarnings: sellerTotal.toFixed(2),
            shippingDeadline: formatShippingDeadline(calculateShippingDeadline(new Date())),
            shipUrl: '#',
          });
        }
      }
    } catch (emailErr) {
      console.error('[PAY] Cart email send failed (non-fatal):', emailErr);
    }

    // Meta CAPI Purchase event for native cart (fire-and-forget)
    try {
      const buyerForCapi = await prisma.users.findUnique({
        where: { id: buyerId },
        select: { email: true },
      });
      if (buyerForCapi?.email && orders.length > 0) {
        sendMetaPurchaseEvent({
          orderId: paymentIntent.id,
          amount: parseFloat(metadata.grand_total || '0'),
          currency: 'GBP',
          buyerEmail: buyerForCapi.email,
          testEventCode: process.env.META_TEST_EVENT_CODE,
        });
      }
    } catch (capiErr) {
      console.error('[META_CAPI] Native cart buyer lookup failed (non-fatal):', (capiErr as any).message);
    }

    console.log('[PAY] Cart orders fulfilled:', orders.length);
    return orders;
  }
}
