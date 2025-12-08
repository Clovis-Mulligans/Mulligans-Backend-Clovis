// src/routes/cartRoutes.ts
import { Router } from 'express';
import { CartController } from '../controllers/cartController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// All cart routes require authentication
router.use(authenticateToken);

// Get user's cart (grouped by seller)
router.get('/', CartController.getCart);

// Get cart item count (for badge)
router.get('/count', CartController.getCartCount);

// Check if specific item is in cart
router.get('/check/:listing_id', CartController.isInCart);

// Get listing cart info (how many have it in cart)
router.get('/listing/:listing_id', CartController.getListingCartInfo);

// Validate cart before checkout
router.post('/validate', CartController.validateCart);

// Add item to cart
router.post('/add', CartController.addToCart);

// Remove item from cart
router.delete('/:listing_id', CartController.removeFromCart);

// Clear entire cart
router.delete('/', CartController.clearCart);

export default router;