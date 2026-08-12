# Questions — task/admin-sales-page-fix

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
The `source` field (ios/android/web) is NULL on all existing orders. The Sales page displays it but shows "unknown" for every row. Needs fix in the order creation flow. Separate task.

### 2. Real Stripe fee capture
Stripe's actual processing fee is not stored anywhere in the database. The Sales page shows an estimate (1.5% + 20p UK domestic card approximation). Real fees vary by card type. Would require capturing from Stripe payment intents. Separate task. Estimate is clearly labelled "est." in the UI.
