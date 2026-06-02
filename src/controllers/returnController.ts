// src/controllers/returnController.ts
// Handles return label purchases and return flow
// ✅ Buyer pays: Deducted from refund
// ✅ Seller pays: Charged via Stripe upfront
// ✅ Full notifications: In-app, Push, and Email

import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import Stripe from 'stripe';
import { Shippo } from 'shippo';
import { getSellerSendingAddress } from '../lib/sellerAddress';
import { sendPushNotification } from './pushNotificationController';
import { 
  sendReturnAddressNeeded,
  sendReturnLabelCreated,
  sendReturnShipped,
  sendReturnRefundProcessed,
} from '../services/emailService';
import { normalizeCarrierName } from '../utils/carrierName';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});
const shippo = new Shippo({
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
});

// Escrow period for returns (days after delivery)
const RETURN_ESCROW_DAYS = 5;

// Type for authenticated requests
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

// ============================================
// CHECK SELLER ADDRESS STATUS
// Returns whether seller has a stored sending address
// GET /api/returns/seller-status/:orderId
// ============================================
export const checkSellerStripeStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId } = req.params;

    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        users_orders_seller_idTousers: {
          select: {
            id: true,
            stripe_connect_id: true,
            stripe_connect_status: true,
            display_name: true,
            email: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const sellerAddr = await getSellerSendingAddress(order.seller_id);

    return res.json({
      success: true,
      data: {
        hasAddress: sellerAddr.isReal,
        canReceiveReturns: sellerAddr.isReal,
        message: sellerAddr.isReal
          ? 'Seller can receive returns'
          : 'Seller needs to set their sending address',
      },
    });
  } catch (error: any) {
    console.error('❌ Error checking seller status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// CREATE RETURN REQUEST
// Called when return is approved (by seller or admin)
// POST /api/returns/create
// ============================================
export const createReturnRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { orderId, disputeId, reason } = req.body;

    if (!orderId || !reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Order ID and reason are required' 
      });
    }

    // Get order with dispute info
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: {
        disputes: true,
        listings: true,
        users_orders_buyer_idTousers: true,
        users_orders_seller_idTousers: true,
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Check user is buyer or seller
    const isBuyer = order.buyer_id === req.user?.id;
    const isSeller = order.seller_id === req.user?.id;
    
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ 
        success: false, 
        error: 'You do not have access to this order' 
      });
    }

    // Check if return request already exists
    const existingReturn = await prisma.return_requests.findFirst({
      where: { 
        order_id: orderId,
        status: { notIn: ['cancelled', 'completed'] },
      },
    });

    if (existingReturn) {
      return res.status(400).json({ 
        success: false, 
        error: 'A return request already exists for this order',
        returnId: existingReturn.id,
      });
    }

    const seller = order.users_orders_seller_idTousers;
    const sellerAddr = await getSellerSendingAddress(order.seller_id);
    let initialStatus = sellerAddr.isReal ? 'approved' : 'awaiting_address';

    // Calculate refund amount (100% minus return shipping will be calculated later)
    const refundAmount = parseFloat(order.listing_price?.toString() || order.amount.toString());

    // Get listing title for notifications
    const listingTitle = order.listing_title || order.listings?.title || 'Item';

    // Create return request
    const returnRequest = await prisma.return_requests.create({
      data: {
        order_id: orderId,
        dispute_id: disputeId || order.disputes?.id || null,
        requested_by: req.user!.id,
        approved_by: req.user!.id, // Auto-approved when created through agreement
        reason: reason,
        status: initialStatus,
        refund_amount: refundAmount,
      },
    });

    // If awaiting address, notify seller specifically
    if (initialStatus === 'awaiting_address' && !isSeller) {
      // In-app notification
      const returnAddressNeededNotifId = crypto.randomUUID();
      await prisma.notifications.create({
        data: {
          id: returnAddressNeededNotifId,
          user_id: order.seller_id,
          type: 'return_address_needed',
          title: '⚠️ Action Required: Return Address Needed',
          message: `Please complete your Stripe setup to receive the returned "${listingTitle}".`,
          image_url: order.listing_image,
          related_id: returnRequest.id,
        },
      });

      // Push notification
      try {
        await sendPushNotification(
          order.seller_id,
          '⚠️ Action Required',
          `Complete your Stripe setup to receive the returned "${listingTitle}"`,
          { notification_id: returnAddressNeededNotifId, type: 'return_requested', return_id: returnRequest.id, order_id: orderId }
        );
      } catch (pushErr) {
        console.error('[RETURN] Push notification failed:', pushErr);
      }

      // Email notification
      try {
        await sendReturnAddressNeeded(seller.email, {
          sellerName: seller.display_name || 'Seller',
          itemTitle: listingTitle,
          orderNumber: orderId.slice(-8).toUpperCase(),
          buyerName: order.users_orders_buyer_idTousers.display_name || 'Buyer',
          itemImageUrl: order.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(order.listings?.price?.toString() || order.amount?.toString() || '0').toFixed(2)}`,
        });
      } catch (emailErr) {
        console.error('[RETURN] Failed to send address needed email:', emailErr);
      }
    }

    // Notify the other party about return approval
    const otherUserId = isBuyer ? order.seller_id : order.buyer_id;

    // In-app notification
    const returnApprovedNotifId = crypto.randomUUID();
    await prisma.notifications.create({
      data: {
        id: returnApprovedNotifId,
        user_id: otherUserId,
        type: 'return_approved',
        title: 'Return Approved',
        message: initialStatus === 'awaiting_address'
          ? `Return approved for "${listingTitle}". Please complete your Stripe setup to provide a return address.`
          : `Return approved for "${listingTitle}". A return label can now be purchased.`,
        image_url: order.listing_image,
        related_id: returnRequest.id,
      },
    });

    // Push notification
    try {
      await sendPushNotification(
        otherUserId,
        'Return Approved',
        `Return approved for "${listingTitle}"`,
        { notification_id: returnApprovedNotifId, type: 'return_approved', return_id: returnRequest.id, order_id: orderId }
      );
    } catch (pushErr) {
      console.error('[RETURN] Push notification failed:', pushErr);
    }

    res.json({
      success: true,
      data: {
        returnId: returnRequest.id,
        status: returnRequest.status,
        refundAmount: refundAmount,
        awaitingSellerAddress: initialStatus === 'awaiting_address',
      },
    });
  } catch (error: any) {
    console.error('❌ Error creating return request:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// GET RETURN SHIPPING RATES
// Fetches rates for return shipment (buyer → seller)
// POST /api/returns/rates
// ============================================
export const getReturnShippingRates = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId } = req.body;

    if (!returnId) {
      return res.status(400).json({ success: false, error: 'Return ID is required' });
    }

    // Get return request with order info
    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            listings: true,
            users_orders_buyer_idTousers: true,
            users_orders_seller_idTousers: true,
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Check status allows label purchase
    if (returnRequest.status === 'awaiting_address') {
      return res.status(400).json({ 
        success: false, 
        error: 'Seller has not completed their address setup yet' 
      });
    }

    if (returnRequest.return_label_url) {
      return res.status(400).json({ 
        success: false, 
        error: 'Return label already exists',
        labelUrl: returnRequest.return_label_url,
      });
    }

    const order = returnRequest.orders;
    const buyer = order.users_orders_buyer_idTousers;
    const seller = order.users_orders_seller_idTousers;

    const sellerAddress = await getSellerSendingAddress(order.seller_id);
    if (!sellerAddress.isReal || !sellerAddress.address) {
      return res.status(400).json({
        success: false,
        error: 'sending_address_required',
        addressRequired: true,
        reason: sellerAddress.failureReason,
      });
    }

    // Get buyer's address from the original order shipping address
    const buyerAddress = order.shipping_address as any;
    if (!buyerAddress) {
      return res.status(400).json({ 
        success: false, 
        error: 'No shipping address found for this order' 
      });
    }

    // Get parcel size from original listing
    const parcelSize = order.listings?.parcel_size || 'medium';
    const parcelConfig = {
      small: { length: '30', width: '20', height: '10', weight: '1' },
      medium: { length: '45', width: '35', height: '20', weight: '5' },
      large: { length: '130', width: '15', height: '15', weight: '3' },
      extra_large: { length: '130', width: '40', height: '40', weight: '15' },
      oversized: { length: '140', width: '50', height: '50', weight: '25' },
    }[parcelSize] || { length: '45', width: '35', height: '20', weight: '5' };

    console.log('📦 Getting return shipping rates');
    console.log('📍 From (buyer):', buyerAddress);
    console.log('📍 To (seller):', sellerAddress.address);

    // Create shipment for rates (REVERSED: buyer → seller)
    const shipment = await shippo.shipments.create({
      addressFrom: {
        name: buyerAddress.name || 'Buyer',
        street1: buyerAddress.line1 || buyerAddress.street1,
        street2: buyerAddress.line2 || buyerAddress.street2 || '',
        city: buyerAddress.city,
        state: buyerAddress.county || buyerAddress.state || '',
        zip: buyerAddress.postcode || buyerAddress.postal_code,
        country: buyerAddress.country || 'GB',
      },
      addressTo: {
        name: sellerAddress.address.name,
        street1: sellerAddress.address.line1,
        street2: sellerAddress.address.line2 || '',
        city: sellerAddress.address.city,
        zip: sellerAddress.address.postal_code,
        country: sellerAddress.address.country,
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

    // Filter for tracked services only
    const trackedRates = shipment.rates?.filter((rate: any) => {
      const serviceName = (rate.servicelevel?.name || '').toLowerCase();
      const serviceToken = (rate.servicelevel?.token || '').toLowerCase();
      const provider = (rate.provider || '').toLowerCase();
      
      const untrackedKeywords = ['untracked', 'economy', 'standard letter', 'large letter'];
      const isUntracked = untrackedKeywords.some(keyword => 
        serviceName.includes(keyword) || serviceToken.includes(keyword)
      );
      
      if (isUntracked) return false;
      
      const trackedKeywords = ['tracked', 'signed', 'express', 'next day', 'courier', 'parcel', 'evri', 'dpd', 'yodel'];
      const isTracked = trackedKeywords.some(keyword => 
        serviceName.includes(keyword) || serviceToken.includes(keyword) || provider.includes(keyword)
      );
      
      const hasDeliveryEstimate = rate.estimatedDays !== undefined;
      const isProbablyTracked = hasDeliveryEstimate && parseFloat(rate.amount) >= 2.50;
      
      return isTracked || isProbablyTracked;
    }) || [];

    // Format rates
    const rates = trackedRates.map((rate: any) => ({
      id: rate.objectId,
      carrier: rate.provider,
      service: rate.servicelevel?.name || rate.servicelevelName,
      price: parseFloat(rate.amount),
      currency: rate.currency,
      estimatedDays: rate.estimatedDays,
    })).sort((a: any, b: any) => a.price - b.price);

    res.json({
      success: true,
      data: {
        shipmentId: shipment.objectId,
        rates,
        parcelSize,
        sellerAddress: {
          city: sellerAddress.city,
          postcode: sellerAddress.postal_code,
        },
      },
    });
  } catch (error: any) {
    console.error('❌ Error getting return rates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// PURCHASE RETURN LABEL - BUYER PAYS
// Deducted from refund amount
// POST /api/returns/purchase-label/buyer
// ============================================
export const purchaseReturnLabelBuyer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId, rateId } = req.body;

    if (!returnId || !rateId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Return ID and Rate ID are required' 
      });
    }

    // Get return request with seller email
    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            listings: true,
            users_orders_seller_idTousers: {
              select: {
                id: true,
                display_name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Check user is the buyer
    if (returnRequest.orders.buyer_id !== req.user?.id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only the buyer can purchase this return label' 
      });
    }

    // Check label doesn't already exist
    if (returnRequest.return_label_url) {
      return res.status(400).json({ 
        success: false, 
        error: 'Return label already exists',
        labelUrl: returnRequest.return_label_url,
      });
    }

    console.log('🏷️ Creating return label for return:', returnId);

    // Get rate price
    let labelCost = 0;
    let carrierName = 'Unknown';
    try {
      const rate = await shippo.rates.get(rateId);
      labelCost = parseFloat(rate.amount || '0');
      carrierName = normalizeCarrierName(rate.provider) || 'Unknown';
      console.log('💰 Return label cost:', labelCost);
      console.log('📦 Carrier:', carrierName);
    } catch (rateError) {
      console.warn('⚠️ Could not fetch rate details');
    }

    // Create the label (charges Mulligans' Shippo card)
    const transaction = await shippo.transactions.create({
      rate: rateId,
      labelFileType: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      console.error('❌ Shippo transaction failed:', transaction.messages);
      return res.status(400).json({
        success: false,
        error: 'Failed to create return shipping label',
        details: transaction.messages,
      });
    }

    // Get label cost from transaction if not from rate
    if (labelCost === 0 && typeof transaction.rate === 'object') {
      labelCost = parseFloat((transaction.rate as any).amount || '0');
    }

    // Calculate new refund amount (original minus shipping)
    const originalRefund = parseFloat(returnRequest.refund_amount?.toString() || '0');
    const newRefundAmount = Math.max(0, originalRefund - labelCost);
    if (newRefundAmount === 0) {
      console.warn(`[RETURN] Label cost (£${labelCost.toFixed(2)}) exceeds refund (£${originalRefund.toFixed(2)}) — refund zeroed out`);
    }

    const returnShipDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // Update return request
    await prisma.return_requests.update({
      where: { id: returnId },
      data: {
        return_label_url: transaction.labelUrl,
        return_tracking_number: transaction.trackingNumber,
        return_carrier: carrierName,
        label_cost: labelCost,
        paid_by: req.user!.id,
        shippo_transaction_id: transaction.objectId,
        shipping_deducted: labelCost,
        refund_amount: newRefundAmount,
        status: 'label_created',
        return_ship_deadline: returnShipDeadline,
        updated_at: new Date(),
      },
    });

    console.log('✅ Return label created:', {
      returnId,
      trackingNumber: transaction.trackingNumber,
      carrier: carrierName,
      labelCost,
      newRefundAmount,
      returnShipDeadline: returnShipDeadline.toISOString(),
    });

    // Get info for notifications
    const listingTitle = returnRequest.orders.listing_title || 'Item';
    const seller = returnRequest.orders.users_orders_seller_idTousers;

    // In-app notification to seller
    const returnLabelCreatedNotifId = crypto.randomUUID();
    await prisma.notifications.create({
      data: {
        id: returnLabelCreatedNotifId,
        user_id: returnRequest.orders.seller_id,
        type: 'return_label_created',
        title: 'Return Label Created',
        message: `The buyer has created a return label for "${listingTitle}". Tracking: ${transaction.trackingNumber}`,
        image_url: returnRequest.orders.listing_image,
        related_id: returnId,
      },
    });

    // Push notification to seller
    try {
      await sendPushNotification(
        returnRequest.orders.seller_id,
        'Return Label Created',
        `Buyer is returning "${listingTitle}". Tracking: ${transaction.trackingNumber}`,
        { notification_id: returnLabelCreatedNotifId, type: 'return_approved', return_id: returnId, order_id: returnRequest.order_id }
      );
    } catch (pushErr) {
      console.error('[RETURN] Push notification failed:', pushErr);
    }

    // Email to seller
    try {
      if (seller?.email) {
        await sendReturnLabelCreated(seller.email, {
          recipientName: seller.display_name || 'Seller',
          itemTitle: listingTitle,
          carrier: carrierName,
          trackingNumber: transaction.trackingNumber || '',
          message: `The buyer has created a return label and will be sending back "${listingTitle}". Keep an eye out for the delivery.`,
          orderNumber: returnRequest.order_id?.slice(-8).toUpperCase() || '',
          itemImageUrl: returnRequest.orders?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(returnRequest.orders?.listings?.price?.toString() || returnRequest.orders?.amount?.toString() || '0').toFixed(2)}`,
        });
      }
    } catch (emailErr) {
      console.error('[RETURN] Email failed:', emailErr);
    }

    res.json({
      success: true,
      data: {
        trackingNumber: transaction.trackingNumber,
        trackingUrl: transaction.trackingUrlProvider,
        labelUrl: transaction.labelUrl,
        carrier: carrierName,
        labelCost,
        originalRefund,
        newRefundAmount,
        message: `£${labelCost.toFixed(2)} will be deducted from your refund`,
      },
    });
  } catch (error: any) {
    console.error('❌ Error creating return label (buyer):', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// PURCHASE RETURN LABEL - SELLER PAYS
// Charges seller via Stripe
// POST /api/returns/purchase-label/seller
// ============================================
export const purchaseReturnLabelSeller = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId, rateId, paymentMethodId } = req.body;

    if (!returnId || !rateId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Return ID and Rate ID are required' 
      });
    }

    // Get return request with buyer email
    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            listings: true,
            users_orders_buyer_idTousers: {
              select: {
                id: true,
                display_name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Check user is the seller
    if (returnRequest.orders.seller_id !== req.user?.id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only the seller can pay for this return label' 
      });
    }

    // Check label doesn't already exist
    if (returnRequest.return_label_url) {
      return res.status(400).json({ 
        success: false, 
        error: 'Return label already exists',
        labelUrl: returnRequest.return_label_url,
      });
    }

    console.log('🏷️ Creating return label (seller pays) for return:', returnId);

    // Get rate price
    let labelCost = 0;
    let carrierName = 'Unknown';
    try {
      const rate = await shippo.rates.get(rateId);
      labelCost = parseFloat(rate.amount || '0');
      carrierName = normalizeCarrierName(rate.provider) || 'Unknown';
    } catch (rateError) {
      console.warn('⚠️ Could not fetch rate details');
    }

    // Charge seller via Stripe
    const labelCostPence = Math.round(labelCost * 100);
    
    if (labelCostPence < 30) {
      return res.status(400).json({
        success: false,
        error: 'Label cost is too low to process payment',
      });
    }

    // Create payment intent for seller
    const paymentIntent = await stripe.paymentIntents.create({
      amount: labelCostPence,
      currency: 'gbp',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
      metadata: {
        type: 'return_label',
        return_id: returnId,
        order_id: returnRequest.order_id,
        paid_by: 'seller',
      },
    });

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        error: 'Payment failed. Please try again.',
      });
    }

    console.log('💳 Seller payment successful:', paymentIntent.id);

    // Create the label (charges Mulligans' Shippo card)
    const transaction = await shippo.transactions.create({
      rate: rateId,
      labelFileType: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      // Refund seller if label creation fails
      await stripe.refunds.create({
        payment_intent: paymentIntent.id,
        reason: 'requested_by_customer',
      });
      
      console.error('❌ Shippo transaction failed, seller refunded:', transaction.messages);
      return res.status(400).json({
        success: false,
        error: 'Failed to create return shipping label. Payment has been refunded.',
        details: transaction.messages,
      });
    }

    // Get label cost from transaction if not from rate
    if (labelCost === 0 && typeof transaction.rate === 'object') {
      labelCost = parseFloat((transaction.rate as any).amount || '0');
    }

    const returnShipDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // Update return request (refund amount stays the same since seller paid)
    await prisma.return_requests.update({
      where: { id: returnId },
      data: {
        return_label_url: transaction.labelUrl,
        return_tracking_number: transaction.trackingNumber,
        return_carrier: carrierName,
        label_cost: labelCost,
        paid_by: req.user!.id,
        shippo_transaction_id: transaction.objectId,
        shipping_deducted: 0, // Seller paid, so nothing deducted from buyer's refund
        status: 'label_created',
        return_ship_deadline: returnShipDeadline,
        updated_at: new Date(),
      },
    });

    console.log('✅ Return label created (seller paid):', {
      returnId,
      trackingNumber: transaction.trackingNumber,
      carrier: carrierName,
      labelCost,
    });

    // Get info for notifications
    const listingTitle = returnRequest.orders.listing_title || 'Item';
    const buyer = returnRequest.orders.users_orders_buyer_idTousers;

    // In-app notification to buyer
    const returnLabelReadyNotifId = crypto.randomUUID();
    await prisma.notifications.create({
      data: {
        id: returnLabelReadyNotifId,
        user_id: returnRequest.orders.buyer_id,
        type: 'return_label_created',
        title: 'Return Label Ready',
        message: `The seller has purchased a return label for "${listingTitle}". You can now ship the item back.`,
        image_url: returnRequest.orders.listing_image,
        related_id: returnId,
      },
    });

    // Push notification to buyer
    try {
      await sendPushNotification(
        returnRequest.orders.buyer_id,
        'Return Label Ready',
        `Return label ready for "${listingTitle}". Ship it back to get your refund.`,
        { notification_id: returnLabelReadyNotifId, type: 'return_approved', return_id: returnId, order_id: returnRequest.order_id }
      );
    } catch (pushErr) {
      console.error('[RETURN] Push notification failed:', pushErr);
    }

    // Email to buyer
    try {
      if (buyer?.email) {
        await sendReturnLabelCreated(buyer.email, {
          recipientName: buyer.display_name || 'there',
          itemTitle: listingTitle,
          carrier: carrierName,
          trackingNumber: transaction.trackingNumber || '',
          message: `The seller has purchased a return label for "${listingTitle}". Please print the label and ship the item back to receive your refund.`,
          orderNumber: returnRequest.order_id?.slice(-8).toUpperCase() || '',
          itemImageUrl: returnRequest.orders?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(returnRequest.orders?.listings?.price?.toString() || returnRequest.orders?.amount?.toString() || '0').toFixed(2)}`,
        });
      }
    } catch (emailErr) {
      console.error('[RETURN] Email failed:', emailErr);
    }

    res.json({
      success: true,
      data: {
        trackingNumber: transaction.trackingNumber,
        trackingUrl: transaction.trackingUrlProvider,
        labelUrl: transaction.labelUrl,
        carrier: carrierName,
        labelCost,
        paidBy: 'seller',
        message: 'Label purchased successfully. Buyer can now ship the item.',
      },
    });
  } catch (error: any) {
    console.error('❌ Error creating return label (seller):', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// MARK RETURN AS SHIPPED
// POST /api/returns/mark-shipped
// ============================================
export const markReturnShipped = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId } = req.body;

    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            users_orders_seller_idTousers: {
              select: {
                id: true,
                display_name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Only buyer can mark as shipped
    if (returnRequest.orders.buyer_id !== req.user?.id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only the buyer can mark this return as shipped' 
      });
    }

    if (!returnRequest.return_label_url) {
      return res.status(400).json({ 
        success: false, 
        error: 'Please create a return label first' 
      });
    }

    await prisma.return_requests.update({
      where: { id: returnId },
      data: {
        status: 'shipped',
        shipped_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Get info for notifications
    const listingTitle = returnRequest.orders.listing_title || 'Item';
    const seller = returnRequest.orders.users_orders_seller_idTousers;

    // In-app notification to seller
    const returnShippedNotifId = crypto.randomUUID();
    await prisma.notifications.create({
      data: {
        id: returnShippedNotifId,
        user_id: returnRequest.orders.seller_id,
        type: 'return_shipped',
        title: 'Return Item Shipped',
        message: `The buyer has shipped the return. Tracking: ${returnRequest.return_tracking_number}`,
        image_url: returnRequest.orders.listing_image,
        related_id: returnId,
      },
    });

    // Push notification to seller
    try {
      await sendPushNotification(
        returnRequest.orders.seller_id,
        'Return Item Shipped',
        `Return is on its way! Tracking: ${returnRequest.return_tracking_number}`,
        { notification_id: returnShippedNotifId, type: 'return_shipped', return_id: returnId, order_id: returnRequest.order_id }
      );
    } catch (pushErr) {
      console.error('[RETURN] Push notification failed:', pushErr);
    }

    // Email to seller
    try {
      if (seller?.email) {
        await sendReturnShipped(seller.email, {
          sellerName: seller.display_name || 'Seller',
          itemTitle: listingTitle,
          carrier: returnRequest.return_carrier || 'Carrier',
          trackingNumber: returnRequest.return_tracking_number || '',
          orderNumber: returnRequest.order_id?.slice(-8).toUpperCase() || '',
          itemImageUrl: returnRequest.orders?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(returnRequest.orders?.amount?.toString() || '0').toFixed(2)}`,
        });
      }
    } catch (emailErr) {
      console.error('[RETURN] Email failed:', emailErr);
    }

    res.json({
      success: true,
      data: {
        status: 'shipped',
        shippedAt: new Date(),
        trackingNumber: returnRequest.return_tracking_number,
      },
    });
  } catch (error: any) {
    console.error('❌ Error marking return shipped:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// CONFIRM RETURN DELIVERED
// Seller confirms receipt, starts escrow period
// POST /api/returns/confirm-delivered
// ============================================
export const confirmReturnDelivered = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId } = req.body;

    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            users_orders_buyer_idTousers: {
              select: {
                id: true,
                display_name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Only seller can confirm delivery
    if (returnRequest.orders.seller_id !== req.user?.id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only the seller can confirm return delivery' 
      });
    }

    // Calculate escrow release date
    const escrowReleaseAt = new Date();
    escrowReleaseAt.setDate(escrowReleaseAt.getDate() + RETURN_ESCROW_DAYS);

    await prisma.return_requests.update({
      where: { id: returnId },
      data: {
        status: 'delivered',
        delivered_at: new Date(),
        escrow_release_at: escrowReleaseAt,
        updated_at: new Date(),
      },
    });

    // Get info for notifications
    const listingTitle = returnRequest.orders.listing_title || 'Item';
    const buyer = returnRequest.orders.users_orders_buyer_idTousers;
    const refundAmount = returnRequest.refund_amount?.toFixed(2) || '0.00';

    // In-app notification to buyer
    const returnDeliveredNotifId = crypto.randomUUID();
    await prisma.notifications.create({
      data: {
        id: returnDeliveredNotifId,
        user_id: returnRequest.orders.buyer_id,
        type: 'return_delivered',
        title: 'Return Received',
        message: `The seller has confirmed receipt of your return. Your refund of £${refundAmount} will be processed in ${RETURN_ESCROW_DAYS} days.`,
        image_url: returnRequest.orders.listing_image,
        related_id: returnId,
      },
    });

    // Push notification to buyer
    try {
      await sendPushNotification(
        returnRequest.orders.buyer_id,
        'Return Received',
        `Seller received your return. Refund processing in ${RETURN_ESCROW_DAYS} days.`,
        { notification_id: returnDeliveredNotifId, type: 'return_refunded', return_id: returnId, order_id: returnRequest.order_id }
      );
    } catch (pushErr) {
      console.error('[RETURN] Push notification failed:', pushErr);
    }

    // Email to buyer
    try {
      if (buyer?.email) {
        await sendReturnRefundProcessed(buyer.email, {
          buyerName: buyer.display_name || 'there',
          itemTitle: listingTitle,
          refundAmount: refundAmount,
          shippingDeducted: returnRequest.shipping_deducted?.toFixed(2) || undefined,
          orderNumber: returnRequest.order_id.slice(-8).toUpperCase(),
          itemImageUrl: returnRequest.orders?.listing_image || '',
          itemBrand: '',
          itemCondition: '',
          itemPrice: `£${parseFloat(returnRequest.orders?.amount?.toString() || '0').toFixed(2)}`,
        });
      }
    } catch (emailErr) {
      console.error('[RETURN] Email failed:', emailErr);
    }

    res.json({
      success: true,
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        escrowReleaseAt,
        refundAmount: returnRequest.refund_amount,
        message: `Refund will be processed on ${escrowReleaseAt.toLocaleDateString()}`,
      },
    });
  } catch (error: any) {
    console.error('❌ Error confirming return delivery:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// GET RETURN REQUEST DETAILS
// GET /api/returns/:returnId
// ============================================
export const getReturnRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnId } = req.params;

    const returnRequest = await prisma.return_requests.findUnique({
      where: { id: returnId },
      include: {
        orders: {
          include: {
            listings: {
              include: {
                images: { take: 1, orderBy: PRIMARY_IMAGE_ORDER },
              },
            },
            users_orders_buyer_idTousers: {
              select: { id: true, display_name: true, avatar_url: true },
            },
            users_orders_seller_idTousers: {
              select: { id: true, display_name: true, avatar_url: true, stripe_connect_id: true },
            },
          },
        },
        disputes: true,
      },
    });

    if (!returnRequest) {
      return res.status(404).json({ success: false, error: 'Return request not found' });
    }

    // Check user is buyer or seller
    const isBuyer = returnRequest.orders.buyer_id === req.user?.id;
    const isSeller = returnRequest.orders.seller_id === req.user?.id;
    
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ 
        success: false, 
        error: 'You do not have access to this return request' 
      });
    }

    const sellerAddrResult = await getSellerSendingAddress(returnRequest.orders.seller_id);
    const sellerHasAddress = sellerAddrResult.isReal;

    res.json({
      success: true,
      data: {
        ...returnRequest,
        sellerHasAddress,
        canPurchaseLabel: returnRequest.status === 'approved' && sellerHasAddress && !returnRequest.return_label_url,
        isBuyer,
        isSeller,
      },
    });
  } catch (error: any) {
    console.error('❌ Error getting return request:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

export default {
  checkSellerStripeStatus,
  createReturnRequest,
  getReturnShippingRates,
  purchaseReturnLabelBuyer,
  purchaseReturnLabelSeller,
  markReturnShipped,
  confirmReturnDelivered,
  getReturnRequest,
};