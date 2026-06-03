# CHANGES — Admin "Full Refund Including Fees" Override

**Branch:** `task/admin-full-refund`
**Base:** `upstream/main` (`e4b3e96`)

## Endpoint

`POST /admin/orders/:id/full-refund`

Admin-only. Refunds the buyer's ENTIRE payment (item + shipping + buyer-protection fee + service fee). Standard item-only refund is unchanged.

- **Auth:** `adminAuth` + `adminActionLimiter`. Non-admin → 403.
- **Reason required.** Missing/empty → 400.
- **Amount:** `buyer_total` (server-derived, never from request body). If `buyer_total` is null → 400 with `buyer_total_missing` code (admin handles manually via Stripe dashboard). We NEVER fall back to `order.amount` because that is the item price only and would silently under-refund.
- **Concurrency:** Claim-the-row `FOR UPDATE` + Stripe idempotency key `admin_full_refund_${orderId}`. Double-call → 409.
- **Audit:** `admin_audit_log` via `logAdminAction()` — action, reason, amount, stripe ID, previous status.

## Worked example

£50 item, buyer paid £58.49 (= £50 item + £4.99 shipping + £2.75 protection + £0.99 fee):
- Full refund → £58.49 (from `buyer_total`)
- If `buyer_total` is null → 400 error, admin processes manually via Stripe dashboard
- Standard item-only refund (other flows) → £50 (unchanged)

## Fix: buyer_total null-guard (commit 2)

The original code fell back to `order.amount` when `buyer_total` was null. Since `order.amount` is the item price only (not the buyer total), this would silently under-refund — defeating the entire purpose of the endpoint. Fixed: if `buyer_total` is null, return 400 with a clear message instead of guessing.

**No rollback needed on early return:** The claim-the-row does `FOR UPDATE` SELECT + read only — no order mutation happens before the `buyer_total` check. Confirmed by code review.

## Dev test plan

1. Order WITH `buyer_total` £58.49 (item £50) → full refund = £58.49
2. Order with `buyer_total` = null → 400 `buyer_total_missing`, NO Stripe refund, order untouched
3. Non-admin call → 403
4. Missing reason → 400
5. Double-call on valid order → second bails 409, no double refund
6. Standard item-only refund (dispute/return flows) → still refunds item cost only, unaffected

## Typecheck

`npx tsc --noEmit` → ZERO errors.

## Files changed

| File | Change |
|---|---|
| `src/routes/adminRoutes.ts` | Full-refund endpoint + buyer_total null-guard fix |
