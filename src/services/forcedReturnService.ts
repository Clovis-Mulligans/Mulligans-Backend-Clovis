// src/services/forcedReturnService.ts
// Forced return logic for high-value dispute refunds (≥70% of item cost).
// The buyer must return the item before receiving a 100% refund.

import { prisma } from '../lib/prisma';
import { Shippo } from 'shippo';
import { getSellerSendingAddress } from '../lib/sellerAddress';
import { sendPushNotification } from '../controllers/pushNotificationController';
import { PARCEL_SIZES } from '../controllers/shippingController';
import crypto from 'crypto';

const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// ============================================
// CONSTANTS
// ============================================
export const FORCED_RETURN_THRESHOLD = 0.70;
export const FORCED_RETURN_SHIP_DEADLINE_DAYS = 5;
export const FORCED_RETURN_SELLER_CONFIRM_DAYS = 3;
export const FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS = 14;

// ============================================
// THRESHOLD CHECK
// ============================================
export function isForceReturnThreshold(refundAmount: number, itemCost: number): boolean {
  if (itemCost <= 0) return false;
  return refundAmount >= itemCost * FORCED_RETURN_THRESHOLD;
}

// ============================================
// PAYER SEAM
// Today: platform absorbs forced-return label costs.
// Future: change this single function to 'seller' to enable seller-debit.
// ============================================
export function resolveReturnLabelPayer(returnRequest: { is_forced: boolean }): 'platform' | 'buyer' | 'seller' {
  if (returnRequest.is_forced) return 'platform';
  return 'buyer';
}

// ============================================
// RATE FILTERING (mirrored from autoShippingService — kept local to avoid coupling)
// ============================================
const UNTRACKED_KEYWORDS = [
  'untracked', 'economy', 'standard letter', 'postable',
  'large letter', '2nd class letter', 'media mail',
  'royal mail 24', 'royal mail 48',
];

const TRACKED_KEYWORDS = [
  'tracked', 'signed', 'express', 'next day', 'courier', 'priority',
  'parcel', 'guaranteed', 'special delivery', 'recorded', 'parcelforce',
  'dpd', 'evri', 'yodel', 'ups', 'fedex', 'dhl', 'hermes',
];

interface TrackedRate {
  id: string;
  carrier: string;
  service: string;
  price: number;
}

function filterTrackedRates(rates: any[]): TrackedRate[] {
  const tracked = rates.filter((rate: any) => {
    const serviceName = (rate.servicelevel?.name || '').toLowerCase();
    const serviceToken = (rate.servicelevel?.token || '').toLowerCase();
    const provider = (rate.provider || '').toLowerCase();

    const isUntracked = UNTRACKED_KEYWORDS.some(kw =>
      serviceName.includes(kw) || serviceToken.includes(kw)
    );
    if (isUntracked) return false;

    const isTracked = TRACKED_KEYWORDS.some(kw =>
      serviceName.includes(kw) || serviceToken.includes(kw) || provider.includes(kw)
    );

    const hasDeliveryEstimate = rate.estimatedDays !== undefined && rate.estimatedDays !== null;
    const isProbablyTracked = hasDeliveryEstimate && parseFloat(rate.amount) >= 2.50;

    return isTracked || isProbablyTracked;
  });

  return tracked
    .map((rate: any) => ({
      id: rate.objectId,
      carrier: rate.provider,
      service: rate.servicelevel?.name || 'Unknown',
      price: parseFloat(rate.amount),
    }))
    .sort((a: TrackedRate, b: TrackedRate) => a.price - b.price);
}

// ============================================
// CREATE FORCED RETURN
// ============================================
export interface CreateForcedReturnParams {
  orderId: string;
  disputeId: string;
  buyerId: string;
  sellerId: string;
  itemCost: number;
  listingTitle: string;
  listingImage: string | null;
}

export interface ForcedReturnResult {
  returnId: string;
  labelPurchased: boolean;
  labelUrl?: string;
  trackingNumber?: string;
  labelCost?: number;
  failureReason?: string;
}

export async function createForcedReturn(params: CreateForcedReturnParams): Promise<ForcedReturnResult> {
  const { orderId, disputeId, buyerId, sellerId, itemCost, listingTitle, listingImage } = params;

  console.log(`[FORCED-RETURN] Creating forced return for order ${orderId} (dispute ${disputeId})`);
  console.log(`  Item cost: £${itemCost.toFixed(2)}, refund on completion: £${itemCost.toFixed(2)} (100%)`);

  // 1. Create the return_request record
  const returnId = crypto.randomUUID();
  const now = new Date();

  await prisma.return_requests.create({
    data: {
      id: returnId,
      order_id: orderId,
      dispute_id: disputeId,
      requested_by: buyerId,
      approved_by: 'system',
      reason: 'forced_return_high_value_refund',
      status: 'approved',
      is_forced: true,
      refund_amount: itemCost,
      shipping_deducted: 0,
      created_at: now,
      updated_at: now,
    },
  });

  console.log(`[FORCED-RETURN] Return request created: ${returnId}`);

  // 2. Attempt auto-purchase of return label (platform-pays)
  let labelResult: { purchased: boolean; labelUrl?: string; trackingNumber?: string; carrier?: string; cost?: number; error?: string } = {
    purchased: false,
  };

  try {
    labelResult = await purchaseReturnLabelPlatform(returnId, orderId, buyerId, sellerId);
  } catch (labelErr: any) {
    console.error(`[FORCED-RETURN] Label purchase failed (non-fatal): ${labelErr.message}`);
    labelResult = { purchased: false, error: labelErr.message };
  }

  // 3. Notify both parties
  try {
    const buyerMessage = labelResult.purchased
      ? `You need to return "${listingTitle}" to receive your full refund of £${itemCost.toFixed(2)}. A prepaid return label has been created — print it and ship within ${FORCED_RETURN_SHIP_DEADLINE_DAYS} days.`
      : `You need to return "${listingTitle}" to receive your full refund of £${itemCost.toFixed(2)}. We're preparing your return label — check back shortly.`;

    await prisma.notifications.create({
      data: {
        id: crypto.randomUUID(),
        user_id: buyerId,
        type: 'forced_return',
        title: 'Return Required for Your Refund',
        message: buyerMessage,
        image_url: listingImage,
        related_id: returnId,
      },
    });

    await sendPushNotification(
      buyerId,
      'Return Required for Your Refund',
      `Return "${listingTitle}" within ${FORCED_RETURN_SHIP_DEADLINE_DAYS} days to receive your £${itemCost.toFixed(2)} refund.`,
      { type: 'forced_return', return_id: returnId, order_id: orderId }
    ).catch(err => console.error('[FORCED-RETURN] Push to buyer failed:', err));

    await prisma.notifications.create({
      data: {
        id: crypto.randomUUID(),
        user_id: sellerId,
        type: 'forced_return',
        title: 'Item Being Returned',
        message: `The buyer is returning "${listingTitle}". You will receive the item back. No payment will be released for this order.`,
        image_url: listingImage,
        related_id: returnId,
      },
    });

    await sendPushNotification(
      sellerId,
      'Item Being Returned',
      `"${listingTitle}" is being returned to you.`,
      { type: 'forced_return', return_id: returnId, order_id: orderId }
    ).catch(err => console.error('[FORCED-RETURN] Push to seller failed:', err));
  } catch (notifErr) {
    console.error('[FORCED-RETURN] Notification failed (non-fatal):', notifErr);
  }

  console.log(`[FORCED-RETURN] ✅ Forced return created: ${returnId} (label: ${labelResult.purchased ? 'yes' : 'no'})`);

  return {
    returnId,
    labelPurchased: labelResult.purchased,
    labelUrl: labelResult.labelUrl,
    trackingNumber: labelResult.trackingNumber,
    labelCost: labelResult.cost,
    failureReason: labelResult.error,
  };
}

// ============================================
// PURCHASE RETURN LABEL — PLATFORM PAYS
// Shippo charges Mulligans' account. Nobody is charged back.
// ============================================
async function purchaseReturnLabelPlatform(
  returnId: string,
  orderId: string,
  buyerId: string,
  sellerId: string,
): Promise<{ purchased: boolean; labelUrl?: string; trackingNumber?: string; carrier?: string; cost?: number; error?: string }> {
  // Get order with addresses
  const order = await prisma.orders.findUnique({
    where: { id: orderId },
    include: {
      listings: { select: { parcel_size: true } },
    },
  });

  if (!order) throw new Error('Order not found');

  // Get seller's sending address (return destination)
  const sellerAddr = await getSellerSendingAddress(sellerId);
  if (!sellerAddr.isReal || !sellerAddr.address) {
    console.warn(`[FORCED-RETURN] Seller ${sellerId} has no sending address — label cannot be auto-purchased`);
    return { purchased: false, error: 'seller_no_sending_address' };
  }

  // Get buyer's address from order
  const buyerAddress = order.shipping_address as any;
  if (!buyerAddress) {
    return { purchased: false, error: 'no_buyer_address_on_order' };
  }

  // Parcel config
  const parcelSize = order.listings?.parcel_size || 'medium';
  const parcelConfig = PARCEL_SIZES[parcelSize as keyof typeof PARCEL_SIZES] || PARCEL_SIZES.medium;

  // Create Shippo shipment (buyer → seller, reversed)
  console.log(`[FORCED-RETURN] Requesting return rates: ${parcelSize} parcel`);

  const shipment = await shippo.shipments.create({
    addressFrom: {
      name: buyerAddress.name || 'Buyer',
      street1: buyerAddress.line1 || buyerAddress.street1 || '1 Main Street',
      street2: buyerAddress.line2 || buyerAddress.street2 || '',
      city: buyerAddress.city || 'London',
      state: buyerAddress.county || buyerAddress.state || '',
      zip: buyerAddress.postcode || buyerAddress.postal_code || '',
      country: buyerAddress.country || 'GB',
    },
    addressTo: {
      name: sellerAddr.address.name,
      street1: sellerAddr.address.line1,
      street2: sellerAddr.address.line2 || '',
      city: sellerAddr.address.city,
      zip: sellerAddr.address.postal_code,
      country: sellerAddr.address.country,
    },
    parcels: [{
      length: parcelConfig.length,
      width: parcelConfig.width,
      height: parcelConfig.height,
      distanceUnit: 'cm',
      weight: parcelConfig.weight,
      massUnit: 'kg',
    }],
    async: false,
  });

  // Filter to tracked rates
  const trackedRates = filterTrackedRates(shipment.rates || []);

  if (trackedRates.length === 0) {
    console.warn(`[FORCED-RETURN] No tracked rates available (${shipment.rates?.length || 0} total)`);
    return { purchased: false, error: 'no_tracked_rates' };
  }

  const selectedRate = trackedRates[0]; // cheapest tracked
  console.log(`[FORCED-RETURN] Selected rate: ${selectedRate.carrier} ${selectedRate.service} — £${selectedRate.price.toFixed(2)}`);

  // Purchase label
  const transaction = await shippo.transactions.create({
    rate: selectedRate.id,
    labelFileType: 'PDF',
    async: false,
  });

  if (transaction.status !== 'SUCCESS') {
    console.error(`[FORCED-RETURN] Shippo transaction failed:`, transaction.messages);
    return { purchased: false, error: `shippo_transaction_failed: ${JSON.stringify(transaction.messages)}` };
  }

  let labelCost = selectedRate.price;
  if (labelCost === 0 && typeof transaction.rate === 'object' && transaction.rate !== null) {
    labelCost = parseFloat((transaction.rate as any).amount || '0');
  }

  // Update return with label info + set deadline
  const returnShipDeadline = new Date(Date.now() + FORCED_RETURN_SHIP_DEADLINE_DAYS * 24 * 60 * 60 * 1000);

  await prisma.return_requests.update({
    where: { id: returnId },
    data: {
      return_label_url: transaction.labelUrl,
      return_tracking_number: transaction.trackingNumber,
      return_carrier: selectedRate.carrier,
      label_cost: labelCost,
      paid_by: null,
      shippo_transaction_id: transaction.objectId,
      status: 'label_created',
      return_ship_deadline: returnShipDeadline,
      updated_at: new Date(),
    },
  });

  console.log(`[FORCED-RETURN] ✅ Label purchased: ${selectedRate.carrier} — £${labelCost.toFixed(2)}, deadline: ${returnShipDeadline.toISOString()}`);

  return {
    purchased: true,
    labelUrl: transaction.labelUrl || undefined,
    trackingNumber: transaction.trackingNumber || undefined,
    carrier: selectedRate.carrier,
    cost: labelCost,
  };
}
