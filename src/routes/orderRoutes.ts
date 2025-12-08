// src/routes/orderRoutes.ts
// ✅ UPDATED: Added /viewed endpoint for marking orders as seen by buyer

import { Router } from 'express';
import { OrderController } from '../controllers/orderController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// ✅ Get order counts for badges (MUST be before /:id route!)
router.get('/counts', authenticateToken, OrderController.getOrderCounts);

// Get user's purchases (orders they bought)
router.get('/my-purchases', authenticateToken, OrderController.getMyPurchases);

// Get user's sales (orders they sold)
router.get('/my-sales', authenticateToken, OrderController.getMySales);

// Get single order details
router.get('/:id', authenticateToken, OrderController.getOrderById);

// Update order status
router.put('/:id/ship', authenticateToken, OrderController.markAsShipped);
router.put('/:id/deliver', authenticateToken, OrderController.markAsDelivered);
router.put('/:id/cancel', authenticateToken, OrderController.cancelOrder);
router.put('/:id/dispute', authenticateToken, OrderController.openDispute);
router.put('/:id/complete', authenticateToken, OrderController.completeOrder);

// ✅ NEW: Mark order as viewed by buyer (clears notification badge)
router.put('/:id/viewed', authenticateToken, OrderController.markAsViewed);

export default router;