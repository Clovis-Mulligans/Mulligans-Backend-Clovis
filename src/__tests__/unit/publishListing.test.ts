import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-jwt-secret-for-publish';
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
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: jest.fn().mockResolvedValue(0),
}));

// ── Prisma mock ────────────────────────────────────────────────────────
const mockListings: Record<string, any> = {};
const mockUsersData: Record<string, any> = {};

const mockListingsModel = {
  findUnique: jest.fn(({ where, include }: any) => {
    const listing = mockListings[where.id];
    if (!listing) return Promise.resolve(null);
    if (include?.images) {
      return Promise.resolve({ ...listing, images: listing.images || [] });
    }
    return Promise.resolve(listing);
  }),
  findMany: jest.fn(({ where, include }: any) => {
    const ids: string[] = where?.id?.in || [];
    const results = ids.map((id) => mockListings[id]).filter(Boolean);
    if (include?.images) {
      return Promise.resolve(results.map((l) => ({ ...l, images: l.images || [] })));
    }
    return Promise.resolve(results);
  }),
  count: jest.fn().mockResolvedValue(0),
  update: jest.fn(({ where, data }: any) => {
    const listing = mockListings[where.id];
    if (!listing) return Promise.resolve(null);
    const updated = { ...listing, ...data };
    mockListings[where.id] = updated;
    return Promise.resolve(updated);
  }),
  updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    users: mockUsersModel,
    orders: { findFirst: jest.fn().mockResolvedValue(null) },
    cart_items: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
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

const COMPLETE_DRAFT = {
  id: 'lst_pub_1',
  seller_id: OWNER_ID,
  title: 'TaylorMade SIM2 Max Driver',
  description: 'Excellent condition driver, barely used on course, perfect for mid-handicappers',
  category: 'Clubs',
  subcategory: 'Drivers',
  location: 'London, UK',
  price: '149.99',
  parcel_size: 'large',
  shipping_cost: '6.99',
  quantity: 1,
  status: 'draft',
  deleted_at: null,
  brand: 'TaylorMade',
  model: 'SIM2 Max',
  currency: 'GBP',
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
  condition_overall: 4,
  condition_shaft: null,
  specifications: null,
  external_source: null,
  external_id: null,
  images: [{ id: 'img_1', image_url: 'https://example.com/img.jpg', s3_key: 'img/1', is_primary: true, display_order: 0 }],
};

const PAYOUT_READY_SELLER = {
  id: OWNER_ID,
  stripe_connect_id: 'acct_123',
  stripe_connect_status: 'active',
  is_banned: false,
  display_name: 'Test Seller',
  rating: 5,
  avatar_url: null,
  is_verified_seller: true,
  is_pro_store: true,
  pro_store_name: 'Test Pro Store',
};

const PAYOUT_NOT_READY_SELLER = {
  ...PAYOUT_READY_SELLER,
  stripe_connect_id: null,
  stripe_connect_status: null,
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
  Object.keys(mockUsersData).forEach((k) => delete mockUsersData[k]);
  mockListingsModel.findUnique.mockImplementation(({ where }: any) => {
    const listing = mockListings[where.id];
    return Promise.resolve(listing ? { ...listing, images: listing.images || [] } : null);
  });
});

// ====================================================================
// A — PUT /api/listings/:id/publish (single)
// ====================================================================

describe('PUT /api/listings/:id/publish', () => {
  const LISTING_ID = 'lst_pub_1';
  const url = `/api/listings/${LISTING_ID}/publish`;

  test('happy path: complete draft + payout-ready → active', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
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

  test('409 when not payout-ready', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT };
    mockUsersData[OWNER_ID] = { ...PAYOUT_NOT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe');
    expect(mockListingsModel.update).not.toHaveBeenCalled();
  });

  test('409 when no images', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, images: [] };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('image');
  });

  test('409 when quantity is 0', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, quantity: 0 };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('quantity');
  });

  test('409 when missing required field (no category)', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, category: null };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('category');
  });

  test('409 when price below minimum', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, price: '0.10' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('price');
  });

  test.each(['active', 'sold', 'off_sale', 'removed'])('409 from %s status', async (status) => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, status };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(status);
  });

  test('non-owner → 404', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OTHER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
  });

  test('no auth → 401', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT };

    const res = await httpRequest(server, 'PUT', url);

    expect(res.status).toBe(401);
  });

  test('deleted → 404', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, status: 'deleted' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token);

    expect(res.status).toBe(404);
  });
});

// ====================================================================
// B — Relist regression (extraction didn't change behaviour)
// ====================================================================

describe('PUT /api/listings/:id/relist — regression after extraction', () => {
  const LISTING_ID = 'lst_relist_reg';

  test('off_sale → active when payout-ready (shared util path)', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, id: LISTING_ID, status: 'off_sale' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', `/api/listings/${LISTING_ID}/relist`, token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  test('409 when not payout-ready (shared util path)', async () => {
    mockListings[LISTING_ID] = { ...COMPLETE_DRAFT, id: LISTING_ID, status: 'off_sale' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_NOT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', `/api/listings/${LISTING_ID}/relist`, token);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe');
  });
});

// ====================================================================
// C — PUT /api/listings/publish-bulk
// ====================================================================

describe('PUT /api/listings/publish-bulk', () => {
  const url = '/api/listings/publish-bulk';

  test('mixed batch → correct published/skipped split', async () => {
    mockListings['lst_a'] = { ...COMPLETE_DRAFT, id: 'lst_a', status: 'draft' };
    mockListings['lst_b'] = { ...COMPLETE_DRAFT, id: 'lst_b', status: 'active' };
    mockListings['lst_c'] = { ...COMPLETE_DRAFT, id: 'lst_c', status: 'draft', images: [] };
    mockListings['lst_d'] = { ...COMPLETE_DRAFT, id: 'lst_d', status: 'draft' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token, {
      listing_ids: ['lst_a', 'lst_b', 'lst_c', 'lst_d', 'lst_nonexistent'],
    });

    expect(res.status).toBe(200);
    expect(res.body.published).toEqual(expect.arrayContaining(['lst_a', 'lst_d']));
    expect(res.body.published).toHaveLength(2);
    expect(res.body.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lst_b', reason: 'not_draft' }),
      expect.objectContaining({ id: 'lst_c', reason: expect.stringContaining('image') }),
      expect.objectContaining({ id: 'lst_nonexistent', reason: 'not_found' }),
    ]));
  });

  test('payout-not-ready short-circuits all', async () => {
    mockListings['lst_a'] = { ...COMPLETE_DRAFT, id: 'lst_a', status: 'draft' };
    mockListings['lst_b'] = { ...COMPLETE_DRAFT, id: 'lst_b', status: 'draft' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_NOT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token, {
      listing_ids: ['lst_a', 'lst_b'],
    });

    expect(res.status).toBe(200);
    expect(res.body.published).toHaveLength(0);
    expect(res.body.skipped).toHaveLength(2);
    expect(res.body.skipped[0].reason).toBe('payout_not_ready');
    expect(res.body.skipped[1].reason).toBe('payout_not_ready');
    expect(mockListingsModel.updateMany).not.toHaveBeenCalled();
  });

  test('foreign ids skipped as not_found, valid rows still publish', async () => {
    mockListings['lst_foreign'] = { ...COMPLETE_DRAFT, id: 'lst_foreign', seller_id: OTHER_ID, status: 'draft' };
    mockListings['lst_owned'] = { ...COMPLETE_DRAFT, id: 'lst_owned', status: 'draft' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token, {
      listing_ids: ['lst_foreign', 'lst_owned'],
    });

    expect(res.status).toBe(200);
    expect(res.body.published).toEqual(['lst_owned']);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ id: 'lst_foreign', reason: 'not_found' }),
    ]);
  });

  test('empty array → 400', async () => {
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token, { listing_ids: [] });

    expect(res.status).toBe(400);
  });

  test('no auth → 401', async () => {
    const res = await httpRequest(server, 'PUT', url, undefined, {
      listing_ids: ['lst_a'],
    });

    expect(res.status).toBe(401);
  });

  test('all valid drafts → all published', async () => {
    mockListings['lst_x'] = { ...COMPLETE_DRAFT, id: 'lst_x', status: 'draft' };
    mockListings['lst_y'] = { ...COMPLETE_DRAFT, id: 'lst_y', status: 'draft' };
    mockUsersData[OWNER_ID] = { ...PAYOUT_READY_SELLER };
    const token = makeToken(OWNER_ID);

    const res = await httpRequest(server, 'PUT', url, token, {
      listing_ids: ['lst_x', 'lst_y'],
    });

    expect(res.status).toBe(200);
    expect(res.body.published).toEqual(['lst_x', 'lst_y']);
    expect(res.body.skipped).toHaveLength(0);
    expect(mockListingsModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['lst_x', 'lst_y'] } },
        data: expect.objectContaining({ status: 'active' }),
      }),
    );
  });
});
