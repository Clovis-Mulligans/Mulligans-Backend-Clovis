// src/controllers/cartController.ts
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
                  rating: true
                }
              }
            }
          }
        },
        orderBy: { added_at: 'desc' }
      });

      // Check which items are still available
      const itemsWithAvailability = await Promise.all(
        cartItems.map(async (item) => {
          const isAvailable = item.listings.status === 'active';
          
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
            is_available: isAvailable,
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
            items: [],
            subtotal: 0,
            shipping_cost: 0  // ✅ FIXED: Sum of shipping costs for this seller
          };
        }

        const price = Number(item.listings.price);
        const shippingCost = Number(item.listings.shipping_cost) || 0;  // ✅ FIXED: Get seller's shipping cost
        
        sellerGroups[sellerId].items.push({
          id: item.id,
          listing_id: item.listing_id,
          title: item.listings.title,
          price: price,
          shipping_cost: shippingCost,  // ✅ ADDED: Include shipping cost per item
          image_url: item.listings.images[0]?.image_url || null,
          parcel_size: item.listings.parcel_size,
          added_at: item.added_at,
          expires_at: item.expires_at,
          is_available: item.is_available,
          in_other_carts: item.in_other_carts
        });
        
        sellerGroups[sellerId].subtotal += price;
        sellerGroups[sellerId].shipping_cost += shippingCost;  // ✅ FIXED: Accumulate shipping
      }

      // Convert to array
      const sellers = Object.values(sellerGroups);

      // Calculate totals
      const itemsTotal = sellers.reduce((sum, s) => sum + s.subtotal, 0);
      const shippingTotal = sellers.reduce((sum, s) => sum + (s.shipping_cost || 0), 0);  // ✅ FIXED: Use actual shipping
      const buyerProtectionFee = (itemsTotal * BUYER_PROTECTION_PERCENTAGE) + BUYER_PROTECTION_FIXED;
      const grandTotal = itemsTotal + shippingTotal + buyerProtectionFee;

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
          item_count: itemsWithAvailability.length
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
  // ============================================
  async addToCart(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { listing_id } = req.body;

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
        // Refresh the expiry time
        const updatedItem = await prisma.cart_items.update({
          where: { id: existingCartItem.id },
          data: {
            expires_at: new Date(Date.now() + CART_EXPIRY_MS)
          }
        });
        return res.json({ 
          message: 'Item already in cart, expiry refreshed',
          cart_item: updatedItem 
        });
      }

      // Add to cart with 72-hour expiry
      const cartItem = await prisma.cart_items.create({
        data: {
          id: `cart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          user_id: userId,
          listing_id: listing_id,
          expires_at: new Date(Date.now() + CART_EXPIRY_MS)
        }
      });

      // Get updated cart count
      const cartCount = await prisma.cart_items.count({
        where: { 
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });

      res.status(201).json({
        message: 'Item added to cart',
        cart_item: cartItem,
        cart_count: cartCount
      });

    } catch (error) {
      console.error('Failed to add to cart:', error);
      res.status(500).json({ error: 'Failed to add to cart' });
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

      // Get updated cart count
      const cartCount = await prisma.cart_items.count({
        where: { 
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });

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

      const count = await prisma.cart_items.count({
        where: { 
          user_id: userId,
          expires_at: { gt: new Date() }
        }
      });

      res.json({ count });

    } catch (error) {
      console.error('Failed to get cart count:', error);
      res.status(500).json({ error: 'Failed to get cart count' });
    }
  },

  // ============================================
  // VALIDATE CART (before checkout)
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

      // Check each item's availability
      const unavailable: any[] = [];
      const available: any[] = [];

      for (const item of cartItems) {
        if (item.listings.status !== 'active') {
          unavailable.push({
            listing_id: item.listing_id,
            title: item.listings.title,
            reason: 'Item is no longer available'
          });
          
          // Remove unavailable items from cart
          await prisma.cart_items.delete({
            where: { id: item.id }
          });
        } else {
          available.push({
            listing_id: item.listing_id,
            title: item.listings.title,
            price: item.listings.price,
            seller_id: item.listings.seller_id
          });
        }
      }

      if (unavailable.length > 0) {
        return res.json({
          valid: false,
          message: `${unavailable.length} item(s) removed from cart`,
          unavailable_items: unavailable,
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
        expires_at: isInCart ? cartItem?.expires_at : null
      });

    } catch (error) {
      console.error('Failed to check cart:', error);
      res.status(500).json({ error: 'Failed to check cart' });
    }
  },

  // ============================================
  // GET LISTING CART INFO (for listing detail)
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

      // Check if current user has it in cart
      let userHasInCart = false;
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
      }

      res.json({
        in_carts_count: inCartsCount,
        user_has_in_cart: userHasInCart
      });

    } catch (error) {
      console.error('Failed to get listing cart info:', error);
      res.status(500).json({ error: 'Failed to get listing cart info' });
    }
  }
};