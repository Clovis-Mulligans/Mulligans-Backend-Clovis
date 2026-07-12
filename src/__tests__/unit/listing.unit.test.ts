// Listing Controller UNIT tests.
//
// These tests exercise the REAL ListingController class from
// `src/controllers/listingController.ts`. Prisma, S3 and Sharp are the
// only things mocked — the controller logic under test is production
// code.
//
// Each test calls the controller method directly with a mock req/res so
// we can verify:
//   - correct status + response shape
//   - correct prisma calls (arguments + result consumption)
//   - correct branching in the calculation logic (club condition,
//     size-variant quantity, specification flattening, etc.)

import { jest } from '@jest/globals';

// ── Module-level mocks ────────────────────────────────────────────────────
// Must be declared before any import of the module under test.

jest.mock('../../lib/prisma', () => ({
  prisma: require('../helpers/mockPrisma').mockPrisma,
}));

jest.mock('../../services/s3Service', () => ({
  S3Service: {
    uploadImage: jest.fn<(...args: any[]) => any>(),
    deleteImage: jest.fn<(...args: any[]) => any>(),
  },
}));

// Sharp is an optional runtime dep for uploadListingImage — the controller
// does `require('sharp')` inline, so we mock the module to return a chainable
// builder whose final toBuffer() resolves to the input buffer. Signatures
// are intentionally loose so tests don't have to replicate sharp's types.
jest.mock('sharp', () => {
  const chain: any = {
    rotate: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => Buffer.from('processed'),
  };
  return jest.fn(() => chain);
});

import { ListingController } from '../../controllers/listingController';
import { mockPrisma, resetMockPrisma } from '../helpers/mockPrisma';
import { S3Service } from '../../services/s3Service';
import {
  testUserSeller,
  testUserBuyer,
  testListing,
  testImage,
  makeMockRequest,
  makeMockResponse,
} from '../helpers/testSetup';

const mockedS3 = S3Service as unknown as {
  uploadImage: jest.Mock<(...args: any[]) => any>;
  deleteImage: jest.Mock<(...args: any[]) => any>;
};

beforeEach(() => {
  resetMockPrisma();
  mockedS3.uploadImage.mockReset();
  mockedS3.deleteImage.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════
// createListing
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.createListing', () => {
  function primeSuccessPath() {
    mockPrisma.users.findUnique.mockResolvedValueOnce(testUserSeller); // existence check
    mockPrisma.listings.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    mockPrisma.listing_attributes.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      images: [],
    });
    mockPrisma.users.findUnique.mockResolvedValueOnce({
      id: testUserSeller.id,
      display_name: testUserSeller.display_name,
      avatar_url: testUserSeller.avatar_url,
      rating: testUserSeller.rating,
    });
  }

  it('creates a listing with status=active and returns 201 with a { listing } envelope', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        subcategory: 'Drivers',
      },
    });
    const res = makeMockResponse();

    await ListingController.createListing(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toHaveProperty('listing');
    expect(payload.listing).toHaveProperty('seller');

    const createArgs = mockPrisma.listings.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('active');
    expect(createArgs.data.seller_id).toBe(testUserSeller.id);
  });

  it('generates an id matching lst_{timestamp}_{random}', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: { title: 't', description: 'description text', price: 10, category: 'Clubs' },
    });
    await ListingController.createListing(req, makeMockResponse());

    const createArgs = mockPrisma.listings.create.mock.calls[0][0];
    expect(createArgs.data.id).toMatch(/^lst_\d+_[a-z0-9]+$/);
  });

  it('auto-computes condition_overall for clubs as rounded average of head/shaft/grip', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        condition_head: 5,
        condition_shaft: 4,
        condition_grip: 3, // average = 4, rounds to 4
      },
    });

    await ListingController.createListing(req, makeMockResponse());
    const createArgs = mockPrisma.listings.create.mock.calls[0][0];
    expect(createArgs.data.condition_overall).toBe(4);
  });

  it('clubs: (5, 3, 4) rounds to 4 (not 5)', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        condition_head: 5,
        condition_shaft: 3,
        condition_grip: 4, // (5+3+4)/3 = 4
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(4);
  });

  it('clubs: explicit condition_overall is OVERRIDDEN when head/shaft/grip all present', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        condition_overall: 1,
        condition_head: 5,
        condition_shaft: 5,
        condition_grip: 5,
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(5);
  });

  it('clubs: if any of head/shaft/grip missing, uses provided condition_overall directly', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        condition_overall: 3,
        condition_head: 5,
        // no shaft / no grip
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(3);
  });

  it('non-clubs: condition_overall is used as-is', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Glove',
        description: 'Barely worn glove.',
        price: 15,
        category: 'Accessories',
        condition_overall: 5,
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(5);
  });

  it('specifications.sizeQuantities auto-sums to quantity (overrides quantity field)', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Polo',
        description: 'Brand new polo shirt.',
        price: 29.99,
        category: 'Clothing',
        quantity: 1, // will be ignored
        specifications: { sizeQuantities: { S: 2, M: 3, L: 4 } },
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.quantity).toBe(9);
  });

  it('missing quantity defaults to 1', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Glove',
        description: 'A well kept glove.',
        price: 10,
        category: 'Accessories',
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.quantity).toBe(1);
  });

  it('location defaults to "UK" when omitted', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Iron set',
        description: 'Great condition irons 4-PW.',
        price: 300,
        category: 'Clubs',
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.location).toBe('UK');
  });

  it('is_negotiable defaults to false when omitted', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: { title: 'x', description: 'ten chars!', price: 10, category: 'Balls' },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.is_negotiable).toBe(false);
  });

  it('explicit is_negotiable=true passes through', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'x',
        description: 'ten chars!',
        price: 10,
        category: 'Balls',
        is_negotiable: true,
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.is_negotiable).toBe(true);
  });

  it('writes listing_attributes rows from specifications', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Driver',
        description: 'A great driver in good condition.',
        price: 199,
        category: 'Clubs',
        specifications: { dexterity: 'Right', shaftFlex: 'Stiff', loft: '10.5' },
      },
    });
    await ListingController.createListing(req, makeMockResponse());

    expect(mockPrisma.listing_attributes.createMany).toHaveBeenCalledTimes(1);
    const rows = (mockPrisma.listing_attributes.createMany.mock.calls[0][0] as any).data;
    expect(rows).toHaveLength(3);
    expect(rows.map((r: any) => r.key).sort()).toEqual(['dexterity', 'loft', 'shaftFlex']);
  });

  it('setMakeup array explodes into one listing_attributes row per iron', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Iron set',
        description: 'Great condition irons 4-PW.',
        price: 300,
        category: 'Clubs',
        specifications: { setMakeup: ['4', '5', '6', '7', '8', '9', 'PW'] },
      },
    });
    await ListingController.createListing(req, makeMockResponse());

    const rows = (mockPrisma.listing_attributes.createMany.mock.calls[0][0] as any).data;
    expect(rows).toHaveLength(7);
    expect(rows.every((r: any) => r.key === 'setMakeup')).toBe(true);
    expect(rows.map((r: any) => r.value)).toEqual(['4', '5', '6', '7', '8', '9', 'PW']);
  });

  it('includes seller info in the response', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: { title: 'x', description: 'ten chars!', price: 10, category: 'Balls' },
    });
    const res = makeMockResponse();
    await ListingController.createListing(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.listing.seller).toEqual({
      id: testUserSeller.id,
      display_name: testUserSeller.display_name,
      avatar_url: testUserSeller.avatar_url,
      rating: testUserSeller.rating,
    });
  });

  it('returns 404 when the authenticated user does not exist in the DB', async () => {
    mockPrisma.users.findUnique.mockResolvedValueOnce(null);
    const req = makeMockRequest({
      user: { id: 'ghost' },
      body: { title: 'x', description: 'ten chars!', price: 10, category: 'Balls' },
    });
    const res = makeMockResponse();

    await ListingController.createListing(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'User not found in database' });
    expect(mockPrisma.listings.create).not.toHaveBeenCalled();
  });

  it('returns 500 when prisma.listings.create throws', async () => {
    mockPrisma.users.findUnique.mockResolvedValueOnce(testUserSeller);
    mockPrisma.listings.create.mockRejectedValueOnce(new Error('db down'));
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: { title: 'x', description: 'ten chars!', price: 10, category: 'Balls' },
    });
    const res = makeMockResponse();
    await ListingController.createListing(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Failed to create listing' });
  });

  // ── NEW: seller response shape — PII check (SEC-08) ──

  it('seller in response contains only safe fields (no email, no is_banned)', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: { title: 'x', description: 'ten chars!', price: 10, category: 'Balls' },
    });
    const res = makeMockResponse();
    await ListingController.createListing(req, res);

    const sellerFields = Object.keys(res.json.mock.calls[0][0].listing.seller);
    expect(sellerFields).toEqual(expect.arrayContaining(['id', 'display_name', 'avatar_url', 'rating']));
    expect(sellerFields).not.toContain('email');
    expect(sellerFields).not.toContain('is_banned');
    expect(sellerFields).not.toContain('username');
  });

  // ── NEW: condition averaging boundary (BND-13, BND-14) ──

  it('clubs: all-ones (1,1,1) → condition_overall = 1', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Old iron',
        description: 'Heavily worn, needs regripping.',
        price: 25,
        category: 'Clubs',
        condition_head: 1,
        condition_shaft: 1,
        condition_grip: 1,
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(1);
  });

  it('clubs: (1,1,2) → rounds to 1 (Math.round(1.33) = 1)', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Old iron',
        description: 'Heavily worn, needs regripping.',
        price: 25,
        category: 'Clubs',
        condition_head: 1,
        condition_shaft: 1,
        condition_grip: 2,
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.condition_overall).toBe(1);
  });

  // ── NEW: sizeQuantities with non-numeric values (BND-12) ──

  it('sizeQuantities with non-numeric values treats them as 0', async () => {
    primeSuccessPath();
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'Polo',
        description: 'Brand new polo shirt.',
        price: 29.99,
        category: 'Clothing',
        quantity: 5,
        specifications: { sizeQuantities: { S: 'abc', M: '3' } },
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    // parseInt('abc') = NaN → || 0, parseInt('3') = 3, total = 3
    expect(mockPrisma.listings.create.mock.calls[0][0].data.quantity).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getAllListings
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.getAllListings', () => {
  it('returns paginated results with the canonical shape', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    mockPrisma.listings.count.mockResolvedValueOnce(1);
    const req = makeMockRequest({ query: { page: '1', limit: '20' } });
    const res = makeMockResponse();

    await ListingController.getAllListings(req, res);

    expect(res.json).toHaveBeenCalledWith({
      listings: [testListing],
      pagination: { total: 1, page: 1, limit: 20, pages: 1 },
    });
  });

  it('only queries status=active listings', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(makeMockRequest(), makeMockResponse());

    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.status).toBe('active');
  });

  it('applies category filter', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { category: 'Clubs' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.category).toBe('Clubs');
  });

  it('applies subcategory filter', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { subcategory: 'Drivers' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.subcategory).toBe('Drivers');
  });

  it('applies price range filter', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { minPrice: '50', maxPrice: '500' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.price).toEqual({ gte: 50, lte: 500 });
  });

  it('minPrice only sets gte, not lte', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { minPrice: '50' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.price).toEqual({ gte: 50 });
  });

  it('applies brand filter case-insensitively via contains', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { brand: 'TaylorMade' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.brand).toEqual({ contains: 'TaylorMade', mode: 'insensitive' });
  });

  it('strips duplicates if brand is sent as comma-separated', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { brand: 'TaylorMade,TaylorMade' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.brand.contains).toBe('TaylorMade');
  });

  it('keyword search matches title, description, brand, model', async () => {
    mockPrisma.listing_attributes.findMany.mockResolvedValueOnce([]); // shaftModel lookup
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { keyword: 'stealth' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    const conditions = args.where.OR as any[];
    expect(conditions).toEqual(expect.arrayContaining([
      { title: { contains: 'stealth', mode: 'insensitive' } },
      { description: { contains: 'stealth', mode: 'insensitive' } },
      { brand: { contains: 'stealth', mode: 'insensitive' } },
      { model: { contains: 'stealth', mode: 'insensitive' } },
    ]));
  });

  it('q param builds OR condition across title and description', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { q: 'wedge' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.OR).toEqual([
      { title: { contains: 'wedge', mode: 'insensitive' } },
      { description: { contains: 'wedge', mode: 'insensitive' } },
    ]);
  });

  it('dexterity attribute filter intersects via listing_attributes', async () => {
    mockPrisma.listing_attributes.findMany.mockResolvedValueOnce([
      { listing_id: 'lst_1' },
      { listing_id: 'lst_2' },
    ]);
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { dexterity: 'Right' } }),
      makeMockResponse()
    );

    const attrCallArgs = mockPrisma.listing_attributes.findMany.mock.calls[0][0] as any;
    expect(attrCallArgs.where).toEqual({ key: 'dexterity', value: 'Right' });

    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.id.in).toEqual(['lst_1', 'lst_2']);
  });

  it('shaftFlex attribute filter queries listing_attributes', async () => {
    mockPrisma.listing_attributes.findMany.mockResolvedValueOnce([{ listing_id: 'lst_a' }]);
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { shaftFlex: 'Stiff' } }),
      makeMockResponse()
    );
    const attrCall = mockPrisma.listing_attributes.findMany.mock.calls[0][0] as any;
    expect(attrCall.where).toEqual({ key: 'shaftFlex', value: 'Stiff' });
  });

  it('short-circuits with empty list when attribute filters match nothing', async () => {
    mockPrisma.listing_attributes.findMany.mockResolvedValueOnce([]); // no matches
    const res = makeMockResponse();
    await ListingController.getAllListings(
      makeMockRequest({ query: { dexterity: 'Left' } }),
      res
    );
    expect(res.json.mock.calls[0][0]).toEqual({
      listings: [],
      pagination: { total: 0, page: 1, limit: 20, pages: 0 },
    });
    expect(mockPrisma.listings.findMany).not.toHaveBeenCalled();
  });

  it('uses default pagination (page=1, limit=20) when not provided', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(makeMockRequest(), makeMockResponse());

    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('pagination: page=3, limit=10 => skip=20, take=10', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { page: '3', limit: '10' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });

  it('empty results return the expected empty shape', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    const res = makeMockResponse();
    await ListingController.getAllListings(makeMockRequest(), res);
    expect(res.json.mock.calls[0][0]).toEqual({
      listings: [],
      pagination: { total: 0, page: 1, limit: 20, pages: 0 },
    });
  });

  it('returns 500 when prisma throws', async () => {
    mockPrisma.listings.findMany.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    const res = makeMockResponse();
    await ListingController.getAllListings(makeMockRequest(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  // ── NEW: condition filter uses gte (A4) ──

  it('applies condition filter as gte on condition_overall', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { condition: '3' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.condition_overall).toEqual({ gte: 3 });
  });

  // ── NEW: seller_id filter (A5) ──

  it('applies seller_id filter as exact match', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { seller_id: 'user_abc' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.seller_id).toBe('user_abc');
  });

  // ── NEW: model filter (A14) ──

  it('applies model filter case-insensitively via contains', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { model: 'Stealth' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.model).toEqual({ contains: 'Stealth', mode: 'insensitive' });
  });

  // ── NEW: offset override (A26) ──

  it('offset param overrides page-based skip calculation', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    await ListingController.getAllListings(
      makeMockRequest({ query: { page: '3', limit: '10', offset: '5' } }),
      makeMockResponse()
    );
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.skip).toBe(5); // offset=5 overrides page=3 which would give skip=20
  });

  // ── NEW: size filter exact match (A19, A20) ──

  it('size filter finds exact matches via listing_attributes', async () => {
    // Exact match query returns one listing
    mockPrisma.listing_attributes.findMany
      .mockResolvedValueOnce([{ listing_id: 'lst_match' }])  // exact match
      .mockResolvedValueOnce([]);  // "Various" match
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);

    await ListingController.getAllListings(
      makeMockRequest({ query: { size: 'M' } }),
      makeMockResponse()
    );

    const attrCall = mockPrisma.listing_attributes.findMany.mock.calls[0][0] as any;
    expect(attrCall.where).toEqual({ key: 'size', value: 'M' });
  });

  // ── NEW: size filter short-circuit on no matches (A22) ──

  it('size filter with no matches returns empty without querying listings', async () => {
    mockPrisma.listing_attributes.findMany
      .mockResolvedValueOnce([])  // no exact match
      .mockResolvedValueOnce([]); // no "Various" match

    const res = makeMockResponse();
    await ListingController.getAllListings(
      makeMockRequest({ query: { size: 'XXXL' } }),
      res
    );

    expect(res.json.mock.calls[0][0].listings).toEqual([]);
    expect(res.json.mock.calls[0][0].pagination.total).toBe(0);
  });

  // ── NEW: multiple attribute filters intersect (A23) ──

  it('multiple attribute filters intersect (AND logic)', async () => {
    // dexterity=Right matches lst_1, lst_2
    // shaftFlex=Stiff matches lst_2, lst_3
    // intersection should be lst_2
    mockPrisma.listing_attributes.findMany
      .mockResolvedValueOnce([{ listing_id: 'lst_1' }, { listing_id: 'lst_2' }])  // dexterity
      .mockResolvedValueOnce([{ listing_id: 'lst_2' }, { listing_id: 'lst_3' }]); // shaftFlex
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);

    await ListingController.getAllListings(
      makeMockRequest({ query: { dexterity: 'Right', shaftFlex: 'Stiff' } }),
      makeMockResponse()
    );

    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.id.in).toEqual(['lst_2']);
  });

  // ── NEW: Prisma parameterizes search (SEC-10) ──

  it('search query with SQL injection attempt is safely parameterized', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.count.mockResolvedValueOnce(0);
    const res = makeMockResponse();

    await ListingController.getAllListings(
      makeMockRequest({ query: { q: "'; DROP TABLE listings;--" } }),
      res
    );

    // Prisma parameterizes the query — the injection string is treated as a literal search term
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where.OR[0].title.contains).toBe("'; DROP TABLE listings;--");
    expect(res.statusCode).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getListingById
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.getListingById', () => {
  it('returns the listing with seller and favorite_count', async () => {
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
    mockPrisma.favorites.count.mockResolvedValueOnce(7);

    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({ params: { id: testListing.id } }),
      res
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.listing).toMatchObject({
      id: testListing.id,
      favorite_count: 7,
    });
    expect(payload.listing.seller).toBeDefined();
    expect(payload.listing.seller.display_name).toBe(testUserSeller.display_name);
  });

  it('returns 404 when the listing does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({ params: { id: 'nope' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Listing not found' });
  });

  // ── NEW: soft-deleted listing returns 404 (STA-02, G1) ──

  it('returns 404 when listing exists but has status=deleted', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      status: 'deleted',
    });
    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({ params: { id: testListing.id } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Listing not found' });
  });

  // ── NEW: viewer_active_offer for authenticated buyer (POS-05, G4, G5) ──

  it('returns viewer_active_offer for authenticated buyer with an accepted offer', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h
    const respondedAt = new Date(now.getTime() - 60 * 1000); // -1min

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
    mockPrisma.favorites.count.mockResolvedValueOnce(0);
    mockPrisma.offers.findFirst.mockResolvedValueOnce({
      id: 'offer_123',
      final_amount: 200.00,
      responded_at: respondedAt,
      acceptance_expires_at: expiresAt,
      status: 'ACCEPTED',
    });

    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({
        user: { id: testUserBuyer.id },
        params: { id: testListing.id },
      }),
      res
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.listing.viewer_active_offer).toEqual({
      offer_id: 'offer_123',
      offer_amount: '200',
      accepted_at: respondedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: 'ACCEPTED',
    });
  });

  // ── NEW: seller viewing own listing gets no viewer_active_offer (G6) ──

  it('does NOT return viewer_active_offer when viewer is the seller', async () => {
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
    mockPrisma.favorites.count.mockResolvedValueOnce(0);

    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );

    expect(mockPrisma.offers.findFirst).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].listing.viewer_active_offer).toBeNull();
  });

  // ── NEW: seller PII check (SEC-07) ──

  it('seller object in detail response has only safe fields', async () => {
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
    mockPrisma.favorites.count.mockResolvedValueOnce(0);

    const res = makeMockResponse();
    await ListingController.getListingById(
      makeMockRequest({ params: { id: testListing.id } }),
      res
    );

    const sellerFields = Object.keys(res.json.mock.calls[0][0].listing.seller);
    const safeFields = ['id', 'display_name', 'rating', 'avatar_url', 'is_verified_seller', 'is_pro_store', 'pro_store_name'];
    expect(sellerFields.sort()).toEqual(safeFields.sort());
    expect(sellerFields).not.toContain('email');
    expect(sellerFields).not.toContain('is_banned');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// updateListing
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.updateListing', () => {
  it('updates title, price, description when owner', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)      // ownership check
      .mockResolvedValueOnce(testListing);     // final refetch
    mockPrisma.listings.update.mockResolvedValueOnce(testListing);

    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      params: { id: testListing.id },
      body: { title: 'New title', price: 300, description: 'Updated description here.' },
    });
    const res = makeMockResponse();

    await ListingController.updateListing(req, res);

    const updArgs = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(updArgs.where).toEqual({ id: testListing.id });
    expect(updArgs.data.title).toBe('New title');
    expect(updArgs.data.price).toBe(300);
    expect(updArgs.data.description).toBe('Updated description here.');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Clubs: recalculates condition_overall on update', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)
      .mockResolvedValueOnce(testListing);
    mockPrisma.listings.update.mockResolvedValueOnce(testListing);

    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        body: {
          category: 'Clubs',
          condition_head: 5,
          condition_shaft: 3,
          condition_grip: 4,
        },
      }),
      makeMockResponse()
    );

    const updArgs = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(updArgs.data.condition_overall).toBe(4);
  });

  it('replaces listing_attributes when specifications are provided', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)
      .mockResolvedValueOnce(testListing);
    mockPrisma.listings.update.mockResolvedValueOnce(testListing);
    mockPrisma.listing_attributes.deleteMany.mockResolvedValueOnce({ count: 3 });
    mockPrisma.listing_attributes.createMany.mockResolvedValueOnce({ count: 2 });

    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        body: { specifications: { dexterity: 'Left', shaftFlex: 'Regular' } },
      }),
      makeMockResponse()
    );

    expect(mockPrisma.listing_attributes.deleteMany).toHaveBeenCalledWith({
      where: { listing_id: testListing.id },
    });
    const createRows = (mockPrisma.listing_attributes.createMany.mock.calls[0][0] as any).data;
    expect(createRows).toHaveLength(2);
  });

  it('returns 403 when non-owner tries to update', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
    });
    const res = makeMockResponse();
    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        body: { title: 'Hijack attempt' },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Unauthorized' });
    expect(mockPrisma.listings.update).not.toHaveBeenCalled();
  });

  it('returns 404 when listing does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: 'ghost' },
        body: { title: 'x' },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // ── NEW: location does NOT default to 'UK' on update (STA-05, UP6) ──

  it('update does not apply UK default for location (unlike create)', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)
      .mockResolvedValueOnce(testListing);
    mockPrisma.listings.update.mockResolvedValueOnce(testListing);

    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        body: { location: '' },
      }),
      makeMockResponse()
    );

    const updArgs = mockPrisma.listings.update.mock.calls[0][0] as any;
    // Falsy location on update → null (not 'UK')
    expect(updArgs.data.location).toBeNull();
  });

  // ── NEW: quantity recalculation with sizeQuantities on update (UP8) ──

  it('recalculates quantity from sizeQuantities on update', async () => {
    mockPrisma.listings.findUnique
      .mockResolvedValueOnce(testListing)
      .mockResolvedValueOnce(testListing);
    mockPrisma.listings.update.mockResolvedValueOnce(testListing);
    mockPrisma.listing_attributes.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.listing_attributes.createMany.mockResolvedValueOnce({ count: 0 });

    await ListingController.updateListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        body: {
          specifications: { sizeQuantities: { S: 5, M: 10, L: 3 } },
        },
      }),
      makeMockResponse()
    );

    const updArgs = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(updArgs.data.quantity).toBe(18);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// deleteListing
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.deleteListing', () => {
  const listingWithImages = { ...testListing, images: [testImage] };

  // CORRECTED: soft-deletes via listings.update, NOT listings.delete.
  // POLICY (Harry, 12 Jul 2026): S3 images are RETAINED when a listing is
  // deleted. A failure here means someone added S3 cleanup — that is a
  // POLICY BREACH, not a bug fix. Escalate before reverting.
  it('soft-deletes listing and retains S3 images (policy: images are never deleted)', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(listingWithImages);
    mockPrisma.orders.findFirst.mockResolvedValueOnce(null);
    mockPrisma.listings.update.mockResolvedValueOnce({ ...testListing, status: 'deleted' });

    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );

    // 30 confirmed by policy owner, 12 Jul 2026.
    expect(mockedS3.deleteImage).not.toHaveBeenCalled();

    const updateArgs = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(updateArgs.where).toEqual({ id: testListing.id });
    expect(updateArgs.data.status).toBe('deleted');
    expect(updateArgs.data.deleted_at).toBeInstanceOf(Date);
    expect(updateArgs.data.updated_at).toBeInstanceOf(Date);

    expect(res.json.mock.calls[0][0]).toEqual({ message: 'Listing deleted successfully' });
  });

  it('blocks deletion with 400 when an active order exists (status=paid)', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(listingWithImages);
    mockPrisma.orders.findFirst.mockResolvedValueOnce({ id: 'ord_1', status: 'paid' });

    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.order_status).toBe('paid');
    expect(body.error).toMatch(/shipped|waiting|order/i);
    expect(mockPrisma.listings.update).not.toHaveBeenCalled();
  });

  it('uses shipped-specific message for status=shipped', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(listingWithImages);
    mockPrisma.orders.findFirst.mockResolvedValueOnce({ id: 'ord_1', status: 'shipped' });
    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );
    expect(res.json.mock.calls[0][0].error).toMatch(/in transit/i);
  });

  it('uses delivered-specific message for status=delivered', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(listingWithImages);
    mockPrisma.orders.findFirst.mockResolvedValueOnce({ id: 'ord_1', status: 'delivered' });
    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );
    expect(res.json.mock.calls[0][0].error).toMatch(/transaction completes/i);
  });

  it('active-order check queries the 6 expected statuses', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(listingWithImages);
    mockPrisma.orders.findFirst.mockResolvedValueOnce(null);
    mockPrisma.listings.update.mockResolvedValueOnce({ ...testListing, status: 'deleted' });

    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      makeMockResponse()
    );

    const args = mockPrisma.orders.findFirst.mock.calls[0][0] as any;
    expect(args.where.status.in).toEqual([
      'pending',
      'paid',
      'to_ship',
      'shipped',
      'in_transit',
      'delivered',
    ]);
  });

  it('returns 403 when non-owner tries to delete', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...listingWithImages,
      seller_id: 'someone_else',
    });
    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserBuyer.id },
        params: { id: testListing.id },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 for non-existent listing', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: 'ghost' },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // CORRECTED: S3 is never called during deletion (policy retention).
  // The old test asserted "skips S3 when no images" — but the truth is
  // S3 is never called regardless of image count.
  it('S3 is never called during deletion even when listing has no images', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({ ...testListing, images: [] });
    mockPrisma.orders.findFirst.mockResolvedValueOnce(null);
    mockPrisma.listings.update.mockResolvedValueOnce({ ...testListing, status: 'deleted' });

    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      makeMockResponse()
    );

    expect(mockedS3.deleteImage).not.toHaveBeenCalled();
  });

  // ── NEW: idempotent delete (STA-01, D3) ──

  it('returns 200 without re-processing when listing is already deleted', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...listingWithImages,
      status: 'deleted',
    });

    const res = makeMockResponse();
    await ListingController.deleteListing(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );

    expect(res.json.mock.calls[0][0]).toEqual({ message: 'Listing deleted successfully' });
    expect(mockPrisma.orders.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.listings.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// uploadListingImage
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.uploadListingImage', () => {
  it('processes and uploads each file then returns { message, count }', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockedS3.uploadImage.mockResolvedValue({ url: 'https://cdn/test.jpg', key: 'listings/x/test.jpg' });
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const files = [
      { buffer: Buffer.from('a'), originalname: 'a.png', mimetype: 'image/png' },
      { buffer: Buffer.from('b'), originalname: 'b.heic', mimetype: 'image/heic' },
    ];
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      params: { id: testListing.id },
      files,
    });
    const res = makeMockResponse();

    await ListingController.uploadListingImage(req, res);

    expect(mockedS3.uploadImage).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Images uploaded successfully',
      count: 2,
    });
  });

  it('renames .heic/.heif/.png/.webp to .jpg', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockedS3.uploadImage.mockResolvedValue({ url: 'u', key: 'k' });
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await ListingController.uploadListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        files: [{ buffer: Buffer.from('x'), originalname: 'photo.heic', mimetype: 'image/heic' }],
      }),
      makeMockResponse()
    );

    const uploadCallArgs = mockedS3.uploadImage.mock.calls[0];
    expect(uploadCallArgs[2]).toBe('photo.jpg');
  });

  it('returns 404 when the listing does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.uploadListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: 'ghost' },
        files: [{ buffer: Buffer.from('x'), originalname: 'a.jpg', mimetype: 'image/jpeg' }],
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 when uploading to a listing the user does not own', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'someone_else',
    });
    const res = makeMockResponse();
    await ListingController.uploadListingImage(
      makeMockRequest({
        user: { id: testUserBuyer.id },
        params: { id: testListing.id },
        files: [{ buffer: Buffer.from('x'), originalname: 'a.jpg', mimetype: 'image/jpeg' }],
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockedS3.uploadImage).not.toHaveBeenCalled();
  });

  it('returns 400 when no files provided', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    const res = makeMockResponse();
    await ListingController.uploadListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        files: [],
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'No files uploaded' });
  });

  // ── NEW: sharp failure fallback (INT-01, U5) ──

  it('falls back to original buffer when sharp processing fails', async () => {
    // Override the sharp mock to throw for this test
    const sharp = require('sharp');
    sharp.mockImplementationOnce(() => {
      throw new Error('sharp failure');
    });

    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockedS3.uploadImage.mockResolvedValue({ url: 'u', key: 'k' });
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const originalBuffer = Buffer.from('original-image-data');
    const res = makeMockResponse();
    await ListingController.uploadListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
        files: [{ buffer: originalBuffer, originalname: 'photo.jpg', mimetype: 'image/jpeg' }],
      }),
      res
    );

    // Should still succeed with original buffer
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockedS3.uploadImage).toHaveBeenCalledTimes(1);
    const uploadedBuffer = mockedS3.uploadImage.mock.calls[0][0];
    expect(uploadedBuffer).toBe(originalBuffer);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// deleteListingImage
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.deleteListingImage', () => {
  it('deletes image when owner', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.images.findUnique.mockResolvedValueOnce(testImage);
    mockedS3.deleteImage.mockResolvedValue(undefined);
    mockPrisma.images.delete.mockResolvedValueOnce(testImage);

    const res = makeMockResponse();
    await ListingController.deleteListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id, imageId: testImage.id },
      }),
      res
    );

    expect(mockedS3.deleteImage).toHaveBeenCalledWith(testImage.s3_key);
    expect(mockPrisma.images.delete).toHaveBeenCalledWith({ where: { id: testImage.id } });
    expect(res.json.mock.calls[0][0]).toEqual({ message: 'Image deleted successfully' });
  });

  it('returns 403 when non-owner', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      ...testListing,
      seller_id: 'other',
    });
    const res = makeMockResponse();
    await ListingController.deleteListingImage(
      makeMockRequest({
        user: { id: testUserBuyer.id },
        params: { id: testListing.id, imageId: testImage.id },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.images.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when listing does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.deleteListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: 'ghost', imageId: testImage.id },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when image does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing);
    mockPrisma.images.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.deleteListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id, imageId: 'nope' },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Image not found' });
  });

  // SECURITY: a caller must not be able to delete images from a listing they
  // do not own, even if they own the listing named in params.id.
  // (FIND-LST-01, fixed 12 Jul 2026.)
  it('rejects deleting an image that belongs to a different listing (403)', async () => {
    const otherListingImage = {
      ...testImage,
      id: 'img_other_listing',
      listing_id: 'lst_different_listing',
      s3_key: 'listings/other/photo.jpg',
    };

    mockPrisma.listings.findUnique.mockResolvedValueOnce(testListing); // owns this listing
    mockPrisma.images.findUnique.mockResolvedValueOnce(otherListingImage); // image belongs to different listing

    const res = makeMockResponse();
    await ListingController.deleteListingImage(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id, imageId: otherListingImage.id },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Unauthorized' });
    expect(mockedS3.deleteImage).not.toHaveBeenCalled();
    expect(mockPrisma.images.delete).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getSellerListings
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.getSellerListings', () => {
  it('queries by seller_id with status=active', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    const res = makeMockResponse();

    await ListingController.getSellerListings(
      makeMockRequest({ params: { seller_id: testUserSeller.id } }),
      res
    );

    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.where).toEqual({
      seller_id: testUserSeller.id,
      status: 'active',
    });
    expect(res.json).toHaveBeenCalledWith({ listings: [testListing] });
  });

  it('returns an empty array when seller has no active listings', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    const res = makeMockResponse();
    await ListingController.getSellerListings(
      makeMockRequest({ params: { seller_id: 'nobody' } }),
      res
    );
    expect(res.json).toHaveBeenCalledWith({ listings: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// trackView
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.trackView', () => {
  it('increments views for a buyer viewing someone else\'s listing', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      id: testListing.id,
      seller_id: testUserSeller.id,
      views: 10,
    });
    mockPrisma.listings.update.mockResolvedValueOnce({ views: 11 });

    const res = makeMockResponse();
    await ListingController.trackView(
      makeMockRequest({
        user: { id: testUserBuyer.id },
        params: { id: testListing.id },
      }),
      res
    );

    expect(mockPrisma.listings.update).toHaveBeenCalledWith({
      where: { id: testListing.id },
      data: { views: { increment: 1 } },
      select: { views: true },
    });
    expect(res.json.mock.calls[0][0]).toEqual({
      success: true,
      views: 11,
      counted: true,
    });
  });

  it('does NOT increment when the viewer is the seller', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      id: testListing.id,
      seller_id: testUserSeller.id,
      views: 5,
    });

    const res = makeMockResponse();
    await ListingController.trackView(
      makeMockRequest({
        user: { id: testUserSeller.id },
        params: { id: testListing.id },
      }),
      res
    );

    expect(mockPrisma.listings.update).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toEqual({
      success: true,
      views: 5,
      counted: false,
    });
  });

  it('counts anonymous views (no user)', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce({
      id: testListing.id,
      seller_id: testUserSeller.id,
      views: 0,
    });
    mockPrisma.listings.update.mockResolvedValueOnce({ views: 1 });

    const res = makeMockResponse();
    await ListingController.trackView(
      makeMockRequest({ params: { id: testListing.id } }),
      res
    );
    expect(res.json.mock.calls[0][0].counted).toBe(true);
  });

  it('returns 404 when listing does not exist', async () => {
    mockPrisma.listings.findUnique.mockResolvedValueOnce(null);
    const res = makeMockResponse();
    await ListingController.trackView(
      makeMockRequest({ params: { id: 'ghost' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getFeaturedListings
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.getFeaturedListings', () => {
  it('returns unpersonalised results when not logged in', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    const res = makeMockResponse();

    await ListingController.getFeaturedListings(makeMockRequest(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.personalized).toBe(false);
    expect(body.matches).toBe(0);
    expect(body.total).toBe(1);
    expect(mockPrisma.users.findUnique).not.toHaveBeenCalled();
  });

  it('returns unpersonalised when user has no size preferences', async () => {
    mockPrisma.users.findUnique.mockResolvedValueOnce({
      sizing_preference: null,
      clothing_size: [],
      shoe_size: [],
      glove_size: [],
    });
    mockPrisma.listings.findMany.mockResolvedValueOnce([testListing]);
    const res = makeMockResponse();

    await ListingController.getFeaturedListings(
      makeMockRequest({ user: { id: testUserBuyer.id } }),
      res
    );

    expect(res.json.mock.calls[0][0].personalized).toBe(false);
  });

  it('prioritises listings matching user clothing_size preferences', async () => {
    mockPrisma.users.findUnique.mockResolvedValueOnce({
      sizing_preference: 'mens',
      clothing_size: ['M'],
      shoe_size: [],
      glove_size: [],
    });
    mockPrisma.listings.findMany.mockResolvedValueOnce([
      { ...testListing, id: 'match-1', specifications: { clothing_size: 'M' } },
      { ...testListing, id: 'non-match', specifications: { clothing_size: 'XL' } },
      { ...testListing, id: 'match-2', specifications: { clothing_size: 'M' } },
    ]);

    const res = makeMockResponse();
    await ListingController.getFeaturedListings(
      makeMockRequest({ user: { id: testUserBuyer.id } }),
      res
    );

    const body = res.json.mock.calls[0][0];
    expect(body.personalized).toBe(true);
    expect(body.matches).toBe(2);
    expect(body.listings[0].id).toMatch(/^match-/);
    expect(body.listings[1].id).toMatch(/^match-/);
    expect(body.listings[2].id).toBe('non-match');
  });

  // CORRECTED: take=30, where includes is_pro_store filter.
  // 30 confirmed by policy owner, 12 Jul 2026.
  it('hits prisma with take=30 for pro-store active listings', async () => {
    mockPrisma.listings.findMany.mockResolvedValueOnce([]);
    await ListingController.getFeaturedListings(makeMockRequest(), makeMockResponse());
    const args = mockPrisma.listings.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(30);
    expect(args.where).toEqual({
      status: 'active',
      users: { is_pro_store: true },
    });
  });

  // ── NEW: personalization with prefs but no matching listings (STA-06, F9) ──

  it('returns personalized=false when user has prefs but no listings match', async () => {
    mockPrisma.users.findUnique.mockResolvedValueOnce({
      sizing_preference: 'mens',
      clothing_size: ['XXL'],
      shoe_size: [],
      glove_size: [],
    });
    mockPrisma.listings.findMany.mockResolvedValueOnce([
      { ...testListing, id: 'no-match-1', specifications: { clothing_size: 'S' } },
      { ...testListing, id: 'no-match-2', specifications: { clothing_size: 'M' } },
    ]);

    const res = makeMockResponse();
    await ListingController.getFeaturedListings(
      makeMockRequest({ user: { id: testUserBuyer.id } }),
      res
    );

    const body = res.json.mock.calls[0][0];
    expect(body.personalized).toBe(false);
    expect(body.matches).toBe(0);
    expect(body.listings).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Internal helper behaviours sanity-checked via createListing
// ══════════════════════════════════════════════════════════════════════════

describe('calculateTotalFromSizeQuantities (indirectly, via createListing)', () => {
  beforeEach(() => {
    mockPrisma.users.findUnique.mockResolvedValue(testUserSeller);
    mockPrisma.listings.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    mockPrisma.listings.findUnique.mockResolvedValue({ ...testListing, images: [] });
  });

  it('falls back to quantity when sizeQuantities is empty / zero', async () => {
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'x',
        description: 'ten chars!',
        price: 10,
        category: 'Clothing',
        quantity: 5,
        specifications: { sizeQuantities: { S: 0, M: 0 } },
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.quantity).toBe(5);
  });

  it('treats missing sizeQuantities field as no-op (uses quantity field)', async () => {
    const req = makeMockRequest({
      user: { id: testUserSeller.id },
      body: {
        title: 'x',
        description: 'ten chars!',
        price: 10,
        category: 'Clothing',
        quantity: 3,
        specifications: { color: 'Black' },
      },
    });
    await ListingController.createListing(req, makeMockResponse());
    expect(mockPrisma.listings.create.mock.calls[0][0].data.quantity).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// bulkUpdateListings
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.bulkUpdateListings', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({ user: { id: testUserSeller.id }, body: {} }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'ids must be a non-empty array' });
  });

  it('returns 400 when ids is an empty array', async () => {
    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({ user: { id: testUserSeller.id }, body: { ids: [] } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 when user does not own all listed ids', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1); // owns 1, sent 2
    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_owned', 'lst_not_owned'], status: 'sold' },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'You do not own all of these listings' });
  });

  it('updates status via updateMany when owner', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(2);
    mockPrisma.listings.updateMany.mockResolvedValueOnce({ count: 2 });

    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1', 'lst_2'], status: 'sold' },
      }),
      res
    );

    expect(mockPrisma.listings.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lst_1', 'lst_2'] }, seller_id: testUserSeller.id },
      data: { status: 'sold' },
    });
    expect(res.json.mock.calls[0][0]).toEqual({ updated: 2 });
  });

  it('applies percentage price adjustment to each listing individually', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(2);
    mockPrisma.listings.findMany.mockResolvedValueOnce([
      { id: 'lst_1', price: '100.00' },
      { id: 'lst_2', price: '200.00' },
    ]);
    mockPrisma.listings.update.mockResolvedValue({});

    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1', 'lst_2'], price_adjustment_percent: -10 },
      }),
      res
    );

    expect(mockPrisma.listings.update).toHaveBeenCalledTimes(2);
    const call1 = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(call1.data.price).toBe('90.00');
    const call2 = mockPrisma.listings.update.mock.calls[1][0] as any;
    expect(call2.data.price).toBe('180.00');
    expect(res.json.mock.calls[0][0]).toEqual({ updated: 2 });
  });

  it('returns 400 when no update data provided', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1);
    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1'] },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'No update data provided' });
  });

  // ── NEW: percent adjustment clamps negative prices to 0 (BND-16, BU6) ──

  it('clamps price to 0 when percent adjustment would make it negative', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1);
    mockPrisma.listings.findMany.mockResolvedValueOnce([
      { id: 'lst_1', price: '50.00' },
    ]);
    mockPrisma.listings.update.mockResolvedValue({});

    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1'], price_adjustment_percent: -150 },
      }),
      res
    );

    const call = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(call.data.price).toBe('0.00');
  });

  // This documents a KNOWN GAP, not intended behaviour. If this test fails,
  // someone fixed the gap — update the test, do not revert.
  it('KNOWN GAP (FIND-LST-04): percent path drops status — asserts current behaviour', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1);
    mockPrisma.listings.findMany.mockResolvedValueOnce([
      { id: 'lst_1', price: '100.00' },
    ]);
    mockPrisma.listings.update.mockResolvedValue({});

    const res = makeMockResponse();
    await ListingController.bulkUpdateListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1'], status: 'sold', price_adjustment_percent: 10 },
      }),
      res
    );

    // Only the price adjustment is applied; status is NOT updated
    const call = mockPrisma.listings.update.mock.calls[0][0] as any;
    expect(call.data.price).toBe('110.00');
    expect(call.data.status).toBeUndefined();
    expect(mockPrisma.listings.updateMany).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// bulkDeleteListings
// ══════════════════════════════════════════════════════════════════════════

describe('ListingController.bulkDeleteListings', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const res = makeMockResponse();
    await ListingController.bulkDeleteListings(
      makeMockRequest({ user: { id: testUserSeller.id }, body: {} }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'ids must be a non-empty array' });
  });

  it('returns 403 when user does not own all listed ids', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1); // owns 1, sent 3
    const res = makeMockResponse();
    await ListingController.bulkDeleteListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1', 'lst_2', 'lst_3'] },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('soft-deletes via updateMany when owner and no active orders', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(2);
    mockPrisma.orders.findMany.mockResolvedValueOnce([]); // no active orders
    mockPrisma.listings.updateMany.mockResolvedValueOnce({ count: 2 });

    const res = makeMockResponse();
    await ListingController.bulkDeleteListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1', 'lst_2'] },
      }),
      res
    );

    const updateCall = mockPrisma.listings.updateMany.mock.calls[0][0] as any;
    expect(updateCall.where).toEqual({ id: { in: ['lst_1', 'lst_2'] }, seller_id: testUserSeller.id });
    expect(updateCall.data.status).toBe('deleted');
    expect(updateCall.data.deleted_at).toBeInstanceOf(Date);
    expect(updateCall.data.updated_at).toBeInstanceOf(Date);
    expect(res.json.mock.calls[0][0]).toEqual({ deleted: 2 });
  });

  it('blocks bulk delete when any listing has an active order', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(2);
    mockPrisma.orders.findMany.mockResolvedValueOnce([
      { listing_id: 'lst_blocked', status: 'paid' },
    ]);

    const res = makeMockResponse();
    await ListingController.bulkDeleteListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_ok', 'lst_blocked'] },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/active orders/i);
    expect(res.json.mock.calls[0][0].blocked).toEqual([
      { listing_id: 'lst_blocked', order_status: 'paid' },
    ]);
    expect(mockPrisma.listings.updateMany).not.toHaveBeenCalled();
  });

  it('queries orders with all 6 active statuses', async () => {
    mockPrisma.listings.count.mockResolvedValueOnce(1);
    mockPrisma.orders.findMany.mockResolvedValueOnce([]);
    mockPrisma.listings.updateMany.mockResolvedValueOnce({ count: 1 });

    await ListingController.bulkDeleteListings(
      makeMockRequest({
        user: { id: testUserSeller.id },
        body: { ids: ['lst_1'] },
      }),
      makeMockResponse()
    );

    const orderArgs = mockPrisma.orders.findMany.mock.calls[0][0] as any;
    expect(orderArgs.where.status.in).toEqual([
      'pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered',
    ]);
  });
});
