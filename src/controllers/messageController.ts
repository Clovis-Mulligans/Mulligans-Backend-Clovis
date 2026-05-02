// src/controllers/messageController.ts
// Handles messaging between users with notifications

import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { AuthenticatedRequest } from '../middleware/auth';
import { sendPushNotification } from './pushNotificationController';


export class MessageController {
  /**
   * Get or create a conversation
   */
  static async getOrCreateConversation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { listingId, sellerId } = req.body;
      const buyerId = req.user?.sub;

      // Validate user is authenticated
      if (!buyerId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Check if buyer is trying to message themselves
      if (buyerId === sellerId) {
        res.status(400).json({ error: 'Cannot message yourself' });
        return;
      }

      // Check if conversation already exists
      let conversation = await prisma.conversations.findFirst({
        where: listingId
          ? {
              listing_id: listingId,
              buyer_id: buyerId,
              seller_id: sellerId,
            }
          : {
              listing_id: null,
              buyer_id: buyerId,
              seller_id: sellerId,
            },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              price: true,
              status: true,
              images: {
                orderBy: PRIMARY_IMAGE_ORDER,
                take: 1,
              },
            },
          },
          users_conversations_buyer_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
          users_conversations_seller_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
        },
      });

      // Create new conversation if doesn't exist
      if (!conversation) {
        const newConversation = await prisma.conversations.create({
          data: {
            id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            listing_id: listingId || null,
            buyer_id: buyerId,
            seller_id: sellerId,
            last_message_at: new Date(),
          },
          include: {
            listings: {
              select: {
                id: true,
                title: true,
                price: true,
                status: true,
                images: {
                  orderBy: PRIMARY_IMAGE_ORDER,
                  take: 1,
                },
              },
            },
            users_conversations_buyer_idTousers: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
              },
            },
            users_conversations_seller_idTousers: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
              },
            },
          },
        });
        conversation = newConversation;
      }

      res.json({ conversation });
    } catch (error) {
      console.error('Get/create conversation error:', error);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  }

  /**
   * Get user's conversations
   */
  static async getUserConversations(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const { page = 1, limit = 20 } = req.query;

      const skip = (Number(page) - 1) * Number(limit);

      const [conversations, total] = await Promise.all([
        prisma.conversations.findMany({
          where: {
            OR: [{ buyer_id: userId }, { seller_id: userId }],
            is_archived: false,
          },
          skip,
          take: Number(limit),
          include: {
            listings: {
              select: {
                id: true,
                title: true,
                price: true,
                status: true,
                images: {
                  orderBy: PRIMARY_IMAGE_ORDER,
                  take: 1,
                },
              },
            },
            users_conversations_buyer_idTousers: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
                is_verified_seller: true,
              },
            },
            users_conversations_seller_idTousers: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
                is_verified_seller: true,
              },
            },
            messages: {
              orderBy: { created_at: 'desc' },
              take: 1,
            },
          },
          orderBy: { last_message_at: 'desc' },
        }),
        prisma.conversations.count({
          where: {
            OR: [{ buyer_id: userId }, { seller_id: userId }],
            is_archived: false,
          },
        }),
      ]);

      res.json({
        conversations,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error('Get conversations error:', error);
      res.status(500).json({ error: 'Failed to get conversations' });
    }
  }

  /**
   * Get messages in a conversation
   */
  static async getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const { page = 1, limit = 50 } = req.query;

      const skip = (Number(page) - 1) * Number(limit);

      // Verify user is part of conversation
      const conversation = await prisma.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [{ buyer_id: userId }, { seller_id: userId }],
        },
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const [messages, total] = await Promise.all([
        prisma.messages.findMany({
          where: { conversation_id: conversationId },
          skip,
          take: Number(limit),
          include: {
            users_messages_sender_idTousers: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
              },
            },
          },
          orderBy: { created_at: 'asc' },
        }),
        prisma.messages.count({
          where: { conversation_id: conversationId },
        }),
      ]);

      // Mark messages as read
      await prisma.messages.updateMany({
        where: {
          conversation_id: conversationId,
          receiver_id: userId,
          is_read: false,
        },
        data: { is_read: true },
      });

      res.json({
        messages,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }

  /**
   * Send a message
   * Creates notification for recipient with listing image and conversation ID
   */
  static async sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const { content, messageType = 'text', offerAmount } = req.body;
      const senderId = req.user?.sub;

      // Validate message content
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ error: 'Message content is required' });
        return;
      }

      if (content.length > 2000) {
        res.status(400).json({ error: 'Message too long (max 2000 characters)' });
        return;
      }

      // Validate user is authenticated
      if (!senderId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Verify user is part of conversation and get full details
      const conversation = await prisma.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [{ buyer_id: senderId }, { seller_id: senderId }],
        },
        include: {
          // Get listing details for notification
          listings: {
            select: {
              id: true,
              title: true,
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
        },
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const receiverId =
        conversation.buyer_id === senderId
          ? conversation.seller_id
          : conversation.buyer_id;

      // Get sender info for notification message
      const sender = await prisma.users.findUnique({
        where: { id: senderId },
        select: { display_name: true },
      });

      const message = await prisma.messages.create({
        data: {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          conversation_id: conversationId,
          sender_id: senderId as string,
          receiver_id: receiverId,
          content,
          message_type: messageType,
          offer_amount: offerAmount ? parseFloat(offerAmount) : null,
        },
        include: {
          users_messages_sender_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
        },
      });

      // Update conversation last_message_at
      await prisma.conversations.update({
        where: { id: conversationId },
        data: { last_message_at: new Date() },
      });

      // Get sender name for notifications
      const senderName = sender?.display_name || 'Someone';
      const listingTitle = conversation.listings?.title || 'an item';

      // SAFETY CHECK: Never notify the sender themselves
      if (receiverId && receiverId !== senderId) {
        // CREATE NOTIFICATION FOR RECIPIENT
        try {
          const listingImage = conversation.listings?.images?.[0]?.image_url || null;

          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: receiverId,
              type: 'message',
              title: 'New Message',
              message: `${senderName} sent you a message about ${listingTitle}`,
              image_url: listingImage,
              related_id: conversationId,
              related_user_id: senderId,
              is_read: false,
              created_at: new Date(),
            },
          });
          
          console.log('[MSG] Created notification for user:', receiverId);
        } catch (notifError) {
          // Don't fail the message send if notification creation fails
          console.error('[MSG] Failed to create notification:', notifError);
        }

        // SEND PUSH NOTIFICATION
        try {
          console.log('[MSG] Sending push notification to:', receiverId);
          await sendPushNotification(
            receiverId,
            `New message from ${senderName}`,
            content.length > 50 ? content.substring(0, 50) + '...' : content,
            { type: 'message', conversation_id: conversationId }
          );
        } catch (pushErr) {
          console.error('[MSG] Push notification failed:', pushErr);
        }
      } else {
        console.log('[MSG] Skipped self-notification: senderId=' + senderId + ', receiverId=' + receiverId);
      }

      res.status(201).json({ message });
    } catch (error) {
      console.error('Send message error:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }

  /**
   * Archive a conversation
   */
  static async archiveConversation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { conversationId } = req.params;
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Verify user is part of conversation
      const conversation = await prisma.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [{ buyer_id: userId }, { seller_id: userId }],
        },
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      await prisma.conversations.update({
        where: { id: conversationId },
        data: { is_archived: true },
      });

      res.json({ message: 'Conversation archived' });
    } catch (error) {
      console.error('Archive conversation error:', error);
      res.status(500).json({ error: 'Failed to archive conversation' });
    }
  }

  /**
   * Get unread message count
   */
  static async getUnreadCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const unreadCount = await prisma.messages.count({
        where: {
          receiver_id: userId,
          is_read: false,
        },
      });

      res.json({ unreadCount });
    } catch (error) {
      console.error('Get unread count error:', error);
      res.status(500).json({ error: 'Failed to get unread count' });
    }
  }
}