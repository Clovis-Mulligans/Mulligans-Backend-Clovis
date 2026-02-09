// src/services/verificationService.ts
// Handles verified seller status checks
// UPDATED: Added push notifications

import { prisma } from '../lib/prisma';
import { sendPushNotification } from '../controllers/pushNotificationController';


// ============================================
// VERIFICATION CRITERIA
// ============================================
const CRITERIA = {
  MIN_SALES: 5,
  MIN_RATING: 4.0,
  MIN_ACCOUNT_AGE_DAYS: 30,
  MAX_SHIPPING_STRIKES: 1,
};

// ============================================
// CHECK AND UPDATE ALL USERS
// Called by cron job daily
// ============================================
export async function updateVerificationStatus(): Promise<void> {
  console.log('[VERIFY] Running verification status check...');

  try {
    const now = new Date();
    const minAccountDate = new Date(now.getTime() - CRITERIA.MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000);

    // Find users who SHOULD be verified
    const qualifiedUsers = await prisma.users.findMany({
      where: {
        total_sales: { gte: CRITERIA.MIN_SALES },
        rating: { gte: CRITERIA.MIN_RATING },
        created_at: { lte: minAccountDate },
        shipping_strikes: { lte: CRITERIA.MAX_SHIPPING_STRIKES },
        avatar_url: { not: null },
        is_verified_seller: false, // Not already verified
      },
      select: { id: true, display_name: true },
    });

    console.log(`[VERIFY] Found ${qualifiedUsers.length} users who qualify for verification`);

    // Grant verification
    for (const user of qualifiedUsers) {
      await prisma.users.update({
        where: { id: user.id },
        data: {
          is_verified_seller: true,
          verified_seller_at: now,
          updated_at: now,
        },
      });

      // Notify user
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: user.id,
          type: 'account',
          title: 'You\'re now a Verified Seller!',
          message: 'Congratulations! Your profile now displays the verified badge, and your listings will appear higher in search results.',
        },
      });

      // PUSH: Notify user of verification
      try {
        await sendPushNotification(
          user.id,
          'You\'re now a Verified Seller!',
          'Congratulations! Your profile now displays the verified badge.',
          { type: 'account', action: 'verified' }
        );
      } catch (pushErr) {
        console.error('[VERIFY] Push notification failed:', pushErr);
      }

      console.log(`[VERIFY] Verified: ${user.display_name || user.id}`);
    }

    // Find users who SHOULD LOSE verification
    const unqualifiedUsers = await prisma.users.findMany({
      where: {
        is_verified_seller: true,
        OR: [
          { rating: { lt: CRITERIA.MIN_RATING } },
          { shipping_strikes: { gt: CRITERIA.MAX_SHIPPING_STRIKES } },
        ],
      },
      select: { id: true, display_name: true },
    });

    console.log(`[VERIFY] Found ${unqualifiedUsers.length} users who no longer qualify`);

    // Remove verification
    for (const user of unqualifiedUsers) {
      await prisma.users.update({
        where: { id: user.id },
        data: {
          is_verified_seller: false,
          verified_seller_at: null,
          updated_at: now,
        },
      });

      // Notify user
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: user.id,
          type: 'account',
          title: 'Verified Status Update',
          message: 'Your verified seller status has been paused. Maintain a 4.0+ rating and avoid shipping issues to regain it.',
        },
      });

      // PUSH: Notify user of status change
      try {
        await sendPushNotification(
          user.id,
          'Verified Status Update',
          'Your verified seller status has been paused. Check your profile for details.',
          { type: 'account', action: 'unverified' }
        );
      } catch (pushErr) {
        console.error('[VERIFY] Push notification failed:', pushErr);
      }

      console.log(`[VERIFY] Unverified: ${user.display_name || user.id}`);
    }

    console.log('[VERIFY] Verification status check complete');
  } catch (error: any) {
    console.error('[VERIFY] Verification check failed:', error.message);
  }
}

// ============================================
// CHECK SINGLE USER (for API)
// ============================================
export async function checkUserVerification(userId: string): Promise<{
  isVerifiedSeller: boolean;
  meetsRequirements: boolean;
  requirements: {
    sales: { required: number; current: number; met: boolean };
    rating: { required: number; current: number; met: boolean };
    accountAge: { required: number; current: number; met: boolean };
    shippingStrikes: { required: number; current: number; met: boolean };
    hasPhoto: { met: boolean };
  };
}> {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      is_verified_seller: true,
      total_sales: true,
      rating: true,
      created_at: true,
      shipping_strikes: true,
      avatar_url: true,
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date();
  const accountAgeDays = Math.floor((now.getTime() - user.created_at.getTime()) / (24 * 60 * 60 * 1000));
  const currentRating = parseFloat(user.rating?.toString() || '0');

  const requirements = {
    sales: {
      required: CRITERIA.MIN_SALES,
      current: user.total_sales,
      met: user.total_sales >= CRITERIA.MIN_SALES,
    },
    rating: {
      required: CRITERIA.MIN_RATING,
      current: currentRating,
      met: currentRating >= CRITERIA.MIN_RATING,
    },
    accountAge: {
      required: CRITERIA.MIN_ACCOUNT_AGE_DAYS,
      current: accountAgeDays,
      met: accountAgeDays >= CRITERIA.MIN_ACCOUNT_AGE_DAYS,
    },
    shippingStrikes: {
      required: CRITERIA.MAX_SHIPPING_STRIKES,
      current: user.shipping_strikes,
      met: user.shipping_strikes <= CRITERIA.MAX_SHIPPING_STRIKES,
    },
    hasPhoto: {
      met: !!user.avatar_url,
    },
  };

  const meetsRequirements = Object.values(requirements).every((r) => r.met);

  return {
    isVerifiedSeller: user.is_verified_seller,
    meetsRequirements,
    requirements,
  };
}

export default {
  updateVerificationStatus,
  checkUserVerification,
};