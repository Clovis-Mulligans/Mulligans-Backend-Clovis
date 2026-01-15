// src/routes/adminRoutes.ts
// Admin panel routes for dispute management

import express from 'express';
import path from 'path';
import { adminAuth, verifyAdminPassword } from '../middleware/adminAuth';
import { DisputeController } from '../controllers/disputeController';
import { AdminReportsController } from '../controllers/adminReportsController';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

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
router.post('/verify', verifyAdminPassword);

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

export default router;