# CHANGES — `task/admin-exclude-test-orders`

**Branch:** `task/admin-exclude-test-orders`
**Base:** `main` @ `e4858e4`

## Summary

Excludes 18 legacy pre-dev test orders from ALL admin dashboard metrics. Non-destructive read filter only — no order rows were deleted, updated, or modified. The orders remain in the database; they are simply excluded from dashboard queries via `WHERE id NOT IN (...)`.

## Shared constant

`EXCLUDED_ORDER_IDS` — exported from `src/controllers/adminStatsController.ts:20`, containing exactly 18 order IDs. Referenced by a single `excludeTestOrders` helper object at line 49: `{ id: { notIn: [...EXCLUDED_ORDER_IDS] } }`.

Added `import { Prisma } from '@prisma/client'` at line 5 for safe parameterisation of raw SQL queries via `Prisma.join()`.

## Every query that received the exclusion clause

### `getStats` (12 Prisma queries)
- `totalOrders` — `adminStatsController.ts:100`
- `ordersThisWeek` — `adminStatsController.ts:102`
- `ordersLastWeek` — `adminStatsController.ts:106`
- `gmvResult` — `adminStatsController.ts:118`
- `gmvThisWeekResult` — `adminStatsController.ts:127`
- `gmvLastWeekResult` — `adminStatsController.ts:137`
- `todayOrders` — `adminStatsController.ts:149`
- `todayRevenueResult` — `adminStatsController.ts:156`
- `realisedResult` — `adminStatsController.ts:168`
- `gmvOrderCount` — `adminStatsController.ts:177`
- `pendingEscrowResult` — `adminStatsController.ts:191`
- `avgOrderResult` — `adminStatsController.ts:201`

### `getChartData` (3 queries: 2 raw SQL + 1 groupBy)
- `ordersByDay` (raw SQL) — `adminStatsController.ts:274` — `AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})`
- `gmvByDay` (raw SQL) — `adminStatsController.ts:294` — `AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})`
- `categoryBreakdown` (groupBy) — `adminStatsController.ts:361`

### `getDetailedStats` (9 queries: 6 Prisma + 3 raw SQL)
- `gmvResult` — `adminStatsController.ts:451`
- `orderCountResult` — `adminStatsController.ts:458`
- `shippingResult` — `adminStatsController.ts:466`
- `realisedGmvResult` — `adminStatsController.ts:485`
- `realisedCountResult` — `adminStatsController.ts:492`
- `soldOrders` (raw SQL) — `adminStatsController.ts:545` — `AND o.id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})`
- `ordersByDay` (raw SQL) — `adminStatsController.ts:562` — `AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})`
- `categoryBreakdown` (groupBy) — `adminStatsController.ts:650`
- `orderStatusBreakdown` (groupBy) — `adminStatsController.ts:683`

### `getSales` (3 queries via shared `where` object)
- `findMany` — `adminStatsController.ts:757` (shared `where` includes exclusion)
- `count` — `adminStatsController.ts:757` (same shared `where`)
- `aggregate` — `adminStatsController.ts:757` (same shared `where`)

**Total: 27 order queries updated across 4 controller methods.**

## Confirmation

- **NO order rows were deleted or modified.** This is a read-filter only (`WHERE ... NOT IN (...)`).
- **Raw SQL exclusion is parameterised** via `Prisma.join()` template literals — no string interpolation.
- **Exclusion is fully reversible:** remove `EXCLUDED_ORDER_IDS`, `excludeTestOrders`, the `Prisma` import, and the spread/AND clauses, and the orders reappear in all metrics.
- **Tier 1 status logic (`GMV_STATUSES` etc.) is unchanged.** Margin math is unchanged. No routes, HTML pages, or non-stats code was touched.

## Tests added

7 new tests in `src/__tests__/unit/adminSales.test.ts`:

1. `EXCLUDED_ORDER_IDS contains exactly 18 order IDs`
2. `every entry starts with "order_"`
3. `has no duplicate entries`
4. `includes known legacy IDs`
5. `findMany, count, and aggregate all receive id: { notIn: EXCLUDED_ORDER_IDS }` (getSales)
6. `order with an EXCLUDED_ORDER_IDS id does not appear in salesRows`
7. `every order count/aggregate in getStats includes id notIn exclusion`

## Full suite result

```
Test Suites: 16 passed, 16 total
Tests:       2 skipped, 2 todo, 646 passed, 650 total
Snapshots:   0 total
Time:        3.741 s
```

## Files changed
- `src/controllers/adminStatsController.ts` — added `EXCLUDED_ORDER_IDS`, `excludeTestOrders`, `Prisma` import, exclusion clauses on all 27 order queries
- `src/__tests__/unit/adminSales.test.ts` — 7 new test cases for exclusion behaviour
- `CHANGES.md` — this file
