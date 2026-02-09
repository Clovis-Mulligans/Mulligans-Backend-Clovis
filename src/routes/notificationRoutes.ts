import express from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// Get user notifications
router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    
    const notifications = await prisma.notifications.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: {
        // Get the user who triggered the notification
        related_user: {
          select: {
            avatar_url: true,
            display_name: true,
          }
        }
      }
    });

    // Transform for frontend
    const transformedNotifications = notifications.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      image_url: n.image_url,
      related_user_avatar: n.related_user?.avatar_url || null,
      related_user_name: n.related_user?.display_name || null,
      created_at: n.created_at,
      is_read: n.is_read,
      related_id: n.related_id,
    }));

    const unread_count = transformedNotifications.filter(n => !n.is_read).length;

    res.json({
      notifications: transformedNotifications,
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