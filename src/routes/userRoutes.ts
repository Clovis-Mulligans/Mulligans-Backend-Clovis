// src/routes/userRoutes.ts
// UPDATED: Replaced immediate account deletion with 30-day cooling-off period
// UPDATED: Added report and block user functionality
import express from 'express';
import { UserController } from '../controllers/userController';
import { UserActionsController } from '../controllers/userActionsController';
import { AccountDeletionController } from '../controllers/accountDeletionController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';
import { savePushToken, removePushToken } from '../controllers/pushNotificationController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ROUTE ORDER MATTERS! Most specific routes FIRST!

// Protected routes - MUST COME FIRST
router.get('/my-listings', authenticateToken, UserController.getMyListings);
router.get('/me', authenticateToken, UserController.getCurrentUser);
router.put('/me', authenticateToken, UserController.updateCurrentUser);

// Account deletion routes (30-day cooling-off period)
// MUST come before /:userId routes to avoid being caught by param matching
router.post('/request-deletion', authenticateToken, AccountDeletionController.requestDeletion);
router.post('/cancel-deletion', authenticateToken, AccountDeletionController.cancelDeletion);
router.get('/deletion-status', authenticateToken, AccountDeletionController.getDeletionStatus);

// Legacy delete endpoint — returns 410 Gone directing users to new flow
router.delete('/account', authenticateToken, AccountDeletionController.legacyDeleteUser);

// Push notification token routes
router.post('/push-token', authenticateToken, savePushToken);
router.delete('/push-token', authenticateToken, removePushToken);

// NEW: Report user
router.post('/report', authenticateToken, UserActionsController.reportUser);

// NEW: Get blocked users list
router.get('/blocked', authenticateToken, UserActionsController.getBlockedUsers);

// Protected user-specific routes
router.get('/:userId/download-data', authenticateToken, UserController.downloadUserData);
router.post('/:userId/avatar', authenticateToken, upload.single('avatar'), UserController.uploadAvatar);
router.put('/:userId', authenticateToken, UserController.updateUser);

// NEW: Block/unblock specific user
router.post('/:id/block', authenticateToken, UserActionsController.blockUser);
router.delete('/:id/block', authenticateToken, UserActionsController.unblockUser);
router.get('/:id/blocked', authenticateToken, UserActionsController.isUserBlocked);

// Public routes (no auth required) - COME LAST
router.get('/:userId/seller-stats', UserController.getSellerStats);
router.get('/:userId/sold-items', UserController.getSoldItems);
router.get('/:userId/stats', UserController.getUserStats);
router.get('/:userId/listings', UserController.getUserListings);
router.get('/:userId', UserController.getUser);

export default router;
