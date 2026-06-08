# Pre-Launch Shipping Fix — Investigation Findings

**Date:** 2026-06-08
**Brief:** clovis-brief-pre-launch-shipping-fix-2026-06-07
**Branch:** task/pre-launch-shipping-display-fix-2026-06-07 (backend)

---

## Investigation 1 — Where does the displayed parcel_size come from?

**Finding: Path A (read-side bug).** The listing's `parcel_size` is correctly stored in the database and correctly queried by the backend, but **dropped from the API response** when formatting the order object.

### Evidence

The `getOrderById` endpoint (orderController.ts) includes `parcel_size` in the Prisma select:

```
src/controllers/orderController.ts:367 — parcel_size: true,
```

But the formatted response object omits it entirely:

```
src/controllers/orderController.ts:484-492 — listing object has title, description, category, subcategory, brand, price, images — NO parcel_size
```

The field is selected from the DB but never placed into the response JSON. The mobile app receives `listing.parcel_size = undefined`.

**Conclusion:** The listing DB row almost certainly has `parcel_size = 'small'` for Haydn's order. This is a read-side omission, not a write-side bug. **No migration needed.** No data correction needed.

---

## Investigation 2 — Trace the display chain

Full chain for parcel size display on the ship wizard screen:

| Step | Location | What happens |
|------|----------|-------------|
| 1 | Mobile: `ship.tsx:loadOrder()` | Calls `GET /orders/${id}` |
| 2 | Backend: `orderController.ts:344` (`getOrderById`) | Queries listings with `parcel_size: true` (line 367) |
| 3 | Backend: `orderController.ts:484-492` | Formats listing object — **omits parcel_size** |
| 4 | Mobile: `ship.tsx:161-162` | Checks `orderData.listing?.parcel_size` → undefined → does NOT call `setSelectedParcelSize` |
| 5 | Mobile: `ship.tsx:87` | State stays at default: `useState<ParcelSizeKey>('medium')` |
| 6 | Mobile: `ship.tsx:378` | Displays `PARCEL_SIZES[selectedParcelSize]?.name || 'Medium'` → shows "Medium" |

---

## Investigation 3 — Rate options endpoint

**Endpoint:** `POST /api/shipping/rates`
**Handler:** `shippingController.ts:getShippingRates` (line 122)

**Request body:** `{ orderId: string }`

**Response shape:**
```json
{
  "success": true,
  "data": {
    "shipmentId": "string (Shippo shipment ID)",
    "rates": [
      {
        "id": "string (Shippo rate object ID)",
        "carrier": "string (normalized carrier name)",
        "service": "string (service level name)",
        "price": "number (parseFloat of Shippo amount)",
        "currency": "string",
        "estimatedDays": "number",
        "durationTerms": "string"
      }
    ],
    "parcelSize": "string (the parcel size key used for this shipment)",
    "parcelDetails": {
      "length": "string", "width": "string",
      "height": "string", "weight": "string"
    }
  }
}
```

**Rate price type:** `rate.price` is a JavaScript number (via `parseFloat(rate.amount)` at shippingController.ts:293).
**Order shipping_cost:** Available at `order.shipping_cost` in the order detail response (orderController.ts:496), also a number.

The `rate.price` and `order.shipping_cost` are both numbers suitable for direct `<=` comparison. No string-vs-number issues for the mobile filter.

---

## Chosen Path

**Path A** — the fix is on the read side. The backend's `getOrderById` formatter now includes `parcel_size` and `shipping_cost` in the listing object.

---

## Lines Changed (Backend)

| File | Line(s) | Change |
|------|---------|--------|
| `src/controllers/orderController.ts` | 491-492 (inserted) | Added `parcel_size: order.listings.parcel_size \|\| null` and `shipping_cost: ...` to formatted listing object |

---

## Security Scan

- **Client-controllable input bypass:** The `parcel_size` field is read from the database (Prisma query), not from request body or query params. No client can manipulate it via this endpoint.
- **Rate filter (mobile-side):** The filter compares `rate.price` (from Shippo API, via backend) against `order.shipping_cost` (from database, via backend). Neither value is client-controlled at the point of comparison. A malicious client could theoretically call `/shipping/rates` directly and see all rates, but they cannot purchase a label via `/shipping/labels` at an over-budget rate — the `createShippingLabel` endpoint delegates to `autoPurchaseLabel` which uses the server-side `selectRate()` (Reading C rule), not client-selected rates.
- **Conclusion:** The mobile-side filter is a UX improvement, not a security boundary. The server-side rate selection in `autoPurchaseLabel` remains the security boundary and is unmodified by this fix.
