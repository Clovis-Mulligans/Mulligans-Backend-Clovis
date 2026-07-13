# FIND-PAY-03: Refund on Silent Fulfilment Abort

**Branch:** `task/fulfillorder-refund-fix`
**Base SHA:** `12f96f1` (origin/main, confirmed via `git ls-remote`)
**Push target:** `clovis` (Clovis fork)

---

## The Bugs (2 found)

### BUG 1 — Listing not found (stripeController.ts:640-642)

`fulfillOrder` has an early return when the listing is null. The buyer is charged (Stripe session completed), but no refund is issued. The webhook returns 200 to Stripe, and the charge is silently swallowed.

```typescript
// BEFORE
if (!listing) {
  console.error('Listing not found:', listing_id);
  return;  // ← silent abort, no refund
}
```

### BUG 2 — Address validation throw (stripeController.ts:670)

`validateShippingAddress(shippingAddressJson)` throws `AddressValidationError` which propagates up to the webhook handler. The webhook handler logs, emails ops, and returns 200 — but never issues a refund.

Both bugs exist ONLY in `stripeController.fulfillOrder` (single-item checkout). `cartCheckoutController.fulfillCartOrder` is clean — its outer try/catch at line 1081 wraps everything including address validation and issues a refund for all exceptions.

---

## The Fix

### Shared helper: `src/lib/issueFailureRefund.ts`

Extracted the refund-on-failure pattern into a shared function:

```typescript
export async function issueFailureRefund(
  stripe: Stripe,
  paymentIntentId: string,
  reason: string,
  metadata: FailureRefundMetadata,
): Promise<boolean>
```

- Constructs deterministic idempotency key `fulfillment_refund_${paymentIntentId}`
- Calls `stripe.refunds.create` with the key and metadata
- Logs `[REFUND]` on success, `[CRITICAL]` on failure
- Returns boolean (true = refunded, false = refund failed)
- Never throws — failures are caught and logged

### BUG 1 fix (listing not found)

```typescript
if (!listing) {
  console.error('Listing not found:', listing_id);
  if (session.payment_intent) {
    await issueFailureRefund(stripe, session.payment_intent as string, 'listing_not_found', {
      reason: 'listing_not_found',
      listing_id,
      buyer_id,
      session_id: session.id,
    });
  }
  return;
}
```

### BUG 2 fix (address validation)

```typescript
try {
  validateShippingAddress(shippingAddressJson);
} catch (addrError: any) {
  if (addrError instanceof AddressValidationError && session.payment_intent) {
    await issueFailureRefund(stripe, session.payment_intent as string, 'address_validation_failed', {
      reason: 'address_validation_failed',
      listing_id,
      buyer_id,
      session_id: session.id,
      error: addrError.message?.substring(0, 200) || 'Address validation failed',
    });
  }
  throw addrError;  // re-throw so webhook handler still logs + emails ops
}
```

### Existing sites refactored

The shared helper also replaces inline refund code at:
- `stripeController.ts` D-C4 catch block (single-item fulfilment failure)
- `stripeController.ts` orphan watchdog (30s safety net)

These sites previously had bespoke try/catch around `stripe.refunds.create`. Now they call `issueFailureRefund`, reducing duplication. The idempotency keys and metadata are preserved exactly.

### Sites NOT refactored (out of scope)

- `cartCheckoutController.ts:1087` — different controller, same pattern but different log labels
- `nativePaymentController.ts:591` — different controller, also needs `refundIssued` boolean for user message

These can be refactored in a follow-up cleanup pass.

---

## Cross-Platform Confirmation

`fulfillOrder` handles single-item Stripe Checkout sessions only. Cart checkout goes through `fulfillCartOrder` (already clean). Native payment (Apple/Google Pay) goes through `nativePaymentController.confirmPayment` (fixed in Branch 2). All three checkout paths now have refund coverage on all post-charge failure paths.

---

## Security Scan

The refund call does NOT specify an `amount` parameter. Stripe refunds the full charge amount from the PaymentIntent. No refund amount is read from the request body — confirmed across all sites using the shared helper.

---

## Test Results

### FIND-PAY-03 tests turned GREEN (2 existing + 4 new)

| Test | Status | Notes |
|------|--------|-------|
| stripe.refunds.create fires with correct payment_intent | **GREEN** | Was RED — now passes |
| refund metadata includes listing_id for reconciliation | **GREEN** | Was RED — now passes |
| listing-not-found refund carries idempotency key | **GREEN** | New test |
| refund failure does not throw — webhook returns 200 | **GREEN** | New test |
| address validation failure triggers refund before propagating | **GREEN** | New test |
| happy path — listing exists, address valid → no refund | **GREEN** | New test |

### FIND-PAY-03 test modifications

The two original FIND-PAY-03 assertions needed `expect.anything()` added as a second argument matcher. Same adaptation as FIND-PAY-02 in Branch 2: `stripe.refunds.create` is now called with 2 args (payload + idempotency key options) via the shared helper. Jest's `toHaveBeenCalledWith` with a single matcher rejects 2-arg calls. The core assertions (correct `payment_intent`, correct `metadata.listing_id`) are unchanged.

---

## Verification

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx tsc --noEmit
(clean — no errors)

$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --runInBand --ci
Test Suites: 11 passed, 11 total
Tests:       2 skipped, 2 todo, 548 passed, 552 total
```

0 failures. Board is fully GREEN.

---

## Questions for Harry

1. **Address validation refund + re-throw** — BUG 2's fix issues a refund then re-throws the `AddressValidationError`. The webhook handler still catches it, logs it, and emails `info@mulligans.uk.com`. This means ops gets the email AND the buyer gets refunded. Is that the right behaviour, or should the re-throw be suppressed (just return silently after refunding)?

2. **Shared helper adoption** — `issueFailureRefund` is used in `stripeController.ts` (3 sites). Should `cartCheckoutController.ts` and `nativePaymentController.ts` also be refactored to use it in a follow-up, or leave them as-is since they work correctly?
