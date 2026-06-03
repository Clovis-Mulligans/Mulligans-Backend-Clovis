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
