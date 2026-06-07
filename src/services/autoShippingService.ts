import { prisma } from '../lib/prisma';
import { normalizeCarrierName } from '../utils/carrierName';
import { Shippo } from 'shippo';
import { PARCEL_SIZES } from '../controllers/shippingController';
import { getSellerSendingAddress } from '../lib/sellerAddress';
import { selectRate } from '../lib/rateSelection';

const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// ============================================
// TYPES
// ============================================

interface AutoLabelResult {
  success: boolean;
  orderId: string;
  labelUrl?: string;
  trackingNumber?: string;
  carrier?: string;
  labelCost?: number;
  qrCodeUrl?: string;
  failureReason?: string;
  skippedReason?: 'no_valid_address' | 'no_tracked_rate';
  overBudget?: boolean;
}

interface AutoPurchaseOptions {
  forcePurchase?: boolean;
}

// ============================================
// MAIN FUNCTION: AUTO-PURCHASE LABEL
// ============================================

export async function autoPurchaseLabel(
  orderId: string,
  options?: AutoPurchaseOptions,
): Promise<AutoLabelResult> {
  const forcePurchase = options?.forcePurchase ?? false;
  const tag = forcePurchase ? '[MANUAL-SHIP]' : '[AUTO-SHIP]';

  try {
    console.log(`${tag} Starting label purchase for order ${orderId}`);

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

    if (order.label_url) {
      console.log(`${tag} Label already exists for order ${orderId}, skipping`);
      return {
        success: true,
        orderId,
        labelUrl: order.label_url,
        trackingNumber: order.tracking_number || undefined,
        carrier: order.carrier || undefined,
      };
    }

    const sellerAddr = await getSellerSendingAddress(order.seller_id);
    if (!sellerAddr.isReal || !sellerAddr.address) {
      console.log(`${tag} No sending address for seller ${order.seller_id}`);
      return { success: false, orderId, skippedReason: 'no_valid_address' };
    }

    const parcelSize = order.parcel_size || order.listings?.parcel_size || 'medium';
    const parcelConfig = PARCEL_SIZES[parcelSize as keyof typeof PARCEL_SIZES] || PARCEL_SIZES.medium;

    const shippingAddress = order.shipping_address as any;
    if (!shippingAddress) {
      return handleAutoLabelFailure(orderId, 'No shipping address on order');
    }

    console.log(`${tag} Requesting rates: ${parcelSize} parcel, ${sellerAddr.address.postal_code} → ${shippingAddress.postal_code || shippingAddress.postalCode || shippingAddress.postcode || '?'}`);

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

    const buyerShippingCost = parseFloat((order.shipping_cost || 0).toString());
    const rateResult = selectRate({
      rates: shipment.rates || [],
      buyerPaidShippingCost: buyerShippingCost,
    });

    if (!rateResult) {
      console.log(`${tag} No rates returned by Shippo (${shipment.rates?.length || 0} total)`);
      return { success: false, orderId, skippedReason: 'no_tracked_rate' };
    }

    const selectedRate = rateResult.selectedRate;
    const carrier = normalizeCarrierName(selectedRate.provider);
    const ratePrice = parseFloat(selectedRate.amount);

    if (rateResult.overBudget) {
      console.log(`${tag} Over-budget: cheapest £${ratePrice.toFixed(2)} > buyer paid £${buyerShippingCost.toFixed(2)} — Mulligans absorbs difference`);
    }

    console.log(`${tag} Selected: ${carrier} ${selectedRate.servicelevel?.name || 'Unknown'} — £${ratePrice.toFixed(2)} (${rateResult.reason})`);

    const transaction = await shippo.transactions.create({
      rate: selectedRate.objectId,
      labelFileType: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      return handleAutoLabelFailure(
        orderId,
        `Shippo transaction failed: ${JSON.stringify(transaction.messages)}`
      );
    }

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
      console.log(`${tag} QR code available for order ${orderId}, expires: ${qrCodeExpiresAt?.toISOString() || 'unknown'}`);
    }

    let labelCost = ratePrice;
    if (labelCost === 0 && typeof transaction.rate === 'object' && transaction.rate !== null) {
      labelCost = parseFloat((transaction.rate as any).amount || '0');
    }

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
        label_auto_generated: !forcePurchase,
        status: 'to_ship',
        updated_at: new Date(),
      },
    });

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
          label_cost: 0,
          qr_code_url: qrCodeUrl,
          qr_code_expires_at: qrCodeExpiresAt,
          shippo_transaction_id: transaction.objectId,
          label_auto_generated: !forcePurchase,
          status: 'to_ship',
          updated_at: new Date(),
        },
      });

      if (relatedResult.count > 0) {
        console.log(`${tag} Updated ${relatedResult.count} related order(s) with same tracking info`);
      }
    }

    const margin = buyerShippingCost - labelCost;
    console.log(`${tag} ✅ Label purchased order=${orderId} carrier=${carrier} £${labelCost.toFixed(2)} (margin: £${margin.toFixed(2)}) qr=${qrCodeUrl ? 'YES' : 'NO'}`);

    return {
      success: true,
      orderId,
      labelUrl: transaction.labelUrl || undefined,
      trackingNumber: transaction.trackingNumber || undefined,
      carrier,
      labelCost,
      qrCodeUrl: qrCodeUrl || undefined,
      overBudget: rateResult.overBudget,
    };
  } catch (error: any) {
    console.error(`[AUTO-SHIP] ❌ Unexpected error for order ${orderId}:`, error.message);
    return handleAutoLabelFailure(orderId, error.message || 'Unknown error');
  }
}

// ============================================
// GRACEFUL FAILURE HANDLER
// ============================================

function handleAutoLabelFailure(orderId: string, reason: string): AutoLabelResult {
  console.warn(`[AUTO-SHIP] ⚠️ Auto-label failed for order ${orderId}: ${reason}`);
  return {
    success: false,
    orderId,
    failureReason: reason,
  };
}
