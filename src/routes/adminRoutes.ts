// src/routes/adminRoutes.ts
// Admin panel routes for dispute management

import express from 'express';
import path from 'path';
import { adminAuth, verifyAdminPassword } from '../middleware/adminAuth';
import { DisputeController } from '../controllers/disputeController';
import { AdminReportsController } from '../controllers/adminReportsController';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { sendPushNotification } from '../controllers/pushNotificationController';
import { 
  sendInsuranceClaimApprovedToBuyer, 
  sendInsuranceClaimApprovedToSeller,
  sendInsuranceClaimDeniedToBuyer,
  sendInsuranceClaimDeniedToSeller
} from '../services/emailService';

import rateLimit from 'express-rate-limit';

// Admin login rate limiter - 5 attempts per 15 minutes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many admin login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Serve admin panel HTML
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/admin.html'));
});

// Verify admin password
router.post('/verify', adminLimiter, verifyAdminPassword);

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

    res.json({ dispute: formatted });
  } catch (error: any) {
    console.error('❌ Get dispute detail error:', error);
    res.status(500).json({ error: 'Failed to get dispute details' });
  }
});

// Resolve dispute
router.put('/disputes/:id/resolve', adminAuth, DisputeController.adminResolveDispute);

// Report management routes (MOVE THESE BEFORE EXPORT)
router.get('/reports', adminAuth, AdminReportsController.getReports);
router.get('/reports/:id', adminAuth, AdminReportsController.getReport);
router.patch('/reports/:id', adminAuth, AdminReportsController.updateReport);
router.post('/reports/:id/ban-user', adminAuth, AdminReportsController.banUser);

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
      updateData.escrow_release_at = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
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
    
    res.json({ success: true, return: updated });
  } catch (error: any) {
    console.error('❌ Update return error:', error);
    res.status(500).json({ error: error.message || 'Failed to update return' });
  }
});

// Process refund for return (admin action)
router.post('/returns/:id/refund', adminAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    
    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: req.params.id },
      include: {
        orders: {
          select: {
            id: true,
            amount: true,
            stripe_payment_intent_id: true,
            listing_id: true,
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ error: 'Return not found' });
    }

    if (returnRequest.stripe_refund_id) {
      return res.status(400).json({ error: 'Return already refunded' });
    }

    if (!returnRequest.orders.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment intent found for this order' });
    }

    // Calculate refund amount
    const refundAmount = amount || (returnRequest.refund_amount ? parseFloat(returnRequest.refund_amount.toString()) : parseFloat(returnRequest.orders.amount.toString()));

    // Process Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: returnRequest.orders.stripe_payment_intent_id,
      amount: Math.round(refundAmount * 100),
      reason: 'requested_by_customer',
      metadata: {
        return_id: returnRequest.id,
        order_id: returnRequest.order_id,
        admin_processed: 'true',
      },
    });

    const now = new Date();

    // Update return request
    await prisma.return_requests.update({
      where: { id: req.params.id },
      data: {
        status: 'completed',
        completed_at: now,
        refund_amount: refundAmount,
        stripe_refund_id: refund.id,
        updated_at: now,
      },
    });

    // Update order status
    await prisma.orders.update({
      where: { id: returnRequest.order_id },
      data: {
        status: 'returned',
        refunded_at: now,
        refund_amount: refundAmount,
        stripe_refund_id: refund.id,
        updated_at: now,
      },
    });

    // Relist the item if listing exists
    if (returnRequest.orders.listing_id) {
      await prisma.listings.update({
        where: { id: returnRequest.orders.listing_id },
        data: {
          status: 'active',
          updated_at: now,
        },
      });
    }

    console.log(`✅ Admin processed refund for return ${req.params.id}: £${refundAmount.toFixed(2)}`);
    
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
              orderBy: { display_order: 'asc' },
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
    
    res.json({ success: true, message: 'Claim marked as filed' });
  } catch (error: any) {
    console.error('❌ File claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to file claim' });
  }
});

// Approve claim and refund buyer
router.post('/claims/:id/approve', adminAuth, async (req, res) => {
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
      }).catch(err => console.error('Email error:', err));
    }

    if (sellerFull?.email) {
      sendInsuranceClaimApprovedToSeller(sellerFull.email, {
        sellerName: seller?.display_name || 'there',
        itemTitle: order.listing_title || 'the item',
        buyerName: buyer?.display_name || 'The buyer',
        orderNumber: order.id,
      }).catch(err => console.error('Email error:', err));
    }

    console.log(`✅ Admin approved insurance claim for order ${req.params.id}, refunded £${amount.toFixed(2)}`);
    
    res.json({ success: true, refund_id: refund.id, amount });
  } catch (error: any) {
    console.error('❌ Approve claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to approve claim' });
  }
});

// Deny claim
router.post('/claims/:id/deny', adminAuth, async (req, res) => {
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
      }).catch(err => console.error('Email error:', err));
    }

    if (sellerFull?.email) {
      sendInsuranceClaimDeniedToSeller(sellerFull.email, {
        sellerName: sellerFull.display_name || 'there',
        itemTitle: order.listing_title || 'the item',
        orderNumber: order.id,
      }).catch(err => console.error('Email error:', err));
    }

    console.log(`❌ Admin denied insurance claim for order ${req.params.id}: ${reason}`);
    
    res.json({ success: true, message: 'Claim denied' });
  } catch (error: any) {
    console.error('❌ Deny claim error:', error);
    res.status(500).json({ error: error.message || 'Failed to deny claim' });
  }
});

export default router;