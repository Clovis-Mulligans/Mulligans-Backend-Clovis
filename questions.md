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
