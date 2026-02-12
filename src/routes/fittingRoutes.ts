// src/routes/fittingRoutes.ts
// Routes for fitting profiles, bag management, and swing data
//
// All routes require authentication.
// Mounted at /api/fitting in src/index.ts

import { Router } from 'express';
import { FittingController } from '../controllers/fittingController';
import { authenticateToken } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createFittingProfileSchema,
  updateFittingProfileSchema,
  addBagClubSchema,
  updateBagClubSchema,
  deleteBagClubSchema,
  addSwingDataSchema,
  deleteSwingDataSchema,
} from '../validators/chipValidation';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// All fitting routes require authentication
router.use(authenticateToken);

// ============================================
// FITTING PROFILE
// ============================================

router.get('/profile', FittingController.getProfile);
router.post('/profile', validate(createFittingProfileSchema), FittingController.upsertProfile);
router.delete('/profile', FittingController.deleteProfile);

// ============================================
// BAG MANAGEMENT
// ============================================

router.get('/bag', FittingController.getBag);
router.post('/bag', validate(addBagClubSchema), FittingController.addClub);
router.put('/bag/:id', validate(updateBagClubSchema), FittingController.updateClub);
// FIX (H3): Added missing validation middleware
router.delete('/bag/:id', validate(deleteBagClubSchema), FittingController.deleteClub);

// ============================================
// SWING DATA
// ============================================

router.get('/swing-data', FittingController.getSwingData);
router.post('/swing-data', validate(addSwingDataSchema), FittingController.addSwingData);
router.post(
  '/swing-data/upload',
  upload.single('image'),
  FittingController.uploadSwingImage
);
// FIX (H3): Added missing validation middleware
router.delete('/swing-data/:id', validate(deleteSwingDataSchema), FittingController.deleteSwingData);

export default router;
