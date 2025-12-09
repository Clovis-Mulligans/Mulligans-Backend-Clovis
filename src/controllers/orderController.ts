// src/controllers/orderController.ts
// ✅ UPDATED: Added buyer_viewed_at tracking for purchase notifications
// ✅ UPDATED: Added is_new flags to purchases and sales
// ✅ UPDATED: Creates notifications when order is shipped/delivered
// ✅ UPDATED: Sends shipping notification email

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { sendShippingNotification } from '../services/emailService';

const prisma = new PrismaClient();

// Fee calculation - matches your pricing structure
const calculateSellerPayout = (totalAmount: number): number => {
  // Buyer pays: item price + 7% + £0.99
  // So we reverse: seller_payout = total / 1.07 - (0.99 / 1.07)
  // Simplified: seller gets the original listing price
  const platformFeePercent = 0.07;
  const platformFeeFixed = 0.99;
  const sellerPayout = (totalAmount - platformFeeFixed) / (1 + platformFeePercent);
  return Math.round(sellerPayout * 100) / 100; // Round to 2 decimal places
};

export class OrderController {
  /**
   * Get order counts for badges (pending sales + new purchases)
   * GET /api/orders/counts
   * ✅ UPDATED: new_purchases only counts orders buyer hasn't viewed
   */
  static async getOrderCounts(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Count orders where user is seller and status is 'to_ship' (needs action)
      // This clears when seller ships the item
      const pendingSales = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: {
            in: ['to_ship', 'paid'],
          },
        },
      });

      // ✅ UPDATED: Count purchases that buyer HASN'T viewed yet
      // This clears when buyer clicks on the order
      const newPurchases = await prisma.orders.count({
        where: {
          buyer_id: userId,
          status: {
            in: ['to_ship', 'in_transit'],
          },
          buyer_viewed_at: null, // ✅ Only count unviewed
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
   * ✅ NEW: Mark order as viewed by buyer
   * PUT /api/orders/:id/viewed
   * Clears the "new purchase" notification for this order
   */
  static async markAsViewed(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;

      console.log('👁️ Marking order as viewed:', orderId, 'by user:', userId);

      // Verify buyer owns this order
      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          buyer_id: userId,
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // If already viewed, return success (idempotent)
      if (order.buyer_viewed_at) {
        console.log('✅ Order already viewed:', orderId);
        return res.json({ success: true, already_viewed: true });
      }

      // Mark as viewed
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
   * ✅ UPDATED: Now returns is_new flag for highlighting
   */
  static async getMyPurchases(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;

      console.log('📦 Fetching purchases for user:', userId, 'status:', status);

      // Build status filter
      let statusFilter: any = {};
      if (status && status !== 'all') {
        if (status === 'in_progress') {
          // In Progress = to_ship, in_transit, delivered (not yet completed)
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
        seller_id: order.seller_id,
        seller_name: order.users_orders_seller_idTousers?.display_name || 'Unknown',
        seller_avatar: order.users_orders_seller_idTousers?.avatar_url || null,
        status: order.status,
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        has_reviewed: order.reviews.length > 0,
        // ✅ NEW: Flag for highlighting new/unviewed purchases
        is_new: order.buyer_viewed_at === null && ['to_ship', 'in_transit'].includes(order.status),
      }));

      console.log(`✅ Found ${formattedOrders.length} purchases`);
      
      // Log how many are new
      const newCount = formattedOrders.filter(o => o.is_new).length;
      console.log(`🆕 New (unviewed) purchases: ${newCount}`);

      res.json({ orders: formattedOrders });
    } catch (error: any) {
      console.error('❌ Get purchases error:', error);
      res.status(500).json({ error: 'Failed to get purchases' });
    }
  }

  /**
   * Get user's sales (orders where they are the seller)
   * GET /api/orders/my-sales?status=to_ship
   * ✅ UPDATED: Now returns is_new flag for highlighting
   */
  static async getMySales(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;

      console.log('💰 Fetching sales for user:', userId, 'status:', status);

      // Build status filter
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
        buyer_id: order.buyer_id,
        buyer_name: order.users_orders_buyer_idTousers?.display_name || 'Unknown',
        buyer_avatar: order.users_orders_buyer_idTousers?.avatar_url || null,
        status: order.status,
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        shipping_address: order.shipping_address,
        // ✅ NEW: Flag for highlighting - sales need action until shipped
        is_new: order.status === 'to_ship',
      }));

      console.log(`✅ Found ${formattedOrders.length} sales`);
      
      // Log how many need shipping
      const needsShipping = formattedOrders.filter(o => o.is_new).length;
      console.log(`📦 Sales needing shipment: ${needsShipping}`);

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
        shipping_cost: order.shipping_cost ? parseFloat(order.shipping_cost.toString()) : 0,  // ✅ ADDED
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
        tracking_number: order.tracking_number,
        carrier: order.carrier,
        shipping_address: isSeller ? order.shipping_address : null, // Only show to seller
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
   * ✅ UPDATED: Now creates notification for buyer AND sends shipping email
   */
  static async markAsShipped(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;
      const { tracking_number, carrier } = req.body;

      console.log('📦 Marking order as shipped:', orderId);

      // Verify seller owns this order and get buyer email
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
          tracking_number: tracking_number || null,
          carrier: carrier || null,
          shipped_at: new Date(),
          updated_at: new Date(),
        },
      });

      // ✅ Create notification for buyer
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.buyer_id,
          type: 'shipped',
          title: 'Your item has shipped! 📦',
          message: tracking_number 
            ? `"${listingTitle}" is on its way! Tracking: ${tracking_number}`
            : `"${listingTitle}" is on its way to you!`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order marked as shipped:', orderId);
      console.log('📬 Shipped notification sent to buyer:', order.buyer_id);

      // ✅ Send shipping notification email
      const buyerEmail = order.users_orders_buyer_idTousers?.email;
      if (buyerEmail) {
        try {
          await sendShippingNotification(buyerEmail, {
            buyerName: order.users_orders_buyer_idTousers?.display_name || 'there',
            itemName: listingTitle,
            trackingNumber: tracking_number || undefined,
            carrier: carrier || undefined,
            orderId: orderId,
          });
          console.log('📧 Shipping notification email sent to:', buyerEmail);
        } catch (emailError) {
          console.error('⚠️ Failed to send shipping email:', emailError);
          // Don't fail the request if email fails
        }
      }
      
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Mark shipped error:', error);
      res.status(500).json({ error: 'Failed to mark order as shipped' });
    }
  }

  /**
   * Mark order as delivered (can be triggered by carrier webhook or manually)
   * PUT /api/orders/:id/deliver
   * ✅ UPDATED: Now creates notification for buyer
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

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'delivered',
          delivered_at: new Date(),
          updated_at: new Date(),
        },
      });

      // ✅ Create notification for buyer
      const listingTitle = order.listings?.title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || null;

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.buyer_id,
          type: 'delivered',
          title: 'Item delivered! 🎉',
          message: `"${listingTitle}" has been delivered. Enjoy your purchase!`,
          image_url: listingImage,
          related_id: orderId,
        },
      });

      console.log('✅ Order marked as delivered:', orderId);
      console.log('📬 Delivered notification sent to buyer:', order.buyer_id);
      
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Mark delivered error:', error);
      res.status(500).json({ error: 'Failed to mark order as delivered' });
    }
  }

  /**
   * Cancel order
   * PUT /api/orders/:id/cancel
   */
  static async cancelOrder(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.id;
      const { reason } = req.body;

      console.log('❌ Cancelling order:', orderId);

      const order = await prisma.orders.findFirst({
        where: {
          id: orderId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: { in: ['pending', 'to_ship'] }, // Can only cancel before shipping
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
      }

      const isBuyer = order.buyer_id === userId;
      const cancelReason = isBuyer ? 'buyer_cancelled' : 'seller_cancelled';

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'cancelled',
          cancelled_at: new Date(),
          cancel_reason: reason || cancelReason,
          updated_at: new Date(),
        },
      });

      // TODO: Process refund via Stripe
      // TODO: Relist item if seller cancelled
      // TODO: Send notifications

      console.log('✅ Order cancelled:', orderId);
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Cancel order error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
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
          status: { in: ['delivered', 'in_transit'] }, // Can dispute after shipped
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be disputed' });
      }

      if (!reason) {
        return res.status(400).json({ error: 'Dispute reason is required' });
      }

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'disputed',
          disputed_at: new Date(),
          dispute_reason: reason,
          updated_at: new Date(),
        },
      });

      // TODO: Notify seller
      // TODO: Notify admin/support
      // TODO: Hold payment release

      console.log('✅ Dispute opened:', orderId);
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Open dispute error:', error);
      res.status(500).json({ error: 'Failed to open dispute' });
    }
  }

  /**
   * Complete order (after escrow period)
   * PUT /api/orders/:id/complete
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
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be completed' });
      }

      // Calculate seller payout if not already set
      const sellerPayout = order.seller_payout || calculateSellerPayout(parseFloat(order.amount.toString()));

      const updatedOrder = await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'completed',
          completed_at: new Date(),
          seller_payout: sellerPayout,
          updated_at: new Date(),
        },
      });

      // TODO: Release payment to seller via Stripe Connect
      // TODO: Update seller's balance
      // TODO: Send notifications

      console.log('✅ Order completed:', orderId);
      res.json({ success: true, order: updatedOrder });
    } catch (error: any) {
      console.error('❌ Complete order error:', error);
      res.status(500).json({ error: 'Failed to complete order' });
    }
  }
}