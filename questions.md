# Questions — Brief 2: Money-Safety Foundations

## 5A-BUG-1: Legacy orders with seller_payout = NULL

**Count not executed.** Clovis does not have database access (per safety rules).

Harry — please run this read-only query on a staging/prod read-replica:

```sql
SELECT COUNT(*) FROM orders WHERE seller_payout IS NULL AND status NOT IN ('cancelled');
```

This tells us how many active/completed orders used the old fallback formula that underpaid sellers. The fix (routing through `feeCalculations.ts`) is deployed for new disputes, but a backfill of historical `seller_payout` values is a separate decision.

**Recommendation:** If the count is > 0, backfill `seller_payout` for those orders using the `calculateSellerPayout()` formula from `src/lib/feeCalculations.ts`. This is a data migration, not a code change — should be done as a one-off script reviewed before execution.

---

## Security scan — auth/role checks

All touched endpoints retain their existing auth middleware:
- `respondToDispute`: `authenticateToken` + seller ownership check (unchanged)
- `acceptCounterOffer`: `authenticateToken` + buyer ownership check (unchanged)
- `adminResolveDispute`: `adminAuth` middleware (unchanged)
- `confirmReceipt`: `authenticateToken` + buyer ownership check (unchanged)
- Removed `POST /auto-escalate` endpoint (was behind `adminAuth`, now handled by cron only — reduces attack surface)

No new injection or validation gaps introduced. B4 adds upper-bound validation on `resolutionAmount` that was previously missing.

---

## No Tier A items proved larger than scoped

All three Tier A items were implemented as specified. The row-lock pattern (Prisma `$queryRaw` + `SELECT FOR UPDATE` inside `$transaction`) is the standard approach for Prisma's lack of native row-level locking. It adds one raw query per resolution call — negligible overhead given these are low-frequency operations.

---

# Add Memorabilia Category — Backend (5 June 2026)

## Investigation Findings

**File modified:** `src/middleware/validation.ts` (lines 46-54 and 76-84)
- Added `'Memorabilia'` to the `category` z.enum in both `createListingSchema` and `updateListingSchema`.
- `subcategory` is a free-text string field (`z.string().min(1).max(100)`) — NOT an enum. No subcategory change needed on backend.
- No DB migration required — `listings.category` and `listings.subcategory` are varchar columns.

**Files NOT modified (and why):**
- `src/routes/listingRoutes.ts` — uses the schemas via middleware; no direct category references.
- `prisma/schema.prisma` — category/subcategory are String columns, no enum constraint.
- No other validators reference the category enum.

## Security Scan

- **Server-side validation:** Category strings are validated by Zod enum — only canonical strings accepted. Adding `'Memorabilia'` extends the valid set without weakening validation.
- **Rate limiting:** Existing 50 listings/hour rate limit is applied at the route level, not per-category. No bypass possible.
- **No new endpoints:** This change only modifies validation middleware. No new routes created.
- **Subcategory validation:** Backend accepts any string 1-100 chars for subcategory. Client-side enforcement of specific subcategories (Signed Items, Vintage, Other) is the intended pattern, consistent with all existing categories.

## Cross-Platform Notes

- Mobile and web CATEGORIES constants are independent copies — both must be updated in parallel.
- Merge order: backend first (extends accepted values), then mobile + web together (start producing new values).

## Assumptions

1. The additive enum change is backward-compatible — existing categories remain valid.
2. No special brand/model database needed for Memorabilia on the backend — brand and model are optional nullable strings.
