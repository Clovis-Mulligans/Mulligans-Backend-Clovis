// Tests for completeOrder and confirmReceipt after transferToSeller adoption.
//
// Expected values from the brief and business-logic-v2.md.
// Layer: Unit (mocked Prisma, Stripe, transferToSeller helper)
// Dev-only guard: N/A (unit tests, no real services)

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SHIPPO_API_KEY = process.env.SHIPPO_API_KEY || 'shippo_test_mock';

// ─── transferToSeller mock ───
const mockTransferToSeller = jest.fn();
jest.mock('../../lib/transferToSeller', () => ({
  transferToSeller: (...args: any[]) => mockTransferToSeller(...args),
}));

// ─── Stripe mock (still needed — controller imports Stripe directly for other calls) ───
const mockStripeInstance: any = {
  transfers: { create: jest.fn() },
  paymentIntents: { retrieve: jest.fn(), create: jest.fn() },
  refunds: { create: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } },
  accounts: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
const mockPrisma: any = {
  orders: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  users: { findUnique: jest.fn(), update: jest.fn() },
  notifications: { create: jest.fn() },
  disputes: { findUnique: jest.fn() },
  returns: { findFirst: jest.fn() },
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};
jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));

jest.mock('shippo', () => ({
  Shippo: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/emailService', () => ({
  sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  sendSaleNotification: jest.fn().mockResolvedValue(undefined),
  sendOrderCancellation: jest.fn().mockResolvedValue(undefined),
  sendDeliveryConfirmation: jest.fn().mockResolvedValue(undefined),
  sendEscrowReleased: jest.fn().mockResolvedValue(undefined),
  sendInsuranceReportReceivedToBuyer: jest.fn().mockResolvedValue(undefined),
  sendInsuranceReportReceivedToSeller: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../routes/emailActionRoutes', () => ({
  generateEmailActionToken: jest.fn().mockReturnValue('mock-token'),
}));
jest.mock('../../lib/stockUtils', () => ({
  restoreListingStock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/shippingDeadline', () => ({
  weekdaysUntil: jest.fn().mockReturnValue(5),
  calculateShippingDeadline: jest.fn().mockReturnValue(new Date()),
}));
jest.mock('../../services/escrowService', () => ({
  hasBlockingDispute: jest.fn().mockResolvedValue(false),
  hasBlockingReturn: jest.fn().mockResolvedValue(false),
}));

import { Request, Response } from 'express';
import { sendPushNotification } from '../../controllers/pushNotificationController';
import { hasBlockingDispute, hasBlockingReturn } from '../../services/escrowService';
import { shouldReleaseEscrow } from '../../lib/escrowDecisions';

// Import the controller after all mocks are set up
const { OrderController } = require('../../controllers/orderController');

// ─── Test fixtures ─────────────────────────────────────────────────────

const ACTIVE_SELLER = {
  id: 'test0Y91_seller_active',
  stripe_connect_id: 'acct_test_active',
  stripe_connect_status: 'active',
  display_name: 'Active Seller',
};

const RESTRICTED_SELLER = {
  id: 'test0Y91_seller_restricted',
  stripe_connect_id: 'acct_test_restricted',
  stripe_connect_status: 'restricted',
  display_name: 'Restricted Seller',
};

const PENDING_SELLER = {
  id: 'test0Y91_seller_pending',
  stripe_connect_id: 'acct_test_pending',
  stripe_connect_status: 'pending',
  display_name: 'Pending Seller',
};

const NULL_CONNECT_SELLER = {
  id: 'test0Y91_seller_null',
  stripe_connect_id: null,
  stripe_connect_status: null,
  display_name: 'No Connect Seller',
};

function makeDeliveredOrder(sellerOverride: any = ACTIVE_SELLER, overrides: any = {}) {
  return {
    id: 'test0Y91_order_1',
    buyer_id: 'test0Y91_buyer_1',
    seller_id: sellerOverride.id,
    amount: 50.0,
    seller_payout: 46.25,
    status: 'delivered',
    stripe_transfer_id: null,
    listings: {
      title: 'Test Iron Set',
      images: [{ image_url: 'https://example.com/img.jpg' }],
    },
    users_orders_seller_idTousers: sellerOverride,
    ...overrides,
  };
}

function mockReq(overrides: any = {}): Partial<Request> {
  return {
    params: { id: 'test0Y91_order_1' },
    body: {},
    user: { id: 'test0Y91_buyer_1' },
    ...overrides,
  };
}

function mockRes(): { res: Partial<Response>; statusCode: number; body: any } {
  const state = { statusCode: 200, body: null as any };
  const res: any = {
    status: jest.fn((code: number) => { state.statusCode = code; return res; }),
    json: jest.fn((data: any) => { state.body = data; return res; }),
  };
  return { res, ...state };
}

function getResState(res: any): { statusCode: number; body: any } {
  if (res.status.mock.calls.length > 0) {
    return {
      statusCode: res.status.mock.calls[res.status.mock.calls.length - 1][0],
      body: res.json.mock.calls[res.json.mock.calls.length - 1]?.[0],
    };
  }
  return {
    statusCode: 200,
    body: res.json.mock.calls[res.json.mock.calls.length - 1]?.[0],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.orders.findFirst.mockResolvedValue(null);
  mockPrisma.orders.update.mockResolvedValue({});
  mockPrisma.users.update.mockResolvedValue({});
  mockPrisma.users.findUnique.mockResolvedValue({ email: 'test@example.com' });
  mockPrisma.notifications.create.mockResolvedValue({});
});

// ═════════════════════════════════════════════════════════════════════════
// completeOrder
// ═════════════════════════════════════════════════════════════════════════

describe('completeOrder', () => {
  test('active seller → completed with stripe_transfer_id set', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'transferred', transferId: 'tr_complete_1' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.completeOrder(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);

    expect(mockTransferToSeller).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'complete_order_transfer_test0Y91_order_1',
        metadata: expect.objectContaining({ type: 'order_completed' }),
      }),
    );

    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  test('blocked seller → 409, order not completed, escrow_release_at set', async () => {
    const order = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.completeOrder(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(409);
    expect(body.reason).toBe('stripe_status_restricted');

    // Verify escrow_release_at was set (so cron retries)
    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ escrow_release_at: expect.any(Date) }),
      }),
    );

    // Verify status was NOT set to completed
    const updateData = mockPrisma.orders.update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
  });

  test('already_transferred → 400, no second Stripe call', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'already_transferred', transferId: 'tr_existing' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.completeOrder(req, res);

    const { statusCode } = getResState(res);
    expect(statusCode).toBe(400);
  });

  test('idempotency key uses orderId', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'transferred', transferId: 'tr_1' });

    const req = mockReq({ params: { id: 'test0Y91_order_xyz' } });
    mockPrisma.orders.findFirst.mockResolvedValue({ ...order, id: 'test0Y91_order_xyz' });
    const { res } = mockRes();
    await OrderController.completeOrder(req, res);

    expect(mockTransferToSeller).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'complete_order_transfer_test0Y91_order_xyz',
      }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// confirmReceipt
// ═════════════════════════════════════════════════════════════════════════

describe('confirmReceipt', () => {
  test('active seller → 200, completed, all fields set, payout_status released', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'transferred', transferId: 'tr_confirm_1' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payout_status).toBe('released');
    expect(body.message).toBe('Thank you for confirming receipt. The seller has been paid.');

    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          completed_at: expect.any(Date),
          buyer_confirmed_at: expect.any(Date),
          escrow_release_at: expect.any(Date),
        }),
      }),
    );

    // Counters increment on transferred path
    expect(mockPrisma.users.update).toHaveBeenCalledTimes(2);
  });

  test('restricted seller → 200, payout_status pending, status stays delivered, buyer_confirmed_at set, completed_at null', async () => {
    const order = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payout_status).toBe('pending');
    expect(body.message).toBe('Thank you for confirming receipt.');

    // status NOT set to completed, buyer_confirmed_at IS set
    const updateData = mockPrisma.orders.update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
    expect(updateData.buyer_confirmed_at).toEqual(expect.any(Date));
    expect(updateData.completed_at).toBeUndefined();
    expect(updateData.escrow_release_at).toEqual(expect.any(Date));

    // Counters do NOT increment on blocked path
    expect(mockPrisma.users.update).not.toHaveBeenCalled();
  });

  test('pending seller → 200, payout_status pending', async () => {
    const order = makeDeliveredOrder(PENDING_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_pending' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.payout_status).toBe('pending');
  });

  test('null stripe_connect_id → 200, payout_status pending', async () => {
    const order = makeDeliveredOrder(NULL_CONNECT_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'no_stripe_connect_id' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.payout_status).toBe('pending');
  });

  test('Stripe throws → 200, order stays delivered, no error string to buyer', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'failed', reason: 'stripe_error', code: 'balance_insufficient' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.payout_status).toBe('pending');
    // No Stripe error details in the response
    expect(JSON.stringify(body)).not.toContain('stripe');
    expect(JSON.stringify(body)).not.toContain('balance_insufficient');
  });

  test('blocked path sends payout_blocked notification, NOT "has been transferred"', async () => {
    const order = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const notifCall = mockPrisma.notifications.create.mock.calls[0][0].data;
    expect(notifCall.type).toBe('payout_blocked');
    expect(notifCall.title).toBe('Action needed to get paid');
    expect(notifCall.message).toContain('Complete your Stripe setup');
    expect(notifCall.message).not.toContain('has been transferred');

    const pushCall = (sendPushNotification as jest.Mock).mock.calls[0];
    expect(pushCall[1]).toBe('Action needed to get paid');
    expect(pushCall[2]).toContain('Complete your Stripe setup');
  });

  test('counters increment only on transferred path', async () => {
    // Transferred → counters increment
    const order1 = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order1);
    mockTransferToSeller.mockResolvedValue({ status: 'transferred', transferId: 'tr_1' });

    const req1 = mockReq();
    const { res: res1 } = mockRes();
    await OrderController.confirmReceipt(req1, res1);
    expect(mockPrisma.users.update).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    mockPrisma.orders.update.mockResolvedValue({});
    mockPrisma.notifications.create.mockResolvedValue({});

    // Blocked → counters do NOT increment
    const order2 = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order2);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    const req2 = mockReq();
    const { res: res2 } = mockRes();
    await OrderController.confirmReceipt(req2, res2);
    expect(mockPrisma.users.update).not.toHaveBeenCalled();
  });

  // Existing error responses unchanged
  test('order not found → 404', async () => {
    mockPrisma.orders.findFirst.mockResolvedValue(null);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode } = getResState(res);
    expect(statusCode).toBe(404);
  });

  test('already transferred → 400', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER, { stripe_transfer_id: 'tr_existing' });
    mockPrisma.orders.findFirst.mockResolvedValue(order);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode } = getResState(res);
    expect(statusCode).toBe(400);
  });

  test('active dispute → 400', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    (hasBlockingDispute as jest.Mock).mockResolvedValue(true);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode } = getResState(res);
    expect(statusCode).toBe(400);
    (hasBlockingDispute as jest.Mock).mockResolvedValue(false);
  });

  test('active return → 400', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    (hasBlockingReturn as jest.Mock).mockResolvedValue(true);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode } = getResState(res);
    expect(statusCode).toBe(400);
    (hasBlockingReturn as jest.Mock).mockResolvedValue(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Brief 1b: zero-payout, failed-vs-blocked notification
// ═════════════════════════════════════════════════════════════════════════

describe('confirmReceipt — zero payout', () => {
  test('seller_payout zero → 200, payout_status released, order completed, transferToSeller never called, no notification', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER, { seller_payout: 0 });
    mockPrisma.orders.findFirst.mockResolvedValue(order);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payout_status).toBe('released');

    expect(mockTransferToSeller).not.toHaveBeenCalled();
    expect(mockPrisma.notifications.create).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();

    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  test('seller_payout null → 200, payout_status released, order completed, transferToSeller never called, no notification', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER, { seller_payout: null });
    mockPrisma.orders.findFirst.mockResolvedValue(order);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payout_status).toBe('released');

    expect(mockTransferToSeller).not.toHaveBeenCalled();
    expect(mockPrisma.notifications.create).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  test('zero payout → counters do increment', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER, { seller_payout: 0 });
    mockPrisma.orders.findFirst.mockResolvedValue(order);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    expect(mockPrisma.users.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTIVE_SELLER.id },
        data: expect.objectContaining({ total_sales: { increment: 1 } }),
      }),
    );
    expect(mockPrisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'test0Y91_buyer_1' },
        data: expect.objectContaining({ total_purchases: { increment: 1 } }),
      }),
    );
  });
});

describe('completeOrder — zero payout', () => {
  test('zero payout → order completed, helper never called, not 409', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER, { seller_payout: 0 });
    mockPrisma.orders.findFirst.mockResolvedValue(order);

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.completeOrder(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);

    expect(mockTransferToSeller).not.toHaveBeenCalled();

    expect(mockPrisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });
});

describe('confirmReceipt — failed vs blocked notifications', () => {
  test('helper returns failed → no seller notification created, no push sent, still 200 / payout_status pending', async () => {
    const order = makeDeliveredOrder(ACTIVE_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'failed', reason: 'stripe_error', code: 'balance_insufficient' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    const { statusCode, body } = getResState(res);
    expect(statusCode).toBe(200);
    expect(body.payout_status).toBe('pending');

    expect(mockPrisma.notifications.create).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  test('helper returns blocked → payout_blocked notification IS sent', async () => {
    const order = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    expect(mockPrisma.notifications.create).toHaveBeenCalledTimes(1);
    const notifCall = mockPrisma.notifications.create.mock.calls[0][0].data;
    expect(notifCall.type).toBe('payout_blocked');

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Integration: blocked path → order still satisfies escrow predicate
// ═════════════════════════════════════════════════════════════════════════

describe('integration: blocked confirmReceipt → order eligible for escrow cron', () => {
  test('after blocked path, order satisfies real escrow predicate', async () => {
    const order = makeDeliveredOrder(RESTRICTED_SELLER);
    mockPrisma.orders.findFirst.mockResolvedValue(order);
    mockTransferToSeller.mockResolvedValue({ status: 'blocked', reason: 'stripe_status_restricted' });

    let capturedUpdateData: any = null;
    mockPrisma.orders.update.mockImplementation((args: any) => {
      capturedUpdateData = args.data;
      return Promise.resolve({});
    });

    const req = mockReq();
    const { res } = mockRes();
    await OrderController.confirmReceipt(req, res);

    // Build a snapshot matching what the escrow cron would see
    const escrowSnapshot = {
      id: order.id,
      status: capturedUpdateData.status || 'delivered',
      auto_cancel_at: null,
      escrow_release_at: capturedUpdateData.escrow_release_at,
      shipped_at: null,
      delivered_at: new Date(),
      refunded_at: null,
      stripe_transfer_id: capturedUpdateData.stripe_transfer_id || null,
      stripe_refund_id: null,
      lost_notification_sent_at: null,
      label_auto_generated: false,
      label_cost: null,
      shipping_cost: 0,
      item_price: 100,
      quantity: 1,
    };

    const now = new Date(capturedUpdateData.escrow_release_at.getTime() + 1000);
    const eligible = shouldReleaseEscrow(
      escrowSnapshot,
      { hasBlockingDispute: false, hasBlockingReturn: false },
      now,
    );
    expect(eligible).toBe(true);
  });
});
