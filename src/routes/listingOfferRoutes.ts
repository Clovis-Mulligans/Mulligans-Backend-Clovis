// src/routes/listingOfferRoutes.ts
// Listing-specific offer endpoints
// These are mounted under /api/listings and require auth
// Date: 5 Feb 2026

import { Router } from 'express';
import { OfferController } from '../controllers/offerController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Get buyer's current offer on a listing
// GET /api/listings/:listingId/my-offer
router.get('/:listingId/my-offer', authenticateToken, OfferController.getMyOfferOnListing);

// Get offer availability status for a listing
// GET /api/listings/:listingId/offer-status
router.get('/:listingId/offer-status', authenticateToken, OfferController.getOfferStatus);

export default router;
