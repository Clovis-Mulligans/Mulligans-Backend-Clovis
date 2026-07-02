import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-jwt-secret-for-off-sale';
process.env.JWT_SECRET = TEST_SECRET;

// ── Mock heavy deps ────────────────────────────────────────────────────
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
jest.mock('../../services/s3Service', () => ({ S3Service: { uploadImage: jest.fn(), deleteImage: jest.fn() } }));
jest.mock('multer', () => {
  const noop = (_req: any, _res: any, next: any) => next();
  const m = () => ({ array: () => noop, single: () => noop });
  m.memoryStorage = () => ({});
  return m;
});
jest.mock('express-rate-limit', () => () => (_req: any, _res: any, next: any) => next());

const mockExpireOffers = jest.fn().mockResolvedValue(0);
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: (...args: any[]) => mockExpireOffers(...args),
}));

// ── Prisma mock ────────────────────────────────────────────────────────
const mockListings: Record<string, any> = {};
const mockOrdersData: Record<string, any> = {};
const mockUsersData: Record<string, any> = {};

const mockListingsModel = {
  findUnique: jest.fn(({ where }: any) => Promise.resolve(mockListings[where.id] ?? null)),
  findMany: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  update: jest.fn(({ where, data, include }: any) => {
    const listing = mockListings[where.id];
    if (!listing) return Promise.resolve(null);
    const updated = { ...listing, ...data };
    mockListings[where.id] = updated;
    return Promise.resolve(updated);
  }),
  updateMany: jest.fn().mockResolvedValue({ count: 0 }),
};

const mockOrdersModel = {
  findFirst: jest.fn(({ where }: any) => {
    const order = mockOrdersData[where.listing_id];
    return Promise.resolve(order ?? null);
  }),
};

const mockCartItemsModel = {
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
};

const mockUsersModel = {
  findUnique: jest.fn(({ where }: any) => {
    return Promise.resolve(mockUsersData[where.id] ?? {
      id: where.id,
      display_name: 'Test User',
      rating: 5,
      avatar_url: null,
      is_verified_seller: true,
      is_pro_store: false,
      pro_store_name: null,
      is_banned: false,
      stripe_connect_id: null,
      stripe_connect_status: null,
    });
  }),
};

jest.mock('../../lib/prisma', () => ({
  prisma: {
    listings: mockListingsModel,
    orders: mockOrdersModel,
    cart_items: mockCartItemsModel,
    users: mockUsersModel,
    favorites: { count: jest.fn().mockResolvedValue(0) },
    offers: { findFirst: jest.fn().mockResolvedValue(null) },
    listing_attributes: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

import listingRoutes from '../../routes/listingRoutes';

// ── Helpers ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/listings', listingRoutes);
  return app;
}

function makeToken(userId: string): string {
  return jwt.sign({ userId, email: 'test@test.com', username: 'test' }, TEST_SECRET);
}

function httpRequest(
  server: http.Server,
  method: string,
  path: string,
  token?: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();

    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────

const OWNER_ID = 'owner-1';
const OTHER_ID = 'other-1';

const BASE_LISTING = {
  seller_id: OWNER_ID,
  title: 'Test Club',
  description: 'A test listing',
  category: 'Clubs',
  price: 100,
  deleted_at: null,
  images: [],
  specifications: null,
  brand: null,
  model: null,
  subcategory: null,
  currency: 'GBP',
  location: 'UK',
  original_price: null,
  is_featured: false,
  is_negotiable: true,
  views: 0,
  favorites_count: 0,
  created_at: new Date(),
  updated_at: new Date(),
  ball_condition_type: null,
  condition_grip: null,
  condition_head: null,
  condition_overall: null,
  condition_shaft: null,
  parcel_size: 'large',
  shipping_cost: 6.99,
  quantity: 1,
  external_source: null,
  external_id: null,
};

// ── Test suite ─────────────────────────────────────────────────────────

let server: http.Server;

beforeAll((done) => {
  const app = buildApp();
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockListings).forEach((k) => delete mockListings[k]);
  Object.keys(mockOrdersData).forEach((k) => delete mockOrdersData[k]);
  Object.keys(mockUsersData).forEach((k) => delete mockUsersData[k]);
  mockListingsModel.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(mockListings[where.id] ?? null),
  );
  mockExpireOffers.mockResolvedValue(0);
});

// ====================================================================
// A — PUT /api/listings/:id/off-sale (markOffSale)
// ====================================================================

describe('PUT /api/listings/:id/off-sale', () => {
  const LISTING_ID = 'lst_offsale_1';
  const url = `/api/listings/${LISTING_ID}/off-sale`;

  test('happy path: active → off_sale, offers expired, cart cleared', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'active' };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('off_sale');

    expect(mockExpireOffers).toHaveBeenCalledWith(LISTING_ID);
    expect(mockCartItemsModel.deleteMany).toHaveBeenCalledWith({
      where: { listing_id: LISTING_ID },
    });
    expect(mockListingsModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LISTING_ID },
        data: expect.objectContaining({ status: 'off_sale' }),
      }),
    );
  });

  test('reserved → off_sale (allowed)', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'reserved' };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('off_sale');
  });

  test('409 when listing has active order', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'active' };
    mockOrdersData[LISTING_ID] = { id: 'ord_1', status: 'to_ship' };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('order');
    expect(res.body.order_status).toBe('to_ship');
    expect(mockExpireOffers).not.toHaveBeenCalled();
    expect(mockCartItemsModel.deleteMany).not.toHaveBeenCalled();
  });

  test('non-owner → 404', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'active' };
    const token = makeToken(OTHER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
    expect(mockExpireOffers).not.toHaveBeenCalled();
  });

  test('no auth → 401', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'active' };

    const res = await httpRequest(server, 'PUT', url);

    expect(res.status).toBe(401);
  });

  test.each(['draft', 'sold', 'removed'])('%s → 409', async (status) => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(status);
    expect(mockExpireOffers).not.toHaveBeenCalled();
  });

  test('deleted listing → 404', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'deleted' };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
  });

  test('nonexistent listing → 404', async () => {
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', '/api/listings/lst_nope/off-sale', token);

    expect(res.status).toBe(404);
  });
});

// ====================================================================
// B — PUT /api/listings/:id/relist
// ====================================================================

describe('PUT /api/listings/:id/relist', () => {
  const LISTING_ID = 'lst_relist_1';
  const url = `/api/listings/${LISTING_ID}/relist`;

  test('happy path: off_sale → active (Stripe active)', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    mockUsersData[OWNER_ID] = {
      id: OWNER_ID,
      stripe_connect_id: 'acct_123',
      stripe_connect_status: 'active',
      is_banned: false,
    };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(mockListingsModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LISTING_ID },
        data: expect.objectContaining({ status: 'active' }),
      }),
    );
  });

  test('409 when Stripe not active', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    mockUsersData[OWNER_ID] = {
      id: OWNER_ID,
      stripe_connect_id: null,
      stripe_connect_status: null,
      is_banned: false,
    };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe');
    expect(mockListingsModel.update).not.toHaveBeenCalled();
  });

  test('409 when Stripe pending (not active)', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    mockUsersData[OWNER_ID] = {
      id: OWNER_ID,
      stripe_connect_id: 'acct_123',
      stripe_connect_status: 'pending',
      is_banned: false,
    };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe');
  });

  test.each(['active', 'sold', 'draft', 'removed'])('%s → 409', async (status) => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status };
    mockUsersData[OWNER_ID] = {
      id: OWNER_ID,
      stripe_connect_id: 'acct_123',
      stripe_connect_status: 'active',
      is_banned: false,
    };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(status);
  });

  test('non-owner → 404', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    const token = makeToken(OTHER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
  });

  test('no auth → 401', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };

    const res = await httpRequest(server, 'PUT', url);

    expect(res.status).toBe(401);
  });

  test('deleted listing → 404', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'deleted' };
    mockUsersData[OWNER_ID] = {
      id: OWNER_ID,
      stripe_connect_id: 'acct_123',
      stripe_connect_status: 'active',
      is_banned: false,
    };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
  });
});

// ====================================================================
// C — Visibility: off_sale excluded from buyer-facing surfaces
// ====================================================================

describe('off_sale visibility', () => {
  const LISTING_ID = 'lst_vis_1';

  test('GET /api/listings/:id — owner sees own off_sale listing', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'GET', `/api/listings/${LISTING_ID}`, token);

    expect(res.status).toBe(200);
    expect(res.body.listing.status).toBe('off_sale');
  });

  test('GET /api/listings/:id — non-owner gets 404 for off_sale listing', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };
    const token = makeToken(OTHER_ID);

    const res = await httpRequest(server, 'GET', `/api/listings/${LISTING_ID}`, token);

    expect(res.status).toBe(404);
  });

  test('GET /api/listings/:id — anonymous gets 404 for off_sale listing', async () => {
    mockListings[LISTING_ID] = { ...BASE_LISTING, id: LISTING_ID, status: 'off_sale' };

    const res = await httpRequest(server, 'GET', `/api/listings/${LISTING_ID}`);

    expect(res.status).toBe(404);
  });

  test('GET /api/listings — search queries filter on status=active (fail-closed)', async () => {
    mockListingsModel.findMany.mockResolvedValue([]);
    mockListingsModel.count.mockResolvedValue(0);

    await httpRequest(server, 'GET', '/api/listings');

    const callArgs = mockListingsModel.findMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.status).toBe('active');
  });
});
