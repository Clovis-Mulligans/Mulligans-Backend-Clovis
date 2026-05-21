// src/controllers/userController.ts
// UPDATED: Added getCurrentUser and updateCurrentUser methods for /me endpoint
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { AuthenticatedRequest } from '../middleware/auth';
import { S3Service } from '../services/s3Service';


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
          is_verified_seller: true,
          is_pro_store: true,
          pro_store_name: true,
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
 /**
   * Get current authenticated user's profile (/me endpoint)
   * ✅ UPDATED: Now includes payment status for bank details badge
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
          // ✅ NEW: Include these for payment badge
          total_sales: true,
          stripe_connect_status: true,
        },
      });

      if (!user) {
        console.log('❌ User not found in database');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // ✅ NEW: Check if user has active listings
      const listingCount = await prisma.listings.count({
        where: {
          seller_id: userId,
          status: 'active',
        },
      });

      // ✅ NEW: Build response with payment status info
      const response = {
        ...user,
        has_listings: listingCount > 0,
        has_sales: (user.total_sales || 0) > 0,
        // Needs bank details if has listings/sales but stripe not active
        needs_bank_details: 
          (listingCount > 0 || (user.total_sales || 0) > 0) && 
          user.stripe_connect_status !== 'active',
      };

      console.log('✅ Current user data returned with payment status:', {
        stripe_connect_status: user.stripe_connect_status,
        has_listings: response.has_listings,
        has_sales: response.has_sales,
        needs_bank_details: response.needs_bank_details,
      });
      
      res.json(response);
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

      // Fetch all user data with safe field selection
      const [
        user,
        listings,
        purchases,
        sales,
        reviewsWritten,
        reviewsReceived,
        favorites,
        messagesSent,
        conversations,
      ] = await Promise.all([
        // User profile - exclude internal fields
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
            is_verified_seller: true,
            rating: true,
            total_sales: true,
            total_purchases: true,
            created_at: true,
            updated_at: true,
          },
        }),

        // User's listings
        prisma.listings.findMany({
          where: { seller_id: userId },
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            category: true,
            subcategory: true,
            brand: true,
            status: true,
            views: true,
            shipping_cost: true,
            parcel_size: true,
            specifications: true,
            created_at: true,
            updated_at: true,
            images: {
              select: {
                id: true,
                image_url: true,
                display_order: true,
              },
            },
          },
        }),

        // Orders as buyer
        prisma.orders.findMany({
          where: { buyer_id: userId },
          select: {
            id: true,
            listing_id: true,
            amount: true,
            shipping_cost: true,
            status: true,
            shipping_address: true,
            tracking_number: true,
            carrier: true,
            created_at: true,
            paid_at: true,
            shipped_at: true,
            delivered_at: true,
            completed_at: true,
            listings: {
              select: {
                title: true,
                price: true,
              },
            },
          },
        }),

        // Orders as seller
        prisma.orders.findMany({
          where: { seller_id: userId },
          select: {
            id: true,
            listing_id: true,
            amount: true,
            shipping_cost: true,
            seller_payout: true,
            status: true,
            tracking_number: true,
            carrier: true,
            created_at: true,
            paid_at: true,
            shipped_at: true,
            delivered_at: true,
            completed_at: true,
            listings: {
              select: {
                title: true,
                price: true,
              },
            },
          },
        }),

       // Reviews user has written
prisma.reviews.findMany({
  where: { reviewer_id: userId },
  select: {
    id: true,
    rating: true,
    review_type: true,
    created_at: true,
  },
}),

        // Reviews user has received
prisma.reviews.findMany({
  where: { reviewed_user_id: userId },
  select: {
    id: true,
    rating: true,
    review_type: true,
    created_at: true,
  },
}),
        // Favorites
        prisma.favorites.findMany({
          where: { user_id: userId },
          select: {
            listing_id: true,
            created_at: true,
            listings: {
              select: {
                title: true,
                price: true,
                status: true,
              },
            },
          },
        }),

        // Messages sent by user
        prisma.messages.findMany({
          where: { sender_id: userId },
          select: {
            id: true,
            content: true,
            created_at: true,
            conversation_id: true,
          },
          orderBy: { created_at: 'desc' },
          take: 500,
        }),

        // Conversations user is part of
        prisma.conversations.findMany({
          where: {
            OR: [
              { buyer_id: userId },
              { seller_id: userId },
            ],
          },
          select: {
            id: true,
            created_at: true,
            listings: {
              select: {
                title: true,
              },
            },
          },
        }),
      ]);

      const userData = {
        export_date: new Date().toISOString(),
        export_version: '1.0',
        data_subject: 'Your Mulligans account data',
        
        profile: user,
        
        listings: {
          count: listings.length,
          items: listings,
        },
        
        purchases: {
          count: purchases.length,
          description: 'Items you have bought',
          items: purchases,
        },
        
        sales: {
          count: sales.length,
          description: 'Items you have sold',
          items: sales,
        },
        
        reviews_written: {
          count: reviewsWritten.length,
          items: reviewsWritten,
        },
        
        reviews_received: {
          count: reviewsReceived.length,
          items: reviewsReceived,
        },
        
        favorites: {
          count: favorites.length,
          items: favorites,
        },
        
        messages_sent: {
          count: messagesSent.length,
          note: 'Limited to last 500 messages',
          items: messagesSent,
        },
        
        conversations: {
          count: conversations.length,
          items: conversations,
        },
      };

      console.log(`✅ User data compiled: ${listings.length} listings, ${purchases.length} purchases, ${sales.length} sales`);

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

      // Get sales count (completed and delivered orders)
const salesCount = await prisma.orders.count({
  where: {
    seller_id: userId,
    status: { in: ['completed', 'delivered'] },
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
    const {
      page = 1,
      limit = 20,
      status,
      category,
      condition,
      minPrice,
      maxPrice,
      search,
      sort = 'recent',
    } = req.query;

    console.log('📋 GET /users/my-listings - User ID:', userId, 'Filters:', req.query);

    const skip = (Number(page) - 1) * Number(limit);

    // Build where clause
    const where: Record<string, unknown> = { seller_id: userId };

    if (status && status !== 'all') {
      where.status = status as string;
    }
    if (category) {
      where.category = category as string;
    }
    if (condition) {
      where.condition_overall = Number(condition);
    }
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) (where.price as Record<string, unknown>).gte = String(Number(minPrice));
      if (maxPrice) (where.price as Record<string, unknown>).lte = String(Number(maxPrice));
    }
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { brand: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const orderBy =
      sort === 'price_asc'
        ? { price: 'asc' as const }
        : sort === 'price_desc'
        ? { price: 'desc' as const }
        : { created_at: 'desc' as const };

    const [listings, total] = await Promise.all([
      prisma.listings.findMany({
        where,
        include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.listings.count({ where }),
    ]);

    console.log(`✅ Returned ${listings.length} listings (${total} total)`);
    res.json({
      listings,
      total,
      page: Number(page),
      limit: Number(limit),
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
        is_pro_store: true,
        pro_store_name: true,
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
            orderBy: PRIMARY_IMAGE_ORDER,
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

  /**
   * Get seller dashboard stats
   * GET /users/:userId/seller-stats
   * Returns comprehensive stats for the seller dashboard
   */
  static async getSellerStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      console.log('📊 GET /users/:userId/seller-stats - User ID:', userId);

      // Verify user exists
      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          rating: true,
          total_sales: true,
          created_at: true,
          stripe_connect_id: true,
        },
      });

      if (!user) {
        console.log('❌ User not found');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Date calculations
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      const monthStart = new Date(todayStart);
      monthStart.setDate(monthStart.getDate() - 30);

      // Get earnings data from completed orders
      const [todayOrders, weekOrders, monthOrders] = await Promise.all([
        prisma.orders.aggregate({
          where: {
            seller_id: userId,
            status: 'completed',
            completed_at: { gte: todayStart },
          },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.orders.aggregate({
          where: {
            seller_id: userId,
            status: 'completed',
            completed_at: { gte: weekStart },
          },
          _sum: { amount: true },
        }),
        prisma.orders.aggregate({
          where: {
            seller_id: userId,
            status: 'completed',
            completed_at: { gte: monthStart },
          },
          _sum: { amount: true },
        }),
      ]);

      // Year earnings (last 365 days)
      const yearStart = new Date();
      yearStart.setDate(yearStart.getDate() - 365);
      yearStart.setHours(0, 0, 0, 0);

      const yearOrders = await prisma.orders.aggregate({
        where: {
          seller_id: userId,
          status: { in: ['completed', 'delivered'] },
          completed_at: { gte: yearStart },
        },
        _sum: { amount: true },
      });

      // All-time earnings
      const allTimeOrders = await prisma.orders.aggregate({
        where: {
          seller_id: userId,
          status: { in: ['completed', 'delivered'] },
        },
        _sum: { amount: true },
      });

      // Get pending balance (orders delivered but not yet completed - in escrow)
      const pendingOrders = await prisma.orders.aggregate({
        where: {
          seller_id: userId,
          status: 'delivered',
        },
        _sum: { amount: true },
      });

      // Get orders to ship count
      const ordersToShip = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: { in: ['to_ship', 'paid'] },
        },
      });

      // Get orders in transit count
      const ordersInTransit = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: 'in_transit',
        },
      });

      // Get delivered orders awaiting completion
      const ordersDelivered = await prisma.orders.count({
        where: {
          seller_id: userId,
          status: 'delivered',
        },
      });

      // Get active listings count
      const activeListings = await prisma.listings.count({
        where: {
          seller_id: userId,
          status: 'active',
        },
      });

      // Get total views across all active listings
      const listingsWithViews = await prisma.listings.aggregate({
        where: {
          seller_id: userId,
          status: 'active',
        },
        _sum: { views: true },
      });

      // Get total favorites across all active listings
      const totalFavorites = await prisma.favorites.count({
        where: {
          listings: {
            seller_id: userId,
            status: 'active',
          },
        },
      });

     // Get review stats
const reviewStats = await prisma.reviews.aggregate({
  where: {
    reviewed_user_id: userId,
    review_type: 'buyer_to_seller',
  },
  _avg: { rating: true },
});

// Get review count separately (more reliable)
const reviewCount = await prisma.reviews.count({
  where: {
    reviewed_user_id: userId,
    review_type: 'buyer_to_seller',
  },
});

      // Calculate response rate (default to 100% for now)
      const responseRate = 100;

      // Calculate average shipping time for completed orders
      const shippedOrders = await prisma.orders.findMany({
        where: {
          seller_id: userId,
          status: 'completed',
          shipped_at: { not: null },
          paid_at: { not: null },
        },
        select: {
          paid_at: true,
          shipped_at: true,
        },
        take: 50,
      });

      let avgShippingTime = 0;
      if (shippedOrders.length > 0) {
        const totalDays = shippedOrders.reduce((acc, order) => {
          if (order.paid_at && order.shipped_at) {
            const days = (order.shipped_at.getTime() - order.paid_at.getTime()) / (1000 * 60 * 60 * 24);
            return acc + days;
          }
          return acc;
        }, 0);
        avgShippingTime = totalDays / shippedOrders.length;
      }

      const stats = {
        todayEarnings: Number(todayOrders._sum.amount) || 0,
  weekEarnings: Number(weekOrders._sum.amount) || 0,
  monthEarnings: Number(monthOrders._sum.amount) || 0,
  yearEarnings: Number(yearOrders._sum.amount) || 0,
  allTimeEarnings: Number(allTimeOrders._sum.amount) || 0,
  availableBalance: 0,
  pendingBalance: Number(pendingOrders._sum.amount) || 0,
  ordersToShip,
        ordersInTransit,
        ordersDelivered,
        activeListings,
        totalViews: Number(listingsWithViews._sum.views) || 0,
        totalFavorites,
        totalSales: user.total_sales || 0,
        rating: Number(reviewStats._avg.rating) || Number(user.rating) || 0,
        reviewCount: reviewCount,
        responseRate,
        avgShippingTime: Math.round(avgShippingTime * 10) / 10,
      };

      console.log('✅ Seller stats returned:', stats);
      res.json(stats);
    } catch (error) {
      console.error('❌ Get seller stats error:', error);
      res.status(500).json({ error: 'Failed to get seller stats' });
    }
  }

  /**
   * Get sold items for a user (public - for transparency)
   * GET /users/:userId/sold-items
   */
  static async getSoldItems(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      console.log('📦 GET /users/:userId/sold-items - User ID:', userId);

      const soldOrders = await prisma.orders.findMany({
        where: {
          seller_id: userId,
          status: {
            in: ['delivered', 'completed', 'reviewed'],
          },
        },
        include: {
          listings: {
            include: {
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
            },
          },
        },
        orderBy: {
          updated_at: 'desc',
        },
      });

      const items = soldOrders.map((order: any) => ({
        id: order.listing_id,
        title: order.listings?.title || 'Unknown Item',
        price: order.amount || order.listings?.price || 0,
        images: order.listings?.images?.map((img: any) => ({
          id: img.id,
          image_url: img.image_url,
        })) || [],
        sold_at: order.updated_at || order.created_at,
        brand: order.listings?.brand || null,
        category: order.listings?.category || null,
      }));

      console.log(`✅ Returned ${items.length} sold items for user ${userId}`);
      res.json({ items, total: items.length });
    } catch (error) {
      console.error('❌ Error fetching sold items:', error);
      res.status(500).json({ error: 'Failed to fetch sold items' });
    }
  }
}