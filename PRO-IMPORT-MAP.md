# PRO-IMPORT-MAP — Import Pipeline Surface (Live Confirmed)

**Date:** 2026-06-22
**Backend SHA:** `dc3891965d4925939175e5ce8cab63af63b0e30b` (clovis/pro-seller-foundation)
**Web SHA:** `9245a34ddad0dc53417be4b44322d5f82b41a762` (clovis/pro-seller-foundation)

---

## A. Listing Creation Seam

**CONFIRMED** — `POST /api/listings` create handler.

| Item | Live location | Status vs PRO-01 |
|------|--------------|-------------------|
| Route | `listingRoutes.ts:35` | CONFIRMED |
| Handler | `listingController.ts:154-303` | CONFIRMED |
| Zod schema | `validation.ts:41-70` | CONFIRMED (PRO-01 cited `:42-57` — off by a few lines) |
| Category enum | `validation.ts:46-55` — **8 values** | **DIFFERS-FROM-PRO-01** (see below) |

**Middleware chain:** `authenticateToken` → `listingLimiter` (50 req/hr) → `validate(createListingSchema)` → `ListingController.createListing`

### Zod `createListingSchema` — full contract

| Field | Type | Required? | Constraints |
|-------|------|-----------|-------------|
| `title` | string | Yes | min 3, max 200 |
| `description` | string | Yes | min 10, max 5000 |
| `price` | number | Yes | min 0.50, max 50000 |
| `category` | enum | Yes | 8 values (see below) |
| `subcategory` | string | Yes | min 1, max 100 |
| `location` | string | Yes (Zod) | min 1, max 200; defaults to `'UK'` in controller |
| `brand` | string | No | max 100, optional/nullable |
| `model` | string | No | max 100, optional/nullable |
| `is_negotiable` | boolean | No | defaults to `false` in controller |
| `parcel_size` | enum | Yes | `'small'`, `'medium'`, `'large'`, `'extra_large'`, `'oversized'` |
| `shipping_cost` | number | Yes | min 0, max 100 |
| `quantity` | int | No | min 1, max 999, default 1 |
| `condition_overall` | int | No | 1-5 |
| `condition_head` | int | No | 1-5 |
| `condition_shaft` | int | No | 1-5 |
| `condition_grip` | int | No | 1-5 |
| `specifications` | Record<string, any> | No | — |

**NOT in Zod but used by controller:** `ball_condition_type` — destructured from `req.body` at line 176, written to DB at line 225. Passes through UNVALIDATED.

**NOT accepted at all:** `status` — not in Zod, not destructured. Hardcoded to `'active'` at line 234.

### **DIFFERS-FROM-PRO-01: Category Enum**

**Live backend (validation.ts:46-55) — 8 values:**
1. `'Clubs'`
2. `'Shafts, Grips & Heads'` ← note the COMMA
3. `'Clothing'`
4. `'Shoes'`
5. `'Accessories'`
6. `'Balls'`
7. `'Training Aids'`
8. `'Everything Else'`

PRO-01 listed 7 categories and did not include "Everything Else" or "Shafts, Grips & Heads" — the live enum has BOTH, totalling 8.

### **DIFFERS-FROM-PRO-01: Category Mismatch Web ↔ Backend**

The web dashboard wizard (`import/page.tsx:27-36`) defines `VALID_CATEGORIES` with `'Shafts Grips & Heads'` (NO comma). The backend Zod enum has `'Shafts, Grips & Heads'` (WITH comma). **A CSV import with this category would pass web validation but FAIL backend Zod validation.** This is a latent bug.

### Status on create

```ts
// listingController.ts:234
status: 'active',
```

Hardcoded. `'draft'` is NOT an accepted status on the create path. The web `CreateListingData` type includes `status?: 'active' | 'draft'` (api-client `listings.ts:50`) and the wizard sends `status: 'draft'` at line 611, but **the backend ignores it** — every listing goes live as `'active'` immediately. This is a silent bug: the wizard believes it can create drafts, but cannot.

**Update schema (validation.ts:91):** `z.enum(['active', 'sold', 'reserved', 'removed']).optional()` — `'draft'` not included here either. To support draft listings, both create and update schemas need amendment.

### Image attachment — separate call

Images are NOT part of the create request. After creating a listing, the client makes a separate call:

```
POST /api/listings/:id/images  (multipart, field: 'images', max 5 files)
```

**Route:** `listingRoutes.ts:38-43` — uses `multer.memoryStorage()`, max 5 files.
**Handler:** `listingController.ts:309-410` — ownership check at line 325.
**Import reuse:** The import pipeline's image-from-URL step must produce a Buffer and filename, then call the same sharp→S3 path (or `S3Service.uploadImage` directly).

---

## B. Image Hosting Seam (and Security)

**CONFIRMED** — `listingController.ts:339-410`, `s3Service.ts`.

### Sharp pipeline (listingController.ts:353-363)

```ts
sharp(file.buffer)
  .rotate()                          // EXIF auto-rotate
  .resize(2000, 2000, {              // max 2000x2000
    fit: 'inside',
    withoutEnlargement: true          // don't upscale
  })
  .jpeg({ quality: 85, progressive: true })
  .toBuffer();
```

Extension rename: `.heic`, `.heif`, `.png`, `.webp` → `.jpg` (line 366).
Fallback: if sharp fails, uses original buffer (line 372-374).

### S3Service.uploadImage signature (s3Service.ts:31-51)

```ts
static async uploadImage(
  file: Buffer,
  mimetype: string,
  originalName: string
): Promise<{ url: string; key: string }>
```

Key: `listings/${uuid}.${extension}` (auto-generated from originalName).
ContentType: set from `mimetype` parameter.

### **PRE-EXISTING BUG: S3 ContentType corrupted**

The controller calls `S3Service.uploadImage` at lines 378-382:
```ts
S3Service.uploadImage(
  processedBuffer,
  `listings/${id}`,   // ← this is the MIMETYPE parameter!
  finalFilename
);
```

The second argument is `listings/${id}` (e.g. `"listings/lst_17190..."`) passed as `mimetype`. S3 stores these objects with `ContentType: "listings/lst_..."` instead of `"image/jpeg"`. Images serve correctly because CloudFront/browsers sniff content type, but the S3 metadata is wrong. **Not blocking for import, but should be fixed.**

### Where image-URL fetch slots in

The import pipeline needs a function that:
1. Fetches image bytes from a URL (SSRF-hardened — see below)
2. Produces a `Buffer` + a filename (e.g. `"imported_1.jpg"`)
3. Feeds into the SAME sharp pipeline at line 353 (or calls `S3Service.uploadImage` directly with the processed buffer)

No new sharp config needed — the existing pipeline handles HEIC, PNG, WEBP → JPG conversion.

### SSRF — existing utilities

**There is NO existing URL-fetch utility in the codebase.** No `axios`, `node-fetch`, or `got` dependencies. The backend uses Node 20's built-in `fetch()` in a few places (SES SNS confirmation, Shippo, Meta CAPI, Expo Push) — all with hardcoded/env-controlled URLs, none user-supplied.

**No existing SSRF hardening:** No URL allowlist, no IP blocklist, no private-range check, no timeout utility.

**Net-new for I-03:**
- Scheme allowlist: `https://` only
- IP range blocklist: `169.254.0.0/16` (link-local/metadata), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `::1`, `fc00::/7`
- DNS resolution check BEFORE fetch (resolve hostname, check IP against blocklist)
- Max response size cap (e.g. 10MB)
- Content-type check (`image/jpeg`, `image/png`, `image/webp`, `image/heic`)
- Fetch timeout (e.g. 15s)
- Redirect limit (max 3, re-check each redirect target)

---

## C. Live Schema for `listings`

**File:** `prisma/schema.prisma:76-126`

```prisma
model listings {
  id                  String               @id
  seller_id           String
  title               String
  description         String?
  category            String
  brand               String?
  model               String?
  price               Decimal              @db.Decimal(10, 2)
  original_price      Decimal?             @db.Decimal(10, 2)
  currency            String               @default("GBP")
  status              String               @default("active")
  location            String?
  is_featured         Boolean              @default(false)
  is_negotiable       Boolean              @default(true)
  views               Int                  @default(0)
  favorites_count     Int                  @default(0)
  created_at          DateTime             @default(now())
  updated_at          DateTime
  ball_condition_type String?
  condition_grip      Int?
  condition_head      Int?
  condition_overall   Int?
  condition_shaft     Int?
  subcategory         String?
  specifications      Json?
  parcel_size         String?
  shipping_cost       Decimal?             @db.Decimal(10, 2)
  quantity            Int                  @default(1)
  deleted_at          DateTime?
  // ... relations ...
}
```

**Confirmed:**
- `external_source` — **ABSENT** (net-new)
- `external_id` — **ABSENT** (net-new)
- `quantity` — present, `Int @default(1)` ✓
- `specifications` — present, `Json?` ✓
- `parcel_size` — present, `String?` ✓
- `shipping_cost` — present, `Decimal? @db.Decimal(10, 2)` ✓
- `status` — present, `String @default("active")` — no DB-level enum constraint

### Distinct `status` values in use

| Status | Where set | Context |
|--------|----------|---------|
| `'active'` | `listingController.ts:234` | On create (hardcoded) |
| `'sold'` | `validation.ts:91` (update enum) | After sale completes |
| `'reserved'` | `validation.ts:91` (update enum) | During active order |
| `'removed'` | `validation.ts:91` (update enum) | Seller removal |
| `'deleted'` | `listingController.ts:1167` | Soft delete |
| `'inactive'` | Found in search filters | Query filter only |

**NOT in codebase:** `'draft'`, `'sold_elsewhere'` — both are **net-new**.

---

## D. Dashboard Import Wizard (Web)

**CONFIRMED** — `apps/dashboard/src/app/(dashboard)/inventory/import/page.tsx:413-1321`

### Publish loop — N+1 client-side sequential

```ts
// page.tsx:604-661
for (let i = 0; i < toImport.length; i++) {
  const row = validRows[toImport[i]];
  const shipping = SHIPPING_MAP[row['shipping_option']] ?? SHIPPING_MAP['Small'];
  const status = rowStatuses.get(idx) ?? 'draft';  // ← sends 'draft'

  const data: CreateListingData = {
    title: row['title'],
    category: row['category'],
    price: parseFloat(row['price']),
    parcel_size: shipping.parcel_size,  // ← UPPERCASE: 'SMALL', 'MEDIUM'...
    shipping_cost: shipping.shipping_cost,
    status: status,                      // ← 'draft' — backend ignores this
    // ...
  };

  const listing = await createListing(data);     // POST /api/listings

  const images = listingImages.get(idx) ?? [];
  for (const file of images) {
    await uploadListingImage(listing.id, file);   // POST /api/listings/:id/images
  }
}
```

**CONFIRMED:** Step 3 calls `createListing()` + `uploadListingImage()` N times, one listing at a time, sequential. For N listings with M images each: N + (N × M) sequential HTTP requests.

### **DIFFERS-FROM-PRO-01: Multiple wizard bugs discovered**

1. **`status: 'draft'` silently ignored** — backend hardcodes `'active'`, so every imported listing goes LIVE immediately. The wizard UI shows "Draft"/"Active" toggle per row (line 611) but the backend disregards it.

2. **`parcel_size` case mismatch** — `SHIPPING_MAP` (line 57-64) produces UPPERCASE values (`'SMALL'`, `'MEDIUM'`, `'LARGE'`, `'EXTRA_LARGE'`, `'OVERSIZED'`). Backend Zod enum expects lowercase (`'small'`, `'medium'`, ...). **Import would fail Zod validation.** (The "Own Carrier" option maps to `parcel_size: 'SMALL'` as a fallback — also UPPERCASE.)

3. **Category string mismatch** — Web: `'Shafts Grips & Heads'` (no comma). Backend: `'Shafts, Grips & Heads'` (with comma). Listings in this category would fail backend validation.

4. **`subcategory` required but wizard doesn't always send it** — Backend Zod requires `subcategory: z.string().min(1).max(100)` (not optional). Web's `CreateListingData` has `subcategory?: string`. CSV template includes subcategory but it's not validated as required by the web-side validator. Would fail backend validation if omitted.

5. **`auto_decline_threshold` is a dead column** — Present in CSV header template but never read by `validateRows()` or `handleImport()`.

These mean **the import wizard has likely never been tested end-to-end** with real backend validation. All 4 issues would cause silent failures or data integrity problems.

### CSV template — 21 columns

```
title,description,category,condition,price,shipping_option,brand,model,
club_type,shaft_flex,shaft_material,loft,lie_angle,shaft_length,dexterity,
size,gender,colour,subcategory,accepts_offers,auto_decline_threshold
```

| # | Column | Required (web) | Maps to backend field |
|---|--------|----------------|----------------------|
| 1 | `title` | Yes | `title` |
| 2 | `description` | Yes (web validation) | `description` |
| 3 | `category` | Yes (enum) | `category` |
| 4 | `condition` | Yes (New/Like New/Very Good/Good/Fair) | → `condition_overall` (1-5 via CONDITION_TO_NUMBER) |
| 5 | `price` | Yes (positive number) | `price` |
| 6 | `shipping_option` | Yes (Small/Medium/Large/Extra Large/Oversized/Own Carrier) | → `parcel_size` + `shipping_cost` via SHIPPING_MAP |
| 7 | `brand` | No | `brand` |
| 8 | `model` | No | `model` |
| 9-18 | `club_type` thru `colour` | No (spec fields) | → `specifications` JSON object |
| 19 | `subcategory` | No (web) / Yes (backend!) | `subcategory` |
| 20 | `accepts_offers` | No (boolean) | `is_negotiable` |
| 21 | `auto_decline_threshold` | No | **DEAD — never read** |

### API-client functions used

Only two, from `@mulligans/api-client` (`packages/api-client/src/endpoints/listings.ts`):

1. **`createListing(data: CreateListingData): Promise<Listing>`** — calls `POST /api/listings` (line 102)
2. **`uploadListingImage(listingId: string, file: File): Promise<{message: string; count: number}>`** — calls `POST /api/listings/:listingId/images` via raw `fetch()` with FormData (line 133-161). Uses multer field name `'images'`.

### Image support

**File-only.** No URL support. DropZone at line 966 accepts `.jpg,.jpeg,.png,.webp`. State is `Map<number, File[]>`. No `image_url` column in CSV template.

---

## E. Stripe Connect "Ready to Sell" Check

**CONFIRMED** — `users.stripe_connect_id` (String?, schema line 278) + `users.stripe_connect_status` (String?, schema line 279).

### Payment-readiness check pattern

The codebase checks `seller.stripe_connect_id` as the primary gate. If absent, it auto-creates a Connect account:

```ts
// cartCheckoutController.ts:263-303
if (!seller.stripe_connect_id) {
  // Auto-create Connect account (Express, GB, card_payments + transfers)
  const account = await stripe.accounts.create({...});
  await prisma.users.update({ data: {
    stripe_connect_id: account.id,
    stripe_connect_status: 'pending',
  }});
  seller.stripe_connect_id = account.id;
}
```

The same pattern exists in `nativePaymentController.ts:207-233` and `:562-587`.

**There is no helper function** like `isPaymentReady()` — the check is inline `if (!seller.stripe_connect_id)` in each checkout controller. The `stripe_connect_status` field is set to `'pending'` on auto-creation and `'active'` in tests, but there's no explicit gate on status being `'active'` before allowing payouts — only the presence of `stripe_connect_id` is checked.

**Import gate for draft→active:** An imported listing should stay `'draft'` until the seller has `stripe_connect_id` (at minimum). The implementation may want to also check `stripe_connect_status === 'active'` for safety. No existing helper to extract — this is a small net-new utility.

---

## F. Phantom-Stock Primitives

### `expireOffersForSoldItem()` — CONFIRMED

**File:** `jobs/offerJobs.ts:387-461`
**Signature:** `async (listingId: string): Promise<number>`

What it does:
1. Finds all offers with status `PENDING`, `ACCEPTED`, `COUNTERED`, `COUNTER_ACCEPTED` for the listing
2. Batch-updates all to `EXPIRED`
3. Deletes cart_items referencing those offer IDs (`deleteMany where offer_id in [...]`)
4. Sends push notification to each affected buyer ("Item Sold — your offer has been cancelled")
5. Returns count of expired offers

**Called from:** `nativePaymentController.ts:992`, `nativePaymentController.ts:1362`, `stripeController.ts` (after marking listing as sold on purchase).

### Cart-removal pattern — CONFIRMED

Multiple precedents for `cart_items.deleteMany`:

```ts
// stripeController.ts:835 — after successful purchase
await tx.cart_items.deleteMany({
  where: { listing_id: soldListingId }
});

// nativePaymentController.ts:970 — after fulfilment
await tx.cart_items.deleteMany({
  where: { listing_id: listingId }
});
```

Pattern: `prisma.cart_items.deleteMany({ where: { listing_id } })` — removes the listing from all users' carts.

### Active-order guard (deletion protection) — CONFIRMED

**File:** `listingController.ts:1130-1162`

```ts
const ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered'];

const activeOrders = await prisma.orders.findFirst({
  where: {
    listing_id: id,
    status: { in: ACTIVE_ORDER_STATUSES },
  },
  select: { id: true, status: true },
});

if (activeOrders) {
  // Block deletion with contextual error message
  res.status(400).json({ error: message, order_status: activeOrders.status });
  return;
}
```

**Reusable for mark-sold-elsewhere:** The same `ACTIVE_ORDER_STATUSES` check and `findFirst` pattern can guard the `POST /api/listings/:id/mark-sold-elsewhere` endpoint. If the listing has an active order, block the mark-sold-elsewhere action with an appropriate error. This is the SAFE v1 approach (vs auto-cancel+refund which touches money).

### `sold_elsewhere` concept — CONFIRMED ABSENT

`grep -rn 'sold_elsewhere'` across the entire backend returns zero results. Net-new status value.

---

## G. Dedup / Idempotency

**CONFIRMED: No existing import idempotency.** No `external_source`, `external_id`, or unique constraint for imported listings. Re-running a CSV would create duplicate listings.

### Proposed unique-key shape

```sql
UNIQUE (seller_id, external_source, external_id) WHERE external_source IS NOT NULL
```

- `external_source`: `'csv'`, `'ebay'` (future), `'shopify'` (future)
- `external_id`: For CSV: hash of `title + price + category` (or row number + import batch ID). For eBay: the eBay listing ID.
- Both nullable — existing listings (created via normal sell flow) have NULL for both, so the unique constraint only applies to imported listings.

**Prisma partial unique indexes** require raw SQL migration (Prisma doesn't support `WHERE` clauses in `@@unique`). The migration should use:

```sql
CREATE UNIQUE INDEX listings_external_dedup
ON listings (seller_id, external_source, external_id)
WHERE external_source IS NOT NULL;
```

---

## Resolved Category Enum (Definitive)

**8 values — live on backend as of this SHA:**

| # | Value (exact string) | Notes |
|---|---------------------|-------|
| 1 | `Clubs` | |
| 2 | `Shafts, Grips & Heads` | **Has comma** — web wizard has `Shafts Grips & Heads` (no comma) = MISMATCH |
| 3 | `Clothing` | |
| 4 | `Shoes` | |
| 5 | `Accessories` | |
| 6 | `Balls` | |
| 7 | `Training Aids` | |
| 8 | `Everything Else` | Not in PRO-01's list |

---

## Normalized `IncomingListing` Spec (Corrected Against Live Validation)

Based on the live Zod `createListingSchema` + real field names:

```ts
interface IncomingListing {
  // Required (must pass Zod)
  title: string;            // min 3, max 200
  description: string;      // min 10, max 5000
  price: number;            // min 0.50, max 50000
  category: Category;       // 8-value enum (see above)
  subcategory: string;      // min 1, max 100 — REQUIRED by backend
  parcel_size: ParcelSize;  // 'small' | 'medium' | 'large' | 'extra_large' | 'oversized' (LOWERCASE)
  shipping_cost: number;    // min 0, max 100

  // Optional
  brand?: string;           // max 100
  model?: string;           // max 100
  location?: string;        // max 200, defaults to 'UK'
  is_negotiable?: boolean;  // defaults to false
  quantity?: number;        // int, min 1, max 999, default 1
  condition_overall?: number; // 1-5
  condition_head?: number;  // 1-5 (Clubs only)
  condition_shaft?: number; // 1-5 (Clubs only)
  condition_grip?: number;  // 1-5 (Clubs only)
  ball_condition_type?: string; // NOT validated by Zod (passes through raw)
  specifications?: Record<string, any>;

  // Import-specific (net-new, not sent to current create endpoint)
  external_source?: string;   // 'csv' | 'ebay' | ...
  external_id?: string;       // dedup key within source
  image_urls?: string[];      // URLs to fetch (SSRF-hardened)
  status?: 'draft' | 'active'; // default 'draft' for imports
}
```

**Key corrections from PRO-01:**
- `subcategory` is REQUIRED (not optional) in backend Zod
- `parcel_size` must be LOWERCASE (the web wizard sends UPPERCASE — bug)
- `status` is not accepted by the current create endpoint — must be added
- `ball_condition_type` bypasses Zod entirely — either add to schema or document

---

## Proposed Sliced Build Sequence

### I-01 — Schema: `external_source` + `external_id` + `draft`/`sold_elsewhere` status

**Scope:** Prisma schema migration + validation schema updates.

**Changes:**
1. Add `external_source String?` and `external_id String?` to `listings` model
2. Add raw SQL partial unique index: `(seller_id, external_source, external_id) WHERE external_source IS NOT NULL`
3. Add `'draft'` and `'sold_elsewhere'` to the update schema status enum (`validation.ts:91`)
4. Accept `status` on the create endpoint: add to `createListingSchema` as `z.enum(['active', 'draft']).optional().default('active')` and use it in the controller instead of hardcoding `'active'`
5. Fix `parcel_size` case mismatch: either normalize to lowercase in the controller, or update the enum to accept both cases (prefer: normalize in controller/adapter)

**Money-adjacent?** NO — schema only, no checkout/payout/escrow changes.
**Dependency:** None (first slice).

**Tests:**
- Create listing with `status: 'draft'` → confirm it's stored as `'draft'`, not `'active'`
- Create listing without `status` → confirm it defaults to `'active'` (backward-compat)
- Create two listings with same `(seller_id, external_source, external_id)` → second fails unique constraint
- Create two listings with `external_source: null` → both succeed (partial index)
- Listings with `status: 'draft'` are excluded from public search/feed queries

### I-02 — `importService` + `csvAdapter` (no images)

**Scope:** Backend service that accepts normalized `IncomingListing[]`, validates, creates listings in batch, returns `{created, failed[], warnings[]}`.

**Changes:**
1. `csvAdapter.ts` — parses CSV rows into `IncomingListing[]` using the same 21-column template. Handles: category name normalization (comma mismatch fix), condition string→number mapping, shipping option→parcel_size+cost mapping, case normalization for parcel_size.
2. `importService.ts` — takes `IncomingListing[]`, validates each against existing Zod rules, creates listings (reuses existing Prisma create path), assigns `external_source: 'csv'`, generates `external_id` per row, returns structured results.
3. `POST /api/listings/import` endpoint — accepts CSV file upload (multer), runs through csvAdapter → importService. Auth: `authenticateToken` — creates listings owned by `req.user.id`.
4. Rate limit: separate from per-listing limiter (e.g. 5 imports/hr, 200 rows max per import).

**Money-adjacent?** NO — creates listings only, no payment changes.
**Dependency:** I-01 (needs `external_source`/`external_id` fields + `draft` status).

**Tests:**
- Valid CSV → all rows created, each with `external_source: 'csv'` and `external_id`
- Duplicate CSV re-run → fails on unique constraint, returns `{created: 0, failed: [{reason: 'duplicate'}]}`
- Row with invalid category → fails with clear error, other rows still created
- Row with missing required field (title, price) → fails, others succeed
- CSV with >200 rows → rejected before processing
- Parcel size normalization: `'Small'` → `'small'`, `'Extra Large'` → `'extra_large'`
- Category normalization: `'Shafts Grips & Heads'` → `'Shafts, Grips & Heads'`

### I-03 — Image-URL Fetch + SSRF-Hardened Ingress

**Scope:** Fetch images from seller-supplied URLs, feed into existing sharp→S3 pipeline.

**Changes:**
1. `imageUrlFetcher.ts` — SSRF-hardened URL fetch utility:
   - Scheme allowlist: `https://` only
   - DNS resolve → check IP against private/link-local/metadata blocklist BEFORE connecting
   - Content-type check: `image/jpeg`, `image/png`, `image/webp`, `image/heic`
   - Max response size: 10MB
   - Fetch timeout: 15s
   - Max redirects: 3 (re-check each redirect destination)
2. Integrate into importService: if `IncomingListing.image_urls` present, fetch each URL → pass Buffer through existing sharp pipeline → `S3Service.uploadImage` → create image record.
3. Also fix the S3 ContentType bug (pass `'image/jpeg'` as mimetype, not `listings/${id}`).

**Money-adjacent?** NO — image hosting only.
**Dependency:** I-02 (needs importService to attach images to).

**Tests:**
- Valid `https://` image URL → fetched, processed, S3-uploaded
- `http://` URL → rejected (scheme allowlist)
- URL resolving to `169.254.169.254` → rejected (metadata IP)
- URL resolving to `10.x.x.x` → rejected (private range)
- URL resolving to `127.0.0.1` → rejected (localhost)
- Response >10MB → rejected
- Response with `Content-Type: text/html` → rejected
- Timeout after 15s → fails gracefully, listing still created (images optional)
- Redirect to private IP → rejected

### I-04 — Phantom Stock v1: `mark-sold-elsewhere`

**Scope:** New endpoint to mark a listing as sold on another platform.

**Changes:**
1. `POST /api/listings/:id/mark-sold-elsewhere` — auth'd, seller-owned only
2. Active-order guard: reuse `ACTIVE_ORDER_STATUSES` pattern from `deleteListing` (lines 1130-1162). If listing has active order → 400 "Cannot mark as sold — active order exists"
3. If no active order:
   - Set `status: 'sold_elsewhere'`
   - Call `expireOffersForSoldItem(listingId)` (reuse existing)
   - Call `cart_items.deleteMany({ where: { listing_id } })` (reuse existing pattern)
4. Add `'sold_elsewhere'` to update schema enum
5. Dashboard bulk action: `POST /api/listings/bulk/mark-sold-elsewhere` (array of IDs, same checks per ID)

**Money-adjacent?** NO — does not touch checkout, payout, or refunds. Deliberately blocks if mid-order (defers auto-cancel+refund to a future money-critical slice).
**Dependency:** I-01 (needs `'sold_elsewhere'` status in schema).

**Tests:**
- Listing with no active order → status changed to `'sold_elsewhere'`, offers expired, cart items removed
- Listing with active order (`'to_ship'`) → 400, status unchanged
- Listing with active order (`'shipped'`) → 400, status unchanged
- Listing already `'sold_elsewhere'` → idempotent success
- Non-owner seller → 403
- Listing with 3 pending offers → all 3 expired, buyers notified

### I-05 — Re-point Dashboard Wizard at Backend Pipeline + URL Images

**Scope:** Update the web dashboard import wizard to use the new backend import endpoint.

**Changes:**
1. Replace the N+1 `createListing()` + `uploadListingImage()` loop with a single `POST /api/listings/import` call (CSV file upload)
2. Add `image_url` column to CSV template (optional, per-row)
3. Fix category string to match backend enum (add comma: `'Shafts, Grips & Heads'`)
4. Fix parcel_size case to lowercase (or let backend adapter handle it — done in I-02)
5. Remove the dead `auto_decline_threshold` column from template
6. Update `api-client`: add `importListings(file: File): Promise<ImportResult>` function

**Money-adjacent?** NO — UI and API plumbing only.
**Dependency:** I-02 + I-03 (needs backend import endpoint with image support).

**Tests:**
- Wizard upload → single POST request to backend (not N+1)
- CSV with image URLs → images fetched and attached
- CSV with file-drop images → still works (formData includes files)
- Error rows → displayed in wizard with per-row error messages
- Duplicate import → shows "already imported" for duplicate rows

### Dependency order

```
I-01 (schema) ← I-02 (import service) ← I-03 (image fetch)
     ↑                                          ↑
     I-04 (phantom stock)              I-05 (wizard re-point)
```

I-01 is first. I-02 and I-04 can be done in parallel after I-01. I-03 depends on I-02. I-05 depends on I-02 + I-03.

---

## Proof-of-Work

**Backend SHA:** `dc3891965d4925939175e5ce8cab63af63b0e30b`
**Web SHA:** `9245a34ddad0dc53417be4b44322d5f82b41a762`

No source files modified. This was read-only.
