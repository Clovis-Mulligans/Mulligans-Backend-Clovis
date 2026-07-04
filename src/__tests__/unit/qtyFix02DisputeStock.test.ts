// QTY-FIX-02: Dispute stock-restore investigation tests.
//
// Proves that the internal dispute system correctly handles stock:
// - Full refund -> forced return -> stock restored on return completion
// - Partial refund <= 60% -> money-only, buyer keeps item, NO stock restore
// - Forced return completion -> restoreListingStock called inside $transaction
// - off_sale status preserved on restore (S-6 integration)
// - Claim-the-row guard prevents double restore

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── uuid + S3 mocks (ESM modules need mocking before imports) ───
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));

// ─── Stripe mock ───
const mockStripeInstance: any = {
  refunds: { create: jest.fn() },
  paymentIntents: { retrieve: jest.fn(), create: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } },
  accounts: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
const mockTx: any = {
  return_requests: { update: jest.fn() },
  orders: { update: jest.fn() },
  listings: { findUnique: jest.fn(), update: jest.fn() },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

const mockPrisma: any = {
  disputes: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  orders: { findFirst: jest.fn(), update: jest.fn() },
  return_requests: { findUnique: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  users: { findUnique: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));

// ─── Mock side-effect modules ───
const mockCreateForcedReturn = jest.fn();
jest.mock('../../services/forcedReturnService', () => ({
  isForceReturnThreshold: jest.requireActual('../../services/forcedReturnService').isForceReturnThreshold,
  createForcedReturn: (...args: any[]) => mockCreateForcedReturn(...args),
  FORCED_RETURN_SHIP_DEADLINE_DAYS: 7,
}));

const mockRestoreListingStock = jest.fn();
jest.mock('../../lib/stockUtils', () => ({
  restoreListingStock: (...args: any[]) => mockRestoreListingStock(...args),
  logStockDecrement: jest.fn(),
}));

jest.mock('../../services/emailService', () => ({
  sendDisputeOpenedToSeller: jest.fn().mockResolvedValue(undefined),
  sendDisputeOpenedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendDisputeResponseToBuyer: jest.fn().mockResolvedValue(undefined),
  sendDisputeEscalatedToAdmin: jest.fn().mockResolvedValue(undefined),
  sendDisputeEscalatedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendDisputeResolved: jest.fn().mockResolvedValue(undefined),
  sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  sendSaleNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/metaCapi', () => ({
  sendMetaPurchaseEvent: jest.fn(),
}));
jest.mock('../../utils/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/addressValidation', () => ({
  validateShippingAddress: jest.fn(),
  AddressValidationError: class extends Error { missingFields: string[] = []; },
}));
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../services/autoShippingService', () => ({
  autoPurchaseLabel: jest.fn().mockResolvedValue({ success: false }),
}));

// ─── Imports ───
import { DisputeController } from '../../controllers/disputeController';
import { confirmReturnDelivered } from '../../controllers/returnController';
import { restoreListingStock } from '../../lib/stockUtils';

// ─── Helpers ───
function makeDispute(overrides: Record<string, any> = {}) {
  return {
    id: 'dispute_1',
    order_id: 'order_1',
    buyer_id: 'buyer_1',
    seller_id: 'seller_1',
    status: 'open',
    requested_refund_percent: 100,
    requested_refund_amount: { toString: () => '55' },
    counter_offer_percent: null,
    counter_offer_amount: null,
    seller_deadline: new Date(Date.now() + 86400000),
    orders: {
      id: 'order_1',
      amount: { toString: () => '55' },
      seller_payout: { toString: () => '45' },
      listing_title: 'TaylorMade Driver',
      listing_image: 'https://img.test/driver.jpg',
      stripe_payment_intent_id: 'pi_dispute_1',
      listing_id: 'lst_1',
      quantity: 1,
      selected_size: null,
      buyer_id: 'buyer_1',
      seller_id: 'seller_1',
    },
    users_disputes_buyer: { id: 'buyer_1', display_name: 'Buyer', email: 'buyer@test.com' },
    users_disputes_seller: { id: 'seller_1', display_name: 'Seller', email: 'seller@test.com' },
    ...overrides,
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
  mockRestoreListingStock.mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// DISPUTE ROUTING: full refund -> forced return, partial -> money-only
// ═══════════════════════════════════════════════════════════════════════════

describe('QTY-FIX-02: dispute resolution routing', () => {

  test('seller accept 100% -> createForcedReturn called (stock deferred to return)', async () => {
    const dispute = makeDispute({
      requested_refund_percent: 100,
      requested_refund_amount: { toString: () => '55' },
    });

    mockPrisma.$transaction.mockResolvedValue(dispute);
    mockCreateForcedReturn.mockResolvedValue({ returnId: 'ret_1' });
    mockPrisma.disputes.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = {
      params: { id: 'dispute_1' },
      body: { responseType: 'accept' },
      user: { id: 'seller_1' },
    } as any;
    const res = makeMockRes();

    await DisputeController.respondToDispute(req, res);

    expect(mockCreateForcedReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order_1',
        disputeId: 'dispute_1',
        buyerId: 'buyer_1',
        sellerId: 'seller_1',
      })
    );
    expect(res.body.forcedReturn).toBe(true);
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('seller accept 30% -> Stripe refund, NO createForcedReturn (buyer keeps item)', async () => {
    const dispute = makeDispute({
      requested_refund_percent: 30,
      requested_refund_amount: { toString: () => '16.50' },
    });

    mockPrisma.$transaction.mockResolvedValue(dispute);
    mockStripeInstance.refunds.create.mockResolvedValue({ id: 're_partial' });
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.disputes.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = {
      params: { id: 'dispute_1' },
      body: { responseType: 'accept' },
      user: { id: 'seller_1' },
    } as any;
    const res = makeMockRes();

    await DisputeController.respondToDispute(req, res);

    expect(mockCreateForcedReturn).not.toHaveBeenCalled();
    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_dispute_1',
        amount: 1650,
      }),
      expect.objectContaining({ idempotencyKey: 'dispute_refund_dispute_1' })
    );
    expect(mockRestoreListingStock).not.toHaveBeenCalled();
  });

  test('admin full_refund -> createForcedReturn called', async () => {
    const dispute = makeDispute({ status: 'escalated' });

    mockPrisma.$transaction.mockResolvedValue(dispute);
    mockCreateForcedReturn.mockResolvedValue({ returnId: 'ret_admin' });
    mockPrisma.disputes.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = {
      params: { id: 'dispute_1' },
      body: { resolutionType: 'full_refund', resolutionNotes: 'Admin reviewed evidence and granted full refund.' },
    } as any;
    const res = makeMockRes();

    await DisputeController.adminResolveDispute(req, res);

    expect(mockCreateForcedReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order_1',
        disputeId: 'dispute_1',
      })
    );
    expect(res.body.forcedReturn).toBe(true);
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('admin no_refund -> no refund, no stock restore, sale stands', async () => {
    const dispute = makeDispute({ status: 'escalated' });

    mockPrisma.$transaction.mockResolvedValue(dispute);
    mockPrisma.disputes.update.mockResolvedValue({});
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = {
      params: { id: 'dispute_1' },
      body: { resolutionType: 'no_refund', resolutionNotes: 'Item matches description, no refund warranted.' },
    } as any;
    const res = makeMockRes();

    await DisputeController.adminResolveDispute(req, res);

    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
    expect(mockCreateForcedReturn).not.toHaveBeenCalled();
    expect(mockRestoreListingStock).not.toHaveBeenCalled();
    expect(res.body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORCED RETURN COMPLETION: stock restored inside $transaction
// ═══════════════════════════════════════════════════════════════════════════

describe('QTY-FIX-02: forced return completion restores stock', () => {

  function makeForcedReturnRequest() {
    return {
      id: 'ret_forced_1',
      order_id: 'order_1',
      is_forced: true,
      status: 'shipped',
      refund_amount: { toString: () => '45.00' },
      stripe_refund_id: null,
      orders: {
        id: 'order_1',
        buyer_id: 'buyer_1',
        seller_id: 'seller_1',
        listing_id: 'lst_1',
        listing_title: 'TaylorMade Driver',
        listing_image: 'https://img.test/driver.jpg',
        quantity: 2,
        selected_size: null,
        stripe_payment_intent_id: 'pi_forced_1',
      },
    };
  }

  test('confirmReturnDelivered (forced) calls restoreListingStock inside $transaction', async () => {
    const returnReq = makeForcedReturnRequest();
    mockPrisma.return_requests.findUnique.mockResolvedValue(returnReq);

    // First $transaction: claim-the-row
    mockPrisma.$transaction.mockResolvedValueOnce(true);
    // Stripe refund
    mockStripeInstance.refunds.create.mockResolvedValue({ id: 're_forced_1' });

    // Second $transaction: finalize + restore stock
    let txCallback: any;
    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => {
      txCallback = fn;
      return fn(mockTx);
    });

    mockTx.return_requests.update.mockResolvedValue({});
    mockTx.orders.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = { body: { returnId: 'ret_forced_1' }, user: { id: 'seller_1' } } as any;
    const res = makeMockRes();

    await confirmReturnDelivered(req, res);

    expect(mockRestoreListingStock).toHaveBeenCalledWith(
      mockTx,
      'lst_1',
      2,
      'return_refund',
      null
    );
    expect(mockTx.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'returned' }),
      })
    );
  });

  test('confirmReturnDelivered uses order.quantity || 1 fallback', async () => {
    const returnReq = makeForcedReturnRequest();
    returnReq.orders.quantity = null as any;
    mockPrisma.return_requests.findUnique.mockResolvedValue(returnReq);

    mockPrisma.$transaction.mockResolvedValueOnce(true);
    mockStripeInstance.refunds.create.mockResolvedValue({ id: 're_qty_fallback' });
    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));
    mockTx.return_requests.update.mockResolvedValue({});
    mockTx.orders.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({ id: 'n1' });

    const req = { body: { returnId: 'ret_forced_1' }, user: { id: 'seller_1' } } as any;
    const res = makeMockRes();

    await confirmReturnDelivered(req, res);

    expect(mockRestoreListingStock).toHaveBeenCalledWith(
      mockTx, 'lst_1', 1, 'return_refund', null
    );
  });

  test('claim-the-row guard: second confirmation returns 409', async () => {
    const returnReq = makeForcedReturnRequest();
    mockPrisma.return_requests.findUnique.mockResolvedValue(returnReq);

    // Claim-the-row returns null (already claimed)
    mockPrisma.$transaction.mockResolvedValueOnce(null);

    const req = { body: { returnId: 'ret_forced_1' }, user: { id: 'seller_1' } } as any;
    const res = makeMockRes();

    await confirmReturnDelivered(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('already being processed');
    expect(mockRestoreListingStock).not.toHaveBeenCalled();
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S-6 INTEGRATION: off_sale preserved on dispute-refund stock restore
// ═══════════════════════════════════════════════════════════════════════════

describe('QTY-FIX-02: off_sale preservation on dispute stock restore', () => {

  test('restoreListingStock preserves off_sale status (S-6 integration)', async () => {
    // Use the REAL restoreListingStock to verify S-6 fix
    const { restoreListingStock: realRestore } = jest.requireActual('../../lib/stockUtils');

    const mockTxLocal: any = {
      listings: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lst_1',
          quantity: 3,
          status: 'off_sale',
          size_quantities: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await realRestore(mockTxLocal, 'lst_1', 1, 'dispute_refund', null);

    expect(mockTxLocal.listings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantity: { increment: 1 },
          status: 'off_sale',
        }),
      })
    );
  });

  test('restoreListingStock restores deleted listing to deleted (not active)', async () => {
    const { restoreListingStock: realRestore } = jest.requireActual('../../lib/stockUtils');

    const mockTxLocal: any = {
      listings: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lst_2',
          quantity: 0,
          status: 'deleted',
          size_quantities: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await realRestore(mockTxLocal, 'lst_2', 1, 'dispute_refund', null);

    expect(mockTxLocal.listings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantity: { increment: 1 },
          status: 'deleted',
        }),
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL: threshold routing is wired correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('QTY-FIX-02 structural: isForceReturnThreshold routing', () => {

  test('isForceReturnThreshold returns true for amount > 60% of item cost', () => {
    const { isForceReturnThreshold } = jest.requireActual('../../services/forcedReturnService');
    expect(isForceReturnThreshold(31, 50)).toBe(true);
    expect(isForceReturnThreshold(50, 50)).toBe(true);
  });

  test('isForceReturnThreshold returns false for amount <= 60% of item cost', () => {
    const { isForceReturnThreshold } = jest.requireActual('../../services/forcedReturnService');
    expect(isForceReturnThreshold(30, 50)).toBe(false);
    expect(isForceReturnThreshold(10, 50)).toBe(false);
  });

  test('isForceReturnThreshold returns false for zero/negative item cost', () => {
    const { isForceReturnThreshold } = jest.requireActual('../../services/forcedReturnService');
    expect(isForceReturnThreshold(10, 0)).toBe(false);
    expect(isForceReturnThreshold(10, -5)).toBe(false);
  });
});
