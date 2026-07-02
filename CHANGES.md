
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
- Foreign-owned listings treated as `not_found` (skipped, not 403) — consistent with single-endpoint 404 pattern, avoids existence oracle and mid-batch partial-state incoherence
- 400 if `listing_ids` empty or >500
- Cap: 500 listings per batch

### Listing completeness validation

`validateListingCompleteness(listing, imageCount)` checks:
1. `title` present, ≥3 chars
2. `description` present, ≥10 chars
3. `price` ≥ £0.50 (from `createListingSchema` at `validation.ts:45`: `z.number().min(0.50)`)
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
| 18 | bulk: foreign ids skipped as not_found, valid rows publish | No existence oracle, no partial-state halt | Remove ownership→not_found mapping → test fails |
| 19 | bulk: empty array → 400 | Input validation | Remove array check → test fails |
| 20 | bulk: no auth → 401 | Auth middleware | Remove authenticateToken → test fails |
| 21 | bulk: all valid → all published | Happy path for batch | Remove updateMany → test fails |

## Deploy notes

1. No database migration — no schema changes
2. No `npx prisma generate` needed
3. Backend deploy: standard `npm run build` + PM2 restart
4. New file: `src/lib/payoutReadiness.ts` — ensure it's included in build output
5. Backwards-compatible: new endpoints only, no changes to existing API surface

# AUTH-01: Refresh-Token Authentication (Backend)

**Branch:** `auth-01-refresh-tokens`
**Base SHA:** `fd99fe907074704866520b722caca50822cda2d6` (upstream/main, fetched 2026-07-02)
**Mirror status:** mirror `origin/main` was already at upstream HEAD — zero commits behind.

---

## Summary

Introduces short-lived access tokens (1h) plus long-lived revocable refresh tokens (90d) with client-capability gating. Existing clients continue to receive legacy 60-day tokens unchanged. New clients opt in via `X-Client-Refresh: v1` header.

---

## Files touched

```
 package-lock.json                                                 |  87 +++
 package.json                                                      |   2 +
 prisma/migrations/20260702000000_add_refresh_tokens/migration.sql |  22 +
 prisma/schema.prisma                                              |  14 +
 src/__tests__/unit/refreshTokens.test.ts                          | 449 ++++++++++
 src/lib/tokens.ts                                                 |  91 ++
 src/middleware/auth.ts                                             |   7 +-
 src/routes/authRoutes.ts                                          | 103 ++-
 8 files changed
```

---

## What changed

### New: `prisma/schema.prisma` — `refresh_tokens` model
- `id` (UUID PK), `user_id`, `token_hash` (@unique), `expires_at`, `revoked_at`, `replaced_by`, `user_agent`, `created_at`
- Indexes on `user_id` and `expires_at`
- Back-relation `refresh_tokens[]` added to `users` model

### New: `prisma/migrations/20260702000000_add_refresh_tokens/migration.sql`
- Additive CREATE TABLE + indexes + FK to `users` with CASCADE delete
- Migration written manually (no DATABASE_URL in dev — by design)

### New: `src/lib/tokens.ts`
- `hashToken(raw)` — SHA-256 hex digest
- `signAccessToken(user, ttl)` — JWT with `type: 'access'` claim, reuses existing `JWT_SECRET`
- `issueRefreshToken(userId, userAgent)` — 32 random bytes → SHA-256 → DB row, returns raw token once
- `wantsRefresh(req)` — checks `X-Client-Refresh: v1` header (case-insensitive)
- `buildTokenResponse(user, req)` — capability-gated: with header → 1h access + real refresh; without → legacy 60d token

### Modified: `src/routes/authRoutes.ts`
- **Login** (~line 592): replaced inline JWT signing with `buildTokenResponse()` call
- **Verify-email auto-login** (~line 273): same replacement
- **New `POST /refresh`** (~line 727): rate-limited (10/15min), validates input, looks up by token_hash, checks expiry, detects reuse (revokes ALL user tokens), rotates on success
- **New `POST /logout`** (~line 796): hashes token, revokes via updateMany, always returns 200 (idempotent)

### Modified: `src/middleware/auth.ts`
- Missing token → `401 { error, code: 'TOKEN_MISSING' }`
- `TokenExpiredError` → `403 { error, code: 'TOKEN_EXPIRED' }` (recoverable — client will refresh)
- Other JWT errors → `403 { error, code: 'TOKEN_INVALID' }` (terminal — client will log out)
- Banned → `403 { ..., code: 'ACCOUNT_BANNED' }` (unchanged, already present)
- **No HTTP status codes changed on any existing response.**

### Modified: `package.json` / `package-lock.json`
- Added `supertest` + `@types/supertest` as devDependencies (test infrastructure)

---

## Backward-Compatibility Contract — verified

| Scenario | Before | After | Breaking? |
|---|---|---|---|
| Login without `X-Client-Refresh` | 60d token, `refreshToken` = access token | Identical | No |
| Login with `X-Client-Refresh: v1` | N/A (header didn't exist) | 1h access + real refresh + `refreshExpiresAt` | No (additive) |
| Middleware 401 (missing token) | `{ error }` | `{ error, code }` | No (additive field) |
| Middleware 403 (bad/expired) | `{ error }` | `{ error, code }` | No (additive field) |
| Existing 60d tokens in the wild | Valid | Still valid until natural expiry | No |

---

## Out-of-scope follow-ups (do NOT build here)

1. **Cron pruning** of expired/revoked `refresh_tokens` rows (mirroring the existing offer-jobs scheduler)
2. **"Log out all devices"** endpoint (bulk revoke by user_id)
3. **Reducing per-request `is_banned` DB lookup** (caching — separate performance brief)

---

## Proof-of-work

### `npx tsc --noEmit`
```
(no output — clean)
```

### `npm run build`
```
> backend@1.0.0 build
> tsc
(exit 0 — clean)
```

### Test results
```
Test Suites: 1 failed (pre-existing), 5 passed, 6 total
Tests:       2 skipped, 210 passed, 212 total

The 1 failed suite is registration.test.ts — pre-existing TS errors
(TS2493, TS18046) confirmed present on origin/main before any AUTH-01 changes.
```

### AUTH-01 test suite: 22/22 passing
```
 PASS  src/__tests__/unit/refreshTokens.test.ts
  Token helpers
    ✓ hashToken produces a 64-char hex SHA-256
    ✓ signAccessToken produces a valid JWT with type:access
    ✓ wantsRefresh returns true for X-Client-Refresh: v1
    ✓ wantsRefresh returns false when header is missing
  Login capability gating
    ✓ login WITHOUT X-Client-Refresh → legacy 60d token, no refresh row
    ✓ login WITH X-Client-Refresh: v1 → short access + real refresh + DB row
  POST /refresh
    ✓ returns 400 for missing refreshToken
    ✓ returns 401 REFRESH_INVALID for unknown token
    ✓ returns 401 REFRESH_INVALID for expired token
    ✓ returns 401 REFRESH_REUSE and revokes all for reused token
    ✓ rotates: revokes old, issues new access + new refresh
    ✓ returns 403 ACCOUNT_BANNED for banned user
  POST /logout
    ✓ revokes the refresh token and returns 200
    ✓ is idempotent — second call still returns 200
    ✓ returns 200 even with missing/empty refreshToken
  Middleware error codes
    ✓ returns 401 TOKEN_MISSING when no Authorization header
    ✓ returns 403 TOKEN_EXPIRED for expired JWT
    ✓ returns 403 TOKEN_INVALID for malformed JWT
    ✓ returns 403 ACCOUNT_BANNED for banned user
  Token security
    ✓ stored token_hash ≠ raw token
    ✓ stored token_hash = SHA-256 of raw token
    ✓ raw token is 64 chars hex (32 bytes)
```

---

## Curl examples

### 1. Login with capability header (new client)
```bash
curl -s -X POST https://api.mulligans.uk.com/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Client-Refresh: v1" \
  -d '{"email":"user@example.com","password":"Password123!"}' | jq .

# Response:
# {
#   "accessToken": "eyJhbG...",        ← 1h TTL
#   "idToken": "eyJhbG...",            ← same as accessToken
#   "refreshToken": "a3f8b2c1...",     ← 64-char hex (opaque, NOT a JWT)
#   "refreshExpiresAt": "2026-10-01T12:00:00.000Z",
#   "user": { "id": "...", "email": "...", "display_name": "..." }
# }
```

### 2. Refresh (rotation)
```bash
curl -s -X POST https://api.mulligans.uk.com/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"a3f8b2c1...the-token-from-login..."}' | jq .

# Response:
# {
#   "token": "eyJhbG...",              ← new 1h access token
#   "refreshToken": "d7e9f4a2...",     ← NEW refresh token (old one is now revoked)
#   "refreshExpiresAt": "2026-10-01T..."
# }
```

### 3. Reuse detection (second use of the now-rotated token)
```bash
curl -s -X POST https://api.mulligans.uk.com/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"a3f8b2c1...the-OLD-token-from-step-1..."}' | jq .

# Response (401):
# {
#   "error": "Refresh token reuse detected — all sessions revoked",
#   "code": "REFRESH_REUSE"
# }
# All active refresh tokens for this user are now revoked.
```

### 4. Logout
```bash
curl -s -X POST https://api.mulligans.uk.com/api/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"d7e9f4a2...the-current-refresh-token..."}' | jq .

# Response (always 200):
# { "success": true }
```

### 5. Login without capability header (legacy client — unchanged behaviour)
```bash
curl -s -X POST https://api.mulligans.uk.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"Password123!"}' | jq .

# Response (unchanged from pre-AUTH-01):
# {
#   "accessToken": "eyJhbG...",        ← 60d TTL (same as before)
#   "idToken": "eyJhbG...",
#   "refreshToken": "eyJhbG...",       ← same as accessToken (same as before)
#   "user": { ... }
# }
```

