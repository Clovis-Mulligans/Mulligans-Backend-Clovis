// src/routes/favoriteRoutes.ts
// UPDATED: Explicitly includes listing status for sold badge display
import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get user's favorites
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const favorites = await prisma.favorites.findMany({
      where: {
        user_id: req.user!.id,
        listings: { status: { not: 'deleted' } },
      },
      include: {
        listings: {
          include: {
            images: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    // Map listings and explicitly include status
    const listings = favorites.map(fav => ({
      ...fav.listings,
      status: fav.listings.status, // Explicitly include status (active, sold, etc.)
    }));
    
    res.json({ listings });
  } catch (error) {
    console.error('Failed to get favorites:', error);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Add favorite
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { listing_id } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    // Get the listing and current user info
    const listing = await prisma.listings.findUnique({
      where: { id: listing_id },
      select: {
        id: true,
        title: true,
        seller_id: true
      }
    });

    if (!listing) {
      res.status(404).json({ error: 'Listing not found' });
      return;
    }

    const currentUser = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        display_name: true
      }
    });

    const favorite = await prisma.favorites.create({
      data: {
        id: `fav_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: userId,
        listing_id
      }
    });

   // Create notification for the listing owner (only if not favoriting own listing)
    if (listing.seller_id !== userId) {
      // Get the listing's first image for the notification
      const listingImage = await prisma.images.findFirst({
        where: { listing_id: listing_id },
        orderBy: PRIMARY_IMAGE_ORDER,
      });

      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: listing.seller_id,
          type: 'favorite',
          title: 'New Favourite',
          message: `${currentUser?.display_name || 'Someone'} favourited your listing: ${listing.title}`,
          related_id: listing_id,
          related_user_id: userId,
          image_url: listingImage?.image_url || null
        }
      });
    }

    res.json(favorite);
  } catch (error) {
    console.error('Failed to add favorite:', error);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

// Remove favorite
router.delete('/:listing_id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await prisma.favorites.deleteMany({
      where: {
        user_id: req.user!.id,
        listing_id: req.params.listing_id
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to remove favorite:', error);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

// Check if listing is favorited
router.get('/check/:listing_id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const favorite = await prisma.favorites.findFirst({
      where: {
        user_id: req.user!.id,
        listing_id: req.params.listing_id
      }
    });

    res.json({ isFavorited: !!favorite });
  } catch (error) {
    console.error('Failed to check favorite:', error);
    res.status(500).json({ error: 'Failed to check favorite' });
  }
});

export default router;