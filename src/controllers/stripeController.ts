// src/controllers/stripeController.ts
// Updated to handle both single-item and cart checkout webhooks
// FIXED: Now retrieves full session with shipping details
// FIXED: Now includes image_url in notifications

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { CartCheckoutController } from './cartCheckoutController';

const prisma = new PrismaClient();
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

export class StripeController {
  /**
   * Create Stripe Checkout Session (Single Item - Legacy)
   * POST /api/stripe/create-checkout-session
   */
  static async createCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id } = req.body;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('🛒 Creating checkout session for listing:', listing_id);

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

      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot buy your own listing' });
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

      // Calculate prices
      const itemPrice = parseFloat(listing.price.toString());
      const platformFeePercent = 0.07;
      const platformFeeFixed = 0.99;
      const platformFee = (itemPrice * platformFeePercent) + platformFeeFixed;
      const totalPrice = itemPrice + platformFee;

      const totalAmountPence = Math.round(totalPrice * 100);
      const platformFeePence = Math.round(platformFee * 100);

      console.log('💰 Price breakdown:', {
        itemPrice: itemPrice.toFixed(2),
        platformFee: platformFee.toFixed(2),
        totalPrice: totalPrice.toFixed(2),
        sellerReceives: itemPrice.toFixed(2),
        sellerConnectId,
      });

      // Create PaymentIntent with Connect transfer
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        transfer_data: {
          destination: sellerConnectId,
        },
        application_fee_amount: platformFeePence,
        metadata: {
          type: 'single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId,
          item_price: itemPrice.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          total_price: totalPrice.toFixed(2),
        },
      });

      // Create checkout session for web fallback
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'gbp',
              product_data: {
                name: listing.title,
                description: `Sold by ${seller.display_name}`,
                images: listing.images && listing.images.length > 0
                  ? [listing.images[0].image_url]
                  : undefined,
              },
              unit_amount: totalAmountPence,
            },
            quantity: 1,
          },
        ],
        shipping_address_collection: {
          allowed_countries: ['GB'],
        },
        payment_intent_data: {
          transfer_data: {
            destination: sellerConnectId,
          },
          application_fee_amount: platformFeePence,
        },
        metadata: {
          type: 'single_item',
          listing_id: listing.id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          seller_connect_id: sellerConnectId,
          item_price: itemPrice.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          total_price: totalPrice.toFixed(2),
        },
        success_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-cancelled`,
      });

      console.log('✅ Payment intent created:', paymentIntent.id);
      console.log('✅ Checkout session created:', session.id);
      console.log('✅ Funds will transfer to:', sellerConnectId);

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
        break;

      case 'payment_intent.succeeded':
        console.log('💰 Payment succeeded');
        break;

      case 'transfer.created':
        const transfer = event.data.object as Stripe.Transfer;
        console.log('💸 Transfer created to Connect account:', transfer.destination);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }

  /**
   * Fulfill Single Item Order
   * UPDATED: Now includes image_url in notifications
   */
  private static async fulfillOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('📦 Fulfilling order for session:', session.id);

      const metadata = session.metadata!;
      const listing_id = metadata.listing_id;
      const buyer_id = metadata.buyer_id;
      const seller_id = metadata.seller_id;

      // Check if order already exists
      const existingOrder = await prisma.orders.findFirst({
        where: { listing_id, buyer_id },
      });

      if (existingOrder) {
        console.log('⚠️ Order already exists:', existingOrder.id);
        return;
      }

      // ✅ Get listing with image for notifications
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: {
            take: 1,
            orderBy: { display_order: 'asc' },
          },
        },
      });

      const listingImage = listing?.images?.[0]?.image_url || null;
      const listingTitle = listing?.title || 'your item';

      // Get shipping address from session
      // Note: In newer Stripe API versions, shipping is in collected_information.shipping_details
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

      const itemPrice = parseFloat(metadata.item_price);
      const sellerPayout = itemPrice;

      // Auto-cancel date (7 days)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + 7);

      // Create order with shipping address
      const order = await prisma.orders.create({
        data: {
          id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          listing_id,
          buyer_id,
          seller_id,
          amount: parseFloat(metadata.total_price),
          seller_payout: sellerPayout,
          currency: 'GBP',
          stripe_payment_intent_id: session.payment_intent as string,
          stripe_payment_method_id: paymentMethodId,
          status: 'to_ship',
          paid_at: new Date(),
          auto_cancel_at: autoCancelAt,
          shipping_address: shippingAddressJson ?? Prisma.JsonNull,
          updated_at: new Date(),
        },
      });

      console.log('✅ Order created:', order.id);
      console.log('📍 With shipping address:', shippingAddressJson ? 'YES' : 'NO');

      // Update listing
      await prisma.listings.update({
        where: { id: listing_id },
        data: { status: 'sold', updated_at: new Date() },
      });

      // Check if seller needs bank verification
      const sellerUser = await prisma.users.findUnique({
        where: { id: seller_id },
        select: { stripe_connect_status: true },
      });

      const needsVerification = sellerUser?.stripe_connect_status !== 'active';

      // ✅ Notify buyer - WITH IMAGE
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyer_id,
          type: 'order',
          title: 'Payment Successful! 🎉',
          message: `Your order for "${listingTitle}" has been confirmed. The seller will ship your item soon.`,
          image_url: listingImage, // ✅ NEW: Include image
          related_id: order.id,
        },
      });

      // ✅ Notify seller - WITH IMAGE (different message if needs verification)
      if (needsVerification) {
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: seller_id,
            type: 'payout',
            title: 'Congratulations on your sale! 🎉',
            message: `"${listingTitle}" sold for £${itemPrice.toFixed(2)}. Add your bank details to withdraw your earnings.`,
            image_url: listingImage, // ✅ NEW: Include image
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
            message: `"${listingTitle}" sold for £${itemPrice.toFixed(2)}. Please ship within 7 days.`,
            image_url: listingImage, // ✅ NEW: Include image
            related_id: order.id,
          },
        });
      }

      console.log('✅ Order fulfilled successfully');
    } catch (error) {
      console.error('❌ Error fulfilling order:', error);
      throw error;
    }
  }
}