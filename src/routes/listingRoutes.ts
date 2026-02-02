// src/routes/listingRoutes.ts
import { Router } from 'express';
import { ListingController } from '../controllers/listingController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';
import { validate, createListingSchema } from '../middleware/validation';

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
router.post('/', authenticateToken, validate(createListingSchema), ListingController.createListing);

// Upload images separately
router.post(
  '/:id/images',
  authenticateToken,
  upload.array('images', 5),
  ListingController.uploadListingImage
);

router.put('/:id', authenticateToken, ListingController.updateListing);

router.delete('/:id', authenticateToken, ListingController.deleteListing);

router.delete('/:id/images/:imageId', authenticateToken, ListingController.deleteListingImage);

/**
 * Public routes (anyone can access)
 * These MUST come LAST because they have generic patterns
 */
router.get('/seller/:seller_id', ListingController.getSellerListings);

// Track listing view (no auth required)
router.post('/:id/view', ListingController.trackView);

router.get('/:id', ListingController.getListingById);
router.get('/', ListingController.getAllListings);

export default router;