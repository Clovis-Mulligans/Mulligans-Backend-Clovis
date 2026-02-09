// src/routes/offerRoutes.ts
// Routes for the Offer System
// Date: 5 Feb 2026
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #33] Added Zod validation middleware to createOffer and counterOffer routes.
//             Schemas imported from '../middleware/validation'.

import { Router } from 'express';
import { OfferController } from '../controllers/offerController';
import { authenticateToken } from '../middleware/auth';
import { validate, createOfferSchema, counterOfferSchema } from '../middleware/validation';

const router = Router();

// All offer routes require authentication
router.use(authenticateToken);

// ============================================
// OFFER CRUD
// ============================================

// Get offer counts for notification badges (MUST be before /:id)
router.get('/counts', OfferController.getOfferCounts);

// Get offers I've made
router.get('/my-offers', OfferController.getMyOffers);

// Get offers I've received (as seller)
router.get('/received', OfferController.getReceivedOffers);

// Get single offer details
router.get('/:id', OfferController.getOfferById);

// [Issue #33] Create new offer — with Zod validation
router.post('/', validate(createOfferSchema), OfferController.createOffer);

// ============================================
// SELLER ACTIONS
// ============================================

// Accept an offer
router.put('/:id/accept', OfferController.acceptOffer);

// Decline an offer
router.put('/:id/decline', OfferController.declineOffer);

// [Issue #33] Send counter offer — with Zod validation
router.put('/:id/counter', validate(counterOfferSchema), OfferController.counterOffer);

// ============================================
// BUYER ACTIONS
// ============================================

// Accept counter offer
router.put('/:id/accept-counter', OfferController.acceptCounter);

// Decline counter offer
router.put('/:id/decline-counter', OfferController.declineCounter);

// Withdraw offer
router.put('/:id/withdraw', OfferController.withdrawOffer);

export default router;
