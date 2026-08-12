# CHANGES — task/admin-sales-page-fix

**Branched from:** `main` @ `c2bb3cd` (the revert of `task/admin-sales-page`)

## Failure reproduced

Before any changes, applied the broken `34b1182` commit via cherry-pick and ran the full suite:

```
NODE_OPTIONS="--max-old-space-size=1536" npx jest --selectProjects unit --runInBand
```

Result: **2 suites failed**, both with the same crash:

```
Route.get() requires a callback function but got a [object Undefined]
  at src/routes/adminRoutes.ts:1807
  router.get('/sales', adminAuth, AdminStatsController.getSales);
```

The failing suites were `platformStats.test.ts` and `paymentMoneySafety.test.ts`.

## Root cause

**NOT a brace error, NOT a circular import, NOT `getSales` outside the class.**

The method `getSales` was correctly placed as a `static async` method inside `AdminStatsController` (confirmed: `ts-node` loads the class and `typeof AdminStatsController.getSales === 'function'`). The braces balanced. There was no circular dependency (`feeCalculations.ts` import already exists on `main`).

**Actual cause:** Two existing test files mock `adminStatsController` with a manual factory object that explicitly lists controller methods — and the mock did not include `getSales`:

1. **`src/__tests__/unit/platformStats.test.ts:93-100`** — mocked `AdminStatsController` with `{ getStats, getChartData, getDetailedStats }` (no `getSales`)
2. **`src/__tests__/unit/paymentMoneySafety.test.ts`** — same: `{ getStats: noop, getChartData: noop, getDetailedStats: noop }` (no `getSales`)

Both files then import `adminRoutes.ts`, which evaluates `AdminStatsController.getSales` at module-load time to register the Express route. Since the mock didn't include `getSales`, it resolved to `undefined`, and `router.get('/sales', adminAuth, undefined)` threw `Route.get() requires a callback function`.

**Why the 18 targeted tests passed:** `adminSales.test.ts` imported `adminStatsController.ts` directly (not through the route module) and never loaded `adminRoutes.ts`. It tested the math correctly but never exercised the route wiring — so the load crash was invisible.

## Fix

1. **Added `getSales: jest.fn()` to the mock in `platformStats.test.ts:98`** — the mock factory now includes all four controller methods.

2. **Added `getSales: noop` to the mock in `paymentMoneySafety.test.ts`** — same fix, matching that file's `noop` convention.

3. **Re-added `getSales` as a `static async` method inside the class** (before the class closing `}`) at `adminStatsController.ts:691`. Identical margin math to the reverted `34b1182`, with the `display_name`/`email` fix already applied.

4. **Added module-load test in `adminSales.test.ts`** — uses `jest.isolateModules` to load `adminRoutes.ts` with full mocks, verifying the router constructs without throwing. Also verifies `getSales` is structurally inside the class body (between class open and class close braces).

## Module-load test: fails-before, passes-after

**Before fix (getSales missing from mocks):** The module-load test calls `require('../../routes/adminRoutes')` — this throws `Route.get() requires a callback function but got a [object Undefined]` because the mock doesn't have `getSales`. Test FAILS.

**After fix (getSales added to mocks):** The same require succeeds. Test PASSES. Additionally, `AdminStatsController.getSales` is confirmed as `typeof 'function'`, and source-level analysis confirms it's inside the class body.

## Full suite result (after fix)

```
Test Suites: 16 passed, 16 total
Tests:       2 skipped, 2 todo, 639 passed, 643 total
Snapshots:   0 total
Time:        5.979 s
```

All 16 suites green. Zero failures.

## Margin math (unchanged from 34b1182)

| Field | Formula |
|-------|---------|
| `mulligans_gross` | `buyer_total - seller_payout - shipping_cost - label_cost` |
| `formula_fee` | `listing_price * BUYER_PROTECTION_RATE + SERVICE_FEE_PER_ITEM` |
| `est_stripe_fee` | `buyer_total * 0.015 + 0.20` (UK domestic card estimate) |
| `est_net` | `mulligans_gross - est_stripe_fee` |

Constants imported from `src/lib/feeCalculations.ts` (not hardcoded). Stripe fee constants at `adminStatsController.ts:18-19`.

## Files changed

| File | Change |
|------|--------|
| `src/controllers/adminStatsController.ts` | Added `getSales` static method (line 691), `EST_STRIPE_RATE`/`EST_STRIPE_FIXED` constants (lines 18-19), `round2` helper (line 21) |
| `src/routes/adminRoutes.ts` | Added `router.get('/sales', adminAuth, AdminStatsController.getSales)` (line 1807) |
| `src/__tests__/unit/platformStats.test.ts` | Added `getSales: jest.fn()` to AdminStatsController mock (line 98) |
| `src/__tests__/unit/paymentMoneySafety.test.ts` | Added `getSales: noop` to AdminStatsController mock |
| `src/__tests__/unit/adminSales.test.ts` | New — 21 tests (18 margin math + 3 module-load/wiring) |
| `public/admin/sales.html` | New — per-sale P&L page |
| `public/admin/shared/nav.js` | Added "Sales" nav item in Overview section |
| `CHANGES.md` | This file |
| `output/questions-admin-sales-page-fix.md` | Security scan + follow-ups |

## NOT touched (confirmed)

- `public/admin/index.html` — not modified
- `public/admin/analytics.html` — not modified
- `public/admin/disputes.html` — safety page, not touched
- `public/admin/returns.html` — safety page, not touched
- `public/admin/claims.html` — safety page, not touched
- `public/admin/reports.html` — safety page, not touched
- `public/admin/shared/styles.css` — not touched
- `src/lib/feeCalculations.ts` — only imported, not modified
- No migrations, no DB writes, no state changes
