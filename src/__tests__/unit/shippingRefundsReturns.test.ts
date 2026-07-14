// SHIPPING / REFUNDS / RETURNS — Regression Test Suite
//
// Brief: Clovis Regression-Test Brief — SHIPPING / REFUNDS / RETURNS
// Layer: Unit (mocked Prisma + Stripe)
// Spec source: business-logic-v2.md §2, §3, §4, §5, §6, §12
//
// This suite covers:
//   FIND-PAY-03 — stripeController.fulfillOrder silent abort (RED on delivery)
//   Forced return threshold (isForceReturnThreshold boundary)
//   Refund policy rules (allowed percents, admin limits)
//   Return label payer resolution
//   BLOCKING_RETURN_STATUSES divergence tripwire
//   Escrow timing constant tripwires (return escrow days)
//   Idempotency key format tripwires
//
// NO PRODUCT CODE CHANGES IN THIS BRIEF.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── Stripe mock ───
const mockRefundsCreate = jest.fn();
const mockTransfersCreate = jest.fn();
const mockWebhooksConstructEvent = jest.fn();
const mockStripeInstance: any = {
  paymentIntents: {
    retrieve: jest.fn(),
    create: jest.fn(),
  },
  refunds: { create: mockRefundsCreate },
  transfers: { create: mockTransfersCreate },
  checkout: {
    sessions: {
      retrieve: jest.fn(),
      create: jest.fn(),
    },
  },
  accounts: { create: jest.fn() },
  webhooks: { constructEvent: mockWebhooksConstructEvent },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
const mockPrisma: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  orders: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  users: { findUnique: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  offers: { update: jest.fn() },
  return_requests: { findFirst: jest.fn(), update: jest.fn() },
  disputes: { findFirst: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
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
jest.mock('../../lib/stockUtils', () => ({
  ...jest.requireActual('../../lib/stockUtils'),
  logStockDecrement: jest.fn(),
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
}));

import { StripeController } from '../../controllers/stripeController';
import {
  isForceReturnThreshold,
  resolveReturnLabelPayer,
  FORCED_RETURN_THRESHOLD,
  FORCED_RETURN_SELLER_CONFIRM_DAYS,
  FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS,
  FORCED_RETURN_SHIP_DEADLINE_DAYS,
} from '../../services/forcedReturnService';
import {
  isAllowedBuyerRefundPercent,
  isAllowedCounterPercent,
  isAllowedAdminPartialAmount,
  MAX_PARTIAL_FRACTION,
  PARTIAL_REFUND_PERCENTS,
  FULL_REFUND_PERCENT,
} from '../../lib/refundPolicy';
import {
  BLOCKING_DISPUTE_STATUSES,
  BLOCKING_RETURN_STATUSES,
} from '../../lib/escrowDecisions';
import {
  ESCROW_RELEASE_DAYS,
  RETURN_SHIPPING_DEADLINE_DAYS,
  RETURN_ESCROW_DAYS,
} from '../../config/constants';
import { INSPECTION_WINDOW_DAYS } from '../../constants/inspection';

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// FIND-PAY-03: stripeController.fulfillOrder — listing not found, NO refund
//
// Spec §4.1: every post-charge failure path must refund the buyer.
// BUG: fulfillOrder has an early return when listing is null — no refund
// is issued, the webhook returns 200 to Stripe, and the charge is silently
// swallowed. This test asserts the SPEC. It SHOULD BE RED on delivery.
// ═══════════════════════════════════════════════════════════════════════════

describe('FIND-PAY-03: fulfillOrder MUST refund when listing not found post-charge', () => {
  // Access private static method for testing
  const fulfillOrder = (StripeController as any).fulfillOrder;

  test('stripe.refunds.create fires when listing does not exist', async () => {
    // No existing order (not a duplicate)
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    // Listing not found
    mockPrisma.listings.findUnique.mockResolvedValue(null);
    mockRefundsCreate.mockResolvedValue({ id: 're_listing_gone' });

    const session = {
      id: 'cs_find_pay_03',
      payment_intent: 'pi_listing_gone',
      metadata: {
        listing_id: 'lst_deleted',
        buyer_id: 'buyer_1',
        seller_id: 'seller_1',
        quantity: '1',
        item_price: '50',
      },
      collected_information: {
        shipping_details: {
          name: 'Test Buyer',
          address: {
            line1: '1 High St',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country: 'GB',
          },
        },
      },
    };

    await fulfillOrder.call(StripeController, session);

    // SPEC: buyer MUST be refunded when listing no longer exists
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_listing_gone',
      }),
      expect.anything()
    );
  });

  test('refund metadata includes listing_id for reconciliation', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.listings.findUnique.mockResolvedValue(null);
    mockRefundsCreate.mockResolvedValue({ id: 're_listing_meta' });

    const session = {
      id: 'cs_pay03_meta',
      payment_intent: 'pi_meta_03',
      metadata: {
        listing_id: 'lst_gone',
        buyer_id: 'buyer_1',
        seller_id: 'seller_1',
        quantity: '1',
        item_price: '50',
      },
      collected_information: {
        shipping_details: {
          name: 'Test',
          address: {
            line1: '1 St',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country: 'GB',
          },
        },
      },
    };

    await fulfillOrder.call(StripeController, session);

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          listing_id: 'lst_gone',
        }),
      }),
      expect.anything()
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIND-PAY-03 supplementary tests: idempotency, refund failure, address
// validation, happy-path regression guard
// ═══════════════════════════════════════════════════════════════════════════

describe('FIND-PAY-03: fulfillOrder refund — supplementary assertions', () => {
  const fulfillOrder = (StripeController as any).fulfillOrder;
  const { validateShippingAddress, AddressValidationError } = require('../../utils/addressValidation');

  const makeSession = (overrides: any = {}) => ({
    id: 'cs_supp',
    payment_intent: 'pi_supp_test',
    metadata: {
      listing_id: 'lst_supp',
      buyer_id: 'buyer_supp',
      seller_id: 'seller_supp',
      quantity: '1',
      item_price: '50',
    },
    collected_information: {
      shipping_details: {
        name: 'Test',
        address: { line1: '1 St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
      },
    },
    ...overrides,
  });

  test('listing-not-found refund carries idempotency key fulfillment_refund_<piId>', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.listings.findUnique.mockResolvedValue(null);
    mockRefundsCreate.mockResolvedValue({ id: 're_idem' });

    await fulfillOrder.call(StripeController, makeSession());

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: 'fulfillment_refund_pi_supp_test',
      })
    );
  });

  test('refund failure does not throw — webhook still returns 200', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.listings.findUnique.mockResolvedValue(null);
    mockRefundsCreate.mockRejectedValue(new Error('Stripe outage'));

    await expect(
      fulfillOrder.call(StripeController, makeSession())
    ).resolves.toBeUndefined();
  });

  test('address validation failure triggers refund before propagating', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.listings.findUnique.mockResolvedValue({
      id: 'lst_supp',
      title: 'Test Club',
      images: [{ image_url: 'img.jpg' }],
    });
    const addrErr = new AddressValidationError();
    addrErr.message = 'Missing: line1';
    validateShippingAddress.mockImplementation(() => { throw addrErr; });
    mockRefundsCreate.mockResolvedValue({ id: 're_addr' });

    await expect(
      fulfillOrder.call(StripeController, makeSession())
    ).rejects.toThrow();

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_supp_test',
        metadata: expect.objectContaining({
          reason: 'address_validation_failed',
        }),
      }),
      expect.objectContaining({
        idempotencyKey: 'fulfillment_refund_pi_supp_test',
      })
    );
  });

  test('happy path — listing exists, address valid → no refund issued', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);
    mockPrisma.listings.findUnique.mockResolvedValue({
      id: 'lst_supp',
      title: 'Test Club',
      images: [{ image_url: 'img.jpg' }],
    });
    validateShippingAddress.mockReturnValue({
      name: 'Test', line1: '1 St', line2: '', city: 'London',
      state: '', postal_code: 'SW1A 1AA', country: 'GB',
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      payment_method: 'pm_test',
    });
    mockPrisma.$transaction.mockResolvedValue({
      createdOrder: { id: 'ord_hp', amount: 50, listing_id: 'lst_supp', buyer_id: 'buyer_supp' },
      shouldMarkSold: false,
    });

    await fulfillOrder.call(StripeController, makeSession({
      metadata: {
        listing_id: 'lst_supp',
        buyer_id: 'buyer_supp',
        seller_id: 'seller_supp',
        quantity: '1',
        item_price: '5000',
        seller_payout: '4500',
        unit_price: '5000',
        selected_size: null,
        insurance_premium: '0',
      },
    }));

    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Forced return threshold — isForceReturnThreshold boundary tests
//
// Spec §5.3: refund > 60% of item cost → mandatory return before 100% refund.
// Strict greater-than: exactly 60% is the max partial (money-only, no return).
// ═══════════════════════════════════════════════════════════════════════════

describe('forced return threshold (isForceReturnThreshold)', () => {
  test('FORCED_RETURN_THRESHOLD equals MAX_PARTIAL_FRACTION (0.60)', () => {
    expect(FORCED_RETURN_THRESHOLD).toBe(MAX_PARTIAL_FRACTION);
    expect(FORCED_RETURN_THRESHOLD).toBe(0.60);
  });

  test('exactly 60% of item cost → NO forced return (max partial)', () => {
    expect(isForceReturnThreshold(60, 100)).toBe(false);
  });

  test('60.01% of item cost → forced return', () => {
    expect(isForceReturnThreshold(60.01, 100)).toBe(true);
  });

  test('100% of item cost → forced return', () => {
    expect(isForceReturnThreshold(100, 100)).toBe(true);
  });

  test('50% of item cost → NO forced return', () => {
    expect(isForceReturnThreshold(50, 100)).toBe(false);
  });

  test('zero item cost → no forced return (safety)', () => {
    expect(isForceReturnThreshold(10, 0)).toBe(false);
  });

  test('negative item cost → no forced return (safety)', () => {
    expect(isForceReturnThreshold(10, -5)).toBe(false);
  });

  test('£1 above threshold on a £200 item → forced return', () => {
    const threshold = 200 * 0.60;    // = 120
    expect(isForceReturnThreshold(120, 200)).toBe(false);
    expect(isForceReturnThreshold(120.01, 200)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Refund policy rules — allowed percents, admin amounts
//
// Spec §5.2: partial refunds are 10–60% in 10% steps (money-only).
// 100% = full refund with return. Nothing else is allowed.
// ═══════════════════════════════════════════════════════════════════════════

describe('refund policy — allowed buyer refund percents', () => {
  const allowed = [10, 20, 30, 40, 50, 60, 100];
  test.each(allowed)('%d%% is allowed for buyer dispute', (pct) => {
    expect(isAllowedBuyerRefundPercent(pct)).toBe(true);
  });

  const disallowed = [0, 5, 15, 25, 35, 45, 55, 65, 70, 75, 80, 90, 99, 101, -10];
  test.each(disallowed)('%d%% is NOT allowed for buyer dispute', (pct) => {
    expect(isAllowedBuyerRefundPercent(pct)).toBe(false);
  });
});

describe('refund policy — seller counter-offer percents', () => {
  const allowed = [10, 20, 30, 40, 50, 60];
  test.each(allowed)('%d%% is allowed as seller counter', (pct) => {
    expect(isAllowedCounterPercent(pct)).toBe(true);
  });

  test('100% is NOT allowed as counter (seller should accept, not counter)', () => {
    expect(isAllowedCounterPercent(100)).toBe(false);
  });

  test('0% is NOT allowed as counter', () => {
    expect(isAllowedCounterPercent(0)).toBe(false);
  });
});

describe('refund policy — admin partial amount limits', () => {
  test('up to 60% of £100 item (£60) is allowed', () => {
    expect(isAllowedAdminPartialAmount(60, 100)).toBe(true);
  });

  test('£0.01 is allowed (minimum meaningful refund)', () => {
    expect(isAllowedAdminPartialAmount(0.01, 100)).toBe(true);
  });

  test('£60.01 on a £100 item is NOT allowed (exceeds 60%)', () => {
    expect(isAllowedAdminPartialAmount(60.01, 100)).toBe(false);
  });

  test('zero amount is not allowed', () => {
    expect(isAllowedAdminPartialAmount(0, 100)).toBe(false);
  });

  test('negative amount is not allowed', () => {
    expect(isAllowedAdminPartialAmount(-10, 100)).toBe(false);
  });

  test('PARTIAL_REFUND_PERCENTS constant = [10, 20, 30, 40, 50, 60]', () => {
    expect([...PARTIAL_REFUND_PERCENTS]).toEqual([10, 20, 30, 40, 50, 60]);
  });

  test('FULL_REFUND_PERCENT = 100', () => {
    expect(FULL_REFUND_PERCENT).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Return label payer resolution
//
// Spec §5.3: forced returns → platform pays for return label.
// Normal returns → buyer pays.
// ═══════════════════════════════════════════════════════════════════════════

describe('return label payer resolution (resolveReturnLabelPayer)', () => {
  test('forced return → platform pays', () => {
    expect(resolveReturnLabelPayer({ is_forced: true })).toBe('platform');
  });

  test('normal return → buyer pays', () => {
    expect(resolveReturnLabelPayer({ is_forced: false })).toBe('buyer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Forced return timing constants
//
// These are tripwires — if someone changes a timing constant,
// this test fails and forces a conscious decision.
// ═══════════════════════════════════════════════════════════════════════════

describe('forced return timing constants', () => {
  test('seller confirm window = 3 days', () => {
    expect(FORCED_RETURN_SELLER_CONFIRM_DAYS).toBe(3);
  });

  test('seller confirm fallback = 14 days (auto-confirm if no action)', () => {
    expect(FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS).toBe(14);
  });

  test('return ship deadline matches non-forced return deadline', () => {
    expect(FORCED_RETURN_SHIP_DEADLINE_DAYS).toBe(RETURN_SHIPPING_DEADLINE_DAYS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKING status lists — single-source-of-truth tripwires
//
// escrowDecisions.ts is the ONE canonical list. escrowService.ts imports it.
// If this test fails, someone re-forked the list instead of importing.
// ═══════════════════════════════════════════════════════════════════════════

describe('BLOCKING status lists — escrowDecisions.ts tripwires', () => {
  test('BLOCKING_DISPUTE_STATUSES = [open, counter_offered, escalated]', () => {
    expect([...BLOCKING_DISPUTE_STATUSES]).toEqual([
      'open',
      'counter_offered',
      'escalated',
    ]);
  });

  test('BLOCKING_RETURN_STATUSES includes all pre-completion return statuses including refund_processing', () => {
    expect([...BLOCKING_RETURN_STATUSES]).toEqual([
      'pending',
      'approved',
      'awaiting_address',
      'label_created',
      'shipped',
      'delivered',
      'refund_processing',
    ]);
  });

  test('refund_processing IS included — blocks escrow during in-flight refund', () => {
    expect([...BLOCKING_RETURN_STATUSES]).toContain('refund_processing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Escrow timing — return escrow days divergence tripwire
//
// FINDING: returnController.ts hardcodes RETURN_ESCROW_DAYS = 5 for
// normal return delivery (confirmReturnDelivered), while the main
// ESCROW_RELEASE_DAYS from constants.ts = INSPECTION_WINDOW_DAYS = 3.
// These tripwires lock in the current values.
// ═══════════════════════════════════════════════════════════════════════════

describe('escrow timing tripwires — delivery vs return escrow', () => {
  test('ESCROW_RELEASE_DAYS (delivery) = INSPECTION_WINDOW_DAYS = 3', () => {
    expect(ESCROW_RELEASE_DAYS).toBe(3);
    expect(ESCROW_RELEASE_DAYS).toBe(INSPECTION_WINDOW_DAYS);
  });

  test('RETURN_ESCROW_DAYS = INSPECTION_WINDOW_DAYS = 3', () => {
    expect(RETURN_ESCROW_DAYS).toBe(INSPECTION_WINDOW_DAYS);
    expect(RETURN_ESCROW_DAYS).toBe(3);
  });

  test('RETURN_SHIPPING_DEADLINE_DAYS = 5', () => {
    expect(RETURN_SHIPPING_DEADLINE_DAYS).toBe(5);
  });
});
