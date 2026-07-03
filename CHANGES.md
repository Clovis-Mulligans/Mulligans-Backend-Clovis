# QTY-FIX-01: Money-Critical Bug Fixes

Branch: `task/qty-fix-01-money` based from `clovis/pro-seller-foundation` at `a24e1c5`

## Fixes implemented

### C-2 — Missing `charge.dispute.closed` handler (CRITICAL)

**File:** `src/controllers/stripeController.ts`

Stripe fires `charge.dispute.closed` with status `won` or `lost`. Before this fix, there was no handler — a lost dispute left orders stuck in `disputed` status forever, stock never restored, and no admin notification.

**Fix:** Added full `charge.dispute.closed` case in the webhook switch. On `lost`: single `$transaction` updates claims from `disputed` -> `refunded`, calls `restoreListingStock(tx, ...)` per order, sends admin notification. On `won`: updates claims from `disputed` -> `to_ship`, sends admin notification. Idempotent — if no rows match the status filter, the handler exits cleanly.

**Status transitions:**

| Event | From | To |
|-------|------|----|
| dispute.closed (lost) | disputed | refunded |
| dispute.closed (won) | disputed | to_ship |

### H-1 — TOCTOU race in idempotency checks (HIGH x 3 controllers)

**Files:** `src/controllers/stripeController.ts` (H-1a), `src/controllers/cartCheckoutController.ts` (H-1b), `src/controllers/nativePaymentController.ts` (H-1c)

All three checkout controllers had the same pattern: check for existing orders *outside* the `$transaction`, then create orders *inside* it. Under concurrent Stripe webhooks, both checks pass, both transactions create orders -> duplicate fulfilment.

**Fix:** Moved the idempotency check inside each `$transaction` callback so the check and the create share the same serializable transaction. Uses a skip sentinel (`{ skipped: true as const }`) to signal early exit without throwing. The transaction commits as a no-op; post-tx code checks the sentinel and returns early.

- **H-1a** (`stripeController.ts` `fulfillOrder`): `tx.orders.findFirst` inside tx
- **H-1b** (`cartCheckoutController.ts` `fulfillCartOrder`): `tx.orders.findMany` inside tx
- **H-1c** (`nativePaymentController.ts` `fulfillSingleItem` + `fulfillCart`): `tx.orders.findFirst` / `tx.orders.findMany` inside tx

### H-3 — Admin refund callback-form tx (HIGH)

**File:** `src/routes/adminRoutes.ts`

The admin refund endpoint used `prisma.$transaction([...])` (array form), which runs Prisma operations in sequence but does NOT roll back on failure. `restoreListingStock` was called *after* the transaction, so a stock-restore failure left the order marked `refunded` with no stock returned.

**Fix:** Converted to callback-form `prisma.$transaction(async (tx) => { ... })` and moved `restoreListingStock(tx, ...)` inside the callback. Now if stock restore fails, the entire transaction (including the order status update) rolls back.

### S-5 — Null escrow on `charge.dispute.created` (SWEEP)

**File:** `src/controllers/stripeController.ts`

When a dispute opens, orders move to `disputed` but `escrow_release_at` was left populated. If the merchant wins the dispute, the escrow timer could fire during the dispute window and release funds prematurely.

**Fix:** Added `escrow_release_at: null` to the `updateMany` data in the `charge.dispute.created` handler.

### S-6 — Stock restore clobbers `off_sale` status (SWEEP)

**File:** `src/lib/stockUtils.ts`

`restoreListingStock` set any non-deleted listing back to `active`. Listings that were `off_sale` before the order would be resurrected as `active` — the seller's intent to hide the listing was lost.

**Fix:** Changed status logic to preserve both `deleted` and `off_sale`:
```
const newStatus = (listing.status === 'deleted' || listing.status === 'off_sale')
  ? listing.status : 'active';
```
Applied to both the simple path (line 64) and the size-variant path (line 91).

### M-4 — No real refund in native payment error path (MEDIUM)

**File:** `src/controllers/nativePaymentController.ts`

When `confirmPayment` threw after the PI succeeded (e.g. stock exhausted during fulfilment), the catch block returned an error message to the user but never issued a Stripe refund. The orphaned-payment safety net would eventually catch it, but users saw "payment failed" with money taken and no immediate refund.

**Fix:** Added `stripe.refunds.create({ payment_intent: piId })` in the catch block. On success, user message says "Your payment has been refunded." On refund failure, says "Your refund is being processed" (safety net will retry). No double-refund risk: the safety net checks for existing orders before refunding, and Stripe rejects refunding an already-fully-refunded PI.

### Schema — Non-unique index on `stripe_payment_intent_id`

**File:** `prisma/schema.prisma`

Cart checkout creates multiple order rows per payment intent (one per seller). A `@@unique` constraint would break this. Added `@@index([stripe_payment_intent_id])` (non-unique) to the orders model for query performance on idempotency lookups and dispute handlers.

## Tests

**File:** `src/__tests__/unit/qtyFix01.test.ts` — 30 tests, all pass.

| Fix | Functional tests | Structural tests | Total |
|-----|-----------------|------------------|-------|
| S-6 | 4 (invoke restoreListingStock, verify status preserved) | 0 | 4 |
| C-2 | 3 (simulate dispute handler logic, verify status transitions) | 5 (handler exists, imports, tx wrapping) | 8 |
| H-1 | 0 | 7 (verify findFirst/findMany inside tx callback, all 3 controllers) | 7 |
| H-3 | 2 (simulate tx rollback on stock-restore failure) | 2 (callback-form tx, restoreListingStock inside) | 4 |
| S-5 | 0 | 1 (escrow_release_at: null in handler) | 1 |
| M-4 | 2 (user message logic with/without refund) | 3 (stripe.refunds.create in catch, req.body fallback) | 5 |
| Schema | 0 | 1 (@@index present, not @@unique) | 1 |

Structural tests follow the `checkoutOversellLock.test.ts` pattern and are clearly labelled.

**Existing tests updated** (to match H-1 in-transaction pattern):
- `cartPartialClear.test.ts` — added `findMany` mock to tx object (4 tests pass)
- `fulfilmentDispatch.test.ts` — updated idempotency assertions (15 tests pass)
- `sellerCheckoutE2E.test.ts` — added `findMany` mock, updated replay test (13 tests pass)

**Test suite results:** 19 suites pass, 461 tests pass. 3 pre-existing failures (registration.test.ts TS errors, refreshTokens.test.ts missing supertest, apiEndpoints.test.ts no server).

**TypeScript:** `npx tsc --noEmit` clean (4 pre-existing auth errors only, none from these changes).

## Diff stats

```
 prisma/schema.prisma                          |   1 +
 src/__tests__/unit/cartPartialClear.test.ts   |   4 +-
 src/__tests__/unit/fulfilmentDispatch.test.ts |  32 ++++---
 src/__tests__/unit/sellerCheckoutE2E.test.ts  |  17 +++-
 src/controllers/cartCheckoutController.ts     |  21 ++---
 src/controllers/nativePaymentController.ts    |  66 +++++++++----
 src/controllers/stripeController.ts           | 129 +++++++++++++++++++++++---
 src/lib/stockUtils.ts                         |   4 +-
 src/routes/adminRoutes.ts                     |  32 +++----
 9 files changed, 226 insertions(+), 80 deletions(-)
 1 new file: src/__tests__/unit/qtyFix01.test.ts
```

## Deploy notes

1. **Schema migration required:** Run `npx prisma migrate dev --name add-order-pi-index` to create the non-unique index on `stripe_payment_intent_id`. Additive index only -- no data migration, no downtime. Can be applied while the server is running.

2. **No env changes.** No new dependencies.

3. **Stripe webhook:** The `charge.dispute.closed` handler is new. Ensure this event type is enabled in the Stripe webhook dashboard (Dashboard -> Developers -> Webhooks -> select endpoint -> add `charge.dispute.closed`). The `charge.dispute.created` event should already be enabled.

4. **Rollback:** All fixes are backward-compatible. The schema index can be dropped without code changes. The dispute handler simply won't fire if the event isn't enabled.

## Security checklist

- [x] No new env vars or secrets
- [x] No new API endpoints (webhook handler is a new case in existing endpoint)
- [x] Transaction boundaries verified -- all money-touching writes are inside $transaction callbacks
- [x] Idempotency checks are inside transactions (no TOCTOU window)
- [x] Stripe refund in catch block uses req.body?.paymentIntentId (safe -- already validated by Stripe retrieve)
- [x] Admin route change is within existing auth middleware (no new exposure)
- [x] No SQL injection vectors (all queries use Prisma ORM)
- [x] Status transitions are uni-directional (disputed -> refunded/to_ship, never backward)
