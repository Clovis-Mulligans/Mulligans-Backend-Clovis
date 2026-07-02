# AUTH-01 — Security Scan & Questions

**Branch:** `auth-01-refresh-tokens`
**Base SHA:** `fd99fe907074704866520b722caca50822cda2d6`

---

## Security scan

### 1. Token storage — PASS
- Raw refresh tokens are **never** stored. Only the SHA-256 hex digest (`token_hash`) is persisted in the `refresh_tokens` table.
- The raw token is generated via `crypto.randomBytes(32)`, returned to the client once in the HTTP response, and discarded server-side.
- Test `"stored token_hash ≠ raw token"` and `"stored token_hash = SHA-256 of raw token"` verify this invariant.
- If the database is compromised, the attacker gets hashes — they cannot reconstruct raw tokens to call `/refresh`.

### 2. Reuse detection — PASS
- When a revoked token is presented to `POST /refresh`, **all** active refresh tokens for that user are bulk-revoked (`updateMany where user_id AND revoked_at IS NULL`).
- This is a standard theft-detection pattern: if an attacker replays an old token after the legitimate client has already rotated, both parties lose access and the user must re-authenticate. This is the correct trade-off.
- The `replaced_by` field on the revoked row creates an audit chain for forensics.
- Test `"returns 401 REFRESH_REUSE and revokes all for reused token"` verifies the bulk-revoke behaviour.

### 3. Rate limiting — PASS
- `POST /refresh` has its own `refreshLimiter` at 10 requests per 15 minutes per IP.
- This is intentionally more generous than the login limiter (5/15min) because legitimate clients will call `/refresh` regularly.
- `POST /logout` has no rate limiter — it's idempotent and doesn't return user information, so abuse is low-risk.

### 4. Log leakage — PASS
- Raw tokens are **never** logged. Console output in the refresh endpoint logs only `user_id` and `token_id` (the DB row UUID), never the raw token or its hash.
- The reuse-detection log line: `[AUTH] REFRESH_REUSE user=${row.user_id} token_id=${row.id}` — safe.
- No `console.log` in `tokens.ts` at all.

### 5. Timing-safe comparison — ACCEPTABLE (documented choice)
- The refresh endpoint does NOT use `crypto.timingSafeEqual` for token comparison. Instead, it relies on the **database unique-index lookup** (`findUnique where token_hash`).
- This is acceptable because: (a) the SHA-256 hash is the value being looked up, not compared byte-by-byte in application code; (b) database index lookups have variable timing due to I/O, caching, and B-tree traversal — they do not leak byte-by-byte comparison info; (c) even if an attacker could measure query timing, they'd be learning about hash values, not raw tokens, and SHA-256 is pre-image resistant.
- If Harry prefers belt-and-suspenders, we could add a `crypto.timingSafeEqual` after the DB lookup returns a row, comparing the presented hash against the stored hash. This would be strictly redundant but defensible for compliance.

### 6. Input validation — PASS
- `POST /refresh`: validates `refreshToken` is present, is a string, and is at least 16 characters. Short-circuits with 400 before any DB query.
- `POST /logout`: validates `refreshToken` is present, is a string, and is at least 16 characters before attempting DB update. If validation fails, still returns 200 (idempotent — doesn't leak whether the token existed).
- Both endpoints use parameterised Prisma queries — no SQL injection risk.

### 7. Token entropy — PASS
- Refresh tokens are 32 bytes from `crypto.randomBytes` (256 bits of entropy), hex-encoded to 64 characters.
- This exceeds OWASP recommendations (128+ bits for session tokens).

### 8. Cascade delete — PASS
- `refresh_tokens` FK to `users` uses `onDelete: Cascade`. If a user is deleted, all their refresh tokens are automatically purged. No orphan cleanup needed.

---

## Questions for Harry

### Q1: Register path — no tokens issued
The brief mentions "register ~79/271" as a site for capability gating. Registration does NOT issue tokens — it returns `{ message, email, user_id, requires_verification }`. Token issuance happens in the **verify-email** auto-login path (~line 273), which I've gated with `buildTokenResponse()`. Please confirm this is correct.

**My recommendation:** This is correct as-is. Registration should not issue tokens before email verification.

**Blocked:** No — implemented the verify-email path as the correct interpretation.

### Q2: Timing-safe comparison
As noted in scan item 5, the current approach relies on DB unique-index lookup rather than `crypto.timingSafeEqual`. Do you want the redundant application-level comparison added?

**My recommendation:** Not needed. The DB lookup approach is standard and the hash is pre-image resistant.

**Blocked:** No — current approach is secure.

### Q3: Refresh token pruning
Expired and revoked rows will accumulate over time. A cron job to prune old rows (e.g. `DELETE FROM refresh_tokens WHERE revoked_at < now() - interval '30 days' OR expires_at < now() - interval '7 days'`) should be added as a follow-up. What interval feels right?

**My recommendation:** Prune revoked rows older than 30 days, expired rows older than 7 days. Run daily alongside existing offer-jobs scheduler.

**Blocked:** No — this is a follow-up, not part of AUTH-01.
