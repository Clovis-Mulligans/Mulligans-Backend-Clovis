# CHANGES — task/admin-sales-page

**Branched from:** `task/admin-stats-status-filter-fix-main` (which is `main` @ `0a84e23` + Tier 1 fix `6176df8`)

## Summary

New **Sales** page in the admin dashboard — a per-sale P&L view showing what Mulligans actually makes on each order. Read-only, additive only. No existing pages modified, no safety pages touched, no state-changing code.

## What was built

### 1. New endpoint: `GET /admin/sales`

**File:** `src/controllers/adminStatsController.ts:695` — `AdminStatsController.getSales`
**Route:** `src/routes/adminRoutes.ts:1807` — `router.get('/sales', adminAuth, AdminStatsController.getSales)`

Returns paginated orders (50/page, `created_at` desc) with per-order P&L:

| Field | Formula |
|-------|---------|
| `mulligans_gross` | `buyer_total − seller_payout − shipping_cost − label_cost` |
| `formula_fee` | `listing_price × BUYER_PROTECTION_RATE + SERVICE_FEE_PER_ITEM` |
| `est_stripe_fee` | `buyer_total × 0.015 + 0.20` (UK domestic card estimate) |
| `est_net` | `mulligans_gross − est_stripe_fee` |

Constants used:
- `BUYER_PROTECTION_RATE` (0.075) and `SERVICE_FEE_PER_ITEM` (0.99) imported from `src/lib/feeCalculations.ts`
- `EST_STRIPE_RATE` (0.015) and `EST_STRIPE_FIXED` (0.20) defined at `adminStatsController.ts:18-19` — labelled as estimates

**Query params:**
- `page` (default 1) — pagination
- `status` (default `gmv`) — filter: `gmv` uses `GMV_STATUSES` from Tier 1; `cancelled`, `refunded`, `returned`, `all`

**Response includes:**
- `sales[]` — per-order rows with all money fields, buyer/seller info, computed margins, time_to_sell, source, status
- `pagination` — page, pageSize, totalCount, totalPages
- `totals` — count, mulligans_gross, est_stripe_fee, est_net (computed over FULL filtered set, not just current page)
- `statusFilter` — echoes the active filter

**Per-order details:**
- Buyer/seller display names (from `display_name` or `email` fallback) + seller `is_pro` flag
- `label_pending: true` when `label_cost` is null (row flagged, not mistaken for final)
- `time_to_sell` — human-readable `paid_at − created_at` (null-safe)
- `source` — platform (may be null → "unknown")
- Offer details: `original_list_price`, `discount_amount`, `offer_id`
- `shipping_address` (JSON)

### 2. New page: `public/admin/sales.html`

Matches existing admin page structure (login screen → app container → sidebar + main-wrapper). Uses `shared/styles.css`, `shared/auth.js`, `shared/helpers.js`, `shared/nav.js`.

**Features:**
- **Totals bar** — 4 cards: Order Count, Mulligans Gross, Est. Stripe Fees, Est. Net Profit
- **Status filter** — toggle buttons: Sales (default/GMV), Cancelled, Refunded, Returned, All
- **Per-sale table** — columns: Order, Listing, Buyer, Seller, Status, Buyer Total, Seller Payout, Shipping, Label, Gross, Formula Fee, Est. Stripe, Est. Net, Source, Sold
- Both `mulligans_gross` and `formula_fee` visible per row so discrepancies are immediately visible
- Stripe fees always labelled "est." (italic label)
- Label-pending rows show "pending" in italic
- Negative margins highlighted in red, positive in green
- Pro sellers show a green "PRO" badge
- Offer-sales show discount info below the listing title
- **CSV export** — matching analytics.html pattern: totals + per-order breakdown
- **Pagination** — prev/next with page info
- Money columns right-aligned with tabular-nums

**Page-specific styles only.** No modifications to `shared/styles.css`.

### 3. Nav integration

**File:** `public/admin/shared/nav.js` — added "Sales" (💷) in Overview section, between Analytics and Operations.

Uses the same `getCurrentPage()` active-state pattern. No nav badges (read-only page, no actionable count).

### 4. Stripe fee constants

**File:** `src/controllers/adminStatsController.ts:18-19`
- `EST_STRIPE_RATE = 0.015` — UK domestic card rate
- `EST_STRIPE_FIXED = 0.20` — per-transaction fixed fee

Both exported for test access. Comment documents they are estimates pending real Stripe data capture.

### 5. Helper function

**File:** `src/controllers/adminStatsController.ts:21` — `round2(n)` for consistent 2-decimal rounding across all money fields.

## Margin math implemented (exactly as specified)

1. `mulligans_gross = buyer_total − seller_payout − shipping_cost − label_cost` (primary, ground truth)
2. `formula_fee = (listing_price × 0.075) + 0.99` (cross-check, shown alongside)
3. `est_stripe_fee = (buyer_total × 0.015) + 0.20` (estimate, labelled)
4. `est_net = mulligans_gross − est_stripe_fee` (estimate, labelled)

No other fees invented. `est_net` never presented as exact.

## Tests

**File:** `src/__tests__/unit/adminSales.test.ts` — 18 tests, all passing.

| Test group | Count | What it covers |
|-----------|-------|---------------|
| Per-order margin math | 5 | mulligans_gross, null label_cost treated as 0, formula_fee uses imported constants, est_stripe_fee calc, est_net calc |
| Offer-sale handling | 3 | discount_amount/offer_id surfaced, seller_payout = listing_price, formula_fee on listing_price not original |
| Label pending flag | 2 | null label_cost → flagged, non-null → not flagged |
| Totals aggregation | 5 | gmv filter includes/excludes correct statuses, cancelled filter, all filter, gross sums correctly, est_net = gross - stripe |
| Stripe fee constants | 2 | EST_STRIPE_RATE = 0.015, EST_STRIPE_FIXED = 0.20 |
| Endpoint auth | 1 | Route exists in adminRoutes.ts with adminAuth middleware |

Tests import real controller constants (`GMV_STATUSES`, `EST_STRIPE_RATE`, `EST_STRIPE_FIXED`) and real fee constants (`BUYER_PROTECTION_RATE`, `SERVICE_FEE_PER_ITEM`). Math is not mocked.

Run: `npx jest --selectProjects unit -- adminSales`

## NOT touched (confirmed)

- `public/admin/index.html` — not modified
- `public/admin/analytics.html` — not modified
- `public/admin/disputes.html` — safety page, not touched
- `public/admin/returns.html` — safety page, not touched
- `public/admin/claims.html` — safety page, not touched
- `public/admin/reports.html` — safety page, not touched
- `public/admin/users.html` — not touched
- `public/admin/pro-store-applications.html` — not touched
- `public/admin/shared/styles.css` — not touched (page-specific styles only)
- `src/lib/feeCalculations.ts` — only imported, not modified
- No migrations, no DB writes, no state changes

## Follow-ups (not done here — separate tasks)

1. **`source` / platform capture** — currently NULL on all orders. Column displayed but shows "unknown". Needs separate fix in order creation flow.
2. **Real Stripe fee capture** — currently estimated at 1.5% + 20p. Need to capture actual Stripe processing fees from webhooks/payment intents and store in a column. This would replace the estimate.

## Files changed

| File | Change |
|------|--------|
| `src/controllers/adminStatsController.ts` | Added `getSales` method, `EST_STRIPE_RATE`/`EST_STRIPE_FIXED` constants, `round2` helper |
| `src/routes/adminRoutes.ts` | Added `router.get('/sales', adminAuth, AdminStatsController.getSales)` |
| `public/admin/sales.html` | New page — per-sale P&L table with totals, filters, CSV export |
| `public/admin/shared/nav.js` | Added "Sales" nav item in Overview section |
| `src/__tests__/unit/adminSales.test.ts` | New test file — 18 tests |
| `CHANGES.md` | This file |
| `output/questions-admin-sales-page.md` | Security scan + follow-ups |
