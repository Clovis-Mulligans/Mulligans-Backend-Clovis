# Investigation: Parcel-size drift + sending-address UX
Date: 4 June 2026

---

## TASK 1 — Parcel-size drift

### Schema

- `listings.parcel_size`: **PRESENT** — `String?`, line 102 of `prisma/schema.prisma`
- `orders.parcel_size`: **ABSENT** — the `orders` model (lines 148–219 of `prisma/schema.prisma`) has no `parcel_size` column
- `orders.shipping_cost`: present (line 177), `Decimal?(10,2)` — stores the monetary shipping cost the buyer paid, but **not** the parcel tier that determined it
- `orders.listing_id`: present (line 150), `String?` — nullable FK to `listings`; used for live join

### Order creation paths

All four order-creation calls snapshot `listing_title`, `listing_image`, and `listing_price` onto the order row. **None of them snapshot `parcel_size`.**

| Controller | Line | `parcel_size` copied? | Notes |
|---|---|---|---|
| `cartCheckoutController.ts` | 787–817 | **No** | `prisma.orders.create` — stores `listing_title`, `listing_image`, `listing_price`, `shipping_cost`, but omits `parcel_size` |
| `nativePaymentController.ts` (single) | 680–709 | **No** | Same pattern |
| `nativePaymentController.ts` (cart) | 1038–1066 | **No** | Same pattern |
| `stripeController.ts` | 759–786 | **No** | Same pattern |

### Shipping options read path

**Endpoint:** `POST /api/shipping/rates` — `getShippingRates()` in `shippingController.ts`

**Trace:**
1. Line 265–275: fetches the order with `include: { listings: { include: { users: true } } }` — a **live join** to the current `listings` row
2. Line 293: `const parcelSize = order.listings?.parcel_size || 'medium';`
3. Line 294: maps `parcelSize` to dimensions via `PARCEL_SIZES` lookup

**The parcel size displayed to the seller comes from the listing's current state, not from the order.** If the listing's `parcel_size` changes between purchase and label creation, the seller sees the new value.

**Same pattern in two other read paths:**
- `autoShippingService.ts:179` — `order.listings?.parcel_size || 'medium'` (auto-label generation)
- `returnController.ts:403` — `order.listings?.parcel_size || 'medium'` (return label creation)

All three fall back to `'medium'` if `parcel_size` is null or the listing relation is missing.

### Mutation paths

| File | Line | What it does | Risk |
|---|---|---|---|
| `listingController.ts` | 229 | Initial listing creation — sets `parcel_size` from request body | None (pre-order) |
| `listingController.ts` | 1026 | **Listing update** — `if (parcel_size !== undefined) updateData.parcel_size = parcel_size \|\| null;` | **HIGH**: seller can change `parcel_size` on their listing at any time via `PUT /api/listings/:id`, including after orders exist in `to_ship` status. No guard checks for outstanding orders. |
| `listingController.ts` | 1027 | Listing update — `shipping_cost` also updatable | Lower risk: `shipping_cost` IS snapshotted on the order at creation, so the buyer-charged amount is safe. But parcel dimensions are not. |

No other code path writes to `parcel_size` — no background jobs, no admin endpoints, no automated processes.

### Security notes

1. **Post-order parcel downgrade attack:** A malicious seller could list at Large (higher buyer shipping charge), wait for purchase, then edit the listing to Small and buy a cheaper label. The buyer paid for Large shipping but the label is purchased with Small dimensions. The shipping margin difference is pocketed as extra profit. No authorization check prevents this because `PUT /api/listings/:id` only verifies the user owns the listing, not whether outstanding orders depend on the current `parcel_size`.

2. **Null fallback to medium:** If `parcel_size` is set to `null` (e.g., via `parcel_size || null` in the update path when an empty string is sent), or if the listing is soft-deleted (`listing_id` set to null on the order), every shipping call silently falls back to `'medium'` regardless of what the buyer paid for. This is a silent data integrity failure.

3. **`shipping_cost` is safe:** The monetary amount charged to the buyer is snapshotted at order creation (`orders.shipping_cost`), so the financial charge to the buyer cannot be retroactively changed. The vulnerability is in the dimensional data used to purchase the actual shipping label.

### Root cause hypothesis

The `orders` table has no `parcel_size` column. All order-creation paths snapshot `listing_title`, `listing_image`, and `listing_price` but **omit `parcel_size`**. At label-purchase time, `shippingController.ts:293` reads `parcel_size` via a live join to the current `listings` row.

**Two specific scenarios could cause the drift Harry observed (Large -> Medium):**

1. **Listing edited after purchase:** The seller (or any code path) updated the listing's `parcel_size` between the buyer's purchase and the seller's "Get shipping options" tap. The live join returns the new value.

2. **Null fallback:** If `parcel_size` was somehow nulled on the listing (e.g., a buggy edit that sent `parcel_size: ""`, which the update path converts to `null` via `parcel_size || null`), the `|| 'medium'` fallback kicks in at `shippingController.ts:293`, silently downgrading any tier to Medium.

**Most likely scenario:** The seller edited the listing (perhaps to relist or adjust for a new buyer) and inadvertently changed or nulled `parcel_size`. The live join then returned a different value than what the original buyer paid for.

### Recommended fix

1. **Add `parcel_size String?` column to the `orders` table** (Prisma migration). This is the same snapshot pattern already used for `listing_title`, `listing_image`, and `listing_price`.

2. **Snapshot at order creation:** In all four `prisma.orders.create` calls (`cartCheckoutController.ts:787`, `nativePaymentController.ts:680`, `nativePaymentController.ts:1038`, `stripeController.ts:759`), add `parcel_size: listing.parcel_size` to the data block.

3. **Read from snapshot at label time:** Change the three read paths to prefer the order snapshot:
   - `shippingController.ts:293` -> `order.parcel_size || order.listings?.parcel_size || 'medium'`
   - `autoShippingService.ts:179` -> same
   - `returnController.ts:403` -> same
   
   The fallback chain (order snapshot -> live listing -> 'medium') provides backwards compatibility for orders created before the migration.

4. **Backfill existing orders:** One-time migration script to copy `listings.parcel_size` into `orders.parcel_size` for all existing orders that have a valid `listing_id`.

5. **Defence in depth (optional):** Add a guard in the listing update path (`listingController.ts:1026`) that prevents `parcel_size` changes when orders in `to_ship` status exist against that listing. This prevents the security concern in the mutation paths section.

---

## TASK 2 — Sending-address branch review

### Branch status

- **Exists:** Yes — local, `origin`, and `upstream` on `Mulligans-Mobile-Clovis`
- **Base:** Diverged from `main`; includes prior feature commits (android fixes, disputes, Evri QR, Stripe onboarding)
- **Sending-address-specific commits (3):**
  1. `a3cb19c` — `feat: seller sending address UI (v2 — correct base branch)` (2 June 2026)
  2. `b001ab6` — `chore: remove dead AddressModal and senderAddress remnants` (2 June 2026)
  3. `b03245e` — `feat: swap postcode lookup from getAddress.io to postcodes.io (free gov API)` (2 June 2026)

### Files modified by `task/mobile-sending-address`

| File | Summary |
|---|---|
| `app/shipping-info.tsx` | Major rewrite: full sending-address form with postcodes.io lookup, save via `PUT /auth/sending-address`, red alert banner when no address set, green "ready" card when set |
| `app/orders/sold/[id].tsx` | State E banner text changed from Stripe-focused to address-focused; CTA now routes to `/shipping-info` instead of Stripe dashboard; `consumeShippingError()` called on focus |
| `app/orders/sold/[id]/ship.tsx` | Removed dead `senderAddress` client overrides; when `response.data.addressRequired === true`, calls `setShippingError('address_required')` and `router.back()` |
| `components/orders/AddressModal.tsx` | **Deleted** (285 lines — dead code from old Stripe-based flow) |
| `lib/shippingState.ts` | **New** (13 lines): in-memory error shuttle (`setShippingError` / `consumeShippingError`) for passing state from `ship.tsx` back to `sold/[id].tsx` |
| `lib/postcodeLookup.ts` | **New** (20 lines): standalone postcodes.io helper — **dead code**, not imported (shipping-info.tsx has its own inline lookup) |

### Detailed changes

**`app/shipping-info.tsx`:**
- `SendingAddress` interface: `name`, `line1`, `line2`, `city`, `postal_code`, `country`
- `loadData()` calls `GET /users/:id` and `GET /auth/sending-address` in parallel
- If address exists: green checkmark card — "Address set — ready to create labels" + Edit link
- If no address: red alert banner — "Add your sending address — it's needed before you can create shipping labels. Buyers also return items here."
- Postcode lookup via postcodes.io: enter postcode, tap "Find", auto-fills city from `admin_district`
- Graceful fallback: if postcodes.io 404s or errors, shows warning + exposes manual fields
- "Enter address manually" link bypasses lookup entirely
- Save calls `PUT /auth/sending-address` + `PUT /users/:id` (postcode_area sync)
- Success alert: "Your sending address has been updated. You can now create shipping labels."

**`app/orders/sold/[id].tsx`:**
- State E banner: was "We couldn't ship from your registered address. Please update your details in Stripe" → now "Set your sending address first — we need it to create your shipping label and for any returns."
- State E CTA: was `Linking.openURL(stripeDashboard)` → now `router.push('/shipping-info')`
- `isStateE` condition: `isPending && !hasLabel && shippingError === 'address_required' && stripeVerified`
- `consumeShippingError()` called on screen focus to pick up error from `ship.tsx`
- Removed `handleAddressSubmit()` and `showAddressModal` state

**`app/orders/sold/[id]/ship.tsx`:**
- Removed `senderStreet1`/`senderCity`/`senderPostcode` URL params and client-side `senderAddress` body parameter
- When `response.data.addressRequired === true`: calls `setShippingError('address_required')`, `router.back()`
- When rates array empty: calls `setShippingError('no_rates')`, `router.back()`
- Also catches `addressRequired` in error response

**`lib/shippingState.ts`:**
- Module-level variable `_pendingError: 'address_required' | 'no_rates' | null`
- `setShippingError()`: sets the pending error
- `consumeShippingError()`: reads and clears (read-once pattern)

### UX coverage checklist

- [x] **No-address detection:** Yes — `ship.tsx` sends `POST /shipping/rates`; if backend returns `{ addressRequired: true }`, it calls `setShippingError('address_required')` and pops back. `sold/[id].tsx` picks this up via `consumeShippingError()` and shows State E banner.
- [x] **Prompt modal with explanation:** Yes (banner, not modal) — State E shows "Set your sending address first — we need it to create your shipping label and for any returns." The `/shipping-info` screen itself also shows a red alert when no address exists.
- [x] **Deep-link button to Settings:** Yes — State E CTA routes to `/shipping-info` (the Settings > Shipping Info screen) where the address form lives.
- [x] **Dead-end fix on "Get shipping options":** Yes — previously, tapping "Get shipping options" with no address silently failed or dead-ended back to sale detail with no explanation. Now `ship.tsx` detects `addressRequired`, shuttles the error, and `sold/[id].tsx` displays the State E banner with the "Set Sending Address" CTA.
- [x] **Address-input UI (postcode lookup + save):** Yes — postcodes.io lookup (free government API, no key needed), manual entry fallback, save via `PUT /auth/sending-address`.

### Gaps and follow-ups

1. **Backend branch not merged:** The backend branch `task/seller-sending-address` adds `GET/PUT /api/auth/sending-address` endpoints and the `users.sending_address Json?` column. This branch has **not** been merged to `feature/pro-store-foundation` or `main`. The mobile branch will fail at runtime until the backend branch is also merged and deployed.

2. **Dead code:** `lib/postcodeLookup.ts` is created but never imported — `shipping-info.tsx` has its own inline postcode lookup. Should be deleted on merge.

3. **No proactive check on sold order load:** The `address_required` detection only triggers **after** the seller taps "Create Label" and the ship wizard tries to fetch rates. If the seller hasn't tapped it yet, there's no upfront banner warning that their address is missing. The seller has to fail once to see the prompt.

4. **No re-check after address save:** After saving the address on `/shipping-info` and going back to the sold order, the seller must tap "Create Label" again. There's no automatic re-attempt or state refresh. (Minor UX friction, not a blocker.)

5. **In-memory error shuttle is fragile:** `lib/shippingState.ts` uses a module-level variable. If React Native hot-reloads or the module is re-evaluated, the pending error is lost. Route params or `AsyncStorage` would be more robust. (Minor concern for production.)

6. **No handling of malformed/rejected addresses:** The new State E only fires on `address_required`. If the seller has a saved address but Shippo rejects it as invalid, a different error is returned that isn't caught by the `addressRequired` check. The old State E partially covered this; the new flow doesn't.

### Recommended next step

**(b) Merge then patch gaps**

The branch is well-structured and correctly solves the core UX problem: detecting no sending address, showing an actionable banner, providing a postcode-lookup form, and saving to the backend. All four UX requirements from Harry's test session are covered.

**However, it cannot be merged in isolation.** Merge order:
1. Merge backend `task/seller-sending-address` into `feature/pro-store-foundation` and deploy
2. Merge mobile `task/mobile-sending-address` into the active mobile branch
3. Post-merge patches:
   - Delete dead `lib/postcodeLookup.ts`
   - Consider proactive address check on sold order load (not just after label attempt)
   - Consider handling Shippo address-rejection errors (distinct from `address_required`)
