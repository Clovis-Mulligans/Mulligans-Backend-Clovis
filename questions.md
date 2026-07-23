# Questions — Brief 3a: Return-Refund Money-Safety

## Idempotency key alignment — VERIFIED

Both paths use the **identical key**: `return_refund_${returnRequest.id}` (where `returnRequest.id` is the `return_requests` table PK).

- **Cron** (`escrowService.ts:901` → now inside `$transaction`): `idempotencyKey: 'return_refund_${returnRequest.id}'`
- **Admin** (`adminRoutes.ts:556` → now inside `$transaction`): `idempotencyKey: 'return_refund_${returnId}'` where `returnId = req.params.id`

Same return = same key = Stripe deduplicates. If both fire for the same return, Stripe returns the existing refund to the second caller rather than creating a new one.

## Lock ordering — no deadlock risk

The dispute-resolution paths (Brief 2) lock `disputes` rows. The return-refund paths (this brief) lock `return_requests` rows. These are **different tables** — no cross-lock ordering conflict. The only shared table is `orders`, but neither path holds a persistent lock on `orders` during the Stripe call — the `orders` update happens after the Stripe call returns, in a separate batch transaction.

## Typecheck

Could not run `tsc --noEmit` — TypeScript is not installed in the clone (no `node_modules`). Harry should run `npm install --legacy-peer-deps && npx tsc --noEmit` on the dev EC2 after fetching the branch.

## Security — upper-bound validation cannot be bypassed

The admin endpoint now validates `refundAmount > orderAmount` before the Stripe call. The `orderAmount` is read from the database inside the `FOR UPDATE` transaction, not from the request body, so an admin cannot manipulate it.

## Sweep findings — other un-hardened money movement in return paths

### 1. Seller-pays return label PaymentIntent — NO idempotency key
**File:** `returnController.ts:702-717`  
**Risk:** Low — this is a charge (not a refund), protected by Stripe's own PaymentIntent idempotency via the `payment_method` + `confirm: true` pattern. However, if the endpoint is called twice with the same `returnId + rateId`, two PaymentIntents could be created.  
**Recommendation:** Add an idempotency key (e.g., `return_label_seller_${returnId}`) in a follow-up. Not a refund-race — different concern.

### 2. Seller-pays label failure refund — NO idempotency key
**File:** `returnController.ts:737`  
**Context:** If Shippo label creation fails after the seller was charged, a refund is issued to the seller's PaymentIntent. No idempotency key.  
**Risk:** Very low — this only fires on a Shippo failure within the same request. Two concurrent requests would create two PaymentIntents (finding #1), and each would refund its own PI. Not a cross-path race.

### 3. Insurance claim refund — NO idempotency key
**File:** `adminRoutes.ts:876`  
**Context:** Admin approves an insurance claim and refunds the buyer. No idempotency key, no row lock.  
**Risk:** Medium — similar to the return-refund admin hole (could double-refund if admin clicks twice). Different flow (insurance, not returns) — out of scope for this brief.  
**Recommendation:** Harry should consider a follow-up brief to harden the insurance claim refund path with the same pattern.

### 4. Escrow auto-cancel refund — HAS idempotency key
**File:** `escrowService.ts:218`  
**Context:** `autoCancelUnshippedOrders` uses `idempotencyKey: 'auto_cancel_refund_${order.id}'`. Already hardened.

### 5. Escrow release transfer — HAS idempotency key
**File:** `escrowService.ts:666`  
**Context:** `autoReleaseEscrow` uses `idempotencyKey: 'escrow_release_group_${trackingKey}'`. Already hardened.

---

# Questions — Stuck-Order Safety Net + Auto-Ship Stripe Consistency

## Schema Change: `payout_blocked_at` + `payout_reminder_sent_at`

Two nullable DateTime columns added to `orders`:
- `payout_blocked_at` — when escrow release first detected the seller cannot receive payout
- `payout_reminder_sent_at` — last seller reminder timestamp (enforces 3-day cadence)

Both nullable, no default. Existing orders get NULL. Non-destructive.
Dev: `prisma db push`. Prod: run `prisma/migrations/stuck_order_safety_net/migration.sql`.

## Admin Surface

`GET /admin/stuck-orders` behind `adminAuth`. Returns JSON for dashboard wiring.
At 14 days, a `support_ticket` is also auto-created (type: `payout_blocked`, priority: `high`).

## Security

- New fields are server-side only (cron writes, no user-facing endpoint reads/writes them)
- Admin endpoint does NOT expose raw `stripe_connect_id`
- Seller notifications say "complete your payment setup" — no financial detail leaked
- Buyer receives NO notification about blocked payout state

## Change 1: Auto-Ship Stripe Gate Removed

The `stripe_connect_status === 'active'` gate at autoShippingService.ts:116 has been removed per the brief. Auto-ship now requires only a sending address, matching the manual path. No other shipping path gates on Stripe status.

---

# Questions — Ship-Status Integrity

## Auto-cancel deadline: no change needed (confirmed)

The 5-weekday deadline is not too tight after removing the manual button. The Shippo webhook fires PRE_TRANSIT when a label is created, which clears `auto_cancel_at`. So sellers with labels won't be auto-cancelled regardless of carrier scan timing.

## Separate concern: "label created but never dropped off"

Once a label exists and PRE_TRANSIT clears `auto_cancel_at`, the order sits at `to_ship` indefinitely if the seller never drops off the parcel. There's no timeout for this state. `checkLostInTransit` only flags orders at `in_transit` for 14+ days — it doesn't catch `to_ship` orders with stale labels.

This is NOT introduced by this change (it existed before), but removing the manual button makes it slightly more visible since the seller can no longer manually advance to `in_transit`. Flagging for awareness — could be a future brief to add a "label created but not scanned within N days" check.

**Blocked:** No — does not affect this brief.

## orderController.markAsShipped — removed (confirmed self-attestation, ship-status-integrity)

---

# Questions — Brief 3b: Forced Returns

## Schema: `is_forced` on `return_requests`

Single boolean column, nullable with `DEFAULT false`. Existing returns unaffected. Dev: `prisma db push`. Prod: `prisma/migrations/forced_returns/migration.sql`.

No additional columns needed — `paid_by` (set to `'platform'`), `return_ship_deadline`, `refund_amount`, `dispute_id`, `delivered_at` all exist already.

## Payer seam: `resolveReturnLabelPayer()`

In `forcedReturnService.ts`. Returns `'platform'` for forced returns. To enable seller-debit later, change this one function to return `'seller'` and wire up the charging logic. Commented clearly.

## Buyer ship deadline: 5 days (confirmed)

## Seller confirm deadline

- **Primary:** 3 days after `delivered_at` (set by Shippo DELIVERED webhook for return parcel — newly wired in this brief)
- **Fallback:** 14 days after `shipped_at` if carrier never reports DELIVERED
- Both use claim-the-row refund pattern

## Forced return does NOT change the `paid_by` FK constraint

The `paid_by` field has a FK to `users.id`. For forced returns, we set `paid_by: 'platform'` (a string, not a user ID). This will fail the FK constraint.

**Options:**
1. Make `paid_by` nullable and leave it NULL for platform-pays (then check `is_forced` to infer payer)
2. Drop the FK constraint on `paid_by` (it's optional anyway)
3. Create a system user ID for 'platform'

**Recommendation:** Option 1 — set `paid_by: null` for forced returns. The `is_forced` flag tells us the platform paid. Simplest change, no FK issues.

**This is flagged for Harry — the current code sets `paid_by: 'platform'` which will fail the FK. Harry should confirm approach before testing.**

This endpoint accepted a seller-provided tracking number without Shippo verification. While it could theoretically serve "shipped with own label" sellers, the tracking number isn't monitored by Shippo webhooks, so the buyer gets no automatic delivery updates and the transition to `delivered` would never fire automatically. It's effectively self-attestation with a tracking number string.

Removed along with shippingController.markAsShipped. If a "shipped outside system" flow is needed later, it should be built with carrier verification (e.g., Shippo universal tracking registration).

---

# Questions — Admin Full Refund Override

## Audit mechanism — existing `admin_audit_log` table reused

The `admin_audit_log` table + `logAdminAction()` helper already exist and are used for dispute resolution, user bans, report updates, etc. No new table needed. The full refund records action `'admin_full_refund'` with all relevant details in the JSON `details` field.

## Refund amount — `buyer_total` field used

`buyer_total` is set at all order creation paths (native payment, cart checkout). It captures the grand total the buyer paid (item + shipping + fees). For legacy orders where `buyer_total` is null, falls back to `amount`. The amount is ALWAYS derived server-side — the request body only carries `reason`, never an amount.

## Security

- Endpoint is behind `adminAuth` + `adminActionLimiter` (rate limited)
- `reason` is required and recorded in audit log
- Refund amount derived from order data, not request body
- Claim-the-row prevents double-refund or race with other refund paths
- Stripe idempotency key ensures at-most-once processing

---

# Questions — Brief 3c: Return-Seller Backend (A1, A2, B1, D1)

## Phase 1 Plan

### A1: `total_purchases` increment — three completion paths, all mutually exclusive

**Confirmed dead:** `total_purchases` is never incremented anywhere. Only reads/selects exist.

**Three completion paths** (each requires `status: 'delivered'`, sets `status: 'completed'` — mutually exclusive by claim-the-row):

| Path | File:line | Trigger | buyer_id source | Increment |
|------|-----------|---------|-----------------|-----------|
| Escrow auto-release | `escrowService.ts:784-805` | Cron after escrow period | `orders[0].buyer_id` (all orders in group share buyer) | `orders.length` (batch) |
| Buyer confirm-receipt | `orderController.ts:795-814` | `PUT /orders/:id/confirm-receipt` | `order.buyer_id` (line 727 select) | 1 |
| Manual complete | `orderController.ts:1610-1629` | `PUT /orders/:id/complete` | needs `buyer_id` added to query | 1 |

**Exactly-once guarantee:** All three paths require `status: 'delivered'` to find the order, then set `status: 'completed'`. Once completed, no path can find the order again. The escrow path has an additional idempotency key (`escrow_release_group_${trackingKey}`). Confirm-receipt has a `stripe_transfer_id` short-circuit. These are the same guards that protect `total_sales` — the increment mirrors the existing pattern.

**Note on `completeOrder`:** The current query does NOT select `buyer_id`. Need to add it to the `include` or use the order object directly (Prisma `include` returns all scalar fields by default).

**Money paths untouched:** The increment is placed AFTER the order status update and Stripe transfer, using the same `now` timestamp. No change to transfer amounts, escrow timing, or payout logic.

### A2: `total_sales` — confirmed LIVE, three increment points

`total_sales` is incremented at all three completion paths (escrowService.ts:799-804, orderController.ts:808-813, orderController.ts:1623-1628). It is real data.

**Change:** Add `total_sales: true` to the seller select at `orderController.ts:385-393` and map it at line 539. Two lines, strictly additive. Auth unchanged — the endpoint already returns the seller object to both buyer and seller.

### B1: Return TRANSIT → shipped via webhook

**Outbound pattern (to mirror):** `shippingController.ts:680-683` — on `TRANSIT`, sets `newStatus = 'in_transit'` and `shippedAt = new Date()`.

**Return webhook:** `shippingController.ts:795-813` — currently only handles `DELIVERED` for returns. All other events logged and ignored.

**Tracking registration confirmed:** Return labels are created via `shippo.transactions.create()` which auto-registers tracking with Shippo. The webhook handler already matches return tracking numbers against `return_requests.return_tracking_number`.

**Change:** Add `TRANSIT` handling to the return branch: update `return_requests.status = 'shipped'` and `shipped_at = new Date()`, guarded by `!returnRequest.shipped_at` (same idempotency pattern as outbound). Add notification to seller that return is in transit.

**Manual endpoint preserved:** `POST /returns/mark-shipped` stays — brief says don't remove it yet. The manual endpoint and webhook now write the same fields (`status: 'shipped'`, `shipped_at`), so they don't diverge.

### D1: Return QR codes — migration + three code changes

**Outbound QR pattern:** `shippingController.ts:225` adds `qrCodeRequested: true` to extras. Lines 426-440 extract `qrCodeUrl` and `qrCodeExpiresAt` from the transaction response.

**Schema change needed:** `return_requests` has no `qr_code_url` or `qr_code_expires_at` columns. Need a Prisma migration to add both (nullable, additive).

**Migration name:** `20260615000000_return_qr_codes` (follows lexicographic convention after `20260603200000_forced_returns`).

**Three `shippo.transactions.create()` calls to modify:**
1. `returnController.ts:498` — buyer-pays label
2. `returnController.ts:730` — seller-pays label
3. `forcedReturnService.ts:347` — forced return (platform-pays)

Each gets `qrCodeRequested: true` added and QR extraction logic (mirroring outbound pattern at lines 426-440), storing to the new `return_requests` columns.

**GET exposure:** The `getReturnRequest` endpoint (`returnController.ts:1199-1257`) uses `...returnRequest` spread, so the new columns will automatically appear in the response. No additional mapping needed.

**Money paths untouched:** QR is a label display feature. No change to label cost, Shippo charges, or Stripe flows.

## Security confirmation (all commits)

- **A1:** No auth change. No amount change. Increment is additive metadata on user profile.
- **A2:** No auth change. `total_sales` exposed to same recipients who already see `rating`, `display_name`, etc.
- **B1:** No auth change. Webhook is unauthenticated (Shippo fires it) — same as existing handler. No amount/escrow change.
- **D1:** No auth change. QR URL is a Shippo-hosted image. Exposed via same auth-gated `getReturnRequest` endpoint.

---

# Questions — Payout Guards Audit (23 Jul 2026)

## Abort Conditions

No abort conditions were hit. Branch, SHA, and tree are verified (see AUDIT.md §2).

**Remote discrepancy (non-blocking):** The brief references `upstream/main` but no `upstream` remote exists. `origin` points at `HS-Mulligans/Mulligans-Backend` and was used as the upstream. The audit is against the correct tree.

---

## Items Warranting Immediate Action

### IMMEDIATE-1: Order `order_980551c6` (the incident order) — manual intervention required

The incident order (£189.98 paid, £160.00 seller payout) is currently stuck in `delivered` with `completed_at = NULL`. The escrow cron will pick it up nightly but will continue to fail because:

1. The seller's Connect account `acct_1TWyccHAxYrQJMTK` has `stripe_connect_status = 'restricted'`
2. Even if the seller completes Stripe onboarding, the DB will not know — there is no `account.updated` webhook (see P1-1)
3. The seller must actively poll `/account-status` or `/onboarding-status` in the app to update their DB status

**Decision required:** Should the seller be contacted directly and walked through Stripe onboarding? Or should an admin manually poll the Stripe API for the account status and update the DB?

### IMMEDIATE-2: Audit the DB for other orphaned orders

The following query would identify orders in the same state as the incident:
```sql
SELECT id, status, stripe_transfer_id, completed_at, seller_payout,
       escrow_release_at, payout_blocked_at
FROM orders
WHERE status = 'completed'
  AND stripe_transfer_id IS NULL
  AND seller_payout > 0;
```

And orders stuck in `delivered` past their escrow release:
```sql
SELECT id, status, stripe_transfer_id, escrow_release_at, payout_blocked_at,
       seller_id
FROM orders
WHERE status = 'delivered'
  AND escrow_release_at < NOW()
  AND stripe_transfer_id IS NULL;
```

**Decision required:** Harry to run these queries against production and assess the scale of the problem.

### IMMEDIATE-3: Three orphaned Stripe accounts in Stripe dashboard

The three duplicate `POST /v1/accounts` events (22 Jul, 21 Jul ×2) likely created orphaned `acct_` objects in Stripe. These should be identified and either linked to the correct user or deleted via the Stripe dashboard.

**Decision required:** Harry to check the Stripe dashboard for duplicate/orphaned Connect accounts.

---

## Ambiguities & Undeterminable Questions

### Q15 — Anomaly attribution is probabilistic, not certain

For `order_c52adae2` (21 May, transfer created but `stripe_transfer_id` NULL): I attributed this to the `completeOrder` path based on the code analysis (it's the only path that creates a transfer without persisting the ID at current HEAD). However, before commit `13d4a5b` (1 Jun), `confirmReceipt` also had this bug. The order date (21 May) is before the fix, so **either path could have been responsible**. `completeOrder` is the only path where this bug is still live.

For `order_655d42f6` (1 Jun, `completed` with both fields NULL): I attributed this to a dispute resolution path (the only paths that omit `completed_at`). Without access to the production logs or dispute records for this order, I cannot confirm which of the three dispute paths was used.

### Q19 — Alerting completeness

I found no Sentry, PagerDuty, Slack, or other external alerting integration. If one exists outside the `src/` tree (e.g., in infrastructure config, PM2 config, or a separate monitoring service), it would not be visible in this audit.

### Missing `account.updated` webhook — known gap vs. oversight?

The spec (§4.8, Open item 4-OPEN-5) mentions "Surface failed Stripe transfers (Connect account `restricted`) to admin/seller" as an open item. But the spec does not explicitly call for an `account.updated` webhook. Is the absence of this webhook:
- A known gap that was deliberately deferred?
- An oversight that should be addressed with the payout guard fix?

This affects the scope of the proposed consolidation.

### `completeOrder` endpoint — who calls it?

The admin route `PUT /api/orders/:id/complete` is behind `adminAuth`. I could not determine from the code alone whether this endpoint is called:
- Only from the admin web panel (manual action by Harry)
- Programmatically by any other service or cron job
- At all in production (it may be a dormant admin tool)

If it is rarely used, the P0-2 risk is mitigated by low exposure. If it is used regularly, the risk is acute.

### Dispute resolution — is the order-status-before-transfer sequence intentional?

The dispute paths set `completed` before attempting the transfer. This could be:
- A bug (the status should be set after the transfer)
- An intentional design choice (the refund has already been issued to the buyer, so the order is "resolved" from the buyer's perspective regardless of seller payout success)

The answer affects the proposed fix. If intentional, the fix should add a retry mechanism for completed orders with NULL `stripe_transfer_id`. If a bug, the fix should reorder the operations.

---

## Strategic Recommendation

**The audit strongly favours consolidation (Harry's option 2) over a single-site patch.**

Patching `confirmReceipt` alone fixes the specific incident but leaves:
- `completeOrder` with no idempotency, no transfer ID persistence, no status check (P0-2)
- Dispute resolution permanently orphaning orders on transfer failure (P0-3)
- Dispute resolution warn-and-continue on non-active accounts (P0-5)
- 6 of 7 completion paths inconsistent in what they write (Table E)
- No test coverage for the failure mode

A `transferToSeller()` helper (modelled on `issueFailureRefund.ts`) fixes all four transfer sites and can be adopted incrementally, starting with `completeOrder` (the most dangerous site).

**However:** The consolidation does not fix the upstream gating problem (P1-2) or the missing webhook (P1-1). Those are separate, complementary fixes.

**Recommended sequencing:**
1. **Today:** Manual intervention for the incident order (IMMEDIATE-1)
2. **Today:** DB audit for other orphaned orders (IMMEDIATE-2)
3. **This week:** Create `transferToSeller.ts` and adopt in `completeOrder` (fixes P0-2)
4. **This week:** Adopt in `confirmReceipt` with `connect_status` check (fixes P0-1)
5. **This week:** Fix dispute resolution ordering or add retry mechanism (fixes P0-3)
6. **Next week:** `account.updated` webhook (fixes P1-1)
7. **Next week:** Upstream payability gate at checkout (fixes P1-2)
8. **CI check:** Add after all sites are consolidated (Q27)
