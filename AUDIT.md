# Payout Guards & Stripe Connect Status — Code Audit

**Auditor:** Clovis (Claude Opus 4.6)
**Date:** 23 Jul 2026
**Repo:** Mulligans-Backend
**Base:** `upstream/main` (via `origin/main` — see remote note below)
**Pinned SHA:** `5afc28ea96634d5de1b4423584b0e1f1c39343e6`
**Scope:** Read-only investigation. No code changes.

---

## §2 Branch Verification

```
$ git remote -v
clovis   git@github.com:Clovis-Mulligans/Mulligans-Backend-Clovis.git (fetch)
clovis   git@github.com:Clovis-Mulligans/Mulligans-Backend-Clovis.git (push)
origin   https://...@github.com/HS-Mulligans/Mulligans-Backend.git (fetch)
origin   https://...@github.com/HS-Mulligans/Mulligans-Backend.git (push)

$ git checkout -b task/audit-payout-guards origin/main
Switched to a new branch 'task/audit-payout-guards'
branch 'task/audit-payout-guards' set up to track 'origin/main'.

$ git branch --show-current
task/audit-payout-guards

$ git rev-parse HEAD
5afc28ea96634d5de1b4423584b0e1f1c39343e6

$ git log -1 --oneline
5afc28e fix: constants dedupe + refund-helper adoption across all controllers

$ git status --short
(no output — clean tree)

$ git log --oneline origin/main..HEAD
(no output — zero commits ahead)

$ git branch --contains HEAD -a
  main
  pro-seller-foundation
* task/audit-payout-guards
  task/constants-cleanup
  remotes/clovis/pro-seller-foundation
  remotes/clovis/task/constants-cleanup
  remotes/origin/HEAD -> origin/main
  remotes/origin/main
  remotes/origin/pro-seller-foundation
  remotes/origin/task/constants-cleanup
```

**Remote note:** No `upstream` remote exists. `origin` points at `HS-Mulligans/Mulligans-Backend` (the upstream). `clovis` is the Clovis fork. All `upstream/main` references in the brief map to `origin/main` in this clone.

**Confirmation:** HEAD matches pinned SHA `5afc28e`. Branch is `task/audit-payout-guards` off `origin/main`. Not on `pro-seller-foundation`. No modified tracked files. No commits from `pro-seller-foundation` in history (zero commits ahead of `origin/main`).

---

## Findings by Severity

### P0 — Money can be lost, double-paid, or permanently orphaned

#### P0-1: `confirmReceipt` transfers to non-`active` Connect accounts

**File:** `src/controllers/orderController.ts:775`
**What is wrong:** The guard checks only `seller.stripe_connect_id && order.seller_payout`. It does not check `stripe_connect_status === 'active'`. The query at line 742-747 does not even SELECT `stripe_connect_status`. `sellerCanReceivePayout()` is not called.
**What should happen (per §7.2):** Only `active` accounts can receive transfers. `restricted` and `pending` accounts must be refused.
**Impact:** This is the exact path that caused the 22 Jul incident. The buyer's 5 confirm-receipt attempts all hit Stripe's `insufficient_capabilities_for_transfer` error, returning 500 to the buyer. The order stayed `delivered` but the buyer received no actionable error message.
**Proposed fix:** Add `stripe_connect_status` to the seller SELECT. Before the transfer, check `sellerCanReceivePayout()` (or equivalent). On failure, return a descriptive error and trigger the blocked-payout notification path from `escrowService.ts:631-737`.

#### P0-2: `completeOrder` (admin) has no idempotency key, no double-transfer guard, and does not persist `stripe_transfer_id`

**File:** `src/controllers/orderController.ts:1606`
**What is wrong:**
1. `stripe.transfers.create()` at line 1606-1614 has **no idempotency key**.
2. There is no `if (order.stripe_transfer_id)` short-circuit before the transfer.
3. The order update at lines 1625-1633 does NOT set `stripe_transfer_id`.
4. The guard at line 1602 does not check `stripe_connect_status`.

**What should happen (per §4.8):** All money-moving operations must use idempotency keys. Transfer IDs must be persisted. Double-transfer must be prevented.
**Impact:** An admin retry or race condition pays the seller twice with no Stripe deduplication. Even a single successful call orphans the transfer ID — the DB has no record of which Stripe transfer was created. The `confirmReceipt` path was hardened against all of these issues in commit `13d4a5b` (1 Jun 2026); `completeOrder` was not.
**Proposed fix:** Apply the same hardening as `confirmReceipt`: add idempotency key `complete_order_transfer_${orderId}`, add `stripe_transfer_id` short-circuit, add `stripe_transfer_id` to the order update, add `stripe_connect_status` check.

#### P0-3: Dispute resolution sets `completed` BEFORE transfer — permanently orphans order on transfer failure

**Files:**
- `src/controllers/disputeController.ts:977-984` (seller accepts)
- `src/controllers/disputeController.ts:1296-1302` (buyer accepts counter-offer)
- `src/controllers/disputeController.ts:1727-1734` (admin resolves)

**What is wrong:** All three paths set `status: 'completed'` (for partial refunds) as part of the refund write, then attempt `transferSellerPayout()` afterward. If the transfer fails (restricted account, Stripe error), the order is already `completed`. The escrow cron only selects `status: 'delivered'` orders (`escrowService.ts:457`), so the order is **permanently unreachable** — it can never be retried.

Additionally, none of these paths set `completed_at`, violating the spec (§2.3: `delivered → completed` writes `completed_at`).

**What should happen (per §2.1):** `completed` means "Funds transferred to seller; sale recorded." Status should not be set to `completed` until the transfer is confirmed.
**Impact:** Any dispute resolution for a seller with a non-active Connect account permanently orphans the seller's payout with no recovery path.
**Proposed fix:** Either (a) defer setting `completed` until after successful transfer, setting a new intermediate status like `payout_pending`, or (b) keep the current flow but add a separate retry mechanism for `completed` orders with `stripe_transfer_id = NULL`.

#### P0-4: Dispute resolution paths do not increment `total_sales` / `total_purchases`

**Files:**
- `src/controllers/disputeController.ts:977-1002`
- `src/controllers/disputeController.ts:1282-1302`
- `src/controllers/disputeController.ts:1712-1734`

**What is wrong:** When a dispute resolves with partial/no refund and the order transitions to `completed`, neither `total_sales` nor `total_purchases` is incremented. The `confirmReceipt` path (line 809-825) and `completeOrder` path (line 1635-1651) and escrow cron (line 795-810) all increment these counters.
**What should happen (per §2.3):** `delivered → completed` writes `users.total_sales++`.
**Impact:** Seller and buyer totals are permanently undercounted for all dispute-resolved orders.
**Proposed fix:** Add `total_sales` and `total_purchases` increments after dispute resolution sets order to `completed`.

#### P0-5: `disputeController.transferSellerPayout` warns on non-`active` Connect but proceeds with transfer

**File:** `src/controllers/disputeController.ts:211-213`
**What is wrong:** When `seller.stripe_connect_status !== 'active'`, the code logs `console.warn` but proceeds to `stripe.transfers.create()` at line 218. The transfer will fail at Stripe, but the error is only logged — and the calling code at lines 994-998 also only logs the failure while the order is already `completed` (see P0-3).
**What should happen:** Non-active accounts must be refused before the transfer attempt.
**Proposed fix:** Change the warn-and-continue to a guard that returns `{ success: false }` and triggers the blocked-payout notification.

#### P0-6: Connect account creation has no race protection — orphaned Stripe accounts

**Files (5 call sites):**
- `src/controllers/stripeConnectController.ts:75` (user-initiated)
- `src/controllers/stripeConnectController.ts:376` (auto-create on status poll)
- `src/controllers/nativePaymentController.ts:198` (auto-create at native checkout)
- `src/controllers/stripeController.ts:217` (auto-create at web checkout)
- `src/controllers/cartCheckoutController.ts:259` (auto-create at cart checkout)

**What is wrong:**
1. All 5 sites follow check-then-create (TOCTOU) without any lock, transaction, or idempotency key.
2. `stripe_connect_id` has no `@unique` constraint in the schema — a second write silently overwrites the first.
3. The Stripe API call and DB write are not in a transaction. If the DB write fails after `stripe.accounts.create` succeeds, the `acct_` is orphaned with no cleanup.
4. No reconciliation or cleanup mechanism exists.

**Impact:** The three duplicate `POST /v1/accounts` events in Stripe logs (22 Jul, 21 Jul ×2) are explained by concurrent requests hitting the TOCTOU window. Orphaned `acct_` objects accumulate in Stripe with no linkage to user rows.
**Proposed fix:** Add a deterministic idempotency key (`connect_account_${userId}`) to all `stripe.accounts.create` calls. Add `@unique` constraint on `stripe_connect_id` in schema. Consider serialising account creation with a DB row lock.

### P1 — User-facing failure with no automatic recovery

#### P1-1: No `account.updated` webhook — Connect status permanently stale

**File:** `src/controllers/stripeController.ts:403-578`
**What is wrong:** The webhook handler processes exactly 4 events: `checkout.session.completed`, `payment_intent.succeeded`, `charge.dispute.created`, `transfer.created`. There is no handler for `account.updated` or any Connect account event. `stripe_connect_status` is only updated when the seller actively polls `/account-status` or `/onboarding-status`.
**What should happen (per §7.2):** Status transitions (pending → active, active → restricted) should be reflected in real time.
**Impact:** A seller who completes Stripe onboarding but does not poll the status endpoint will have their payouts blocked indefinitely. The escrow cron reads the stale `pending`/`restricted` value from the DB and triggers the blocked-payout safety net, even though the seller's Stripe account is now `active`. There is no automatic way out — the seller must open the app and navigate to a screen that triggers the poll.
**Proposed fix:** Add an `account.updated` webhook handler that updates `stripe_connect_status` based on `charges_enabled && payouts_enabled`.

#### P1-2: No upstream payability gate — buyers can pay for items from sellers who cannot receive payouts

**Files:**
- `src/controllers/listingController.ts:156-306` (createListing — no check)
- `src/controllers/stripeController.ts:210-260` (checkout — auto-creates account, no status check)
- `src/controllers/cartCheckoutController.ts:251-299` (cart checkout — same)
- `src/controllers/nativePaymentController.ts:195-232` (native payment — same)
- `src/services/autoShippingService.ts:112` (shipping — comment confirms "Stripe NOT required to ship")

**What is wrong:** No payability check exists anywhere upstream of payout. A seller with `stripe_connect_status = 'restricted'` (or `pending`, or `null`) can list items, receive payments, have items shipped, and delivered — and the failure only surfaces at payout time, days after the buyer has paid.
**What should happen:** At minimum, checkout should warn the buyer or block the transaction when the seller's Connect account is not `active`. Listing creation could also gate on payability.
**Impact:** This is the root cause of the 22 Jul incident pattern. The buyer paid £189.98, the item was shipped and delivered, and only then did the system discover the seller couldn't be paid.
**Proposed fix:** Add a payability check at checkout. If seller is not `active`, either block the purchase or show a clear warning. At listing creation, set a visible indicator that the seller needs to complete payment setup.

### P2 — Silent failure requiring manual intervention

#### P2-1: Transfer failure in escrow cron is not alerted

**File:** `src/services/escrowService.ts:773-776`
**What is wrong:** When `stripe.transfers.create()` throws a non-duplicate error, the code logs `console.error` and `continue`s. No notification is created. No admin ticket. No email. The order stays `delivered` for retry, but the failure is invisible outside server logs.
**What should happen (per §4.8, Open item 4-OPEN-5):** Failed Stripe transfers should surface to admin and seller. The spec explicitly calls this out as an open item.
**Proposed fix:** Create a support ticket or admin notification on transfer failure, similar to the stuck-payout escalation at line 708-729.

#### P2-2: Transfer failure in `confirmReceipt` returns generic error to buyer

**File:** `src/controllers/orderController.ts:791-793`
**What is wrong:** The catch block returns `{ error: 'Failed to process payment to seller' }` with no context. The log at line 792 logs only `transferError.message` without order ID or seller ID. The buyer has no way to know whether to retry or wait. No admin is notified.
**Impact:** This is the exact error message the buyer in the 22 Jul incident received 5 times. Each retry hit Stripe and failed identically.
**Proposed fix:** Distinguish `insufficient_capabilities_for_transfer` from other errors. On capability errors, return a message explaining the seller needs to complete payment setup and trigger the blocked-payout notification path. Add order/seller context to the log.

#### P2-3: Zero-payout escrow path does not increment counters

**File:** `src/services/escrowService.ts:597-625`
**What is wrong:** When `actualPayout <= 0`, orders are marked `completed` without incrementing `total_sales` / `total_purchases`. The counter increment is at lines 795-810, which is only reached on the happy path.
**What should happen (per §2.3):** `total_sales++` on all `completed` transitions.
**Proposed fix:** Add counter increments to the zero-payout completion path.

### P3 — Inconsistency with no current impact

#### P3-1: Dispute resolution does not set `completed_at`

**Files:**
- `src/controllers/disputeController.ts:977-984`
- `src/controllers/disputeController.ts:1296-1302`
- `src/controllers/disputeController.ts:1727-1734`

**What is wrong:** All three paths set `status: 'completed'` but omit `completed_at`. All other completion paths (`confirmReceipt`:802, `completeOrder`:1629, escrow:786) set `completed_at: now`.
**What should happen (per §2.3):** `completed_at` is listed as a required field for `delivered → completed`.
**Proposed fix:** Add `completed_at: now` to all three order updates.

#### P3-2: `autoShippingService.ts` has dead `seller_not_verified` skip reason

**File:** `src/services/autoShippingService.ts:38`
**What is wrong:** The `skippedReason` enum includes `'seller_not_verified'` but this reason is never used in the function. It appears to be a vestige of a removed or never-implemented check.
**Proposed fix:** Remove the dead enum value, or implement the check it was meant for.

---

## Table A: Transfer Call Sites

| # | File:Line | Guard for `connect_id` | Guard for `connect_status` | `sellerCanReceivePayout` called | Double-transfer guard | Idempotency key | Transfer ID persisted | Failure behaviour |
|---|-----------|------------------------|----------------------------|-------------------------------|----------------------|-----------------|----------------------|-------------------|
| 1 | `orderController.ts:779` | Truthy check (line 775) | **NONE** — not even selected | No | Yes (`stripe_transfer_id` short-circuit, line 757) | Yes: `confirm_receipt_transfer_${orderId}` | Yes (line 804) | Aborts, returns 500, no admin alert |
| 2 | `orderController.ts:1606` | Truthy check (line 1602) | **NONE** — not even selected | No | **NONE** | **NONE** | **NO** — update at 1625 omits it | Aborts, returns 500, no admin alert |
| 3 | `disputeController.ts:218` | Explicit null check (line 179) | Warn only, proceeds (line 211-213) | No | Yes (`stripe_transfer_id` short-circuit, line 147) | Yes: `dispute_transfer_${disputeId}` | Yes (line 235) | Returns `{ success: false }`, caller logs only |
| 4 | `escrowService.ts:756` | `sellerCanReceivePayout()` + belt-and-braces (line 750) | Yes, via `sellerCanReceivePayout()` (line 631) | **Yes** | Yes (query filter + re-verify, lines 463/533-555) | Yes: `escrow_release_group_${trackingKey}` | Yes (line 787, all orders in group) | Continues to next group, order retried next cron |

**Cross-path double-pay risk:** Each site uses a different idempotency key prefix (or none). The same order could theoretically be paid via `confirmReceipt` (key: per-order), then `completeOrder` (no key), then escrow cron (key: per-tracking-group). The `stripe_transfer_id` column is the sole cross-path defence, but `completeOrder` neither checks it before transferring nor sets it after.

**Platform self-payout (out of scope):** `stripeController.ts:1068` calls `stripe.payouts.create()` (not `transfers.create`) to move platform fees to Mulligans' own bank account. Not a connected-account transfer.

---

## Table E: Order Completion Paths

| Path | File:Line | Sets `completed_at` | Sets `stripe_transfer_id` | Increments `total_sales` | Increments `total_purchases` | Checks `connect_status` |
|------|-----------|--------------------|--------------------------|--------------------------|-----------------------------|------------------------|
| Escrow auto-release (cron) | `escrowService.ts:785-810` | Yes | Yes | Yes | Yes | Yes (`sellerCanReceivePayout`) |
| Buyer confirms receipt | `orderController.ts:798-825` | Yes | Yes | Yes | Yes | **No** |
| Admin completeOrder | `orderController.ts:1625-1651` | Yes | **No** | Yes | Yes | **No** |
| Dispute: seller accepts (partial) | `disputeController.ts:977-984` | **No** | Via `transferSellerPayout` (if transfer succeeds) | **No** | **No** | Warn only |
| Dispute: buyer accepts counter | `disputeController.ts:1296-1302` | **No** | Via `transferSellerPayout` (if transfer succeeds) | **No** | **No** | Warn only |
| Dispute: admin resolves (partial/no refund) | `disputeController.ts:1727-1734` | **No** | Via `transferSellerPayout` (if transfer succeeds) | **No** | **No** | Warn only |
| Escrow zero-payout | `escrowService.ts:597-625` | Yes (line 608) | Not applicable (no transfer) | **No** | **No** | N/A |

**Invariant "status = 'completed' implies stripe_transfer_id is not null":** Not enforced anywhere. Violated by:
1. `completeOrder` (never sets `stripe_transfer_id`)
2. All three dispute resolution paths (set `completed` before transfer; if transfer fails, `stripe_transfer_id` stays null)
3. Zero-payout escrow path (intentional — no money to transfer)

---

## Question 15: Production Anomalies

### `order_c52adae2` (21 May) — Transfer created but `stripe_transfer_id` NULL

**Explanation:** Historical bug, **fixed** by commit `13d4a5b` (1 Jun 2026, "Tier A — money-safety must-fixes"). Before that commit, `confirmReceipt` created the Stripe transfer but did not persist the transfer ID to the order row. The diff shows `stripe_transfer_id` storage was added as part of "A3: confirmReceipt hardened with idempotency key, stripe_transfer_id storage."

**Status:** Fixed in `13d4a5b`. The current `confirmReceipt` code at line 804 persists `stripe_transfer_id`. However, the same bug **still exists** in `completeOrder` (line 1625-1633), which was not touched by that commit.

### `order_655d42f6` (1 Jun) — `completed` with both `stripe_transfer_id` and `completed_at` NULL

**Explanation:** This order went through a **dispute resolution** path. All three dispute resolution paths (`disputeController.ts:977-984`, `:1296-1302`, `:1727-1734`) set `status: 'completed'` without setting `completed_at`. If the `transferSellerPayout` call failed or the seller had no Connect account, `stripe_transfer_id` would also remain NULL.

**Status:** Live bug. All dispute resolution paths currently omit `completed_at` from the order update. This is a current defect (P3-1 above), and the more serious issue is P0-3 (order permanently orphaned if transfer fails).

---

## Question 17: The Critical Question

**If an order is marked `completed` without a transfer, can escrow ever pay it?**

**NO. The order is permanently orphaned.**

The escrow cron predicate at `escrowService.ts:455-463`:
```
status: 'delivered',
escrow_release_at: { lte: now, not: null },
stripe_transfer_id: null,
```

The pure predicate at `escrowDecisions.ts:100`:
```
if (order.status !== 'delivered') return false;
```

An order with `status = 'completed'` will never be selected by the escrow cron. There is no mechanism in the codebase to revert a `completed` order to `delivered`, and no separate job retries `completed` orders with `stripe_transfer_id = NULL`.

**Paths that create this orphan state:**
1. Dispute resolution (P0-3): sets `completed` before transfer, transfer fails → permanently stuck
2. `completeOrder` admin path (P0-2): transfer succeeds but ID not persisted → audit trail broken (money moved but DB shows NULL)
3. Zero-payout escrow: intentional (no money to transfer, not harmful)

**This means the proposed fix of "patch the single confirm-receipt site" (Harry's option 1) does not address the dispute resolution orphan path (P0-3). The dispute paths are independently dangerous.**

---

## Section B: Connect Status — Writes

### Q5: Every write to `users.stripe_connect_status`

| # | File:Line | Value | Trigger | Authentication |
|---|-----------|-------|---------|----------------|
| 1 | `stripeConnectController.ts:99` | `'pending'` | Seller creates Connect account | JWT (seller) |
| 2 | `stripeConnectController.ts:197-201` | `'active'`/`'restricted'`/`'pending'` (derived) | Seller polls `/account-status` | JWT (seller) |
| 3 | `stripeConnectController.ts:395` | `'pending'` | Auto-create on `/onboarding-status` poll | JWT (seller) |
| 4 | `stripeConnectController.ts:457-460` | `'active'`/`'restricted'`/`'pending'` (derived) | Seller polls `/onboarding-status` | JWT (seller) |
| 5 | `nativePaymentController.ts:220` | `'pending'` | Auto-create at native checkout | JWT (**buyer**, not seller) |
| 6 | `stripeController.ts:247` | `'pending'` | Auto-create at web checkout | JWT (**buyer**, not seller) |
| 7 | `cartCheckoutController.ts:290` | `'pending'` | Auto-create at cart checkout | JWT (**buyer**, not seller) |
| 8 | `accountDeletionJob.ts:275` | `null` | GDPR deletion cron (3am daily) | None (server-side cron) |

### Q6: Paths that update without seller's authenticated request

Four paths update `stripe_connect_status` without the seller making an authenticated request:

1. **Buyer-triggered auto-creation (3 paths):** Writes 5, 6, and 7 above. Any buyer checkout auto-creates a Connect account for the seller and sets status to `'pending'`.
2. **GDPR deletion cron:** Write 8. Nulls both `stripe_connect_id` and `stripe_connect_status`.

No admin override path writes to `stripe_connect_status`.

### Q7: Stripe webhook handlers

**No handler exists for `account.updated` or any Connect account event.**

Events currently handled (`stripeController.ts:403-578`):

| Event | Line | Action |
|-------|------|--------|
| `checkout.session.completed` | :422 | Order fulfilment |
| `payment_intent.succeeded` | :473 | Orphan PI refund safety net |
| `charge.dispute.created` | :528 | Freeze escrow, notify admin |
| `transfer.created` | :569 | Log only |

All other events fall through to a `default` case (line 574) that logs `Unhandled event type` and returns 200.

---

## Section C: Connect Status — Reads

### Q8-9: Reads classified and conflation count

**Sites that correctly check payability (both existence + `active` status): 3**
- `escrowService.ts:146-147` (`sellerCanReceivePayout`)
- `escrowService.ts:631` (calls `sellerCanReceivePayout`)
- `userController.ts:124` (`needs_bank_details: status !== 'active'`)

**Sites that conflate existence with payability (use `stripe_connect_id` alone to decide whether to send money): 6**

| # | File:Line | Context |
|---|-----------|---------|
| 1 | `orderController.ts:775` | `confirmReceipt` — guards transfer with `if (seller.stripe_connect_id && order.seller_payout)` |
| 2 | `orderController.ts:1602` | `completeOrder` — same pattern |
| 3 | `disputeController.ts:179,221` | `transferSellerPayout` — existence gate at 179, warn-only status check at 211 |
| 4 | `nativePaymentController.ts:194` | Native checkout — stores ID for transfer, status fetched but not checked |
| 5 | `stripeController.ts:211` | Web checkout — same pattern |
| 6 | `cartCheckoutController.ts:255` | Cart checkout — same pattern |

**The escrow cron is the only transfer path with a correct two-part payability gate.** All three interactive transfer paths (`confirmReceipt`, `completeOrder`, `transferSellerPayout`) lack the status check or treat it as advisory.

---

## Section D: Account Creation

### Q10: `stripe.accounts.create` call sites

| # | File:Line | Trigger | Guard |
|---|-----------|---------|-------|
| 1 | `stripeConnectController.ts:75` | User taps "Start Selling" | `if (user.stripe_connect_id)` early return |
| 2 | `stripeConnectController.ts:376` | Auto-create on `/onboarding-status` poll | `if (!user?.stripe_connect_id)` |
| 3 | `nativePaymentController.ts:198` | Buyer native checkout — seller lacks account | `if (!sellerConnectId)` |
| 4 | `stripeController.ts:217` | Buyer web checkout — seller lacks account | `if (!sellerConnectId)` |
| 5 | `cartCheckoutController.ts:259` | Buyer cart checkout — per seller | `if (!seller.stripe_connect_id)` |

### Q11: Race condition analysis

**Yes, races are possible and likely explain the duplicate Stripe events.** All 5 sites follow the same vulnerable pattern:

1. Read user row (check `stripe_connect_id` is null)
2. Async gap (other queries, Stripe API call)
3. `stripe.accounts.create()` (irreversible)
4. `prisma.users.update()` (writes `acct_xxx`)

No lock, no transaction, no idempotency key on any of the 5 paths. `stripe_connect_id` has no `@unique` constraint — a second write silently overwrites the first.

The three duplicate `POST /v1/accounts` events (22 Jul 17:42:32, 21 Jul 17:37:05, 21 Jul 13:17:08) are consistent with concurrent requests from the mobile app hitting the TOCTOU window (e.g., `create-account` and `onboarding-status` firing simultaneously on screen mount).

### Q12: Orphaned `acct_` creation

**Yes.** The Stripe API call and DB write are sequential `await` calls with no wrapping transaction. If the DB write fails after `stripe.accounts.create` succeeds, the `acct_` is permanently orphaned. No cleanup or reconciliation mechanism exists. No `stripe.accounts.del` call exists anywhere in the codebase. The `accountDeletionJob.ts` nulls `stripe_connect_id` but does not delete the Stripe account object.

---

## Section F: Escrow Retry Eligibility

### Q16: Exact selection predicate

`src/services/escrowService.ts:455-463`:
```typescript
const ordersToRelease = await prisma.orders.findMany({
  where: {
    status: 'delivered',
    escrow_release_at: { lte: now, not: null },
    stripe_transfer_id: null,
  },
  // includes: listings, seller (with stripe_connect_id, stripe_connect_status),
  //           disputes, return_requests
});
```

Post-query safety checks per order (lines 530-577):
1. Re-fetch order, verify `status === 'delivered'` and `stripe_transfer_id === null`
2. `hasBlockingDispute()` — blocks on statuses: `open`, `counter_offered`, `escalated`
3. `hasBlockingReturn()` — blocks on statuses: `pending`, `approved`, `awaiting_address`, `label_created`, `shipped`, `delivered`, `refund_processing`

Then `sellerCanReceivePayout()` at line 631 — blocks on non-active Connect.

### Q17: Answer repeated above in dedicated section.

**An order marked `completed` without a transfer can NEVER be paid by escrow. It is permanently orphaned.**

### Q18: Does escrow increment `total_sales` / `total_purchases`?

**Yes, on the happy path only.** `escrowService.ts:795-810` increments both counters after successful transfer.

**Not incremented by:**
- Zero-payout path (`escrowService.ts:597-625`) — orders set to `completed`, counters skipped
- All three dispute resolution paths (`disputeController.ts`) — counters never incremented
- Blocked-payout path (`escrowService.ts:631-737`) — correct (order stays `delivered` for retry)

### Q19: Alerting on blocked/failed payouts

| Path | Alert | Recipient | Delay |
|------|-------|-----------|-------|
| Blocked payout (cron) | In-app + push | Seller | Immediate, then every 3 days |
| Blocked payout (cron, 14+ days) | Support ticket | Admin (passive — must check dashboard) | 14 days |
| Dispute transfer fail | `console.error` only | **Nobody** | N/A |
| `confirmReceipt` transfer fail | HTTP 500 to buyer | Buyer (error message only) | Immediate |
| `completeOrder` transfer fail | HTTP 500 to admin | Admin caller only | Immediate |
| Escrow cron transfer fail (Stripe error) | `console.error` only | **Nobody** | N/A |

**No external alerting exists.** No Slack, PagerDuty, Sentry, or email-to-admin for any payout failure. The admin stuck-orders endpoint (`adminRoutes.ts:1840-1907`) exists but is pull-based.

---

## Section G: Upstream Gating

### Q20

`stripe_connect_status` is not checked at listing creation, checkout, label purchase, or shipping. The `autoShippingService.ts:112` comment ("Stripe NOT required to ship") is accurate and is the only gate-related comment. No other path checks payability before delivery.

The `seller_not_verified` skip reason at `autoShippingService.ts:38` is dead code — never used.

### Q21: What prompts sellers to complete Connect onboarding

| Mechanism | Type | When | Channel |
|-----------|------|------|---------|
| `needs_bank_details` flag in `/me` | Passive | Every app launch | Client-driven (frontend decides whether to show banner) |
| Blocked-payout notification | Reactive | First escrow cron after delivery + inspection | In-app + push |
| Blocked-payout reminder | Reactive | Every 3 days while blocked | In-app + push |
| Admin escalation ticket | Reactive | 14 days after first block | Support ticket (admin must check dashboard) |
| Dispute payout pending | Event-driven | Dispute resolves, seller has no Connect ID | In-app + push |

**Not present:** No email reminders. No pre-sale prompting. No webhook-driven notifications. No proactive push outside escrow cron context.

---

## Section H: Test Coverage

### Q22: Payout guards with test coverage

- `src/__tests__/unit/escrowService.test.ts` — tests `shouldReleaseEscrow()` (the pure predicate in `escrowDecisions.ts`), including double-release guard and blocking dispute/return checks. Does NOT test `sellerCanReceivePayout()` or the real escrow cron.
- `src/__tests__/unit/paymentMoneySafety.test.ts` — tests payout amount calculations and refund idempotency. Does NOT test seller status as a guard.

**Guards with NO test coverage:**
- `sellerCanReceivePayout()` (`escrowService.ts:146`) — zero tests, function is not exported
- `confirmReceipt` transfer path (`orderController.ts:775`) — zero tests
- `completeOrder` transfer path (`orderController.ts:1602`) — zero tests
- `transferSellerPayout` (`disputeController.ts:117`) — zero tests
- Blocked-payout safety net (`escrowService.ts:631`) — zero tests

### Q23: Tests asserting non-`active` seller refused payout

**None exist on any path.**

### Q24: Test fixture status values

The only occurrence of `stripe_connect_status` in test fixtures is at `paymentMoneySafety.test.ts:188`, hardcoded to `'active'`.

**The failure mode in this incident (seller with `stripe_connect_status !== 'active'`) is untestable with current fixtures.** No fixture models `'pending'`, `'restricted'`, or `null`. `sellerCanReceivePayout` is file-private (not exported) and cannot be imported for testing.

---

## Section I: Consolidation Assessment

### Q25: Does the `issueFailureRefund` pattern apply?

**Yes, with modifications.** The refund helper (`src/lib/issueFailureRefund.ts`, adopted across 5 sites in commit `5afc28e`) wraps a single Stripe API call with idempotency, logging, and a boolean return. The transfer case is structurally analogous but requires a more flexible interface.

A `transferToSeller()` helper could enforce:
1. Double-release guard (check `stripe_transfer_id` before transferring)
2. Payability check (`sellerCanReceivePayout`)
3. Idempotency key (caller-provided formula)
4. `stripe_transfer_id` persistence (to one or more order IDs)
5. Structured logging with order/seller context

### Q26: Call sites and exceptions

**Would adopt the helper (3 sites):**

| Site | File:Line | Notes |
|------|-----------|-------|
| `confirmReceipt` | `orderController.ts:779` | Simplest case — single order, standard amount |
| `completeOrder` | `orderController.ts:1606` | Urgently needs it — fixes 3 bugs at once |
| `transferSellerPayout` | `disputeController.ts:218` | Partial amount, dispute-specific metadata |

**Could partially adopt (1 site):**

| Site | File:Line | Friction |
|------|-----------|---------|
| Escrow cron | `escrowService.ts:756` | Multi-order grouping, aggregated payout, per-order persist loop, blocked-payout safety net are domain-specific |

The escrow cron could use the helper for the core `stripe.transfers.create` + persist step, but the pre-transfer validation (dispute/return checks, `sellerCanReceivePayout` with notifications, tracking group logic) must remain in the caller.

**No site is incompatible.** Differences in amount, idempotency key formula, and metadata are all parameterisable. The helper signature would be:

```typescript
async function transferToSeller(params: {
  amount: number;              // GBP, not pence
  destination: string;         // stripe_connect_id
  idempotencyKey: string;      // caller provides
  metadata: Record<string, string>;
  orderIds: string[];          // orders to mark with stripe_transfer_id
}): Promise<{ success: boolean; transferId: string | null }>
```

### Q27: CI check feasibility

**Feasible and recommended.** A grep-based CI check:

```bash
matches=$(grep -rn 'stripe\.transfers\.create' --include='*.ts' src/ \
  | grep -v 'src/lib/transferToSeller.ts' \
  | grep -v 'src/__tests__/')
if [ -n "$matches" ]; then
  echo "FAIL: stripe.transfers.create found outside the canonical helper:"
  echo "$matches"
  exit 1
fi
```

**Legitimate exceptions:** `src/__tests__/` (test mocks may reference the API). No other exception exists in the current codebase.

The `backup-before-security-fixes-2026-02-09_170338/` directory contains old copies — the grep should scope to `src/` only.

---

## Consolidation Recommendation

**Consolidation is viable and strongly recommended.** The `issueFailureRefund` commit (`5afc28e`) is a direct template. The transfer case is more complex (variable amounts, variable keys, multi-order persist) but all variability is parameterisable.

**The most compelling immediate win is `completeOrder` (site 2).** Adopting a shared helper would fix three bugs simultaneously: missing idempotency key, missing double-transfer guard, and missing transfer ID persistence.

**Phased approach:**
1. Create `src/lib/transferToSeller.ts` with the signature above
2. Adopt in `completeOrder` first (fixes P0-2)
3. Adopt in `confirmReceipt` (consolidation, adds `connect_status` check for P0-1)
4. Adopt in `transferSellerPayout` (consolidation, fixes P0-5 warn-and-continue)
5. Adopt in escrow cron for the core transfer step (final consolidation)
6. Add CI check to prevent bypass

This is not "consolidation or single-site patch" — it is "consolidation, starting with the single most dangerous site." The two options are not mutually exclusive.
