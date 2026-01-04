// src/routes/adminRoutes.ts
// Admin panel routes for dispute management

import express from 'express';
import path from 'path';
import { adminAuth, verifyAdminPassword } from '../middleware/adminAuth';
import { DisputeController } from '../controllers/disputeController';

const router = express.Router();

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
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
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

export default router;