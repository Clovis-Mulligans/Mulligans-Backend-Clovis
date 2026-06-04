# CSV/Feed Importer Audit — Prioritised Findings

**Date:** 2026-06-04
**Auditor:** Clovis
**Branch:** `task/csv-importer-audit` (off `upstream/main` @ `4585dcf`)
**Scope:** Dashboard importer at `Mulligans-Web/apps/dashboard/src/app/(dashboard)/inventory/import/page.tsx` (1,322 lines) + backend `createListing` path + api-client contracts.

---

## Location & Current State

The importer is **entirely client-side**, in the dashboard web app:
- **File:** `Mulligans-Web/apps/dashboard/src/app/(dashboard)/inventory/import/page.tsx`
- **Format accepted:** CSV only (custom parser, no library — no `papaparse`/`fast-csv` in dependencies)
- **Flow:** 3-step wizard: (1) Upload & validate CSV → (2) Assign images via file picker → (3) Review table with draft/active toggle → Import
- **Backend:** Uses the standard `POST /api/listings` + `POST /api/listings/:id/images` endpoints — no dedicated import endpoint, no server-side CSV processing
- **What works:** CSV parsing, client-side validation, image assignment UI, sequential row-by-row creation via `createListing` api-client function
- **What's broken/stubbed:** Almost every import will fail backend validation (see findings below). Draft status is ignored server-side. No dedupe, no attention flags, no async processing.

---

## CRITICAL

### C-1. Listings ALWAYS land as `active` — draft toggle is non-functional

**Backend:** `Mulligans-Backend/src/controllers/listingController.ts:234`
**Frontend:** `import/page.tsx:611,633-646`

The backend `createListing` hardcodes `status: 'active'` at line 234. The `status` field is not destructured from `req.body` (lines 165-185) and is not in the `createListingSchema` (validation.ts:41-69). The importer's draft/active toggle (page.tsx:1224-1250) and the `status` field in `CreateListingData` (api-client listings.ts:50) are dead code — every imported listing goes live in public search immediately.

This is the single most dangerous issue. A 200-row test import would publish 200 unreviewed listings to production.

**Recommended fix:**
1. Add `status: z.enum(['active', 'draft']).optional().default('draft')` to `createListingSchema` in `validation.ts:41`
2. Destructure `status` from `req.body` in `listingController.ts:165` and use it at line 234: `status: status || 'draft'`
3. Also add `'draft'` to the `updateListingSchema` status enum (validation.ts:89) — currently `['active', 'sold', 'reserved', 'removed']` which blocks draft→active transitions via PUT

### C-2. Category mismatch — importer sends values the backend rejects

**Frontend:** `import/page.tsx:27-36`
**Backend:** `validation.ts:46-54`

The importer's `VALID_CATEGORIES` array includes:
- `'Shafts Grips & Heads'` — but backend expects `'Shafts, Grips & Heads'` (note the comma)
- `'Everything Else'` — not in the backend enum at all

Any listing with either category passes client-side validation but gets a 400 from the backend. The seller sees "1 failed" with no explanation (catch at line 658 swallows the error).

**Recommended fix:** Align `VALID_CATEGORIES` in `import/page.tsx:27-36` exactly with the backend's `createListingSchema` enum. Drop `'Everything Else'` until the backend supports it.

### C-3. Parcel size case mismatch — ALL listings fail backend validation

**Frontend:** `import/page.tsx:57-64` (`SHIPPING_MAP` sends `'SMALL'`, `'MEDIUM'`, etc.)
**Backend:** `validation.ts:60` (expects `'small'`, `'medium'`, `'large'`, `'extra_large'`, `'oversized'`)

Every single listing will fail Zod validation because the importer sends uppercase parcel sizes and the backend enum is lowercase. This makes the importer **100% non-functional** against the current backend.

**Recommended fix:** Change `SHIPPING_MAP` values to lowercase: `parcel_size: 'small'`, etc.

### C-4. Required fields missing — `subcategory` and `location` never sent

**Frontend:** `import/page.tsx:633-647` (the `data: CreateListingData` object)
**Backend:** `validation.ts:55-56`

The backend Zod schema requires:
- `subcategory: z.string().min(1).max(100)` — **required, no default**
- `location: z.string().min(1).max(200)` — **required, no default**

The importer never sends either field. `subcategory` is in the CSV template header but never mapped to the API payload. `location` isn't referenced at all. Every request hits a 400.

**Recommended fix:**
- Map `row['subcategory']` into the payload, or make `subcategory` optional in the backend schema (with a default of `null`)
- Default `location` to `'UK'` in the importer payload (the backend already defaults to `'UK'` in the controller at line 227, but validation rejects the request before it gets there)

---

## HIGH

### H-1. Rate limiter blocks bulk imports at row 51

**Backend:** `listingRoutes.ts:10-16`

The listing creation route has `rateLimit({ max: 50, windowMs: 60 * 60 * 1000 })`. The importer creates listings one-per-request in a sequential loop (page.tsx:604-661). A 200-row import would succeed for rows 1-50 and silently fail for 51-200, with the catch block (line 658) just incrementing `failed++`.

**Recommended fix:** Either (a) exempt bulk imports from per-listing rate limiting (requires a dedicated backend import endpoint), or (b) implement server-side batch creation so 200 rows = 1 request, or (c) at minimum, detect 429 responses on the client and show the seller a clear "rate limited" message with retry guidance.

### H-2. No CSV formula/injection sanitisation

**Frontend:** `import/page.tsx:73-92` (parseCSV), `import/page.tsx:130-165` (validateRows)

Cell values starting with `=`, `+`, `-`, `@` are passed through as-is. While React escapes output and the backend API doesn't interpret formulas, the risk vector is:
1. A seller imports a CSV containing `=HYPERLINK("evil.com","Click here")` as a listing title
2. The title is stored verbatim and displayed to buyers
3. If any admin or seller later exports listing data to a spreadsheet (e.g. analytics CSV export), the formula executes

This is a standard OWASP spreadsheet injection risk.

**Recommended fix:** Add a sanitisation pass in `parseCSV` or `validateRows`. Strip or prefix-escape any cell whose trimmed value starts with `=`, `+`, `-`, `@`, `\t`, `\r`. Example: prepend `'` (apostrophe) to neutralise the formula.

### H-3. No dedupe mechanism — re-imports create duplicates

**Frontend:** `import/page.tsx:593-665`
**Schema:** `Mulligans-Backend/prisma/schema.prisma:76-126`

There is no source identifier, external ID, or import batch ID stored on listings. Re-running the same CSV creates entirely new duplicate listings. The Prisma `listings` model has no field for `external_id`, `import_source`, or `import_batch_id`.

**Recommended fix:**
1. Add `external_id String?` and `import_batch_id String?` columns to the listings schema
2. Store a hash or row identifier per imported listing
3. On import, check for existing listings with the same `external_id` + `seller_id` and skip or update instead of creating

### H-4. No attention flags for listings needing human input

**Frontend:** `import/page.tsx:593-665`

The importer silently creates listings without flagging:
- **Missing club conditions:** For `category: 'Clubs'`, only `condition_overall` is sent (page.tsx:640). The granular `condition_head` / `condition_shaft` / `condition_grip` fields are never populated. The backend can auto-calculate overall from components (listingController.ts:202-208) but not the reverse. Mobile displays these component conditions prominently — imported club listings will show blank condition details.
- **Low-confidence category mapping:** No fuzzy matching or warning when a CSV category doesn't exactly match. The validation just rejects the row entirely rather than flagging it for review.
- **Missing/oversized parcel size:** No warning about whether the selected shipping option is actually serviceable. `'Oversized'` maps to `OVERSIZED` / £14.99 but there's no validation that this is a configured Shippo tier.
- **Missing images:** Listings without images aren't flagged — they just go through with no photos.

**Recommended fix:** Add an `attention_flags` array to each row in the review step (step 3). Flag conditions like: `MISSING_CLUB_CONDITIONS`, `NO_IMAGES`, `LARGE_PARCEL`, `MISSING_SUBCATEGORY`. Show these as warning badges in the review table.

### H-5. Shipping safety — unshippable parcel sizes land as publishable

**Frontend:** `import/page.tsx:57-64` (SHIPPING_MAP)

The `SHIPPING_MAP` includes `'Oversized'` (parcel_size: `'OVERSIZED'`, cost: £14.99) and `'Own Carrier'` (parcel_size: `'SMALL'`, cost: 0). Per the brief, only DPD ≤2kg is configured in Shippo. The importer doesn't validate whether a given parcel_size actually has a working shipping configuration. A bulk import of 200 golf bags (Oversized) would create 200 listings that can't generate shipping labels.

The `'Own Carrier'` mapping is especially suspect — it maps to `parcel_size: 'SMALL'` with `shipping_cost: 0`, which is misleading (the listing will appear as Small parcel with free shipping, not as seller-arranged shipping).

**Recommended fix:** Either (a) restrict `VALID_SHIPPING` to sizes that have active Shippo configurations, or (b) flag oversized/own-carrier listings with an attention flag and prevent them from being set to `active` status until shipping is confirmed.

### H-6. No pro-gating on the import page

**Dashboard middleware:** `Mulligans-Web/apps/dashboard/src/middleware.ts:7-40`
**User schema:** `Mulligans-Backend/prisma/schema.prisma:285` (`is_pro_store Boolean`)

The dashboard middleware only checks for a Cognito auth cookie — not whether `is_pro_store` is true. Any authenticated user who navigates to `/inventory/import` can use the importer. The brief says import should be restricted to pro sellers.

Note: the entire dashboard may be intended as pro-only, but there's no enforcement. The `/apply` page is public, and after approval the user gets `is_pro_store: true`, but the middleware doesn't check this flag.

**Recommended fix:** Add a client-side check on the import page (and ideally the dashboard layout) that reads the user's `is_pro_store` status and redirects non-pro users. Better: add server-side enforcement — a backend middleware or import endpoint that checks `is_pro_store` before accepting import requests.

---

## MEDIUM

### M-1. Sequential blocking import — no async job, no batching

**Frontend:** `import/page.tsx:604-661`

The import loop is a sequential `for` loop with `await createListing(data)` per row, followed by sequential `await uploadListingImage()` per image. For 200 rows with 2 images each, this means 600 sequential HTTP requests. At ~200ms per request, that's ~2 minutes of blocking browser time. The "Please do not close this page" overlay (line 1313) confirms there's no background processing.

Risks:
- Browser tab closure loses all progress with no resume
- Network interruption leaves partial imports with no cleanup or rollback
- JWT token could expire during a long import

**Recommended fix:** Move to a server-side import endpoint: client uploads the CSV + images, backend processes as an async job with progress reporting (e.g. via polling or WebSocket). The existing per-listing API calls should be internal service calls, not client HTTP requests.

### M-2. Error swallowing — seller gets no actionable feedback

**Frontend:** `import/page.tsx:658`

The catch block for import failures:
```ts
catch {
  failed++;
}
```

The seller sees "{N} failed" but never learns why — validation error? Rate limited? Auth expired? Network failure? Duplicate? The Zod validation errors from the backend (validation.ts:26-30) include detailed field-level messages, but the importer discards them entirely.

**Recommended fix:** Capture the error response body and build a per-row error report. Display it in the partial-failure banner (lines 1093-1112) with specific row numbers and error messages.

### M-3. No file/row size limits

**Frontend:** `import/page.tsx:469-484`

The `handleCSVFiles` function reads the entire CSV into memory via `FileReader.readAsText` with no size check. There are no limits on:
- File size (a 100MB CSV would be read into a single string)
- Row count (10,000 rows would generate 10,000+ API requests)
- Field length (a title of 10,000 characters passes client validation but hits backend's 200-char limit)

**Recommended fix:** Add a file size limit (e.g. 5MB), a row count limit (e.g. 500), and field length validation that matches the backend Zod schema limits (title: 200, description: 5000, etc.).

### M-4. `description` validation mismatch

**Frontend:** `import/page.tsx:142-143` — checks present/non-empty only
**Backend:** `validation.ts:44` — requires `z.string().min(10).max(5000)`

The importer's client-side validation checks that description exists and is non-empty, but doesn't enforce the backend's 10-character minimum. A description like "Golf club" (9 chars) passes client validation but fails server validation.

**Recommended fix:** Add `min(10)` check to client-side validation for description.

### M-5. `auto_decline_threshold` column in CSV template is dead

**Frontend:** `import/page.tsx:67` (CSV_TEMPLATE_HEADER includes `auto_decline_threshold`)
**Schema:** Not in Prisma schema, not in `CreateListingData`

The CSV template tells sellers to fill in `auto_decline_threshold` but the field is:
- Not in the Prisma listings model
- Not in `CreateListingData` (api-client)
- Not mapped in the import payload (page.tsx:633-647)
- Never sent to the backend

Sellers will fill it in and it'll be silently ignored.

**Recommended fix:** Either (a) implement `auto_decline_threshold` on the listing model and map it through, or (b) remove it from the CSV template header to avoid confusion.

### M-6. Cross-platform condition display gap for Clubs

**Frontend:** `import/page.tsx:640` — only sends `condition_overall`
**Mobile:** Expects `condition_head`, `condition_shaft`, `condition_grip` for Club listings

When the importer creates a Club listing, it sends only `condition_overall` (mapped from the CSV `condition` column). The granular `condition_head` / `condition_shaft` / `condition_grip` fields are never populated. On the mobile app, Club listing detail screens display these component conditions — imported clubs will show empty/null for all three.

The CSV template doesn't include columns for head/shaft/grip condition, so there's no way for the seller to provide this data even if mapping were implemented.

**Recommended fix:**
1. Add `condition_head`, `condition_shaft`, `condition_grip` columns to the CSV template
2. If provided, map them into the payload. If not provided for a Club listing, flag it with `MISSING_CLUB_CONDITIONS` attention flag
3. Alternatively, for the MVP: when only `condition_overall` is provided for Clubs, set all three component conditions to the same value as overall (imperfect but renders something on mobile)

### M-7. `bulkUpdate` status validation inconsistency

**Backend:** `listingController.ts:1279-1349`

The `bulkUpdateListings` endpoint at `PATCH /bulk` accepts any string for `status` with no validation (line 1301-1303). This contrasts with the single `updateListing` which validates via `updateListingSchema`. A caller could set `status` to arbitrary strings like `"hacked"` via bulk update.

While not directly an importer issue, the importer's future "bulk publish drafts" flow would likely use this endpoint, so it matters for the import pipeline.

**Recommended fix:** Add Zod validation to the `PATCH /bulk` route, or at minimum validate `status` against a known set of values in the controller.

### M-8. Data leakage in error messages

**Backend:** `validation.ts:26-30`

The Zod validation errors returned by the backend include field names and detailed messages:
```json
{ "error": "Validation failed", "details": [{ "field": "body.subcategory", "message": "Required" }] }
```

While the importer currently swallows these (see M-2), if exposed they reveal the backend's exact validation schema and field names to any API caller. This is low-risk for the importer specifically but worth noting for the security scan.

**Recommended fix:** In production, consider returning generic validation errors without revealing internal field names. For the importer specifically, map backend field names to user-friendly labels.

---

## Auth/Ownership Assessment (PASS)

The importer correctly uses the existing `createListing` api-client function (page.tsx:649), which calls `POST /api/listings` with the seller's JWT. The backend extracts `seller_id` from `req.user!.id` (listingController.ts:157) — there's no way to inject another seller's ID via the CSV. The JWT is set during login (auth.ts:84-86) and sent via Authorization header (api-client listings.ts:152).

Image uploads similarly verify ownership — `uploadListingImage` checks `listing.seller_id !== userId` (listingController.ts:325).

## SSRF Assessment (NOT APPLICABLE)

The importer does NOT fetch image URLs from the CSV. Images are assigned from local files via the browser file picker (page.tsx:497-521). There is no image URL column in the CSV template. No SSRF risk exists in the current implementation. If image URL import is added in the future, this must be revisited with allowlist-based URL validation and private IP blocking.

---

## Summary Table

| # | Severity | Issue | File(s) |
|---|----------|-------|---------|
| C-1 | CRITICAL | Listings always `active` — draft toggle is dead | listingController.ts:234, validation.ts:41 |
| C-2 | CRITICAL | Category enum mismatch (comma, "Everything Else") | import/page.tsx:27, validation.ts:46 |
| C-3 | CRITICAL | Parcel size case mismatch — 100% of imports fail | import/page.tsx:57, validation.ts:60 |
| C-4 | CRITICAL | `subcategory` & `location` required but never sent | import/page.tsx:633, validation.ts:55-56 |
| H-1 | HIGH | Rate limiter blocks at row 51 | listingRoutes.ts:10 |
| H-2 | HIGH | No CSV formula/injection sanitisation | import/page.tsx:73 |
| H-3 | HIGH | No dedupe — re-imports create duplicates | import/page.tsx:593 |
| H-4 | HIGH | No attention flags for incomplete listings | import/page.tsx:593 |
| H-5 | HIGH | Unshippable parcel sizes land as publishable | import/page.tsx:57 |
| H-6 | HIGH | No pro-gating on import page | middleware.ts:7 |
| M-1 | MEDIUM | Sequential blocking import, no async/batch | import/page.tsx:604 |
| M-2 | MEDIUM | Error messages swallowed — no per-row feedback | import/page.tsx:658 |
| M-3 | MEDIUM | No file/row size limits | import/page.tsx:469 |
| M-4 | MEDIUM | Description min-length mismatch (10 chars) | import/page.tsx:142, validation.ts:44 |
| M-5 | MEDIUM | `auto_decline_threshold` CSV column is dead | import/page.tsx:67 |
| M-6 | MEDIUM | Club condition components never populated | import/page.tsx:640 |
| M-7 | MEDIUM | `bulkUpdate` accepts arbitrary status strings | listingController.ts:1301 |
| M-8 | MEDIUM | Validation errors leak internal field names | validation.ts:26 |

---

## Verdict

The importer is **non-functional against the current backend**. Critical findings C-2, C-3, and C-4 mean every single import request will be rejected by Zod validation before reaching the controller. Even if those are fixed, C-1 means everything goes live immediately — the entire draft/review concept in the UI is a lie.

**Minimum viable fix order:** C-3 (case) → C-2 (categories) → C-4 (required fields) → C-1 (draft status) → H-1 (rate limit). Without all five, the importer should not be exposed to sellers.
