// src/routes/stripeRoutes.ts
import { Router } from 'express';
import { StripeController } from '../controllers/stripeController';
import { authenticateToken } from '../middleware/auth';
import express from 'express';
import { CartCheckoutController } from '../controllers/cartCheckoutController';

const router = Router();

// Create checkout session (protected - user must be logged in)
router.post(
  '/create-checkout-session',
  authenticateToken,
  StripeController.createCheckoutSession
);

// NEW: Cart checkout session (protected - user must be logged in)
router.post(
  '/create-cart-checkout',
  authenticateToken,
  CartCheckoutController.createCartCheckoutSession
);

// Webhook endpoint (NOT protected - Stripe calls this)
// IMPORTANT: Must use raw body for webhook signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  StripeController.handleWebhook
);

export default router;