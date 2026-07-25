# AUDIT — `auto_cancel_at` cleared on PRE_TRANSIT

**Auditor:** Clovis
**Date:** 2026-07-25
**Branch:** `task/audit-autocancel-pretransit`
**Base:** `origin/main` @ `5afc28e`

---

## §2 Branch verification (verbatim output)

```
$ git remote -v
clovis	git@github.com:Clovis-Mulligans/Mulligans-Backend-Clovis.git (fetch)
clovis	git@github.com:Clovis-Mulligans/Mulligans-Backend-Clovis.git (push)
origin	https://...@github.com/HS-Mulligans/Mulligans-Backend.git (fetch)
origin	https://...@github.com/HS-Mulligans/Mulligans-Backend.git (push)

$ git rev-parse HEAD
5afc28ea96634d5de1b4423584b0e1f1c39343e6

$ git branch --show-current
task/audit-autocancel-pretransit

$ git status --short
(clean)

$ git log --oneline origin/main..HEAD
(empty)
```

HEAD = `5afc28e` ✓ — clean working tree, no commits ahead of `origin/main`.

---

## Hypothesis: CONFIRMED

The hypothesis is correct in full. Here is the chain of evidence:

### A. The clearing site

**A1. The `updateMany` unconditionally clears `auto_cancel_at` for all tracking events, including `PRE_TRANSIT`.**

`src/controllers/shippingController.ts:668-712`:

```typescript
switch (status) {
  case 'PRE_TRANSIT':
    // Label created / tracking registered, but the carrier has NOT yet
    // physically scanned the parcel. The seller may not have dropped it
    // off yet, so the order must stay 'to_ship' (not 'in_transit').
    // Do NOT set shipped_at here — it drives the lost-in-transit timer
    // and the buyer-facing "shipped" state. Only a real TRANSIT scan
    // means the parcel is genuinely on its way.
    // (auto_cancel_at is still cleared below on any tracking event,
    //  which is correct: a label exists, so don't auto-cancel.)   ← LINE 676-677
    newStatus = 'to_ship';  // ← correctly stays to_ship
    break;
  case 'TRANSIT':
    newStatus = 'in_transit';
    if (!shippedAt) shippedAt = new Date();
    break;
  // ... DELIVERED, RETURNED, FAILURE cases ...
}

// Update ALL orders with this tracking number (multi-item shipments)
// Per Brief 2 fix: clear auto_cancel_at on ANY tracking event (parcel is with carrier) ← LINE 700
await prisma.orders.updateMany({
  where: { tracking_number: trackingNumber },
  data: {
    status: newStatus,
    delivered_at: deliveredAt,
    escrow_release_at: escrowReleaseAt,
    shipped_at: shippedAt,
    auto_cancel_at: null,        // ← LINE 709 — unconditionally null for ALL cases
    updated_at: new Date(),
  },
});
```

The switch correctly keeps `PRE_TRANSIT` as `to_ship` and does NOT set `shipped_at`. But the shared `updateMany` always sets `auto_cancel_at: null`, so the shipping deadline is wiped.

**A2. The in-code comments assert the clearing is "correct" — contradicting the `PRE_TRANSIT` semantics.**

- Line 676-677: `"(auto_cancel_at is still cleared below on any tracking event, which is correct: a label exists, so don't auto-cancel.)"` — This reasoning is wrong. A label existing does NOT mean the parcel is with the carrier. The seller could create a label and never drop the parcel off. The deadline exists to protect the buyer against exactly this scenario.

- Line 700: `"Per Brief 2 fix: clear auto_cancel_at on ANY tracking event (parcel is with carrier)"` — The parenthetical "parcel is with carrier" is false for `PRE_TRANSIT`. The code contradicts its own `PRE_TRANSIT` comment (line 670-674) which explicitly states "the carrier has NOT yet physically scanned the parcel" and "the seller may not have dropped it off yet."

### B. Is this the ONLY place the deadline is wrongly cleared?

**B3. Every write that sets `auto_cancel_at` to `null` in `src/`:**

| # | File:line | Trigger | Context | Clearing correct? |
|---|-----------|---------|---------|-------------------|
| 1 | `shippingController.ts:709` | Shippo `track_updated` webhook (any status) | Inside the shared `updateMany` after the switch block | **NO for PRE_TRANSIT** — label exists but parcel not with carrier. **YES for TRANSIT/DELIVERED** — parcel genuinely shipped. **Debatable for FAILURE/RETURNED** — see §E. |

That is the **only** production write that sets `auto_cancel_at` to `null`. There are no other sites.

The `escrowService.ts:163` reference is a **read** (the `findMany` WHERE clause `auto_cancel_at: { lte: now }`), not a write.

The `testRoutes.ts:116` sets `auto_cancel_at` to a past date (for the `ready_for_cancel` test scenario), not null — and testRoutes are not production paths.

**B4. Is there any OTHER path that clears or fails to set `auto_cancel_at`?**

**No.** Comprehensive search results:

- **Manual label generation** (`shippingController.ts:332-556`, `createShippingLabel`): Updates the order with `tracking_number`, `label_url`, `label_cost`, `carrier`, `status: 'to_ship'` — does NOT touch `auto_cancel_at`. The deadline survives manual label creation. ✓
- **Auto-ship flow** (`autoShippingService.ts`, `autoPurchaseLabel`): Updates the order with label info and sets `label_auto_generated = true` — does NOT touch `auto_cancel_at`. The deadline survives auto-ship label purchase. ✓
- **`markAsShipped` route**: REMOVED — see `shippingRoutes.ts:74` comment: `"markAsShipped route REMOVED — see task/ship-status-integrity"`. The Shippo webhook is now the sole setter of `in_transit`/`shipped` status (see comment at `shippingController.ts:630`).
- **Admin actions**: No admin route or controller writes `auto_cancel_at`.
- **Cron jobs**: `autoCancelUnshippedOrders` reads `auto_cancel_at` in its WHERE clause but never writes it.
- **Return flow** (`returnController.ts`): Does not reference `auto_cancel_at` at all.

**Direct answer to question 4: YES, this is the only site. `shippingController.ts:709` is the sole production write that clears `auto_cancel_at`, and it does so unconditionally for all tracking statuses.**

**B5. Do all order-creation paths set `auto_cancel_at` at checkout?**

**Yes — all four do**, via `calculateShippingDeadline(new Date())`:

| # | Controller | Line | Mechanism |
|---|-----------|------|-----------|
| 1 | `nativePaymentController.ts` (single item) | 557, 702 | `calculateShippingDeadline(new Date())` → `autoCancelAt` → `orders.create({ auto_cancel_at: autoCancelAt })` |
| 2 | `nativePaymentController.ts` (cart) | 557, 1059 | Same `autoCancelAt` computed at line 557, passed to `fulfillCart()`, set on each order |
| 3 | `stripeController.ts` | 714, 775 | `calculateShippingDeadline(new Date())` → `autoCancelAt` → `orders.create({ auto_cancel_at: autoCancelAt })` |
| 4 | `cartCheckoutController.ts` | 662, 795 | `calculateShippingDeadline(new Date())` → `autoCancelAt` → `orders.create({ auto_cancel_at: autoCancelAt })` |

`calculateShippingDeadline()` (`src/utils/shippingDeadline.ts:10-27`) adds 5 weekdays (Mon-Fri) to the sale date, with deadline at 23:59:59.999 on the 5th weekday.

### C. The trigger job

**C6. `autoCancelUnshippedOrders()` selection predicate** (`escrowService.ts:160-166`):

```typescript
const overdueOrders = await prisma.orders.findMany({
  where: {
    status: 'to_ship',
    auto_cancel_at: {
      lte: now,
    },
    refunded_at: null,
  },
  // ...
});
```

The predicate depends on:
1. `status = 'to_ship'` ✓
2. `auto_cancel_at <= now` ✓
3. `refunded_at IS NULL` ✓

It does NOT gate on label presence (`label_url`), `shipped_at`, `tracking_number`, or any other field. So once `auto_cancel_at` is nulled, the order is invisible to this job forever — there is no secondary mechanism that would catch it.

The pure predicate in `escrowDecisions.ts:80-86` (`shouldAutoCancelUnshipped`) mirrors this:
```typescript
if (order.status !== 'to_ship') return false;
if (order.refunded_at !== null) return false;
if (order.stripe_refund_id !== null) return false;
if (order.auto_cancel_at === null) return false;   // ← null = never cancel
return order.auto_cancel_at.getTime() <= now.getTime();
```

**C7. What auto-cancel does when it fires** (`escrowService.ts:220-390`):

The auto-cancel flow is sound. In order:

1. **Re-verify status** (`escrowService.ts:205-218`): Re-reads the order. Skips if status has changed from `to_ship`, or if `refunded_at` or `stripe_refund_id` is already set. Prevents race conditions.

2. **Stripe refund** (`escrowService.ts:225-249`): Full refund of `payment_intent`. Uses idempotency key `auto_cancel_refund_${order.id}` to prevent double-refund on cron retry. Handles `charge_already_refunded` gracefully. If refund fails for another reason, skips this order (does not update status).

3. **Order status update** (`escrowService.ts:253-264`): Only after successful refund. Sets `status: 'cancelled'`, `cancelled_at`, `cancel_reason: 'auto_cancelled_not_shipped'`, `refunded_at`, `refund_amount: order.amount`, `stripe_refund_id`.

4. **Shippo label refund** (`escrowService.ts:267-289`): Fire-and-forget refund of the Shippo label (if `shippo_transaction_id` exists). Non-blocking — failure is logged but does not prevent cancellation.

5. **Relist item** (`escrowService.ts:292-301`): Sets listing status back to `active`.

6. **Seller strike** (`escrowService.ts:304-337`): Increments `shipping_strikes`. If `strikes >= 2`, creates automatic 1-star review. Uses `updateUserRating()` to recalculate average.

7. **Notifications** (`escrowService.ts:339-390`): In-app notification + push + email to both buyer and seller.

**Restoring `auto_cancel_at` on these stranded orders will not expose a second bug.** The auto-cancel flow is well-guarded with idempotency, re-verification, and proper error handling.

### D. Blast radius

**D8. Query for currently-unprotected orders:**

```sql
-- READ ONLY — do not modify
SELECT
  id,
  status,
  auto_cancel_at,
  created_at,
  updated_at,
  paid_at,
  shipped_at,
  tracking_number,
  label_url,
  amount,
  buyer_id,
  seller_id,
  listing_title
FROM orders
WHERE status = 'to_ship'
  AND auto_cancel_at IS NULL
  AND refunded_at IS NULL
  AND cancelled_at IS NULL
ORDER BY created_at ASC;
```

All orders matching this query have had their buyer protection silently disabled. Based on the brief's statement that there are 5 current `to_ship` orders with a label and NULL `auto_cancel_at`, all 5 are unprotected.

Additionally, this query finds orders that *were* unprotected but have since shipped:

```sql
-- Orders that shipped after auto_cancel_at was cleared
-- (no active harm, but confirms the bug has been firing)
SELECT
  id,
  status,
  auto_cancel_at,
  created_at,
  shipped_at,
  tracking_number
FROM orders
WHERE auto_cancel_at IS NULL
  AND tracking_number IS NOT NULL
  AND status IN ('in_transit', 'delivered', 'completed')
ORDER BY created_at ASC;
```

**D9. Has auto-cancel ever fired successfully?**

The test route `ready_for_cancel` (`testRoutes.ts:112-118`) exists and manually sets `auto_cancel_at` to the past, which suggests it was built for testing the job. However, whether the job has ever fired on a real order depends on whether any order's `auto_cancel_at` deadline has passed without a tracking event clearing it first.

Given that auto-ship runs at checkout and fires a `PRE_TRANSIT` webhook within seconds, **every auto-shipped order has its deadline cleared almost immediately**. For the job to have ever fired, there would need to be an order where:
- Auto-ship failed (seller uses manual wizard), AND
- The seller never created a manual label either, AND
- 5 weekdays passed

Harry should run this query to check:

```sql
-- Has auto-cancel ever fired?
SELECT id, status, cancel_reason, cancelled_at, auto_cancel_at
FROM orders
WHERE cancel_reason = 'auto_cancelled_not_shipped'
ORDER BY cancelled_at DESC;
```

If this returns zero rows, the auto-cancel protection has **effectively never worked** for auto-shipped orders — it has been silently disabled since the "Brief 2 fix" that added the unconditional `auto_cancel_at: null`.

### E. The FAILURE and RETURNED cases

**E10. Per-case analysis of whether clearing `auto_cancel_at` is correct:**

| Status | Current `newStatus` | Clears `auto_cancel_at`? | Correct? | Reasoning |
|--------|-------------------|------------------------|----------|-----------|
| `PRE_TRANSIT` | `to_ship` | Yes (bug) | **NO** | Label created but parcel not with carrier. Seller may never drop it off. Buyer protection must remain active. The spec (business-logic-v2.md lines 164-166) says `auto_cancel_at` is cleared only on transition to `in_transit`. |
| `TRANSIT` | `in_transit` | Yes | **YES** | Parcel is physically with the carrier. Seller has fulfilled their shipping obligation. Spec confirms: `auto_cancel_at = null` on `in_transit` transition. |
| `DELIVERED` | `delivered` | Yes | **YES** | Parcel delivered. Auto-cancel is moot — escrow release timer takes over. |
| `RETURNED` | `returned` | Yes | **YES, conditionally** | Return means the carrier sent the parcel back to the seller. The order has progressed beyond the shipping stage. Auto-cancel deadline is no longer relevant. However, a separate return-handling flow should manage what happens next. |
| `FAILURE` | `delivery_failed` | Yes | **NO — should reset, not clear** | Delivery attempt failed (e.g., wrong address, recipient unavailable, damage). The parcel may be returned to the seller or stuck in limbo. The buyer has paid but has not received the item. Clearing the deadline removes all automated protection. **Recommendation: on `FAILURE`, reset `auto_cancel_at` to a new 5-weekday window from now**, giving the seller time to resolve (re-ship, provide new address) while keeping buyer protection active. If the seller doesn't resolve, the order auto-cancels and the buyer gets a refund. This aligns with spec line 258: "If recoverable — Order → `to_ship` with new `auto_cancel_at`; seller reships." |

### F. Interactions

**F11. Interaction analysis for the proposed fix:**

| System | Depends on `auto_cancel_at`? | Impact of NOT clearing on `PRE_TRANSIT`? |
|--------|-------------------------------|------------------------------------------|
| `shipped_at` | No | No interaction. `shipped_at` is set only on `TRANSIT` (line 682). `PRE_TRANSIT` already does not set it. Fix is orthogonal. |
| Lost-in-transit timer (`checkLostInTransit`, `escrowService.ts:1401`) | No — depends on `status = 'in_transit'`, `shipped_at`, and `lost_notification_sent_at` | No interaction. The order stays `to_ship` on `PRE_TRANSIT`, so it never enters the lost-in-transit check. |
| Escrow release (`autoReleaseEscrow`, `escrowService.ts:448`) | No — depends on `status = 'delivered'`, `escrow_release_at`, `stripe_transfer_id` | No interaction. |
| Return flow (`returnController.ts`) | No — does not reference `auto_cancel_at` | No interaction. |

**The proposed fix does not regress any adjacent system.**

**F12. Is there a pre-deadline ship reminder for sales?**

**Confirmed: there is NO sale-ship reminder.** The only ship reminder is `sendReturnShipReminders()` (`escrowService.ts:1156`), which is for return labels only — it queries `return_requests` with `status: 'label_created'` and `return_ship_deadline`.

The `runEscrowJobs()` function (`escrowService.ts:1802-1820`) calls these jobs in order:
1. `autoCancelUnshippedOrders()`
2. `autoReleaseEscrow()`
3. `sendInspectionReminders()`
4. `autoProcessReturnRefunds()`
5. `sendReturnShipReminders()` ← return-only
6. `autoExpireReturns()`
7. `autoConfirmForcedReturns()`
8. `autoEscalateDisputes()`
9. `checkLostInTransit()`

No `sendShipReminder` or equivalent exists for sale orders. **Documented as a gap — not to be fixed here.**

---

## Proposed fix

### Fix 1: Conditional `auto_cancel_at` clearing (the core bug)

Only clear `auto_cancel_at` when the parcel is genuinely with the carrier or at a terminal state. On `PRE_TRANSIT`, leave it untouched. On `FAILURE`, reset it.

```typescript
// Build the data object conditionally — only include auto_cancel_at
// when we want to change it. Prisma ignores `undefined` fields in
// updateMany data (does not write them to the DB), so omitting
// auto_cancel_at entirely preserves its current value.
//
// On Prisma 6.x (this repo: @prisma/client ^6.17.1), `undefined`
// in a data object means "do not include this field in the SET clause."
// This is stable, documented behaviour. `null` means "set to NULL."

let autoCancelUpdate: Date | null | undefined;

switch (status) {
  case 'PRE_TRANSIT':
    // Label created but parcel NOT with carrier — preserve deadline
    autoCancelUpdate = undefined;  // don't touch
    break;
  case 'TRANSIT':
  case 'DELIVERED':
  case 'RETURNED':
    // Parcel is with carrier or at terminal state — clear deadline
    autoCancelUpdate = null;
    break;
  case 'FAILURE':
    // Delivery failed — reset deadline to give seller time to resolve
    autoCancelUpdate = calculateShippingDeadline(new Date());
    break;
  default:
    autoCancelUpdate = undefined;  // unknown status — don't touch
}

await prisma.orders.updateMany({
  where: { tracking_number: trackingNumber },
  data: {
    status: newStatus,
    delivered_at: deliveredAt,
    escrow_release_at: escrowReleaseAt,
    shipped_at: shippedAt,
    auto_cancel_at: autoCancelUpdate,
    updated_at: new Date(),
  },
});
```

**Note on Prisma `undefined` semantics:** In Prisma 6.x, passing `undefined` for a field in a `create` or `update`/`updateMany` data object means "do not include this column in the generated SQL." This is the correct way to conditionally omit a field. Do **not** use `null` (which means "SET column = NULL") and do **not** build a conditional data object with spread (`...conditionalObj`) — that risks accidental null writes if the conditional evaluates wrong.

**Import required:** `calculateShippingDeadline` from `../utils/shippingDeadline` (already imported in the file for some paths; verify).

Actually — checking the imports: `calculateShippingDeadline` is NOT currently imported in `shippingController.ts`. It would need to be added:

```typescript
import { calculateShippingDeadline } from '../utils/shippingDeadline';
```

**Fix 2: Update the misleading comments** (lines 676-677 and 700):

- Line 676-677: Remove or replace `"(auto_cancel_at is still cleared below on any tracking event, which is correct: a label exists, so don't auto-cancel.)"` with `"// auto_cancel_at is preserved — label creation alone doesn't prove the parcel was posted."`
- Line 700: Remove `"Per Brief 2 fix: clear auto_cancel_at on ANY tracking event (parcel is with carrier)"` — the comment was incorrect and the unconditional clearing was the bug.

### Tests that should ship with the fix

These are the load-bearing assertions:

```typescript
describe('Shippo webhook: auto_cancel_at handling', () => {
  test('PRE_TRANSIT preserves auto_cancel_at (does not clear deadline)', async () => {
    // Create order with auto_cancel_at set
    // Fire PRE_TRANSIT webhook
    // Assert order.auto_cancel_at is UNCHANGED (not null)
    // Assert order.status === 'to_ship'
    // Assert order.shipped_at is null
  });

  test('TRANSIT clears auto_cancel_at', async () => {
    // Create order with auto_cancel_at set
    // Fire TRANSIT webhook
    // Assert order.auto_cancel_at === null
    // Assert order.status === 'in_transit'
    // Assert order.shipped_at is set
  });

  test('DELIVERED clears auto_cancel_at', async () => {
    // Fire DELIVERED webhook
    // Assert order.auto_cancel_at === null
  });

  test('FAILURE resets auto_cancel_at to new 5-weekday deadline', async () => {
    // Create order with auto_cancel_at set to original deadline
    // Fire FAILURE webhook
    // Assert order.auto_cancel_at is NOT null
    // Assert order.auto_cancel_at is approximately now + 5 weekdays
    // Assert order.status === 'delivery_failed'
  });

  test('RETURNED clears auto_cancel_at', async () => {
    // Fire RETURNED webhook
    // Assert order.auto_cancel_at === null
  });
});
```

---

## Proposed back-fill for stranded orders

### Approach: dry-run-first, idempotent, per-order decision

**Step 1: Dry run** — identify which orders are affected and what their new deadlines would be:

```sql
-- DRY RUN — does not modify data
SELECT
  id,
  created_at,
  updated_at,
  paid_at,
  amount,
  listing_title,
  buyer_id,
  seller_id,
  tracking_number,
  label_url,
  -- What the new deadline would be (5 weekdays from created_at)
  -- PostgreSQL doesn't have weekday-aware date math natively,
  -- so compute this in application code using calculateShippingDeadline(created_at)
  created_at AS deadline_basis,
  CASE
    WHEN created_at + INTERVAL '7 days' < NOW() THEN 'ALREADY OVERDUE'
    ELSE 'WITHIN WINDOW'
  END AS rough_status
FROM orders
WHERE status = 'to_ship'
  AND auto_cancel_at IS NULL
  AND refunded_at IS NULL
  AND cancelled_at IS NULL
ORDER BY created_at ASC;
```

**Step 2: Application-level computation** — for each stranded order, compute `calculateShippingDeadline(order.created_at)` and compare to `now`:

- If `deadline > now`: order is still within the shipping window → safe to back-fill `auto_cancel_at = deadline`. The next cron run will not cancel it.
- If `deadline <= now`: order is **already overdue** → back-filling would cause the next cron run (daily at 2 AM UK time) to auto-cancel and refund. **Harry must decide per-order.**

**Step 3: Per-order decision for overdue orders** — Harry reviews each overdue order and decides:

- **Cancel and refund** — apply `calculateShippingDeadline(created_at)` which will be in the past, triggering auto-cancel on next cron run.
- **Extend deadline** — apply `calculateShippingDeadline(new Date())` giving the seller a fresh 5-weekday window.
- **Leave as-is** — if the seller is known to be about to ship, leave `auto_cancel_at` null temporarily and set it manually after confirming.

### Live-money warning

**This is real money.** `order_d72c800f-...` is a real £36 buyer order. If Harry back-fills `calculateShippingDeadline(created_at)` and the deadline is already past, the next 2 AM cron run will:
1. Issue a full Stripe refund to the buyer
2. Cancel the order
3. Relist the item
4. Add a shipping strike to the seller
5. If the seller has 2+ strikes, create a 1-star review
6. Send cancellation notifications and emails to both parties

**Never batch-apply past deadlines without per-order review.** The back-fill script must surface which orders are already overdue and present them for Harry's individual decision.

### Idempotency

The back-fill is idempotent: running `UPDATE orders SET auto_cancel_at = X WHERE id = Y AND auto_cancel_at IS NULL` is safe to re-run — if `auto_cancel_at` is already set, the WHERE clause won't match.

---

## Severity

**P0** — confirmed. Buyer protection (the auto-cancel-and-refund mechanism) is silently disabled on every auto-shipped order, which is the majority of orders. The auto-cancel job has likely never fired for an auto-shipped order because the `PRE_TRANSIT` webhook clears the deadline within seconds of order creation. This means buyers on orders where the seller never ships have no automated recourse.

---

## Webhook security note

The Shippo webhook uses a query-string token (`shippingController.ts:641-644`):

```typescript
const token = req.query.token;
if (token !== process.env.SHIPPO_WEBHOOK_SECRET) {
  console.error('❌ Invalid Shippo webhook token');
  return res.status(401).json({ error: 'Unauthorized' });
}
```

This is a shared-secret token passed as a URL query parameter. It is **not** an HMAC signature over the request body. See `questions.md` for the security implications.

---

## Summary

| Question | Answer |
|----------|--------|
| Is the hypothesis correct? | **Yes** — confirmed with file:line evidence |
| Is `PRE_TRANSIT` the only site that wrongly clears `auto_cancel_at`? | **Yes** — `shippingController.ts:709` is the sole production write that nulls `auto_cancel_at`, and it fires unconditionally for all tracking statuses |
| Is `auto_cancel_at` set on all order-creation paths? | **Yes** — all 4 checkout controllers set it via `calculateShippingDeadline(new Date())` |
| Has auto-cancel ever fired? | **Unknown — Harry should run the query in §D9** |
| Does the fix regress anything? | **No** — `auto_cancel_at` is independent of `shipped_at`, lost-in-transit, escrow release, and returns |
| Is there a sale-ship reminder? | **No** — confirmed gap; only return-ship reminders exist |
| `FAILURE` case recommendation | **Reset deadline** (new 5-weekday window), don't clear |
