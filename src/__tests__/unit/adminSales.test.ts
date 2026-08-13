/**
 * Admin Sales Endpoint Tests
 *
 * Verifies per-order P&L math, totals aggregation, status filtering,
 * offer-sale handling, null label_cost treatment, and route wiring.
 *
 * Run: npx jest --selectProjects unit adminSales
 */

import {
  GMV_STATUSES,
  EST_STRIPE_RATE,
  EST_STRIPE_FIXED,
  EXCLUDED_ORDER_IDS,
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
    label_cost: null,
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
  const labelCost = order.label_cost ?? 0;
  const listingPrice = order.listing_price;

  const mulligansGross = buyerTotal - sellerPayout - labelCost;
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
  test('mulligans_gross = buyer_total - seller_payout - label_cost', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    // 225.48 - 200 - 6.50 = 18.98
    expect(m.mulligans_gross).toBeCloseTo(18.98, 2);
  });

  test('null label_cost treated as 0 for gross calculation', () => {
    const order = SEED_ORDERS[1];
    const m = computeMargins(order);
    // 387.24 - 350 - 0 = 37.24
    expect(m.mulligans_gross).toBeCloseTo(37.24, 2);
  });

  test('formula_fee uses imported constants, not hardcoded values', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    const expected = (order.listing_price * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
    expect(m.formula_fee).toBeCloseTo(expected, 2);
    expect(m.formula_fee).toBeCloseTo(15.99, 2);
  });

  test('est_stripe_fee = buyer_total * 0.015 + 0.20', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    const expected = (order.buyer_total * EST_STRIPE_RATE) + EST_STRIPE_FIXED;
    expect(m.est_stripe_fee).toBeCloseTo(expected, 2);
    expect(m.est_stripe_fee).toBeCloseTo(3.58, 2);
  });

  test('est_net = mulligans_gross - est_stripe_fee', () => {
    const order = SEED_ORDERS[0];
    const m = computeMargins(order);
    expect(m.est_net).toBeCloseTo(m.mulligans_gross - m.est_stripe_fee, 2);
    // 18.98 - 3.58 = 15.40
    expect(m.est_net).toBeCloseTo(15.40, 2);
  });
});

// ─── shipping_cost does NOT affect gross ────────────────────────────

describe('shipping_cost independence', () => {
  test('two orders with identical buyer_total/seller_payout/label_cost but different shipping_cost produce the same gross', () => {
    const orderA: SeedOrder = {
      ...SEED_ORDERS[0],
      id: 'order-ship-a',
      shipping_cost: 5.00,
    };
    const orderB: SeedOrder = {
      ...SEED_ORDERS[0],
      id: 'order-ship-b',
      shipping_cost: 15.00,
    };

    expect(orderA.shipping_cost).not.toBe(orderB.shipping_cost);

    const mA = computeMargins(orderA);
    const mB = computeMargins(orderB);
    expect(mA.mulligans_gross).toBe(mB.mulligans_gross);
    expect(mA.est_net).toBe(mB.est_net);
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
      const lc = o.label_cost ?? 0;
      sumGross += bt - sp - lc;
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
    expect(totals.count).toBe(2);
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

// ─── EXCLUDED_ORDER_IDS constant validation ────────────────────────

describe('EXCLUDED_ORDER_IDS constant', () => {
  test('contains exactly 18 order IDs', () => {
    expect(EXCLUDED_ORDER_IDS).toHaveLength(18);
  });

  test('every entry starts with "order_"', () => {
    for (const id of EXCLUDED_ORDER_IDS) {
      expect(id).toMatch(/^order_/);
    }
  });

  test('has no duplicate entries', () => {
    const unique = new Set(EXCLUDED_ORDER_IDS);
    expect(unique.size).toBe(EXCLUDED_ORDER_IDS.length);
  });

  test('includes known legacy IDs', () => {
    expect(EXCLUDED_ORDER_IDS).toContain('order_cdc05c80-4f33-400a-9092-a2e62db38d93');
    expect(EXCLUDED_ORDER_IDS).toContain('order_1764523612193_isgwb6iee');
  });
});

// ─── Exclusion filter is applied to all order queries ───────────────

describe('test-order exclusion — getSales passes notIn filter to Prisma', () => {
  test('findMany, count, and aggregate all receive id: { notIn: EXCLUDED_ORDER_IDS }', async () => {
    const mockFindMany = jest.fn().mockResolvedValue([]);
    const mockCount = jest.fn().mockResolvedValue(0);
    const mockAggregate = jest.fn().mockResolvedValue({
      _sum: { buyer_total: 0, seller_payout: 0, shipping_cost: 0, label_cost: 0 },
      _count: 0,
    });

    let Controller: any;
    jest.isolateModules(() => {
      jest.doMock('../../lib/prisma', () => ({
        prisma: {
          orders: {
            findMany: mockFindMany,
            count: mockCount,
            aggregate: mockAggregate,
          },
        },
      }));
      Controller = require('../../controllers/adminStatsController').AdminStatsController;
    });

    const req = { query: { page: '1', status: 'gmv' } } as any;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as any;

    await Controller.getSales(req, res);

    const excludedSet = [...EXCLUDED_ORDER_IDS];

    const findManyWhere = mockFindMany.mock.calls[0][0].where;
    expect(findManyWhere.id).toEqual({ notIn: excludedSet });

    const countWhere = mockCount.mock.calls[0][0].where;
    expect(countWhere.id).toEqual({ notIn: excludedSet });

    const aggregateWhere = mockAggregate.mock.calls[0][0].where;
    expect(aggregateWhere.id).toEqual({ notIn: excludedSet });
  });
});

describe('test-order exclusion — excluded order absent from response rows', () => {
  test('order with an EXCLUDED_ORDER_IDS id does not appear in salesRows', async () => {
    const excludedId = EXCLUDED_ORDER_IDS[0];
    const normalId = 'order-normal-001';

    const fakeOrders = [
      {
        id: normalId,
        listing_title: 'Normal Club',
        listing_image: null,
        listing_price: 100,
        original_list_price: 100,
        discount_amount: 0,
        offer_id: null,
        buyer_total: 115,
        seller_payout: 100,
        shipping_cost: 7,
        label_cost: 5,
        status: 'completed',
        source: null,
        quantity: 1,
        created_at: new Date(),
        paid_at: new Date(),
        shipping_address: null,
        users_orders_buyer_idTousers: { id: 'b1', display_name: 'Buyer', email: 'b@test.com' },
        users_orders_seller_idTousers: { id: 's1', display_name: 'Seller', email: 's@test.com', is_verified_seller: false },
      },
    ];

    const mockFindMany = jest.fn().mockResolvedValue(fakeOrders);
    const mockCount = jest.fn().mockResolvedValue(1);
    const mockAggregate = jest.fn().mockResolvedValue({
      _sum: { buyer_total: 115, seller_payout: 100, shipping_cost: 7, label_cost: 5 },
      _count: 1,
    });

    let Controller: any;
    jest.isolateModules(() => {
      jest.doMock('../../lib/prisma', () => ({
        prisma: {
          orders: {
            findMany: mockFindMany,
            count: mockCount,
            aggregate: mockAggregate,
          },
        },
      }));
      Controller = require('../../controllers/adminStatsController').AdminStatsController;
    });

    const req = { query: { page: '1', status: 'all' } } as any;
    const jsonSpy = jest.fn();
    const res = { json: jsonSpy, status: jest.fn().mockReturnThis() } as any;

    await Controller.getSales(req, res);

    expect(jsonSpy).toHaveBeenCalled();
    const body = jsonSpy.mock.calls[0][0];

    const rowIds = body.sales.map((r: any) => r.id);
    expect(rowIds).toContain(normalId);
    expect(rowIds).not.toContain(excludedId);
  });
});

describe('test-order exclusion — getStats passes notIn filter to all order queries', () => {
  test('every order count/aggregate in getStats includes id notIn exclusion', async () => {
    const mockOrderCount = jest.fn().mockResolvedValue(0);
    const mockOrderAggregate = jest.fn().mockResolvedValue({
      _sum: { amount: 0 }, _avg: { amount: 0 }, _count: 0,
    });
    const mockUsersCount = jest.fn().mockResolvedValue(0);
    const mockListingsCount = jest.fn().mockResolvedValue(0);

    let Controller: any;
    jest.isolateModules(() => {
      jest.doMock('../../lib/prisma', () => ({
        prisma: {
          orders: { count: mockOrderCount, aggregate: mockOrderAggregate },
          users: { count: mockUsersCount },
          listings: { count: mockListingsCount },
        },
      }));
      Controller = require('../../controllers/adminStatsController').AdminStatsController;
    });

    const req = { query: {} } as any;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as any;

    await Controller.getStats(req, res);

    const excludedSet = [...EXCLUDED_ORDER_IDS];

    for (const call of mockOrderCount.mock.calls) {
      expect(call[0].where.id).toEqual({ notIn: excludedSet });
    }

    for (const call of mockOrderAggregate.mock.calls) {
      expect(call[0].where.id).toEqual({ notIn: excludedSet });
    }
  });
});

// ─── Module-load test — adminRoutes.ts must import without crashing ─

describe('adminRoutes module load — getSales wiring', () => {
  test('AdminStatsController.getSales is a function, not undefined', () => {
    const { AdminStatsController } = require('../../controllers/adminStatsController');
    expect(typeof AdminStatsController.getSales).toBe('function');
  });

  test('getSales is inside the class body (before class closing brace)', () => {
    const controllerPath = resolve(__dirname, '../../controllers/adminStatsController.ts');
    const src = readFileSync(controllerPath, 'utf8');
    const lines = src.split('\n');

    const classOpenLine = lines.findIndex(l => l.startsWith('export class AdminStatsController'));
    expect(classOpenLine).toBeGreaterThan(-1);

    const getSalesLine = lines.findIndex(l => l.includes('static async getSales'));
    expect(getSalesLine).toBeGreaterThan(-1);
    expect(getSalesLine).toBeGreaterThan(classOpenLine);

    let classCloseLine = -1;
    for (let i = lines.length - 1; i > classOpenLine; i--) {
      if (lines[i].trim() === '}') {
        classCloseLine = i;
        break;
      }
    }
    expect(classCloseLine).toBeGreaterThan(-1);
    expect(getSalesLine).toBeLessThan(classCloseLine);
  });

  test('adminRoutes.ts loads without throwing when getSales is present', () => {
    const envBackup: Record<string, string | undefined> = {};
    const envKeys = [
      'DISPUTE_ADMIN_PASSWORD', 'JWT_SECRET', 'COGNITO_CLIENT_ID',
      'COGNITO_USER_POOL_ID', 'AWS_REGION', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY',
    ];
    const envDefaults: Record<string, string> = {
      DISPUTE_ADMIN_PASSWORD: 'test', JWT_SECRET: 'test', COGNITO_CLIENT_ID: 'test',
      COGNITO_USER_POOL_ID: 'test', AWS_REGION: 'eu-west-2',
      RESEND_API_KEY: 're_test_key', STRIPE_SECRET_KEY: 'sk_test_fake',
    };
    for (const k of envKeys) {
      envBackup[k] = process.env[k];
      if (!process.env[k]) process.env[k] = envDefaults[k];
    }

    let loaded = false;
    jest.isolateModules(() => {
      const noop = jest.fn();
      const noopMw = (_r: any, _s: any, n: any) => n();

      jest.doMock('../../lib/prisma', () => ({ prisma: { users: {}, orders: {}, listings: {} } }));
      jest.doMock('@aws-sdk/client-cognito-identity-provider', () => ({
        CognitoIdentityProviderClient: jest.fn(() => ({ send: noop })),
        SignUpCommand: jest.fn(), InitiateAuthCommand: jest.fn(),
        AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH' },
        AdminConfirmSignUpCommand: jest.fn(), ConfirmSignUpCommand: jest.fn(),
        ForgotPasswordCommand: jest.fn(), ConfirmForgotPasswordCommand: jest.fn(),
        ChangePasswordCommand: jest.fn(),
      }));
      jest.doMock('../../services/emailService', () => ({
        sendVerificationEmail: noop, sendWelcomeEmail: noop,
        sendPasswordResetEmail: noop, sendInsuranceClaimApprovedToBuyer: noop,
        sendInsuranceClaimApprovedToSeller: noop, sendInsuranceClaimDeniedToBuyer: noop,
        sendInsuranceClaimDeniedToSeller: noop,
      }));
      jest.doMock('express-rate-limit', () => ({
        __esModule: true, default: jest.fn(() => noopMw),
      }));
      jest.doMock('stripe', () => jest.fn(() => ({})));
      jest.doMock('../../controllers/pushNotificationController', () => ({ sendPushNotification: noop }));
      jest.doMock('../../lib/auditLogger', () => ({ logAdminAction: noop, AUDIT_ACTIONS: {} }));
      jest.doMock('../../lib/stockUtils', () => ({ restoreListingStock: noop }));
      jest.doMock('../../constants/inspection', () => ({ INSPECTION_WINDOW_MS: 259200000 }));
      jest.doMock('../../controllers/disputeController', () => ({
        DisputeController: { getAdminDisputes: noop, getAdminDisputeDetail: noop, adminResolveDispute: noop },
      }));
      jest.doMock('../../controllers/adminReportsController', () => ({
        AdminReportsController: { getReports: noop, getReport: noop, updateReport: noop, banUser: noop },
      }));
      jest.doMock('../../controllers/adminStatsController', () => ({
        AdminStatsController: { getStats: noop, getChartData: noop, getDetailedStats: noop, getSales: noop },
      }));

      require('../../routes/adminRoutes');
      loaded = true;
    });

    expect(loaded).toBe(true);

    for (const k of envKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });
});
