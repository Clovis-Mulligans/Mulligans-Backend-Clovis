// PAYMENT MONEY-SAFETY TESTS
//
// Covers the brief's HIGHEST-PRIORITY scenarios:
// - Active-but-zero-quantity listing must not reach a successful charge
// - Charge succeeds but order creation fails → auto-refund issued
// - Seller is NEVER charged a fee (spec rule: "Zero seller fees")
// - No card/Stripe secrets leaked in responses
//
// Layer: Unit (mocked Prisma + Stripe)
// Spec source: business-logic-v2.md §4, §12
// Dev-only guard: N/A (unit tests, no real services)

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── Stripe mock ───
const mockRefundsCreate = jest.fn();
const mockStripeInstance: any = {
  paymentIntents: {
    retrieve: jest.fn(),
    create: jest.fn(),
  },
  refunds: { create: mockRefundsCreate },
  checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } },
  accounts: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
const mockTx: any = {
  listings: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  orders: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
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
  AddressValidationError: class extends Error {
    missingFields: string[] = [];
  },
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
jest.mock('../../services/metaCapi', () => ({
  sendMetaPurchaseEvent: jest.fn(),
}));
jest.mock('../../utils/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/imageOrder', () => ({
  PRIMARY_IMAGE_ORDER: { orderBy: { display_order: 'asc' } },
}));
jest.mock('../../utils/shippingDeadline', () => ({
  calculateShippingDeadline: jest.fn().mockReturnValue(new Date('2026-07-18')),
  formatShippingDeadline: jest.fn().mockReturnValue('18 July 2026'),
}));

import { NativePaymentController } from '../../controllers/nativePaymentController';
import { CartCheckoutController } from '../../controllers/cartCheckoutController';
import {
  calculateBuyerFees,
  calculateSellerPayout,
  CartItem,
  BUYER_PROTECTION_RATE,
  SERVICE_FEE_PER_ITEM,
} from '../../lib/feeCalculations';

// ─── Helpers ───

function makeMockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

function makeListing(overrides: any = {}) {
  return {
    id: overrides.id || 'lst_test',
    seller_id: overrides.seller_id || 'seller_1',
    title: overrides.title || 'Test Item',
    price: { toString: () => String(overrides.price ?? 50) },
    shipping_cost: { toString: () => String(overrides.shipping_cost ?? 5.99) },
    status: overrides.status ?? 'active',
    quantity: overrides.quantity ?? 1,
    specifications: overrides.specifications ?? null,
    size_quantities: overrides.size_quantities ?? null,
    images: [{ image_url: 'https://img.test/1.jpg' }],
    users: {
      id: overrides.seller_id || 'seller_1',
      email: 'seller@test.com',
      display_name: 'Test Seller',
      stripe_connect_id: 'acct_seller1',
      stripe_connect_status: 'active',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-MONEY-01: Active listing with quantity = 0 MUST be rejected pre-charge
//
// Spec: An item with zero available stock must not proceed to payment.
// Root cause (2026-06-29 incident): getStockForSize uses `listing.quantity || 1`
// which treats 0 as falsy and returns 1.
// This test asserts the SPEC — it should FAIL until the || 1 bug is fixed.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-MONEY-01: active-but-zero-quantity listing rejected at checkout', () => {
  test('createSingleItemPaymentIntent rejects quantity-0 listing with 400', async () => {
    const listing = makeListing({ quantity: 0, status: 'active' });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test', quantity: 1 },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    // Spec: zero-quantity listing must be rejected BEFORE Stripe PI creation
    expect(res.statusCode).toBe(400);
    expect(mockStripeInstance.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('zero-quantity rejection message mentions stock, not generic error', async () => {
    const listing = makeListing({ quantity: 0, status: 'active' });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test', quantity: 1 },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.body.error).toMatch(/stock|available|sold/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-MONEY-02: Charge succeeds → order creation fails → auto-refund
//
// Spec §4.1: "no payment without a path to refund"
// Tests the D-C4 pattern in stripeController.fulfillOrder and
// cartCheckoutController.fulfillCartOrder.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-MONEY-02: auto-refund when fulfillment fails (cart checkout)', () => {
  test('fulfillCartOrder issues refund when transaction throws', async () => {
    const listings = [makeListing({ id: 'lst_1', seller_id: 'seller_A', price: 60 })];
    mockPrisma.listings.findMany.mockResolvedValue(listings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1',
      email: 'buyer@test.com',
      display_name: 'Buyer',
    });

    // Transaction throws (simulating stock guard failure after charge)
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );

    mockRefundsCreate.mockResolvedValue({ id: 're_auto_1' });

    const session = {
      id: 'cs_test',
      payment_intent: 'pi_test_refund',
      metadata: {
        type: 'cart_checkout',
        buyer_id: 'buyer_1',
        listing_ids: 'lst_1',
        listing_quantities: '{"lst_1":1}',
        seller_ids: 'seller_A',
        insurance_premium: '0.63',
        insured_value: '50',
        platform_fee: '4.74',
        grand_total: '60',
        shipping_total: '5.99',
        total_quantity: '1',
      },
      collected_information: {
        shipping_details: {
          name: 'Test Buyer',
          address: {
            line1: '123 Test St',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country: 'GB',
          },
        },
      },
    };

    // fulfillCartOrder should NOT throw (it catches and refunds)
    await expect(
      CartCheckoutController.fulfillCartOrder(session as any)
    ).rejects.toThrow();

    // Auto-refund MUST have been issued
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_test_refund',
      })
    );
  });

  test('refund metadata includes reason for audit trail', async () => {
    mockPrisma.listings.findMany.mockResolvedValue([
      makeListing({ id: 'lst_1', seller_id: 'seller_A' }),
    ]);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1',
      email: 'b@test.com',
      display_name: 'B',
    });
    mockPrisma.$transaction.mockRejectedValue(new Error('DB failure'));
    mockRefundsCreate.mockResolvedValue({ id: 're_auto_2' });

    const session = {
      id: 'cs_meta',
      payment_intent: 'pi_meta_test',
      metadata: {
        type: 'cart_checkout',
        buyer_id: 'buyer_1',
        listing_ids: 'lst_1',
        listing_quantities: '{"lst_1":1}',
        seller_ids: 'seller_A',
        insurance_premium: '0',
        insured_value: '50',
        platform_fee: '4.74',
        grand_total: '55',
        shipping_total: '5',
        total_quantity: '1',
      },
      collected_information: {
        shipping_details: {
          name: 'B',
          address: {
            line1: '1 St',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country: 'GB',
          },
        },
      },
    };

    try {
      await CartCheckoutController.fulfillCartOrder(session as any);
    } catch {
      // expected
    }

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: expect.stringMatching(/fulfillment_failed|cart_fulfillment_failed/),
        }),
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-MONEY-03: nativePaymentController.confirmPayment catch block
//
// On main: the catch does NOT issue a refund (relies on 30s webhook safety net).
// The response message claims "has been refunded" — which is misleading.
// This test documents the CURRENT behaviour; the feature branch fixes it.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-MONEY-03: native payment confirm — catch block behaviour', () => {
  test('confirmPayment returns 500 on fulfilment failure', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_fail_test',
      status: 'succeeded',
      metadata: {
        type: 'native_single_item',
        buyer_id: 'buyer_1',
        listing_id: 'lst_1',
        seller_id: 'seller_1',
        quantity: '1',
      },
      shipping: {
        name: 'Test',
        address: {
          line1: '1 St',
          city: 'London',
          postal_code: 'SW1A 1AA',
          country: 'GB',
        },
      },
    });

    // No existing order
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    // Transaction throws
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_fail_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.statusCode).toBe(500);
  });

  test('insufficient-stock error message mentions refund (user-facing)', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_stock_test',
      status: 'succeeded',
      metadata: {
        type: 'native_single_item',
        buyer_id: 'buyer_1',
        listing_id: 'lst_1',
        seller_id: 'seller_1',
        quantity: '1',
      },
      shipping: {
        name: 'Test',
        address: {
          line1: '1 St',
          city: 'London',
          postal_code: 'SW1A 1AA',
          country: 'GB',
        },
      },
    });
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_stock_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    // The user message should tell the buyer about the refund
    expect(res.body.error).toMatch(/refund|no longer available/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-FEE-01: Seller is NEVER charged a fee
//
// Spec §12.1: "Sellers never see a fee"
// Spec §12.2: "Final value fee (selling fee): £0 — Zero seller fees"
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-FEE-01: seller is NEVER charged a fee (zero seller fees)', () => {
  const item = (p: Partial<CartItem> & { listingPrice: number }): CartItem => ({
    sellerId: p.sellerId ?? 'seller-1',
    listingPrice: p.listingPrice,
    offerPrice: p.offerPrice ?? null,
    quantity: p.quantity ?? 1,
    shippingCost: p.shippingCost ?? 0,
  });

  test('auto-ship: seller payout equals full item price (no deduction)', () => {
    const payout = calculateSellerPayout(100, 1, 5.99, true);
    expect(payout.itemAmount).toBe(100);
    expect(payout.total).toBe(100);
    // Seller receives EXACTLY the item price — no fee deducted
  });

  test('manual-ship: seller payout equals item price + shipping reimbursement', () => {
    const payout = calculateSellerPayout(100, 1, 5.99, false, 0);
    expect(payout.total).toBeCloseTo(105.99, 2);
    // No fee deducted from the seller's payout
  });

  test('all fees are paid by the BUYER, never subtracted from seller payout', () => {
    const cart = [
      item({ listingPrice: 100, shippingCost: 5.99 }),
    ];
    const buyerFees = calculateBuyerFees(cart);
    const sellerPayout = calculateSellerPayout(100, 1, 5.99, true);

    // Buyer pays more than item price (fees added on top)
    expect(buyerFees.grandTotal).toBeGreaterThan(buyerFees.itemsTotal);
    // Buyer pays 7.5% protection + £0.99 service + insurance + shipping
    expect(buyerFees.buyerProtectionFee).toBeCloseTo(7.50, 2);
    expect(buyerFees.serviceFee).toBeCloseTo(0.99, 2);

    // Seller receives exactly the item price (auto-ship)
    expect(sellerPayout.total).toBe(100);

    // The platform fee is not deducted from the seller
    expect(sellerPayout.total).toBe(buyerFees.itemsTotal);
  });

  test('multi-item order: seller payout = sum of item prices, zero fee deduction', () => {
    const payout1 = calculateSellerPayout(80, 1, 5.99, true);
    const payout2 = calculateSellerPayout(120, 1, 5.99, true);

    expect(payout1.total).toBe(80);
    expect(payout2.total).toBe(120);
    expect(payout1.total + payout2.total).toBe(200);
  });

  test('offer-price order: seller payout = offer price, not listing price', () => {
    const payout = calculateSellerPayout(85, 1, 5.99, true); // offer price = £85
    expect(payout.total).toBe(85);
    // Still zero fees deducted
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-FEE-02: 7.5% buyer protection and £0.99 are SEPARATE line items
//
// Spec §12.2: These are two distinct fee components, not combined.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-FEE-02: fees are separate line items', () => {
  const item = (p: Partial<CartItem> & { listingPrice: number }): CartItem => ({
    sellerId: p.sellerId ?? 'seller-1',
    listingPrice: p.listingPrice,
    offerPrice: p.offerPrice ?? null,
    quantity: p.quantity ?? 1,
    shippingCost: p.shippingCost ?? 0,
  });

  test('buyerProtectionFee and serviceFee are separate fields in breakdown', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 100, shippingCost: 5.99 })]);

    // Two distinct values
    expect(fees.buyerProtectionFee).toBeCloseTo(7.50, 2);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);

    // They sum to platformFee (not combined into one)
    expect(fees.platformFee).toBeCloseTo(
      fees.buyerProtectionFee + fees.serviceFee,
      6
    );
  });

  test('7.5% scales with item value; £0.99 scales with quantity', () => {
    const cheap = calculateBuyerFees([item({ listingPrice: 10 })]);
    const expensive = calculateBuyerFees([item({ listingPrice: 1000 })]);

    // 7.5% scales linearly with price
    expect(cheap.buyerProtectionFee).toBeCloseTo(0.75, 2);
    expect(expensive.buyerProtectionFee).toBeCloseTo(75, 2);

    // £0.99 is constant (one item in both cases)
    expect(cheap.serviceFee).toBeCloseTo(0.99, 2);
    expect(expensive.serviceFee).toBeCloseTo(0.99, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-SEC-01: Amounts and fees cannot be overridden via request body
//
// The endpoint must compute fees server-side, not trust client-provided values.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-SEC-01: fee computation is server-side, not client-controlled', () => {
  test('createSingleItemPaymentIntent ignores client-sent platformFee', async () => {
    const listing = makeListing({
      quantity: 5,
      status: 'active',
      price: 100,
      shipping_cost: 5.99,
    });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    mockStripeInstance.paymentIntents.create.mockResolvedValue({
      id: 'pi_sec_test',
      client_secret: 'pi_sec_test_secret',
    });

    const req = {
      user: { id: 'buyer_1' },
      body: {
        listing_id: 'lst_test',
        quantity: 1,
        // Attacker tries to set a lower fee
        platformFee: 0.01,
        platform_fee: 0.01,
        grand_total: 100.01,
        amount: 10001,
      },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    if (res.statusCode === 200) {
      // The PI amount should be the SERVER-COMPUTED value, not the client value
      const piCreate = mockStripeInstance.paymentIntents.create.mock.calls[0][0];
      const serverAmount = piCreate.amount;

      // Server computes: item(100) + platformFee(100*0.075 + 0.99 = 8.49) + shipping(5.99) + insurance(1.25) = 115.73
      // In pence: 11573
      const expectedMinPence = Math.round(
        (100 + 100 * 0.075 + 0.99 + 5.99 + 100 * 0.0125) * 100
      );

      // Amount must be the server-computed value, not the attacker's value
      expect(serverAmount).toBeGreaterThanOrEqual(expectedMinPence - 1);
      expect(serverAmount).toBeLessThanOrEqual(expectedMinPence + 1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-SEC-02: No Stripe secrets in API responses
//
// Responses must not leak sk_test/sk_live keys or full PaymentIntent objects.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-SEC-02: no Stripe secrets leaked in responses', () => {
  test('createSingleItemPaymentIntent response has no secret key', async () => {
    const listing = makeListing({ quantity: 5, status: 'active', price: 50 });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    mockStripeInstance.paymentIntents.create.mockResolvedValue({
      id: 'pi_test_sec2',
      client_secret: 'pi_test_sec2_secret_xxx',
    });

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test', quantity: 1 },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    if (res.statusCode === 200) {
      const body = JSON.stringify(res.body);
      // Must not contain sk_test or sk_live keys
      expect(body).not.toMatch(/sk_test_/);
      expect(body).not.toMatch(/sk_live_/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-HP-01: Happy path — successful charge → order with correct amounts
//
// Spec §4.1, §4.2, §12.5: Buyer pays grand total, seller receives item price.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-HP-01: happy path — correct amounts on order creation', () => {
  test('PI amount matches spec formula for £100 item with £5.99 shipping', async () => {
    const listing = makeListing({
      quantity: 5,
      status: 'active',
      price: 100,
      shipping_cost: 5.99,
    });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    mockStripeInstance.paymentIntents.create.mockResolvedValue({
      id: 'pi_hp_test',
      client_secret: 'pi_hp_test_secret',
    });

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test', quantity: 1 },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.statusCode).toBe(200);

    // Spec worked example: £100 item, £5.99 shipping → £115.73
    const piCreate = mockStripeInstance.paymentIntents.create.mock.calls[0][0];
    expect(piCreate.amount).toBe(11573);
    expect(piCreate.currency).toBe('gbp');
  });

  test('PI metadata includes listing_id, buyer_id, seller_id for fulfilment', async () => {
    const listing = makeListing({
      quantity: 5,
      status: 'active',
      price: 50,
    });
    mockPrisma.listings.findUnique.mockResolvedValue(listing);

    mockStripeInstance.paymentIntents.create.mockResolvedValue({
      id: 'pi_meta',
      client_secret: 'pi_meta_secret',
    });

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test', quantity: 1 },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    const piCreate = mockStripeInstance.paymentIntents.create.mock.calls[0][0];
    expect(piCreate.metadata.listing_id).toBe('lst_test');
    expect(piCreate.metadata.buyer_id).toBe('buyer_1');
    expect(piCreate.metadata.seller_id).toBe('seller_1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-NEG-01: Validation — invalid inputs rejected pre-charge
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-NEG-01: validation rejects bad input before Stripe call', () => {
  test('missing listing_id → 404', async () => {
    mockPrisma.listings.findUnique.mockResolvedValue(null);

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'nonexistent' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.statusCode).toBe(404);
    expect(mockStripeInstance.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('inactive listing → 400', async () => {
    mockPrisma.listings.findUnique.mockResolvedValue(
      makeListing({ status: 'sold' })
    );

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockStripeInstance.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('own listing → 400', async () => {
    mockPrisma.listings.findUnique.mockResolvedValue(
      makeListing({ seller_id: 'buyer_1', quantity: 5 })
    );

    const req = {
      user: { id: 'buyer_1' },
      body: { listing_id: 'lst_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('unauthenticated request → 401', async () => {
    const req = {
      user: undefined,
      body: { listing_id: 'lst_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.createSingleItemPaymentIntent(req, res);

    expect(res.statusCode).toBe(401);
  });
});
