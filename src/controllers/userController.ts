// src/controllers/userController.ts
// UPDATED: Added getCurrentUser and updateCurrentUser methods for /me endpoint
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { S3Service } from '../services/s3Service';

const prisma = new PrismaClient();

export class UserController {
  /**
   * Get user profile by ID (public route)
   */
  static async getUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      console.log('🔍 GET /users/:userId - User ID:', userId);

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          avatar_url: true,
          rating: true,
          created_at: true,
          location: true,
          bio: true,
          postcode_area: true,
          preferred_carriers: true,
          default_shipping_cost: true,
          offers_free_shipping: true,
          email_notifications: true,
          order_notifications: true,
          marketing_emails: true,
          handicap: true,
          clothing_size: true,
          shoe_size: true,
          glove_size: true,
          is_verified: true,
        },
      });

      if (!user) {
        console.log('❌ User not found');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      console.log('✅ User data returned');
      res.json(user);
    } catch (error) {
      console.error('❌ Get user error:', error);
      res.status(500).json({ error: 'Failed to get user' });
    }
  }

  /**
   * Get current authenticated user's profile (/me endpoint)
   */
  static async getCurrentUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      
      console.log('🔍 GET /users/me - User ID:', userId);

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          avatar_url: true,
          rating: true,
          created_at: true,
          location: true,
          bio: true,
          postcode_area: true,
          preferred_carriers: true,
          default_shipping_cost: true,
          offers_free_shipping: true,
          email_notifications: true,
          order_notifications: true,
          marketing_emails: true,
          sizing_preference: true,
          handicap: true,
          clothing_size: true,
          shoe_size: true,
          glove_size: true,
        },
      });

      if (!user) {
        console.log('❌ User not found in database');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      console.log('✅ Current user data returned');
      res.json(user);
    } catch (error) {
      console.error('❌ Get current user error:', error);
      res.status(500).json({ error: 'Failed to get user' });
    }
  }

  /**
   * Update user profile by ID (protected route)
   */
  static async updateUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { userId: paramUserId } = req.params;

      console.log('🔧 PUT /users/:userId - Param ID:', paramUserId, 'Auth ID:', userId);

      // Verify user is updating their own profile
      if (paramUserId && userId !== paramUserId) {
        console.log('❌ Unauthorized: User trying to update another user');
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      const { 
        display_name, 
        avatar_url, 
        location, 
        bio,
        postcode_area,
        preferred_carriers,
        default_shipping_cost,
        offers_free_shipping,
        email_notifications,
        order_notifications,
        marketing_emails,
        handicap,
        clothing_size,
        shoe_size,
        glove_size,
      } = req.body;

      const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: {
          display_name,
          avatar_url,
          location,
          bio,
          ...(postcode_area !== undefined && { postcode_area }),
          ...(preferred_carriers !== undefined && { preferred_carriers }),
          ...(default_shipping_cost !== undefined && { default_shipping_cost }),
          ...(offers_free_shipping !== undefined && { offers_free_shipping }),
          ...(email_notifications !== undefined && { email_notifications }),
          ...(order_notifications !== undefined && { order_notifications }),
          ...(marketing_emails !== undefined && { marketing_emails }),
          ...(handicap !== undefined && { handicap }),
          ...(clothing_size !== undefined && { clothing_size }),
          ...(shoe_size !== undefined && { shoe_size }),
          ...(glove_size !== undefined && { glove_size }),
          updated_at: new Date(),
        },
        select: {
          id: true,
          email: true,
          display_name: true,
          avatar_url: true,
          rating: true,
          created_at: true,
          location: true,
          bio: true,
          postcode_area: true,
          preferred_carriers: true,
          default_shipping_cost: true,
          offers_free_shipping: true,
          email_notifications: true,
          order_notifications: true,
          marketing_emails: true,
          handicap: true,
          clothing_size: true,
          shoe_size: true,
          glove_size: true,
        },
      });

      console.log('✅ User updated successfully');
      res.json(updatedUser);
    } catch (error) {
      console.error('❌ Update user error:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  }

  /**
   * Update current authenticated user's profile (/me endpoint)
   */
  static async updateCurrentUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      
      console.log('🔧 PUT /users/me - User ID:', userId);
      console.log('📦 Request body:', req.body);

      const { 
        display_name, 
        avatar_url, 
        location, 
        bio,
        postcode_area,
        preferred_carriers,
        default_shipping_cost,
        offers_free_shipping,
        email_notifications,
        order_notifications,
        marketing_emails,
        sizing_preference,
        handicap,
        clothing_size,
        shoe_size,
        glove_size,
      } = req.body;

      const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: {
          display_name,
          avatar_url,
          location,
          bio,
          ...(postcode_area !== undefined && { postcode_area }),
          ...(preferred_carriers !== undefined && { preferred_carriers }),
          ...(default_shipping_cost !== undefined && { default_shipping_cost }),
          ...(offers_free_shipping !== undefined && { offers_free_shipping }),
          ...(email_notifications !== undefined && { email_notifications }),
          ...(order_notifications !== undefined && { order_notifications }),
          ...(marketing_emails !== undefined && { marketing_emails }),
          ...(sizing_preference !== undefined && { sizing_preference }),
          ...(handicap !== undefined && { handicap }),
          ...(clothing_size !== undefined && { clothing_size }),
          ...(shoe_size !== undefined && { shoe_size }),
          ...(glove_size !== undefined && { glove_size }),
          updated_at: new Date(),
        },
        select: {
          id: true,
          email: true,
          display_name: true,
          avatar_url: true,
          rating: true,
          created_at: true,
          location: true,
          bio: true,
          postcode_area: true,
          preferred_carriers: true,
          default_shipping_cost: true,
          offers_free_shipping: true,
          email_notifications: true,
          order_notifications: true,
          marketing_emails: true,
          sizing_preference: true,
          handicap: true,
          clothing_size: true,
          shoe_size: true,
          glove_size: true,
        },
      });

      console.log('✅ Current user updated successfully');
      res.json(updatedUser);
    } catch (error) {
      console.error('❌ Update current user error:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  }

  /**
   * Upload user avatar
   */
  static async uploadAvatar(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { userId: paramUserId } = req.params;

      console.log('📤 POST /users/:userId/avatar - Param ID:', paramUserId, 'Auth ID:', userId);

      // Verify user is updating their own avatar
      if (userId !== paramUserId) {
        console.log('❌ Unauthorized: User trying to upload avatar for another user');
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      console.log('📤 Uploading avatar to S3...');

      // Process image with sharp (same as listings)
      const sharp = require('sharp');
      
      let processedBuffer = req.file.buffer;
      let finalFilename = req.file.originalname;

      try {
        console.log(`🔄 Processing avatar: ${req.file.originalname}`);

        // Resize to square, convert to JPG, optimize
        processedBuffer = await sharp(req.file.buffer)
          .rotate() // Auto-rotate based on EXIF
          .resize(400, 400, { // Avatar size
            fit: 'cover', // Square crop
            position: 'center'
          })
          .jpeg({
            quality: 90,
            progressive: true
          })
          .toBuffer();

        // Change extension to .jpg
        finalFilename = req.file.originalname.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
        if (!finalFilename.toLowerCase().endsWith('.jpg')) {
          finalFilename += '.jpg';
        }

        console.log(`✅ Avatar processed: ${req.file.originalname} → ${finalFilename}`);
      } catch (processError) {
        console.error(`⚠️ Avatar processing failed, using original:`, processError);
      }

      // Upload to S3 using same service as listings
      const uploadResult = await S3Service.uploadImage(
        processedBuffer,
        `avatars/${userId}`,
        finalFilename
      );

      console.log('✅ Avatar uploaded to S3:', uploadResult.url);

      // Update user with new avatar URL
      const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: {
          avatar_url: uploadResult.url,
          updated_at: new Date(),
        },
        select: {
          id: true,
          email: true,
          display_name: true,
          avatar_url: true,
          rating: true,
          location: true,
          bio: true,
          postcode_area: true,
          preferred_carriers: true,
          default_shipping_cost: true,
          offers_free_shipping: true,
          email_notifications: true,
          order_notifications: true,
          marketing_emails: true,
          handicap: true,
          clothing_size: true,
          shoe_size: true,
          glove_size: true,
        },
      });

      console.log('✅ User avatar updated in database');

      res.json(updatedUser);
    } catch (error) {
      console.error('❌ Upload avatar error:', error);
      res.status(500).json({ error: 'Failed to upload avatar' });
    }
  }

  /**
   * Download all user data (GDPR compliance)
   */
  static async downloadUserData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { userId: paramUserId } = req.params;

      console.log('📥 GET /users/:userId/download-data - Param ID:', paramUserId, 'Auth ID:', userId);

      // Verify user is downloading their own data
      if (userId !== paramUserId) {
        console.log('❌ Unauthorized: User trying to download another user\'s data');
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      console.log(`📥 User ${userId} requesting data download...`);

      // Fetch all user data
      const [
        user,
        listings,
        orders,
        reviews,
        favorites,
        messages,
        conversations,
      ] = await Promise.all([
        prisma.users.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            display_name: true,
            phone: true,
            location: true,
            bio: true,
            avatar_url: true,
            postcode_area: true,
            preferred_carriers: true,
            default_shipping_cost: true,
            offers_free_shipping: true,
            email_notifications: true,
            order_notifications: true,
            marketing_emails: true,
            handicap: true,
            clothing_size: true,
            shoe_size: true,
            glove_size: true,
            is_verified: true,
            rating: true,
            total_sales: true,
            total_purchases: true,
            created_at: true,
            updated_at: true,
          },
        }),
        prisma.listings.findMany({
          where: { seller_id: userId },
          include: { images: true },
        }),
        prisma.orders.findMany({
          where: {
            OR: [
              { buyer_id: userId },
              { seller_id: userId },
            ],
          },
        }),
        prisma.reviews.findMany({
          where: {
            OR: [
              { reviewer_id: userId },
              { reviewed_user_id: userId },
            ],
          },
        }),
        prisma.favorites.findMany({
          where: { user_id: userId },
        }),
        prisma.messages.findMany({
          where: {
            OR: [
              { sender_id: userId },
              { receiver_id: userId },
            ],
          },
        }),
        prisma.conversations.findMany({
          where: {
            OR: [
              { buyer_id: userId },
              { seller_id: userId },
            ],
          },
        }),
      ]);

      const userData = {
        export_date: new Date().toISOString(),
        user_profile: user,
        listings: {
          count: listings.length,
          data: listings,
        },
        orders: {
          count: orders.length,
          data: orders,
        },
        reviews: {
          count: reviews.length,
          data: reviews,
        },
        favorites: {
          count: favorites.length,
          data: favorites,
        },
        messages: {
          count: messages.length,
          data: messages,
        },
        conversations: {
          count: conversations.length,
          data: conversations,
        },
      };

      console.log(`✅ User data compiled: ${listings.length} listings, ${orders.length} orders`);

      // Return as JSON for download
      res.json(userData);
    } catch (error) {
      console.error('❌ Download user data error:', error);
      res.status(500).json({ error: 'Failed to download user data' });
    }
  }

  /**
   * Get user statistics for profile page
   */
  static async getUserStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      console.log('📊 GET /users/:userId/stats - User ID:', userId);

      // Verify user exists
      const user = await prisma.users.findUnique({
        where: { id: userId },
      });

      if (!user) {
        console.log('❌ User not found');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Get sales count (completed orders)
      const salesCount = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: 'completed',
        },
      });

      // Get reviews count and average rating
      const reviews = await prisma.reviews.findMany({
        where: { reviewed_user_id: userId },
        select: { rating: true },
      });

      const reviewCount = reviews.length;
      const averageRating = reviewCount > 0
        ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviewCount
        : 0;

      // Get earnings from last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentOrders = await prisma.orders.findMany({
        where: {
          seller_id: userId,
          status: 'completed',
          completed_at: {
            gte: thirtyDaysAgo,
          },
        },
        select: { amount: true },
      });

      const last30DaysEarnings = recentOrders.reduce(
        (acc, order) => acc + Number(order.amount),
        0
      );

      // Get active listings
      const activeListings = await prisma.listings.findMany({
        where: {
          seller_id: userId,
          status: 'active',
        },
        select: { price: true },
      });

      const activeListingsCount = activeListings.length;
      const potentialRevenue = activeListings.reduce(
        (acc, listing) => acc + Number(listing.price),
        0
      );

      // Member since
      const memberSince = new Date(user.created_at).getFullYear();

      const stats = {
        sales: salesCount,
        rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
        reviewCount,
        memberSince,
        last30DaysEarnings,
        potentialRevenue,
        activeListingsCount,
      };

      console.log('✅ User stats returned:', stats);
      res.json(stats);
    } catch (error) {
      console.error('❌ Get user stats error:', error);
      res.status(500).json({ error: 'Failed to get user stats' });
    }
  }

  /**
   * Get user's own listings (for profile)
   */
  static async getMyListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { page = 1, limit = 20, status = 'active' } = req.query;

      console.log('📋 GET /users/my-listings - User ID:', userId, 'Status:', status);

      const skip = (Number(page) - 1) * Number(limit);

      const [listings, total] = await Promise.all([
        prisma.listings.findMany({
          where: {
            seller_id: userId,
            status: status as string,
          },
          include: {
            images: {
              orderBy: { display_order: 'asc' },
              take: 1,
            },
          },
          orderBy: { created_at: 'desc' },
          skip,
          take: Number(limit),
        }),
        prisma.listings.count({
          where: {
            seller_id: userId,
            status: status as string,
          },
        }),
      ]);

      console.log(`✅ Returned ${listings.length} listings (${total} total)`);

      res.json({
        listings,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (error) {
      console.error('❌ Get my listings error:', error);
      res.status(500).json({ error: 'Failed to get listings' });
    }
  }

  /**
 * Get a specific user's listings (public route for seller profiles)
 */
static async getUserListings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const { 
      page = 1, 
      limit = 20, 
      category, 
      search,
      sort = 'recent' 
    } = req.query;

    console.log('📋 GET /users/:userId/listings - User ID:', userId);
    console.log('📦 Query params:', { category, search, sort, page, limit });

    // Verify user exists
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        display_name: true,
        avatar_url: true,
        location: true,
        bio: true,
        rating: true,
        created_at: true,
      },
    });

    if (!user) {
      console.log('❌ User not found');
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Build where clause
    const where: any = {
      seller_id: userId,
      status: 'active',
    };

    // Filter by category if provided
    if (category && category !== 'all') {
      where.category = category;
    }

    // Filter by search term if provided
    if (search && typeof search === 'string' && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { description: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    // Build order by clause
    let orderBy: any = { created_at: 'desc' }; // Default: newest first

    if (sort === 'price-low') {
      orderBy = { price: 'asc' };
    } else if (sort === 'price-high') {
      orderBy = { price: 'desc' };
    } else if (sort === 'oldest') {
      orderBy = { created_at: 'asc' };
    }

    const skip = (Number(page) - 1) * Number(limit);

    // Get listings and total count
    const [listings, total] = await Promise.all([
      prisma.listings.findMany({
        where,
        include: {
          images: {
            orderBy: { display_order: 'asc' },
            take: 1, // Only get first image for grid view
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.listings.count({ where }),
    ]);

    // Get all unique categories from this seller's listings (for category filter)
    const allCategories = await prisma.listings.findMany({
      where: {
        seller_id: userId,
        status: 'active',
      },
      select: {
        category: true,
        subcategory: true,
      },
      distinct: ['category'],
    });

    const categories = allCategories
      .map(l => l.category)
      .filter(Boolean);

    console.log(`✅ Returned ${listings.length} listings (${total} total)`);
    console.log(`📊 Available categories:`, categories);

    res.json({
      user,
      listings,
      total,
      categories,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error('❌ Get user listings error:', error);
    res.status(500).json({ error: 'Failed to get user listings' });
  }
}

  /**
   * Delete user account with proper cleanup
   */
  static async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;

      console.log(`🗑️ DELETE /users/account - User ${userId} requesting account deletion`);

      // Check if user has any active listings
      const activeListings = await prisma.listings.count({
        where: {
          seller_id: userId,
          status: 'active',
        },
      });

      if (activeListings > 0) {
        console.log(`❌ User has ${activeListings} active listings`);
        res.status(400).json({ 
          error: 'Cannot delete account with active listings',
          message: 'Please delete or complete all your active listings before deleting your account.',
        });
        return;
      }

      // Check if user has any pending orders
      const pendingOrders = await prisma.orders.count({
        where: {
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: {
            in: ['pending', 'paid', 'shipped'],
          },
        },
      });

      if (pendingOrders > 0) {
        console.log(`❌ User has ${pendingOrders} pending orders`);
        res.status(400).json({
          error: 'Cannot delete account with pending orders',
          message: 'Please complete all your pending orders before deleting your account.',
        });
        return;
      }

      // Proceed with deletion (Prisma will handle cascade deletes based on schema)
      await prisma.users.delete({
        where: { id: userId },
      });

      console.log(`✅ User ${userId} account deleted successfully`);

      res.json({ 
        message: 'Account deleted successfully',
        deleted_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('❌ Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  }
}