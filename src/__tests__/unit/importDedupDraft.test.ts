import { createListingSchema, updateListingSchema } from '../../middleware/validation';
import { validateListingForCart, validateCheckout } from '../../lib/cartValidation';
import { makeListing, makeCartItem, hoursAgo } from '../helpers/mockFactories';

const NOW = new Date('2026-06-23T10:00:00Z');

// ─── 1-3: CREATE SCHEMA — status field ─────────────────────────────────

describe('createListingSchema — status field', () => {
  const BASE = {
    title: 'TaylorMade Stealth 2 Driver',
    description: 'Excellent condition, barely used on course.',
    price: 249.99,
    category: 'Clubs',
    subcategory: 'Drivers',
    location: 'UK',
    parcel_size: 'large',
    shipping_cost: 6.99,
  };

  test('status: "draft" → stored as "draft"', () => {
    const result = createListingSchema.parse({ body: { ...BASE, status: 'draft' } });
    expect(result.body.status).toBe('draft');
  });

  test('no status → defaults to "active"', () => {
    const result = createListingSchema.parse({ body: { ...BASE } });
    expect(result.body.status).toBe('active');
  });

  test('status: "active" → "active"', () => {
    const result = createListingSchema.parse({ body: { ...BASE, status: 'active' } });
    expect(result.body.status).toBe('active');
  });

  test('status: "sold" → rejected on create (not in create enum)', () => {
    expect(() =>
      createListingSchema.parse({ body: { ...BASE, status: 'sold' } })
    ).toThrow();
  });

  test('status: "sold_elsewhere" → rejected (not in this slice)', () => {
    expect(() =>
      createListingSchema.parse({ body: { ...BASE, status: 'sold_elsewhere' } })
    ).toThrow();
  });
});

// ─── UPDATE SCHEMA — draft in enum ──────────────────────────────────────

describe('updateListingSchema — draft in status enum', () => {
  test('"draft" accepted in update', () => {
    const result = updateListingSchema.parse({
      body: { status: 'draft' },
      params: { id: 'lst_123' },
    });
    expect(result.body.status).toBe('draft');
  });

  test('"active" still accepted in update', () => {
    const result = updateListingSchema.parse({
      body: { status: 'active' },
      params: { id: 'lst_123' },
    });
    expect(result.body.status).toBe('active');
  });
});

// ─── 4-5: DEDUP UNIQUE INDEX (schema-level — tested via SQL shape) ──────

describe('dedup fields — migration SQL shape', () => {
  const fs = require('fs');
  const path = require('path');
  const migrationPath = path.join(
    __dirname, '..', '..', '..', 'prisma', 'migrations',
    '20260623000000_listing_import_dedup', 'migration.sql'
  );

  let sql: string;
  beforeAll(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
  });

  test('adds external_source column', () => {
    expect(sql).toContain('ADD COLUMN "external_source" TEXT');
  });

  test('adds external_id column', () => {
    expect(sql).toContain('ADD COLUMN "external_id" TEXT');
  });

  test('creates partial unique index on (seller_id, external_source, external_id)', () => {
    expect(sql).toContain('"seller_id", "external_source", "external_id"');
    expect(sql).toContain('WHERE "external_source" IS NOT NULL');
    expect(sql).toContain('UNIQUE INDEX');
  });
});

// ─── 6: DRAFT EXCLUDED FROM CART VALIDATION (reuses the real predicate) ─

describe('validateListingForCart — draft listing rejected', () => {
  test('draft listing → listing_inactive', () => {
    const listing = makeListing({ status: 'draft', quantity: 5, seller_id: 'seller-1' });
    const result = validateListingForCart(listing, 'buyer-1', 1);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('listing_inactive');
  });

  test('active listing → valid (baseline)', () => {
    const listing = makeListing({ status: 'active', quantity: 5, seller_id: 'seller-1' });
    const result = validateListingForCart(listing, 'buyer-1', 1);
    expect(result.valid).toBe(true);
  });
});

// ─── 7: CHECKOUT VALIDATION — draft listing blocked ─────────────────────

describe('validateCheckout — draft listing blocked before payment', () => {
  test('cart with draft listing → unavailable, not proceedable', () => {
    const draftListing = makeListing({ status: 'draft', quantity: 1, seller_id: 'seller-1' });
    const cartItem = makeCartItem({ listing_id: draftListing.id, user_id: 'buyer-1', created_at: hoursAgo(1, NOW) });
    const report = validateCheckout(
      [{ cartItem, listing: draftListing }],
      'buyer-1',
      NOW,
    );
    expect(report.proceedable).toBe(false);
    expect(report.unavailable).toContain(draftListing.id);
  });

  test('cart with active listing → proceedable (baseline)', () => {
    const activeListing = makeListing({ status: 'active', quantity: 1, seller_id: 'seller-1' });
    const cartItem = makeCartItem({ listing_id: activeListing.id, user_id: 'buyer-1', created_at: hoursAgo(1, NOW) });
    const report = validateCheckout(
      [{ cartItem, listing: activeListing }],
      'buyer-1',
      NOW,
    );
    expect(report.proceedable).toBe(true);
  });

  test('mixed cart: one active + one draft → not proceedable', () => {
    const active = makeListing({ status: 'active', quantity: 1, seller_id: 'seller-1' });
    const draft = makeListing({ status: 'draft', quantity: 1, seller_id: 'seller-1' });
    const report = validateCheckout(
      [
        { cartItem: makeCartItem({ listing_id: active.id, user_id: 'buyer-1', created_at: hoursAgo(1, NOW) }), listing: active },
        { cartItem: makeCartItem({ listing_id: draft.id, user_id: 'buyer-1', created_at: hoursAgo(1, NOW) }), listing: draft },
      ],
      'buyer-1',
      NOW,
    );
    expect(report.proceedable).toBe(false);
    expect(report.unavailable).toContain(draft.id);
    expect(report.unavailable).not.toContain(active.id);
  });
});
