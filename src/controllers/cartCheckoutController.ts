// src/controllers/cartCheckoutController.ts
// Handles checkout for cart with multiple items (potentially from multiple sellers)
// ✅ ESCROW UPDATE: Removed immediate transfers - funds held until escrow releases
// ✅ ESCROW UPDATE: Shipping deadline changed from 7 to 5 days
// ✅ FIXED: Now includes image_url in notifications
// ✅ UPDATED: Sends order confirmation email to buyer
// ✅ QUANTITY UPDATE: Now handles quantities in cart items

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { sendOrderConfirmation, sendSaleNotification } from '../services/emailService';

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
const PLATFORM_FEE_PERCENT = 0.07; // 7%
const PLATFORM_FEE_FIXED = 0.99; // £0.99

// ✅ Escrow constants
const SHIPPING_DEADLINE_DAYS = 5;

export class CartCheckoutController {
  /**
   * Create Stripe Checkout Session for Cart
   * POST /api/stripe/create-cart-checkout
   * 
   * This creates a single checkout session for all cart items.
   * After payment, separate orders are created for each seller.
   * ✅ ESCROW: Funds held in platform account until delivery confirmed
   * ✅ QUANTITY: Now includes quantities in calculations
   */
  static async createCartCheckoutSession(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      console.log('🛒 Creating cart checkout session for user:', userId);

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
        // Remove unavailable items from cart
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

      // ✅ QUANTITY: Validate quantities don't exceed stock
      const overStockItems = cartItems.filter(
        (item) => (item.quantity || 1) > item.listings.quantity
      );

      if (overStockItems.length > 0) {
        return res.status(400).json({
          error: 'Some items exceed available stock',
          over_stock: overStockItems.map((item) => ({
            listing_id: item.listing_id,
            title: item.listings.title,
            requested: item.quantity || 1,
            available: item.listings.quantity,
          })),
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
      // ✅ QUANTITY: Now includes totalQuantity per seller
      const sellerGroups: {
        [sellerId: string]: {
          seller: any;
          items: any[];
          subtotal: number;
          shippingTotal: number;
          totalQuantity: number;  // ✅ NEW
        };
      } = {};

      for (const item of cartItems) {
        const sellerId = item.listings.seller_id;
        const seller = item.listings.users;
        const quantity = item.quantity || 1;  // ✅ Get quantity from cart item

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = {
            seller,
            items: [],
            subtotal: 0,
            shippingTotal: 0,
            totalQuantity: 0,  // ✅ NEW
          };
        }

        const price = parseFloat(item.listings.price.toString());
        const shippingCost = parseFloat((item.listings as any).shipping_cost?.toString() || '0');
        
        // ✅ SHIPPING LOGIC: Every 5 items = 1 shipping charge
        const listingShipping = Math.ceil(quantity / 5) * shippingCost;
        
        sellerGroups[sellerId].items.push({
          listing_id: item.listing_id,
          title: item.listings.title,
          price,
          quantity,  // ✅ NEW
          shipping_cost: shippingCost,
          image_url: item.listings.images[0]?.image_url || null,
        });
        sellerGroups[sellerId].subtotal += price * quantity;  // ✅ Multiply by quantity
        // ✅ SHIPPING: Take MAX shipping per seller (not sum)
        sellerGroups[sellerId].shippingTotal = Math.max(sellerGroups[sellerId].shippingTotal, listingShipping);
        sellerGroups[sellerId].totalQuantity += quantity;  // ✅ NEW
      }

      // Ensure all sellers have Connect accounts (auto-create if needed)
      // (Sellers still need Connect accounts for future payout after escrow)
      for (const sellerId of Object.keys(sellerGroups)) {
        const seller = sellerGroups[sellerId].seller;

        if (!seller.stripe_connect_id) {
          console.log('🔗 Auto-creating Connect account for seller:', sellerId);

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

            // Update database
            await prisma.users.update({
              where: { id: sellerId },
              data: {
                stripe_connect_id: account.id,
                stripe_connect_status: 'pending',
                updated_at: new Date(),
              },
            });

            seller.stripe_connect_id = account.id;
            console.log('✅ Connect account created:', account.id);
          } catch (error: any) {
            console.error('❌ Failed to create Connect account for seller:', sellerId, error);
            return res.status(500).json({
              error: 'Failed to set up seller payments',
              details: error.message,
            });
          }
        }
      }

      // ✅ QUANTITY: Calculate totals with quantity support
      const itemsTotal = cartItems.reduce(
        (sum, item) => sum + parseFloat(item.listings.price.toString()) * (item.quantity || 1),
        0
      );
      // ✅ SHIPPING: Sum each seller's MAX shipping (already calculated with ceil(qty/5) logic)
      const shippingTotal = Object.values(sellerGroups).reduce(
        (sum, group) => sum + group.shippingTotal,
        0
      );
      const totalQuantity = cartItems.reduce(
        (sum, item) => sum + (item.quantity || 1),
        0
      );
      const platformFee = itemsTotal * PLATFORM_FEE_PERCENT + PLATFORM_FEE_FIXED;
      const grandTotal = itemsTotal + shippingTotal + platformFee;

      const grandTotalPence = Math.round(grandTotal * 100);
      const platformFeePence = Math.round(platformFee * 100);
      const shippingTotalPence = Math.round(shippingTotal * 100);

      console.log('💰 Cart checkout price breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        itemCount: cartItems.length,
        totalQuantity: totalQuantity,  // ✅ NEW
        sellerCount: Object.keys(sellerGroups).length,
        escrowNote: 'Funds held until delivery confirmed',
      });

      // ✅ QUANTITY: Build line items for Stripe Checkout with quantities
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
          quantity: item.quantity || 1,  // ✅ Use cart item quantity
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
              description: `Delivery for ${totalQuantity} item${totalQuantity > 1 ? 's' : ''}`,  // ✅ Use totalQuantity
            },
            unit_amount: shippingTotalPence,
          },
          quantity: 1,
        });
      }

      // ✅ QUANTITY: Build listing quantities map for metadata
      const listingQuantities: Record<string, number> = {};
      for (const item of cartItems) {
        listingQuantities[item.listing_id] = item.quantity || 1;
      }

      // Create seller breakdown for metadata (including images for notifications)
      // ✅ QUANTITY: Now includes item_quantities
      const sellerBreakdown = Object.entries(sellerGroups).map(([sellerId, data]) => ({
        seller_id: sellerId,
        seller_connect_id: data.seller.stripe_connect_id,
        subtotal: data.subtotal.toFixed(2),
        shipping_total: data.shippingTotal.toFixed(2),
        total_quantity: data.totalQuantity,  // ✅ NEW
        listing_ids: data.items.map((item: any) => item.listing_id),
        item_quantities: data.items.reduce((acc: any, item: any) => {  // ✅ NEW
          acc[item.listing_id] = item.quantity;
          return acc;
        }, {}),
        first_image: data.items[0]?.image_url || null,
      }));

      // ✅ ESCROW: Create Stripe Checkout Session (funds stay in platform account)
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: lineItems,
        shipping_address_collection: {
          allowed_countries: ['GB'], // UK only for now
        },
        metadata: {
          type: 'cart_checkout',
          buyer_id: userId,
          items_total: itemsTotal.toFixed(2),
          shipping_total: shippingTotal.toFixed(2),
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          item_count: cartItems.length.toString(),
          total_quantity: totalQuantity.toString(),  // ✅ NEW
          listing_ids: cartItems.map((item) => item.listing_id).join(','),
          listing_quantities: JSON.stringify(listingQuantities),  // ✅ NEW
          seller_breakdown: JSON.stringify(sellerBreakdown),
          first_item_image: cartItems[0]?.listings.images[0]?.image_url || '',
          escrow: 'true', // ✅ Flag that this uses escrow
        },
        success_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-success?session_id={CHECKOUT_SESSION_ID}&type=cart`,
        cancel_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-cancelled`,
      });

      console.log('✅ Cart checkout session created:', session.id);
      console.log('📦 Listings:', cartItems.map((item) => `${item.listing_id} (x${item.quantity || 1})`));  // ✅ Show quantities
      console.log('👥 Sellers:', Object.keys(sellerGroups));
      console.log('🔒 Funds will be held in escrow until delivery + 5 days');

      res.json({
        sessionId: session.id,
        url: session.url,
        summary: {
          itemCount: cartItems.length,
          totalQuantity: totalQuantity,  // ✅ NEW
          itemsTotal: itemsTotal.toFixed(2),
          shippingTotal: shippingTotal.toFixed(2),
          platformFee: platformFee.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
        },
      });
    } catch (error: any) {
      console.error('❌ Cart checkout session error:', error);
      res.status(500).json({
        error: 'Failed to create checkout session',
        details: error.message,
      });
    }
  }

  /**
   * Fulfill Cart Order (called from webhook)
   * Creates separate orders for each seller
   * ✅ ESCROW UPDATE: No longer transfers immediately - funds held in escrow
   * ✅ QUANTITY UPDATE: Now handles quantities and reduces stock
   */
  static async fulfillCartOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('📦 Fulfilling cart order for session:', session.id);

      const metadata = session.metadata!;
      const buyerId = metadata.buyer_id;
      const listingIds = metadata.listing_ids.split(',');
      const listingQuantities = JSON.parse(metadata.listing_quantities || '{}');  // ✅ NEW: Get quantities
      const sellerBreakdown = JSON.parse(metadata.seller_breakdown);
      const firstItemImage = metadata.first_item_image || null;
      const grandTotal = metadata.grand_total;
      const shippingTotal = metadata.shipping_total || '0';
      const totalQuantity = parseInt(metadata.total_quantity || '0');  // ✅ NEW

      // Get shipping address from session
      const collectedInfo = (session as any).collected_information;
      const shippingDetails = collectedInfo?.shipping_details || (session as any).shipping_details;
      const shippingAddress = shippingDetails?.address;
      const shippingName = shippingDetails?.name;

      console.log('📍 Shipping details:', { name: shippingName, address: shippingAddress });

      // Build shipping address JSON for storage
      const shippingAddressJson = shippingAddress ? {
        name: shippingName || '',
        line1: shippingAddress.line1 || '',
        line2: shippingAddress.line2 || null,
        city: shippingAddress.city || '',
        postal_code: shippingAddress.postal_code || '',
        country: shippingAddress.country || 'GB',
      } : null;

      console.log('📦 Shipping address JSON:', shippingAddressJson);

      // Check if orders already exist (idempotency)
      const existingOrders = await prisma.orders.findMany({
        where: {
          listing_id: { in: listingIds },
          buyer_id: buyerId,
        },
      });

      if (existingOrders.length > 0) {
        console.log('⚠️ Orders already exist for this session');
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

      // ✅ ESCROW: Auto-cancel date (5 days, not 7)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + SHIPPING_DEADLINE_DAYS);

      // Create orders for each seller
      const createdOrders: any[] = [];
      const orderItems: { name: string; price: string; quantity: number }[] = [];  // ✅ Added quantity

      // ✅ QUANTITY: Use transaction to ensure atomicity for stock updates
      await prisma.$transaction(async (tx) => {
        for (const sellerData of sellerBreakdown) {
          const { seller_id, seller_connect_id, subtotal, shipping_total, listing_ids, first_image, item_quantities } = sellerData;

          for (const listingId of listing_ids) {
            // ✅ Get quantity for this listing
            const orderQuantity = listingQuantities[listingId] || item_quantities?.[listingId] || 1;

            // Get listing price, shipping cost, stock and image
            const listing = await tx.listings.findUnique({
              where: { id: listingId },
              select: { 
                price: true, 
                shipping_cost: true,
                quantity: true,  // ✅ NEW: Get current stock
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
            const currentStock = listing.quantity;
            
            // ✅ SHIPPING LOGIC: Every 5 items = 1 shipping charge
            const orderShipping = Math.ceil(orderQuantity / 5) * itemShippingCost;

            // ✅ Validate stock one more time
            if (currentStock < orderQuantity) {
              console.error(`❌ Insufficient stock for ${listingId}: requested ${orderQuantity}, available ${currentStock}`);
              throw new Error(`Insufficient stock for ${listing.title}`);
            }

            // ✅ Calculate new stock
            const newStock = currentStock - orderQuantity;
            const shouldMarkSold = newStock <= 0;

            // Add to email items list
            orderItems.push({
              name: listing.title,
              price: `£${(itemPrice * orderQuantity).toFixed(2)}`,  // ✅ Total for quantity
              quantity: orderQuantity,  // ✅ NEW
            });

            // ✅ ESCROW: Create order - seller_payout stored but NOT transferred yet
            // ✅ QUANTITY: Now includes quantity and calculates totals
            const order = await tx.orders.create({
              data: {
                id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                listing_id: listingId,
                buyer_id: buyerId,
                seller_id: seller_id,
                amount: itemPrice * orderQuantity,  // ✅ Total for quantity
                quantity: orderQuantity,  // ✅ NEW: Store quantity
                shipping_cost: orderShipping,  // ✅ Uses ceil(qty/5) formula
                seller_payout: (itemPrice * orderQuantity) + orderShipping, // ✅ Total payout
                currency: 'GBP',
                stripe_payment_intent_id: session.payment_intent as string,
                status: 'to_ship',
                paid_at: new Date(),
                auto_cancel_at: autoCancelAt, // ✅ 5 days to ship
                shipping_address: shippingAddressJson ?? Prisma.JsonNull,
                updated_at: new Date(),
              },
            });

            createdOrders.push({ ...order, image_url: listingImage, title: listing.title, quantity: orderQuantity });
            console.log(`✅ Order created: ${order.id} for listing: ${listingId} (qty: ${orderQuantity})`);
            console.log('📍 With shipping address:', shippingAddressJson ? 'YES' : 'NO');
            console.log(`🔒 Seller payout stored: £${((itemPrice * orderQuantity) + orderShipping).toFixed(2)} (held in escrow)`);

            // ✅ QUANTITY: Update listing stock and status
            await tx.listings.update({
              where: { id: listingId },
              data: { 
                quantity: Math.max(0, newStock),
                status: shouldMarkSold ? 'sold' : 'active',  // ✅ Only mark sold if out of stock
                updated_at: new Date() 
              },
            });

            console.log(`📊 Stock updated: ${currentStock} → ${newStock}${shouldMarkSold ? ' (SOLD OUT)' : ''}`);
          }
        }

        // Remove items from cart (inside transaction)
        await tx.cart_items.deleteMany({
          where: {
            user_id: buyerId,
            listing_id: { in: listingIds },
          },
        });
      });

      // Process seller notifications (outside transaction)
      for (const sellerData of sellerBreakdown) {
        const { seller_id, seller_connect_id, subtotal, shipping_total, listing_ids, first_image } = sellerData;

        // ✅ ESCROW: REMOVED immediate transfer to seller
        // Previously this code transferred funds immediately:
        // const transfer = await stripe.transfers.create({
        //   amount: transferAmount,
        //   currency: 'gbp',
        //   destination: seller_connect_id,
        //   ...
        // });
        // 
        // Now funds are held in platform account until escrow releases
        // (handled by escrowService.ts autoReleaseEscrow job)

        const sellerSubtotal = parseFloat(subtotal);
        const sellerShipping = parseFloat(shipping_total || '0');
        console.log('💰 Seller payout scheduled (after escrow):', {
          seller_id,
          subtotal: sellerSubtotal.toFixed(2),
          shipping: sellerShipping.toFixed(2),
          totalPayout: (sellerSubtotal + sellerShipping).toFixed(2),
          releaseCondition: 'After delivery + 5 days OR buyer confirms receipt',
        });

        // Get first listing image for this seller's notification
        const sellerFirstImage = first_image || createdOrders.find(o => o.image_url)?.image_url || null;

        // Notify seller
        const sellerUser = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { stripe_connect_status: true },
        });

        const needsVerification = sellerUser?.stripe_connect_status !== 'active';

        // ✅ Calculate total quantity for this seller
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
              title: 'Congratulations on your sale! 🎉',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal}. Add your bank details to receive payment after delivery.`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });
          console.log('📬 Seller notification created with image:', sellerFirstImage ? 'YES' : 'NO');
       } else {
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'sale',
              title: 'Item Sold! 🎉',
              message: `You sold ${listing_ids.length} listing(s)${qtyText} for £${subtotal}. Ship within ${SHIPPING_DEADLINE_DAYS} days. Payment released after delivery confirmed.`,
              image_url: sellerFirstImage,
              related_id: createdOrders[0]?.id,
            },
          });
          console.log('📬 Seller notification created with image:', sellerFirstImage ? 'YES' : 'NO');
        }

        // ✅ Send sale notification EMAIL to seller
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
              salePrice: subtotal,
              orderNumber: createdOrders[0]?.id || 'N/A',
              buyerName: buyer?.display_name || 'Buyer',
              shippingAddress: shippingAddr,
            });
            console.log('📧 Sale notification email sent to seller:', sellerEmailRecord.email);
          } catch (emailError) {
            console.error('⚠️ Failed to send sale notification email:', emailError);
          }
        }
      }

      // Get first item image for buyer notification

      // Get first item image for buyer notification
      const buyerNotificationImage = firstItemImage || createdOrders[0]?.image_url || null;

      // ✅ Calculate total items including quantities
      const totalItems = totalQuantity || createdOrders.reduce((sum, o) => sum + (o.quantity || 1), 0);
      const itemText = totalItems === 1 ? '1 item' : `${totalItems} items`;

      // Notify buyer with image
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyerId,
          type: 'order',
          title: 'Payment Successful! 🎉',
          message: `Your order of ${itemText} has been confirmed. Sellers will ship within ${SHIPPING_DEADLINE_DAYS} days.`,
          image_url: buyerNotificationImage,
          related_id: createdOrders[0]?.id,
        },
      });
      console.log('📬 Buyer notification created with image:', buyerNotificationImage ? 'YES' : 'NO');

      // Send order confirmation email to buyer
      if (buyer?.email) {
        try {
          // Format shipping address for email
          const formattedAddress = shippingAddressJson 
            ? `${shippingAddressJson.name}\n${shippingAddressJson.line1}${shippingAddressJson.line2 ? '\n' + shippingAddressJson.line2 : ''}\n${shippingAddressJson.city}\n${shippingAddressJson.postal_code}`
            : 'Address not available';

          // ✅ Format items with quantities for email
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
          
          console.log('📧 Order confirmation email sent to:', buyer.email);
        } catch (emailError) {
          console.error('⚠️ Failed to send order confirmation email:', emailError);
          // Don't fail the order if email fails
        }
      }

      console.log('✅ Cart order fulfilled successfully (escrow mode with quantity support)');
     console.log(`📦 Orders created: ${createdOrders.length}, Total items: ${totalItems}`);
console.log(`⏰ Auto-cancel if not shipped by: ${autoCancelAt.toISOString()}`);
    } catch (error) {
      console.error('❌ Error fulfilling cart order:', error);
      throw error;
    }
  }
}