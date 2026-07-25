# Web Checkout Money-Path Safety Audit

**Branch:** `task/audit-web-money-safety`
**Base:** `origin/main` @ `0a84e23`
**Date:** 2026-07-25
**Author:** Clovis (audit only — zero source changes)

---

## Branch verification

```
$ git remote -v
clovis  git@github.com:Clovis-Mulligans/Mulligans-Backend-Clovis.git (fetch/push)
origin  https://...@github.com/HS-Mulligans/Mulligans-Backend.git (fetch/push)

$ git fetch origin
$ git checkout -b task/audit-web-money-safety origin/main

$ git rev-parse HEAD
0a84e23245911f8cd43a89eee6a50f553c8633e9  ✓

$ git status --short
(clean)
```

---

## TIER 0 — Checkout topology

### Entry point map

| # | Route | Controller | Function | Stripe method | Client | Auth |
|---|-------|-----------|----------|--------------|--------|------|
| 1 | `POST /api/stripe/create-checkout-session` | `StripeController` | `createCheckoutSession` | `checkout.sessions.create` | Web (hosted checkout) | `authenticateToken` |
| 2 | `POST /api/stripe/create-cart-checkout` | `CartCheckoutController` | `createCartCheckoutSession` | `checkout.sessions.create` | Web (hosted checkout) | `authenticateToken` |
| 3 | `POST /api/stripe/native-payment/single-item` | `NativePaymentController` | `createSingleItemPaymentIntent` | `paymentIntents.create` | Mobile (Apple/Google Pay) | `authenticateToken` |
| 4 | `POST /api/stripe/native-payment/cart` | `NativePaymentController` | `createCartPaymentIntent` | `paymentIntents.create` | Mobile (Apple/Google Pay) | `authenticateToken` |
| 5 | `POST /api/stripe/native-payment/fulfill` | `NativePaymentController` | `confirmPayment` | `paymentIntents.retrieve` | Mobile (fulfillment) | `authenticateToken` |
| 6 | `POST /api/stripe/webhook` | `StripeController` | `handleWebhook` | — | Stripe (callback) | Stripe signature |

### How orders are created

| Path | Trigger | Controller | Order creation | file:line |
|------|---------|-----------|---------------|-----------|
| Web single-item | Webhook `checkout.session.completed` (metadata `type: single_item`) | `StripeController.fulfillOrder` | `tx.orders.create` | `stripeController.ts:758` |
| Web cart | Webhook `checkout.session.completed` (metadata `type: cart_checkout`) | `CartCheckoutController.fulfillCartOrder` | `tx.orders.create` (per item) | `cartCheckoutController.ts:776` |
| Mobile single-item | Client calls `/native-payment/fulfill` | `NativePaymentController.fulfillSingleItem` | `tx.orders.create` | `nativePaymentController.ts:683` |
| Mobile cart | Client calls `/native-payment/fulfill` | `NativePaymentController.fulfillCart` | `tx.orders.create` (per item) | `nativePaymentController.ts:1041` |

### Key structural observations

1. **No server-side web/mobile differentiation.** There is no middleware, header check, or platform flag. The client self-selects which endpoint to call. All checkout routes require `authenticateToken`.

2. **Two session-creating controllers exist because the architecture is a 2×2 matrix:** single-item vs cart, crossed with web (Stripe Checkout Sessions) vs mobile (PaymentIntents). `stripeController` handles web single-item; `cartCheckoutController` handles web cart; `nativePaymentController` handles both mobile single-item and mobile cart.

3. **The mobile PaymentIntent path is the only mobile checkout.** Mobile does NOT use hosted sessions. Conversely, web does NOT use PaymentIntents for purchase (only sessions).

4. **Web orders are created server-side via webhook.** Mobile orders are created client-side via `/fulfill` endpoint. This is the fundamental architectural split and drives most of the divergences below.

---

## TIER 1 — Is the web money path safe?

### Protection matrix

| # | Protection | Mobile | Web | Severity | Detail |
|---|-----------|--------|-----|----------|--------|
| 5 | **Ship timer (`auto_cancel_at`) set at creation** | YES `nativePaymentController.ts:702,1059` | YES `stripeController.ts:775`, `cartCheckoutController.ts:795` | — | Both paths call `calculateShippingDeadline(new Date())` |
| 5 | **Ship timer NOT cleared on PRE_TRANSIT** | YES (fix in `0a84e23`) | YES (same webhook handler) | **P1 — fixed** | See root-cause below |
| 6 | **Shippo webhook shared** | YES | YES | — | Single webhook handler at `shippingController.ts:640` processes all orders by `tracking_number`, regardless of origin |
| 7 | **Payout guard: `sellerCanReceivePayout`** | YES — `confirmReceipt` uses `transferToSeller` (`orderController.ts:811`); escrow auto-release checks directly (`escrowService.ts:626`) | YES — same routes, same escrow cron | — | Web orders reach the same `confirmReceipt` and escrow-release paths |
| 8 | **Payout via `transferToSeller` helper** | YES — `confirmReceipt` (`orderController.ts:811`), `completeOrder` (`orderController.ts:1692`) | YES — same endpoints | **P2** | Escrow auto-release (`escrowService.ts:750`) calls `stripe.transfers.create` directly — same guards but duplicated logic |
| 9 | **Idempotency on payout** | YES — idempotency key on all transfer paths | YES — same paths | — | `confirm_receipt_transfer_{orderId}`, `escrow_release_group_{trackingKey}` |
| 10 | **Order always created after payment** | YES — client retries + 30s orphan auto-refund (`stripeController.ts:483-522`) | **NO** | **P1** | See finding 10 below |
| 11 | **Fees via canonical `feeCalculations.ts`** | NO — inline | NO — inline | **P2** | Both compute inline; see fee analysis below |
| 12 | **Guest buyer handling** | N/A | N/A | **P3** | `gcus_` is a Stripe-internal prefix — see finding 12 |
| 13 | **Auth gate on checkout** | `authenticateToken` | `authenticateToken` | — | Both require valid JWT |
| 14 | **`orders.source` populated** | NO | NO | **P3 — known** | Column is always NULL |

---

### Finding 5 — ROOT CAUSE: Ship timer (`auto_cancel_at`) did not fire on the owner's web order

**Severity: P1 — fixed in `0a84e23`**

**Root cause:**

Before commit `50fff1e` (merged in `0a84e23`), the Shippo webhook handler at `shippingController.ts` cleared `auto_cancel_at` on **every** tracking event, including `PRE_TRANSIT`:

```
// OLD CODE (before 50fff1e):
data: {
  ...
  auto_cancel_at: null,   // cleared on ANY tracking event
}
```

The chain of events for the owner's web order:

1. Buyer completes Stripe Checkout → webhook fires → `fulfillOrder` creates order with `auto_cancel_at` set correctly
2. `autoPurchaseLabel` runs immediately after (`stripeController.ts:893`) → creates a Shippo label
3. Shippo sends a `track_updated` webhook with `PRE_TRANSIT` status (label created, parcel NOT yet at carrier)
4. **Old code cleared `auto_cancel_at = null`** on this PRE_TRANSIT event
5. Order now has `status = 'to_ship'` but `auto_cancel_at = NULL`
6. The auto-cancel cron (`escrowService.ts:158`) queries `WHERE status = 'to_ship' AND auto_cancel_at <= now` — this order **never matches** because `auto_cancel_at` is NULL
7. **The ship timer never fires.** The order sits in `to_ship` indefinitely.

**The fix** (commit `50fff1e`, merged in `0a84e23`):

```typescript
// CURRENT CODE:
case 'PRE_TRANSIT':
  newStatus = 'to_ship';
  // auto_cancel_at deliberately preserved — a label is not proof of postage
  break;
```

Now `auto_cancel_at` is only cleared on `TRANSIT`, `DELIVERED`, or `RETURNED` — i.e., when the parcel is genuinely with the carrier.

**Scope:** This bug affected ALL orders with auto-purchased labels (web AND mobile), not just web orders. The owner's web order was simply the observed symptom. Any mobile order that was auto-labeled before `50fff1e` would have the same broken timer. However, mobile orders have an additional safety characteristic: the buyer app can prompt re-purchase if `confirmPayment` fails, and there's a 30s orphan refund check. This doesn't fix the timer, but may mean mobile orders had fewer visible symptoms.

**Status:** Fixed in current `main`. New web orders will correctly preserve `auto_cancel_at` on PRE_TRANSIT. **However, any existing orders created before the fix that had their `auto_cancel_at` cleared are still stranded** — see the backfill query in §Queries.

---

### Finding 10 — Web checkout has NO orphaned-payment safety net (P1)

**Severity: P1 — web buyers can pay and receive no order**

The webhook handler at `stripeController.ts:422-470` catches ALL errors during fulfillment and **still returns 200 to Stripe** to prevent retries that could cause duplicate orders. This is a deliberate design choice documented in the code comments.

If `fulfillOrder` or `fulfillCartOrder` throws for ANY reason (DB error, listing deleted between payment and webhook, address validation failure, transient network issue), the buyer has paid but **no order is created** and **Stripe will not retry** because it received a 200 response.

The only recovery is:
- For `AddressValidationError`: an ops email is sent to `info@mulligans.uk.com` (`stripeController.ts:453-461`). Manual reconciliation required.
- For all other errors: a generic console.error (`stripeController.ts:464`). **No alert, no email, no notification.** Manual investigation via Stripe dashboard only.

**Compare with mobile:** The mobile path has a 30-second safety net (`stripeController.ts:483-522`). When `payment_intent.succeeded` fires for a native payment, a setTimeout checks after 30s if an order exists. If not, it auto-refunds the buyer via `issueFailureRefund`. **This safety net only runs for metadata types `native_single_item` and `native_cart`** (line 477). Web sessions (metadata type `single_item` or `cart_checkout`) are NOT covered.

**The gap:** Web has a single-attempt, fail-silent-to-Stripe, no-auto-refund path. Mobile has client retry + 30s server-side orphan detection + auto-refund.

---

### Finding 11 — Fee calculations are inline, not via canonical module (P2)

**Severity: P2 — drift risk, no live data loss**

`src/lib/feeCalculations.ts` exists as the declared "single source of truth" (its own header: "If this module diverges from the controllers, the controllers are wrong"). But **no checkout controller calls `calculateBuyerFees()`**. All four paths compute fees inline with locally declared constants.

The core rates match across all paths:
- 7.5% buyer protection: consistent
- £0.99 per item: consistent
- 1.25% insurance: consistent (imported from `feeCalculations.ts`)

**One concrete divergence exists:** shipping quantity scaling.

| Path | Shipping formula for single-item | Matches spec? |
|------|----------------------------------|--------------|
| Web single-item (`stripeController.ts:271`) | `Math.ceil(qty / 5) * shippingCost` | YES |
| Web cart (`cartCheckoutController.ts:231`) | `Math.ceil(qty / 5) * shippingCost` | YES |
| Mobile single-item (`nativePaymentController.ts:238`) | `shippingCost` (flat) | NO |
| Mobile cart (`nativePaymentController.ts:395`) | `Math.max(shippingCost)` per seller (flat) | NO |
| `feeCalculations.ts:89-94` | `Math.max(shippingCost)` per seller (flat) | NO |

The spec (`business-logic-v2.md` §4.2, line 667) says: `Additional items: ceil(quantity / 5) × shipping_cost`. The web paths implement this; the mobile paths and the canonical module do not.

**Impact for quantity = 1 (the common case): zero.** The formulas produce identical results. For quantity > 5: web charges more shipping than mobile (web is correct per spec; mobile undercharges).

**Fee reconciliation against a known web order:**

The brief cites a £62.20 web order. Reverse-engineering:
- Item: £42.50
- Platform fee: (£42.50 × 0.075) + £0.99 = £3.19 + £0.99 = £4.18 ✓
- Insurance: £42.50 × 0.0125 = £0.53
- Base shipping: £15.52 − £0.53 = £14.99
- Grand total: £42.50 + £4.18 + £15.52 = £62.20 ✓

The fees are correct.

**Metadata naming inconsistency (cosmetic/analytics):** Web and mobile use different metadata keys for the same values (`item_price` vs `item_total`, `total_price` vs `grand_total`, `shipping_total` vs `shipping_cost`). Each fulfillment path reads its own keys correctly, so no runtime bug, but it complicates cross-path analytics. Additionally, `buyer_protection_fee` in metadata stores the combined platform fee (7.5% + £0.99), while `service_fee` is hardcoded to `'0.00'`, misrepresenting the breakdown in order emails.

---

### Finding 12 — "Guest checkout" is a Stripe artefact, not a backend concept (P3)

**Severity: P3 — cosmetic/operational**

The `gcus_` prefix does not appear anywhere in the backend codebase. There is no guest user model, no guest registration flow, and no `gcus_`-prefixed user IDs in the code or schema.

**What `gcus_` actually is:** When `stripe.checkout.sessions.create` is called without a `customer` parameter (which is the case — `stripeController.ts:347` and `cartCheckoutController.ts:433` do not pass `customer`), Stripe auto-creates a "guest customer" object with a `gcus_` prefix. This is internal to Stripe.

**All web buyers ARE fully authenticated Mulligans users.** The checkout routes require `authenticateToken`. The `buyer_id` in session metadata comes from `req.user.id` (a standard `user_XXXXX` ID from the JWT). Every buyer has:
- A Cognito account (required for JWT issuance)
- An email (required, unique field in schema)
- Full access to order history, confirm-receipt, dispute, and return flows

**Impact:** No orphaning risk from the user-identity side. Refunds work via `stripe_payment_intent_id` regardless of Stripe customer type. Notifications work because the buyer is a registered user with an email. The only issue is Stripe dashboard usability: the same Mulligans user appears as a different `gcus_` customer on each web purchase, making cross-referencing harder. Passing a Stripe Customer ID would fix this but is a feature, not a safety fix.

---

### Finding 13 — Web checkout reachability and auth model

**Severity: Informational (known — noted per brief §5)**

Web checkout is reachable by **any authenticated user** who knows the API endpoint and has a valid JWT. There is no additional gate (feature flag, IP allowlist, user-agent check, or platform header requirement).

The routes are:
- `POST /api/stripe/create-checkout-session` — `authenticateToken` (`stripeRoutes.ts:12-16`)
- `POST /api/stripe/create-cart-checkout` — `authenticateToken` (`stripeRoutes.ts:19-23`)

After payment, the buyer is redirected to `https://api.mulligans.uk.com/payment-success` (a static HTML page on the API server, `index.ts:162-164`), not to a web app page.

The checkout session's `success_url` and `cancel_url` point to the API domain (`stripeController.ts:375-376`), not the consumer web app:
```
success_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-success?session_id={CHECKOUT_SESSION_ID}`
cancel_url: `${process.env.BASE_URL || 'https://api.mulligans.uk.com'}/payment-cancelled`
```

**Who is calling these endpoints?** This audit cannot determine the client. The backend has no client-identification mechanism. This question is deferred to Brief 2 (frontend parity).

---

### Finding: `payoutPlatformFee` is web-only (P3)

**Severity: P3 — operational inconsistency, no buyer/seller impact**

After web fulfillment, `StripeController.payoutPlatformFee` (`stripeController.ts:1042-1083`) immediately withdraws the platform fee from the Stripe balance to Mulligans' bank account. This is only called from the webhook handler (`stripeController.ts:443`).

The mobile path does NOT do this. Mobile platform fees accumulate in the Stripe balance.

This has no safety impact on buyers or sellers — it only affects when Mulligans receives its own platform fee.

---

### Finding: Escrow auto-release duplicates `transferToSeller` logic (P2)

**Severity: P2 — code health, same guards present**

The escrow auto-release cron (`escrowService.ts:750-764`) calls `stripe.transfers.create` directly instead of using the `transferToSeller` helper (`src/lib/transferToSeller.ts`). However, it independently implements all the same guards:

| Guard | `transferToSeller` | Escrow auto-release |
|-------|-------------------|-------------------|
| Double-transfer check | `orders.findMany` for existing `stripe_transfer_id` (`transferToSeller.ts:31-38`) | `orders.findFirst` with `stripe_transfer_id: null` in query (`escrowService.ts:500`) |
| `sellerCanReceivePayout` | `transferToSeller.ts:42` | `escrowService.ts:626` |
| Idempotency key | Caller-provided (`transferToSeller.ts:64`) | `escrow_release_group_{trackingKey}` (`escrowService.ts:763`) |
| Transfer ID persistence | `orders.updateMany` (`transferToSeller.ts:75-78`) | `orders.update` per order (`escrowService.ts:782`) |

No safety gap exists, but the duplication creates drift risk.

---

## Known items (noted, not findings per brief §5)

| Item | Status | Detail |
|------|--------|--------|
| Web checkout auth model | Known | No web/mobile gate — any authenticated user can reach checkout |
| `orders.source` never populated | Known | Column exists in schema but is NULL on all rows |
| Klarna/BNPL via `automatic_payment_methods` | Known | Mobile PaymentIntent sets `automatic_payment_methods: { enabled: true }` (`nativePaymentController.ts:268`). Web uses `payment_method_types: ['card']` only (`stripeController.ts:348`). BNPL is mobile-only. |
| Webhook auth is query-string token, not HMAC | Known | Shippo webhook uses `req.query.token === process.env.SHIPPO_WEBHOOK_SECRET` (`shippingController.ts:641-644`). Stripe webhook correctly uses signature verification (`stripeController.ts:409-413`). |

---

## Queries for Harry

### Q1 — Count web-originated orders (best available signal)

Since `orders.source` is NULL on all rows, the best signal is matching `stripe_payment_intent_id` to Stripe sessions. Orders created via the Checkout Session flow will have a `stripe_payment_intent_id` that was auto-created by the session (not by a standalone `paymentIntents.create` call). However, this is indistinguishable from the backend alone.

**Alternative approach:** check Stripe dashboard directly for checkout sessions:

```
Stripe Dashboard → Payments → filter by "Checkout Sessions"
```

Or via Stripe CLI:
```bash
stripe checkout sessions list --limit 100
```

### Q2 — Find stranded orders (to_ship with NULL auto_cancel_at)

```sql
-- Orders stuck in to_ship with no ship timer (affected by the pre-fix bug)
SELECT
  id,
  buyer_id,
  seller_id,
  amount,
  status,
  auto_cancel_at,
  paid_at,
  created_at,
  stripe_payment_intent_id,
  tracking_number,
  label_auto_generated
FROM orders
WHERE status = 'to_ship'
  AND auto_cancel_at IS NULL
  AND refunded_at IS NULL
ORDER BY created_at ASC;
```

### Q3 — Find paid sessions with no matching order

```sql
-- Orders where payment exists but something looks wrong
-- (Run alongside Stripe session list for cross-reference)
SELECT
  id,
  buyer_id,
  status,
  auto_cancel_at,
  stripe_payment_intent_id,
  paid_at,
  shipped_at,
  delivered_at,
  completed_at,
  refunded_at,
  cancelled_at,
  cancel_reason
FROM orders
WHERE paid_at IS NOT NULL
  AND status NOT IN ('completed', 'cancelled', 'refunded', 'returned')
ORDER BY paid_at DESC
LIMIT 50;
```

### Q4 — Count orders by label_auto_generated flag

```sql
-- Helps gauge exposure to the PRE_TRANSIT bug
SELECT
  label_auto_generated,
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN auto_cancel_at IS NULL THEN 1 END) as null_timer_count
FROM orders
WHERE status IN ('to_ship', 'in_transit', 'delivered')
GROUP BY label_auto_generated, status
ORDER BY label_auto_generated, status;
```

---

## Verdict

**Is the web money path safe for the buyers already using it?**

**Conditionally yes, with one P1 gap remaining.**

The web checkout path shares nearly all safety infrastructure with mobile:
- `auto_cancel_at` is set correctly at order creation ✓
- The PRE_TRANSIT timer-clearing bug is now fixed ✓
- Payout uses `sellerCanReceivePayout` + `transferToSeller` (or equivalent guards) ✓
- Idempotency keys on all transfers ✓
- Fees are computed correctly (verified against the £62.20 order) ✓
- Buyers are fully authenticated, not guests ✓
- All post-purchase flows (confirm receipt, cancel, dispute, return) work for web buyers ✓

**The one remaining P1 gap is Finding 10:** web checkout has no safety net for failed order fulfillment. If the webhook handler fails to create an order after a buyer pays, the buyer is charged with no order, no auto-refund, and (for non-address errors) no alert. Mobile has a 30-second orphan detection + auto-refund. Web has nothing.

**For the three known live web orders (£36.00, £42.50, £62.20):** these orders exist and were fulfilled correctly (the webhook succeeded). The ship timer bug affected the owner's order but is now fixed. Run query Q2 to confirm whether any of these orders are stranded.

---

## Options

These are the three paths forward. Each is presented with evidence, not as a recommendation. Harry decides.

### Option A — Gate web checkout off

**What:** Add a feature flag or remove the web checkout frontend code so no new web sessions can be created. Existing orders continue through normal lifecycle.

**Evidence for:**
- Web was never intended to be live
- Finding 10 (no orphan safety net) is a real gap
- The shipping quantity formula divergence (Finding 11) means web and mobile charge differently for multi-quantity orders
- No `orders.source` tracking makes it hard to monitor web orders separately

**Evidence against:**
- Real buyers have successfully used it (3 known orders)
- The core money path is structurally sound
- Gating requires a frontend change (this audit is backend-only)

### Option B — Fix then keep

**What:** Close the P1 gap (Finding 10), then keep web checkout live.

**Fixes needed:**
1. Add a orphaned-session safety net: check for unfulfilled `checkout.session.completed` events after a delay (similar to the mobile 30s check) and auto-refund
2. Optionally: pass a Stripe Customer ID when creating sessions (fixes `gcus_` tracking)
3. Optionally: populate `orders.source` to distinguish web vs mobile
4. Optionally: consolidate fee calculation through `calculateBuyerFees()` to prevent drift

**Evidence for:**
- The money path is fundamentally sound — only the failure-recovery path differs
- Web checkout works and real buyers use it
- The fixes are surgical, not architectural

**Evidence against:**
- Web was never intended to be live; there may be frontend gaps Brief 2 will surface
- Adding safety nets increases the surface area to maintain

### Option C — Embrace and fix

**What:** Treat web checkout as an intentional channel. Fix all findings, add monitoring, and prepare for consumer web launch.

**Additional work beyond Option B:**
- Consolidate all fee calculation through `feeCalculations.ts` (eliminate four inline copies)
- Normalise metadata keys across web and mobile
- Add `orders.source` population at creation time
- Add web-specific monitoring/alerting
- Fix `buyer_protection_fee` / `service_fee` metadata split for accurate email receipts
- Route `payoutPlatformFee` through both web and mobile (or remove it)

**Evidence for:**
- Mulligans-Web consumer app is in development (Brief 6 phase per CLAUDE.md)
- The architecture is already sound; the gaps are failure-recovery and code hygiene
- Real buyers have validated the flow

**Evidence against:**
- Significant dev effort across multiple files
- Should be coordinated with Brief 2 (frontend) findings
