# Questions — task/admin-stats-status-filter-fix

## Security scan

**Read-only queries only — CONFIRMED.** All changes are to `SELECT`/aggregation logic in `adminStatsController.ts`. No writes, no status transitions, no refunds, no payouts, no disputes, no returns. The controller uses `prisma.orders.aggregate`, `prisma.orders.count`, `prisma.orders.groupBy`, and `prisma.$queryRaw` with `SELECT` — all read-only.

**No new routes added.** The existing `GET /admin/stats`, `GET /admin/stats/charts`, and `GET /admin/stats/detailed` routes are unchanged — only the internal query logic was modified.

**No injection risk.** The raw SQL queries use Prisma tagged template literals, which parameterize all interpolated values. The status strings in `IN (...)` clauses are hardcoded literals, not user input.

**No auth changes.** Admin middleware is untouched.

## Operator DB checks needed

### 1. Verified sellers count
The `verifiedSellers` metric queries `users.is_verified_seller = true`. This was not changed (per brief). The operator should verify:
- Is the count plausible?
- Who has `is_verified_seller = true`? Run: `SELECT id, email, username, is_verified_seller FROM users WHERE is_verified_seller = true;`
- Is there an automated process setting this flag, or was it set manually?

### 2. Escrow field choice
Pending escrow uses `status IN ('to_ship','in_transit','delivered')` rather than filtering on `escrow_release_at`. Rationale:
- `to_ship` and `in_transit` have `escrow_release_at = NULL` (not yet scheduled), so a NULL-based query would need `escrow_release_at IS NULL OR escrow_release_at > NOW()`, which also captures `disputed` orders (their `escrow_release_at` is set to NULL to prevent auto-release). Status-based filtering is more explicit.
- If a more precise escrow calculation is needed (e.g. counting only orders where release is scheduled but not yet occurred), a hybrid query could be: `WHERE (status IN ('to_ship','in_transit') OR (status = 'delivered' AND escrow_release_at > NOW()))`. This was not implemented as it adds complexity for negligible difference at current scale.

### 3. Dashboard frontend update
The API response shape changed:
- `getStats` now includes `realisedRevenue`, `grossFees`, `realisedFees` (new fields)
- `getDetailedStats` now returns `revenue.grossFees` and `revenue.realisedFees` instead of `revenue.estimatedFees`, plus `revenue.realisedGMV` (new)
- The dashboard frontend (`Mulligans-Web`) will need updating to display the new fee fields and handle the renamed `estimatedFees` → `grossFees`/`realisedFees`. This is a separate task.

### 4. Disputed orders in GMV
Disputed orders (1 in prod) are included in GMV per this change. The reasoning: a disputed order still represents goods sold until the dispute is resolved. If the operator prefers to exclude disputed orders from GMV, change `GMV_STATUSES` to remove `'disputed'`. This is flagged as a policy decision, not a technical one.
