// src/lib/refundPolicy.ts
// Refund model (June 2026): partial refunds are money-only — the buyer keeps
// the item — and exist only at 10–60% in 10% steps. Anything above 60% of
// item cost is exactly one thing: a 100% refund with mandatory return.
// Shared by buyer dispute creation, seller counter-offers and admin resolution
// so the allowed set lives in one place.

export const PARTIAL_REFUND_PERCENTS = [10, 20, 30, 40, 50, 60] as const;
export const FULL_REFUND_PERCENT = 100;

// Fraction of item cost above which a resolution must be a full refund with
// return (the forced-return backstop). Derived from the max partial percent.
export const MAX_PARTIAL_FRACTION = Math.max(...PARTIAL_REFUND_PERCENTS) / 100;

// Penny tolerance for amount comparisons (amounts are pound floats).
const AMOUNT_EPSILON = 0.005;

export const PARTIAL_REFUND_RULE_ERROR =
  'Partial refunds can be up to 60%. For more than that, request a full refund with return.';

export const COUNTER_OFFER_RULE_ERROR =
  'Counter-offers can be 10–60%. To give a full refund, accept the dispute instead — the buyer returns the item.';

// Buyer dispute creation: 10–60 in 10% steps, or 100 (= full refund with return).
export function isAllowedBuyerRefundPercent(percent: number): boolean {
  return percent === FULL_REFUND_PERCENT || (PARTIAL_REFUND_PERCENTS as readonly number[]).includes(percent);
}

// Seller counter-offers: partial set only — a full refund is an accept, not a counter.
export function isAllowedCounterPercent(percent: number): boolean {
  return (PARTIAL_REFUND_PERCENTS as readonly number[]).includes(percent);
}

// Admin partial resolution amounts: at most 60% of item cost. An amount equal
// to the full item cost is allowed (it routes to the forced-return backstop);
// anything in between is rejected.
export function isAllowedAdminPartialAmount(amount: number, itemCost: number): boolean {
  return amount > 0 && amount <= itemCost * MAX_PARTIAL_FRACTION + AMOUNT_EPSILON;
}

export function isFullItemCostAmount(amount: number, itemCost: number): boolean {
  return Math.abs(amount - itemCost) <= 0.01;
}

export function adminPartialRuleError(itemCost: number): string {
  return `Partial refunds can be up to 60% of the item cost (£${(itemCost * MAX_PARTIAL_FRACTION).toFixed(2)} here). For more than that, resolve as a full refund — the buyer returns the item.`;
}
