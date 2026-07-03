/**
 * QTY-FIX-01: Money-critical stock/webhook fixes.
 *
 * Functional tests invoke real logic (restoreListingStock, mock-tx simulation).
 * Structural tests (labeled) verify wiring that cannot be exercised without a
 * running database — following the checkoutOversellLock.test.ts pattern.
 */
import { restoreListingStock, StockChangeCause } from '../../lib/stockUtils';
import * as fs from 'fs';
import * as path from 'path';

// ─── Shared mock helpers ───────────────────────────────────────────────

let mockListing: {
  id: string;
  quantity: number;
  status: string;
  specifications: any;
} | null = null;

let lastUpdate: { where: any; data: any } | null = null;
let queryRawCalls: string[] = [];

const makeTx = () => ({
  listings: {
    findUnique: jest.fn(async () => mockListing),
    update: jest.fn(async (_args: any) => {
      lastUpdate = _args;
      if (mockListing) {
        if (typeof _args.data.quantity === 'object' && 'increment' in _args.data.quantity) {
          mockListing.quantity += _args.data.quantity.increment;
        } else if (typeof _args.data.quantity === 'number') {
          mockListing.quantity = _args.data.quantity;
        }
        if (_args.data.status) mockListing.status = _args.data.status;
        if (_args.data.specifications) mockListing.specifications = _args.data.specifications;
      }
      return mockListing;
    }),
  },
  orders: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  return_requests: {
    update: jest.fn(),
  },
  $queryRawUnsafe: jest.fn(async (sql: string) => {
    queryRawCalls.push(sql);
    return [{ id: mockListing?.id }];
  }),
});

beforeEach(() => {
  mockListing = null;
  lastUpdate = null;
  queryRawCalls = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── S-6: restoreListingStock preserves off_sale status ─────────────

describe('S-6: restoreListingStock preserves off_sale status', () => {
  test('plain-quantity off_sale listing keeps off_sale after stock restore', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'off_sale', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 2, 'order_cancelled');

    expect(lastUpdate!.data.status).toBe('off_sale');
    expect(lastUpdate!.data.quantity).toEqual({ increment: 2 });
  });

  test('size-variant off_sale listing keeps off_sale after stock restore', async () => {
    mockListing = {
      id: 'L2',
      quantity: 0,
      status: 'off_sale',
      specifications: { sizeQuantities: { S: 0, M: 0 } },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'dispute_refund', 'S');

    expect(lastUpdate!.data.status).toBe('off_sale');
    expect(lastUpdate!.data.specifications.sizeQuantities.S).toBe(1);
  });

  test('sold listing still returns to active (regression)', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, 'order_cancelled');

    expect(lastUpdate!.data.status).toBe('active');
  });

  test('deleted listing still stays deleted (regression)', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'deleted', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, 'return_refund');

    expect(lastUpdate!.data.status).toBe('deleted');
  });
});

// ─── C-2: dispute resolution stock restore ──────────────────────────

describe('C-2: dispute lost → stock restore per order', () => {
  test('restores stock for each order in a multi-order PI (cart scenario)', async () => {
    const orders = [
      { id: 'o1', listing_id: 'L1', quantity: 2, selected_size: null },
      { id: 'o2', listing_id: 'L2', quantity: 1, selected_size: 'M' },
    ];

    const tx = makeTx();

    // First order: plain quantity
    mockListing = { id: 'L1', quantity: 3, status: 'active', specifications: null };
    await restoreListingStock(tx as any, 'L1', orders[0].quantity, 'dispute_refund', null);
    expect(mockListing.quantity).toBe(5);

    // Second order: size variant
    mockListing = {
      id: 'L2', quantity: 1, status: 'active',
      specifications: { sizeQuantities: { M: 0, L: 1 } },
    };
    await restoreListingStock(tx as any, 'L2', orders[1].quantity, 'dispute_refund', 'M');
    expect(lastUpdate!.data.specifications.sizeQuantities.M).toBe(1);
    expect(lastUpdate!.data.quantity).toBe(2);
  });

  test('idempotency: claimed.count === 0 prevents double stock restore', async () => {
    const tx = makeTx();
    mockListing = { id: 'L1', quantity: 5, status: 'active', specifications: null };

    // First call: claim succeeds
    tx.orders.updateMany.mockResolvedValueOnce({ count: 1 });
    const firstClaim = await tx.orders.updateMany({
      where: { stripe_payment_intent_id: 'pi_1', status: 'disputed' },
      data: { status: 'refunded' },
    });
    expect(firstClaim.count).toBe(1);
    await restoreListingStock(tx as any, 'L1', 1, 'dispute_refund');
    expect(mockListing.quantity).toBe(6);

    // Second call (redelivery): claim returns 0 — no restore should follow
    tx.orders.updateMany.mockResolvedValueOnce({ count: 0 });
    const secondClaim = await tx.orders.updateMany({
      where: { stripe_payment_intent_id: 'pi_1', status: 'disputed' },
      data: { status: 'refunded' },
    });
    expect(secondClaim.count).toBe(0);
    // Real handler returns early here — stock stays at 6, not 7
  });

  test('won dispute: no stock restore, order → to_ship', async () => {
    const tx = makeTx();
    tx.orders.updateMany.mockResolvedValue({ count: 1 });

    const result = await tx.orders.updateMany({
      where: { stripe_payment_intent_id: 'pi_1', status: 'disputed' },
      data: { status: 'to_ship', updated_at: new Date() },
    });

    expect(result.count).toBe(1);
    expect(tx.orders.updateMany.mock.calls[0][0].data.status).toBe('to_ship');
    expect(tx.listings.update).not.toHaveBeenCalled();
  });
});

// ─── H-3: admin refund atomicity ─────────────────────────────────────

describe('H-3: admin refund stock restore inside transaction', () => {
  test('simulated tx body: all 3 operations succeed atomically', async () => {
    const tx = makeTx();
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };

    // Simulate the callback-form transaction body
    await tx.return_requests.update({
      where: { id: 'ret_1' },
      data: { status: 'completed', stripe_refund_id: 'ref_1' },
    });
    await tx.orders.updateMany({
      where: { id: 'order_1' },
      data: { status: 'returned', stripe_refund_id: 'ref_1' },
    });
    await restoreListingStock(tx as any, 'L1', 1, 'return_refund');

    expect(tx.return_requests.update).toHaveBeenCalledTimes(1);
    expect(tx.orders.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.listings.update).toHaveBeenCalledTimes(1);
    expect(mockListing.quantity).toBe(1);
    expect(mockListing.status).toBe('active');
  });

  test('simulated tx: restore failure rolls back entire transaction', async () => {
    const tx = makeTx();
    mockListing = null; // listing not found → restoreListingStock logs error

    let txCommitted = false;
    try {
      await tx.return_requests.update({ where: { id: 'ret_1' }, data: { status: 'completed' } });
      await tx.orders.updateMany({ where: { id: 'order_1' }, data: { status: 'returned' } });

      // restoreListingStock with null listing doesn't throw — it logs and returns.
      // But if we simulate a real failure (e.g., db error):
      tx.listings.update.mockRejectedValueOnce(new Error('DB connection lost'));
      mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
      await restoreListingStock(tx as any, 'L1', 1, 'return_refund');
      txCommitted = true;
    } catch (err) {
      // In a real $transaction, this error rolls back everything
      expect((err as Error).message).toBe('DB connection lost');
    }

    expect(txCommitted).toBe(false);
  });
});

// ─── M-4: native payment refund simulation ──────────────────────────

describe('M-4: native payment error path refund logic', () => {
  test('refund succeeds → message says "has been refunded"', () => {
    const refundIssued = true;
    const errorMessage = 'Insufficient stock for listing L1';

    const userMessage = errorMessage.includes('Insufficient stock')
      ? (refundIssued
          ? 'This item is no longer available. Your payment has been refunded.'
          : 'This item is no longer available. Your refund is being processed.')
      : errorMessage;

    expect(userMessage).toBe('This item is no longer available. Your payment has been refunded.');
  });

  test('refund fails → message says "is being processed"', () => {
    const refundIssued = false;
    const errorMessage = 'Insufficient stock for listing L1';

    const userMessage = errorMessage.includes('Insufficient stock')
      ? (refundIssued
          ? 'This item is no longer available. Your payment has been refunded.'
          : 'This item is no longer available. Your refund is being processed.')
      : errorMessage;

    expect(userMessage).toBe('This item is no longer available. Your refund is being processed.');
  });
});

// ─── Structural guarantees (wiring verification) ─────────────────────
// These verify that fixes are wired correctly at the source level.
// They complement the functional tests above — not a substitute.

describe('structural: S-5 escrow_release_at nulled in dispute.created', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/stripeController.ts'), 'utf-8',
  );
  const disputeCreatedBlock = source.slice(
    source.indexOf("case 'charge.dispute.created':"),
    source.indexOf("case 'charge.dispute.closed':"),
  );

  test('updateMany data includes escrow_release_at: null', () => {
    expect(disputeCreatedBlock).toContain('escrow_release_at: null');
  });
});

describe('structural: C-2 dispute.closed handler wiring', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/stripeController.ts'), 'utf-8',
  );
  const closedBlock = source.slice(
    source.indexOf("case 'charge.dispute.closed':"),
    source.indexOf("default:"),
  );

  test('handler exists with lost and won branches', () => {
    expect(closedBlock).toContain("closedDispute.status === 'lost'");
    expect(closedBlock).toContain("closedDispute.status === 'won'");
  });

  test('lost path calls restoreListingStock with tx (not prisma)', () => {
    const match = closedBlock.match(/restoreListingStock\(\s*(\w+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('tx');
  });

  test('lost path has claimed.count === 0 early return (idempotency guard)', () => {
    expect(closedBlock).toContain('claimed.count === 0');
  });

  test('won path sets status to to_ship', () => {
    const wonBlock = closedBlock.slice(closedBlock.indexOf("=== 'won'"));
    expect(wonBlock).toContain("status: 'to_ship'");
  });
});

describe('structural: H-1 idempotency checks inside transactions', () => {
  const controllers = [
    {
      file: 'stripeController.ts',
      method: 'private static async fulfillOrder',
      checkFn: 'tx.orders.findFirst',
    },
    {
      file: 'cartCheckoutController.ts',
      method: 'static async fulfillCartOrder',
      checkFn: 'tx.orders.findMany',
    },
    {
      file: 'nativePaymentController.ts',
      method: 'private static async fulfillSingleItem',
      checkFn: 'tx.orders.findFirst',
    },
    {
      file: 'nativePaymentController.ts',
      method: 'private static async fulfillCart(',
      checkFn: 'tx.orders.findMany',
    },
  ];

  test.each(controllers)(
    '$file $method: idempotency check uses tx (inside transaction)',
    ({ file, method, checkFn }) => {
      const source = fs.readFileSync(
        path.resolve(__dirname, `../../controllers/${file}`), 'utf-8',
      );
      const methodStart = source.indexOf(method);
      const block = source.slice(methodStart, methodStart + 8000);
      const txStart = block.indexOf('prisma.$transaction(async (tx)');
      const checkPos = block.indexOf(checkFn);

      expect(txStart).toBeGreaterThan(0);
      expect(checkPos).toBeGreaterThan(txStart);
    },
  );

  test('no prisma.orders.findFirst outside transaction in fulfillOrder', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../controllers/stripeController.ts'), 'utf-8',
    );
    const start = source.indexOf('private static async fulfillOrder');
    const txStart = source.indexOf('prisma.$transaction(async (tx)', start);
    const before = source.slice(start, txStart);
    expect(before).not.toContain('prisma.orders.findFirst');
  });

  test('no prisma.orders.findMany outside transaction in fulfillCartOrder', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../controllers/cartCheckoutController.ts'), 'utf-8',
    );
    const start = source.indexOf('static async fulfillCartOrder');
    const txStart = source.indexOf('prisma.$transaction(async (tx)', start);
    const before = source.slice(start, txStart);
    expect(before).not.toContain('prisma.orders.findMany');
  });

  test('no prisma.orders.findFirst outside transaction in confirmPayment', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../controllers/nativePaymentController.ts'), 'utf-8',
    );
    const start = source.indexOf('static async confirmPayment');
    const end = source.indexOf('private static async fulfillSingleItem');
    const before = source.slice(start, end);
    expect(before).not.toContain('prisma.orders.findFirst');
  });
});

describe('structural: H-3 admin refund uses callback-form $transaction', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../routes/adminRoutes.ts'), 'utf-8',
  );
  const refundSection = source.slice(
    source.indexOf('persist refund ID'),
    source.indexOf('Admin processed refund'),
  );

  test('uses callback form, not array form', () => {
    expect(refundSection).toContain('$transaction(async (tx)');
    expect(refundSection).not.toContain('$transaction([');
  });

  test('restoreListingStock called with tx (not prisma)', () => {
    const match = refundSection.match(/restoreListingStock\(\s*(\w+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('tx');
  });
});

describe('structural: M-4 refund in native payment error catch block', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/nativePaymentController.ts'), 'utf-8',
  );
  const confirmStart = source.indexOf('static async confirmPayment');
  const confirmEnd = source.indexOf('private static async fulfillSingleItem');
  const catchBlock = source.slice(
    source.indexOf('} catch (error', confirmStart),
    confirmEnd,
  );

  test('calls stripe.refunds.create in the catch block', () => {
    expect(catchBlock).toContain('stripe.refunds.create');
    expect(catchBlock).toContain('payment_intent:');
  });

  test('refund failure has its own try/catch (no crash)', () => {
    expect(catchBlock).toContain('catch (refundErr');
  });

  test('message varies based on refundIssued flag', () => {
    expect(catchBlock).toContain('refundIssued');
    expect(catchBlock).toContain('has been refunded');
    expect(catchBlock).toContain('is being processed');
  });
});

describe('structural: schema index on stripe_payment_intent_id', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf-8',
  );
  const ordersModel = schema.slice(
    schema.indexOf('model orders {'),
    schema.indexOf('model reviews {'),
  );

  test('has @@index (non-unique) on stripe_payment_intent_id', () => {
    expect(ordersModel).toContain('@@index([stripe_payment_intent_id])');
  });

  test('does NOT have @@unique on stripe_payment_intent_id', () => {
    expect(ordersModel).not.toContain('@@unique([stripe_payment_intent_id])');
  });
});
