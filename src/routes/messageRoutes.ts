import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const prisma = new PrismaClient();

// Rate limiter: 10 messages per minute per user
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'You are sending messages too quickly. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Get unread message count
router.get('/unread-count', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.sub || req.user.id;

    const unreadCount = await prisma.messages.count({
      where: {
        receiver_id: userId,
        is_read: false
      }
    });

    console.log('📬 Unread count for user', userId, ':', unreadCount);
    res.json({ unread_count: unreadCount });
  } catch (error) {
    console.error('Failed to get unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// ✅ Mark messages as read in a conversation
router.patch('/conversations/:id/read', authenticateToken, async (req: any, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user.sub || req.user.id;

    console.log('📖 Marking messages as read in conversation:', conversationId);
    console.log('   For user:', userId);

    // Mark all messages in this conversation where user is receiver as read
    const result = await prisma.messages.updateMany({
      where: {
        conversation_id: conversationId,
        receiver_id: userId,
        is_read: false
      },
      data: {
        is_read: true
      }
    });

    console.log('✅ Marked', result.count, 'messages as read');
    res.json({ success: true, marked_count: result.count });
  } catch (error) {
    console.error('Failed to mark messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Create or get conversation
router.post('/conversations', authenticateToken, async (req: any, res) => {
  try {
    const { listing_id, seller_id, buyer_id: providedBuyerId } = req.body;
    const userId = req.user.sub || req.user.id;

    console.log('📨 Create conversation request:');
    console.log('   listing_id:', listing_id);
    console.log('   seller_id:', seller_id);
    console.log('   providedBuyerId:', providedBuyerId);
    console.log('   authenticated userId:', userId);

    const buyer = await prisma.users.findUnique({
      where: { id: userId }
    });

    if (!buyer) {
      return res.status(404).json({ error: 'User not found' });
    }

    const buyer_id = providedBuyerId || buyer.id;

    let conversation = await prisma.conversations.findFirst({
      where: {
        listing_id: listing_id,
        buyer_id: buyer_id,
        seller_id: seller_id
      }
    });

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          listing_id: listing_id,
          buyer_id: buyer_id,
          seller_id: seller_id
        }
      });
    }

    res.json(conversation);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get conversation by ID
router.get('/conversations/:id', authenticateToken, async (req: any, res) => {
  try {
    const conversation = await prisma.conversations.findUnique({
      where: { id: req.params.id }
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const listing = await prisma.listings.findUnique({
      where: { id: conversation.listing_id },
      include: {
        images: true
      }
    });

    const userId = req.user.sub || req.user.id;
    const current_user = await prisma.users.findUnique({
      where: { id: userId }
    });

    const other_user_id = conversation.buyer_id === current_user?.id ? conversation.seller_id : conversation.buyer_id;
    
    const other_user = await prisma.users.findUnique({
      where: { id: other_user_id }
    });

    res.json({
      id: conversation.id,
      listing_id: conversation.listing_id,
      listing_title: listing?.title,
      listing_price: listing?.price,
      listing_image: listing?.images?.[0]?.image_url,
      other_user_name: other_user?.display_name,
      other_user_id: other_user?.id,
      other_user_avatar: other_user?.avatar_url  // ✅ Added avatar
    });
  } catch (error) {
    console.error('Failed to get conversation:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// Get conversation messages
router.get('/conversations/:id/messages', authenticateToken, async (req: any, res) => {
  try {
    const conversationId = req.params.id;
    
    console.log('Fetching messages for conversation:', conversationId);
    
    const messages = await prisma.messages.findMany({
      where: { 
        conversation_id: conversationId
      },
      orderBy: { created_at: 'asc' },
      include: {
        users_messages_sender_idTousers: {
          select: {
            id: true,
            display_name: true
          }
        }
      }
    });

    console.log('Found messages:', messages.length);
    
    res.json({ messages });
  } catch (error) {
    console.error('Failed to get messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send message
// ✅ FIXED: Notification now includes image_url and uses conversation_id (not listing_id)
router.post('/', authenticateToken, messageLimiter, async (req: any, res) => {
  try {
    const { conversation_id, content } = req.body;
    const userId = req.user.sub || req.user.id;

    const sender = await prisma.users.findUnique({
      where: { id: userId }
    });

    if (!sender) {
      return res.status(404).json({ error: 'User not found' });
    }

    const conversation = await prisma.conversations.findUnique({
      where: { id: conversation_id },
      include: {
        listings: {
          include: {
            images: {
              take: 1,
              orderBy: { display_order: 'asc' }
            }
          }
        }
      }
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const receiver_id = conversation.buyer_id === sender.id 
      ? conversation.seller_id 
      : conversation.buyer_id;

    const message = await prisma.messages.create({
      data: {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content,
        users_messages_sender_idTousers: {
          connect: { id: sender.id }
        },
        users_messages_receiver_idTousers: {
          connect: { id: receiver_id }
        },
        conversations: {
          connect: { id: conversation_id }
        }
      }
    });

    // ✅ FIXED: Create notification with image_url and conversation_id
    const listingImage = conversation.listings?.images?.[0]?.image_url || null;
    
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: receiver_id,
        type: 'message',
        title: 'New Message',
        message: `${sender.display_name || 'Someone'} sent you a message about ${conversation.listings?.title || 'an item'}`,
        image_url: listingImage,          // ✅ NOW INCLUDES LISTING IMAGE
        related_id: conversation_id,       // ✅ FIXED: Now uses conversation_id (not listing_id)
        related_user_id: sender.id
      }
    });

    console.log('📬 Created message notification for user', receiver_id);

    res.json(message);
  } catch (error) {
    console.error('Failed to send message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get user conversations with full details
router.get('/conversations', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    
    console.log('🔍 Fetching conversations for user:', userId);
    
    const current_user = await prisma.users.findUnique({
      where: { id: userId }
    });

    if (!current_user) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('✅ Current user found:', current_user.display_name);

    // Get all conversations for this user
    const conversations = await prisma.conversations.findMany({
      where: {
        OR: [
          { buyer_id: current_user.id },
          { seller_id: current_user.id }
        ]
      }
    });

    console.log('📬 Found', conversations.length, 'conversations');

    // Enrich each conversation with details
    const enrichedConversations = await Promise.all(
      conversations.map(async (conv) => {
        console.log('\n📝 Processing conversation:', conv.id);
        console.log('   Buyer:', conv.buyer_id);
        console.log('   Seller:', conv.seller_id);
        
        // Determine the "other user"
        const other_user_id = conv.buyer_id === current_user.id 
          ? conv.seller_id 
          : conv.buyer_id;

        console.log('   Other user ID:', other_user_id);

        // Fetch other user details
       const other_user = await prisma.users.findUnique({
          where: { id: other_user_id },
          select: {
            id: true,
            display_name: true,
            avatar_url: true,
            is_verified: true
          }
        });

        console.log('   Other user found:', other_user?.display_name || 'NOT FOUND');

        // Fetch listing details
        const listing = await prisma.listings.findUnique({
          where: { id: conv.listing_id },
          include: {
            images: {
              take: 1,
              orderBy: { created_at: 'asc' }
            }
          }
        });

        console.log('   Listing:', listing?.title || 'NOT FOUND');

        // Fetch last message
        const lastMessage = await prisma.messages.findFirst({
          where: { conversation_id: conv.id },
          orderBy: { created_at: 'desc' },
          select: {
            content: true,
            created_at: true,
            sender_id: true
          }
        });

        console.log('   Last message:', lastMessage?.content || 'NO MESSAGES');

        // Count unread messages for this user in this conversation
        const unreadCount = await prisma.messages.count({
          where: {
            conversation_id: conv.id,
            receiver_id: current_user.id,
            is_read: false
          }
        });

        return {
          id: conv.id,
          listing_id: conv.listing_id,
          listing_title: listing?.title || 'Unknown Item',
          listing_image: listing?.images?.[0]?.image_url || null,
          other_user_id: other_user?.id || null,
          other_user_name: other_user?.display_name || 'Unknown User',
          other_user_avatar: other_user?.avatar_url || null,
          other_user_is_verified: other_user?.is_verified || false,
          last_message: lastMessage?.content || 'No messages yet',
          last_message_time: lastMessage?.created_at?.toISOString() || conv.created_at.toISOString(),
          last_message_timestamp: lastMessage?.created_at || conv.created_at,
          unread_count: unreadCount,
          created_at: conv.created_at
        };
      })
    );

    // Sort by most recent message first
    enrichedConversations.sort((a, b) => {
      return new Date(b.last_message_timestamp).getTime() - new Date(a.last_message_timestamp).getTime();
    });

    console.log('\n✅ Returning', enrichedConversations.length, 'enriched conversations');

    res.json({ conversations: enrichedConversations });
  } catch (error) {
    console.error('❌ Failed to get conversations:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

export default router;