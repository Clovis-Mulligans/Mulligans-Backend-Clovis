// src/controllers/stripeController.ts
// Updated to handle both single-item and cart checkout webhooks
// ✅ ESCROW UPDATE: Removed immediate transfer_data - funds held until escrow releases
// ✅ ESCROW UPDATE: Shipping deadline changed from 7 to 5 days
// ✅ QUANTITY UPDATE: Now reduces stock instead of marking sold immediately

// ==========================================
// OFFER SYSTEM CHANGES (5 Feb 2026)
// ==========================================
// - Line ~77: Added offer_id to request body
// - Line ~126: Added offer validation and price override
// - Line ~204: FIXED £0.99 fee from flat to PER ITEM
// - Line ~243: Added offer_id to PaymentIntent metadata
// - Line ~520: Mark offer as PURCHASED in fulfillOrder webhook
// ==========================================

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { CartCheckoutController } from './cartCheckoutController';
import { sendPushNotification } from './pushNotificationController';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ✅ Constants for escrow system
const SHIPPING_DEADLINE_DAYS = 5;

// ✅ SIZE VARIANT: Helper to get stock for a specific size
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

// ✅ SIZE VARIANT: Helper to decrement stock for a specific size
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

// ✅ SIZE VARIANT: Helper to calculate total stock from all sizes
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
   * ✅ ESCROW UPDATE: Funds now held in platform account, not transferred immediately
   * ✅ QUANTITY UPDATE: Now includes quantity in metadata
   * ✅ OFFER SYSTEM: Supports offer-based checkout with discounted price
   */
  static async createCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id, quantity = 1, selected_size, offer_id } = req.body;  // ✅ SIZE VARIANT + OFFER SYSTEM
      const userId = req.user?.id || req.user?.sub;
      const orderQuantity = Math.max(1, parseInt(quantity) || 1);

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('🛒 Creating checkout session for listing:', listing_id, 'quantity:', orderQuantity, offer_id ? `offer: ${offer_id}` : '');

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

      // ✅ SIZE VARIANT: Check if size selection is required
      const specs = listing.specifications as any;
      const hasSizeVariants = specs?.sizeQuantities && Object.keys(specs.sizeQuantities).length > 0;

      if (hasSizeVariants && !selected_size) {
        return res.status(400).json({
          error: 'Size selection required',
          message: 'Please select a size before purchasing',
          available_sizes: Object.keys(specs.sizeQuantities).filter(size => specs.sizeQuantities[size] > 0)
        });
      }

      // ✅ SIZE VARIANT: Check stock availability for specific size
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

      // ✅ OFFER SYSTEM: Check if this is an offer-based purchase
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

        console.log(`💰 Offer-based checkout: list price £${unitPrice.toFixed(2)} → offer price £${effectiveUnitPrice.toFixed(2)}`);
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
        console.log('🔗 Auto-creating Connect account for seller:', seller.id);

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

          console.log('✅ Connect account auto-created:', account.id);
        } catch (error: any) {
          console.error('❌ Failed to create Connect account:', error);
          return res.status(500).json({
            error: 'Failed to set up seller payments',
            details: error.message,
          });
        }
      }

      // ✅ Calculate prices with quantity (using effective price which may be offer price)
      const itemPrice = effectiveUnitPrice * orderQuantity;  // ✅ Total for all items
      const platformFeePercent = 0.075;
      const platformFeeFixed = 0.99;
      // ✅ FIXED: £0.99 fee applies PER ITEM (multiplied by quantity)
      const platformFee = (itemPrice * platformFeePercent) + (platformFeeFixed * orderQuantity);
      const totalPrice = itemPrice + platformFee;

      const totalAmountPence = Math.round(totalPrice * 100);
      const platformFeePence = Math.round(platformFee * 100);

      // ✅ Calculate seller payout (what they'll receive after escrow)
      const sellerPayout = itemPrice;

      console.log('💰 Price breakdown:', {
        unitPrice: unitPrice.toFixed(2),
        effectiveUnitPrice: effectiveUnitPrice.toFixed(2),
        quantity: orderQuantity,
        itemPrice: itemPrice.toFixed(2),
        platformFee: platformFee.toFixed(2),
        totalPrice: totalPrice.toFixed(2),
        sellerReceives: sellerPayout.toFixed(2),
        sellerConnectId,
        escrowNote: 'Funds held until delivery confirmed',
        offerId: validatedOfferId || 'none',
      });

      // ✅ ESCROW: Create PaymentIntent WITHOUT transfer_data
      // Funds stay in Mulligans platform account until escrow releases
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        metadata: {
          type: 'single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId || '',
          quantity: orderQuantity.toString(),
          selected_size: selected_size || '',  // ✅ SIZE VARIANT
          unit_price: unitPrice.toFixed(2),    // ✅ Original list price per item
          effective_unit_price: effectiveUnitPrice.toFixed(2),  // ✅ OFFER SYSTEM: Actual price charged
          item_price: itemPrice.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          seller_payout: sellerPayout.toFixed(2),
          total_price: totalPrice.toFixed(2),
          escrow: 'true',
          offer_id: validatedOfferId || '',  // ✅ OFFER SYSTEM
        },
      });

      // ✅ ESCROW: Create checkout session WITHOUT transfer_data
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
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
              unit_amount: Math.round(effectiveUnitPrice * 100),  // ✅ OFFER SYSTEM: Use effective price in pence
            },
            quantity: orderQuantity,  // ✅ Use actual quantity
          },
          // ✅ Add platform fee as separate line item
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
        ],
        shipping_address_collection: {
          allowed_countries: ['GB'],
        },
        metadata: {
          type: 'single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId || '',
          quantity: orderQuantity.toString(),  // ✅ Include quantity
          unit_price: unitPrice.toFixed(2),
          effective_unit_price: effectiveUnitPrice.toFixed(2),  // ✅ OFFER SYSTEM
          item_price: itemPrice.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          seller_payout: sellerPayout.toFixed(2),
          total_price: totalPrice.toFixed(2),
          escrow: 'true',
          offer_id: validatedOfferId || '',  // ✅ OFFER SYSTEM
        },
        success_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-cancelled`,
      });

      console.log('✅ Payment intent created:', paymentIntent.id);
      console.log('✅ Checkout session created:', session.id);
      console.log('🔒 Funds will be held in escrow until delivery + 5 days');

      res.json({
        clientSecret: paymentIntent.client_secret,
        sessionId: session.id,
        url: session.url,
      });
    } catch (error: any) {
      console.error('❌ Checkout session error:', error);
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
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log('📨 Webhook event received:', event.type);

    switch (event.type) {
      case 'checkout.session.completed':
        const webhookSession = event.data.object as Stripe.Checkout.Session;

        // Retrieve the full session to get shipping details
        console.log('🔄 Retrieving full session...');
        const fullSession = await stripe.checkout.sessions.retrieve(webhookSession.id);

        // Debug: Log entire session to find shipping data location
        console.log('📦 FULL SESSION KEYS:', Object.keys(fullSession));
        console.log('📍 shipping_details:', (fullSession as any).shipping_details);
        console.log('📍 shipping:', (fullSession as any).shipping);
        console.log('📍 shipping_cost:', (fullSession as any).shipping_cost);
        console.log('📍 customer_details:', JSON.stringify((fullSession as any).customer_details, null, 2));
        console.log('📍 collected_information:', (fullSession as any).collected_information);

        // Check if this is a cart checkout or single item
        if (fullSession.metadata?.type === 'cart_checkout') {
          console.log('🛒 Processing cart checkout...');
          await CartCheckoutController.fulfillCartOrder(fullSession);
        } else {
          console.log('📦 Processing single item checkout...');
          await StripeController.fulfillOrder(fullSession);
        }

        // Immediately payout platform fee to bank account
        await StripeController.payoutPlatformFee(fullSession);
        break;

      case 'payment_intent.succeeded':
        console.log('💰 Payment succeeded - funds held in escrow');
        break;

      case 'transfer.created':
        const transfer = event.data.object as Stripe.Transfer;
        console.log('💸 Escrow transfer created to Connect account:', transfer.destination);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }

  /**
   * Fulfill Single Item Order
   * ✅ ESCROW UPDATE: Now stores seller_payout, uses 5-day shipping deadline
   * ✅ QUANTITY UPDATE: Reduces stock, only marks sold when qty = 0
   * ✅ OFFER SYSTEM: Marks offer as PURCHASED when order is fulfilled
   */
  private static async fulfillOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('📦 Fulfilling order for session:', session.id);

      const metadata = session.metadata!;
      const listing_id = metadata.listing_id;
      const buyer_id = metadata.buyer_id;
      const seller_id = metadata.seller_id;

      // ✅ Get quantity, size, and offer_id from metadata
      const orderQuantity = parseInt(metadata.quantity || '1');
      const selectedSize = metadata.selected_size || null;  // ✅ SIZE VARIANT
      const offerId = metadata.offer_id || null;  // ✅ OFFER SYSTEM

      // Check if order already exists (prevent duplicate processing)
      const existingOrder = await prisma.orders.findFirst({
        where: {
          listing_id,
          buyer_id,
          stripe_payment_intent_id: session.payment_intent as string
        },
      });

      if (existingOrder) {
        console.log('⚠️ Order already exists:', existingOrder.id);
        return;
      }

      // ✅ Get listing with current stock level
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: {
            take: 1,
            orderBy: { display_order: 'asc' },
          },
        },
      });

      if (!listing) {
        console.error('❌ Listing not found:', listing_id);
        return;
      }

      const listingImage = listing.images?.[0]?.image_url || null;
      const listingTitle = listing.title || 'your item';

      // ✅ SIZE VARIANT: Get stock for specific size
      const currentStock = getStockForSize(listing, selectedSize);

      // ✅ Validate stock (should have been checked at checkout, but double-check)
      if (currentStock < orderQuantity) {
        console.error(`❌ Insufficient stock! Requested: ${orderQuantity}, Available: ${currentStock}${selectedSize ? ` (size: ${selectedSize})` : ''}`);
        return;
      }

      // Get shipping address from session
      const collectedInfo = (session as any).collected_information;
      const shippingDetails = collectedInfo?.shipping_details || (session as any).shipping_details;
      const shippingAddress = shippingDetails?.address;
      const shippingName = shippingDetails?.name;

      console.log('📍 Shipping details:', { name: shippingName, address: shippingAddress });

      // Build shipping address JSON for storage
      const shippingAddressJson = shippingAddress ? {
        name: shippingName || '',
        line1: shippingAddress.line1 || '',
        line2: shippingAddress.line2 || null,
        city: shippingAddress.city || '',
        postal_code: shippingAddress.postal_code || '',
        country: shippingAddress.country || 'GB',
      } : null;

      console.log('📦 Shipping address JSON:', shippingAddressJson);

      // Get payment method
      let paymentMethodId: string | null = null;
      if (session.payment_intent) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(
            session.payment_intent as string
          );
          paymentMethodId = paymentIntent.payment_method as string;
        } catch (error) {
          console.warn('⚠️ Could not retrieve payment method');
        }
      }

      // ✅ Get seller payout from metadata (or calculate from item price)
      const itemPrice = parseFloat(metadata.item_price);
      const sellerPayout = metadata.seller_payout
        ? parseFloat(metadata.seller_payout)
        : itemPrice;

      // ✅ OFFER SYSTEM: Get original list price and calculate discount
      const originalListPrice = parseFloat(metadata.unit_price);
      const effectiveUnitPrice = metadata.effective_unit_price
        ? parseFloat(metadata.effective_unit_price)
        : originalListPrice;
      const discountAmount = offerId
        ? (originalListPrice - effectiveUnitPrice) * orderQuantity
        : 0;

      // ✅ ESCROW: Auto-cancel date (5 days)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      // ✅ SIZE VARIANT: Calculate new stock level
      let newTotalStock: number;
      let updatedSpecs = listing.specifications;

      if (selectedSize && (listing.specifications as any)?.sizeQuantities) {
        updatedSpecs = decrementSizeStock(listing.specifications, selectedSize, orderQuantity);
        newTotalStock = getTotalStockFromSizes(updatedSpecs);
      } else {
        newTotalStock = listing.quantity - orderQuantity;
      }

      const shouldMarkSold = newTotalStock <= 0;

      console.log(`📊 Stock update: ${currentStock} - ${orderQuantity} = ${newTotalStock}${selectedSize ? ` (size: ${selectedSize})` : ''} (Mark sold: ${shouldMarkSold})`);

      // ✅ Use transaction to ensure atomicity
      const order = await prisma.$transaction(async (tx) => {
        // Create order with quantity and offer data
        const createdOrder = await tx.orders.create({
          data: {
            id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            listing_id,
            buyer_id,
            seller_id,
            amount: parseFloat(metadata.total_price),
            quantity: orderQuantity,
            selected_size: selectedSize,  // ✅ SIZE VARIANT
            seller_payout: sellerPayout,
            currency: 'GBP',
            stripe_payment_intent_id: session.payment_intent as string,
            stripe_payment_method_id: paymentMethodId,
            status: 'to_ship',
            paid_at: new Date(),
            auto_cancel_at: autoCancelAt,
            shipping_address: shippingAddressJson ?? Prisma.JsonNull,
            updated_at: new Date(),
            // ✅ OFFER SYSTEM: Store offer details on the order
            offer_id: offerId || null,
            original_list_price: offerId ? originalListPrice : null,
            discount_amount: offerId ? discountAmount : 0,
          },
        });

        // ✅ SIZE VARIANT: Update listing stock, specifications, and status
        await tx.listings.update({
          where: { id: listing_id },
          data: {
            quantity: Math.max(0, newTotalStock),
            specifications: updatedSpecs ?? undefined,  // ✅ Update size quantities
            status: shouldMarkSold ? 'sold' : 'active',
            updated_at: new Date()
          },
        });

        // ✅ Remove from buyer's cart (if was in cart)
        await tx.cart_items.deleteMany({
          where: {
            user_id: buyer_id,
            listing_id: listing_id
          }
        });

        // ✅ OFFER SYSTEM: Mark the offer as PURCHASED
        if (offerId) {
          await tx.offers.update({
            where: { id: offerId },
            data: {
              status: 'PURCHASED',
              purchased_at: new Date(),
            },
          });
          console.log(`✅ Offer ${offerId} marked as PURCHASED`);
        }

        return createdOrder;
      });

      console.log('✅ Order created:', order.id);
      console.log(`📦 Quantity: ${orderQuantity}`);
     console.log(`📊 New stock: ${newTotalStock}${shouldMarkSold ? ' (listing marked as SOLD)' : ''}`);
      console.log('📍 With shipping address:', shippingAddressJson ? 'YES' : 'NO');
      console.log(`🔒 Funds held in escrow. Seller payout: £${sellerPayout.toFixed(2)}`);
      console.log(`⏰ Auto-cancel if not shipped by: ${autoCancelAt.toISOString()}`);
      if (offerId) {
        console.log(`🤝 Offer-based purchase: original £${originalListPrice.toFixed(2)} → paid £${effectiveUnitPrice.toFixed(2)} (saved £${discountAmount.toFixed(2)})`);
      }

      // Check if seller needs bank verification
      const sellerUser = await prisma.users.findUnique({
        where: { id: seller_id },
        select: { stripe_connect_status: true },
      });

      const needsVerification = sellerUser?.stripe_connect_status !== 'active';

      // ✅ Notify buyer - WITH IMAGE, quantity, and size
      const sizeText = selectedSize ? ` (${selectedSize})` : '';
      const qtyText = orderQuantity > 1 ? ` (x${orderQuantity})` : '';
      const offerText = offerId ? ` at your offer price of £${effectiveUnitPrice.toFixed(2)}` : '';
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyer_id,
          type: 'order',
          title: 'Payment Successful! 🎉',
          message: `Your order for "${listingTitle}"${qtyText}${offerText} has been confirmed. The seller will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: listingImage,
          related_id: order.id,
        },
      });

      // ✅ Notify seller - WITH IMAGE (different message if needs verification)
      const totalSaleValue = itemPrice.toFixed(2);
      if (needsVerification) {
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: seller_id,
            type: 'payout',
            title: 'Congratulations on your sale! 🎉',
            message: `"${listingTitle}"${qtyText} sold for £${totalSaleValue}. Add your bank details to receive payment after delivery.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });
      } else {
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: seller_id,
            type: 'sale',
            title: 'Item Sold! 🎉',
            message: `"${listingTitle}"${qtyText} sold for £${totalSaleValue}. Ship within ${SHIPPING_DEADLINE_DAYS} days. Payment released after delivery confirmed.`,
            image_url: listingImage,
            related_id: order.id,
          },
        });
      }

      // ✅ PUSH NOTIFICATION - New sale to seller
      try {
        await sendPushNotification(
          seller_id,
          '🎉 You made a sale!',
          `"${listingTitle}"${qtyText} sold for £${totalSaleValue}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          { type: 'sale', order_id: order.id }
        );
      } catch (pushErr) {
        console.error('Push notification failed:', pushErr);
      }

      console.log('✅ Order fulfilled successfully (escrow mode with quantity support)');
    } catch (error) {
      console.error('❌ Error fulfilling order:', error);
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
        console.log('⚠️ No platform fee in metadata, skipping payout');
        return;
      }

      const platformFeePence = Math.round(parseFloat(platformFee) * 100);

      if (platformFeePence <= 0) {
        console.log('⚠️ Platform fee is zero, skipping payout');
        return;
      }

      // Check available balance first
      const balance = await stripe.balance.retrieve();
      const availableGBP = balance.available.find(b => b.currency === 'gbp')?.amount || 0;

      if (availableGBP < platformFeePence) {
        console.log(`⚠️ Insufficient balance for fee payout. Available: ${availableGBP}, Needed: ${platformFeePence}`);
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

      console.log(`✅ Platform fee payout created: £${platformFee} → ${payout.id}`);
    } catch (error: any) {
      // Don't throw - fee payout failure shouldn't break order processing
      console.error('⚠️ Platform fee payout failed (non-critical):', error.message);
    }
  }
}
