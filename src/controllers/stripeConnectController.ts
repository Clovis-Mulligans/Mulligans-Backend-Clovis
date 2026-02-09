// src/controllers/stripeConnectController.ts
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

export class StripeConnectController {
  /**
   * Create a Connect Express account for a seller
   * POST /api/stripe/connect/create-account
   */
  static async createAccount(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Check if user already has a Connect account
      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { 
          id: true, 
          email: true, 
          stripe_connect_id: true,
          display_name: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // If they already have an account, return it
      if (user.stripe_connect_id) {
        console.log('📦 User already has Connect account:', user.stripe_connect_id);
        return res.json({ 
          account_id: user.stripe_connect_id,
          already_exists: true,
        });
      }

      console.log('🔗 Creating Stripe Connect account for user:', userId);

     // Create Express account
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        business_profile: {
          mcc: '5699',
          product_description: 'Selling golf equipment on Mulligans',
        },
        metadata: {
          user_id: userId,
          platform: 'mulligans',
        },
      });

      // Save Connect ID to database
      await prisma.users.update({
        where: { id: userId },
        data: {
          stripe_connect_id: account.id,
          stripe_connect_status: 'pending',
          updated_at: new Date(),
        },
      });

      console.log('✅ Connect account created:', account.id);

      res.json({
        account_id: account.id,
        already_exists: false,
      });
    } catch (error: any) {
      console.error('❌ Create Connect account error:', error);
      res.status(500).json({ error: error.message || 'Failed to create account' });
    }
  }

  /**
   * Generate onboarding link for seller
   * POST /api/stripe/connect/onboarding-link
   */
  static async createOnboardingLink(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { return_url, refresh_url } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { stripe_connect_id: true },
      });

      if (!user?.stripe_connect_id) {
        return res.status(400).json({ error: 'No Connect account found. Create one first.' });
      }

      console.log('🔗 Creating onboarding link for:', user.stripe_connect_id);

      const accountLink = await stripe.accountLinks.create({
        account: user.stripe_connect_id,
        refresh_url: refresh_url || 'https://api.mulligans.uk.com/connect/refresh',
return_url: return_url || 'https://api.mulligans.uk.com/connect/return',
        type: 'account_onboarding',
      });

      console.log('✅ Onboarding link created');

      res.json({ url: accountLink.url });
    } catch (error: any) {
      console.error('❌ Create onboarding link error:', error);
      res.status(500).json({ error: error.message || 'Failed to create link' });
    }
  }

  /**
   * Get account status
   * GET /api/stripe/connect/account-status
   */
  static async getAccountStatus(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { 
          stripe_connect_id: true,
          stripe_connect_status: true,
        },
      });

      if (!user?.stripe_connect_id) {
        return res.json({
          has_account: false,
          status: null,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
        });
      }

      // Fetch current status from Stripe
      const account = await stripe.accounts.retrieve(user.stripe_connect_id);

      // Update local status if changed
      let newStatus = 'pending';
      if (account.charges_enabled && account.payouts_enabled) {
        newStatus = 'active';
      } else if (account.requirements?.disabled_reason) {
        newStatus = 'restricted';
      }

      if (newStatus !== user.stripe_connect_status) {
        await prisma.users.update({
          where: { id: userId },
          data: {
            stripe_connect_status: newStatus,
            updated_at: new Date(),
          },
        });
      }

      res.json({
        has_account: true,
        account_id: account.id,
        status: newStatus,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        requirements: account.requirements,
      });
    } catch (error: any) {
      console.error('❌ Get account status error:', error);
      res.status(500).json({ error: error.message || 'Failed to get status' });
    }
  }

  /**
   * Get Connect dashboard link (for sellers to view their earnings)
   * GET /api/stripe/connect/dashboard-link
   */
  static async getDashboardLink(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { stripe_connect_id: true },
      });

      if (!user?.stripe_connect_id) {
        return res.status(400).json({ error: 'No Connect account found' });
      }

      const loginLink = await stripe.accounts.createLoginLink(user.stripe_connect_id);

      res.json({ url: loginLink.url });
    } catch (error: any) {
      console.error('❌ Get dashboard link error:', error);
      res.status(500).json({ error: error.message || 'Failed to get dashboard link' });
    }
  }

  /**
   * Get seller balance
   * GET /api/stripe/connect/balance
   */
  static async getBalance(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { stripe_connect_id: true },
      });

      if (!user?.stripe_connect_id) {
        return res.json({
          available: 0,
          pending: 0,
          currency: 'gbp',
        });
      }

      const balance = await stripe.balance.retrieve({
        stripeAccount: user.stripe_connect_id,
      });

      const available = balance.available.find(b => b.currency === 'gbp')?.amount || 0;
      const pending = balance.pending.find(b => b.currency === 'gbp')?.amount || 0;

      res.json({
        available: available / 100, // Convert from pence to pounds
        pending: pending / 100,
        currency: 'gbp',
      });
    } catch (error: any) {
      console.error('❌ Get balance error:', error);
      res.status(500).json({ error: error.message || 'Failed to get balance' });
    }
  }
}