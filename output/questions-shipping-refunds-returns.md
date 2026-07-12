# Shipping / Refunds / Returns — Questions, Findings & Report

**Date:** 2026-07-12
**Branch:** `task/shipping-refunds-returns-suite` from `origin/main` @ `4a06c19`
**Author:** Clovis (Opus execution)

---

## LOGIC MAP

### 1. Payment & Fulfilment Paths

| ID | Path | Entry Point | Refund on Failure? |
|-----|------|-------------|-------------------|
| PAY-1 | Native single item (Apple/Google Pay) | `nativePaymentController.confirmPayment` → `fulfillSingleItem` | **NO (BUG FIND-PAY-02)** |
| PAY-2 | Native cart (Apple/Google Pay) | `nativePaymentController.confirmPayment` → `fulfillCart` | **NO (BUG FIND-PAY-02)** |
| PAY-3 | Stripe checkout (single item) | `stripeController.handleWebhook` → `fulfillOrder` | YES (D-C4) for tx failure; **NO for listing-not-found (BUG FIND-PAY-03)** |
| PAY-4 | Cart checkout (web) | `cartCheckoutController.handleWebhook` → `fulfillCartOrder` | YES (D-C4) |
| PAY-5 | Orphan payment safety net | `stripeController.handleWebhook` (payment_intent.succeeded) | YES — 30s delayed auto-refund |

### 2. Refund Paths

| ID | Trigger | Controller/Service | Idempotency Key Pattern |
|-----|---------|-------------------|------------------------|
| REF-1 | Buyer cancel (5-min window) | `orderController.cancelOrder` | None (Stripe PI refund) |
| REF-2 | Seller cancel | `orderController.cancelOrder` | None (Stripe PI refund) |
| REF-3 | Auto-cancel (unshipped 5 days) | `escrowService.autoCancelUnshippedOrders` | `auto_cancel_refund_${order.id}` |
| REF-4 | Return refund (auto cron) | `escrowService.autoProcessReturnRefunds` | `return_refund_${returnRequest.id}` |
| REF-5 | Forced return confirm (seller) | `returnController.confirmReturnDelivered` | `forced_return_refund_${returnId}` |
| REF-6 | Forced return auto-confirm | `escrowService.autoConfirmForcedReturns` | `forced_return_refund_${returnRequest.id}` |
| REF-7 | Admin full refund | `adminRoutes POST /orders/:id/full-refund` | `admin_full_refund_${orderId}` |
| REF-8 | Admin return refund | `adminRoutes POST /returns/:id/refund` | (claim-the-row) |
| REF-9 | Insurance claim approval | `adminRoutes POST /claims/:id/approve` | None visible |
| REF-10 | Fulfilment failure (D-C4 — stripe) | `stripeController.fulfillOrder` catch | None (Stripe metadata only) |
| REF-11 | Fulfilment failure (D-C4 — cart) | `cartCheckoutController.fulfillCartOrder` catch | None (Stripe metadata only) |
| REF-12 | Dispute partial refund | `disputeController.adminResolveDispute` | Via admin routes |

### 3. Escrow Release Paths

| ID | Trigger | Controller/Service | Guard |
|-----|---------|-------------------|-------|
| ESC-1 | Auto-release (3 days after delivery) | `escrowService.autoReleaseEscrow` | No blocking dispute/return, no existing transfer |
| ESC-2 | Buyer confirm receipt (early) | `orderController.confirmReceipt` | No blocking dispute/return, no existing transfer |
| ESC-3 | Admin/cron complete | `orderController.completeOrder` | None |

### 4. Return Flow

| ID | Step | Controller Method | Key Detail |
|-----|------|-------------------|-----------|
| RET-1 | Create return request | `returnController.createReturnRequest` | Status = 'approved' or 'awaiting_address' |
| RET-2 | Get shipping rates | `returnController.getReturnShippingRates` | Buyer→seller direction |
| RET-3a | Buyer purchases label | `returnController.purchaseReturnLabelBuyer` | Label cost deducted from refund_amount |
| RET-3b | Seller purchases label | `returnController.purchaseReturnLabelSeller` | Seller pays, shipping_deducted=0 |
| RET-3c | Platform purchases label (forced) | `forcedReturnService.createForcedReturn` | Auto-purchase, cheapest tracked rate |
| RET-4 | Buyer marks shipped | `returnController.markReturnShipped` | Status → 'shipped' |
| RET-5a | Seller confirms delivery (normal) | `returnController.confirmReturnDelivered` | Status → 'delivered', escrow_release_at = now + 5 days |
| RET-5b | Seller confirms delivery (forced) | `returnController.confirmReturnDelivered` | Immediate 100% refund, order → 'returned' |
| RET-6 | Auto-confirm forced return | `escrowService.autoConfirmForcedReturns` | 3 days after DELIVERED or 14 days after shipped |
| RET-7 | Auto-expire unshipped return | `escrowService.autoExpireReturns` | 5 days, closes linked dispute |
| RET-8 | Return refund cron | `escrowService.autoProcessReturnRefunds` | After escrow_release_at |

### 5. Dispute Flow

| ID | Step | Controller/Service | Key Detail |
|-----|------|-------------------|-----------|
| DIS-1 | Open dispute | `orderController.openDispute` | Buyer-only, clears escrow_release_at |
| DIS-2 | Seller responds | `disputeController` | Accept / counter (10-60%) / reject |
| DIS-3 | Auto-escalate | `escrowService.autoEscalateDisputes` | 72h no response, or counter buyer_deadline expired |
| DIS-4 | Admin resolve | `adminRoutes PUT /disputes/:id/resolve` | Partial (10-60%) or full (100% + forced return) |

### 6. Shipping Flow

| ID | Step | Controller/Service | Key Detail |
|-----|------|-------------------|-----------|
| SHIP-1 | Get rates | `shippingController.getShippingRates` | Filters tracked only |
| SHIP-2 | Create label (manual) | `shippingController.createShippingLabel` | Updates all orders with same stripe_payment_intent_id |
| SHIP-3 | Auto-purchase label | `autoShippingService.autoPurchaseLabel` | Cost ceiling check, preferred carrier within 20% |
| SHIP-4 | Tracking webhook | `shippingController.handleShippoWebhook` | PRE_TRANSIT→to_ship, TRANSIT→in_transit, DELIVERED→delivered |
| SHIP-5 | Lost-in-transit check | `escrowService.checkLostInTransit` | 14 days without delivery |
| SHIP-6 | Return ship reminder | `escrowService.sendReturnShipReminders` | 24h before deadline |

---

## SPEC-CODE DIVERGENCES

| ID | What | Spec Says | Code Does | Severity |
|-----|------|-----------|-----------|----------|
| DIV-1 | Escrow release days | §2.3, §4.5: 5 days | ESCROW_RELEASE_DAYS = INSPECTION_WINDOW_DAYS = 3 | HIGH — policy-owner confirmed 3 is correct |
| DIV-2 | Dispute window | §5.1: 5 days from delivery | DISPUTE_WINDOW_DAYS = INSPECTION_WINDOW_DAYS = 3 | HIGH — same as DIV-1 |
| DIV-3 | Return escrow days | Not explicit in spec | returnController.ts hardcodes RETURN_ESCROW_DAYS = 5, main path uses 3 | MEDIUM — inconsistency |
| DIV-4 | BLOCKING_RETURN_STATUSES | Should be identical | escrowService.ts includes 'refund_processing', escrowDecisions.ts does NOT | MEDIUM — could cause release during refund |
| DIV-5 | FIND-PAY-02 | §4.1: "no payment without path to refund" | nativePaymentController.confirmPayment catch says "refunded" but never calls stripe.refunds.create | **CRITICAL** |
| DIV-6 | FIND-PAY-03 | §4.1: every post-charge path must refund | stripeController.fulfillOrder returns silently when listing not found — no refund | **CRITICAL** |

---

## FILES CHANGED

| File | What | Why |
|------|------|-----|
| `src/__tests__/unit/paymentMoneySafety.test.ts` | Rewrote TC-MONEY-03 (3 tests) | HYG-04: now asserts `stripe.refunds.create` fires — 2 tests RED (FIND-PAY-02) |
| `src/__tests__/unit/shippingRefundsReturns.test.ts` | New file (55 tests) | FIND-PAY-03 (2 RED), forced return threshold, refund policy, return payer, blocking statuses, timing tripwires |

---

## RED TEST INVENTORY (must be RED on delivery)

| Test | File | Bug ID | Why RED |
|------|------|--------|---------|
| `FIND-PAY-02: stripe.refunds.create fires with correct payment_intent on stock failure` | paymentMoneySafety.test.ts | FIND-PAY-02 | `confirmPayment` catch never calls `stripe.refunds.create` |
| `FIND-PAY-02: refund metadata includes reason for audit trail` | paymentMoneySafety.test.ts | FIND-PAY-02 | Same root cause — no refund call at all |
| `FIND-PAY-03: stripe.refunds.create fires when listing does not exist` | shippingRefundsReturns.test.ts | FIND-PAY-03 | `fulfillOrder` does `return;` when listing is null — no refund |
| `FIND-PAY-03: refund metadata includes listing_id for reconciliation` | shippingRefundsReturns.test.ts | FIND-PAY-03 | Same root cause — silent return |

---

## TEST CASE ENUMERATION

### Category 1: Known Bugs (must be RED)

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-PAY-02a | confirmPayment stock failure → refund fires | `stripe.refunds.create` called with payment_intent | RED |
| TC-PAY-02b | confirmPayment stock failure → refund has metadata | metadata.reason = `fulfillment_failed` | RED |
| TC-PAY-02c | confirmPayment stock failure → returns 500 | res.statusCode = 500 | GREEN |
| TC-PAY-03a | fulfillOrder listing-not-found → refund fires | `stripe.refunds.create` called with payment_intent | RED |
| TC-PAY-03b | fulfillOrder listing-not-found → refund has listing_id | metadata.listing_id present | RED |

### Category 2: Forced Return Threshold (boundary)

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-FRT-01 | FORCED_RETURN_THRESHOLD = MAX_PARTIAL_FRACTION = 0.60 | Constant tripwire | GREEN |
| TC-FRT-02 | Exactly 60% → no forced return | `isForceReturnThreshold(60, 100)` = false | GREEN |
| TC-FRT-03 | 60.01% → forced return | `isForceReturnThreshold(60.01, 100)` = true | GREEN |
| TC-FRT-04 | 100% → forced return | `isForceReturnThreshold(100, 100)` = true | GREEN |
| TC-FRT-05 | 50% → no forced return | `isForceReturnThreshold(50, 100)` = false | GREEN |
| TC-FRT-06 | Zero item cost → no forced return | Safety guard | GREEN |
| TC-FRT-07 | Negative item cost → no forced return | Safety guard | GREEN |
| TC-FRT-08 | £200 item boundary | 120 = false, 120.01 = true | GREEN |

### Category 3: Refund Policy Rules

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-RP-01..07 | Buyer allowed percents: 10,20,30,40,50,60,100 | All true | GREEN |
| TC-RP-08..22 | Buyer disallowed percents: 0,5,15,25,...,101,-10 | All false | GREEN |
| TC-RP-23..28 | Counter allowed: 10-60 | All true | GREEN |
| TC-RP-29 | Counter 100% blocked (accept, don't counter) | false | GREEN |
| TC-RP-30 | Counter 0% blocked | false | GREEN |
| TC-RP-31..35 | Admin partial: £60 OK, £0.01 OK, £60.01 blocked, 0 blocked, negative blocked | Correct | GREEN |
| TC-RP-36 | PARTIAL_REFUND_PERCENTS constant | [10,20,30,40,50,60] | GREEN |
| TC-RP-37 | FULL_REFUND_PERCENT constant | 100 | GREEN |

### Category 4: Return Label Payer

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-RLP-01 | Forced return → platform pays | 'platform' | GREEN |
| TC-RLP-02 | Normal return → buyer pays | 'buyer' | GREEN |

### Category 5: Timing Constants (tripwires)

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-TIM-01 | FORCED_RETURN_SELLER_CONFIRM_DAYS = 3 | Constant | GREEN |
| TC-TIM-02 | FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS = 14 | Constant | GREEN |
| TC-TIM-03 | FORCED_RETURN_SHIP_DEADLINE = RETURN_SHIPPING_DEADLINE | Equal | GREEN |
| TC-TIM-04 | ESCROW_RELEASE_DAYS = INSPECTION_WINDOW_DAYS = 3 | Constant | GREEN |
| TC-TIM-05 | RETURN_SHIPPING_DEADLINE_DAYS = 5 | Constant | GREEN |

### Category 6: Blocking Status Divergence (tripwires)

| TC ID | Description | Expected | Status |
|-------|-------------|----------|--------|
| TC-BLK-01 | BLOCKING_DISPUTE_STATUSES = [open, counter_offered, escalated] | Array match | GREEN |
| TC-BLK-02 | BLOCKING_RETURN_STATUSES = [pending, approved, awaiting_address, label_created, shipped, delivered] | Array match | GREEN |
| TC-BLK-03 | escrowDecisions does NOT include 'refund_processing' | Divergence documented | GREEN |

---

## COVERAGE TABLE

| Area | Existing Tests | New Tests | Gaps Remaining |
|------|---------------|-----------|----------------|
| Payment fulfilment refund (native) | TC-MONEY-03 (old, weak) | HYG-04 rewrite (3 tests, 2 RED) | Fix FIND-PAY-02 |
| Payment fulfilment refund (stripe) | TC-MONEY-02 (cart path only) | FIND-PAY-03 (2 tests, 2 RED) | Fix FIND-PAY-03 |
| Escrow decision functions | 42 tests in escrowService.test.ts | — | Covered |
| Forced return threshold | None | 8 tests | Covered |
| Refund policy rules | None | 37 tests | Covered |
| Return label payer | None | 2 tests | Covered |
| Timing constants | 5 in escrowService + 10 in orderLifecycle | 5 more (forced return, return escrow) | Covered |
| Blocking status lists | None | 3 tests (incl. divergence tripwire) | Covered |
| Fee calculations | 15 tests in feeCalculations.test.ts + 9 in paymentMoneySafety | — | Covered |
| Order state machine | 22 tests in orderLifecycle.test.ts | — | Covered |
| Cancel order flow | None | — | **GAP**: cancel refund path, stock restore, cancel-after-scan, 5-min window |
| Confirm receipt blocking | None | — | **GAP**: blocking dispute/return check on early release |
| Admin full refund | None | — | **GAP**: buyer_total vs amount, claim-the-row |
| Shippo webhook status mapping | None | — | **GAP**: PRE_TRANSIT/TRANSIT/DELIVERED mapping |
| Auto-shipping rate selection | None | — | **GAP**: cost ceiling, preferred carrier within 20% |
| Insurance claim flow | None | — | **GAP**: file/approve/deny paths |

---

## VERIFICATION OUTPUT

### 1. Type check

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx tsc --noEmit
(no output — clean)
```

### 2. Full unit suite

```
$ NODE_OPTIONS=--max-old-space-size=1536 npx jest --selectProjects unit --runInBand --ci

Test Suites: 2 failed, 9 passed, 11 total
Tests:       4 failed, 2 skipped, 2 todo, 524 passed, 532 total
Snapshots:   0 total
Time:        ~1.8s
```

**Failing tests (expected RED — known bugs):**
1. `FIND-PAY-02: stripe.refunds.create fires with correct payment_intent on stock failure` — paymentMoneySafety.test.ts
2. `FIND-PAY-02: refund metadata includes reason for audit trail` — paymentMoneySafety.test.ts
3. `FIND-PAY-03: stripe.refunds.create fires when listing does not exist` — shippingRefundsReturns.test.ts
4. `FIND-PAY-03: refund metadata includes listing_id for reconciliation` — shippingRefundsReturns.test.ts

**Delta from baseline (4a06c19):**
- Suites: 10 → 11 (+1: shippingRefundsReturns.test.ts)
- Tests: 474 → 532 (+58: 55 new in shippingRefundsReturns + 3 net in paymentMoneySafety)
- 4 intentionally RED (known bugs assert spec, not code)
- All other 524 tests GREEN

### 3. A fully-green board means you did it wrong

**Confirmed:** 4 tests are RED. They assert the SPEC, not the code. This is correct per the brief.

---

## QUESTIONS FOR HARRY

### Q1: Return escrow days inconsistency (DIV-3)

`returnController.ts` hardcodes `RETURN_ESCROW_DAYS = 5` for normal return delivery, while the main delivery path uses `ESCROW_RELEASE_DAYS = INSPECTION_WINDOW_DAYS = 3`.

**Is 5 days intentional for returns?** Returns might warrant a longer inspection window since the seller is re-inspecting a returned item. But it's a local constant, not imported from config.

**Recommendation:** Make it explicit either way — import from constants or add a comment explaining why returns get 5 days.

### Q2: BLOCKING_RETURN_STATUSES divergence (DIV-4)

`escrowService.ts` line ~43 includes `'refund_processing'` in BLOCKING_RETURN_STATUSES but `escrowDecisions.ts` line ~34 does NOT.

**Risk:** If escrowDecisions.ts is ever used for the release check (as the refactor proposal suggests), a return in `refund_processing` status would NOT block escrow release — potentially releasing funds while a refund is in flight.

**Recommendation:** Add `'refund_processing'` to `escrowDecisions.ts` BLOCKING_RETURN_STATUSES to match the service. This is a one-line change.

### Q3: FIND-PAY-03 — listing-not-found is the narrowest interpretation

The brief says "post-charge stock recheck fails." The [D-C4] fix actually handles transaction failure (including stock recheck) correctly. The remaining gap is the pre-transaction listing-not-found path at line 638-640 of stripeController.ts. I've written the test against the listing-not-found path, which IS the silent abort with no refund. Confirm this is the intended target.

### Q4: Remaining coverage gaps

The following areas have NO regression tests yet. Recommend a follow-up brief:
- Cancel order flow (refund, stock restore, cancel-after-scan, 5-min buyer window)
- Confirm receipt blocking checks
- Admin full refund (buyer_total calculation, claim-the-row)
- Shippo webhook status mapping
- Auto-shipping rate selection (cost ceiling, preferred carrier)
- Insurance claim flow (file/approve/deny)
