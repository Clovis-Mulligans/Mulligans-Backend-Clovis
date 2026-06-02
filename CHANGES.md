# CHANGES — Seller Sending/Return Address (Backend)

**Branch:** `task/seller-sending-address`  
**Base:** `main` (`347ffc9`)  
**Repo:** `Mulligans-Backend` → `Clovis-Mulligans/Mulligans-Backend-Clovis`

## Summary

Moves the seller sender address from a live Stripe lookup to an authoritative `users.sending_address` JSON field. One shared function replaces two divergent Stripe-calling implementations. The client `senderAddress` override is removed. Both `getEstimatedCity` duplicates are removed.

## Migration

`prisma/migrations/20260602000000_add_seller_sending_address/migration.sql`  
Adds `sending_address JSONB` (nullable) to `users` table.  
**Must be applied before/with code deploy.** Additive-nullable — rollback-safe.

## Deploy ordering

1. Run the Prisma migration (`npx prisma migrate deploy`)
2. Deploy the updated backend code
3. Sellers will need to set their sending address via the new PUT endpoint (frontend brief follows)
4. Until a seller sets their address, auto-ship skips gracefully and manual label generation returns `{ error: 'sending_address_required', addressRequired: true }`

## Design decisions

**JSON field shape:** `{ name, line1, line2, city, postal_code, country }` — matches `orders.shipping_address` for consistency. Stored as `Json?` (Prisma) / `JSONB` (Postgres) for flexibility. Chose JSON over discrete columns because (a) the address is always read/written as a unit, (b) matches existing patterns, (c) simpler migration.

**getEstimatedCity removed:** Both copies (shippingController + autoShippingService) deleted. With the DB field now authoritative and containing a real city, postcode→city estimation is dead code. See `questions.md` for full rationale.

**No Stripe fallback:** Per Harry's locked decision — DB is authoritative, Stripe is no longer consulted for shipping address once this field exists.

**Consistent error shape:** All address-required responses use `{ error: 'sending_address_required', addressRequired: true, reason: 'no_sending_address' }` across both outbound and return paths.

---

## Per-file changelog

### NEW: `src/lib/sellerAddress.ts`
- `SendingAddress` interface — typed shape for the JSON field
- `SellerAddressResult` type — `{ address, isReal, failureReason }` matching the old `SellerAddress` pattern for minimal call-site change
- `getSellerSendingAddress(sellerId)` — reads `users.sending_address` from DB, validates required fields present, returns typed result
- `validateSendingAddress(data)` — input validation for the PUT endpoint (presence, type, max-length checks)

### NEW: `prisma/migrations/20260602000000_add_seller_sending_address/migration.sql`
- `ALTER TABLE "users" ADD COLUMN "sending_address" JSONB;`

### `prisma/schema.prisma`
- Added `sending_address Json?` to `users` model

### `src/controllers/shippingController.ts`
- **[Site 1] Removed:** `getSellerAddress()` function (93-154), `SellerAddress` type (76-87), `getEstimatedCity()` (29-70), Stripe import + initialisation (12-17)
- **[Site 2] Rewired:** `getShippingRates()` origin address logic — now calls `getSellerSendingAddress(order.seller_id)`. Removed `senderAddress` client override from request destructuring. Returns `{ error: 'sending_address_required', addressRequired: true }` when missing.
- **[Site 2] Updated:** Shippo `addressFrom` now uses `sellerAddr.address.*` fields including `line2`.
- Verified: `getShippingRates` trace: auth → find order → check ownership → check buyer address → `getSellerSendingAddress()` → if `!isReal` return 400 → build Shippo shipment → return rates.
- Verified: `createShippingLabel` trace: auth → find order → check ownership → check status → check no duplicate → purchase label via Shippo transaction → update order. (No address re-check — trusts the rate's shipment from the prior step, unchanged from before.)

### `src/services/autoShippingService.ts`
- **[Site 3] Rewired:** Gate 2 — `getSellerAddress().isReal` → `getSellerSendingAddress(order.seller_id).isReal`. Returns `skippedReason: 'no_address'` on miss (graceful skip, order stays `to_ship`).
- **[Site 4] Rewired:** `addressFrom` in Shippo shipment — uses `sellerAddr.address.*` fields.
- **[Site 10] Removed:** `getEstimatedCity()` duplicate (61-106).
- **Updated import:** `getSellerAddress, SellerAddress` from shippingController → `getSellerSendingAddress` from lib/sellerAddress.
- Verified: Auto-ship trace: Gate 1 (Stripe Connect status) → Gate 2 (`getSellerSendingAddress`) → if `!isReal` skip gracefully → build Shippo shipment → filter tracked rates → select best rate → purchase label → update order with `label_auto_generated: true`.

### `src/controllers/returnController.ts`
- **[Site 5] Removed:** `getSellerAddressFromStripe()` function (43-82) — entire function and comment block.
- **[Site 6] Rewired:** `checkSellerStripeStatus()` — now calls `getSellerSendingAddress(order.seller_id)`. Removed Stripe Connect checks (`stripe_connect_id`, `stripe_connect_status`). Returns `hasAddress: sellerAddr.isReal`. Renamed comment to "CHECK SELLER ADDRESS STATUS".
- **[Site 7] Rewired:** `createReturnRequest()` — `awaiting_address` gate now uses `getSellerSendingAddress()` instead of checking Stripe Connect + `getSellerAddressFromStripe()`.
- **[Site 8] Rewired:** `getReturnShippingRates()` — seller address from `getSellerSendingAddress()`. Returns `{ error: 'sending_address_required', addressRequired: true }` when missing. Updated `addressTo` in Shippo shipment to use `sellerAddress.address.*`.
- **[Site 9] Rewired:** `getReturnRequest()` — `sellerHasAddress` now from `getSellerSendingAddress()` instead of `getSellerAddressFromStripe()`.
- Verified: Return rate trace: auth → find return → check status → `getSellerSendingAddress()` → if `!isReal` return 400 → get buyer address from order → build Shippo shipment → return rates.

### `src/routes/authRoutes.ts`
- **Updated:** `GET /profile` now includes `sending_address` in the select/response.
- **New:** `GET /sending-address` — returns the authenticated user's sending address.
- **New:** `PUT /sending-address` — validates + stores the authenticated user's sending address. Input sanitised (trimmed, length-capped, uppercase postal_code + country).

---

## Blast radius verification matrix

| # | Site | File | Status | How verified |
|---|------|------|--------|-------------|
| 1 | `getSellerAddress()` definition | shippingController.ts | Removed | grep confirms 0 references to old function |
| 2 | `getShippingRates()` origin logic | shippingController.ts | Rewired | Reads `getSellerSendingAddress()`, senderAddress override removed |
| 3 | Auto-ship Gate 2 | autoShippingService.ts | Rewired | Uses `getSellerSendingAddress().isReal`, graceful skip on false |
| 4 | Auto-ship addressFrom | autoShippingService.ts | Rewired | Uses `sellerAddr.address.*` fields |
| 5 | `getSellerAddressFromStripe()` definition | returnController.ts | Removed | grep confirms 0 references to old function |
| 6 | `checkSellerStripeStatus()` | returnController.ts | Rewired | Uses `getSellerSendingAddress()`, no Stripe call |
| 7 | `createReturnRequest()` gate | returnController.ts | Rewired | awaiting_address based on `!sellerAddr.isReal` |
| 8 | `getReturnShippingRates()` addressTo | returnController.ts | Rewired | Uses `sellerAddress.address.*` fields |
| 9 | `getReturnRequest()` address check | returnController.ts | Rewired | Uses `getSellerSendingAddress().isReal` |
| 10 | `getEstimatedCity()` (autoShipping) | autoShippingService.ts | Removed | grep confirms 0 references |
| 11 | `getEstimatedCity()` (shipping) | shippingController.ts | Removed | grep confirms 0 references |
| 12 | Schema | schema.prisma | Added | `sending_address Json?` on users model |
