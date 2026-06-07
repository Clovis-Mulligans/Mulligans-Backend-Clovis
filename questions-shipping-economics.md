# Questions — Lock Shipping Economics

**Date:** 7 June 2026
**Brief:** clovis-brief-lock-shipping-economics-2026-06-07
**Backend branch:** `task/lock-shipping-economics-2026-06-07` from `origin/main` (`672d2bc`)
**Mobile branch:** `task/lock-shipping-economics-mobile-2026-06-07` from state-priority fix on `feature/shipping-safety-mobile-2026-05` (`5378feb`)

---

## Investigation Verification

### SHA Verification
- Backend `origin/main` HEAD: `672d2bc` — confirmed
- Mobile `origin/feature/shipping-safety-mobile-2026-05` HEAD: `5378feb` — confirmed
- Mobile state-priority fix: `eb0158b` + `ac59d63` on `clovis/task/fix-sold-order-state-priority-2026-06` — mobile task branch created from here to preserve new state machine

### `getSellerSendingAddress` call sites (all on `main`)
- `src/services/autoShippingService.ts:116` — outbound auto label
- `src/controllers/shippingController.ts:177` — rate options endpoint (now orphaned)
- `src/controllers/returnController.ts:69` — return rates
- `src/controllers/returnController.ts:146` — return label purchase
- `src/controllers/returnController.ts:310` — return label (another path)
- `src/controllers/returnController.ts:1239` — forced return

All paths use the DB-backed helper, not Stripe Connect. Preserved.

### `PARCEL_SIZES` location
- Defined: `src/controllers/shippingController.ts:27-73`
- Shape: `{ small, medium, large, extra_large, oversized }` — each with `name`, `description`, `price`, `length`, `width`, `height`, `weight`

### Manual label endpoint
- Route: `POST /api/shipping/labels`
- Handler: `createShippingLabel` in `shippingController.ts`
- Previous request body: `{ orderId, rateId }`
- **New request body:** `{ orderId }` — rateId no longer accepted (rate selection is server-side)
- Response shape preserved: `{ success, data: { trackingNumber, labelUrl, carrier, labelCost, qr_code_url } }`

### Rate-options endpoint
- Route: `GET/POST /api/shipping/rates` (getShippingRates in shippingController.ts)
- **Now orphaned** — no mobile screen calls this anymore. Left in place; not removed. Harry can remove in a future cleanup PR.

---

## Snapshot Sites (Step 2)

| Controller | Line | Listing variable | Notes |
|---|---|---|---|
| cartCheckoutController.ts | 802 | `listing` (from `findUnique` with `select` — added `parcel_size: true` to select) | Cart checkout |
| nativePaymentController.ts | 695 | `listing` (full include) | Single-item Apple Pay |
| nativePaymentController.ts | 1053 | `listing` (full include) | Cart Apple Pay |
| stripeController.ts | 781 | `listing` (full include from line 640, not `freshListing` which uses narrow select) | Stripe Checkout single-item |

---

## Reader Fallback Chain

All three reader locations now use: `order.parcel_size || order.listings?.parcel_size || 'medium'`

- `src/controllers/shippingController.ts:162` — rate options (orphaned but kept correct)
- `src/services/autoShippingService.ts:80` — auto/manual label purchase
- `src/controllers/returnController.ts:331` — return label

---

## Rate Selection — Reading C Implementation

Implemented in `src/lib/rateSelection.ts`:

1. Filter to tracked rates (using keyword matching, same as existing `filterTrackedRates` logic)
2. If no tracked rates available, fall back to all rates (rather than failing — untracked > no label)
3. Sort by price ascending
4. Find all rates with `amount <= buyerPaidShippingCost`
5. If matches: pick **most expensive** (best service within budget) → `overBudget: false`
6. If no matches: pick **cheapest** → `overBudget: true` (Mulligans absorbs)

Unit tests: `src/__tests__/unit/rateSelection.test.ts` — 8 tests, all passing.

### Assumption requiring confirmation
**Untracked fallback:** If Shippo returns only untracked rates, the helper falls back to those rather than returning null. This means Mulligans would rather ship untracked than not at all. **Harry should confirm this is acceptable.**

### Old selectBestRate removed
The old 20% preferred-carrier bonus is removed entirely. Reading C supersedes it. If seller carrier preferences become relevant again, they can be layered on top of Reading C (e.g. prefer among qualifying rates), but that's a separate brief.

---

## Security Scan

### Parcel size immutability
- `parcel_size` is set only in `prisma.orders.create` calls (4 sites documented above)
- No controller or route writes to `orders.parcel_size` after creation
- No API endpoint accepts `parcel_size` as a body parameter on update routes
- **Verdict: immutable post-creation. Safe.**

### Rate selection bypass
- The manual label endpoint (`POST /shipping/labels`) no longer accepts `rateId`
- Rate selection is entirely server-side via `selectRate()` in `rateSelection.ts`
- No client-controlled input can influence which rate is picked or override the budget check
- **Verdict: no bypass possible. Safe.**

### Force-purchase mode
- `forcePurchase: true` is set only by the server-side `createShippingLabel` handler
- No client can pass `forcePurchase` — it's an internal options parameter
- Currently forcePurchase doesn't skip any gates that exist (seller_not_verified was already removed). It's a semantic flag for intent + log tagging + `label_auto_generated = false` distinction.

---

## Return Label Dimensions — Before/After

| Size | Field | BEFORE (hardcoded in returnController) | AFTER (PARCEL_SIZES) |
|---|---|---|---|
| small | weight | 1 kg | 0.5 kg |
| medium | length | 45 cm | 40 cm |
| medium | width | 35 cm | 30 cm |
| medium | height | 20 cm | 15 cm |
| medium | weight | 5 kg | 1.8 kg |
| large | length | 130 cm | 119 cm |
| large | weight | 3 kg | 2 kg |
| extra_large | length | 130 cm | 119 cm |
| extra_large | weight | 15 kg | 8 kg |
| oversized | width | 50 cm | 40 cm |
| oversized | height | 50 cm | 40 cm |
| oversized | weight | 25 kg | 15 kg |

Every return label size was over-dimensioned and over-weighted, leading to inflated Shippo quotes. Now unified.

---

## Mobile Changes

### Create Label flow
- `handleCreateLabel` now POSTs directly to `/shipping/labels` with `{ orderId }` only
- Shows `ActivityIndicator` + "Creating Label..." during request
- On success: alert with tracking info + "View Label" / "OK", then refreshes order
- On error: alert with backend error message

### Ship wizard (`app/orders/sold/[id]/ship.tsx`)
- Replaced 1173-line wizard with 17-line redirect back to order detail
- Stale navigation links safely handled — any arrival at this route immediately redirects

### Dead code removed
- `ShippingRate` interface
- `showLabelModal`, `loadingRates`, `shippingRates`, `selectedRate` state variables
- Label modal component (rate selection UI)
- All related styles (rateCard, rateProvider, etc.)

### State machine preserved
- The `isReadyToLabel` / `isActionLoading` / `isAddressRequired` / `isNoRates` state machine from the state-priority fix (`eb0158b`) is fully preserved
- Create Label button only appears in `isReadyToLabel` state
- Stripe verification remains a secondary nudge, never the primary CTA

---

## Edge Cases / Open Questions for Harry

1. **Untracked fallback:** If only untracked rates are returned by Shippo, should we ship untracked or fail? Currently: ship untracked. See rate selection section above.

2. **Over-budget logging:** When Mulligans absorbs the difference (cheapest tracked > buyer paid), this is logged with `[MANUAL-SHIP]` or `[AUTO-SHIP]` tags. Should we also flag these orders in the database for financial reporting? Currently we return `overBudget: true` in the result but don't persist it.

3. **Legacy orders without snapshot:** Pre-fix orders have `orders.parcel_size = null`. They fall back to the listing join. If a seller changes a listing's parcel_size between sale and shipment, legacy orders will use the new size. No backfill was requested — just documenting the residual risk.

4. **Rate-options endpoint cleanup:** `getShippingRates` in shippingController is now orphaned (no mobile screen calls it). Left in place. Safe to remove in a future PR.
