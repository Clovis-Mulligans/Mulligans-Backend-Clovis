// src/routes/stripeRoutes.ts
import { Router } from 'express';
import { StripeController } from '../controllers/stripeController';
import { authenticateToken } from '../middleware/auth';
import express from 'express';
import { CartCheckoutController } from '../controllers/cartCheckoutController';
import { NativePaymentController } from '../controllers/nativePaymentController';

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

// ✅ NEW: Native Payment (Apple Pay / Google Pay) routes
router.post(
  '/native-payment/single-item',
  authenticateToken,
  NativePaymentController.createSingleItemPaymentIntent
);

router.post(
  '/native-payment/cart',
  authenticateToken,
  NativePaymentController.createCartPaymentIntent
);

router.post(
  '/native-payment/fulfill',
  authenticateToken,
  NativePaymentController.confirmPayment  // ← FIXED: was fulfillNativePayment
);

// Webhook endpoint (NOT protected - Stripe calls this)
// IMPORTANT: Must use raw body for webhook signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  StripeController.handleWebhook
);

export default router;