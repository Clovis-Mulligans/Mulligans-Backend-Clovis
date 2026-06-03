# CHANGES — Ship-Status Integrity: remove manual "mark as shipped" bypass

**Branch:** `task/ship-status-integrity`
**Base:** `upstream/main` (`bb04308`)

## Investigation Findings

### 1. Tracking webhook status transitions (confirmed)
`shippingController.ts` `handleShippoWebhook`:
- `PRE_TRANSIT` → keeps `to_ship` (label registered, no carrier scan), clears `auto_cancel_at`
- `TRANSIT` → sets `in_transit` + `shipped_at` (real carrier scan)
- `DELIVERED` → sets `delivered` + `delivered_at` + `escrow_release_at`
- `RETURNED` → sets `returned`
- `FAILURE` → sets `delivery_failed`
- ALL events clear `auto_cancel_at` and update ALL orders sharing the same tracking number

### 2. Manual endpoints identified (both self-attestation)
| Endpoint | File | Requires label? | What it does |
|---|---|---|---|
| `POST /api/shipping/mark-shipped` | shippingController.ts | Yes (`label_url`) | Sets `in_transit` + `shipped_at` on seller's say-so |
| `PUT /api/orders/:id/ship` | orderController.ts | No | Takes seller-provided tracking_number + carrier, sets `in_transit` + `shipped_at` |

Both are self-attestation — neither verifies an actual carrier scan. The orderController version also accepts a seller-provided tracking number (not verified against Shippo). Both removed.

### 3. Auto-cancel deadline (5 weekdays) — no change needed
`autoCancelUnshippedOrders` keys off `auto_cancel_at <= now` where `status = 'to_ship'`. The Shippo webhook clears `auto_cancel_at` on ANY tracking event, including `PRE_TRANSIT` (which fires when a label is created/registered). This means:
- Once a label exists → PRE_TRANSIT fires → `auto_cancel_at` cleared → no auto-cancel risk
- A seller who creates a label but is slow to drop off won't be auto-cancelled
- 5 weekdays is sufficient for the label-creation-to-carrier-scan gap

**No deadline change needed.** See questions.md for a separate concern about "label created but never dropped off".

## Changes

### Removed: `POST /api/shipping/mark-shipped`
- **Controller:** `shippingController.markAsShipped` removed (was lines 630-759)
- **Route:** `shippingRoutes.ts` line 77 removed
- **Export:** Removed from shippingController default export

### Removed: `PUT /api/orders/:id/ship`
- **Controller:** `orderController.markAsShipped` removed (was lines 580-710)
- **Route:** `orderRoutes.ts` line 30 removed
- **Import cleanup:** `sendShippingNotification` removed from orderController imports (was only used by markAsShipped)

### Preserved (not touched)
- `POST /api/returns/mark-shipped` (returnController) — buyer's return flow, different purpose
- Shippo webhook handler — now the **sole setter** of outbound `in_transit`/shipped status
- `autoCancelUnshippedOrders` — no deadline change

## Files changed

| File | Change |
|---|---|
| `src/controllers/shippingController.ts` | Removed `markAsShipped` function + export |
| `src/routes/shippingRoutes.ts` | Removed `mark-shipped` route + import |
| `src/controllers/orderController.ts` | Removed `markAsShipped` method + unused import |
| `src/routes/orderRoutes.ts` | Removed `/:id/ship` route |

## Remaining callers (grep confirmation)
After removal, only `POST /api/returns/mark-shipped` remains (return flow, out of scope). No backend code references the removed endpoints.
