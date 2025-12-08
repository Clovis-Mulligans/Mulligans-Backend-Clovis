// src/routes/searchRoutes.ts
// ✅ UPDATED: Added suggestions endpoint for autocomplete search
import express from 'express';
import { SearchController } from '../controllers/searchController';

const router = express.Router();

// ✅ NEW: Search suggestions for autocomplete
router.get('/suggestions', SearchController.getSuggestions);

// Advanced search with all filters
router.get('/', SearchController.advancedSearch);

// Get available filter options for a category
router.get('/filters/:category', SearchController.getFilterOptions);

// Get sold items for a seller
router.get('/sold/:userId', SearchController.getSoldItems);

// Get price history for anti-scam feature
router.get('/price-history', SearchController.getPriceHistory);

export default router;