# PRO-IMPORT-I-06 — Questions and Security Checklist

## Security Checklist

### 1. Ownership enforcement
The import endpoint requires `authenticateToken` middleware. `importListings` receives `sellerId` from `req.user.id` (JWT-verified). All lookups are scoped to `seller_id: sellerId` — a seller cannot read, update, or skip another seller's listings via CSV import. **Status: covered.**

### 2. Price mutation safety
Re-import can change `listings.price`. The I-02c investigation (section 2) confirmed: Stripe locks the charge amount at checkout session creation. A price change between cart-add and checkout-start is existing behaviour (identical to a seller manually editing price). The active-order guard prevents mutation while an order is in flight. **Status: safe, no new risk introduced.**

### 3. Quantity inflation
The delta method prevents phantom stock creation. `new_quantity = MAX(0, csv_qty - units_consumed)` always deducts Mulligans sales from the CSV quantity. Manual Mulligans-side quantity edits between imports will be overridden (CSV is source of truth — documented in I-02c). **Status: covered by design.**

### 4. Status escalation
Re-import cannot set arbitrary statuses. Status transitions are hardcoded in the service logic, not derived from CSV input. The `removed` status (platform moderation) is always respected — CSV cannot override it. **Status: covered.**

### 5. Reactivation gates
Reactivation from off_sale/sold/deleted to active requires: (a) `sellerIsPayoutReady` (Stripe Connect active), and (b) `validateListingCompleteness` (all required fields + >= 1 image). Listings without images (typical for imports before I-03) cannot reach `active` — they fall to `draft`. **Status: covered.**

### 6. Rate limiting
The import route has `importLimiter` (rate-limit middleware) and a 200-row cap. No change from I-02. **Status: unchanged.**

### 7. Off-sale side-effects
When `active` → `off_sale` via qty depletion: offers are expired (`expireOffersForSoldItem`) and cart items are cleared (`cart_items.deleteMany`). Same pattern as I-04 `markOffSale`. **Status: reused, not duplicated.**

## Questions for Harry

### Q1: Manual Mulligans-side edits between imports
If a seller manually edits a listing's title, description, or price on Mulligans between CSV imports, the next import will overwrite those edits with the CSV values (full re-sync, CSV wins). This is correct for pro sellers using CSV as their source of truth, but could surprise sellers who mix manual edits with CSV imports. 

**Recommendation:** Accept for v1. If complaints arise, add a future `sync_mode` parameter (`'full' | 'qty_price_only'`). Worth noting in pro seller documentation.

### Q2: Image completeness gate on reactivation
Imported listings typically have 0 images (I-03 handles image import). This means reactivation from off_sale/sold/deleted will almost always fail the completeness gate and produce `draft` instead of `active`. This is intentionally conservative — a listing without images shouldn't go live.

**Impact:** Sellers who want to restock imported listings must either (a) attach images first via the dashboard, or (b) wait for I-03. The import response includes a `restock_blocked` warning explaining why.

### Q3: `deleted` reactivation scope
The brief says `deleted → REACTIVATE (locked)`. This means a seller can un-delete a listing by including its SKU in a CSV re-import. This differs from `removed` (platform action, permanent). Is this the desired behaviour? It means soft-deletion is reversible via import — a seller who manually deletes a listing on Mulligans and then re-imports their CSV will have it resurrected.

**Recommendation:** This is probably correct for the pro seller workflow (CSV is truth), but worth confirming. If not desired, change to skip like `removed`.

### Q4: Dev re-import verification
The upsert logic is tested with mocked Prisma. Dev verification with a real database is recommended before production deploy:
1. Import a CSV (creates drafts)
2. Manually change a listing's quantity (simulating a sale)
3. Re-import the same CSV
4. Verify the reconciled quantity matches the delta method formula
5. Verify `last_imported_at` and `qty_at_last_import` are set correctly

### Q5: Migration timing
The migration adds two nullable columns with no backfill. This is safe for a live deploy (no table lock, no data migration). However, the `prisma generate` step must run before the application build, and `prisma migrate deploy` must run before the application starts. The deploy script should enforce this order.
