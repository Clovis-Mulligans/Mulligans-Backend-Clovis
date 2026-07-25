// Shippo webhook auto_cancel_at handling — unit tests
//
// Spec source: business-logic-v2.md §2.5, §4.7
// Fix brief: BRIEF-fix-autocancel-pretransit.md §4–§5
//
// Tests that auto_cancel_at is:
//   - PRESERVED on PRE_TRANSIT (the bug fix)
//   - CLEARED on TRANSIT, DELIVERED, RETURNED
//   - PRESERVED on FAILURE (spec §2.5 — manual admin recovery)
//   - Consistently applied across multi-item shipments

process.env.SHIPPO_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockFindFirst = jest.fn();
const mockFindUnique = jest.fn();
const mockNotificationsCreate = jest.fn().mockResolvedValue({});
const mockUsersFind = jest.fn().mockResolvedValue(null);
const mockReturnFindFirst = jest.fn().mockResolvedValue(null);

const mockPrisma: any = {
  orders: {
    findFirst: mockFindFirst,
    findUnique: mockFindUnique,
    updateMany: mockUpdateMany,
    update: jest.fn(),
  },
  notifications: { create: mockNotificationsCreate },
  users: { findUnique: mockUsersFind },
  return_requests: { findFirst: mockReturnFindFirst },
};

jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/emailService', () => ({
  sendDeliveryConfirmation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../routes/emailActionRoutes', () => ({
  generateEmailActionToken: jest.fn().mockReturnValue('mock-token'),
}));
jest.mock('../../utils/carrierName', () => ({
  normalizeCarrierName: jest.fn((c: string) => c),
}));
jest.mock('../../lib/sellerAddress', () => ({
  getSellerSendingAddress: jest.fn().mockResolvedValue({ address: null }),
}));
jest.mock('../../lib/imageOrder', () => ({
  PRIMARY_IMAGE_ORDER: { display_order: 'asc' },
}));
jest.mock('shippo', () => ({
  Shippo: jest.fn(() => ({
    rates: { get: jest.fn() },
    transactions: { create: jest.fn() },
    refunds: { create: jest.fn() },
  })),
}));

import { handleShippoWebhook } from '../../controllers/shippingController';
import { ESCROW_RELEASE_DAYS } from '../../config/constants';

function makeBaseOrder(overrides: Record<string, any> = {}) {
  return {
    id: 'order_test_001',
    status: 'to_ship',
    buyer_id: 'buyer_001',
    seller_id: 'seller_001',
    tracking_number: 'TRACK123',
    shipped_at: null,
    delivered_at: null,
    auto_cancel_at: new Date('2026-08-01T23:59:59.999Z'),
    amount: 36,
    listing_id: 'listing_001',
    ...overrides,
  };
}

function makeReq(trackingStatus: string) {
  return {
    query: { token: 'test-webhook-secret' },
    body: {
      event: 'track_updated',
      data: {
        tracking_number: 'TRACK123',
        tracking_status: { status: trackingStatus },
      },
    },
  } as any;
}

function makeRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReturnFindFirst.mockResolvedValue(null);
});

// ─── PRE_TRANSIT: the core bug fix ──────────────────────────────────────

describe('PRE_TRANSIT preserves auto_cancel_at', () => {
  test('updateMany data does NOT include auto_cancel_at', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);

    await handleShippoWebhook(makeReq('PRE_TRANSIT'), makeRes());

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const updateData = mockUpdateMany.mock.calls[0][0].data;

    expect(updateData).not.toHaveProperty('auto_cancel_at');
    expect(updateData.status).toBe('to_ship');
    expect(updateData.shipped_at).toBeNull();
  });
});

// ─── TRANSIT: clears auto_cancel_at ─────────────────────────────────────

describe('TRANSIT clears auto_cancel_at', () => {
  test('updateMany data sets auto_cancel_at to null and shipped_at', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);

    await handleShippoWebhook(makeReq('TRANSIT'), makeRes());

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const updateData = mockUpdateMany.mock.calls[0][0].data;

    expect(updateData.auto_cancel_at).toBeNull();
    expect(updateData.status).toBe('in_transit');
    expect(updateData.shipped_at).toBeInstanceOf(Date);
  });

  test('TRANSIT does not overwrite existing shipped_at', async () => {
    const existingShippedAt = new Date('2026-07-20T10:00:00Z');
    const order = makeBaseOrder({ shipped_at: existingShippedAt });
    mockFindFirst.mockResolvedValue(order);

    await handleShippoWebhook(makeReq('TRANSIT'), makeRes());

    const updateData = mockUpdateMany.mock.calls[0][0].data;
    expect(updateData.shipped_at).toEqual(existingShippedAt);
  });
});

// ─── DELIVERED: clears auto_cancel_at ───────────────────────────────────

describe('DELIVERED clears auto_cancel_at', () => {
  test('sets auto_cancel_at null, status delivered, escrow_release_at set', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);
    mockFindUnique.mockResolvedValue({
      ...order,
      listings: { title: 'Test Club', images: [] },
    });

    await handleShippoWebhook(makeReq('DELIVERED'), makeRes());

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const updateData = mockUpdateMany.mock.calls[0][0].data;

    expect(updateData.auto_cancel_at).toBeNull();
    expect(updateData.status).toBe('delivered');
    expect(updateData.delivered_at).toBeInstanceOf(Date);
    expect(updateData.escrow_release_at).toBeInstanceOf(Date);

    const escrowDays = Math.round(
      (updateData.escrow_release_at.getTime() - updateData.delivered_at.getTime()) /
      (24 * 60 * 60 * 1000)
    );
    expect(escrowDays).toBe(ESCROW_RELEASE_DAYS);
  });
});

// ─── RETURNED: clears auto_cancel_at ────────────────────────────────────

describe('RETURNED clears auto_cancel_at', () => {
  test('sets auto_cancel_at null and status returned', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);

    await handleShippoWebhook(makeReq('RETURNED'), makeRes());

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const updateData = mockUpdateMany.mock.calls[0][0].data;

    expect(updateData.auto_cancel_at).toBeNull();
    expect(updateData.status).toBe('returned');
  });
});

// ─── FAILURE: preserves auto_cancel_at (spec §2.5) ─────────────────────

describe('FAILURE preserves auto_cancel_at', () => {
  test('updateMany data does NOT include auto_cancel_at', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);

    await handleShippoWebhook(makeReq('FAILURE'), makeRes());

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const updateData = mockUpdateMany.mock.calls[0][0].data;

    expect(updateData).not.toHaveProperty('auto_cancel_at');
    expect(updateData.status).toBe('delivery_failed');
  });
});

// ─── Multi-item shipment: shared tracking_number ────────────────────────

describe('multi-item shipment', () => {
  test('updateMany WHERE matches on tracking_number, not order id', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);
    mockUpdateMany.mockResolvedValue({ count: 3 });

    await handleShippoWebhook(makeReq('TRANSIT'), makeRes());

    const where = mockUpdateMany.mock.calls[0][0].where;
    expect(where).toEqual({ tracking_number: 'TRACK123' });
    expect(where).not.toHaveProperty('id');
  });
});

// ─── Webhook auth ───────────────────────────────────────────────────────

describe('webhook authentication', () => {
  test('rejects invalid token with 401', async () => {
    const req = makeReq('TRANSIT');
    req.query.token = 'wrong-token';
    const res = makeRes();

    await handleShippoWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

// ─── Response contract ──────────────────────────────────────────────────

describe('webhook response', () => {
  test('always returns 200 to acknowledge receipt', async () => {
    const order = makeBaseOrder();
    mockFindFirst.mockResolvedValue(order);
    const res = makeRes();

    await handleShippoWebhook(makeReq('PRE_TRANSIT'), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ received: true }));
  });
});
