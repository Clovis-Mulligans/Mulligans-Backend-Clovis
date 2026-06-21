import { restoreListingStock, StockChangeCause } from '../../lib/stockUtils';

// Mock listing state — reset before each test
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
  $queryRawUnsafe: jest.fn(async (sql: string, ..._params: any[]) => {
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

describe('restoreListingStock — plain quantity (no size variants)', () => {
  test('increments quantity by order quantity', async () => {
    mockListing = { id: 'L1', quantity: 3, status: 'active', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 2, 'order_cancelled');

    expect(tx.listings.update).toHaveBeenCalledTimes(1);
    const data = lastUpdate!.data;
    expect(data.quantity).toEqual({ increment: 2 });
  });

  test('does NOT acquire row lock for plain quantity', async () => {
    mockListing = { id: 'L1', quantity: 3, status: 'active', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 2, 'order_cancelled');

    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('sets status to active when listing was sold', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, 'order_cancelled');

    expect(lastUpdate!.data.status).toBe('active');
    expect(mockListing.quantity).toBe(1);
  });

  test('preserves deleted status (does not override to active)', async () => {
    mockListing = { id: 'L1', quantity: 0, status: 'deleted', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, 'return_refund');

    expect(lastUpdate!.data.status).toBe('deleted');
  });

  test('logs structured audit line', async () => {
    mockListing = { id: 'L1', quantity: 5, status: 'active', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 3, 'admin_refund');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[STOCK] INCREMENT listing=L1 prev=5 delta=+3 new=8 cause=admin_refund'),
    );
  });

  test('handles listing not found gracefully', async () => {
    mockListing = null;
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L-MISSING', 1, 'order_cancelled');

    expect(tx.listings.update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('RESTORE_FAILED listing=L-MISSING reason=listing_not_found'),
    );
  });
});

describe('restoreListingStock — size variants', () => {
  test('restores stock to the correct size bucket', async () => {
    mockListing = {
      id: 'L2',
      quantity: 2,
      status: 'active',
      specifications: {
        sizeQuantities: { S: 1, M: 0, L: 1 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'order_cancelled', 'M');

    const updatedSpecs = lastUpdate!.data.specifications;
    expect(updatedSpecs.sizeQuantities.M).toBe(1);
    expect(updatedSpecs.sizeQuantities.S).toBe(1);
    expect(updatedSpecs.sizeQuantities.L).toBe(1);
    expect(lastUpdate!.data.quantity).toBe(3);
  });

  test('acquires FOR UPDATE row lock before reading sizeQuantities', async () => {
    mockListing = {
      id: 'L2',
      quantity: 2,
      status: 'active',
      specifications: {
        sizeQuantities: { S: 1, M: 1 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'order_cancelled', 'M');

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(queryRawCalls[0]).toContain('FOR UPDATE');
    expect(queryRawCalls[0]).toContain('listings');
  });

  test('re-reads listing after acquiring lock (uses locked state, not stale read)', async () => {
    mockListing = {
      id: 'L2',
      quantity: 2,
      status: 'active',
      specifications: {
        sizeQuantities: { S: 1, M: 1 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'order_cancelled', 'M');

    // findUnique called twice: initial read + re-read after lock
    expect(tx.listings.findUnique).toHaveBeenCalledTimes(2);
  });

  test('sets total quantity as sum of all size buckets (buckets are source of truth)', async () => {
    mockListing = {
      id: 'L2',
      quantity: 5,
      status: 'active',
      specifications: {
        sizeQuantities: { S: 2, M: 1, L: 2 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 3, 'return_refund', 'M');

    // S:2 + M:(1+3) + L:2 = 8
    expect(lastUpdate!.data.quantity).toBe(8);
  });

  test('sold listing with size variants returns to active', async () => {
    mockListing = {
      id: 'L2',
      quantity: 0,
      status: 'sold',
      specifications: {
        sizeQuantities: { S: 0, M: 0, L: 0 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 1, 'order_cancelled', 'M');

    expect(lastUpdate!.data.status).toBe('active');
    expect(lastUpdate!.data.quantity).toBe(1);
    expect(lastUpdate!.data.specifications.sizeQuantities.M).toBe(1);
  });

  test('deleted listing with size variants stays deleted', async () => {
    mockListing = {
      id: 'L2',
      quantity: 0,
      status: 'deleted',
      specifications: {
        sizeQuantities: { S: 0, M: 0 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 2, 'dispute_refund', 'S');

    expect(lastUpdate!.data.status).toBe('deleted');
    expect(lastUpdate!.data.specifications.sizeQuantities.S).toBe(2);
  });

  test('falls back to plain increment when selectedSize given but no sizeQuantities', async () => {
    mockListing = { id: 'L3', quantity: 0, status: 'sold', specifications: { brand: 'Titleist' } };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L3', 1, 'order_cancelled', 'M');

    expect(lastUpdate!.data.quantity).toEqual({ increment: 1 });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('logs size-specific audit line', async () => {
    mockListing = {
      id: 'L2',
      quantity: 1,
      status: 'active',
      specifications: {
        sizeQuantities: { M: 1 },
      },
    };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L2', 2, 'return_refund', 'M');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('size=M'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('sizeQty=1→3'),
    );
  });
});

describe('restoreListingStock — all StockChangeCause values accepted', () => {
  const causes: StockChangeCause[] = [
    'order_cancelled',
    'return_refund',
    'admin_refund',
    'dispute_refund',
  ];

  test.each(causes)('accepts cause=%s without error', async (cause) => {
    mockListing = { id: 'L1', quantity: 0, status: 'sold', specifications: null };
    const tx = makeTx();

    await restoreListingStock(tx as any, 'L1', 1, cause);

    expect(tx.listings.update).toHaveBeenCalledTimes(1);
  });
});
