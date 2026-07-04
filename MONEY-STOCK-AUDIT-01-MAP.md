# MONEY-STOCK-AUDIT-01: Comprehensive Money + Stock + Order-State Integrity Map

**Branch:** `audit/money-stock-01` based from `clovis/pro-seller-foundation` at `ccbdded` (includes QTY-FIX-01)  
**Date:** 2026-07-04  
**Author:** Clovis  
**Type:** Read-only audit — no code changes  

---

## 1. Headline: Admin Full-Refund Stock Leak + Siblings

### The Confirmed Bug

**`POST /admin/orders/:id/full-refund`** (`src/routes/adminRoutes.ts:1849-2020`)

This handler refunds the buyer's entire payment (item cost + shipping + protection fee + service fee) via Stripe, sets the order status to `refunded`, but **never calls `restoreListingStock`**. The listing's quantity is permanently decremented. Every admin full refund leaks one unit of stock.

Evidence:

- Stripe refund issued at line 1933 with idempotency key `admin_full_refund_${orderId}`
- Order status set to `refunded` at line 1958 via bare `prisma.orders.update` (outside any transaction)
- The order SELECT (lines 1873-1886) does NOT fetch `listing_id`, `quantity`, or `selected_size` — the fields needed by `restoreListingStock`
- No import or call to `restoreListingStock` in this handler
- Contrast with the admin return-refund handler (`POST /admin/returns/:id/refund`, lines 511-639) which correctly selects those fields and calls `restoreListingStock(tx, ...)` inside a `$transaction`

### The Sibling Table: How Big Is This Class?

Every path that refunds, cancels, or reverses money — does it also correctly restore stock?

| # | Path | File:Line | Refunds money? | Restores stock? | Status correct? | In $transaction? | Idempotent? | Verdict |
|---|------|-----------|---------------|----------------|----------------|-----------------|------------|---------|
| 1 | **Admin full refund** | adminRoutes.ts:1849 | YES (idem key) | **NO** | YES (`refunded`) | **NO** (bare update) | YES (claim-the-row + Stripe key) | **BUG — stock leak** |
| 2 | **Admin insurance claim approve** | adminRoutes.ts:868 | YES (**no idem key**) | NO (correct — item lost) | YES (`refunded`) | **NO** | **NO** | **Double-refund risk** |
| 3 | **Buyer/seller cancel** | orderController.ts:1070 | YES (**no idem key**) | YES (in tx) | YES (`cancelled`) | Partial (stock in tx, refund outside) | **NO** | **Double-refund risk** |
| 4 | **Admin complete order** | orderController.ts:1567 | Transfer (**no idem key**) | N/A | YES (`completed`) | **NO** | **NO** | **Double-transfer risk** |
| 5 | **Tracking RETURNED** | shippingController.ts:691 | **NO** | **NO** | YES (`returned`) | NO | N/A | **BUG — money + stock stuck** |
| 6 | **Tracking FAILURE** | shippingController.ts:695 | **NO** | **NO** | YES (`delivery_failed`) | NO | N/A | **BUG — money + stock stuck** |
| 7 | Admin return refund | adminRoutes.ts:511 | YES (idem key) | YES (in tx) | YES (`returned`) | YES | YES (claim-the-row + Stripe key) | CORRECT |
| 8 | Auto-cancel (escrow cron) | escrowService.ts:159 | YES (idem key) | YES (in tx, FOR UPDATE) | YES (`cancelled`) | YES | YES (triple guard) | CORRECT |
| 9 | Auto return refund (escrow cron) | escrowService.ts:911 | YES (idem key) | YES (in tx) | YES (`returned`) | YES | YES (claim-the-row + Stripe key) | CORRECT |
| 10 | Forced return — seller confirms | returnController.ts:1003 | YES (idem key) | YES (in tx) | YES (`returned`) | YES | YES (claim-the-row + Stripe key) | CORRECT |
| 11 | Forced return — auto-confirm (cron) | escrowService.ts:1657 | YES (idem key) | YES (in tx) | YES (`returned`) | YES | YES (claim-the-row + Stripe key) | CORRECT |
| 12 | Stripe dispute lost | stripeController.ts:620 | (Stripe did it) | YES (in tx) | YES (`refunded`) | YES | YES (updateMany guard) | CORRECT |
| 13 | Dispute — seller accept ≤60% | disputeController.ts:960 | YES (idem key) | NO (correct — buyer keeps item) | YES | **NO** | YES (idem key + FOR UPDATE on dispute) | Acceptable |
| 14 | Dispute — seller accept 100% | disputeController.ts:960 | YES (idem key) | NO (triggers forced return) | YES | **NO** | YES | Acceptable (forced return lifecycle handles stock) |
| 15 | Dispute — buyer accept counter | disputeController.ts:1130 | YES (idem key) | NO (correct — ≤60% only) | YES | **NO** | YES | Acceptable |
| 16 | Dispute — admin resolve | disputeController.ts:1520 | YES (idem key) | NO (full → forced return) | YES | **NO** | YES (idem key + FOR UPDATE) | Acceptable |
| 17 | Buyer confirm receipt | orderController.ts:720 | Transfer (idem key) | N/A | YES (`completed`) | NO | YES (idem key + `stripe_transfer_id` guard) | CORRECT |
| 18 | Escrow auto-release (cron) | escrowService.ts:462 | Transfer (idem key) | N/A | YES (`completed`) | NO | YES (re-verify + idem key) | CORRECT |
| 19 | Native payment failure | nativePaymentController.ts:960 | YES (catch block) | N/A (order never created) | N/A | N/A | N/A | CORRECT (fixed in QTY-FIX-01) |

**Size of the class:** 6 paths have bugs (rows 1-6). 4 are money/stock bugs; 2 are idempotency gaps. The gold-standard pattern (admin return refund, escrow crons, forced returns) is well established — the bugs exist where that pattern wasn't applied.

---

## 2. Findings — Ranked by Severity

### CRITICAL-01: Admin Full Refund Leaks Stock

**File:** `src/routes/adminRoutes.ts:1849-2020`  
**What's wrong:** Stripe refund issued + status set to `refunded`, but `restoreListingStock` is never called. The handler doesn't even SELECT `listing_id`, `quantity`, or `selected_size`.  
**Failure scenario:** Admin refunds an order → buyer gets money back → listing quantity stays decremented → that unit of stock is permanently lost. If the seller relists manually, they have to adjust quantity by hand. Every admin full refund executed so far has leaked stock.  
**Exploitable today:** YES. Every invocation leaks stock.  
**Additional sub-bug:** The order update at line 1955 is a bare `prisma.orders.update`, NOT inside a `$transaction`. If the Stripe refund at line 1933 succeeds but the order update fails, money is refunded but order stays in its previous status (the claim-the-row at line 1861 would prevent a retry from re-refunding, but the order record would be inconsistent).

### CRITICAL-02: Tracking Webhook RETURNED — Terminal State With No Side Effects

**File:** `src/controllers/shippingController.ts:691-692`  
**What's wrong:** When a carrier returns a parcel to the sender (tracking status `RETURNED`), the order is set to `returned` via `updateMany` at line 702. No Stripe refund is issued. No stock is restored. No admin notification is sent. The buyer's money is stuck in escrow forever.  
**Failure scenario:** Carrier fails delivery, returns parcel to seller → order reaches terminal `returned` status → buyer never refunded → seller has the item but it's not relisted → money stuck → no handler or cron ever resolves this state.  
**Exploitable today:** YES, whenever a carrier returns a parcel.  
**Note:** The `delivered` check in `autoReleaseEscrow` means escrow won't release either — the order is effectively abandoned in every dimension (money, stock, status).

### CRITICAL-03: Tracking Webhook FAILURE — Terminal State With No Resolution

**File:** `src/controllers/shippingController.ts:694-695`  
**What's wrong:** Same as CRITICAL-02 but for tracking status `FAILURE` → order status `delivery_failed`. No refund, no stock restore, no resolution cron, no admin notification. Terminal dead-end.  
**Failure scenario:** Carrier marks delivery as failed → order stuck in `delivery_failed` forever → buyer never refunded → stock not restored.  
**Exploitable today:** YES, whenever a carrier reports failure.  
**Note:** `delivery_failed` is not even in the `OrderStatus` type definition at `src/lib/escrowDecisions.ts:43-45`. It's an undocumented status.

### HIGH-01: Insurance Claim Approve — No Stripe Idempotency Key

**File:** `src/routes/adminRoutes.ts:868-924`  
**What's wrong:** `stripe.refunds.create` at line 901 has no `idempotencyKey`. The only guard is a soft status check at line 889 (`insurance_claim_status IN ['reported_lost', 'claim_filed']`), which is NOT atomic — a concurrent request could pass the same check. The Stripe refund and order update are also not in a `$transaction`.  
**Failure scenario:** Admin double-clicks "Approve Claim" → two concurrent requests both pass the status check → two Stripe refunds issued → buyer refunded twice.  
**Exploitable today:** YES (requires concurrent admin action, low probability but non-zero).  
**Stock note:** No stock restore is correct here — the item is genuinely lost.

### HIGH-02: Buyer/Seller Cancel — No Stripe Idempotency Key + Refund Outside Transaction

**File:** `src/controllers/orderController.ts:1070-1309`  
**What's wrong:** Two issues:  
1. `stripe.refunds.create` at line 1206 has no `idempotencyKey`. The order status filter `{ in: ['pending', 'to_ship'] }` at line 1094 is a soft guard (not atomic).  
2. The Stripe refund happens BEFORE the `$transaction` at line 1228. If the refund succeeds but the transaction rolls back, money is refunded but order stays in `to_ship` and stock is not restored. Conversely, if the Stripe refund fails, the transaction still runs — stock is restored and order is cancelled, but buyer is NOT refunded (flagged as `[REFUND FAILED - MANUAL REFUND REQUIRED]` in `cancel_reason`).  
**Failure scenario (double-refund):** User double-taps cancel → two requests pass the `findFirst` check (both see `to_ship`) → two Stripe refunds issued.  
**Failure scenario (orphan):** Stripe refund fails → order cancelled + stock restored → item available for someone else to buy → original buyer never refunded.  
**Exploitable today:** Double-refund requires concurrent requests (low probability). Orphan scenario requires Stripe failure (also low but has happened — the `[REFUND FAILED]` flag is in the code for a reason).  
**Mitigating factor:** The buyer's 5-minute cancellation window + status filter reduce the race window significantly.

### HIGH-03: completeOrder — No Transfer Idempotency Key + No stripe_transfer_id Persistence

**File:** `src/controllers/orderController.ts:1567-1643`  
**What's wrong:** `stripe.transfers.create` at line 1616 has no `idempotencyKey` and no `stripe_transfer_id` guard. The `stripe_transfer_id` is NOT saved to the order record (compare with `confirmReceipt` at line 811 which does save it). The order update at line 1635 only sets `status: 'completed'`, `completed_at`, `seller_payout`.  
**Failure scenario:** If the transfer succeeds but the order update at line 1635 fails, the order stays `delivered`. The escrow cron (`autoReleaseEscrow`) sees a `delivered` order with no `stripe_transfer_id` and issues a SECOND transfer.  
**Exploitable today:** Requires a DB failure after a successful Stripe call, or a retry of the endpoint. Low probability but financial impact is high (seller paid twice, platform absorbs loss).  
**Contrast:** `confirmReceipt` (line 786) correctly uses `idempotencyKey: \`confirm_receipt_transfer_${orderId}\`` and saves `stripe_transfer_id` at line 811. `autoReleaseEscrow` also uses an idempotency key. This handler missed the pattern.

### HIGH-04: Native Cart Checkout — No Size-Variant Branch

**File:** `src/controllers/nativePaymentController.ts:1330-1340`  
**What's wrong:** The native (Apple Pay) cart fulfillment path uses `tx.listings.updateMany` with atomic `{ decrement: quantity }` for ALL items. Unlike the single-item native path (line 975-983), the Stripe checkout session path (line 919-927), and the web cart path (line 1139-1147), this path has NO size-variant branch that updates `specifications.sizeQuantities`.  
**Failure scenario:** Buyer purchases a size-variant item via Apple Pay cart checkout → top-level `quantity` is decremented → but `sizeQuantities` JSON is NOT updated → `sizeQuantities` shows more stock than actually available → next buyer can purchase a size that's actually sold out. The mismatch compounds with every native cart purchase of a size-variant listing.  
**Exploitable today:** YES, on every native cart purchase of a size-variant listing.  
**Additional sub-issue:** This path also lacks a `FOR UPDATE` row lock (line 1252 uses plain `findUnique`). The `WHERE quantity >= N` guard on `updateMany` prevents actual oversell of total stock, but the `sizeQuantities` drift is unprotected.

### MEDIUM-01: Dispute Resolution Paths — Non-Transactional Multi-Step Writes

**Files:**  
- `src/controllers/disputeController.ts:964-983` (seller accept)  
- `src/controllers/disputeController.ts:1244-1302` (buyer accept counter-offer)  
- `src/controllers/disputeController.ts:1669-1733` (admin resolve)  

**What's wrong:** All three dispute resolution paths perform a sequence of independent writes: Stripe refund → persist `stripe_refund_id` on order → transfer seller payout → update dispute status → update order status. None of these are wrapped in a `$transaction`. A failure at any step leaves the system in an inconsistent state (e.g., money refunded but order still `disputed`).  
**Failure scenario:** Stripe refund succeeds → order update fails → order stuck in `disputed` with money refunded. The Stripe idempotency key prevents double-refund on retry, but the order record is inconsistent.  
**Exploitable today:** Requires a DB failure mid-sequence. Low probability per invocation, but there are three paths with the same pattern.  
**Mitigating factor:** Stripe idempotency keys on all three paths prevent double-refund. The `FOR UPDATE` on the dispute row prevents concurrent execution.

### MEDIUM-02: ACTIVE_ORDER_STATUSES Missing `disputed`

**File:** `src/controllers/listingController.ts:1140, 1314` and `src/services/importService.ts:10`  
**What's wrong:** The constant `ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered']` is used to block listing deletion and off-sale when active orders exist. `'disputed'` is not included.  
**Failure scenario:** Seller deletes a listing while a dispute is active on one of its orders → dispute resolution may fail or behave unexpectedly if it references the listing (e.g., for stock restore).  
**Exploitable today:** Requires a seller to delete a listing during an active dispute (uncommon but possible).  
**Also defined 3 times inline** — should be a shared constant.

### MEDIUM-03: Cancel Proceeds When Refund Fails

**File:** `src/controllers/orderController.ts:1218-1252`  
**What's wrong:** When `stripe.refunds.create` fails (line 1218), the handler continues to the `$transaction` which cancels the order and restores stock. The buyer is not refunded but the item becomes available for someone else to purchase. The only signal is a `[REFUND FAILED - MANUAL REFUND REQUIRED]` string in `cancel_reason`.  
**Failure scenario:** Stripe outage → buyer taps cancel → order cancelled, stock restored → item bought by someone else → buyer #1 never refunded → requires manual admin intervention to discover and fix.  
**Exploitable today:** Requires Stripe failure (rare but possible).  
**Note:** This is a design choice (prefer consistency over blocking), but the manual follow-up mechanism is just a string in `cancel_reason` — there's no alert, queue, or cron that surfaces these.

### LOW-01: `delivery_failed` Has No Resolution Flow

**File:** `src/controllers/shippingController.ts:695`  
**What's wrong:** The `delivery_failed` status is set but never resolved. No cron picks it up. No admin UI surfaces it. It's not in the `OrderStatus` type. Orders that reach this state are invisible dead-ends.  
**Note:** Partially overlaps with CRITICAL-03 (the immediate impact is the same). Listed separately because even if CRITICAL-03 is fixed with a refund, there should be a resolution flow for this status.

### LOW-02: `pending` and `paid` Are Dead Statuses

**File:** `src/lib/escrowDecisions.ts:43` (type definition), `src/controllers/orderController.ts:1094` (query filter)  
**What's wrong:** All orders are created as `to_ship`. No code path sets `pending` or `paid` on an order. Yet both appear in query filters and the `ACTIVE_ORDER_STATUSES` constant.  
**Impact:** No functional impact. Code hygiene only.

---

## 3. Master Money-Out-Path Table (Integrity Matrix)

| Path | Stripe action | Idem key? | Stock restore? | Status set | In $tx? | Row lock? | Payout handled? |
|------|--------------|-----------|---------------|------------|---------|-----------|-----------------|
| Admin full refund | refund | YES | **NO** | `refunded` | **NO** | YES (claim) | N/A (pre-payout) |
| Admin return refund | refund | YES | YES | `returned` | YES | YES (claim) | N/A (pre-payout) |
| Admin insurance approve | refund | **NO** | NO (correct) | `refunded` | **NO** | **NO** | N/A (pre-payout) |
| Buyer/seller cancel | refund | **NO** | YES | `cancelled` | Partial | **NO** | N/A (pre-payout) |
| Auto-cancel (cron) | refund | YES | YES | `cancelled` | YES | YES (FOR UPDATE) | N/A (pre-payout) |
| Forced return — seller confirm | refund | YES | YES | `returned` | YES | YES (claim) | N/A (pre-payout) |
| Forced return — auto-confirm | refund | YES | YES | `returned` | YES | YES (claim) | N/A (pre-payout) |
| Auto return refund (cron) | refund | YES | YES | `returned` | YES | YES (claim) | N/A (pre-payout) |
| Stripe dispute lost | (Stripe) | N/A | YES | `refunded` | YES | updateMany guard | N/A |
| Dispute seller accept ≤60% | refund | YES | NO (correct) | `completed` | **NO** | YES (dispute) | YES (transfer) |
| Dispute seller accept 100% | refund | YES | NO (forced return) | `refunded` | **NO** | YES (dispute) | NO (nothing left) |
| Dispute buyer accept counter | refund | YES | NO (correct) | `completed` | **NO** | YES (dispute) | YES (transfer) |
| Dispute admin resolve | refund | YES | NO (forced return or correct) | varies | **NO** | YES (dispute) | YES (transfer) |
| Tracking RETURNED | **NONE** | N/A | **NO** | `returned` | **NO** | N/A | **NO** |
| Tracking FAILURE | **NONE** | N/A | **NO** | `delivery_failed` | **NO** | N/A | **NO** |
| Buyer confirm receipt | transfer | YES | N/A | `completed` | NO | `stripe_transfer_id` guard | YES |
| Admin complete order | transfer | **NO** | N/A | `completed` | **NO** | **NO** | YES (but double-risk) |
| Escrow auto-release (cron) | transfer | YES | N/A | `completed` | NO | Re-verify | YES |
| Native payment failure | refund | N/A | N/A (no order) | N/A | N/A | N/A | N/A |

---

## 4. Stock Mutation Map

### All Stock Decrements

| # | File:Line | Trigger | Size-variant branch? | Guard |
|---|-----------|---------|---------------------|-------|
| 1 | stripeController.ts:900 | Stripe checkout webhook (single) | YES (line 919) | `WHERE quantity >= N` + FOR UPDATE |
| 2 | cartCheckoutController.ts:1120 | Cart Stripe checkout webhook | YES (line 1139) | `WHERE quantity >= N` + FOR UPDATE |
| 3 | nativePaymentController.ts:956 | Apple Pay single-item webhook | YES (line 975) | `WHERE quantity >= N` + FOR UPDATE |
| 4 | nativePaymentController.ts:1330 | **Apple Pay cart webhook** | **NO** | `WHERE quantity >= N` only |

Finding #4 is HIGH-04 — the native cart path decrements top-level `quantity` but never updates `sizeQuantities`.

### All Stock Restorations (`restoreListingStock` calls)

| # | File:Line | Cause | Inside $tx? | Passes `tx`? |
|---|-----------|-------|-------------|-------------|
| 1 | orderController.ts:1246 | `order_cancelled` | YES | YES |
| 2 | stripeController.ts:638 | `dispute_refund` | YES | YES |
| 3 | returnController.ts:1107 | `return_refund` | YES | YES |
| 4 | adminRoutes.ts:619 | `return_refund` | YES | YES |
| 5 | escrowService.ts:278 | `order_cancelled` | YES | YES |
| 6 | escrowService.ts:1072 | `return_refund` | YES | YES |
| 7 | escrowService.ts:1761 | `return_refund` | YES | YES |

All 7 calls are correctly inside `$transaction` and pass `tx`. The `restoreListingStock` function itself handles both plain and size-variant paths correctly (FOR UPDATE lock for size variants, atomic increment for plain).

### Unmatched Decrements (stock leak vectors)

| Decrement trigger | Matching restore on reversal? | Gap? |
|-------------------|------------------------------|------|
| Stripe checkout → cancel | YES (orderController.ts:1246 or escrowService.ts:278) | No |
| Stripe checkout → return | YES (adminRoutes.ts:619, escrowService.ts:1072, etc.) | No |
| Stripe checkout → dispute lost | YES (stripeController.ts:638) | No |
| Stripe checkout → admin full refund | **NO** | **CRITICAL-01** |
| Stripe checkout → tracking RETURNED | **NO** | **CRITICAL-02** |
| Stripe checkout → tracking FAILURE | **NO** | **CRITICAL-03** |
| Native cart checkout → any reversal (size-variant) | Partial — quantity restored but sizeQuantities already drifted | **HIGH-04** |

---

## 5. Order Status Lifecycle Map

### Canonical Statuses (11 total, 9 in type definition)

```
In OrderStatus type:   pending, to_ship, in_transit, delivered, completed, cancelled, disputed, refunded, returned
Not in type:           delivery_failed (shippingController.ts:695), paid (referenced in queries, never set)
Never set by any code: pending, paid, shipped (orders only — used on return_requests)
```

### Transition Diagram

```
                                ┌─────────────────────────────────────────┐
                                │           ORDER CREATION                │
                                │  (all 3 checkout controllers)           │
                                └──────────────┬──────────────────────────┘
                                               │
                                               ▼
                           ┌───────────── to_ship ──────────────┐
                           │                   │                │
                    buyer/seller cancel    tracking TRANSIT   tracking PRE_TRANSIT
                    or auto-cancel cron        │              (stays to_ship)
                           │                   ▼
                           ▼             in_transit ────────────────────────┐
                      cancelled               │               │           │
                                         tracking          tracking    tracking
                                         DELIVERED         RETURNED    FAILURE
                                              │               │           │
                                              ▼               ▼           ▼
                     ┌─────────────────  delivered     returned(!)  delivery_failed(!)
                     │        │              │
                  dispute  confirm       escrow cron
                  opened   receipt       auto-release
                     │        │              │
                     ▼        ▼              ▼
                 disputed  completed     completed
                     │
          ┌──────────┼──────────────┐
     dispute     dispute        dispute
      lost     resolved        resolved
     (Stripe)   (partial)      (full, ≤60%)
          │         │              │
          ▼         ▼              ▼
      refunded  completed      refunded + forced return
                                       │
                                       ▼
                                   returned

(!) = terminal state with NO side effects — CRITICAL bugs
```

### Terminal States

| Status | Money resolved? | Stock resolved? | Notes |
|--------|----------------|----------------|-------|
| `completed` | YES (seller paid) | N/A (stock sold) | Correct terminal state |
| `cancelled` | Usually (refund attempted) | YES (restored) | Correct, but refund can fail (MEDIUM-03) |
| `refunded` | YES (buyer refunded) | Sometimes — depends on path | CRITICAL-01 (admin full refund leaks stock) |
| `returned` | Usually | Usually | CRITICAL-02 (tracking RETURNED — no refund, no stock) |
| `delivery_failed` | **NO** | **NO** | CRITICAL-03 (no resolution flow at all) |

---

## 6. Idempotency Audit (Post-QTY-FIX-01)

### Stripe Refund Idempotency

| Path | Has `idempotencyKey`? | Has atomic guard? |
|------|----------------------|-------------------|
| Admin full refund | YES (`admin_full_refund_${orderId}`) | YES (claim-the-row) |
| Admin return refund | YES (`return_refund_${returnId}`) | YES (claim-the-row) |
| **Admin insurance approve** | **NO** | **NO** (soft status check only) |
| **Buyer/seller cancel** | **NO** | **NO** (soft status check only) |
| Auto-cancel (cron) | YES (`auto_cancel_refund_${order.id}`) | YES (FOR UPDATE) |
| Forced return — seller | YES (`forced_return_refund_${returnId}`) | YES (claim-the-row) |
| Forced return — auto | YES (`forced_return_refund_${returnId}`) | YES (claim-the-row) |
| Auto return refund | YES (`return_refund_${returnRequest.id}`) | YES (claim-the-row) |
| Dispute seller accept | YES (`dispute_refund_${disputeId}`) | YES (FOR UPDATE on dispute) |
| Dispute buyer accept | YES (`dispute_counter_refund_${disputeId}`) | YES (FOR UPDATE) |
| Dispute admin resolve | YES (`dispute_admin_refund_${disputeId}`) | YES (FOR UPDATE) |

### Stripe Transfer Idempotency

| Path | Has `idempotencyKey`? | Persists `stripe_transfer_id`? |
|------|----------------------|-------------------------------|
| Buyer confirm receipt | YES (`confirm_receipt_transfer_${orderId}`) | YES (line 811) |
| Escrow auto-release | YES (`escrow_release_group_${trackingKey}`) | YES (line 808) |
| Dispute seller payout | YES (`dispute_transfer_${disputeId}`) | YES (line 233) |
| **Admin complete order** | **NO** | **NO** |

### Summary

- **2 refund paths missing Stripe idempotency:** Insurance claim approve (HIGH-01), buyer/seller cancel (HIGH-02)
- **1 transfer path missing idempotency:** completeOrder (HIGH-03)
- All 3 checkout controllers are now guarded (QTY-FIX-01 H-1)
- Dispute.closed is guarded (QTY-FIX-01 C-2)

---

## 7. Payout / Fee Correctness on Reversal

### Transfer Reversal: Not Used

There are zero calls to `stripe.transfers.reverse` anywhere in the codebase. When an order is refunded after payout, the platform absorbs the loss. This is a deliberate design choice, not a bug — but it has financial risk if post-payout refunds occur at scale.

### Payout Withholding Mechanism

The escrow system correctly prevents payouts on reversed orders:

- `autoReleaseEscrow` (escrowService.ts:462) filters for `status: 'delivered'` + `stripe_transfer_id IS NULL` + `escrow_release_at <= now`
- If an order is cancelled/refunded/returned before the escrow timer fires, the status is no longer `delivered`, so the cron skips it
- Disputes block escrow via `hasBlockingDispute` check (escrowService.ts:572)
- Returns block escrow via `hasBlockingReturn` check (escrowService.ts:584)

### Fee Handling

- `computeSellerTransferAmount` correctly deducts platform fees for pro sellers (SB-08)
- For partial dispute refunds, `transferSellerPayout` scales the seller's payout: `sellerReceives = netPayout * (1 - refundPercent)` (disputeController.ts:159)
- No issues found in fee calculation logic

### Gap: No Post-Payout Refund Protection

If `completeOrder` (HIGH-03) triggers a double-transfer due to missing idempotency, or if a manual refund is needed after escrow release, there is no mechanism to recover the seller's payout. The only option is manual intervention via Stripe dashboard.

---

## 8. Multi-Quantity Readiness (Money/Stock Angle)

### Stock Paths

- All 7 `restoreListingStock` calls pass `order.quantity || 1` — the `|| 1` fallback is now dead code since `quantity` is non-nullable, but harmless
- `restoreListingStock` itself correctly increments by the passed `quantity` value (atomic `{ increment: quantity }`)
- Size-variant restore correctly increments the specific `sizeQuantities[selectedSize]` bucket by `quantity` and recalculates the total

### Money Paths — Quantity-Aware?

| Path | Uses quantity for money calc? | Notes |
|------|------------------------------|-------|
| Admin full refund | Uses `buyer_total` (full charge) | Correct — refunds everything |
| Admin return refund | Uses `refund_amount` from return | Correct — pre-calculated |
| Buyer/seller cancel | Refunds full PI | Correct — refunds everything |
| Insurance claim | Uses `order.amount` or custom | Correct |
| Dispute refunds | Uses `resolution_amount` (percent of item cost) | Correct |
| Seller payout | Uses `order.seller_payout` | Correct |

### Gap: Analytics Counters

`total_sales` and `total_purchases` are incremented by 1 (e.g., orderController.ts:1647, 1656) regardless of `order.quantity`. This means 1 order of 3 items counts as 1 sale, not 3. This is a known issue (H-2 from original audit) — cosmetic, not money-impacting.

---

## 9. Recommended Fix Batches

### Slice 1: Refund-Path Stock Restores (CRITICAL)

**Scope:** Fix CRITICAL-01 + CRITICAL-02 + CRITICAL-03  
**Size:** ~50 lines changed across 2 files  
**Changes:**
- `adminRoutes.ts`: Add `listing_id`, `quantity`, `selected_size` to the admin full-refund order SELECT. Add `restoreListingStock(tx, ...)` call. Wrap the order update + stock restore in a `$transaction`.
- `shippingController.ts`: Add resolution logic for RETURNED and FAILURE tracking statuses. Options (needs Harry's input — see Section 10):
  - Option A: Trigger auto-refund + stock restore (treat as cancellation)
  - Option B: Set a flag for admin review (create admin notification, add to a review queue)
  - Option C: Create a cron that surfaces these for manual resolution

### Slice 2: Idempotency Guards (HIGH)

**Scope:** Fix HIGH-01, HIGH-02, HIGH-03  
**Size:** ~30 lines changed across 3 files  
**Changes:**
- `adminRoutes.ts` (insurance claim): Add `idempotencyKey: \`insurance_claim_refund_${orderId}\`` to Stripe call. Add claim-the-row or `$transaction` with status re-check.
- `orderController.ts` (cancelOrder): Add `idempotencyKey: \`cancel_refund_${orderId}\`` to Stripe call. Move Stripe refund inside the `$transaction` (or add claim-the-row).
- `orderController.ts` (completeOrder): Add `idempotencyKey: \`complete_transfer_${orderId}\`` to Stripe transfer. Save `stripe_transfer_id` on order. Add `stripe_transfer_id IS NULL` guard.

### Slice 3: Native Cart Size-Variant Branch (HIGH)

**Scope:** Fix HIGH-04  
**Size:** ~30 lines added to 1 file  
**Changes:**
- `nativePaymentController.ts`: Add size-variant branch to cart fulfillment path (lines ~1325-1345), following the pattern from the single-item path (lines 975-983). Add `FOR UPDATE` lock for size-variant listings.

### Slice 4: Transactional Consistency (MEDIUM)

**Scope:** Fix MEDIUM-01 (dispute paths), improve CRITICAL-01 order update  
**Size:** ~60 lines changed across 2 files  
**Changes:**
- `disputeController.ts`: Wrap refund + order update sequences in `$transaction` callbacks for all 3 resolution paths. Keep Stripe calls outside tx (unavoidable), but group all DB writes inside tx.
- Consolidate `ACTIVE_ORDER_STATUSES` into a shared constant and add `'disputed'` (MEDIUM-02).

### Slice 5: Cancel Refund Failure Alerting (MEDIUM)

**Scope:** Fix MEDIUM-03  
**Size:** ~15 lines added to 1 file  
**Changes:**
- `orderController.ts`: When Stripe refund fails in `cancelOrder`, create an admin notification (not just a string in `cancel_reason`). Consider adding to a cron-surfaced queue.

---

## 10. Open Decisions for Harry

### Decision 1: Tracking RETURNED/FAILURE — What Should Happen?

When a carrier returns a parcel or reports delivery failure, what's the correct business logic?

**Option A:** Auto-refund buyer + restore stock (treat it like a cancellation). Simple but doesn't handle edge cases (e.g., parcel lost by carrier, insurance claim needed).

**Option B:** Create an admin notification and queue for manual review. Admin decides per-case whether to refund, reship, or file insurance. More work for admin but handles edge cases.

**Option C:** Auto-refund if no insurance claim exists; queue for review if an insurance claim is already filed.

**Current state:** Neither — the order just sits forever with no resolution.

### Decision 2: Admin Full Refund — Is Stock Restore Always Correct?

The admin full refund is used for various reasons (quality issue, wrong item, customer complaint). Should stock ALWAYS be restored, or are there cases where the item should NOT be relisted (e.g., damaged, counterfeit)?

**Option A:** Always restore stock (matches all other refund paths). Admin can manually delist after if needed.

**Option B:** Add a checkbox in the admin UI: "Restore stock?" (default: yes). Requires admin dashboard change.

**Recommendation:** Option A for now. Simpler, consistent, and admin can always delist manually. Option B is a future improvement.

### Decision 3: Post-Payout Refund Policy

There is no `stripe.transfers.reverse` anywhere. If a refund is needed after the seller has been paid, the platform absorbs the loss. Is this intentional?

**If intentional:** Document it and monitor for frequency. At scale, this could be significant.

**If not intentional:** Add transfer reversal logic to refund paths that can fire after payout (currently theoretical — all refund triggers block escrow release, so this shouldn't happen in practice).

### Decision 4: Cancel-Without-Refund — Should It Be Blocked?

Currently, `cancelOrder` proceeds even when the Stripe refund fails, restoring stock but not refunding the buyer. Should the cancellation be blocked when the refund fails?

**Option A:** Block cancellation on refund failure (buyer retries later). Risk: buyer stuck with a hung order.

**Option B:** Current behaviour (cancel + flag). Risk: buyer not refunded, requires manual follow-up.

**Option C:** Current behaviour + automated admin alert. Best of both worlds.

**Recommendation:** Option C — keep current flow but add an admin notification.

---

## 11. Already Fixed by QTY-FIX-01 (Do NOT Re-Flag)

| ID | Finding | Fix | Commit |
|----|---------|-----|--------|
| C-2 | No `charge.dispute.closed` handler — lost disputes left orders stuck, stock never restored | Added full handler with `$transaction` + `restoreListingStock` | `ccbdded` |
| H-1 | TOCTOU race in idempotency checks (3 checkout controllers) — check outside tx, create inside | Moved check inside `$transaction` in all 3 controllers | `ccbdded` |
| H-3 | Admin return refund used array-form `$transaction` — `restoreListingStock` outside tx | Converted to callback-form, moved `restoreListingStock` inside | `ccbdded` |
| S-5 | `escrow_release_at` left populated during disputes — premature payout risk | Added `escrow_release_at: null` in `charge.dispute.created` handler | `ccbdded` |
| S-6 | `restoreListingStock` clobbered `off_sale` status back to `active` | Now preserves both `deleted` and `off_sale` | `ccbdded` |
| M-4 | Native payment failure catch block never issued Stripe refund | Added `stripe.refunds.create` in catch block | `ccbdded` |

---

## 12. Summary Counts

| Severity | Count | Exploitable today? |
|----------|-------|--------------------|
| CRITICAL | 3 | All 3 (stock leak, money stuck) |
| HIGH | 4 | 3 of 4 (HIGH-04 requires native cart + size-variant) |
| MEDIUM | 3 | Low probability (requires concurrent requests or Stripe failure) |
| LOW | 2 | No functional impact |
| **Total open** | **12** | |
| Already fixed (QTY-FIX-01) | 6 | N/A |

The bug class IS bigger than one handler — but the existing gold-standard pattern (claim-the-row + Stripe idempotency key + `restoreListingStock` inside `$transaction`) is well established in 7 of the 19 money-touching paths. The 12 findings are gaps where that pattern wasn't applied, clustered in admin routes, the cancel handler, `completeOrder`, and the shipping webhook.
