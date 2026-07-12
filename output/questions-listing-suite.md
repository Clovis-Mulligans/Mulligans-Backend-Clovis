# Listing Regression Suite — Questions, Findings & Deliverables

**Date:** 2026-07-12
**Branch:** `task/listing-regression-suite` based on `origin/main` @ `2fdc9bf`
**Author:** Clovis (Sonnet task, Opus execution)

---

## STEP 1 — INVESTIGATION REPORT

### Files examined

| File | Purpose |
|------|---------|
| `src/controllers/listingController.ts` (1383 lines) | Primary target — all 12 listing handlers |
| `src/routes/listingRoutes.ts` (66 lines) | Route definitions, middleware stack |
| `src/middleware/validation.ts` (119 lines) | Zod schemas for create/update/getListings |
| `prisma/schema.prisma` (lines 48-126) | `images`, `listing_attributes`, `listings` models |
| `mulligans-knowledge/business-logic-v2.md` (2497 lines) | Canonical spec — Section 9 (Listing Rules) is UNWRITTEN |
| `src/__tests__/helpers/mockPrisma.ts` | Shared Prisma mock |
| `src/__tests__/helpers/testSetup.ts` | Fixtures, JWT, mock req/res, test app factory |
| `src/__tests__/helpers/mockFactories.ts` | Additional test factories |
| `origin/task/listing-suite-salvage:listing.unit.test.ts` (1293 lines) | Salvaged unit suite — 70 tests (68 pass, 2 fail) |
| `origin/task/listing-suite-salvage:listing.integration.test.ts` (587 lines) | Salvaged middleware-stack tests |
| `src/__tests__/unit/*.test.ts` (8 files on main) | Existing unit suites — none are listing-related |

### Brief-listed test files that DO NOT EXIST

The brief references six suites as "existing listing test coverage":
- `publishListing.test.ts` — **MISSING** (not on main, not anywhere in repo)
- `draftVisibility.test.ts` — **MISSING**
- `csvImport.test.ts` — **MISSING**
- `importDedupDraft.test.ts` — **MISSING**
- `importUpsert.test.ts` — **MISSING**
- `offSale.test.ts` — **MISSING**

**Conclusion:** These features (publish/draft workflow, CSV import, off-sale) may be planned but have never been implemented. No code for these features exists in `listingController.ts`. The only listing test coverage is the salvaged suite.

### Salvaged unit test coverage summary (70 tests)

| Describe block | Tests | What it covers |
|---------------|-------|----------------|
| createListing | 17 | Happy path, ID format, club condition averaging (5 cases), sizeQuantities auto-sum, defaults (quantity/location/is_negotiable), listing_attributes/setMakeup, seller in response, 404/500 errors |
| getAllListings | 17 | Pagination (defaults, page/limit), status=active, category/subcategory/price/brand/keyword/q filters, dexterity/shaftFlex attribute filters, empty short-circuit, 500 error |
| getListingById | 2 | Happy path with seller+favorites, 404 not found |
| updateListing | 5 | Owner update (title/price/desc), club condition recalc, listing_attributes replacement, 403 non-owner, 404 not found |
| deleteListing | 8 | ⚠️ Owner delete, active order blocking (paid/shipped/delivered messages), 6-status check, 403/404, S3 skip on no images |
| uploadListingImage | 5 | Happy path, .heic→.jpg rename, 404/403/400 |
| deleteListingImage | 4 | Owner delete, 403/404 (listing & image) |
| getSellerListings | 2 | status=active query, empty result |
| trackView | 4 | Buyer view (increment), seller self-view (skip), anonymous view, 404 |
| getFeaturedListings | 4 | ⚠️ Unpersonalised (guest & no prefs), personalisation matching, take/where check |
| calculateTotalFromSizeQuantities | 2 | Zero sizeQuantities fallback, missing sizeQuantities fallback |

⚠️ = contains known failing tests (see Known Corrections below)

### Salvaged integration test coverage summary (38 tests)

This file is labeled "integration" but uses **mocked Prisma, S3, and Sharp** — it's a middleware-stack test using supertest, not a true integration test hitting dev services. See "Integration File Assessment" section below.

| Describe block | Tests | What it covers |
|---------------|-------|----------------|
| GET /featured (public) | 1 | 200 without auth |
| POST /listings | 10 | 401 no auth, 401/403 bad JWT, 201 valid, 400 title too short/long, 400 desc too short, 400 price below/above bounds, 400 bad category, 400 missing fields, 400 bad parcel_size, rate-limit headers |
| GET /listings | 4 | 200 shape, category filter, price range, dexterity attribute |
| GET /listings/:id | 2 | 200 with seller+favorites, 404 |
| PUT /listings/:id | 3 | 401 no auth, 403 non-owner, owner price update |
| DELETE /listings/:id | 4 | 401 no auth, owner delete, 400 active order, 403 non-owner, 404 |
| DELETE /listings/:id/images/:imageId | 4 | 401 no auth, owner delete, 403 non-owner, 404 image |
| POST /listings/:id/images | 3 | 401 no auth, 403 non-owner, owner upload 201 |
| GET /seller/:seller_id | 2 | 200 public, status=active query |
| POST /:id/view | 3 | Anonymous counted, auth seller still counted (route has no auth), 404 |
| Error response contract | 2 | { error } on 404, { error, details[] } on Zod failure |

---

## STEP 2 — LOGIC MAP

### Helper: `calculateTotalFromSizeQuantities(specifications)`
| Branch | Condition | Result |
|--------|-----------|--------|
| H1 | `specifications?.sizeQuantities` missing or not object | return `null` |
| H2 | Sum of all parseInt(qty) values > 0 | return sum |
| H3 | Sum = 0 (all values zero/NaN) | return `null` |

### 1. `getFeaturedListings` (GET /listings/featured)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| F1 | `req.user?.id` present | Fetch user preferences |
| F2 | `req.user?.id` absent (guest) | Skip preferences |
| F3 | User has preferences AND at least one size array non-empty | Personalization path |
| F4 | Personalization: listing specs match user clothing_size | → matchingListings |
| F5 | Personalization: listing specs match user shoe_size | → matchingListings |
| F6 | Personalization: listing specs match user glove_size | → matchingListings |
| F7 | No match | → nonMatchingListings |
| F8 | matchingListings.length > 0 | personalized: true, matching first |
| F9 | matchingListings.length = 0 | personalized: false (all went to non-matching) |
| F10 | No preferences / empty size arrays / guest | Unpersonalized return |
| F11 | Prisma query filters: `status: 'active', users.is_pro_store: true` | Only pro-store active listings |
| F12 | `take: 30`, `orderBy: created_at desc` | 30 most recent |
| F13 | Catch → 500 | Error path |
| **Defaults/Computed** | `personalized` (boolean), `matches` (count), `total` (count) | Response shape |

### 2. `createListing` (POST /listings)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| C1 | `req.user!.id` falsy (defensive) | 401 'User ID not found in token' |
| C2 | User not in DB (`users.findUnique` null) | 404 'User not found in database' |
| C3 | `category === 'Clubs'` AND all 3 sub-conditions truthy | `condition_overall = Math.round((head+shaft+grip)/3)` |
| C4 | Category not Clubs OR any sub-condition missing | `condition_overall = condition_overall` (passthrough) |
| C5 | `specifications.sizeQuantities` present and sum > 0 | `quantity = calculateTotalFromSizeQuantities(specs)` |
| C6 | sizeQuantities absent/zero AND `quantity` provided | `quantity = parseInt(quantity)` |
| C7 | sizeQuantities absent/zero AND no `quantity` | `quantity = 1` (default) |
| C8 | `location` falsy | defaults to `'UK'` |
| C9 | `is_negotiable` falsy | defaults to `false` |
| C10 | `specifications` is object → build listing_attributes | Attribute creation |
| C11 | Spec key === 'setMakeup' AND value is Array | One row per array element |
| C12 | Spec value is string | Use as-is |
| C13 | Spec value is non-string | `JSON.stringify(value)` |
| C14 | `subcategory/brand/model` falsy | → `null` |
| C15 | `shipping_cost` truthy | `parseFloat(shipping_cost)` |
| C16 | `shipping_cost` falsy | → `null` |
| C17 | `parcel_size` | passthrough or `null` |
| C18 | ID generation | `lst_${Date.now()}_${random}` |
| C19 | Status | hardcoded `'active'` |
| C20 | After create, re-fetch with images + fetch seller | Response assembly |
| C21 | Catch → 500 | Error path |
| **Validation (Zod, pre-controller)** | title 3-200, desc 10-5000, price 0.50-50000, category enum (8 values), subcategory 1-100, location 1-200, parcel_size enum, shipping_cost 0-100, quantity int 1-999, conditions int 1-5 | 400 on failure |
| **Middleware** | `authenticateToken` → `listingLimiter` (50/hr) → `validate(createListingSchema)` | Pre-controller chain |

### 3. `uploadListingImage` (POST /listings/:id/images)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| U1 | Listing not found | 404 |
| U2 | `listing.seller_id !== userId` | 403 |
| U3 | No files or empty array | 400 'No files uploaded' |
| U4 | Sharp processing succeeds | Use processed buffer, rename extensions |
| U5 | Sharp processing fails | Fallback to original buffer/filename (warning logged) |
| U6 | Extension is `.heic/.heif/.png/.webp` (case-insensitive) | Strip and append `.jpg` |
| U7 | Filename doesn't end with `.jpg` after strip | Force-append `.jpg` |
| U8 | S3 upload per file | `S3Service.uploadImage(buffer, 'listings/${id}', filename)` |
| U9 | Raw SQL insert into images | `display_order = i` (loop index) |
| U10 | Catch → 500 | Error path |
| **Middleware** | `authenticateToken` → `multer.array('images', 5)` | Max 5 files |
| **No per-file rollback** | If file N fails, files 0..(N-1) remain uploaded | Partial failure gap |

### 4. `getAllListings` (GET /listings)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| A1 | Base where: `status: 'active'` | Always applied |
| A2 | `category` param → exact match | Filter |
| A3 | `subcategory` param → exact match | Filter |
| A4 | `condition` param → `condition_overall >= parseInt(condition)` | Filter |
| A5 | `seller_id` param → exact match | Filter |
| A6 | `minPrice` → `price >= parseFloat` | Filter |
| A7 | `maxPrice` → `price <= parseFloat` | Filter |
| A8 | `q` param → OR across title/description (insensitive) | Text search |
| A9 | `keyword` param → OR across title/desc/brand/model + shaftModel attributes | Extended search |
| A10 | `keyword` + `q` both present → AND of both OR groups | Combined filter |
| A11 | `brand` with comma → take first segment only | Dedupe workaround |
| A12 | `brand` → contains, insensitive | Filter |
| A13 | `model` with comma → take first segment | Dedupe workaround |
| A14 | `model` → contains, insensitive | Filter |
| A15 | Attribute filters (dexterity, shaftFlex, shaftMaterial, loft, lieAngle, gripSize, length) | Each queries listing_attributes |
| A16 | `setMakeup` → comma-split, one filter per value | Multi-value filter |
| A17 | Clothing filters (gender, waist, color, clothingType) | Attribute filters |
| A18 | Accessory filters (spikes, bagType, headcoverType, gloveSize, teeMaterial, teeStyle, slopeAdjust) | Attribute filters |
| A19 | `size` or `shoeSize` present | Special handling path |
| A20 | Size exact match via listing_attributes | Direct match |
| A21 | Size "Various" listings → check `specifications.sizeQuantities[value] > 0` | Stock-level filter |
| A22 | Size matches empty → early return empty | Short-circuit |
| A23 | Multiple attribute filters → intersection (AND) | All must match |
| A24 | Attribute intersection empty → early return empty | Short-circuit |
| A25 | Size + attribute intersection → combined | Further filtering |
| A26 | `offset` param present → overrides page-based skip | Pagination override |
| A27 | Default pagination: page=1, limit=20 | Defaults |
| A28 | Final query: `findMany` + `count` in parallel | Response assembly |
| A29 | Catch → 500 | Error path |

### 5. `getListingById` (GET /listings/:id)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| G1 | Listing not found OR `status === 'deleted'` | 404 |
| G2 | Fetch seller info (7 fields) | Always |
| G3 | Count favorites | Always |
| G4 | `viewerId` present AND `viewerId !== listing.seller_id` | Check for active offer |
| G5 | Active offer found with `final_amount` AND `acceptance_expires_at` | Build `viewer_active_offer` object |
| G6 | No viewerId / viewer is seller / no active offer | `viewer_active_offer = null` |
| G7 | Response includes `seller`, `favorite_count`, `viewer_active_offer` | Response shape |
| G8 | Catch → 500 | Error path |

### 6. `getSellerListings` (GET /listings/seller/:seller_id)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| S1 | Query: `seller_id + status: 'active'` | Always |
| S2 | No pagination | Returns all active listings |
| S3 | Includes primary image + seller subset | Response shape |
| S4 | Catch → 500 | Error path |

### 7. `updateListing` (PUT /listings/:id)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| UP1 | Listing not found | 404 |
| UP2 | `listing.seller_id !== userId` | 403 |
| UP3 | `category === 'Clubs'` AND all 3 sub-conditions truthy | Recalculate condition_overall |
| UP4 | Partial update — only fields where value `!== undefined` are set | Selective update |
| UP5 | `subcategory/brand/model` — value or `null` if falsy | Nullable handling |
| UP6 | `location` — value or `null` (NO 'UK' default unlike create) | Inconsistency with create |
| UP7 | `status` — direct passthrough, no validation of allowed values | Any string accepted |
| UP8 | `specifications.sizeQuantities` present → recalculate quantity | Auto-sum |
| UP9 | No sizeQuantities but `quantity !== undefined` → `parseInt(quantity) \|\| 1` | Explicit quantity |
| UP10 | `specifications` provided → delete all existing attributes, rebuild | Replace all |
| UP11 | Re-fetch includes `listing_attributes` (create response doesn't) | Response inconsistency |
| UP12 | Catch → 500 | Error path |

### 8. `deleteListing` (DELETE /listings/:id)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| D1 | Listing not found | 404 |
| D2 | `listing.seller_id !== userId` | 403 |
| D3 | `listing.status === 'deleted'` | Idempotent 200 (no re-processing) |
| D4 | Active order exists (any of 6 statuses) | 400 with status-specific message |
| D5 | Active order status in `[pending, paid, to_ship]` | "waiting to be shipped" message |
| D6 | Active order status in `[shipped, in_transit]` | "in transit" message |
| D7 | Active order status === `delivered` | "wait until transaction completes" message |
| D8 | No active orders → soft delete | `status: 'deleted', deleted_at: new Date()` |
| D9 | **S3 images are NOT deleted** | Policy: retain images on deletion |
| D10 | Catch → 500 | Error path |

### 9. `deleteListingImage` (DELETE /listings/:id/images/:imageId)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| DI1 | Listing not found | 404 |
| DI2 | `listing.seller_id !== userId` | 403 |
| DI3 | Image not found | 404 |
| DI4 | S3 delete then DB delete | Order of operations |
| DI5 | **No check that `image.listing_id === id`** | ⚠️ Authorization gap — see findings |
| DI6 | Catch → 500 | Error path |

### 10. `trackView` (POST /listings/:id/view)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| V1 | Listing not found | 404 |
| V2 | `viewerId` present AND equals `seller_id` | Skip counting, `counted: false` |
| V3 | `viewerId` absent (anonymous) | Count view, `counted: true` |
| V4 | `viewerId` present AND not seller | Count view, `counted: true` |
| V5 | Atomic increment: `views: { increment: 1 }` | No race condition on count |
| V6 | Catch → 500 | Error path |

### 11. `bulkUpdateListings` (PATCH /listings/bulk)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| BU1 | `ids` missing/not-array/empty | 400 'ids must be a non-empty array' |
| BU2 | Not all ids owned by user | 403 'You do not own all of these listings' |
| BU3 | `status` truthy → add to updateData | Status update |
| BU4 | `price` defined → `String(price)` + optional `original_price` | Price update |
| BU5 | `price_adjustment_percent` defined | Per-listing percentage adjustment path |
| BU6 | Percent path: `newPrice = currentPrice * (1 + pct/100)`, clamped to ≥0 | Price calculation |
| BU7 | Percent path early return — **silently drops status/price from updateData** | ⚠️ See findings |
| BU8 | No status, no price, no percent → empty updateData | 400 'No update data provided' |
| BU9 | Non-empty updateData → `updateMany` | Batch update |
| BU10 | Catch → 500 | Error path |

### 12. `bulkDeleteListings` (POST /listings/bulk-delete)
| ID | Branch/Condition | Path |
|----|-----------------|------|
| BD1 | `ids` missing/not-array/empty | 400 |
| BD2 | Not all ids owned by user | 403 |
| BD3 | Soft delete via `updateMany` — `status: 'deleted'` | No `deleted_at` set (inconsistent with single delete) |
| BD4 | **No active order check** (unlike single delete) | ⚠️ See findings |
| BD5 | Catch → 500 | Error path |

---

## STEP 3 — TEST CASE ENUMERATION

### Category: Positive / Happy Path

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| POS-01 | Create listing returns 201 with listing envelope | Auth'd seller, user exists | Valid body | 201 `{ listing: { ...data, seller } }` | C19, C20 |
| POS-02 | Create listing ID format matches `lst_{timestamp}_{random}` | Auth'd seller | Valid body | ID matches pattern | C18 |
| POS-03 | Create with all optional fields populated | Auth'd seller | Full body with all fields | All fields persisted correctly | C3-C17 |
| POS-04 | Get listing by ID returns seller + favorites + null viewer_offer | Guest | Valid listing ID | 200 with full shape | G2, G3, G6, G7 |
| POS-05 | Get listing by ID as buyer with active offer | Auth'd buyer, accepted offer exists | Valid listing ID | 200 with `viewer_active_offer` populated | G4, G5 |
| POS-06 | Get all listings returns paginated results | Active listings exist | Default params | 200 `{ listings, pagination }` | A1, A27, A28 |
| POS-07 | Get seller listings returns active-only | Seller has active listings | seller_id param | 200 `{ listings }` | S1 |
| POS-08 | Update listing fields (partial) | Auth'd owner | `{ title, price }` | 200, only provided fields changed | UP4 |
| POS-09 | Delete listing (soft) when no orders | Auth'd owner, no active orders | Listing ID | 200, status→deleted | D8, D9 |
| POS-10 | Upload images returns 201 | Auth'd owner, valid files | 2 image files | 201 `{ message, count: 2 }` | U4, U8, U9 |
| POS-11 | Delete image when owner | Auth'd owner, image exists | listing_id + imageId | 200, S3+DB deleted | DI4 |
| POS-12 | Track view increments for buyer | Listing exists, buyer auth'd | Listing ID | 200 `{ counted: true }` | V4 |
| POS-13 | Track view for anonymous | Listing exists | Listing ID, no auth | 200 `{ counted: true }` | V3 |
| POS-14 | Featured listings for guest | Active pro-store listings exist | No auth | 200, `personalized: false` | F2, F10 |
| POS-15 | Featured listings with size match | Auth'd buyer with prefs, matching listings | Auth token | 200, `personalized: true`, matches first | F3, F4, F8 |
| POS-16 | Bulk update status | Auth'd owner of all IDs | `{ ids, status: 'sold' }` | 200 `{ updated: N }` | BU3, BU9 |
| POS-17 | Bulk delete (soft) | Auth'd owner of all IDs | `{ ids }` | 200 `{ deleted: N }` | BD3 |
| POS-18 | Bulk update with price_adjustment_percent | Auth'd owner | `{ ids, price_adjustment_percent: -10 }` | 200, each price reduced 10% | BU5, BU6 |

### Category: Negative / Validation Failures

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| NEG-01 | Create listing — user not in DB | Auth'd with ghost user | Valid body | 404 'User not found in database' | C2 |
| NEG-02 | Create listing — Prisma throws on create | Auth'd seller | Valid body, DB error | 500 | C21 |
| NEG-03 | Upload — listing not found | Auth'd user | Non-existent listing ID | 404 | U1 |
| NEG-04 | Upload — no files | Auth'd owner | Empty files array | 400 'No files uploaded' | U3 |
| NEG-05 | Get listing — not found | — | Non-existent ID | 404 | G1 |
| NEG-06 | Update — listing not found | Auth'd | Non-existent ID | 404 | UP1 |
| NEG-07 | Delete — listing not found | Auth'd | Non-existent ID | 404 | D1 |
| NEG-08 | Delete — active order (pending/paid/to_ship) | Auth'd owner, paid order exists | Listing ID | 400, "waiting to be shipped" | D4, D5 |
| NEG-09 | Delete — active order (shipped/in_transit) | Auth'd owner, shipped order | Listing ID | 400, "in transit" | D4, D6 |
| NEG-10 | Delete — active order (delivered) | Auth'd owner, delivered order | Listing ID | 400, "wait until transaction completes" | D4, D7 |
| NEG-11 | Delete image — listing not found | Auth'd | Non-existent listing ID | 404 | DI1 |
| NEG-12 | Delete image — image not found | Auth'd owner | Non-existent imageId | 404 | DI3 |
| NEG-13 | Track view — listing not found | — | Non-existent ID | 404 | V1 |
| NEG-14 | Bulk update — ids missing/empty | Auth'd | `{}` or `{ ids: [] }` | 400 | BU1 |
| NEG-15 | Bulk update — no update data | Auth'd owner | `{ ids: ['x'] }` (no status/price/pct) | 400 'No update data provided' | BU8 |
| NEG-16 | Bulk delete — ids missing/empty | Auth'd | `{}` or `{ ids: [] }` | 400 | BD1 |
| NEG-17 | Get all listings — Prisma throws | — | Any | 500 | A29 |
| NEG-18 | Featured listings — Prisma throws | — | Any | 500 | F13 |

### Category: Boundary Values

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| BND-01 | Price at minimum (£0.50) | Auth'd seller | `price: 0.50` | 201 (Zod passes) | Zod |
| BND-02 | Price at maximum (£50,000) | Auth'd seller | `price: 50000` | 201 (Zod passes) | Zod |
| BND-03 | Price below minimum (£0.49) | Auth'd seller | `price: 0.49` | 400 (Zod rejects) | Zod |
| BND-04 | Price above maximum (£50,001) | Auth'd seller | `price: 50001` | 400 (Zod rejects) | Zod |
| BND-05 | Title at min length (3 chars) | Auth'd seller | `title: 'abc'` | 201 | Zod |
| BND-06 | Title at max length (200 chars) | Auth'd seller | `title: 'x'.repeat(200)` | 201 | Zod |
| BND-07 | Title below min (2 chars) | Auth'd seller | `title: 'ab'` | 400 | Zod |
| BND-08 | Title above max (201 chars) | Auth'd seller | `title: 'x'.repeat(201)` | 400 | Zod |
| BND-09 | Description at min (10 chars) | Auth'd seller | `desc: 'x'.repeat(10)` | 201 | Zod |
| BND-10 | Description below min (9 chars) | Auth'd seller | `desc: 'x'.repeat(9)` | 400 | Zod |
| BND-11 | Quantity=1 (minimum, schema default) | Auth'd seller | `quantity: 1` | 201, quantity=1 | C6 |
| BND-12 | sizeQuantities with non-numeric values | Auth'd seller | `{ S: 'abc', M: '3' }` | quantity=3 (parseInt('abc')=NaN→0) | H1-H3, C5 |
| BND-13 | Condition values at boundaries (1, 5) | Auth'd seller, Clubs | head=1, shaft=1, grip=1 | condition_overall=1 | C3 |
| BND-14 | Condition average rounding (1,1,2)→1 vs (2,2,3)→2 | Auth'd seller, Clubs | Various combos | Correct Math.round | C3 |
| BND-15 | Empty pagination (page=0 or limit=0) | — | `page=0, limit=0` | Implementation-defined | A27 |
| BND-16 | Bulk update percentage to negative price | Auth'd owner | `pct: -150` | Price clamped to 0 (Math.max) | BU6 |

### Category: State-Based / Duplicate

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| STA-01 | Delete already-deleted listing (idempotent) | Auth'd owner, listing.status='deleted' | Listing ID | 200 (no re-processing) | D3 |
| STA-02 | Get listing with status='deleted' returns 404 | Listing exists but deleted | Listing ID | 404 | G1 |
| STA-03 | Track view — seller views own listing | Auth'd seller | Own listing ID | `counted: false` | V2 |
| STA-04 | Update listing status to arbitrary value | Auth'd owner | `{ status: 'garbage' }` | 200 (controller accepts) | UP7 |
| STA-05 | Update listing — location does NOT default to 'UK' | Auth'd owner | `{ location: '' }` | `location: null` (unlike create) | UP6 |
| STA-06 | Featured — user with prefs but no matching listings | Auth'd buyer with prefs | All listings non-matching | personalized: false (0 matches) | F9 |

### Category: Security

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| SEC-01 | Non-owner cannot update listing | Auth'd non-owner | Update body | 403 | UP2 |
| SEC-02 | Non-owner cannot delete listing | Auth'd non-owner | Delete request | 403 | D2 |
| SEC-03 | Non-owner cannot upload images | Auth'd non-owner | Image file | 403 | U2 |
| SEC-04 | Non-owner cannot delete images | Auth'd non-owner | imageId | 403 | DI2 |
| SEC-05 | Bulk update — partial ownership rejected | Auth'd, owns only some | `{ ids: [owned, unowned] }` | 403 | BU2 |
| SEC-06 | Bulk delete — partial ownership rejected | Auth'd, owns only some | `{ ids: [owned, unowned] }` | 403 | BD2 |
| SEC-07 | Seller PII not leaked in listing detail response | — | Valid listing | Seller object has only safe fields (id, display_name, rating, avatar_url, is_verified, is_pro, pro_name) | G2 |
| SEC-08 | Seller PII not leaked in create response | Auth'd seller | Create listing | Seller object has only (id, display_name, avatar_url, rating) | C20 |
| SEC-09 | deleteListingImage — image belongs to different listing | Auth'd owner of listing A | `params: { id: listingA, imageId: imageBelongsToListingB }` | ⚠️ FINDING: image is deleted (no cross-listing check) | DI5 |
| SEC-10 | Search params use Prisma parameterized queries (no injection) | — | `q: "'; DROP TABLE listings;--"` | Normal empty result (Prisma parameterizes) | A8 |

### Category: Integration / Failure Modes

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| INT-01 | Image upload — Sharp processing fails | Auth'd owner, sharp throws | Valid image file | Falls back to original buffer, still 201 | U5 |
| INT-02 | Image upload — S3 fails mid-batch | Auth'd owner, 2 files, S3 fails on 2nd | 2 files | 500 (first file already uploaded — no rollback) | U10 |
| INT-03 | Delete — active order check queries all 6 statuses | Auth'd owner | Any listing | Order query includes all 6 | D4 |
| INT-04 | getAllListings — size filter with Various stock | Listing with `value: 'Various'`, specs has sizeQuantities | `shoeSize=UK9` | Listing included if sizeQuantities['UK9'] > 0 | A21 |
| INT-05 | getAllListings — size filter no matches → early return | No listings match size | `size=XXXL` | Empty response, main query NOT called | A22 |
| INT-06 | Bulk update percent + status → status silently dropped | Auth'd owner | `{ ids, status: 'sold', price_adjustment_percent: 10 }` | Only percent applied, status NOT updated | BU7 |

### Category: Authorization / Rate Limiting

| Case ID | Description | Preconditions | Input | Expected Result | Branch |
|---------|-------------|---------------|-------|-----------------|--------|
| AUTH-01 | Create listing — unauthenticated | No auth header | Valid body | 401 (middleware) | Route |
| AUTH-02 | Update listing — unauthenticated | No auth header | Update body | 401 (middleware) | Route |
| AUTH-03 | Delete listing — unauthenticated | No auth header | — | 401 (middleware) | Route |
| AUTH-04 | Upload images — unauthenticated | No auth header | Image file | 401 (middleware) | Route |
| AUTH-05 | Delete images — unauthenticated | No auth header | — | 401 (middleware) | Route |
| AUTH-06 | Rate limit: 50 requests per hour | Auth'd seller | 50th request | Rate-limit headers present | Route |
| AUTH-07 | Featured/getAll/getById/seller/view — no auth required | No auth | Various | 200 (public routes) | Route |

---

## STEP 4 — COVERAGE TABLE

| Case ID | Branch | Existing test? | File | Action |
|---------|--------|---------------|------|--------|
| **Positive** | | | | |
| POS-01 | C19,C20 | ✅ | salvaged unit:89 | No action |
| POS-02 | C18 | ✅ | salvaged unit:115 | No action |
| POS-03 | C3-C17 | Partial (individual cases) | salvaged unit | No action — covered by sub-cases |
| POS-04 | G2,G3,G6,G7 | ✅ | salvaged unit:597 | No action |
| POS-05 | G4,G5 | ❌ | — | **NEW TEST** |
| POS-06 | A1,A27,A28 | ✅ | salvaged unit:384 | No action |
| POS-07 | S1 | ✅ | salvaged unit:1066 | No action |
| POS-08 | UP4 | ✅ | salvaged unit:642 | No action |
| POS-09 | D8,D9 | ⚠️ WRONG ASSERTION | salvaged unit:754 | **FIX** (known correction #2 + listings.update) |
| POS-10 | U4,U8,U9 | ✅ | salvaged unit:898 | No action |
| POS-11 | DI4 | ✅ | salvaged unit:995 | No action |
| POS-12 | V4 | ✅ | salvaged unit:1099 | No action |
| POS-13 | V3 | ✅ | salvaged unit:1152 | No action |
| POS-14 | F2,F10 | ✅ | salvaged unit:1184 | No action |
| POS-15 | F3,F4,F8 | ✅ | salvaged unit:1215 | No action |
| POS-16 | BU3,BU9 | ❌ | — | **NEW TEST** |
| POS-17 | BD3 | ❌ | — | **NEW TEST** |
| POS-18 | BU5,BU6 | ❌ | — | **NEW TEST** |
| **Negative** | | | | |
| NEG-01 | C2 | ✅ | salvaged unit:351 | No action |
| NEG-02 | C21 | ✅ | salvaged unit:365 | No action |
| NEG-03 | U1 | ✅ | salvaged unit:942 | No action |
| NEG-04 | U3 | ✅ | salvaged unit:974 | No action |
| NEG-05 | G1 | ✅ | salvaged unit:625 | No action |
| NEG-06 | UP1 | ✅ | salvaged unit:732 | No action |
| NEG-07 | D1 | ✅ | salvaged unit:863 | No action |
| NEG-08 | D4,D5 | ✅ | salvaged unit:774 | No action |
| NEG-09 | D4,D6 | ✅ | salvaged unit:794 | No action |
| NEG-10 | D4,D7 | ✅ | salvaged unit:808 | No action |
| NEG-11 | DI1 | ✅ | salvaged unit:1032 | No action |
| NEG-12 | DI3 | ✅ | salvaged unit:1045 | No action |
| NEG-13 | V1 | ✅ | salvaged unit:1168 | No action |
| NEG-14 | BU1 | ❌ | — | **NEW TEST** |
| NEG-15 | BU8 | ❌ | — | **NEW TEST** |
| NEG-16 | BD1 | ❌ | — | **NEW TEST** |
| NEG-17 | A29 | ✅ | salvaged unit:583 | No action |
| NEG-18 | F13 | Implicit (tested by catch path) | — | Not adding (low value) |
| **Boundary** | | | | |
| BND-01 to BND-10 | Zod | ✅ | salvaged integration | No action (Zod validation tests) |
| BND-11 | C6 | ✅ | salvaged unit:237 | No action |
| BND-12 | H1-H3 | ❌ | — | **NEW TEST** |
| BND-13 | C3 | ❌ | — | **NEW TEST** |
| BND-14 | C3 | Partially ✅ | salvaged unit:127,147 | Extend with edge rounding |
| BND-15 | A27 | ❌ | — | Not adding (implementation-defined, low value) |
| BND-16 | BU6 | ❌ | — | **NEW TEST** |
| **State-Based** | | | | |
| STA-01 | D3 | ❌ | — | **NEW TEST** |
| STA-02 | G1 | ❌ | — | **NEW TEST** |
| STA-03 | V2 | ✅ | salvaged unit:1128 | No action |
| STA-04 | UP7 | ❌ | — | **ESCALATE** (spec gap) |
| STA-05 | UP6 | ❌ | — | **NEW TEST** |
| STA-06 | F9 | ❌ | — | **NEW TEST** |
| **Security** | | | | |
| SEC-01 | UP2 | ✅ | salvaged unit:713 | No action |
| SEC-02 | D2 | ✅ | salvaged unit:847 | No action |
| SEC-03 | U2 | ✅ | salvaged unit:956 | No action |
| SEC-04 | DI2 | ✅ | salvaged unit:1015 | No action |
| SEC-05 | BU2 | ❌ | — | **NEW TEST** |
| SEC-06 | BD2 | ❌ | — | **NEW TEST** |
| SEC-07 | G2 | ❌ | — | **NEW TEST** |
| SEC-08 | C20 | ❌ | — | **NEW TEST** |
| SEC-09 | DI5 | ❌ | — | **NEW TEST** (documents bug) |
| SEC-10 | A8 | ❌ | — | **NEW TEST** |
| **Integration/Failure** | | | | |
| INT-01 | U5 | ❌ | — | **NEW TEST** |
| INT-02 | U10 | ❌ | — | Not adding (complex mock setup, low yield) |
| INT-03 | D4 | ✅ | salvaged unit:822 | **FIX** (mock uses listings.delete) |
| INT-04 | A21 | ❌ | — | **NEW TEST** |
| INT-05 | A22 | ❌ | — | **NEW TEST** |
| INT-06 | BU7 | ❌ | — | **NEW TEST** (documents bug) |
| **Auth/Rate** | | | | |
| AUTH-01 to AUTH-07 | Route | ✅ | salvaged integration | No action (middleware tests) |

### Summary
- **Existing tests that need NO changes:** 52 cases covered
- **Tests needing CORRECTIONS:** 3 (2 known + delete mock fix)
- **NEW tests to write:** ~25 cases
- **Tests in salvaged integration file:** 38 (middleware stack coverage)

---

## FINDINGS

### FINDING 1: Section 9 (Listing Rules) in business-logic-v2.md is UNWRITTEN
**Severity:** HIGH (blocks spec-first testing)
**Details:** The canonical spec has Section 9 marked as ✏️ (not yet finalised). The section does not exist — the document jumps from Section 8 to Section 12. This means most listing behaviors (creation defaults, validation rules, deletion policy, image handling, search behavior, bulk operations) have NO canonical specification.
**Impact on this task:** Many test expected values cannot be derived from the spec because the spec is silent. I have used the Zod validation schema and Prisma schema defaults as secondary sources where they constitute declarative policy (e.g., "title must be 3-200 chars" is a validation rule in code that IS the spec). For controller-level logic (condition averaging, sizeQuantities summing, soft delete behavior), I've flagged cases where the correct behavior is ambiguous.
**Recommendation:** Write Section 9 before the next audit cycle. Until then, the Zod schema + Prisma schema are the de facto spec for validation rules.

### FINDING 2: deleteListingImage has no cross-listing authorization check
**Severity:** MEDIUM (authorization gap)
**Details:** `deleteListingImage` checks that the caller owns the listing referenced in `params.id`, then fetches the image by `params.imageId`, but never verifies that `image.listing_id === params.id`. An owner of listing A could delete an image belonging to listing B if they know the imageId, as long as they own listing A.
**Recommendation:** Add `if (image.listing_id !== id)` check. LOG this as a product bug — do NOT fix per brief rules.

### FINDING 3: bulkDeleteListings skips active-order check
**Severity:** MEDIUM (business logic gap)
**Details:** `deleteListing` explicitly checks for active orders before allowing deletion. `bulkDeleteListings` skips this check entirely — a seller could bulk-delete a listing with a pending/shipped order.
**Recommendation:** LOG as a product bug. The test asserts current behavior but flags this gap.

### FINDING 4: bulkDeleteListings omits `deleted_at` timestamp
**Severity:** LOW (inconsistency)
**Details:** Single `deleteListing` sets `deleted_at: new Date()`. Bulk delete only sets `status: 'deleted'` without `deleted_at`. Historical data queries relying on `deleted_at` will miss bulk-deleted listings.

### FINDING 5: bulkUpdateListings silently drops status/price when percent also provided
**Severity:** LOW (surprising behavior)
**Details:** If a request includes both `status`/`price` AND `price_adjustment_percent`, the percent path takes an early return (line 1330) and the status/price changes in `updateData` are never applied.

### FINDING 6: Featured listings only shows pro-store listings
**Severity:** INFO (design decision, not a bug)
**Details:** The `getFeaturedListings` query includes `users: { is_pro_store: true }`, meaning only listings from pro-store sellers appear on the home screen featured section. This is presumably intentional for the current pro-store launch strategy. The existing salvaged test at line 1247 asserts `where: { status: 'active' }` which is incomplete — the actual where also includes the pro-store filter. Fixed in the correction.

### FINDING 7: trackView route has no auth middleware — self-view skip is unreachable via HTTP
**Severity:** LOW (already documented in salvaged integration test)
**Details:** The `/listings/:id/view` route is registered without `authenticateToken`, so `req.user` is never populated even if the client sends a Bearer token. The controller's seller self-view skip (branch V2) is unreachable via the route. The unit test covers this branch directly by injecting `req.user`, which is correct for unit testing the logic. The integration test documents this gap with a comment.

### FINDING 8: Six test files referenced in the brief do not exist
**Severity:** INFO (task scoping)
**Details:** `publishListing.test.ts`, `draftVisibility.test.ts`, `csvImport.test.ts`, `importDedupDraft.test.ts`, `importUpsert.test.ts`, `offSale.test.ts` — none of these exist on main or anywhere in the repo. The features they would test (draft/publish workflow, CSV import, off-sale) are not implemented in `listingController.ts`.

---

## INTEGRATION FILE ASSESSMENT

**File:** `origin/task/listing-suite-salvage:src/__tests__/integration/listing.integration.test.ts`

### What it does
Uses supertest to drive the real Express router (listingRoutes) with all production middleware (auth, validation, rate limiting, multer). All backend dependencies (Prisma, S3, Sharp) are mocked. This is NOT a true integration test per the project's definition — it tests middleware-stack integration, not real dev services.

### Is it safe?
**YES** — it connects to nothing real:
- Prisma is fully mocked (no DB connection)
- S3 is fully mocked (no AWS calls)
- Sharp is fully mocked
- Auth uses test JWTs signed with a test secret
- No environment variables beyond `JWT_SECRET` (set in-test)

### Placement concern
It is currently in `src/__tests__/integration/` which means it will run in the `integration` Jest project. Per the CI configuration, only the `unit` project runs in CI. Since this file needs no DB/secrets, it COULD run in the unit tier. However, moving it would change CI scope and should be a deliberate decision.

### Missing conventions
- ❌ Does NOT have `test0Y91_` prefix (not needed — creates no persistent data)
- ❌ Does NOT have dev-only guard (not needed — connects to nothing)
- ✅ Does NOT perform teardown (correct — there's nothing to tear down)

### Recommendation
**HOLD this file as-is.** It is safe and useful but misnamed. Options for Harry:
1. **Move to unit tier** — rename to `listing.middleware.test.ts` in `src/__tests__/unit/`. This adds 38 tests to CI on every push. The tests are fast (~2s) and deterministic.
2. **Keep in integration tier** — it won't run in CI but can be run locally. Downside: these middleware tests won't catch regressions automatically.

**Decision needed from Harry — escalated above.**

---

## KNOWN CORRECTIONS APPLIED

### 1. getFeaturedListings take: 20 → 30
- **Test:** "hits prisma with take=30 for pro-store active listings"
- **Old assertion:** `expect(args.take).toBe(20)` and `expect(args.where).toEqual({ status: 'active' })`
- **New assertion:** `expect(args.take).toBe(30)` and `expect(args.where).toEqual({ status: 'active', users: { is_pro_store: true } })`
- **Comment added:** "30 confirmed by policy owner, 12 Jul 2026."

### 2. deleteListing S3 retention policy
- **Test:** Renamed to "soft-deletes listing and retains S3 images (policy: images are never deleted)"
- **Old assertion:** `expect(mockedS3.deleteImage).toHaveBeenCalledWith(testImage.s3_key)` and `expect(mockPrisma.listings.delete).toHaveBeenCalledWith(...)`
- **New assertion:** `expect(mockedS3.deleteImage).not.toHaveBeenCalled()` + verify `listings.update` with `{ status: 'deleted', deleted_at, updated_at }`
- **Tripwire comment:** "POLICY (Harry, 12 Jul 2026): S3 images are RETAINED when a listing is deleted. A failure here means someone added S3 cleanup — that is a POLICY BREACH, not a bug fix. Escalate before reverting."

### 3. Additional delete test corrections
- All tests in the `deleteListing` describe block that mocked `listings.delete` have been updated to mock `listings.update` instead, since the controller performs a soft delete via `update`, not a hard `delete`.

---

## QUESTIONS FOR HARRY

### Q1: Integration test file placement
**Task:** Reviewing salvaged `listing.integration.test.ts`
**Question:** Should this file be moved to the unit tier (`src/__tests__/unit/listing.middleware.test.ts`) so it runs in CI, or kept in the integration tier where it won't run automatically?
**Options:** (A) Move to unit — adds 38 middleware+validation tests to CI. (B) Keep in integration — manual-only.
**My recommendation:** Move to unit. These tests are fast, deterministic, and catch real regressions (auth bypass, validation schema drift, rate limit changes).
**Blocked:** No — the unit test work proceeds either way.

### Q2: Missing spec for listing rules
**Task:** Asserting expected values from the spec
**Question:** Section 9 (Listing Rules) in business-logic-v2.md is unwritten. For this suite, I've used the Zod validation schema and Prisma schema defaults as secondary sources. Are these acceptable as spec for test expectations?
**Options:** (A) Yes, treat Zod+Prisma as spec for now. (B) Write Section 9 first, then revisit tests.
**My recommendation:** (A) for now — the Zod schema IS the validation spec in practice.
**Blocked:** No — I've proceeded with (A) and flagged where ambiguity exists.

### Q3: updateListing accepts arbitrary status values
**Task:** Testing status update via PUT /listings/:id
**Question:** The controller accepts any status string via update (no validation). The Zod updateListingSchema defines `status: z.enum(['active', 'sold', 'reserved', 'removed'])` but this validation is NOT wired into the PUT route (route uses `authenticateToken` only, no `validate(updateListingSchema)`). Should the test assert that arbitrary status values are accepted (current behavior) or that only valid statuses are accepted (intended behavior)?
**Options:** (A) Assert current behavior, file a bug for missing validation middleware. (B) Assert the Zod restriction, let test fail as a finding.
**My recommendation:** (A) — assert what the controller actually does, and file the missing validation middleware as a finding.
**FINDING:** The PUT /listings/:id route does NOT use `validate(updateListingSchema)`. The schema exists but is never wired in.
**Blocked:** No — I've gone with (A).

### Q4: is_negotiable default mismatch
**Task:** Testing create listing defaults
**Question:** The controller defaults `is_negotiable` to `false` when omitted, but the Prisma schema defaults it to `true` (`@default(true)`). Which is correct? The controller's explicit `false` overrides the DB default.
**Options:** (A) Controller's `false` is correct (explicit design choice). (B) Prisma's `true` is correct (controller has a bug).
**My recommendation:** Cannot determine without Section 9 spec. The existing test asserts `false` (controller behavior). Leaving as-is.
**Blocked:** No.

---

## VERIFICATION OUTPUT

### 1. Listing-specific unit tests

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --testPathPatterns "listing" --runInBand --ci

Test Suites: 1 passed, 1 total
Tests:       104 passed, 104 total
Snapshots:   0 total
Time:        2.204 s
```

All 104 listing tests pass (70 salvaged + corrections + 34 new).

### 2. Type check

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx tsc --noEmit
(no output — clean)
```

### 3. Full unit suite (all projects)

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --runInBand --ci

Test Suites: 9 passed, 9 total
Tests:       2 skipped, 2 todo, 426 passed, 430 total
Snapshots:   0 total
Time:        1.575 s
```

No regressions. The 6 brief-listed test files (publishListing, draftVisibility,
csvImport, importDedupDraft, importUpsert, offSale) do not exist in the repo —
confirmed via find and grep. They were listed in the brief but never created.

### 4. Notes on known corrections applied

| # | What changed | Old assertion | New assertion | Source |
|---|---|---|---|---|
| 1 | getFeaturedListings take | `toBe(20)` | `toBe(30)` | Policy owner Harry, 12 Jul 2026 |
| 2 | deleteListing S3 | `toHaveBeenCalledWith(s3_key)` | `not.toHaveBeenCalled()` | Policy owner Harry, 12 Jul 2026 |
| 3 | deleteListing mock | `listings.delete` | `listings.update` (soft delete) | Controller code — code uses update, not delete |
