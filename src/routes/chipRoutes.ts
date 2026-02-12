// src/routes/chipRoutes.ts
// Routes for Chip AI Caddy chat, rate limiting, and recommendations
//
// All routes require authentication.
// Mounted at /api/chip in src/index.ts

import { Router } from 'express';
import { ChipController } from '../controllers/chipController';
import { authenticateToken } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createConversationSchema,
  sendMessageSchema,
  getConversationSchema,
  deleteConversationSchema,
  getRecommendationsSchema,
} from '../validators/chipValidation';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiter for chat messages: 60 requests per minute per IP
// (layered on top of the 30/day application-level limit)
const chipMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { error: "Chip's on the back nine — give him a minute and try again" },
  standardHeaders: true,
  legacyHeaders: false,
});

// All chip routes require authentication
router.use(authenticateToken);

// ============================================
// RATE LIMIT CHECK (must be before :id routes)
// ============================================

router.get('/rate-limit', ChipController.getRateLimit);

// ============================================
// RECOMMENDATIONS
// ============================================

router.get('/recommendations', validate(getRecommendationsSchema), ChipController.getRecommendations);

// ============================================
// CONVERSATIONS
// ============================================

router.get('/conversations', ChipController.getConversations);
router.post('/conversations', validate(createConversationSchema), ChipController.createConversation);
router.get('/conversations/:id', validate(getConversationSchema), ChipController.getConversationMessages);
router.delete('/conversations/:id', validate(deleteConversationSchema), ChipController.deleteConversation);
router.post(
  '/conversations/:id/messages',
  chipMessageLimiter,
  validate(sendMessageSchema),
  ChipController.sendMessage
);

export default router;
