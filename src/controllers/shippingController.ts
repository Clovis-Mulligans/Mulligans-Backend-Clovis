// src/controllers/shippingController.ts
// Handles Shippo integration for shipping rates, labels, and tracking
// ✅ UPDATED: Added escrow release date when order is delivered

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { Shippo } from 'shippo';

const prisma = new PrismaClient();

// Initialize Shippo with new SDK syntax
const shippo = new Shippo({
  apiKeyHeader: process.env.SHIPPO_API_KEY!,
});

// ✅ Escrow release period (days after delivery)
const ESCROW_RELEASE_DAYS = 5;

// ============================================
// SHIPPING PRICE CONSTANTS
// ============================================
export const PARCEL_SIZES = {
  small: {
    name: 'Small',
    description: 'Balls, gloves, grips',
    price: 3.49,
    length: '25',  // cm (as string for Shippo)
    width: '20',
    height: '5',
    weight: '0.5', // kg
  },
  medium: {
    name: 'Medium',
    description: 'Shoes, single club, clothing',
    price: 5.99,
    length: '45',
    width: '30',
    height: '15',
    weight: '2',
  },
  large: {
    name: 'Large',
    description: 'Driver, woods, iron set',
    price: 9.99,
    length: '120',
    width: '15',
    height: '15',
    weight: '3',
  },
  extra_large: {
    name: 'Extra Large',
    description: 'Full bag, travel bag',
    price: 14.99,
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

    // Get seller's postcode for sender address
    const seller = order.users_orders_seller_idTousers;
    const sellerPostcode = seller.postcode_area || 'SW1A 1AA'; // Default if not set

    // Get buyer's shipping address
    const shippingAddress = order.shipping_address as any;
    
    if (!shippingAddress) {
      return res.status(400).json({
        success: false,
        error: 'Order has no shipping address',
      });
    }

    console.log('Getting Shippo rates for order:', orderId);

    // Create shipment to get rates using new SDK
    const shipment = await shippo.shipments.create({
      addressFrom: {
        name: seller.display_name || 'Seller',
        street1: 'Sender Address', // Will be entered by seller when creating label
        city: 'London',
        zip: sellerPostcode,
        country: 'GB',
      },
      addressTo: {
        name: shippingAddress.name || 'Buyer',
        street1: shippingAddress.line1 || shippingAddress.street1,
        street2: shippingAddress.line2 || shippingAddress.street2 || '',
        city: shippingAddress.city,
        state: shippingAddress.county || shippingAddress.state || '',
        zip: shippingAddress.postcode || shippingAddress.postal_code,
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
      async: false,
    });

    // Format rates for response
    const rates = shipment.rates?.map((rate: any) => ({
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
    console.error('Error getting shipping rates:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get shipping rates',
    });
  }
};

// ============================================
// CREATE SHIPPING LABEL
// Creates a label and returns PDF URL
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
        listings: true,
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

    console.log('Creating shipping label for order:', orderId, 'with rate:', rateId);

    // Create transaction (purchase the label) using Shippo
    const transaction = await shippo.transactions.create({
      rate: rateId,
      labelFileType: 'PDF',
      async: false,
    });

    // Check if transaction was successful
    if (transaction.status !== 'SUCCESS') {
      console.error('Shippo transaction failed:', transaction.messages);
      return res.status(400).json({
        success: false,
        error: 'Failed to create shipping label',
        details: transaction.messages,
      });
    }

    // Get carrier from rate info
    const carrier = typeof transaction.rate === 'object' ? transaction.rate?.provider || 'Unknown' : 'Unknown';

    // Update order with tracking info and label URL
    await prisma.orders.update({
      where: { id: orderId },
      data: {
        tracking_number: transaction.trackingNumber,
        carrier: carrier,
        label_url: transaction.labelUrl,
        status: 'to_ship', // Ensure status is to_ship after label created
        updated_at: new Date(),
      },
    });

    console.log('Shipping label created:', {
      orderId,
      trackingNumber: transaction.trackingNumber,
      carrier,
      labelUrl: transaction.labelUrl,
    });

    // Create notification for buyer
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.buyer_id,
        type: 'shipping_label_created',
        title: 'Shipping Label Created',
        message: `The seller has created a shipping label for your order. Tracking: ${transaction.trackingNumber}`,
        related_id: orderId,
      },
    });

    res.json({
      success: true,
      data: {
        trackingNumber: transaction.trackingNumber,
        trackingUrl: transaction.trackingUrlProvider,
        labelUrl: transaction.labelUrl,
        carrier: carrier,
        transactionId: transaction.objectId,
      },
    });
  } catch (error: any) {
    console.error('Error creating shipping label:', error);
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
    console.error('Error getting tracking info:', error);
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
        listings: true,
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

    // Notify buyer
    await prisma.notifications.create({
      data: {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: order.buyer_id,
        type: 'order_shipped',
        title: 'Your Order Has Shipped! 📦',
        message: `Your ${order.listings?.title || 'item'} is on its way! Tracking: ${order.tracking_number}`,
        related_id: orderId,
      },
    });

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
    console.error('Error marking order as shipped:', error);
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

        // Update order
        await prisma.orders.update({
          where: { id: order.id },
          data: {
            status: newStatus,
            delivered_at: deliveredAt,
            escrow_release_at: escrowReleaseAt, // ✅ NEW: Set escrow release date
            updated_at: new Date(),
          },
        });

        // Notify buyer of delivery
        if (status === 'DELIVERED') {
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: order.buyer_id,
              type: 'order_delivered',
              title: 'Your Order Has Been Delivered! 🎉',
              message: `Your item has arrived. You have ${ESCROW_RELEASE_DAYS} days to confirm receipt or report any issues.`,
              related_id: order.id,
            },
          });
          
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
