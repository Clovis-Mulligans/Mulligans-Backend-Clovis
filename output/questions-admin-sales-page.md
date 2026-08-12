# Questions — task/admin-sales-page

## Security scan

**Read-only endpoint — CONFIRMED.** `getSales` uses `prisma.orders.findMany`, `prisma.orders.count`, and `prisma.orders.aggregate` — all read-only. No writes, no status transitions, no refunds, no payouts.

**Behind admin auth — CONFIRMED.** Route at `adminRoutes.ts:1807` uses `adminAuth` middleware, matching the pattern of all other admin endpoints (`/stats`, `/stats/charts`, `/stats/detailed`). Unauthenticated requests receive 401/403.

**PII exposure assessment.** The endpoint returns:
- Buyer/seller `display_name` (or email fallback) and internal `id`
- `shipping_address` (JSON — includes street address, city, postcode)
- Financial data: buyer_total, seller_payout, shipping_cost, label_cost, computed margins

This is sensitive data (PII + financials). It is appropriately gated behind admin auth. The same class of data is already exposed via the existing admin endpoints. No new PII surface beyond what admin already has access to.

**No injection risk.** Status filter values are matched against a hardcoded set (`gmv`, `all`, `cancelled`, `refunded`, `returned`) — no user-supplied strings reach the database query. Page number is parsed as integer.

**No new external dependencies.** No CDN scripts, no external API calls. Page uses existing shared assets only.

## Follow-ups logged (not done here)

### 1. `source` / platform capture is broken
**What:** The `source` field (ios/android/web) is NULL on all existing orders. The Sales page displays it but shows "unknown" for every row.
**Why it matters:** The operator wants to see which platform generates sales — critical for investment in iOS vs Android vs web.
**Status:** Separate task. Needs fix in the order creation flow (mobile app + backend) to populate `source`. Not in scope for this page — displaying null gracefully is correct behaviour here.

### 2. Real Stripe fee capture
**What:** Stripe's actual processing fee is not stored anywhere in the database. The Sales page shows an estimate (1.5% + 20p UK domestic card approximation).
**Why it matters:** Real Stripe fees vary (international cards are higher, Amex is higher, refunds have partial fee retention). The estimate will understate fees on non-UK-domestic transactions.
**Status:** Separate task. Would require capturing the fee from Stripe payment intent metadata or charge objects and storing it in a new column. The estimate is clearly labelled "est." in the UI and is adequate for now.

### 3. Totals are current-filter-only
**What:** The totals bar shows sums for the active status filter only. When viewing "Cancelled", totals show cancelled order sums, not the main sales totals.
**Design decision:** This is intentional — the operator specifically asked for "everything with a status filter the user can toggle." Totals matching the filter is consistent with how analytics.html works. If the operator wants always-on main totals, that's a UI iteration.
