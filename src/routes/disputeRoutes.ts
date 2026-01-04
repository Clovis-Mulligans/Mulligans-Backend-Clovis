// src/routes/disputeRoutes.ts
import express from 'express';
import { DisputeController } from '../controllers/disputeController';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// ============================================
// BUYER ENDPOINTS
// ============================================

// Open a new dispute (buyer only)
// POST /api/disputes
router.post('/', authenticateToken, DisputeController.openDispute);

// Get dispute by order ID
// GET /api/disputes/order/:orderId
router.get('/order/:orderId', authenticateToken, DisputeController.getDisputeByOrder);

// Get dispute details
// GET /api/disputes/:id
router.get('/:id', authenticateToken, DisputeController.getDispute);

// Buyer accepts seller's counter offer
// PUT /api/disputes/:id/accept-counter
router.put('/:id/accept-counter', authenticateToken, DisputeController.acceptCounterOffer);

// Buyer escalates dispute to admin
// PUT /api/disputes/:id/escalate
router.put('/:id/escalate', authenticateToken, DisputeController.escalateDispute);

// ============================================
// SELLER ENDPOINTS
// ============================================

// Seller responds to dispute (accept/counter/reject)
// PUT /api/disputes/:id/respond
router.put('/:id/respond', authenticateToken, DisputeController.respondToDispute);

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all disputes (admin)
// GET /api/admin/disputes
router.get('/admin/list', DisputeController.getAdminDisputes);

// Admin resolves dispute
// PUT /api/disputes/:id/resolve
router.put('/:id/resolve', DisputeController.adminResolveDispute);

// ============================================
// SYSTEM ENDPOINTS (CRON JOBS)
// ============================================

// Auto-escalate expired disputes
// POST /api/disputes/auto-escalate
router.post('/auto-escalate', DisputeController.autoEscalateExpired);

export default router;