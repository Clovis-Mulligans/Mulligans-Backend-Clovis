// src/routes/adminRoutes.ts
// Admin panel routes for dispute management

import express from 'express';
import { adminAuth, verifyAdminPassword, adminLogout } from '../middleware/adminAuth';
import { DisputeController } from '../controllers/disputeController';
import { AdminReportsController } from '../controllers/adminReportsController';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import Stripe from 'stripe';
import { sendPushNotification } from '../controllers/pushNotificationController';
import { 
  sendInsuranceClaimApprovedToBuyer, 
  sendInsuranceClaimApprovedToSeller,
  sendInsuranceClaimDeniedToBuyer,
  sendInsuranceClaimDeniedToSeller
} from '../services/emailService';
import { AdminStatsController } from '../controllers/adminStatsController';
import { logAdminAction, AUDIT_ACTIONS } from '../lib/auditLogger';
import { restoreListingStock } from '../lib/stockUtils';
import { INSPECTION_WINDOW_MS } from '../constants/inspection';

import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// Admin login rate limiter - 5 attempts per 15 minutes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many admin login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin action rate limiter - 30 actions per 15 minutes (prevents accidental mass operations)
const adminActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many admin actions, please slow down',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Verify admin password (rate limited)
router.post('/verify', adminLimiter, verifyAdminPassword);

// Logout (destroy session)
router.post('/logout', adminLogout);

// ============================================
// PROTECTED ROUTES (admin auth required)
// ============================================

// Get all disputes
router.get('/disputes', adminAuth, DisputeController.getAdminDisputes);

// Get single dispute details (with images)
router.get('/disputes/:id', adminAuth, async (req, res) => {
  try {
    const dispute = await prisma.disputes.findUnique({
      where: { id: req.params.id },
      include: {
        orders: {
          select: {
            id: true,
            amount: true,
            shipping_cost: true,
            listing_id: true,
            listing_title: true,
            listing_image: true,
            stripe_payment_intent_id: true,
            created_at: true,
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
        dispute_images: {
          select: {
            id: true,
            image_url: true,
            uploaded_by: true,
            created_at: true,
          },
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    // Format response
    const formatted = {
      id: dispute.id,
      order_id: dispute.order_id,
      status: dispute.status,
      reason_type: dispute.reason_type,
      reason_text: dispute.reason_text,
      requested_refund_percent: dispute.requested_refund_percent,
      requested_refund_amount: parseFloat(dispute.requested_refund_amount.toString()),
      counter_offer_percent: dispute.counter_offer_percent,
      counter_offer_amount: dispute.counter_offer_amount ? parseFloat(dispute.counter_offer_amount.toString()) : null,
      seller_response_text: dispute.seller_response_text,
      seller_responded_at: dispute.seller_responded_at?.toISOString() || null,
      seller_deadline: dispute.seller_deadline?.toISOString() || null,
      resolution_type: dispute.resolution_type,
      resolution_amount: dispute.resolution_amount ? parseFloat(dispute.resolution_amount.toString()) : null,
      resolution_notes: dispute.resolution_notes,
      resolved_at: dispute.resolved_at?.toISOString() || null,
      auto_escalated: dispute.auto_escalated,
      created_at: dispute.created_at.toISOString(),
      order: {
        id: dispute.orders.id,
        amount: parseFloat(dispute.orders.amount.toString()),
        shipping_cost: dispute.orders.shipping_cost ? parseFloat(dispute.orders.shipping_cost.toString()) : 0,
        listing_title: dispute.orders.listing_title,
        listing_image: dispute.orders.listing_image,
        created_at: dispute.orders.created_at.toISOString(),
        listing: null as any,
      },
      buyer: {
        id: dispute.users_disputes_buyer.id,
        display_name: dispute.users_disputes_buyer.display_name,
        email: dispute.users_disputes_buyer.email,
      },
      seller: {
        id: dispute.users_disputes_seller.id,
        display_name: dispute.users_disputes_seller.display_name,
        email: dispute.users_disputes_seller.email,
      },
      buyer_images: dispute.dispute_images
        .filter((img: any) => img.uploaded_by === 'buyer')
        .map((img: any) => ({
          id: img.id,
          url: img.image_url,
          created_at: img.created_at.toISOString(),
        })),
      seller_images: dispute.dispute_images
        .filter((img: any) => img.uploaded_by === 'seller')
        .map((img: any) => ({
          id: img.id,
          url: img.image_url,
          created_at: img.created_at.toISOString(),
        })),
    };

    // Fetch full listing details for dispute comparison
    if (dispute.orders.listing_id) {
      const listing = await prisma.listings.findUnique({
        where: { id: dispute.orders.listing_id },
        select: {
          id: true,
          description: true,
          price: true,
          condition_overall: true,
          images: {
            select: { image_url: true },
            orderBy: PRIMARY_IMAGE_ORDER,
          },
        },
      });
      if (listing) {
        formatted.order.listing = {
          description: listing.description,
          price: parseFloat(listing.price.toString()),
          condition: listing.condition_overall,
          images: listing.images.map((img: any) => img.image_url),
        };
      }
    }

    res.json({ dispute: formatted });
  } catch (error: any) {
    console.error('❌ Get dispute detail error:', error);
    res.status(500).json({ error: 'Failed to get dispute details' });
  }
});

// Resolve dispute (with audit logging)
router.put('/disputes/:id/resolve', adminAuth, adminActionLimiter, async (req, res) => {
  // Store original json method to capture response
  const originalJson = res.json.bind(res);
  res.json = function(data: any) {
    // Log after successful resolution
    if (data && !data.error) {
      logAdminAction(
        AUDIT_ACTIONS.RESOLVE_DISPUTE,
        'dispute',
        req.params.id,
        {
          resolution_type: req.body.resolution_type,
          resolution_amount: req.body.resolution_amount,
          notes: req.body.notes?.substring(0, 200),
        },
        req
      );
    }
    return originalJson(data);
  };
  return DisputeController.adminResolveDispute(req, res);
});

// Report management routes (MOVE THESE BEFORE EXPORT)
router.get('/reports', adminAuth, AdminReportsController.getReports);
router.get('/reports/:id', adminAuth, AdminReportsController.getReport);
router.patch('/reports/:id', adminAuth, AdminReportsController.updateReport);
router.post('/reports/:id/ban-user', adminAuth, adminActionLimiter, AdminReportsController.banUser);

// ============================================
// RETURNS MANAGEMENT ROUTES (NEW)
// ============================================

// Get all returns with filters and stats
router.get('/returns', adminAuth, async (req, res) => {
  try {
    const { tab } = req.query;
    
    let whereClause: any = {};
    
    // Filter by tab
    if (tab === 'pending') {
      whereClause.status = { in: ['pending', 'approved', 'awaiting_address', 'label_created'] };
    } else if (tab === 'in_transit') {
      whereClause.status = { in: ['shipped'] };
    } else if (tab === 'delivered') {
      whereClause.status = 'delivered';
    } else if (tab === 'completed') {
      whereClause.status = { in: ['completed', 'cancelled', 'expired'] };
    }

    const returns = await prisma.return_requests.findMany({
      where: whereClause,
      include: {
        orders: {
          select: {
            id: true,
            amount: true,
            listing_title: true,
            listing_image: true,
            stripe_payment_intent_id: true,
            buyer_id: true,
            seller_id: true,
          },
        },
        requester: {
          select: {
            id: true,
            display_name: true,
            email: true,
          },
        },
        disputes: {
          select: {
            id: true,
            status: true,
            reason_type: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    // Get stats
    const allReturns = await prisma.return_requests.findMany({
      select: { status: true },
    });

    const stats = {
      pending: allReturns.filter(r => ['pending', 'approved', 'awaiting_address', 'label_created'].includes(r.status)).length,
      in_transit: allReturns.filter(r => r.status === 'shipped').length,
      delivered: allReturns.filter(r => r.status === 'delivered').length,
      completed: allReturns.filter(r => ['completed', 'cancelled', 'expired'].includes(r.status)).length,
      total: allReturns.length,
    };

    // Format response
    const formatted = returns.map((r: any) => ({
      id: r.id,
      order_id: r.order_id,
      status: r.status,
      reason: r.reason,
      label_cost: r.label_cost ? parseFloat(r.label_cost.toString()) : null,
      paid_by: r.paid_by,
      return_label_url: r.return_label_url,
      return_tracking_number: r.return_tracking_number,
      return_carrier: r.return_carrier,
      shipped_at: r.shipped_at?.toISOString() || null,
      delivered_at: r.delivered_at?.toISOString() || null,
      completed_at: r.completed_at?.toISOString() || null,
      refund_amount: r.refund_amount ? parseFloat(r.refund_amount.toString()) : null,
      escrow_release_at: r.escrow_release_at?.toISOString() || null,
      return_ship_deadline: r.return_ship_deadline?.toISOString() || null,
      created_at: r.created_at.toISOString(),
      order: {
        id: r.orders.id,
        amount: parseFloat(r.orders.amount.toString()),
        listing_title: r.orders.listing_title,
        listing_image: r.orders.listing_image,
        buyer_id: r.orders.buyer_id,
        seller_id: r.orders.seller_id,
      },
      requester: {
        id: r.requester.id,
        display_name: r.requester.display_name,
        email: r.requester.email,
      },
      dispute: r.disputes ? {
        id: r.disputes.id,
        status: r.disputes.status,
        reason_type: r.disputes.reason_type,
      } : null,
    }));

    res.json({ returns: formatted, stats });
  } catch (error: any) {
    console.error('❌ Get returns error:', error);
    res.status(500).json({ error: 'Failed to get returns' });
  }
});

// Get single return details
router.get('/returns/:id', adminAuth, async (req, res) => {
  try {
    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: req.params.id },
      include: {
        orders: {
          select: {
            id: true,
            amount: true,
            shipping_cost: true,
            listing_title: true,
            listing_image: true,
            stripe_payment_intent_id: true,
            created_at: true,
            buyer_id: true,
            seller_id: true,
          },
        },
        requester: {
          select: {
            id: true,
            display_name: true,
            email: true,
          },
        },
        payer: {
          select: {
            id: true,
            display_name: true,
          },
        },
        disputes: {
          select: {
            id: true,
            status: true,
            reason_type: true,
            reason_text: true,
            requested_refund_percent: true,
            requested_refund_amount: true,
            resolution_type: true,
            resolution_amount: true,
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ error: 'Return not found' });
    }

    // Get buyer and seller info
    const buyer = await prisma.users.findUnique({
      where: { id: returnRequest.orders.buyer_id },
      select: { id: true, display_name: true, email: true },
    });

    const seller = await prisma.users.findUnique({
      where: { id: returnRequest.orders.seller_id },
      select: { id: true, display_name: true, email: true, stripe_connect_id: true },
    });

    const formatted = {
      id: returnRequest.id,
      order_id: returnRequest.order_id,
      status: returnRequest.status,
      reason: returnRequest.reason,
      label_cost: returnRequest.label_cost ? parseFloat(returnRequest.label_cost.toString()) : null,
      paid_by: returnRequest.paid_by,
      return_label_url: returnRequest.return_label_url,
      return_tracking_number: returnRequest.return_tracking_number,
      return_carrier: returnRequest.return_carrier,
      shippo_transaction_id: returnRequest.shippo_transaction_id,
      shipped_at: returnRequest.shipped_at?.toISOString() || null,
      delivered_at: returnRequest.delivered_at?.toISOString() || null,
      completed_at: returnRequest.completed_at?.toISOString() || null,
      refund_amount: returnRequest.refund_amount ? parseFloat(returnRequest.refund_amount.toString()) : null,
      stripe_refund_id: returnRequest.stripe_refund_id,
      escrow_release_at: returnRequest.escrow_release_at?.toISOString() || null,
      return_ship_deadline: returnRequest.return_ship_deadline?.toISOString() || null,
      created_at: returnRequest.created_at.toISOString(),
      order: {
        id: returnRequest.orders.id,
        amount: parseFloat(returnRequest.orders.amount.toString()),
        shipping_cost: returnRequest.orders.shipping_cost ? parseFloat(returnRequest.orders.shipping_cost.toString()) : 0,
        listing_title: returnRequest.orders.listing_title,
        listing_image: returnRequest.orders.listing_image,
        stripe_payment_intent_id: returnRequest.orders.stripe_payment_intent_id,
        created_at: returnRequest.orders.created_at.toISOString(),
      },
      requester: {
        id: returnRequest.requester.id,
        display_name: returnRequest.requester.display_name,
        email: returnRequest.requester.email,
      },
      payer: returnRequest.payer ? {
        id: returnRequest.payer.id,
        display_name: returnRequest.payer.display_name,
      } : null,
      buyer: buyer,
      seller: {
        ...seller,
        has_stripe: !!seller?.stripe_connect_id,
      },
      dispute: returnRequest.disputes ? {
        id: returnRequest.disputes.id,
        status: returnRequest.disputes.status,
        reason_type: returnRequest.disputes.reason_type,
        reason_text: returnRequest.disputes.reason_text,
        requested_refund_percent: returnRequest.disputes.requested_refund_percent,
        requested_refund_amount: returnRequest.disputes.requested_refund_amount ? parseFloat(returnRequest.disputes.requested_refund_amount.toString()) : null,
        resolution_type: returnRequest.disputes.resolution_type,
        resolution_amount: returnRequest.disputes.resolution_amount ? parseFloat(returnRequest.disputes.resolution_amount.toString()) : null,
      } : null,
    };

    res.json({ return: formatted });
  } catch (error: any) {
    console.error('❌ Get return detail error:', error);
    res.status(500).json({ error: 'Failed to get return details' });
  }
});

// Update return status (admin override)
router.patch('/returns/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const now = new Date();

    const updateData: any = {
      status,
      updated_at: now,
    };

    // Handle status-specific updates
    if (status === 'delivered') {
      updateData.delivered_at = now;
      // Set escrow release for 3 days from now
      updateData.escrow_release_at = new Date(now.getTime() + INSPECTION_WINDOW_MS);
    } else if (status === 'completed') {
      updateData.completed_at = now;
    } else if (status === 'cancelled') {
      updateData.completed_at = now;
    }

    const updated = await prisma.return_requests.update({
      where: { id: req.params.id },
      data: updateData,
    });

    console.log(`✅ Admin updated return ${req.params.id} to status: ${status}`);

    await logAdminAction(
      AUDIT_ACTIONS.UPDATE_RETURN,
      'return',
      req.params.id,
      { new_status: status },
      req
    );

    res.json({ success: true, return: updated });
  } catch (error: any) {
    console.error('❌ Update return error:', error);
    res.status(500).json({ error: error.message || 'Failed to update return' });
  }
});

// Process refund for return (admin action)
router.post('/returns/:id/refund', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { amount } = req.body;
    const returnId = req.params.id;

    const now = new Date();

    // Claim-the-row: lock + transition to 'refund_processing' atomically.
    // Once committed, no concurrent run (cron or admin) can claim this return.
    const claimedReturn = await prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        SELECT id, status FROM return_requests WHERE id = ${returnId} AND stripe_refund_id IS NULL AND status != 'refund_processing' AND status != 'completed' FOR UPDATE`;
      if (rows.length === 0) return null;
      const previousStatus = (rows[0] as any).status;
      await tx.return_requests.update({
        where: { id: returnId },
        data: { status: 'refund_processing', updated_at: now },
      });
      const full = await tx.return_requests.findUnique({
        where: { id: returnId },
        include: {
          orders: {
            select: {
              id: true,
              amount: true,
              quantity: true,
              stripe_payment_intent_id: true,
              listing_id: true,
            },
          },
        },
      });
      return full ? { ...full, _previousStatus: previousStatus } : null;
    });

    if (!claimedReturn) {
      const existing = await prisma.return_requests.findUnique({
        where: { id: returnId },
        select: { status: true, stripe_refund_id: true },
      });
      if (existing?.status === 'refund_processing') {
        return res.status(409).json({ error: 'A refund for this return is already in progress' });
      }
      return res.status(400).json({ error: 'Return not found or already refunded' });
    }

    if (!claimedReturn.orders.stripe_payment_intent_id) {
      await prisma.return_requests.update({ where: { id: returnId }, data: { status: claimedReturn._previousStatus, updated_at: now } });
      return res.status(400).json({ error: 'No payment intent found for this order' });
    }

    const orderAmount = parseFloat(claimedReturn.orders.amount.toString());
    const refundAmount = amount || (claimedReturn.refund_amount ? parseFloat(claimedReturn.refund_amount.toString()) : orderAmount);

    if (refundAmount > orderAmount) {
      await prisma.return_requests.update({ where: { id: returnId }, data: { status: claimedReturn._previousStatus, updated_at: now } });
      return res.status(400).json({ error: `Refund amount (£${refundAmount.toFixed(2)}) cannot exceed order amount (£${orderAmount.toFixed(2)})` });
    }
    if (refundAmount <= 0) {
      await prisma.return_requests.update({ where: { id: returnId }, data: { status: claimedReturn._previousStatus, updated_at: now } });
      return res.status(400).json({ error: 'Refund amount must be greater than zero' });
    }

    let refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent: claimedReturn.orders.stripe_payment_intent_id,
        amount: Math.round(refundAmount * 100),
        reason: 'requested_by_customer',
        metadata: {
          return_id: returnId,
          order_id: claimedReturn.order_id,
          admin_processed: 'true',
        },
      }, {
        idempotencyKey: `return_refund_${returnId}`,
      });
    } catch (stripeErr: any) {
      console.error(`❌ Stripe refund failed for return ${returnId}, reverting claim:`, stripeErr.message);
      await prisma.return_requests.update({ where: { id: returnId }, data: { status: claimedReturn._previousStatus, updated_at: now } });
      return res.status(500).json({ error: stripeErr.message || 'Stripe refund failed' });
    }

    // Final state: persist refund ID on both tables
    await prisma.$transaction([
      prisma.return_requests.update({
        where: { id: returnId },
        data: {
          status: 'completed',
          completed_at: now,
          refund_amount: refundAmount,
          stripe_refund_id: refund.id,
          updated_at: now,
        },
      }),
      prisma.orders.update({
        where: { id: claimedReturn.order_id },
        data: {
          status: 'returned',
          refunded_at: now,
          refund_amount: refundAmount,
          stripe_refund_id: refund.id,
          updated_at: now,
        },
      }),
    ]);

    if (claimedReturn.orders.listing_id) {
      await restoreListingStock(
        prisma,
        claimedReturn.orders.listing_id,
        claimedReturn.orders.quantity || 1,
        'return_refund',
      );
    }

    console.log(`✅ Admin processed refund for return ${returnId}: £${refundAmount.toFixed(2)}`);

    await logAdminAction(
      AUDIT_ACTIONS.PROCESS_REFUND,
      'return',
      returnId,
      { amount: refundAmount, stripe_refund_id: refund.id, order_id: claimedReturn.order_id },
      req
    );

    res.json({ success: true, refund_id: refund.id, amount: refundAmount });
  } catch (error: any) {
    console.error('❌ Refund return error:', error);
    res.status(500).json({ error: error.message || 'Failed to process refund' });
  }
});

// ============================================
// INSURANCE CLAIMS MANAGEMENT ROUTES (NEW)
// ============================================

// Get all orders with insurance claims
router.get('/claims', adminAuth, async (req, res) => {
  try {
    const { tab } = req.query;
    
    let whereClause: any = {
      insurance_claim_status: { not: null },
    };
    
    // Filter by tab
    if (tab === 'reported') {
      whereClause.insurance_claim_status = 'reported_lost';
    } else if (tab === 'filed') {
      whereClause.insurance_claim_status = 'claim_filed';
    } else if (tab === 'approved') {
      whereClause.insurance_claim_status = 'claim_approved';
    } else if (tab === 'denied') {
      whereClause.insurance_claim_status = 'claim_denied';
    }

    const claims = await prisma.orders.findMany({
      where: whereClause,
      include: {
        users_orders_buyer_idTousers: {
          select: {
            id: true,
            display_name: true,
            email: true,
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            display_name: true,
            email: true,
          },
        },
      },
      orderBy: { reported_lost_at: 'desc' },
    });

    // Get stats
    const allClaims = await prisma.orders.findMany({
      where: { insurance_claim_status: { not: null } },
      select: { insurance_claim_status: true },
    });

    const stats = {
      reported: allClaims.filter(c => c.insurance_claim_status === 'reported_lost').length,
      filed: allClaims.filter(c => c.insurance_claim_status === 'claim_filed').length,
      approved: allClaims.filter(c => c.insurance_claim_status === 'claim_approved').length,
      denied: allClaims.filter(c => c.insurance_claim_status === 'claim_denied').length,
      total: allClaims.length,
    };

    // Format response
    const formatted = claims.map((order: any) => ({
      id: order.id,
      listing_title: order.listing_title,
      listing_image: order.listing_image,
      amount: parseFloat(order.amount.toString()),
      shipping_cost: order.shipping_cost ? parseFloat(order.shipping_cost.toString()) : 0,
      insurance_premium: order.insurance_premium ? parseFloat(order.insurance_premium.toString()) : 0,
      insured_value: order.insured_value ? parseFloat(order.insured_value.toString()) : 0,
      insurance_claim_status: order.insurance_claim_status,
      insurance_claim_id: order.insurance_claim_id,
      tracking_number: order.tracking_number,
      carrier: order.carrier,
      shipped_at: order.shipped_at?.toISOString() || null,
      reported_lost_at: order.reported_lost_at?.toISOString() || null,
      created_at: order.created_at.toISOString(),
      buyer: {
        id: order.users_orders_buyer_idTousers?.id,
        display_name: order.users_orders_buyer_idTousers?.display_name,
        email: order.users_orders_buyer_idTousers?.email,
      },
      seller: {
        id: order.users_orders_seller_idTousers?.id,
        display_name: order.users_orders_seller_idTousers?.display_name,
        email: order.users_orders_seller_idTousers?.email,
      },
    }));

    res.json({ claims: formatted, stats });
  } catch (error: any) {
    console.error('❌ Get claims error:', error);
    res.status(500).json({ error: 'Failed to get claims' });
  }
});

// Get single claim details
router.get('/claims/:id', adminAuth, async (req, res) => {
  try {
    const order = await prisma.orders.findUnique({
      where: { id: req.params.id },
      include: {
        users_orders_buyer_idTousers: {
          select: {
            id: true,
            display_name: true,
            email: true,
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            display_name: true,
            email: true,
            stripe_connect_id: true,
          },
        },
        listings: {
          select: {
            id: true,
            title: true,
            images: {
              select: { image_url: true },
              take: 1,
              orderBy: PRIMARY_IMAGE_ORDER,
            },
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const formatted = {
      id: order.id,
      listing_id: order.listing_id,
      listing_title: order.listing_title || order.listings?.title,
      listing_image: order.listing_image || order.listings?.images?.[0]?.image_url,
      amount: parseFloat(order.amount.toString()),
      shipping_cost: order.shipping_cost ? parseFloat(order.shipping_cost.toString()) : 0,
      seller_payout: order.seller_payout ? parseFloat(order.seller_payout.toString()) : 0,
      insurance_premium: order.insurance_premium ? parseFloat(order.insurance_premium.toString()) : 0,
      insured_value: order.insured_value ? parseFloat(order.insured_value.toString()) : 0,
      insurance_claim_status: order.insurance_claim_status,
      insurance_claim_id: order.insurance_claim_id,
      status: order.status,
      tracking_number: order.tracking_number,
      carrier: order.carrier,
      label_url: order.label_url,
      shippo_transaction_id: order.shippo_transaction_id,
      shipping_address: order.shipping_address,
      stripe_payment_intent_id: order.stripe_payment_intent_id,
      paid_at: order.paid_at?.toISOString() || null,
      shipped_at: order.shipped_at?.toISOString() || null,
      reported_lost_at: order.reported_lost_at?.toISOString() || null,
      created_at: order.created_at.toISOString(),
      buyer: {
        id: order.users_orders_buyer_idTousers?.id,
        display_name: order.users_orders_buyer_idTousers?.display_name,
        email: order.users_orders_buyer_idTousers?.email,
      },
      seller: {
        id: order.users_orders_seller_idTousers?.id,
        display_name: order.users_orders_seller_idTousers?.display_name,
        email: order.users_orders_seller_idTousers?.email,
        has_stripe: !!order.users_orders_seller_idTousers?.stripe_connect_id,
      },
    };

    res.json({ claim: formatted });
  } catch (error: any) {
    console.error('❌ Get claim detail error:', error);
    res.status(500).json({ error: 'Failed to get claim details' });
  }
});

// Mark claim as filed (admin files through Shippo dashboard, then records here)
router.post('/claims/:id/file', adminAuth, async (req, res) => {
  try {
    const { claim_id, notes } = req.body;
    const now = new Date();

    const order = await prisma.orders.findUnique({
      where: { id: req.params.id },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.insurance_claim_status !== 'reported_lost') {
      return res.status(400).json({ error: 'Claim must be in reported_lost status to file' });
    }

    await prisma.orders.update({
      where: { id: req.params.id },
      data: {
        insurance_claim_status: 'claim_filed',
        insurance_claim_id: claim_id || `manual_${Date.now()}`,
        cancel_reason: notes ? `Claim filed: ${notes}` : 'Claim filed with carrier',
        updated_at: now,
      },
    });

    console.log(`📋 Admin filed insurance claim for order ${req.params.id}`);

    await logAdminAction(
      AUDIT_ACTIONS.FILE_CLAIM,
      'order',
      req.params.id,
      { claim_id: claim_id || null, notes: notes?.substring(0, 200) },
      req
    );

    res.json({ success: true, message: 'Claim marked as filed' });
  } catch (error: any) {
    console.error('❌ File claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to file claim' });
  }
});

// Approve claim and refund buyer
router.post('/claims/:id/approve', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { refund_amount, notes } = req.body;
    const now = new Date();

    const order = await prisma.orders.findUnique({
      where: { id: req.params.id },
      include: {
        users_orders_buyer_idTousers: {
          select: { id: true, display_name: true },
        },
        users_orders_seller_idTousers: {
          select: { id: true, display_name: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!['reported_lost', 'claim_filed'].includes(order.insurance_claim_status || '')) {
      return res.status(400).json({ error: 'Invalid claim status for approval' });
    }

    if (!order.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment intent found for this order' });
    }

    // Calculate refund amount (default to full order amount)
    const amount = refund_amount || parseFloat(order.amount.toString());

    // Process Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      amount: Math.round(amount * 100),
      reason: 'requested_by_customer',
      metadata: {
        order_id: order.id,
        reason: 'insurance_claim_approved',
        admin_processed: 'true',
      },
    });

    // Update order
    await prisma.orders.update({
      where: { id: req.params.id },
      data: {
        status: 'refunded',
        insurance_claim_status: 'claim_approved',
        refunded_at: now,
        refund_amount: amount,
        stripe_refund_id: refund.id,
        cancel_reason: notes ? `Claim approved: ${notes}` : 'Insurance claim approved - buyer refunded',
        updated_at: now,
      },
    });

    // Notify buyer
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.buyer_id,
        type: 'refund',
        title: 'Lost Item Claim Approved',
        message: `Your claim for "${order.listing_title}" has been approved. A refund of £${amount.toFixed(2)} has been processed.`,
        image_url: order.listing_image,
        related_id: order.id,
      },
    });

    // Notify seller
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.seller_id,
        type: 'order_update',
        title: 'Lost Item Claim Resolved',
        message: `The insurance claim for "${order.listing_title}" has been approved. The buyer has been refunded.`,
        image_url: order.listing_image,
        related_id: order.id,
      },
    });

    // ✅ Send push notifications
    sendPushNotification(
      order.buyer_id,
      'Lost Item Claim Approved ✅',
      `Your claim for "${order.listing_title}" has been approved. Refund: £${amount.toFixed(2)}`,
      { type: 'claim_approved', orderId: order.id }
    );
    
    sendPushNotification(
      order.seller_id,
      'Lost Item Claim Resolved',
      `The claim for "${order.listing_title}" has been approved. The buyer has been refunded.`,
      { type: 'claim_approved', orderId: order.id }
    );

    // ✅ Send emails
    const buyer = order.users_orders_buyer_idTousers;
    const seller = order.users_orders_seller_idTousers;
    
    // Get buyer email
    const buyerFull = await prisma.users.findUnique({
      where: { id: order.buyer_id },
      select: { email: true }
    });
    
    // Get seller email
    const sellerFull = await prisma.users.findUnique({
      where: { id: order.seller_id },
      select: { email: true }
    });

    if (buyerFull?.email) {
      sendInsuranceClaimApprovedToBuyer(buyerFull.email, {
        buyerName: buyer?.display_name || 'there',
        itemTitle: order.listing_title || 'your item',
        refundAmount: amount.toFixed(2),
        orderNumber: order.id,
        itemImageUrl: order.listing_image || '',
        itemBrand: '',
        itemCondition: '',
        itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
      }).catch(err => console.error('Email error:', err));
    }

    if (sellerFull?.email) {
      sendInsuranceClaimApprovedToSeller(sellerFull.email, {
        sellerName: seller?.display_name || 'there',
        itemTitle: order.listing_title || 'the item',
        buyerName: buyer?.display_name || 'The buyer',
        orderNumber: order.id,
        itemImageUrl: order.listing_image || '',
        itemBrand: '',
        itemCondition: '',
        itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
      }).catch(err => console.error('Email error:', err));
    }

    console.log(`✅ Admin approved insurance claim for order ${req.params.id}, refunded £${amount.toFixed(2)}`);

    await logAdminAction(
      AUDIT_ACTIONS.APPROVE_CLAIM,
      'order',
      req.params.id,
      { amount, stripe_refund_id: refund.id, notes: notes?.substring(0, 200) },
      req
    );

    res.json({ success: true, refund_id: refund.id, amount });
  } catch (error: any) {
    console.error('❌ Approve claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to approve claim' });
  }
});

// Deny claim
router.post('/claims/:id/deny', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { reason } = req.body;
    const now = new Date();

    if (!reason) {
      return res.status(400).json({ error: 'Denial reason is required' });
    }

    const order = await prisma.orders.findUnique({
      where: { id: req.params.id },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update order - keep status as in_transit since no refund
    await prisma.orders.update({
      where: { id: req.params.id },
      data: {
        insurance_claim_status: 'claim_denied',
        cancel_reason: `Claim denied: ${reason}`,
        updated_at: now,
      },
    });

    // Notify buyer
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.buyer_id,
        type: 'order_update',
        title: 'Lost Item Claim Update',
        message: `Your claim for "${order.listing_title}" could not be approved. Reason: ${reason}. Please contact support if you have questions.`,
        image_url: order.listing_image,
        related_id: order.id,
      },
    });

    // Notify seller too
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.seller_id,
        type: 'order_update',
        title: 'Lost Item Claim Resolved',
        message: `The lost item claim for "${order.listing_title}" was not approved. Your payout will proceed as normal.`,
        image_url: order.listing_image,
        related_id: order.id,
      },
    });

    // Send push notifications
    sendPushNotification(
      order.buyer_id,
      'Lost Item Claim Update',
      `Your claim for "${order.listing_title}" could not be approved.`,
      { type: 'claim_denied', orderId: order.id }
    );
    
    sendPushNotification(
      order.seller_id,
      'Lost Item Claim Resolved ✅',
      `The claim for "${order.listing_title}" was denied. Your payout will proceed normally.`,
      { type: 'claim_denied', orderId: order.id }
    );

    // Send emails
    const buyerFull = await prisma.users.findUnique({
      where: { id: order.buyer_id },
      select: { email: true, display_name: true }
    });
    
    const sellerFull = await prisma.users.findUnique({
      where: { id: order.seller_id },
      select: { email: true, display_name: true }
    });

    if (buyerFull?.email) {
      sendInsuranceClaimDeniedToBuyer(buyerFull.email, {
        buyerName: buyerFull.display_name || 'there',
        itemTitle: order.listing_title || 'your item',
        reason: reason,
        orderNumber: order.id,
        itemImageUrl: order.listing_image || '',
        itemBrand: '',
        itemCondition: '',
        itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
      }).catch(err => console.error('Email error:', err));
    }

    if (sellerFull?.email) {
      sendInsuranceClaimDeniedToSeller(sellerFull.email, {
        sellerName: sellerFull.display_name || 'there',
        itemTitle: order.listing_title || 'the item',
        orderNumber: order.id,
        itemImageUrl: order.listing_image || '',
        itemBrand: '',
        itemCondition: '',
        itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
      }).catch(err => console.error('Email error:', err));
    }

    console.log(`❌ Admin denied insurance claim for order ${req.params.id}: ${reason}`);

    await logAdminAction(
      AUDIT_ACTIONS.DENY_CLAIM,
      'order',
      req.params.id,
      { reason: reason?.substring(0, 200) },
      req
    );

    res.json({ success: true, message: 'Claim denied' });
  } catch (error: any) {
    console.error('❌ Deny claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to deny claim' });
  }
});


// ============================================
// USER MANAGEMENT ROUTES (Batch 3)
// ============================================

// Get all users with search, filter, and pagination
router.get('/users', adminAuth, async (req, res) => {
  try {
    const {
      search = '',
      filter = 'all',
      page = '1',
      limit = '25',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};

    if (search) {
      where.OR = [
        { display_name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (filter === 'verified') {
      where.is_verified_seller = true;
    } else if (filter === 'banned') {
      where.is_banned = true;
    }

    const [users, totalCount] = await Promise.all([
      prisma.users.findMany({
        where,
        select: {
          id: true,
          display_name: true,
          email: true,
          avatar_url: true,
          is_verified_seller: true,
          is_banned: true,
          ban_reason: true,
          total_sales: true,
          total_purchases: true,
          rating: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.users.count({ where }),
    ]);

    const [totalUsers, activeSellers, verifiedSellers, bannedUsers] = await Promise.all([
      prisma.users.count(),
      prisma.users.count({ where: { total_sales: { gt: 0 } } }),
      prisma.users.count({ where: { is_verified_seller: true } }),
      prisma.users.count({ where: { is_banned: true } }),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      users: users.map((u: any) => ({
        ...u,
        rating: u.rating ? parseFloat(u.rating.toString()) : null,
      })),
      page: pageNum,
      totalPages,
      totalCount,
      stats: {
        totalUsers,
        activeSellers,
        verifiedSellers,
        bannedUsers,
      },
    });
  } catch (error: any) {
    console.error('❌ Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user details with orders, reports, and listings
router.get('/users/:id', adminAuth, async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        display_name: true,
        email: true,
        avatar_url: true,
        location: true,
        bio: true,
        is_verified_seller: true,
        is_banned: true,
        ban_reason: true,
        rating: true,
        total_sales: true,
        total_purchases: true,
        shipping_strikes: true,
        buyer_cancellation_count: true,
        seller_cancellation_count: true,
        stripe_connect_id: true,
        stripe_connect_status: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const recentOrders = await prisma.orders.findMany({
      where: {
        OR: [
          { buyer_id: req.params.id },
          { seller_id: req.params.id },
        ],
      },
      select: {
        id: true,
        listing_title: true,
        amount: true,
        status: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    const reportsAgainst = await prisma.user_reports.findMany({
      where: { reported_user_id: req.params.id },
      select: {
        id: true,
        reason: true,
        details: true,
        status: true,
        created_at: true,
        reporter: {
          select: { display_name: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    const listings = await prisma.listings.findMany({
      where: { seller_id: req.params.id },
      select: {
        id: true,
        title: true,
        price: true,
        status: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    res.json({
      user: {
        ...user,
        rating: user.rating ? parseFloat(user.rating.toString()) : null,
      },
      recentOrders: recentOrders.map((o: any) => ({
        ...o,
        amount: parseFloat(o.amount.toString()),
      })),
      reportsAgainst,
      listings: listings.map((l: any) => ({
        ...l,
        price: parseFloat(l.price.toString()),
      })),
    });
  } catch (error: any) {
    console.error('❌ Get user detail error:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Ban user
router.post('/users/:id/ban', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Ban reason is required' });
    }

    const user = await prisma.users.findUnique({
      where: { id: req.params.id },
      select: { id: true, display_name: true, is_banned: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.is_banned) {
      return res.status(400).json({ error: 'User is already banned' });
    }

    const now = new Date();

    await prisma.users.update({
      where: { id: req.params.id },
      data: {
        is_banned: true,
        ban_reason: reason,
        banned_at: now,
        updated_at: now,
      },
    });

    await prisma.listings.updateMany({
      where: { seller_id: req.params.id, status: 'active' },
      data: { status: 'inactive', updated_at: now },
    });

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: req.params.id,
        type: 'account',
        title: 'Account Suspended',
        message: `Your account has been suspended for violating our terms of service. Reason: ${reason}`,
      },
    });

    console.log(`🚫 Admin banned user ${req.params.id}: ${reason}`);

    await logAdminAction(
      AUDIT_ACTIONS.BAN_USER,
      'user',
      req.params.id,
      { reason, display_name: user.display_name },
      req
    );

    res.json({ success: true, message: 'User banned and listings deactivated' });
  } catch (error: any) {
    console.error('❌ Ban user error:', error);
    res.status(500).json({ error: error.message || 'Failed to ban user' });
  }
});

// Unban user
router.post('/users/:id/unban', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: req.params.id },
      select: { id: true, display_name: true, is_banned: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.is_banned) {
      return res.status(400).json({ error: 'User is not banned' });
    }

    await prisma.users.update({
      where: { id: req.params.id },
      data: {
        is_banned: false,
        ban_reason: null,
        banned_at: null,
        updated_at: new Date(),
      },
    });

    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: req.params.id,
        type: 'account',
        title: 'Account Reinstated',
        message: 'Your account has been reinstated. You can now use Mulligans again.',
      },
    });

    console.log(`✅ Admin unbanned user ${req.params.id}`);

    await logAdminAction(
      AUDIT_ACTIONS.UNBAN_USER,
      'user',
      req.params.id,
      { display_name: user.display_name },
      req
    );

    res.json({ success: true, message: 'User unbanned' });
  } catch (error: any) {
    console.error('❌ Unban user error:', error);
    res.status(500).json({ error: error.message || 'Failed to unban user' });
  }
});

// Verify seller
router.post('/users/:id/verify', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    await prisma.users.update({
      where: { id: req.params.id },
      data: {
        is_verified_seller: true,
        verified_seller_at: new Date(),
        updated_at: new Date(),
      },
    });

    console.log(`✅ Admin verified seller ${req.params.id}`);

    await logAdminAction(AUDIT_ACTIONS.VERIFY_SELLER, 'user', req.params.id, null, req);

    res.json({ success: true, message: 'Seller verified' });
  } catch (error: any) {
    console.error('❌ Verify seller error:', error);
    res.status(500).json({ error: 'Failed to verify seller' });
  }
});

// Remove seller verification
router.post('/users/:id/unverify', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    await prisma.users.update({
      where: { id: req.params.id },
      data: {
        is_verified_seller: false,
        verified_seller_at: null,
        updated_at: new Date(),
      },
    });

    console.log(`📋 Admin removed verification for ${req.params.id}`);

    await logAdminAction(AUDIT_ACTIONS.UNVERIFY_SELLER, 'user', req.params.id, null, req);

    res.json({ success: true, message: 'Seller verification removed' });
  } catch (error: any) {
    console.error('❌ Unverify seller error:', error);
    res.status(500).json({ error: 'Failed to remove verification' });
  }
});

// ============================================
// LISTING MODERATION (Batch 5)
// ============================================

// Deactivate or reactivate a listing
router.patch('/listings/:id/moderate', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { action, reason } = req.body;

    if (!action || !['deactivate', 'reactivate'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "deactivate" or "reactivate"' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const listing = await prisma.listings.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, status: true, seller_id: true },
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const newStatus = action === 'deactivate' ? 'inactive' : 'active';

    await prisma.listings.update({
      where: { id: req.params.id },
      data: { status: newStatus, updated_at: new Date() },
    });

    // Notify the seller
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: listing.seller_id,
        type: 'listing',
        title: action === 'deactivate' ? 'Listing Removed' : 'Listing Reinstated',
        message: action === 'deactivate'
          ? `Your listing "${listing.title}" has been removed. Reason: ${reason}`
          : `Your listing "${listing.title}" has been reinstated.`,
        related_id: listing.id,
      },
    });

    console.log(`📋 Admin ${action}d listing ${req.params.id}: ${reason}`);

    await logAdminAction(
      AUDIT_ACTIONS.MODERATE_LISTING,
      'listing',
      req.params.id,
      { action, reason, title: listing.title, previous_status: listing.status },
      req
    );

    res.json({ success: true, message: `Listing ${action}d` });
  } catch (error: any) {
    console.error('❌ Moderate listing error:', error);
    res.status(500).json({ error: error.message || 'Failed to moderate listing' });
  }
});


// Get all pro store applications (paginated, filterable)
router.get('/pro-store/applications', adminAuth, async (req, res) => {
  try {
    const { status, page = '1', limit = '20' } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (status && ['pending', 'approved', 'rejected', 'info_requested'].includes(status)) {
      where.status = status;
    }

    const [applications, total] = await Promise.all([
      prisma.pro_store_applications.findMany({
        where,
        include: {
          user: {
            select: {
              email: true,
              display_name: true,
              avatar_url: true,
              created_at: true,
              total_sales: true,
              is_verified_seller: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limitNum,
        skip,
      }),
      prisma.pro_store_applications.count({ where }),
    ]);

    res.json({
      applications,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error: any) {
    console.error('❌ Get pro store applications error:', error);
    res.status(500).json({ error: 'Failed to fetch pro store applications' });
  }
});


// Get single pro store application detail (includes review_notes)
router.get('/pro-store/applications/:id', adminAuth, async (req, res) => {
  try {
    const application = await prisma.pro_store_applications.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            email: true,
            display_name: true,
            avatar_url: true,
            total_sales: true,
            is_verified_seller: true,
            created_at: true,
            is_banned: true,
          },
        },
      },
    });

    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    res.json({ application });
  } catch (error: any) {
    console.error('❌ Get pro store application detail error:', error);
    res.status(500).json({ error: 'Failed to fetch application details' });
  }
});


// Review a pro store application (approve / reject / info_requested)
router.patch('/pro-store/applications/:id/review', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const { action, review_notes } = req.body;

    if (!action || !['approve', 'reject', 'info_requested'].includes(action)) {
      res.status(400).json({ error: 'action must be one of: approve, reject, info_requested' });
      return;
    }

    const application = await prisma.pro_store_applications.findUnique({
      where: { id: req.params.id },
    });

    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    // Status mapping — action values map to correct status strings
const STATUS_MAP: Record<string, string> = {
  approve: 'approved',
  reject: 'rejected',
  info_requested: 'info_requested',
};

// Run as a single transaction
const updatedApplication = await prisma.$transaction(async (tx) => {
  // a. Update the application
  const updated = await tx.pro_store_applications.update({
    where: { id: req.params.id },
    data: {
      status: STATUS_MAP[action],
      review_notes: review_notes || null,
      reviewed_by: 'admin',
      reviewed_at: new Date(),
    },
  });

  // b. If approved, update the user
  if (action === 'approve') {
    await tx.users.update({
      where: { id: application.user_id },
      data: {
        is_pro_store: true,
        pro_store_approved_at: new Date(),
      },
    });
  } 

      // c. Write to audit log
      await tx.admin_audit_log.create({
        data: {
          action: `pro_store_${action}`,
          target_type: 'user',
          target_id: application.user_id,
          details: {
            application_id: application.id,
            business_name: application.business_name,
            review_notes: review_notes || null,
          },
          admin_ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
            || req.socket.remoteAddress
            || 'unknown',
        },
      });

      return updated;
    });

    res.json({ application: updatedApplication });
  } catch (error: any) {
    console.error('❌ Review pro store application error:', error);
    res.status(500).json({ error: 'Failed to review application' });
  }
});

// DASHBOARD STATS ROUTES
// ============================================

// Get platform overview stats (users, listings, orders, GMV, etc.)
router.get('/stats', adminAuth, AdminStatsController.getStats);

// Get chart data (orders/revenue/signups over time)
router.get('/stats/charts', adminAuth, AdminStatsController.getChartData);

// Get detailed analytics stats (Batch 4)
router.get('/stats/detailed', adminAuth, AdminStatsController.getDetailedStats);

// ============================================
// AUDIT LOG ROUTES (Batch 5)
// ============================================

// Get recent admin actions
router.get('/audit-log', adminAuth, async (req, res) => {
  try {
    const { limit = '50', offset = '0', action, target_type } = req.query as Record<string, string>;

    const where: any = {};
    if (action) where.action = action;
    if (target_type) where.target_type = target_type;

    const [logs, total] = await Promise.all([
      prisma.admin_audit_log.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: Math.min(100, parseInt(limit, 10) || 50),
        skip: parseInt(offset, 10) || 0,
      }),
      prisma.admin_audit_log.count({ where }),
    ]);

    res.json({ logs, total });
  } catch (error: any) {
    console.error('❌ Get audit log error:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ============================================
// STUCK ORDERS (PAYOUT BLOCKED)
// Orders where seller hasn't completed Stripe onboarding
// ============================================
router.get('/stuck-orders', adminAuth, async (req, res) => {
  try {
    const stuckOrders = await prisma.orders.findMany({
      where: {
        payout_blocked_at: { not: null },
        status: 'delivered',
        stripe_transfer_id: null,
      },
      include: {
        listings: {
          select: {
            id: true,
            title: true,
            images: { take: 1, orderBy: { display_order: 'asc' as const } },
          },
        },
        users_orders_seller_idTousers: {
          select: {
            id: true,
            display_name: true,
            email: true,
            stripe_connect_id: true,
            stripe_connect_status: true,
          },
        },
        users_orders_buyer_idTousers: {
          select: { id: true, display_name: true, email: true },
        },
      },
      orderBy: { payout_blocked_at: 'asc' },
    });

    const now = new Date();

    res.json({
      count: stuckOrders.length,
      orders: stuckOrders.map(o => {
        const blockedAt = new Date(o.payout_blocked_at!);
        const daysBlocked = Math.floor((now.getTime() - blockedAt.getTime()) / (24 * 60 * 60 * 1000));
        const seller = o.users_orders_seller_idTousers;
        const buyer = o.users_orders_buyer_idTousers;

        return {
          id: o.id,
          amount: parseFloat(o.amount.toString()),
          listing_title: o.listing_title || o.listings?.title || null,
          listing_image: o.listings?.images?.[0]?.image_url || o.listing_image || null,
          blocked_since: o.payout_blocked_at,
          days_blocked: daysBlocked,
          last_reminder_sent: o.payout_reminder_sent_at,
          delivered_at: o.delivered_at,
          created_at: o.created_at,
          seller: {
            id: seller.id,
            name: seller.display_name,
            email: seller.email,
            stripe_connect_status: seller.stripe_connect_status || 'none',
            has_connect_id: !!seller.stripe_connect_id,
          },
          buyer: {
            id: buyer.id,
            name: buyer.display_name,
            email: buyer.email,
          },
          escalated: daysBlocked >= 14,
        };
      }),
    });
  } catch (error: any) {
    console.error('Failed to fetch stuck orders:', error);
    res.status(500).json({ error: 'Failed to fetch stuck orders' });
  }
});

// ============================================
// ADMIN: FULL REFUND INCLUDING FEES
// Refunds the buyer's ENTIRE payment (item + shipping + protection fee + service fee).
// Admin-only safety valve for chargebacks, platform-fault, legal, or goodwill.
// ============================================
router.post('/orders/:id/full-refund', adminAuth, adminActionLimiter, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { reason } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'A reason is required for full refund override' });
    }

    const now = new Date();

    // Claim-the-row: lock order + verify it hasn't already been refunded
    const claimedOrder = await prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        SELECT id, status FROM orders
        WHERE id = ${orderId}
        AND stripe_refund_id IS NULL
        AND status NOT IN ('refunded', 'cancelled')
        FOR UPDATE`;
      if (rows.length === 0) return null;

      const previousStatus = (rows[0] as any).status;
      return tx.orders.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          amount: true,
          buyer_total: true,
          shipping_cost: true,
          seller_payout: true,
          listing_title: true,
          listing_image: true,
          buyer_id: true,
          seller_id: true,
          stripe_payment_intent_id: true,
          stripe_refund_id: true,
          status: true,
        },
      }).then(order => order ? { ...order, _previousStatus: previousStatus } : null);
    });

    if (!claimedOrder) {
      const existing = await prisma.orders.findUnique({
        where: { id: orderId },
        select: { status: true, stripe_refund_id: true },
      });

      if (existing?.stripe_refund_id) {
        return res.status(409).json({ error: 'This order has already been refunded' });
      }
      if (existing?.status === 'refunded' || existing?.status === 'cancelled') {
        return res.status(409).json({ error: `Order is already ${existing.status}` });
      }
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!claimedOrder.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment intent found for this order' });
    }

    // Calculate FULL refund amount: buyer_total (everything the buyer paid)
    // Fallback chain: buyer_total → amount (for legacy orders where buyer_total wasn't tracked)
    const fullRefundAmount = claimedOrder.buyer_total
      ? parseFloat(claimedOrder.buyer_total.toString())
      : parseFloat(claimedOrder.amount.toString());

    if (fullRefundAmount <= 0) {
      return res.status(400).json({ error: 'Refund amount must be greater than zero' });
    }

    console.log(`[ADMIN-FULL-REFUND] Processing full refund for order ${orderId}`);
    console.log(`  buyer_total: £${claimedOrder.buyer_total ? parseFloat(claimedOrder.buyer_total.toString()).toFixed(2) : 'N/A'}`);
    console.log(`  amount (item): £${parseFloat(claimedOrder.amount.toString()).toFixed(2)}`);
    console.log(`  Full refund: £${fullRefundAmount.toFixed(2)}`);
    console.log(`  Reason: ${reason.trim()}`);

    // Process Stripe refund
    let refundId: string;
    try {
      const refund = await stripe.refunds.create({
        payment_intent: claimedOrder.stripe_payment_intent_id,
        amount: Math.round(fullRefundAmount * 100),
        reason: 'requested_by_customer',
        metadata: {
          order_id: orderId,
          resolution: 'admin_full_refund',
          reason: reason.trim().slice(0, 500),
          includes_fees: 'true',
        },
      }, {
        idempotencyKey: `admin_full_refund_${orderId}`,
      });

      refundId = refund.id;
      console.log(`[ADMIN-FULL-REFUND] ✅ Stripe refund ${refund.id}: £${fullRefundAmount.toFixed(2)}`);
    } catch (refundErr: any) {
      console.error(`[ADMIN-FULL-REFUND] ❌ Stripe refund failed:`, refundErr.message);
      return res.status(500).json({ error: `Stripe refund failed: ${refundErr.message}` });
    }

    // Update order
    await prisma.orders.update({
      where: { id: orderId },
      data: {
        status: 'refunded',
        refunded_at: now,
        refund_amount: fullRefundAmount,
        stripe_refund_id: refundId,
        updated_at: now,
      },
    });

    // Audit log
    await logAdminAction(
      'admin_full_refund',
      'order',
      orderId,
      {
        reason: reason.trim(),
        refund_amount: fullRefundAmount,
        stripe_refund_id: refundId,
        buyer_total: claimedOrder.buyer_total ? parseFloat(claimedOrder.buyer_total.toString()) : null,
        item_amount: parseFloat(claimedOrder.amount.toString()),
        seller_payout: claimedOrder.seller_payout ? parseFloat(claimedOrder.seller_payout.toString()) : null,
        previous_status: claimedOrder._previousStatus,
        includes_fees_and_shipping: true,
      },
      req
    );

    // Notify buyer
    const listingTitle = claimedOrder.listing_title || 'Your item';
    try {
      await prisma.notifications.create({
        data: {
          id: crypto.randomUUID(),
          user_id: claimedOrder.buyer_id,
          type: 'refund',
          title: 'Full Refund Issued',
          message: `A full refund of £${fullRefundAmount.toFixed(2)} for "${listingTitle}" has been issued to your original payment method.`,
          image_url: claimedOrder.listing_image,
          related_id: orderId,
        },
      });

      await sendPushNotification(
        claimedOrder.buyer_id,
        'Full Refund Issued',
        `£${fullRefundAmount.toFixed(2)} refund for "${listingTitle}" is on its way.`,
        { type: 'refund', order_id: orderId }
      );
    } catch (notifErr) {
      console.error('[ADMIN-FULL-REFUND] Notification failed (non-fatal):', notifErr);
    }

    console.log(`[ADMIN-FULL-REFUND] ✅ Complete — order ${orderId} fully refunded £${fullRefundAmount.toFixed(2)}`);

    res.json({
      success: true,
      data: {
        orderId,
        refundAmount: fullRefundAmount,
        stripeRefundId: refundId,
        reason: reason.trim(),
        message: `Full refund of £${fullRefundAmount.toFixed(2)} processed (includes all fees and shipping).`,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN-FULL-REFUND] ❌ Error:', error);
    res.status(500).json({ error: 'Failed to process full refund' });
  }
});

export default router;