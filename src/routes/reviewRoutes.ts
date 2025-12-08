// src/routes/reviewRoutes.ts
import { Router } from 'express';
import { ReviewController } from '../controllers/reviewController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Create a review
router.post('/', authenticateToken, ReviewController.createReview);

// Get reviews written by current user
router.get('/my-reviews', authenticateToken, ReviewController.getMyReviews);

// Get reviews for a specific user
router.get('/user/:userId', ReviewController.getUserReviews);

// Get review statistics for a user
router.get('/user/:userId/stats', ReviewController.getUserReviewStats);

export default router;