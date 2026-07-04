# QTY-FIX-02: Internal Dispute Stock-Restore Investigation (S-4)

Branch: `task/qty-fix-02-internal-disputes` based from `clovis/pro-seller-foundation` at `ccbdded`

## Investigation: Resolution Path Map

The dispute controller (`src/controllers/disputeController.ts`, 2174 lines) has three user-triggered resolution paths and three system-automated paths. The forced return service (`src/services/forcedReturnService.ts`) adds a >60% threshold backstop.

### Resolution Paths

| # | Function | File | Actor | Trigger |
|---|----------|------|-------|---------|
| 1 | `respondToDispute` (accept) | disputeController.ts:771 | Seller | `PUT /api/disputes/:id/respond` |
| 2 | `acceptCounterOffer` | disputeController.ts:1130 | Buyer | `PUT /api/disputes/:id/accept-counter` |
| 3 | `adminResolveDispute` | disputeController.ts:1520 | Admin | `PUT /api/disputes/:id/resolve` |
| 4 | `autoEscalateDisputes` | escrowService.ts:1508 | System | Cron (72h timeout) |
| 5 | `autoExpireReturns` | escrowService.ts:1258 | System | Cron (buyer didn't ship return) |
| 6 | `autoConfirmForcedReturns` | escrowService.ts:1657 | System | Cron (seller didn't confirm receipt) |
| 7 | `confirmReturnDelivered` | returnController.ts:1003 | Seller | `POST /api/returns/confirm-delivered` |

### Threshold Logic (key to understanding S-4)

`isForceReturnThreshold(amount, itemCost)` returns true when `amount > itemCost * 0.6`. This means:
- **>60% of item cost** -> forced return (buyer must send item back, refund on completion)
- **<=60% of item cost** -> money-only partial refund (buyer keeps item)

Counter offers are restricted to 10-60% in 10% steps (`isAllowedCounterPercent`).
Buyer refund requests allow 10-60% (partial) or 100% (full).

### Status Transitions per Resolution Outcome

| Path | Condition | Dispute status | Order status | Refund? | Stock restore? |
|------|-----------|---------------|-------------|---------|----------------|
| 1a. Seller accept, >60% | Forced return | seller_accepted | (unchanged, stays disputed) | Deferred to return completion | Via paths 6 or 7 |
| 1b. Seller accept, <=60% | Money-only | seller_accepted | completed | Stripe refund (partial) | NO (buyer keeps item) |
| 2a. Buyer accept counter, >60% | Forced return (legacy only) | buyer_accepted | (unchanged) | Deferred | Via paths 6 or 7 |
| 2b. Buyer accept counter, <=60% | Money-only | buyer_accepted | completed | Stripe refund (partial) | NO (buyer keeps item) |
| 3a. Admin full_refund, >60% | Forced return | admin_resolved | (unchanged) | Deferred | Via paths 6 or 7 |
| 3b. Admin partial, <=60% | Money-only | admin_resolved | completed | Stripe refund (partial) | NO (buyer keeps item) |
| 3c. Admin no_refund | Sale stands | admin_resolved | completed | None | NO (sale stands) |
| 4. Auto-escalate | Not terminal | escalated | (unchanged) | None | N/A |
| 5. Auto-expire return | Buyer didn't ship | admin_resolved | delivered | None | NO (buyer kept item) |
| 6. Auto-confirm return | Seller timeout | N/A | returned | Stripe refund (full) | YES (restoreListingStock inside $transaction) |
| 7. Seller confirms return | Manual | N/A | returned | Stripe refund (full) | YES (restoreListingStock inside $transaction) |

### Critical Finding: Why Full Refund Always Triggers Forced Return

For a 100% buyer request: `requested_refund_amount = orderAmount * 1.0 = orderAmount`. Since `orderAmount >= itemCost` (includes shipping/fees), and `orderAmount > itemCost * 0.6`, the threshold ALWAYS triggers forced return.

For admin `full_refund`: `finalRefundAmount = orderAmount` (line 1565). Same logic applies.

Counter offers are capped at 60%, so `counterOfferAmount <= itemCost * 0.6` -- they NEVER trigger forced return through the current allowlist.

**Conclusion:** Every full-refund resolution goes through the forced return lifecycle, which restores stock via path 6 or 7. There is no code path where a buyer receives a full refund without the forced return mechanism engaging.

### Stock Restore Verification

Forced return stock restore happens in two places:
1. **`returnController.ts:1096-1115`** (seller confirms receipt): `restoreListingStock(tx, listing_id, quantity || 1, 'return_refund', selected_size)` inside `$transaction`
2. **`escrowService.ts:1750-1768`** (auto-confirm, seller timeout): `restoreListingStock(tx, listing_id, quantity || 1, 'return_refund', selected_size)` inside `$transaction`

Both use claim-the-row idempotency (`SELECT ... FOR UPDATE` with status + `stripe_refund_id IS NULL` guard). Both call `restoreListingStock` inside the same transaction that updates the return request and order status. Both benefit from QTY-FIX-01's S-6 fix (off_sale status preserved).

### S-4 Assessment

**The original S-4 finding is a false positive** for the specific scenario described ("buyer receives full refund, stock not restored"). The auditor examined `disputeController.ts` in isolation and correctly observed it never calls `restoreListingStock`. However, full refunds always route through the forced return lifecycle (`returnController` + `escrowService`), where stock IS restored inside transactions with claim-the-row idempotency.

**Partial refunds (<=60%)** correctly do NOT restore stock -- the buyer keeps the item. The sale transitions to `completed`, not `refunded`. Restoring stock here would overcount the seller's available inventory.

### No Code Changes Required in disputeController.ts

There are no resolution paths where stock should be restored but isn't. The forced return mechanism provides the correct separation of concerns: the dispute controller handles the resolution decision; the return controller handles the physical return and stock accounting.

## Partial Refund Decision (flagged for Harry)

See `output/questions.md` -- the question is whether partial refunds (buyer keeps item, gets <=60% money back, order `completed`) should also restore stock. Current behavior: NO restore. Analysis: this is correct because the buyer physically has the item. Restoring stock would inflate the seller's available inventory beyond what they can actually fulfill.

The C-2 chargeback precedent (restore stock even though buyer keeps item) does NOT apply here because:
- Chargeback: unilateral card network decision, sale voided against seller's will, order -> `refunded`
- Internal partial refund: negotiated compromise, sale stands at reduced price, order -> `completed`

## Tests

**File:** `src/__tests__/unit/qtyFix02DisputeStock.test.ts`

Tests verify the current behavior is correct:

| # | Test | What it proves | Teeth-check |
|---|------|----------------|-------------|
| 1 | Seller accept 100% -> createForcedReturn called | Full refund always routes to forced return | Remove threshold check -> test fails |
| 2 | Seller accept 30% -> Stripe refund, no createForcedReturn | Partial stays money-only | Lower threshold -> test fails |
| 3 | Admin full_refund -> createForcedReturn called | Admin full refund routes to forced return | Remove threshold check -> test fails |
| 4 | Admin no_refund -> no refund, sale stands | No-refund path has no stock restore | Add unwanted refund -> test fails |
| 5 | confirmReturnDelivered -> restoreListingStock inside tx | Forced return completion restores stock | Remove restock call -> test fails |
| 6 | off_sale listing stays off_sale after restore | S-6 fix integration | Revert S-6 fix -> test fails |
| 7 | Claim-the-row blocks double restore | Idempotency on forced return | Remove guard -> test fails |

## Concerns (not bugs, noted for awareness)

1. **Non-transactional resolution writes**: In all three dispute controller resolution functions, the Stripe refund, order update, dispute update, and seller payout transfer are separate non-transactional operations. If any step fails mid-way, there's no rollback. This is a pre-existing design pattern -- flagged but NOT in scope per brief instructions ("Do NOT change refund/escrow money logic").

2. **Dead code**: `dispute.requested_refund_percent === 100` checks at lines 981 and 1299 are dead code -- 100% requests always trigger forced return before reaching these lines. Counter offers are capped at 60%, so `counter_offer_percent === 100` is also dead code. Harmless but confusing.

## Diff stats

```
 CHANGES.md                                         | (this file)
 src/__tests__/unit/qtyFix02DisputeStock.test.ts     | new file (tests)
 0 production code files changed
```

No schema changes. No deploy required.
