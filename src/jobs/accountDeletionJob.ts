// src/jobs/accountDeletionJob.ts
// ============================================
// ACCOUNT DELETION CRON JOB
// ============================================
// Processes accounts that have passed their 30-day cooling-off period.
// Runs daily at 3:00 AM UK time (after escrow job at 2:00 AM).
//
// For each expired deletion request:
// 1. Anonymise user record (GDPR compliance)
// 2. Delete listing images from S3
// 3. Delete avatar from S3
// 4. Delete Cognito account
// 5. Delete listings (cascade handles images, favorites, etc.)
// 6. Delete cart items, favorites, notifications, offers, etc.
//
// IMPORTANT: 
// - Orders are NEVER deleted (HMRC requires 7-year retention for tax compliance).
// - Messages and conversations are PRESERVED — the other party should still
//   see their chat history. The anonymised user record (display_name: "Deleted User")
//   handles the display side naturally.
// - The user record is anonymised, not deleted, so order/review foreign keys remain valid.
//
// Each user's deletion is wrapped in try/catch so one failure doesn't block others.

import { prisma } from '../lib/prisma';
import { S3Service } from '../services/s3Service';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'eu-west-2',
});

/**
 * Extract the S3 key from a full S3 URL.
 * Example: https://bucket.s3.eu-west-2.amazonaws.com/listings/abc.jpg -> listings/abc.jpg
 */
function extractS3Key(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Remove leading slash from pathname
    const key = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Process all accounts that have passed their 30-day deletion deadline.
 * Called by the cron scheduler daily.
 */
export async function processAccountDeletions(): Promise<void> {
  const now = new Date();
  console.log(`[ACCOUNT-DELETION] Starting account deletion processing at ${now.toISOString()}`);

  // Find all users whose deletion_scheduled_for has passed
  const usersToDelete = await prisma.users.findMany({
    where: {
      deletion_scheduled_for: {
        lt: now,
      },
    },
    select: {
      id: true,
      email: true,
      display_name: true,
      cognito_id: true,
      avatar_url: true,
    },
  });

  if (usersToDelete.length === 0) {
    console.log('[ACCOUNT-DELETION] No accounts to delete');
    return;
  }

  console.log(`[ACCOUNT-DELETION] Found ${usersToDelete.length} account(s) to delete`);

  let successCount = 0;
  let failureCount = 0;

  for (const user of usersToDelete) {
    try {
      console.log(`[ACCOUNT-DELETION] Processing deletion for user ${user.id} (${user.email})`);

      // ============================================
      // STEP 1: Collect S3 keys for listing images
      // ============================================
      const listingImages = await prisma.images.findMany({
        where: {
          listings: {
            seller_id: user.id,
          },
        },
        select: {
          s3_key: true,
        },
      });

      const s3KeysToDelete: string[] = listingImages
        .map(img => img.s3_key)
        .filter((key): key is string => !!key);

      console.log(`[ACCOUNT-DELETION] User ${user.id}: Found ${s3KeysToDelete.length} listing image(s) to delete from S3`);

      // ============================================
      // STEP 2: Collect avatar S3 key
      // ============================================
      if (user.avatar_url) {
        const avatarKey = extractS3Key(user.avatar_url);
        if (avatarKey) {
          s3KeysToDelete.push(avatarKey);
          console.log(`[ACCOUNT-DELETION] User ${user.id}: Avatar key added: ${avatarKey}`);
        }
      }

      // ============================================
      // STEP 3: Delete images from S3
      // ============================================
      if (s3KeysToDelete.length > 0) {
        try {
          // Process in batches of 50 to avoid overwhelming S3
          const batchSize = 50;
          for (let i = 0; i < s3KeysToDelete.length; i += batchSize) {
            const batch = s3KeysToDelete.slice(i, i + batchSize);
            await S3Service.deleteImages(batch);
            console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted S3 batch ${Math.floor(i / batchSize) + 1} (${batch.length} files)`);
          }
          console.log(`[ACCOUNT-DELETION] User ${user.id}: All ${s3KeysToDelete.length} S3 files deleted`);
        } catch (s3Error) {
          // Log but don't fail the entire deletion — orphaned S3 files are less critical
          console.error(`[ACCOUNT-DELETION] User ${user.id}: S3 deletion error (continuing):`, s3Error);
        }
      }

      // ============================================
      // STEP 4: Delete Cognito account
      // ============================================
      if (user.cognito_id && !user.cognito_id.startsWith('deleted_')) {
        try {
          const deleteCommand = new AdminDeleteUserCommand({
            UserPoolId: process.env.COGNITO_USER_POOL_ID!,
            Username: user.email,
          });
          await cognitoClient.send(deleteCommand);
          console.log(`[ACCOUNT-DELETION] User ${user.id}: Cognito account deleted`);
        } catch (cognitoError: any) {
          // UserNotFoundException means already deleted — that's fine
          if (cognitoError.name === 'UserNotFoundException') {
            console.log(`[ACCOUNT-DELETION] User ${user.id}: Cognito account already deleted`);
          } else {
            // Log but continue — we can clean up Cognito manually later
            console.error(`[ACCOUNT-DELETION] User ${user.id}: Cognito deletion error (continuing):`, cognitoError);
          }
        }
      }

      // ============================================
      // STEP 5: Delete related data in database
      // ============================================
      // Use a transaction for database operations to ensure consistency.
      //
      // NOTE: Messages and conversations are intentionally NOT deleted.
      // The other party should still see their chat history — the anonymised
      // user record (display_name: "Deleted User") handles the display naturally.
      await prisma.$transaction(async (tx) => {
        // 5a. Delete cart items
        const deletedCartItems = await tx.cart_items.deleteMany({
          where: { user_id: user.id },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedCartItems.count} cart item(s)`);

        // 5b. Delete favorites
        const deletedFavorites = await tx.favorites.deleteMany({
          where: { user_id: user.id },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedFavorites.count} favorite(s)`);

        // 5c. Delete notifications (both received and triggered)
        const deletedNotifications = await tx.notifications.deleteMany({
          where: {
            OR: [
              { user_id: user.id },
              { related_user_id: user.id },
            ],
          },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedNotifications.count} notification(s)`);

        // 5d. Delete offers (as buyer or seller)
        // Must delete before listings since offers reference listings
        const deletedOffers = await tx.offers.deleteMany({
          where: {
            OR: [
              { buyer_id: user.id },
              { seller_id: user.id },
            ],
          },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedOffers.count} offer(s)`);

        // 5e. Delete listings (cascade will handle images, listing_attributes, etc.)
        const deletedListings = await tx.listings.deleteMany({
          where: { seller_id: user.id },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedListings.count} listing(s)`);

        // 5f. Delete feedback
        const deletedFeedback = await tx.feedback.deleteMany({
          where: { userId: user.id },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedFeedback.count} feedback item(s)`);

        // 5g. Delete support tickets (cascade handles support_ticket_images)
        const deletedTickets = await tx.support_tickets.deleteMany({
          where: { user_id: user.id },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedTickets.count} support ticket(s)`);

        // 5h. Delete blocked users relationships
        const deletedBlocks = await tx.blocked_users.deleteMany({
          where: {
            OR: [
              { blocker_id: user.id },
              { blocked_id: user.id },
            ],
          },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedBlocks.count} block relationship(s)`);

        // 5i. Delete user reports (as reporter or reported)
        const deletedReports = await tx.user_reports.deleteMany({
          where: {
            OR: [
              { reporter_id: user.id },
              { reported_user_id: user.id },
            ],
          },
        });
        console.log(`[ACCOUNT-DELETION] User ${user.id}: Deleted ${deletedReports.count} user report(s)`);

        // ============================================
        // STEP 6: Anonymise the user record
        // ============================================
        // We anonymise rather than delete because:
        // - Orders reference user IDs (tax compliance — 7 year retention)
        // - Reviews reference user IDs
        // - Messages reference user IDs (preserved for other party)
        // - Return requests reference user IDs
        // - Disputes reference user IDs
        await tx.users.update({
          where: { id: user.id },
          data: {
            display_name: 'Deleted User',
            email: `deleted_${user.id}@mulligans.uk.com`,
            phone: null,
            bio: null,
            avatar_url: null,
            location: null,
            postcode_area: null,
            push_token: null,
            push_token_platform: null,
            password_reset_code: null,
            verification_code: null,
            cognito_id: `deleted_${user.id}`,
            handicap: null,
            clothing_size: [],
            shoe_size: [],
            glove_size: [],
            // FIX #3: Clear Stripe Connect traceable link (GDPR)
            stripe_connect_id: null,
            stripe_connect_status: null,
            // Clear notification preferences
            email_notifications: false,
            order_notifications: false,
            marketing_emails: false,
            // Clear shipping preferences
            preferred_carriers: null,
            default_shipping_cost: null,
            offers_free_shipping: false,
            sizing_preference: null,
            // Clear verification data
            password_reset_code_expires: null,
            verification_code_expires: null,
            // Reset counters
            shipping_strikes: 0,
            buyer_cancellation_count: 0,
            seller_cancellation_count: 0,
            // Keep deletion timestamps for audit trail
            // deletion_requested_at: kept
            // deletion_scheduled_for: kept
            updated_at: new Date(),
          },
        });

        console.log(`[ACCOUNT-DELETION] User ${user.id}: Record anonymised`);
      });

      successCount++;
      console.log(`[ACCOUNT-DELETION] User ${user.id}: Deletion completed successfully`);

    } catch (error) {
      failureCount++;
      console.error(`[ACCOUNT-DELETION] User ${user.id}: Deletion FAILED:`, error);
      // Continue to next user — don't let one failure block others
    }
  }

  console.log(`[ACCOUNT-DELETION] Processing complete. Success: ${successCount}, Failed: ${failureCount}, Total: ${usersToDelete.length}`);
}
