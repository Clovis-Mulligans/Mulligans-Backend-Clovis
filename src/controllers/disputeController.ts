// src/controllers/disputeController.ts
// ✅ COMPLETE DISPUTE SYSTEM
// - Buyer opens dispute with photos + refund request
// - Seller responds (accept/counter/reject)
// - Buyer reviews counter-offer
// - 36-hour deadline with auto-escalation
// - Admin resolution
// - Email notifications

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { sendDisputeEmail } from '../services/emailService';
import { sendPushNotification } from './pushNotificationController';

const prisma = new PrismaClient();
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

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'mulligans-images';

// Constants
const SELLER_RESPONSE_DEADLINE_HOURS = 36;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@mulligans.uk.com';

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

  const imageUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'eu-west-2'}.amazonaws.com/${s3Key}`;

  return { imageUrl, s3Key };
}

/**
 * Send email notification for dispute events
 */
async function sendDisputeNotification(
  to: string,
  subject: string,
  htmlContent: string
): Promise<void> {
  try {
    await sendDisputeEmail(to, subject, htmlContent);
    console.log(`📧 Dispute email sent to: ${to}`);
  } catch (error) {
    console.error(`⚠️ Failed to send dispute email to ${to}:`, error);
  }
}

/**
 * Create email HTML for dispute notifications
 */
function createDisputeEmailHtml(
  title: string,
  content: string,
  actionUrl?: string,
  actionText?: string
): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1DC690; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; background: #1DC690; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 16px; }
        .warning { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 12px; margin: 16px 0; }
        .urgent { background: #FEE2E2; border-left: 4px solid #EF4444; padding: 12px; margin: 16px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
        </div>
        <div class="content">
          ${content}
          ${actionUrl ? `<a href="${actionUrl}" class="button">${actionText || 'View Details'}</a>` : ''}
          <p style="margin-top: 24px; font-size: 12px; color: #666;">
            This is an automated message from Mulligans Golf. Please do not reply to this email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
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
                orderBy: { display_order: 'asc' },
              },
            },
          },
          users_orders_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
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

      // Calculate seller deadline (36 hours from now)
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

      // Update order status
      await prisma.orders.update({
        where: { id: orderId },
        data: {
          status: 'disputed',
          disputed_at: now,
          dispute_reason: `${reasonType}: ${reasonText}`,
          escrow_release_at: null, // Hold funds
          updated_at: now,
        },
      });

      // Get listing info for notifications
      const listingTitle = order.listings?.title || (order as any).listing_title || 'Your item';
      const listingImage = order.listings?.images?.[0]?.image_url || (order as any).listing_image || null;
      const seller = order.users_orders_seller_idTousers;
      const buyer = order.users_orders_buyer_idTousers;

      // Create notification for seller
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: order.seller_id,
          type: 'dispute',
          title: '⚠️ Dispute Opened',
          message: `A buyer has opened a dispute for "${listingTitle}". You have 36 hours to respond. Requested: £${requestedRefundAmount.toFixed(2)} (${requestedRefundPercent}%)`,
          image_url: listingImage,
          related_id: disputeId,
        },
      });

      // Send push notification to seller
      if (seller.push_token) {
        await sendPushNotification(
          seller.push_token,
          '⚠️ Dispute Opened - Action Required',
          `A dispute has been opened for "${listingTitle}". You have 36 hours to respond.`,
          { type: 'dispute', disputeId, orderId }
        );
      }

      // Send email to seller
      if (seller.email) {
        const emailHtml = createDisputeEmailHtml(
          '⚠️ Dispute Opened - Action Required',
          `
            <div class="urgent">
              <strong>You have 36 hours to respond to this dispute.</strong>
            </div>
            <p><strong>Item:</strong> ${listingTitle}</p>
            <p><strong>Buyer:</strong> ${buyer.display_name}</p>
            <p><strong>Issue:</strong> ${reasonType.replace(/_/g, ' ')}</p>
            <p><strong>Description:</strong> ${reasonText}</p>
            <p><strong>Requested Refund:</strong> £${requestedRefundAmount.toFixed(2)} (${requestedRefundPercent}%)</p>
            <p>Please log in to the Mulligans app to review the claim and respond.</p>
          `,
          'mulligans://orders',
          'Review Dispute'
        );
        await sendDisputeEmail(seller.email, `⚠️ Dispute Opened - ${listingTitle}`, emailHtml);
      }

      // Send email to ADMIN
      const adminEmailHtml = createDisputeEmailHtml(
        '🆕 New Dispute Opened',
        `
          <p><strong>Order ID:</strong> ${orderId}</p>
          <p><strong>Dispute ID:</strong> ${disputeId}</p>
          <p><strong>Item:</strong> ${listingTitle}</p>
          <p><strong>Buyer:</strong> ${buyer.display_name} (${buyer.email})</p>
          <p><strong>Seller:</strong> ${seller.display_name} (${seller.email})</p>
          <p><strong>Issue Type:</strong> ${reasonType.replace(/_/g, ' ')}</p>
          <p><strong>Description:</strong> ${reasonText}</p>
          <p><strong>Order Amount:</strong> £${orderAmount.toFixed(2)}</p>
          <p><strong>Requested Refund:</strong> £${requestedRefundAmount.toFixed(2)} (${requestedRefundPercent}%)</p>
          <p><strong>Seller Deadline:</strong> ${sellerDeadline.toLocaleString('en-GB')}</p>
          <div class="warning">
            <strong>Monitor:</strong> If seller doesn't respond by ${sellerDeadline.toLocaleString('en-GB')}, this will be auto-escalated.
          </div>
        `
      );
      await sendDisputeEmail(ADMIN_EMAIL, `🆕 New Dispute - Order ${orderId.slice(-8)}`, adminEmailHtml);

      console.log('✅ Dispute created:', disputeId);
      res.status(201).json({ 
        success: true, 
        disputeId,
        message: 'Dispute opened successfully. The seller has 36 hours to respond.',
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
              is_verified: true,
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
            is_verified: dispute.users_disputes_seller.is_verified,
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

      // Find the dispute
      const dispute = await prisma.disputes.findFirst({
        where: {
          id: disputeId,
          seller_id: userId,
          status: 'open',
        },
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              listing_title: true,
              listing_image: true,
              stripe_payment_intent_id: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
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
        return res.status(404).json({ error: 'Dispute not found or you cannot respond to it' });
      }

      // Check if deadline has passed
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
          return res.status(400).json({ error: 'Invalid counter offer percentage' });
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
      const updatedDispute = await prisma.disputes.update({
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

      // If seller accepted, process the refund
      if (responseType === 'accept' && resolutionAmount && dispute.orders.stripe_payment_intent_id) {
        const refundAmount = Math.round(resolutionAmount * 100);
        try {
          await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmount,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'seller_accepted',
            },
          });
          console.log(`💸 Refund processed: £${resolutionAmount.toFixed(2)}`);

          // Update order status
          await prisma.orders.update({
            where: { id: dispute.order_id },
            data: {
              status: dispute.requested_refund_percent === 100 ? 'refunded' : 'completed',
              updated_at: now,
            },
          });
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
        notificationMessage = `The seller has made a counter offer of £${counterOfferAmount?.toFixed(2)} (${counterOfferPercent}%) for "${listingTitle}". Please review and respond.`;
      } else if (responseType === 'reject') {
        notificationTitle = '⚠️ Dispute Escalated';
        notificationMessage = `The seller has rejected your claim for "${listingTitle}". Mulligans will now review and make a decision.`;
      }

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyer.id,
          type: 'dispute_update',
          title: notificationTitle,
          message: notificationMessage,
          image_url: listingImage,
          related_id: disputeId,
        },
      });

      // Send push notification to buyer
      if (buyer.push_token) {
        await sendPushNotification(
          buyer.push_token,
          notificationTitle,
          notificationMessage,
          { type: 'dispute_update', disputeId }
        );
      }

      // Send email to buyer
      if (buyer.email) {
        const emailHtml = createDisputeEmailHtml(
          notificationTitle,
          `
            <p><strong>Item:</strong> ${listingTitle}</p>
            <p>${notificationMessage}</p>
            ${responseText ? `<p><strong>Seller's message:</strong> ${responseText}</p>` : ''}
          `,
          'mulligans://orders',
          responseType === 'counter' ? 'Review Counter Offer' : 'View Details'
        );
        await sendDisputeEmail(buyer.email, notificationTitle, emailHtml);
      }

      // If escalated, notify admin
      if (responseType === 'reject') {
        const adminEmailHtml = createDisputeEmailHtml(
          '🚨 Dispute Escalated - Review Required',
          `
            <div class="urgent">
              <strong>A seller has rejected a dispute claim. Admin review required.</strong>
            </div>
            <p><strong>Dispute ID:</strong> ${disputeId}</p>
            <p><strong>Order ID:</strong> ${dispute.order_id}</p>
            <p><strong>Item:</strong> ${listingTitle}</p>
            <p><strong>Buyer:</strong> ${buyer.display_name} (${buyer.email})</p>
            <p><strong>Seller:</strong> ${seller.display_name} (${seller.email})</p>
            <hr/>
            <p><strong>Buyer's Claim:</strong></p>
            <p>Issue: ${dispute.reason_type.replace(/_/g, ' ')}</p>
            <p>${dispute.reason_text}</p>
            <p>Requested: £${parseFloat(dispute.requested_refund_amount.toString()).toFixed(2)} (${dispute.requested_refund_percent}%)</p>
            <hr/>
            <p><strong>Seller's Response:</strong></p>
            <p>${responseText}</p>
          `
        );
        await sendDisputeEmail(ADMIN_EMAIL, `🚨 Escalated Dispute - ${disputeId.slice(-8)}`, adminEmailHtml);
      }

      console.log('✅ Seller response recorded:', disputeId);
      res.json({ 
        success: true, 
        status: newStatus,
        message: responseType === 'accept' 
          ? 'You have accepted the buyer\'s request. A refund has been processed.'
          : responseType === 'counter'
          ? 'Your counter offer has been sent to the buyer.'
          : 'Your response has been recorded. Mulligans will review and make a decision.',
      });
    } catch (error: any) {
      console.error('❌ Respond to dispute error:', error);
      res.status(500).json({ error: 'Failed to respond to dispute' });
    }
  }

  /**
   * Buyer accepts counter offer
   * PUT /api/disputes/:id/accept-counter
   */
  static async acceptCounterOffer(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const disputeId = req.params.id;

      console.log('✅ Buyer accepting counter offer:', disputeId);

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
              stripe_payment_intent_id: true,
              listing_title: true,
              listing_image: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
            },
          },
        },
      });

      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found or no counter offer to accept' });
      }

      const counterOfferAmount = parseFloat(dispute.counter_offer_amount!.toString());
      const now = new Date();

      // Process refund
      if (dispute.orders.stripe_payment_intent_id) {
        const refundAmount = Math.round(counterOfferAmount * 100);
        try {
          await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmount,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'buyer_accepted_counter',
            },
          });
          console.log(`💸 Counter offer refund processed: £${counterOfferAmount.toFixed(2)}`);
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          return res.status(500).json({ error: 'Failed to process refund' });
        }
      }

      // Update dispute
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

      // Update order
      await prisma.orders.update({
        where: { id: dispute.order_id },
        data: {
          status: dispute.counter_offer_percent === 100 ? 'refunded' : 'completed',
          updated_at: now,
        },
      });

      const seller = dispute.users_disputes_seller;
      const listingTitle = dispute.orders.listing_title || 'Your item';

      // Notify seller
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: seller.id,
          type: 'dispute_resolved',
          title: '✅ Dispute Resolved',
          message: `The buyer accepted your counter offer of £${counterOfferAmount.toFixed(2)} for "${listingTitle}".`,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // Push notification to seller
      if (seller.push_token) {
        await sendPushNotification(
          seller.push_token,
          '✅ Dispute Resolved',
          `The buyer accepted your counter offer for "${listingTitle}".`,
          { type: 'dispute_resolved', disputeId }
        );
      }

      console.log('✅ Counter offer accepted:', disputeId);
      res.json({ 
        success: true, 
        message: `Counter offer accepted. £${counterOfferAmount.toFixed(2)} will be refunded to your account.`,
        resolution_amount: counterOfferAmount,
      });
    } catch (error: any) {
      console.error('❌ Accept counter offer error:', error);
      res.status(500).json({ error: 'Failed to accept counter offer' });
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
              push_token: true,
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
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: seller.id,
          type: 'dispute_escalated',
          title: '⚠️ Dispute Escalated',
          message: `The buyer has escalated the dispute for "${listingTitle}" to Mulligans for review.`,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // Push notification to seller
      if (seller.push_token) {
        await sendPushNotification(
          seller.push_token,
          '⚠️ Dispute Escalated',
          `The dispute for "${listingTitle}" has been escalated to Mulligans.`,
          { type: 'dispute_escalated', disputeId }
        );
      }

      // Email admin
      const adminEmailHtml = createDisputeEmailHtml(
        '🚨 Dispute Escalated by Buyer',
        `
          <div class="urgent">
            <strong>The buyer has rejected the counter offer and escalated this dispute.</strong>
          </div>
          <p><strong>Dispute ID:</strong> ${disputeId}</p>
          <p><strong>Order ID:</strong> ${dispute.order_id}</p>
          <p><strong>Item:</strong> ${listingTitle}</p>
          <p><strong>Order Amount:</strong> £${parseFloat(dispute.orders.amount.toString()).toFixed(2)}</p>
          <hr/>
          <p><strong>Buyer:</strong> ${buyer.display_name} (${buyer.email})</p>
          <p><strong>Requested:</strong> £${parseFloat(dispute.requested_refund_amount.toString()).toFixed(2)} (${dispute.requested_refund_percent}%)</p>
          <p><strong>Claim:</strong> ${dispute.reason_text}</p>
          ${additionalNotes ? `<p><strong>Additional Notes:</strong> ${additionalNotes}</p>` : ''}
          <hr/>
          <p><strong>Seller:</strong> ${seller.display_name} (${seller.email})</p>
          <p><strong>Counter Offer:</strong> £${parseFloat(dispute.counter_offer_amount!.toString()).toFixed(2)} (${dispute.counter_offer_percent}%)</p>
          <p><strong>Seller's Response:</strong> ${dispute.seller_response_text}</p>
        `
      );
      await sendDisputeEmail(ADMIN_EMAIL, `🚨 Escalated Dispute - Review Required - ${disputeId.slice(-8)}`, adminEmailHtml);

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
   */
  static async adminResolveDispute(req: Request, res: Response) {
    try {
      // TODO: Add admin authentication check
      const disputeId = req.params.id;
      const { resolutionType, resolutionAmount, resolutionNotes } = req.body;

      console.log('👨‍⚖️ Admin resolving dispute:', disputeId);

      if (!resolutionType || !resolutionNotes) {
        return res.status(400).json({ error: 'Resolution type and notes are required' });
      }

      const dispute = await prisma.disputes.findFirst({
        where: {
          id: disputeId,
          status: 'escalated',
        },
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              stripe_payment_intent_id: true,
              listing_title: true,
              listing_image: true,
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
            },
          },
          users_disputes_seller: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
            },
          },
        },
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
        finalRefundAmount = resolutionAmount;
      }

      // Process refund if needed
      if (finalRefundAmount > 0 && dispute.orders.stripe_payment_intent_id) {
        const refundAmountCents = Math.round(finalRefundAmount * 100);
        try {
          await stripe.refunds.create({
            payment_intent: dispute.orders.stripe_payment_intent_id,
            amount: refundAmountCents,
            reason: 'requested_by_customer',
            metadata: {
              dispute_id: disputeId,
              order_id: dispute.order_id,
              resolution: 'admin_resolved',
            },
          });
          console.log(`💸 Admin resolution refund processed: £${finalRefundAmount.toFixed(2)}`);
        } catch (refundError: any) {
          console.error('⚠️ Refund failed:', refundError.message);
          return res.status(500).json({ error: 'Failed to process refund' });
        }
      }

      // Update dispute
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

      // Update order status
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

      // Notify both parties
      const buyerMessage = resolutionType === 'no_refund'
        ? `After reviewing all evidence, we've decided no refund is warranted for "${listingTitle}".`
        : `After reviewing all evidence, we've issued a ${resolutionType === 'full_refund' ? 'full' : 'partial'} refund of £${finalRefundAmount.toFixed(2)} for "${listingTitle}".`;

      const sellerMessage = resolutionType === 'no_refund'
        ? `The dispute for "${listingTitle}" has been resolved in your favor. No refund was issued.`
        : `The dispute for "${listingTitle}" has been resolved. A ${resolutionType === 'full_refund' ? 'full' : 'partial'} refund of £${finalRefundAmount.toFixed(2)} was issued to the buyer.`;

      // Buyer notification
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyer.id,
          type: 'dispute_resolved',
          title: '⚖️ Dispute Resolved',
          message: buyerMessage,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // Seller notification
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: seller.id,
          type: 'dispute_resolved',
          title: '⚖️ Dispute Resolved',
          message: sellerMessage,
          image_url: dispute.orders.listing_image,
          related_id: disputeId,
        },
      });

      // Push notifications
      if (buyer.push_token) {
        await sendPushNotification(buyer.push_token, '⚖️ Dispute Resolved', buyerMessage, { type: 'dispute_resolved', disputeId });
      }
      if (seller.push_token) {
        await sendPushNotification(seller.push_token, '⚖️ Dispute Resolved', sellerMessage, { type: 'dispute_resolved', disputeId });
      }

      // Email both parties
      const buyerEmailHtml = createDisputeEmailHtml(
        '⚖️ Dispute Resolved',
        `
          <p><strong>Item:</strong> ${listingTitle}</p>
          <p>${buyerMessage}</p>
          <p><strong>Our notes:</strong> ${resolutionNotes}</p>
        `
      );
      await sendDisputeEmail(buyer.email!, 'Dispute Resolved', buyerEmailHtml);

      const sellerEmailHtml = createDisputeEmailHtml(
        '⚖️ Dispute Resolved',
        `
          <p><strong>Item:</strong> ${listingTitle}</p>
          <p>${sellerMessage}</p>
          <p><strong>Our notes:</strong> ${resolutionNotes}</p>
        `
      );
      await sendDisputeEmail(seller.email!, 'Dispute Resolved', sellerEmailHtml);

      console.log('✅ Admin resolved dispute:', disputeId);
      res.json({ 
        success: true, 
        message: 'Dispute resolved successfully',
        resolution: {
          type: resolutionType,
          amount: finalRefundAmount,
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
            },
          },
          users_disputes_buyer: {
            select: {
              id: true,
              display_name: true,
              email: true,
              push_token: true,
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
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: buyer.id,
            type: 'dispute_escalated',
            title: '⚠️ Dispute Auto-Escalated',
            message: `The seller didn't respond in time. Your dispute for "${listingTitle}" has been escalated to Mulligans for review.`,
            image_url: dispute.orders.listing_image,
            related_id: dispute.id,
          },
        });

        // Notify seller
        await prisma.notifications.create({
          data: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            user_id: seller.id,
            type: 'dispute_escalated',
            title: '⚠️ Dispute Auto-Escalated',
            message: `You didn't respond to the dispute for "${listingTitle}" in time. It has been escalated to Mulligans for review.`,
            image_url: dispute.orders.listing_image,
            related_id: dispute.id,
          },
        });

        // Email admin
        const adminEmailHtml = createDisputeEmailHtml(
          '🕐 Dispute Auto-Escalated (No Response)',
          `
            <div class="urgent">
              <strong>Seller failed to respond within 36 hours. Review required.</strong>
            </div>
            <p><strong>Dispute ID:</strong> ${dispute.id}</p>
            <p><strong>Item:</strong> ${listingTitle}</p>
            <p><strong>Buyer:</strong> ${buyer.display_name} (${buyer.email})</p>
            <p><strong>Seller:</strong> ${seller.display_name} (${seller.email})</p>
            <p><strong>Requested:</strong> £${parseFloat(dispute.requested_refund_amount.toString()).toFixed(2)} (${dispute.requested_refund_percent}%)</p>
            <p><strong>Reason:</strong> ${dispute.reason_type.replace(/_/g, ' ')}</p>
            <p><strong>Description:</strong> ${dispute.reason_text}</p>
          `
        );
        await sendDisputeEmail(ADMIN_EMAIL, `🕐 Auto-Escalated Dispute - ${dispute.id.slice(-8)}`, adminEmailHtml);

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

      const imageUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'eu-west-2'}.amazonaws.com/${s3Key}`;

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