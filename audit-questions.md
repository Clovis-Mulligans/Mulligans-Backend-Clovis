# Questions — Web Checkout Money-Path Audit

**Branch:** `task/audit-web-money-safety`
**Date:** 2026-07-25

---

## Q1 — For Harry: Which web orders are the three known ones?

**Context:** The brief mentions three live web orders: £36.00, £42.50, £62.20. To confirm they are not stranded (Finding 5), I need to cross-reference them against the database.

**Action:** Run query Q2 from AUDIT.md to find any `to_ship` orders with `auto_cancel_at = NULL`. If any of the three known orders appear, they need a manual `auto_cancel_at` backfill (the `scripts/backfill-autocancel.ts` script exists for this).

---

## Q2 — For Harry: Has the owner's order been manually resolved?

**Context:** The owner's web order that triggered this audit had its `auto_cancel_at` cleared by the PRE_TRANSIT bug. The fix prevents this going forward, but does not restore the timer on already-affected orders.

**Question:** Was the owner's order manually completed, cancelled, or is it still sitting in `to_ship`? If still in `to_ship`, the backfill script should be run against it.

---

## Q3 — For Harry: Should `payoutPlatformFee` run on mobile too?

**Context:** After a web checkout, the platform fee is immediately withdrawn from Stripe to the bank (`stripeController.ts:1042-1083`). Mobile orders do not do this — the platform fee sits in the Stripe balance.

**Question:** Is this intentional? If not, should it be added to the mobile path or removed from web? Neither option has a safety impact — this is purely about when Mulligans receives its own fee.

---

## Q4 — For Brief 2 (frontend): Who is calling the web checkout endpoints?

**Context:** The backend cannot determine which client calls `POST /api/stripe/create-checkout-session`. There is no client-identification mechanism. The brief assumes "web" but the backend has no way to verify.

**Question for frontend audit:** Is the Mulligans consumer web app (`mulligans.uk.com`) calling these endpoints? Or is it the mobile app's WebView? Or something else? The frontend code will answer this.

---

## Q5 — For Harry: Which shipping formula is correct for multi-quantity?

**Context:** The spec (`business-logic-v2.md` §4.2) says `ceil(quantity / 5) × shipping_cost` for quantity scaling. The web path implements this. The mobile path uses flat `shippingCost` regardless of quantity. `feeCalculations.ts` also uses flat shipping.

**The spec, the canonical module, and the mobile code disagree.**

**Options:**
- A. The spec is right, web is correct, fix mobile + `feeCalculations.ts` to match
- B. The spec is outdated, mobile is correct, fix web + update spec
- C. Quantity > 1 is rare enough that this can wait

**My assessment:** For quantity = 1 (the overwhelmingly common case), all paths agree. The divergence only matters for multi-quantity purchases. This is P2 at worst, but Harry should state the intended behaviour so the spec and code can be aligned.

---

## Q6 — For Harry: Should the escrow auto-release use `transferToSeller`?

**Context:** The escrow cron (`escrowService.ts:750`) calls `stripe.transfers.create` directly instead of using the `transferToSeller` helper. Both have the same guards (double-transfer check, `sellerCanReceivePayout`, idempotency key, transfer ID persistence), but the logic is duplicated.

**My assessment:** No safety gap exists. But if `transferToSeller` is ever updated (e.g., additional validation), the escrow cron won't benefit. This is a code-health item, not urgent.

---

## Q7 — Ambiguity: `buyer_protection_fee` vs `service_fee` in metadata/emails

**Context:** All checkout paths store the combined platform fee (7.5% + £0.99) as `buyer_protection_fee` and set `service_fee = '0.00'`. Order confirmation emails display these values, showing an inflated "Buyer Protection" line and a zero "Service Fee".

**Question:** Is this the intended display? The terms of service and buyer-facing copy should show either:
- A single combined fee (rename to "Mulligans Fee" or similar), OR
- Two separate line items (7.5% buyer protection + £0.99 service fee)

The current approach labels the combined amount as "Buyer Protection" which is technically inaccurate. This may have legal/compliance implications for consumer transparency.
