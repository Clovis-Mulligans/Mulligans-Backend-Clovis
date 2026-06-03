# CHANGES — Payout Fix: manual-ship overpayment + dead code

**Branch:** `task/payout-fix`  
**Base:** `main` (`ad1d959`)  
**Repo:** `Mulligans-Backend` → `Clovis-Mulligans/Mulligans-Backend-Clovis`

## Change 1 — Fix manual-ship payout formula

**File:** `escrowService.ts` (around line 572)

**Before:**
```
if (isAutoShipped) {
  actualPayout = itemsTotal;                                    // item-only ✓
} else {
  shippingAmount = MAX(order.shipping_cost);
  labelCostTotal = SUM(order.label_cost);
  actualPayout = itemsTotal + shippingAmount - labelCostTotal;  // item + shipping margin ✗
}
```

**After:**
```
actualPayout = SUM(order.seller_payout)   // item-only, both paths
```

The auto/manual distinction is preserved in logging only (for ops visibility). The payout amount is now identical regardless of how the label was generated.

**Worked example — £50 item, £4.99 buyer-paid shipping, £3.50 label cost:**

| | Before (manual) | After (both) | Canonical rule |
|---|----------------|-------------|---------------|
| Seller receives | £51.49 | **£50.00** | £50.00 |
| Platform keeps (shipping) | £0 (only label cost) | **£4.99** | £4.99 |
| Platform pays (label) | £3.50 | £3.50 | £3.50 |
| **Net platform shipping margin** | **-£1.49** | **+£1.49** | +£1.49 |

The `shippingAmount` and `labelCostTotal` variables were removed — they are no longer used. Logging now shows item total and transfer amount only.

The existing `actualPayout <= 0` safety check is preserved (prevents negative/zero transfers).

## Change 2 — Remove dead-code legacy payout fallback

**File:** `orderController.ts` (was lines 38-43)

**Removed:** The local `calculateSellerPayout()` function that used a wrong inverse formula `(amount - 0.99) / 1.075`. This was a fallback in `completeOrder` (line 1718): `order.seller_payout || calculateSellerPayout(amount)`. Since `seller_payout` is always set at order creation (verified: `cartCheckoutController.ts:797`, `nativePaymentController.ts:690,1047`), the fallback was never reached.

**Grep result:**
```
src/controllers/orderController.ts:38  — function definition (REMOVED)
src/controllers/orderController.ts:1718 — sole caller (REMOVED — now uses seller_payout directly)
src/lib/escrowDecisions.ts:18,120 — DIFFERENT function (imported from feeCalculations.ts, not touched)
```

The `completeOrder` path now uses `order.seller_payout` directly. If `seller_payout` is null (shouldn't happen), the `if (seller.stripe_connect_id && sellerPayout)` guard at line 1723 prevents a transfer — safe.
