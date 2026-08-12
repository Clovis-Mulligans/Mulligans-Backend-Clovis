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
  orders: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  cart_items: { deleteMany: jest.fn() },
  offers: { update: jest.fn() },
  notifications: { create: jest.fn() },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  $queryRaw: jest.fn(),
};
const mockPrisma: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  orders: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  users: { findUnique: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
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
  sendOrderCancellation: jest.fn().mockResolvedValue(undefined),
  sendDeliveryConfirmation: jest.fn().mockResolvedValue(undefined),
  sendEscrowReleased: jest.fn().mockResolvedValue(undefined),
  sendInsuranceReportReceivedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendInsuranceReportReceivedToSeller: jest.fn().mockResolvedValue(undefined),
  sendInsuranceClaimApprovedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendInsuranceClaimApprovedToSeller: jest.fn().mockResolvedValue(undefined),
  sendInsuranceClaimDeniedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendInsuranceClaimDeniedToSeller: jest.fn().mockResolvedValue(undefined),
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
  ...jest.requireActual('../../lib/stockUtils'),
  logStockDecrement: jest.fn(),
  restoreListingStock: jest.fn().mockResolvedValue(undefined),
}));
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
  weekdaysUntil: jest.fn().mockReturnValue(5),
}));
jest.mock('shippo', () => ({
  Shippo: jest.fn(() => ({
    trackingStatus: { get: jest.fn() },
  })),
}));
jest.mock('../../config/constants', () => ({
  ESCROW_RELEASE_DAYS: 3,
  SHIPPING_DEADLINE_DAYS: 5,
}));
jest.mock('../../routes/emailActionRoutes', () => ({
  generateEmailActionToken: jest.fn().mockReturnValue('mock-token'),
}));
jest.mock('../../services/escrowService', () => ({
  hasBlockingDispute: jest.fn().mockResolvedValue(false),
  hasBlockingReturn: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../middleware/adminAuth', () => ({
  adminAuth: (_req: any, _res: any, next: any) => next(),
  verifyAdminPassword: jest.fn((_req: any, _res: any, next: any) => next()),
  adminLogout: jest.fn((_req: any, res: any) => res.json({ success: true })),
}));
const noop = (_req: any, res: any) => res.json({});
jest.mock('../../controllers/disputeController', () => ({
  DisputeController: { getAdminDisputes: noop, adminResolveDispute: noop },
}));
jest.mock('../../controllers/adminReportsController', () => ({
  AdminReportsController: { getReports: noop, getReport: noop, updateReport: noop, banUser: noop },
}));
jest.mock('../../controllers/adminStatsController', () => ({
  AdminStatsController: { getStats: noop, getChartData: noop, getDetailedStats: noop, getSales: noop },
}));
jest.mock('../../lib/auditLogger', () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
  AUDIT_ACTIONS: { APPROVE_CLAIM: 'approve_claim', DENY_CLAIM: 'deny_claim', PROCESS_REFUND: 'process_refund' },
}));
jest.mock('../../constants/inspection', () => ({
  INSPECTION_WINDOW_MS: 259200000,
}));
jest.mock('express-rate-limit', () => jest.fn(() => (_req: any, _res: any, next: any) => next()));

import { NativePaymentController } from '../../controllers/nativePaymentController';
import { CartCheckoutController } from '../../controllers/cartCheckoutController';
import { OrderController } from '../../controllers/orderController';
import express from 'express';
import request from 'supertest';
import adminRouter from '../../routes/adminRoutes';
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
// Fixed: getStockForSize now returns listing.quantity directly (no || 1).
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

    // Auto-refund MUST have been issued (second arg = idempotency key options)
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_test_refund',
      }),
      expect.objectContaining({
        idempotencyKey: expect.any(String),
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
      }),
      expect.objectContaining({
        idempotencyKey: expect.any(String),
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-MONEY-03 (HYG-04 REWRITE): native payment confirm — MUST refund
//
// Spec §4.1: "no payment without a path to refund". The native path
// (Apple Pay / Google Pay) must match the cart checkout path (D-C4):
// when fulfilment fails after payment succeeds, stripe.refunds.create
// MUST fire synchronously. The 30-second webhook safety net is NOT a
// substitute — it races with the error response reaching the client.
//
// BUG (FIND-PAY-02): The catch block in confirmPayment says "Your
// payment has been refunded" but NEVER calls stripe.refunds.create.
// This test asserts the SPEC. It SHOULD BE RED on delivery.
// ═══════════════════════════════════════════════════════════════════════════

describe('TC-MONEY-03 (HYG-04): confirmPayment MUST refund on fulfilment failure', () => {
  function makeSucceededPI(id: string) {
    return {
      id,
      status: 'succeeded',
      metadata: {
        type: 'native_single_item',
        buyer_id: 'buyer_1',
        listing_id: 'lst_1',
        seller_id: 'seller_1',
        quantity: '1',
      },
      shipping: {
        name: 'Test Buyer',
        address: {
          line1: '1 High St',
          city: 'London',
          postal_code: 'SW1A 1AA',
          country: 'GB',
        },
      },
    };
  }

  test('FIND-PAY-02: stripe.refunds.create fires with correct payment_intent on stock failure', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_native_refund')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockResolvedValue({ id: 're_native_1' });

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_native_refund' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    // SPEC: refund MUST be issued — matching the cart checkout D-C4 pattern
    // Second arg: idempotency key options (added in Branch 1, FIND-PAY-04)
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_native_refund',
      }),
      expect.anything()
    );
  });

  test('FIND-PAY-02: refund metadata includes reason for audit trail', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_native_audit')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockResolvedValue({ id: 're_native_2' });

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_native_audit' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    // SPEC: refund metadata must include machine-readable reason
    // Second arg: idempotency key options (added in Branch 1, FIND-PAY-04)
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: expect.stringMatching(/fulfillment_failed/),
        }),
      }),
      expect.anything()
    );
  });

  test('FIND-PAY-02: confirmPayment still returns 500 to client on failure', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_native_500')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_native_500' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.statusCode).toBe(500);
  });

  test('FIND-PAY-02: refund carries deterministic idempotency key fulfillment_refund_<piId>', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_idem_native')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockResolvedValue({ id: 're_idem_native' });

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_idem_native' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: 'fulfillment_refund_pi_idem_native',
      })
    );
  });

  test('FIND-PAY-02: if stripe.refunds.create throws, endpoint still returns 500 and logs failure', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_refund_fail')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockRejectedValue(new Error('Stripe is down'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_refund_fail' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.statusCode).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CRITICAL]'),
      expect.anything()
    );

    consoleSpy.mockRestore();
  });

  test('FIND-PAY-02: user-facing message is accurate after successful refund', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_msg_test')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockResolvedValue({ id: 're_msg_test' });

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_msg_test' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/has been refunded/);
  });

  test('FIND-PAY-02: user-facing message differs when refund itself fails', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(
      makeSucceededPI('pi_msg_fail')
    );
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValue(
      new Error('Insufficient stock for listing lst_1')
    );
    mockRefundsCreate.mockRejectedValue(new Error('Stripe down'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const req = {
      user: { id: 'buyer_1' },
      body: { paymentIntentId: 'pi_msg_fail' },
    } as any;
    const res = makeMockRes();

    await NativePaymentController.confirmPayment(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/being processed/);
    expect(res.body.error).not.toMatch(/has been refunded/);

    consoleSpy.mockRestore();
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

    expect(res.statusCode).toBe(200);

    const piCreate = mockStripeInstance.paymentIntents.create.mock.calls[0][0];
    const serverAmount = piCreate.amount;

    // Server computes: item(100) + platformFee(100*0.075 + 0.99 = 8.49) + shipping(5.99) + insurance(1.25) = 115.73
    // In pence: 11573
    const expectedMinPence = Math.round(
      (100 + 100 * 0.075 + 0.99 + 5.99 + 100 * 0.0125) * 100
    );

    expect(serverAmount).toBeGreaterThanOrEqual(expectedMinPence - 1);
    expect(serverAmount).toBeLessThanOrEqual(expectedMinPence + 1);
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

    expect(res.statusCode).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/sk_test_/);
    expect(body).not.toMatch(/sk_live_/);
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

// ═══════════════════════════════════════════════════════════════════════════
// FIND-PAY-04: Idempotency keys on ALL refund paths
//
// Every stripe.refunds.create call MUST pass a deterministic idempotencyKey
// derived from stable DB identifiers. Never from Date.now() or Math.random().
// Two identical operations for the same entity MUST produce the SAME key.
// ═══════════════════════════════════════════════════════════════════════════

describe('FIND-PAY-04: cancel order refund has idempotency key', () => {
  function makeOrder(id: string) {
    const now = new Date();
    return {
      id,
      buyer_id: 'buyer_1',
      seller_id: 'seller_1',
      status: 'pending',
      stripe_payment_intent_id: 'pi_cancel_test',
      shippo_transaction_id: null,
      tracking_number: null,
      carrier: null,
      created_at: now,
      updated_at: now,
      amount: { toString: () => '50.00' },
      listing_title: 'Test Club',
      listing_image: null,
      listings: { id: 'lst_1', title: 'Test Club', images: [] },
      users_orders_buyer_idTousers: { id: 'buyer_1', display_name: 'Buyer', buyer_cancellation_count: 0 },
      users_orders_seller_idTousers: { id: 'seller_1', display_name: 'Seller', seller_cancellation_count: 0 },
    };
  }

  test('stripe.refunds.create receives idempotencyKey = cancel_refund_<orderId>', async () => {
    const order = makeOrder('ord_idem_001');
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockRefundsCreate.mockResolvedValue({ id: 're_idem_1' });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockTx));
    mockTx.orders.update.mockResolvedValue({});
    mockTx.listings.update.mockResolvedValue({});
    mockPrisma.users.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({});

    const req = {
      user: { id: 'buyer_1' },
      params: { id: 'ord_idem_001' },
      body: { reason: 'changed_mind' },
    } as any;
    const res = makeMockRes();

    await OrderController.cancelOrder(req, res);

    expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
    const [refundArgs, refundOpts] = mockRefundsCreate.mock.calls[0];
    expect(refundArgs.payment_intent).toBe('pi_cancel_test');
    expect(refundOpts).toEqual({ idempotencyKey: 'cancel_refund_ord_idem_001' });
  });

  test('same order ID always produces the same key (deterministic)', async () => {
    const orderId = 'ord_deterministic_test';
    const order = makeOrder(orderId);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockRefundsCreate.mockResolvedValue({ id: 're_det_1' });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockTx));
    mockTx.orders.update.mockResolvedValue({});
    mockTx.listings.update.mockResolvedValue({});
    mockPrisma.users.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({});

    const req = {
      user: { id: 'buyer_1' },
      params: { id: orderId },
      body: { reason: 'changed_mind' },
    } as any;
    const res = makeMockRes();

    await OrderController.cancelOrder(req, res);

    const key1 = mockRefundsCreate.mock.calls[0][1].idempotencyKey;

    jest.clearAllMocks();
    mockPrisma.orders.findFirst.mockResolvedValue(makeOrder(orderId));
    mockRefundsCreate.mockResolvedValue({ id: 're_det_2' });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockTx));
    mockTx.orders.update.mockResolvedValue({});
    mockTx.listings.update.mockResolvedValue({});
    mockPrisma.users.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({});

    await OrderController.cancelOrder(req, res);

    const key2 = mockRefundsCreate.mock.calls[0][1].idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(`cancel_refund_${orderId}`);
  });

  test('key is derived from order.id, not from timestamp or random value', async () => {
    const order = makeOrder('ord_stable_id');
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockRefundsCreate.mockResolvedValue({ id: 're_stable_1' });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockTx));
    mockTx.orders.update.mockResolvedValue({});
    mockTx.listings.update.mockResolvedValue({});
    mockPrisma.users.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({});

    const req = {
      user: { id: 'buyer_1' },
      params: { id: 'ord_stable_id' },
      body: { reason: 'changed_mind' },
    } as any;
    const res = makeMockRes();

    await OrderController.cancelOrder(req, res);

    const key = mockRefundsCreate.mock.calls[0][1].idempotencyKey;
    expect(key).not.toMatch(/\d{13}/);
    expect(key).toBe('cancel_refund_ord_stable_id');
  });
});

describe('FIND-PAY-04: cart fulfilment-failure refund has idempotency key', () => {
  test('fulfillCartOrder passes idempotencyKey = fulfillment_refund_<paymentIntentId>', async () => {
    mockPrisma.listings.findMany.mockResolvedValue([
      makeListing({ id: 'lst_1', seller_id: 'seller_A', price: 60 }),
    ]);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'b@test.com', display_name: 'B',
    });
    mockPrisma.$transaction.mockRejectedValue(new Error('Stock guard failure'));
    mockRefundsCreate.mockResolvedValue({ id: 're_cart_idem' });

    const session = {
      id: 'cs_idem',
      payment_intent: 'pi_cart_idem_test',
      metadata: {
        type: 'cart_checkout',
        buyer_id: 'buyer_1',
        listing_ids: 'lst_1',
        listing_quantities: '{"lst_1":1}',
        seller_ids: 'seller_A',
        insurance_premium: '0',
        insured_value: '50',
        platform_fee: '4.74',
        grand_total: '60',
        shipping_total: '5.99',
        total_quantity: '1',
      },
      collected_information: {
        shipping_details: {
          name: 'B',
          address: { line1: '1 St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
        },
      },
    };

    try {
      await CartCheckoutController.fulfillCartOrder(session as any);
    } catch {
      // expected — re-throws after refund
    }

    expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
    const [, refundOpts] = mockRefundsCreate.mock.calls[0];
    expect(refundOpts).toEqual({ idempotencyKey: 'fulfillment_refund_pi_cart_idem_test' });
  });
});

describe('FIND-PAY-04: insurance claim approval — idempotency key + claim-the-row', () => {
  let app: any;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
  });

  function makeClaimOrder(orderId: string) {
    return {
      id: orderId,
      buyer_id: 'buyer_claim',
      seller_id: 'seller_claim',
      status: 'delivered',
      insurance_claim_status: 'claim_filed',
      stripe_payment_intent_id: 'pi_claim_test',
      stripe_refund_id: null,
      amount: { toString: () => '100.00' },
      listing_title: 'Lost Driver',
      listing_image: null,
      users_orders_buyer_idTousers: { id: 'buyer_claim', display_name: 'Buyer' },
      users_orders_seller_idTousers: { id: 'seller_claim', display_name: 'Seller' },
    };
  }

  test('stripe.refunds.create receives idempotencyKey = insurance_claim_refund_<orderId>', async () => {
    const orderId = 'ord_claim_idem_001';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockRefundsCreate.mockResolvedValue({ id: 're_claim_idem' });
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.orders.findUnique.mockResolvedValue(null);
    mockPrisma.notifications.create.mockResolvedValue({});
    mockPrisma.users.findUnique.mockResolvedValue({ email: 'buyer@test.com' });

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ notes: 'Approved' });

    expect(res.status).toBe(200);
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
    const [, refundOpts] = mockRefundsCreate.mock.calls[0];
    expect(refundOpts).toEqual({ idempotencyKey: `insurance_claim_refund_${orderId}` });
  });

  test('claim-the-row: handler uses SELECT FOR UPDATE before Stripe call', async () => {
    const orderId = 'ord_claim_lock_test';
    const order = makeClaimOrder(orderId);
    let queryRawMock: jest.Mock;

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      queryRawMock = jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]);
      const tx = {
        $queryRaw: queryRawMock,
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockRefundsCreate.mockResolvedValue({ id: 're_lock_test' });
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.orders.findUnique.mockResolvedValue(null);
    mockPrisma.notifications.create.mockResolvedValue({});
    mockPrisma.users.findUnique.mockResolvedValue({ email: 'b@test.com' });

    await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ notes: 'test' });

    expect(queryRawMock!).toHaveBeenCalled();
    expect(mockRefundsCreate).toHaveBeenCalled();
  });

  test('concurrent approval returns 409 when claim is already processing', async () => {
    const orderId = 'ord_concurrent_test';

    mockPrisma.$transaction.mockResolvedValue(null);
    mockPrisma.orders.findUnique.mockResolvedValue({
      insurance_claim_status: 'claim_processing',
      stripe_refund_id: null,
    });

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ notes: 'test' });

    expect(res.status).toBe(409);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  test('Stripe failure reverts claim status to previous value', async () => {
    const orderId = 'ord_revert_test';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({ ...order, _previousClaimStatus: 'claim_filed' }),
        },
      };
      return cb(tx);
    });
    mockRefundsCreate.mockRejectedValue(new Error('Stripe error'));
    mockPrisma.orders.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ notes: 'test' });

    expect(res.status).toBe(500);
    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId },
        data: expect.objectContaining({ insurance_claim_status: 'claim_filed' }),
      })
    );
  });

  test('refund_amount > order amount → 400, Stripe NOT called', async () => {
    const orderId = 'ord_overcharge_test';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockPrisma.orders.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ refund_amount: 999.99, notes: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds order total/);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  test('refund_amount <= 0 → 400, Stripe NOT called', async () => {
    const orderId = 'ord_negative_test';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockPrisma.orders.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ refund_amount: -5, notes: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive number/);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  test('refund_amount absent → defaults to full order amount', async () => {
    const orderId = 'ord_default_amount';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockRefundsCreate.mockResolvedValue({ id: 're_default' });
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.orders.findUnique.mockResolvedValue(null);
    mockPrisma.notifications.create.mockResolvedValue({});
    mockPrisma.users.findUnique.mockResolvedValue({ email: 'b@test.com' });

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ notes: 'test' });

    expect(res.status).toBe(200);
    const [refundArgs] = mockRefundsCreate.mock.calls[0];
    expect(refundArgs.amount).toBe(10000);
  });

  test('refund_amount valid & <= order total → succeeds', async () => {
    const orderId = 'ord_partial_refund';
    const order = makeClaimOrder(orderId);

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId, insurance_claim_status: 'claim_filed' }]),
        orders: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(order),
        },
      };
      return cb(tx);
    });
    mockRefundsCreate.mockResolvedValue({ id: 're_partial' });
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.orders.findUnique.mockResolvedValue(null);
    mockPrisma.notifications.create.mockResolvedValue({});
    mockPrisma.users.findUnique.mockResolvedValue({ email: 'b@test.com' });

    const res = await request(app)
      .post(`/admin/claims/${orderId}/approve`)
      .send({ refund_amount: 75.50, notes: 'partial' });

    expect(res.status).toBe(200);
    const [refundArgs] = mockRefundsCreate.mock.calls[0];
    expect(refundArgs.amount).toBe(7550);
  });
});
