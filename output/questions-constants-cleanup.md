# Constants Dedupe + Refund-Helper Adoption

**Branch:** `task/constants-cleanup`
**Base SHA:** `b82c96c` (origin/main, confirmed via `git merge-base`)
**Push target:** `clovis` (Clovis fork)

---

## Task 1 — RETURN_ESCROW_DAYS: 5 → 3

### What changed

- **Removed** hardcoded `const RETURN_ESCROW_DAYS = 5` from `returnController.ts:32`
- **Added** `export const RETURN_ESCROW_DAYS = INSPECTION_WINDOW_DAYS` to `src/config/constants.ts`
- **Import** in `returnController.ts` now reads from `config/constants.ts`
- **Behaviour change:** sellers get 3 days (not 5) to inspect a returned item before the buyer's refund is released

### Other uses of the old 5-day value

Grepped the entire `src/` tree — `RETURN_ESCROW_DAYS` was only used in `returnController.ts` at three sites (all in `confirmReturnDelivered`):
1. Line 1153: `escrowReleaseAt.setDate(escrowReleaseAt.getDate() + RETURN_ESCROW_DAYS)` — escrow timer
2. Line 1175: notification message — "refund will be processed in N days"
3. Line 1186: push notification — "Refund processing in N days"

All three now read the imported constant (= 3). No other file references it.

### Tripwire test

Added: `expect(RETURN_ESCROW_DAYS).toBe(INSPECTION_WINDOW_DAYS)` — any future drift triggers a failure.

---

## Task 2 — BLOCKING_RETURN_STATUSES: one source of truth

### What changed

- **Canonical definition** stays in `src/lib/escrowDecisions.ts` (chosen because it already exports the types + `shouldReleaseEscrow` decision logic — keeping constants near their consumers)
- **Added `'refund_processing'`** to the canonical list — this is the safer superset. An order in `refund_processing` MUST block escrow release; missing it would let the seller be paid out while a refund is in flight.
- **Deleted** the duplicate from `src/services/escrowService.ts:50-53` — replaced with `import { BLOCKING_DISPUTE_STATUSES, BLOCKING_RETURN_STATUSES } from '../lib/escrowDecisions'`
- **Type change:** dropped `as const` → `string[]` to satisfy Prisma's `{ in: ... }` clause and `.includes(string)` calls. The array is module-level and never mutated.

### BLOCKING_DISPUTE_STATUSES

Was ALSO duplicated (escrowDecisions.ts:33 + escrowService.ts:50). Both copies were identical (`['open', 'counter_offered', 'escalated']`), so no divergence yet — but the duplicate was waiting to happen. Now imported from the same single source.

### Tripwire test update

- **Old TC-BLK-03:** asserted the DIVERGENCE (`not.toContain('refund_processing')`)
- **New TC-BLK-03:** asserts the list INCLUDES `refund_processing` — a future failure means someone removed it or re-forked the list

---

## Task 3 — issueFailureRefund adoption in remaining 2 sites

### cartCheckoutController.ts (D-C4 catch)

**Before:**
```typescript
try {
  const refund = await stripe.refunds.create({
    payment_intent: session.payment_intent as string,
    reason: 'requested_by_customer',
    metadata: { reason: 'cart_fulfillment_failed', session_id: session.id, error: ... },
  }, { idempotencyKey: `fulfillment_refund_${session.payment_intent}` });
  console.log(`[CART] Auto-refund issued: ${refund.id} for session ${session.id}`);
} catch (refundError: any) {
  console.error(`[CRITICAL] Cart auto-refund ALSO FAILED for session ${session.id}:`, refundError);
}
```

**After:**
```typescript
await issueFailureRefund(stripe, session.payment_intent as string, 'cart_fulfillment_failed', {
  reason: 'cart_fulfillment_failed',
  session_id: session.id,
  error: error.message?.substring(0, 200) || 'Unknown error',
});
```

**Behavioural equivalence:**
- Same idempotency key: `fulfillment_refund_${session.payment_intent}` ✓
- Same metadata keys and values: `reason`, `session_id`, `error` ✓
- Same Stripe args: `payment_intent`, `reason: 'requested_by_customer'` ✓
- Refund failure is caught and logged (helper does this internally) ✓
- **Log label change:** `[CART]` → `[REFUND]` on success, `[CRITICAL] Cart auto-refund ALSO FAILED` → `[CRITICAL] Auto-refund FAILED` on failure. Acceptable — labels are for ops grep, not user-facing.

### nativePaymentController.ts (confirmPayment catch)

**Before:**
```typescript
let refundIssued = false;
if (paymentIntentId) {
  try {
    const refund = await stripe.refunds.create({...}, { idempotencyKey: ... });
    refundIssued = true;
  } catch (refundError) { ... }
}
```

**After:**
```typescript
let refundIssued = false;
if (paymentIntentId) {
  refundIssued = await issueFailureRefund(stripe, paymentIntentId, 'native_fulfillment_failed', {
    reason: 'native_fulfillment_failed',
    buyer_id: req.user?.id || req.user?.sub || 'unknown',
    error: error.message?.substring(0, 200) || 'Unknown error',
  });
}
```

**Behavioural equivalence:**
- Same idempotency key: `fulfillment_refund_${paymentIntentId}` ✓
- Same metadata keys and values: `reason`, `buyer_id`, `error` ✓
- `refundIssued` boolean: helper returns `true` on success, `false` on failure — identical semantics ✓
- User-facing message logic unchanged: `refundIssued ? 'has been refunded' : 'is being processed'` ✓
- **Log label change:** `[PAY]` → `[REFUND]` on success, `[CRITICAL] Native auto-refund ALSO FAILED` → `[CRITICAL] Auto-refund FAILED` on failure. Acceptable.

### Cross-platform confirmation

Both refactored paths handle the same payments:
- **cartCheckoutController** = Stripe Checkout (web cart)
- **nativePaymentController** = Apple Pay / Google Pay (mobile)

Both now use the identical `issueFailureRefund` helper with the same idempotency key pattern. All 5 refund-on-failure sites now call the single shared helper.

### Security scan

No refund amount is specified in any `issueFailureRefund` call — Stripe refunds the full charge. No refund amount is read from any request body. Confirmed across all 5 call sites.

---

## Task 4 — DEF-03: Escrow re-arm timers (INVESTIGATION ONLY)

### Finding

**File:** `src/services/escrowService.ts:1326`
**Context:** `processExpiredReturns()` — when a buyer fails to ship their return within the deadline, the return is cancelled and escrow is re-armed so the seller gets paid.

**Code:**
```typescript
const escrowReleaseAt = new Date(now.getTime() + ESCROW_RELEASE_DAYS * 24 * 60 * 60 * 1000);
```

**Constant used:** `ESCROW_RELEASE_DAYS` = `INSPECTION_WINDOW_DAYS` = **3 days**

**Spec says:** §5B describes a failed-return path that re-arms escrow as `now + 5d`.

**Discrepancy:** Code uses 3 days, spec says 5 days. This is the only re-arm point in `escrowService.ts`. The seller gets paid 3 days after a failed return is cancelled, not 5.

**No code change made.** Harry decides whether to:
1. Update the spec to match the code (3 days — consistent with all other inspection windows)
2. Update the code to match the spec (5 days — gives more buffer for edge cases)
3. Create a separate `RETURN_EXPIRY_ESCROW_DAYS` constant if this timer should differ from the standard inspection window

---

## Verification

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx tsc --noEmit
(clean — no errors)

$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --runInBand --ci
Test Suites: 11 passed, 11 total
Tests:       2 skipped, 2 todo, 549 passed, 553 total
```

0 failures. Board stays GREEN. Test count rose from 552 → 553 (new RETURN_ESCROW_DAYS tripwire).
