// Middleware-stack tests — drives the real Express router (auth, Zod
// validation, rate limiting, multer) with all backend dependencies mocked.
// Runs in the UNIT tier because it touches no real services.

import { jest } from '@jest/globals';

// Mocks must be hoisted before any import of modules that pull in prisma.
jest.mock('../../lib/prisma', () => ({
  prisma: require('../helpers/mockPrisma').mockPrisma,
}));
jest.mock('../../services/s3Service', () => ({
  S3Service: {
    uploadImage: jest.fn<(...args: any[]) => any>(async () => ({
      url: 'https://cdn.test/x.jpg',
      key: 'listings/x.jpg',
    })),
    deleteImage: jest.fn<(...args: any[]) => any>(async () => undefined),
  },
}));
jest.mock('sharp', () => {
  const chain: any = {
    rotate: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => Buffer.from('processed'),
  };
  return jest.fn(() => chain);
});

import request from 'supertest';
import { Express } from 'express';
import { mockPrisma, resetMockPrisma } from '../helpers/mockPrisma';
import {
  testUserSeller,
  testUserBuyer,
  testListing,
  testImage,
  authHeader,
  validCreateListingPayload,
  buildTestApp,
} from '../helpers/testSetup';

let app: Express;

beforeAll(() => {
  app = buildTestApp();
});

beforeEach(() => {
  resetMockPrisma();
  // authenticateToken makes a DB call for the banned-user check on every
  // authenticated request. Default: user exists and is not banned.
  mockPrisma.users.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id === testUserSeller.id) return { ...testUserSeller, is_banned: false };
    if (where.id === testUserBuyer.id) return { ...testUserBuyer, is_banned: false };
    return null;
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Public: GET /api/listings/featured
// ══════════════════════════════════════════════════════════════════════════

describe('GET /api/listings/featured (public)', () => {
  it('returns 200 with listings array without auth', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    const res = await request(app).get('/api/listings/featured');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('listings');
    expect(Array.isArray(res.body.listings)).toBe(true);
    expect(res.body.personalized).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/listings — auth + validation
// ══════════════════════════════════════════════════════════════════════════

describe('POST /api/listings', () => {
  beforeEach(() => {
    // Prime success path. Each test that creates a listing reuses these.
    mockPrisma.listings.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    mockPrisma.listing_attributes.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.listings.findUnique.mockResolvedValue({ ...testListing, images: [] });
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request(app)
      .post('/api/listings')
      .send(validCreateListingPayload());
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Access token required' });
  });

  it('returns 401 / 403 when Authorization is malformed', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .send(validCreateListingPayload());
    expect([401, 403]).toContain(res.status);
  });

  it('returns 201 for a valid payload from an authenticated seller', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload());
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('listing');
    expect(res.body.listing).toHaveProperty('seller');
  });

  it('returns 400 when title is too short (< 3 chars)', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ title: 'ab' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringContaining('title') }),
      ])
    );
  });

  it('returns 400 when title is too long (> 200 chars)', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ title: 'x'.repeat(201) }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when description is too short (< 10 chars)', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ description: 'short' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when price is below £0.50', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ price: 0.49 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when price is above £50,000', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ price: 50001 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when category is not in the allowed enum', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ category: 'NotAGolfThing' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send({ title: 'Driver' }); // almost everything missing
    expect(res.status).toBe(400);
  });

  it('returns 400 when parcel_size is invalid', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ parcel_size: 'gigantic' }));
    expect(res.status).toBe(400);
  });

  it('includes RateLimit headers on listing creation responses', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload());

    // express-rate-limit v8 with standardHeaders: true emits IETF draft headers
    const headerNames = Object.keys(res.headers).map((h) => h.toLowerCase());
    expect(headerNames.some((h) => h.startsWith('ratelimit'))).toBe(true);
  });

  it('rate limit advertises max of 50', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload());
    const limit = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'];
    expect(limit).toBe('50');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/listings
// ══════════════════════════════════════════════════════════════════════════

describe('GET /api/listings (list / search)', () => {
  it('returns 200 with { listings, pagination } shape', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    mockPrisma.listings.count.mockResolvedValueOnce(1);

    const res = await request(app).get('/api/listings');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.listings)).toBe(true);
    expect(res.body.pagination).toEqual(
      expect.objectContaining({
        total: 1,
        page: 1,
        limit: 20,
        pages: 1,
      })
    );
  });

  it('applies category query parameter', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await request(app).get('/api/listings?category=Clubs');
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.category).toBe('Clubs');
  });

  it('applies minPrice / maxPrice range', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await request(app).get('/api/listings?minPrice=100&maxPrice=500');
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.price).toEqual({ gte: 100, lte: 500 });
  });

  it('applies dexterity via listing_attributes join', async () => {
    mockPrisma.listing_attributes.findMany.mockResolvedValueOnce([
      { listing_id: testListing.id },
    ]);
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await request(app).get('/api/listings?dexterity=Right');

    const attrCall = mockPrisma.listing_attributes.findMany.mock.calls[0][0] as any;
    expect(attrCall.where).toEqual({ key: 'dexterity', value: 'Right' });
  });

  it('returns empty result shape when no listings match', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    const res = await request(app).get('/api/listings');
    expect(res.body.listings).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/listings/:id
// ══════════════════════════════════════════════════════════════════════════

describe('GET /api/listings/:id', () => {
  it('returns 200 with full listing (seller + favorite_count) for a valid id', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.users.findUnique.mockResolvedValueOnce({
      id: testUserSeller.id,
      display_name: testUserSeller.display_name,
      rating: testUserSeller.rating,
      avatar_url: null,
      is_verified_seller: true,
      is_pro_store: false,
      pro_store_name: null,
    });
    mockPrisma.favorites.count.mockResolvedValueOnce(3);

    const res = await request(app).get(`/api/listings/${testListing.id}`);
    expect(res.status).toBe(200);
    expect(res.body.listing.id).toBe(testListing.id);
    expect(res.body.listing.favorite_count).toBe(3);
    expect(res.body.listing.seller).toEqual(
      expect.objectContaining({ id: testUserSeller.id })
    );
  });

  it('returns 404 for a non-existent id', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/listings/lst_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Listing not found' });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PUT /api/listings/:id
// ══════════════════════════════════════════════════════════════════════════

describe('PUT /api/listings/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put(`/api/listings/${testListing.id}`).send({ title: 'x' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner attempts to update', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
    });

    const res = await request(app)
      .put(`/api/listings/${testListing.id}`)
      .set(authHeader(testUserBuyer))
      .send({ title: 'Hijack attempt now' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('owner can update price', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)     // ownership check
      .mockResolvedValueOnce(testListing);    // final refetch
    mockPrisma.listings.update.mockResolvedValueOnce({ ...testListing, price: 299 });

    const res = await request(app)
      .put(`/api/listings/${testListing.id}`)
      .set(authHeader(testUserSeller))
      .send({ price: 299 });

    expect(res.status).toBe(200);
    const call = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(call.data.price).toBe(299);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DELETE /api/listings/:id
// ══════════════════════════════════════════════════════════════════════════

describe('DELETE /api/listings/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).delete(`/api/listings/${testListing.id}`);
    expect(res.status).toBe(401);
  });

  it('owner can delete when no active orders exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      images: [testImage],
    });
    mockPrisma.orders.findFirst.mockResolvedValueOnce(null);
    mockPrisma.listings.update.mockResolvedValueOnce({ ...testListing, status: 'deleted' });

    const res = await request(app)
      .delete(`/api/listings/${testListing.id}`)
      .set(authHeader(testUserSeller));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Listing deleted successfully' });
  });

  it('blocks deletion with 400 when an active order exists', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      images: [testImage],
    });
    mockPrisma.orders.findFirst.mockResolvedValueOnce({ id: 'ord_1', status: 'paid' });

    const res = await request(app)
      .delete(`/api/listings/${testListing.id}`)
      .set(authHeader(testUserSeller));

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.order_status).toBe('paid');
  });

  it('returns 403 when non-owner attempts to delete', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
      images: [],
    });

    const res = await request(app)
      .delete(`/api/listings/${testListing.id}`)
      .set(authHeader(testUserBuyer));

    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent listing', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .delete(`/api/listings/lst_ghost`)
      .set(authHeader(testUserSeller));
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DELETE /api/listings/:id/images/:imageId
// ══════════════════════════════════════════════════════════════════════════

describe('DELETE /api/listings/:id/images/:imageId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).delete(
      `/api/listings/${testListing.id}/images/${testImage.id}`
    );
    expect(res.status).toBe(401);
  });

  it('owner can delete an image', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.images.findUnique.mockResolvedValueOnce(testImage);
    mockPrisma.images.delete.mockResolvedValueOnce(testImage);

    const res = await request(app)
      .delete(`/api/listings/${testListing.id}/images/${testImage.id}`)
      .set(authHeader(testUserSeller));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Image deleted successfully' });
  });

  it('returns 403 for non-owner', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
    });
    const res = await request(app)
      .delete(`/api/listings/${testListing.id}/images/${testImage.id}`)
      .set(authHeader(testUserBuyer));
    expect(res.status).toBe(403);
  });

  it('returns 404 when image does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.images.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .delete(`/api/listings/${testListing.id}/images/img_ghost`)
      .set(authHeader(testUserSeller));
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/listings/:id/images (multer field=images, max=5)
// ══════════════════════════════════════════════════════════════════════════

describe('POST /api/listings/:id/images', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/listings/${testListing.id}/images`)
      .attach('images', Buffer.from('fake'), 'a.jpg');
    expect(res.status).toBe(401);
  });

  it('rejects upload with 403 when caller is not the owner', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
    });
    const res = await request(app)
      .post(`/api/listings/${testListing.id}/images`)
      .set(authHeader(testUserBuyer))
      .attach('images', Buffer.from('fake'), 'a.jpg');
    expect(res.status).toBe(403);
  });

  it('owner upload returns 201 with { message, count }', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const res = await request(app)
      .post(`/api/listings/${testListing.id}/images`)
      .set(authHeader(testUserSeller))
      .attach('images', Buffer.from('fake-img-a'), 'a.jpg')
      .attach('images', Buffer.from('fake-img-b'), 'b.jpg');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: 'Images uploaded successfully',
      count: 2,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/listings/seller/:seller_id
// ══════════════════════════════════════════════════════════════════════════

describe('GET /api/listings/seller/:seller_id (public)', () => {
  it('returns 200 without auth', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    const res = await request(app).get(`/api/listings/seller/${testUserSeller.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.listings)).toBe(true);
  });

  it('queries only active listings for that seller', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    await request(app).get(`/api/listings/seller/${testUserSeller.id}`);
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where).toEqual({
      seller_id: testUserSeller.id,
      status: 'active',
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/listings/:id/view (public, auth optional)
// ══════════════════════════════════════════════════════════════════════════

describe('POST /api/listings/:id/view (public)', () => {
  it('anonymous viewer gets counted=true', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      id: testListing.id,
      seller_id: testUserSeller.id,
      views: 0,
    });
    mockPrisma.listings.update.mockResolvedValueOnce({ views: 1 });

    const res = await request(app).post(`/api/listings/${testListing.id}/view`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, views: 1, counted: true });
  });

  it('authenticated viewer is still counted because the route has no auth middleware', async () => {
    // NOTE: The /view route is registered WITHOUT authenticateToken, so
    // even if the client sends a Bearer token, req.user is never populated
    // and the controller's self-view skip branch is unreachable here.
    // The unit test covers the skip branch directly by injecting req.user.
    // See questions.md for the documented behaviour gap.
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      id: testListing.id,
      seller_id: testUserSeller.id,
      views: 5,
    });
    mockPrisma.listings.update.mockResolvedValueOnce({ views: 6 });

    const res = await request(app)
      .post(`/api/listings/${testListing.id}/view`)
      .set(authHeader(testUserSeller));
    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(true);
  });

  it('returns 404 for non-existent listing', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/listings/lst_ghost/view');
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Error response contract
// ══════════════════════════════════════════════════════════════════════════

describe('Error response contract', () => {
  it('uses consistent { error } shape on 404', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/listings/lst_ghost');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });

  it('uses { error, details[] } shape on Zod validation failure', async () => {
    const res = await request(app)
      .post('/api/listings')
      .set(authHeader(testUserSeller))
      .send(validCreateListingPayload({ price: -5 }));
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('details');
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});
