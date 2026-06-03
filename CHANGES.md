# CHANGES — Brief 3b: Forced Returns on High-Value Refunds

**Branch:** `task/3b-forced-returns`
**Base:** `upstream/main` (`f941aaa`)

## What this does

When a dispute refund of ≥70% of item cost is agreed (seller accepts, buyer accepts counter, or admin resolves), it triggers a **forced return**: the buyer must return the item before receiving a refund. On completion, the buyer is refunded **100% of item cost** (not the partial amount). The platform pays for the return label.

## Components

### 1. Forced return threshold + creation (`forcedReturnService.ts` — NEW)
- `isForceReturnThreshold(refundAmount, itemCost)` — true if ≥70%
- `resolveReturnLabelPayer()` — payer seam (returns `'platform'` for forced; future: seller-debit)
- `createForcedReturn()` — creates return_request with `is_forced: true`, auto-purchases platform-paid return label via Shippo, notifies both parties, sets 5-day buyer ship deadline

### 2. Dispute resolution intercepts (`disputeController.ts`)
Three insertion points, all BEFORE the Stripe refund call:
- **Seller accepts** (~line 850): if `requested_refund_amount ≥ 70%` → forced return
- **Buyer accepts counter** (~line 1110): if `counter_offer_amount ≥ 70%` → forced return
- **Admin resolves** (~line 1510): if `finalRefundAmount ≥ 70%` → forced return

When triggered: creates forced return, sets dispute `resolution_type: 'forced_return'`, does NOT process Stripe refund, does NOT transfer to seller, does NOT change order status. The blocking return prevents any money movement.

### 3. Seller confirms receipt → 100% refund (`returnController.ts`)
Modified `confirmReturnDelivered`: if `is_forced`, uses claim-the-row (FOR UPDATE → `refund_processing`), refunds 100% of item cost via Stripe with idempotency key, marks return completed + order returned. Reverts on failure.

### 4a. Return delivery webhook (`shippingController.ts`)
Extended `handleShippoWebhook` to check `return_requests.return_tracking_number` when no order matches. On DELIVERED status, sets `return_requests.delivered_at`.

### 4b. Seller auto-confirm (`escrowService.ts`)
`autoConfirmForcedReturns()` — added to `runEscrowJobs`. Auto-confirms forced returns where:
- Carrier delivered + 3 days passed without seller confirmation
- OR shipped 14+ days ago with no delivery signal (fallback)

Uses same claim-the-row pattern as manual confirmation. Concurrency-safe with `confirmReturnDelivered`.

### 5. Buyer-didn't-return timeout
The existing `autoExpireReturns` already handles this — forced returns with `status: 'label_created'` past `return_ship_deadline` are cancelled. Order goes back to `delivered` → seller gets paid.

## Schema change
```prisma
is_forced  Boolean  @default(false)  // on return_requests
```
Migration: `prisma/migrations/forced_returns/migration.sql`

## Money safety

| Scenario | Guard |
|---|---|
| Double refund | Stripe idempotency key `forced_return_refund_${returnId}` |
| Concurrent seller-confirm + auto-confirm | FOR UPDATE on `status = 'shipped'` — only one can claim |
| Concurrent timeout + confirmation | Different status targets: timeout queries `label_created`, confirmation queries `shipped` |
| Refund AND release to seller | BLOCKING_RETURN_STATUSES prevents escrow release while return active |
| Claim revert on Stripe failure | Status reverted to `shipped` if Stripe call fails |

## Constants
- `FORCED_RETURN_THRESHOLD = 0.70` (70%)
- `FORCED_RETURN_SHIP_DEADLINE_DAYS = 5`
- `FORCED_RETURN_SELLER_CONFIRM_DAYS = 3` (after delivery)
- `FORCED_RETURN_SELLER_CONFIRM_FALLBACK_DAYS = 14` (after ship, no delivery signal)

## Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `is_forced` to `return_requests` |
| `src/services/forcedReturnService.ts` | **NEW** — threshold check, payer seam, forced return creation + label purchase |
| `src/controllers/disputeController.ts` | ≥70% intercept at 3 resolution paths |
| `src/controllers/returnController.ts` | Forced return handling in `confirmReturnDelivered` |
| `src/controllers/shippingController.ts` | Webhook handles return tracking DELIVERED |
| `src/services/escrowService.ts` | `autoConfirmForcedReturns()` + wired into `runEscrowJobs` |

## Dev test plan
1. ≥70% dispute → forced return created, no Stripe refund
2. <70% dispute → normal immediate refund (unchanged)
3. Platform-paid label generated, `paid_by: 'platform'`
4. Seller confirms → buyer refunded 100% item cost, idempotent
5. Concurrent confirm → second call gets 409
6. Buyer doesn't ship → timeout cancels return, seller gets paid
7. Seller doesn't confirm + carrier DELIVERED → auto-confirm after 3 days
8. Seller doesn't confirm + no DELIVERED → fallback auto-confirm after 14 days
