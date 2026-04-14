// Pure validation functions extracted from cartController.ts and
// cartCheckoutController.ts. Production controllers query Prisma, then pass
// the rows to these predicates. Until the controllers are refactored to
// actually call these functions, they serve as an executable specification.
//
// See output/questions.md (Brief 8B) for the refactor proposal.

import { CART_ITEM_EXPIRY_HOURS } from './feeCalculations';
export { CART_ITEM_EXPIRY_HOURS };

export type ListingStatus = 'active' | 'sold' | 'inactive' | 'deleted' | 'pending_review';

export interface ListingSnapshot {
  id: string;
  status: ListingStatus;
  seller_id: string;
  quantity: number;
}

export interface CartItemSnapshot {
  listing_id: string;
  user_id: string;
  quantity: number;
  created_at: Date;
  expires_at: Date | null;
}

// ─── CART ITEM EXPIRY ───────────────────────────────────────────────────

const EXPIRY_MS = CART_ITEM_EXPIRY_HOURS * 60 * 60 * 1000;

export function isCartItemExpired(item: CartItemSnapshot, now: Date): boolean {
  if (item.expires_at !== null) {
    return item.expires_at.getTime() <= now.getTime();
  }
  const ageMs = now.getTime() - item.created_at.getTime();
  return ageMs >= EXPIRY_MS;
}

// ─── LISTING AVAILABILITY ───────────────────────────────────────────────

export type CartValidationError =
  | 'listing_not_found'
  | 'listing_inactive'
  | 'listing_sold_out'
  | 'own_listing'
  | 'quantity_invalid'
  | 'quantity_exceeds_stock';

export interface CartValidationResult {
  valid: boolean;
  error: CartValidationError | null;
}

export function validateListingForCart(
  listing: ListingSnapshot | null,
  buyerId: string,
  requestedQuantity: number,
): CartValidationResult {
  if (!listing) {
    return { valid: false, error: 'listing_not_found' };
  }

  if (listing.seller_id === buyerId) {
    return { valid: false, error: 'own_listing' };
  }

  if (listing.status !== 'active') {
    return { valid: false, error: 'listing_inactive' };
  }

  if (listing.quantity <= 0) {
    return { valid: false, error: 'listing_sold_out' };
  }

  const qtyCheck = validateQuantity(requestedQuantity, listing.quantity);
  if (!qtyCheck.valid) return qtyCheck;

  return { valid: true, error: null };
}

export function validateQuantity(
  requestedQuantity: number,
  availableStock: number,
): CartValidationResult {
  if (!Number.isFinite(requestedQuantity) || requestedQuantity < 0) {
    return { valid: false, error: 'quantity_invalid' };
  }
  if (!Number.isInteger(requestedQuantity)) {
    return { valid: false, error: 'quantity_invalid' };
  }
  if (requestedQuantity === 0) {
    // Zero is "remove from cart" — not an error, but not a valid add either.
    return { valid: false, error: 'quantity_invalid' };
  }
  if (requestedQuantity > availableStock) {
    return { valid: false, error: 'quantity_exceeds_stock' };
  }
  return { valid: true, error: null };
}

export function isOwnListing(listing: ListingSnapshot, buyerId: string): boolean {
  return listing.seller_id === buyerId;
}

// ─── CHECKOUT-TIME RE-VALIDATION ────────────────────────────────────────

export interface CheckoutValidationItem {
  cartItem: CartItemSnapshot;
  listing: ListingSnapshot | null;
}

export interface CheckoutValidationReport {
  proceedable: boolean;
  removedExpired: string[];        // listing_ids dropped because cart entry expired
  unavailable: string[];           // listing_ids no longer valid at checkout
  quantityAdjusted: Array<{ listing_id: string; requested: number; available: number }>;
}

export function validateCheckout(
  items: CheckoutValidationItem[],
  buyerId: string,
  now: Date,
): CheckoutValidationReport {
  const removedExpired: string[] = [];
  const unavailable: string[] = [];
  const quantityAdjusted: Array<{ listing_id: string; requested: number; available: number }> = [];

  for (const { cartItem, listing } of items) {
    if (isCartItemExpired(cartItem, now)) {
      removedExpired.push(cartItem.listing_id);
      continue;
    }
    if (!listing || listing.status !== 'active') {
      unavailable.push(cartItem.listing_id);
      continue;
    }
    if (listing.seller_id === buyerId) {
      unavailable.push(cartItem.listing_id);
      continue;
    }
    if (listing.quantity <= 0) {
      unavailable.push(cartItem.listing_id);
      continue;
    }
    if (cartItem.quantity > listing.quantity) {
      quantityAdjusted.push({
        listing_id: cartItem.listing_id,
        requested: cartItem.quantity,
        available: listing.quantity,
      });
    }
  }

  const proceedable = unavailable.length === 0 && removedExpired.length === 0 && quantityAdjusted.length === 0;
  return { proceedable, removedExpired, unavailable, quantityAdjusted };
}
