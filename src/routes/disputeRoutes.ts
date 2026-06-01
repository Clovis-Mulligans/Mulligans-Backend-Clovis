// src/routes/disputeRoutes.ts
import express from 'express';
import multer from 'multer';
import { DisputeController } from '../controllers/disputeController';
import { authenticateToken } from '../middleware/auth';
import { adminAuth } from '../middleware/adminAuth';

const router = express.Router();

// ============================================
// MULTER CONFIGURATION FOR IMAGE UPLOADS
// ============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per file
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed') as any, false);
    }
  },
});

// ============================================
// BUYER ENDPOINTS
// ============================================

// Open a new dispute (buyer only)
// POST /api/disputes
router.post('/', authenticateToken, DisputeController.openDispute);

// Upload image to dispute (multipart/form-data) - NEW
// POST /api/disputes/:id/images
router.post('/:id/images', authenticateToken, upload.single('image'), DisputeController.uploadDisputeImageFile);

// Get dispute by order ID
// GET /api/disputes/order/:orderId
router.get('/order/:orderId', authenticateToken, DisputeController.getDisputeByOrder);

// Get dispute details
// GET /api/disputes/:id
router.get('/:id', authenticateToken, DisputeController.getDispute);

// Buyer accepts seller's counter offer
// PUT /api/disputes/:id/accept-counter
router.put('/:id/accept-counter', authenticateToken, DisputeController.acceptCounterOffer);

// Buyer escalates dispute to admin
// PUT /api/disputes/:id/escalate
router.put('/:id/escalate', authenticateToken, DisputeController.escalateDispute);

// ============================================
// SELLER ENDPOINTS
// ============================================

// Seller responds to dispute (accept/counter/reject)
// PUT /api/disputes/:id/respond
router.put('/:id/respond', authenticateToken, DisputeController.respondToDispute);

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all disputes (admin)
// GET /api/admin/disputes
router.get('/admin/list', adminAuth, DisputeController.getAdminDisputes);

// Get single dispute detail (admin) - includes full listing
// GET /api/admin/disputes/:id
router.get('/admin/:id', adminAuth, DisputeController.getAdminDisputeDetail);

// Admin resolves dispute
// PUT /api/disputes/:id/resolve
router.put('/:id/resolve', adminAuth, DisputeController.adminResolveDispute);

export default router;