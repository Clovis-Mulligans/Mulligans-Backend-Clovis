import { parseCsv } from '../../services/csvAdapter';

let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => {
    uuidCounter++;
    const hex = uuidCounter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-a000-${hex}`;
  },
}));

const mockExpireOffers = jest.fn().mockResolvedValue(0);
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: (...args: any[]) => mockExpireOffers(...args),
}));

const mockSellerIsPayoutReady = jest.fn();
jest.mock('../../lib/payoutReadiness', () => ({
  sellerIsPayoutReady: (...args: any[]) => mockSellerIsPayoutReady(...args),
}));

// ── Prisma mock ─────────────────────────────────────────────────────────

const mockListings: Record<string, any> = {};
const mockOrdersData: Record<string, any> = {};
const createdAttributes: any[] = [];

const mockListingsModel = {
  findFirst: jest.fn(({ where }: any) => {
    const match = Object.values(mockListings).find(
      (l: any) =>
        l.seller_id === where.seller_id &&
        l.external_source === where.external_source &&
        l.external_id === where.external_id,
    );
    if (match) {
      return Promise.resolve({ ...match, images: match._images || [] });
    }
    if (where.listing_id) {
      const order = mockOrdersData[where.listing_id];
      return Promise.resolve(order ?? null);
    }
    return Promise.resolve(null);
  }),
  create: jest.fn(({ data }: any) => {
    mockListings[data.id] = { ...data, _images: [] };
    return Promise.resolve(data);
  }),
  update: jest.fn(({ where, data }: any) => {
    const listing = mockListings[where.id];
    if (!listing) return Promise.resolve(null);
    const updated = { ...listing, ...data };
    mockListings[where.id] = updated;
    return Promise.resolve(updated);
  }),
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

jest.mock('../../lib/prisma', () => ({
  prisma: {
    listings: mockListingsModel,
    orders: mockOrdersModel,
    cart_items: mockCartItemsModel,
    listing_attributes: {
      createMany: jest.fn(({ data }: any) => {
        createdAttributes.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { importListings } from '../../services/importService';

// ── Helpers ─────────────────────────────────────────────────────────────

const SELLER_ID = 'seller-1';
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
    club_type: '',
    shaft_flex: '',
  };
  const merged = { ...defaults, ...overrides };
  return Object.values(merged).join(',');
}

function csvBuffer(headers: string, ...rows: string[]): Buffer {
  return Buffer.from([headers, ...rows].join('\n'));
}

function seedListing(overrides: Partial<any> = {}): any {
  const id = overrides.id || `lst-${uuidCounter++}`;
  const listing = {
    id,
    seller_id: SELLER_ID,
    title: 'TaylorMade Stealth 2 Driver',
    description: 'Excellent driver in great condition with headcover',
    price: 249.99,
    category: 'Clubs',
    subcategory: 'Drivers',
    brand: 'TaylorMade',
    model: 'Stealth 2',
    condition_overall: 4,
    location: 'UK',
    is_negotiable: true,
    parcel_size: 'large',
    shipping_cost: 7.50,
    quantity: 1,
    status: 'active',
    external_source: 'csv',
    external_id: 'SKU-001',
    qty_at_last_import: 1,
    last_imported_at: new Date('2026-06-30'),
    specifications: null,
    created_at: new Date('2026-06-30'),
    updated_at: new Date('2026-06-30'),
    _images: [],
    ...overrides,
  };
  mockListings[listing.id] = listing;
  return listing;
}

beforeEach(() => {
  for (const key of Object.keys(mockListings)) delete mockListings[key];
  for (const key of Object.keys(mockOrdersData)) delete mockOrdersData[key];
  createdAttributes.length = 0;
  uuidCounter = 0;
  mockSellerIsPayoutReady.mockReset();
  mockSellerIsPayoutReady.mockResolvedValue({ ready: true });
  mockExpireOffers.mockClear();
  jest.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('importService — upsert (I-06)', () => {

  // 1. I-02c worked example verbatim
  test('1. delta reconciliation: import 5, sell 2, return 1, CSV says 4 → result 3', async () => {
    seedListing({
      id: 'lst-delta',
      external_id: 'SKU-DELTA',
      quantity: 4,
      qty_at_last_import: 5,
      status: 'active',
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DELTA', quantity: '4' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.created).toHaveLength(0);

    const updatedListing = mockListings['lst-delta'];
    expect(updatedListing.quantity).toBe(3);
    expect(updatedListing.qty_at_last_import).toBe(4);
  });

  // 2. MAX(0) clamp: consumed exceeds CSV qty → 0 → off_sale fires
  test('2. MAX(0) clamp: consumed exceeds CSV qty → qty 0 → off_sale transition', async () => {
    seedListing({
      id: 'lst-clamp',
      external_id: 'SKU-CLAMP',
      quantity: 0,
      qty_at_last_import: 3,
      status: 'active',
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-CLAMP', quantity: '1' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    const updatedListing = mockListings['lst-clamp'];
    expect(updatedListing.quantity).toBe(0);
    expect(updatedListing.status).toBe('off_sale');

    expect(mockExpireOffers).toHaveBeenCalledWith('lst-clamp');
    expect(mockCartItemsModel.deleteMany).toHaveBeenCalledWith({ where: { listing_id: 'lst-clamp' } });
  });

  // 3. Active-order row: NOTHING mutates
  test('3. active-order listing → skipped, nothing mutated', async () => {
    const original = seedListing({
      id: 'lst-order',
      external_id: 'SKU-ORDER',
      quantity: 5,
      qty_at_last_import: 5,
      price: 249.99,
      title: 'Original Title',
      status: 'active',
    });

    mockOrdersData['lst-order'] = { id: 'ord-1', status: 'to_ship' };

    const buf = csvBuffer(HEADERS, validRow({
      sku: 'SKU-ORDER',
      quantity: '10',
      price: '999.99',
      title: 'Changed Title',
    }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('active_order');
    expect(result.updated).toHaveLength(0);

    const listing = mockListings['lst-order'];
    expect(listing.quantity).toBe(5);
    expect(listing.qty_at_last_import).toBe(5);
    expect(listing.title).toBe('Original Title');
    expect(listing.price).toBe(249.99);
  });

  // 4. removed skip
  test('4. removed listing → skipped with reason "removed"', async () => {
    seedListing({
      id: 'lst-removed',
      external_id: 'SKU-REMOVED',
      status: 'removed',
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-REMOVED' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('removed');
    expect(result.updated).toHaveLength(0);
  });

  // 5. deleted reactivation (gates pass) → active
  test('5. deleted listing (gates pass, qty >= 1) → reactivated to active', async () => {
    seedListing({
      id: 'lst-deleted-pass',
      external_id: 'SKU-DEL-PASS',
      status: 'deleted',
      quantity: 0,
      qty_at_last_import: null,
      _images: [{ id: 'img-1' }],
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: true });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DEL-PASS', quantity: '3' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-deleted-pass'];
    expect(listing.status).toBe('active');
    expect(listing.quantity).toBe(3);
  });

  // 6. deleted reactivation (gates fail) → draft
  test('6. deleted listing (payout not ready) → reactivated to draft', async () => {
    seedListing({
      id: 'lst-deleted-fail',
      external_id: 'SKU-DEL-FAIL',
      status: 'deleted',
      quantity: 0,
      qty_at_last_import: null,
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: false, reason: 'payout_not_ready' });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DEL-FAIL', quantity: '3' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-deleted-fail'];
    expect(listing.status).toBe('draft');
  });

  // 7. off_sale restock (gates pass) → active
  test('7. off_sale listing + qty >= 1 + gates pass → reactivated to active', async () => {
    seedListing({
      id: 'lst-offsale-pass',
      external_id: 'SKU-OFF-PASS',
      status: 'off_sale',
      quantity: 0,
      qty_at_last_import: 3,
      _images: [{ id: 'img-1' }],
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: true });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-OFF-PASS', quantity: '5' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-offsale-pass'];
    expect(listing.status).toBe('active');
    expect(listing.quantity).toBe(2);
  });

  // 8. off_sale restock (gates fail) → stays off_sale + warning
  test('8. off_sale listing + qty >= 1 + payout not ready → stays off_sale + restock_blocked warning', async () => {
    seedListing({
      id: 'lst-offsale-fail',
      external_id: 'SKU-OFF-FAIL',
      status: 'off_sale',
      quantity: 0,
      qty_at_last_import: 3,
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: false, reason: 'payout_not_ready' });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-OFF-FAIL', quantity: '5' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBeFalsy();

    const listing = mockListings['lst-offsale-fail'];
    expect(listing.status).toBe('off_sale');

    expect(result.warnings.some((w: string) => w.includes('restock_blocked'))).toBe(true);
  });

  // 9. sold restock (gates pass) → active
  test('9. sold listing + restocked qty → reactivated to active', async () => {
    seedListing({
      id: 'lst-sold-restock',
      external_id: 'SKU-SOLD',
      status: 'sold',
      quantity: 0,
      qty_at_last_import: 2,
      _images: [{ id: 'img-1' }],
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: true });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-SOLD', quantity: '5' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-sold-restock'];
    expect(listing.status).toBe('active');
    expect(listing.quantity).toBe(3);
  });

  // 10. NULL-anchor first touch → csv_qty verbatim
  test('10. NULL anchor (first touch) → csv_qty verbatim, units_consumed=0', async () => {
    seedListing({
      id: 'lst-null-anchor',
      external_id: 'SKU-NULL',
      quantity: 7,
      qty_at_last_import: null,
      status: 'active',
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-NULL', quantity: '10' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);

    const listing = mockListings['lst-null-anchor'];
    expect(listing.quantity).toBe(10);
    expect(listing.qty_at_last_import).toBe(10);
  });

  // 11. Full re-sync: changed fields reported, price warning present
  test('11. full re-sync: changed fields tracked, price change warning emitted', async () => {
    seedListing({
      id: 'lst-resync',
      external_id: 'SKU-RESYNC',
      title: 'Old Title',
      price: 100.00,
      description: 'Old description text here',
      quantity: 5,
      qty_at_last_import: 5,
      status: 'active',
    });

    const buf = csvBuffer(HEADERS, validRow({
      sku: 'SKU-RESYNC',
      title: 'New Title Updated',
      price: '199.99',
      quantity: '5',
    }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].changed_fields).toContain('title');
    expect(result.updated[0].changed_fields).toContain('price');

    expect(result.warnings.some((w: string) => w.includes('price changed'))).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('100') && w.includes('199.99'))).toBe(true);
  });

  // 12. Anchors stamped on create
  test('12. create path stamps qty_at_last_import + last_imported_at', async () => {
    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-NEW-ANCHOR', quantity: '7' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.created).toHaveLength(1);

    const created = mockListings[result.created[0].id];
    expect(created.qty_at_last_import).toBe(7);
    expect(created.last_imported_at).toBeInstanceOf(Date);
  });

  // 13. Anchors stamped on update, NOT on skip
  test('13. anchors stamped on update; active-order skip preserves existing anchors', async () => {
    const originalImportDate = new Date('2026-06-28');
    seedListing({
      id: 'lst-skip-anchor',
      external_id: 'SKU-SKIP-ANC',
      quantity: 5,
      qty_at_last_import: 5,
      last_imported_at: originalImportDate,
      status: 'active',
    });

    mockOrdersData['lst-skip-anchor'] = { id: 'ord-skip', status: 'paid' };

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-SKIP-ANC', quantity: '10' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.skipped).toHaveLength(1);

    const listing = mockListings['lst-skip-anchor'];
    expect(listing.qty_at_last_import).toBe(5);
    expect(listing.last_imported_at).toEqual(originalImportDate);
  });

  // 14. Create-path regression
  test('14. new rows still create as draft with anchors', async () => {
    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-CREATE-REG' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.created).toHaveLength(1);
    expect(result.updated).toHaveLength(0);

    const created = mockListings[result.created[0].id];
    expect(created.status).toBe('draft');
    expect(created.external_source).toBe('csv');
    expect(created.external_id).toBe('SKU-CREATE-REG');
    expect(created.seller_id).toBe(SELLER_ID);
  });

  // 15. Same batch: one create + one update
  test('15. mixed batch: new row creates, existing row updates', async () => {
    seedListing({
      id: 'lst-mix-existing',
      external_id: 'SKU-EXISTING',
      quantity: 3,
      qty_at_last_import: 3,
      status: 'active',
    });

    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'SKU-EXISTING', quantity: '5' }),
      validRow({ sku: 'SKU-BRAND-NEW', title: 'Brand New Club' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].external_id).toBe('SKU-EXISTING');
    expect(result.created).toHaveLength(1);
    expect(result.created[0].external_id).toBe('SKU-BRAND-NEW');
  });

  // 16. off_sale side-effects: carts cleared, offers expired
  test('16. active→off_sale transition clears carts and expires offers', async () => {
    seedListing({
      id: 'lst-side-effects',
      external_id: 'SKU-SIDE',
      quantity: 1,
      qty_at_last_import: 3,
      status: 'active',
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-SIDE', quantity: '1' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    const listing = mockListings['lst-side-effects'];
    expect(listing.status).toBe('off_sale');
    expect(listing.quantity).toBe(0);

    expect(mockExpireOffers).toHaveBeenCalledWith('lst-side-effects');
    expect(mockCartItemsModel.deleteMany).toHaveBeenCalledWith({ where: { listing_id: 'lst-side-effects' } });
  });

  // 17. Payout readiness cached (checked once per run)
  test('17. payout readiness checked once per import run, not per row', async () => {
    seedListing({
      id: 'lst-cache-1',
      external_id: 'SKU-CACHE-1',
      status: 'off_sale',
      quantity: 0,
      qty_at_last_import: 2,
      _images: [{ id: 'img-1' }],
    });
    seedListing({
      id: 'lst-cache-2',
      external_id: 'SKU-CACHE-2',
      status: 'sold',
      quantity: 0,
      qty_at_last_import: 2,
      _images: [{ id: 'img-2' }],
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: true });

    const buf = csvBuffer(
      HEADERS,
      validRow({ sku: 'SKU-CACHE-1', quantity: '5' }),
      validRow({ sku: 'SKU-CACHE-2', quantity: '3', title: 'Another Club Item Here' }),
    );
    const { rows, failed, warnings } = parseCsv(buf);
    await importListings(rows, SELLER_ID, failed, warnings);

    expect(mockSellerIsPayoutReady).toHaveBeenCalledTimes(1);
  });

  // 18. sold restock (gates fail) → stays sold + warning
  test('18. sold listing + payout not ready → stays sold + restock_blocked warning', async () => {
    seedListing({
      id: 'lst-sold-fail',
      external_id: 'SKU-SOLD-FAIL',
      status: 'sold',
      quantity: 0,
      qty_at_last_import: 2,
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: false, reason: 'payout_not_ready' });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-SOLD-FAIL', quantity: '5' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBeFalsy();

    const listing = mockListings['lst-sold-fail'];
    expect(listing.status).toBe('sold');

    expect(result.warnings.some((w: string) => w.includes('restock_blocked'))).toBe(true);
  });

  // 19. draft stays draft — fields + qty updated
  test('19. draft listing stays draft, fields and quantity updated', async () => {
    seedListing({
      id: 'lst-draft',
      external_id: 'SKU-DRAFT',
      status: 'draft',
      quantity: 1,
      qty_at_last_import: 1,
      title: 'Draft Item',
      price: 50.00,
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DRAFT', quantity: '3', price: '99.99' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);

    const listing = mockListings['lst-draft'];
    expect(listing.status).toBe('draft');
    expect(listing.quantity).toBe(3);
    expect(listing.price).toBe(99.99);
  });

  // 20. deleted + consumed yields qty 0 → draft
  test('20. deleted listing + reconciled qty 0 → reactivated to draft', async () => {
    seedListing({
      id: 'lst-deleted-zero',
      external_id: 'SKU-DEL-ZERO',
      status: 'deleted',
      quantity: 0,
      qty_at_last_import: 3,
    });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DEL-ZERO', quantity: '2' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-deleted-zero'];
    expect(listing.status).toBe('draft');
    expect(listing.quantity).toBe(0);
  });

  // 21. deleted + no images → draft even if payout ready
  test('21. deleted listing + no images → reactivated to draft (completeness gate fails)', async () => {
    seedListing({
      id: 'lst-deleted-noimg',
      external_id: 'SKU-DEL-NOIMG',
      status: 'deleted',
      quantity: 0,
      qty_at_last_import: null,
      _images: [],
    });

    mockSellerIsPayoutReady.mockResolvedValue({ ready: true });

    const buf = csvBuffer(HEADERS, validRow({ sku: 'SKU-DEL-NOIMG', quantity: '3' }));
    const { rows, failed, warnings } = parseCsv(buf);
    const result = await importListings(rows, SELLER_ID, failed, warnings);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].reactivated).toBe(true);

    const listing = mockListings['lst-deleted-noimg'];
    expect(listing.status).toBe('draft');
  });
});
