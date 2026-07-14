// src/controllers/cartController.ts
// UPDATED: Added size variant support (selected_size) for clothing, shoes, grips, and shaft flex
// UPDATED: Added offer system support (offer_id, offer_price) for negotiated prices
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #13] Removed offer_price from destructured request body in addToCart.
//             The validated price now comes exclusively from the offer object lookup.
// [Issue #19] Replaced `new PrismaClient()` with shared singleton `import { prisma }`.

import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { BUYER_PROTECTION_RATE, SERVICE_FEE_PER_ITEM, INSURANCE_RATE } from '../lib/feeCalculations';
import { AuthenticatedRequest } from '../middleware/auth';
import { getStockForSize } from '../lib/stockUtils';

// Cart expiry time: 72 hours in milliseconds
const CART_EXPIRY_HOURS = 72;
const CART_EXPIRY_MS = CART_EXPIRY_HOURS * 60 * 60 * 1000;

// ============================================
// HELPER: Check if listing has size variants
// ============================================
function hasVariants(listing: any): boolean {
  const specs = listing.specifications as any;
  return specs?.sizeQuantities &&
         typeof specs.sizeQuantities === 'object' &&
         Object.keys(specs.sizeQuantities).length > 0;
}

// ============================================
// HELPER: Get all available sizes with stock > 0
// ============================================
function getAvailableSizes(listing: any): { size: string; quantity: number }[] {
  const specs = listing.specifications as any;
  if (!specs?.sizeQuantities) return [];

  return Object.entries(specs.sizeQuantities)
    .filter(([_, qty]) => (qty as number) > 0)
    .map(([size, qty]) => ({ size, quantity: qty as number }));
}

export const CartController = {
  // ============================================
  // GET CART - Returns cart grouped by seller
  // UPDATED: Now includes selected_size and offer fields
  // ============================================
  async getCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // First, clean up expired items
      await prisma.cart_items.deleteMany({
        where: {
          user_id: userId,
          expires_at: { lt: new Date() }
        }
      });

      // Get cart items with listing and seller details
      const cartItems = await prisma.cart_items.findMany({
        where: { user_id: userId },
        include: {
          listings: {
            include: {
              images: {
                take: 1,
                orderBy: PRIMARY_IMAGE_ORDER,
              },
             users: {
               select: {
  id: true,
  display_name: true,
  avatar_url: true,
  postcode_area: true,
  rating: true,
  is_verified_seller: true,
  is_pro_store: true,
  pro_store_name: true
}
              }
            }
          }
        },
        orderBy: { added_at: 'desc' }
      });

      // OFFER SYSTEM: Batch-fetch offer expiry times for offer-based cart items
      const offerIds = cartItems
        .filter(item => item.offer_id)
        .map(item => item.offer_id as string);

      let offerExpiryMap: Record<string, string | null> = {};
      if (offerIds.length > 0) {
        const offers = await prisma.offers.findMany({
          where: { id: { in: offerIds } },
          select: { id: true, acceptance_expires_at: true, status: true },
        });
        for (const offer of offers) {
          // Only include expiry if offer is still in an accepted state
          if (offer.status === 'ACCEPTED' || offer.status === 'COUNTER_ACCEPTED') {
            offerExpiryMap[offer.id] = offer.acceptance_expires_at?.toISOString() || null;
          }
        }
      }

      // Check which items are still available and validate quantities
      const itemsWithAvailability = await Promise.all(
        cartItems.map(async (item) => {
          const listing = item.listings;
          const selectedSize = item.selected_size;

          // Get stock for specific size (or total if no size)
          const availableStock = getStockForSize(listing, selectedSize);
          const isAvailable = listing.status === 'active' && availableStock > 0;

          // Cap cart quantity to available stock for this size
          const validQuantity = Math.min(item.quantity, availableStock);

          // If cart quantity exceeds stock, update it
          if (item.quantity > availableStock && availableStock > 0) {
            await prisma.cart_items.update({
              where: { id: item.id },
              data: { quantity: availableStock }
            });
          }

          // Count how many other users have this item+size in their cart
          const otherCartsCount = await prisma.cart_items.count({
            where: {
              listing_id: item.listing_id,
              selected_size: selectedSize,
              user_id: { not: userId },
              expires_at: { gt: new Date() }
            }
          });

          return {
            ...item,
            quantity: validQuantity,
            is_available: isAvailable,
            available_stock: availableStock,
            in_other_carts: otherCartsCount
          };
        })
      );

      // Group items by seller
      const sellerGroups: { [key: string]: any } = {};

      for (const item of itemsWithAvailability) {
        const sellerId = item.listings.seller_id;
        const seller = item.listings.users;

        if (!sellerGroups[sellerId]) {
          sellerGroups[sellerId] = {
            seller_id: sellerId,
            seller_name: seller.display_name || 'Unknown Seller',
            seller_avatar: seller.avatar_url,
            seller_postcode: seller.postcode_area,
            seller_rating: seller.rating,
           seller_is_verified_seller_seller: seller.is_verified_seller || false,
is_pro_store: seller.is_pro_store ?? false,
pro_store_name: seller.pro_store_name ?? null,
items: [],
            subtotal: 0,
            shipping_cost: 0
          };
        }

        // OFFER SYSTEM: Use offer_price when available, otherwise listing price
        const price = item.offer_price
          ? Number(item.offer_price)
          : Number(item.listings.price);
        const originalPrice = Number(item.listings.price);
        const shippingCost = Number(item.listings.shipping_cost) || 0;
        const quantity = item.quantity;

        // Calculate line total based on quantity
        const lineTotal = price * quantity;
        // SHIPPING LOGIC: Every 5 items = 1 shipping charge
        const lineShipping = Math.ceil(quantity / 5) * shippingCost;

        sellerGroups[sellerId].items.push({
          id: item.id,
          listing_id: item.listing_id,
          title: item.listings.title,
          price: originalPrice,
          quantity: quantity,
          selected_size: item.selected_size,
          line_total: lineTotal,
          available_stock: item.available_stock,
          shipping_cost: shippingCost,
          image_url: item.listings.images[0]?.image_url || null,
          parcel_size: item.listings.parcel_size,
          added_at: item.added_at,
          expires_at: item.expires_at,
          is_available: item.is_available,
          in_other_carts: item.in_other_carts > 0,
          // OFFER SYSTEM: Include offer fields in response
          offer_id: item.offer_id || null,
          offer_price: item.offer_price ? Number(item.offer_price) : null,
          offer_expires_at: item.offer_id ? (offerExpiryMap[item.offer_id as string] || null) : null,
          condition_overall: item.listings.condition_overall ?? null,
          brand: item.listings.brand ?? null,
          model: item.listings.model ?? null
        });

        sellerGroups[sellerId].subtotal += lineTotal;
        // SHIPPING: Take MAX shipping per seller (not sum)
        sellerGroups[sellerId].shipping_cost = Math.max(sellerGroups[sellerId].shipping_cost, lineShipping);
      }

      // Convert to array
      const sellers = Object.values(sellerGroups);


// Calculate totals (using line totals which include quantity)
      const itemsTotal = sellers.reduce((sum, s) => sum + s.subtotal, 0);
      const baseShippingTotal = sellers.reduce((sum, s) => sum + (s.shipping_cost || 0), 0);

      // Total items count (sum of quantities) - moved up for fee calculation
      const totalItemCount = itemsWithAvailability.reduce((sum, item) => sum + item.quantity, 0);

      // INSURANCE: Calculate insurance premium (1.25% of item value)
      const insurancePremium = itemsTotal * INSURANCE_RATE;
      const insuredShippingTotal = baseShippingTotal + insurancePremium;

      const sellerCount = sellers.length;
      const buyerProtectionFee = (itemsTotal * BUYER_PROTECTION_RATE) + (SERVICE_FEE_PER_ITEM * sellerCount);
      const grandTotal = itemsTotal + insuredShippingTotal + buyerProtectionFee;

      // Generate warnings for items in multiple carts
      const warnings = itemsWithAvailability
        .filter(item => item.in_other_carts > 0)
        .map(item => ({
          listing_id: item.listing_id,
          selected_size: item.selected_size,
          message: `This item is in ${item.in_other_carts} other cart${item.in_other_carts > 1 ? 's' : ''}`
        }));

      // Check for unavailable items
      const unavailableItems = itemsWithAvailability
        .filter(item => !item.is_available)
        .map(item => ({
          listing_id: item.listing_id,
          title: item.listings.title,
          selected_size: item.selected_size,
          message: item.selected_size
            ? `Size ${item.selected_size} is no longer available`
            : 'This item is no longer available'
        }));

      res.json({
        sellers,
        summary: {
          items_total: Number(itemsTotal.toFixed(2)),
          base_shipping: baseShippingTotal,
        insurance_premium: insurancePremium,
        insured_shipping_total: insuredShippingTotal,
          buyer_protection_fee: Number(buyerProtectionFee.toFixed(2)),
          grand_total: Number(grandTotal.toFixed(2)),
          item_count: totalItemCount
        },
        warnings,
        unavailable_items: unavailableItems
      });

    } catch (error) {
      console.error('Failed to get cart:', error);
      res.status(500).json({ error: 'Failed to get cart' });
    }
  },

  // ============================================
  // ADD TO CART
  // UPDATED: Accepts selected_size for variants
  // UPDATED: Accepts offer_id for negotiated prices
  // [Issue #13] offer_price removed from request body destructuring
  // ============================================
  async addToCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // [Issue #13] offer_price is NOT destructured from req.body — it comes from the offer lookup
      const { listing_id, quantity = 1, selected_size = null, offer_id = null } = req.body;
      const requestedQty = Math.max(1, parseInt(quantity) || 1);

      if (!listing_id) {
        return res.status(400).json({ error: 'Listing ID is required' });
      }

      // Check if listing exists and is available
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id },
        include: {
          users: {
            select: { id: true, display_name: true }
          }
        }
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      if (listing.status !== 'active') {
        return res.status(400).json({ error: 'This item is no longer available' });
      }

      // Check if this listing requires a size selection
      const listingHasVariants = hasVariants(listing);
      if (listingHasVariants && !selected_size) {
        const availableSizes = getAvailableSizes(listing);
        return res.status(400).json({
          error: 'Please select a size',
          requires_size: true,
          available_sizes: availableSizes
        });
      }

      // Get stock for the specific size (or total if no variants)
      const availableStock = getStockForSize(listing, selected_size);

      if (availableStock < 1) {
        return res.status(400).json({
          error: selected_size
            ? `Size ${selected_size} is out of stock`
            : 'This item is out of stock'
        });
      }

      // Can't add your own listing to cart
      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot add your own listing to cart' });
      }

      // OFFER SYSTEM: Validate offer if provided
      let validatedOfferId: string | null = null;
      let validatedOfferPrice: number | null = null;

      if (offer_id) {
        const offer = await prisma.offers.findUnique({
          where: { id: offer_id },
        });

        if (!offer) {
          return res.status(404).json({ error: 'Offer not found' });
        }

        if (offer.buyer_id !== userId) {
          return res.status(403).json({ error: 'This offer does not belong to you' });
        }

        if (offer.status !== 'ACCEPTED' && offer.status !== 'COUNTER_ACCEPTED') {
          return res.status(400).json({ error: 'This offer is not in an accepted state' });
        }

        if (offer.listing_id !== listing_id) {
          return res.status(400).json({ error: 'Offer does not match this listing' });
        }

        // Check acceptance window hasn't expired
        if (offer.acceptance_expires_at && new Date() > offer.acceptance_expires_at) {
          return res.status(400).json({ error: 'The acceptance window for this offer has expired' });
        }

        validatedOfferId = offer.id;
        // [Issue #13] Price comes from the offer object, NOT from req.body
        validatedOfferPrice = parseFloat(offer.final_amount!.toString());

        console.log(`[CART] Offer-based add: listing ${listing_id}, list £${Number(listing.price).toFixed(2)} → offer £${validatedOfferPrice.toFixed(2)}`);
      }

      // Check if already in cart (with same size)
      // Since selected_size can be null, we need to handle this carefully
      const existingCartItem = await prisma.cart_items.findFirst({
        where: {
          user_id: userId,
          listing_id: listing_id,
          selected_size: selected_size  // null matches null
        }
      });

      if (existingCartItem) {
        // OFFER SYSTEM: If adding with an offer, update existing item's offer fields
        if (validatedOfferId) {
          const updatedItem = await prisma.cart_items.update({
            where: { id: existingCartItem.id },
            data: {
              offer_id: validatedOfferId,
              offer_price: validatedOfferPrice,
              expires_at: new Date(Date.now() + CART_EXPIRY_MS)
            }
          });

          const cartItems = await prisma.cart_items.findMany({
            where: { user_id: userId, expires_at: { gt: new Date() } }
          });
          const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

          return res.json({
            message: 'Cart updated with offer price',
            cart_item: updatedItem,
            quantity: existingCartItem.quantity,
            selected_size: selected_size,
            available_stock: availableStock,
            cart_count: cartCount,
            offer_applied: true,
          });
        }

        // ADDITIVE: Add requested qty to existing qty
        const newQuantity = existingCartItem.quantity + requestedQty;

        // Cap at available stock for this size
        const cappedQuantity = Math.min(newQuantity, availableStock);

        if (cappedQuantity === existingCartItem.quantity) {
          // Already at max stock
          return res.status(400).json({
            error: 'Maximum quantity reached',
            message: selected_size
              ? `Only ${availableStock} available in size ${selected_size}`
              : `Only ${availableStock} available`,
            current_quantity: existingCartItem.quantity,
            available_stock: availableStock
          });
        }

        const updatedItem = await prisma.cart_items.update({
          where: { id: existingCartItem.id },
          data: {
            quantity: cappedQuantity,
            expires_at: new Date(Date.now() + CART_EXPIRY_MS)
          }
        });

        // Get updated cart count (sum of quantities)
        const cartItems = await prisma.cart_items.findMany({
          where: {
            user_id: userId,
            expires_at: { gt: new Date() }
          }
        });
        const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

        return res.json({
          message: `Quantity updated to ${cappedQuantity}`,
          cart_item: updatedItem,
          quantity: cappedQuantity,
          selected_size: selected_size,
          available_stock: availableStock,
          cart_count: cartCount
        });
      }

      // New cart item - cap at available stock
      const cappedQuantity = Math.min(requestedQty, availableStock);

      // Add to cart with 72-hour expiry
      const cartItem = await prisma.cart_items.create({
        data: {
          id: `cart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: userId,
          listing_id: listing_id,
          quantity: cappedQuantity,
          selected_size: selected_size,
          // OFFER SYSTEM: Store offer fields on cart item
          offer_id: validatedOfferId,
          offer_price: validatedOfferPrice,
          expires_at: new Date(Date.now() + CART_EXPIRY_MS)
        }
      });

      // Get updated cart count (sum of quantities)
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });
      const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

      res.status(201).json({
        message: validatedOfferId ? 'Item added to cart at offer price' : 'Item added to cart',
        cart_item: cartItem,
        quantity: cappedQuantity,
        selected_size: selected_size,
        available_stock: availableStock,
        cart_count: cartCount,
        offer_applied: !!validatedOfferId,
      });

    } catch (error) {
      console.error('Failed to add to cart:', error);
      res.status(500).json({ error: 'Failed to add to cart' });
    }
  },

  // ============================================
  // UPDATE CART ITEM QUANTITY
  // UPDATED: Works with size variants
  // ============================================
  async updateCartItemQuantity(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;
      const { quantity, selected_size = null } = req.body;
      const requestedQty = parseInt(quantity);

      if (!listing_id) {
        return res.status(400).json({ error: 'Listing ID is required' });
      }

      if (isNaN(requestedQty) || requestedQty < 0) {
        return res.status(400).json({ error: 'Valid quantity is required' });
      }

      // If quantity is 0, remove from cart
      if (requestedQty === 0) {
        await prisma.cart_items.deleteMany({
          where: {
            user_id: userId,
            listing_id: listing_id,
            selected_size: selected_size
          }
        });

        const cartItems = await prisma.cart_items.findMany({
          where: {
            user_id: userId,
            expires_at: { gt: new Date() }
          }
        });
        const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

        return res.json({
          message: 'Item removed from cart',
          cart_count: cartCount
        });
      }

      // Get listing to check stock
      const listing = await prisma.listings.findUnique({
        where: { id: listing_id }
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      if (listing.status !== 'active') {
        return res.status(400).json({ error: 'This item is no longer available' });
      }

      // Get stock for specific size
      const availableStock = getStockForSize(listing, selected_size);

      // Cap at available stock
      const cappedQuantity = Math.min(requestedQty, availableStock);

      // Find cart item with matching size
      const cartItem = await prisma.cart_items.findFirst({
        where: {
          user_id: userId,
          listing_id: listing_id,
          selected_size: selected_size
        }
      });

      if (!cartItem) {
        return res.status(404).json({ error: 'Item not found in cart' });
      }

      const updatedItem = await prisma.cart_items.update({
        where: { id: cartItem.id },
        data: {
          quantity: cappedQuantity,
          expires_at: new Date(Date.now() + CART_EXPIRY_MS)
        }
      });

      // Get updated cart count
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });
      const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

      res.json({
        message: 'Quantity updated',
        cart_item: updatedItem,
        quantity: cappedQuantity,
        selected_size: selected_size,
        available_stock: availableStock,
        was_capped: requestedQty > availableStock,
        cart_count: cartCount
      });

    } catch (error) {
      console.error('Failed to update cart quantity:', error);
      res.status(500).json({ error: 'Failed to update cart quantity' });
    }
  },

  // ============================================
  // REMOVE FROM CART
  // UPDATED: Accepts selected_size to remove specific variant
  // ============================================
  async removeFromCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;
      // Get selected_size from query params (for DELETE requests)
      const selected_size = req.query.selected_size as string | undefined || null;

      if (!listing_id) {
        return res.status(400).json({ error: 'Listing ID is required' });
      }

      // Delete the specific cart item (matching size)
      const deleted = await prisma.cart_items.deleteMany({
        where: {
          user_id: userId,
          listing_id: listing_id,
          selected_size: selected_size || null
        }
      });

      if (deleted.count === 0) {
        return res.status(404).json({ error: 'Item not found in cart' });
      }

      // Get updated cart count (sum of quantities)
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });
      const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

      res.json({
        message: 'Item removed from cart',
        cart_count: cartCount
      });

    } catch (error) {
      console.error('Failed to remove from cart:', error);
      res.status(500).json({ error: 'Failed to remove from cart' });
    }
  },

  // ============================================
  // CLEAR CART
  // ============================================
  async clearCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      await prisma.cart_items.deleteMany({
        where: { user_id: userId }
      });

      res.json({
        message: 'Cart cleared',
        cart_count: 0
      });

    } catch (error) {
      console.error('Failed to clear cart:', error);
      res.status(500).json({ error: 'Failed to clear cart' });
    }
  },

  // ============================================
  // GET CART COUNT (for badge)
  // ============================================
  async getCartCount(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Clean up expired items first
      await prisma.cart_items.deleteMany({
        where: {
          user_id: userId,
          expires_at: { lt: new Date() }
        }
      });

      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });

      // Sum of quantities instead of count of items
      const count = cartItems.reduce((sum, item) => sum + item.quantity, 0);

      res.json({ count });

    } catch (error) {
      console.error('Failed to get cart count:', error);
      res.status(500).json({ error: 'Failed to get cart count' });
    }
  },

  // ============================================
  // VALIDATE CART (before checkout)
  // UPDATED: Validates quantities per size
  // ============================================
  async validateCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Get all cart items
      const cartItems = await prisma.cart_items.findMany({
        where: {
          user_id: userId,
          expires_at: { gt: new Date() }
        },
        include: {
          listings: {
            select: {
              id: true,
              title: true,
              status: true,
              price: true,
              quantity: true,
              specifications: true,
              seller_id: true
            }
          }
        }
      });

      if (cartItems.length === 0) {
        return res.status(400).json({
          valid: false,
          error: 'Cart is empty'
        });
      }

      // Check each item's availability and quantity
      const unavailable: any[] = [];
      const available: any[] = [];
      const quantityAdjusted: any[] = [];

      for (const item of cartItems) {
        const listing = item.listings;
        const selectedSize = item.selected_size;

        // Get stock for this specific size
        const availableStock = getStockForSize(listing, selectedSize);

        if (listing.status !== 'active' || availableStock < 1) {
          // Item/size no longer available
          unavailable.push({
            listing_id: item.listing_id,
            title: listing.title,
            selected_size: selectedSize,
            reason: selectedSize
              ? `Size ${selectedSize} is no longer available`
              : 'Item is no longer available'
          });

          // Remove from cart
          await prisma.cart_items.delete({
            where: { id: item.id }
          });
        } else if (item.quantity > availableStock) {
          // Quantity exceeds stock for this size - adjust it
          const oldQty = item.quantity;
          const newQty = availableStock;

          quantityAdjusted.push({
            listing_id: item.listing_id,
            title: listing.title,
            selected_size: selectedSize,
            old_quantity: oldQty,
            new_quantity: newQty,
            reason: selectedSize
              ? `Only ${newQty} available in size ${selectedSize}`
              : `Only ${newQty} available`
          });

          // Update cart quantity
          await prisma.cart_items.update({
            where: { id: item.id },
            data: { quantity: newQty }
          });

          available.push({
            listing_id: item.listing_id,
            title: listing.title,
            price: listing.price,
            quantity: newQty,
            selected_size: selectedSize,
            seller_id: listing.seller_id
          });
        } else {
          available.push({
            listing_id: item.listing_id,
            title: listing.title,
            price: listing.price,
            quantity: item.quantity,
            selected_size: selectedSize,
            seller_id: listing.seller_id
          });
        }
      }

      if (unavailable.length > 0 || quantityAdjusted.length > 0) {
        return res.json({
          valid: quantityAdjusted.length > 0 && unavailable.length === 0,
          message: unavailable.length > 0
            ? `${unavailable.length} item(s) removed from cart`
            : `${quantityAdjusted.length} item(s) had quantity adjusted`,
          unavailable_items: unavailable,
          quantity_adjusted: quantityAdjusted,
          available_items: available
        });
      }

      res.json({
        valid: true,
        message: 'All items available',
        available_items: available
      });

    } catch (error) {
      console.error('Failed to validate cart:', error);
      res.status(500).json({ error: 'Failed to validate cart' });
    }
  },

  // ============================================
  // CHECK IF ITEM IS IN CART
  // UPDATED: Returns info per size variant
  // ============================================
  async isInCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;
      const selected_size = req.query.selected_size as string | undefined || null;

      // Find cart item with matching size
      const cartItem = await prisma.cart_items.findFirst({
        where: {
          user_id: userId,
          listing_id: listing_id,
          selected_size: selected_size || null
        }
      });

      const isInCart = cartItem !== null && cartItem.expires_at > new Date();

      res.json({
        in_cart: isInCart,
        quantity: isInCart ? cartItem?.quantity : 0,
        selected_size: isInCart ? cartItem?.selected_size : null,
        expires_at: isInCart ? cartItem?.expires_at : null
      });

    } catch (error) {
      console.error('Failed to check cart:', error);
      res.status(500).json({ error: 'Failed to check cart' });
    }
  },

 // ============================================
// GET LISTING CART INFO (for listing detail)
// UPDATED: Optionally filter by selected_size
// ============================================
async getListingCartInfo(req: AuthenticatedRequest, res: Response) {
  try {
    const { listing_id } = req.params;
    const selected_size = req.query.selected_size as string | undefined;
    const userId = req.user?.id;

    // Count how many users have this in their cart (any size)
    const inCartsCount = await prisma.cart_items.count({
      where: {
        listing_id: listing_id,
        expires_at: { gt: new Date() }
      }
    });

    // Get cart items for this listing by current user
    let userHasInCart = false;
    let userCartQuantity = 0;
    let userCartItems: { selected_size: string | null; quantity: number }[] = [];

    if (userId) {
      // If selected_size provided, only check for that specific size
      const whereClause: any = {
        user_id: userId,
        listing_id: listing_id,
        expires_at: { gt: new Date() }
      };

      // Only add size filter if a size was specified
      if (selected_size !== undefined) {
        whereClause.selected_size = selected_size || null;
      }

      const userItems = await prisma.cart_items.findMany({
        where: whereClause,
        select: {
          selected_size: true,
          quantity: true
        }
      });

      userCartItems = userItems;
      userCartQuantity = userItems.reduce((sum, item) => sum + item.quantity, 0);
      userHasInCart = userCartQuantity > 0;
    }

    res.json({
      in_carts_count: inCartsCount,
      user_has_in_cart: userHasInCart,
      user_cart_quantity: userCartQuantity,
      user_cart_items: userCartItems
    });

  } catch (error) {
    console.error('Failed to get listing cart info:', error);
    res.status(500).json({ error: 'Failed to get listing cart info' });
  }
}
};
