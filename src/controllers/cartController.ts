// src/controllers/cartController.ts
// ✅ UPDATED: Added quantity support for multi-item purchases
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';

const prisma = new PrismaClient();

// Cart expiry time: 72 hours in milliseconds
const CART_EXPIRY_HOURS = 72;
const CART_EXPIRY_MS = CART_EXPIRY_HOURS * 60 * 60 * 1000;

// Buyer protection fee
const BUYER_PROTECTION_PERCENTAGE = 0.07; // 7%
const BUYER_PROTECTION_FIXED = 0.99; // £0.99

export const CartController = {
  // ============================================
  // GET CART - Returns cart grouped by seller
  // ✅ UPDATED: Now includes quantity and available_stock
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
                take: 1
              },
             users: {
                select: {
                  id: true,
                  display_name: true,
                  avatar_url: true,
                  postcode_area: true,
                  rating: true,
                  is_verified: true
                }
              }
            }
          }
        },
        orderBy: { added_at: 'desc' }
      });

      // Check which items are still available and validate quantities
      const itemsWithAvailability = await Promise.all(
        cartItems.map(async (item) => {
          const listing = item.listings;
          const isAvailable = listing.status === 'active' && listing.quantity > 0;
          const availableStock = listing.quantity;
          
          // ✅ Cap cart quantity to available stock
          const validQuantity = Math.min(item.quantity, availableStock);
          
          // If cart quantity exceeds stock, update it
          if (item.quantity > availableStock && availableStock > 0) {
            await prisma.cart_items.update({
              where: { id: item.id },
              data: { quantity: availableStock }
            });
          }
          
          // Count how many other users have this item in their cart
          const otherCartsCount = await prisma.cart_items.count({
            where: {
              listing_id: item.listing_id,
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
            seller_is_verified: seller.is_verified || false,
            items: [],
            subtotal: 0,
            shipping_cost: 0
          };
        }

        const price = Number(item.listings.price);
        const shippingCost = Number(item.listings.shipping_cost) || 0;
        const quantity = item.quantity;
        
        // ✅ Calculate line total based on quantity
        const lineTotal = price * quantity;
        // ✅ SHIPPING LOGIC: Every 5 items = 1 shipping charge
        // ceil(qty / 5) × base_shipping = e.g., 1-5 items = 1x, 6-10 = 2x, etc.
        const lineShipping = Math.ceil(quantity / 5) * shippingCost;
        
        sellerGroups[sellerId].items.push({
          id: item.id,
          listing_id: item.listing_id,
          title: item.listings.title,
          price: price,
          quantity: quantity,  // ✅ NEW: Include quantity
          line_total: lineTotal,  // ✅ NEW: price * quantity
          available_stock: item.available_stock,  // ✅ NEW: Available stock
          shipping_cost: shippingCost,
          image_url: item.listings.images[0]?.image_url || null,
          parcel_size: item.listings.parcel_size,
          added_at: item.added_at,
          expires_at: item.expires_at,
          is_available: item.is_available,
          in_other_carts: item.in_other_carts > 0
        });
        
        sellerGroups[sellerId].subtotal += lineTotal;
        // ✅ SHIPPING: Take MAX shipping per seller (not sum)
        // Multiple listings from same seller = MAX shipping cost
        sellerGroups[sellerId].shipping_cost = Math.max(sellerGroups[sellerId].shipping_cost, lineShipping);
      }

      // Convert to array
      const sellers = Object.values(sellerGroups);

      // ✅ Calculate totals (using line totals which include quantity)
      const itemsTotal = sellers.reduce((sum, s) => sum + s.subtotal, 0);
      const shippingTotal = sellers.reduce((sum, s) => sum + (s.shipping_cost || 0), 0);
      const buyerProtectionFee = (itemsTotal * BUYER_PROTECTION_PERCENTAGE) + BUYER_PROTECTION_FIXED;
      const grandTotal = itemsTotal + shippingTotal + buyerProtectionFee;

      // ✅ Total items count (sum of quantities)
      const totalItemCount = itemsWithAvailability.reduce((sum, item) => sum + item.quantity, 0);

      // Generate warnings for items in multiple carts
      const warnings = itemsWithAvailability
        .filter(item => item.in_other_carts > 0)
        .map(item => ({
          listing_id: item.listing_id,
          message: `This item is in ${item.in_other_carts} other cart${item.in_other_carts > 1 ? 's' : ''}`
        }));

      // Check for unavailable items
      const unavailableItems = itemsWithAvailability
        .filter(item => !item.is_available)
        .map(item => ({
          listing_id: item.listing_id,
          title: item.listings.title,
          message: 'This item is no longer available'
        }));

      res.json({
        sellers,
        summary: {
          items_total: Number(itemsTotal.toFixed(2)),
          shipping_total: Number(shippingTotal.toFixed(2)),
          buyer_protection_fee: Number(buyerProtectionFee.toFixed(2)),
          grand_total: Number(grandTotal.toFixed(2)),
          item_count: totalItemCount  // ✅ Now counts total quantity, not just line items
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
  // ✅ UPDATED: Accepts quantity, adds to existing if already in cart
  // ============================================
  async addToCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id, quantity = 1 } = req.body;
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

      if (listing.quantity < 1) {
        return res.status(400).json({ error: 'This item is out of stock' });
      }

      // Can't add your own listing to cart
      if (listing.seller_id === userId) {
        return res.status(400).json({ error: 'You cannot add your own listing to cart' });
      }

      // Check if already in cart
      const existingCartItem = await prisma.cart_items.findUnique({
        where: {
          user_id_listing_id: {
            user_id: userId,
            listing_id: listing_id
          }
        }
      });

      if (existingCartItem) {
        // ✅ ADDITIVE: Add requested qty to existing qty
        const newQuantity = existingCartItem.quantity + requestedQty;
        
        // ✅ Cap at available stock
        const cappedQuantity = Math.min(newQuantity, listing.quantity);
        
        if (cappedQuantity === existingCartItem.quantity) {
          // Already at max stock
          return res.status(400).json({ 
            error: 'Maximum quantity reached',
            message: `Only ${listing.quantity} available`,
            current_quantity: existingCartItem.quantity,
            available_stock: listing.quantity
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
          available_stock: listing.quantity,
          cart_count: cartCount
        });
      }

      // ✅ New cart item - cap at available stock
      const cappedQuantity = Math.min(requestedQty, listing.quantity);

      // Add to cart with 72-hour expiry
      const cartItem = await prisma.cart_items.create({
        data: {
          id: `cart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: userId,
          listing_id: listing_id,
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

      res.status(201).json({
        message: 'Item added to cart',
        cart_item: cartItem,
        quantity: cappedQuantity,
        available_stock: listing.quantity,
        cart_count: cartCount
      });

    } catch (error) {
      console.error('Failed to add to cart:', error);
      res.status(500).json({ error: 'Failed to add to cart' });
    }
  },

  // ============================================
  // UPDATE CART ITEM QUANTITY
  // ✅ NEW: Set specific quantity for a cart item
  // ============================================
  async updateCartItemQuantity(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;
      const { quantity } = req.body;
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
            listing_id: listing_id
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

      // Cap at available stock
      const cappedQuantity = Math.min(requestedQty, listing.quantity);

      // Find and update cart item
      const cartItem = await prisma.cart_items.findUnique({
        where: {
          user_id_listing_id: {
            user_id: userId,
            listing_id: listing_id
          }
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
        available_stock: listing.quantity,
        was_capped: requestedQty > listing.quantity,
        cart_count: cartCount
      });

    } catch (error) {
      console.error('Failed to update cart quantity:', error);
      res.status(500).json({ error: 'Failed to update cart quantity' });
    }
  },

  // ============================================
  // REMOVE FROM CART
  // ============================================
  async removeFromCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;

      if (!listing_id) {
        return res.status(400).json({ error: 'Listing ID is required' });
      }

      // Delete the cart item
      const deleted = await prisma.cart_items.deleteMany({
        where: {
          user_id: userId,
          listing_id: listing_id
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
  // ✅ UPDATED: Returns sum of quantities, not just item count
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

      // ✅ Sum of quantities instead of count of items
      const count = cartItems.reduce((sum, item) => sum + item.quantity, 0);

      res.json({ count });

    } catch (error) {
      console.error('Failed to get cart count:', error);
      res.status(500).json({ error: 'Failed to get cart count' });
    }
  },

  // ============================================
  // VALIDATE CART (before checkout)
  // ✅ UPDATED: Validates quantities against stock
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
        
        if (listing.status !== 'active' || listing.quantity < 1) {
          // Item no longer available
          unavailable.push({
            listing_id: item.listing_id,
            title: listing.title,
            reason: 'Item is no longer available'
          });
          
          // Remove from cart
          await prisma.cart_items.delete({
            where: { id: item.id }
          });
        } else if (item.quantity > listing.quantity) {
          // ✅ Quantity exceeds stock - adjust it
          const oldQty = item.quantity;
          const newQty = listing.quantity;
          
          quantityAdjusted.push({
            listing_id: item.listing_id,
            title: listing.title,
            old_quantity: oldQty,
            new_quantity: newQty,
            reason: `Only ${newQty} available`
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
            seller_id: listing.seller_id
          });
        } else {
          available.push({
            listing_id: item.listing_id,
            title: listing.title,
            price: listing.price,
            quantity: item.quantity,
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
  // ✅ UPDATED: Returns quantity in cart
  // ============================================
  async isInCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.params;

      const cartItem = await prisma.cart_items.findUnique({
        where: {
          user_id_listing_id: {
            user_id: userId,
            listing_id: listing_id
          }
        }
      });

      const isInCart = cartItem !== null && cartItem.expires_at > new Date();

      res.json({ 
        in_cart: isInCart,
        quantity: isInCart ? cartItem?.quantity : 0,
        expires_at: isInCart ? cartItem?.expires_at : null
      });

    } catch (error) {
      console.error('Failed to check cart:', error);
      res.status(500).json({ error: 'Failed to check cart' });
    }
  },

  // ============================================
  // GET LISTING CART INFO (for listing detail)
  // ✅ UPDATED: Returns user's quantity in cart
  // ============================================
  async getListingCartInfo(req: AuthenticatedRequest, res: Response) {
    try {
      const { listing_id } = req.params;
      const userId = req.user?.id;

      // Count how many users have this in their cart
      const inCartsCount = await prisma.cart_items.count({
        where: {
          listing_id: listing_id,
          expires_at: { gt: new Date() }
        }
      });

      // Check if current user has it in cart and get quantity
      let userHasInCart = false;
      let userCartQuantity = 0;
      
      if (userId) {
        const userCartItem = await prisma.cart_items.findUnique({
          where: {
            user_id_listing_id: {
              user_id: userId,
              listing_id: listing_id
            }
          }
        });
        userHasInCart = userCartItem !== null && userCartItem.expires_at > new Date();
        userCartQuantity = userHasInCart ? userCartItem!.quantity : 0;
      }

      res.json({
        in_carts_count: inCartsCount,
        user_has_in_cart: userHasInCart,
        user_cart_quantity: userCartQuantity  // ✅ NEW
      });

    } catch (error) {
      console.error('Failed to get listing cart info:', error);
      res.status(500).json({ error: 'Failed to get listing cart info' });
    }
  }
};