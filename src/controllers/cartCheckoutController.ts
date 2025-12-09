// src/controllers/cartCheckoutController.ts
// Handles checkout for cart with multiple items (potentially from multiple sellers)
// UPDATED: Now saves shipping address from Stripe checkout
// ✅ FIXED: Now includes image_url in notifications
// ✅ UPDATED: Sends order confirmation email to buyer

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient, Prisma } from '@prisma/client';
import { sendOrderConfirmation } from '../services/emailService';

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

export class CartCheckoutController {
  /**
   * Create Stripe Checkout Session for Cart
   * POST /api/stripe/create-cart-checkout
   * 
   * This creates a single checkout session for all cart items.
   * After payment, separate orders are created for each seller.
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
          shippingTotal: number;  // ✅ ADDED
        };
      } = {};

      for (const item of cartItems) {
        const sellerId = item.listings.seller_id;
        const seller = item.listings.users;

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = {
            seller,
            items: [],
            subtotal: 0,
            shippingTotal: 0,  // ✅ ADDED: Track shipping per seller
          };
        }

        const price = parseFloat(item.listings.price.toString());
        const shippingCost = parseFloat((item.listings as any).shipping_cost?.toString() || '0');  // ✅ ADDED
        
        sellerGroups[sellerId].items.push({
          listing_id: item.listing_id,
          title: item.listings.title,
          price,
          shipping_cost: shippingCost,  // ✅ ADDED
          image_url: item.listings.images[0]?.image_url || null,
        });
        sellerGroups[sellerId].subtotal += price;
        sellerGroups[sellerId].shippingTotal += shippingCost;  // ✅ ADDED
      }

      // Ensure all sellers have Connect accounts (auto-create if needed)
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

      // Calculate totals - ✅ FIXED: Now includes shipping
      const itemsTotal = cartItems.reduce(
        (sum, item) => sum + parseFloat(item.listings.price.toString()),
        0
      );
      const shippingTotal = cartItems.reduce(
        (sum, item) => sum + parseFloat((item.listings as any).shipping_cost?.toString() || '0'),
        0
      );
      const platformFee = itemsTotal * PLATFORM_FEE_PERCENT + PLATFORM_FEE_FIXED;
      const grandTotal = itemsTotal + shippingTotal + platformFee;  // ✅ FIXED: Include shipping

      const grandTotalPence = Math.round(grandTotal * 100);
      const platformFeePence = Math.round(platformFee * 100);
      const shippingTotalPence = Math.round(shippingTotal * 100);

      console.log('💰 Cart checkout price breakdown:', {
        itemsTotal: itemsTotal.toFixed(2),
        shippingTotal: shippingTotal.toFixed(2),  // ✅ ADDED
        platformFee: platformFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        itemCount: cartItems.length,
        sellerCount: Object.keys(sellerGroups).length,
      });

      // Build line items for Stripe Checkout
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
          quantity: 1,
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

      // ✅ ADDED: Add shipping as a line item (if there's any shipping cost)
      if (shippingTotalPence > 0) {
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Shipping',
              description: `Delivery for ${cartItems.length} item${cartItems.length > 1 ? 's' : ''}`,
            },
            unit_amount: shippingTotalPence,
          },
          quantity: 1,
        });
      }

      // Create seller breakdown for metadata (including images for notifications)
      // ✅ FIXED: Now includes shipping costs
      const sellerBreakdown = Object.entries(sellerGroups).map(([sellerId, data]) => ({
        seller_id: sellerId,
        seller_connect_id: data.seller.stripe_connect_id,
        subtotal: data.subtotal.toFixed(2),
        shipping_total: data.shippingTotal.toFixed(2),  // ✅ ADDED
        listing_ids: data.items.map((item: any) => item.listing_id),
        // ✅ Include first item's image for notification
        first_image: data.items[0]?.image_url || null,
      }));

      // Create Stripe Checkout Session
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
          shipping_total: shippingTotal.toFixed(2),  // ✅ ADDED
          platform_fee: platformFee.toFixed(2),
          grand_total: grandTotal.toFixed(2),
          item_count: cartItems.length.toString(),
          listing_ids: cartItems.map((item) => item.listing_id).join(','),
          seller_breakdown: JSON.stringify(sellerBreakdown),
          // ✅ Store first item image for buyer notification
          first_item_image: cartItems[0]?.listings.images[0]?.image_url || '',
        },
        success_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-success?session_id={CHECKOUT_SESSION_ID}&type=cart`,
        cancel_url: `${process.env.FRONTEND_URL || 'mulligans://'}payment-cancelled`,
      });

      console.log('✅ Cart checkout session created:', session.id);
      console.log('📦 Listings:', cartItems.map((item) => item.listing_id));
      console.log('👥 Sellers:', Object.keys(sellerGroups));

      res.json({
        sessionId: session.id,
        url: session.url,
        summary: {
          itemCount: cartItems.length,
          itemsTotal: itemsTotal.toFixed(2),
          shippingTotal: shippingTotal.toFixed(2),  // ✅ ADDED
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
   * ✅ UPDATED: Now includes image_url in notifications
   * ✅ UPDATED: Sends order confirmation email to buyer
   */
  static async fulfillCartOrder(session: Stripe.Checkout.Session) {
    try {
      console.log('📦 Fulfilling cart order for session:', session.id);

      const metadata = session.metadata!;
      const buyerId = metadata.buyer_id;
      const listingIds = metadata.listing_ids.split(',');
      const sellerBreakdown = JSON.parse(metadata.seller_breakdown);
      const firstItemImage = metadata.first_item_image || null; // ✅ For buyer notification
      const grandTotal = metadata.grand_total;
      const shippingTotal = metadata.shipping_total || '0';

      // Get shipping address from session
      // Note: In newer Stripe API versions, shipping is in collected_information.shipping_details
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

      // ✅ Get buyer info for email
      const buyer = await prisma.users.findUnique({
        where: { id: buyerId },
        select: {
          email: true,
          display_name: true,
        },
      });

      // Auto-cancel date (7 days from now)
      const autoCancelAt = new Date();
      autoCancelAt.setDate(autoCancelAt.getDate() + 7);

      // Create orders for each seller
      const createdOrders: any[] = [];
      const orderItems: { name: string; price: string }[] = []; // ✅ For email

      for (const sellerData of sellerBreakdown) {
        const { seller_id, seller_connect_id, subtotal, shipping_total, listing_ids, first_image } = sellerData;  // ✅ Added shipping_total

        for (const listingId of listing_ids) {
          // Get listing price, shipping cost and image
          const listing = await prisma.listings.findUnique({
            where: { id: listingId },
            select: { 
              price: true, 
              shipping_cost: true,  // ✅ ADDED
              title: true,
              images: {
                take: 1,
                orderBy: { display_order: 'asc' },
              },
            },
          });

          if (!listing) continue;

          const itemPrice = parseFloat(listing.price.toString());
          const itemShippingCost = parseFloat((listing.shipping_cost || 0).toString());  // ✅ ADDED
          const listingImage = listing.images[0]?.image_url || null;

          // ✅ Add to email items list
          orderItems.push({
            name: listing.title,
            price: `£${itemPrice.toFixed(2)}`,
          });

          // Create order with shipping address and shipping cost
          const order = await prisma.orders.create({
            data: {
              id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              listing_id: listingId,
              buyer_id: buyerId,
              seller_id: seller_id,
              amount: itemPrice,
              shipping_cost: itemShippingCost,  // ✅ ADDED: Store shipping cost on order
              seller_payout: itemPrice + itemShippingCost,  // ✅ FIXED: Seller gets item + shipping
              currency: 'GBP',
              stripe_payment_intent_id: session.payment_intent as string,
              status: 'to_ship',
              paid_at: new Date(),
              auto_cancel_at: autoCancelAt,
              // Save shipping address as JSON (use Prisma.JsonNull for null values)
              shipping_address: shippingAddressJson ?? Prisma.JsonNull,
              updated_at: new Date(),
            },
          });

          createdOrders.push({ ...order, image_url: listingImage, title: listing.title });
          console.log('✅ Order created:', order.id, 'for listing:', listingId);
          console.log('📍 With shipping address:', shippingAddressJson ? 'YES' : 'NO');

          // Update listing status to sold
          await prisma.listings.update({
            where: { id: listingId },
            data: { status: 'sold', updated_at: new Date() },
          });
        }

        // Create transfer to seller's Connect account
        // ✅ FIXED: Transfer includes item subtotal + shipping (seller gets both)
        const sellerSubtotal = parseFloat(subtotal);
        const sellerShipping = parseFloat(shipping_total || '0');
        const transferAmount = Math.round((sellerSubtotal + sellerShipping) * 100);

        console.log('💰 Seller transfer breakdown:', {
          seller_id,
          subtotal: sellerSubtotal.toFixed(2),
          shipping: sellerShipping.toFixed(2),
          totalTransfer: ((sellerSubtotal + sellerShipping)).toFixed(2),
        });

        try {
          const transfer = await stripe.transfers.create({
            amount: transferAmount,
            currency: 'gbp',
            destination: seller_connect_id,
            transfer_group: session.id,
            metadata: {
              session_id: session.id,
              seller_id: seller_id,
              listing_ids: listing_ids.join(','),
              subtotal: subtotal,
              shipping: shipping_total || '0',
            },
          });

          console.log('💸 Transfer created:', transfer.id, 'to:', seller_connect_id, 'amount:', transferAmount);
        } catch (transferError: any) {
          console.error('❌ Transfer failed for seller:', seller_id, transferError.message);
          // Don't fail the whole order - the money is in our account and can be transferred manually
        }

        // ✅ Get first listing image for this seller's notification
        const sellerFirstImage = first_image || createdOrders.find(o => o.image_url)?.image_url || null;

        // Notify seller
        const sellerUser = await prisma.users.findUnique({
          where: { id: seller_id },
          select: { stripe_connect_status: true },
        });

        const needsVerification = sellerUser?.stripe_connect_status !== 'active';

        if (needsVerification) {
          // ✅ Include image_url in notification
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'payout',
              title: 'Congratulations on your sale! 🎉',
              message: `You sold ${listing_ids.length} item(s) for £${subtotal}. Add your bank details to withdraw your earnings.`,
              image_url: sellerFirstImage, // ✅ NEW
              related_id: createdOrders[0]?.id,
            },
          });
          console.log('📬 Seller notification created with image:', sellerFirstImage ? 'YES' : 'NO');
        } else {
          // ✅ Include image_url in notification
          await prisma.notifications.create({
            data: {
              id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_id: seller_id,
              type: 'sale',
              title: 'Item Sold! 🎉',
              message: `You sold ${listing_ids.length} item(s) for £${subtotal}. Please ship within 7 days.`,
              image_url: sellerFirstImage, // ✅ NEW
              related_id: createdOrders[0]?.id,
            },
          });
          console.log('📬 Seller notification created with image:', sellerFirstImage ? 'YES' : 'NO');
        }
      }

      // Remove items from cart
      await prisma.cart_items.deleteMany({
        where: {
          user_id: buyerId,
          listing_id: { in: listingIds },
        },
      });

      // ✅ Get first item image for buyer notification
      const buyerNotificationImage = firstItemImage || createdOrders[0]?.image_url || null;

      // ✅ Notify buyer with image
      await prisma.notifications.create({
        data: {
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: buyerId,
          type: 'order',
          title: 'Payment Successful! 🎉',
          message: `Your order of ${listingIds.length} item(s) has been confirmed. Sellers will ship your items soon.`,
          image_url: buyerNotificationImage, // ✅ NEW
          related_id: createdOrders[0]?.id,
        },
      });
      console.log('📬 Buyer notification created with image:', buyerNotificationImage ? 'YES' : 'NO');

      // ✅ Send order confirmation email to buyer
      if (buyer?.email) {
        try {
          // Format shipping address for email
          const formattedAddress = shippingAddressJson 
            ? `${shippingAddressJson.name}\n${shippingAddressJson.line1}${shippingAddressJson.line2 ? '\n' + shippingAddressJson.line2 : ''}\n${shippingAddressJson.city}\n${shippingAddressJson.postal_code}`
            : 'Address not available';

          await sendOrderConfirmation(buyer.email, {
            buyerName: buyer.display_name || 'there',
            orderId: createdOrders[0]?.id || session.id,
            items: orderItems,
            totalAmount: `£${grandTotal}`,
            shippingAddress: formattedAddress,
          });
          console.log('📧 Order confirmation email sent to:', buyer.email);
        } catch (emailError) {
          console.error('⚠️ Failed to send order confirmation email:', emailError);
          // Don't fail the order if email fails
        }
      }

      console.log('✅ Cart order fulfilled successfully');
      console.log('📦 Orders created:', createdOrders.length);
    } catch (error) {
      console.error('❌ Error fulfilling cart order:', error);
      throw error;
    }
  }
}