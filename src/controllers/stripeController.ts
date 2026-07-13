// src/controllers/stripeController.ts
// Updated to handle both single-item and cart checkout webhooks
// ESCROW UPDATE: Removed immediate transfer_data - funds held until escrow releases
// ESCROW UPDATE: Shipping deadline changed from 7 to 5 days
// QUANTITY UPDATE: Now reduces stock instead of marking sold immediately

// ==========================================
// OFFER SYSTEM CHANGES (5 Feb 2026)
// ==========================================
// - Line ~77: Added offer_id to request body
// - Line ~126: Added offer validation and price override
// - Line ~204: FIXED 0.99 fee from flat to PER ITEM
// - Line ~243: Added offer_id to PaymentIntent metadata
// - Line ~520: Mark offer as PURCHASED in fulfillOrder webhook
// ==========================================

// ==========================================
// OFFER SYSTEM FIXES (6 Feb 2026)
// ==========================================
// [Issue #2]  Import and call expireOffersForSoldItem after fulfillment when shouldMarkSold
// [Issue #8]  Force orderQuantity = 1 when offer_id is present to prevent quantity manipulation
// [Issue #19] Replaced `new PrismaClient()` with shared singleton `import { prisma } from '../lib/prisma'`
// [Issue #24] Added shipping cost line item to the Stripe checkout session
// ==========================================

// ==========================================
// CRITICAL FIXES (9 Feb 2026)
// ==========================================
// [P-C1]  Removed standalone PaymentIntent creation in createCheckoutSession (double-charge fix)
// [E-C1]  Wrapped webhook fulfillment in try/catch, removed debug console.logs
// [EC-C2] Structured logging for native payment_intent.succeeded events
// [D-C1]  Race condition fix: stock read + check moved inside transaction with atomic decrement
// [D-C2]  Order ID generation uses crypto.randomUUID() instead of Math.random()
// [D-C4]  Automatic refund on failed fulfillment (prevents charge without order)
// ==========================================

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { INSURANCE_RATE } from '../lib/feeCalculations';
import { SHIPPING_DEADLINE_DAYS } from '../config/constants';
import { CartCheckoutController } from './cartCheckoutController';
import { sendPushNotification } from './pushNotificationController';
import { expireOffersForSoldItem } from '../jobs/offerJobs';
import crypto from 'crypto';
import { autoPurchaseLabel } from '../services/autoShippingService';
import { sendOrderConfirmation, sendSaleNotification } from '../services/emailService';
import { sendEmail } from '../utils/email';
import { validateShippingAddress, AddressValidationError } from '../utils/addressValidation';
import { issueFailureRefund } from '../lib/issueFailureRefund';
import { logStockDecrement, getStockForSize } from '../lib/stockUtils';
import { calculateShippingDeadline, formatShippingDeadline } from '../utils/shippingDeadline';
import { sendMetaPurchaseEvent } from '../services/metaCapi';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

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

export class StripeController {
  /**
   * Create Stripe Checkout Session (Single Item - Legacy)
   * POST /api/stripe/create-checkout-session
   * ESCROW UPDATE: Funds now held in platform account, not transferred immediately
   * QUANTITY UPDATE: Now includes quantity in metadata
   * OFFER SYSTEM: Supports offer-based checkout with discounted price
   */
  static async createCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id, quantity = 1, selected_size, offer_id } = req.body;  // SIZE VARIANT + OFFER SYSTEM
      const userId = req.user?.id || req.user?.sub;
      let orderQuantity = Math.max(1, parseInt(quantity) || 1);

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('Creating checkout session for listing:', listing_id, 'quantity:', orderQuantity, offer_id ? `offer: ${offer_id}` : '');

      // Get listing details
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: true,
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

      // SIZE VARIANT: Check stock availability for specific size
      const availableStock = getStockForSize(listing, selected_size);
      if (availableStock < orderQuantity) {
        return res.status(400).json({
          error: 'Not enough stock available',
          available: availableStock,
          requested: orderQuantity,
          selected_size: selected_size || null
        });
      }

      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot buy your own listing' });
      }

      // OFFER SYSTEM: Check if this is an offer-based purchase
      const unitPrice = parseFloat(listing.price.toString());
      let effectiveUnitPrice = unitPrice;
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

        // [Issue #8] Force quantity = 1 for offer-based purchases to prevent quantity manipulation
        orderQuantity = 1;

        console.log(`Offer-based checkout: list price \u00a3${unitPrice.toFixed(2)} -> offer price \u00a3${effectiveUnitPrice.toFixed(2)}`);
      }

      // Get seller details
      const seller = await prisma.users.findUnique({
        where: { id: listing.seller_id },
        select: {
          id: true,
          email: true,
          stripe_connect_id: true,
          stripe_connect_status: true,
          display_name: true,
        },
      });

      if (!seller) {
        return res.status(404).json({ error: 'Seller not found' });
      }

      // Auto-create Connect account if seller doesn't have one
      // (Seller still needs Connect account for future payout, just not immediate)
      let sellerConnectId = seller.stripe_connect_id;

      if (!sellerConnectId) {
        console.log('Auto-creating Connect account for seller:', seller.id);

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
            settings: {
              payouts: {
                schedule: {
                  delay_days: 'minimum',
                },
              },
            },
            metadata: {
              user_id: seller.id,
              platform: 'mulligans',
              auto_created: 'true',
            },
          });

          sellerConnectId = account.id;

          // Save to database
          await prisma.users.update({
            where: { id: seller.id },
            data: {
              stripe_connect_id: account.id,
              stripe_connect_status: 'pending',
              updated_at: new Date(),
            },
          });

          console.log('Connect account auto-created:', account.id);
        } catch (error: any) {
          console.error('Failed to create Connect account:', error);
          return res.status(500).json({
            error: 'Failed to set up seller payments',
            details: error.message,
          });
        }
      }

      // Calculate prices with quantity (using effective price which may be offer price)
      const itemPrice = effectiveUnitPrice * orderQuantity;  // Total for all items
      const platformFeePercent = 0.075;
      const platformFeeFixed = 0.99;
      // FIXED: 0.99 fee applies PER ITEM (multiplied by quantity)
      const platformFee = (itemPrice * platformFeePercent) + (platformFeeFixed * orderQuantity);

      // [Issue #24] Calculate shipping cost
      const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
      const baseShipping = Math.ceil(orderQuantity / 5) * shippingCost;
      const insurancePremium = itemPrice * INSURANCE_RATE;
      const shippingTotal = parseFloat((baseShipping + insurancePremium).toFixed(2));

      // [Issue #24] Grand total now includes shipping
      const totalPrice = itemPrice + platformFee + shippingTotal;

      const totalAmountPence = Math.round(totalPrice * 100);
      const platformFeePence = Math.round(platformFee * 100);
      const shippingTotalPence = Math.round(shippingTotal * 100);

      // Calculate seller payout (what they'll receive after escrow) — item only, shipping is platform's
      const sellerPayout = itemPrice;

      console.log('Price breakdown:', {
        unitPrice: unitPrice.toFixed(2),
        effectiveUnitPrice: effectiveUnitPrice.toFixed(2),
        quantity: orderQuantity,
        itemPrice: itemPrice.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        totalPrice: totalPrice.toFixed(2),
        sellerReceives: sellerPayout.toFixed(2),
        sellerConnectId,
        escrowNote: 'Funds held until delivery confirmed',
        offerId: validatedOfferId || 'none',
      });

      // [P-C1] ESCROW: Create checkout session WITHOUT transfer_data
      // Funds stay in Mulligans platform account until escrow releases
      // NOTE: The Checkout Session creates its own PaymentIntent internally.
      // Do NOT create a standalone PaymentIntent here -- that would double-charge.
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: listing.title,
              description: `Sold by ${seller.display_name}${orderQuantity > 1 ? ` (x${orderQuantity})` : ''}${validatedOfferId ? ' (Offer price)' : ''}`,
              images: listing.images && listing.images.length > 0
                ? [listing.images[0].image_url]
                : undefined,
            },
            unit_amount: Math.round(effectiveUnitPrice * 100),  // OFFER SYSTEM: Use effective price in pence
          },
          quantity: orderQuantity,  // Use actual quantity
        },
        // Add platform fee as separate line item
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Buyer Protection',
              description: 'Secure payment & purchase protection',
            },
            unit_amount: platformFeePence,
          },
          quantity: 1,
        },
      ];

      // [Issue #24] Add shipping as a separate line item if applicable
      if (shippingTotalPence > 0) {
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Insured Shipping',
              description: `Delivery with full loss & damage protection`,
            },
            unit_amount: shippingTotalPence,
          },
          quantity: 1,
        });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: lineItems,
        shipping_address_collection: {
          allowed_countries: ['GB'],
        },
        metadata: {
          type: 'single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId || '',
          quantity: orderQuantity.toString(),  // Include quantity
          selected_size: selected_size || '',  // [P-C1] SIZE VARIANT: Now included in session metadata
          unit_price: unitPrice.toFixed(2),
          effective_unit_price: effectiveUnitPrice.toFixed(2),  // OFFER SYSTEM
          item_price: itemPrice.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          buyer_protection_fee: platformFee.toFixed(2),
          service_fee: '0.00',
          seller_payout: sellerPayout.toFixed(2),
          total_price: totalPrice.toFixed(2),
          insurance_premium: insurancePremium.toFixed(2),
          escrow: 'true',
          offer_id: validatedOfferId || '',  // OFFER SYSTEM
        },
       success_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-cancelled`,
      });

      console.log('Checkout session created:', session.id);
      console.log('Funds will be held in escrow until delivery + 3 days');

      // [P-C1] Return only session data -- no standalone PaymentIntent clientSecret
      res.json({
        sessionId: session.id,
        url: session.url,
      });
    } catch (error: any) {
      console.error('Checkout session error:', error);
      res.status(500).json({
        error: 'Failed to create checkout session',
        details: error.message,
      });
    }
  }

  /**
   * Stripe Webhook Handler
   * Updated to handle both single-item and cart checkouts
   * FIXED: Now retrieves full session to get shipping details
   * [E-C1] Wrapped fulfillment in try/catch to prevent unhandled crashes
   * [EC-C2] Structured logging for native payment_intent.succeeded
   */
  static async handleWebhook(req: Request, res: Response) {
    const sig = req.headers['stripe-signature'] as string;

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log('[WEBHOOK] Event received:', event.type);

    switch (event.type) {
      case 'checkout.session.completed':
        const webhookSession = event.data.object as Stripe.Checkout.Session;

        // [E-C1] Wrap entire fulfillment block in try/catch to prevent
        // unhandled exceptions from crashing the webhook handler.
        // If fulfillment fails, we still return 200 to prevent Stripe retries
        // that could cause duplicate orders.
        try {
          // Retrieve the full session to get shipping details
          const fullSession = await stripe.checkout.sessions.retrieve(webhookSession.id);

          // Check if this is a cart checkout or single item
          if (fullSession.metadata?.type === 'cart_checkout') {
            console.log('[WEBHOOK] Processing cart checkout for session:', fullSession.id);
            await CartCheckoutController.fulfillCartOrder(fullSession);
          } else {
            console.log('[WEBHOOK] Processing single item checkout for session:', fullSession.id);
            await StripeController.fulfillOrder(fullSession);
          }

          // Immediately payout platform fee to bank account
          await StripeController.payoutPlatformFee(fullSession);
        } catch (fulfillmentError: any) {
          // Specific handling for address validation failures (Q1/Q2 decision)
          if (fulfillmentError instanceof AddressValidationError) {
            console.error('[WEBHOOK_VALIDATION_FAILURE]', {
              sessionId: webhookSession.id,
              missingFields: fulfillmentError.missingFields,
            });

            // Email ops (fire-and-forget — prevent email failure from cascading)
            sendEmail({
              to: 'info@mulligans.uk.com',
              subject: '[Mulligans Alert] Checkout webhook address validation failed',
              text: `A Stripe Checkout webhook arrived with an invalid shipping address.\n\n` +
                    `Session: ${webhookSession.id}\n` +
                    `Missing fields: ${fulfillmentError.missingFields.join(', ')}\n\n` +
                    `Manual reconciliation required - buyer's payment is in Stripe but no order was created. ` +
                    `Either refund the buyer or contact them for address correction.`,
            }).catch(emailErr => console.error('[OPS_EMAIL_FAILED]', emailErr));
          } else {
            // Generic fallback — existing behaviour preserved
            console.error('[WEBHOOK] Order fulfillment failed for session:', webhookSession.id, fulfillmentError);
          }
          // Still return 200 to prevent Stripe retries that could cause duplicates.
          // The idempotency checks in fulfillOrder/fulfillCartOrder provide some protection,
          // but uncontrolled retries are still dangerous.
          // Failed fulfillments must be investigated manually via Stripe dashboard.
        }
        break;

      case 'payment_intent.succeeded':
        const pi = event.data.object as Stripe.PaymentIntent;
        const piType = pi.metadata?.type;

        if (piType === 'native_single_item' || piType === 'native_cart') {
          console.log(`[WEBHOOK] Native payment succeeded: ${pi.id}, type: ${piType}, amount: ${pi.amount}`);

          // Safety net: check after 30s if the client confirmed the order.
          // If the app crashed after payment but before calling /confirm,
          // the buyer is charged with no order — auto-refund prevents this.
          setTimeout(async () => {
            try {
              const existingOrder = await prisma.orders.findFirst({
                where: { stripe_payment_intent_id: pi.id },
              });

              if (!existingOrder) {
                console.error(`[WEBHOOK] ORPHANED PAYMENT: No order for PI ${pi.id} after 30s — issuing refund`);

                await issueFailureRefund(stripe, pi.id, 'orphaned_native_payment', {
                  reason: 'orphaned_native_payment',
                  type: piType || 'unknown',
                  buyer_id: pi.metadata?.buyer_id || 'unknown',
                });
              } else {
                console.log(`[WEBHOOK] Native payment ${pi.id} confirmed — order ${existingOrder.id} exists`);

                // Meta CAPI Purchase event for native payment (fire-and-forget)
                try {
                  const buyerForCapi = await prisma.users.findUnique({
                    where: { id: existingOrder.buyer_id },
                    select: { email: true },
                  });
                  if (buyerForCapi?.email) {
                    sendMetaPurchaseEvent({
                      orderId: existingOrder.id,
                      amount: parseFloat(existingOrder.buyer_total?.toString() || '0'),
                      currency: 'GBP',
                      buyerEmail: buyerForCapi.email,
                      testEventCode: process.env.META_TEST_EVENT_CODE,
                    });
                  }
                } catch (capiErr) {
                  console.error('[META_CAPI] Native safety net buyer lookup failed (non-fatal):', (capiErr as any).message);
                }
              }
            } catch (err) {
              console.error(`[WEBHOOK] Error checking orphaned payment ${pi.id}:`, err);
            }
          }, 30000);
        } else {
          console.log('Payment succeeded - funds held in escrow');
        }
        break;

      case 'charge.dispute.created':
        const dispute = event.data.object as Stripe.Dispute;
        console.error(`[WEBHOOK] DISPUTE CREATED: ${dispute.id}, amount: ${dispute.amount}, reason: ${dispute.reason}`);

        try {
          // Find the order linked to this payment
          const disputedOrder = await prisma.orders.findFirst({
            where: { stripe_payment_intent_id: dispute.payment_intent as string },
          });

          if (disputedOrder) {
            // Freeze escrow — prevent auto-release while dispute is active
            await prisma.orders.updateMany({
              where: { stripe_payment_intent_id: dispute.payment_intent as string },
              data: {
                status: 'disputed',
                updated_at: new Date(),
              },
            });

            // Notify admin
            await prisma.notifications.create({
              data: {
                id: `notif_${crypto.randomUUID()}`,
                user_id: 'admin',
                type: 'dispute',
                title: 'STRIPE DISPUTE — Action Required',
                message: `Dispute ${dispute.id} on order ${disputedOrder.id}. Amount: £${(dispute.amount / 100).toFixed(2)}. Reason: ${dispute.reason}. Escrow frozen.`,
                related_id: disputedOrder.id,
              },
            });

            console.log(`[WEBHOOK] Order ${disputedOrder.id} frozen due to dispute`);
          } else {
            console.warn(`[WEBHOOK] No order found for disputed PI: ${dispute.payment_intent}`);
          }
        } catch (disputeErr) {
          console.error('[WEBHOOK] Error handling dispute:', disputeErr);
        }
        break;

      case 'transfer.created':
        const transfer = event.data.object as Stripe.Transfer;
        console.log('Escrow transfer created to Connect account:', transfer.destination);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }

  /**
   * Fulfill Single Item Order
   * ESCROW UPDATE: Now stores seller_payout, uses 5-day shipping deadline
   * QUANTITY UPDATE: Reduces stock, only marks sold when qty = 0
   * OFFER SYSTEM: Marks offer as PURCHASED when order is fulfilled
   * [Issue #2]: Expires other offers when item is sold
   * [D-C1]: Stock check moved inside transaction with atomic decrement
   * [D-C2]: Order ID uses crypto.randomUUID()
   * [D-C4]: Automatic refund on failed fulfillment
   */
  private static async fulfillOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('Fulfilling order for session:', session.id);

      const metadata = session.metadata!;
      const listing_id = metadata.listing_id;
      const buyer_id = metadata.buyer_id;
      const seller_id = metadata.seller_id;

      // Get quantity, size, and offer_id from metadata
      const orderQuantity = parseInt(metadata.quantity || '1');
      const selectedSize = metadata.selected_size || null;  // SIZE VARIANT
      const offerId = metadata.offer_id || null;  // OFFER SYSTEM

      // Check if order already exists (prevent duplicate processing)
      const existingOrder = await prisma.orders.findFirst({
        where: {
          listing_id,
          buyer_id,
          stripe_payment_intent_id: session.payment_intent as string
        },
      });

      if (existingOrder) {
        console.log('Order already exists:', existingOrder.id);
        return;
      }

      // [D-C1] Get listing for metadata (image, title) -- NOT for stock decisions
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: {
            take: 1,
            orderBy: PRIMARY_IMAGE_ORDER,
          },
        },
      });

      if (!listing) {
        console.error('Listing not found:', listing_id);
        if (session.payment_intent) {
          await issueFailureRefund(stripe, session.payment_intent as string, 'listing_not_found', {
            reason: 'listing_not_found',
            listing_id,
            buyer_id,
            session_id: session.id,
          });
        }
        return;
      }

      const listingImage = listing.images?.[0]?.image_url || null;
      const listingTitle = listing.title || 'your item';

      // Get shipping address from session
      const collectedInfo = (session as any).collected_information;
      const shippingDetails = collectedInfo?.shipping_details || (session as any).shipping_details;
      const shippingAddress = shippingDetails?.address;
      const shippingName = shippingDetails?.name;

      console.log('Shipping details:', { name: shippingName, address: shippingAddress });

      // Build shipping address JSON for storage
      const shippingAddressJson = shippingAddress ? {
        name: shippingName || '',
        line1: shippingAddress.line1 || '',
        line2: shippingAddress.line2 || null,
        city: shippingAddress.city || '',
        postal_code: shippingAddress.postal_code || '',
        country: shippingAddress.country || 'GB',
      } : null;

      console.log('Shipping address JSON:', shippingAddressJson);

      try {
        validateShippingAddress(shippingAddressJson);
      } catch (addrError: any) {
        if (addrError instanceof AddressValidationError && session.payment_intent) {
          await issueFailureRefund(stripe, session.payment_intent as string, 'address_validation_failed', {
            reason: 'address_validation_failed',
            listing_id,
            buyer_id,
            session_id: session.id,
            error: addrError.message?.substring(0, 200) || 'Address validation failed',
          });
        }
        throw addrError;
      }

      // Get payment method
      let paymentMethodId: string | null = null;
      if (session.payment_intent) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(
            session.payment_intent as string
          );
          paymentMethodId = paymentIntent.payment_method as string;
        } catch (error) {
          console.warn('Could not retrieve payment method');
        }
      }

      // Get seller payout from metadata (or calculate from item price)
      const itemPrice = parseFloat(metadata.item_price);
      const sellerPayout = metadata.seller_payout
        ? parseFloat(metadata.seller_payout)
        : itemPrice;

      // OFFER SYSTEM: Get original list price and calculate discount
      const originalListPrice = parseFloat(metadata.unit_price);
      const effectiveUnitPrice = metadata.effective_unit_price
        ? parseFloat(metadata.effective_unit_price)
        : originalListPrice;
      const discountAmount = offerId
        ? (originalListPrice - effectiveUnitPrice) * orderQuantity
        : 0;

        // Insurance — read from metadata for storage on order (FIX 3 / FINDING G-7)
      const insurancePremium = parseFloat(metadata.insurance_premium || '0');
      const insuredValue = parseFloat(metadata.item_price || '0');

      // ESCROW: Auto-cancel date (5 weekdays)
      const autoCancelAt = calculateShippingDeadline(new Date());

      // [D-C4] Wrap the transaction in try/catch to issue refund on failure
      let order: any;
      let shouldMarkSold = false;

      try {
        // [D-C1] Use transaction to ensure atomicity -- stock check happens INSIDE
        const txResult = await prisma.$transaction(async (tx) => {
          // [D-C1] RACE CONDITION FIX: Re-read listing inside transaction for fresh stock data
          const freshListing = await tx.listings.findUnique({
            where: { id: listing_id },
            select: { quantity: true, specifications: true, status: true },
          });

          if (!freshListing || freshListing.status === 'sold') {
            throw new Error(`Listing ${listing_id} is no longer available`);
          }

          // SIZE VARIANT: Get stock for specific size from FRESH data
          const currentStock = getStockForSize(freshListing, selectedSize);

          if (currentStock < orderQuantity) {
            throw new Error(
              `Insufficient stock for listing ${listing_id}: requested ${orderQuantity}, available ${currentStock}${selectedSize ? ` (size: ${selectedSize})` : ''}`
            );
          }

          // SIZE VARIANT: Calculate new stock level from FRESH data
          let newTotalStock: number;
          let updatedSpecs = freshListing.specifications;

          if (selectedSize && (freshListing.specifications as any)?.sizeQuantities) {
            updatedSpecs = decrementSizeStock(freshListing.specifications, selectedSize, orderQuantity);
            newTotalStock = getTotalStockFromSizes(updatedSpecs);
          } else {
            newTotalStock = freshListing.quantity - orderQuantity;
          }

          const computedShouldMarkSold = newTotalStock <= 0;

          console.log(`Stock update: ${currentStock} - ${orderQuantity} = ${newTotalStock}${selectedSize ? ` (size: ${selectedSize})` : ''} (Mark sold: ${computedShouldMarkSold})`);

          // [D-C2] Create order with crypto.randomUUID() for collision-safe IDs
          const createdOrder = await tx.orders.create({
            data: {
              id: `order_${crypto.randomUUID()}`,
              listing_id,
              buyer_id,
              seller_id,
              amount: parseFloat(metadata.item_price),
              shipping_cost: parseFloat(metadata.shipping_total || '0'),
              quantity: orderQuantity,
              selected_size: selectedSize,  // SIZE VARIANT
              seller_payout: sellerPayout,
              buyer_total: parseFloat(metadata.total_price),
              currency: 'GBP',
              stripe_payment_intent_id: session.payment_intent as string,
              stripe_payment_method_id: paymentMethodId,
              status: 'to_ship',
              paid_at: new Date(),
              auto_cancel_at: autoCancelAt,
              shipping_address: shippingAddressJson ?? Prisma.JsonNull,
              updated_at: new Date(),
              insurance_premium: insurancePremium,
              insured_value: insuredValue,
              // OFFER SYSTEM: Store offer details on the order
              offer_id: offerId || null,
              original_list_price: offerId ? originalListPrice : null,
              discount_amount: offerId ? discountAmount : 0,
            },
          });

          // [D-C1] ATOMIC stock decrement with WHERE guard (optimistic locking)
          // For non-size-variant: use updateMany with quantity check
          // For size-variant: use standard update (JSON field can't be checked atomically)
          if (!selectedSize || !(freshListing.specifications as any)?.sizeQuantities) {
            // Non-size-variant: atomic check prevents race condition
            const stockResult = await tx.listings.updateMany({
              where: {
                id: listing_id,
                quantity: { gte: orderQuantity },
              },
              data: {
                quantity: { decrement: orderQuantity },
                status: computedShouldMarkSold ? 'sold' : 'active',
                updated_at: new Date(),
              },
            });

            if (stockResult.count === 0) {
              console.log(`[STOCK] GUARD_FAILED listing=${listing_id} requested=${orderQuantity} cause=single_checkout`);
              throw new Error(`Insufficient stock for listing ${listing_id}`);
            }
            logStockDecrement(listing_id, freshListing.quantity, orderQuantity, 'single_checkout');
          } else {
            // Size-variant: update with computed values (race window minimised by being inside tx)
            await tx.listings.update({
              where: { id: listing_id },
              data: {
                quantity: Math.max(0, newTotalStock),
                specifications: updatedSpecs ?? undefined,
                status: computedShouldMarkSold ? 'sold' : 'active',
                updated_at: new Date(),
              },
            });
            logStockDecrement(listing_id, freshListing.quantity, orderQuantity, 'single_checkout');
          }

          // Remove from buyer's cart (if was in cart)
          await tx.cart_items.deleteMany({
            where: {
              user_id: buyer_id,
              listing_id: listing_id
            }
          });

          // OFFER SYSTEM: Mark the offer as PURCHASED
          if (offerId) {
            await tx.offers.update({
              where: { id: offerId },
              data: {
                status: 'PURCHASED',
                purchased_at: new Date(),
              },
            });
            console.log(`Offer ${offerId} marked as PURCHASED`);
          }

          return { createdOrder, shouldMarkSold: computedShouldMarkSold };
        });

        // Extract results from the transaction
        order = txResult.createdOrder;
        shouldMarkSold = txResult.shouldMarkSold;
      } catch (txError: any) {
        // [D-C4] Transaction failed -- issue refund to buyer
        console.error(`[STRIPE] Order creation failed for listing ${listing_id}:`, txError.message);

        if (session.payment_intent) {
          await issueFailureRefund(stripe, session.payment_intent as string, 'fulfillment_failed', {
            reason: 'fulfillment_failed',
            listing_id,
            error: txError.message?.substring(0, 200) || 'unknown',
            buyer_id,
            session_id: session.id,
          });
        }

        return; // Exit fulfillOrder -- webhook still returns 200 to Stripe
      }

      // Post-transaction: logging, notifications, offer expiry
      // Only reached if the transaction succeeded
      console.log('Order created:', order.id);
      console.log(`Quantity: ${orderQuantity}`);
      console.log(`New stock updated${shouldMarkSold ? ' (listing marked as SOLD)' : ''}`);
      console.log('With shipping address:', shippingAddressJson ? 'YES' : 'NO');
      console.log(`Funds held in escrow. Seller payout: \u00a3${sellerPayout.toFixed(2)}`);
      console.log(`Auto-cancel if not shipped by: ${autoCancelAt.toISOString()}`);
      if (offerId) {
        console.log(`Offer-based purchase: original \u00a3${originalListPrice.toFixed(2)} -> paid \u00a3${effectiveUnitPrice.toFixed(2)} (saved \u00a3${discountAmount.toFixed(2)})`);
      }

      // [Issue #2] Expire all other active offers for this listing when item is sold
      if (shouldMarkSold) {
        try {
          const expiredCount = await expireOffersForSoldItem(listing_id);
          if (expiredCount > 0) {
            console.log(`Expired ${expiredCount} other offer(s) for sold listing ${listing_id}`);
          }
        } catch (expireErr) {
          console.error('Error expiring offers for sold item (non-fatal):', expireErr);
        }
      }

      // AUTO-SHIP: Purchase shipping label automatically
      let autoLabelResult: { success: boolean; labelUrl?: string; trackingNumber?: string } = { success: false };
      try {
        autoLabelResult = await autoPurchaseLabel(order.id);
      } catch (autoShipErr) {
        console.error('[STRIPE] Auto-label purchase failed (non-fatal):', autoShipErr);
      }

      // Notify buyer - WITH IMAGE, quantity, and size
      const sizeText = selectedSize ? ` (${selectedSize})` : '';
      const qtyText = orderQuantity > 1 ? ` (x${orderQuantity})` : '';
      const offerText = offerId ? ` at your offer price of \u00a3${effectiveUnitPrice.toFixed(2)}` : '';
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyer_id,
          type: 'order',
          title: 'Payment Successful!',
          message: `Your order for "${listingTitle}"${qtyText}${offerText} has been confirmed. The seller will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: listingImage,
          related_id: order.id,
        },
      });

      // Notify seller — split on autoLabelResult.success
      const totalSaleValue = itemPrice.toFixed(2);
      const sellerNotifType = autoLabelResult.success ? 'sale_label_ready' : 'sale_action_required';
      const sellerNotifTitle = autoLabelResult.success ? 'Item sold!' : 'Item sold — action needed';
      const sellerNotifBody = autoLabelResult.success
        ? 'Your shipping label is ready. Tap to view your QR code.'
        : 'Tap to complete shipping details for your sale.';
      const notifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: notifId,
          user_id: seller_id,
          type: sellerNotifType,
          title: sellerNotifTitle,
          message: sellerNotifBody,
          image_url: listingImage,
          related_id: order.id,
        },
      });

      // PUSH NOTIFICATION - New sale to seller
      try {
        await sendPushNotification(
          seller_id,
          sellerNotifTitle,
          sellerNotifBody,
          { notification_id: notifId, type: sellerNotifType, order_id: order.id }
        );
      } catch (pushErr) {
        console.error('Push notification failed:', pushErr);
      }

      // Send order confirmation email to buyer
      try {
        const buyerRecord = await prisma.users.findUnique({
          where: { id: buyer_id },
          select: { email: true, display_name: true },
        });
        const sellerRecord = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { email: true, display_name: true },
        });

        if (buyerRecord?.email) {
          const shippingAddr = shippingAddress
            ? `${shippingAddress.name || ''}<br>${shippingAddress.line1 || ''}${shippingAddress.line2 ? '<br>' + shippingAddress.line2 : ''}<br>${shippingAddress.city || ''}<br>${shippingAddress.postal_code || ''}`
            : 'See app for details';

          await sendOrderConfirmation(buyerRecord.email, {
            buyerName: buyerRecord.display_name || 'there',
            orderId: order.id,
            itemsList: `<tr><td style="padding: 8px; border-bottom: 1px solid #E5E7EB;">${listingTitle}${orderQuantity > 1 ? ` (x${orderQuantity})` : ''}</td><td style="padding: 8px; border-bottom: 1px solid #E5E7EB; text-align: right;">£${itemPrice.toFixed(2)}</td></tr>`,
            totalAmount: `£${parseFloat(metadata.total_price).toFixed(2)}`,
            shippingAddress: shippingAddr,
            orderReference: order.id,
            itemName: listingTitle,
            itemImageUrl: order.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${itemPrice.toFixed(2)}`,
            itemSubtotal: itemPrice.toFixed(2),
            buyerProtectionFee: metadata.buyer_protection_fee || '0.00',
            serviceFee: metadata.service_fee || '0.00',
            shippingCost: metadata.shipping_total || '0.00',
            orderTotal: parseFloat(metadata.total_price).toFixed(2),
            paymentMethod: 'Card payment',
            orderUrl: '#',
          });
        }

        if (sellerRecord?.email) {
          const shippingAddr = shippingAddress
            ? `${shippingAddress.name || ''}<br>${shippingAddress.line1 || ''}<br>${shippingAddress.city || ''}<br>${shippingAddress.postal_code || ''}`
            : 'See app for details';

          await sendSaleNotification(sellerRecord.email, {
            itemTitle: listingTitle,
            salePrice: itemPrice.toFixed(2),
            orderNumber: order.id,
            buyerName: buyerRecord?.display_name || 'A buyer',
            shippingAddress: shippingAddr,
            sellerName: sellerRecord?.display_name || 'Seller',
            itemName: listingTitle,
            itemImageUrl: order.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${itemPrice.toFixed(2)}`,
            buyerProtectionFee: '0.00',
            sellerEarnings: metadata.seller_payout || itemPrice.toFixed(2),
            shippingDeadline: formatShippingDeadline(calculateShippingDeadline(new Date())),
            shipUrl: '#',
          });
        }
      } catch (emailErr) {
        console.error('[STRIPE] Email send failed (non-fatal):', emailErr);
      }

      // Meta CAPI Purchase event (fire-and-forget)
      // buyerRecord is scoped inside the email try/catch above, so we fetch fresh
      // (trivial PK lookup, Prisma cache should still be warm)
      try {
        const buyerForCapi = await prisma.users.findUnique({
          where: { id: buyer_id },
          select: { email: true },
        });
        if (buyerForCapi?.email) {
          sendMetaPurchaseEvent({
            orderId: order.id,
            amount: parseFloat(metadata.total_price),
            currency: 'GBP',
            buyerEmail: buyerForCapi.email,
            testEventCode: process.env.META_TEST_EVENT_CODE,
          });
        }
      } catch (capiErr) {
        console.error('[META_CAPI] Buyer lookup failed (non-fatal):', (capiErr as any).message);
      }

      console.log('Order fulfilled successfully (escrow mode with quantity support)');
    } catch (error) {
      console.error('Error fulfilling order:', error);
      throw error;
    }
  }

  /**
   * Payout platform fee to bank immediately after successful checkout
   */
  private static async payoutPlatformFee(session: Stripe.Checkout.Session) {
    try {
      const platformFee = session.metadata?.platform_fee;

      if (!platformFee) {
        console.log('No platform fee in metadata, skipping payout');
        return;
      }

      const platformFeePence = Math.round(parseFloat(platformFee) * 100);

      if (platformFeePence <= 0) {
        console.log('Platform fee is zero, skipping payout');
        return;
      }

      // Check available balance first
      const balance = await stripe.balance.retrieve();
      const availableGBP = balance.available.find(b => b.currency === 'gbp')?.amount || 0;

      if (availableGBP < platformFeePence) {
        console.log(`Insufficient balance for fee payout. Available: ${availableGBP}, Needed: ${platformFeePence}`);
        return;
      }

      // Create immediate payout to bank
      const payout = await stripe.payouts.create({
        amount: platformFeePence,
        currency: 'gbp',
        description: `Platform fee - ${session.id}`,
        metadata: {
          session_id: session.id,
          type: 'platform_fee',
        },
      });

      console.log(`Platform fee payout created: \u00a3${platformFee} -> ${payout.id}`);
    } catch (error: any) {
      // Don't throw - fee payout failure shouldn't break order processing
      console.error('Platform fee payout failed (non-critical):', error.message);
    }
  }
}
