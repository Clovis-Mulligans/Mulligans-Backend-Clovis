// Unit tests for the transferToSeller helper.
//
// Expected values come from the brief and business-logic-v2.md, NOT from
// reading what the code returns. Stripe and Prisma are mocked; the helper's
// decision logic is the system under test.

const mockTransfersCreate = jest.fn();
const mockOrdersFindMany = jest.fn();
const mockOrdersUpdateMany = jest.fn();

jest.mock('../../lib/prisma', () => ({
  prisma: {
    orders: {
      findMany: (...args: any[]) => mockOrdersFindMany(...args),
      updateMany: (...args: any[]) => mockOrdersUpdateMany(...args),
    },
  },
}));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    transfers: { create: mockTransfersCreate },
  }));
});

import { transferToSeller, TransferToSellerParams } from '../../lib/transferToSeller';
import { sellerCanReceivePayout } from '../../lib/escrowDecisions';

const ACTIVE_SELLER = {
  id: 'test0Y91_seller_active',
  stripe_connect_id: 'acct_test_active',
  stripe_connect_status: 'active',
};

const RESTRICTED_SELLER = {
  id: 'test0Y91_seller_restricted',
  stripe_connect_id: 'acct_test_restricted',
  stripe_connect_status: 'restricted',
};

const PENDING_SELLER = {
  id: 'test0Y91_seller_pending',
  stripe_connect_id: 'acct_test_pending',
  stripe_connect_status: 'pending',
};

const NULL_CONNECT_SELLER = {
  id: 'test0Y91_seller_no_connect',
  stripe_connect_id: null,
  stripe_connect_status: null,
};

function makeParams(overrides: Partial<TransferToSellerParams> = {}): TransferToSellerParams {
  return {
    amountPence: 5000,
    seller: ACTIVE_SELLER,
    idempotencyKey: 'test_key_1',
    metadata: { order_id: 'order_1', type: 'test' },
    orderIds: ['order_1'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersFindMany.mockResolvedValue([{ id: 'order_1', stripe_transfer_id: null }]);
  mockOrdersUpdateMany.mockResolvedValue({ count: 1 });
  mockTransfersCreate.mockResolvedValue({ id: 'tr_test_123' });
});

// ─── sellerCanReceivePayout predicate ──────────────────────────────────

describe('sellerCanReceivePayout', () => {
  test('active seller can receive payout', () => {
    expect(sellerCanReceivePayout(ACTIVE_SELLER)).toBe(true);
  });

  test('restricted seller cannot receive payout', () => {
    expect(sellerCanReceivePayout(RESTRICTED_SELLER)).toBe(false);
  });

  test('pending seller cannot receive payout', () => {
    expect(sellerCanReceivePayout(PENDING_SELLER)).toBe(false);
  });

  test('null stripe_connect_id cannot receive payout', () => {
    expect(sellerCanReceivePayout(NULL_CONNECT_SELLER)).toBe(false);
  });
});

// ─── transferToSeller ──────────────────────────────────────────────────

describe('transferToSeller', () => {
  // 1. Active seller → transferred
  test('active seller → Stripe called once, transfer ID persisted, returns transferred', async () => {
    const result = await transferToSeller(makeParams());

    expect(result).toEqual({ status: 'transferred', transferId: 'tr_test_123' });
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        currency: 'gbp',
        destination: 'acct_test_active',
      }),
      { idempotencyKey: 'test_key_1' },
    );
    expect(mockOrdersUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['order_1'] }, stripe_transfer_id: null },
        data: expect.objectContaining({ stripe_transfer_id: 'tr_test_123' }),
      }),
    );
  });

  // 2. Restricted seller → blocked, no Stripe call
  test('restricted seller → blocked, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ seller: RESTRICTED_SELLER }));

    expect(result).toEqual({ status: 'blocked', reason: 'stripe_status_restricted' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 3. Pending seller → blocked, no Stripe call
  test('pending seller → blocked, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ seller: PENDING_SELLER }));

    expect(result).toEqual({ status: 'blocked', reason: 'stripe_status_pending' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 4. Null stripe_connect_id → blocked, no Stripe call
  test('null stripe_connect_id → blocked, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ seller: NULL_CONNECT_SELLER }));

    expect(result).toEqual({ status: 'blocked', reason: 'no_stripe_connect_id' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 5. Order already has transfer ID → already_transferred, no Stripe call
  test('order already has stripe_transfer_id → already_transferred, no Stripe call', async () => {
    mockOrdersFindMany.mockResolvedValue([{ id: 'order_1', stripe_transfer_id: 'tr_existing_456' }]);

    const result = await transferToSeller(makeParams());

    expect(result).toEqual({ status: 'already_transferred', transferId: 'tr_existing_456' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 6. Stripe throws → failed with code, no order mutated
  test('Stripe error → failed with code, orders not updated', async () => {
    mockTransfersCreate.mockRejectedValue(
      Object.assign(new Error('Insufficient funds'), { code: 'balance_insufficient', type: 'StripeInvalidRequestError' }),
    );

    const result = await transferToSeller(makeParams());

    expect(result).toEqual({ status: 'failed', reason: 'stripe_error', code: 'balance_insufficient' });
    expect(mockOrdersUpdateMany).not.toHaveBeenCalled();
  });

  // 7a. amountPence non-integer → failed, no Stripe call
  test('amountPence as float → failed, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ amountPence: 50.5 }));

    expect(result).toEqual({ status: 'failed', reason: 'invalid_amount' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 7b. amountPence ≤ 0 → failed, no Stripe call
  test('amountPence zero → failed, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ amountPence: 0 }));

    expect(result).toEqual({ status: 'failed', reason: 'invalid_amount' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  test('amountPence negative → failed, Stripe never called', async () => {
    const result = await transferToSeller(makeParams({ amountPence: -100 }));

    expect(result).toEqual({ status: 'failed', reason: 'invalid_amount' });
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  // 8. Multi-order orderIds → all stamped with the same transfer ID
  test('multi-order → all orders stamped with same transfer ID', async () => {
    const orderIds = ['order_1', 'order_2', 'order_3'];
    mockOrdersFindMany.mockResolvedValue(
      orderIds.map(id => ({ id, stripe_transfer_id: null })),
    );
    mockOrdersUpdateMany.mockResolvedValue({ count: 3 });

    const result = await transferToSeller(makeParams({ orderIds }));

    expect(result).toEqual({ status: 'transferred', transferId: 'tr_test_123' });
    expect(mockOrdersUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: orderIds }, stripe_transfer_id: null },
      }),
    );
  });

  // 9. updateMany affects zero rows after successful transfer → error-level log
  test('zero rows updated after transfer → error log containing transfer ID', async () => {
    mockOrdersUpdateMany.mockResolvedValue({ count: 0 });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await transferToSeller(makeParams());

    expect(result).toEqual({ status: 'transferred', transferId: 'tr_test_123' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('tr_test_123'),
    );
    consoleSpy.mockRestore();
  });

  // 10. Successful transfer → log line contains transfer ID and amount
  test('success → log line contains transfer ID and amount', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await transferToSeller(makeParams({ amountPence: 4625 }));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/tr_test_123.*£46\.25/),
    );
    consoleSpy.mockRestore();
  });
});
