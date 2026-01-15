// src/routes/returnRoutes.ts
// Routes for return label system

import express from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  checkSellerStripeStatus,
  createReturnRequest,
  getReturnShippingRates,
  purchaseReturnLabelBuyer,
  purchaseReturnLabelSeller,
  markReturnShipped,
  confirmReturnDelivered,
  getReturnRequest,
} from '../controllers/returnController';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Check if seller has completed Stripe setup with address
router.get('/seller-status/:orderId', checkSellerStripeStatus);

// Create a return request (when return is approved)
router.post('/create', createReturnRequest);

// Get shipping rates for return
router.post('/rates', getReturnShippingRates);

// Purchase return label - buyer pays (deducted from refund)
router.post('/purchase-label/buyer', purchaseReturnLabelBuyer);

// Purchase return label - seller pays (charged via Stripe)
router.post('/purchase-label/seller', purchaseReturnLabelSeller);

// Mark return as shipped (buyer)
router.post('/mark-shipped', markReturnShipped);

// Confirm return delivered (seller)
router.post('/confirm-delivered', confirmReturnDelivered);

// Get return request details
router.get('/:returnId', getReturnRequest);

export default router;