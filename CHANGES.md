# CHANGES — Brief 2: Money-Safety Foundations

**Branch:** `task/money-safety-foundations`  
**Base:** `main`  
**Repo:** `Mulligans-Backend` → `Clovis-Mulligans/Mulligans-Backend-Clovis`

## Migration included

`prisma/migrations/20260601000000_money_safety_foundations/migration.sql`  
Adds two nullable columns: `disputes.buyer_deadline`, `return_requests.reminder_sent_at`.  
**Must be applied before/with the code deploy.** Additive-nullable — rollback-safe.

## Deploy ordering

1. Run the Prisma migration (`npx prisma migrate deploy`)
2. Deploy the updated backend code
3. No client changes required (all changes are backend-only; `admin_resolved` status is already handled by Brief 1's mobile status maps)

---

## Per-file changelog

### prisma/schema.prisma
- Added `buyer_deadline DateTime?` to `disputes` model
- Added `reminder_sent_at DateTime?` to `return_requests` model

### prisma/migrations/20260601000000_money_safety_foundations/migration.sql
- New migration: two `ALTER TABLE ADD COLUMN` statements

### src/controllers/disputeController.ts
- **A2:** `respondToDispute` — row-lock (SELECT FOR UPDATE) before resolution; idempotency key `dispute_refund_${disputeId}` on Stripe refund; persists `stripe_refund_id` on order
- **A2:** `acceptCounterOffer` — row-lock; idempotency key `dispute_counter_refund_${disputeId}`; persists `stripe_refund_id`; skips transfer at 100% counter-offer (was attempting £0 transfer)
- **A2:** `adminResolveDispute` — row-lock; idempotency key `dispute_admin_refund_${disputeId}`; persists `stripe_refund_id`
- **A2:** `transferSellerPayout` — idempotency key `dispute_transfer_${disputeId}`; persists `stripe_transfer_id` on order; short-circuits if already transferred
- **B1:** Removed `autoEscalateExpired` static method (dead HTTP handler; cron version in escrowService is authoritative)
- **B3:** `respondToDispute` counter path sets `buyer_deadline = now + 72h`
- **B4:** `adminResolveDispute` validates `resolutionAmount <= orderAmount` (returns 400)
- **B5:** `transferSellerPayout` fallback uses `calculateSellerPayout()` from `feeCalculations.ts` instead of inline formula
- **C2:** Seller-accept path now sends resolution email to seller (was buyer-only)
- **C3:** All notification IDs switched to `crypto.randomUUID()`
- Added `import crypto from 'crypto'` and `import { calculateSellerPayout, ... } from '../lib/feeCalculations'`

### src/controllers/orderController.ts
- **A3:** `confirmReceipt` — idempotency key `confirm_receipt_transfer_${orderId}`; stores `stripe_transfer_id`; blocks if active dispute or return; short-circuits if already transferred
- **C3:** Notification IDs switched to `crypto.randomUUID()`
- Added `import crypto from 'crypto'` and `import { hasBlockingDispute, hasBlockingReturn } from '../services/escrowService'`

### src/controllers/returnController.ts
- **A1:** `purchaseReturnLabelBuyer` and `purchaseReturnLabelSeller` both set `return_ship_deadline = now + 3 days`
- **C3:** Notification IDs switched to `crypto.randomUUID()`
- Added `import crypto from 'crypto'`

### src/routes/disputeRoutes.ts
- **B1:** Removed `POST /auto-escalate` route and `DisputeController.autoEscalateExpired` reference

### src/services/escrowService.ts
- **A1:** New `sendReturnShipReminders()` function — fires 48h reminder (24h before deadline) for `label_created` returns with null `reminder_sent_at`; wired into `runEscrowJobs()`
- **B1:** `autoEscalateDisputes()` now queries on explicit `seller_deadline <= now` (not `created_at` offset); also escalates `counter_offered` disputes past `buyer_deadline`
- **B2:** `autoExpireReturns()` sets dispute status to `admin_resolved` (was undocumented `resolved`)
- **C1:** `autoReleaseEscrow()` uses `order.seller_payout` for payout calculation (falls back to `order.amount` for legacy orders)
- **C3:** All notification + ticket IDs switched to `crypto.randomUUID()`
- Exported `hasBlockingDispute()` and `hasBlockingReturn()` for reuse in orderController

## Commits

| SHA | Tier | Summary |
|-----|------|---------|
| `13d4a5b` | A | Idempotency, row locks, return deadline, schema migration |
| `43fd53d` | B | Escalation consolidation, status fix, buyer deadline, validation |
| `806b4a1` | C | seller_payout, seller email, collision-safe IDs |
