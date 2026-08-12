# Questions — task/admin-stats-status-filter-fix-main

## Security scan

**Read-only queries only — CONFIRMED.** All changes are to `SELECT`/aggregation logic in `adminStatsController.ts`. No writes, no status transitions, no refunds, no payouts, no disputes, no returns. The controller uses `prisma.orders.aggregate`, `prisma.orders.count`, `prisma.orders.groupBy`, and `prisma.$queryRaw` with `SELECT` — all read-only.

**No new routes added.** The existing `GET /admin/stats`, `GET /admin/stats/charts`, and `GET /admin/stats/detailed` routes are unchanged.

**No injection risk.** Raw SQL queries use Prisma tagged template literals (parameterized). Status strings in `IN (...)` clauses are hardcoded literals.

**No auth changes.** Admin middleware is untouched.

**No pro-seller code.** The `BUYER_PROTECTION_RATE` and `SERVICE_FEE_PER_ITEM` constants imported from `feeCalculations.ts` already exist on `main` (verified: `git show main:src/lib/feeCalculations.ts`). No pro-seller-specific code was introduced.

**Frontend changes are display-only.** Only `analytics.html` was modified — added a card for realised fees and relabelled gross fees. No disputes/returns/claims/reports pages touched.

## Operator DB checks needed

### 1. Verified sellers count
The `verifiedSellers` metric queries `users.is_verified_seller = true`. Not changed (per brief). Operator should verify:
- Is the count plausible?
- Run: `SELECT id, email, username, is_verified_seller FROM users WHERE is_verified_seller = true;`
- Is there an automated process setting this flag?

### 2. Escrow field choice
Pending escrow uses `status IN ('to_ship','in_transit','delivered')` rather than `escrow_release_at`. Rationale:
- `to_ship` and `in_transit` have `escrow_release_at = NULL` (not yet scheduled)
- `delivered` has `escrow_release_at` set to a future date (3 days from delivery)
- `disputed` has `escrow_release_at` set to NULL to prevent auto-release — correctly excluded from "pending escrow" (it's contested, not simply pending)
- Status-based filtering is more explicit for dashboard purposes

### 3. Disputed orders in GMV
1 disputed order in prod is now included in GMV. Policy decision — disputed orders represent goods sold until resolved. To exclude, remove `'disputed'` from `GMV_STATUSES`.

### 4. Backward compatibility note
`estimatedFees` is kept in the `getDetailedStats` response (now equals `grossFees`) so `analytics.html` continues working even if the code deploys before the HTML is cached. The HTML has been updated to prefer `grossFees` with `estimatedFees` fallback.
