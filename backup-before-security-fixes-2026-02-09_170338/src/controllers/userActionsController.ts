// src/controllers/userActionsController.ts
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';

const prisma = new PrismaClient();

export class UserActionsController {
  /**
   * Report a user
   * POST /api/users/report
   */
  static async reportUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { reported_user_id, reason, details, conversation_id, listing_id } = req.body;

      if (!reported_user_id || !reason) {
        res.status(400).json({ error: 'reported_user_id and reason are required' });
        return;
      }

      // Can't report yourself
      if (reported_user_id === userId) {
        res.status(400).json({ error: 'You cannot report yourself' });
        return;
      }

      // Check if user exists
      const reportedUser = await prisma.users.findUnique({
        where: { id: reported_user_id },
      });

      if (!reportedUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Check for duplicate report (same reporter, same user, within 24 hours)
      const existingReport = await prisma.user_reports.findFirst({
        where: {
          reporter_id: userId,
          reported_user_id: reported_user_id,
          created_at: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      });

      if (existingReport) {
        res.status(400).json({ error: 'You have already reported this user recently' });
        return;
      }

      // Create the report
      const report = await prisma.user_reports.create({
        data: {
          reporter_id: userId,
          reported_user_id,
          reason,
          details: details || null,
          conversation_id: conversation_id || null,
          listing_id: listing_id || null,
          status: 'pending',
        },
      });

      console.log(`📋 New report created: ${report.id} - ${reason}`);

      // TODO: Send notification to admin/support team
      // TODO: Send email to support@mulligans.uk.com

      res.status(201).json({
        success: true,
        message: 'Report submitted successfully',
        report_id: report.id,
      });
    } catch (error) {
      console.error('Report user error:', error);
      res.status(500).json({ error: 'Failed to submit report' });
    }
  }

  /**
   * Block a user
   * POST /api/users/:id/block
   */
  static async blockUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const blockedId = req.params.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Can't block yourself
      if (blockedId === userId) {
        res.status(400).json({ error: 'You cannot block yourself' });
        return;
      }

      // Check if user exists
      const userToBlock = await prisma.users.findUnique({
        where: { id: blockedId },
      });

      if (!userToBlock) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Check if already blocked
      const existingBlock = await prisma.blocked_users.findUnique({
        where: {
          blocker_id_blocked_id: {
            blocker_id: userId,
            blocked_id: blockedId,
          },
        },
      });

      if (existingBlock) {
        res.status(400).json({ error: 'User is already blocked' });
        return;
      }

      // Create the block
      await prisma.blocked_users.create({
        data: {
          blocker_id: userId,
          blocked_id: blockedId,
        },
      });

      console.log(`🚫 User ${userId} blocked ${blockedId}`);

      res.json({
        success: true,
        message: 'User blocked successfully',
      });
    } catch (error) {
      console.error('Block user error:', error);
      res.status(500).json({ error: 'Failed to block user' });
    }
  }

  /**
   * Unblock a user
   * DELETE /api/users/:id/block
   */
  static async unblockUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const blockedId = req.params.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Check if block exists
      const existingBlock = await prisma.blocked_users.findUnique({
        where: {
          blocker_id_blocked_id: {
            blocker_id: userId,
            blocked_id: blockedId,
          },
        },
      });

      if (!existingBlock) {
        res.status(404).json({ error: 'Block not found' });
        return;
      }

      // Remove the block
      await prisma.blocked_users.delete({
        where: {
          blocker_id_blocked_id: {
            blocker_id: userId,
            blocked_id: blockedId,
          },
        },
      });

      console.log(`✅ User ${userId} unblocked ${blockedId}`);

      res.json({
        success: true,
        message: 'User unblocked successfully',
      });
    } catch (error) {
      console.error('Unblock user error:', error);
      res.status(500).json({ error: 'Failed to unblock user' });
    }
  }

  /**
   * Get list of blocked users
   * GET /api/users/blocked
   */
  static async getBlockedUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const blockedUsers = await prisma.blocked_users.findMany({
        where: { blocker_id: userId },
        include: {
          blocked: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      res.json({
        blocked_users: blockedUsers.map((b: any) => ({
          id: b.blocked.id,
          display_name: b.blocked.display_name,
          avatar_url: b.blocked.avatar_url,
          blocked_at: b.created_at,
        })),
      });
    } catch (error) {
      console.error('Get blocked users error:', error);
      res.status(500).json({ error: 'Failed to get blocked users' });
    }
  }

  /**
   * Check if a user is blocked
   * GET /api/users/:id/blocked
   */
  static async isUserBlocked(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const otherUserId = req.params.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const block = await prisma.blocked_users.findUnique({
        where: {
          blocker_id_blocked_id: {
            blocker_id: userId,
            blocked_id: otherUserId,
          },
        },
      });

      res.json({
        is_blocked: !!block,
      });
    } catch (error) {
      console.error('Check blocked error:', error);
      res.status(500).json({ error: 'Failed to check block status' });
    }
  }
}