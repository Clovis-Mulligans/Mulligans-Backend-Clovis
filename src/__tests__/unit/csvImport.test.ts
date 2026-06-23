import { parseCsv, IncomingListing } from '../../services/csvAdapter';
import crypto from 'crypto';

// ── Mock uuid (ESM module needs mocking before import) ──────────────────
let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => {
    uuidCounter++;
    // Generate a valid v4 UUID format with a unique counter
    const hex = uuidCounter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-a000-${hex}`;
  },
}));

import { importListings } from '../../services/importService';

// ── Prisma mock ─────────────────────────────────────────────────────────
const createdListings: any[] = [];
const createdAttributes: any[] = [];

jest.mock('../../lib/prisma', () => ({
  prisma: {
    listings: {
      create: jest.fn(({ data }: any) => {
        const dup = createdListings.find(
          l => l.seller_id === data.seller_id &&
               l.external_source === data.external_source &&
               l.external_id === data.external_id &&
               l.external_source !== null,
        );
        if (dup) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          err.meta = { target: ['listings_external_dedup'] };
          throw err;
        }
        createdListings.push(data);
        return Promise.resolve(data);
      }),
    },
    listing_attributes: {
      createMany: jest.fn(({ data }: any) => {
        createdAttributes.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
  },
}));

beforeEach(() => {
  createdListings.length = 0;
  createdAttributes.length = 0;
  uuidCounter = 0;
  jest.clearAllMocks();
});

// ── Helper: build CSV string ────────────────────────────────────────────

function csvBuffer(headers: string, ...rows: string[]): Buffer {
  return Buffer.from([headers, ...rows].join('\n'));
}

const HEADERS = 'title,description,price,category,subcategory,parcel_size,shipping_cost,location,brand,model,condition,accepts_offers,quantity,sku,club_type,shaft_flex';

function validRow(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    title: 'TaylorMade Stealth 2 Driver',
    description: 'Excellent driver in great condition with headcover',
    price: '249.99',
    category: 'Clubs',
    subcategory: 'Drivers',
    parcel_size: 'Large',
    shipping_cost: '7.50',
    location: 'UK',
    brand: 'TaylorMade',
    model: 'Stealth 2',
    condition: 'Like New',
    accepts_offers: 'true',
    quantity: '1',
    sku: '',
    club_type: 'Driver',
    shaft_flex: 'Regular',
  };
  const merged = { ...defaults, ...overrides };
  return Object.values(merged).join(',');
}

const SELLER_ID = 'seller-1';

// ── Test 1: Valid CSV → all created as draft ────────────────────────────

describe('csvAdapter + importService', () => {
  test('1. valid CSV rows → all created as status:draft with external_source:csv', async () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'SKU-001' }),
      validRow({ title: 'Ping G430 Iron Set', sku: 'SKU-002', price: '450.00', subcategory: 'Iron Sets' }),
      validRow({ title: 'Callaway Rogue ST', sku: 'SKU-003', price: '199.00', subcategory: 'Fairway Woods' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    expect(rows).toHaveLength(3);
    expect(failed).toHaveLength(0);

    const result = await importListings(rows, SELLER_ID, failed, warnings);
    expect(result.created).toHaveLength(3);
    expect(result.failed).toHaveLength(0);

    for (const listing of createdListings) {
      expect(listing.status).toBe('draft');
      expect(listing.external_source).toBe('csv');
      expect(listing.external_id).toBeTruthy();
      expect(listing.seller_id).toBe(SELLER_ID);
    }
  });

  // ── Test 2: Re-run same CSV → duplicates (mock-level) ──────────────
  // The Prisma mock simulates the dedup P2002. This tests the service's
  // duplicate-handling branch, NOT the real DB index. The real proof is
  // a dev re-import (see questions.md "Dev re-import verification").

  test('2. re-run same CSV → service surfaces duplicate reason (mock-level; real index proven on dev)', async () => {
    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DUP' }));
    const parsed = parseCsv(buf);
    await importListings(parsed.rows, SELLER_ID, parsed.failed, parsed.warnings);
    expect(createdListings).toHaveLength(1);

    const parsed2 = parseCsv(buf);
    const result2 = await importListings(parsed2.rows, SELLER_ID, parsed2.failed, parsed2.warnings);
    expect(result2.created).toHaveLength(0);
    expect(result2.failed).toHaveLength(1);
    expect(result2.failed[0].reason).toBe('duplicate');
  });

  // ── Test 3: Unknown category → row fails, others succeed ─────────────

  test('3. unknown category → that row fails, rest succeed', async () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'CAT-GOOD' }),
      validRow({ sku: 'CAT-BAD', category: 'Golf Carts', title: 'Bad Category Item' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    expect(rows).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain('unknown category');

    const result = await importListings(rows, SELLER_ID, failed, warnings);
    expect(result.created).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  // ── Test 4: Missing required fields → rows fail ───────────────────────

  test('4. missing title/price/subcategory/parcel_size/shipping_cost → row fails', async () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ title: '', sku: 'M1' }),
      validRow({ price: '', sku: 'M2' }),
      validRow({ subcategory: '', sku: 'M3' }),
      validRow({ parcel_size: '', sku: 'M4' }),
      validRow({ shipping_cost: '', sku: 'M5' }),
      validRow({ sku: 'M-GOOD' }),
    );
    const { rows, failed } = parseCsv(buf);
    expect(failed.length).toBeGreaterThanOrEqual(5);
    expect(rows).toHaveLength(1);

    const result = await importListings(rows, SELLER_ID, failed, []);
    expect(result.created).toHaveLength(1);
    expect(result.failed.length).toBeGreaterThanOrEqual(5);
  });

  // ── Test 5: CSV > 200 rows → rejected (tested at controller level via row count) ─

  test('5. parseCsv handles 201 rows (controller enforces the cap)', () => {
    const rowLines = Array.from({ length: 201 }, (_, i) =>
      validRow({ sku: `BULK-${i}`, title: `Item ${i}` }),
    );
    const buf = csvBuffer(HEADERS, ...rowLines);
    const { rows, failed } = parseCsv(buf);
    expect(rows.length + failed.length).toBe(201);
  });

  // ── Test 6: parcel_size normalization ─────────────────────────────────

  test('6. parcel_size normalization: Small→small, Extra Large→extra_large', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ parcel_size: 'Small', sku: 'PS1' }),
      validRow({ parcel_size: 'Extra Large', sku: 'PS2' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].parcel_size).toBe('small');
    expect(rows[1].parcel_size).toBe('extra_large');
  });

  // ── Test 7: category normalization ────────────────────────────────────

  test('7. category normalization: Shafts Grips & Heads → Shafts, Grips & Heads', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ category: 'Shafts Grips & Heads', sku: 'CN1' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].category).toBe('Shafts, Grips & Heads');
  });

  // ── Test 8: shipping_cost from row, not overwritten ───────────────────

  test('8. shipping_cost read from CSV row, not overwritten', async () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ shipping_cost: '7.50', sku: 'SC1' }),
      validRow({ shipping_cost: '12.99', sku: 'SC2' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    expect(rows[0].shipping_cost).toBe(7.50);
    expect(rows[1].shipping_cost).toBe(12.99);

    const result = await importListings(rows, SELLER_ID, failed, warnings);
    expect(createdListings[0].shipping_cost).toBe(7.50);
    expect(createdListings[1].shipping_cost).toBe(12.99);
  });

  // ── Test 9: condition mapping ─────────────────────────────────────────

  test('9. condition mapping: Like New → condition_overall: 4', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ condition: 'Like New', sku: 'COND1' }),
      validRow({ condition: 'Fair', sku: 'COND2' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].condition_overall).toBe(4);
    expect(rows[1].condition_overall).toBe(1);
  });

  // ── Test 10: sku → external_id; absent sku → content hash (stable) ───

  test('10. sku present → external_id equals sku; absent → stable content hash', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'MY-SKU-123' }),
      validRow({ sku: '', title: 'Hashable Item', brand: 'Ping', model: 'G430', category: 'Clubs', price: '300.00' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].external_id).toBe('MY-SKU-123');

    const expectedHash = crypto.createHash('sha256')
      .update('hashable item|ping|g430|clubs|300')
      .digest('hex')
      .slice(0, 16);
    expect(rows[1].external_id).toBe(expectedHash);

    // Stable: re-parse produces the same hash
    const { rows: rows2 } = parseCsv(buf);
    expect(rows2[1].external_id).toBe(expectedHash);
  });

  // ── Test 11: drafted listings don't appear in public search query ─────

  test('11. drafted listings created → status is draft (I-01 guarantees public exclusion)', async () => {
    const buf = csvBuffer(HEADERS, validRow({ sku: 'DRAFT-CHECK' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);
    expect(result.created).toHaveLength(1);
    expect(createdListings[0].status).toBe('draft');
    // I-01's getAllListings already filters status:'active', so drafts are excluded.
    // The draftVisibility test suite (I-01a) proves this end-to-end.
  });

  // ── Additional: specs assembled correctly ─────────────────────────────

  test('spec fields assembled into specifications JSON', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ club_type: 'Driver', shaft_flex: 'Regular', sku: 'SPEC1' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].specifications).toEqual({ club_type: 'Driver', shaft_flex: 'Regular' });
  });

  test('accepts_offers → is_negotiable boolean', () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ accepts_offers: 'true', sku: 'NEG1' }),
      validRow({ accepts_offers: 'false', sku: 'NEG2' }),
    );
    const { rows } = parseCsv(buf);
    expect(rows[0].is_negotiable).toBe(true);
    expect(rows[1].is_negotiable).toBe(false);
  });

  // ── Test 14: All IDs are valid UUIDs and unique ───────────────────────

  test('14. listing and attribute IDs are distinct valid UUIDs', async () => {
    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'UUID-1', club_type: 'Driver', shaft_flex: 'Stiff' }),
      validRow({ sku: 'UUID-2', club_type: 'Iron', shaft_flex: 'Regular' }),
      validRow({ sku: 'UUID-3', club_type: 'Wedge' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);
    expect(result.created).toHaveLength(3);

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const listingIds = createdListings.map(l => l.id);
    for (const id of listingIds) {
      expect(id).toMatch(uuidRe);
    }
    expect(new Set(listingIds).size).toBe(listingIds.length);

    const attrIds = createdAttributes.map(a => a.id);
    for (const id of attrIds) {
      expect(id).toMatch(uuidRe);
    }
    const allIds = [...listingIds, ...attrIds];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  // ── Test 15: PK-collision P2002 is NOT labelled 'duplicate' ───────────

  test('15. PK-collision P2002 (non-dedup target) → distinct reason, not duplicate', async () => {
    const { prisma } = require('../../lib/prisma');
    const originalCreate = prisma.listings.create;

    // Simulate a PK collision on the first create call
    prisma.listings.create = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), {
        code: 'P2002',
        meta: { target: ['listings_pkey'] },
      }),
    );

    const buf = csvBuffer(HEADERS, validRow({ sku: 'PK-COLLIDE' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).not.toBe('duplicate');
    expect(result.failed[0].reason).toContain('id collision');
    expect(result.failed[0].reason).toContain('listings_pkey');

    // Restore
    prisma.listings.create = originalCreate;
  });
});
