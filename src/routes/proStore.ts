// src/routes/proStore.ts
// Pro store application endpoints for the web dashboard

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const VALID_SELLER_TYPES = ['pro_shop', 'online_retailer', 'brand'];
const VALID_ESTIMATED_LISTINGS = ['1-50', '51-200', '201-500', '500+'];

// Simple email format check
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Simple URL format check
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// POST /pro-store/apply — Submit a pro store application
router.post('/apply', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const {
      business_name,
      business_email,
      business_phone,
      website,
      seller_type,
      description,
      estimated_listings,
      instagram_handle,
      has_existing_store = false,
      existing_store_url,
    } = req.body;

    // Validate required fields
    if (!business_name || typeof business_name !== 'string' || business_name.trim().length === 0) {
      res.status(400).json({ error: 'business_name is required' });
      return;
    }
    if (business_name.length > 100) {
      res.status(400).json({ error: 'business_name must be 100 characters or less' });
      return;
    }
    if (!business_email || !isValidEmail(business_email)) {
      res.status(400).json({ error: 'A valid business_email is required' });
      return;
    }
    if (!business_phone || typeof business_phone !== 'string' || business_phone.trim().length === 0) {
      res.status(400).json({ error: 'business_phone is required' });
      return;
    }
    if (!website || !isValidUrl(website)) {
      res.status(400).json({ error: 'A valid website URL is required' });
      return;
    }
    if (!seller_type || !VALID_SELLER_TYPES.includes(seller_type)) {
      res.status(400).json({ error: `seller_type must be one of: ${VALID_SELLER_TYPES.join(', ')}` });
      return;
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (description.length > 500) {
      res.status(400).json({ error: 'description must be 500 characters or less' });
      return;
    }
    if (!estimated_listings || !VALID_ESTIMATED_LISTINGS.includes(estimated_listings)) {
      res.status(400).json({ error: `estimated_listings must be one of: ${VALID_ESTIMATED_LISTINGS.join(', ')}` });
      return;
    }
    if (has_existing_store && (!existing_store_url || !isValidUrl(existing_store_url))) {
      res.status(400).json({ error: 'existing_store_url is required when has_existing_store is true' });
      return;
    }

    // Check if user is already a pro store
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: { is_pro_store: true },
    });

    if (user?.is_pro_store) {
      res.status(409).json({ error: 'Already a pro store' });
      return;
    }

    // Check for existing pending or approved application
    const existingApplication = await prisma.pro_store_applications.findFirst({
      where: {
        user_id: userId,
        status: { in: ['pending', 'approved'] },
      },
    });

    if (existingApplication) {
      res.status(409).json({ error: 'Application already exists' });
      return;
    }

    // Create application
    const application = await prisma.pro_store_applications.create({
      data: {
        user_id: userId,
        business_name: business_name.trim(),
        business_email: business_email.trim().toLowerCase(),
        business_phone: business_phone.trim(),
        website: website.trim(),
        seller_type,
        description: description.trim(),
        estimated_listings,
        instagram_handle: instagram_handle?.trim() || null,
        has_existing_store: Boolean(has_existing_store),
        existing_store_url: has_existing_store ? existing_store_url?.trim() : null,
      },
    });

    // Exclude review_notes from response
    const { review_notes, ...responseData } = application;

    res.status(201).json(responseData);
  } catch (error) {
    console.error('Failed to submit pro store application:', error);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// GET /pro-store/application-status — Get authenticated user's most recent application
router.get('/application-status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const application = await prisma.pro_store_applications.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });

    if (!application) {
      res.status(404).json({ error: 'No application found' });
      return;
    }

    // Exclude review_notes from response
    const { review_notes, ...responseData } = application;

    res.json(responseData);
  } catch (error) {
    console.error('Failed to get application status:', error);
    res.status(500).json({ error: 'Failed to get application status' });
  }
});

export default router;
