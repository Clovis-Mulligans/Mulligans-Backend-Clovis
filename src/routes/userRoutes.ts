// src/routes/userRoutes.ts
// UPDATED: Added report and block user functionality
import express from 'express';
import { UserController } from '../controllers/userController';
import { UserActionsController } from '../controllers/userActionsController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';
import { savePushToken, removePushToken } from '../controllers/pushNotificationController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ⚠️ ROUTE ORDER MATTERS! Most specific routes FIRST!

// Protected routes - MUST COME FIRST
router.get('/my-listings', authenticateToken, UserController.getMyListings);
router.get('/me', authenticateToken, UserController.getCurrentUser);
router.put('/me', authenticateToken, UserController.updateCurrentUser);
router.delete('/account', authenticateToken, UserController.deleteUser);

// Push notification token routes
router.post('/push-token', authenticateToken, savePushToken);
router.delete('/push-token', authenticateToken, removePushToken);

// ✅ NEW: Report user
router.post('/report', authenticateToken, UserActionsController.reportUser);

// ✅ NEW: Get blocked users list
router.get('/blocked', authenticateToken, UserActionsController.getBlockedUsers);

// Protected user-specific routes
router.get('/:userId/download-data', authenticateToken, UserController.downloadUserData);
router.post('/:userId/avatar', authenticateToken, upload.single('avatar'), UserController.uploadAvatar);
router.put('/:userId', authenticateToken, UserController.updateUser);

// ✅ NEW: Block/unblock specific user
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