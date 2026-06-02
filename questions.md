# Questions — Seller Sending Address (Backend)

## Grep results proving no shipping-address path still reads from Stripe

All searches run against `src/` (excluding `node_modules`):

**`getSellerAddress` (old outbound function):** 0 results — removed.  
**`getSellerAddressFromStripe` (old return function):** 0 results — removed.  
**`getEstimatedCity` (duplicated postcode→city estimator):** 0 results — both copies removed.  
**`senderAddress` (client override):** 0 results — removed from getShippingRates and createShippingLabel.  
**`stripe.accounts.retrieve`:** 2 results, both in `stripeConnectController.ts` (lines 187, 426) — these are for Stripe Connect onboarding verification, NOT shipping address retrieval. Correct.  
**`getSellerSendingAddress`:** 5 call sites — all correct:
- `shippingController.ts:177` (outbound rates)
- `autoShippingService.ts:122` (auto-ship Gate 2)
- `returnController.ts:69` (seller address check)
- `returnController.ts:146` (createReturnRequest gate)
- `returnController.ts:310` (return shipping rates)
- `returnController.ts:1128` (getReturnRequest display)

## Typecheck

Could not run `tsc --noEmit` — TypeScript is not installed in the clone (no `node_modules`). Harry should run `npm install --legacy-peer-deps && npx tsc --noEmit` on the dev EC2 after fetching the branch. The changes are structurally sound: all old function signatures are replaced with the new shared helper, and the return types are compatible.

## Security scan — new endpoints

**`PUT /api/auth/sending-address`:**
- Auth: `authenticateToken` middleware — only authenticated users can set their own address. The userId is taken from the JWT token, not from request body, so a user cannot set another user's address.
- Input validation: `validateSendingAddress()` checks presence + type of required fields (line1, city, postal_code, country) and enforces max lengths (200/100/20 chars). All string values are trimmed and sliced.
- Injection: The address is stored as a JSON blob via Prisma's parameterised queries — no SQL injection risk. The JSON is sanitised (trimmed, length-capped) before storage.
- No data leakage: The endpoint only returns the sanitised address for the authenticated user.

**`GET /api/auth/sending-address`:**
- Auth: `authenticateToken` — returns only the authenticated user's own address.
- No sensitive data exposed beyond the address itself.

**`GET /api/auth/profile` (updated):**
- Now includes `sending_address` in the response. Same auth gate. Only the user's own profile.

## getEstimatedCity removal decision

**Removed both copies.** Rationale: The postcode→city estimation was only used as a fallback when the Stripe address was incomplete. With the DB field now authoritative and containing a full city, there is no code path that needs to estimate a city from a postcode prefix. If a future feature needs postcode-to-city mapping (e.g., the frontend address entry form), it should live in a shared utility and be imported — not duplicated inline.

## `SellerAddress` type export from shippingController

The old `SellerAddress` type was exported from `shippingController.ts` and imported by `autoShippingService.ts`. Both are now replaced by `SellerAddressResult` from `src/lib/sellerAddress.ts`. The `PARCEL_SIZES` export from shippingController is still imported by autoShippingService (unchanged — it's unrelated to addresses).
