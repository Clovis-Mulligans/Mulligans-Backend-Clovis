# CHANGES — task/admin-stats-status-filter-fix

**Branched from:** `pro-seller-foundation` @ `8da6a9c8f9a863e0ab3cdf439302e847b4e4f6a4`

## Summary

Fixed admin dashboard money-metric queries that filtered on phantom statuses (`shipped`, `paid` — 0 rows in prod) while omitting real in-flight statuses (`to_ship`, `in_transit`, `disputed`). This made 9 real paid orders invisible to GMV, revenue, fees, and pending escrow.

## Per-metric status mapping (before → after)

### GMV (Gross Merchandise Value) — all genuine sales
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:76,84,93`
- **After:** `status IN ('completed','delivered','in_transit','to_ship','disputed')` — `adminStatsController.ts:13` (exported `GMV_STATUSES`)
- **Rationale:** `shipped` and `paid` match 0 rows. `to_ship` (6 orders), `in_transit` (3), and `disputed` (1) are genuine sales that should count toward total goods sold. Disputed orders remain in GMV because the goods were sold; if the operator later wants disputed excluded, it's a one-line change to `GMV_STATUSES`.

### Pending escrow — money held, not yet released to sellers
- **Before:** `status IN ('paid','shipped')` — `adminStatsController.ts:125`
- **After:** `status IN ('to_ship','in_transit','delivered')` — `adminStatsController.ts:15` (exported `PENDING_ESCROW_STATUSES`)
- **Rationale:** Both phantom statuses matched 0 rows, so pending escrow always showed £0. The real pending states are orders that are paid but not yet `completed` (i.e. escrow not released). `delivered` is included because escrow is held for 3 days after delivery before auto-release.
- **Escrow field choice:** The schema has `escrow_release_at` (DateTime?) on orders. For `to_ship` and `in_transit`, this field is NULL (not yet scheduled). For `delivered`, it's set to a future date. Status-based filtering is clearer for the dashboard's purposes and doesn't require a comparison against `now()`. Noted for operator awareness.

### Realised revenue — money actually settled to the platform
- **Before:** Not separately tracked (lumped into GMV)
- **After:** `status = 'completed'` only — `adminStatsController.ts:14` (exported `REALISED_STATUSES`)
- **New fields:** `realisedRevenue` in `getStats` response, `realisedGMV` in `getDetailedStats` response

### Mulligans fee revenue — gross vs realised
- **Before:** Single `estimatedFees` field using the (buggy) GMV filter — `adminStatsController.ts:400`
- **After:** Two explicit fields:
  - `grossFees` = fees across the GMV set (all genuine sales): `totalGMV * 7.5% + orderCount * £0.99`
  - `realisedFees` = fees on completed orders only: `realisedGMV * 7.5% + completedCount * £0.99`
- **Dashboard impact:** The old `estimatedFees` field has been replaced by `grossFees` and `realisedFees` in both `getStats` and `getDetailedStats` responses. The dashboard frontend may need updating to display both or choose one.

### Today's revenue
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:111`
- **After:** Uses GMV definition (`GMV_STATUSES`)

### Chart data (revenue and GMV time-series)
- **Before:** Raw SQL `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:200,219`
- **After:** `status IN ('completed','delivered','in_transit','to_ship','disputed')` in all raw SQL

### Average order value
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:134`
- **After:** Uses `GMV_STATUSES`

### Category breakdown (both in getChartData and getDetailedStats)
- **Before:** `status IN ('completed','delivered','shipped','paid')` — `adminStatsController.ts:288,549`
- **After:** Uses `GMV_STATUSES`

## Deliberately NOT changed

- **Orders count** (`totalOrders`, `ordersThisWeek`, `ordersLastWeek`, `todayOrders`): No status filter — counts all orders. This is correct.
- **Verified sellers** (`verifiedSellers`): Queries `users.is_verified_seller`. The audit indicates this is likely a real data fact (nobody manually verified each seller record), not a query bug. **Operator should check:** is the count plausible? Are the right users marked `is_verified_seller=true`?
- **Recent Activity feed**: Out of scope. It only shows disputes/reports/claims, not orders — a design gap, not a filter bug. Separate follow-up task.
- **`soldOrders` raw SQL** (avg days to sell): Uses `status IN ('completed','delivered')` — this is correct for measuring actual sale-to-delivery time.

## Correctness verification

With the corrected GMV filter, the 9 previously-omitted orders are now included:
- `to_ship`: 6 orders (was excluded — no `paid` status exists)
- `in_transit`: 3 orders (was excluded — no `shipped` status exists)
- `disputed`: 1 order (was excluded)

Total GMV-eligible orders: 18 (completed) + 2 (delivered) + 6 (to_ship) + 3 (in_transit) + 1 (disputed) = 30 orders (was 20, only completed + delivered matched before since shipped/paid = 0 rows).

Pending escrow now correctly captures the 11 orders with held funds: 6 (to_ship) + 3 (in_transit) + 2 (delivered) = 11 orders (was 0 — both `paid` and `shipped` = 0 rows).

## Files changed

| File | Change |
|------|--------|
| `src/controllers/adminStatsController.ts` | Fixed all status filters, added exported status constants, added realised revenue + gross/realised fees |
| `src/__tests__/unit/adminStatsStatusFilter.test.ts` | New test file — 22 tests covering status-set correctness, aggregation logic, phantom-status regression |
| `CHANGES.md` | This file |
| `output/questions-admin-stats-status-filter-fix.md` | Security scan + operator questions |
