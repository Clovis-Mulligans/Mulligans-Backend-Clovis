import { prisma } from '../lib/prisma';
import { sendPushNotification } from '../controllers/pushNotificationController';
import { REMINDER_TRIGGER_MS_AFTER_DELIVERY } from '../constants/inspection';
import { generateEmailActionToken } from '../routes/emailActionRoutes';
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_ADDRESS = 'Mulligans <hello@mail.mulligans.uk.com>';
const REPLY_TO_CUSTOMER = 'info@mulligans.uk.com';

function loadTemplate(templateName: string, variables: Record<string, string>): string {
  const templatePath = path.join(__dirname, '../../src/email-templates', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf-8');
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, value || '');
  });
  return html;
}

function shortId(orderId: string): string {
  const cleaned = orderId.replace(/^order_/, '');
  return cleaned.substring(0, 8);
}

/**
 * Send 24-hour inspection reminders for orders approaching escrow release.
 *
 * Finds orders where:
 * - Status is 'delivered'
 * - delivered_at was approximately REMINDER_TRIGGER_MS_AFTER_DELIVERY ago (±15 min)
 * - Buyer has NOT already confirmed or disputed
 * - reminder_sent_at IS NULL (idempotency)
 *
 * Called by the daily escrow cron at 2 AM UK time.
 */
export async function sendInspectionReminders(): Promise<void> {
  console.log('[REMINDER] Running inspection reminder check...');

  try {
    const now = new Date();
    const toleranceMs = 15 * 60 * 1000; // 15 minutes

    // Orders delivered approximately REMINDER_TRIGGER_DAYS ago
    const targetDeliveryTime = new Date(now.getTime() - REMINDER_TRIGGER_MS_AFTER_DELIVERY);
    const windowStart = new Date(targetDeliveryTime.getTime() - toleranceMs);
    const windowEnd = new Date(targetDeliveryTime.getTime() + toleranceMs);

    // Also catch any orders that should have received a reminder but didn't
    // (e.g., if cron missed a run). Include orders delivered up to
    // REMINDER_TRIGGER_MS ago that still haven't had a reminder sent.
    const latestDeliveryForReminder = new Date(now.getTime() - REMINDER_TRIGGER_MS_AFTER_DELIVERY + toleranceMs);

    const eligibleOrders = await prisma.orders.findMany({
      where: {
        status: 'delivered',
        delivered_at: {
          lte: latestDeliveryForReminder,
          not: null,
        },
        reminder_sent_at: null,
        escrow_release_at: {
          gt: now, // escrow hasn't released yet
        },
      },
      select: {
        id: true,
        buyer_id: true,
        delivered_at: true,
        escrow_release_at: true,
        listing_title: true,
        listing_image: true,
        listing_price: true,
        listings: {
          select: {
            title: true,
            images: {
              orderBy: { display_order: 'asc' as const },
              take: 1,
              select: { image_url: true },
            },
          },
        },
        users_orders_buyer_idTousers: {
          select: {
            email: true,
            display_name: true,
          },
        },
      },
    });

    // Filter out orders with active disputes or returns
    const ordersToRemind = [];
    for (const order of eligibleOrders) {
      const dispute = await prisma.disputes.findUnique({
        where: { order_id: order.id },
        select: { status: true },
      });
      if (dispute && ['open', 'counter_offered', 'escalated'].includes(dispute.status)) {
        console.log(`[REMINDER] Skipping order ${order.id} — active dispute`);
        continue;
      }

      const returnReq = await prisma.return_requests.findFirst({
        where: { order_id: order.id },
        select: { status: true },
      });
      if (returnReq && !['rejected', 'cancelled', 'completed'].includes(returnReq.status)) {
        console.log(`[REMINDER] Skipping order ${order.id} — active return`);
        continue;
      }

      ordersToRemind.push(order);
    }

    console.log(`[REMINDER] Found ${ordersToRemind.length} orders eligible for reminder`);

    for (const order of ordersToRemind) {
      try {
        const buyerEmail = order.users_orders_buyer_idTousers?.email;
        const buyerName = order.users_orders_buyer_idTousers?.display_name || 'there';
        const itemTitle = order.listing_title || order.listings?.title || 'Your item';
        const itemImage = order.listing_image || order.listings?.images?.[0]?.image_url || '';
        const itemPrice = order.listing_price
          ? `£${parseFloat(order.listing_price.toString()).toFixed(2)}`
          : '';

        const deliveredAt = order.delivered_at!;
        const daysSinceDelivery = Math.floor(
          (now.getTime() - deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
        );

        // Generate signed URLs for email buttons
        const confirmToken = generateEmailActionToken(
          order.id,
          order.buyer_id,
          'confirm-receipt',
          order.escrow_release_at!,
        );
        const reportToken = generateEmailActionToken(
          order.id,
          order.buyer_id,
          'report-issue',
          order.escrow_release_at!,
        );
        const confirmUrl = `https://api.mulligans.uk.com/api/email-actions/confirm-receipt?token=${confirmToken}`;
        const reportIssueUrl = `https://api.mulligans.uk.com/api/email-actions/report-issue?token=${reportToken}`;

        // Send email
        if (buyerEmail) {
          const html = loadTemplate('inspection-reminder', {
            buyerName,
            itemName: itemTitle,
            itemImageUrl: itemImage,
            itemPrice,
            orderReference: order.id,
            daysSinceDelivery: daysSinceDelivery.toString(),
            confirmUrl,
            reportIssueUrl,
          });

          await resend.emails.send({
            from: FROM_ADDRESS,
            to: buyerEmail,
            replyTo: REPLY_TO_CUSTOMER,
            subject: `24 hours left to confirm your Mulligans order`,
            html,
          });
          console.log(`[REMINDER] Email sent for order ${order.id} to ${buyerEmail}`);
        }

        // Send push notification
        try {
          await sendPushNotification(
            order.buyer_id,
            '24 hours to confirm your order',
            `Tap to confirm receipt or report an issue with your ${itemTitle}.`,
            {
              type: 'inspection_reminder',
              order_id: order.id,
              notification_id: `reminder_${order.id}_${Date.now()}`,
            },
          );
          console.log(`[REMINDER] Push sent for order ${order.id}`);
        } catch (pushErr) {
          console.error(`[REMINDER] Push failed for order ${order.id}:`, pushErr);
        }

        // Mark reminder as sent (idempotency)
        await prisma.orders.update({
          where: { id: order.id },
          data: { reminder_sent_at: now },
        });

        console.log(`[REMINDER] Reminder complete for order ${order.id}`);
      } catch (orderErr) {
        console.error(`[REMINDER] Failed to process order ${order.id}:`, orderErr);
      }
    }

    console.log('[REMINDER] Inspection reminder check complete');
  } catch (error: any) {
    console.error('[REMINDER] Reminder job failed:', error.message);
  }
}
