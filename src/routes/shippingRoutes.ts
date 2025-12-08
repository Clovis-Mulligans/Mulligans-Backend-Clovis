// src/routes/shippingRoutes.ts
// Routes for shipping functionality (Shippo integration)

import express from 'express';
import {
  getParcelSizes,
  getShippingRates,
  createShippingLabel,
  getTrackingInfo,
  markAsShipped,
  handleShippoWebhook,
} from '../controllers/shippingController';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// ============================================
// PUBLIC ROUTES
// ============================================

// Get available parcel sizes with default prices
// GET /api/shipping/parcel-sizes
router.get('/parcel-sizes', getParcelSizes);

// Shippo webhook (no auth - called by Shippo)
// POST /api/shipping/webhook
router.post('/webhook', handleShippoWebhook);

// ============================================
// AUTHENTICATED ROUTES
// ============================================

// Get shipping rates for an order (seller only)
// POST /api/shipping/rates
router.post('/rates', authenticateToken, getShippingRates);

// Create shipping label (seller only)
// POST /api/shipping/labels
router.post('/labels', authenticateToken, createShippingLabel);

// Get tracking info for an order (buyer or seller)
// GET /api/shipping/tracking/:orderId
router.get('/tracking/:orderId', authenticateToken, getTrackingInfo);

// Mark order as shipped (seller only)
// POST /api/shipping/mark-shipped
router.post('/mark-shipped', authenticateToken, markAsShipped);

export default router;