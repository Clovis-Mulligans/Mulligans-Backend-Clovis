# I-01 — Schema: Import Dedup Fields + Safe `draft` Status

**Branch:** `task/pro-import-i01-schema` off `clovis/pro-seller-foundation`
**Start SHA:** `dc3891965d4925939175e5ce8cab63af63b0e30b`
**Base-tip SHA:** `dc3891965d4925939175e5ce8cab63af63b0e30b` (confirms fresh base)
**Repo:** `Mulligans-Backend`
**Date:** 2026-06-23

---

## Files Changed

```
prisma/schema.prisma                                          | +2  (external_source, external_id)
prisma/migrations/20260623000000_listing_import_dedup/         | new (migration SQL)
src/middleware/validation.ts                                   | +2  (status in create + update schemas)
src/controllers/listingController.ts                          | +5  (status from body, draft owner gate)
src/lib/cartValidation.ts                                     | +1  ('draft' in ListingStatus type)
src/__tests__/unit/importDedupDraft.test.ts                   | new (15 tests)
CHANGES.md                                                    | this file
```

No changes to: `package.json`, `package-lock.json`, `checkoutState.ts`, any Stripe/transfer/refund/escrow code, fee calculations, or any money path.

---

## Change 1: Prisma Schema — `external_source` + `external_id`

**File:** `prisma/schema.prisma` (model listings, after `deleted_at`)

```prisma
external_source     String?
external_id         String?
```

Both nullable. Existing listings get NULL. No `@@unique` in Prisma — the dedup index is partial (see Change 2).

## Change 2: Migration — Partial Unique Index

**Folder:** `prisma/migrations/20260623000000_listing_import_dedup/migration.sql`

```sql
ALTER TABLE "listings" ADD COLUMN "external_source" TEXT;
ALTER TABLE "listings" ADD COLUMN "external_id" TEXT;

CREATE UNIQUE INDEX "listings_external_dedup"
  ON "listings" ("seller_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL;
```

Partial index: only applies when `external_source IS NOT NULL`. Existing listings (NULL external_source) are unaffected — the constraint only catches duplicate imports.

## Change 3: Validation — `status` on Create + Update

**File:** `src/middleware/validation.ts`

- **createListingSchema** (line 69): Added `status: z.enum(['active', 'draft']).optional().default('active')`. Backward-compatible — omitting `status` defaults to `'active'`.
- **updateListingSchema** (line 91): Added `'draft'` to existing enum → `z.enum(['active', 'sold', 'reserved', 'removed', 'draft']).optional()`.

`'sold_elsewhere'` is NOT added — that belongs to I-04.

## Change 4: Controller — Use Validated Status

**File:** `src/controllers/listingController.ts`

- Added `status` to the destructured body (line 184).
- Changed line 234 from `status: 'active'` to `status: status ?? 'active'`. The `??` is a safety net — the Zod `.default('active')` already ensures a value, but `??` catches any edge case.

## Change 5: Draft Safety — `getListingById` Owner Gate

**File:** `src/controllers/listingController.ts` (lines 838-842)

```ts
const viewerId = req.user?.id;
if (listing.status === 'draft' && listing.seller_id !== viewerId) {
  res.status(404).json({ error: 'Listing not found' });
  return;
}
```

Non-owner requesting a draft listing → 404 (does not reveal existence). Owner → normal 200 response.

Also removed a duplicate `const viewerId` declaration at the former line 872 (offer lookup section), which now reuses the earlier declaration.

## Change 6: `ListingStatus` Type

**File:** `src/lib/cartValidation.ts` (line 11)

Added `'draft'` to the `ListingStatus` union type. The existing `validateListingForCart` and `validateCheckout` functions already check `listing.status !== 'active'`, so drafts are automatically rejected by both — no logic change needed.

---

## Public Query Audit — Draft Exclusion

Every public-facing query was checked for `status: 'active'` filter:

| Query | File:line | Filter | Result |
|-------|----------|--------|--------|
| `getFeaturedListings` | `listingController.ts:58` | `status: 'active'` | Already excludes drafts |
| `getAllListings` (search/browse) | `listingController.ts:462` | `status: 'active'` | Already excludes drafts |
| `getSellerListings` (public profile) | `listingController.ts:919` | `status: 'active'` | Already excludes drafts |
| `getUserListings` (public profile) | `userController.ts:904` | `status: 'active'` | Already excludes drafts |
| `getMyListings` (dashboard, auth'd) | `userController.ts:802-806` | Status from query param; no filter = all | Correct: owner sees own drafts |

## Cart + Checkout Audit — Draft Blocked

| Path | File:line | Guard | Result |
|------|----------|-------|--------|
| `addToCart` | `cartController.ts:331` | `listing.status !== 'active'` → 400 | Blocks drafts |
| Cart checkout entry | `cartCheckoutController.ts:153` | `item.listings.status !== 'active'` → reject | Blocks drafts |
| Per-seller checkout | `cartCheckoutController.ts:549` | `item.listings.status === 'active'` filter | Excludes drafts |
| Stripe single-item | `stripeController.ts:137` | `listing.status !== 'active'` → 400 | Blocks drafts |
| Native single-item | `nativePaymentController.ts:133` | `listing.status !== 'active'` → 400 | Blocks drafts |
| Native per-seller | `nativePaymentController.ts:525` | `item.listings.status === 'active'` filter | Excludes drafts |
| Native cart | `nativePaymentController.ts:369` | `item.listings.status !== 'active'` → reject | Blocks drafts |

All checkout paths already gate on `status === 'active'`. No changes needed to any checkout/payment code.

---

## Tests — 15 total

### Create schema — status field (5 tests)
1. `status: 'draft'` → stored as `'draft'`
2. No status → defaults to `'active'`
3. `status: 'active'` → `'active'`
4. `status: 'sold'` → rejected on create
5. `status: 'sold_elsewhere'` → rejected (not in this slice)

### Update schema — draft in enum (2 tests)
6. `'draft'` accepted in update
7. `'active'` still accepted in update

### Migration SQL shape (3 tests)
8. Adds `external_source` column
9. Adds `external_id` column
10. Creates partial unique index with correct columns and WHERE clause

### Cart validation — draft rejected (2 tests)
11. Draft listing → `listing_inactive` error
12. Active listing → valid (baseline)

### Checkout validation — draft blocked (3 tests)
13. Cart with draft → unavailable, not proceedable
14. Cart with active → proceedable (baseline)
15. Mixed cart (active + draft) → not proceedable, only draft in unavailable

### Teeth-checks:
- Tests 1, 4, 5 FAIL if the `z.enum` is wrong (wrong values accepted/rejected)
- Test 2 FAILS if the `.default('active')` is removed
- Tests 11, 13, 15 FAIL if `validateListingForCart`/`validateCheckout` stops checking `status !== 'active'`
- Test 14 FAILS if active listings are incorrectly blocked

---

## Verification

- `npx tsc --noEmit` — clean
- `npx jest --selectProjects unit` — 341 pass, 2 skip (pre-existing registration.test.ts TS error, unrelated)
- `package-lock.json` unchanged
