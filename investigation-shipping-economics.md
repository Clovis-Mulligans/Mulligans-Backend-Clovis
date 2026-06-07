# Investigation: Shipping Economics & Parcel Size

**Date:** 7 June 2026
**Investigator:** Clovis
**Base branch (backend):** `origin/feature/push-deep-linking-2026-05` (SHA `347ffc9`)
**Deployed code (production):** `origin/main` — includes commit `b614afd` (sending address migration)
**Mobile base:** `origin/feature/shipping-safety-mobile-2026-05` (SHA `5378feb`)

> **Note on branch state:** The investigation base branch (`feature/push-deep-linking-2026-05`) does NOT include the `sending_address` DB migration (`b614afd`), which is already deployed to production on `main`. Where findings differ between branches, both are documented. The implementation brief should target main, not the investigation base branch.

---

## Area 1 — Parcel size at display time

### Files examined

- `app/orders/sold/[id]/ship.tsx` (mobile, 1173 lines)
- `src/controllers/shippingController.ts:293` (backend, rates endpoint)

### Findings

**The mobile ship screen reads `parcel_size` from the listing, not the order.**

`ship.tsx:87` initialises `selectedParcelSize` to `'medium'`:

```typescript
const [selectedParcelSize, setSelectedParcelSize] = useState<ParcelSizeKey>('medium');
```

`ship.tsx:161-163` then overrides it from the listing join:

```typescript
if (orderData.listing?.parcel_size) {
  setSelectedParcelSize(orderData.listing.parcel_size);
}
```

The order response includes `listing` via a Prisma join (`include: { listings: ... }`). Since orders do NOT have a `parcel_size` column, this is the **live listing value** — subject to seller edits after the order was placed.

**When does the seller see "Medium" for a "Small" item?** Two scenarios:

1. **Listing join returns null** — if the listing was deleted, soft-deleted, or the relation fails, `orderData.listing?.parcel_size` is falsy and `selectedParcelSize` stays at the default `'medium'`. This is the `|| 'medium'` pattern from the previous investigation.

2. **Seller edits the listing** — if the seller changes `parcel_size` on their listing from `small` to `medium` after the order was placed, the ship screen reflects the current listing value, not the value at order time.

**Backend confirms the same pattern.** `shippingController.ts:293`:
```typescript
const parcelSize = order.listings?.parcel_size || 'medium';
```
This is a live join — same vulnerability.

**For Haydn's specific bug** (listed as small, displayed as medium): the most likely cause is scenario 1 — the listing join returned a falsy `parcel_size`, triggering the `|| 'medium'` fallback. Scenario 2 is possible if Haydn edited the listing's parcel size between order creation and label creation.

### Open questions

- Did Haydn edit the listing's `parcel_size` between order and label attempt? A DB query on the listing's `updated_at` vs order's `created_at` would confirm.
- Is `listings.parcel_size` nullable in the schema? If yes, existing listings created before `parcel_size` was added would always fall back to `medium`.

### Risks

- **Active money-leak vector.** Seller edits listing parcel size after purchase → label generated with wrong dimensions → platform eats the cost difference or buyer gets worse service than paid for.
- **Silent downgrade.** Any `null`/undefined `parcel_size` defaults to medium, regardless of what the buyer paid.

---

## Area 2 — Rate options screen + endpoint

### Files examined

- `app/orders/sold/[id]/ship.tsx` (mobile, shipping wizard)
- `src/controllers/shippingController.ts:253-470` (backend, `getShippingRates`)
- `src/controllers/shippingController.ts:478-650` (backend, `createShippingLabel`)

### Findings

**Rate-quoting endpoint:** `POST /api/shipping/rates`

- **Request shape:** `{ orderId: string, senderAddress?: { street1, city, postcode } }`
- **Response shape:** `{ success, data: { shipmentId, rates: ShippingRate[], parcelSize, parcelDetails } }`
- Each rate: `{ id, carrier, service, price, currency, estimatedDays, durationTerms }`

**Label-purchase endpoint:** `POST /api/shipping/labels`

- **Request shape:** `{ orderId: string, rateId: string, senderAddress?: {...} }`
- The `rateId` is a Shippo `objectId` from the rates response — the seller picks a specific rate and sends it back.
- **Response shape:** `{ success, data: { trackingNumber, carrier, labelUrl, qrCodeUrl? } }`

**Mobile flow (ship.tsx):**

1. Step 1 (`renderStep1`, line 330): Shows item, address, and parcel size. Seller taps "Get Shipping Options" → calls `handleGetRates` (line 183).
2. Step 2 (`renderStep2`, line 409): Displays ALL tracked rates as selectable cards. Seller picks one. **This is Bug 2 — the seller sees and chooses the carrier rate.**
3. Step 3 (`renderStep3`, line 493): Review screen with selected rate.
4. Step 4: Seller confirms → `handlePurchaseLabel` (line 223) sends `{ orderId, rateId: selectedRate.id }` to `POST /shipping/labels`.

**The rate_id flows directly from Shippo's response through the mobile UI back to the backend.** The backend does NOT re-quote — it trusts the rate_id and purchases it directly via `shippo.transactions.create({ rate: rateId })` at `shippingController.ts:553`.

### Open questions

None — the flow is fully traced.

### Risks

- **Seller picks expensive rate → platform loss.** Buyer paid £3.50 (based on listing's parcel size), seller picks £5.60 rate → Mulligans loses £2.10. No server-side ceiling check on the manual path.
- **Seller picks cheap rate → worse service.** Buyer expected a certain service level. Seller picks cheapest → saves money but buyer gets worse delivery.
- **Rate staleness.** Shippo rates expire (typically 1-24 hours). If seller takes a long time between Step 2 and Step 4, the `rateId` may be invalid. The backend would get a Shippo error, but the UX doesn't handle this gracefully.

---

## Area 3 — Auto-label vs manual label divergence

### Files examined

- `src/services/autoShippingService.ts` (478 lines — auto-label)
- `src/controllers/shippingController.ts:253-470` (manual rates)
- `src/controllers/shippingController.ts:478-650` (manual purchase)

### Findings

**Auto-label flow (`autoShippingService.ts:129-361`):**

1. Load order + listing + seller (line 134)
2. Duplicate check — skip if label already exists (line 151)
3. **Gate 1 (base branch):** Seller must be Stripe-verified (`stripe_connect_status === 'active'`) — line 166
   **Gate 1 (main):** Seller must have a `sending_address` in DB — Stripe NOT required to ship
4. **Gate 2 (base branch):** Seller must have a real address from Stripe (`getSellerAddress`) — line 172
   **Gate 2 (main):** Same check but via `getSellerSendingAddress` (DB-backed)
5. Get parcel config from `PARCEL_SIZES` (line 179)
6. Create Shippo shipment → get rates (line 192)
7. Filter to tracked rates via `filterTrackedRates` (line 229)
8. **Gate 3:** At least one tracked rate (line 232)
9. **Cost ceiling:** Cheapest tracked rate must be ≤ buyer's `shipping_cost` (line 245)
10. **Rate selection:** `selectBestRate` — cheapest tracked, with preferred-carrier bonus within 20% (line 254)
11. Purchase label via Shippo transaction (line 259)
12. Update order + related cart orders (lines 301-343)

**Manual label flow (`shippingController.ts:253-650`):**

1. Load order + listing + seller (line 265)
2. Authorization check — user must be seller (line 285)
3. Get parcel config from `PARCEL_SIZES` (line 293)
4. Get seller address — senderAddress override OR Stripe Connect (lines 314-332)
5. Create Shippo shipment → get ALL tracked rates (lines 339-445)
6. **Return ALL rates to client** — no cost ceiling, no selection (line 447)
7. Seller picks a rate on mobile (see Area 2)
8. Seller submits `rateId` to `POST /shipping/labels` (line 478)
9. Backend purchases that exact rate — NO cost ceiling check (line 553)
10. Update order + related cart orders (lines 602-643)

### Shared code

| Component | Auto-label | Manual | Shared? |
|---|---|---|---|
| `PARCEL_SIZES` | Imported from shippingController | Defined in shippingController | Yes — single source |
| Rate filtering (tracked keywords) | `filterTrackedRates` (dedicated function) | Inline filter (lines 386-429) | **No — duplicated and slightly divergent keyword lists** |
| Rate selection | `selectBestRate` (cheapest + preferred carrier) | Seller picks manually | N/A — different by design |
| Address sourcing | `getSellerAddress` (base) / `getSellerSendingAddress` (main) | `getSellerAddress` + senderAddress override (base) / `getSellerSendingAddress` (main) | Partially — manual has override path |
| Cost ceiling | ≤ `order.shipping_cost` | **None** | **Divergent — manual has no ceiling** |
| Label purchase | `shippo.transactions.create({ rate })` | Same | Yes |
| Order update | Full update including `label_auto_generated: true` | Same minus `label_auto_generated` | Mostly |

### Divergence in tracked-rate filtering

Auto-label `filterTrackedRates` (line 425) and manual inline filter (line 386) use the same keyword lists but are **separate code**. The auto-label version is a clean extracted function; the manual version is inline. They produce the same results today, but maintenance drift is likely.

### Refactor estimate

To make manual "Create Label" call the same logic as auto:

1. Extract the rate-selection + cost-ceiling logic from `autoShippingService.ts` into a shared function
2. Replace the manual rates endpoint to either: (a) not return rates to the client at all (just auto-purchase), or (b) return the single selected rate for confirmation
3. Remove `rateId` from the label-purchase endpoint request
4. Remove the rate-selection UI from ship.tsx (Steps 2-3)

**Effort estimate: Medium.** ~100-150 lines of backend changes, ~200 lines removed from ship.tsx. The tricky part is the multi-item cart edge case where different items might have different parcel sizes — currently, the manual flow handles one order at a time, while auto handles groups.

---

## Area 4 — Ship_from / sending_address audit

### Files examined

- `src/controllers/shippingController.ts:93-154` — `getSellerAddress` (base branch, Stripe-based)
- `src/lib/sellerAddress.ts` — `getSellerSendingAddress` (main branch, DB-based)
- `src/services/autoShippingService.ts:192-226` — auto-label Shippo call
- `src/controllers/shippingController.ts:339-374` — manual rates Shippo call
- `src/controllers/returnController.ts:43-81` — `getSellerAddressFromStripe` (base branch)
- `src/controllers/returnController.ts:418-446` — return label Shippo call

### Findings — base branch (`feature/push-deep-linking-2026-05`)

**ALL label paths use Stripe Connect as address source. `users.sending_address` does not exist on this branch.**

| Path | Function | Address source | File:line |
|---|---|---|---|
| Auto-label (outbound) | `getSellerAddress` | Stripe Connect `individual.address` | `autoShippingService.ts:172` → `shippingController.ts:93` |
| Manual rates (outbound) | `getSellerAddress` | Stripe Connect OR client `senderAddress` override | `shippingController.ts:314-332` |
| Manual label (outbound) | No address re-check | Uses rate's embedded address from quoting step | `shippingController.ts:553` |
| Return rates | `getSellerAddressFromStripe` | Stripe Connect (separate function, same source) | `returnController.ts:386` → `returnController.ts:43` |
| Return label purchase | (Not audited — same pattern expected) | Stripe Connect | — |

### Findings — main branch (deployed)

**ALL label paths now use `getSellerSendingAddress` (DB-backed `users.sending_address`).**

| Path | File:line (main) | Address source |
|---|---|---|
| Auto-label (outbound) | `autoShippingService.ts:116` | `users.sending_address` via `getSellerSendingAddress` |
| Manual rates (outbound) | `shippingController.ts:177` | `users.sending_address` — client override REMOVED |
| Return rates | `returnController.ts:310` | `users.sending_address` |
| Return label purchase | `returnController.ts:1239` | `users.sending_address` |

**Conclusion:** On production (main), `users.sending_address` IS correctly wired as `address_from` for all four label paths. The migration `b614afd` addressed this comprehensively.

### Return label address direction

For return labels (buyer → seller), the Shippo call at `returnController.ts:418-446` correctly sets:
- `addressFrom` = buyer's original shipping address (where the item is now)
- `addressTo` = seller's address (where the return goes back to)

This is correct — the return label ships FROM buyer TO seller.

### Open questions

- The `senderAddress` client override was removed on main. Was it ever used in production? If a seller's Stripe address was wrong, this was their escape hatch. With the DB-backed address, the escape hatch is the Shipping Info screen — which is better.

### Risks

- None on the deployed codebase. The sending_address migration solved this comprehensively.
- **Risk if implementation brief targets the wrong branch:** If the parcel-size-snapshot fix is built on `feature/push-deep-linking-2026-05` without merging `b614afd`, the address sourcing will regress to Stripe Connect.

---

## Area 5 — Existing rate-selection logic (auto-label)

### Files examined

- `src/services/autoShippingService.ts:376-415` — `selectBestRate`
- `src/services/autoShippingService.ts:425-461` — `filterTrackedRates`

### Findings

**Rate filtering (`filterTrackedRates`, line 425):**

1. Exclude services matching `UNTRACKED_KEYWORDS` (line 44-48): `untracked`, `economy`, `standard letter`, `postable`, `large letter`, `2nd class letter`, `media mail`, `book post`, `printed papers`, `royal mail 24`, `royal mail 48`
2. Include services matching `TRACKED_KEYWORDS` (line 50-54): `tracked`, `signed`, `express`, `next day`, `courier`, `priority`, `parcel`, `guaranteed`, `special delivery`, `recorded`, `parcelforce`, `dpd`, `evri`, `yodel`, `ups`, `fedex`, `dhl`, `hermes`
3. Fallback: include if `estimatedDays` exists AND price ≥ £2.50 (line 444)
4. Sort by price ascending (line 458)

**Rate selection (`selectBestRate`, line 376):**

1. Start with cheapest tracked rate (line 381)
2. If seller has `preferred_carriers` (comma-separated string on user record):
   - Find cheapest preferred-carrier rate within 20% of cheapest overall AND ≤ buyer shipping cost (lines 398-404)
   - If found, use it; otherwise fall back to cheapest (line 414)
3. If no preferred carriers, use cheapest (line 384)

**Cost ceiling (caller, line 245):**

- `buyerShippingCost = parseFloat((order.shipping_cost || 0).toString())`
- If cheapest tracked rate > buyer's shipping cost → auto-label FAILS (line 246)
- Order stays in `to_ship`, seller uses manual wizard

**When Shippo returns zero rates:** The `trackedRates.length === 0` check at line 232 causes auto-label to return `{ skippedReason: 'no_tracked_rate' }`. Order stays in `to_ship`.

### Current rule vs. decided future rule

| Aspect | Current auto-label | Future (decided) |
|---|---|---|
| Selection | Cheapest tracked (+ preferred carrier bonus) | Most expensive within buyer's budget |
| Cost ceiling | Hard fail if cheapest > buyer paid | Soft fail: pick cheapest and absorb loss |
| Manual fallback | On any failure, seller uses wizard with rate choice | Manual triggers same auto-logic, no rate choice |

### Open questions

- `preferred_carriers` on the user record — is this field populated for any seller? If not, the preferred-carrier logic is dead code.

### Risks

- The current cheapest-rate rule is the OPPOSITE of the decided future rule (most expensive within budget). Until the implementation brief lands, auto-label picks the worst service the buyer could get.

---

## Area 6 — Buyer-paid shipping cost lookup

### Files examined

- `prisma/schema.prisma:177` — `orders.shipping_cost Decimal?`
- `prisma/schema.prisma:103` — `listings.shipping_cost Decimal?`
- `src/controllers/cartCheckoutController.ts:744-796` — order creation (cart path)
- `src/controllers/nativePaymentController.ts:247-293` — order creation (Apple Pay path)
- `src/controllers/stripeController.ts:281,766` — order creation (Stripe Checkout path)
- `src/services/autoShippingService.ts:238` — cost ceiling read

### Findings

**Two `shipping_cost` fields exist:**

1. **`listings.shipping_cost`** (schema line 103): The buyer-facing shipping price from `PARCEL_SIZES` (e.g. £3.49 for small, £5.99 for medium). Set when the listing is created, derived from `parcel_size`.

2. **`orders.shipping_cost`** (schema line 177): Snapshotted from `listings.shipping_cost` at order creation time. This is the canonical "what the buyer paid for shipping" field.

**How `orders.shipping_cost` is populated:**

- **Cart checkout** (`cartCheckoutController.ts:744-796`):
  ```
  itemShippingCost = parseFloat((listing.shipping_cost || 0).toString())  // line 744
  orderShipping = isShippingWinner ? Math.ceil(orderQuantity / 5) * itemShippingCost : 0  // line 750
  shipping_cost: orderShipping  // line 796
  ```
  Note: `isShippingWinner` means only the highest-shipping-cost listing per seller carries the shipping charge. Other orders in the same seller group get `shipping_cost: 0`. This is the "pay once for shipping per seller" rule.

- **Native payment** (`nativePaymentController.ts:247,293,1046`): Same pattern — reads `listing.shipping_cost`, snapshots to order.

- **Stripe Checkout** (`stripeController.ts:281,766`): Same pattern — reads from listing, snapshots to order.

**Auto-label reads it correctly** (`autoShippingService.ts:238`):
```typescript
const buyerShippingCost = parseFloat((order.shipping_cost || 0).toString());
```

**Insurance field:** `orders.insured_value` (schema line 197) is a separate field for XCover insurance. It is NOT the shipping cost — it's the item value for insurance purposes. Do not confuse them.

### Multi-item cart shipping

For multi-seller carts, shipping cost is **per seller, per order**. The highest-shipping-cost item per seller carries the full shipping charge; other items from the same seller get `shipping_cost: 0`. This means:

- Auto-label checks `order.shipping_cost` for the specific order being labelled
- If the order is a non-winner item (`shipping_cost: 0`), auto-label fails at line 241: "Order has no shipping cost (free shipping?)"
- The primary order (winner) has the full shipping cost and succeeds

### Open questions

- For multi-item carts with the same seller: only one order gets `shipping_cost > 0`. Auto-label is called per-order, so non-winner orders will fail the cost ceiling. Is this intended? The multi-item cart label sharing logic (lines 317-343) propagates the label from the winner to related orders, so in practice the non-winner orders should already have labels by the time auto-label is called for them — the duplicate check at line 151 would catch this. **This needs verification.**

### Risks

- `orders.shipping_cost` is populated from `listings.shipping_cost` at order creation. Since `listings.shipping_cost` is derived from `parcel_size` at listing time, and sellers CAN edit their listing's `parcel_size` (which also changes `shipping_cost`), the snapshot is correct — it captures the value at order time. **However**, if `listings.shipping_cost` is null for an old listing, `orders.shipping_cost` is also null/0, and auto-label will fail.

---

## Critical findings

### 1. PARCEL_SIZES divergence between outbound and return labels (ACTIVE BUG)

**Severity: HIGH — affects return shipping costs**

`returnController.ts:405-411` defines a hardcoded parcel config that DIFFERS from `PARCEL_SIZES` in `shippingController.ts:159-205`:

| Size | Outbound (PARCEL_SIZES) | Return (hardcoded) | Weight diff | Dimension diff |
|---|---|---|---|---|
| small | 30×20×10, 0.5kg | 30×20×10, **1kg** | +100% | Same |
| medium | 40×30×15, **1.8kg** | **45×35×20**, **5kg** | +178% | Bigger |
| large | **119**×15×15, **2kg** | **130**×15×15, **3kg** | +50% | Longer |
| extra_large | **119×30×20**, **8kg** | **130×40×40**, **15kg** | +88% | Bigger |
| oversized | 140×**40×40**, **15kg** | 140×**50×50**, **25kg** | +67% | Bigger |

Return labels will consistently get HIGHER rates than outbound labels for the same item because the return parcel config is larger and heavier. This is present on both the base branch AND main (verified).

**This is NOT using the shared `PARCEL_SIZES` constant** — it's a hardcoded inline object in the return controller. The implementation brief should import `PARCEL_SIZES` from the shipping controller instead.

### 2. Manual label path has NO cost ceiling (MONEY LEAK)

**Severity: CRITICAL — active money-leak vector**

Auto-label enforces `cheapestRate.price <= buyerShippingCost` (`autoShippingService.ts:245`). The manual label path has NO equivalent check. The seller can pick any rate, including rates far exceeding what the buyer paid. The backend purchases it without validation (`shippingController.ts:553`).

**Example from Haydn's test:** Buyer paid £3.50 for shipping. Seller was offered rates at £2.50, £3.60, and £5.60. If seller picks £5.60, Mulligans loses £2.10 on that order.

### 3. Branch divergence risk for implementation

The base branch (`feature/push-deep-linking-2026-05`) does NOT include the `sending_address` migration (`b614afd` on main). Any implementation targeting the base branch will need to either:
- Merge main first, or
- Build on main directly

Building on the base branch without the migration would regress address sourcing back to Stripe Connect.
