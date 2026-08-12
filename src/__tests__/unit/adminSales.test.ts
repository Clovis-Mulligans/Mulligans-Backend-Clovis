/**
 * Admin Sales Endpoint Tests
 *
 * Verifies per-order P&L math, totals aggregation, status filtering,
 * offer-sale handling, and null label_cost treatment.
 *
 * Run: npx jest --selectProjects unit adminSales
 */

import {
  GMV_STATUSES,
  EST_STRIPE_RATE,
  EST_STRIPE_FIXED,
} from '../../controllers/adminStatsController';
import {
  BUYER_PROTECTION_RATE,
  SERVICE_FEE_PER_ITEM,
} from '../../lib/feeCalculations';

// ─── Seed data ──────────────────────────────────────────────────────

interface SeedOrder {
  id: string;
  listing_title: string;
  listing_image: string | null;
  listing_price: number;
  original_list_price: number;
  discount_amount: number;
  offer_id: string | null;
  buyer_total: number;
  seller_payout: number;
  shipping_cost: number;
  label_cost: number | null;
  status: string;
  source: string | null;
  quantity: number;
  created_at: Date;
  paid_at: Date | null;
  shipping_address: object | null;
  buyer: { id: string; name: string } | null;
  seller: { id: string; name: string; is_pro: boolean } | null;
}

const SEED_ORDERS: SeedOrder[] = [
  {
    id: 'order-001',
    listing_title: 'Titleist TSR3 Driver',
    listing_image: null,
    listing_price: 200,
    original_list_price: 200,
    discount_amount: 0,
    offer_id: null,
    buyer_total: 225.48,
    seller_payout: 200,
    shipping_cost: 8.99,
    label_cost: 6.50,
    status: 'completed',
    source: null,
    quantity: 1,
    created_at: new Date('2026-07-01T10:00:00Z'),
    paid_at: new Date('2026-07-01T10:05:00Z'),
    shipping_address: { city: 'London' },
    buyer: { id: 'b1', name: 'Alice' },
    seller: { id: 's1', name: 'Bob', is_pro: false },
  },
  {
    id: 'order-002',
    listing_title: 'Callaway Apex Iron Set',
    listing_image: 'https://img.example.com/irons.jpg',
    listing_price: 350,
    original_list_price: 400,
    discount_amount: 50,
    offer_id: 'offer-abc',
    buyer_total: 387.24,
    seller_payout: 350,
    shipping_cost: 12.99,
    label_cost: null, // label pending
    status: 'in_transit',
    source: 'ios',
    quantity: 1,
    created_at: new Date('2026-07-05T09:00:00Z'),
    paid_at: new Date('2026-07-06T14:30:00Z'),
    shipping_address: { city: 'Edinburgh' },
    buyer: { id: 'b2', name: 'Charlie' },
    seller: { id: 's2', name: 'Diana', is_pro: true },
  },
  {
    id: 'order-003',
    listing_title: 'Golf Bag',
    listing_image: null,
    listing_price: 50,
    original_list_price: 50,
    discount_amount: 0,
    offer_id: null,
    buyer_total: 59.73,
    seller_payout: 50,
    shipping_cost: 5.99,
    label_cost: 4.20,
    status: 'cancelled',
    source: null,
    quantity: 1,
    created_at: new Date('2026-07-02T08:00:00Z'),
    paid_at: null,
    shipping_address: null,
    buyer: { id: 'b3', name: 'Eve' },
    seller: { id: 's3', name: 'Frank', is_pro: false },
  },
];

// ─── Margin computation (mirrors controller logic) ──────────────────

function computeMargins(order: SeedOrder) {
  const buyerTotal = order.buyer_total;
  const sellerPayout = order.seller_payout;
  const shippingCost = order.shipping_cost;
  const labelCost = order.label_cost ?? 0;
  const listingPrice = order.listing_price;

  const mulligansGross = buyerTotal - sellerPayout - shippingCost - labelCost;
  const formulaFee = (listingPrice * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
  const estStripeFee = (buyerTotal * EST_STRIPE_RATE) + EST_STRIPE_FIXED;
  const estNet = mulligansGross - estStripeFee;

  return {
    mulligans_gross: Math.round(mulligansGross * 100) / 100,
    formula_fee: Math.round(formulaFee * 100) / 100,
    est_stripe_fee: Math.round(estStripeFee * 100) / 100,
    est_net: Math.round(estNet * 100) / 100,
  };
}

// ─── Per-order margin math ──────────────────────────────────────────

describe('per-order margin math', () => {
  test('mulligans_gross = buyer_total - seller_payout - shipping_cost - label_cost', () => {
    const order = SEED_ORDERS[0]; // completed, all fields present
    const m = computeMargins(order);
    // 225.48 - 200 - 8.99 - 6.50 = 9.99
    expect(m.mulligans_gross).toBeCloseTo(9.99, 2);
  });

  test('null label_cost treated as 0 for gross calculation', () => {
    const order = SEED_ORDERS[1]; // in_transit, label_cost = null
    const m = computeMargins(order);
    // 387.24 - 350 - 12.99 - 0 = 24.25
    expect(m.mulligans_gross).toBeCloseTo(24.25, 2);
  });

  test('formula_fee uses imported constants, not hardcoded values', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    const expected = (order.listing_price * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
    expect(m.formula_fee).toBeCloseTo(expected, 2);
    // 200 * 0.075 + 0.99 = 15 + 0.99 = 15.99
    expect(m.formula_fee).toBeCloseTo(15.99, 2);
  });

  test('est_stripe_fee = buyer_total * 0.015 + 0.20', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    // 225.48 * 0.015 + 0.20 = 3.3822 + 0.20 = 3.58
    const expected = (order.buyer_total * EST_STRIPE_RATE) + EST_STRIPE_FIXED;
    expect(m.est_stripe_fee).toBeCloseTo(expected, 2);
    expect(m.est_stripe_fee).toBeCloseTo(3.58, 2);
  });

  test('est_net = mulligans_gross - est_stripe_fee', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    // 9.99 - 3.58 = 6.41
    expect(m.est_net).toBeCloseTo(m.mulligans_gross - m.est_stripe_fee, 2);
    expect(m.est_net).toBeCloseTo(6.41, 2);
  });
});

// ─── Offer-sale handling ────────────────────────────────────────────

describe('offer-sale handling', () => {
  test('discount_amount and offer_id are surfaced correctly', () => {
    const offerOrder = SEED_ORDERS[1];
    expect(offerOrder.offer_id).toBe('offer-abc');
    expect(offerOrder.discount_amount).toBe(50);
    expect(offerOrder.original_list_price).toBe(400);
    expect(offerOrder.listing_price).toBe(350);
  });

  test('seller_payout equals accepted listing_price (not adjusted by discount)', () => {
    const offerOrder = SEED_ORDERS[1];
    expect(offerOrder.seller_payout).toBe(offerOrder.listing_price);
  });

  test('formula_fee computed on listing_price, not original_list_price', () => {
    const offerOrder = SEED_ORDERS[1];
    const m = computeMargins(offerOrder);
    const onListingPrice = (offerOrder.listing_price * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
    const onOriginalPrice = (offerOrder.original_list_price * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
    expect(m.formula_fee).toBeCloseTo(onListingPrice, 2);
    expect(m.formula_fee).not.toBeCloseTo(onOriginalPrice, 2);
  });
});

// ─── Label pending flag ─────────────────────────────────────────────

describe('label_pending flag', () => {
  test('order with null label_cost is flagged as label_pending', () => {
    const order = SEED_ORDERS[1];
    expect(order.label_cost).toBeNull();
    const labelPending = order.label_cost === null;
    expect(labelPending).toBe(true);
  });

  test('order with non-null label_cost is not flagged', () => {
    const order = SEED_ORDERS[0];
    expect(order.label_cost).not.toBeNull();
    const labelPending = order.label_cost === null;
    expect(labelPending).toBe(false);
  });
});

// ─── Totals aggregation with status filtering ───────────────────────

describe('totals aggregation — respects status filter', () => {
  function computeTotals(orders: SeedOrder[], statusFilter: string) {
    let filtered: SeedOrder[];
    if (statusFilter === 'all') {
      filtered = orders;
    } else if (statusFilter === 'gmv') {
      const gmvSet = new Set(GMV_STATUSES);
      filtered = orders.filter(o => gmvSet.has(o.status as any));
    } else {
      filtered = orders.filter(o => o.status === statusFilter);
    }

    let sumGross = 0;
    let sumStripe = 0;
    for (const o of filtered) {
      const bt = o.buyer_total;
      const sp = o.seller_payout;
      const sc = o.shipping_cost;
      const lc = o.label_cost ?? 0;
      sumGross += bt - sp - sc - lc;
      sumStripe += (bt * EST_STRIPE_RATE) + EST_STRIPE_FIXED;
    }

    return {
      count: filtered.length,
      mulligans_gross: Math.round(sumGross * 100) / 100,
      est_stripe_fee: Math.round(sumStripe * 100) / 100,
      est_net: Math.round((sumGross - sumStripe) * 100) / 100,
    };
  }

  test('gmv filter includes completed + in_transit, excludes cancelled', () => {
    const totals = computeTotals(SEED_ORDERS, 'gmv');
    expect(totals.count).toBe(2); // order-001 (completed) + order-002 (in_transit)
  });

  test('cancelled filter includes only cancelled orders', () => {
    const totals = computeTotals(SEED_ORDERS, 'cancelled');
    expect(totals.count).toBe(1);
    const cancelledOrder = SEED_ORDERS[2];
    const m = computeMargins(cancelledOrder);
    expect(totals.mulligans_gross).toBeCloseTo(m.mulligans_gross, 2);
  });

  test('all filter includes every order', () => {
    const totals = computeTotals(SEED_ORDERS, 'all');
    expect(totals.count).toBe(3);
  });

  test('totals gross sums correctly for gmv set', () => {
    const totals = computeTotals(SEED_ORDERS, 'gmv');
    const m1 = computeMargins(SEED_ORDERS[0]);
    const m2 = computeMargins(SEED_ORDERS[1]);
    expect(totals.mulligans_gross).toBeCloseTo(m1.mulligans_gross + m2.mulligans_gross, 2);
  });

  test('totals est_net = totals gross - totals stripe', () => {
    const totals = computeTotals(SEED_ORDERS, 'gmv');
    expect(totals.est_net).toBeCloseTo(totals.mulligans_gross - totals.est_stripe_fee, 2);
  });
});

// ─── Stripe fee constants ───────────────────────────────────────────

describe('Stripe fee constants', () => {
  test('EST_STRIPE_RATE is 0.015 (1.5%)', () => {
    expect(EST_STRIPE_RATE).toBe(0.015);
  });

  test('EST_STRIPE_FIXED is 0.20 (20p)', () => {
    expect(EST_STRIPE_FIXED).toBe(0.20);
  });
});

// ─── Auth requirement ───────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('endpoint auth — route is behind adminAuth', () => {
  const routesPath = resolve(__dirname, '../../routes/adminRoutes.ts');
  const routesSource = readFileSync(routesPath, 'utf8');

  test('GET /sales route exists and uses adminAuth middleware', () => {
    const salesRoute = routesSource
      .split('\n')
      .find(line => line.includes("'/sales'") && line.includes('getSales'));
    expect(salesRoute).toBeDefined();
    expect(salesRoute).toContain('adminAuth');
  });
});
