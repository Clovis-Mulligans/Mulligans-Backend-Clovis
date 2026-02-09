// src/services/socketService.ts
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { prisma } from '../lib/prisma';
import { CognitoJwtVerifier } from 'aws-jwt-verify';


const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: 'access',
  clientId: process.env.COGNITO_CLIENT_ID!,
});

interface AuthenticatedSocket {
  userId: string;
  email: string;
}

export class SocketService {
  private io: SocketIOServer;
  private userSockets: Map<string, string[]> = new Map();

  constructor(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
      },
    });

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  private setupMiddleware() {
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;

        if (!token) {
          return next(new Error('Authentication error'));
        }

        const payload = await verifier.verify(token);
        (socket as any).userId = payload.sub;
        (socket as any).email = payload.email;

        next();
      } catch (error) {
        next(new Error('Authentication error'));
      }
    });
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket) => {
      const userId = (socket as any).userId;
      console.log(`User connected: ${userId}`);

      // Track user socket connections
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, []);
      }
      this.userSockets.get(userId)!.push(socket.id);

      // Join user's personal room
      socket.join(`user:${userId}`);

      // Handle joining conversation rooms
      socket.on('join_conversation', (conversationId: string) => {
        socket.join(`conversation:${conversationId}`);
        console.log(`User ${userId} joined conversation ${conversationId}`);
      });

      // Handle leaving conversation rooms
      socket.on('leave_conversation', (conversationId: string) => {
        socket.leave(`conversation:${conversationId}`);
      });

      // Handle new message
      socket.on('send_message', async (data) => {
        try {
          const { conversationId, content, messageType, offerAmount } = data;

          // Verify user is part of conversation
          const conversation = await prisma.conversations.findFirst({
            where: {
              id: conversationId,
              OR: [{ buyer_id: userId }, { seller_id: userId }],
            },
          });

          if (!conversation) {
            socket.emit('error', { message: 'Conversation not found' });
            return;
          }

          const receiverId =
            conversation.buyer_id === userId
              ? conversation.seller_id
              : conversation.buyer_id;

          // Create message
          const message = await prisma.messages.create({
            data: {
              id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              conversation_id: conversationId,
              sender_id: userId,
              receiver_id: receiverId,
              content,
              message_type: messageType || 'text',
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

          // Update conversation
          await prisma.conversations.update({
            where: { id: conversationId },
            data: { last_message_at: new Date() },
          });

          // Emit to conversation room
          this.io.to(`conversation:${conversationId}`).emit('new_message', message);

          // Emit notification to receiver
          this.io.to(`user:${receiverId}`).emit('message_notification', {
            conversationId,
            message,
          });
        } catch (error) {
          console.error('Send message error:', error);
          socket.emit('error', { message: 'Failed to send message' });
        }
      });

      // Handle typing indicator
      socket.on('typing', (data) => {
        const { conversationId, isTyping } = data;
        socket.to(`conversation:${conversationId}`).emit('user_typing', {
          userId,
          isTyping,
        });
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        console.log(`User disconnected: ${userId}`);
        const sockets = this.userSockets.get(userId);
        if (sockets) {
          const index = sockets.indexOf(socket.id);
          if (index > -1) {
            sockets.splice(index, 1);
          }
          if (sockets.length === 0) {
            this.userSockets.delete(userId);
          }
        }
      });
    });
  }

  // Method to update conversation status when listing is sold/shipped
  public async notifyListingStatusChange(
    listingId: string,
    status: string
  ): Promise<void> {
    try {
      const conversations = await prisma.conversations.findMany({
        where: { listing_id: listingId },
      });

      conversations.forEach((conv) => {
        this.io.to(`conversation:${conv.id}`).emit('listing_status_changed', {
          listingId,
          status,
          message:
            status === 'sold'
              ? 'This item has been sold'
              : status === 'shipped'
              ? 'This item has been shipped'
              : `Listing status: ${status}`,
        });
      });
    } catch (error) {
      console.error('Notify listing status error:', error);
    }
  }

  public getIO(): SocketIOServer {
    return this.io;
  }
}