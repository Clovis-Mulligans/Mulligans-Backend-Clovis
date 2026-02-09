// src/controllers/reviewController.ts
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

export class ReviewController {
  /**
   * Create a new review
   * POST /api/reviews
   */
  static async createReview(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { order_id, reviewed_user_id, rating, review_text, review_type } = req.body;

      console.log('⭐ Creating review for order:', order_id);

      // Validate required fields
      if (!order_id || !reviewed_user_id || !rating) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate rating
      if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      // Check order exists and user is part of it
      const order = await prisma.orders.findFirst({
        where: {
          id: order_id,
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: 'completed',
        },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or not completed' });
      }

      // Check if user already reviewed this order
      const existingReview = await prisma.reviews.findFirst({
        where: {
          order_id,
          reviewer_id: userId,
        },
      });

      if (existingReview) {
        return res.status(400).json({ error: 'You have already reviewed this order' });
      }

      // Create the review
      const review = await prisma.reviews.create({
        data: {
          id: uuidv4(),
          order_id,
          reviewer_id: userId,
          reviewed_user_id,
          rating,
          review_text: review_text || null,
          review_type: review_type || 'buyer_to_seller',
          is_public: true,
        },
      });

      // Update the reviewed user's average rating
      await ReviewController.updateUserRating(reviewed_user_id);

      console.log('✅ Review created:', review.id);
      res.status(201).json({ success: true, review });
    } catch (error: any) {
      console.error('❌ Create review error:', error);
      res.status(500).json({ error: 'Failed to create review' });
    }
  }

  /**
   * Get reviews for a user
   * GET /api/reviews/user/:userId
   */
  static async getUserReviews(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      console.log('📋 Fetching reviews for user:', userId);

      const reviews = await prisma.reviews.findMany({
        where: {
          reviewed_user_id: userId,
          is_public: true,
        },
        include: {
          users_reviews_reviewer_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
          orders: {
            select: {
              id: true,
              listings: {
                select: {
                  id: true,
                  title: true,
                  images: {
                    where: { is_primary: true },
                    select: { image_url: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
        take: limit,
        skip: offset,
      });

      // Get total count
      const totalCount = await prisma.reviews.count({
        where: {
          reviewed_user_id: userId,
          is_public: true,
        },
      });

      // Format response
      const formattedReviews = reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        review_text: review.review_text,
        review_type: review.review_type,
        created_at: review.created_at.toISOString(),
        reviewer: {
          id: review.users_reviews_reviewer_idTousers.id,
          display_name: review.users_reviews_reviewer_idTousers.display_name,
          avatar_url: review.users_reviews_reviewer_idTousers.avatar_url,
        },
        listing: review.orders.listings ? {
          id: review.orders.listings.id,
          title: review.orders.listings.title,
          image: review.orders.listings.images[0]?.image_url || null,
        } : null,
      }));

      console.log(`✅ Found ${formattedReviews.length} reviews`);

      res.json({
        reviews: formattedReviews,
        total: totalCount,
        hasMore: offset + reviews.length < totalCount,
      });
    } catch (error: any) {
      console.error('❌ Get user reviews error:', error);
      res.status(500).json({ error: 'Failed to get reviews' });
    }
  }

  /**
   * Get review statistics for a user
   * GET /api/reviews/user/:userId/stats
   */
  static async getUserReviewStats(req: Request, res: Response) {
    try {
      const { userId } = req.params;

      console.log('📊 Fetching review stats for user:', userId);

      const reviews = await prisma.reviews.findMany({
        where: {
          reviewed_user_id: userId,
          is_public: true,
        },
        select: {
          rating: true,
        },
      });

      const totalReviews = reviews.length;
      const averageRating = totalReviews > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
        : 0;

      // Count by rating
      const ratingCounts = {
        5: reviews.filter(r => r.rating === 5).length,
        4: reviews.filter(r => r.rating === 4).length,
        3: reviews.filter(r => r.rating === 3).length,
        2: reviews.filter(r => r.rating === 2).length,
        1: reviews.filter(r => r.rating === 1).length,
      };

      res.json({
        total_reviews: totalReviews,
        average_rating: Math.round(averageRating * 10) / 10,
        rating_counts: ratingCounts,
      });
    } catch (error: any) {
      console.error('❌ Get review stats error:', error);
      res.status(500).json({ error: 'Failed to get review stats' });
    }
  }

  /**
   * Get reviews written by the current user
   * GET /api/reviews/my-reviews
   */
  static async getMyReviews(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      console.log('📋 Fetching reviews written by:', userId);

      const reviews = await prisma.reviews.findMany({
        where: {
          reviewer_id: userId,
        },
        include: {
          users_reviews_reviewed_user_idTousers: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
          orders: {
            select: {
              id: true,
              listings: {
                select: {
                  id: true,
                  title: true,
                  images: {
                    where: { is_primary: true },
                    select: { image_url: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
      });

      const formattedReviews = reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        review_text: review.review_text,
        review_type: review.review_type,
        created_at: review.created_at.toISOString(),
        reviewed_user: {
          id: review.users_reviews_reviewed_user_idTousers.id,
          display_name: review.users_reviews_reviewed_user_idTousers.display_name,
          avatar_url: review.users_reviews_reviewed_user_idTousers.avatar_url,
        },
        listing: review.orders.listings ? {
          id: review.orders.listings.id,
          title: review.orders.listings.title,
          image: review.orders.listings.images[0]?.image_url || null,
        } : null,
      }));

      res.json({ reviews: formattedReviews });
    } catch (error: any) {
      console.error('❌ Get my reviews error:', error);
      res.status(500).json({ error: 'Failed to get reviews' });
    }
  }

  /**
   * Helper: Update user's average rating
   */
  private static async updateUserRating(userId: string) {
    try {
      const reviews = await prisma.reviews.findMany({
        where: {
          reviewed_user_id: userId,
          is_public: true,
        },
        select: {
          rating: true,
        },
      });

      const totalReviews = reviews.length;
      const averageRating = totalReviews > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
        : 0;

      await prisma.users.update({
        where: { id: userId },
        data: {
          rating: Math.round(averageRating * 100) / 100,
          updated_at: new Date(),
        },
      });

      console.log(`✅ Updated user ${userId} rating to ${averageRating.toFixed(2)}`);
    } catch (error) {
      console.error('❌ Update user rating error:', error);
    }
  }
}