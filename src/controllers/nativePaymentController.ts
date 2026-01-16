// src/controllers/nativePaymentController.ts
// Handles native in-app payments (Apple Pay / Google Pay)
// Uses Payment Intents instead of Checkout Sessions
// UPDATED: Added push notifications

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { sendPushNotification } from './pushNotificationController';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// Platform fee calculation (same as cart checkout)
const PLATFORM_FEE_PERCENT = 0.075; // 7.5%
const PLATFORM_FEE_FIXED = 0.99; // £0.99 per item
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
      const { listing_id, quantity = 1, selected_size } = req.body;
      const userId = req.user?.id || req.user?.sub;
      const orderQuantity = Math.max(1, parseInt(quantity) || 1);

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[PAY] Creating native payment intent for listing:', listing_id, 'qty:', orderQuantity);

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

      const seller = listing.users;

      // Auto-create Connect account if needed
      let sellerConnectId = seller.stripe_connect_id;
      if (!sellerConnectId) {
        console.log('[PAY] Auto-creating Connect account for seller:', seller.id);
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
      }

      // Calculate prices
      const unitPrice = parseFloat(listing.price.toString());
      const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
      const itemTotal = unitPrice * orderQuantity;
      const shippingTotal = Math.ceil(orderQuantity / 5) * shippingCost;
      const platformFee = (itemTotal * PLATFORM_FEE_PERCENT) + (PLATFORM_FEE_FIXED * orderQuantity);
      const grandTotal = itemTotal + shippingTotal + platformFee;

      const totalAmountPence = Math.round(grandTotal * 100);

      console.log('[PAY] Native payment breakdown:', {
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
          selected_size: selected_size || '',
          unit_price: unitPrice.toFixed(2),
          item_total: itemTotal.toFixed(2),
          shipping_cost: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          seller_payout: (itemTotal + shippingTotal).toFixed(2),
          grand_total: grandTotal.toFixed(2),
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
   */
  static async createCartPaymentIntent(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[PAY] Creating cart payment intent for user:', userId);

      // Get user's cart items
      const cartItems = await prisma.cart_items.findMany({
        where: { user_id: userId },
        include: {
          listings: {
            include: {
              images: { take: 1, orderBy: { created_at: 'asc' } },
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
      let itemsTotal = 0;
      let shippingTotal = 0;
      const itemsMetadata: string[] = [];

      for (const cartItem of cartItems) {
        const listing = cartItem.listings!;
        const quantity = cartItem.quantity || 1;
        const unitPrice = parseFloat(listing.price.toString());
        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
        
        itemsTotal += unitPrice * quantity;
        shippingTotal += Math.ceil(quantity / 5) * shippingCost;
        itemsMetadata.push(`${listing.id}:${quantity}`);
      }

      const totalQuantity = cartItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
const platformFee = (itemsTotal * PLATFORM_FEE_PERCENT) + (PLATFORM_FEE_FIXED * totalQuantity);
      const grandTotal = itemsTotal + shippingTotal + platformFee;
      const totalAmountPence = Math.round(grandTotal * 100);

      console.log('[PAY] Cart payment breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),
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
          type: 'native_cart',
          buyer_id: userId,
          items: itemsMetadata.join(','),
          items_total: itemsTotal.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
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

      // Check if already processed
      const existingOrder = await prisma.orders.findFirst({
        where: { stripe_payment_intent_id: paymentIntentId },
      });

      if (existingOrder) {
        return res.json({ 
          success: true, 
          order_id: existingOrder.id,
          message: 'Order already created',
        });
      }

      // Calculate auto-cancel date
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      // Create order based on type
      const metadata = paymentIntent.metadata;
      let orders: any;

      if (metadata.type === 'native_single_item') {
        orders = await NativePaymentController.fulfillSingleItem(
          paymentIntent,
          shippingAddress,
          autoCancelAt
        );
      } else if (metadata.type === 'native_cart') {
        orders = await NativePaymentController.fulfillCart(
          paymentIntent,
          shippingAddress,
          autoCancelAt
        );
      } else {
        return res.status(400).json({ error: 'Unknown payment type' });
      }

      res.json({
        success: true,
        order_id: Array.isArray(orders) ? orders[0]?.id : orders?.id,
        orders: Array.isArray(orders) ? orders.map((o: any) => o.id) : [orders?.id],
      });
    } catch (error: any) {
      console.error('[PAY] Error confirming payment:', error);
      res.status(500).json({ error: error.message || 'Failed to confirm payment' });
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
    const orderQuantity = parseInt(metadata.quantity) || 1;
    const selectedSize = metadata.selected_size || null;

    const listing = await prisma.listings.findUnique({
      where: { id: listingId },
      include: { images: { take: 1 } },
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    // SIZE VARIANT: Calculate new stock
    let newTotalStock: number;
    let updatedSpecs = listing.specifications;
    
    if (selectedSize && (listing.specifications as any)?.sizeQuantities) {
      updatedSpecs = decrementSizeStock(listing.specifications, selectedSize, orderQuantity);
      newTotalStock = getTotalStockFromSizes(updatedSpecs);
    } else {
      newTotalStock = listing.quantity - orderQuantity;
    }
    
    const shouldMarkSold = newTotalStock <= 0;
    const listingImage = listing.images?.[0]?.image_url || null;
    const itemPrice = parseFloat(listing.price.toString());

    const order = await prisma.$transaction(async (tx) => {
      // Create order with selected_size
      const createdOrder = await tx.orders.create({
        data: {
          id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          listing_id: listingId,
          buyer_id: buyerId,
          seller_id: sellerId,
          amount: parseFloat(metadata.item_total),
          quantity: orderQuantity,
          selected_size: selectedSize,
          shipping_cost: parseFloat(metadata.shipping_cost || '0'),
          seller_payout: parseFloat(metadata.seller_payout),
          listing_title: listing.title,
          listing_image: listingImage,
          listing_price: itemPrice,
          currency: 'GBP',
          stripe_payment_intent_id: paymentIntent.id,
          status: 'to_ship',
          paid_at: new Date(),
          auto_cancel_at: autoCancelAt,
          shipping_address: shippingAddress ?? Prisma.JsonNull,
          updated_at: new Date(),
        },
      });

      console.log('[PAY] Listing snapshot saved:', listing.title, '@ £' + itemPrice, selectedSize ? `(${selectedSize})` : '');

      // SIZE VARIANT: Update stock and specifications
      await tx.listings.update({
        where: { id: listingId },
        data: {
          quantity: Math.max(0, newTotalStock),
          specifications: updatedSpecs ?? undefined,
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
    const sizeText = selectedSize ? ` (${selectedSize})` : '';
    const qtyText = orderQuantity > 1 ? ` (x${orderQuantity})` : '';

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: buyerId,
        type: 'order',
        title: 'Payment Successful!',
        message: `Your order for "${listing.title}"${sizeText}${qtyText} has been confirmed. The seller will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        image_url: listingImage,
        related_id: order.id,
      },
    });

    // PUSH: Notify buyer
    try {
      await sendPushNotification(
        buyerId,
        'Payment Successful!',
        `Your order for "${listing.title}" is confirmed. Shipping within ${SHIPPING_DEADLINE_DAYS} days.`,
        { type: 'order', order_id: order.id }
      );
    } catch (pushErr) {
      console.error('[PAY] Push to buyer failed:', pushErr);
    }

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: sellerId,
        type: 'sale',
        title: 'Item Sold!',
        message: `"${listing.title}"${qtyText} sold for £${metadata.item_total}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        image_url: listingImage,
        related_id: order.id,
      },
    });

    // PUSH: Notify seller of sale
    try {
      await sendPushNotification(
        sellerId,
        'You Made a Sale!',
        `"${listing.title}" sold for £${metadata.item_total}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
        { type: 'sale', order_id: order.id }
      );
    } catch (pushErr) {
      console.error('[PAY] Push to seller failed:', pushErr);
    }

    console.log('[PAY] Single item order fulfilled:', order.id);
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
        const listingImage = listing.images?.[0]?.image_url || null;

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
            listing_title: listing.title,
            listing_image: listingImage,
            listing_price: unitPrice,
            currency: 'GBP',
            stripe_payment_intent_id: paymentIntent.id,
            status: 'to_ship',
            paid_at: new Date(),
            auto_cancel_at: autoCancelAt,
            shipping_address: shippingAddress ?? Prisma.JsonNull,
            updated_at: new Date(),
          },
        });

        console.log('[PAY] Listing snapshot saved:', listing.title, '@ £' + unitPrice);
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
        { type: 'order', order_id: orders[0]?.id }
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
      const sellerTotal = sellerOrderList.reduce((sum, o) => sum + o.amount, 0);
      const sellerQty = sellerOrderList.reduce((sum, o) => sum + o.quantity, 0);
      const sellerImage = sellerOrderList[0]?.listing?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: sellerId,
          type: 'sale',
          title: 'Items Sold!',
          message: `You sold ${sellerQty} item${sellerQty > 1 ? 's' : ''} for £${sellerTotal.toFixed(2)}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: sellerImage,
          related_id: sellerOrderList[0]?.id,
        },
      });

      // PUSH: Notify seller of sale
      try {
        await sendPushNotification(
          sellerId,
          'You Made a Sale!',
          `You sold ${sellerQty} item${sellerQty > 1 ? 's' : ''} for £${sellerTotal.toFixed(2)}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          { type: 'sale', order_id: sellerOrderList[0]?.id }
        );
      } catch (pushErr) {
        console.error('[PAY] Push to seller failed:', pushErr);
      }
    }

    console.log('[PAY] Cart orders fulfilled:', orders.length);
    return orders;
  }
}