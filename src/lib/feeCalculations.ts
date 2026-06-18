// Shared fee calculation module — single source of truth for buyer fees,
// seller payouts, and offer validation. Pure maths, no Prisma, no Stripe.
//
// Formulas mirror the production logic in cartCheckoutController.ts
// (lines ~316-336) and nativePaymentController.ts (lines ~382-421).
// If this module diverges from the controllers, the controllers are wrong.

export const BUYER_PROTECTION_RATE = 0.075;           // 7.5%
export const SERVICE_FEE_PER_ITEM = 0.99;             // £0.99 per item
export const INSURANCE_RATE = 0.0125;                 // 1.25% of item value

export const MIN_OFFER_PERCENT = 0.5;                 // offer floor
export const MAX_OFFER_PERCENT = 1.0;                 // offer ceiling

export {
  ESCROW_RELEASE_DAYS,
  SHIPPING_DEADLINE_DAYS,
  AUTO_CANCEL_DAYS,
  RETURN_SHIPPING_DEADLINE_DAYS,
} from '../config/constants';
export const LOST_IN_TRANSIT_DAYS = 14;
export const SELLER_DISPUTE_RESPONSE_HOURS = 72;
export const BUYER_CANCEL_WINDOW_MINUTES = 5;
export const CART_ITEM_EXPIRY_HOURS = 72;
export const OFFER_EXPIRY_HOURS = 24;
export const ACCEPTANCE_WINDOW_HOURS = 24;
export const MAX_OFFERS_PER_LISTING = 3;
export const ADMIN_SESSION_TIMEOUT_MINUTES = 30;

export interface CartItem {
  sellerId: string;
  listingPrice: number;        // listing.price
  offerPrice?: number | null;  // accepted/counter-accepted offer price (overrides listingPrice)
  quantity: number;
  shippingCost: number;        // per-listing shipping cost (£)
}

export interface FeeBreakdown {
  itemsTotal: number;
  baseShipping: number;
  insurancePremium: number;
  insuredShipping: number;
  buyerProtectionFee: number;
  serviceFee: number;
  platformFee: number;
  grandTotal: number;
  totalQuantity: number;
  itemCount: number;
}

export interface SellerPayout {
  itemAmount: number;
  shippingAmount: number;
  total: number;
}

/**
 * Calculate the full buyer fee breakdown for a set of cart items.
 *
 * Per-seller shipping: we charge the MAX shipping cost among that seller's
 * listings (mirrors production cartCheckoutController:254). Additional items
 * from the same seller ride for free on the highest-priced shipping label.
 */
export function calculateBuyerFees(items: CartItem[]): FeeBreakdown {
  if (items.length === 0) {
    return {
      itemsTotal: 0,
      baseShipping: 0,
      insurancePremium: 0,
      insuredShipping: 0,
      buyerProtectionFee: 0,
      serviceFee: 0,
      platformFee: 0,
      grandTotal: 0,
      totalQuantity: 0,
      itemCount: 0,
    };
  }

  let itemsTotal = 0;
  let totalQuantity = 0;
  const sellerMaxShipping: Record<string, number> = {};

  for (const item of items) {
    const effectivePrice = item.offerPrice ?? item.listingPrice;
    itemsTotal += effectivePrice * item.quantity;
    totalQuantity += item.quantity;

    const prev = sellerMaxShipping[item.sellerId] ?? 0;
    if (item.shippingCost > prev) {
      sellerMaxShipping[item.sellerId] = item.shippingCost;
    } else if (sellerMaxShipping[item.sellerId] === undefined) {
      sellerMaxShipping[item.sellerId] = item.shippingCost;
    }
  }

  const baseShipping = Object.values(sellerMaxShipping).reduce((sum, v) => sum + v, 0);
  const insurancePremium = itemsTotal * INSURANCE_RATE;
  const insuredShipping = baseShipping + insurancePremium;

  const buyerProtectionFee = itemsTotal * BUYER_PROTECTION_RATE;
  const serviceFee = SERVICE_FEE_PER_ITEM * totalQuantity;
  const platformFee = buyerProtectionFee + serviceFee;

  const grandTotal = itemsTotal + insuredShipping + platformFee;

  return {
    itemsTotal,
    baseShipping,
    insurancePremium,
    insuredShipping,
    buyerProtectionFee,
    serviceFee,
    platformFee,
    grandTotal,
    totalQuantity,
    itemCount: items.length,
  };
}

/**
 * Calculate seller payout for a single order (one seller, one listing line).
 *
 * Auto-ship: seller receives `effectivePrice * quantity`. Platform retains
 * the shipping line (buys the label via Shippo and keeps any margin).
 *
 * Manual ship: seller receives `effectivePrice * quantity + shippingCost - labelCost`.
 * `shippingCost` is what the buyer paid for shipping (the "base shipping" line),
 * `labelCost` is what Shippo charged if the platform bought the label on the
 * seller's behalf. `shippingAmount` is floored at 0 — it can never be negative.
 */
export function calculateSellerPayout(
  effectivePrice: number,
  quantity: number,
  shippingCost: number,
  isAutoShip: boolean,
  labelCost: number = 0,
): SellerPayout {
  const itemAmount = effectivePrice * quantity;

  let shippingAmount: number;
  if (isAutoShip) {
    shippingAmount = 0;
  } else {
    shippingAmount = Math.max(0, shippingCost - labelCost);
  }

  return {
    itemAmount,
    shippingAmount,
    total: itemAmount + shippingAmount,
  };
}

/**
 * Estimate the buyer-facing price for a single item (quantity 1, no shipping).
 * Used for display contexts (e.g. Chip Caddy) where the full cart breakdown
 * isn't available. Includes 7.5% buyer protection + £0.99 service fee.
 */
export function estimateBuyerPrice(itemPrice: number): number {
  return itemPrice * (1 + BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
}

/**
 * Validate an offer amount against a listing price.
 * Returns null if the offer is valid, or a human-readable reason string if not.
 * Mirrors offerController.ts:159-172.
 */
export function validateOfferAmount(
  offerAmount: number,
  listPrice: number,
): string | null {
  if (!Number.isFinite(offerAmount) || offerAmount <= 0) {
    return 'Offer amount must be a positive number';
  }
  if (!Number.isFinite(listPrice) || listPrice <= 0) {
    return 'List price must be a positive number';
  }

  const minOffer = listPrice * MIN_OFFER_PERCENT;
  const maxOffer = listPrice * MAX_OFFER_PERCENT;

  if (offerAmount < minOffer) {
    return `Offer must be at least 50% of the list price (£${minOffer.toFixed(2)})`;
  }
  if (offerAmount > maxOffer) {
    return 'Offer cannot exceed the list price';
  }
  return null;
}
