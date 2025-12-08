import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get user notifications
router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.sub || req.user.id;

    const notifications = await prisma.notifications.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50 // Limit to 50 most recent
    });

    const unread_count = notifications.filter(n => !n.is_read).length;

    res.json({ 
      notifications,
      unread_count 
    });
  } catch (error) {
    console.error('Failed to get notifications:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Mark notification as read
router.patch('/:id/read', authenticateToken, async (req: any, res) => {
  try {
    const notificationId = req.params.id;

    const notification = await prisma.notifications.update({
      where: { id: notificationId },
      data: { is_read: true }
    });

    res.json(notification);
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.patch('/read-all', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.sub || req.user.id;

    await prisma.notifications.updateMany({
      where: { 
        user_id: userId,
        is_read: false 
      },
      data: { is_read: true }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to mark all as read:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

export default router;