import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-jwt-secret-for-draft-visibility';

// Set JWT_SECRET before importing routes (auth middleware reads it at verify time)
process.env.JWT_SECRET = TEST_SECRET;

// ── Mock heavy deps that the route chain imports ────────────────────────
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
jest.mock('../../services/s3Service', () => ({ S3Service: { uploadImage: jest.fn(), deleteImage: jest.fn() } }));
jest.mock('multer', () => {
  const m = () => ({ array: () => (_req: any, _res: any, next: any) => next() });
  m.memoryStorage = () => ({});
  return m;
});
jest.mock('express-rate-limit', () => () => (_req: any, _res: any, next: any) => next());

// ── Prisma mock ─────────────────────────────────────────────────────────
const mockListings: Record<string, any> = {};
const mockFavorites = { count: jest.fn().mockResolvedValue(0) };
const mockOffers = { findFirst: jest.fn().mockResolvedValue(null) };
const mockUsers = {
  findUnique: jest.fn().mockResolvedValue({
    id: 'owner-1',
    display_name: 'Owner',
    rating: 5,
    avatar_url: null,
    is_verified_seller: true,
    is_pro_store: false,
    pro_store_name: null,
    is_banned: false,
  }),
};
const mockListingsModel = {
  findUnique: jest.fn(({ where }: any) => {
    return Promise.resolve(mockListings[where.id] ?? null);
  }),
  findMany: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
};

jest.mock('../../lib/prisma', () => ({
  prisma: {
    listings: mockListingsModel,
    favorites: mockFavorites,
    offers: mockOffers,
    users: mockUsers,
    listing_attributes: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

// Import routes AFTER mock is in place
import listingRoutes from '../../routes/listingRoutes';

// ── Test app + server ───────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/listings', listingRoutes);
  return app;
}

function makeToken(userId: string): string {
  return jwt.sign({ userId, email: 'test@test.com', username: 'test' }, TEST_SECRET);
}

function request(
  server: http.Server,
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.get(
      { hostname: '127.0.0.1', port: addr.port, path, headers },
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
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-1';
const OTHER_ID = 'other-1';

const DRAFT_LISTING = {
  id: 'lst_draft_1',
  seller_id: OWNER_ID,
  title: 'Draft Club',
  description: 'A draft listing',
  category: 'Clubs',
  price: 100,
  status: 'draft',
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

const ACTIVE_LISTING = {
  ...DRAFT_LISTING,
  id: 'lst_active_1',
  title: 'Active Club',
  status: 'active',
};

// ── Tests ───────────────────────────────────────────────────────────────

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
  mockListings['lst_draft_1'] = DRAFT_LISTING;
  mockListings['lst_active_1'] = ACTIVE_LISTING;
  mockListingsModel.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(mockListings[where.id] ?? null),
  );
});

describe('GET /api/listings/:id — draft visibility (real route + middleware)', () => {
  test('owner requests own draft (valid token) → 200', async () => {
    const token = makeToken(OWNER_ID);
    const res = await request(server, '/api/listings/lst_draft_1', token);
    expect(res.status).toBe(200);
    expect(res.body.listing).toBeDefined();
    expect(res.body.listing.id).toBe('lst_draft_1');
    expect(res.body.listing.status).toBe('draft');
  });

  test('non-owner requests a draft (different valid token) → 404', async () => {
    const token = makeToken(OTHER_ID);
    const res = await request(server, '/api/listings/lst_draft_1', token);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Listing not found');
  });

  test('anonymous requests a draft (no token) → 404', async () => {
    const res = await request(server, '/api/listings/lst_draft_1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Listing not found');
  });

  test('anyone requests an active listing (no token) → 200', async () => {
    const res = await request(server, '/api/listings/lst_active_1');
    expect(res.status).toBe(200);
    expect(res.body.listing).toBeDefined();
    expect(res.body.listing.id).toBe('lst_active_1');
    expect(res.body.listing.status).toBe('active');
  });
});

describe('GET /api/listings — search excludes drafts', () => {
  test('getAllListings does not return a draft listing', async () => {
    mockListingsModel.findMany.mockResolvedValue([ACTIVE_LISTING]);
    mockListingsModel.count.mockResolvedValue(1);
    const res = await request(server, '/api/listings');
    expect(res.status).toBe(200);
    const ids = (res.body.listings || []).map((l: any) => l.id);
    expect(ids).not.toContain('lst_draft_1');
    // Verify the query was called with status: 'active'
    const callArgs = mockListingsModel.findMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.status).toBe('active');
  });
});
