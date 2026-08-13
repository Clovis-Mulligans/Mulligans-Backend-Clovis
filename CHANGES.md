# CHANGES — `task/admin-sales-gross-formula-fix`

**Branch:** `task/admin-sales-gross-formula-fix`
**Base:** `main` @ `e863d14`

## Summary

Fixes a calculation bug in the admin Sales page where `mulligans_gross` wrongly subtracted `shipping_cost` (money the buyer paid IN, already a component of `buyer_total`) as if it were a cost out. This double-counted shipping against the platform, understating profit on every order.

## The bug

**Old formula** (`adminStatsController.ts:797`):
```
mulligans_gross = buyer_total − seller_payout − shipping_cost − label_cost
```

`shipping_cost` is what the buyer paid for shipping — it flows into `buyer_total` (money IN). The only shipping money that actually leaves the platform is `label_cost` (the Shippo label). Subtracting `shipping_cost` double-counts it.

**Corrected formula** (`adminStatsController.ts:796`):
```
mulligans_gross = buyer_total − seller_payout − label_cost
```

### Correctness proof (RAM shoes order, verified against live Stripe):
- Stripe Payment Intent: £30.91 received (= `buyer_total`) ✓
- Stripe Transfer: £22.00 to seller (= `seller_payout`) ✓
- Shippo label: £4.85 (= `label_cost`)
- Old formula: `30.91 − 22.00 − 6.27 − 4.85 = −£2.21` (wrong)
- New formula: `30.91 − 22.00 − 4.85 = +£4.06` gross, minus est. Stripe £0.66 = **+£3.40 net** ✓ matches Stripe exactly

## Changes made

### `src/controllers/adminStatsController.ts`
- **Line 796:** Per-order `mulligansGross` — removed `- shippingCost`
- **Line 785:** `totalGross` in totals summary — removed `- totalShippingCost`
- Everything else unchanged: `est_stripe_fee`, `formula_fee`, status filters, `EXCLUDED_ORDER_IDS`, `label_cost` null handling

### `public/admin/sales.html`
- **Line 349:** Column subtitle updated from `buyer_total - seller_payout - shipping - labels` to `buyer_total - seller_payout - labels`

### `src/__tests__/unit/adminSales.test.ts`
- `computeMargins()` helper: removed `- shippingCost` from gross formula (line 119)
- `computeTotals()` helper: removed `- sc` from gross sum (line 236)
- Added new `shipping_cost independence` test: two orders with identical buyer_total/seller_payout/label_cost but DIFFERENT shipping_cost produce the SAME gross

## Test expected-values corrected

The OLD expected values were **wrong** — they asserted the buggy formula that double-counted shipping. These are not regressions; the old values were incorrect.

| Test | Field | Old (wrong) | New (correct) | Derivation |
|------|-------|-------------|---------------|------------|
| `mulligans_gross = buyer_total - seller_payout - label_cost` | `mulligans_gross` | 9.99 | **18.98** | 225.48 − 200 − 6.50 |
| `null label_cost treated as 0` | `mulligans_gross` | 24.25 | **37.24** | 387.24 − 350 − 0 |
| `est_net = mulligans_gross - est_stripe_fee` | `est_net` | 6.41 | **15.40** | 18.98 − 3.58 |

The `computeTotals` and `computeMargins` helpers were also corrected so all downstream assertions (totals gross sums, est_net relationship, cancelled filter) now test the correct formula.

## Full suite result

```
Test Suites: 16 passed, 16 total
Tests:       2 skipped, 2 todo, 647 passed, 651 total
Snapshots:   0 total
Time:        4.75 s
```

## Files changed
- `src/controllers/adminStatsController.ts` — removed `- shippingCost` from per-order gross and `- totalShippingCost` from totals
- `public/admin/sales.html` — updated column subtitle text
- `src/__tests__/unit/adminSales.test.ts` — corrected formula in test helpers, re-derived expected values, added shipping independence test
- `CHANGES.md` — this file
