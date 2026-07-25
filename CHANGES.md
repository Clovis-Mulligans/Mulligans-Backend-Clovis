# Fix: `auto_cancel_at` cleared on PRE_TRANSIT

**Branch:** `task/fix-autocancel-pretransit`
**Base:** `origin/main` @ `5afc28e`
**Date:** 2026-07-25

---

## Fix: conditional `auto_cancel_at` clearing in Shippo webhook

**File:** `src/controllers/shippingController.ts` (~line 662-712)

**Bug:** The Shippo tracking webhook's `updateMany` unconditionally set `auto_cancel_at: null` for every tracking status, including `PRE_TRANSIT`. Since auto-ship buys a label at checkout and Shippo fires `PRE_TRANSIT` within seconds, the 5-weekday shipping deadline was wiped before the seller had done anything. `auto_cancel_at` is the sole trigger for `autoCancelUnshippedOrders()` — once cleared, the order can never auto-cancel and the buyer can never be auto-refunded if the seller never ships.

**Fix:** `auto_cancel_at` is now cleared only when the parcel is genuinely with the carrier or at a terminal state:

| Tracking status | `auto_cancel_at` | Rationale |
|---|---|---|
| `PRE_TRANSIT` | **preserved** | Label exists, parcel NOT with carrier. Deadline must stand. |
| `TRANSIT` | **cleared (null)** | Real carrier scan. Seller has shipped. |
| `DELIVERED` | **cleared (null)** | Terminal. Escrow timer takes over. |
| `RETURNED` | **cleared (null)** | Terminal. Order no longer `to_ship`. |
| `FAILURE` | **preserved** | Recovery is a manual admin action (spec §2.5). |
| default/unknown | **preserved** | Never wipe a protection field on an unmodelled event. |

### FAILURE case — overrides the audit recommendation

The preceding audit (`task/audit-autocancel-pretransit`) proposed *resetting* `auto_cancel_at` to a fresh 5-weekday window on `FAILURE`. **This was wrong against the spec.** `business-logic-v2.md` §2.5 states delivery-failure recovery is a manual admin action, not an automatic one. Resetting the deadline would re-arm auto-cancel on delivery failures and eventually refund a buyer on a recoverable case — a new money bug. The fix preserves the existing `auto_cancel_at` value on `FAILURE`, leaving the order for admin review.

### Implementation: explicit conditional object

The `updateMany` data object is built explicitly. `auto_cancel_at` is only added to the object when `clearAutoCancel` is `true`. This avoids relying on Prisma's implicit `undefined`-omission behaviour for a buyer-protection field.

### Comments updated

Removed the two misleading comments:
- `"(auto_cancel_at is still cleared below on any tracking event, which is correct: a label exists, so don't auto-cancel.)"` — **deleted** (this was the reasoning that introduced the bug).
- `"Per Brief 2 fix: clear auto_cancel_at on ANY tracking event (parcel is with carrier)"` — **replaced** with an accurate comment explaining the conditional clearing logic.

### Existing per-case field handling preserved

The fix does not alter how `delivered_at`, `escrow_release_at`, or `shipped_at` are handled per tracking status. These fields continue to be set exactly as before:
- `shipped_at`: set on `TRANSIT` (if not already set), null on `PRE_TRANSIT`
- `delivered_at`: set on `DELIVERED`
- `escrow_release_at`: set on `DELIVERED` (+ ESCROW_RELEASE_DAYS)

### Auth untouched

The webhook's query-string token authentication (`shippingController.ts:641-644`) is not modified by this change. Its replacement with HMAC signature verification is a separate brief.

---

## Tests: `src/__tests__/unit/webhookAutoCancel.test.ts`

Unit tests with mocked Prisma, asserting on the `updateMany` data object:

1. **PRE_TRANSIT preserves auto_cancel_at** — asserts `data` does NOT have `auto_cancel_at` property; status stays `to_ship`; `shipped_at` stays null
2. **TRANSIT clears auto_cancel_at** — asserts `data.auto_cancel_at === null`; status `in_transit`; `shipped_at` set
3. **TRANSIT preserves existing shipped_at** — asserts pre-existing `shipped_at` is not overwritten
4. **DELIVERED clears auto_cancel_at** — asserts null; status `delivered`; `escrow_release_at` set to +ESCROW_RELEASE_DAYS
5. **RETURNED clears auto_cancel_at** — asserts null; status `returned`
6. **FAILURE preserves auto_cancel_at** — asserts `data` does NOT have `auto_cancel_at` property; status `delivery_failed`
7. **Multi-item shipment** — asserts `updateMany` WHERE uses `tracking_number`, not order id
8. **Webhook auth** — rejects invalid token with 401, no `updateMany` call
9. **Response contract** — always returns 200

Tests assert on whether `auto_cancel_at` *appears in the updateMany data object*, not just its value — the distinction between "set to null" and "not touched" is the entire fix.

---

## Back-fill script: `scripts/backfill-autocancel.ts`

Standalone script to restore `auto_cancel_at` on the 5 stranded `to_ship` orders.

**Usage:**
```bash
npx ts-node scripts/backfill-autocancel.ts              # dry run (default)
npx ts-node scripts/backfill-autocancel.ts --apply       # write future-deadline rows only
npx ts-node scripts/backfill-autocancel.ts --apply-overdue  # write ALL rows including overdue
```

### ⚠️ Live-money caution

`order_d72c800f-...` is a real £36 buyer order. Orders created recently compute to a **future** deadline (safe). Older orders compute to deadlines **already in the past** — writing those would make the next 02:00 cron run cancel and refund them.

The script has two safety gates:
- `--apply` writes only rows where the computed deadline is in the future
- `--apply-overdue` is required to write overdue rows, preventing accidental refunds
- Default (no flag) prints the table and exits without writing

The back-fill is a manual operational step to run AFTER the code fix is deployed, not part of the automatic deploy.

---

## Files changed

| File | Change |
|---|---|
| `src/controllers/shippingController.ts` | Conditional `auto_cancel_at` clearing; comment updates |
| `src/__tests__/unit/webhookAutoCancel.test.ts` | New — 9 test cases |
| `scripts/backfill-autocancel.ts` | New — dry-run-first back-fill |
| `CHANGES.md` | This file |
| `questions.md` | Confirmation notes |

---
---

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
