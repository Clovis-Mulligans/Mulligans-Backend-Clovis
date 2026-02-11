// src/controllers/accountDeletionController.ts
// ============================================
// ACCOUNT DELETION CONTROLLER
// ============================================
// Handles the 30-day cooling-off account deletion flow:
// - Request deletion (with password verification)
// - Cancel deletion (within 30-day window)
// - Check deletion status
// - Legacy endpoint redirect
//
// UK consumer protection requires a reasonable cooling-off period.
// Apple/Google require account deletion capability in apps.
// Orders are NEVER deleted (HMRC requires 7-year retention).

import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  sendDeletionRequested,
  sendDeletionCancelled,
  sendDeletionAdminNotification,
} from '../services/emailService';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'eu-west-2',
});

export class AccountDeletionController {
  /**
   * POST /api/users/request-deletion
   * Body: { password: string }
   *
   * Initiates the 30-day account deletion process:
   * 1. Check for blocking conditions (active orders, open disputes, pending payouts)
   * 2. Verify password against Cognito
   * 3. Set pending_deletion state
   * 4. Suspend all active listings
   * 5. Send confirmation email + admin notification
   */
  static async requestDeletion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { password } = req.body;

      console.log(`[ACCOUNT-DELETION] User ${userId} requesting account deletion`);

      if (!password) {
        res.status(400).json({ error: 'Password is required to confirm account deletion' });
        return;
      }

      // Fetch user
      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          cognito_id: true,
          deletion_requested_at: true,
          stripe_connect_id: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Check if already pending deletion
      if (user.deletion_requested_at) {
        res.status(400).json({
          error: 'Account deletion already requested',
          message: 'Your account is already scheduled for deletion. You can cancel this from your privacy settings.',
        });
        return;
      }

      // === BLOCKING CONDITIONS ===

      // 1. Active orders (as buyer or seller) — these MUST complete first
      const activeOrders = await prisma.orders.findMany({
        where: {
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: {
            in: ['pending', 'paid', 'shipped', 'processing', 'to_ship', 'in_transit'],
          },
        },
        select: {
          id: true,
          status: true,
          listing_title: true,
        },
      });

      if (activeOrders.length > 0) {
        console.log(`[ACCOUNT-DELETION] Blocked: ${activeOrders.length} active orders for user ${userId}`);
        res.status(409).json({
          error: 'Cannot delete account with active orders',
          message: `You have ${activeOrders.length} active order(s) that must be completed or cancelled before you can delete your account.`,
          blocking_orders: activeOrders.map(o => ({
            id: o.id,
            status: o.status,
            title: o.listing_title || 'Unknown item',
          })),
        });
        return;
      }

      // 2. Open disputes — must be resolved before deletion
      const openDisputes = await prisma.disputes.findMany({
        where: {
          OR: [
            { buyer_id: userId },
            { seller_id: userId },
          ],
          status: {
            in: ['open', 'pending', 'under_review', 'awaiting_seller', 'escalated'],
          },
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (openDisputes.length > 0) {
        console.log(`[ACCOUNT-DELETION] Blocked: ${openDisputes.length} open disputes for user ${userId}`);
        res.status(409).json({
          error: 'Cannot delete account with open disputes',
          message: `You have ${openDisputes.length} open dispute(s) that must be resolved before you can delete your account.`,
          blocking_disputes: openDisputes.map(d => ({
            id: d.id,
            status: d.status,
          })),
        });
        return;
      }

      // 3. Pending payouts (delivered orders still in escrow)
      const pendingPayouts = await prisma.orders.findMany({
        where: {
          seller_id: userId,
          status: 'delivered',
        },
        select: {
          id: true,
          seller_payout: true,
          listing_title: true,
        },
      });

      if (pendingPayouts.length > 0) {
        const totalPending = pendingPayouts.reduce(
          (sum, o) => sum + Number(o.seller_payout || 0), 0
        );
        console.log(`[ACCOUNT-DELETION] Blocked: ${pendingPayouts.length} pending payouts (GBP ${totalPending.toFixed(2)}) for user ${userId}`);
        res.status(409).json({
          error: 'Cannot delete account with pending payouts',
          message: `You have ${pendingPayouts.length} order(s) with unreleased funds (\u00A3${totalPending.toFixed(2)}). Please wait for escrow to release before deleting your account.`,
          blocking_payouts: pendingPayouts.map(p => ({
            id: p.id,
            amount: Number(p.seller_payout || 0),
            title: p.listing_title || 'Unknown item',
          })),
        });
        return;
      }

      // === VERIFY PASSWORD AGAINST COGNITO ===
      try {
        const authCommand = new InitiateAuthCommand({
          ClientId: process.env.COGNITO_CLIENT_ID!,
          AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
          AuthParameters: {
            USERNAME: user.email,
            PASSWORD: password,
          },
        });

        const authResult = await cognitoClient.send(authCommand);

        if (!authResult.AuthenticationResult) {
          res.status(401).json({ error: 'Incorrect password' });
          return;
        }
      } catch (authError: any) {
        console.log(`[ACCOUNT-DELETION] Password verification failed for user ${userId}`);
        if (authError.name === 'NotAuthorizedException') {
          res.status(401).json({ error: 'Incorrect password' });
          return;
        }
        // Re-throw unexpected Cognito errors
        throw authError;
      }

      // === SET PENDING DELETION STATE ===
      const now = new Date();
      const deletionDate = new Date(now);
      deletionDate.setDate(deletionDate.getDate() + 30);

      // Use transaction: update user + suspend all active listings atomically
      const [updatedUser, suspendedResult] = await prisma.$transaction(async (tx) => {
        // Mark user as pending deletion
        const updated = await tx.users.update({
          where: { id: userId },
          data: {
            deletion_requested_at: now,
            deletion_scheduled_for: deletionDate,
            updated_at: now,
          },
        });

        // Suspend all active listings so they don't appear in search
        const suspended = await tx.listings.updateMany({
          where: {
            seller_id: userId,
            status: 'active',
          },
          data: {
            status: 'suspended',
            updated_at: now,
          },
        });

        return [updated, suspended];
      });

      const suspendedCount = suspendedResult.count;

      console.log(`[ACCOUNT-DELETION] User ${userId} set to pending deletion. ${suspendedCount} listings suspended. Scheduled for: ${deletionDate.toISOString()}`);

      // Send confirmation email to user (non-blocking — don't fail request if email fails)
      try {
        await sendDeletionRequested(user.email, {
          userName: user.display_name || 'there',
          deletionDate: deletionDate.toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
          listingsSuspended: suspendedCount,
        });
      } catch (emailError) {
        console.error('[ACCOUNT-DELETION] Failed to send confirmation email:', emailError);
      }

      // Send admin notification (non-blocking)
      try {
        await sendDeletionAdminNotification({
          userId: userId,
          userEmail: user.email,
          userName: user.display_name || 'Unknown',
          deletionDate: deletionDate.toISOString(),
          listingsSuspended: suspendedCount,
        });
      } catch (emailError) {
        console.error('[ACCOUNT-DELETION] Failed to send admin notification:', emailError);
      }

      // FIX #5: Include days_remaining in response so frontend can display immediately
      res.json({
        message: 'Account deletion requested successfully',
        deletion_scheduled_for: deletionDate.toISOString(),
        days_remaining: 30,
        listings_suspended: suspendedCount,
      });
    } catch (error) {
      console.error('[ACCOUNT-DELETION] Request deletion error:', error);
      res.status(500).json({ error: 'Failed to process deletion request' });
    }
  }

  /**
   * POST /api/users/cancel-deletion
   *
   * Cancels a pending account deletion:
   * 1. Clear deletion timestamps
   * 2. Reactivate suspended listings
   * 3. Send confirmation email
   */
  static async cancelDeletion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;

      console.log(`[ACCOUNT-DELETION] User ${userId} cancelling deletion`);

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          deletion_requested_at: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      if (!user.deletion_requested_at) {
        res.status(400).json({ error: 'No pending deletion to cancel' });
        return;
      }

      // Transaction: clear deletion state + reactivate suspended listings
      const [updatedUser, reactivatedResult] = await prisma.$transaction(async (tx) => {
        const updated = await tx.users.update({
          where: { id: userId },
          data: {
            deletion_requested_at: null,
            deletion_scheduled_for: null,
            updated_at: new Date(),
          },
        });

        // Reactivate suspended listings
        // Only listings with status 'suspended' are affected —
        // listings that were 'sold', 'draft', or 'deleted' stay as they were
        const reactivated = await tx.listings.updateMany({
          where: {
            seller_id: userId,
            status: 'suspended',
          },
          data: {
            status: 'active',
            updated_at: new Date(),
          },
        });

        return [updated, reactivated];
      });

      const reactivatedCount = reactivatedResult.count;

      console.log(`[ACCOUNT-DELETION] Deletion cancelled for user ${userId}. ${reactivatedCount} listings reactivated.`);

      // Send confirmation email (non-blocking)
      try {
        await sendDeletionCancelled(user.email, {
          userName: user.display_name || 'there',
          listingsReactivated: reactivatedCount,
        });
      } catch (emailError) {
        console.error('[ACCOUNT-DELETION] Failed to send cancellation email:', emailError);
      }

      res.json({
        message: 'Account deletion cancelled successfully',
        listings_reactivated: reactivatedCount,
      });
    } catch (error) {
      console.error('[ACCOUNT-DELETION] Cancel deletion error:', error);
      res.status(500).json({ error: 'Failed to cancel deletion' });
    }
  }

  /**
   * GET /api/users/deletion-status
   *
   * Returns the current deletion state for the authenticated user.
   * Used by the mobile app to show countdown / warning UI.
   */
  static async getDeletionStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;

      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          deletion_requested_at: true,
          deletion_scheduled_for: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      if (!user.deletion_requested_at || !user.deletion_scheduled_for) {
        res.json({
          pending: false,
          deletion_requested_at: null,
          deletion_scheduled_for: null,
          days_remaining: null,
        });
        return;
      }

      const now = new Date();
      const msRemaining = user.deletion_scheduled_for.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));

      res.json({
        pending: true,
        deletion_requested_at: user.deletion_requested_at.toISOString(),
        deletion_scheduled_for: user.deletion_scheduled_for.toISOString(),
        days_remaining: daysRemaining,
      });
    } catch (error) {
      console.error('[ACCOUNT-DELETION] Get status error:', error);
      res.status(500).json({ error: 'Failed to get deletion status' });
    }
  }

  /**
   * DELETE /api/users/account (legacy endpoint)
   *
   * Returns an error directing users to the new flow.
   * Kept for backwards compatibility with old app versions that may
   * still call this endpoint directly.
   */
  static async legacyDeleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.status(410).json({
      error: 'This endpoint has been replaced',
      message: 'Account deletion now uses a 30-day cooling off period for your protection. Please use the updated privacy settings in the app to request account deletion.',
    });
  }
}
