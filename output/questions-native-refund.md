# FIND-PAY-02: Synchronous Refund in Native confirmPayment

**Branch:** `task/native-refund-fix`
**Base SHA:** `5578656` (origin/main, confirmed via `git merge-base`)
**Push target:** `clovis` (Clovis fork)

---

## The Bug

`nativePaymentController.confirmPayment` — the Apple Pay / Google Pay path — had a catch block that:
1. Returned 500
2. Told the buyer "Your payment has been refunded"
3. **Never called `stripe.refunds.create`**

The buyer was charged, told they were refunded, and the money only came back (if at all) via a 30-second orphaned-payment watchdog in the Stripe webhook.

## The Fix

Added a synchronous `stripe.refunds.create` call in the catch block, mirroring the existing cart checkout pattern (`cartCheckoutController.fulfillCartOrder`):

```typescript
const refund = await stripe.refunds.create({
  payment_intent: paymentIntentId,
  reason: 'requested_by_customer',
  metadata: {
    reason: 'native_fulfillment_failed',
    buyer_id: req.user?.id || req.user?.sub || 'unknown',
    error: error.message?.substring(0, 200) || 'Unknown error',
  },
}, {
  idempotencyKey: `fulfillment_refund_${paymentIntentId}`,
});
```

### Key decisions

- **Idempotency key:** `fulfillment_refund_${paymentIntentId}` — shared with the 30s watchdog (`stripeController.ts:501`). If both fire, Stripe deduplicates. The watchdog becomes a genuine backstop instead of a second refund.
- **Refund amount:** Not specified — Stripe refunds the full charge. No amount is read from the request body.
- **User-facing message:** Now accurate. If refund succeeds: "has been refunded." If refund fails: "is being processed" (the watchdog will still try).
- **500 status:** Preserved. The endpoint still returns 500 on failure.
- **Refund failure:** Logged at `[CRITICAL]` level and NOT swallowed. The endpoint still returns 500. This is the last line of defence before the watchdog.
- **30s watchdog:** NOT removed or modified. It stays as the backstop.

### Shared helper — not extracted

The refund-on-failure pattern now appears in 4 places:
1. `nativePaymentController.ts:591` (this fix)
2. `cartCheckoutController.ts:1087`
3. `stripeController.ts:492` (orphan safety net)
4. `stripeController.ts:855` (single-item D-C4)

I did NOT extract a shared helper because:
- Each site has different metadata (reason, session_id, buyer_id, listing_id, error)
- Each site has different log labels ([PAY], [CART], [WEBHOOK])
- Touching cartCheckoutController and stripeController is outside FIND-PAY-02's scope
- The pattern is simple (try/catch around one Stripe call)

**Recommendation:** Extract a shared `issueFulfillmentRefund(paymentIntentId, metadata)` helper in a cleanup pass after all three branches land.

---

## Cross-Platform Confirmation

`confirmPayment` handles both payment types via the `metadata.type` field:
- `native_single_item` → `fulfillSingleItem()` (line 563)
- `native_cart` → `fulfillCart()` (line 569)

Both branches throw into the same catch block. iOS (Apple Pay) and Android (Google Pay) both call the same `/api/payments/confirm` endpoint. The fix covers both platforms.

---

## Security Scan

The refund call does NOT specify an `amount` parameter. Stripe refunds the full charge amount from the PaymentIntent. No refund amount is read from the request body — confirmed.

---

## Test Results

### FIND-PAY-02 tests turned GREEN (2 existing + 4 new)

| Test | Status | Notes |
|------|--------|-------|
| stripe.refunds.create fires with correct payment_intent | **GREEN** | Was RED — now passes |
| refund metadata includes reason for audit trail | **GREEN** | Was RED — now passes |
| confirmPayment still returns 500 to client on failure | GREEN | Was already green |
| refund carries idempotency key `fulfillment_refund_<piId>` | **GREEN** | New test |
| stripe.refunds.create throws → still returns 500, logs [CRITICAL] | **GREEN** | New test |
| user-facing message accurate after successful refund | **GREEN** | New test |
| user-facing message differs when refund itself fails | **GREEN** | New test |

### FIND-PAY-02 test modifications

The two original FIND-PAY-02 assertions needed `expect.anything()` added as a second argument matcher. This is because Branch 1 (FIND-PAY-04) added mandatory idempotency keys to all refund calls. Jest's `toHaveBeenCalledWith` with a single matcher rejects calls with two arguments. The core assertions (correct `payment_intent`, correct `metadata.reason`) are unchanged — only the argument count matcher was adapted.

### FIND-PAY-03 tests STILL RED (2 failures)

| Test | Status |
|------|--------|
| fulfillOrder MUST refund when listing not found | **RED** |
| refund metadata includes listing_id | **RED** |

These are Branch 3's job. Not touched.

---

## Verification

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx tsc --noEmit
(clean — no errors)

$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --runInBand --ci
Test Suites: 1 failed, 10 passed, 11 total
Tests:       2 failed, 2 skipped, 2 todo, 542 passed, 548 total
```

2 failures = FIND-PAY-03 x2 (correct).
