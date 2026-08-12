# CHANGES — task/admin-stats-status-filter-fix-main

**Branched from:** `main` @ `0a84e23245911f8cd43a89eee6a50f553c8633e9`

## Summary

Fixed admin dashboard money-metric queries that filtered on phantom statuses (`shipped`, `paid` — 0 rows in prod) while omitting real in-flight statuses (`to_ship`, `in_transit`, `disputed`). This made 9 real paid orders invisible to GMV, revenue, fees, and pending escrow.

This is the same logical fix as `task/admin-stats-status-filter-fix` (pro-seller-foundation branch), re-derived directly against `main` with zero pro-seller dependencies. The pro-seller branch was not merged or referenced.

## Per-metric status mapping (before → after)

### GMV (Gross Merchandise Value) — all genuine sales
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:75,83,92`
- **After:** `status IN ('completed','delivered','in_transit','to_ship','disputed')` — `adminStatsController.ts:13` (exported `GMV_STATUSES`)
- **Rationale:** `shipped` and `paid` match 0 rows. `to_ship` (6 orders), `in_transit` (3), and `disputed` (1) are genuine sales that should count toward total goods sold. Disputed orders remain in GMV because the goods were sold; if the operator later wants disputed excluded, it's a one-line change to `GMV_STATUSES`.

### Pending escrow — money held, not yet released to sellers
- **Before:** `status IN ('paid','shipped')` — `adminStatsController.ts:124`
- **After:** `status IN ('to_ship','in_transit','delivered')` — `adminStatsController.ts:15` (exported `PENDING_ESCROW_STATUSES`)
- **Rationale:** Both phantom statuses matched 0 rows, so pending escrow always showed £0. The real pending states are orders that are paid but not yet `completed` (i.e. escrow not released). `delivered` is included because escrow is held for 3 days after delivery before auto-release.
- **Escrow field choice:** The schema has `escrow_release_at` (DateTime?) on orders. For `to_ship` and `in_transit`, this field is NULL (not yet scheduled). For `delivered`, it's set to a future date. Status-based filtering is clearer for the dashboard's purposes and doesn't require a comparison against `now()`. See questions file for operator verification.

### Realised revenue — money actually settled to the platform
- **Before:** Not separately tracked (lumped into GMV)
- **After:** `status = 'completed'` only — `adminStatsController.ts:14` (exported `REALISED_STATUSES`)
- **New fields:** `realisedRevenue` in `getStats` response; `realisedGMV` in `getDetailedStats` response

### Mulligans fee revenue — gross vs realised
- **Before:** Single `estimatedFees` field using literal `0.075` and `0.99` with the buggy GMV filter — `adminStatsController.ts:400`
- **After:** Three fields in `getDetailedStats` response:
  - `estimatedFees` — **kept for backward compat** (now equals `grossFees`; `analytics.html` reads this)
  - `grossFees` — fees across the GMV set: `totalGMV * 7.5% + orderCount * £0.99`
  - `realisedFees` — fees on completed orders only: `realisedGMV * 7.5% + completedCount * £0.99`
- Now uses `BUYER_PROTECTION_RATE` and `SERVICE_FEE_PER_ITEM` from `src/lib/feeCalculations.ts` (these already exist on `main`) instead of literal `0.075`/`0.99`.

### Today's revenue — `adminStatsController.ts:110`
- **Before:** `status IN ('completed','delivered','shipped','paid')`
- **After:** Uses GMV definition (`GMV_STATUSES`)

### Chart data (revenue and GMV time-series) — raw SQL
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:199,218`
- **After:** `status IN ('completed','delivered','in_transit','to_ship','disputed')`

### Average order value — `adminStatsController.ts:133`
- **Before:** `status IN ('completed','delivered','shipped','paid')`
- **After:** Uses `GMV_STATUSES`

### Category breakdown (in getChartData and getDetailedStats)
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:287,548`
- **After:** Uses `GMV_STATUSES`

### `validOrderStatuses` in getDetailedStats — `adminStatsController.ts:369`
- **Before:** `['completed', 'delivered', 'shipped', 'paid']`
- **After:** `[...GMV_STATUSES]`

### Time-series raw SQL in getDetailedStats — `adminStatsController.ts:458`
- **Before:** `status IN ('completed','delivered','shipped','paid')`
- **After:** `status IN ('completed','delivered','in_transit','to_ship','disputed')`

## Frontend HTML updates

### `public/admin/analytics.html` — display-only changes
1. **Fee card relabelled:** "Mulligans Fee Revenue" → "Gross Fee Revenue" with sub "7.5% + £0.99 across all sales"
2. **New card added:** "Realised Fee Revenue" showing `revenue.realisedFees` with sub "Fees on completed orders only"
3. **JS `renderMetrics`:** reads `revenue.grossFees || revenue.estimatedFees` (fallback ensures compat if old API served), plus `revenue.realisedFees`
4. **CSV export:** adds "Realised Fee Revenue" row; renames "Estimated Fee Revenue" → "Gross Fee Revenue"

### NOT touched (confirmed)
- `public/admin/index.html` — reads `totalGMV`, `todayRevenue`, `pendingEscrow`, `avgOrderValue` etc. from `getStats`. These field names are unchanged; only the underlying queries changed. No HTML edit needed.
- `public/admin/disputes.html` — safety page, not touched
- `public/admin/returns.html` — safety page, not touched
- `public/admin/claims.html` — safety page, not touched
- `public/admin/reports.html` — safety page, not touched
- `public/admin/users.html` — reads `verifiedSellers` from a different endpoint; untouched
- `public/admin/pro-store-applications.html` — unrelated; untouched

## Deliberately NOT changed

- **Orders count** (`totalOrders`, `ordersThisWeek`, `ordersLastWeek`, `todayOrders`): No status filter — counts all orders. This is correct.
- **Verified sellers** (`verifiedSellers`): Queries `users.is_verified_seller`. Likely a real data fact — not a query bug. **Operator should check:** is the count plausible?
- **Recent Activity feed**: Out of scope — design gap (only shows disputes/reports/claims, not orders), not a filter bug. Separate follow-up.
- **`soldOrders` raw SQL** (avg days to sell): Uses `status IN ('completed','delivered')` — correct for measuring sale-to-delivery time.
- **Order status breakdown** (`groupBy` at the end of `getDetailedStats`): Already correct — no status filter on the groupBy, just a date filter.

## Correctness verification

With the corrected GMV filter, the 9+ previously-omitted orders are now included:
- `to_ship`: 6 orders (was excluded — phantom `paid` matched 0)
- `in_transit`: 3 orders (was excluded — phantom `shipped` matched 0)
- `disputed`: 1 order (was excluded)

Pending escrow now correctly captures held funds: `to_ship` (6) + `in_transit` (3) + `delivered` (2) = 11 orders (was 0).

## Files changed

| File | Change |
|------|--------|
| `src/controllers/adminStatsController.ts` | Fixed all status filters, added exported status constants, added import for fee constants, added realised revenue + gross/realised fees, kept `estimatedFees` for backward compat |
| `src/__tests__/unit/adminStatsStatusFilter.test.ts` | New test file — 22 tests |
| `public/admin/analytics.html` | Added realised fees card, relabelled gross fees, updated JS rendering + CSV export |
| `CHANGES.md` | This file |
| `output/questions-admin-stats-status-filter-fix-main.md` | Security scan + operator questions |
