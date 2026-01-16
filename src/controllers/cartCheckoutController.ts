// src/controllers/cartCheckoutController.ts
// Handles checkout for cart with multiple items (potentially from multiple sellers)
// ESCROW UPDATE: Removed immediate transfers - funds held until escrow releases
// ESCROW UPDATE: Shipping deadline changed from 7 to 5 days
// FIXED: Now includes image_url in notifications
// UPDATED: Sends order confirmation email to buyer
// QUANTITY UPDATE: Now handles quantities in cart items
// PUSH: Added push notifications

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { sendOrderConfirmation, sendSaleNotification } from '../services/emailService';
import { sendPushNotification } from './pushNotificationController';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    sub?: string;
  };
}

// Platform fee calculation
const PLATFORM_FEE_PERCENT = 0.075; // 7.5%
const PLATFORM_FEE_FIXED = 0.99; // £0.99

// Escrow constants
const SHIPPING_DEADLINE_DAYS = 5;

// SIZE VARIANT: Helper to get stock for a specific size
function getStockForSize(listing: any, selectedSize: string | null): number {
  if (!selectedSize) {
    return listing.quantity || 1;
  }
  const specs = listing.specifications as any;
  if (specs?.sizeQuantities && typeof specs.sizeQuantities === 'object') {
    return specs.sizeQuantities[selectedSize] || 0;
  }
  return listing.quantity || 1;
}

// SIZE VARIANT: Helper to decrement stock for a specific size
function decrementSizeStock(specifications: any, selectedSize: string, quantity: number): any {
  if (!specifications || !selectedSize) return specifications;
  
  const specs = { ...specifications };
  if (specs.sizeQuantities && typeof specs.sizeQuantities === 'object') {
    const currentStock = specs.sizeQuantities[selectedSize] || 0;
    specs.sizeQuantities = {
      ...specs.sizeQuantities,
      [selectedSize]: Math.max(0, currentStock - quantity)
    };
  }
  return specs;
}

// SIZE VARIANT: Helper to calculate total stock from all sizes
function getTotalStockFromSizes(specifications: any): number {
  if (!specifications?.sizeQuantities) return 0;
  return Object.values(specifications.sizeQuantities).reduce((sum: number, qty: any) => sum + (qty || 0), 0);
}

export class CartCheckoutController {
  /**
   * Create Stripe Checkout Session for Cart
   * POST /api/stripe/create-cart-checkout
   */
  static async createCartCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('[CART] Creating cart checkout session for user:', userId);

      // Get all cart items for this user
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() },
        },
        include: {
          listings: {
            include: {
              images: {
                take: 1,
                orderBy: { created_at: 'asc' },
              },
              users: {
                select: {
                  id: true,
                  email: true,
                  display_name: true,
                  stripe_connect_id: true,
                  stripe_connect_status: true,
                },
              },
            },
          },
        },
      });

      if (cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
      }

      // Validate all items are still available
      const unavailableItems = cartItems.filter(
        (item) => item.listings.status !== 'active'
      );

      if (unavailableItems.length > 0) {
        await prisma.cart_items.deleteMany({
          where: {
            id: { in: unavailableItems.map((item) => item.id) },
          },
        });

        return res.status(400).json({
          error: 'Some items are no longer available',
          unavailable: unavailableItems.map((item) => ({
            listing_id: item.listing_id,
            title: item.listings.title,
          })),
        });
      }

      // SIZE VARIANT: Validate quantities against size-specific stock
      const overStockItems: any[] = [];
      for (const item of cartItems) {
        const selectedSize = item.selected_size;
        const requestedQty = item.quantity || 1;
        const availableStock = getStockForSize(item.listings, selectedSize);
        
        if (requestedQty > availableStock) {
          overStockItems.push({
            listing_id: item.listing_id,
            title: item.listings.title,
            selected_size: selectedSize,
            requested: requestedQty,
            available: availableStock,
          });
        }
      }

      if (overStockItems.length > 0) {
        return res.status(400).json({
          error: 'Some items exceed available stock',
          over_stock: overStockItems,
        });
      }

      // Check buyer isn't buying their own items
      const ownItems = cartItems.filter(
        (item) => item.listings.seller_id === userId
      );

      if (ownItems.length > 0) {
        return res.status(400).json({
          error: 'You cannot buy your own listings',
          own_items: ownItems.map((item) => item.listings.title),
        });
      }

      // Group items by seller for order creation later
      const sellerGroups: {
        [sellerId: string]: {
          seller: any;
          items: any[];
          subtotal: number;
          shippingTotal: number;
          totalQuantity: number;
        };
      } = {};

      for (const item of cartItems) {
        const sellerId = item.listings.seller_id;
        const seller = item.listings.users;
        const quantity = item.quantity || 1;

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = {
            seller,
            items: [],
            subtotal: 0,
            shippingTotal: 0,
            totalQuantity: 0,
          };
        }

        const price = parseFloat(item.listings.price.toString());
        const shippingCost = parseFloat((item.listings as any).shipping_cost?.toString() || '0');
        
        const listingShipping = Math.ceil(quantity / 5) * shippingCost;
        
        sellerGroups[sellerId].items.push({
          listing_id: item.listing_id,
          title: item.listings.title,
          price,
          quantity,
          selected_size: item.selected_size || null,
          shipping_cost: shippingCost,
          image_url: item.listings.images[0]?.image_url || null,
        });
        sellerGroups[sellerId].subtotal += price * quantity;
        sellerGroups[sellerId].shippingTotal = Math.max(sellerGroups[sellerId].shippingTotal, listingShipping);
        sellerGroups[sellerId].totalQuantity += quantity;
      }

      // Ensure all sellers have Connect accounts (auto-create if needed)
      for (const sellerId of Object.keys(sellerGroups)) {
        const seller = sellerGroups[sellerId].seller;

        if (!seller.stripe_connect_id) {
          console.log('[CART] Auto-creating Connect account for seller:', sellerId);

          try {
            const account = await stripe.accounts.create({
              type: 'express',
              country: 'GB',
              email: seller.email,
              capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
              },
              business_type: 'individual',
              business_profile: {
                mcc: '5699',
                product_description: 'Selling golf equipment on Mulligans',
              },
              settings: {
                payouts: {
                  schedule: {
                    delay_days: 'minimum',
                  },
                },
              },
              metadata: {
                user_id: sellerId,
                platform: 'mulligans',
                auto_created: 'true',
              },
            });

            await prisma.users.update({
              where: { id: sellerId },
              data: {
                stripe_connect_id: account.id,
                stripe_connect_status: 'pending',
                updated_at: new Date(),
              },
            });

            seller.stripe_connect_id = account.id;
            console.log('[CART] Connect account created:', account.id);
          } catch (error: any) {
            console.error('[CART] Failed to create Connect account for seller:', sellerId, error);
            return res.status(500).json({
              error: 'Failed to set up seller payments',
              details: error.message,
            });
          }
        }
      }

      // Calculate totals with quantity support
      const itemsTotal = cartItems.reduce(
        (sum, item) => sum + parseFloat(item.listings.price.toString()) * (item.quantity || 1),
        0
      );
      const shippingTotal = Object.values(sellerGroups).reduce(
        (sum, group) => sum + group.shippingTotal,
        0
      );
      const totalQuantity = cartItems.reduce(
        (sum, item) => sum + (item.quantity || 1),
        0
      );
      // ✅ FIXED: £0.99 fee applies PER ITEM, not per cart
const platformFee = itemsTotal * PLATFORM_FEE_PERCENT + (PLATFORM_FEE_FIXED * totalQuantity);
      const grandTotal = itemsTotal + shippingTotal + platformFee;

      const grandTotalPence = Math.round(grandTotal * 100);
      const platformFeePence = Math.round(platformFee * 100);
      const shippingTotalPence = Math.round(shippingTotal * 100);

      console.log('[CART] Cart checkout price breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        itemCount: cartItems.length,
        totalQuantity: totalQuantity,
        sellerCount: Object.keys(sellerGroups).length,
      });

      // Build line items for Stripe Checkout with quantities
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = cartItems.map(
        (item) => ({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: item.listings.title,
              description: `Sold by ${item.listings.users.display_name}`,
              images: item.listings.images[0]?.image_url
                ? [item.listings.images[0].image_url]
                : undefined,
            },
            unit_amount: Math.round(parseFloat(item.listings.price.toString()) * 100),
          },
          quantity: item.quantity || 1,
        })
      );

      // Add platform fee as a line item
      lineItems.push({
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Buyer Protection Fee',
            description: 'Secure payment processing and buyer protection',
          },
          unit_amount: platformFeePence,
        },
        quantity: 1,
      });

      // Add shipping as a line item (if there's any shipping cost)
      if (shippingTotalPence > 0) {
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Shipping',
              description: `Delivery for ${totalQuantity} item${totalQuantity > 1 ? 's' : ''}`,
            },
            unit_amount: shippingTotalPence,
          },
          quantity: 1,
        });
      }

      // Build listing quantities map for metadata
      const listingQuantities: Record<string, number> = {};
      for (const item of cartItems) {
        listingQuantities[item.listing_id] = item.quantity || 1;
      }

      // Create seller breakdown for metadata
      const sellerBreakdown = Object.entries(sellerGroups).map(([sellerId, data]) => ({
        seller_id: sellerId,
        seller_connect_id: data.seller?.stripe_connect_id || null,
        subtotal: data.subtotal,
        shipping_total: data.shippingTotal,
        cart_items: data.items.map((item: any) => ({
          listing_id: item.listing_id,
          quantity: item.quantity || 1,
          selected_size: item.selected_size || null,
        })),
        first_image: data.items[0]?.image_url || null,
      }));

      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: lineItems,
        shipping_address_collection: {
          allowed_countries: ['GB'],
        },
        metadata: {
          type: 'cart_checkout',
          buyer_id: userId,
          items_total: itemsTotal.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          item_count: cartItems.length.toString(),
          total_quantity: totalQuantity.toString(),
          // ✅ FIXED: Truncate listing_ids to stay under 500 char limit
          listing_ids: cartItems.map((item) => item.listing_id).join(',').substring(0, 490),
          // ✅ FIXED: Store quantities separately, truncated
          listing_quantities: JSON.stringify(listingQuantities).substring(0, 490),
          // ✅ FIXED: Simplified seller breakdown (just IDs and totals)
          seller_ids: Object.keys(sellerGroups).join(',').substring(0, 490),
          first_item_image: (cartItems[0]?.listings.images[0]?.image_url || '').substring(0, 490),
          escrow: 'true',
        },
        success_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-success?session_id={CHECKOUT_SESSION_ID}&type=cart`,
        cancel_url: `${process.env.FRONTEND_URL || 'mulligans://'}cart`,
      });

      console.log('[CART] Cart checkout session created:', session.id);

      res.json({
        sessionId: session.id,
        url: session.url,
        summary: {
          itemCount: cartItems.length,
          totalQuantity: totalQuantity,
          itemsTotal: itemsTotal.toFixed(2),
          shippingTotal: shippingTotal.toFixed(2),
          platformFee: platformFee.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
        },
      });
    } catch (error: any) {
      console.error('[CART] Cart checkout session error:', error);
      res.status(500).json({
        error: 'Failed to create checkout session',
        details: error.message,
      });
    }
  }

  /**
   * Fulfill Cart Order (called from webhook)
   * Creates separate orders for each seller
   */
  static async fulfillCartOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('[CART] Fulfilling cart order for session:', session.id);

      const metadata = session.metadata!;
      const buyerId = metadata.buyer_id;
      const listingIds = metadata.listing_ids.split(',');
      const listingQuantities = JSON.parse(metadata.listing_quantities || '{}');
      // ✅ Reconstruct seller breakdown from database instead of metadata
      const sellerIds = (metadata.seller_ids || '').split(',').filter(Boolean);
      const firstItemImage = metadata.first_item_image || null;

      // Fetch listings to reconstruct seller breakdown
      const listings = await prisma.listings.findMany({
        where: { id: { in: listingIds } },
        include: {
          images: {
            take: 1,
            orderBy: { display_order: 'asc' },
          },
          users: {
            select: {
              id: true,
              stripe_connect_id: true,
            },
          },
        },
      });

      // Build sellerBreakdown from fetched listings
      const sellerBreakdown: {
        seller_id: string;
        seller_connect_id: string | null;
        subtotal: number;
        shipping_total: number;
        cart_items: { listing_id: string; quantity: number; selected_size: string | null }[];
        first_image: string | null;
      }[] = [];

      // Group listings by seller
      const sellerMap: Record<string, typeof sellerBreakdown[0]> = {};
      
      for (const listing of listings) {
        const sellerId = listing.seller_id;
        const quantity = listingQuantities[listing.id] || 1;
        // Parse selected_size from metadata if stored, otherwise null
        const selectedSize = null; // Will be populated from cart_items if needed
        
        if (!sellerMap[sellerId]) {
          sellerMap[sellerId] = {
            seller_id: sellerId,
            seller_connect_id: listing.users?.stripe_connect_id || null,
            subtotal: 0,
            shipping_total: 0,
            cart_items: [],
            first_image: listing.images[0]?.image_url || null,
          };
        }
        
        const price = parseFloat(listing.price.toString());
        const shippingCost = parseFloat((listing as any).shipping_cost?.toString() || '0');
        
        sellerMap[sellerId].subtotal += price * quantity;
        sellerMap[sellerId].shipping_total = Math.max(
          sellerMap[sellerId].shipping_total,
          Math.ceil(quantity / 5) * shippingCost
        );
        sellerMap[sellerId].cart_items.push({
          listing_id: listing.id,
          quantity,
          selected_size: selectedSize,
        });
      }

      // Convert map to array
      for (const sellerId of Object.keys(sellerMap)) {
        sellerBreakdown.push(sellerMap[sellerId]);
      }
      const grandTotal = metadata.grand_total;
      const shippingTotal = metadata.shipping_total || '0';
      const totalQuantity = parseInt(metadata.total_quantity || '0');

      // Get shipping address from session
      const collectedInfo = (session as any).collected_information;
      const shippingDetails = collectedInfo?.shipping_details || (session as any).shipping_details;
      const shippingAddress = shippingDetails?.address;
      const shippingName = shippingDetails?.name;

      console.log('[CART] Shipping details:', { name: shippingName, address: shippingAddress });

      // Build shipping address JSON for storage
      const shippingAddressJson = shippingAddress ? {
        name: shippingName || '',
        line1: shippingAddress.line1 || '',
        line2: shippingAddress.line2 || null,
        city: shippingAddress.city || '',
        postal_code: shippingAddress.postal_code || '',
        country: shippingAddress.country || 'GB',
      } : null;

      // Check if orders already exist (idempotency)
      const existingOrders = await prisma.orders.findMany({
        where: {
          stripe_payment_intent_id: session.payment_intent as string,
        },
      });

      if (existingOrders.length > 0) {
        console.log('[CART] Orders already exist for this session');
        return;
      }

      // Get buyer info for email
      const buyer = await prisma.users.findUnique({
        where: { id: buyerId },
        select: {
          email: true,
          display_name: true,
        },
      });

      // Auto-cancel date (5 days)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      // Create orders for each seller
      const createdOrders: any[] = [];
      const orderItems: { name: string; price: string; quantity: number }[] = [];

      // Use transaction to ensure atomicity for stock updates
      await prisma.$transaction(async (tx) => {
        for (const sellerData of sellerBreakdown) {
          const { seller_id, seller_connect_id, subtotal, shipping_total, cart_items, first_image } = sellerData;
          
          for (const cartItem of (cart_items || [])) {
            const listingId = cartItem.listing_id;
            const orderQuantity = cartItem.quantity || 1;
            const selectedSize = cartItem.selected_size || null;

            // Get listing details
            const listing = await tx.listings.findUnique({
              where: { id: listingId },
              select: { 
                price: true, 
                shipping_cost: true,
                quantity: true,
                specifications: true,
                title: true,
                images: {
                  take: 1,
                  orderBy: { display_order: 'asc' },
                },
              },
            });

            if (!listing) continue;

            const itemPrice = parseFloat(listing.price.toString());
            const itemShippingCost = parseFloat((listing.shipping_cost || 0).toString());
            const listingImage = listing.images[0]?.image_url || null;
            
            const currentStock = getStockForSize(listing, selectedSize);
            const orderShipping = Math.ceil(orderQuantity / 5) * itemShippingCost;

            // Validate stock
            if (currentStock < orderQuantity) {
              console.error(`[CART] Insufficient stock for ${listingId}: requested ${orderQuantity}, available ${currentStock}`);
              throw new Error(`Insufficient stock for ${listing.title}`);
            }

            // Calculate new stock
            let newTotalStock: number;
            let updatedSpecs = listing.specifications;
            
            if (selectedSize && (listing.specifications as any)?.sizeQuantities) {
              updatedSpecs = decrementSizeStock(listing.specifications, selectedSize, orderQuantity);
              newTotalStock = getTotalStockFromSizes(updatedSpecs);
            } else {
              newTotalStock = listing.quantity - orderQuantity;
            }
            
            const shouldMarkSold = newTotalStock <= 0;

            // Add to email items list
            const sizeText = selectedSize ? ` (${selectedSize})` : '';
            orderItems.push({
              name: `${listing.title}${sizeText}`,
              price: `£${(itemPrice * orderQuantity).toFixed(2)}`,
              quantity: orderQuantity,
            });

            // Create order
            const order = await tx.orders.create({
              data: {
                id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                listing_id: listingId,
                buyer_id: buyerId,
                seller_id: seller_id,
                amount: itemPrice * orderQuantity,
                quantity: orderQuantity,
                selected_size: selectedSize,
                shipping_cost: orderShipping,
                seller_payout: (itemPrice * orderQuantity) + orderShipping,
                listing_title: listing.title,
                listing_image: listingImage,
                listing_price: itemPrice,
                currency: 'GBP',
                stripe_payment_intent_id: session.payment_intent as string,
                status: 'to_ship',
                paid_at: new Date(),
                auto_cancel_at: autoCancelAt,
                shipping_address: shippingAddressJson ?? Prisma.JsonNull,
                updated_at: new Date(),
              },
            });

            createdOrders.push({ ...order, image_url: listingImage, title: listing.title, quantity: orderQuantity });
            console.log(`[CART] Order created: ${order.id} for listing: ${listingId} (qty: ${orderQuantity})`);

            // Update listing stock
            await tx.listings.update({
              where: { id: listingId },
              data: { 
                quantity: Math.max(0, newTotalStock),
                specifications: updatedSpecs ?? undefined,
                status: shouldMarkSold ? 'sold' : 'active',
                updated_at: new Date() 
              },
            });
          }
        }

        // Remove items from cart
        await tx.cart_items.deleteMany({
          where: {
            user_id: buyerId,
            listing_id: { in: listingIds },
          },
        });
      });

      // Process seller notifications (outside transaction)
      for (const sellerData of sellerBreakdown) {
        const { seller_id, seller_connect_id, subtotal, shipping_total, cart_items, first_image } = sellerData;
        const listing_ids = (cart_items || []).map((item: any) => item.listing_id);

        const sellerSubtotal = subtotal;
        const sellerShipping = shipping_total || 0;
        console.log('[CART] Seller payout scheduled (after escrow):', {
          seller_id,
          subtotal: sellerSubtotal.toFixed(2),
          shipping: sellerShipping.toFixed(2),
          totalPayout: (sellerSubtotal + sellerShipping).toFixed(2),
        });

        // Get first listing image for this seller's notification
        const sellerFirstImage = first_image || createdOrders.find(o => o.image_url)?.image_url || null;

        // Notify seller
        const sellerUser = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { stripe_connect_status: true },
        });

        const needsVerification = sellerUser?.stripe_connect_status !== 'active';

        // Calculate total quantity for this seller
        const sellerTotalQty = createdOrders
          .filter((o: any) => listing_ids.includes(o.listing_id))
          .reduce((sum: number, o: any) => sum + (o.quantity || 1), 0);
        const qtyText = sellerTotalQty > 1 ? ` (${sellerTotalQty} items)` : '';

        if (needsVerification) {
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'payout',
              title: 'Congratulations on your sale!',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal.toFixed(2)}. Add your bank details to receive payment after delivery.`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });

          // PUSH: Notify seller (needs verification)
          try {
            await sendPushNotification(
              seller_id,
              'Congratulations on your sale!',
              `You sold ${listing_ids.length} item(s) for £${subtotal}. Add bank details to get paid.`,
              { type: 'sale', order_id: createdOrders[0]?.id }
            );
          } catch (pushErr) {
            console.error('[CART] Push to seller failed:', pushErr);
          }
        } else {
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'sale',
              title: 'Item Sold!',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal}. Ship within ${SHIPPING_DEADLINE_DAYS} days. Payment released after delivery confirmed.`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });

          // PUSH: Notify seller
          try {
            await sendPushNotification(
              seller_id,
              'Item Sold!',
              `You sold ${listing_ids.length} item(s) for £${subtotal}. Ship within ${SHIPPING_DEADLINE_DAYS} days.`,
              { type: 'sale', order_id: createdOrders[0]?.id }
            );
          } catch (pushErr) {
            console.error('[CART] Push to seller failed:', pushErr);
          }
        }

        // Send sale notification EMAIL to seller
        const sellerEmailRecord = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { email: true },
        });
        
        if (sellerEmailRecord?.email) {
          try {
            const shippingAddr = shippingAddressJson 
              ? `${shippingAddressJson.name}<br>${shippingAddressJson.line1}${shippingAddressJson.line2 ? '<br>' + shippingAddressJson.line2 : ''}<br>${shippingAddressJson.city}<br>${shippingAddressJson.postal_code}`
              : 'See app for details';
            
            await sendSaleNotification(sellerEmailRecord.email, {
              itemTitle: listing_ids.length === 1 ? createdOrders[0]?.title : `${listing_ids.length} items`,
              salePrice: subtotal.toFixed(2),
              orderNumber: createdOrders[0]?.id || 'N/A',
              buyerName: buyer?.display_name || 'Buyer',
              shippingAddress: shippingAddr,
            });
            console.log('[CART] Sale notification email sent to seller:', sellerEmailRecord.email);
          } catch (emailError) {
            console.error('[CART] Failed to send sale notification email:', emailError);
          }
        }
      }

      // Get first item image for buyer notification
      const buyerNotificationImage = firstItemImage || createdOrders[0]?.image_url || null;

      // Calculate total items including quantities
      const totalItems = totalQuantity || createdOrders.reduce((sum, o) => sum + (o.quantity || 1), 0);
      const itemText = totalItems === 1 ? '1 item' : `${totalItems} items`;

      // Notify buyer with image
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyerId,
          type: 'order',
          title: 'Payment Successful!',
          message: `Your order of ${itemText} has been confirmed. Sellers will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: buyerNotificationImage,
          related_id: createdOrders[0]?.id,
        },
      });

      // PUSH: Notify buyer
      try {
        await sendPushNotification(
          buyerId,
          'Payment Successful!',
          `Your order of ${itemText} is confirmed. Sellers will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          { type: 'order', order_id: createdOrders[0]?.id }
        );
      } catch (pushErr) {
        console.error('[CART] Push to buyer failed:', pushErr);
      }

      // Send order confirmation email to buyer
      if (buyer?.email) {
        try {
          const formattedAddress = shippingAddressJson 
            ? `${shippingAddressJson.name}\n${shippingAddressJson.line1}${shippingAddressJson.line2 ? '\n' + shippingAddressJson.line2 : ''}\n${shippingAddressJson.city}\n${shippingAddressJson.postal_code}`
            : 'Address not available';

          const itemsListHtml = orderItems.map(item => 
            `<tr><td style="padding: 8px; border-bottom: 1px solid #E5E7EB;">${item.name}${item.quantity > 1 ? ` (x${item.quantity})` : ''}</td><td style="padding: 8px; border-bottom: 1px solid #E5E7EB; text-align: right;">${item.price}</td></tr>`
          ).join('');

          await sendOrderConfirmation(buyer.email, {
            buyerName: buyer.display_name || 'there',
            orderId: createdOrders[0]?.id || session.id,
            itemsList: itemsListHtml,
            totalAmount: `£${grandTotal}`,
            shippingAddress: formattedAddress.replace(/\n/g, '<br>'),
          });
          
          console.log('[CART] Order confirmation email sent to:', buyer.email);
        } catch (emailError) {
          console.error('[CART] Failed to send order confirmation email:', emailError);
        }
      }

      console.log('[CART] Cart order fulfilled successfully');
      console.log(`[CART] Orders created: ${createdOrders.length}, Total items: ${totalItems}`);
    } catch (error) {
      console.error('[CART] Error fulfilling cart order:', error);
      throw error;
    }
  }
}