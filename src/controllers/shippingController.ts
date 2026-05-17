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
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});
import { ESCROW_RELEASE_DAYS } from '../config/constants';
import { sendDeliveryConfirmation } from '../services/emailService';

// ✅ FIXED: Initialize Shippo with correct API key format
// The SDK expects "ShippoToken <your_api_key>" format
const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// Determine city based on postcode prefix for rate estimation
    function getEstimatedCity(postcode: string): string {
      if (!postcode) return 'London';
      const prefix = postcode.toUpperCase().replace(/[0-9]/g, '').trim();
      const cityMap: { [key: string]: string } = {
        'RH': 'Reigate', 'GU': 'Guildford', 'KT': 'Kingston',
        'CR': 'Croydon', 'SM': 'Sutton', 'TW': 'Twickenham',
        'BR': 'Bromley', 'DA': 'Dartford', 'ME': 'Maidstone',
        'TN': 'Tunbridge Wells', 'CT': 'Canterbury', 'BN': 'Brighton',
        'PO': 'Portsmouth', 'SO': 'Southampton', 'BH': 'Bournemouth',
        'SP': 'Salisbury', 'BA': 'Bath', 'BS': 'Bristol',
        'GL': 'Gloucester', 'OX': 'Oxford', 'HP': 'Hemel Hempstead',
        'SL': 'Slough', 'RG': 'Reading', 'MK': 'Milton Keynes',
        'NN': 'Northampton', 'CV': 'Coventry', 'B': 'Birmingham',
        'WS': 'Walsall', 'WV': 'Wolverhampton', 'DY': 'Dudley',
        'ST': 'Stoke-on-Trent', 'DE': 'Derby', 'NG': 'Nottingham',
        'LE': 'Leicester', 'PE': 'Peterborough', 'CB': 'Cambridge',
        'IP': 'Ipswich', 'NR': 'Norwich', 'CO': 'Colchester',
        'CM': 'Chelmsford', 'SS': 'Southend', 'RM': 'Romford',
        'IG': 'Ilford', 'EN': 'Enfield', 'AL': 'St Albans',
        'WD': 'Watford', 'HA': 'Harrow', 'UB': 'Uxbridge',
        'LU': 'Luton', 'SG': 'Stevenage', 'HU': 'Hull',
        'YO': 'York', 'LS': 'Leeds', 'BD': 'Bradford',
        'HX': 'Halifax', 'HD': 'Huddersfield', 'WF': 'Wakefield',
        'S': 'Sheffield', 'DN': 'Doncaster', 'LN': 'Lincoln',
        'M': 'Manchester', 'OL': 'Oldham', 'BL': 'Bolton',
        'WN': 'Wigan', 'WA': 'Warrington', 'L': 'Liverpool',
        'CH': 'Chester', 'CW': 'Crewe', 'SK': 'Stockport',
        'PR': 'Preston', 'BB': 'Blackburn', 'FY': 'Blackpool',
        'LA': 'Lancaster', 'CA': 'Carlisle', 'NE': 'Newcastle',
        'SR': 'Sunderland', 'DH': 'Durham', 'TS': 'Middlesbrough',
        'DL': 'Darlington', 'EH': 'Edinburgh', 'G': 'Glasgow',
        'PA': 'Paisley', 'KA': 'Kilmarnock', 'ML': 'Motherwell',
        'FK': 'Falkirk', 'KY': 'Kirkcaldy', 'DD': 'Dundee',
        'AB': 'Aberdeen', 'PH': 'Perth', 'IV': 'Inverness',
        'CF': 'Cardiff', 'NP': 'Newport', 'SA': 'Swansea',
        'LL': 'Llandudno', 'SY': 'Shrewsbury', 'HR': 'Hereford',
        'WR': 'Worcester', 'DT': 'Dorchester', 'EX': 'Exeter',
        'PL': 'Plymouth', 'TQ': 'Torquay', 'TR': 'Truro',
        'TA': 'Taunton',
      }
      // Check for London postcodes
      if (['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC'].includes(prefix)) {
        return 'London';
      }
      return cityMap[prefix] || 'London';
    };

/**
 * Get seller's real address from Stripe Connect, with postcode fallback
 */
export async function getSellerAddress(sellerId: string): Promise<{ street: string; city: string; postcode: string }> {
  const seller = await prisma.users.findUnique({
    where: { id: sellerId },
    select: { stripe_connect_id: true, postcode_area: true },
  });

  if (seller?.stripe_connect_id) {
    try {
      const account = await stripe.accounts.retrieve(seller.stripe_connect_id);
      const addr = (account as any).individual?.address || (account as any).company?.address;
      if (addr?.line1) {
        return {
          street: addr.line1,
          city: addr.city || getEstimatedCity(seller.postcode_area || ''),
          postcode: addr.postal_code || seller.postcode_area || 'SW1A 1AA',
        };
      }
    } catch (err) {
      console.warn('[SHIPPING] Could not retrieve seller Stripe address, using fallback');
    }
  }

  return {
    street: '1 High Street',
    city: getEstimatedCity(seller?.postcode_area || ''),
    postcode: seller?.postcode_area || 'SW1A 1AA',
  };
}

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
    length: '130',
    width: '15',
    height: '15',
    weight: '2',
  },
  extra_large: {
    name: 'Extra Large',
    description: 'Iron set, stand bag (empty)',
    price: 14.99,
    length: '130',
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
    const sellerPostcode = seller?.postcode_area || 'SW1A 1AA'; // Default if not set

    // Get buyer's shipping address
    const shippingAddress = order.shipping_address as any;
    
    if (!shippingAddress) {
      return res.status(400).json({
        success: false,
        error: 'Order has no shipping address',
      });
    }

    // ✅ Enhanced logging for debugging
    console.log('📦 Getting Shippo rates for order:', orderId);
    console.log('📍 Seller postcode:', sellerPostcode);
    console.log('📍 Buyer address:', JSON.stringify(shippingAddress, null, 2));
    console.log('🛡️ Insurance value:', order.insured_value?.toString() || order.amount.toString());

    

    const estimatedCity = getEstimatedCity(sellerPostcode);
    console.log('📍 Estimated city for seller:', estimatedCity);

    // Create shipment to get rates using new SDK
    // Note: For rate calculation, we use a placeholder street address
    // The actual seller address will be collected when creating the label
    const shipment = await shippo.shipments.create({
      addressFrom: {
        name: seller?.display_name || 'Seller',
        street1: (await getSellerAddress(order.seller_id)).street,
        city: estimatedCity,
        zip: sellerPostcode,
        country: 'GB',
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
      carrier: rate.provider,
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
    const { orderId, rateId, senderAddress } = req.body;

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
        label_cost: labelCost,  // ✅ NEW: Save label cost for escrow deduction
        shippo_transaction_id: transaction.objectId,  // Save transaction ID
        status: 'to_ship', // Ensure status is to_ship after label created
        updated_at: new Date(),
      },
    });

    // ✅ NEW: Also update ALL related orders from the same transaction (multi-item cart checkout)
    // These orders share the same stripe_payment_intent_id and seller_id
    if (order.stripe_payment_intent_id) {
      const relatedOrdersResult = await prisma.orders.updateMany({
        where: {
          stripe_payment_intent_id: order.stripe_payment_intent_id,
          seller_id: order.seller_id,
          id: { not: orderId },  // Don't update the primary order again
          status: { in: ['paid', 'to_ship'] },  // Only update orders that haven't shipped yet
        },
        data: {
          tracking_number: transaction.trackingNumber,
          carrier: carrier,
          label_url: transaction.labelUrl,
          label_cost: 0,  // Only primary order gets the label cost
          shippo_transaction_id: transaction.objectId,
          status: 'to_ship',
          updated_at: new Date(),
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
      labelCost: labelCost,  // ✅ Log the label cost
    });

    // Create notification for buyer
    const listingImage = order.listings?.images?.[0]?.image_url || null;
    
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
        { type: 'shipping', order_id: orderId }
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
        labelCost: labelCost,  // ✅ Return label cost to frontend
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

// ============================================
// MARK ORDER AS SHIPPED
// Updates order status after seller ships
// POST /api/shipping/mark-shipped
// ============================================
export const markAsShipped = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID is required',
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
        error: 'Only the seller can mark an order as shipped',
      });
    }

    // Check order has a label
    if (!order.label_url) {
      return res.status(400).json({
        success: false,
        error: 'Please create a shipping label first',
      });
    }

    // Update order status
    const updatedOrder = await prisma.orders.update({
      where: { id: orderId },
      data: {
        status: 'in_transit',
        shipped_at: new Date(),
        updated_at: new Date(),
      },
    });

    // ✅ NEW: Also mark ALL related orders as shipped (multi-item cart checkout)
    if (order.stripe_payment_intent_id) {
      const relatedOrdersResult = await prisma.orders.updateMany({
        where: {
          stripe_payment_intent_id: order.stripe_payment_intent_id,
          seller_id: order.seller_id,
          id: { not: orderId },
          status: 'to_ship',
        },
        data: {
          status: 'in_transit',
          shipped_at: new Date(),
          updated_at: new Date(),
        },
      });
      
      if (relatedOrdersResult.count > 0) {
        console.log(`✅ Also marked ${relatedOrdersResult.count} related orders as shipped`);
      }
    }

    // Notify buyer
    // ✅ FIX: Add image_url and use consistent type
    const listingImage = order.listings?.images?.[0]?.image_url || null;
    
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.buyer_id,
        type: 'shipped',  // ✅ FIX: Use 'shipped' to match frontend
        title: 'Your Order Has Shipped! 📦',
        message: `Your ${order.listings?.title || 'item'} is on its way! Tracking: ${order.tracking_number}`,
        image_url: listingImage,  // ✅ FIX: Add image
        related_id: orderId,
      },
    });

    // PUSH: Notify buyer item shipped
    try {
      await sendPushNotification(
        order.buyer_id,
        'Your Order Has Shipped!',
        `"${order.listings?.title || 'Your item'}" is on its way! Tracking: ${order.tracking_number}`,
        { type: 'shipped', order_id: orderId }
      );
    } catch (pushErr) {
      console.error('[SHIP] Push notification failed:', pushErr);
    }

    res.json({
      success: true,
      data: {
        orderId: updatedOrder.id,
        status: updatedOrder.status,
        shippedAt: updatedOrder.shipped_at,
        trackingNumber: updatedOrder.tracking_number,
      },
    });
  } catch (error: any) {
    console.error('❌ Error marking order as shipped:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to mark order as shipped',
    });
  }
};

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

        // Map Shippo status to our order status
        switch (status) {
          case 'TRANSIT':
            newStatus = 'in_transit';
            break;
          case 'DELIVERED':
            newStatus = 'delivered';
            deliveredAt = new Date();
            // ✅ Calculate escrow release date (5 days from delivery)
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
        await prisma.orders.updateMany({
          where: { tracking_number: trackingNumber },
          data: {
            status: newStatus,
            delivered_at: deliveredAt,
            escrow_release_at: escrowReleaseAt, // ✅ NEW: Set escrow release date
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
          
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
                confirmUrl: '#',
                reportIssueUrl: '#',
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
              { type: 'delivered', order_id: order.id }
            );
          } catch (pushErr) {
            console.error('[SHIP] Push notification failed:', pushErr);
          }
          
          console.log(`📅 Escrow release scheduled for order ${order.id}: ${escrowReleaseAt?.toISOString()}`);
        }

        console.log(`✅ Updated order ${order.id} status to ${newStatus}`);
      } else {
        console.log(`⚠️ No order found for tracking number: ${trackingNumber}`);
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
  markAsShipped,
  handleShippoWebhook,
};