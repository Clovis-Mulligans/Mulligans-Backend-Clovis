# PRO-IMPORT-I-02c — Re-import Sync Surface Map

**Base SHA:** `1fd4973` (`origin/pro-seller-foundation`, I-02+I-02a merged)
**Investigation branch:** `task/pro-import-i02c-investigation`
**Type:** READ-ONLY — no source changes
**Date:** 2026-06-23

---

## 1. QUANTITY RECONCILIATION

### 1.1 How `listings.quantity` is decremented on sale

Four checkout paths, all using atomic `{ decrement: orderQuantity }` with a WHERE guard:

| Path | File:Line | Guard |
|------|-----------|-------|
| Stripe single checkout | `stripeController.ts:809` | `quantity: { gte: orderQuantity }` via `updateMany` |
| Native single checkout | `nativePaymentController.ts:944` | same pattern |
| Native cart checkout | `nativePaymentController.ts:1308` | same pattern |
| Cart (Stripe) checkout | `cartCheckoutController.ts:1129` | same pattern |

All four set `status: 'sold'` when `newTotalStock <= 0` (e.g. `cartCheckoutController.ts:1057`):
```ts
const shouldMarkSold = newTotalStock <= 0;
// ...
status: shouldMarkSold ? 'sold' : 'active',
```

**Size-variant listings** store per-size buckets in `specifications.sizeQuantities`. The decrement updates the bucket and recalculates the total. Same atomic guard applies.

**Stock restoration** (cancel/return/refund) goes through `restoreListingStock()` in `src/lib/stockUtils.ts:41-132`. Uses `{ increment: quantity }` for plain listings; read-modify-write with `FOR UPDATE` lock for size variants. Restores status to `'active'` (unless listing is `'deleted'`).

### 1.2 Per-listing sold tracking

**No `units_sold` counter on listings.** Sold count is derivable from `orders`:

- `orders.listing_id` (String?, FK to listings) — `schema.prisma:152`
- `orders.quantity` (Int, default 1) — `schema.prisma:193`
- `orders.paid_at` (DateTime?) — `schema.prisma:164`
- `orders.status` (String) — `schema.prisma:159`
- `orders.cancelled_at`, `orders.refunded_at` — timestamps for restorations

### 1.3 Timestamp anchor

**No `last_imported_at` or `last_synced_at` exists today.** The listing has:
- `created_at` (DateTime, default now) — never changes
- `updated_at` (DateTime) — changes on every stock/price/field mutation

`updated_at` is unsuitable as an import anchor because sales also update it.

### 1.4 Multi-unit support

**Yes — fully supported today.** `listings.quantity` is `Int @default(1)` but can be any positive integer. `cart_items.quantity` and `orders.quantity` both support multi-unit. Size-variant listings hold per-size counts in `specifications.sizeQuantities`.

### 1.5 Proposed reconciliation formula

**The delta method** — uses current DB state, no order queries needed:

```
units_consumed = qty_at_last_import − current_listings.quantity
new_quantity   = MAX(0, csv_qty − units_consumed)
```

Trace-through proof:

| Step | External | Mulligans qty | qty_at_last_import |
|------|----------|---------------|--------------------|
| Import at qty 5 | 5 | 5 | 5 |
| 2 sell on Mulligans | 5 | 3 | 5 |
| 1 returned | 5 | 4 | 5 |
| Re-import CSV says 4 | 4 | ? | ? |
| units_consumed = 5 − 4 = 1 | | | |
| new_qty = MAX(0, 4 − 1) = **3** | | **3** | **4** |

Correct: seller's external stock (4) minus net Mulligans sales (1) = 3 available.

**Why this works:** `current_listings.quantity` already reflects all decrements AND all restorations (cancels, returns, refunds). The delta `qty_at_last_import − current_qty` is the net units consumed since the last import, regardless of order status transitions.

**Edge case — seller manually edits quantity on Mulligans between imports:** The delta formula would over- or under-count. Since CSV is declared source of truth, a manual Mulligans-side edit is overridden on next import. Flag in questions.md for Harry.

### 1.6 Minimal schema addition

Two new nullable columns on `listings`:

```sql
ALTER TABLE listings ADD COLUMN last_imported_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN qty_at_last_import INT;
```

- `last_imported_at` — set to `NOW()` on every import/re-import. Used for audit, staleness display, and future "changes since import" queries.
- `qty_at_last_import` — set to the CSV quantity value on every import/re-import. Used in the reconciliation formula.

Both nullable (NULL for manually-created listings). Non-destructive, additive migration.

---

## 2. PRICE SNAPSHOT — IS AN IN-FLIGHT PURCHASE SAFE?

### 2.1 Where price is captured

| Stage | Source | Locked? |
|-------|--------|---------|
| Add to cart | `cart_items` stores `offer_price` if offer accepted; **no listing price snapshot** | No — listing price read live at checkout |
| Checkout session creation | `cartCheckoutController.ts:317-319`: `item.offer_price \|\| item.listings.price` | **Yes** — amount locked into Stripe session |
| Stripe charges buyer | From the session's `unit_amount` (set at creation) | Locked |
| Order creation (webhook) | `cartCheckoutController.ts:1081-1089`: `listing_price: effectivePrice` snapshotted | Locked |

Same pattern in single-item checkout (`stripeController.ts:773`, `nativePaymentController.ts`): price read from Stripe session metadata at fulfillment, not live from DB.

### 2.2 The vulnerability window

**Cart → Checkout Session:** If a re-import changes `listings.price` after a buyer adds to cart but before they click "Pay", the checkout session will use the NEW price (live read from `listings.price` at `cartCheckoutController.ts:317`).

**After checkout session creation:** Safe. Amount is locked in Stripe. A re-import price change after this point does not affect the in-flight purchase.

### 2.3 Verdict

**The active-order guard eliminates the dangerous window.** If a listing has an order in `ACTIVE_ORDER_STATUSES`, the re-import refuses to update. The only remaining risk is a cart item (no order yet) — but cart items are NOT orders; the price read at checkout is always live, and this is existing behaviour (a seller manually changing price has the same effect today). No new risk introduced.

**Confirmation:** There is no place price is read live at charge time that a mid-sync change could corrupt. Stripe session creation locks the amount.

---

## 3. ACTIVE-ORDER GUARD

### 3.1 Location and definition

**File:** `src/controllers/listingController.ts:1137`

```ts
const ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered'];
```

### 3.2 Guard logic (`listingController.ts:1139-1168`)

```ts
const activeOrders = await prisma.orders.findFirst({
  where: {
    listing_id: id,
    status: { in: ACTIVE_ORDER_STATUSES },
  },
  select: { id: true, status: true },
});

if (activeOrders) {
  // Contextual error message based on status subgroup
  // pending/paid/to_ship → "order waiting to be shipped"
  // shipped/in_transit → "order in transit"
  // delivered → "recently delivered order"
  res.status(400).json({ error: message, order_status: activeOrders.status });
  return;
}
```

### 3.3 Reuse plan for re-import

Extract `ACTIVE_ORDER_STATUSES` to a shared constant (e.g. `src/constants/orderStatuses.ts`) and create a reusable function:

```ts
async function hasActiveOrders(listingId: string): Promise<{id: string; status: string} | null>
```

The re-import update calls this per-listing. If an active order exists, the row is reported as `skipped: 'active_order'` with the order status, and no fields are mutated.

### 3.4 Other usage

`accountDeletionController.ts:87-95` uses a similar but broader set (includes `'processing'`, excludes `'delivered'`). These should remain independent — the deletion guard has different safety requirements.

---

## 4. UPDATE PATH — REUSABLE SEAM

### 4.1 Existing `updateListing` controller

**File:** `src/controllers/listingController.ts:957-1104`

Key properties:
- **Conditional field assignment:** Only fields present in `req.body` are added to `updateData` (lines 1014-1039). Absent fields are NOT clobbered.
- **Prisma call:** `prisma.listings.update({ where: { id }, data: updateData })` at line 1043-1046.
- **Listing attributes:** If `specifications` is provided, deletes all existing attributes and recreates (lines 1049-1086). Same delete+recreate pattern as `importService.ts`.
- **Size-variant quantity:** Auto-recalculated from `sizeQuantities` if present (lines 1035-1039).
- **Condition auto-calc:** If category is 'Clubs', `condition_overall` recalculated from head/shaft/grip (lines 1000-1007).
- **Validation:** `updateListingSchema` exists in `middleware/validation.ts:73-106` (all fields optional).

### 4.2 Reusable seam for re-import

The re-import update should NOT call the HTTP endpoint (no req/res). Instead, extract the data-assembly + Prisma update + attribute handling into a shared service function:

```ts
// src/services/listingUpdateService.ts (new)
export async function applyListingUpdate(
  listingId: string,
  fields: Partial<IncomingListing>,
  sellerId: string,
): Promise<void>
```

This function reuses the same field-assembly logic, Prisma `update` call, and attribute delete+recreate pattern from `updateListing`. The controller is then refactored to call this service (optional — can be deferred to avoid touching the controller in this slice).

### 4.3 Dedup index lookup

Match existing listing: `(seller_id, external_source, external_id)` — the same tuple as the `listings_external_dedup` partial unique index. This lookup IS indexed (the dedup index covers it). The re-import uses:

```ts
const existing = await prisma.listings.findFirst({
  where: {
    seller_id: sellerId,
    external_source: 'csv',
    external_id: row.external_id,
  },
});
```

---

## 5. QTY-0 / OFF-SALE

### 5.1 How "sold out" is represented today

When quantity hits 0 after a sale, ALL four checkout paths set `status: 'sold'` (e.g. `cartCheckoutController.ts:1057-1130`):
```ts
status: shouldMarkSold ? 'sold' : 'active',
```

Stock restoration (`stockUtils.ts:64`) sets status back to `'active'` if stock is restored above 0 (unless listing was `'deleted'`).

### 5.2 What public queries filter on

| Query | File:Line | Filter | Checks qty? |
|-------|-----------|--------|-------------|
| `getAllListings` | `listingController.ts:463` | `status: 'active'` | **No** |
| `getFeaturedListings` | `listingController.ts:58` | `status: 'active'` | **No** |
| `getSellerListings` | `listingController.ts:925` | `status: 'active'` | **No** |
| `addToCart` | `cartController.ts:349-354` | `getStockForSize() < 1` → 400 | **Yes** |
| Checkout (all paths) | stock guard before decrement | `quantity: { gte: orderQuantity }` | **Yes** |

**Gap:** A listing with `status: 'active'` and `quantity: 0` would appear in search results but fail at add-to-cart. This is bad UX but not a money risk (checkout guards prevent purchase).

### 5.3 Re-import qty=0 handling

When CSV says qty=0 for a matched listing:
- The reconciliation formula yields `new_qty = MAX(0, 0 - units_consumed)` = **0**
- Status should change to `'sold'` (existing convention) — removes from public queries

### 5.4 I-04 sequencing recommendation

**I-04 is NOT a blocker for I-02c.** The existing `qty → 0 → status: 'sold'` convention is sufficient for re-import. If I-04 later introduces a distinct `'off_sale'` status (distinguishing "seller pulled stock" from "all units sold on Mulligans"), the re-import can be updated to use it. For now, `'sold'` is the safe default.

**However:** `'sold'` is semantically wrong for "seller chose to delist in their external system." If Harry wants a cleaner state machine, I-04 should land first and define the off-sale primitive. Otherwise, `'sold'` is functional today.

---

## 6. FIELD SCOPE

### 6.1 CSV fields (from `IncomingListing`)

| Field | Source |
|-------|--------|
| title | CSV column |
| description | CSV column |
| price | CSV column |
| category | CSV column (normalized) |
| subcategory | CSV column |
| location | CSV column |
| brand | CSV column (optional) |
| model | CSV column (optional) |
| is_negotiable | CSV `accepts_offers` (boolean) |
| parcel_size | CSV column (normalized) |
| shipping_cost | CSV column |
| quantity | CSV column (default 1) |
| condition_overall | CSV `condition` (mapped) |
| specifications | CSV spec fields assembled |
| external_source | Always `'csv'` |
| external_id | SKU or content hash |
| status | Always `'draft'` on initial import |

### 6.2 Listing fields NOT in CSV (frozen on re-import)

| Field | Why frozen |
|-------|-----------|
| `id` | Primary key — identity |
| `seller_id` | Ownership — set at creation |
| `status` | Managed by platform (active/sold/draft/deleted) — see status rules below |
| `original_price` | Historical pricing data |
| `currency` | System default (GBP) |
| `is_featured` | Admin-set, revenue-relevant |
| `views` | User engagement counter |
| `favorites_count` | User engagement counter |
| `created_at` | Immutable creation timestamp |
| `updated_at` | System-managed |
| `deleted_at` | Soft-delete marker |
| `ball_condition_type` | Not in CSV |
| `condition_grip` | Not in CSV (only condition_overall mapped) |
| `condition_head` | Not in CSV |
| `condition_shaft` | Not in CSV |
| images (relation) | Separate upload system |

### 6.3 Status rules on re-import update

| Current status | Re-import action |
|----------------|------------------|
| `draft` | Update all syncable fields freely |
| `active` | Update if no active orders; apply reconciliation formula for qty |
| `sold` | Update qty → if new_qty > 0, reactivate to `active` |
| `deleted` | **Skip** — seller intentionally removed |
| `removed` | **Skip** — platform action |

### 6.4 Recommendation and tradeoff

**Harry's lean: full re-sync** (CSV overwrites all syncable fields).

**Tradeoff:** If a seller hand-edits a listing title/description on Mulligans between imports (e.g., adds "PRICE DROP" or fixes a typo), the next CSV import clobbers that edit with the original CSV value.

**Recommendation:** Full re-sync for v1 with a clear warning in the import response: `"N listings updated from CSV — any Mulligans-side edits to these fields were overwritten."` If sellers complain, a future `sync_mode: 'qty_price_only' | 'full'` parameter can restrict the field scope. But for pro sellers using CSV as their source of truth, full sync is correct.

**Exception:** `specifications` on re-import should merge carefully — if the seller has added Mulligans-side attributes (e.g. images are tagged to attributes), a full delete+recreate could orphan them. Verify whether `listing_attributes` are purely spec data or serve other purposes. (They appear to be purely spec data — `key/value` pairs like `club_type: 'Driver'` — so delete+recreate is safe.)

---

## 7. PROPOSED I-02c IMPLEMENTATION PLAN

### Phase 1: Schema migration

Add two nullable columns to `listings`:
- `last_imported_at TIMESTAMPTZ` — set on every import/re-import
- `qty_at_last_import INT` — CSV quantity value at import time

Migration name: `20260624000000_import_reconciliation_fields`

Prisma can't express these as anything special — just nullable fields. Standard `prisma migrate dev`.

### Phase 2: Shared constants + guard function

New file: `src/constants/orderStatuses.ts`
```ts
export const ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered'];
```

New function (can live in importService or a shared util):
```ts
export async function findActiveOrder(listingId: string): Promise<{id: string; status: string} | null>
```

Refactor `listingController.ts:1137` to import from shared constant (or leave for a later cleanup — no functional change needed).

### Phase 3: Modify `importService.ts`

Change the dedup P2002 branch from "reject as duplicate" to "lookup existing → decide update or skip":

```
For each row:
  1. Try create (existing path)
  2. On P2002 (dedup index):
     a. Lookup existing listing by (seller_id, external_source, external_id)
     b. If existing.status in ('deleted', 'removed') → skip, report as skipped
     c. Check active-order guard → if active order, skip with reason
     d. Apply reconciliation: new_qty = MAX(0, csv_qty - (existing.qty_at_last_import - existing.quantity))
     e. Build update data (all syncable fields + reconciled quantity)
     f. If new_qty = 0: set status = 'sold'
     g. If new_qty > 0 and existing.status = 'sold': set status = 'active' (reactivate)
     h. Prisma update + attribute delete/recreate
     i. Set last_imported_at = NOW(), qty_at_last_import = csv_qty
     j. Report as 'updated' (new result category)
```

### Phase 4: Update ImportResult

```ts
export interface ImportResult {
  created: Array<{ id: string; title: string; external_id: string }>;
  updated: Array<{ id: string; title: string; external_id: string; qty_reconciled: number }>;
  skipped: Array<{ row: number; external_id: string; reason: string }>;
  failed: Array<{ row: number; reason: string }>;
  warnings: string[];
}
```

### Phase 5: Also set `last_imported_at` and `qty_at_last_import` on initial CREATE

So the fields are populated from the first import, ready for the first re-import.

### Phase 6: Tests (real-teeth)

| # | Test | What it proves |
|---|------|----------------|
| 1 | Reconciliation math: import qty 5 → sell 2 (mock qty=3) → re-import qty 4 → result qty 1 | Formula correctness |
| 2 | Reconciliation math: import qty 3 → sell 3 (mock qty=0, status=sold) → re-import qty 5 → result qty 2, status=active | Reactivation from sold |
| 3 | Re-import qty 0 → status becomes 'sold' | Off-sale handling |
| 4 | Active order on listing → row skipped with reason 'active_order' | Active-order guard |
| 5 | Deleted listing → row skipped, NOT resurrected | Status respect |
| 6 | Field sync: title/price/description updated, id/seller_id/views/favorites NOT clobbered | Field scope |
| 7 | `qty_at_last_import` and `last_imported_at` set on both create and update | Schema fields populated |
| 8 | First import creates, second import updates (same external_id) | Full pipeline end-to-end |

Standing anti-pattern rules apply:
1. Never mock the behaviour the test claims to prove
2. Never assert behaviour in CHANGES.md that you did not test
3. IDs are UUIDs, never Date.now() + Math.random()
4. Catch blocks must distinguish error codes

### Schema change discipline

- Prisma migration only (no `db push` for production)
- `prisma/migrations/20260624000000_import_reconciliation_fields/migration.sql`
- RDS snapshot before prod migrate (standing rule)
- Both columns nullable — no data backfill needed

---

## 8. OPEN QUESTIONS FOR HARRY

See `questions.md` — I-02c section.

---

## PROOF-OF-WORK

- Base SHA: `1fd4973` (`origin/pro-seller-foundation`)
- No source files modified — read-only investigation
- Output: this file + `questions.md` updates
