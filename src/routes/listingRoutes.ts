// src/routes/listingRoutes.ts
import { Router } from 'express';
import { ListingController } from '../controllers/listingController';
import { authenticateToken, optionalAuth } from '../middleware/auth';
import multer from 'multer';
import { validate, createListingSchema } from '../middleware/validation';
import rateLimit from 'express-rate-limit';

// Rate limiter: 20 listings per hour per user
const listingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: 'Too many listings created, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * ⚠️ ROUTE ORDER MATTERS - Specific routes MUST come before generic ones!
 */

/**
 * Featured listings for home screen (with personalization if logged in)
 * This MUST be before the generic /:id route
 */
router.get('/featured', ListingController.getFeaturedListings);

/**
 * Protected routes (require login)
 */
// Create listing WITHOUT images
router.post('/', authenticateToken, listingLimiter, validate(createListingSchema), ListingController.createListing);

// Upload images separately
router.post(
  '/:id/images',
  authenticateToken,
  upload.array('images', 5),
  ListingController.uploadListingImage
);

router.put('/:id', authenticateToken, ListingController.updateListing);

router.patch('/bulk', authenticateToken, ListingController.bulkUpdateListings);
router.post('/bulk-delete', authenticateToken, ListingController.bulkDeleteListings);

router.delete('/:id', authenticateToken, ListingController.deleteListing);

router.delete('/:id/images/:imageId', authenticateToken, ListingController.deleteListingImage);

/**
 * Public routes (anyone can access)
 * These MUST come LAST because they have generic patterns
 */
router.get('/seller/:seller_id', ListingController.getSellerListings);

// Track listing view (no auth required)
router.post('/:id/view', ListingController.trackView);

router.get('/:id', optionalAuth, ListingController.getListingById);
router.get('/', ListingController.getAllListings);

export default router;