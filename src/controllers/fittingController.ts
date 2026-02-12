// src/controllers/fittingController.ts
// CRUD operations for fitting profiles, bag clubs, and swing data
//
// Pattern: Static class methods matching existing controller style
// Auth: All endpoints require authenticateToken middleware

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { S3Service } from '../services/s3Service';
import { extractSwingData } from '../services/chipService';

export class FittingController {
  // ============================================
  // FITTING PROFILE
  // ============================================

  /**
   * GET /api/fitting/profile
   * Get the authenticated user's fitting profile.
   */
  static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
        include: {
          bag_clubs: { orderBy: { created_at: 'asc' } },
          swing_data: { orderBy: { created_at: 'desc' } },
        },
      });

      if (!profile) {
        res.status(200).json({ profile: null });
        return;
      }

      res.status(200).json({ profile });
    } catch (error: any) {
      console.error('❌ Error fetching fitting profile:', error);
      res.status(500).json({ error: 'Failed to fetch fitting profile' });
    }
  }

  /**
   * POST /api/fitting/profile
   * Create or update the authenticated user's fitting profile (upsert).
   */
  static async upsertProfile(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const {
        handicap,
        dexterity,
        height_cm,
        looking_for,
        play_frequency,
        goals,
        budget_range,
        condition_pref,
        brand_preferences,
        glove_size,
      } = req.body;

      const profile = await prisma.fitting_profiles.upsert({
        where: { user_id: userId },
        create: {
          user_id: userId,
          handicap,
          dexterity,
          height_cm,
          looking_for: looking_for || [],
          play_frequency,
          goals: goals || [],
          budget_range,
          condition_pref,
          brand_preferences: brand_preferences || [],
          glove_size,
        },
        update: {
          handicap,
          dexterity,
          height_cm,
          looking_for: looking_for || [],
          play_frequency,
          goals: goals || [],
          budget_range,
          condition_pref,
          brand_preferences: brand_preferences || [],
          glove_size,
        },
        include: {
          bag_clubs: { orderBy: { created_at: 'asc' } },
          swing_data: { orderBy: { created_at: 'desc' } },
        },
      });

      res.status(200).json({ profile });
    } catch (error: any) {
      console.error('❌ Error upserting fitting profile:', error);
      res.status(500).json({ error: 'Failed to save fitting profile' });
    }
  }

  /**
   * DELETE /api/fitting/profile
   * Delete the authenticated user's fitting profile and all related data.
   */
  static async deleteProfile(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        res.status(404).json({ error: 'No fitting profile found' });
        return;
      }

      // Cascade delete handles bag_clubs and swing_data
      await prisma.fitting_profiles.delete({
        where: { user_id: userId },
      });

      res.status(200).json({ message: 'Fitting profile deleted' });
    } catch (error: any) {
      console.error('❌ Error deleting fitting profile:', error);
      res.status(500).json({ error: 'Failed to delete fitting profile' });
    }
  }

  // ============================================
  // BAG MANAGEMENT
  // ============================================

  /**
   * GET /api/fitting/bag
   * Get all clubs in the user's bag.
   */
  static async getBag(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        res.status(200).json({ clubs: [] });
        return;
      }

      const clubs = await prisma.fitting_bag_clubs.findMany({
        where: { profile_id: profile.id },
        orderBy: { created_at: 'asc' },
      });

      res.status(200).json({ clubs });
    } catch (error: any) {
      console.error('❌ Error fetching bag:', error);
      res.status(500).json({ error: 'Failed to fetch bag' });
    }
  }

  /**
   * POST /api/fitting/bag
   * Add a club to the user's bag. Max 14 clubs.
   */
  static async addClub(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Ensure profile exists
      let profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        // Auto-create minimal profile
        profile = await prisma.fitting_profiles.create({
          data: { user_id: userId },
        });
      }

      // Check 14-club limit
      const currentCount = await prisma.fitting_bag_clubs.count({
        where: { profile_id: profile.id },
      });

      if (currentCount >= 14) {
        res.status(400).json({ error: 'Maximum of 14 clubs allowed in your bag' });
        return;
      }

      const { club_type, brand, model, shaft_flex, loft, notes } = req.body;

      const club = await prisma.fitting_bag_clubs.create({
        data: {
          profile_id: profile.id,
          club_type,
          brand: brand || null,
          model: model || null,
          shaft_flex: shaft_flex || null,
          loft: loft || null,
          notes: notes || null,
        },
      });

      res.status(201).json({ club });
    } catch (error: any) {
      console.error('❌ Error adding club:', error);
      res.status(500).json({ error: 'Failed to add club' });
    }
  }

  /**
   * PUT /api/fitting/bag/:id
   * Update a club in the user's bag.
   */
  static async updateClub(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      // Verify ownership: club -> profile -> user
      const club = await prisma.fitting_bag_clubs.findUnique({
        where: { id },
        include: { profile: { select: { user_id: true } } },
      });

      if (!club) {
        res.status(404).json({ error: 'Club not found' });
        return;
      }

      if (club.profile.user_id !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      const { club_type, brand, model, shaft_flex, loft, notes } = req.body;

      const updated = await prisma.fitting_bag_clubs.update({
        where: { id },
        data: {
          ...(club_type !== undefined && { club_type }),
          ...(brand !== undefined && { brand }),
          ...(model !== undefined && { model }),
          ...(shaft_flex !== undefined && { shaft_flex }),
          ...(loft !== undefined && { loft }),
          ...(notes !== undefined && { notes }),
        },
      });

      res.status(200).json({ club: updated });
    } catch (error: any) {
      console.error('❌ Error updating club:', error);
      res.status(500).json({ error: 'Failed to update club' });
    }
  }

  /**
   * DELETE /api/fitting/bag/:id
   * Remove a club from the user's bag.
   */
  static async deleteClub(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      // Verify ownership
      const club = await prisma.fitting_bag_clubs.findUnique({
        where: { id },
        include: { profile: { select: { user_id: true } } },
      });

      if (!club) {
        res.status(404).json({ error: 'Club not found' });
        return;
      }

      if (club.profile.user_id !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      await prisma.fitting_bag_clubs.delete({ where: { id } });

      res.status(200).json({ message: 'Club removed from bag' });
    } catch (error: any) {
      console.error('❌ Error deleting club:', error);
      res.status(500).json({ error: 'Failed to remove club' });
    }
  }

  // ============================================
  // SWING DATA
  // ============================================

  /**
   * GET /api/fitting/swing-data
   * Get the user's swing data entries.
   */
  static async getSwingData(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        res.status(200).json({ swing_data: [] });
        return;
      }

      const swingData = await prisma.fitting_swing_data.findMany({
        where: { profile_id: profile.id },
        orderBy: { created_at: 'desc' },
      });

      res.status(200).json({ swing_data: swingData });
    } catch (error: any) {
      console.error('❌ Error fetching swing data:', error);
      res.status(500).json({ error: 'Failed to fetch swing data' });
    }
  }

  /**
   * POST /api/fitting/swing-data
   * Manually add swing data.
   */
  static async addSwingData(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Ensure profile exists
      let profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        profile = await prisma.fitting_profiles.create({
          data: { user_id: userId },
        });
      }

      const {
        club_type,
        club_speed_mph,
        ball_speed_mph,
        launch_angle_deg,
        spin_rate_rpm,
        carry_yards,
        smash_factor,
        source,
      } = req.body;

      const entry = await prisma.fitting_swing_data.create({
        data: {
          profile_id: profile.id,
          club_type: club_type || null,
          club_speed_mph: club_speed_mph || null,
          ball_speed_mph: ball_speed_mph || null,
          launch_angle_deg: launch_angle_deg || null,
          spin_rate_rpm: spin_rate_rpm || null,
          carry_yards: carry_yards || null,
          smash_factor: smash_factor || null,
          source,
        },
      });

      res.status(201).json({ swing_data: entry });
    } catch (error: any) {
      console.error('❌ Error adding swing data:', error);
      res.status(500).json({ error: 'Failed to add swing data' });
    }
  }

  /**
   * POST /api/fitting/swing-data/upload
   * Upload a launch monitor screenshot for AI extraction.
   */
  static async uploadSwingImage(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No image uploaded' });
        return;
      }

      // Validate file type
      if (!file.mimetype.startsWith('image/')) {
        res.status(400).json({ error: 'Only image files are allowed' });
        return;
      }

      // Ensure profile exists
      let profile = await prisma.fitting_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile) {
        profile = await prisma.fitting_profiles.create({
          data: { user_id: userId },
        });
      }

      // Upload to S3
      const uploadResult = await S3Service.uploadImage(
        file.buffer,
        file.mimetype,
        file.originalname
      );

      // Extract data via Claude Vision
      const clubType = req.body.club_type || undefined;
      const extraction = await extractSwingData(userId, uploadResult.url, clubType);

      if (!extraction.success || !extraction.data) {
        res.status(200).json({
          success: false,
          error: extraction.error,
          image_url: uploadResult.url,
        });
        return;
      }

      // Save extracted data
      const entry = await prisma.fitting_swing_data.create({
        data: {
          profile_id: profile.id,
          club_type: clubType || null,
          club_speed_mph: extraction.data.club_speed_mph || null,
          ball_speed_mph: extraction.data.ball_speed_mph || null,
          launch_angle_deg: extraction.data.launch_angle_deg || null,
          spin_rate_rpm: extraction.data.spin_rate_rpm || null,
          carry_yards: extraction.data.carry_yards || null,
          smash_factor: extraction.data.smash_factor || null,
          source: extraction.data.source || 'unknown',
          image_url: uploadResult.url,
        },
      });

      res.status(201).json({
        success: true,
        swing_data: entry,
        image_url: uploadResult.url,
      });
    } catch (error: any) {
      console.error('❌ Error uploading swing image:', error);
      res.status(500).json({ error: 'Failed to process swing data image' });
    }
  }

  /**
   * DELETE /api/fitting/swing-data/:id
   * Delete a swing data entry.
   */
  static async deleteSwingData(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      // Verify ownership
      const entry = await prisma.fitting_swing_data.findUnique({
        where: { id },
        include: { profile: { select: { user_id: true } } },
      });

      if (!entry) {
        res.status(404).json({ error: 'Swing data not found' });
        return;
      }

      if (entry.profile.user_id !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      await prisma.fitting_swing_data.delete({ where: { id } });

      res.status(200).json({ message: 'Swing data deleted' });
    } catch (error: any) {
      console.error('❌ Error deleting swing data:', error);
      res.status(500).json({ error: 'Failed to delete swing data' });
    }
  }
}
