/**
 * SB-04: Verify that cancellation paths restore listing stock via restoreListingStock.
 *
 * Tests verify:
 * 1. Auto-cancel (escrowService) now calls restoreListingStock inside a transaction
 * 2. Buyer/seller cancel (orderController) passes selected_size
 * 3. Size-variant orders restore to correct bucket
 * 4. Sold listings return to active after restore
 * 5. Idempotency: already-cancelled orders can't be re-cancelled
 */
import { restoreListingStock } from '../../lib/stockUtils';

// --- Mock state ---
let mockListing: any = null;
let lastUpdate: any = null;
let queryRawCalls: string[] = [];

const makeTx = () => ({
  listings: {
    findUnique: jest.fn(async () => mockListing),
    update: jest.fn(async (args: any) => {
      lastUpdate = args;
      if (mockListing) {
        if (typeof args.data.quantity === 'object' && 'increment' in args.data.quantity) {
          mockListing.quantity += args.data.quantity.increment;
        } else if (typeof args.data.quantity === 'number') {
          mockListing.quantity = args.data.quantity;
        }
        if (args.data.status) mockListing.status = args.data.status;
        if (args.data.specifications) mockListing.specifications = args.data.specifications;
      }
      return mockListing;
    }),
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
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SB-04: cancel paths restore stock via restoreListingStock', () => {
  test('auto-cancel: plain item quantity restored', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 2, 'order_cancelled', null);

    expect(tx.listings.update).toHaveBeenCalledTimes(1);
    expect(lastUpdate.data.quantity).toEqual({ increment: 2 });
    expect(mockListing.quantity).toBe(2);
  });

  test('auto-cancel: sold listing returns to active', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, 'order_cancelled', null);

    expect(lastUpdate.data.status).toBe('active');
  });

  test('buyer cancel: size-variant order restores correct bucket', async () => {
    mockListing = {
      id: 'L2',
      quantity: 1,
      status: 'active',
      specifications: { sizeQuantities: { S: 1, M: 0, L: 0 } },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'order_cancelled', 'M');

    expect(lastUpdate.data.specifications.sizeQuantities.M).toBe(1);
    expect(lastUpdate.data.specifications.sizeQuantities.S).toBe(1);
    expect(lastUpdate.data.quantity).toBe(2);
  });

  test('seller cancel: size-variant sold listing returns to active', async () => {
    mockListing = {
      id: 'L3',
      quantity: 0,
      status: 'sold',
      specifications: { sizeQuantities: { M: 0 } },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L3', 1, 'order_cancelled', 'M');

    expect(lastUpdate.data.status).toBe('active');
    expect(lastUpdate.data.quantity).toBe(1);
  });

  test('size-variant total is sum of all buckets (source of truth)', async () => {
    mockListing = {
      id: 'L4',
      quantity: 3,
      status: 'active',
      specifications: { sizeQuantities: { S: 1, M: 1, L: 1 } },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L4', 2, 'order_cancelled', 'L');

    // S:1 + M:1 + L:3 = 5
    expect(lastUpdate.data.quantity).toBe(5);
    expect(lastUpdate.data.specifications.sizeQuantities.L).toBe(3);
  });
});

describe('SB-04: idempotency guarantees', () => {
  test('buyer/seller cancel is guarded by status check (only pending/to_ship can cancel)', () => {
    /**
     * orderController.ts cancel endpoint queries with:
     *   status: { in: ['pending', 'to_ship'] }
     * If an order is already 'cancelled', findFirst returns null and the
     * endpoint returns 404. This prevents double-restore without any
     * additional idempotency logic in restoreListingStock itself.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../controllers/orderController.ts'),
      'utf-8',
    );
    expect(src).toContain("status: { in: ['pending', 'to_ship'] }");
  });

  test('auto-cancel is guarded by freshOrder status re-check', () => {
    /**
     * escrowService.ts autoCancelUnshippedOrders re-checks the order
     * status before proceeding:
     *   if (freshOrder?.status !== 'to_ship') { continue; }
     * Combined with the initial query filtering for status: 'to_ship',
     * this prevents double-restore if the cron runs twice.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../services/escrowService.ts'),
      'utf-8',
    );
    expect(src).toContain("freshOrder?.status !== 'to_ship'");
  });
});

describe('SB-04: escrowService auto-cancel uses restoreListingStock in transaction', () => {
  test('auto-cancel path calls restoreListingStock (not manual listings.update)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../services/escrowService.ts'),
      'utf-8',
    );

    // Find the auto-cancel section
    const autoCancelStart = src.indexOf('auto_cancelled_not_shipped');
    expect(autoCancelStart).toBeGreaterThan(-1);

    // restoreListingStock should appear near auto-cancel, not a manual listings.update
    const restoreAfterCancel = src.indexOf('restoreListingStock', autoCancelStart);
    expect(restoreAfterCancel).toBeGreaterThan(autoCancelStart);
  });

  test('auto-cancel wraps order update + stock restore in $transaction', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../services/escrowService.ts'),
      'utf-8',
    );

    const autoCancelStart = src.indexOf('auto_cancelled_not_shipped');
    // Walk backwards to find the $transaction that wraps this section
    const beforeCancel = src.substring(0, autoCancelStart);
    const lastTxIdx = beforeCancel.lastIndexOf('$transaction');
    expect(lastTxIdx).toBeGreaterThan(-1);

    // restoreListingStock is inside the same transaction
    const txBlock = src.substring(lastTxIdx, autoCancelStart + 500);
    expect(txBlock).toContain('restoreListingStock');
  });

  test('auto-cancel passes selected_size to restoreListingStock', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../services/escrowService.ts'),
      'utf-8',
    );

    const autoCancelStart = src.indexOf('auto_cancelled_not_shipped');
    const restoreCall = src.substring(autoCancelStart, autoCancelStart + 600);
    expect(restoreCall).toContain('order.selected_size');
  });
});

describe('SB-04: orderController cancel passes selected_size', () => {
  test('buyer/seller cancel passes order.selected_size to restoreListingStock', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../controllers/orderController.ts'),
      'utf-8',
    );

    const cancelSection = src.indexOf("'order_cancelled'");
    expect(cancelSection).toBeGreaterThan(-1);

    // selected_size should be passed in the same call
    const restoreBlock = src.substring(cancelSection - 200, cancelSection + 200);
    expect(restoreBlock).toContain('order.selected_size');
  });
});
