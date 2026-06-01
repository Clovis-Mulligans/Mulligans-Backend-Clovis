// src/controllers/disputeController.ts
// ✅ COMPLETE DISPUTE SYSTEM WITH ESCROW PAYOUTS
// - Buyer opens dispute with photos + refund request
// - Seller responds (accept/counter/reject)
// - Buyer reviews counter-offer
// - 72-hour deadline with auto-escalation
// - Admin resolution
// - Email notifications (with branded templates)
// - ✅ SELLER PAYOUT: Transfers remaining funds to seller after partial/no refund
// - ✅ PUSH NOTIFICATIONS: All parties notified via push

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import Stripe from 'stripe';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import {
  sendDisputeOpenedToSeller,
  sendDisputeOpenedToBuyer,
  sendDisputeResponseToBuyer,
  sendDisputeEscalatedToAdmin,
  sendDisputeEscalatedToBuyer,
  sendDisputeResolved,
} from '../services/emailService';
import { sendPushNotification } from './pushNotificationController';
import { ESCROW_RELEASE_DAYS } from '../config/constants';
import { calculateSellerPayout as calcPayout, BUYER_PROTECTION_RATE, SERVICE_FEE_PER_ITEM } from '../lib/feeCalculations';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// S3 Configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'mulligans-golf-images-mvp';

// ============================================
// CONSTANTS
// ============================================
const SELLER_RESPONSE_DEADLINE_HOURS = 72;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@mulligans.uk.com';

// ✅ Buyer Protection Fee: 7.5% + £0.99
const PLATFORM_FEE_PERCENT = 0.075;
const PLATFORM_FEE_FIXED = 0.99;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Upload dispute image to S3
 */
async function uploadDisputeImage(
  base64Data: string,
  disputeId: string,
  uploadedBy: string
): Promise<{ imageUrl: string; s3Key: string }> {
  // Remove data URL prefix if present
  const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Image, 'base64');

  // Determine file extension from base64 header
  let extension = 'jpg';
  if (base64Data.includes('data:image/png')) extension = 'png';
  else if (base64Data.includes('data:image/webp')) extension = 'webp';

  const s3Key = `disputes/${disputeId}/${uploadedBy}/${uuidv4()}.${extension}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: `image/${extension}`,
    })
  );

  const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const imageUrl = CLOUDFRONT_DOMAIN
  ? `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
  : `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'eu-west-2'}.amazonaws.com/${s3Key}`;

  return { imageUrl, s3Key };
}

/**
 * ✅ CRITICAL: Transfer remaining funds to seller after dispute resolution
 * 
 * This handles the scenario where buyer gets partial/no refund and seller
 * needs to receive their portion of the payment.
 * 
 * @param orderId - The order ID
 * @param refundAmount - Amount refunded to buyer (0 if no refund)
 * @param disputeId - For logging/metadata
 * @returns Object with success status and details
 */
async function transferSellerPayout(
  orderId: string,
  refundAmount: number,
  disputeId: string
): Promise<{ success: boolean; transferId?: string; amount?: number; error?: string }> {
  console.log(`💰 Processing seller payout for order ${orderId} after dispute ${disputeId}`);
  console.log(`   Refund amount: £${refundAmount.toFixed(2)}`);

  try {
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        users_orders_seller_idTousers: {
          select: {
            id: true,
            stripe_connect_id: true,
            stripe_connect_status: true,
            display_name: true,
            email: true,
          },
        },
      },
    });

    if (!order) {
      console.error('❌ Order not found:', orderId);
      return { success: false, error: 'Order not found' };
    }

    // Short-circuit: already transferred
    if (order.stripe_transfer_id) {
      console.log(`   Order already has transfer ${order.stripe_transfer_id} — skipping`);
      return { success: true, transferId: order.stripe_transfer_id, amount: 0 };
    }

    const seller = order.users_orders_seller_idTousers;
    const orderAmount = parseFloat(order.amount.toString());
    const sellerPayout = order.seller_payout ? parseFloat(order.seller_payout.toString()) : null;

    let sellerReceives: number;

    if (sellerPayout !== null) {
      const refundPercent = orderAmount > 0 ? refundAmount / orderAmount : 0;
      sellerReceives = sellerPayout * (1 - refundPercent);
    } else {
      // B5 fix: use the centralised fee module for the fallback
      const payoutResult = calcPayout(orderAmount, 1, 0, true, 0);
      const refundPercent = orderAmount > 0 ? refundAmount / orderAmount : 0;
      sellerReceives = payoutResult.total * (1 - refundPercent);
    }

    sellerReceives = Math.round(sellerReceives * 100) / 100;

    console.log(`   Order amount: £${orderAmount.toFixed(2)}`);
    console.log(`   Seller payout (stored): £${sellerPayout?.toFixed(2) || 'N/A'}`);
    console.log(`   Seller receives after dispute: £${sellerReceives.toFixed(2)}`);

    if (sellerReceives <= 0) {
      console.log('   Seller receives £0 - no transfer needed');
      return { success: true, amount: 0 };
    }

    if (!seller.stripe_connect_id) {
      console.error('❌ Seller has no Stripe Connect account:', seller.id);

      await prisma.notifications.create({
        data: {
          id: crypto.randomUUID(),
          user_id: seller.id,
          type: 'payout_pending',
          title: '💰 Payment Pending - Action Required',
          message: `You have £${sellerReceives.toFixed(2)} waiting from a resolved dispute. Please add your bank details in Profile to receive payment.`,
          related_id: orderId,
        },
      });

      try {
        await sendPushNotification(
          seller.id,
          'Payment Pending - Action Required',
          `You have £${sellerReceives.toFixed(2)} waiting. Add bank details to receive payment.`,
          { type: 'payout_pending', order_id: orderId, is_buyer: false }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      return {
        success: false,
        error: 'Seller has no Connect account - notified to set up',
        amount: sellerReceives,
      };
    }

    if (seller.stripe_connect_status !== 'active') {
      console.warn('⚠️ Seller Connect account not fully verified:', seller.stripe_connect_status);
    }

    const transferAmountPence = Math.round(sellerReceives * 100);
    const idempotencyKey = `dispute_transfer_${disputeId}`;

    const transfer = await stripe.transfers.create({
      amount: transferAmountPence,
      currency: 'gbp',
      destination: seller.stripe_connect_id,
      metadata: {
        order_id: orderId,
        dispute_id: disputeId,
        type: 'dispute_resolution_payout',
        original_order_amount: orderAmount.toFixed(2),
        refund_amount: refundAmount.toFixed(2),
        seller_receives: sellerReceives.toFixed(2),
      },
    }, { idempotencyKey });

    // Persist transfer ID atomically
    await prisma.orders.update({
      where: { id: orderId },
      data: { stripe_transfer_id: transfer.id },
    });

    console.log(`✅ Transfer created: ${transfer.id} for £${sellerReceives.toFixed(2)}`);

    await prisma.notifications.create({
      data: {
        id: crypto.randomUUID(),
        user_id: seller.id,
        type: 'payout',
        title: '💰 Payment Released',
        message: `£${sellerReceives.toFixed(2)} has been transferred to your account following the dispute resolution.`,
        related_id: orderId,
      },
    });

    try {
      await sendPushNotification(
        seller.id,
        'Payment Released',
        `£${sellerReceives.toFixed(2)} from dispute resolution has been transferred.`,
        { type: 'payout_released', order_id: orderId, is_buyer: false }
      );
    } catch (pushErr) {
      console.error('[DISPUTE] Push notification failed:', pushErr);
    }

    return {
      success: true,
      transferId: transfer.id,
      amount: sellerReceives,
    };

  } catch (error: any) {
    console.error('❌ Transfer failed:', error.message);
    console.error('TRANSFER_FAILED', { orderId, disputeId, refundAmount, error: error.message });
    return { success: false, error: error.message };
  }
}

// ============================================
// DISPUTE CONTROLLER
// ============================================

export class DisputeController {
  /**
   * Open a new dispute (buyer only)
   * POST /api/disputes
   * 
   * Body: {
   *   orderId: string,
   *   reasonType: string,
   *   reasonText: string,
   *   requestedRefundPercent: number,
   *   images: string[] (base64)
   * }
   */
  static async openDispute(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { orderId, reasonType, reasonText, requestedRefundPercent, images } = req.body;

      console.log('⚠️ Opening dispute for order:', orderId);

      // Validate required fields
      if (!orderId || !reasonType || !reasonText || !requestedRefundPercent) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate refund percentage
      if (requestedRefundPercent < 10 || requestedRefundPercent > 100 || requestedRefundPercent % 10 !== 0) {
        return res.status(400).json({ error: 'Invalid refund percentage. Must be 10, 20, 30, 40, 50, 60, 70, 80, 90, or 100' });
      }

      // Find the order
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
              price: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
          users_orders_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
          users_orders_buyer_idTousers: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be disputed' });
      }

      // ✅ Check if within escrow period (3 days from delivery)
      if (order.status === 'delivered' && order.delivered_at) {
        const deliveredAt = new Date(order.delivered_at);
        const escrowDeadline = new Date(deliveredAt.getTime() + ESCROW_RELEASE_DAYS * 24 * 60 * 60 * 1000);
        const now = new Date();
        
        if (now > escrowDeadline) {
          return res.status(400).json({ 
            error: 'Dispute window has closed',
            message: `You can only open a dispute within ${ESCROW_RELEASE_DAYS} days of delivery. The deadline was ${escrowDeadline.toLocaleDateString('en-GB')}.`
          });
        }
      }

      // Check if dispute already exists
      const existingDispute = await prisma.disputes.findUnique({
        where: { order_id: orderId },
      });

      if (existingDispute) {
        return res.status(400).json({ error: 'A dispute has already been opened for this order' });
      }

      // Calculate refund amount
      const orderAmount = parseFloat(order.amount.toString());
      const requestedRefundAmount = (orderAmount * requestedRefundPercent) / 100;

      // Calculate seller deadline (72 hours from now)
      const sellerDeadline = new Date();
      sellerDeadline.setHours(sellerDeadline.getHours() + SELLER_RESPONSE_DEADLINE_HOURS);

      const disputeId = uuidv4();
      const now = new Date();

      // Create the dispute
      const dispute = await prisma.disputes.create({
        data: {
          id: disputeId,
          order_id: orderId,
          buyer_id: userId,
          seller_id: order.seller_id,
          status: 'open',
          reason_type: reasonType,
          reason_text: reasonText,
          requested_refund_percent: requestedRefundPercent,
          requested_refund_amount: requestedRefundAmount,
          seller_deadline: sellerDeadline,
          created_at: now,
          updated_at: now,
        },
      });

      // Upload images if provided
      if (images && images.length > 0) {
        const uploadPromises = images.slice(0, 5).map(async (base64Image: string) => {
          const { imageUrl, s3Key } = await uploadDisputeImage(base64Image, disputeId, 'buyer');
          return prisma.dispute_images.create({
            data: {
              id: uuidv4(),
              dispute_id: disputeId,
              image_url: imageUrl,
              s3_key: s3Key,
              uploaded_by: 'buyer',
              created_at: now,
            },
          });
        });
        await Promise.all(uploadPromises);
        console.log(`📷 Uploaded ${images.length} dispute images`);
      }

      // Update order status - HOLD escrow release
      await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'disputed',
          disputed_at: now,
          dispute_reason: `${reasonType}: ${reasonText}`,
          escrow_release_at: null, // ✅ CRITICAL: Prevent auto-release
          updated_at: now,
        },
      });

      // Get listing info for notifications
      const listingTitle = order.listings?.title || (order as any).listing_title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || (order as any).listing_image || null;
      const seller = order.users_orders_seller_idTousers;
      const buyer = order.users_orders_buyer_idTousers;

      // Create notification for seller
      const disputeOpenedSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: disputeOpenedSellerNotifId,
          user_id: order.seller_id,
          type: 'dispute',
          title: '⚠️ Dispute Opened',
          message: `A buyer has opened a dispute for "${listingTitle}". You have 72 hours to respond. Requested: £${requestedRefundAmount.toFixed(2)} (${requestedRefundPercent}%)`,
          image_url: listingImage,
          related_id: disputeId,
        },
      });

      // ✅ PUSH: Notify seller of dispute opened
      try {
        await sendPushNotification(
          seller.id,
          'Dispute Opened - Action Required',
          `A dispute has been opened for "${listingTitle}". You have 72 hours to respond.`,
          { notification_id: disputeOpenedSellerNotifId, type: 'dispute_opened', dispute_id: disputeId, order_id: orderId, is_buyer: false }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // Send branded email to seller
      if (seller.email) {
        try {
          await sendDisputeOpenedToSeller(seller.email, {
            sellerName: seller.display_name || 'Seller',
            buyerName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: orderId.slice(-8).toUpperCase(),
            reasonType: reasonType,
            reasonText: reasonText,
            refundAmount: requestedRefundAmount.toFixed(2),
            refundPercent: requestedRefundPercent.toString(),
            deadline: sellerDeadline,
            itemImageUrl: listingImage || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(order.listings?.price?.toString() || order.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send dispute email to seller:', emailError);
        }
      }

      // Send branded email to buyer (confirmation)
      if (buyer.email) {
        try {
          await sendDisputeOpenedToBuyer(buyer.email, {
            buyerName: buyer.display_name || 'Buyer',
            sellerName: seller.display_name || 'Seller',
            itemTitle: listingTitle,
            orderNumber: orderId.slice(-8).toUpperCase(),
            reasonType: reasonType,
            reasonText: reasonText,
            refundAmount: requestedRefundAmount.toFixed(2),
            refundPercent: requestedRefundPercent.toString(),
            itemImageUrl: listingImage || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(order.listings?.price?.toString() || order.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send dispute confirmation to buyer:', emailError);
        }
      }

      console.log('✅ Dispute created:', disputeId);
      res.status(201).json({ 
        success: true, 
        disputeId,
        message: 'Dispute opened successfully. The seller has 72 hours to respond.',
        dispute: {
          id: disputeId,
          status: 'open',
          requested_refund_percent: requestedRefundPercent,
          requested_refund_amount: requestedRefundAmount,
          seller_deadline: sellerDeadline.toISOString(),
        }
      });
    } catch (error: any) {
      console.error('❌ Open dispute error:', error);
      res.status(500).json({ error: 'Failed to open dispute' });
    }
  }

  /**
   * Get dispute details
   * GET /api/disputes/:id
   */
  static async getDispute(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const disputeId = req.params.id;

      const dispute = await prisma.disputes.findFirst({
        where: {
          id: disputeId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
        },
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              listing_id: true,
              listing_title: true,
              listing_image: true,
              shipping_address: true,
              tracking_number: true,
              carrier: true,
              created_at: true,
              paid_at: true,
              shipped_at: true,
              delivered_at: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              rating: true,
              total_purchases: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              rating: true,
              total_sales: true,
              is_verified_seller: true,
            },
          },
          dispute_images: {
            orderBy: { created_at: 'asc' },
          },
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found' });
      }

      // Check if user is buyer or seller
      const isBuyer = dispute.buyer_id === userId;

      // Calculate time remaining for seller response
      let timeRemaining = null;
      if (dispute.status === 'open' && dispute.seller_deadline) {
        const now = new Date();
        const deadline = new Date(dispute.seller_deadline);
        const msRemaining = deadline.getTime() - now.getTime();
        if (msRemaining > 0) {
          const hoursRemaining = Math.floor(msRemaining / (1000 * 60 * 60));
          const minutesRemaining = Math.floor((msRemaining % (1000 * 60 * 60)) / (1000 * 60));
          timeRemaining = { hours: hoursRemaining, minutes: minutesRemaining };
        }
      }

      res.json({
        dispute: {
          id: dispute.id,
          order_id: dispute.order_id,
          status: dispute.status,
          
          // Buyer's claim
          reason_type: dispute.reason_type,
          reason_text: dispute.reason_text,
          requested_refund_percent: dispute.requested_refund_percent,
          requested_refund_amount: parseFloat(dispute.requested_refund_amount.toString()),
          
          // Seller's response
          seller_response_type: dispute.seller_response_type,
          counter_offer_percent: dispute.counter_offer_percent,
          counter_offer_amount: dispute.counter_offer_amount ? parseFloat(dispute.counter_offer_amount.toString()) : null,
          seller_response_text: dispute.seller_response_text,
          seller_responded_at: dispute.seller_responded_at?.toISOString() || null,
          
          // Resolution
          resolution_type: dispute.resolution_type,
          resolution_amount: dispute.resolution_amount ? parseFloat(dispute.resolution_amount.toString()) : null,
          resolution_notes: dispute.resolution_notes,
          resolved_by: dispute.resolved_by,
          resolved_at: dispute.resolved_at?.toISOString() || null,
          
          // Deadline
          seller_deadline: dispute.seller_deadline.toISOString(),
          time_remaining: timeRemaining,
          auto_escalated: dispute.auto_escalated,
          
          // Timestamps
          created_at: dispute.created_at.toISOString(),
          updated_at: dispute.updated_at.toISOString(),
          
          // Order info
          order: {
            id: dispute.orders.id,
            amount: parseFloat(dispute.orders.amount.toString()),
            listing_title: dispute.orders.listing_title,
            listing_image: dispute.orders.listing_image,
            tracking_number: dispute.orders.tracking_number,
            carrier: dispute.orders.carrier,
            shipped_at: dispute.orders.shipped_at?.toISOString() || null,
            delivered_at: dispute.orders.delivered_at?.toISOString() || null,
          },
          
          // Users
          buyer: {
            id: dispute.users_disputes_buyer.id,
            display_name: dispute.users_disputes_buyer.display_name,
            avatar_url: dispute.users_disputes_buyer.avatar_url,
            rating: parseFloat(dispute.users_disputes_buyer.rating?.toString() || '0'),
            total_purchases: dispute.users_disputes_buyer.total_purchases,
          },
          seller: {
            id: dispute.users_disputes_seller.id,
            display_name: dispute.users_disputes_seller.display_name,
            avatar_url: dispute.users_disputes_seller.avatar_url,
            rating: parseFloat(dispute.users_disputes_seller.rating?.toString() || '0'),
            total_sales: dispute.users_disputes_seller.total_sales,
            is_verified_seller: dispute.users_disputes_seller.is_verified_seller,
          },
          
          // Images
          buyer_images: dispute.dispute_images.filter(img => img.uploaded_by === 'buyer').map(img => ({
            id: img.id,
            image_url: img.image_url,
            created_at: img.created_at.toISOString(),
          })),
          seller_images: dispute.dispute_images.filter(img => img.uploaded_by === 'seller').map(img => ({
            id: img.id,
            image_url: img.image_url,
            created_at: img.created_at.toISOString(),
          })),
          
          // User context
          is_buyer: isBuyer,
          is_seller: !isBuyer,
          can_respond: !isBuyer && dispute.status === 'open',
          can_accept_counter: isBuyer && dispute.status === 'counter_offered',
          can_escalate: isBuyer && dispute.status === 'counter_offered',
        },
      });
    } catch (error: any) {
      console.error('❌ Get dispute error:', error);
      res.status(500).json({ error: 'Failed to get dispute' });
    }
  }

  /**
   * Get dispute by order ID
   * GET /api/disputes/order/:orderId
   */
  static async getDisputeByOrder(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const orderId = req.params.orderId;

      const dispute = await prisma.disputes.findFirst({
        where: {
          order_id: orderId,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'No dispute found for this order' });
      }

      // Redirect to full dispute endpoint
      req.params.id = dispute.id;
      return DisputeController.getDispute(req, res);
    } catch (error: any) {
      console.error('❌ Get dispute by order error:', error);
      res.status(500).json({ error: 'Failed to get dispute' });
    }
  }

  /**
   * Seller responds to dispute
   * PUT /api/disputes/:id/respond
   * 
   * Body: {
   *   responseType: 'accept' | 'counter' | 'reject',
   *   counterOfferPercent?: number,
   *   responseText?: string,
   *   images?: string[] (base64)
   * }
   * 
   * ✅ ESCROW: If seller accepts partial refund, remaining funds transferred to seller
   */
  static async respondToDispute(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const disputeId = req.params.id;
      const { responseType, counterOfferPercent, responseText, images } = req.body;

      console.log('💬 Seller responding to dispute:', disputeId);

      // Validate response type
      if (!['accept', 'counter', 'reject'].includes(responseType)) {
        return res.status(400).json({ error: 'Invalid response type. Must be: accept, counter, or reject' });
      }

      // Row-lock the dispute to prevent concurrent resolution
      const dispute = await prisma.$transaction(async (tx) => {
        const rows: any[] = await tx.$queryRaw`
          SELECT id FROM disputes WHERE id = ${disputeId} AND seller_id = ${userId} AND status = 'open' FOR UPDATE`;
        if (rows.length === 0) return null;
        return tx.disputes.findFirst({
          where: { id: disputeId, seller_id: userId, status: 'open' },
          include: {
            orders: {
              select: {
                id: true, amount: true, seller_payout: true,
                listing_title: true, listing_image: true, stripe_payment_intent_id: true,
              },
            },
            users_disputes_buyer: { select: { id: true, display_name: true, email: true } },
            users_disputes_seller: { select: { id: true, display_name: true, email: true } },
          },
        });
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found or you cannot respond to it' });
      }

      if (new Date() > dispute.seller_deadline) {
        return res.status(400).json({ error: 'Response deadline has passed. This dispute has been escalated.' });
      }

      const orderAmount = parseFloat(dispute.orders.amount.toString());
      const now = new Date();
      let newStatus = 'open';
      let counterOfferAmount = null;
      let resolutionType = null;
      let resolutionAmount = null;

      // Handle different response types
      if (responseType === 'accept') {
        // Seller accepts buyer's request
        newStatus = 'seller_accepted';
        resolutionType = dispute.requested_refund_percent === 100 ? 'full_refund' : 'partial_refund';
        resolutionAmount = parseFloat(dispute.requested_refund_amount.toString());
      } else if (responseType === 'counter') {
        // Seller makes counter-offer
        if (!counterOfferPercent || counterOfferPercent < 10 || counterOfferPercent > 100 || counterOfferPercent % 10 !== 0) {
          return res.status(400).json({ error: 'Invalid counter proposal percentage' });
        }
        newStatus = 'counter_offered';
        counterOfferAmount = (orderAmount * counterOfferPercent) / 100;
      } else if (responseType === 'reject') {
        // Seller rejects - escalate to admin
        newStatus = 'escalated';
        if (!responseText || responseText.length < 20) {
          return res.status(400).json({ error: 'Please provide at least 20 characters explaining why you reject this claim' });
        }
      }

      // Upload seller images if provided
      if (images && images.length > 0) {
        const uploadPromises = images.slice(0, 5).map(async (base64Image: string) => {
          const { imageUrl, s3Key } = await uploadDisputeImage(base64Image, disputeId, 'seller');
          return prisma.dispute_images.create({
            data: {
              id: uuidv4(),
              dispute_id: disputeId,
              image_url: imageUrl,
              s3_key: s3Key,
              uploaded_by: 'seller',
              created_at: now,
            },
          });
        });
        await Promise.all(uploadPromises);
        console.log(`📷 Uploaded ${images.length} seller images`);
      }

      // Update dispute
      await prisma.disputes.update({
        where: { id: disputeId },
        data: {
          status: newStatus,
          seller_response_type: responseType,
          counter_offer_percent: counterOfferPercent || null,
          counter_offer_amount: counterOfferAmount,
          seller_response_text: responseText || null,
          seller_responded_at: now,
          resolution_type: resolutionType,
          resolution_amount: resolutionAmount,
          resolved_by: responseType === 'accept' ? 'seller' : null,
          resolved_at: responseType === 'accept' ? now : null,
          updated_at: now,
        },
      });

      const buyer = dispute.users_disputes_buyer;
      const seller = dispute.users_disputes_seller;
      const listingTitle = dispute.orders.listing_title || 'Your item';
      const listingImage = dispute.orders.listing_image;

      // If seller accepted, process the refund AND transfer remaining to seller
      if (responseType === 'accept' && resolutionAmount !== null && dispute.orders.stripe_payment_intent_id) {
        const refundAmountPence = Math.round(resolutionAmount * 100);

        try {
          const refund = await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmountPence,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'seller_accepted',
            },
          }, { idempotencyKey: `dispute_refund_${disputeId}` });
          console.log(`💸 Refund processed: £${resolutionAmount.toFixed(2)} (${refund.id})`);

          // Persist refund ID + update order in one write
          await prisma.orders.update({
            where: { id: dispute.order_id },
            data: {
              stripe_refund_id: refund.id,
              status: dispute.requested_refund_percent === 100 ? 'refunded' : 'completed',
              updated_at: now,
            },
          });

          // Transfer remaining to seller (skip at 100% — nothing left)
          if (dispute.requested_refund_percent < 100) {
            const transferResult = await transferSellerPayout(
              dispute.order_id,
              resolutionAmount,
              disputeId
            );

            if (transferResult.success) {
              console.log(`💰 Seller payout transferred: £${transferResult.amount?.toFixed(2)}`);
            } else {
              console.error('⚠️ Seller payout transfer failed:', transferResult.error);
            }
          }
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
        }
      }

      // Notify buyer
      let notificationTitle = '';
      let notificationMessage = '';

      if (responseType === 'accept') {
        notificationTitle = '✅ Dispute Resolved';
        notificationMessage = `The seller has accepted your request. £${resolutionAmount?.toFixed(2)} will be refunded to your account.`;
      } else if (responseType === 'counter') {
        notificationTitle = '💬 Counter Offer Received';
        notificationMessage = `The seller has made a counter proposal of £${counterOfferAmount?.toFixed(2)} (${counterOfferPercent}%) for "${listingTitle}". Please review and respond.`;
      } else if (responseType === 'reject') {
        notificationTitle = '⚠️ Dispute Escalated';
        notificationMessage = `The seller has rejected your claim for "${listingTitle}". Mulligans will now review and make a decision.`;
      }

      const sellerRespondedNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: sellerRespondedNotifId,
          user_id: buyer.id,
          type: 'dispute_update',
          title: notificationTitle,
          message: notificationMessage,
          image_url: listingImage,
          related_id: disputeId,
        },
      });

      // ✅ PUSH: Notify buyer of seller response
      try {
        await sendPushNotification(
          buyer.id,
          notificationTitle,
          notificationMessage,
          { notification_id: sellerRespondedNotifId, type: 'dispute_opened', dispute_id: disputeId, order_id: dispute.order_id, is_buyer: true }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // Send branded email to buyer
      if (buyer.email && (responseType === 'counter' || responseType === 'reject')) {
        try {
          await sendDisputeResponseToBuyer(buyer.email, {
            buyerName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            isCounterOffer: responseType === 'counter',
            counterOfferAmount: counterOfferAmount?.toFixed(2),
            sellerMessage: responseText || 'No message provided',
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send dispute response email to buyer:', emailError);
        }
      }

      // If seller accepted, send resolution email
      if (responseType === 'accept' && buyer.email) {
        try {
          await sendDisputeResolved(buyer.email, {
            userName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            resolutionType: dispute.requested_refund_percent === 100 ? 'full_refund' : 'partial_refund',
            refundAmount: resolutionAmount?.toFixed(2),
            adminNotes: 'The seller accepted your refund request.',
            isBuyer: true,
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send resolution email to buyer:', emailError);
        }
      }

      // If escalated (rejected), notify admin
      if (responseType === 'reject') {
        try {
          await sendDisputeEscalatedToAdmin({
            disputeId: disputeId,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            itemTitle: listingTitle,
            refundAmount: parseFloat(dispute.requested_refund_amount.toString()).toFixed(2),
            buyerName: buyer.display_name || 'Buyer',
            buyerEmail: buyer.email || '',
            sellerName: seller.display_name || 'Seller',
            sellerEmail: seller.email || '',
            reasonType: dispute.reason_type,
            escalationReason: 'Seller rejected the buyer\'s claim',
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send escalation email to admin:', emailError);
        }
      }

      console.log('✅ Seller response recorded:', disputeId);
      res.json({ 
        success: true, 
        status: newStatus,
        message: responseType === 'accept' 
          ? 'You have accepted the buyer\'s request. A refund has been processed.'
          : responseType === 'counter'
          ? 'Your counter proposal has been sent to the buyer.'
          : 'Your response has been recorded. Mulligans will review and make a decision.',
      });
    } catch (error: any) {
      console.error('❌ Respond to dispute error:', error);
      res.status(500).json({ error: 'Failed to respond to dispute' });
    }
  }

  /**
   * Buyer accepts counter proposal
   * PUT /api/disputes/:id/accept-counter
   * 
   * ✅ ESCROW: Refunds counter amount to buyer, transfers remaining to seller
   */
  static async acceptCounterOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const disputeId = req.params.id;

      console.log('✅ Buyer accepting counter proposal:', disputeId);

      // Row-lock the dispute to prevent concurrent resolution
      const dispute = await prisma.$transaction(async (tx) => {
        const rows: any[] = await tx.$queryRaw`
          SELECT id FROM disputes WHERE id = ${disputeId} AND buyer_id = ${userId} AND status = 'counter_offered' FOR UPDATE`;
        if (rows.length === 0) return null;
        return tx.disputes.findFirst({
          where: { id: disputeId, buyer_id: userId, status: 'counter_offered' },
          include: {
            orders: {
              select: {
                id: true, amount: true, seller_payout: true,
                stripe_payment_intent_id: true, listing_title: true, listing_image: true,
              },
            },
            users_disputes_buyer: { select: { id: true, display_name: true, email: true } },
            users_disputes_seller: { select: { id: true, display_name: true, email: true } },
          },
        });
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found or no counter proposal to accept' });
      }

      const counterOfferAmount = parseFloat(dispute.counter_offer_amount!.toString());
      const now = new Date();

      // 1. Process refund to buyer
      if (dispute.orders.stripe_payment_intent_id) {
        const refundAmountPence = Math.round(counterOfferAmount * 100);
        try {
          const refund = await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmountPence,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'buyer_accepted_counter',
            },
          }, { idempotencyKey: `dispute_counter_refund_${disputeId}` });
          console.log(`💸 counter proposal refund processed: £${counterOfferAmount.toFixed(2)} (${refund.id})`);

          await prisma.orders.update({
            where: { id: dispute.order_id },
            data: { stripe_refund_id: refund.id },
          });
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          return res.status(500).json({ error: 'Failed to process refund' });
        }
      }

      // 2. Transfer remaining funds to seller (skip at 100% — nothing left)
      let transferResult: { success: boolean; transferId?: string; amount?: number; error?: string } = { success: true, amount: 0 };
      if (dispute.counter_offer_percent !== 100) {
        transferResult = await transferSellerPayout(
          dispute.order_id,
          counterOfferAmount,
          disputeId
        );

        if (transferResult.success) {
          console.log(`💰 Seller payout transferred: £${transferResult.amount?.toFixed(2)}`);
        } else {
          console.error('⚠️ Seller payout transfer failed:', transferResult.error);
        }
      }

      // 3. Update dispute
      await prisma.disputes.update({
        where: { id: disputeId },
        data: {
          status: 'buyer_accepted',
          resolution_type: dispute.counter_offer_percent === 100 ? 'full_refund' : 'partial_refund',
          resolution_amount: counterOfferAmount,
          resolved_by: 'buyer',
          resolved_at: now,
          updated_at: now,
        },
      });

      // 4. Update order
      await prisma.orders.update({
        where: { id: dispute.order_id },
        data: {
          status: dispute.counter_offer_percent === 100 ? 'refunded' : 'completed',
          updated_at: now,
        },
      });

      const buyer = dispute.users_disputes_buyer;
      const seller = dispute.users_disputes_seller;
      const listingTitle = dispute.orders.listing_title || 'Your item';

      // Notify seller
      const counterAcceptedNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: counterAcceptedNotifId,
          user_id: seller.id,
          type: 'dispute_resolved',
          title: '✅ Dispute Resolved',
          message: `The buyer accepted your counter proposal of £${counterOfferAmount.toFixed(2)} for "${listingTitle}".${transferResult.success ? ` £${transferResult.amount?.toFixed(2)} has been transferred to your account.` : ''}`,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // ✅ PUSH: Notify seller of resolution
      try {
        await sendPushNotification(
          seller.id,
          'Dispute Resolved',
          `The buyer accepted your counter proposal for "${listingTitle}".`,
          { notification_id: counterAcceptedNotifId, type: 'dispute_resolved', dispute_id: disputeId, order_id: dispute.order_id, is_buyer: false }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // Send branded resolution emails to both parties
      if (buyer.email) {
        try {
          await sendDisputeResolved(buyer.email, {
            userName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            resolutionType: dispute.counter_offer_percent === 100 ? 'full_refund' : 'partial_refund',
            refundAmount: counterOfferAmount.toFixed(2),
            adminNotes: 'You accepted the seller\'s counter proposal.',
            isBuyer: true,
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send resolution email to buyer:', emailError);
        }
      }

      if (seller.email) {
        try {
          await sendDisputeResolved(seller.email, {
            userName: seller.display_name || 'Seller',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            resolutionType: dispute.counter_offer_percent === 100 ? 'full_refund' : 'partial_refund',
            refundAmount: counterOfferAmount.toFixed(2),
            adminNotes: `The buyer accepted your counter proposal.${transferResult.success ? ` £${transferResult.amount?.toFixed(2)} has been transferred to your account.` : ' Your payout is being processed.'}`,
            isBuyer: false,
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send resolution email to seller:', emailError);
        }
      }

      console.log('✅ counter proposal accepted:', disputeId);
      res.json({ 
        success: true, 
        message: `counter proposal accepted. £${counterOfferAmount.toFixed(2)} will be refunded to your account.`,
        resolution_amount: counterOfferAmount,
      });
    } catch (error: any) {
      console.error('❌ Accept counter proposal error:', error);
      res.status(500).json({ error: 'Failed to accept counter proposal' });
    }
  }

  /**
   * Buyer escalates dispute to admin
   * PUT /api/disputes/:id/escalate
   */
  static async escalateDispute(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const disputeId = req.params.id;
      const { additionalNotes } = req.body;

      console.log('🚨 Buyer escalating dispute:', disputeId);

      const dispute = await prisma.disputes.findFirst({
        where: {
          id: disputeId,
          buyer_id: userId,
          status: 'counter_offered',
        },
        include: {
          orders: {
            select: {
              id: true,
              listing_title: true,
              listing_image: true,
              amount: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found or cannot be escalated' });
      }

      const now = new Date();

      // Update dispute
      await prisma.disputes.update({
        where: { id: disputeId },
        data: {
          status: 'escalated',
          updated_at: now,
        },
      });

      const buyer = dispute.users_disputes_buyer;
      const seller = dispute.users_disputes_seller;
      const listingTitle = dispute.orders.listing_title || 'Your item';

      // Notify seller
      const escalatedSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: escalatedSellerNotifId,
          user_id: seller.id,
          type: 'dispute_escalated',
          title: '⚠️ Dispute Escalated',
          message: `The buyer has escalated the dispute for "${listingTitle}" to Mulligans for review.`,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // ✅ PUSH: Notify seller of escalation
      try {
        await sendPushNotification(
          seller.id,
          'Dispute Escalated',
          `The dispute for "${listingTitle}" has been escalated to Mulligans.`,
          { notification_id: escalatedSellerNotifId, type: 'dispute_escalated', dispute_id: disputeId, order_id: dispute.order_id, is_buyer: false }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // Send branded email to admin
      try {
        await sendDisputeEscalatedToAdmin({
          disputeId: disputeId,
          orderNumber: dispute.order_id.slice(-8).toUpperCase(),
          itemTitle: listingTitle,
          refundAmount: parseFloat(dispute.requested_refund_amount.toString()).toFixed(2),
          buyerName: buyer.display_name || 'Buyer',
          buyerEmail: buyer.email || '',
          sellerName: seller.display_name || 'Seller',
          sellerEmail: seller.email || '',
          reasonType: dispute.reason_type,
          escalationReason: additionalNotes
            ? `Buyer rejected counter proposal: ${additionalNotes}`
            : 'Buyer rejected the seller\'s counter proposal',
          itemImageUrl: dispute.orders?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
        });
      } catch (emailError) {
        console.error('⚠️ Failed to send escalation email to admin:', emailError);
      }

      // Send confirmation email to buyer
      if (buyer.email) {
        try {
          await sendDisputeEscalatedToBuyer(buyer.email, {
            buyerName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            refundAmount: parseFloat(dispute.requested_refund_amount.toString()).toFixed(2),
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send escalation confirmation to buyer:', emailError);
        }
      }

      console.log('✅ Dispute escalated:', disputeId);
      res.json({ 
        success: true, 
        message: 'Dispute escalated to Mulligans. We will review and make a fair decision within 48 hours.',
      });
    } catch (error: any) {
      console.error('❌ Escalate dispute error:', error);
      res.status(500).json({ error: 'Failed to escalate dispute' });
    }
  }

  /**
   * Admin resolves dispute
   * PUT /api/disputes/:id/resolve
   * 
   * Body: {
   *   resolutionType: 'full_refund' | 'partial_refund' | 'no_refund',
   *   resolutionAmount?: number,
   *   resolutionNotes: string
   * }
   * 
   * ✅ ESCROW: Handles all three scenarios:
   * - Full refund: 100% to buyer, £0 to seller
   * - Partial refund: X% to buyer, remaining to seller
   * - No refund: £0 to buyer, 100% to seller
   */
  static async adminResolveDispute(req: Request, res: Response) {
    try {
      // TODO: Add admin authentication check
      const disputeId = req.params.id;
      const { resolutionType, resolutionAmount, resolutionNotes } = req.body;

      console.log('👨‍⚖️ Admin resolving dispute:', disputeId);
      console.log('   Resolution type:', resolutionType);
      console.log('   Resolution amount:', resolutionAmount);

      if (!resolutionType || !resolutionNotes) {
        return res.status(400).json({ error: 'Resolution type and notes are required' });
      }

      // Row-lock the dispute to prevent concurrent resolution
      const dispute = await prisma.$transaction(async (tx) => {
        const rows: any[] = await tx.$queryRaw`
          SELECT id FROM disputes WHERE id = ${disputeId} AND status = 'escalated' FOR UPDATE`;
        if (rows.length === 0) return null;
        return tx.disputes.findFirst({
          where: { id: disputeId, status: 'escalated' },
          include: {
            orders: {
              select: {
                id: true, amount: true, seller_payout: true,
                stripe_payment_intent_id: true, listing_title: true, listing_image: true,
              },
            },
            users_disputes_buyer: { select: { id: true, display_name: true, email: true } },
            users_disputes_seller: { select: { id: true, display_name: true, email: true } },
          },
        });
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found or not escalated' });
      }

      const orderAmount = parseFloat(dispute.orders.amount.toString());
      let finalRefundAmount = 0;
      const now = new Date();

      if (resolutionType === 'full_refund') {
        finalRefundAmount = orderAmount;
      } else if (resolutionType === 'partial_refund') {
        if (!resolutionAmount || resolutionAmount <= 0) {
          return res.status(400).json({ error: 'Resolution amount required for partial refund' });
        }
        // B4: upper-bound validation
        if (resolutionAmount > orderAmount) {
          return res.status(400).json({ error: `Resolution amount (£${resolutionAmount.toFixed(2)}) cannot exceed order amount (£${orderAmount.toFixed(2)})` });
        }
        finalRefundAmount = resolutionAmount;
      }

      console.log(`   Order amount: £${orderAmount.toFixed(2)}`);
      console.log(`   Final refund: £${finalRefundAmount.toFixed(2)}`);

      // 1. Process refund if needed
      if (finalRefundAmount > 0 && dispute.orders.stripe_payment_intent_id) {
        const refundAmountPence = Math.round(finalRefundAmount * 100);
        try {
          const refund = await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmountPence,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'admin_resolved',
              resolution_type: resolutionType,
            },
          }, { idempotencyKey: `dispute_admin_refund_${disputeId}` });
          console.log(`💸 Admin resolution refund processed: £${finalRefundAmount.toFixed(2)} (${refund.id})`);

          await prisma.orders.update({
            where: { id: dispute.order_id },
            data: { stripe_refund_id: refund.id },
          });
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          return res.status(500).json({ error: 'Failed to process refund' });
        }
      }

      // 2. ✅ CRITICAL: Transfer remaining funds to seller (if not 100% refund)
      let transferResult: { success: boolean; transferId?: string; amount?: number; error?: string } = { success: true, amount: 0 };
      if (resolutionType !== 'full_refund') {
        transferResult = await transferSellerPayout(
          dispute.order_id,
          finalRefundAmount,
          disputeId
        );

        if (transferResult.success) {
          console.log(`💰 Seller payout transferred: £${transferResult.amount?.toFixed(2)}`);
        } else {
          console.error('⚠️ Seller payout transfer failed:', transferResult.error);
          // Continue anyway - we log the error and notify
        }
      }

      // 3. Update dispute
      await prisma.disputes.update({
        where: { id: disputeId },
        data: {
          status: 'admin_resolved',
          resolution_type: resolutionType,
          resolution_amount: finalRefundAmount,
          resolution_notes: resolutionNotes,
          resolved_by: 'admin',
          resolved_at: now,
          updated_at: now,
        },
      });

      // 4. Update order status
      const newOrderStatus = resolutionType === 'full_refund' ? 'refunded' : 'completed';
      await prisma.orders.update({
        where: { id: dispute.order_id },
        data: {
          status: newOrderStatus,
          updated_at: now,
        },
      });

      const buyer = dispute.users_disputes_buyer;
      const seller = dispute.users_disputes_seller;
      const listingTitle = dispute.orders.listing_title || 'Your item';

      // Build notification messages
      let buyerMessage: string;
      let sellerMessage: string;

      if (resolutionType === 'no_refund') {
        buyerMessage = `After reviewing all evidence, we've decided no refund is warranted for "${listingTitle}".`;
        sellerMessage = `The dispute for "${listingTitle}" has been resolved in your favour. No refund was issued.${transferResult.success ? ` £${transferResult.amount?.toFixed(2)} has been transferred to your account.` : ''}`;
      } else if (resolutionType === 'full_refund') {
        buyerMessage = `After reviewing all evidence, we've issued a full refund of £${finalRefundAmount.toFixed(2)} for "${listingTitle}".`;
        sellerMessage = `The dispute for "${listingTitle}" has been resolved. A full refund of £${finalRefundAmount.toFixed(2)} was issued to the buyer.`;
      } else {
        buyerMessage = `After reviewing all evidence, we've issued a partial refund of £${finalRefundAmount.toFixed(2)} for "${listingTitle}".`;
        sellerMessage = `The dispute for "${listingTitle}" has been resolved. A partial refund of £${finalRefundAmount.toFixed(2)} was issued to the buyer.${transferResult.success ? ` £${transferResult.amount?.toFixed(2)} has been transferred to your account.` : ''}`;
      }

      // Buyer notification
      const adminResolvedBuyerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: adminResolvedBuyerNotifId,
          user_id: buyer.id,
          type: 'dispute_resolved',
          title: '⚖️ Dispute Resolved',
          message: buyerMessage,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // Seller notification
      const adminResolvedSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await prisma.notifications.create({
        data: {
          id: adminResolvedSellerNotifId,
          user_id: seller.id,
          type: 'dispute_resolved',
          title: '⚖️ Dispute Resolved',
          message: sellerMessage,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // ✅ PUSH: Notify buyer of resolution
      try {
        await sendPushNotification(
          buyer.id,
          'Dispute Resolved',
          buyerMessage,
          { notification_id: adminResolvedBuyerNotifId, type: 'dispute_resolved', dispute_id: disputeId, order_id: dispute.order_id, is_buyer: true }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // ✅ PUSH: Notify seller of resolution
      try {
        await sendPushNotification(
          seller.id,
          'Dispute Resolved',
          sellerMessage,
          { notification_id: adminResolvedSellerNotifId, type: 'dispute_resolved', dispute_id: disputeId, order_id: dispute.order_id, is_buyer: false }
        );
      } catch (pushErr) {
        console.error('[DISPUTE] Push notification failed:', pushErr);
      }

      // Send branded emails to both parties
      if (buyer.email) {
        try {
          await sendDisputeResolved(buyer.email, {
            userName: buyer.display_name || 'Buyer',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            resolutionType: resolutionType as 'full_refund' | 'partial_refund' | 'no_refund',
            refundAmount: finalRefundAmount > 0 ? finalRefundAmount.toFixed(2) : undefined,
            adminNotes: resolutionNotes,
            isBuyer: true,
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
          console.log(`✅ Dispute resolution email sent to buyer: ${buyer.email}`);
        } catch (emailError) {
          console.error('⚠️ Failed to send resolution email to buyer:', emailError);
        }
      }

      if (seller.email) {
        try {
          await sendDisputeResolved(seller.email, {
            userName: seller.display_name || 'Seller',
            itemTitle: listingTitle,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            resolutionType: resolutionType as 'full_refund' | 'partial_refund' | 'no_refund',
            refundAmount: finalRefundAmount > 0 ? finalRefundAmount.toFixed(2) : undefined,
            adminNotes: `${resolutionNotes}${transferResult.success && transferResult.amount && transferResult.amount > 0 ? ` £${transferResult.amount.toFixed(2)} has been transferred to your account.` : ''}`,
            isBuyer: false,
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
          console.log(`✅ Dispute resolution email sent to seller: ${seller.email}`);
        } catch (emailError) {
          console.error('⚠️ Failed to send resolution email to seller:', emailError);
        }
      }

      console.log('✅ Admin resolved dispute:', disputeId);
      res.json({ 
        success: true, 
        message: 'Dispute resolved successfully',
        resolution: {
          type: resolutionType,
          refund_amount: finalRefundAmount,
          seller_payout: transferResult.amount || 0,
          notes: resolutionNotes,
        },
      });
    } catch (error: any) {
      console.error('❌ Admin resolve dispute error:', error);
      res.status(500).json({ error: 'Failed to resolve dispute' });
    }
  }

  /**
   * Get all disputes (admin)
   * GET /api/admin/disputes?status=escalated
   */
  static async getAdminDisputes(req: Request, res: Response) {
    try {
      // TODO: Add admin authentication check
      const status = req.query.status as string;
      const limit = parseInt(req.query.limit as string) || 50;

      let statusFilter: any = {};
      if (status && status !== 'all') {
        statusFilter = { status };
      }

      const disputes = await prisma.disputes.findMany({
        where: statusFilter,
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              seller_payout: true,
              listing_title: true,
              listing_image: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
        },
        orderBy: [
          { status: 'asc' }, // Escalated first
          { created_at: 'desc' },
        ],
        take: limit,
      });

      const formattedDisputes = disputes.map(d => ({
        id: d.id,
        order_id: d.order_id,
        status: d.status,
        reason_type: d.reason_type,
        requested_refund_percent: d.requested_refund_percent,
        requested_refund_amount: parseFloat(d.requested_refund_amount.toString()),
        counter_offer_percent: d.counter_offer_percent,
        counter_offer_amount: d.counter_offer_amount ? parseFloat(d.counter_offer_amount.toString()) : null,
        seller_deadline: d.seller_deadline.toISOString(),
        auto_escalated: d.auto_escalated,
        created_at: d.created_at.toISOString(),
        order: {
          id: d.orders.id,
          amount: parseFloat(d.orders.amount.toString()),
          seller_payout: d.orders.seller_payout ? parseFloat(d.orders.seller_payout.toString()) : null,
          listing_title: d.orders.listing_title,
          listing_image: d.orders.listing_image,
        },
        buyer: {
          id: d.users_disputes_buyer.id,
          display_name: d.users_disputes_buyer.display_name,
          email: d.users_disputes_buyer.email,
        },
        seller: {
          id: d.users_disputes_seller.id,
          display_name: d.users_disputes_seller.display_name,
          email: d.users_disputes_seller.email,
        },
      }));

      res.json({ disputes: formattedDisputes });
    } catch (error: any) {
      console.error('❌ Get admin disputes error:', error);
      res.status(500).json({ error: 'Failed to get disputes' });
    }
  }

  /**
   * Get single dispute detail (admin) - includes full listing info
   * GET /api/admin/disputes/:id
   */
  static async getAdminDisputeDetail(req: Request, res: Response) {
    try {
      const disputeId = req.params.id;

      const dispute = await prisma.disputes.findFirst({
        where: { id: disputeId },
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              seller_payout: true,
              listing_id: true,
              listing_title: true,
              listing_image: true,
              shipping_address: true,
              tracking_number: true,
              carrier: true,
              created_at: true,
              paid_at: true,
              shipped_at: true,
              delivered_at: true,
              // Include full listing data
              listings: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                  price: true,
                  images: {
                    select: { image_url: true },
                    orderBy: PRIMARY_IMAGE_ORDER,
                  },
                },
              },
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
              rating: true,
              total_purchases: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
              rating: true,
              total_sales: true,
              is_verified_seller: true,
            },
          },
          dispute_images: {
            orderBy: { created_at: 'asc' },
          },
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found' });
      }

      res.json({
        dispute: {
          id: dispute.id,
          order_id: dispute.order_id,
          status: dispute.status,
          
          // Buyer's claim
          reason_type: dispute.reason_type,
          reason_text: dispute.reason_text,
          requested_refund_percent: dispute.requested_refund_percent,
          requested_refund_amount: parseFloat(dispute.requested_refund_amount.toString()),
          
          // Seller's response
          seller_response_type: dispute.seller_response_type,
          counter_offer_percent: dispute.counter_offer_percent,
          counter_offer_amount: dispute.counter_offer_amount ? parseFloat(dispute.counter_offer_amount.toString()) : null,
          seller_response_text: dispute.seller_response_text,
          seller_responded_at: dispute.seller_responded_at?.toISOString() || null,
          
          // Resolution
          resolution_type: dispute.resolution_type,
          resolution_amount: dispute.resolution_amount ? parseFloat(dispute.resolution_amount.toString()) : null,
          resolution_notes: dispute.resolution_notes,
          resolved_by: dispute.resolved_by,
          resolved_at: dispute.resolved_at?.toISOString() || null,
          
          // Deadline
          seller_deadline: dispute.seller_deadline.toISOString(),
          auto_escalated: dispute.auto_escalated,
          
          // Timestamps
          created_at: dispute.created_at.toISOString(),
          updated_at: dispute.updated_at.toISOString(),
          
          // Order info with full listing
          order: {
            id: dispute.orders.id,
            amount: parseFloat(dispute.orders.amount.toString()),
            seller_payout: dispute.orders.seller_payout ? parseFloat(dispute.orders.seller_payout.toString()) : null,
            listing_title: dispute.orders.listing_title,
            listing_image: dispute.orders.listing_image,
            tracking_number: dispute.orders.tracking_number,
            carrier: dispute.orders.carrier,
            created_at: dispute.orders.created_at?.toISOString() || null,
            shipped_at: dispute.orders.shipped_at?.toISOString() || null,
            delivered_at: dispute.orders.delivered_at?.toISOString() || null,
            // Full listing info for admin
            listing: dispute.orders.listings ? {
              id: dispute.orders.listings.id,
              description: dispute.orders.listings.description,
              price: parseFloat(dispute.orders.listings.price.toString()),
              images: dispute.orders.listings.images.map(img => img.image_url),
            } : null,
          },
          
          // Users
          buyer: {
            id: dispute.users_disputes_buyer.id,
            display_name: dispute.users_disputes_buyer.display_name,
            email: dispute.users_disputes_buyer.email,
            avatar_url: dispute.users_disputes_buyer.avatar_url,
            rating: parseFloat(dispute.users_disputes_buyer.rating?.toString() || '0'),
            total_purchases: dispute.users_disputes_buyer.total_purchases,
          },
          seller: {
            id: dispute.users_disputes_seller.id,
            display_name: dispute.users_disputes_seller.display_name,
            email: dispute.users_disputes_seller.email,
            avatar_url: dispute.users_disputes_seller.avatar_url,
            rating: parseFloat(dispute.users_disputes_seller.rating?.toString() || '0'),
            total_sales: dispute.users_disputes_seller.total_sales,
            is_verified_seller: dispute.users_disputes_seller.is_verified_seller,
          },
          
          // Images
          buyer_images: dispute.dispute_images.filter(img => img.uploaded_by === 'buyer').map(img => ({
            id: img.id,
            url: img.image_url,
            created_at: img.created_at.toISOString(),
          })),
          seller_images: dispute.dispute_images.filter(img => img.uploaded_by === 'seller').map(img => ({
            id: img.id,
            url: img.image_url,
            created_at: img.created_at.toISOString(),
          })),
        },
      });
    } catch (error: any) {
      console.error('❌ Get admin dispute detail error:', error);
      res.status(500).json({ error: 'Failed to get dispute' });
    }
  }

  /**
   * Auto-escalate expired disputes (called by cron job)
   * POST /api/disputes/auto-escalate
   */
  static async autoEscalateExpired(req: Request, res: Response) {
    try {
      // Find disputes past deadline with no seller response
      const expiredDisputes = await prisma.disputes.findMany({
        where: {
          status: 'open',
          seller_deadline: {
            lt: new Date(),
          },
        },
        include: {
          orders: {
            select: {
              listing_title: true,
              listing_image: true,
              amount: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
            },
          },
        },
      });

      console.log(`🕐 Found ${expiredDisputes.length} expired disputes to auto-escalate`);

      const now = new Date();

      for (const dispute of expiredDisputes) {
        // Update to escalated
        await prisma.disputes.update({
          where: { id: dispute.id },
          data: {
            status: 'escalated',
            auto_escalated: true,
            updated_at: now,
          },
        });

        const buyer = dispute.users_disputes_buyer;
        const seller = dispute.users_disputes_seller;
        const listingTitle = dispute.orders.listing_title || 'Your item';

        // Notify buyer
        const autoEscalatedBuyerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await prisma.notifications.create({
          data: {
            id: autoEscalatedBuyerNotifId,
            user_id: buyer.id,
            type: 'dispute_escalated',
            title: '⚠️ Dispute Auto-Escalated',
            message: `The seller didn't respond in time. Your dispute for "${listingTitle}" has been escalated to Mulligans for review.`,
            image_url: dispute.orders.listing_image,
            related_id: dispute.id,
          },
        });

        // PUSH: Notify buyer
        try {
          await sendPushNotification(
            buyer.id,
            'Dispute Auto-Escalated',
            `Your dispute for "${listingTitle}" has been escalated for review.`,
            { notification_id: autoEscalatedBuyerNotifId, type: 'dispute_escalated', dispute_id: dispute.id, order_id: dispute.order_id, is_buyer: true }
          );
        } catch (pushErr) {
          console.error('[DISPUTE] Push notification failed:', pushErr);
        }

        // Notify seller
        const autoEscalatedSellerNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await prisma.notifications.create({
          data: {
            id: autoEscalatedSellerNotifId,
            user_id: seller.id,
            type: 'dispute_escalated',
            title: '⚠️ Dispute Auto-Escalated',
            message: `You didn't respond to the dispute for "${listingTitle}" in time. It has been escalated to Mulligans for review.`,
            image_url: dispute.orders.listing_image,
            related_id: dispute.id,
          },
        });

        // PUSH: Notify seller
        try {
          await sendPushNotification(
            seller.id,
            'Dispute Auto-Escalated',
            `Your dispute for "${listingTitle}" has been escalated. Respond promptly.`,
            { notification_id: autoEscalatedSellerNotifId, type: 'dispute_escalated', dispute_id: dispute.id, order_id: dispute.order_id, is_buyer: false }
          );
        } catch (pushErr) {
          console.error('[DISPUTE] Push notification failed:', pushErr);
        }

        // Send branded email to admin
        try {
          await sendDisputeEscalatedToAdmin({
            disputeId: dispute.id,
            orderNumber: dispute.order_id.slice(-8).toUpperCase(),
            itemTitle: listingTitle,
            refundAmount: parseFloat(dispute.requested_refund_amount.toString()).toFixed(2),
            buyerName: buyer.display_name || 'Buyer',
            buyerEmail: buyer.email || '',
            sellerName: seller.display_name || 'Seller',
            sellerEmail: seller.email || '',
            reasonType: dispute.reason_type,
            escalationReason: 'Auto-escalated: Seller failed to respond within 72 hours',
            itemImageUrl: dispute.orders?.listing_image || '',
            itemBrand: '',
            itemCondition: '',
            itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
          });
        } catch (emailError) {
          console.error('⚠️ Failed to send auto-escalation email to admin:', emailError);
        }

        // Send confirmation to buyer
        if (buyer.email) {
          try {
            await sendDisputeEscalatedToBuyer(buyer.email, {
              buyerName: buyer.display_name || 'Buyer',
              itemTitle: listingTitle,
              orderNumber: dispute.order_id.slice(-8).toUpperCase(),
              refundAmount: parseFloat(dispute.requested_refund_amount.toString()).toFixed(2),
              itemImageUrl: dispute.orders?.listing_image || '',
              itemBrand: '',
              itemCondition: '',
              itemPrice: `£${parseFloat(dispute.orders?.amount?.toString() || '0').toFixed(2)}`,
            });
          } catch (emailError) {
            console.error('⚠️ Failed to send auto-escalation confirmation to buyer:', emailError);
          }
        }

        console.log(`✅ Auto-escalated dispute: ${dispute.id}`);
      }

      res.json({ 
        success: true, 
        escalated_count: expiredDisputes.length,
        dispute_ids: expiredDisputes.map(d => d.id),
      });
    } catch (error: any) {
      console.error('❌ Auto-escalate error:', error);
      res.status(500).json({ error: 'Failed to auto-escalate disputes' });
    }
  }

  /**
   * Upload image to a dispute (multipart/form-data)
   * POST /api/disputes/:id/images
   * 
   * This accepts multipart/form-data uploads instead of base64
   * to avoid 413 payload errors
   */
  static async uploadDisputeImageFile(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { id: disputeId } = req.params;

      console.log(`📷 Uploading dispute image for dispute: ${disputeId}`);

      // Verify the dispute exists and user is the buyer or seller
      const dispute = await prisma.disputes.findUnique({
        where: { id: disputeId },
        select: {
          id: true,
          buyer_id: true,
          seller_id: true,
          status: true,
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found' });
      }

      // Only buyer can upload during initial dispute creation
      // Only seller can upload during counter-offer
      const isBuyer = dispute.buyer_id === userId;
      const isSeller = dispute.seller_id === userId;

      if (!isBuyer && !isSeller) {
        return res.status(403).json({ error: 'You are not authorized to upload images to this dispute' });
      }

      // Determine who is uploading
      const uploadedBy = isBuyer ? 'buyer' : 'seller';

      // Get the file from multer
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'No image file provided' });
      }

      // Check current image count (max 5 per party)
      const existingImages = await prisma.dispute_images.count({
        where: {
          dispute_id: disputeId,
          uploaded_by: uploadedBy,
        },
      });

      if (existingImages >= 5) {
        return res.status(400).json({ error: `Maximum 5 images allowed per ${uploadedBy}` });
      }

      // Generate unique filename
      const fileExtension = file.originalname?.split('.').pop()?.toLowerCase() || 'jpg';
      const validExtensions = ['jpg', 'jpeg', 'png', 'webp', 'heic'];
      const extension = validExtensions.includes(fileExtension) ? fileExtension : 'jpg';
      
      const s3Key = `disputes/${disputeId}/${uploadedBy}/${uuidv4()}.${extension}`;

      // Upload to S3
      await s3Client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype || `image/${extension}`,
        })
      );

      const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const imageUrl = CLOUDFRONT_DOMAIN
  ? `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
  : `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'eu-west-2'}.amazonaws.com/${s3Key}`;

      // Save to database
      const disputeImage = await prisma.dispute_images.create({
        data: {
          id: uuidv4(),
          dispute_id: disputeId,
          image_url: imageUrl,
          s3_key: s3Key,
          uploaded_by: uploadedBy,
          created_at: new Date(),
        },
      });

      console.log(`✅ Dispute image uploaded: ${imageUrl}`);

      res.status(201).json({
        success: true,
        image: {
          id: disputeImage.id,
          url: imageUrl,
          uploaded_by: uploadedBy,
        },
      });
    } catch (error: any) {
      console.error('❌ Error uploading dispute image:', error);
      res.status(500).json({ error: 'Failed to upload image' });
    }
  }
}