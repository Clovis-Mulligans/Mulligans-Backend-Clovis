// src/controllers/pushNotificationController.ts
// Handles push token storage and sending push notifications via Expo

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Expo Push API endpoint
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Save user's push notification token
 * POST /api/users/push-token
 */
export const savePushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { push_token, platform } = req.body;

    if (!push_token) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    // Validate it's an Expo push token
    if (!push_token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid Expo push token format' });
    }

    // Save token to user record
    await prisma.users.update({
      where: { id: userId },
      data: {
        push_token: push_token,
        push_token_platform: platform || 'ios',
      },
    });

    console.log(`✅ Push token saved for user ${userId}`);
    res.json({ success: true, message: 'Push token saved' });
  } catch (error) {
    console.error('❌ Save push token error:', error);
    res.status(500).json({ error: 'Failed to save push token' });
  }
};

/**
 * Remove user's push notification token (on logout)
 * DELETE /api/users/push-token
 */
export const removePushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await prisma.users.update({
      where: { id: userId },
      data: {
        push_token: null,
        push_token_platform: null,
      },
    });

    console.log(`✅ Push token removed for user ${userId}`);
    res.json({ success: true, message: 'Push token removed' });
  } catch (error) {
    console.error('❌ Remove push token error:', error);
    res.status(500).json({ error: 'Failed to remove push token' });
  }
};

/**
 * Send push notification to a specific user
 * Used internally by other controllers (messages, orders, etc.)
 */
export const sendPushNotification = async (
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) => {
  try {
    // Get user's push token
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: { push_token: true, display_name: true },
    });

    if (!user?.push_token) {
      console.log(`⚠️ No push token for user ${userId}`);
      return false;
    }

    // Send via Expo Push API
    const message = {
      to: user.push_token,
      sound: 'default',
      title,
      body,
      data: data || {},
    };

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result: any = await response.json();

    if (result.data?.[0]?.status === 'ok') {
      console.log(`📱 Push notification sent to ${user.display_name || userId}`);
      return true;
    } else {
      console.error('❌ Push notification failed:', result);
      return false;
    }
  } catch (error) {
    console.error('❌ Send push notification error:', error);
    return false;
  }
};

/**
 * Send push notification to multiple users
 */
export const sendPushNotificationBatch = async (
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, any>
) => {
  const results = await Promise.all(
    userIds.map(userId => sendPushNotification(userId, title, body, data))
  );
  return results.filter(Boolean).length;
};
