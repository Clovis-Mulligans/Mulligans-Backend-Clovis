// SC-05: Full per-seller checkout end-to-end test pass.
//
// Proves SC-01..SC-04 work together: creation → fulfilment → orders with
// correct fee snapshots → reconciliation → partial cart-clear.
// Every test invokes real code; no tautologies.

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
const mockTx: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  orders: { create: jest.fn(), findMany: jest.fn() },
  cart_items: { deleteMany: jest.fn() },
  offers: { update: jest.fn() },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};
const mockPrisma: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn() },
  orders: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  users: { findUnique: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));

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
jest.mock('../../lib/stockUtils', () => ({ logStockDecrement: jest.fn() }));
jest.mock('../../services/metaCapi', () => ({ sendMetaPurchaseEvent: jest.fn() }));
jest.mock('../../utils/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

import { CartCheckoutController } from '../../controllers/cartCheckoutController';
import { NativePaymentController } from '../../controllers/nativePaymentController';
import { resolveCheckoutRoute } from '../../controllers/stripeController';
import { resolveNativeRoute } from '../../controllers/nativePaymentController';
import { calculateBuyerFees, CartItem as FeeCartItem, SERVICE_FEE_PER_ITEM } from '../../lib/feeCalculations';

// ─── Fixtures ───
function makeCartItem(
  id: string, listingId: string, sellerId: string,
  price: number, shippingCost: number, qty = 1,
) {
  return {
    id,
    user_id: 'buyer_1',
    listing_id: listingId,
    quantity: qty,
    selected_size: null,
    offer_price: null,
    expires_at: new Date(Date.now() + 86400000),
    listings: {
      id: listingId,
      seller_id: sellerId,
      title: `Item ${listingId}`,
      price: { toString: () => String(price) },
      shipping_cost: { toString: () => String(shippingCost) },
      status: 'active',
      quantity: 10,
      size_quantities: null,
      images: [{ image_url: `https://img.test/${listingId}.jpg` }],
      users: {
        id: sellerId,
        email: `${sellerId}@test.com`,
        display_name: `Shop ${sellerId}`,
        stripe_connect_id: `acct_${sellerId}`,
        stripe_connect_status: 'active',
      },
    },
  };
}

function makeFulfilmentListing(listingId: string, sellerId: string, price: number, shippingCost: number) {
  return {
    id: listingId,
    seller_id: sellerId,
    title: `Item ${listingId}`,
    price: { toString: () => String(price) },
    shipping_cost: { toString: () => String(shippingCost) },
    quantity: 10,
    size_quantities: null,
    images: [{ image_url: `https://img.test/${listingId}.jpg` }],
    users: { id: sellerId, stripe_connect_id: `acct_${sellerId}` },
  };
}

const SELLER_A_CART = [
  makeCartItem('ci_a1', 'lst_a1', 'seller_A', 60, 4.99),
  makeCartItem('ci_a2', 'lst_a2', 'seller_A', 40, 3.49),
];
const SELLER_B_CART = [
  makeCartItem('ci_b1', 'lst_b1', 'seller_B', 80, 5.99),
];
const ALL_CART = [...SELLER_A_CART, ...SELLER_B_CART];

const SHIPPING_ADDRESS = {
  name: 'Test Buyer',
  address: { line1: '123 Test St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
};

function makeMockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  return res;
}

function setupTxMock(listings: any[]) {
  Object.values(mockTx).forEach((model: any) => {
    if (typeof model === 'object') {
      Object.values(model).forEach((fn: any) => {
        if (typeof fn?.mockReset === 'function') fn.mockReset();
      });
    }
  });
  mockTx.$queryRawUnsafe.mockReset();
  mockTx.$queryRawUnsafe.mockResolvedValue([]);
  mockTx.listings.findUnique.mockImplementation(({ where }: any) =>
    listings.find(l => l.id === where.id) || null);
  mockTx.listings.findMany.mockResolvedValue(
    listings.map(l => ({ id: l.id, seller_id: l.seller_id, shipping_cost: l.shipping_cost })));
  mockTx.listings.update.mockResolvedValue({});
  mockTx.listings.updateMany.mockResolvedValue({ count: 1 });
  mockTx.orders.findMany.mockResolvedValue([]);
  mockTx.orders.create.mockImplementation(({ data }: any) => ({
    id: `order_${data.listing_id}`, listing_id: data.listing_id,
    quantity: data.quantity || 1, image_url: 'img.jpg', listing_title: data.listing_id, ...data,
  }));
  mockTx.cart_items.deleteMany.mockResolvedValue({ count: 0 });
  mockTx.offers.update.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
}

beforeEach(() => { jest.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1 — Single-seller hosted checkout (Stripe)
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 1: single-seller Stripe checkout e2e', () => {
  let capturedMetadata: any;

  test('createSellerCheckoutSession returns correct per-seller totals', async () => {
    mockPrisma.cart_items.findMany.mockResolvedValue(ALL_CART);
    mockStripeInstance.checkout.sessions.create.mockImplementation((params: any) => {
      capturedMetadata = params.metadata;
      return { id: 'cs_e2e_1', url: 'https://checkout.stripe.com/test', payment_intent: 'pi_e2e_1' };
    });

    const req = { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any;
    const res = makeMockRes();

    await CartCheckoutController.createSellerCheckoutSession(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.sessionId).toBe('cs_e2e_1');

    // Verify fees match calculateBuyerFees for seller A's items
    const expectedFees = calculateBuyerFees([
      { sellerId: 'seller_A', listingPrice: 60, offerPrice: null, quantity: 1, shippingCost: 4.99 },
      { sellerId: 'seller_A', listingPrice: 40, offerPrice: null, quantity: 1, shippingCost: 3.49 },
    ]);

    expect(parseFloat(res.body.sellerSummary.platformFee)).toBeCloseTo(expectedFees.platformFee, 2);
    expect(parseFloat(res.body.sellerSummary.grandTotal)).toBeCloseTo(expectedFees.grandTotal, 2);

    // Metadata flows to fulfilment
    expect(capturedMetadata.type).toBe('seller_checkout');
    expect(capturedMetadata.seller_id).toBe('seller_A');
    expect(capturedMetadata.listing_ids).toContain('lst_a1');
    expect(capturedMetadata.listing_ids).toContain('lst_a2');
    expect(capturedMetadata.listing_ids).not.toContain('lst_b1');
  });

  test('fulfillCartOrder creates 2 orders with correct snapshots, reconciles, clears seller A only', async () => {
    // First run creation to capture metadata
    mockPrisma.cart_items.findMany.mockResolvedValue(ALL_CART);
    mockStripeInstance.checkout.sessions.create.mockImplementation((params: any) => {
      capturedMetadata = params.metadata;
      return { id: 'cs_e2e_1', url: 'https://checkout.stripe.com/test', payment_intent: 'pi_e2e_1' };
    });
    const createReq = { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any;
    await CartCheckoutController.createSellerCheckoutSession(createReq, makeMockRes());

    // Now fulfil using the REAL metadata from creation
    const fulfilListings = [
      makeFulfilmentListing('lst_a1', 'seller_A', 60, 4.99),
      makeFulfilmentListing('lst_a2', 'seller_A', 40, 3.49),
    ];
    mockPrisma.listings.findMany.mockResolvedValue(fulfilListings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });
    setupTxMock(fulfilListings);

    const session = {
      id: 'cs_e2e_1',
      payment_intent: 'pi_e2e_1',
      metadata: capturedMetadata,
      collected_information: { shipping_details: SHIPPING_ADDRESS },
    };

    await CartCheckoutController.fulfillCartOrder(session as any);

    // 2 orders created (one per listing)
    const orderCalls = mockTx.orders.create.mock.calls;
    expect(orderCalls.length).toBe(2);

    // Fee snapshot: first order carries £0.99, second doesn't
    const order1Data = orderCalls[0][0].data;
    const order2Data = orderCalls[1][0].data;
    expect(order1Data.fee_fixed).toBe(SERVICE_FEE_PER_ITEM);
    expect(order2Data.fee_fixed).toBe(0);

    // Both have seller_is_pro_at_sale = false
    expect(order1Data.seller_is_pro_at_sale).toBe(false);
    expect(order2Data.seller_is_pro_at_sale).toBe(false);

    // Reconciliation: snapshot sum ≈ charged platform_fee
    const snapshotSum = order1Data.platform_fee_amount + order2Data.platform_fee_amount;
    const chargedFee = parseFloat(capturedMetadata.platform_fee);
    expect(Math.abs(snapshotSum - chargedFee)).toBeLessThanOrEqual(0.01);

    // Cart clear: only seller A's listings
    expect(mockTx.cart_items.deleteMany).toHaveBeenCalledWith({
      where: {
        user_id: 'buyer_1',
        listing_id: { in: expect.arrayContaining(['lst_a1', 'lst_a2']) },
      },
    });
    const clearWhere = mockTx.cart_items.deleteMany.mock.calls[0][0].where;
    expect(clearWhere.listing_id.in).not.toContain('lst_b1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Single-seller native pay (Apple/Google)
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 2: single-seller native pay e2e', () => {
  let capturedPIMetadata: any;

  test('createSellerPaymentIntent amount matches breakdown.total', async () => {
    mockPrisma.cart_items.findMany.mockResolvedValue(ALL_CART);
    mockStripeInstance.paymentIntents.create.mockImplementation((params: any) => {
      capturedPIMetadata = params.metadata;
      return { id: 'pi_e2e_native', client_secret: 'pi_e2e_native_secret_xxx' };
    });

    const req = { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any;
    const res = makeMockRes();

    await NativePaymentController.createSellerPaymentIntent(req, res);

    expect(res.statusCode).toBe(200);
    // PI amount (pence) matches breakdown.total (pounds)
    const piAmountPence = mockStripeInstance.paymentIntents.create.mock.calls[0][0].amount;
    expect(piAmountPence).toBe(Math.round(res.body.breakdown.total * 100));

    // Metadata type
    expect(capturedPIMetadata.type).toBe('seller_native');
    expect(capturedPIMetadata.seller_id).toBe('seller_A');
  });

  test('fulfillCart creates orders with correct snapshots, reconciles, clears seller A only', async () => {
    // Run creation to get metadata
    mockPrisma.cart_items.findMany.mockResolvedValue(ALL_CART);
    mockStripeInstance.paymentIntents.create.mockImplementation((params: any) => {
      capturedPIMetadata = params.metadata;
      return { id: 'pi_e2e_native', client_secret: 'pi_e2e_native_secret_xxx' };
    });
    await NativePaymentController.createSellerPaymentIntent(
      { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any,
      makeMockRes(),
    );

    // Fulfil via confirmPayment path
    const fulfilListings = [
      makeFulfilmentListing('lst_a1', 'seller_A', 60, 4.99),
      makeFulfilmentListing('lst_a2', 'seller_A', 40, 3.49),
    ];
    setupTxMock(fulfilListings);
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    // Build fake PI that confirmPayment would retrieve
    const fakePI = {
      id: 'pi_e2e_native',
      status: 'succeeded',
      metadata: capturedPIMetadata,
      shipping: SHIPPING_ADDRESS,
    };
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(fakePI);

    const fulfillCartSpy = jest.spyOn(NativePaymentController as any, 'fulfillCart');

    const req = {
      body: { paymentIntentId: 'pi_e2e_native' },
      user: { id: 'buyer_1' },
      headers: {},
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(fulfillCartSpy).toHaveBeenCalled();
    expect(res.body.success).toBe(true);

    // 2 orders created
    const orderCalls = mockTx.orders.create.mock.calls;
    expect(orderCalls.length).toBe(2);

    // Fee snapshot
    const o1 = orderCalls[0][0].data;
    const o2 = orderCalls[1][0].data;
    expect(o1.fee_fixed + o2.fee_fixed).toBeCloseTo(SERVICE_FEE_PER_ITEM, 2);
    expect(o1.seller_is_pro_at_sale).toBe(false);
    expect(o2.seller_is_pro_at_sale).toBe(false);

    // Reconciliation
    const snapshotSum = o1.platform_fee_amount + o2.platform_fee_amount;
    const charged = parseFloat(capturedPIMetadata.platform_fee);
    expect(Math.abs(snapshotSum - charged)).toBeLessThanOrEqual(0.01);

    // Cart clear scoped to seller A
    const clearWhere = mockTx.cart_items.deleteMany.mock.calls[0][0].where;
    expect(clearWhere.user_id).toBe('buyer_1');
    const clearedIds = clearWhere.listing_id.in;
    expect(clearedIds).toContain('lst_a1');
    expect(clearedIds).toContain('lst_a2');
    expect(clearedIds).not.toContain('lst_b1');

    fulfillCartSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3 — Two sellers, independent checkouts
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 3: two sellers, independent checkouts from one bag', () => {
  test('seller A checkout+fulfil, then seller B checkout+fulfil — independent, correct', async () => {
    let metadataA: any;
    let metadataB: any;

    // ── Step 1: Create session for seller A ──
    mockPrisma.cart_items.findMany.mockResolvedValue(ALL_CART);
    mockStripeInstance.checkout.sessions.create.mockImplementation((params: any) => {
      metadataA = params.metadata;
      return { id: 'cs_A', url: 'https://test', payment_intent: 'pi_A' };
    });

    await CartCheckoutController.createSellerCheckoutSession(
      { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any,
      makeMockRes(),
    );

    // ── Step 2: Fulfil seller A ──
    const listingsA = [
      makeFulfilmentListing('lst_a1', 'seller_A', 60, 4.99),
      makeFulfilmentListing('lst_a2', 'seller_A', 40, 3.49),
    ];
    mockPrisma.listings.findMany.mockResolvedValue(listingsA);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });
    setupTxMock(listingsA);

    await CartCheckoutController.fulfillCartOrder({
      id: 'cs_A', payment_intent: 'pi_A', metadata: metadataA,
      collected_information: { shipping_details: SHIPPING_ADDRESS },
    } as any);

    // Assert: only A's orders created
    const ordersA = mockTx.orders.create.mock.calls;
    expect(ordersA.length).toBe(2);
    expect(ordersA.every((c: any) => c[0].data.seller_id === 'seller_A')).toBe(true);

    // Assert: only A's listings cleared
    const clearA = mockTx.cart_items.deleteMany.mock.calls[0][0].where;
    expect(clearA.listing_id.in).toEqual(expect.arrayContaining(['lst_a1', 'lst_a2']));
    expect(clearA.listing_id.in).not.toContain('lst_b1');

    // Assert: A's reconciliation holds
    const snapSumA = ordersA.reduce((s: number, c: any) => s + c[0].data.platform_fee_amount, 0);
    expect(Math.abs(snapSumA - parseFloat(metadataA.platform_fee))).toBeLessThanOrEqual(0.01);

    // ── Step 3: Create session for seller B (only B's items remain) ──
    jest.clearAllMocks();
    mockPrisma.cart_items.findMany.mockResolvedValue(SELLER_B_CART);
    mockStripeInstance.checkout.sessions.create.mockImplementation((params: any) => {
      metadataB = params.metadata;
      return { id: 'cs_B', url: 'https://test', payment_intent: 'pi_B' };
    });

    await CartCheckoutController.createSellerCheckoutSession(
      { user: { id: 'buyer_1' }, body: { seller_id: 'seller_B' } } as any,
      makeMockRes(),
    );

    // ── Step 4: Fulfil seller B ──
    const listingsB = [makeFulfilmentListing('lst_b1', 'seller_B', 80, 5.99)];
    mockPrisma.listings.findMany.mockResolvedValue(listingsB);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n2' });
    setupTxMock(listingsB);

    await CartCheckoutController.fulfillCartOrder({
      id: 'cs_B', payment_intent: 'pi_B', metadata: metadataB,
      collected_information: { shipping_details: SHIPPING_ADDRESS },
    } as any);

    // Assert: only B's order created
    const ordersB = mockTx.orders.create.mock.calls;
    expect(ordersB.length).toBe(1);
    expect(ordersB[0][0].data.seller_id).toBe('seller_B');

    // Assert: B's listing cleared
    const clearB = mockTx.cart_items.deleteMany.mock.calls[0][0].where;
    expect(clearB.listing_id.in).toContain('lst_b1');
    expect(clearB.listing_id.in).not.toContain('lst_a1');

    // Assert: B's reconciliation holds
    const snapSumB = ordersB[0][0].data.platform_fee_amount;
    expect(Math.abs(snapSumB - parseFloat(metadataB.platform_fee))).toBeLessThanOrEqual(0.01);

    // Assert: A and B used independent PIs
    expect(metadataA.seller_id).toBe('seller_A');
    expect(metadataB.seller_id).toBe('seller_B');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4 — Idempotency across the flow
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 4: idempotency — replayed webhook', () => {
  test('replayed fulfillCartOrder with same PI creates no duplicate orders', async () => {
    // Create session
    let metadata: any;
    mockPrisma.cart_items.findMany.mockResolvedValue(SELLER_A_CART);
    mockStripeInstance.checkout.sessions.create.mockImplementation((params: any) => {
      metadata = params.metadata;
      return { id: 'cs_idem', url: 'https://test', payment_intent: 'pi_idem' };
    });
    await CartCheckoutController.createSellerCheckoutSession(
      { user: { id: 'buyer_1' }, body: { seller_id: 'seller_A' } } as any,
      makeMockRes(),
    );

    // First fulfilment — succeeds
    const listings = [
      makeFulfilmentListing('lst_a1', 'seller_A', 60, 4.99),
      makeFulfilmentListing('lst_a2', 'seller_A', 40, 3.49),
    ];
    mockPrisma.listings.findMany.mockResolvedValue(listings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });
    setupTxMock(listings);

    const session = {
      id: 'cs_idem', payment_intent: 'pi_idem', metadata,
      collected_information: { shipping_details: SHIPPING_ADDRESS },
    };
    await CartCheckoutController.fulfillCartOrder(session as any);
    expect(mockTx.orders.create).toHaveBeenCalledTimes(2);

    // Replay — orders already exist (H-1: idempotency check is now INSIDE tx)
    jest.clearAllMocks();
    mockPrisma.listings.findMany.mockResolvedValue(listings);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockTx.orders.findMany.mockResolvedValue([{ id: 'existing_1' }, { id: 'existing_2' }]);
    mockTx.orders.create.mockReset();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

    await CartCheckoutController.fulfillCartOrder(session as any);

    // Transaction IS called, but callback exits early — no orders created
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockTx.orders.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5 — Regression: combined + single-item flows still work
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 5: regression — existing flows unchanged', () => {
  test('resolveCheckoutRoute: cart_checkout still routes to cart handler', () => {
    expect(resolveCheckoutRoute('cart_checkout')).toBe('cart');
    expect(resolveCheckoutRoute('seller_checkout')).toBe('cart');
    expect(resolveCheckoutRoute(undefined)).toBe('single');
  });

  test('resolveNativeRoute: native_cart + native_single_item unchanged', () => {
    expect(resolveNativeRoute('native_cart')).toBe('cart');
    expect(resolveNativeRoute('native_single_item')).toBe('single');
    expect(resolveNativeRoute('seller_native')).toBe('cart');
  });

  test('combined cart_checkout fulfils all sellers and clears all listings', async () => {
    const allListings = [
      makeFulfilmentListing('lst_a1', 'seller_A', 60, 4.99),
      makeFulfilmentListing('lst_b1', 'seller_B', 80, 5.99),
    ];
    mockPrisma.listings.findMany.mockResolvedValue(allListings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });
    setupTxMock(allListings);

    const combinedFees = calculateBuyerFees([
      { sellerId: 'seller_A', listingPrice: 60, offerPrice: null, quantity: 1, shippingCost: 4.99 },
      { sellerId: 'seller_B', listingPrice: 80, offerPrice: null, quantity: 1, shippingCost: 5.99 },
    ]);

    const combinedSession = {
      id: 'cs_combined', payment_intent: 'pi_combined',
      metadata: {
        type: 'cart_checkout',
        buyer_id: 'buyer_1',
        listing_ids: 'lst_a1,lst_b1',
        listing_quantities: '{"lst_a1":1,"lst_b1":1}',
        seller_ids: 'seller_A,seller_B',
        insurance_premium: combinedFees.insurancePremium.toFixed(2),
        insured_value: combinedFees.itemsTotal.toFixed(2),
        platform_fee: combinedFees.platformFee.toFixed(2),
        grand_total: combinedFees.grandTotal.toFixed(2),
        shipping_total: combinedFees.baseShipping.toFixed(2),
        total_quantity: '2',
      },
      collected_information: { shipping_details: SHIPPING_ADDRESS },
    };

    await CartCheckoutController.fulfillCartOrder(combinedSession as any);

    // Both sellers' orders created
    const orderCalls = mockTx.orders.create.mock.calls;
    expect(orderCalls.length).toBe(2);
    const sellerIds = orderCalls.map((c: any) => c[0].data.seller_id);
    expect(sellerIds).toContain('seller_A');
    expect(sellerIds).toContain('seller_B');

    // All listings cleared
    const clearWhere = mockTx.cart_items.deleteMany.mock.calls[0][0].where;
    expect(clearWhere.listing_id.in).toContain('lst_a1');
    expect(clearWhere.listing_id.in).toContain('lst_b1');
  });
});
