// src/routes/listingOfferRoutes.ts
// Listing-specific offer endpoints
// These are mounted under /api/listing-offers and require auth
// Date: 5 Feb 2026
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #34] Mount path changed from /api/listings to /api/listing-offers in index.ts
//             to avoid route conflicts with the main listing routes.
//             Comment updated here for clarity — no code changes needed in this file.

import { Router } from 'express';
import { OfferController } from '../controllers/offerController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Get buyer's current offer on a listing
// GET /api/listing-offers/:listingId/my-offer
router.get('/:listingId/my-offer', authenticateToken, OfferController.getMyOfferOnListing);

// Get offer availability status for a listing
// GET /api/listing-offers/:listingId/offer-status
router.get('/:listingId/offer-status', authenticateToken, OfferController.getOfferStatus);

export default router;
