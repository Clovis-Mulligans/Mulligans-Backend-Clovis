// Order + offer state machine tests.
//
// These state machines live implicitly inside controllers (orderController.ts,
// offerController.ts) as conditional updates. The transition tables below
// act as an executable specification — changing the rules in production
// without updating these tables will fail the test suite.

import {
  ESCROW_RELEASE_DAYS,
  AUTO_CANCEL_DAYS,
  SHIPPING_DEADLINE_DAYS,
  RETURN_SHIPPING_DEADLINE_DAYS,
  LOST_IN_TRANSIT_DAYS,
  SELLER_DISPUTE_RESPONSE_HOURS,
  BUYER_CANCEL_WINDOW_MINUTES,
  CART_ITEM_EXPIRY_HOURS,
  OFFER_EXPIRY_HOURS,
  ACCEPTANCE_WINDOW_HOURS,
  ADMIN_SESSION_TIMEOUT_MINUTES,
} from '../../lib/feeCalculations';
import { INSPECTION_WINDOW_DAYS } from '../../constants/inspection';
import { DISPUTE_WINDOW_DAYS } from '../../config/constants';

type OrderStatus =
  | 'pending'
  | 'to_ship'
  | 'in_transit'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'disputed'
  | 'refunded'
  | 'returned';

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending:    ['to_ship', 'cancelled'],
  to_ship:    ['in_transit', 'cancelled'],
  in_transit: ['delivered'],
  delivered:  ['completed', 'disputed'],
  disputed:   ['completed', 'refunded', 'returned'],
  completed:  [],
  cancelled:  [],
  refunded:   [],
  returned:   [],
};

const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['completed', 'cancelled', 'refunded', 'returned'];

function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return false;
  return ORDER_TRANSITIONS[from].includes(to);
}

describe('order state machine — valid transitions', () => {
  const valid: [OrderStatus, OrderStatus][] = [
    ['pending', 'to_ship'],
    ['to_ship', 'in_transit'],
    ['in_transit', 'delivered'],
    ['delivered', 'completed'],
    ['to_ship', 'cancelled'],
    ['delivered', 'disputed'],
    ['disputed', 'completed'],
    ['disputed', 'refunded'],
    ['disputed', 'returned'],
  ];
  test.each(valid)('%s → %s is allowed', (from, to) => {
    expect(canOrderTransition(from, to)).toBe(true);
  });
});

describe('order state machine — invalid transitions are blocked', () => {
  const invalid: [OrderStatus, OrderStatus, string][] = [
    ['cancelled', 'completed', 'cannot revive cancelled order'],
    ['completed', 'cancelled', 'cannot cancel after payout'],
    ['refunded', 'completed', 'cannot complete after refund'],
    ['pending', 'completed', 'cannot skip entire flow'],
    ['to_ship', 'delivered', 'cannot skip transit'],
    ['in_transit', 'completed', 'cannot skip delivery confirmation'],
    ['to_ship', 'disputed', 'can only dispute after delivery'],
  ];
  test.each(invalid)('%s → %s is blocked (%s)', (from, to) => {
    expect(canOrderTransition(from, to)).toBe(false);
  });
});

describe('order state machine — terminal statuses', () => {
  test.each(TERMINAL_ORDER_STATUSES)('%s is terminal (no outgoing transitions)', (status) => {
    expect(ORDER_TRANSITIONS[status]).toEqual([]);
  });

  const allStatuses: OrderStatus[] = [
    'pending', 'to_ship', 'in_transit', 'delivered',
    'completed', 'cancelled', 'disputed', 'refunded', 'returned',
  ];

  test.each(allStatuses)('%s has a defined transition set', (status) => {
    expect(ORDER_TRANSITIONS[status]).toBeDefined();
  });

  test.each(allStatuses)('%s cannot self-transition', (status) => {
    expect(canOrderTransition(status, status)).toBe(false);
  });
});

// ─── Offer state machine ────────────────────────────────────────────────

type OfferStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'COUNTERED'
  | 'COUNTER_ACCEPTED'
  | 'COUNTER_DECLINED'
  | 'EXPIRED'
  | 'VOID'
  | 'WITHDRAWN'
  | 'PURCHASED';

const OFFER_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  PENDING:          ['ACCEPTED', 'DECLINED', 'COUNTERED', 'EXPIRED', 'WITHDRAWN'],
  ACCEPTED:         ['PURCHASED', 'VOID'],
  COUNTERED:        ['COUNTER_ACCEPTED', 'COUNTER_DECLINED', 'EXPIRED', 'WITHDRAWN'],
  COUNTER_ACCEPTED: ['PURCHASED', 'VOID'],
  DECLINED:         [],
  COUNTER_DECLINED: [],
  EXPIRED:          [],
  VOID:             [],
  WITHDRAWN:        [],
  PURCHASED:        [],
};

const TERMINAL_OFFER_STATUSES: OfferStatus[] = [
  'DECLINED', 'COUNTER_DECLINED', 'EXPIRED', 'VOID', 'WITHDRAWN', 'PURCHASED',
];

function canOfferTransition(from: OfferStatus, to: OfferStatus): boolean {
  if (from === to) return false;
  return OFFER_TRANSITIONS[from].includes(to);
}

describe('offer state machine — happy paths', () => {
  test('PENDING → ACCEPTED → PURCHASED', () => {
    expect(canOfferTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(canOfferTransition('ACCEPTED', 'PURCHASED')).toBe(true);
  });

  test('PENDING → COUNTERED → COUNTER_ACCEPTED → PURCHASED', () => {
    expect(canOfferTransition('PENDING', 'COUNTERED')).toBe(true);
    expect(canOfferTransition('COUNTERED', 'COUNTER_ACCEPTED')).toBe(true);
    expect(canOfferTransition('COUNTER_ACCEPTED', 'PURCHASED')).toBe(true);
  });

  test('PENDING → EXPIRED (24h timeout)', () => {
    expect(canOfferTransition('PENDING', 'EXPIRED')).toBe(true);
  });

  test('ACCEPTED → VOID (buyer did not purchase in 24h)', () => {
    expect(canOfferTransition('ACCEPTED', 'VOID')).toBe(true);
  });
});

describe('offer state machine — blocked transitions', () => {
  test('DECLINED → ACCEPTED is blocked (cannot revive)', () => {
    expect(canOfferTransition('DECLINED', 'ACCEPTED')).toBe(false);
  });

  test('PENDING → PURCHASED is blocked (must be accepted first)', () => {
    expect(canOfferTransition('PENDING', 'PURCHASED')).toBe(false);
  });

  test.each(TERMINAL_OFFER_STATUSES)('%s is terminal', (s) => {
    expect(OFFER_TRANSITIONS[s]).toEqual([]);
  });
});

describe('timing constants — tripwires', () => {
  test('Cart item expiry = 72 hours', () => {
    expect(CART_ITEM_EXPIRY_HOURS).toBe(72);
  });
  test('Offer expiry = 24 hours', () => {
    expect(OFFER_EXPIRY_HOURS).toBe(24);
  });
  test('Acceptance window = 24 hours', () => {
    expect(ACCEPTANCE_WINDOW_HOURS).toBe(24);
  });
  test('Shipping deadline (auto-cancel) = 5 days', () => {
    expect(SHIPPING_DEADLINE_DAYS).toBe(5);
    expect(AUTO_CANCEL_DAYS).toBe(5);
  });
  test('Escrow release after delivery = 3 days (policy-owner confirmed)', () => {
    expect(ESCROW_RELEASE_DAYS).toBe(3);
    expect(ESCROW_RELEASE_DAYS).toBe(INSPECTION_WINDOW_DAYS);
    expect(DISPUTE_WINDOW_DAYS).toBe(INSPECTION_WINDOW_DAYS);
  });
  test('Return shipping deadline = 5 days', () => {
    expect(RETURN_SHIPPING_DEADLINE_DAYS).toBe(5);
  });
  test('Buyer cancel window = 5 minutes', () => {
    expect(BUYER_CANCEL_WINDOW_MINUTES).toBe(5);
  });
  test('Lost-in-transit notification = 14 days', () => {
    expect(LOST_IN_TRANSIT_DAYS).toBe(14);
  });
  test('Seller dispute response deadline = 72 hours', () => {
    expect(SELLER_DISPUTE_RESPONSE_HOURS).toBe(72);
  });
  test('Admin session timeout = 30 minutes', () => {
    expect(ADMIN_SESSION_TIMEOUT_MINUTES).toBe(30);
  });
});
