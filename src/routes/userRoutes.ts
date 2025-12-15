// src/routes/userRoutes.ts
// UPDATED: Fixed /me endpoint to use getCurrentUser and updateCurrentUser methods
import express from 'express';
import { UserController } from '../controllers/userController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';
import { savePushToken, removePushToken } from '../controllers/pushNotificationController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ⚠️ ROUTE ORDER MATTERS! Most specific routes FIRST!

// Protected routes - MUST COME FIRST
router.get('/my-listings', authenticateToken, UserController.getMyListings);
router.get('/me', authenticateToken, UserController.getCurrentUser);  // ✅ FIXED!
router.put('/me', authenticateToken, UserController.updateCurrentUser);  // ✅ FIXED!
router.delete('/account', authenticateToken, UserController.deleteUser);

// Push notification token routes
router.post('/push-token', authenticateToken, savePushToken);
router.delete('/push-token', authenticateToken, removePushToken);

// Protected user-specific routes
router.get('/:userId/download-data', authenticateToken, UserController.downloadUserData);
router.post('/:userId/avatar', authenticateToken, upload.single('avatar'), UserController.uploadAvatar);
router.put('/:userId', authenticateToken, UserController.updateUser);

// Public routes (no auth required) - COME LAST
router.get('/:userId/stats', UserController.getUserStats);
router.get('/:userId/listings', UserController.getUserListings);
router.get('/:userId', UserController.getUser);

export default router;