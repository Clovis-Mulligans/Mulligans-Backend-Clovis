// src/controllers/orderController.ts
// ✅ UPDATED: Escrow system implementation
// - Shipping deadline: 5 days
// - Escrow release: 3 days after delivery
// - Tracking number required
// - Confirm receipt / Report lost endpoints

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { sendShippingNotification } from '../services/emailService';
import { sendPushNotification } from './pushNotificationController';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// CONSTANTS
// ============================================
const SHIPPING_DEADLINE_DAYS = 5;
const ESCROW_RELEASE_DAYS = 3;

// Fee calculation - matches your pricing structure
const calculateSellerPayout = (totalAmount: number): number => {
  const platformFeePercent = 0.07;
  const platformFeeFixed = 0.99;
  const sellerPayout = (totalAmount - platformFeeFixed) / (1 + platformFeePercent);
  return Math.round(sellerPayout * 100) / 100;
};

export class OrderController {
  /**
   * Get order counts for badges (pending sales + new purchases)
   * GET /api/orders/counts
   */
  static async getOrderCounts(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const pendingSales = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: {
            in: ['to_ship', 'paid'],
          },
        },
      });

      const newPurchases = await prisma.orders.count({
        where: {
          buyer_id: userId,
          status: {
            in: ['to_ship', 'in_transit'],
          },
          buyer_viewed_at: null,
        },
      });

      console.log(`📊 Order counts for ${userId}: pending_sales=${pendingSales}, new_purchases=${newPurchases}`);

      res.json({
        pending_sales: pendingSales,
        new_purchases: newPurchases,
        total: pendingSales + newPurchases,
      });
    } catch (error: any) {
      console.error('❌ Get order counts error:', error);
      res.status(500).json({ error: 'Failed to get order counts' });
    }
  }

  /**
   * Mark order as viewed by buyer
   * PUT /api/orders/:id/viewed
   */
  static async markAsViewed(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          buyer_id: userId,
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      if (order.buyer_viewed_at) {
        return res.json({ success: true, already_viewed: true });
      }

      await prisma.orders.update({
        where: { id: orderId },
        data: {
          buyer_viewed_at: new Date(),
          updated_at: new Date(),
        },
      });

      console.log('✅ Order marked as viewed:', orderId);
      res.json({ success: true });
    } catch (error: any) {
      console.error('❌ Mark viewed error:', error);
      res.status(500).json({ error: 'Failed to mark order as viewed' });
    }
  }

  /**
   * Get user's purchases (orders where they are the buyer)
   * GET /api/orders/my-purchases?status=in_progress
   */
  static async getMyPurchases(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;

      console.log('📦 Fetching purchases for user:', userId, 'status:', status);

      let statusFilter: any = {};
      if (status && status !== 'all') {
        if (status === 'in_progress') {
          statusFilter = { status: { in: ['to_ship', 'in_transit', 'delivered', 'pending'] } };
        } else if (status === 'cancelled') {
          statusFilter = { status: { in: ['cancelled', 'refunded'] } };
        } else if (status === 'completed') {
          statusFilter = { status: 'completed' };
        } else {
          statusFilter = { status };
        }
      }

      const orders = await prisma.orders.findMany({
        where: {
          buyer_id: userId,
          ...statusFilter,
        },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              category: true,
              price: true,
              images: {
                select: { image_url: true },
                take: 1,
                orderBy: { display_order: 'asc' },
              },
            },
          },
          users_orders_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
          reviews: {
            where: {
              reviewer_id: userId,
            },
            select: {
              id: true,
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
        take: limit,
      });

      const formattedOrders = orders.map((order) => ({
        id: order.id,
        listing_id: order.listing_id,
        listing_title: order.listings?.title || 'Item no longer available',
        listing_image: order.listings?.images?.[0]?.image_url || '',
        amount: parseFloat(order.amount.toString()),
        created_at: order.created_at.toISOString(),
        paid_at: order.paid_at?.toISOString() || null,
        shipped_at: order.shipped_at?.toISOString() || null,
        delivered_at: order.delivered_at?.toISOString() || null,
        completed_at: order.completed_at?.toISOString() || null,
        cancelled_at: order.cancelled_at?.toISOString() || null,
        escrow_release_at: order.escrow_release_at?.toISOString() || null,
        seller_id: order.seller_id,
        seller_name: order.users_orders_seller_idTousers?.display_name || 'Unknown',
        seller_avatar: order.users_orders_seller_idTousers?.avatar_url || null,
        status: order.status,
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        has_reviewed: order.reviews.length > 0,
        is_new: order.buyer_viewed_at === null && ['to_ship', 'in_transit'].includes(order.status),
        // ✅ NEW: Can confirm receipt if delivered but not completed
        can_confirm_receipt: order.status === 'delivered',
        // ✅ NEW: Can report lost if in_transit for 14+ days
        can_report_lost: order.status === 'in_transit' && 
          order.shipped_at && 
          (new Date().getTime() - order.shipped_at.getTime()) > 14 * 24 * 60 * 60 * 1000,
      }));

      console.log(`✅ Found ${formattedOrders.length} purchases`);
      res.json({ orders: formattedOrders });
    } catch (error: any) {
      console.error('❌ Get purchases error:', error);
      res.status(500).json({ error: 'Failed to get purchases' });
    }
  }

  /**
   * Get user's sales (orders where they are the seller)
   * GET /api/orders/my-sales?status=to_ship
   */
  static async getMySales(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;

      console.log('💰 Fetching sales for user:', userId, 'status:', status);

      let statusFilter: any = {};
      if (status && status !== 'all') {
        if (status === 'to_ship') {
          statusFilter = { status: 'to_ship' };
        } else if (status === 'in_transit') {
          statusFilter = { status: { in: ['in_transit', 'delivered'] } };
        } else if (status === 'cancelled') {
          statusFilter = { status: { in: ['cancelled', 'refunded'] } };
        } else if (status === 'completed') {
          statusFilter = { status: 'completed' };
        } else {
          statusFilter = { status };
        }
      }

      const orders = await prisma.orders.findMany({
        where: {
          seller_id: userId,
          ...statusFilter,
        },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              category: true,
              price: true,
              images: {
                select: { image_url: true },
                take: 1,
                orderBy: { display_order: 'asc' },
              },
            },
          },
          users_orders_buyer_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
        take: limit,
      });

      const formattedOrders = orders.map((order) => ({
        id: order.id,
        listing_id: order.listing_id,
        listing_title: order.listings?.title || 'Item no longer available',
        listing_image: order.listings?.images?.[0]?.image_url || '',
        amount: parseFloat(order.amount.toString()),
        seller_payout: order.seller_payout ? parseFloat(order.seller_payout.toString()) : null,
        created_at: order.created_at.toISOString(),
        paid_at: order.paid_at?.toISOString() || null,
        shipped_at: order.shipped_at?.toISOString() || null,
        delivered_at: order.delivered_at?.toISOString() || null,
        completed_at: order.completed_at?.toISOString() || null,
        cancelled_at: order.cancelled_at?.toISOString() || null,
        auto_cancel_at: order.auto_cancel_at?.toISOString() || null,
        escrow_release_at: order.escrow_release_at?.toISOString() || null,
        buyer_id: order.buyer_id,
        buyer_name: order.users_orders_buyer_idTousers?.display_name || 'Unknown',
        buyer_avatar: order.users_orders_buyer_idTousers?.avatar_url || null,
        status: order.status,
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        shipping_address: order.shipping_address,
        is_new: order.status === 'to_ship',
        // ✅ NEW: Days remaining to ship
        days_to_ship: order.auto_cancel_at ? 
          Math.max(0, Math.ceil((order.auto_cancel_at.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000))) : 
          null,
      }));

      console.log(`✅ Found ${formattedOrders.length} sales`);
      res.json({ orders: formattedOrders });
    } catch (error: any) {
      console.error('❌ Get sales error:', error);
      res.status(500).json({ error: 'Failed to get sales' });
    }
  }

  /**
   * Get single order by ID
   * GET /api/orders/:id
   */
  static async getOrderById(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
        },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              description: true,
              category: true,
              subcategory: true,
              brand: true,
              price: true,
              images: {
                select: { image_url: true },
                orderBy: { display_order: 'asc' },
              },
            },
          },
          users_orders_buyer_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              location: true,
            },
          },
          users_orders_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              location: true,
            },
          },
          reviews: {
            select: {
              id: true,
              rating: true,
              review_text: true,
              created_at: true,
              reviewer_id: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const isBuyer = order.buyer_id === userId;
      const isSeller = order.seller_id === userId;

      const formattedOrder = {
        id: order.id,
        listing_id: order.listing_id,
        listing: order.listings ? {
          title: order.listings.title,
          description: order.listings.description,
          category: order.listings.category,
          subcategory: order.listings.subcategory,
          brand: order.listings.brand,
          price: parseFloat(order.listings.price.toString()),
          images: order.listings.images.map((img: any) => img.image_url),
        } : null,
        amount: parseFloat(order.amount.toString()),
        shipping_cost: order.shipping_cost ? parseFloat(order.shipping_cost.toString()) : 0,
        seller_payout: order.seller_payout ? parseFloat(order.seller_payout.toString()) : null,
        currency: order.currency,
        status: order.status,
        created_at: order.created_at.toISOString(),
        paid_at: order.paid_at?.toISOString() || null,
        shipped_at: order.shipped_at?.toISOString() || null,
        delivered_at: order.delivered_at?.toISOString() || null,
        completed_at: order.completed_at?.toISOString() || null,
        cancelled_at: order.cancelled_at?.toISOString() || null,
        auto_cancel_at: order.auto_cancel_at?.toISOString() || null,
        escrow_release_at: order.escrow_release_at?.toISOString() || null,
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        shipping_address: isSeller ? order.shipping_address : null,
        buyer: {
          id: order.users_orders_buyer_idTousers?.id,
          name: order.users_orders_buyer_idTousers?.display_name || 'Unknown',
          avatar: order.users_orders_buyer_idTousers?.avatar_url,
          location: order.users_orders_buyer_idTousers?.location,
        },
        seller: {
          id: order.users_orders_seller_idTousers?.id,
          name: order.users_orders_seller_idTousers?.display_name || 'Unknown',
          avatar: order.users_orders_seller_idTousers?.avatar_url,
          location: order.users_orders_seller_idTousers?.location,
        },
        is_buyer: isBuyer,
        is_seller: isSeller,
        reviews: order.reviews.map((r: any) => ({
          id: r.id,
          rating: r.rating,
          comment: r.review_text,
          created_at: r.created_at.toISOString(),
          is_mine: r.reviewer_id === userId,
        })),
        has_reviewed: order.reviews.some((r: any) => r.reviewer_id === userId),
        dispute_reason: order.dispute_reason,
        cancel_reason: order.cancel_reason,
        // ✅ NEW: Buyer-specific actions
        can_confirm_receipt: isBuyer && order.status === 'delivered',
        can_report_lost: isBuyer && order.status === 'in_transit' && 
          order.shipped_at && 
          (new Date().getTime() - order.shipped_at.getTime()) > 14 * 24 * 60 * 60 * 1000,
        // ✅ NEW: Days until auto-release
        days_until_release: order.escrow_release_at ? 
          Math.max(0, Math.ceil((order.escrow_release_at.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000))) : 
          null,
      };

      res.json({ order: formattedOrder });
    } catch (error: any) {
      console.error('❌ Get order error:', error);
      res.status(500).json({ error: 'Failed to get order' });
    }
  }

  /**
   * Mark order as shipped (seller only)
   * PUT /api/orders/:id/ship
   * ✅ UPDATED: Tracking number is now REQUIRED
   */
  static async markAsShipped(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;
      const { tracking_number, carrier } = req.body;

      // ✅ REQUIRE tracking number
      if (!tracking_number || !tracking_number.trim()) {
        return res.status(400).json({ 
          error: 'Tracking number is required',
          message: 'All shipments must include a valid tracking number for buyer protection.'
        });
      }

      if (!carrier || !carrier.trim()) {
        return res.status(400).json({ 
          error: 'Carrier is required',
          message: 'Please select the shipping carrier (e.g., Royal Mail, Evri, DPD).'
        });
      }

      console.log('📦 Marking order as shipped:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          seller_id: userId,
          status: 'to_ship',
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
              email: true,
              display_name: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be shipped' });
      }

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'in_transit',
          tracking_number: tracking_number.trim(),
          carrier: carrier.trim(),
          shipped_at: new Date(),
          auto_cancel_at: null, // Clear auto-cancel since it's now shipped
          updated_at: new Date(),
        },
      });

      // Create notification for buyer
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.buyer_id,
          type: 'shipped',
          title: 'Your item has shipped! 📦',
          message: `"${listingTitle}" is on its way! Tracking: ${tracking_number}`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order marked as shipped:', orderId);

      // ✅ PUSH NOTIFICATION - Item shipped
      try {
        await sendPushNotification(
          order.buyer_id,
          '📦 Your item has shipped!',
          `"${listingTitle}" is on its way! Tracking: ${tracking_number}`,
          { type: 'order_update', order_id: orderId, is_buyer: true }
        );
      } catch (pushErr) {
        console.error('Push notification failed:', pushErr);
      }

      // Send shipping notification email
      const buyerEmail = order.users_orders_buyer_idTousers?.email;
      if (buyerEmail) {
        try {
          await sendShippingNotification(buyerEmail, {
            buyerName: order.users_orders_buyer_idTousers?.display_name || 'there',
            itemName: listingTitle,
            trackingNumber: tracking_number,
            carrier: carrier,
            orderId: orderId,
          });
          console.log('📧 Shipping notification email sent to:', buyerEmail);
        } catch (emailError) {
          console.error('⚠️ Failed to send shipping email:', emailError);
        }
      }

      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Mark shipped error:', error);
      res.status(500).json({ error: 'Failed to mark order as shipped' });
    }
  }

  /**
   * Mark order as delivered
   * PUT /api/orders/:id/deliver
   * ✅ UPDATED: Now sets escrow_release_at
   */
  static async markAsDelivered(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      console.log('✅ Marking order as delivered:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: 'in_transit',
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
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be marked delivered' });
      }

      // ✅ Calculate escrow release date (5 days from now)
      const escrowReleaseAt = new Date();
      escrowReleaseAt.setDate(escrowReleaseAt.getDate() + ESCROW_RELEASE_DAYS);

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'delivered',
          delivered_at: new Date(),
          escrow_release_at: escrowReleaseAt, // ✅ NEW
          updated_at: new Date(),
        },
      });

      // Create notification for buyer
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.buyer_id,
          type: 'delivered',
          title: 'Item delivered! 🎉',
          message: `"${listingTitle}" has been delivered. You have ${ESCROW_RELEASE_DAYS} days to confirm or report any issues.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order marked as delivered:', orderId);
      console.log(`📅 Escrow release scheduled for: ${escrowReleaseAt.toISOString()}`);

      // ✅ PUSH NOTIFICATION - Item delivered
      try {
        await sendPushNotification(
          order.buyer_id,
          '🎉 Your item has been delivered!',
          `"${listingTitle}" has arrived. Confirm receipt within ${ESCROW_RELEASE_DAYS} days.`,
          { type: 'order_update', order_id: orderId, is_buyer: true }
        );
      } catch (pushErr) {
        console.error('Push notification failed:', pushErr);
      }

      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Mark delivered error:', error);
      res.status(500).json({ error: 'Failed to mark order as delivered' });
    }
  }

  /**
   * ✅ NEW: Buyer confirms receipt (releases escrow early)
   * PUT /api/orders/:id/confirm-receipt
   */
  static async confirmReceipt(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      console.log('✅ Buyer confirming receipt:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          buyer_id: userId,
          status: 'delivered',
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

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot confirm receipt' });
      }

      const seller = order.users_orders_seller_idTousers;
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      // ✅ Transfer funds to seller immediately
      if (seller.stripe_connect_id && order.seller_payout) {
        const transferAmount = Math.round(parseFloat(order.seller_payout.toString()) * 100);

        try {
          const transfer = await stripe.transfers.create({
            amount: transferAmount,
            currency: 'gbp',
            destination: seller.stripe_connect_id,
            metadata: {
              order_id: order.id,
              type: 'buyer_confirmed_receipt',
              confirmed_at: new Date().toISOString(),
            },
          });

          console.log(`💸 Transfer ${transfer.id} created for £${(transferAmount / 100).toFixed(2)}`);
        } catch (transferError: any) {
          console.error('⚠️ Transfer failed:', transferError.message);
          return res.status(500).json({ error: 'Failed to process payment to seller' });
        }
      }

      // Update order to completed
      const now = new Date();
      await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'completed',
          completed_at: now,
          escrow_release_at: now, // Mark as released
          updated_at: now,
        },
      });

      // Update seller's total_sales
      await prisma.users.update({
        where: { id: seller.id },
        data: {
          total_sales: { increment: 1 },
          updated_at: now,
        },
      });

      // Notify seller
      const payoutAmount = order.seller_payout ? parseFloat(order.seller_payout.toString()).toFixed(2) : '0.00';

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: seller.id,
          type: 'payout',
          title: 'Payment Released! 💰',
          message: `The buyer confirmed receipt of "${listingTitle}". £${payoutAmount} has been transferred to your account.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Receipt confirmed, escrow released for order:', orderId);

      res.json({ 
        success: true, 
        message: 'Thank you for confirming receipt. The seller has been paid.' 
      });
    } catch (error: any) {
      console.error('❌ Confirm receipt error:', error);
      res.status(500).json({ error: 'Failed to confirm receipt' });
    }
  }

  /**
   * ✅ NEW: Buyer reports item as lost
   * PUT /api/orders/:id/report-lost
   */
  static async reportLost(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      console.log('📦 Buyer reporting item as lost:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          buyer_id: userId,
          status: 'in_transit',
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
              display_name: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be reported as lost' });
      }

      // Check if shipped more than 14 days ago
      if (order.shipped_at) {
        const daysSinceShipped = (new Date().getTime() - order.shipped_at.getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceShipped < 14) {
          return res.status(400).json({ 
            error: 'Too early to report as lost',
            message: `You can report this item as lost after ${Math.ceil(14 - daysSinceShipped)} more days.`
          });
        }
      }

      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;
      const now = new Date();

      // ✅ Refund the buyer
      if (order.stripe_payment_intent_id) {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: order.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              order_id: order.id,
              reason: 'reported_lost_in_transit',
            },
          });
          console.log(`💸 Refund created: ${refund.id} for order ${order.id}`);
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          return res.status(500).json({ error: 'Failed to process refund' });
        }
      }

      // Update order status
      await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'refunded',
          reported_lost_at: now,
          cancel_reason: 'lost_in_transit',
          updated_at: now,
        },
      });

      // Notify buyer
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.buyer_id,
          type: 'refund',
          title: 'Refund Processed',
          message: `Your order for "${listingTitle}" has been refunded as it was reported lost in transit.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      // Notify seller
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.seller_id,
          type: 'order_issue',
          title: 'Item Reported Lost in Transit',
          message: `"${listingTitle}" was reported as lost by the buyer. The buyer has been refunded. You may claim compensation from the courier.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order reported as lost, buyer refunded:', orderId);

      res.json({ 
        success: true, 
        message: 'Your refund has been processed. The seller has been notified to claim from the courier.' 
      });
    } catch (error: any) {
      console.error('❌ Report lost error:', error);
      res.status(500).json({ error: 'Failed to report item as lost' });
    }
  }

  /**
   * Cancel order
   * PUT /api/orders/:id/cancel
   * 
   * ✅ UPDATED:
   * - Blocks cancellation if label_url exists (shipping label created)
   * - Requires a reason from the request
   * - Tracks cancellation count for buyer/seller
   * - Creates automatic 1-star review on 2nd+ cancellation
   */
  static async cancelOrder(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;
      const { reason, reasonText } = req.body;

      console.log('❌ Cancel order request:', { orderId, reason, reasonText });

      // Validate reason is provided
      if (!reason) {
        return res.status(400).json({ 
          error: 'Cancellation reason is required',
          message: 'Please select a reason for cancellation.'
        });
      }

      // Find the order with user cancellation counts
      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: { in: ['pending', 'to_ship'] },
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
          users_orders_buyer_idTousers: {
            select: {
              id: true,
              display_name: true,
              buyer_cancellation_count: true,
            },
          },
          users_orders_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              seller_cancellation_count: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
      }

      // ✅ Check if shipping label has been created - block cancellation
      if (order.label_url) {
        return res.status(400).json({ 
          error: 'Cannot cancel order',
          message: 'This order cannot be cancelled because a shipping label has already been purchased. Please contact support if you need assistance.'
        });
      }

      const isBuyer = order.buyer_id === userId;
      
      const cancellingUser = isBuyer 
        ? order.users_orders_buyer_idTousers 
        : order.users_orders_seller_idTousers;
      
      const otherUser = isBuyer 
        ? order.users_orders_seller_idTousers 
        : order.users_orders_buyer_idTousers;

      const cancellationCount = isBuyer 
        ? (cancellingUser as any)?.buyer_cancellation_count || 0
        : (cancellingUser as any)?.seller_cancellation_count || 0;

      const listingTitle = order.listings?.title || 'Item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;
      const fullCancelReason = reasonText || reason;

      console.log(`📊 Cancellation by ${isBuyer ? 'buyer' : 'seller'}, previous count: ${cancellationCount}`);

      // Process refund via Stripe
      if (order.stripe_payment_intent_id) {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: order.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              order_id: order.id,
              reason: fullCancelReason,
              cancelled_by: isBuyer ? 'buyer' : 'seller',
            },
          });
          console.log(`💸 Refund created: ${refund.id}`);
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          // Continue with cancellation - we can process refund manually
        }
      }

      const now = new Date();

      // Update order to cancelled
      await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'cancelled',
          cancelled_at: now,
          cancel_reason: fullCancelReason,
          updated_at: now,
        },
      });

      // Relist the item
      if (order.listing_id) {
        await prisma.listings.update({
          where: { id: order.listing_id },
          data: {
            status: 'active',
            updated_at: now,
          },
        });
        console.log('📋 Item relisted:', order.listing_id);
      }

      // Increment user's cancellation count
      if (isBuyer) {
        await prisma.users.update({
          where: { id: userId },
          data: {
            buyer_cancellation_count: { increment: 1 },
            updated_at: now,
          },
        });
      } else {
        await prisma.users.update({
          where: { id: userId },
          data: {
            seller_cancellation_count: { increment: 1 },
            updated_at: now,
          },
        });
      }

      // Create automatic 1-star review if 2nd+ cancellation
      if (cancellationCount >= 1) {
        console.log('⚠️ Creating automatic 1-star review for repeated cancellation');
        
        try {
          await prisma.reviews.create({
            data: {
              id: `rev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              order_id: orderId,
              reviewer_id: otherUser?.id || 'system',
              reviewed_user_id: userId,
              rating: 1,
              review_text: `Order cancelled by ${isBuyer ? 'buyer' : 'seller'}. Reason: ${fullCancelReason}`,
              review_type: 'cancellation',
              is_public: true,
              created_at: now,
            },
          });

          // Recalculate user's average rating
          const allReviews = await prisma.reviews.findMany({
            where: { reviewed_user_id: userId },
            select: { rating: true },
          });

          if (allReviews.length > 0) {
            const avgRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
            await prisma.users.update({
              where: { id: userId },
              data: {
                rating: Math.round(avgRating * 100) / 100,
                updated_at: now,
              },
            });
          }
        } catch (reviewError: any) {
          console.error('⚠️ Failed to create cancellation review:', reviewError.message);
          // Don't fail the cancellation if review creation fails
        }
      }

      // Notify the other party
      const cancelledBy = isBuyer ? 'The buyer' : 'The seller';
      const notificationMessage = isBuyer
        ? `${cancelledBy} cancelled the order for "${listingTitle}". Your item has been relisted. Reason: ${fullCancelReason}`
        : `${cancelledBy} cancelled the order for "${listingTitle}". A refund has been processed. Reason: ${fullCancelReason}`;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: otherUser?.id || '',
          type: 'order_cancelled',
          title: 'Order Cancelled',
          message: notificationMessage,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order cancelled:', orderId);
      
      res.json({ 
        success: true, 
        message: 'Order cancelled successfully',
        reviewCreated: cancellationCount >= 1,
        newCancellationCount: cancellationCount + 1,
      });
    } catch (error: any) {
      console.error('❌ Cancel order error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  }

  /**
   * Get user's cancellation counts
   * GET /api/orders/cancellation-counts
   * 
   * Returns the current user's cancellation counts for display in the modal
   */
  static async getCancellationCounts(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          buyer_cancellation_count: true,
          seller_cancellation_count: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({
        buyer_cancellation_count: (user as any).buyer_cancellation_count || 0,
        seller_cancellation_count: (user as any).seller_cancellation_count || 0,
      });
    } catch (error: any) {
      console.error('❌ Get cancellation counts error:', error);
      res.status(500).json({ error: 'Failed to get cancellation counts' });
    }
  }

  /**
   * Open dispute (buyer only)
   * PUT /api/orders/:id/dispute
   */
  static async openDispute(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;
      const { reason } = req.body;

      console.log('⚠️ Opening dispute for order:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          buyer_id: userId,
          status: { in: ['delivered', 'in_transit'] },
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
              display_name: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be disputed' });
      }

      if (!reason) {
        return res.status(400).json({ error: 'Dispute reason is required' });
      }

      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;
      const now = new Date();

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'disputed',
          disputed_at: now,
          dispute_reason: reason,
          escrow_release_at: null, // ✅ Clear escrow release - funds held until resolved
          updated_at: now,
        },
      });

      // Notify seller
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.seller_id,
          type: 'dispute',
          title: 'Dispute Opened',
          message: `A dispute has been opened for "${listingTitle}". Reason: ${reason}. Payment is on hold until resolved.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Dispute opened:', orderId);
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Open dispute error:', error);
      res.status(500).json({ error: 'Failed to open dispute' });
    }
  }

  /**
   * Complete order (manual - admin use or after escrow period)
   * PUT /api/orders/:id/complete
   * ✅ UPDATED: Now actually transfers funds via Stripe
   */
  static async completeOrder(req: Request, res: Response) {
    try {
      const orderId = req.params.id;

      console.log('🎉 Completing order:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          status: 'delivered',
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

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be completed' });
      }

      const seller = order.users_orders_seller_idTousers;
      const sellerPayout = order.seller_payout || calculateSellerPayout(parseFloat(order.amount.toString()));
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      // ✅ Transfer funds to seller
      if (seller.stripe_connect_id && sellerPayout) {
        const transferAmount = Math.round(parseFloat(sellerPayout.toString()) * 100);

        try {
          const transfer = await stripe.transfers.create({
            amount: transferAmount,
            currency: 'gbp',
            destination: seller.stripe_connect_id,
            metadata: {
              order_id: order.id,
              type: 'order_completed',
            },
          });

          console.log(`💸 Transfer ${transfer.id} created for £${(transferAmount / 100).toFixed(2)}`);
        } catch (transferError: any) {
          console.error('⚠️ Transfer failed:', transferError.message);
          return res.status(500).json({ error: 'Failed to transfer funds to seller' });
        }
      }

      const now = new Date();

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'completed',
          completed_at: now,
          seller_payout: sellerPayout,
          updated_at: now,
        },
      });

      // Update seller's total_sales
      await prisma.users.update({
        where: { id: seller.id },
        data: {
          total_sales: { increment: 1 },
          updated_at: now,
        },
      });

      // Notify seller
      const payoutAmount = parseFloat(sellerPayout.toString()).toFixed(2);

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: seller.id,
          type: 'payout',
          title: 'Payment Released! 💰',
          message: `£${payoutAmount} for "${listingTitle}" has been transferred to your account.`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order completed:', orderId);
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Complete order error:', error);
      res.status(500).json({ error: 'Failed to complete order' });
    }
  }
}