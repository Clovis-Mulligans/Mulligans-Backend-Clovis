# CHANGES — Stuck-Order Safety Net + Auto-Ship Stripe Consistency

**Branch:** `task/stuck-order-autoship`
**Base:** `main` (`403ecac` — includes payout fix)

## Change 1 — Auto-Ship Stripe Gate Removed

**File:** `src/services/autoShippingService.ts`

Removed the `stripe_connect_status === 'active'` gate at line 116. Auto-ship now requires only a sending address, matching the manual shipping path. Per Harry's model: Stripe onboarding is NOT required to ship — only to withdraw funds.

## Change 2 — Stuck-Order Safety Net

**File:** `src/services/escrowService.ts`

### 2a. Blocked-payout detection (enhanced)

Previously only checked `!seller.stripe_connect_id`. Now checks both conditions via `sellerCanReceivePayout()`:
- `stripe_connect_id` must exist
- `stripe_connect_status` must be `'active'`

### 2b. Schema fields

Two new nullable columns on `orders`:
- `payout_blocked_at` — set when payout first blocked; cleared on successful transfer
- `payout_reminder_sent_at` — last reminder timestamp; enforces 3-day cadence

Migration: `prisma/migrations/stuck_order_safety_net/migration.sql`

### 2c. Seller reminders (3-day cadence)

- Immediate notification on first block: "£X for [item] is ready for you — complete your payment setup to withdraw it."
- Re-reminder every 3 days (idempotent via `payout_reminder_sent_at`)
- In-app notification + push notification
- Stops automatically once seller onboards and payout succeeds

### 2d. Auto-retry

Each daily `autoReleaseEscrow()` run re-processes blocked orders. When seller completes onboarding, next cycle releases funds and clears `payout_blocked_at`.

### 2e. Admin escalation at 14 days

Creates a `support_ticket` with `type: 'payout_blocked'`, `priority: 'high'`. One ticket per order (deduped). No auto-resolution — visibility only.

### 2f. Admin endpoint

**File:** `src/routes/adminRoutes.ts`

`GET /admin/stuck-orders` — returns all blocked-payout orders, oldest first, with seller/buyer info and days-blocked count. Behind `adminAuth`.

## Files changed

| File | Change |
|---|---|
| `src/services/autoShippingService.ts` | Removed Stripe gate (lines 115-118) |
| `src/services/escrowService.ts` | Added constants, helper, blocked-payout safety net, clear on transfer |
| `src/routes/adminRoutes.ts` | Added `GET /admin/stuck-orders` |
| `prisma/schema.prisma` | Added `payout_blocked_at`, `payout_reminder_sent_at`, index |
| `prisma/migrations/stuck_order_safety_net/migration.sql` | DDL for new columns |
| `questions.md` | Schema proposal, security notes |
