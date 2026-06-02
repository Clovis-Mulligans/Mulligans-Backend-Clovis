# CHANGES — Brief 3a: Return-Refund Money-Safety Bulletproofing

**Branch:** `task/return-refund-safety`  
**Base:** `main` (`9fa0c92`)  
**Repo:** `Mulligans-Backend` → `Clovis-Mulligans/Mulligans-Backend-Clovis`

## Summary

Closes a real double-refund hole in the return flow by extending the Brief 2 money-safety pattern (row locks + idempotency keys + atomic persistence) to both return-refund paths: the daily cron and the admin manual endpoint.

**No migration.** No schema change. No API contract change.

---

## Hole 1 — autoProcessReturnRefunds: added row lock + atomic persistence

**File:** `escrowService.ts:799-1050`

**Before:** The cron used a plain `findMany` + per-row re-check (`findUnique` for status + `stripe_refund_id: null`) without any transaction or row lock. Two concurrent executions could both pass the check.

**After:** Each return is processed inside a `prisma.$transaction` with `SELECT id FROM return_requests WHERE id = ${id} AND status = 'delivered' AND stripe_refund_id IS NULL FOR UPDATE`. This acquires a row-level lock — any concurrent attempt (cron overlap or admin endpoint) blocks until the lock is released. The `return_requests` + `orders` updates are now wrapped in a batch `$transaction` so both tables get the `stripe_refund_id` atomically.

**The existing idempotency key (`return_refund_${returnRequest.id}`) was already present** — unchanged.

## Hole 2 — Admin return-refund endpoint: added row lock + idempotency key + upper-bound validation

**File:** `adminRoutes.ts:510-607`

**Before:** The admin endpoint had no idempotency key on the Stripe call, no row lock, and no upper-bound validation on the refund amount. If admin and cron both processed the same return, Stripe would create two genuine refunds (different keys = no dedup).

**After:**
1. **Row lock:** `prisma.$transaction` with `SELECT id FROM return_requests WHERE id = ${id} AND stripe_refund_id IS NULL FOR UPDATE`. Serializes against the cron.
2. **Idempotency key:** `return_refund_${returnId}` — **identical to the cron's key**. If both paths fire for the same return, Stripe returns the existing refund to the second caller. This is the critical fix.
3. **Upper-bound validation:** `refundAmount > orderAmount` → 400. `refundAmount <= 0` → 400. Matches Brief 2's B4 pattern.
4. **Atomic persistence:** Both `return_requests` and `orders` updates in a batch `$transaction`.

---

## Race scenario walkthrough: "admin + cron both process the same return"

**Before this fix:**
1. Cron finds return R1 (`stripe_refund_id: null`, `status: delivered`, `escrow_release_at <= now`)
2. Admin clicks "Process Refund" for R1 at the same moment
3. Both read R1, both see `stripe_refund_id: null`
4. Cron calls `stripe.refunds.create()` with key `return_refund_R1` → Refund A created
5. Admin calls `stripe.refunds.create()` with **NO key** → Refund B created (genuine second refund!)
6. Both write their refund ID to the DB — one overwrites the other
7. **Result:** buyer refunded twice, one refund orphaned

**After this fix:**
1. Cron acquires `FOR UPDATE` lock on R1 in `return_requests`
2. Admin tries to acquire `FOR UPDATE` lock on R1 → **blocks** (waits for cron to finish)
3. Cron calls `stripe.refunds.create()` with key `return_refund_R1` → Refund A created
4. Cron persists `stripe_refund_id = Refund A` on both tables, commits → lock released
5. Admin's `FOR UPDATE` returns 0 rows (`stripe_refund_id IS NULL` no longer matches)
6. Admin returns 400 "Return not found or already refunded"
7. **Result:** exactly ONE refund

**Even if the lock doesn't serialize perfectly** (e.g., both enter the transaction before either commits):
- Both call Stripe with the **same** idempotency key `return_refund_R1`
- Stripe returns the same refund object to both callers
- Both write the same `stripe_refund_id` — idempotent at the DB level too
- **Result:** still exactly ONE refund

---

## Per-file changelog

### `src/services/escrowService.ts`
- `autoProcessReturnRefunds()`: Per-return processing now wrapped in `prisma.$transaction` with `SELECT ... FOR UPDATE` row lock on `return_requests`. The `return_requests` + `orders` status/refundId updates are now a batch `$transaction` (atomic). Safety checks (status re-verify, `stripe_refund_id` null check) are now enforced by the `FOR UPDATE` WHERE clause. `returnHasBlockingDispute` check remains outside the lock (it reads different tables — no lock conflict).

### `src/routes/adminRoutes.ts`
- `POST /admin/returns/:id/refund`: Entire handler now starts with a `prisma.$transaction` + `FOR UPDATE` lock on the return row. Added idempotency key `return_refund_${returnId}` (matches cron key exactly). Added upper-bound validation (`refundAmount > orderAmount` → 400, `refundAmount <= 0` → 400). Both table updates in a batch `$transaction`.
