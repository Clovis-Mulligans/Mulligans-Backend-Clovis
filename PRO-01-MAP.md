# PRO-01-MAP: Pro-Seller Surface Map + Recommended Build Sequence

**Branch:** `task/pro-01-investigation` off `clovis/pro-seller-foundation` @ `dc38919`
**Repo:** Mulligans-Backend (report committed here)
**Scope:** Read-only investigation across all three repos (Backend, Mobile, Web)
**Date:** 2026-07-01

---

## 1. INVENTORY TABLE — Pro-Relevant Surface Status

### A. Pro Dashboard (`apps/dashboard` — dashboard.mulligans.uk.com)

| Route | Status | Evidence | Backend Endpoints |
|-------|--------|----------|-------------------|
| `/` (Overview) | **BUILT** | Fetches real counts via `getMyListings()`, `getOrderCounts()`, `getOfferCounts()`, `getMessageCounts()`. Renders stats grid. | `GET /api/listings?seller_id=me`, order/offer/message count endpoints |
| `/analytics` | **BUILT** | Period selectors (7d/30d/90d/12m), revenue charts via Recharts, AOV calculation, top performers. Fetches `fetchAnalyticsData()`. | `GET /api/orders` + `GET /api/listings` (computed client-side) |
| `/apply` | **BUILT** | Full application form (business name, email, phone, website, seller type, description, estimated listings). Submits to `submitProStoreApplication()`. Checks `getApplicationStatus()`. | `POST /api/pro-store/apply`, `GET /api/pro-store/application-status` |
| `/inventory` | **BUILT** | Full inventory table with filters (status, category, condition, price, age, search). Pagination (20/page). Bulk actions (pause/resume/edit price/discount/delete). Row-level context menu. | `GET /api/listings`, `PUT /api/listings/bulk`, `POST /api/listings/bulk-delete`, `DELETE /api/listings/:id` |
| `/inventory/new` | **BUILT** | Full `ListingForm` component. Creates real listings. | `POST /api/listings`, `POST /api/listings/:id/images` |
| `/inventory/[id]/edit` | **BUILT** | Loads listing via `getListing(id)`, delegates to `ListingForm`. | `GET /api/listings/:id`, `PUT /api/listings/:id` |
| `/inventory/import` | **PARTIAL** | 3-step CSV import flow: (1) upload + client-side parse/validate, (2) image assignment (drag/drop, up to 4/listing), (3) review table + draft/active toggle. Creates listings by calling `createListing()` + `uploadListingImage()` per row. Template download with 21 columns. Missing: "Send Offer to Watchers" (placeholder). | `POST /api/listings`, `POST /api/listings/:id/images` (called per-row client-side) |
| `/login` | **BUILT** | Cognito auth via Amplify → custom JWT exchange. Token stored in localStorage. | `POST /api/auth/login` |
| `/messages` | **BUILT** | Socket.IO real-time with HTTP fallback. Conversation list with search, unread badges, quick reply templates. | `GET /api/conversations`, `GET /api/messages/:conversationId`, `POST /api/messages`, `PUT /api/conversations/:id/read` |
| `/offers` | **BUILT** | Two tabs (Received/Made). Status filters. Accept/decline/counter actions with validation modal. | `GET /api/offers/received`, `GET /api/offers/mine`, `POST /api/offers/:id/accept`, `POST /api/offers/:id/decline`, `POST /api/offers/:id/counter` |
| `/orders` | **BUILT** | Two tabs (Sold/Purchases). Status filters (to_ship, in_transit, delivered, etc.). Escrow countdown. | `GET /api/orders/sales`, `GET /api/orders/purchases` |
| `/payouts` | **BUILT** | Balance display (available/pending/total). Transaction history with filters. Stripe Connect lifecycle (create account → onboarding → dashboard link). | `GET /api/stripe/balance`, `GET /api/stripe/account-status`, `GET /api/stripe/transactions`, `POST /api/stripe/create-account`, etc. |
| `/settings` | **BUILT** | 5 sections (Profile/Shipping/Offers/Notifications/Payouts). Per-section save. Avatar upload. Store name with 6-month change lockout. Carrier selection. | `GET /api/users/settings`, `PUT /api/users/settings`, `POST /api/users/avatar` |

**Dashboard verdict: 11 of 12 routes BUILT or substantially PARTIAL. This is not a scaffold — it is a functioning operational tool.**

**Auth/gating:** Cognito login → custom JWT. The `AuthContext` provides an `isProStore` field but it is **hardcoded to `null`** — the pro role check is not yet wired. Dashboard access is gated only by authentication, not by pro status. The apply page checks `isProStore` and redirects approved users to `/`.

**Pro seller flag in schema:**
```prisma
users {
  is_pro_store         Boolean  @default(false)
  pro_store_name       String?  @db.VarChar(100)
  pro_store_website    String?  @db.VarChar(255)
  pro_store_approved_at DateTime?
  subscription_status   String?  @db.VarChar(30)
  subscription_started_at DateTime?
}
```
File: `prisma/schema.prisma:295-300`

**Pro store application model:**
```prisma
pro_store_applications {
  id, user_id, business_name, business_email, business_phone,
  website, seller_type ('pro_shop'|'online_retailer'|'brand'),
  description, estimated_listings ('1-50'|'51-200'|'201-500'|'500+'),
  instagram_handle?, has_existing_store, existing_store_url?,
  status ('pending'|'approved'|'rejected'|'info_requested'),
  review_notes?, reviewed_by?, reviewed_at?
}
```
File: `src/routes/proStore.ts` (Backend)

---

### B. Pro Storefront (Buyer-Facing)

| Surface | Status | Evidence |
|---------|--------|----------|
| Web `/stores/[slug]` | **BUILT** | SSR page with pro store header (badge, avatar, name, website link, stats), category filter tabs (8 hardcoded categories), listings grid, "Message Store" button. Gates on `is_pro_store=true` (404 otherwise). File: `Mulligans-Web/apps/web/src/app/stores/[slug]/page.tsx` + `StorePageClient.tsx` |
| Web `/user/[userId]` | **BUILT** | Seller profile page. Shows pro store badge (gold background + name) if `is_pro_store`. Stats: sales, rating, response rate, dispatch time, specialization. File: `Mulligans-Web/apps/web/src/app/user/[userId]/page.tsx` |
| Mobile seller profile | **PARTIAL** | `UserAbout.tsx` shows bio, stats, policies. Does NOT display pro store name, website, or pro badge. |
| Storefront customization | **PARTIAL** | Schema stores `pro_store_name` + `pro_store_website`. No banner, logo, or custom colours in schema or UI. Every pro store has the identical layout. |

**URL structure:** `/stores/[user-id]` where `[slug]` is the user's UUID, not a vanity slug. No custom-slug model exists.

---

### C. Listing-Creation Path (Import Target)

| Component | Status | File |
|-----------|--------|------|
| Create listing endpoint | **BUILT** | `POST /api/listings` — `src/routes/listingRoutes.ts:47` |
| Zod validation | **BUILT** | `src/middleware/validation.ts:41-71` |
| Prisma listings model | **BUILT** | `prisma/schema.prisma:76-128` |
| Listing attributes (specs) | **BUILT** | `prisma/schema.prisma:63-74` — denormalized key/value for search |
| Image upload endpoint | **BUILT** | `POST /api/listings/:id/images` — multer + Sharp + S3 |
| S3 service | **BUILT** | `src/services/s3Service.ts` — bucket `mulligans-golf-images-mvp`, region `eu-west-2`, CloudFront via `images.mulligans.uk.com` |
| Image processing | **BUILT** | Sharp: auto-rotate, resize to max 2000x2000, convert to JPEG quality 85, progressive |

See Section 2 below for the full import-target spec.

---

### D. Stock / Phantom-Stock Primitives

| Primitive | Status | Evidence |
|-----------|--------|----------|
| Quantity field | **BUILT** | `listings.quantity` (int, default 1). Size-variant support via `specifications.sizeQuantities` JSON with auto-sum. |
| Atomic stock decrement | **BUILT** | `cartCheckoutController.ts:1118-1153` — optimistic `updateMany` with `WHERE quantity >= orderQty` guard. Size-variant uses row lock + transaction. |
| Stock restoration | **BUILT** | `src/lib/stockUtils.ts:41-132` — `restoreListingStock()` handles cancellation, return, dispute refund. Restores `sold` → `active`. |
| Listing status values | **BUILT** | `active`, `draft`, `sold`, `reserved`, `removed`, `deleted` (soft-delete with `deleted_at`) |
| Auto-sold on zero stock | **BUILT** | Status → `sold` when quantity hits 0 during checkout. `cartCheckoutController.ts:1130` |
| Cart validation | **BUILT** | `src/lib/cartValidation.ts:55-80` — rejects if status != `active`, quantity <= 0, or requested qty > available |
| "Sold elsewhere" flow | **ABSENT** | No endpoint, no UI, no automated flow. See Section 3. |

---

### E. Custom Categories (Storefront Carousel)

| Feature | Status | Evidence |
|---------|--------|----------|
| Seller-defined categories | **ABSENT** | No `seller_categories`, `store_collections`, or saved-filter table in schema. |
| Storefront category tabs | **BUILT (hardcoded)** | `/stores/[slug]` shows 8 global categories (Clubs, Clothing, Shoes, etc.) with client-side filtering. Not seller-defined. |
| Saved filters / collections | **ABSENT** | No concept in schema or backend. |

**Net-new work required.** Cleanest model: a `store_collections` table with `seller_id`, `name`, `sort_order`, and either a query-based approach (category + brand + condition filter) or a join table for hand-picked listings. Query-based is more scalable for large inventories but hand-picked allows curated "Staff Picks" type collections.

---

### F. Follow / Likes / Discovery

| Feature | Status | Evidence |
|---------|--------|----------|
| Favorites (listings) | **BUILT** | Full CRUD at `/api/favorites`. `favorites` table with `user_id` + `listing_id` unique constraint. Notification on favourite. File: `src/routes/favoriteRoutes.ts` |
| Follow-a-seller | **ABSENT** | No `seller_follows` table, no routes, no UI anywhere. Zero matches across all repos. |
| Featured listings (home) | **BUILT** | `GET /api/listings/featured` — queries `listings WHERE status='active' AND users.is_pro_store=true`, returns 30, ordered by `created_at desc`. Web shuffles and shows 15. File: `src/controllers/listingController.ts:26-149` |
| Web vs Mobile discrepancy | **INCONSISTENCY** | Web home filters featured to pro stores only. Mobile home shows all active listings (no pro-store filter). |
| Seller discovery | **MINIMAL** | No "browse stores" or "top sellers" page. Sellers discoverable only via: (1) listing detail → seller profile, (2) direct URL to `/stores/[id]`, (3) appearing in featured listings (pro stores only). |

---

## 2. IMPORT-PIPELINE TARGET SPEC

### The Normalized "Incoming Listing" Shape

Based on the REAL listing-creation path (`POST /api/listings` + Zod `createListingSchema`), an incoming listing must map to:

**REQUIRED fields (validation will reject without these):**

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `title` | string | 3–200 chars | |
| `description` | string | 10–5,000 chars | |
| `price` | number | £0.50–£50,000 | Stored as Decimal(10,2) |
| `category` | enum | 8 values (see below) | Must exact-match |
| `subcategory` | string | 1–100 chars | Free-text but canonical values exist per category (see below) |
| `location` | string | 1–200 chars | Defaults to 'UK' in controller if empty |
| `parcel_size` | enum | `small` / `medium` / `large` / `extra_large` / `oversized` | |
| `shipping_cost` | number | £0–£100 | |

**OPTIONAL fields:**

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `brand` | string | max 100 | nullable |
| `model` | string | max 100 | nullable |
| `is_negotiable` | boolean | | defaults to false |
| `quantity` | int | 1–999 | defaults to 1 |
| `condition_overall` | int | 1–5 | auto-calc'd for Clubs if head/shaft/grip provided |
| `condition_head` | int | 1–5 | Clubs only |
| `condition_shaft` | int | 1–5 | Clubs only |
| `condition_grip` | int | 1–5 | Clubs only |
| `ball_condition_type` | string | | Balls category: 'New' or 'Used/Lake'. NOTE: not in Zod schema — unvalidated |
| `specifications` | JSON | Record<string, any> | Category-dependent; stored in listings + denormalized to listing_attributes |
| `status` | enum | `active` / `draft` | defaults to 'active'; import should use 'draft' |

**Category enum (canonical):** `'Clubs'` | `'Shafts, Grips & Heads'` | `'Clothing'` | `'Shoes'` | `'Accessories'` | `'Balls'` | `'Training Aids'` | `'Everything Else'`

**Canonical subcategories** (from `searchController.ts:43-51`, free-text but these are the expected values):

| Category | Subcategories |
|----------|---------------|
| Clubs | Drivers, Fairway Woods, Hybrids, Irons, Wedges, Putters |
| Shafts, Grips & Heads | Shafts, Grips, Heads |
| Clothing | Jackets, Polo Shirts, Trousers, Shorts, Hoodies, Knitwear, Gilets, Mid-Layers, Waterproofs |
| Shoes | Golf Shoes |
| Accessories | Bags, Headcovers, Gloves, Tees, Rangefinders, Launch Monitors, Towels |
| Balls | New, Used/Lake |
| Training Aids | Training Aids |
| Everything Else | (free-text) |

### Specifications JSON by Category

| Category | Spec Fields | Notes |
|----------|-------------|-------|
| Clubs | `dexterity`, `shaftFlex`, `shaftMaterial`, `loft`, `lieAngle`, `gripSize`, `length`, `setMakeup[]`, `shaftModel` | `setMakeup` is an array of iron numbers; gets individual `listing_attributes` rows |
| Clothing | `size`, `gender`, `color`, `clothingType`, `waist` | `size` supports "Various" + `sizeQuantities` |
| Shoes | `shoeSize`, `spikes`, `color` | `shoeSize` supports "Various" + `sizeQuantities` |
| Accessories | `bagType`, `headcoverType`, `gloveSize`, `teeMaterial`, `teeStyle`, `slopeAdjust` | Varies by subcategory |
| All | `sizeQuantities: { [size]: qty }` | If present, `quantity` auto-calculated as sum of all size buckets |

### Image Flow for Import

**Current mechanism:** Images uploaded separately via `POST /api/listings/:id/images` after listing creation.

**What exists:**
- S3 bucket: `mulligans-golf-images-mvp` (eu-west-2)
- CDN: `images.mulligans.uk.com` (CloudFront)
- Upload: multer in-memory → Sharp processing (auto-rotate, max 2000x2000, JPEG q85) → S3
- Storage: `images` table with `listing_id`, `image_url`, `s3_key`, `display_order`

**What an import needs:**
- Download image from external URL (eBay listing photo, seller's site, etc.)
- Pass buffer to `S3Service.uploadImage(buffer, folder, filename)` — this function already exists and accepts raw buffers
- Create `images` row linking to the new listing

**No built-in URL downloader exists.** The import pipeline would need to add a simple `fetch(url) → buffer` step. The S3 upload and image processing infrastructure is fully built.

### Already-Built Backend Import Pipeline (on `origin/pro-seller-foundation`)

**CRITICAL FINDING:** A backend import pipeline already exists on `origin/pro-seller-foundation` (5 commits ahead of `clovis/pro-seller-foundation`). It has NOT been merged to Harry's active branch yet.

| Component | File | Status |
|-----------|------|--------|
| CSV Adapter | `src/services/csvAdapter.ts` | **BUILT** — parses CSV via `csv-parse`, normalizes categories (aliases), conditions (text→1-5), parcel sizes. Produces `IncomingListing[]` with `external_source: 'csv'` + content-hash `external_id`. |
| Import Service | `src/services/importService.ts` | **BUILT** — validates each row against Zod `createListingSchema`, creates listings as `draft`, creates `listing_attributes`, handles P2002 dedup errors. |
| Import Controller | `src/controllers/importController.ts` | **BUILT** — endpoint handler, 200-row limit, `POST /api/listings/import`. |
| Dedup schema | `prisma migration` | **BUILT** — `external_source` + `external_id` nullable columns on `listings` with partial unique index `(seller_id, external_source, external_id WHERE external_source IS NOT NULL)`. |
| Draft visibility | `src/controllers/listingController.ts` changes | **BUILT** — drafts return 404 to non-owners via `optionalAuth` on `GET /listings/:id`. |
| Tests | `csvImport.test.ts`, `draftVisibility.test.ts`, `importDedupDraft.test.ts` | **BUILT** — unit tests for CSV parsing, draft visibility, and dedup. |

**The `IncomingListing` interface IS the normalized intermediate format the brief describes:**
```typescript
interface IncomingListing {
  _rowNum: number;
  title: string;
  description: string;
  price: number;
  category: string;
  subcategory: string;
  location: string;
  brand?: string | null;
  model?: string | null;
  is_negotiable?: boolean;
  parcel_size: string;
  shipping_cost: number;
  quantity?: number;
  condition_overall?: number;
  specifications?: Record<string, any>;
  status: 'draft';
  external_source: 'csv';  // ← adapter identifier
  external_id: string;      // ← content hash for dedup
}
```

Future adapters (eBay API, Linnworx) would produce the same `IncomingListing[]` with different `external_source` values. The `importService` downstream is adapter-agnostic.

---

## 3. PHANTOM-STOCK REALITY

### What the Code Supports Today

**Stock tracking:** `listings.quantity` (integer, default 1). Atomic decrement at checkout with `WHERE quantity >= orderQty` guard. Size-variant support via row lock + `sizeQuantities` JSON.

**Status transitions that exist:**
- `active` → `sold` (automatic when quantity hits 0 during checkout)
- `active` → `reserved` / `removed` / `deleted` (manual via `PUT /api/listings/:id`)
- `sold` → `active` (stock restoration on cancellation/return/dispute refund)

**Cart validation:** Blocks add-to-cart if listing `status != 'active'` or `quantity <= 0`. Validates at checkout that requested qty ≤ available stock.

### What Does NOT Exist

- No "sold elsewhere" status or flow
- No external-stock-sync mechanism
- No way to automatically remove a listing when sold on another platform
- No webhook or polling for external inventory changes
- No mid-order cancellation triggered by external stock depletion

### Minimal v1 "Sold Elsewhere" Answer

**The cheapest viable approach using existing primitives:**

1. **Manual "sold elsewhere" button** in the Pro Dashboard inventory → calls `PUT /api/listings/:id` with `status: 'removed'` (or a new `'sold_elsewhere'` status for auditability)
2. **If the listing has an active order** (status `pending`/`paid`/`to_ship`): the existing `cartValidation.ts` already rejects checkout attempts for non-`active` listings. For orders already in flight, need a cancellation + refund path (the auto-cancel/refund infrastructure exists in `escrowService.ts`).
3. **Cart cleanup:** Items in cart pointing to a now-`removed` listing are already flagged invalid at checkout (`cartValidation.ts:55-80`).

**What's MISSING for this v1:**
- A dashboard UI button ("Mark sold elsewhere" in inventory context menu)
- Backend logic to cancel any in-flight orders for that listing and trigger buyer refund + notification
- A distinct `sold_elsewhere` status value (optional but valuable for analytics — distinguishes "sold on Mulligans" from "sold on eBay")

**Cost:** Small — the infrastructure (status update, cart validation, refund paths) is built. The gap is the orchestration glue and the UI trigger.

---

## 4. RECOMMENDED BUILD SEQUENCE

### The Central Question: Dash-ops-first or import-pipeline-first?

**ANSWER: IMPORT-PIPELINE-FIRST.**

**Reasoning from the facts:**

1. **The Dashboard is NOT bare shells.** 11 of 12 routes are functional. It already manages listings (create, edit, bulk actions, status changes), orders, offers, messages, payouts, and analytics. Importing into this Dashboard is importing into a working operational environment, not a void.

2. **The import pipeline is already partially built.** The backend CSV adapter, import service, dedup schema, and draft visibility are on `origin/pro-seller-foundation`. The Dashboard already has a client-side CSV import UI at `/inventory/import`. The gap is small: merge the backend work, wire the Dashboard UI to call the backend import endpoint instead of client-side per-row creation, and add image re-hosting.

3. **Import creates the VALUE that makes everything else matter.** A reseller considering Mulligans wants to know: "can I get my catalogue on there without re-listing 200 items manually?" The import pipeline is the wedge. Without it, the Dashboard is a nice tool for a seller with zero listings.

4. **Storefront improvements (custom categories, banner, follow) are ADDITIVE.** They make an existing pro store better. But a pro store with zero listings is valueless regardless of customization. Import comes first.

5. **Dashboard ops gaps are minor.** The main gaps are: `isProStore` not wired in auth context (trivial), and auto-decline threshold (cosmetic, not blocking). These can be fixed alongside or after the import pipeline.

### Phased Build Sequence

#### Phase 1: Import Pipeline (v1) — THE WEDGE

**Goal:** A reseller can upload a CSV and have their catalogue land as reviewable drafts, with images.

| Step | What | Dependencies | Effort |
|------|------|--------------|--------|
| 1a | Merge existing backend import work from `origin/pro-seller-foundation` to active branch | None | Small (already built, needs merge + test on dev) |
| 1b | Wire Dashboard `/inventory/import` to use backend `POST /api/listings/import` instead of client-side per-row creation | 1a | Medium (replace client-side loop with single backend call; keep image step as-is or add to backend) |
| 1c | Add image re-hosting to import service (fetch external URL → S3) | 1a | Medium (add `fetch(url) → buffer → S3Service.uploadImage()`) |
| 1d | Concierge tooling: Harry/Haydn can run an import on behalf of a seller (admin endpoint or CLI) | 1a | Small |
| 1e | Wire `isProStore` in Dashboard auth context | None | Trivial |

#### Phase 2: Phantom-Stock v1 — RISK MITIGATION

**Goal:** A reseller who sells an item on eBay can remove it from Mulligans without leaving a phantom listing.

| Step | What | Dependencies | Effort |
|------|------|--------------|--------|
| 2a | "Sold elsewhere" button in Dashboard inventory (context menu + bulk action) | Phase 1 complete | Small |
| 2b | Backend: on sold-elsewhere, cancel in-flight orders + refund buyers + notify | Existing refund infrastructure | Medium |
| 2c | Add `sold_elsewhere` status value to Prisma schema + validation | None | Trivial |

#### Phase 3: Storefront Enhancement — DIFFERENTIATION

**Goal:** Pro stores look professional and unique; buyers can discover and follow sellers.

| Step | What | Dependencies | Effort |
|------|------|--------------|--------|
| 3a | Custom categories / collections model (`store_collections` table + CRUD) | Schema migration | Medium |
| 3b | Storefront carousel UI (seller-named category sections) | 3a | Medium |
| 3c | Banner/logo upload (add `pro_store_banner_url`, `pro_store_logo_url` to users schema) | Schema migration | Medium |
| 3d | Follow-a-seller (`seller_follows` table, endpoints, notification, badge counts) | Schema migration | Medium |
| 3e | "Browse stores" / "Top sellers" discovery page | 3d (follower counts), existing `is_pro_store` flag | Medium |
| 3f | Mobile parity — show pro store badge/name in seller profiles | None | Small |
| 3g | Fix featured-listings inconsistency (mobile should filter to pro stores, matching web) | None | Small |

#### Phase 4: eBay API Adapter — SCALE

**Goal:** Resellers can import from eBay programmatically (not just CSV).

| Step | What | Dependencies | Effort |
|------|------|--------------|--------|
| 4a | eBay API approval + sandbox integration | External (eBay developer program) | Blocked on approval |
| 4b | eBay adapter: `fetchEbayListings() → IncomingListing[]` | Phase 1 complete (same normalized format) | Large |
| 4c | Periodic sync: detect eBay sold/ended → auto-remove from Mulligans | Phase 2 (phantom-stock handling) | Large |

#### Later: Billing + Fee-Flip (SEPARATE ARC)

**NOT part of this sequence.** Slots in after Phase 3 when pro stores have enough traction to justify monetization.

| Item | Notes |
|------|-------|
| £30/mo subscription | Schema prepared (`subscription_status`, `subscription_started_at`). Stripe Billing integration needed. Deferred until adoption proves demand. |
| Fee-model flip (buyer-fee → seller-deduction) | Money-critical. Welded OFF. Needs its own investigation brief covering: Stripe Connect fee deduction, checkout flow changes, seller dashboard payout display, backwards compatibility for non-pro sellers. |

---

## 5. OPEN QUESTIONS / DECISIONS FOR HARRY

### Q1: Merge the existing import pipeline work?

`origin/pro-seller-foundation` is 5 commits ahead of `clovis/pro-seller-foundation` with the CSV adapter, import service, dedup schema, draft visibility, and tests. Should this be merged to the active branch, or does Harry want to review/rework it first?

### Q2: Image re-hosting strategy

Two options for handling images during CSV import:

**(a) URL-in-CSV, async download:** Seller provides image URLs in the CSV. The import service downloads them asynchronously and re-hosts to S3. Pro: fully automated. Con: external URLs may be temporary (eBay image links expire); download failures need retry/reporting.

**(b) Images uploaded separately (current Dashboard UI approach):** CSV creates listings as drafts with no images. Seller adds images via the Dashboard import step 2 (already built). Pro: simpler, no external URL dependency. Con: manual step for seller; doesn't scale for 200+ listings.

**Recommendation:** Start with (b) for concierge imports (Harry/Haydn add images manually or seller uses the Dashboard UI). Build (a) as a fast-follow for self-serve scale.

### Q3: Storefront URL structure

Currently `/stores/[user-id]` (UUID). Should pro stores get vanity slugs (e.g. `/stores/titleist-pro-shop`)? This requires a `pro_store_slug` field with uniqueness constraint and slug validation. Low priority but worth deciding before launch so URLs don't change later.

### Q4: "Sold elsewhere" — new status or reuse `removed`?

Adding a distinct `sold_elsewhere` status is cleaner for analytics (distinguish "delisted by choice" from "sold on another platform") but requires a schema change + validation update. Reusing `removed` is zero-effort but loses the distinction.

### Q5: Mobile featured-listings parity

Web home shows only pro-store featured listings. Mobile shows all active listings. Is this intentional (mobile shows broader inventory for consumer engagement) or a bug? Should mobile match web's pro-store filter?

### Q6: Dashboard pro-gate

Currently any authenticated user can access the Dashboard. Should it be gated to `is_pro_store = true` users only? If so, what happens to non-pro sellers who use the Dashboard today (if any)?

---

## 6. RISKS & GOTCHAS

### R1: Two parallel import implementations

The Dashboard at `/inventory/import` has a **client-side** CSV import that creates listings one-by-one via `POST /api/listings`. The backend has a **server-side** import service (`POST /api/listings/import`) that batch-creates from CSV. These are **separate, uncoordinated implementations** with different validation logic, error handling, and dedup behaviour. The client-side version does NOT use `external_source`/`external_id` dedup. Risk: if both are available, re-imports could create duplicates via the client-side path.

**Recommendation:** Wire the Dashboard UI to call the backend import endpoint. Retire the client-side per-row creation loop.

### R2: `ball_condition_type` validation gap

`ball_condition_type` is accepted by the controller and stored in the DB but is **not validated by the Zod schema** (`createListingSchema`). The import pipeline's CSV adapter does not normalize or validate it either. Any string value will be stored. This could create inconsistent data from imports.

### R3: Draft visibility inconsistency

On `origin/pro-seller-foundation`, `GET /api/listings/:id` uses `optionalAuth` to allow the owner to see their own drafts while hiding them from others. But `GET /api/listings` (the listing search/browse endpoint) still filters to `status: 'active'` — drafts don't appear in search even for the owner. The Dashboard inventory page works because it calls a separate `getMyListings()` function. This is fine but could surprise a seller who creates a draft and then searches for it on the consumer app.

### R4: No stock-level sync for multi-platform sellers

The biggest operational risk for pro sellers is **phantom stock** — a buyer purchasing an item that was already sold on eBay/elsewhere. Phase 2 provides a manual "sold elsewhere" button, but there's no automated sync. Until the eBay API adapter (Phase 4) is built, phantom stock is managed entirely by the seller manually updating their Dashboard. Harry should communicate this clearly to early pro sellers.

### R5: Stripe Connect requirement for payouts

A pro seller cannot receive payouts until Stripe Connect onboarding is complete. The Dashboard handles this flow (payouts page shows Stripe onboarding), but there's no blocker preventing a seller from importing listings and receiving orders BEFORE completing Stripe setup. This could create stuck-order situations (seller can't get paid, buyer waiting). The existing stuck-order safety net (`payout_blocked_at` cron) handles this but it's a poor first experience.

**Recommendation:** Consider gating listing activation (draft → active) on Stripe Connect completion for pro sellers.

### R6: 200-row limit on backend import

The backend import controller limits CSV imports to 200 rows. For large resellers (500+ SKUs), this requires multiple imports. The Dashboard client-side import has no explicit limit. This discrepancy will surface when the Dashboard is wired to the backend endpoint.

---

## PROOF-OF-WORK

- Report committed as `PRO-01-MAP.md` at repo root of `Mulligans-Backend`
- `git diff --stat` shows exactly this one file
- All 6 sections present with file-path evidence throughout
- Central question answered with dependency reasoning from code facts
