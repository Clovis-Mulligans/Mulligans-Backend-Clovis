// Pure decision functions extracted from escrowService.ts.
//
// The real escrowService imports Prisma + Stripe at module load, making it
// unmockable without refactor. These pure predicates capture the DECISIONS
// the service makes; the real service should call them on DB rows. Until
// escrowService is refactored to import from here, these functions serve as
// an executable specification of the intended rules.
//
// See output/questions.md (Brief 8B) for the refactor proposal.

import {
  ESCROW_RELEASE_DAYS,
  AUTO_CANCEL_DAYS,
  SHIPPING_DEADLINE_DAYS,
  RETURN_SHIPPING_DEADLINE_DAYS,
  LOST_IN_TRANSIT_DAYS,
  SELLER_DISPUTE_RESPONSE_HOURS,
  calculateSellerPayout,
  SellerPayout,
} from './feeCalculations';

// Re-export so escrow callers can import everything from one place
export {
  ESCROW_RELEASE_DAYS,
  AUTO_CANCEL_DAYS,
  SHIPPING_DEADLINE_DAYS,
  RETURN_SHIPPING_DEADLINE_DAYS,
  LOST_IN_TRANSIT_DAYS,
  SELLER_DISPUTE_RESPONSE_HOURS,
};

// Statuses that block escrow release — SINGLE SOURCE OF TRUTH (escrowService.ts imports these)
export const BLOCKING_DISPUTE_STATUSES: string[] = ['open', 'counter_offered', 'escalated'];
export const BLOCKING_RETURN_STATUSES: string[] = [
  'pending',
  'approved',
  'awaiting_address',
  'label_created',
  'shipped',
  'delivered',
  'refund_processing',
];

export type OrderStatus =
  | 'pending' | 'to_ship' | 'in_transit' | 'delivered'
  | 'completed' | 'cancelled' | 'disputed' | 'refunded' | 'returned';

export interface OrderSnapshot {
  id: string;
  status: OrderStatus;
  auto_cancel_at: Date | null;
  escrow_release_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  refunded_at: Date | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  lost_notification_sent_at: Date | null;
  label_auto_generated: boolean;
  label_cost: number | null;
  shipping_cost: number;
  item_price: number;          // effective price (offer_price || listing price) paid per unit
  quantity: number;
}

export interface DisputeSnapshot {
  status: string;
  created_at: Date;
  seller_response_type: string | null;
}

export interface ReturnSnapshot {
  status: string;
  created_at: Date;
  tracking_number: string | null;
}

// ─── SELLER PAYABILITY ──────────────────────────────────────────────────

export function sellerCanReceivePayout(seller: { stripe_connect_id: string | null; stripe_connect_status?: string | null }): boolean {
  return !!seller.stripe_connect_id && seller.stripe_connect_status === 'active';
}

// ─── AUTO-CANCEL ────────────────────────────────────────────────────────

export function shouldAutoCancelUnshipped(order: OrderSnapshot, now: Date): boolean {
  if (order.status !== 'to_ship') return false;
  if (order.refunded_at !== null) return false;
  if (order.stripe_refund_id !== null) return false;
  if (order.auto_cancel_at === null) return false;
  return order.auto_cancel_at.getTime() <= now.getTime();
}

// ─── AUTO-RELEASE ESCROW ────────────────────────────────────────────────

export interface ReleaseContext {
  hasBlockingDispute: boolean;
  hasBlockingReturn: boolean;
}

export function shouldReleaseEscrow(
  order: OrderSnapshot,
  ctx: ReleaseContext,
  now: Date,
): boolean {
  if (order.status !== 'delivered') return false;
  if (order.stripe_transfer_id !== null) return false; // double-release guard
  if (order.escrow_release_at === null) return false;
  if (order.escrow_release_at.getTime() > now.getTime()) return false;
  if (ctx.hasBlockingDispute) return false;
  if (ctx.hasBlockingReturn) return false;
  return true;
}

/**
 * Calculate the seller payout for an escrow release.
 *
 * Auto-ship (`label_auto_generated = true`): seller receives the item
 *   amount only — platform already paid the carrier and keeps the
 *   buyer-paid shipping line.
 *
 * Manual ship: seller receives item + (shipping_cost - label_cost), where
 *   label_cost defaults to 0 if null. Shipping component floors at 0.
 */
export function calculateEscrowPayout(order: OrderSnapshot): SellerPayout {
  const labelCost = order.label_cost ?? 0;
  return calculateSellerPayout(
    order.item_price,
    order.quantity,
    order.shipping_cost,
    order.label_auto_generated,
    labelCost,
  );
}

// ─── DISPUTE ESCALATION ─────────────────────────────────────────────────

export function shouldEscalateDispute(
  order: OrderSnapshot,
  dispute: DisputeSnapshot,
  now: Date,
): boolean {
  if (order.status === 'completed' || order.status === 'refunded' || order.status === 'returned') {
    return false;
  }
  if (dispute.status !== 'open') return false;
  if (dispute.seller_response_type !== null) return false;

  const ageMs = now.getTime() - dispute.created_at.getTime();
  const thresholdMs = SELLER_DISPUTE_RESPONSE_HOURS * 60 * 60 * 1000;
  return ageMs >= thresholdMs;
}

// ─── LOST IN TRANSIT ────────────────────────────────────────────────────

export function shouldFlagLostInTransit(order: OrderSnapshot, now: Date): boolean {
  if (order.status !== 'in_transit') return false;
  if (order.shipped_at === null) return false;
  if (order.lost_notification_sent_at !== null) return false;

  const ageMs = now.getTime() - order.shipped_at.getTime();
  const thresholdMs = LOST_IN_TRANSIT_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= thresholdMs;
}

// ─── RETURN EXPIRY ──────────────────────────────────────────────────────

export function shouldExpireReturn(ret: ReturnSnapshot, now: Date): boolean {
  // Active statuses that can expire if buyer hasn't shipped
  const SHIPPABLE_STATUSES = ['approved', 'awaiting_address', 'label_created'];
  if (!SHIPPABLE_STATUSES.includes(ret.status)) return false;
  if (ret.tracking_number !== null) return false; // buyer has shipped

  const ageMs = now.getTime() - ret.created_at.getTime();
  const thresholdMs = RETURN_SHIPPING_DEADLINE_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= thresholdMs;
}
