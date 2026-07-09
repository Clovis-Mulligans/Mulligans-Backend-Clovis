# task/s3-bucket-env-var — Security Scan & Notes

**Branch:** `task/s3-bucket-env-var`
**Base SHA:** `ccbdded70c576fcc2c1f344badf07d2cf4b946ba`

---

## Security scan

### 1. New env var `S3_BUCKET_NAME` — LOW RISK
- The env var controls which S3 bucket receives uploads. An attacker who can set arbitrary env vars already owns the process — this adds no new attack surface.
- The default (`mulligans-golf-images-mvp`) is not a secret; it was already visible as a string literal in source.
- No validation on the bucket name value. An invalid bucket name will cause AWS SDK errors at upload time (S3 returns 404 NoSuchBucket or 403 AccessDenied), which are already handled by the existing error propagation. No silent data loss.

### 2. No new endpoints or auth surface — PASS
- This change is entirely internal to `s3Service.ts`. No routes, middleware, or exported API signatures changed.

### 3. No secret exposure — PASS
- The bucket name is not a secret. AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are unchanged and still read from env at module load time.

### 4. IAM boundary — NOTE (not a code issue)
- The backend's IAM credentials must have write access to whichever bucket `S3_BUCKET_NAME` resolves to. If dev sets `S3_BUCKET_NAME=mulligans-golf-images-dev`, the `mulligans-dev-s3` IAM user needs `s3:PutObject` and `s3:DeleteObject` on that bucket. Per the brief, this infra is already in place.

---

## Notes

### Transform caching
Confirmed: ts-jest with CommonJS module resolution does NOT cache the `process.env` read across tests. The `getBucketName()` function reads `process.env.S3_BUCKET_NAME` at call time, and setting the env var in `beforeEach` works correctly. All 4 test cases pass with correct bucket values. No caching issue.

### Existing S3 mocking pattern
Other tests (`offSale.test.ts`, `publishListing.test.ts`, `draftVisibility.test.ts`) mock the entire `s3Service` module because they test controllers, not S3 behaviour. This test takes a different approach — importing the real module and mocking only `S3Client.prototype.send` — because the bucket resolution IS the behaviour under test. Both approaches are valid for their respective scopes.

### uuid ESM issue
The `uuid` package (v11+) ships ESM-only `dist-node/index.js`. Jest with ts-jest cannot transform it without `transformIgnorePatterns` config. The existing repo pattern is to `jest.mock('uuid', ...)` — this test follows the same pattern.

### Pre-existing test failures (not introduced by this change)
- `registration.test.ts` — TypeScript errors (TS18046, TS2493) in existing code
- `refreshTokens.test.ts` — missing `supertest` type declarations
