// src/controllers/stripeConnectController.ts
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import Stripe from 'stripe';

// In-memory TTL cache for onboarding status (30-second window)
const statusCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedStatus(userId: string): any | null {
  const entry = statusCache.get(userId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  statusCache.delete(userId);
  return null;
}

function setCachedStatus(userId: string, data: any): void {
  statusCache.set(userId, {
    data,
    expiresAt: Date.now() + 30_000, // 30 seconds
  });
  // Prevent unbounded growth: prune expired entries periodically
  if (statusCache.size > 1000) {
    for (const [key, val] of statusCache) {
      if (val.expiresAt < Date.now()) statusCache.delete(key);
    }
  }
}

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

      // Fetch earnings from orders database (no Stripe calls needed)
      const [completedOrders, pendingEscrowOrders] = await Promise.all([
        // Total earned: completed orders where this user was the seller
        prisma.orders.findMany({
          where: {
            seller_id: userId,
            status: { in: ['completed', 'delivered'] },
          },
          select: { seller_payout: true },
        }),
        // Pending escrow: delivered but not yet released
        prisma.orders.findMany({
          where: {
            seller_id: userId,
            status: 'delivered',
          },
          select: { seller_payout: true },
        }),
      ]);

      const totalEarned = completedOrders.reduce(
        (sum, o) => sum + (o.seller_payout ? parseFloat(o.seller_payout.toString()) : 0), 0
      );
      const pendingEscrow = pendingEscrowOrders.reduce(
        (sum, o) => sum + (o.seller_payout ? parseFloat(o.seller_payout.toString()) : 0), 0
      );

      // Stripe balance (may be £0 if auto-payouts are on)
      let available = 0;
      let pending = 0;

      if (user?.stripe_connect_id) {
        try {
          const balance = await stripe.balance.retrieve({
            stripeAccount: user.stripe_connect_id,
          });
          available = (balance.available.find(b => b.currency === 'gbp')?.amount || 0) / 100;
          pending = (balance.pending.find(b => b.currency === 'gbp')?.amount || 0) / 100;
        } catch (balanceErr) {
          console.error('[BALANCE] Stripe balance fetch failed (non-fatal):', balanceErr);
        }
      }

      res.json({
        available,
        pending,
        currency: 'gbp',
        total_earned: totalEarned,
        pending_escrow: pendingEscrow,
        completed_sales_count: completedOrders.length,
      });
    } catch (error: any) {
      console.error('❌ Get balance error:', error);
      res.status(500).json({ error: error.message || 'Failed to get balance' });
    }
  }

  /**
   * Get composite onboarding status with pending balance
   * GET /api/stripe/connect/onboarding-status
   *
   * Returns the seller's Stripe Connect state as one of:
   *   complete | pending_review | incomplete | restricted
   * Plus their pending balance (earned-but-not-withdrawable) and
   * an onboarding URL if action is needed.
   */
  static async getOnboardingStatus(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Check cache first
      const cached = getCachedStatus(userId);
      if (cached) {
        return res.json(cached);
      }

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          stripe_connect_id: true,
          stripe_connect_status: true,
        },
      });

      // Compute pending balance: orders where seller earned but can't withdraw yet
      const pendingResult = await prisma.orders.aggregate({
        where: {
          seller_id: userId,
          status: { in: ['to_ship', 'in_transit', 'delivered'] },
        },
        _sum: { seller_payout: true },
      });
      const pendingBalancePence = Math.round(
        (pendingResult._sum.seller_payout
          ? parseFloat(pendingResult._sum.seller_payout.toString())
          : 0) * 100
      );
      const pendingBalanceFormatted = `£${(pendingBalancePence / 100).toFixed(2)}`;

      // No Stripe account at all — auto-create one then generate onboarding link
      if (!user?.stripe_connect_id) {
        let onboardingUrl: string | null = null;
        try {
          const account = await stripe.accounts.create({
            type: 'express',
            country: 'GB',
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            business_type: 'individual',
            business_profile: {
              mcc: '5699',
              product_description: 'Selling golf equipment on Mulligans',
            },
            metadata: { user_id: userId, platform: 'mulligans' },
          });

          await prisma.users.update({
            where: { id: userId },
            data: {
              stripe_connect_id: account.id,
              stripe_connect_status: 'pending',
              updated_at: new Date(),
            },
          });

          const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: 'https://api.mulligans.uk.com/connect/refresh',
            return_url: 'https://api.mulligans.uk.com/connect/return',
            type: 'account_onboarding',
          });
          onboardingUrl = accountLink.url;
        } catch (err) {
          console.error('[STRIPE] Failed to auto-create account for onboarding status:', err);
        }

        const result = {
          state: 'incomplete' as const,
          pending_balance_pence: pendingBalancePence,
          pending_balance_formatted: pendingBalanceFormatted,
          requirements_currently_due: [],
          onboarding_url: onboardingUrl,
          needs_action: true,
        };
        setCachedStatus(userId, result);
        return res.json(result);
      }

      // Has Stripe account — retrieve current status
      let account;
      try {
        account = await stripe.accounts.retrieve(user.stripe_connect_id);
      } catch (stripeErr) {
        console.error('[STRIPE] Failed to retrieve account:', stripeErr);
        const fallback = {
          state: 'incomplete' as const,
          pending_balance_pence: pendingBalancePence,
          pending_balance_formatted: pendingBalanceFormatted,
          requirements_currently_due: [],
          onboarding_url: null,
          needs_action: true,
        };
        return res.json(fallback);
      }

      // Derive the 4-state model
      let state: 'complete' | 'pending_review' | 'incomplete' | 'restricted';
      if (account.charges_enabled && account.payouts_enabled) {
        state = 'complete';
      } else if (account.requirements?.disabled_reason) {
        state = 'restricted';
      } else if (
        account.requirements?.currently_due &&
        account.requirements.currently_due.length > 0
      ) {
        state = 'incomplete';
      } else {
        state = 'pending_review';
      }

      // Update local status if changed
      const newStatus = state === 'complete' ? 'active' : state === 'restricted' ? 'restricted' : 'pending';
      if (newStatus !== user.stripe_connect_status) {
        await prisma.users.update({
          where: { id: userId },
          data: { stripe_connect_status: newStatus, updated_at: new Date() },
        });
      }

      // Generate onboarding URL only for actionable states
      let onboardingUrl: string | null = null;
      if (state === 'incomplete' || state === 'restricted') {
        try {
          const accountLink = await stripe.accountLinks.create({
            account: user.stripe_connect_id,
            refresh_url: 'https://api.mulligans.uk.com/connect/refresh',
            return_url: 'https://api.mulligans.uk.com/connect/return',
            type: 'account_onboarding',
          });
          onboardingUrl = accountLink.url;
        } catch (linkErr) {
          console.error('[STRIPE] Failed to create onboarding link:', linkErr);
        }
      }

      const result = {
        state,
        pending_balance_pence: pendingBalancePence,
        pending_balance_formatted: pendingBalanceFormatted,
        requirements_currently_due: account.requirements?.currently_due || [],
        onboarding_url: onboardingUrl,
        needs_action: state !== 'complete',
      };

      setCachedStatus(userId, result);
      res.json(result);
    } catch (error: any) {
      console.error('[STRIPE] Get onboarding status error:', error);
      res.status(500).json({ error: 'Failed to get onboarding status' });
    }
  }
}