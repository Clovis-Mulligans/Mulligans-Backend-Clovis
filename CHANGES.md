# task/s3-bucket-env-var

Branch: `task/s3-bucket-env-var` based from `clovis/pro-seller-foundation` at `ccbdded`

## What changed

Replaced the hardcoded S3 bucket constant in `src/services/s3Service.ts` with a call-time resolver function that reads `process.env.S3_BUCKET_NAME`, falling back to `mulligans-golf-images-mvp` when unset.

### Why a resolver function (not a module-level const)

A module-level `const BUCKET = process.env.X || default` is captured once at import time. Tests that set the env var after import would see the stale value, forcing them to mock the resolution logic itself — which is exactly the behaviour under test. The `getBucketName()` function resolves at call-time, so a test can set `process.env.S3_BUCKET_NAME` before invoking any S3 method and the value takes effect immediately.

### Five reference sites updated

1. **Line 44** — `Bucket: getBucketName()` in `uploadImage` (was `Bucket: BUCKET_NAME`)
2. **Line 68** — `Bucket: getBucketName()` in `uploadSupportImage` (was `Bucket: BUCKET_NAME`)
3. **Line 83** — `Bucket: getBucketName()` in `deleteImage` (was `Bucket: BUCKET_NAME`)
4. **Line 26** — `getBucketName()` in `buildImageUrl` S3-URL fallback (was `BUCKET_NAME`)
5. **Line 13** — Declaration renamed from `BUCKET_NAME` to `DEFAULT_BUCKET_NAME` (used only inside `getBucketName`)

### Prod-safe default confirmed

When `S3_BUCKET_NAME` is **unset**, `getBucketName()` returns `'mulligans-golf-images-mvp'` — byte-for-byte identical to the previous hardcoded value. Prod does not set this env var, so behaviour is unchanged.

### What was NOT changed

- Credentials / region handling — untouched
- `CLOUDFRONT_DOMAIN` logic — untouched
- Key generation (`listings/...`, `support/{ticketId}/...`) — untouched
- Method signatures and exported symbols — untouched
- No renames of public API

## Tests

**File:** `src/__tests__/unit/s3BucketEnv.test.ts` — 4 tests, all pass.

Tests are placed in `src/__tests__/unit/` to match the existing repo convention (all service/controller unit tests live there, not co-located with source).

| # | Test case | Asserts |
|---|-----------|---------|
| 1 | `S3_BUCKET_NAME` set → `uploadImage` | `PutObjectCommand.Bucket === 'mulligans-golf-images-dev'` |
| 2 | `S3_BUCKET_NAME` unset → `uploadImage` | `PutObjectCommand.Bucket === 'mulligans-golf-images-mvp'` (prod default) |
| 3 | `S3_BUCKET_NAME` set → `uploadSupportImage` | `PutObjectCommand.Bucket === 'mulligans-golf-images-dev'` |
| 4 | `S3_BUCKET_NAME` set → `deleteImage` | `DeleteObjectCommand.Bucket === 'mulligans-golf-images-dev'` |

**Mocking boundary:** Only `S3Client.prototype.send` is mocked (via `jest.spyOn`). The bucket-resolution logic (`getBucketName`) is exercised for real — it is the behaviour under test. `uuid` is mocked to avoid its ESM transform issue (matches existing repo pattern in `offSale.test.ts`).

**Env hygiene:** `process.env` is snapshot/restored in `beforeEach`/`afterEach` — no leakage between test cases.

## Diff stats

```
 src/services/s3Service.ts                     |  11 +++--
 src/__tests__/unit/s3BucketEnv.test.ts         |  68 +++++++++++++++++++++++++
 CHANGES.md                                     |  (this file)
 output/questions.md                            |  (security scan)
 4 files changed
```
