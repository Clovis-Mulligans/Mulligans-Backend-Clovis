# CHANGES — Admin "Full Refund Including Fees" Override

**Branch:** `task/admin-full-refund`
**Base:** `upstream/main` (`e4b3e96`)

## What this does

Adds an admin-only endpoint to refund the buyer's ENTIRE payment (item + shipping + buyer-protection fee + service fee). The standard refund (item-only) is unchanged — this is a manual override for exceptional cases: chargebacks, platform-fault errors, legal requirements, high-value goodwill.

## Endpoint

`POST /admin/orders/:id/full-refund`

### Auth
`adminAuth` middleware (same as all admin money actions). Requires `Authorization: Admin <password>` header. Non-admin → 403.

### Request body
```json
{ "reason": "Chargeback received - full refund required" }
```
`reason` is required (non-empty string). Missing/empty → 400.

### Response
```json
{
  "success": true,
  "data": {
    "orderId": "...",
    "refundAmount": 58.49,
    "stripeRefundId": "re_...",
    "reason": "Chargeback received - full refund required",
    "message": "Full refund of £58.49 processed (includes all fees and shipping)."
  }
}
```

## Full-amount calculation

The refund amount = `buyer_total` (everything the buyer paid). Fallback to `amount` for legacy orders where `buyer_total` wasn't tracked. The amount is **derived server-side from the order** — NEVER from request body.

**Worked example:** Buyer paid £58.49 = £50.00 item + £4.99 shipping + £2.75 protection (7.5%) + £0.99 service fee → full refund returns £58.49 (not £50.00).

## Concurrency / idempotency

- **Claim-the-row:** `FOR UPDATE` lock on orders where `stripe_refund_id IS NULL AND status NOT IN ('refunded', 'cancelled')`. If already refunded → 409.
- **Stripe idempotency key:** `admin_full_refund_${orderId}`. Double-call returns the same refund.
- Cannot race with normal refund flow (3a return refund, dispute refund, auto-release) — all check `stripe_refund_id IS NULL` before creating a refund.

## Audit logging

Uses the existing `admin_audit_log` table + `logAdminAction()` helper. Records:
- `action: 'admin_full_refund'`
- `target_type: 'order'`
- `target_id: orderId`
- `details`: reason, refund_amount, stripe_refund_id, buyer_total, item_amount, seller_payout, previous_status, includes_fees_and_shipping

## Security

- Auth: `adminAuth` middleware — cannot be bypassed by non-admin callers
- Reason: enforced server-side (400 if missing)
- Amount: derived from order data, never from request body — caller cannot manipulate
- Audit: always written (via `logAdminAction`, fails silently to not block the refund)
- Rate limited: `adminActionLimiter` (same as other admin money actions)

## Files changed

| File | Change |
|---|---|
| `src/routes/adminRoutes.ts` | Added `POST /admin/orders/:id/full-refund` endpoint + crypto import |

No schema changes. No migration.

## Dev test plan

1. **Non-admin call → 403:** Send request without admin auth header
2. **Missing reason → 400:** Send with auth but empty/missing reason
3. **Valid full refund → success:** Admin refunds order → buyer refunded `buyer_total`, audit record written, order status → `refunded`
4. **Double call → 409:** Call again for same order → second call bails, no double refund
5. **Standard refund unaffected:** Normal item-only refund (via dispute/return flow) still refunds `seller_payout` not `buyer_total`

## Typecheck

`npx prisma generate && npx tsc --noEmit` → ZERO errors.
