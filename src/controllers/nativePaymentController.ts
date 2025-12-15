// src/controllers/nativePaymentController.ts
// Handles native in-app payments (Apple Pay / Google Pay)
// Uses Payment Intents instead of Checkout Sessions

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// Platform fee calculation (same as cart checkout)
const PLATFORM_FEE_PERCENT = 0.07; // 7%
const PLATFORM_FEE_FIXED = 0.99; // £0.99
const SHIPPING_DEADLINE_DAYS = 5;

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
   */
  static async createSingleItemPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id, quantity = 1 } = req.body;
      const userId = req.user?.id || req.user?.sub;
      const orderQuantity = Math.max(1, parseInt(quantity) || 1);

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('📱 Creating native payment intent for listing:', listing_id, 'qty:', orderQuantity);

      // Get listing details
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          images: { take: 1, orderBy: { created_at: 'asc' } },
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

      if (listing.quantity < orderQuantity) {
        return res.status(400).json({
          error: 'Not enough stock available',
          available: listing.quantity,
          requested: orderQuantity,
        });
      }

      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot buy your own listing' });
      }

      const seller = listing.users;

      // Auto-create Connect account if needed
      let sellerConnectId = seller.stripe_connect_id;
      if (!sellerConnectId) {
        console.log('🔗 Auto-creating Connect account for seller:', seller.id);
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
        console.log('✅ Connect account auto-created:', account.id);
      }

      // Calculate prices
      const unitPrice = parseFloat(listing.price.toString());
      const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
      const itemTotal = unitPrice * orderQuantity;
      const shippingTotal = Math.ceil(orderQuantity / 5) * shippingCost; // Every 5 items = 1 shipping
      const platformFee = (itemTotal * PLATFORM_FEE_PERCENT) + PLATFORM_FEE_FIXED;
      const grandTotal = itemTotal + shippingTotal + platformFee;

      const totalAmountPence = Math.round(grandTotal * 100);

      console.log('💰 Native payment breakdown:', {
        unitPrice: unitPrice.toFixed(2),
        quantity: orderQuantity,
        itemTotal: itemTotal.toFixed(2),
        shipping: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
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
          unit_price: unitPrice.toFixed(2),
          item_total: itemTotal.toFixed(2),
          shipping_cost: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          seller_payout: (itemTotal + shippingTotal).toFixed(2),
          grand_total: grandTotal.toFixed(2),
        },
      });

      console.log('✅ Payment Intent created:', paymentIntent.id);

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
      console.error('❌ Create single item payment intent error:', error);
      res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
  }

  /**
   * Create Payment Intent for cart (Apple Pay on cart screen)
   * POST /api/stripe/native-payment/cart
   */
  static async createCartPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('📱 Creating native cart payment intent for user:', userId);

      // Get cart items
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() },
        },
        include: {
          listings: {
            include: {
              images: { take: 1, orderBy: { created_at: 'asc' } },
              users: {
                select: {
                  id: true,
                  email: true,
                  display_name: true,
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

      // Validate items
      const unavailableItems = cartItems.filter(item => item.listings.status !== 'active');
      if (unavailableItems.length > 0) {
        await prisma.cart_items.deleteMany({
          where: { id: { in: unavailableItems.map(item => item.id) } },
        });
        return res.status(400).json({
          error: 'Some items are no longer available',
          unavailable: unavailableItems.map(item => ({
            listing_id: item.listing_id,
            title: item.listings.title,
          })),
        });
      }

      // Check stock
      const overStockItems = cartItems.filter(
        item => (item.quantity || 1) > item.listings.quantity
      );
      if (overStockItems.length > 0) {
        return res.status(400).json({
          error: 'Some items exceed available stock',
          over_stock: overStockItems.map(item => ({
            listing_id: item.listing_id,
            title: item.listings.title,
            requested: item.quantity || 1,
            available: item.listings.quantity,
          })),
        });
      }

      // Check not buying own items
      const ownItems = cartItems.filter(item => item.listings.seller_id === userId);
      if (ownItems.length > 0) {
        return res.status(400).json({ error: 'You cannot buy your own listings' });
      }

      // Calculate totals
      let itemsTotal = 0;
      let shippingTotal = 0;
      const itemsMetadata: string[] = [];

      // Group by seller for shipping calculation
      const sellerGroups: { [sellerId: string]: { items: any[]; maxShipping: number } } = {};

      for (const item of cartItems) {
        const quantity = item.quantity || 1;
        const price = parseFloat(item.listings.price.toString());
        const shippingCost = parseFloat((item.listings as any).shipping_cost?.toString() || '0');
        const sellerId = item.listings.seller_id;

        itemsTotal += price * quantity;

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = { items: [], maxShipping: 0 };
        }
        sellerGroups[sellerId].items.push(item);
        const listingShipping = Math.ceil(quantity / 5) * shippingCost;
        sellerGroups[sellerId].maxShipping = Math.max(sellerGroups[sellerId].maxShipping, listingShipping);

        itemsMetadata.push(`${item.listing_id}:${quantity}`);
      }

      // Sum max shipping per seller
      for (const sellerId of Object.keys(sellerGroups)) {
        shippingTotal += sellerGroups[sellerId].maxShipping;
      }

      const platformFee = (itemsTotal * PLATFORM_FEE_PERCENT) + PLATFORM_FEE_FIXED;
      const grandTotal = itemsTotal + shippingTotal + platformFee;
      const totalAmountPence = Math.round(grandTotal * 100);

      console.log('💰 Native cart payment breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shipping: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        itemCount: cartItems.length,
      });

      // Create Payment Intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountPence,
        currency: 'gbp',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          type: 'native_cart',
          buyer_id: userId,
          items: itemsMetadata.join(','), // Format: "listing_id:qty,listing_id:qty"
          items_total: itemsTotal.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
        },
      });

      console.log('✅ Cart Payment Intent created:', paymentIntent.id);

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
      });
    } catch (error: any) {
      console.error('❌ Create cart payment intent error:', error);
      res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
  }

  /**
   * Fulfill native payment after successful Apple Pay
   * POST /api/stripe/native-payment/fulfill
   */
  static async fulfillNativePayment(req: AuthenticatedRequest, res: Response) {
    try {
      const { paymentIntentId, shippingAddress } = req.body;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment Intent ID required' });
      }

      console.log('📦 Fulfilling native payment:', paymentIntentId);

      // Retrieve Payment Intent from Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment not completed' });
      }

      const metadata = paymentIntent.metadata;

      // Verify buyer matches
      if (metadata.buyer_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Check if already fulfilled
      const existingOrder = await prisma.orders.findFirst({
        where: { stripe_payment_intent_id: paymentIntentId },
      });

      if (existingOrder) {
        console.log('⚠️ Order already exists for this payment');
        return res.json({ success: true, message: 'Order already created', orderId: existingOrder.id });
      }

      // Format shipping address
      const shippingAddressJson = shippingAddress ? {
        name: shippingAddress.name || '',
        line1: shippingAddress.line1 || shippingAddress.address?.line1 || '',
        line2: shippingAddress.line2 || shippingAddress.address?.line2 || null,
        city: shippingAddress.city || shippingAddress.address?.city || '',
        postal_code: shippingAddress.postalCode || shippingAddress.address?.postalCode || '',
        country: shippingAddress.country || shippingAddress.address?.country || 'GB',
      } : null;

      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      if (metadata.type === 'native_single_item') {
        // Single item order
        const order = await NativePaymentController.fulfillSingleItem(
          paymentIntent,
          shippingAddressJson,
          autoCancelAt
        );
        
        return res.json({ success: true, orderId: order.id });
      } else if (metadata.type === 'native_cart') {
        // Cart order
        const orders = await NativePaymentController.fulfillCart(
          paymentIntent,
          shippingAddressJson,
          autoCancelAt
        );
        
        return res.json({ success: true, orderIds: orders.map(o => o.id) });
      } else {
        return res.status(400).json({ error: 'Unknown payment type' });
      }
    } catch (error: any) {
      console.error('❌ Fulfill native payment error:', error);
      res.status(500).json({ error: error.message || 'Failed to fulfill order' });
    }
  }

  /**
   * Fulfill single item order
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
    const orderQuantity = parseInt(metadata.quantity || '1');

    const listing = await prisma.listings.findUnique({
      where: { id: listingId },
      include: { images: { take: 1 } },
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    const newStock = listing.quantity - orderQuantity;
    const shouldMarkSold = newStock <= 0;

    const order = await prisma.$transaction(async (tx) => {
      // Create order
      const createdOrder = await tx.orders.create({
        data: {
          id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          listing_id: listingId,
          buyer_id: buyerId,
          seller_id: sellerId,
          amount: parseFloat(metadata.item_total),
          quantity: orderQuantity,
          shipping_cost: parseFloat(metadata.shipping_cost || '0'),
          seller_payout: parseFloat(metadata.seller_payout),
          currency: 'GBP',
          stripe_payment_intent_id: paymentIntent.id,
          status: 'to_ship',
          paid_at: new Date(),
          auto_cancel_at: autoCancelAt,
          shipping_address: shippingAddress ?? Prisma.JsonNull,
          updated_at: new Date(),
        },
      });

      // Update stock
      await tx.listings.update({
        where: { id: listingId },
        data: {
          quantity: Math.max(0, newStock),
          status: shouldMarkSold ? 'sold' : 'active',
          updated_at: new Date(),
        },
      });

      // Remove from cart if present
      await tx.cart_items.deleteMany({
        where: { user_id: buyerId, listing_id: listingId },
      });

      return createdOrder;
    });

    // Create notifications
    const listingImage = listing.images?.[0]?.image_url || null;
    const qtyText = orderQuantity > 1 ? ` (x${orderQuantity})` : '';

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: buyerId,
        type: 'order',
        title: 'Payment Successful! 🎉',
        message: `Your order for "${listing.title}"${qtyText} has been confirmed. The seller will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        image_url: listingImage,
        related_id: order.id,
      },
    });

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: sellerId,
        type: 'sale',
        title: 'Item Sold! 🎉',
        message: `"${listing.title}"${qtyText} sold for £${metadata.item_total}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        image_url: listingImage,
        related_id: order.id,
      },
    });

    console.log('✅ Single item order fulfilled:', order.id);
    return order;
  }

  /**
   * Fulfill cart order
   */
  private static async fulfillCart(
    paymentIntent: Stripe.PaymentIntent,
    shippingAddress: any,
    autoCancelAt: Date
  ) {
    const metadata = paymentIntent.metadata;
    const buyerId = metadata.buyer_id;
    
    // Parse items from metadata (format: "listing_id:qty,listing_id:qty")
    const itemsData = metadata.items.split(',').map((item: string) => {
      const [listing_id, quantity] = item.split(':');
      return { listing_id, quantity: parseInt(quantity) || 1 };
    });

    const orders: any[] = [];

    await prisma.$transaction(async (tx) => {
      for (const itemData of itemsData) {
        const listing = await tx.listings.findUnique({
          where: { id: itemData.listing_id },
          include: { images: { take: 1 } },
        });

        if (!listing) continue;

        const unitPrice = parseFloat(listing.price.toString());
        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
        const itemTotal = unitPrice * itemData.quantity;
        const orderShipping = Math.ceil(itemData.quantity / 5) * shippingCost;
        const sellerPayout = itemTotal + orderShipping;

        const newStock = listing.quantity - itemData.quantity;
        const shouldMarkSold = newStock <= 0;

        const order = await tx.orders.create({
          data: {
            id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            listing_id: itemData.listing_id,
            buyer_id: buyerId,
            seller_id: listing.seller_id,
            amount: itemTotal,
            quantity: itemData.quantity,
            shipping_cost: orderShipping,
            seller_payout: sellerPayout,
            currency: 'GBP',
            stripe_payment_intent_id: paymentIntent.id,
            status: 'to_ship',
            paid_at: new Date(),
            auto_cancel_at: autoCancelAt,
            shipping_address: shippingAddress ?? Prisma.JsonNull,
            updated_at: new Date(),
          },
        });

        orders.push({ ...order, listing });

        // Update stock
        await tx.listings.update({
          where: { id: itemData.listing_id },
          data: {
            quantity: Math.max(0, newStock),
            status: shouldMarkSold ? 'sold' : 'active',
            updated_at: new Date(),
          },
        });
      }

      // Clear cart
      await tx.cart_items.deleteMany({
        where: {
          user_id: buyerId,
          listing_id: { in: itemsData.map((i: any) => i.listing_id) },
        },
      });
    });

    // Create notifications
    const firstImage = orders[0]?.listing?.images?.[0]?.image_url || null;
    const totalItems = orders.reduce((sum, o) => sum + o.quantity, 0);

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: buyerId,
        type: 'order',
        title: 'Payment Successful! 🎉',
        message: `Your order of ${totalItems} item${totalItems > 1 ? 's' : ''} has been confirmed.`,
        image_url: firstImage,
        related_id: orders[0]?.id,
      },
    });

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
      const sellerTotal = sellerOrderList.reduce((sum, o) => sum + o.amount, 0);
      const sellerQty = sellerOrderList.reduce((sum, o) => sum + o.quantity, 0);
      const sellerImage = sellerOrderList[0]?.listing?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: sellerId,
          type: 'sale',
          title: 'Items Sold! 🎉',
          message: `You sold ${sellerQty} item${sellerQty > 1 ? 's' : ''} for £${sellerTotal.toFixed(2)}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: sellerImage,
          related_id: sellerOrderList[0]?.id,
        },
      });
    }

    console.log('✅ Cart orders fulfilled:', orders.length);
    return orders;
  }
}