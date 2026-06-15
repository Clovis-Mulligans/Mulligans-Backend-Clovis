// src/controllers/shippingController.ts
// Handles Shippo integration for shipping rates, labels, and tracking
// ✅ UPDATED: Added escrow release date when order is delivered
// ✅ FIXED: Corrected Shippo API key format
// ✅ NEW: Saves label_cost to order for escrow deduction

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { Shippo } from 'shippo';
import { sendPushNotification } from './pushNotificationController';
import { normalizeCarrierName } from '../utils/carrierName';
import { getSellerSendingAddress, SellerAddressResult } from '../lib/sellerAddress';
import { ESCROW_RELEASE_DAYS } from '../config/constants';
import { generateEmailActionToken } from '../routes/emailActionRoutes';
import { sendDeliveryConfirmation } from '../services/emailService';

// ✅ FIXED: Initialize Shippo with correct API key format
// The SDK expects "ShippoToken <your_api_key>" format
const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// ============================================
// SHIPPING PRICE CONSTANTS
// ============================================
export const PARCEL_SIZES = {
  small: {
    name: 'Small',
    description: 'Balls, gloves, grips',
    price: 3.49,
    length: '30',
    width: '20',
    height: '10',
    weight: '0.5',
  },
  medium: {
    name: 'Medium',
    description: 'Shoes, clothing, accessories',
    price: 5.99,
    length: '40',
    width: '30',
    height: '15',
    weight: '1.8',
  },
  large: {
    name: 'Large',
    description: 'Single club, putter',
    price: 9.99,
    length: '119',
    width: '15',
    height: '15',
    weight: '2',
  },
  extra_large: {
    name: 'Extra Large',
    description: 'Iron set, stand bag (empty)',
    price: 14.99,
    length: '119',
    width: '30',
    height: '20',
    weight: '8',
  },
  oversized: {
    name: 'Oversized',
    description: 'Full bag with clubs, travel bag',
    price: 24.99,
    length: '140',
    width: '40',
    height: '40',
    weight: '15',
  },
};

// Type for authenticated requests
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

// ============================================
// GET PARCEL SIZE OPTIONS
// Returns available parcel sizes with prices
// GET /api/shipping/parcel-sizes
// ============================================
export const getParcelSizes = async (req: Request, res: Response) => {
  try {
    const sizes = Object.entries(PARCEL_SIZES).map(([key, value]) => ({
      id: key,
      name: value.name,
      description: value.description,
      price: value.price,
      length: value.length,
      width: value.width,
      height: value.height,
      weight: value.weight,
      dimensions: `${value.length}×${value.width}×${value.height}cm`,
      max_weight: `${value.weight}kg`,
    }));

    res.json({
      success: true,
      data: sizes,
    });
  } catch (error) {
    console.error('Error getting parcel sizes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get parcel sizes',
    });
  }
};

// ============================================
// GET SHIPPING RATES FOR AN ORDER
// Returns carrier options with prices
// POST /api/shipping/rates
// ============================================
export const getShippingRates = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID is required',
      });
    }

    // Get order with listing and addresses
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        listings: {
          include: {
            users: true, // Seller info
          },
        },
        users_orders_seller_idTousers: true,
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Check user is the seller
    if (order.seller_id !== req.user?.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the seller can get shipping rates',
      });
    }

    // Get parcel size from listing
    const parcelSize = order.listings?.parcel_size || 'medium';
    const parcelConfig = PARCEL_SIZES[parcelSize as keyof typeof PARCEL_SIZES] || PARCEL_SIZES.medium;

    // Get seller's address info
    const seller = order.users_orders_seller_idTousers;

    // Get buyer's shipping address
    const shippingAddress = order.shipping_address as any;

    if (!shippingAddress) {
      return res.status(400).json({
        success: false,
        error: 'Order has no shipping address',
      });
    }

    const sellerAddr = await getSellerSendingAddress(order.seller_id);
    if (!sellerAddr.isReal || !sellerAddr.address) {
      return res.status(400).json({
        success: false,
        error: 'sending_address_required',
        addressRequired: true,
        reason: sellerAddr.failureReason,
      });
    }

    console.log('📦 Getting Shippo rates for order:', orderId);
    console.log('📍 Origin:', sellerAddr.address.postal_code);
    console.log('📍 Buyer address:', JSON.stringify(shippingAddress, null, 2));
    console.log('🛡️ Insurance value:', order.insured_value?.toString() || order.amount.toString());

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
      // ✅ INSURANCE: Add XCover insurance via Shippo
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

    console.log('✅ Shippo shipment created:', shipment.objectId);
    console.log('📋 Total rates returned:', shipment.rates?.length || 0);
    
    // Log any messages from Shippo (helps debug why no rates)
    if (shipment.messages && shipment.messages.length > 0) {
      console.log('⚠️ Shippo messages:', JSON.stringify(shipment.messages, null, 2));
    }

    // ✅ Filter to only include TRACKED services
    // This is CRITICAL for escrow system and buyer protection - no untracked allowed!
    const trackedRates = shipment.rates?.filter((rate: any) => {
      // Check if service includes tracking
      const serviceName = (rate.servicelevel?.name || '').toLowerCase();
      const serviceToken = (rate.servicelevel?.token || '').toLowerCase();
      const provider = (rate.provider || '').toLowerCase();
      
      // ❌ STRICTLY EXCLUDE untracked/economy services - these cannot be used
      const untrackedKeywords = [
        'untracked', 'economy', 'standard letter', 'postable', 
        'large letter', '2nd class letter', 'media mail', 'book post',
        'printed papers', 'royal mail 24', 'royal mail 48' // RM 24/48 basic can be untracked
      ];
      const isUntracked = untrackedKeywords.some(keyword => 
        serviceName.includes(keyword) || serviceToken.includes(keyword)
      );
      
      if (isUntracked) {
        console.log(`❌ Excluding untracked service: ${serviceName} (${serviceToken})`);
        return false;
      }
      
      // ✅ EXPLICITLY include services that guarantee tracking
      const trackedKeywords = [
        'tracked', 'signed', 'express', 'next day', 'courier', 'priority', 
        'parcel', 'guaranteed', 'special delivery', 'recorded', 'parcelforce',
        'dpd', 'evri', 'yodel', 'ups', 'fedex', 'dhl', 'hermes'
      ];
      const isTracked = trackedKeywords.some(keyword => 
        serviceName.includes(keyword) || serviceToken.includes(keyword) || provider.includes(keyword)
      );
      
      // For parcel-sized items, most services have tracking - include if not explicitly untracked
      // and has delivery estimate (indicates real parcel service vs letter service)
      const hasDeliveryEstimate = rate.estimatedDays !== undefined && rate.estimatedDays !== null;
      const isProbablyTracked = hasDeliveryEstimate && parseFloat(rate.amount) >= 2.50; // Very cheap = likely untracked
      
      if (isTracked || isProbablyTracked) {
        console.log(`✅ Including tracked service: ${serviceName} - £${rate.amount}`);
        return true;
      }
      
      console.log(`⚠️ Excluding uncertain service: ${serviceName} (${serviceToken})`);
      return false;
    }) || [];

    console.log('📋 Tracked rates available:', trackedRates.length);

    // Format rates for response
    const rates = trackedRates.map((rate: any) => ({
      id: rate.objectId,
      carrier: normalizeCarrierName(rate.provider),
      service: rate.servicelevel?.name || rate.servicelevelName,
      price: parseFloat(rate.amount),
      currency: rate.currency,
      estimatedDays: rate.estimatedDays,
      durationTerms: rate.durationTerms,
    })) || [];

    // Sort by price
    rates.sort((a: any, b: any) => a.price - b.price);

    res.json({
      success: true,
      data: {
        shipmentId: shipment.objectId,
        rates,
        parcelSize: parcelSize,
        parcelDetails: {
          length: parcelConfig.length,
          width: parcelConfig.width,
          height: parcelConfig.height,
          weight: parcelConfig.weight,
        },
      },
    });
  } catch (error: any) {
    // ✅ Enhanced error logging
    console.error('❌ Error getting shipping rates:', error);
    console.error('❌ Error details:', JSON.stringify(error, null, 2));
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get shipping rates',
    });
  }
};

// ============================================
// CREATE SHIPPING LABEL
// Creates a label and returns PDF URL
// ✅ NEW: Saves label_cost to order for escrow deduction
// POST /api/shipping/labels
// ============================================
export const createShippingLabel = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId, rateId } = req.body;

    if (!orderId || !rateId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID and Rate ID are required',
      });
    }

    // Get order
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        listings: {
          include: {
            images: {
              take: 1,
              orderBy: PRIMARY_IMAGE_ORDER,
            },
          },
        },
        users_orders_seller_idTousers: true,
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Check user is the seller
    if (order.seller_id !== req.user?.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the seller can create shipping labels',
      });
    }

    // Check order status
    if (order.status !== 'paid' && order.status !== 'to_ship') {
      return res.status(400).json({
        success: false,
        error: `Cannot create label for order with status: ${order.status}`,
      });
    }

    // Check if label already exists
    if (order.label_url) {
      return res.status(400).json({
        success: false,
        error: 'Shipping label already exists for this order',
        labelUrl: order.label_url,
      });
    }

    console.log('🏷️ Creating shipping label for order:', orderId, 'with rate:', rateId);

   // ✅ First, fetch the rate to get the price AND carrier
let labelCost = 0;
let carrierName = 'Unknown';
try {
  const rate = await shippo.rates.get(rateId);
  labelCost = parseFloat(rate.amount || '0');
  carrierName = rate.provider || 'Unknown';
  console.log('💰 Label cost from rate:', labelCost);
  console.log('📦 Carrier from rate:', carrierName);
} catch (rateError) {
  console.warn('⚠️ Could not fetch rate details, will try to get from transaction');
}

    // Create transaction (purchase the label) using Shippo
    const transaction = await shippo.transactions.create({
      rate: rateId,
      labelFileType: 'PDF',
      async: false,
    });

    console.log('📋 Transaction result:', transaction.status, transaction.objectId);
    console.log('📋 Full transaction object:', JSON.stringify(transaction, null, 2));

    // Check if transaction was successful
    if (transaction.status !== 'SUCCESS') {
      console.error('❌ Shippo transaction failed:', transaction.messages);
      return res.status(400).json({
        success: false,
        error: 'Failed to create shipping label',
        details: transaction.messages,
      });
    }

    // Capture QR code URL and expiry (Evri ParcelShop support — F6.1)
    const qrCodeUrl = (transaction as any).qrCodeUrl ?? (transaction as any).qr_code_url ?? null;

    let qrCodeExpiresAt: Date | null = null;
    if (Array.isArray((transaction as any).messages)) {
      const expiryMessage = ((transaction as any).messages as any[]).find(
        (m: any) => m.code === 'QrCodeExpirationDate'
      );
      if (expiryMessage?.text) {
        const parsed = new Date(expiryMessage.text);
        if (!isNaN(parsed.getTime())) {
          qrCodeExpiresAt = parsed;
        }
      }
    }

    // ✅ NEW: Try to get label cost from transaction if we didn't get it from rate
    if (labelCost === 0 && typeof transaction.rate === 'object' && transaction.rate !== null) {
      const rateObj = transaction.rate as any;
      labelCost = parseFloat(rateObj.amount || '0');
      console.log('💰 Label cost from transaction.rate:', labelCost);
    }

    // Get carrier from rate info
    // Use carrier from rate fetch, fallback to transaction
const carrier = carrierName !== 'Unknown' 
  ? carrierName 
  : (typeof transaction.rate === 'object' ? (transaction.rate as any)?.provider || 'Unknown' : 'Unknown');

    // ✅ UPDATED: Update order with tracking info, label URL, AND label_cost
  await prisma.orders.update({
      where: { id: orderId },
      data: {
        tracking_number: transaction.trackingNumber,
        carrier: carrier,
        label_url: transaction.labelUrl,
        label_cost: labelCost,
        shippo_transaction_id: transaction.objectId,
        status: 'to_ship',
        updated_at: new Date(),
        qr_code_url: qrCodeUrl,
        qr_code_expires_at: qrCodeExpiresAt,
      },
    });

    // ✅ NEW: Also update ALL related orders from the same transaction (multi-item cart checkout)
    // These orders share the same stripe_payment_intent_id and seller_id
    if (order.stripe_payment_intent_id) {
      const relatedOrdersResult = await prisma.orders.updateMany({
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
          shippo_transaction_id: transaction.objectId,
          status: 'to_ship',
          updated_at: new Date(),
          qr_code_url: qrCodeUrl,
          qr_code_expires_at: qrCodeExpiresAt,
        },
      });
      
      if (relatedOrdersResult.count > 0) {
        console.log(`✅ Also updated ${relatedOrdersResult.count} related orders with same tracking info`);
      }
    }

    console.log('✅ Shipping label created:', {
      orderId,
      trackingNumber: transaction.trackingNumber,
      carrier,
      labelUrl: transaction.labelUrl,
      labelCost: labelCost,
      qr: qrCodeUrl ? 'YES' : 'NO',
    });

    // Create notification for buyer
    const listingImage = order.listings?.images?.[0]?.image_url || null;
    
    const labelCreatedNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await prisma.notifications.create({
      data: {
        id: labelCreatedNotifId,
        user_id: order.buyer_id,
        type: 'shipping_label_created',
        title: 'Shipping Label Created',
        message: `The seller has created a shipping label for your order. Tracking: ${transaction.trackingNumber}`,
        image_url: listingImage,
        related_id: orderId,
      },
    });

    // PUSH: Notify buyer
    try {
      await sendPushNotification(
        order.buyer_id,
        'Shipping Label Created',
        `The seller is preparing to ship your order. Tracking: ${transaction.trackingNumber}`,
        { notification_id: labelCreatedNotifId, type: 'purchase_shipped', order_id: orderId }
      );
    } catch (pushErr) {
      console.error('[SHIP] Push notification failed:', pushErr);
    }

    res.json({
      success: true,
      data: {
        trackingNumber: transaction.trackingNumber,
        trackingUrl: transaction.trackingUrlProvider,
        labelUrl: transaction.labelUrl,
        carrier: carrier,
        transactionId: transaction.objectId,
        labelCost: labelCost,
        qr_code_url: qrCodeUrl,
      },
    });
  } catch (error: any) {
    console.error('❌ Error creating shipping label:', error);
    console.error('❌ Error details:', JSON.stringify(error, null, 2));
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create shipping label',
    });
  }
};

// ============================================
// GET TRACKING INFO
// Returns current tracking status
// GET /api/shipping/tracking/:orderId
// ============================================
export const getTrackingInfo = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId } = req.params;

    // Get order
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Check user is buyer or seller
    if (order.buyer_id !== req.user?.id && order.seller_id !== req.user?.id) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this order',
      });
    }

    if (!order.tracking_number || !order.carrier) {
      return res.status(400).json({
        success: false,
        error: 'No tracking information available for this order',
      });
    }

    // Get tracking status from Shippo using new SDK
    const tracking = await shippo.trackingStatus.get(
      order.carrier.toLowerCase(),
      order.tracking_number
    );

    // Format tracking history
    const trackingHistory = tracking.trackingHistory?.map((event: any) => ({
      status: event.status,
      statusDetails: event.statusDetails,
      location: event.location ? `${event.location.city}, ${event.location.country}` : null,
      timestamp: event.statusDate,
    })) || [];

    res.json({
      success: true,
      data: {
        trackingNumber: order.tracking_number,
        carrier: order.carrier,
        status: tracking.trackingStatus?.status || 'UNKNOWN',
        statusDetails: tracking.trackingStatus?.statusDetails || '',
        eta: tracking.eta,
        trackingHistory: trackingHistory,
        labelUrl: order.label_url,
      },
    });
  } catch (error: any) {
    console.error('❌ Error getting tracking info:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get tracking information',
    });
  }
};

// markAsShipped REMOVED — manual self-attestation bypass (task/ship-status-integrity)
// The Shippo tracking webhook is now the sole setter of outbound in_transit/shipped status.

// ============================================
// SHIPPO WEBHOOK HANDLER
// Receives tracking updates from Shippo
// POST /webhooks/shippo
// ✅ UPDATED: Now sets escrow_release_at when delivered
// ============================================
export const handleShippoWebhook = async (req: Request, res: Response) => {
  try {
    // Verify webhook secret token
    const token = req.query.token;
    if (token !== process.env.SHIPPO_WEBHOOK_SECRET) {
      console.error('❌ Invalid Shippo webhook token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body;

    console.log('📬 Received Shippo webhook:', event);

    // Handle tracking update events
    if (event.event === 'track_updated') {
      const trackingData = event.data;
      const trackingNumber = trackingData.tracking_number;
      const status = trackingData.tracking_status?.status;

      // Find order by tracking number
      const order = await prisma.orders.findFirst({
        where: { tracking_number: trackingNumber },
      });

      if (order) {
        let newStatus = order.status;
        let deliveredAt = order.delivered_at;
        let escrowReleaseAt: Date | null = null;
        let shippedAt = order.shipped_at;
        // Map Shippo status to our order status
        switch (status) {
          case 'PRE_TRANSIT':
            // Label created / tracking registered, but the carrier has NOT yet
            // physically scanned the parcel. The seller may not have dropped it
            // off yet, so the order must stay 'to_ship' (not 'in_transit').
            // Do NOT set shipped_at here — it drives the lost-in-transit timer
            // and the buyer-facing "shipped" state. Only a real TRANSIT scan
            // means the parcel is genuinely on its way.
            // (auto_cancel_at is still cleared below on any tracking event,
            //  which is correct: a label exists, so don't auto-cancel.)
            newStatus = 'to_ship';
            break;
          case 'TRANSIT':
            newStatus = 'in_transit';
            if (!shippedAt) shippedAt = new Date();
            break;
          case 'DELIVERED':
            newStatus = 'delivered';
            deliveredAt = new Date();
            // ✅ Calculate escrow release date (3 days from delivery)
            escrowReleaseAt = new Date();
            escrowReleaseAt.setDate(escrowReleaseAt.getDate() + ESCROW_RELEASE_DAYS);
            break;
          case 'RETURNED':
            newStatus = 'returned';
            break;
          case 'FAILURE':
            newStatus = 'delivery_failed';
            break;
        }

        // Update ALL orders with this tracking number (multi-item shipments)
        // Per Brief 2 fix: clear auto_cancel_at on ANY tracking event (parcel is with carrier)
        // and persist shipped_at so dashboards reflect carrier-acceptance time
        await prisma.orders.updateMany({
          where: { tracking_number: trackingNumber },
          data: {
            status: newStatus,
            delivered_at: deliveredAt,
            escrow_release_at: escrowReleaseAt,
            shipped_at: shippedAt,
            auto_cancel_at: null,
            updated_at: new Date(),
          },
        });

        // Notify buyer of delivery
        if (status === 'DELIVERED') {
          // ✅ FIX: Get listing image for notification
          const orderWithListing = await prisma.orders.findUnique({
            where: { id: order.id },
            include: {
              listings: {
                include: {
                  images: {
                    take: 1,
                    orderBy: PRIMARY_IMAGE_ORDER,
                  },
                },
              },
            },
          });
          const listingImage = orderWithListing?.listings?.images?.[0]?.image_url || null;
          const listingTitle = orderWithListing?.listings?.title || 'Your item';
          
          const webhookDeliveredNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          await prisma.notifications.create({
            data: {
              id: webhookDeliveredNotifId,
              user_id: order.buyer_id,
              type: 'delivered',  // ✅ FIX: Use 'delivered' to match frontend
              title: 'Your Order Has Been Delivered! 🎉',
              message: `"${listingTitle}" has arrived. You have ${ESCROW_RELEASE_DAYS} days to confirm receipt or report any issues.`,
              image_url: listingImage,  // ✅ FIX: Add image
              related_id: order.id,
            },
          });

          // Send delivery confirmation email
          try {
            const buyerEmailRecord = await prisma.users.findUnique({
              where: { id: order.buyer_id },
              select: { email: true, display_name: true },
            });

            if (buyerEmailRecord?.email) {
              await sendDeliveryConfirmation(buyerEmailRecord.email, {
                itemTitle: listingTitle,
                orderNumber: order.id,
                deliveryDate: new Date().toLocaleDateString('en-GB', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                }),
                buyerName: buyerEmailRecord?.display_name || 'there',
                orderReference: order.id,
                itemName: listingTitle,
                itemImageUrl: listingImage || '',
                itemBrand: '',
                itemCondition: '',
                itemPrice: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
                confirmUrl: `https://api.mulligans.uk.com/api/email-actions/confirm-receipt?token=${generateEmailActionToken(order.id, order.buyer_id, 'confirm-receipt', escrowReleaseAt!)}`,
                reportIssueUrl: `https://api.mulligans.uk.com/api/email-actions/report-issue?token=${generateEmailActionToken(order.id, order.buyer_id, 'report-issue', escrowReleaseAt!)}`,
              });
            }
          } catch (emailErr) {
            console.error('[SHIPPO] Delivery email failed (non-fatal):', emailErr);
          }

          // PUSH: Notify buyer of delivery
          try {
            await sendPushNotification(
              order.buyer_id,
              'Your Order Has Been Delivered!',
              `"${listingTitle}" has arrived. Confirm receipt or report any issues.`,
              { notification_id: webhookDeliveredNotifId, type: 'purchase_delivered', order_id: order.id }
            );
          } catch (pushErr) {
            console.error('[SHIP] Push notification failed:', pushErr);
          }
          
          console.log(`📅 Escrow release scheduled for order ${order.id}: ${escrowReleaseAt?.toISOString()}`);
        }

        // Shipment-deadline recovery: if TRANSIT fires on orders that were flagged
        // during the grace window, send "all good" comms to both parties.
        if (status === 'TRANSIT') {
          try {
            const gracedOrders = await prisma.orders.findMany({
              where: {
                tracking_number: trackingNumber,
                grace_notified_at: { not: null },
                grace_recovered_at: null,
              },
              include: {
                listings: {
                  select: {
                    title: true,
                    images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
                  },
                },
                users_orders_buyer_idTousers: {
                  select: { id: true, email: true, display_name: true },
                },
                users_orders_seller_idTousers: {
                  select: { id: true, email: true, display_name: true },
                },
              },
            });

            if (gracedOrders.length > 0) {
              const now = new Date();
              const firstOrder = gracedOrders[0];
              const recoveryTitle = firstOrder.listings?.title || 'Your item';
              const recoveryImage = firstOrder.listings?.images?.[0]?.image_url || null;
              const buyerId = firstOrder.buyer_id;
              const sellerId = firstOrder.seller_id;
              const buyerName = firstOrder.users_orders_buyer_idTousers?.display_name || 'there';
              const sellerName = firstOrder.users_orders_seller_idTousers?.display_name || 'there';
              const buyerEmail = firstOrder.users_orders_buyer_idTousers?.email;
              const sellerEmail = firstOrder.users_orders_seller_idTousers?.email;

              await prisma.orders.updateMany({
                where: {
                  tracking_number: trackingNumber,
                  grace_notified_at: { not: null },
                  grace_recovered_at: null,
                },
                data: { grace_recovered_at: now, updated_at: now },
              });

              // In-app notifications
              await prisma.notifications.create({
                data: {
                  id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  user_id: buyerId,
                  type: 'shipment_recovered',
                  title: 'Good News — Your Order Is On Its Way',
                  message: `"${recoveryTitle}" has been scanned by the carrier and is now in transit.`,
                  image_url: recoveryImage,
                  related_id: firstOrder.id,
                },
              });
              await prisma.notifications.create({
                data: {
                  id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  user_id: sellerId,
                  type: 'shipment_recovered',
                  title: 'Good News — Your Sale Is On Its Way',
                  message: `"${recoveryTitle}" has been scanned by the carrier and is now in transit.`,
                  image_url: recoveryImage,
                  related_id: firstOrder.id,
                },
              });

              // Push notifications
              try {
                await sendPushNotification(buyerId, 'Your Order Is On Its Way',
                  `"${recoveryTitle}" has been scanned and is now in transit.`,
                  { type: 'shipment_recovered', order_id: firstOrder.id });
              } catch (pushErr) { console.error('[SHIPPO] Recovery push to buyer failed:', pushErr); }
              try {
                await sendPushNotification(sellerId, 'Your Sale Is On Its Way',
                  `"${recoveryTitle}" has been scanned and is now in transit.`,
                  { type: 'shipment_recovered', order_id: firstOrder.id });
              } catch (pushErr) { console.error('[SHIPPO] Recovery push to seller failed:', pushErr); }

              // Email sends are wired in Commit 6
              console.log(`[SHIPPO] Shipment-deadline recovery: ${gracedOrders.length} order(s) recovered for tracking ${trackingNumber}`);
            }
          } catch (recoveryErr) {
            console.error('[SHIPPO] Shipment-deadline recovery failed (non-fatal):', recoveryErr);
          }
        }

        console.log(`✅ Updated order ${order.id} status to ${newStatus}`);
      } else {
        // Check if this is a RETURN label tracking number
        const returnRequest = await prisma.return_requests.findFirst({
          where: { return_tracking_number: trackingNumber },
          select: {
            id: true,
            status: true,
            shipped_at: true,
            delivered_at: true,
            orders: {
              select: {
                id: true,
                seller_id: true,
                listings: {
                  select: {
                    title: true,
                    images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
                  },
                },
              },
            },
          },
        });

        if (returnRequest) {
          const now = new Date();

          if (status === 'TRANSIT' && !returnRequest.shipped_at) {
            await prisma.return_requests.update({
              where: { id: returnRequest.id },
              data: { status: 'shipped', shipped_at: now, updated_at: now },
            });
            console.log(`📦 Return ${returnRequest.id} shipped (carrier scan, tracking: ${trackingNumber})`);

            // Notify seller that return is on its way
            const listingTitle = returnRequest.orders?.listings?.title || 'an item';
            const listingImage = returnRequest.orders?.listings?.images?.[0]?.image_url || null;
            const sellerId = returnRequest.orders?.seller_id;
            if (sellerId) {
              try {
                const returnShippedNotifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                await prisma.notifications.create({
                  data: {
                    id: returnShippedNotifId,
                    user_id: sellerId,
                    type: 'return_shipped',
                    title: 'Return Shipped',
                    message: `The return for "${listingTitle}" has been scanned by the carrier and is on its way to you.`,
                    image_url: listingImage,
                    related_id: returnRequest.id,
                  },
                });
                await sendPushNotification(
                  sellerId,
                  'Return Shipped',
                  `The return for "${listingTitle}" is on its way to you.`,
                  { type: 'return_shipped', return_id: returnRequest.id, order_id: returnRequest.orders?.id }
                ).catch(err => console.error('[SHIP] Return push to seller failed:', err));
              } catch (notifErr) {
                console.error('[SHIP] Return shipped notification failed:', notifErr);
              }
            }
          } else if (status === 'DELIVERED' && !returnRequest.delivered_at) {
            await prisma.return_requests.update({
              where: { id: returnRequest.id },
              data: { delivered_at: now, updated_at: now },
            });
            console.log(`📬 Return ${returnRequest.id} delivered to seller (tracking: ${trackingNumber})`);
          } else {
            console.log(`📬 Return tracking update for ${returnRequest.id}: ${status}`);
          }
        } else {
          console.log(`⚠️ No order or return found for tracking number: ${trackingNumber}`);
        }
      }
    }

    // Always respond 200 to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Error handling Shippo webhook:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ received: true, error: 'Processing error' });
  }
};

export default {
  getParcelSizes,
  getShippingRates,
  createShippingLabel,
  getTrackingInfo,
  handleShippoWebhook,
};