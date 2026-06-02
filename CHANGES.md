# CHANGES — Brief 3a: Return-Refund Money-Safety Bulletproofing

**Branch:** `task/return-refund-safety`  
**Base:** `main` (`9fa0c92`)  
**Repo:** `Mulligans-Backend` → `Clovis-Mulligans/Mulligans-Backend-Clovis`

## Summary

Closes a real double-refund hole in the return flow. Uses a **claim-the-row** pattern: atomically lock + transition the return to `status = 'refund_processing'` before the Stripe call, so a concurrent run finds the row ineligible. The idempotency key remains as a Stripe-level backstop.

**No migration.** No schema change (reuses existing `status` column — `refund_processing` is a new transient value). No API contract change.

---

## Hole 1 — autoProcessReturnRefunds: claim-the-row pattern

**File:** `escrowService.ts:799-1050`

**Before (initial fix, now superseded):** The lock transaction closed before the Stripe call — the `FOR UPDATE` was cosmetic.

**After (claim-the-row):** Each return is processed with this sequence:
1. **Claim:** `prisma.$transaction` with `SELECT ... FOR UPDATE WHERE status = 'delivered' AND stripe_refund_id IS NULL`, then `UPDATE status = 'refund_processing'`, then commit. Lock released, but the row is now ineligible for any concurrent run (cron filters on `status = 'delivered'`, admin filters on `stripe_refund_id IS NULL` — the status change blocks the cron, and any admin request that gets past the lock finds the row already claimed).
2. **Stripe call:** `stripe.refunds.create()` with idempotency key `return_refund_${returnRequest.id}` (unchanged).
3. **Final state:** Batch `$transaction` setting `status = 'completed'`, `stripe_refund_id = refund.id` on both tables.
4. **On failure:** Revert `status → 'delivered'` so the row can be retried on the next cron run.

## Hole 2 — Admin return-refund endpoint: claim-the-row + idempotency + upper-bound

**File:** `adminRoutes.ts:510+`

**Before (initial fix, now superseded):** Same lock-scope issue — lock released before Stripe call.

**After (claim-the-row):**
1. **Claim:** `prisma.$transaction` with `SELECT id, status ... FOR UPDATE WHERE stripe_refund_id IS NULL`, saves previous status, then `UPDATE status = 'refund_processing'`, commit. The previous status is saved for revert on failure.
2. **Validation:** Upper-bound (`refundAmount > orderAmount` → 400), lower-bound (`<= 0` → 400). On validation failure, reverts claim to previous status.
3. **Stripe call:** `stripe.refunds.create()` with key `return_refund_${returnId}` (matches cron — Stripe dedupes).
4. **Final state:** Batch `$transaction` setting `status = 'completed'`, `stripe_refund_id`.
5. **On Stripe failure:** Reverts `status → previousStatus`, returns 500.

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

**After this fix (claim-the-row + admin exclusion):**
1. Cron acquires `FOR UPDATE` lock on R1 (`WHERE status = 'delivered' AND stripe_refund_id IS NULL`), sets `status = 'refund_processing'`, commits → lock released, **row claimed**
2. Admin tries to acquire `FOR UPDATE` on R1 (`WHERE stripe_refund_id IS NULL AND status != 'refund_processing' AND status != 'completed'`) → the `WHERE` no longer matches (status is `refund_processing`) → returns 0 rows
3. Admin returns **409 Conflict: "A refund for this return is already in progress"** — does NOT proceed to Stripe
4. Cron completes: Stripe refund, then `status = 'completed'` + `stripe_refund_id` persisted
5. **Result:** exactly ONE Stripe refund, admin gets a clear rejection

**If admin fires first (before cron):**
1. Admin acquires lock, claims row (`refund_processing`), commits
2. Cron's `findMany WHERE status = 'delivered'` does not match `refund_processing` → **cron skips the row entirely**
3. Admin completes: Stripe refund → `completed`
4. **Result:** exactly ONE Stripe refund

**The three layers of protection:**
- **Layer 1 (claim):** `status = 'refund_processing'` makes both the cron (`WHERE delivered`) and admin (`WHERE status != 'refund_processing'`) skip/reject the row
- **Layer 2 (lock):** `FOR UPDATE` serializes concurrent claims within the same moment
- **Layer 3 (Stripe):** Matching idempotency key `return_refund_${returnId}` prevents a second charge even if both paths somehow reach Stripe

**`refund_processing` added to `BLOCKING_RETURN_STATUSES`** (`escrowService.ts:48`) so that `hasBlockingReturn()` blocks escrow release while a return refund is in flight.

---

## Per-file changelog

### `src/services/escrowService.ts`
- `autoProcessReturnRefunds()`: Per-return processing now wrapped in `prisma.$transaction` with `SELECT ... FOR UPDATE` row lock on `return_requests`. The `return_requests` + `orders` status/refundId updates are now a batch `$transaction` (atomic). Safety checks (status re-verify, `stripe_refund_id` null check) are now enforced by the `FOR UPDATE` WHERE clause. `returnHasBlockingDispute` check remains outside the lock (it reads different tables — no lock conflict).

### `src/routes/adminRoutes.ts`
- `POST /admin/returns/:id/refund`: Entire handler now starts with a `prisma.$transaction` + `FOR UPDATE` lock on the return row. Added idempotency key `return_refund_${returnId}` (matches cron key exactly). Added upper-bound validation (`refundAmount > orderAmount` → 400, `refundAmount <= 0` → 400). Both table updates in a batch `$transaction`.
