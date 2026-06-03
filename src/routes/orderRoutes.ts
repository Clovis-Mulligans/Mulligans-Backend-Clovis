// src/routes/orderRoutes.ts
// ✅ UPDATED: Added seller dashboard endpoints for pending orders and recent sales

import { Router } from 'express';
import { OrderController } from '../controllers/orderController';
import { authenticateToken } from '../middleware/auth';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();

// ✅ Get order counts for badges (MUST be before /:id route!)
router.get('/counts', authenticateToken, OrderController.getOrderCounts);

router.get('/cancellation-counts', authenticateToken, OrderController.getCancellationCounts);

// ✅ NEW: Seller dashboard endpoints
router.get('/seller/pending', authenticateToken, OrderController.getSellerPendingOrders);
router.get('/seller/recent-sales', authenticateToken, OrderController.getSellerRecentSales);

// Get user's purchases (orders they bought)
router.get('/my-purchases', authenticateToken, OrderController.getMyPurchases);

// Get user's sales (orders they sold)
router.get('/my-sales', authenticateToken, OrderController.getMySales);

// Get single order details
router.get('/:id', authenticateToken, OrderController.getOrderById);

// Update order status
// router.put('/:id/ship') REMOVED — task/ship-status-integrity
router.put('/:id/deliver', authenticateToken, OrderController.markAsDelivered);
router.put('/:id/cancel', authenticateToken, OrderController.cancelOrder);
router.put('/:id/dispute', authenticateToken, OrderController.openDispute);
router.put('/:id/complete', adminAuth, OrderController.completeOrder);

// ✅ Mark order as viewed by buyer (clears notification badge)
router.put('/:id/viewed', authenticateToken, OrderController.markAsViewed);

// ✅ ESCROW: Buyer confirms receipt (releases escrow early)
router.put('/:id/confirm-receipt', authenticateToken, OrderController.confirmReceipt);

// ✅ ESCROW: Buyer reports item as lost in transit (after 14 days)
router.put('/:id/report-lost', authenticateToken, OrderController.reportLost);

export default router;