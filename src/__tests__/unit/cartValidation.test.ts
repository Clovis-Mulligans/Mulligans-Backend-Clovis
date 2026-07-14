// Cart validation decision-logic tests.
//
// Production cartController.ts does the DB query + validation in a single
// function, making mocking clumsy. These tests cover the pure predicates
// in src/lib/cartValidation.ts; the production controller should delegate
// to them after the DB fetch. See output/questions.md.

import {
  isCartItemExpired,
  validateListingForCart,
  validateQuantity,
  validateCheckout,
  isOwnListing,
  CART_ITEM_EXPIRY_HOURS,
} from '../../lib/cartValidation';
import { getStockForSize } from '../../lib/stockUtils';
import {
  makeListing,
  makeCartItem,
  hoursAgo,
} from '../helpers/mockFactories';

const NOW = new Date('2026-04-14T10:00:00Z');

// ─── CART ITEM EXPIRY ───────────────────────────────────────────────────

describe('isCartItemExpired', () => {
  test('71-hour-old item is valid (under 72h)', () => {
    const item = makeCartItem({ created_at: hoursAgo(71, NOW) });
    expect(isCartItemExpired(item, NOW)).toBe(false);
  });

  test('73-hour-old item is expired', () => {
    const item = makeCartItem({ created_at: hoursAgo(73, NOW) });
    expect(isCartItemExpired(item, NOW)).toBe(true);
  });

  test('boundary: exactly 72h is expired', () => {
    const item = makeCartItem({ created_at: hoursAgo(CART_ITEM_EXPIRY_HOURS, NOW) });
    expect(isCartItemExpired(item, NOW)).toBe(true);
  });

  test('expires_at column takes precedence when set', () => {
    const item = makeCartItem({
      created_at: hoursAgo(1, NOW),            // only 1 hour old
      expires_at: hoursAgo(0.5, NOW),          // but explicit expiry in the past
    });
    expect(isCartItemExpired(item, NOW)).toBe(true);
  });

  test('future expires_at keeps item valid', () => {
    const item = makeCartItem({
      created_at: hoursAgo(100, NOW),           // ancient by created_at
      expires_at: hoursAgo(-5, NOW),            // but explicit expiry 5h in future
    });
    expect(isCartItemExpired(item, NOW)).toBe(false);
  });
});

describe('multi-item expiry', () => {
  test('in a batch, only the expired items get flagged', () => {
    const items = [
      { id: 'fresh', item: makeCartItem({ created_at: hoursAgo(50, NOW) }) },
      { id: 'stale', item: makeCartItem({ created_at: hoursAgo(75, NOW) }) },
    ];
    const expired = items.filter(({ item }) => isCartItemExpired(item, NOW)).map((x) => x.id);
    expect(expired).toEqual(['stale']);
  });
});

// ─── LISTING AVAILABILITY ───────────────────────────────────────────────

describe('validateListingForCart', () => {
  test('active, in-stock listing → valid', () => {
    const listing = makeListing({ status: 'active', quantity: 5, seller_id: 'seller-1' });
    const result = validateListingForCart(listing, 'buyer-1', 1);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('listing not found → listing_not_found', () => {
    expect(validateListingForCart(null, 'buyer-1', 1).error).toBe('listing_not_found');
  });

  test('sold-out listing (quantity 0) → listing_sold_out', () => {
    const listing = makeListing({ status: 'active', quantity: 0 });
    expect(validateListingForCart(listing, 'buyer-1', 1).error).toBe('listing_sold_out');
  });

  test('sold listing (status=sold) → listing_inactive', () => {
    const listing = makeListing({ status: 'sold', quantity: 1 });
    expect(validateListingForCart(listing, 'buyer-1', 1).error).toBe('listing_inactive');
  });

  test('inactive/deleted listing → listing_inactive', () => {
    const l1 = makeListing({ status: 'inactive' });
    const l2 = makeListing({ status: 'deleted' });
    expect(validateListingForCart(l1, 'buyer-1', 1).error).toBe('listing_inactive');
    expect(validateListingForCart(l2, 'buyer-1', 1).error).toBe('listing_inactive');
  });

  test('own listing rejected (before other checks)', () => {
    const listing = makeListing({ status: 'active', quantity: 5, seller_id: 'user-A' });
    expect(validateListingForCart(listing, 'user-A', 1).error).toBe('own_listing');
  });

  test('quantity exceeds stock → quantity_exceeds_stock', () => {
    const listing = makeListing({ status: 'active', quantity: 2 });
    expect(validateListingForCart(listing, 'buyer-1', 3).error).toBe('quantity_exceeds_stock');
  });
});

describe('validateQuantity', () => {
  test('positive integer within stock is valid', () => {
    expect(validateQuantity(2, 5).valid).toBe(true);
  });

  test('zero is rejected (use remove-from-cart path instead)', () => {
    expect(validateQuantity(0, 5).error).toBe('quantity_invalid');
  });

  test('negative quantity rejected', () => {
    expect(validateQuantity(-1, 5).error).toBe('quantity_invalid');
  });

  test('non-integer rejected', () => {
    expect(validateQuantity(1.5, 5).error).toBe('quantity_invalid');
  });

  test('NaN rejected', () => {
    expect(validateQuantity(Number.NaN, 5).error).toBe('quantity_invalid');
  });

  test('quantity exceeding stock rejected', () => {
    expect(validateQuantity(5, 2).error).toBe('quantity_exceeds_stock');
  });

  test('equal to stock is valid', () => {
    expect(validateQuantity(5, 5).valid).toBe(true);
  });
});

describe('isOwnListing', () => {
  test('buyer === seller returns true', () => {
    const listing = makeListing({ seller_id: 'user-A' });
    expect(isOwnListing(listing, 'user-A')).toBe(true);
  });

  test('buyer !== seller returns false', () => {
    const listing = makeListing({ seller_id: 'user-A' });
    expect(isOwnListing(listing, 'user-B')).toBe(false);
  });
});

// ─── CHECKOUT RE-VALIDATION ─────────────────────────────────────────────

describe('validateCheckout — race-condition awareness', () => {
  test('all items valid → proceedable', () => {
    const listing = makeListing({ status: 'active', quantity: 1, seller_id: 'seller-1' });
    const report = validateCheckout(
      [{ cartItem: makeCartItem({ listing_id: listing.id, quantity: 1 }), listing }],
      'buyer-1',
      NOW,
    );
    expect(report.proceedable).toBe(true);
    expect(report.unavailable).toEqual([]);
  });

  test('item sold between cart-add and checkout → flagged unavailable', () => {
    const listing = makeListing({ status: 'sold', quantity: 0 });
    const cartItem = makeCartItem({ listing_id: listing.id, quantity: 1 });
    const report = validateCheckout([{ cartItem, listing }], 'buyer-1', NOW);
    expect(report.proceedable).toBe(false);
    expect(report.unavailable).toContain(listing.id);
  });

  test('listing deleted between add and checkout → flagged unavailable', () => {
    const cartItem = makeCartItem({ quantity: 1 });
    const report = validateCheckout([{ cartItem, listing: null }], 'buyer-1', NOW);
    expect(report.unavailable).toContain(cartItem.listing_id);
  });

  test('cart expired between add and checkout → removedExpired', () => {
    const listing = makeListing({ status: 'active', quantity: 1 });
    const cartItem = makeCartItem({
      listing_id: listing.id,
      created_at: hoursAgo(80, NOW),
    });
    const report = validateCheckout([{ cartItem, listing }], 'buyer-1', NOW);
    expect(report.removedExpired).toContain(listing.id);
    expect(report.proceedable).toBe(false);
  });

  test('stock dropped below cart quantity → quantityAdjusted', () => {
    const listing = makeListing({ status: 'active', quantity: 1 });
    const cartItem = makeCartItem({ listing_id: listing.id, quantity: 3 });
    const report = validateCheckout([{ cartItem, listing }], 'buyer-1', NOW);
    expect(report.proceedable).toBe(false);
    expect(report.quantityAdjusted).toEqual([
      { listing_id: listing.id, requested: 3, available: 1 },
    ]);
  });

  test('mixed cart: fresh + expired + sold → each reported once', () => {
    const freshListing = makeListing({ status: 'active', quantity: 1 });
    const soldListing = makeListing({ status: 'sold', quantity: 0 });
    const expiredItemListing = makeListing({ status: 'active', quantity: 1 });

    const report = validateCheckout(
      [
        { cartItem: makeCartItem({ listing_id: freshListing.id }), listing: freshListing },
        { cartItem: makeCartItem({ listing_id: soldListing.id }), listing: soldListing },
        {
          cartItem: makeCartItem({
            listing_id: expiredItemListing.id,
            created_at: hoursAgo(80, NOW),
          }),
          listing: expiredItemListing,
        },
      ],
      'buyer-1',
      NOW,
    );

    expect(report.unavailable).toEqual([soldListing.id]);
    expect(report.removedExpired).toEqual([expiredItemListing.id]);
    expect(report.proceedable).toBe(false);
  });
});

// ─── STOCK GUARD (getStockForSize — shared helper) ────────────────────

describe('getStockForSize — zero-quantity guard', () => {
  test('quantity-0 listing returns 0 (not purchasable)', () => {
    const listing = makeListing({ quantity: 0 });
    expect(getStockForSize(listing, null)).toBe(0);
  });

  test('quantity-5 listing returns 5', () => {
    const listing = makeListing({ quantity: 5 });
    expect(getStockForSize(listing, null)).toBe(5);
  });

  test('sized listing with zero stock in selected size returns 0', () => {
    const listing = { quantity: 10, specifications: { sizeQuantities: { M: 0, L: 5 } } };
    expect(getStockForSize(listing, 'M')).toBe(0);
  });

  test('sized listing with stock in selected size returns that size stock', () => {
    const listing = { quantity: 10, specifications: { sizeQuantities: { M: 3, L: 5 } } };
    expect(getStockForSize(listing, 'M')).toBe(3);
  });

  test('sized listing with unknown size returns 0', () => {
    const listing = { quantity: 10, specifications: { sizeQuantities: { M: 3 } } };
    expect(getStockForSize(listing, 'XL')).toBe(0);
  });

  test('no size selected, no sizeQuantities → returns listing.quantity', () => {
    const listing = makeListing({ quantity: 7 });
    expect(getStockForSize(listing, null)).toBe(7);
  });
});
