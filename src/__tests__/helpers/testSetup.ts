// Brief 8 — Listing Controller test helpers.
//
// Fixtures, JWT signing, mock req/res builders, and a test Express app
// factory for supertest-based integration tests.

import express, { Express } from 'express';
import jwt from 'jsonwebtoken';

// Ensure a JWT secret exists BEFORE authenticateToken is imported by any route
// module — the middleware reads process.env.JWT_SECRET at verify time, not at
// import time, so setting here is fine.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-brief8-listing';

// ──────────────────────────────────────────────────────────────────────────
// FIXTURES
// ──────────────────────────────────────────────────────────────────────────

export const testUserSeller = {
  id: 'user_test_seller',
  email: 'seller@test.com',
  display_name: 'Test Seller',
  username: 'testseller',
  avatar_url: null,
  rating: 4.8,
  is_verified_seller: true,
  is_pro_store: false,
  pro_store_name: null,
  is_banned: false,
  sizing_preference: null,
  clothing_size: [] as string[],
  shoe_size: [] as string[],
  glove_size: [] as string[],
};

export const testUserBuyer = {
  id: 'user_test_buyer',
  email: 'buyer@test.com',
  display_name: 'Test Buyer',
  username: 'testbuyer',
  avatar_url: null,
  rating: 5.0,
  is_verified_seller: false,
  is_pro_store: false,
  pro_store_name: null,
  is_banned: false,
  sizing_preference: 'mens',
  clothing_size: ['M', 'L'],
  shoe_size: ['UK9'],
  glove_size: ['ML'],
};

export const testListing = {
  id: 'lst_1700000000000_abc123xyz',
  seller_id: testUserSeller.id,
  title: 'TaylorMade Stealth 2 Driver',
  description: 'Excellent condition 10.5 loft driver. Minor scratches on sole.',
  category: 'Clubs',
  subcategory: 'Drivers',
  brand: 'TaylorMade',
  model: 'Stealth 2',
  price: 249.99,
  original_price: null,
  currency: 'GBP',
  status: 'active',
  location: 'UK',
  is_featured: false,
  is_negotiable: true,
  views: 0,
  favorites_count: 0,
  created_at: new Date('2026-04-10T10:00:00Z'),
  updated_at: new Date('2026-04-10T10:00:00Z'),
  ball_condition_type: null,
  condition_grip: 4,
  condition_head: 5,
  condition_shaft: 4,
  condition_overall: 4,
  specifications: { dexterity: 'Right', shaftFlex: 'Stiff', loft: '10.5' },
  parcel_size: 'medium',
  shipping_cost: 8.5,
  quantity: 1,
  images: [] as any[],
};

export const testImage = {
  id: 'img_1700000000000_0_abc123xyz',
  listing_id: testListing.id,
  image_url: 'https://cdn.mulligans.test/listings/abc.jpg',
  s3_key: 'listings/abc.jpg',
  is_primary: true,
  display_order: 0,
  alt_text: null,
  created_at: new Date('2026-04-10T10:00:00Z'),
};

/**
 * A valid createListing payload that passes the Zod schema.
 */
export function validCreateListingPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'TaylorMade Stealth 2 Driver',
    description: 'Excellent condition, minor scratches on sole.',
    price: 249.99,
    category: 'Clubs',
    subcategory: 'Drivers',
    location: 'UK',
    parcel_size: 'medium',
    shipping_cost: 8.5,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// JWT
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sign a JWT that the production authenticateToken middleware will accept.
 * The middleware pulls `id` from either `userId` or `id` — we put both
 * for safety.
 */
export function generateTestToken(user: { id: string; email?: string; username?: string }): string {
  return jwt.sign(
    {
      userId: user.id,
      id: user.id,
      email: user.email || `${user.id}@test.com`,
      username: user.username || user.id,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

export function authHeader(user: { id: string; email?: string; username?: string }): Record<string, string> {
  return { Authorization: `Bearer ${generateTestToken(user)}` };
}

// ──────────────────────────────────────────────────────────────────────────
// MOCK REQ/RES (for unit tests)
// ──────────────────────────────────────────────────────────────────────────

type MockRequestInit = {
  user?: { id: string; email?: string; username?: string };
  body?: any;
  params?: Record<string, string>;
  query?: Record<string, any>;
  files?: any;
  headers?: Record<string, string>;
};

// Returns `any` so the mock is assignable to Express's Request type
// parameter without having to stub 80+ unused fields.
export function makeMockRequest(init: MockRequestInit = {}): any {
  return {
    user: init.user,
    body: init.body ?? {},
    params: init.params ?? {},
    query: init.query ?? {},
    files: init.files,
    headers: init.headers ?? {},
  };
}

// Returns `any` for the same reason. Callers still get `.status.mock`,
// `.json.mock`, `.body`, `.statusCode` at runtime — they just aren't typed.
export function makeMockResponse(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  res.send = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

// ──────────────────────────────────────────────────────────────────────────
// INTEGRATION APP FACTORY
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that mounts the real listing router at
 * `/api/listings`. All prisma calls go through whatever the test file has
 * jest.mock()'d at module level, so no network or database is involved.
 */
export function buildTestApp(): Express {
  // Import lazily so that any jest.mock() calls in the test file take effect
  // before the router module graph is loaded.
  const listingRoutes = require('../../routes/listingRoutes').default;

  const app = express();
  app.use(express.json());
  app.use('/api/listings', listingRoutes);

  // Generic error handler so unhandled errors become 500 JSON rather than
  // terminating the test process.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err?.message || 'Unhandled error' });
  });

  return app;
}
