// src/routes/stripeConnectRoutes.ts
import { Router } from 'express';
import { StripeConnectController } from '../controllers/stripeConnectController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.post('/create-account', authenticateToken, StripeConnectController.createAccount);
router.post('/onboarding-link', authenticateToken, StripeConnectController.createOnboardingLink);
router.get('/account-status', authenticateToken, StripeConnectController.getAccountStatus);
router.get('/dashboard-link', authenticateToken, StripeConnectController.getDashboardLink);
router.get('/balance', authenticateToken, StripeConnectController.getBalance);

export default router;