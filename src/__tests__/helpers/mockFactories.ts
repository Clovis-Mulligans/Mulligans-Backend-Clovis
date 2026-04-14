// Shared mock/snapshot factories for Brief 8B tests.

import type { OrderSnapshot, DisputeSnapshot, ReturnSnapshot } from '../../lib/escrowDecisions';
import type { ListingSnapshot, CartItemSnapshot } from '../../lib/cartValidation';

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

export function hoursAgo(h: number, from: Date = new Date('2026-04-14T10:00:00Z')): Date {
  return new Date(from.getTime() - h * 60 * 60 * 1000);
}

export function daysAgo(d: number, from: Date = new Date('2026-04-14T10:00:00Z')): Date {
  return hoursAgo(d * 24, from);
}

export function daysFromNow(d: number, from: Date = new Date('2026-04-14T10:00:00Z')): Date {
  return new Date(from.getTime() + d * 24 * 60 * 60 * 1000);
}

export function makeOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: nextId('order'),
    status: 'to_ship',
    auto_cancel_at: null,
    escrow_release_at: null,
    shipped_at: null,
    delivered_at: null,
    refunded_at: null,
    stripe_transfer_id: null,
    stripe_refund_id: null,
    lost_notification_sent_at: null,
    label_auto_generated: false,
    label_cost: null,
    shipping_cost: 0,
    item_price: 100,
    quantity: 1,
    ...overrides,
  };
}

export function makeDispute(overrides: Partial<DisputeSnapshot> = {}): DisputeSnapshot {
  return {
    status: 'open',
    created_at: daysAgo(1),
    seller_response_type: null,
    ...overrides,
  };
}

export function makeReturn(overrides: Partial<ReturnSnapshot> = {}): ReturnSnapshot {
  return {
    status: 'approved',
    created_at: daysAgo(1),
    tracking_number: null,
    ...overrides,
  };
}

export function makeListing(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    id: nextId('listing'),
    status: 'active',
    seller_id: 'seller-1',
    quantity: 1,
    ...overrides,
  };
}

export function makeCartItem(overrides: Partial<CartItemSnapshot> = {}): CartItemSnapshot {
  return {
    listing_id: nextId('listing'),
    user_id: 'buyer-1',
    quantity: 1,
    created_at: hoursAgo(1),
    expires_at: null,
    ...overrides,
  };
}
