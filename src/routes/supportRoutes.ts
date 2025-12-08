// src/routes/supportRoutes.ts
import { Router } from 'express';
import { SupportController } from '../controllers/supportController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
});

// Submit support ticket (with optional images)
router.post(
  '/contact',
  authenticateToken,
  upload.array('images', 4),
  SupportController.submitTicket
);

// Get user's support tickets
router.get('/tickets', authenticateToken, SupportController.getUserTickets);

export default router;