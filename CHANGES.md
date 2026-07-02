# PRO-IMPORT-I-06: Re-import upsert (SKU sync with delta-method quantity reconciliation)

Branch: `task/pro-import-i06-upsert` from `clovis/pro-seller-foundation` at `4160e0d`

## I-02c Findings Followed

- Delta-method formula from `PRO-IMPORT-I-02c-MAP.md` section 1.5
- Active-order guard pattern from section 3 (reuse `ACTIVE_ORDER_STATUSES`)
- Price snapshot safety analysis from section 2 (Stripe locks amount at session creation — no new risk)
- Dedup-index lookup from section 4.3 (`findFirst` by seller+source+external_id)
- Full field re-sync scope from sections 6.1/6.2

## Reconciliation Logic

### Delta method (from I-02c, proven correct)

```
units_consumed = qty_at_last_import - current_listing.quantity
new_quantity   = MAX(0, csv_qty - units_consumed)
```

**Worked example:** Import qty 5 -> 2 sell -> 1 returned (qty now 4) -> CSV says 4
- `units_consumed = 5 - 4 = 1`
- `new_quantity = MAX(0, 4 - 1) = 3`

**NULL-anchor rule (first touch):** If `qty_at_last_import` is NULL (legacy listing, never imported with this feature), treat `units_consumed = 0`. Result: `new_quantity = csv_qty`. This "start from now" anchor means the first re-import after deployment trusts the CSV verbatim — correct for listings that have no import baseline.

**MAX(0) clamp:** If `units_consumed > csv_qty`, new_quantity floors at 0. This triggers the off_sale transition. Example: import qty 2, 3 sell (impossible normally but handles concurrent edge cases) -> consumed=3, csv says 1 -> MAX(0, 1-3) = 0.

### Anchors

- `qty_at_last_import`: Set to the CSV quantity value (not the reconciled quantity) on every create and update. NOT set on skipped rows (their anchor must stay consistent with their untouched qty).
- `last_imported_at`: Set to `NOW()` on every create and update. NOT set on skipped rows.

## Status Transition Matrix

| Current status | new_qty | Gates pass? | New status | Side-effects | Response |
|---|---|---|---|---|---|
| `draft` | any | N/A | `draft` | None | `updated` |
| `active` | >= 1 | N/A | `active` | None | `updated` |
| `active` | 0 | N/A | `off_sale` | Clear carts + expire offers (reuse I-04 pattern) | `updated` |
| `off_sale` | >= 1 | Yes | `active` | None | `updated (reactivated)` |
| `off_sale` | >= 1 | No | `off_sale` | None | `updated` + warning `restock_blocked` |
| `off_sale` | 0 | N/A | `off_sale` | None | `updated` |
| `sold` | >= 1 | Yes | `active` | None | `updated (reactivated)` |
| `sold` | >= 1 | No | `sold` | None | `updated` + warning `restock_blocked` |
| `sold` | 0 | N/A | `sold` | None | `updated` |
| `deleted` | >= 1 | Yes | `active` | None | `updated (reactivated)` |
| `deleted` | >= 1 | No | `draft` | None | `updated (reactivated)` |
| `deleted` | 0 | N/A | `draft` | None | `updated (reactivated)` |
| `removed` | any | N/A | `removed` | None | `skipped (removed)` |
| any with active order | any | N/A | unchanged | None | `skipped (active_order)` |
| size-variant (sizeQuantities) | any | N/A | unchanged | None | `skipped (size_variant_unsupported)` |

**Gates:** `sellerIsPayoutReady` (checked ONCE per import run, cached) AND `validateListingCompleteness` (per-listing).

**Reactivation gate for completeness:** uses merged listing data (existing + CSV updates) and existing image count. Imported listings typically have 0 images until I-03, so completeness will fail on the image gate — listings reactivate to `draft` instead of `active`. This is correct: a listing without images should not go live.

## Guard Order (per matched row)

1. `removed` status -> skip (platform moderation wins over CSV)
2. Active-order check (`ACTIVE_ORDER_STATUSES`) -> skip (in-flight order safety)
3. Size-variant check (`specifications.sizeQuantities` non-null object) -> skip (per-size stock not reconcilable by flat CSV qty — QTY-AUDIT C-1 family)
4. Apply reconciliation + field sync + status transition

## Field Re-sync Scope

**CSV wins (syncable):** title, description, price, category, subcategory, brand, model, condition_overall, location, is_negotiable, parcel_size, shipping_cost, specifications

**Frozen (never touched):** id, seller_id, status (managed by transition rules above), original_price, currency, is_featured, views, favorites_count, created_at, updated_at (system-managed), deleted_at, ball_condition_type, condition_head, condition_shaft, condition_grip, images (separate system)

**Change tracking:** Response includes `changed_fields[]` per updated row. Price changes generate a warning: `"price changed: <old> -> <new>"`.

## Response Schema (additive, backwards-compatible)

```typescript
interface ImportResult {
  created:  Array<{ id, title, external_id }>;                                    // existing
  updated:  Array<{ id, title, external_id, changed_fields[], reactivated? }>;    // NEW
  skipped:  Array<{ row, external_id, reason }>;                                  // NEW
  failed:   Array<{ row, reason }>;                                               // existing
  warnings: string[];                                                              // existing
}
```

Existing consumers reading only `created`, `failed`, `warnings` are unaffected. The `updated` and `skipped` arrays are additive. Rows previously reported as `failed: 'duplicate'` now appear in `updated` or `skipped`.

## Out of Scope (explicitly deferred)

- Absent-from-file auto-deactivation + >20-30% safety guard (needs import-session concept)
- Size-variant import support (per-size qty in CSV → sizeQuantities reconciliation)
- Image handling (I-03)
- Dashboard wiring (I-05)
- XLSX support

## Implementation

### Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `last_imported_at DateTime?`, `qty_at_last_import Int?` to listings model |
| `prisma/migrations/20260702000000_import_reconciliation_fields/migration.sql` | Additive migration: two nullable columns |
| `src/lib/listingCompleteness.ts` | **New** — extracted `validateListingCompleteness` from controller |
| `src/services/importService.ts` | Rewritten: lookup-first upsert, delta reconciliation, status transitions, full field re-sync |
| `src/controllers/listingController.ts` | Imports shared `validateListingCompleteness`, removes static method duplicate |
| `src/__tests__/unit/csvImport.test.ts` | Updated: extended mock for upsert, test 2 updated for upsert behaviour |
| `src/__tests__/unit/importUpsert.test.ts` | **New** — comprehensive upsert tests |

### Architecture decision: lookup-first vs P2002-catch

The I-02 create path used try-create / catch-P2002-as-duplicate. The upsert changes to lookup-first:

1. `findFirst` by (seller_id, external_source, external_id) — indexed by `listings_external_dedup`
2. If found -> update path (guards, reconciliation, status transition)
3. If not found -> create path (existing I-02 logic + anchor stamps)
4. P2002 catch remains as a race-condition fallback

Rationale: the update path needs the existing listing data anyway for guards and reconciliation. A create-then-catch wastes a DB round-trip on every match. The TOCTOU gap is acceptable — concurrent imports by the same seller for the same CSV are operationally impossible (rate-limited, single-session).

## Tests — teeth-checks

| # | Test | What it proves | Teeth-check |
|---|---|---|---|
| 1 | I-02c worked example: 5->sell 2->return 1->CSV 4->result 3 | Delta formula correctness | Change formula -> wrong qty |
| 2 | MAX(0) clamp: consumed > CSV -> 0 -> off_sale fires | Floor clamp + off_sale transition | Remove MAX(0) -> negative qty |
| 3 | Active-order row: nothing mutates, reason correct | Active-order guard | Remove guard -> row updated |
| 4 | `removed` skip | Platform moderation respected | Remove guard -> row updated |
| 5 | `deleted` reactivation (gates pass) -> active | Reactivation from deleted | Remove reactivation -> stays deleted |
| 6 | `deleted` reactivation (gates fail) -> draft | Failed-gate fallback | Remove fallback -> stays deleted |
| 7 | off_sale restock (gates pass) -> active | Reactivation from off_sale | Remove gate -> stays off_sale |
| 8 | off_sale restock (gates fail) -> stays off_sale + warning | Warning on blocked restock | Remove gate -> reactivates without check |
| 9 | sold restock (gates pass) -> active | Reactivation from sold | Remove reactivation -> stays sold |
| 10 | NULL-anchor first touch -> csv_qty verbatim | Start-from-now anchor | Set consumed=NaN -> wrong qty |
| 11 | Full re-sync: changed fields reported, price warning | Change tracking fidelity | Remove field tracking -> empty changed_fields |
| 12 | Anchors stamped on create | Create path stamps both columns | Remove stamps -> null |
| 13 | Anchors stamped on update, NOT on skip | Skip preserves anchor consistency | Stamp on skip -> wrong baseline |
| 14 | Create-path regression: new rows still create as draft | Upsert doesn't break creates | Break create path -> test fails |
| 15 | Same batch: one create + one update | Mixed batch correctness | N/A (integration) |
| 16 | off_sale side-effects: carts cleared, offers expired | I-04 pattern reuse | Remove side-effects -> test fails |
| 17 | Payout readiness cached (checked once) | Performance: 1 DB call not N | Mock tracks call count |
| 18 | sold restock (gates fail) -> stays sold + warning | Warning on blocked sold restock | Remove gate -> reactivates |
| 22 | Size-variant listing -> skipped, all fields + anchors unchanged | sizeQuantities guard | Remove guard -> row updated, per-size stock corrupted |
| 23 | removed + size-variant -> skipped as "removed" | Guard order: removed before size-variant | Swap order -> wrong skip reason |
| 24 | Non-size-variant specs -> updated normally | Guard doesn't over-match | Widen check -> false positives |

## Deploy notes

1. **Database migration:** `npx prisma generate` before build; `npx prisma migrate deploy` on production (after RDS snapshot). Two nullable columns, no data backfill.
2. **Dev environment:** Use `npx prisma db push` (dev migration history is broken — project convention).
3. Backend deploy: standard `npm run build` + PM2 restart.
4. New file: `src/lib/listingCompleteness.ts` — ensure included in build output.
5. Backwards-compatible: same endpoint, richer response.
