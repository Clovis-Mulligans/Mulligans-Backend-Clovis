// src/services/autoShippingService.ts
// Auto-purchases the best-value tracked shipping label when payment succeeds.
// Called synchronously from checkout fulfillment paths.
// On failure, order stays in 'to_ship' without a label — seller uses manual wizard.

import { prisma } from '../lib/prisma';
import { normalizeCarrierName } from '../utils/carrierName';
import { Shippo } from 'shippo';
import { PARCEL_SIZES } from '../controllers/shippingController';
import { getSellerSendingAddress } from '../lib/sellerAddress';

const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// ============================================
// TYPES
// ============================================

interface TrackedRate {
  id: string;
  carrier: string;
  service: string;
  price: number;
  currency: string;
  estimatedDays: number | null;
}

interface AutoLabelResult {
  success: boolean;
  orderId: string;
  labelUrl?: string;
  trackingNumber?: string;
  carrier?: string;
  labelCost?: number;
  qrCodeUrl?: string;
  failureReason?: string;
  skippedReason?: 'seller_not_verified' | 'no_valid_address' | 'no_tracked_rate';
}

// ============================================
// RATE FILTERING CONSTANTS
// ============================================

const UNTRACKED_KEYWORDS = [
  'untracked', 'economy', 'standard letter', 'postable',
  'large letter', '2nd class letter', 'media mail', 'book post',
  'printed papers', 'royal mail 24', 'royal mail 48',
];

const TRACKED_KEYWORDS = [
  'tracked', 'signed', 'express', 'next day', 'courier', 'priority',
  'parcel', 'guaranteed', 'special delivery', 'recorded', 'parcelforce',
  'dpd', 'evri', 'yodel', 'ups', 'fedex', 'dhl', 'hermes',
];

// ============================================
// MAIN FUNCTION: AUTO-PURCHASE LABEL
// ============================================

/**
 * Auto-purchases the best-value tracked label for an order.
 * Called synchronously from checkout fulfillment after order creation.
 *
 * Flow:
 * 1. Load order + listing + seller
 * 2. Check for existing label (duplicate prevention)
 * 3. Build addresses and get Shippo rates
 * 4. Filter to tracked rates only
 * 5. Cost ceiling check (cheapest tracked rate must be <= buyer's shipping cost)
 * 6. Preferred carrier selection (within 20% of cheapest)
 * 7. Purchase label via Shippo
 * 8. Update order with label info + label_auto_generated = true
 * 9. Update related orders (multi-item cart)
 *
 * On ANY failure: logs error and returns failure result.
 * Order stays in 'to_ship' without a label — seller uses manual wizard.
 */
export async function autoPurchaseLabel(orderId: string): Promise<AutoLabelResult> {
  try {
    console.log(`[AUTO-SHIP] Starting auto-label purchase for order ${orderId}`);

    // 1. Load order with listing and seller
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        listings: {
          include: {
            users: true,
          },
        },
        users_orders_seller_idTousers: true,
      },
    });

    if (!order) {
      return handleAutoLabelFailure(orderId, 'Order not found');
    }

    // 2. Duplicate label prevention
    if (order.label_url) {
      console.log(`[AUTO-SHIP] Label already exists for order ${orderId}, skipping`);
      return {
        success: true,
        orderId,
        labelUrl: order.label_url,
        trackingNumber: order.tracking_number || undefined,
        carrier: order.carrier || undefined,
      };
    }

    // 3. HYBRID TRIGGER GATE — three checks before auto-purchasing
    const seller = order.users_orders_seller_idTousers;

    // Gate 1: Seller must be Stripe-verified
    if (seller?.stripe_connect_status !== 'active') {
      console.log(`[AUTO-SHIP] Gate 1 fail: seller ${seller?.id} not verified (status: ${seller?.stripe_connect_status})`);
      return { success: false, orderId, skippedReason: 'seller_not_verified' };
    }

    // Gate 2: Seller must have a stored sending address
    const sellerAddr = await getSellerSendingAddress(order.seller_id);
    if (!sellerAddr.isReal || !sellerAddr.address) {
      console.log(`[AUTO-SHIP] Gate 2 fail: no sending address for seller ${seller?.id}`);
      return { success: false, orderId, skippedReason: 'no_address' as any };
    }

    // 4. Get parcel config from PARCEL_SIZES
    const parcelSize = order.listings?.parcel_size || 'medium';
    const parcelConfig = PARCEL_SIZES[parcelSize as keyof typeof PARCEL_SIZES] || PARCEL_SIZES.medium;

    // 5. Build addresses
    const shippingAddress = order.shipping_address as any;

    if (!shippingAddress) {
      return handleAutoLabelFailure(orderId, 'No shipping address on order');
    }

    // 6. Create Shippo shipment to get rates
    console.log(`[AUTO-SHIP] Requesting rates: ${parcelSize} parcel, ${sellerAddr.address.postal_code} → ${shippingAddress.postal_code || shippingAddress.postalCode || shippingAddress.postcode || '?'}`);

    const shipment = await shippo.shipments.create({
      addressFrom: {
        name: sellerAddr.address.name,
        street1: sellerAddr.address.line1,
        street2: sellerAddr.address.line2 || '',
        city: sellerAddr.address.city,
        zip: sellerAddr.address.postal_code,
        country: sellerAddr.address.country,
      },
      addressTo: {
        name: shippingAddress.name || 'Buyer',
        street1: shippingAddress.line1 || shippingAddress.street1 || '1 Main Street',
        street2: shippingAddress.line2 || shippingAddress.street2 || '',
        city: shippingAddress.city || 'London',
        state: shippingAddress.county || shippingAddress.state || '',
        zip: shippingAddress.postal_code || shippingAddress.postalCode || shippingAddress.postcode || '',
        country: shippingAddress.country || 'GB',
      },
      parcels: [{
        length: parcelConfig.length,
        width: parcelConfig.width,
        height: parcelConfig.height,
        distanceUnit: 'cm',
        weight: parcelConfig.weight,
        massUnit: 'kg',
      }],
      extra: {
        insurance: {
          amount: order.insured_value?.toString() || order.amount.toString(),
          currency: 'GBP',
          content: 'Golf equipment',
        },
        qrCodeRequested: true,
      },
      async: false,
    });

    // 6. Filter to tracked rates
    const trackedRates = filterTrackedRates(shipment.rates || []);

    // Gate 3: At least one tracked rate must be available
    if (trackedRates.length === 0) {
      console.log(`[AUTO-SHIP] Gate 3 fail: no tracked rates (${shipment.rates?.length || 0} total rates returned)`);
      return { success: false, orderId, skippedReason: 'no_tracked_rate' };
    }

    // 7. Cost ceiling check
    const buyerShippingCost = parseFloat((order.shipping_cost || 0).toString());
    const cheapestRate = trackedRates[0];

    if (buyerShippingCost <= 0) {
      return handleAutoLabelFailure(orderId, 'Order has no shipping cost (free shipping?) — cannot auto-purchase');
    }

    if (cheapestRate.price > buyerShippingCost) {
      return handleAutoLabelFailure(
        orderId,
        `Cost ceiling exceeded: cheapest tracked rate £${cheapestRate.price.toFixed(2)} > buyer paid £${buyerShippingCost.toFixed(2)}`
      );
    }

    // 8. Select best rate (with preferred carrier logic)
    const sellerPreferredCarriers = seller?.preferred_carriers || null;
    const selectedRate = selectBestRate(trackedRates, sellerPreferredCarriers, buyerShippingCost);

    console.log(`[AUTO-SHIP] Selected rate: ${selectedRate.carrier} ${selectedRate.service} — £${selectedRate.price.toFixed(2)}`);

    // 9. Purchase label via Shippo
    const transaction = await shippo.transactions.create({
      rate: selectedRate.id,
      labelFileType: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      return handleAutoLabelFailure(
        orderId,
        `Shippo transaction failed: ${JSON.stringify(transaction.messages)}`
      );
    }

    // 9b. Capture QR code URL and expiry (Evri ParcelShop support)
    const qrCodeUrl = (transaction as any).qrCodeUrl || (transaction as any).qr_code_url || null;
    let qrCodeExpiresAt: Date | null = null;

    if (qrCodeUrl && Array.isArray((transaction as any).messages)) {
      const expiryMsg = ((transaction as any).messages as any[]).find(
        (m: any) => m.code === 'QrCodeExpirationDate'
      );
      if (expiryMsg?.text) {
        const parsed = new Date(expiryMsg.text);
        if (!isNaN(parsed.getTime())) {
          qrCodeExpiresAt = parsed;
        }
      }
    }

    if (qrCodeUrl) {
      console.log(`[AUTO-SHIP] QR code available for order ${orderId}, expires: ${qrCodeExpiresAt?.toISOString() || 'unknown'}`);
    }

    // 10. Determine label cost
    let labelCost = selectedRate.price;
    if (labelCost === 0 && typeof transaction.rate === 'object' && transaction.rate !== null) {
      labelCost = parseFloat((transaction.rate as any).amount || '0');
    }

    const carrier = selectedRate.carrier;

    // 11. Update order with label info
    await prisma.orders.update({
      where: { id: orderId },
      data: {
        tracking_number: transaction.trackingNumber,
        carrier: carrier,
        label_url: transaction.labelUrl,
        label_cost: labelCost,
        qr_code_url: qrCodeUrl,
        qr_code_expires_at: qrCodeExpiresAt,
        shippo_transaction_id: transaction.objectId,
        label_auto_generated: true,
        status: 'to_ship',
        updated_at: new Date(),
      },
    });

    // 12. Update related orders (multi-item cart — same payment, same seller)
    if (order.stripe_payment_intent_id) {
      const relatedResult = await prisma.orders.updateMany({
        where: {
          stripe_payment_intent_id: order.stripe_payment_intent_id,
          seller_id: order.seller_id,
          id: { not: orderId },
          status: { in: ['paid', 'to_ship'] },
        },
        data: {
          tracking_number: transaction.trackingNumber,
          carrier: carrier,
          label_url: transaction.labelUrl,
          label_cost: 0, // Only primary order gets the label cost
          qr_code_url: qrCodeUrl,
          qr_code_expires_at: qrCodeExpiresAt,
          shippo_transaction_id: transaction.objectId,
          label_auto_generated: true,
          status: 'to_ship',
          updated_at: new Date(),
        },
      });

      if (relatedResult.count > 0) {
        console.log(`[AUTO-SHIP] Updated ${relatedResult.count} related order(s) with same tracking info`);
      }
    }

    const margin = buyerShippingCost - labelCost;
    console.log(`[AUTO-SHIP] ✅ Label purchased order=${orderId} carrier=${carrier} £${labelCost.toFixed(2)} (margin: £${margin.toFixed(2)}) qr=${qrCodeUrl ? 'YES' : 'NO'}`);

    return {
      success: true,
      orderId,
      labelUrl: transaction.labelUrl || undefined,
      trackingNumber: transaction.trackingNumber || undefined,
      carrier,
      labelCost,
      qrCodeUrl: qrCodeUrl || undefined,
    };
  } catch (error: any) {
    console.error(`[AUTO-SHIP] ❌ Unexpected error for order ${orderId}:`, error.message);
    return handleAutoLabelFailure(orderId, error.message || 'Unknown error');
  }
}

// ============================================
// RATE SELECTION
// ============================================

/**
 * Selects the best rate considering seller's preferred carriers.
 *
 * Rules:
 * 1. Rates are sorted by price ascending (cheapest first)
 * 2. If seller has preferred carriers and one is within 20% of cheapest, prefer it
 * 3. Never exceed the buyer's shipping cost (cost ceiling already enforced by caller)
 * 4. Default to cheapest tracked rate
 */
export function selectBestRate(
  trackedRates: TrackedRate[],
  sellerPreferredCarriers: string | null,
  buyerShippingCost: number,
): TrackedRate {
  const cheapest = trackedRates[0];

  if (!sellerPreferredCarriers || trackedRates.length === 1) {
    return cheapest;
  }

  // Parse preferred carriers (stored as comma-separated string, e.g. "DPD,Evri")
  const preferred = sellerPreferredCarriers
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(c => c.length > 0);

  if (preferred.length === 0) {
    return cheapest;
  }

  // Find cheapest preferred carrier rate within 20% of cheapest overall
  const threshold = cheapest.price * 1.20;

  const preferredRate = trackedRates.find(rate => {
    const carrierLower = rate.carrier.toLowerCase();
    const isPreferred = preferred.some(p => carrierLower.includes(p));
    return isPreferred && rate.price <= threshold && rate.price <= buyerShippingCost;
  });

  if (preferredRate) {
    console.log(
      `[AUTO-SHIP] Preferred carrier selected: ${preferredRate.carrier} £${preferredRate.price.toFixed(2)} ` +
      `(cheapest was ${cheapest.carrier} £${cheapest.price.toFixed(2)}, within 20% threshold £${threshold.toFixed(2)})`
    );
    return preferredRate;
  }

  return cheapest;
}

// ============================================
// TRACKED RATE FILTERING
// ============================================

/**
 * Filters Shippo rates to only tracked services.
 * Returns sorted by price ascending.
 */
function filterTrackedRates(rates: any[]): TrackedRate[] {
  const tracked = rates.filter((rate: any) => {
    const serviceName = (rate.servicelevel?.name || '').toLowerCase();
    const serviceToken = (rate.servicelevel?.token || '').toLowerCase();
    const provider = (rate.provider || '').toLowerCase();

    // Exclude untracked services
    const isUntracked = UNTRACKED_KEYWORDS.some(kw =>
      serviceName.includes(kw) || serviceToken.includes(kw)
    );
    if (isUntracked) return false;

    // Include explicitly tracked services
    const isTracked = TRACKED_KEYWORDS.some(kw =>
      serviceName.includes(kw) || serviceToken.includes(kw) || provider.includes(kw)
    );

    // Probably tracked if has delivery estimate and costs >= £2.50
    const hasDeliveryEstimate = rate.estimatedDays !== undefined && rate.estimatedDays !== null;
    const isProbablyTracked = hasDeliveryEstimate && parseFloat(rate.amount) >= 2.50;

    return isTracked || isProbablyTracked;
  });

  const formatted: TrackedRate[] = tracked.map((rate: any) => ({
    id: rate.objectId,
    carrier: normalizeCarrierName(rate.provider),
    service: rate.servicelevel?.name || rate.servicelevelName || 'Unknown',
    price: parseFloat(rate.amount),
    currency: rate.currency,
    estimatedDays: rate.estimatedDays ?? null,
  }));

  formatted.sort((a, b) => a.price - b.price);

  return formatted;
}

// ============================================
// GRACEFUL FAILURE HANDLER
// ============================================

/**
 * Returns a failure result. Does NOT throw.
 * The order stays in 'to_ship' without a label — seller uses manual wizard.
 */
function handleAutoLabelFailure(orderId: string, reason: string): AutoLabelResult {
  console.warn(`[AUTO-SHIP] ⚠️ Auto-label failed for order ${orderId}: ${reason}`);
  return {
    success: false,
    orderId,
    failureReason: reason,
  };
}
