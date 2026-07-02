# PRO-IMPORT-I-02b: Publish draft → active (Stripe-gated) + payout-readiness extraction

Branch: `task/pro-import-i02b-publish` from `clovis/pro-seller-foundation` at `42276ba`

## Investigation Findings

### Listing completeness rule-set (mirrors create-listing Zod schema)

The `createListingSchema` (`validation.ts:41-71`) requires these fields at creation time:

| Field | Requirement | Publish check |
|---|---|---|
| `title` | string, 3-200 chars | Required, min 3 |
| `description` | string, 10-5000 chars | Required, min 10 |
| `price` | number, 0.50-50000 | Required, min £0.50 |
| `category` | enum (8 values) | Required, non-null |
| `subcategory` | string, 1-100 chars | Required, non-null |
| `location` | string, 1-200 chars | Required, non-null |
| `parcel_size` | enum (5 values) | Required, non-null |
| `shipping_cost` | number, 0-100 | Required, non-null |
| `quantity` | int, 1-999 (optional, defaults 1) | Required, min 1 |
| `images` | Not in Zod (separate upload) | **Required: ≥1 image** |

**Images note:** Normal creation (`POST /api/listings`) does not require images in the request body — they're uploaded separately via `POST /:id/images`. However, listings created via normal flow always have images attached by the mobile/web UI before going live. The publish endpoint enforces ≥1 image at the API level. Imported drafts (I-02) land with zero images — they stay as drafts until images are attached (I-03 will handle image import).

### Payout-readiness extraction

The Stripe-Connect payout gate was previously:
- **escrowService.ts:151** — private `sellerCanReceivePayout(seller)` (takes a seller object, synchronous)
- **listingController.ts (I-04)** — inline check in `relistListing` (comment: "Same gate as escrowService.sellerCanReceivePayout")

Extracted to: **`src/lib/payoutReadiness.ts`** — `sellerIsPayoutReady(userId)` (async, queries DB, returns `{ready, reason?}`).

- `relistListing` refactored to use the shared util. Behaviour identical — same Stripe fields checked, same 409 message.
- `escrowService.sellerCanReceivePayout` left untouched — it's a private synchronous helper that takes an already-fetched seller object. Different calling convention (sync vs async, object vs userId). Consolidation would change escrow internals with no benefit. Noted for future cleanup.

## Implementation

### Files changed

| File | Change |
|---|---|
| `src/lib/payoutReadiness.ts` | **New** — shared `sellerIsPayoutReady(userId)` util |
| `src/controllers/listingController.ts` | Added `import { sellerIsPayoutReady }`, refactored `relistListing` to use it, added `validateListingCompleteness`, `publishListing`, `publishListingsBulk` |
| `src/routes/listingRoutes.ts` | Added `PUT /publish-bulk` (before `/:id` routes), `PUT /:id/publish` |
| `src/__tests__/unit/publishListing.test.ts` | 21 tests across 3 describe blocks |

### Status transition table

| From | To | Endpoint | Gates | Side-effects |
|---|---|---|---|---|
| `draft` | `active` | `PUT /:id/publish` | Owner + payout-ready + listing complete | None |
| `draft` (bulk) | `active` | `PUT /publish-bulk` | Owner + payout-ready (once) + per-listing completeness | None |
| `active`/`sold`/`off_sale`/`removed` | — | `PUT /:id/publish` | 409 | — |
| `deleted` | — | `PUT /:id/publish` | 404 | — |

### Endpoint spec

**`PUT /api/listings/:id/publish`** (auth: owner only)
- 200 + updated listing on success
- 404 if not found, deleted, or not owner
- 409 if not `draft`, not payout-ready, or listing incomplete (with specific field in error message)

**`PUT /api/listings/publish-bulk`** (auth: owner only)
- 200 + `{ published: string[], skipped: [{id, reason}] }` — always 200 (partial success)
- Payout-readiness checked once per request; if fails, all IDs returned as `skipped` with reason `payout_not_ready`
- Per-listing: `not_found`, `not_draft`, `invalid: <field>` reasons
- 403 if any listing belongs to a different seller
- 400 if `listing_ids` empty or >500
- Cap: 500 listings per batch

### Listing completeness validation

`validateListingCompleteness(listing, imageCount)` checks:
1. `title` present, ≥3 chars
2. `description` present, ≥10 chars
3. `price` ≥ £0.50
4. `category` present
5. `subcategory` present
6. `location` present
7. `parcel_size` present
8. `shipping_cost` present
9. `quantity` ≥ 1
10. `imageCount` ≥ 1

Returns `null` if valid, or a human-readable error string naming the failing field.

## Tests — teeth-checks

| # | Test | What it proves | Teeth-check |
|---|---|---|---|
| 1 | publish happy path: draft → active | Complete draft publishes | Remove status update → test fails |
| 2 | 409 not payout-ready | Stripe gate enforced | Remove payout check → test fails (200) |
| 3 | 409 no images | Image requirement enforced | Remove image check → test fails (200) |
| 4 | 409 quantity 0 | Quantity gate enforced | Remove quantity check → test fails |
| 5 | 409 missing category | Required field enforced | Remove category check → test fails |
| 6 | 409 price below minimum | Price floor enforced | Remove price check → test fails |
| 7-10 | active/sold/off_sale/removed → 409 | Only drafts publishable | Widen status guard → tests fail |
| 11 | non-owner → 404 | Ownership enforced | Remove seller_id check → test fails |
| 12 | no auth → 401 | Auth middleware works | Remove authenticateToken → test fails |
| 13 | deleted → 404 | Deleted invisible | Remove deleted check → test fails |
| 14 | relist still works (payout-ready) | Extraction didn't break relist | N/A (regression) |
| 15 | relist still gates (not payout-ready) | Extraction preserved gate | Break shared util → test fails |
| 16 | bulk: mixed batch | Correct published/skipped split | Remove per-listing validation → wrong split |
| 17 | bulk: payout short-circuit | All skipped when not payout-ready | Remove payout check → test fails |
| 18 | bulk: foreign ids → 403 | Ownership enforced across batch | Remove ownership check → test fails |
| 19 | bulk: empty array → 400 | Input validation | Remove array check → test fails |
| 20 | bulk: no auth → 401 | Auth middleware | Remove authenticateToken → test fails |
| 21 | bulk: all valid → all published | Happy path for batch | Remove updateMany → test fails |

## Deploy notes

1. No database migration — no schema changes
2. No `npx prisma generate` needed
3. Backend deploy: standard `npm run build` + PM2 restart
4. New file: `src/lib/payoutReadiness.ts` — ensure it's included in build output
5. Backwards-compatible: new endpoints only, no changes to existing API surface
