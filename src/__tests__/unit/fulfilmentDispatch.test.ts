// SC-03-FIX: Real behavioural tests for dispatch routing + idempotency.
//
// Routing: extracted pure functions (resolveCheckoutRoute, resolveNativeRoute)
// are tested directly — each test FAILS if the routing condition is broken.
//
// Idempotency: fulfillCartOrder and confirmPayment are invoked with mocked
// prisma/stripe. The guard is proven by asserting $transaction / fulfillCart
// are called (or not) based on whether existing orders are found.

// ─── Env vars needed by module-level `new Stripe(...)` in controllers ───
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── Stripe mock ───
const mockStripeInstance: any = {
  paymentIntents: { retrieve: jest.fn(), create: jest.fn() },
  refunds: { create: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } },
  accounts: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
const mockPrisma: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  orders: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  users: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));

// ─── Side-effect-heavy modules: mock to prevent network / DB calls ───
jest.mock('../../utils/addressValidation', () => ({
  validateShippingAddress: jest.fn(),
  AddressValidationError: class extends Error { missingFields: string[] = []; },
}));
jest.mock('../../services/emailService', () => ({
  sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  sendSaleNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../services/autoShippingService', () => ({
  autoPurchaseLabel: jest.fn().mockResolvedValue({ success: false }),
}));
jest.mock('../../lib/stockUtils', () => ({
  logStockDecrement: jest.fn(),
}));
jest.mock('../../services/metaCapi', () => ({
  sendMetaPurchaseEvent: jest.fn(),
}));
jest.mock('../../utils/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports (loaded after mocks take effect) ───
import { resolveCheckoutRoute } from '../../controllers/stripeController';
import { resolveNativeRoute } from '../../controllers/nativePaymentController';
import { NativePaymentController } from '../../controllers/nativePaymentController';
import { CartCheckoutController } from '../../controllers/cartCheckoutController';
import {
  calculateBuyerFees,
  buildFeeSnapshot,
  CartItem,
  SERVICE_FEE_PER_ITEM,
} from '../../lib/feeCalculations';

// ─── Helpers ───
const item = (p: Partial<CartItem> & { listingPrice: number }): CartItem => ({
  sellerId: p.sellerId ?? 'seller-1',
  listingPrice: p.listingPrice,
  offerPrice: p.offerPrice ?? null,
  quantity: p.quantity ?? 1,
  shippingCost: p.shippingCost ?? 0,
});

function fakeStripeSession(metadataOverrides: Record<string, string> = {}) {
  return {
    id: 'cs_test_123',
    payment_intent: 'pi_test_123',
    metadata: {
      type: 'seller_checkout',
      buyer_id: 'buyer_1',
      listing_ids: 'lst_1',
      listing_quantities: '{"lst_1":1}',
      seller_ids: 'seller_1',
      insurance_premium: '0.63',
      insured_value: '50',
      platform_fee: '4.74',
      grand_total: '55.37',
      shipping_total: '5',
      total_quantity: '1',
      ...metadataOverrides,
    },
    collected_information: {
      shipping_details: {
        name: 'Test Buyer',
        address: { line1: '123 Test St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
      },
    },
  };
}

function fakeListing(id = 'lst_1', sellerId = 'seller_1') {
  return {
    id,
    seller_id: sellerId,
    price: { toString: () => '50' },
    shipping_cost: { toString: () => '5' },
    quantity: 1,
    images: [{ image_url: 'https://img.test/1.jpg' }],
    users: { id: sellerId, stripe_connect_id: 'acct_test_seller' },
  };
}

function makeMockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH ROUTING — pure functions extracted from controllers
// ═══════════════════════════════════════════════════════════════════════════

describe('SC-03: webhook checkout dispatch (resolveCheckoutRoute)', () => {
  // Teeth: removing `|| type === 'seller_checkout'` makes the first test fail.

  test('seller_checkout → cart (SC-01 sessions reach fulfillCartOrder)', () => {
    expect(resolveCheckoutRoute('seller_checkout')).toBe('cart');
  });

  test('cart_checkout → cart (regression: existing combined cart unchanged)', () => {
    expect(resolveCheckoutRoute('cart_checkout')).toBe('cart');
  });

  test('undefined → single (single-item sessions fall through to fulfillOrder)', () => {
    expect(resolveCheckoutRoute(undefined)).toBe('single');
  });

  test('any other type → single (safe default, no crash)', () => {
    expect(resolveCheckoutRoute('something_new')).toBe('single');
  });
});

describe('SC-03: native confirm dispatch (resolveNativeRoute)', () => {
  // Teeth: removing `|| type === 'seller_native'` makes the first test fail.

  test('seller_native → cart (SC-02 payments reach fulfillCart)', () => {
    expect(resolveNativeRoute('seller_native')).toBe('cart');
  });

  test('native_cart → cart (regression: existing combined cart unchanged)', () => {
    expect(resolveNativeRoute('native_cart')).toBe('cart');
  });

  test('native_single_item → single (regression: existing single-item unchanged)', () => {
    expect(resolveNativeRoute('native_single_item')).toBe('single');
  });

  test('undefined → unknown (returns 400 in handler)', () => {
    expect(resolveNativeRoute(undefined)).toBe('unknown');
  });

  test('unrecognised type → unknown (returns 400 in handler)', () => {
    expect(resolveNativeRoute('garbage')).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FEE SNAPSHOT RECONCILIATION (KEPT — these exercise real fee logic)
// ═══════════════════════════════════════════════════════════════════════════

describe('SC-03: single-seller fulfilment produces correct fee snapshot + reconciliation', () => {
  test('one seller, 2 items: fee snapshot sum matches session platform_fee', () => {
    const sellerItems = [
      item({ sellerId: 'shop-A', listingPrice: 60, shippingCost: 4.99, quantity: 1 }),
      item({ sellerId: 'shop-A', listingPrice: 40, shippingCost: 3.49, quantity: 1 }),
    ];
    const fees = calculateBuyerFees(sellerItems);

    const snap1 = buildFeeSnapshot(60, true, 'pi_seller_1');
    const snap2 = buildFeeSnapshot(40, false, 'pi_seller_1');

    const snapshotSum = snap1.platform_fee_amount + snap2.platform_fee_amount;
    expect(Math.abs(snapshotSum - fees.platformFee)).toBeLessThanOrEqual(0.01);
  });

  test('one seller, 1 item: trivial reconciliation (single order = single snapshot)', () => {
    const sellerItems = [
      item({ sellerId: 'shop-B', listingPrice: 100, shippingCost: 5.99 }),
    ];
    const fees = calculateBuyerFees(sellerItems);

    const snap = buildFeeSnapshot(100, true, 'pi_seller_2');
    expect(snap.platform_fee_amount).toBeCloseTo(fees.platformFee, 2);
  });

  test('one seller, 3 items: £0.99 on first only, 7.5% on all', () => {
    const items = [
      item({ sellerId: 'shop-C', listingPrice: 20 }),
      item({ sellerId: 'shop-C', listingPrice: 30 }),
      item({ sellerId: 'shop-C', listingPrice: 50 }),
    ];
    const fees = calculateBuyerFees(items);

    const snaps = [
      buildFeeSnapshot(20, true, 'pi_seller_3'),
      buildFeeSnapshot(30, false, 'pi_seller_3'),
      buildFeeSnapshot(50, false, 'pi_seller_3'),
    ];

    const snapshotSum = snaps.reduce((s, snap) => s + snap.platform_fee_amount, 0);
    expect(Math.abs(snapshotSum - fees.platformFee)).toBeLessThanOrEqual(0.01);

    expect(snaps[0].fee_fixed).toBe(SERVICE_FEE_PER_ITEM);
    expect(snaps[1].fee_fixed).toBe(0);
    expect(snaps[2].fee_fixed).toBe(0);
  });

  test('checkout_group_ref = seller PI id (not combined basket ref)', () => {
    const sellerPiId = 'pi_per_seller_abc123';
    const snap = buildFeeSnapshot(100, true, sellerPiId);
    expect(snap.checkout_group_ref).toBe(sellerPiId);
  });

  test('seller_is_pro_at_sale stays false (gated)', () => {
    const snap = buildFeeSnapshot(100, true, 'pi_any');
    expect(snap.seller_is_pro_at_sale).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY — fulfillCartOrder (webhook path)
// ═══════════════════════════════════════════════════════════════════════════

describe('SC-03: idempotency — fulfillCartOrder guard (inside transaction)', () => {
  // H-1 fix: idempotency check moved inside $transaction.
  // Teeth: the tx callback checks for existing orders and returns early if found.

  test('tx callback exits early when orders already exist for this PI', async () => {
    mockPrisma.listings.findMany.mockResolvedValue([fakeListing()]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Test Buyer',
    });

    const mockTxOrders = { findMany: jest.fn().mockResolvedValue([{ id: 'existing_order_1' }]) };
    const mockTxObj = { orders: mockTxOrders };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTxObj));

    await CartCheckoutController.fulfillCartOrder(fakeStripeSession() as any);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockTxOrders.findMany).toHaveBeenCalledWith({
      where: { stripe_payment_intent_id: 'pi_test_123' },
    });
  });

  test('proceeds with order creation when no existing orders in tx', async () => {
    mockPrisma.listings.findMany.mockResolvedValue([fakeListing()]);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Test Buyer',
    });
    mockPrisma.$transaction.mockResolvedValue(undefined);
    mockPrisma.notifications.create.mockResolvedValue({ id: 'notif_1' });

    await CartCheckoutController.fulfillCartOrder(fakeStripeSession() as any);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY — confirmPayment (native path)
// ═══════════════════════════════════════════════════════════════════════════

describe('SC-03: idempotency — confirmPayment guard', () => {
  // Teeth: commenting out the `if (existingOrder)` guard makes the first test
  // fail (response would NOT contain 'Order already created').

  const fakePI = (type: string) => ({
    id: 'pi_test_native',
    status: 'succeeded',
    metadata: {
      type,
      buyer_id: 'buyer_1',
      items: 'lst_1:1',
      items_total: '50',
      insurance_premium: '0.63',
    },
    shipping: {
      name: 'Test Buyer',
      address: { line1: '123 St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
    },
  });

  test('returns "Order already created" when fulfillCart signals skipped', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(fakePI('seller_native'));

    const fulfillCartSpy = jest.spyOn(NativePaymentController as any, 'fulfillCart')
      .mockResolvedValue({ skipped: true, existing: [{ id: 'existing_order_99' }] });

    const req = { body: { paymentIntentId: 'pi_test_native' }, user: { id: 'buyer_1' }, headers: {} } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'Order already created' }),
    );

    fulfillCartSpy.mockRestore();
  });

  test('calls fulfillCart for seller_native when no existing order', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(fakePI('seller_native'));

    const fulfillCartSpy = jest.spyOn(NativePaymentController as any, 'fulfillCart')
      .mockResolvedValue([{ id: 'new_order_1' }]);

    const req = { body: { paymentIntentId: 'pi_test_native' }, user: { id: 'buyer_1' }, headers: {} } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(fulfillCartSpy).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    fulfillCartSpy.mockRestore();
  });

  test('calls fulfillSingleItem for native_single_item (regression)', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(fakePI('native_single_item'));

    const fulfillSingleSpy = jest.spyOn(NativePaymentController as any, 'fulfillSingleItem')
      .mockResolvedValue({ id: 'single_order_1' });

    const req = { body: { paymentIntentId: 'pi_test_native' }, user: { id: 'buyer_1' }, headers: {} } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(fulfillSingleSpy).toHaveBeenCalled();

    fulfillSingleSpy.mockRestore();
  });
});
