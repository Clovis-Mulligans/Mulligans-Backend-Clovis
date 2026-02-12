// src/controllers/chipController.ts
// Chat, rate limiting, and recommendations endpoints for Chip AI Caddy
//
// Pattern: Static class methods matching existing controller style
// Auth: All endpoints require authenticateToken middleware
// Security: User can only access their own conversations

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import {
  sendMessage,
  checkRateLimit,
  getRecommendations,
} from '../services/chipService';
import {
  MAX_USER_MESSAGE_LENGTH,
  MAX_CONVERSATIONS_PER_USER,
  DAILY_TOKEN_BUDGET,
  REJECTION_MESSAGES,
} from '../services/chipSecurity';

export class ChipController {
  // ============================================
  // CONVERSATIONS
  // ============================================

  /**
   * GET /api/chip/conversations
   * List user's conversations (most recent first).
   * Paginated: default 20, max 50.
   */
  static async getConversations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // FIX (M5): Add pagination
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const offset = parseInt(req.query.offset as string) || 0;

      const conversations = await prisma.chip_conversations.findMany({
        where: { user_id: userId },
        orderBy: { updated_at: 'desc' },
        take: limit,
        skip: offset,
        include: {
          listing: {
            select: { id: true, title: true, price: true },
          },
          messages: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { content: true, role: true, created_at: true },
          },
        },
      });

      // Format for mobile: include last message preview
      const formatted = conversations.map((c) => ({
        id: c.id,
        title: c.title || (c.listing ? `About: ${c.listing.title}` : 'Chat with Chip'),
        listing: c.listing,
        lastMessage: c.messages[0]
          ? {
              content: c.messages[0].content.substring(0, 100),
              role: c.messages[0].role,
              created_at: c.messages[0].created_at,
            }
          : null,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));

      res.status(200).json({ conversations: formatted });
    } catch (error: any) {
      console.error('❌ Error fetching conversations:', error);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  }

  /**
   * POST /api/chip/conversations
   * Start a new conversation. Optionally linked to a listing.
   * FIX (H4): Enforces max 50 conversations per user.
   */
  static async createConversation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // FIX (H4): Check conversation limit
      const existingCount = await prisma.chip_conversations.count({
        where: { user_id: userId },
      });

      if (existingCount >= MAX_CONVERSATIONS_PER_USER) {
        res.status(400).json({ error: REJECTION_MESSAGES.maxConversations });
        return;
      }

      const { listing_id } = req.body;

      // If listing_id provided, verify listing exists
      let listingTitle: string | null = null;
      if (listing_id) {
        const listing = await prisma.listings.findUnique({
          where: { id: listing_id },
          select: { id: true, title: true },
        });
        if (!listing) {
          res.status(404).json({ error: 'Listing not found' });
          return;
        }
        listingTitle = listing.title;

        // Check for existing conversation with this listing
        const existing = await prisma.chip_conversations.findFirst({
          where: { user_id: userId, listing_id },
          orderBy: { updated_at: 'desc' },
        });
        if (existing) {
          res.status(200).json({ conversation: existing });
          return;
        }
      }

      const conversation = await prisma.chip_conversations.create({
        data: {
          user_id: userId,
          listing_id: listing_id || null,
          title: listingTitle ? `About: ${listingTitle}` : null,
        },
      });

      res.status(201).json({ conversation });
    } catch (error: any) {
      console.error('❌ Error creating conversation:', error);
      res.status(500).json({ error: 'Failed to create conversation' });
    }
  }

  /**
   * GET /api/chip/conversations/:id
   * Get messages for a specific conversation.
   */
  static async getConversationMessages(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      const conversation = await prisma.chip_conversations.findUnique({
        where: { id },
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              price: true,
              brand: true,
              model: true,
              status: true,
              images: { take: 1, orderBy: { display_order: 'asc' } },
            },
          },
          messages: {
            orderBy: { created_at: 'asc' },
            select: {
              id: true,
              role: true,
              content: true,
              created_at: true,
            },
          },
        },
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      // SECURITY: Verify ownership
      if (conversation.user_id !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      res.status(200).json({
        conversation: {
          id: conversation.id,
          title: conversation.title,
          listing: conversation.listing,
          messages: conversation.messages,
          created_at: conversation.created_at,
          updated_at: conversation.updated_at,
        },
      });
    } catch (error: any) {
      console.error('❌ Error fetching conversation:', error);
      res.status(500).json({ error: 'Failed to fetch conversation' });
    }
  }

  /**
   * DELETE /api/chip/conversations/:id
   * Delete a conversation and all its messages.
   */
  static async deleteConversation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      const conversation = await prisma.chip_conversations.findUnique({
        where: { id },
        select: { user_id: true },
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      // SECURITY: Verify ownership
      if (conversation.user_id !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      // Cascade delete handles messages
      await prisma.chip_conversations.delete({ where: { id } });

      res.status(200).json({ message: 'Conversation deleted' });
    } catch (error: any) {
      console.error('❌ Error deleting conversation:', error);
      res.status(500).json({ error: 'Failed to delete conversation' });
    }
  }

  /**
   * POST /api/chip/conversations/:id/messages
   * Send a message in a conversation and get Chip's response.
   */
  static async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id: conversationId } = req.params;
      const { content } = req.body;

      // Validate message length (also done by Zod, but defence in depth)
      if (!content || content.length === 0) {
        res.status(400).json({ error: 'Message content is required' });
        return;
      }

      if (content.length > MAX_USER_MESSAGE_LENGTH) {
        res.status(400).json({ error: REJECTION_MESSAGES.messageTooLong });
        return;
      }

      // Send message via service (handles rate limiting, sanitisation, Claude call)
      const response = await sendMessage(userId, conversationId, content);

      res.status(200).json({
        message: {
          id: response.messageId,
          role: 'assistant',
          content: response.message,
          created_at: new Date().toISOString(),
        },
        tokens_used: response.tokensUsed,
      });
    } catch (error: any) {
      console.error('❌ Error sending message:', error);

      if (error.message === 'Conversation not found') {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      if (error.message === 'Not authorised to access this conversation') {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      res.status(500).json({ error: REJECTION_MESSAGES.serverError });
    }
  }

  // ============================================
  // RATE LIMIT CHECK
  // ============================================

  /**
   * GET /api/chip/rate-limit
   * Check remaining messages and token budget for today.
   */
  static async getRateLimit(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const limit = await checkRateLimit(userId);

      res.status(200).json({
        remaining: limit.remaining,
        limit: 30,
        tokens_used: limit.tokensUsed,
        token_budget: limit.tokenBudget,
        reset_at: limit.resetAt.toISOString(),
      });
    } catch (error: any) {
      console.error('❌ Error checking rate limit:', error);
      res.status(500).json({ error: 'Failed to check rate limit' });
    }
  }

  // ============================================
  // RECOMMENDATIONS
  // ============================================

  /**
   * GET /api/chip/recommendations
   * Get personalised listing recommendations.
   */
  static async getRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await getRecommendations(userId, limit, offset);

      res.status(200).json({
        listings: result.listings,
        total: result.total,
        limit,
        offset,
      });
    } catch (error: any) {
      console.error('❌ Error fetching recommendations:', error);
      res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
  }
}
