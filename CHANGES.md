# I-02 — CSV Adapter + Import Service (lands drafts)

**Branch:** `task/pro-import-i02-service` off `origin/pro-seller-foundation`
**Start SHA:** `621f1f6dcaa7af91b7ae47eaa8fdf06b721f7045`
**Base-tip SHA:** `621f1f6dcaa7af91b7ae47eaa8fdf06b721f7045` (fresh base, I-01+I-01a merged)
**Repo:** `Mulligans-Backend`
**Date:** 2026-06-23

---

## I-01 Gate — PASSED

- `grep external_source prisma/schema.prisma` → line 106 ✓
- `grep external_id prisma/schema.prisma` → line 107 ✓
- `createListingSchema` accepts `status: z.enum(['active', 'draft'])` → line 69 ✓
- `listings_external_dedup` migration → `prisma/migrations/20260623000000_listing_import_dedup/migration.sql` ✓

---

## Files Changed

```
src/services/csvAdapter.ts          | new  (CSV parsing + normalization → IncomingListing[])
src/services/importService.ts       | new  (Zod validation + batch Prisma create)
src/controllers/importController.ts | new  (POST /api/listings/import handler)
src/routes/listingRoutes.ts         | +12  (import route + importLimiter + ImportController import)
src/__tests__/unit/csvImport.test.ts| new  (13 tests)
src/__tests__/unit/draftVisibility.test.ts | +1 (multer mock: add .single())
CHANGES.md                          | this file
questions.md                        | +  security scan, dep note, hash inputs
package.json                        | +1 (csv-parse dependency)
package-lock.json                   | churn (csv-parse added)
```

No changes to: `checkoutState.ts`, any Stripe/transfer/refund/escrow code, fee calculations, or any money path.

---

## Change 1: `csvAdapter.ts` (new)

**File:** `src/services/csvAdapter.ts`

Parses a CSV buffer → `AdapterResult { rows: IncomingListing[], failed: [...], warnings: [...] }`.

Per-row normalization:
- **category**: case-insensitive match against the live 8-value enum. `'Shafts Grips & Heads'` → `'Shafts, Grips & Heads'` (comma fix). Unknown categories → row rejected with clear message.
- **condition**: `New`→5, `Like New`→4, `Very Good`→3, `Good`→2, `Fair`→1. Unknown → warning, field skipped.
- **parcel_size**: `Small`→`small`, `Medium`→`medium`, `Large`→`large`, `Extra Large`→`extra_large`, `Oversized`→`oversized`. **Required** — missing/invalid → row rejected.
- **shipping_cost**: seller-set number 0–100. **Required** — not derived from any fixed map.
- **subcategory**: **Required** (backend Zod enforces this).
- **spec fields**: `club_type, shaft_flex, shaft_material, loft, lie_angle, shaft_length, dexterity, size, gender, colour` → assembled into `specifications` JSON.
- **accepts_offers** → `is_negotiable` boolean.
- **quantity**: optional, int 1–999, default 1.
- **sku** → `external_id`. If absent, content hash (see below).
- **auto_decline_threshold**: DROPPED (dead column).

### `external_id` derivation

- If `sku` column present: `external_id = sku`
- If absent: SHA-256(first 16 hex chars) of `normalize(title)|normalize(brand)|normalize(model)|normalize(category)|price` where normalize = `trim().toLowerCase()`.

Stable across re-imports — the same row always produces the same hash.

## Change 2: `importService.ts` (new)

**File:** `src/services/importService.ts`

Takes `IncomingListing[]` + `sellerId` → `ImportResult { created, failed, warnings }`.

- Validates each row against the **real** `createListingSchema` (imported from `middleware/validation.ts`). Not a reimplemented copy.
- Creates each valid listing via `prisma.listings.create` with the same data shape as `listingController.createListing` (same fields, same attribute-saving logic).
- All listings created with `status: 'draft'`, `external_source: 'csv'`, `external_id` from adapter.
- Duplicate handling: catches Prisma `P2002` on `listings_external_dedup` → records row as `failed` with `reason: 'duplicate'`, continues batch.
- One bad row doesn't sink the import.

## Change 3: `importController.ts` (new)

**File:** `src/controllers/importController.ts`

`POST /api/listings/import` handler:
1. Reads CSV from `req.file.buffer`
2. Passes to `parseCsv()` → gets adapter results
3. Checks `totalParsedRows > 200` → 400 before any creation
4. Calls `importListings(rows, req.user.id, ...)` → 200 with result JSON

## Change 4: Route wiring

**File:** `src/routes/listingRoutes.ts`

- Added `importLimiter` (5 imports/hour)
- Added `upload.single('file')` for CSV upload (reuses existing multer instance, 5 MB limit)
- Route: `POST /import` → `authenticateToken → importLimiter → upload.single('file') → ImportController.importCsv`
- Placed before `/:id` routes to avoid parameter capture.

## Change 5: Dependency

`csv-parse` v7 added to `dependencies`. Used via `csv-parse/sync` for synchronous CSV parsing. Pure JS, MIT licensed.

---

## Import Limits

| Limit | Value | Enforced at |
|-------|-------|-------------|
| Max rows | 200 | Controller (before creation) |
| Max file size | 5 MB | multer limits |
| Rate limit | 5/hour | `importLimiter` |
| Auth | Required | `authenticateToken` |
| Ownership | `req.user.id` only | Controller (no seller_id param) |

---

## Tests — 13 total

| # | Test | Proves |
|---|------|--------|
| 1 | Valid CSV → all created as draft | Core pipeline works; status=draft, external_source=csv |
| 2 | Re-run same CSV → duplicates | Dedup index catches re-imports |
| 3 | Unknown category → row fails, rest succeed | Per-row isolation; category validation |
| 4 | Missing required fields → rows fail | title/price/subcategory/parcel_size/shipping_cost all required |
| 5 | 201 rows → parsed (controller cap tested separately) | Row count available for cap check |
| 6 | parcel_size: Small→small, Extra Large→extra_large | Normalization to lowercase enum |
| 7 | category: Shafts Grips & Heads → Shafts, Grips & Heads | Comma fix for web wizard mismatch |
| 8 | shipping_cost from row, not overwritten | Seller-set shipping preserved end-to-end |
| 9 | condition: Like New → 4, Fair → 1 | Condition mapping |
| 10 | sku → external_id; no sku → stable content hash | Dedup key derivation + stability |
| 11 | Created listings are status:draft | Draft safety (I-01 guarantees public exclusion) |
| 12 | Spec fields → specifications JSON | Field assembly |
| 13 | accepts_offers → is_negotiable | Boolean mapping |

### Teeth checks:
- Test 2 FAILS if the service's duplicate-handling branch is removed (but see note: the mock simulates the constraint — real proof is the dev re-import)
- Test 8 FAILS if shipping_cost is overwritten by a fixed map
- Test 10 FAILS if content hash changes (different inputs or algorithm)
- Test 11 FAILS if status is changed from 'draft'
- Test 14 FAILS if IDs are not valid v4 UUIDs or if any collision exists
- Test 15 FAILS if PK-collision P2002 is mislabelled as 'duplicate'

---

## I-02a Amendment — ID generation + honest dedup test

**Amend SHA:** `f9a58d5` (I-02 commit)
**Date:** 2026-06-23

### Why this amendment exists

1. **Bug — ID generation.** `importService` used `lst_${Date.now()}_${Math.random().toString(36).substr(2,9)}` for listing IDs and the same pattern for attribute IDs. In a 200-row import loop `Date.now()` repeats for many rows, so collision protection rested on `Math.random()`. A collision would throw P2002 on the primary key, which the catch block mislabelled as a generic error. `substr` is also deprecated.
2. **Toothless test.** Test 2 (dedup) used a hand-written Prisma mock that re-implemented the dedup check in JS. The test proved the mock, not the constraint — it would stay green even if the real DB index was dropped. (Anti-pattern rule 1: never mock the behaviour the test claims to prove.)

### Change A1: UUIDs for all generated IDs

**File:** `src/services/importService.ts`

- Listing IDs: `uuidv4()` (was `lst_${Date.now()}_...`)
- Attribute IDs: `uuidv4()` (was `attr_${Date.now()}_...`)
- Import: `import { v4 as uuidv4 } from 'uuid'` — matches the existing repo style (`disputeController.ts`, `s3Service.ts`, etc.)
- `uuid` is already a dependency — no `package.json` change.

### Change A2: Catch block distinguishes error codes

**File:** `src/services/importService.ts`

- P2002 with `target` including `listings_external_dedup` → `reason: 'duplicate'` (unchanged)
- P2002 with any other target (e.g. PK collision) → `reason: 'id collision (constraint: <target>) — retry'`
- Non-P2002 errors → `reason: err.message` (unchanged)

### Change A3: Test 2 relabelled as mock-level

**File:** `src/__tests__/unit/csvImport.test.ts`

- Renamed to `'2. re-run same CSV → service surfaces duplicate reason (mock-level; real index proven on dev)'`
- Added inline comment stating the Prisma mock simulates the constraint, real proof is the dev re-import in `questions.md`.
- Test is kept (it still checks the service's duplicate-handling branch wires through correctly) — it just no longer masquerades as constraint proof.

### Change A4: Two new tests

| # | Test | Proves |
|---|------|--------|
| 14 | Listing and attribute IDs are distinct valid UUIDs | No Date.now() collision surface; all IDs are v4 UUIDs and globally unique across listings + attributes |
| 15 | PK-collision P2002 (non-dedup target) → distinct reason, not 'duplicate' | Catch block classifies correctly — this IS unit-testable because the classification logic is the thing under test |

### Change A5: Dev re-import verification step

**File:** `questions.md` — added explicit dev verification: import a small CSV twice via `POST /api/listings/import`, confirm first import creates and second import fails all rows with `reason: 'duplicate'`. This — not the unit test — is the proof the index enforces dedup.

---

## Verification

- `npx tsc --noEmit` — clean
- `npx jest --selectProjects unit` — 361 pass, 2 skip (pre-existing registration.test.ts TS error, unrelated)
- `package-lock.json` unchanged (uuid already a dependency)
- No changes to: checkout, payment, escrow, refund, fee, or Stripe code
- Files touched: `importService.ts`, `csvImport.test.ts`, `CHANGES.md`, `questions.md` — nothing else
