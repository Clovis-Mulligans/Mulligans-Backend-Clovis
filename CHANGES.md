# PRO-IMPORT-I-04: `off_sale` status primitive + "mark sold elsewhere"

Branch: `task/pro-import-i04-off-sale` from `clovis/pro-seller-foundation` at `1fd4973`

## Investigation Findings

### Where listing status values live

| Location | Values | Type |
|---|---|---|
| Prisma schema (`prisma/schema.prisma:96`) | `status String @default("active")` | Plain string — no migration needed |
| Zod create schema (`validation.ts:69`) | `['active', 'draft']` | Not modified (off_sale is not a create-time status) |
| Zod update schema (`validation.ts:92`) | `['active', 'sold', 'reserved', 'removed', 'draft']` | **Added `off_sale`** |

### Status reference sites — fail-closed analysis

Every buyer-facing query filters on `status: 'active'`, meaning `off_sale` is automatically excluded without code changes:

| Site | File:line | Filter | Result |
|---|---|---|---|
| Search/browse | `searchController.ts:356,466,713,722` | `status: 'active'` | Excluded |
| Featured listings | `listingController.ts:58` | `status: 'active'` | Excluded |
| Seller public listings | `listingController.ts:925` | `status: 'active'` | Excluded |
| Cart add validation | `cartValidation.ts:68,134` | `status === 'active'` | Blocked |
| Checkout (Stripe) | `stripeController.ts:137` | `status !== 'active'` → 400 | Blocked |
| Checkout (native) | `nativePaymentController.ts:133` | `status !== 'active'` → 400 | Blocked |
| Cart checkout | `cartCheckoutController.ts:153` | filters non-active | Excluded |
| Cart controller | `cartController.ts:331,581,801` | `status === 'active'` | Blocked |
| Offer creation | `offerController.ts:147` | `status !== 'active'` → blocked | Blocked |
| getListingById | `listingController.ts:833,839` | `deleted` → 404; `draft` → 404 to non-owners | **Added `off_sale` → 404 to non-owners** |

### Side-effect patterns reused

- **Offer expiry:** `expireOffersForSoldItem(listingId)` at `src/jobs/offerJobs.ts:387` — expires all offers with status in `['PENDING', 'ACCEPTED', 'COUNTERED', 'COUNTER_ACCEPTED']`, batch-deletes associated offer-linked cart items, sends notifications to affected buyers.
- **Cart cleanup:** `prisma.cart_items.deleteMany({ where: { listing_id } })` — removes all remaining direct cart items (non-offer-linked). Called after `expireOffersForSoldItem` to catch both.
- **Active order guard:** `ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered']` at `listingController.ts:1137` — reused in `markOffSale`.
- **Stripe payout gate:** `sellerCanReceivePayout()` at `escrowService.ts:151` — `!!stripe_connect_id && stripe_connect_status === 'active'`. Same logic inlined in `relistListing` (function is private to escrowService, documented for future extraction).

### `reserved` status decision

`reserved` exists only in the Zod update enum — no code path ever sets it. The active-order guard independently blocks listings with active orders. Decision: allow `reserved` → `off_sale` transition (harmless given guard), but it will never fire in practice. Documented, no risk.

## Implementation

### Files changed

| File | Change |
|---|---|
| `src/middleware/validation.ts` | Added `'off_sale'` to update schema Zod enum |
| `src/controllers/listingController.ts` | Added `import { expireOffersForSoldItem }`, added `off_sale` visibility guard in `getListingById`, added `markOffSale` and `relistListing` static methods |
| `src/routes/listingRoutes.ts` | Added `PUT /:id/off-sale` and `PUT /:id/relist` routes (before generic `PUT /:id`) |
| `src/__tests__/unit/offSale.test.ts` | 24 tests across 3 describe blocks |

### Status transition table

| From | To | Endpoint | Guard | Side-effects |
|---|---|---|---|---|
| `active` | `off_sale` | `PUT /:id/off-sale` | Owner + no active orders | Expire offers, remove all cart items |
| `reserved` | `off_sale` | `PUT /:id/off-sale` | Owner + no active orders | Expire offers, remove all cart items |
| `off_sale` | `active` | `PUT /:id/relist` | Owner + Stripe Connect active | None |
| `draft` | `off_sale` | — | 409 | — |
| `sold` | `off_sale` | — | 409 | — |
| `deleted` | `off_sale` | — | 404 | — |
| `removed` | `off_sale` | — | 409 | — |
| `active` | `off_sale` (with active order) | — | 409 | — |
| `off_sale` | `active` (no Stripe) | — | 409 | — |

### Endpoint spec

**`PUT /api/listings/:id/off-sale`** (auth: owner only)
- 200 + updated listing on success
- 404 if not found, deleted, or not owner
- 409 if wrong status or active order (with descriptive message + `order_status` field)

**`PUT /api/listings/:id/relist`** (auth: owner only)
- 200 + updated listing on success
- 404 if not found, deleted, or not owner
- 409 if not `off_sale` or Stripe not active

## Tests — teeth-checks

| # | Test | What it proves | Teeth-check |
|---|---|---|---|
| 1 | active → off_sale happy path | Status changes, offers expired, cart cleared | Remove `expireOffersForSoldItem` call → test fails (offers not expired) |
| 2 | reserved → off_sale | Transition allowed from reserved | Change guard to exclude reserved → test fails |
| 3 | 409 with active order | Active order blocks off-sale | Remove order check → test fails (200 instead of 409) |
| 4 | non-owner → 404 | Ownership enforced | Remove seller_id check → test fails |
| 5 | no auth → 401 | Auth middleware works | Remove `authenticateToken` from route → test fails |
| 6-8 | draft/sold/removed → 409 | Invalid transitions blocked | Widen status guard → tests fail |
| 9 | deleted → 404 | Deleted listings invisible | Remove deleted check → test fails |
| 10 | nonexistent → 404 | Missing listing handled | N/A (framework) |
| 11 | off_sale → active (Stripe active) | Relist happy path | Remove status update → test fails |
| 12 | 409 when Stripe not active | Stripe gate enforced | Remove Stripe check → test fails (200 instead of 409) |
| 13 | 409 when Stripe pending | Pending != active | Relax check to truthy → test fails |
| 14-17 | active/sold/draft/removed → relist 409 | Only off_sale can relist | Widen status guard → tests fail |
| 18 | non-owner relist → 404 | Ownership enforced | Remove seller_id check → test fails |
| 19 | no auth relist → 401 | Auth middleware works | Remove `authenticateToken` → test fails |
| 20 | deleted relist → 404 | Deleted invisible | Remove deleted check → test fails |
| 21 | owner sees own off_sale | Visibility correct for owner | Remove off_sale from visibility guard → always 404 |
| 22 | non-owner → 404 for off_sale | Hidden from non-owners | Remove off_sale from guard → non-owner sees it |
| 23 | anonymous → 404 for off_sale | Hidden from anonymous | Same as above |
| 24 | search filters status=active | Fail-closed for search | N/A (existing behaviour, verified) |

## Deploy notes

1. No database migration required — `status` is a plain String field in Prisma
2. No `npx prisma generate` needed — no schema.prisma changes
3. Backend deploy: standard `npm run build` + PM2 restart
4. Backwards-compatible: existing clients won't encounter `off_sale` unless they use the new endpoints
