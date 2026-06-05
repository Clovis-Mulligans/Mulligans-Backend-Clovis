# Questions — Brief 2: Money-Safety Foundations

## 5A-BUG-1: Legacy orders with seller_payout = NULL

**Count not executed.** Clovis does not have database access (per safety rules).

Harry — please run this read-only query on a staging/prod read-replica:

```sql
SELECT COUNT(*) FROM orders WHERE seller_payout IS NULL AND status NOT IN ('cancelled');
```

This tells us how many active/completed orders used the old fallback formula that underpaid sellers. The fix (routing through `feeCalculations.ts`) is deployed for new disputes, but a backfill of historical `seller_payout` values is a separate decision.

**Recommendation:** If the count is > 0, backfill `seller_payout` for those orders using the `calculateSellerPayout()` formula from `src/lib/feeCalculations.ts`. This is a data migration, not a code change — should be done as a one-off script reviewed before execution.

---

## Security scan — auth/role checks

All touched endpoints retain their existing auth middleware:
- `respondToDispute`: `authenticateToken` + seller ownership check (unchanged)
- `acceptCounterOffer`: `authenticateToken` + buyer ownership check (unchanged)
- `adminResolveDispute`: `adminAuth` middleware (unchanged)
- `confirmReceipt`: `authenticateToken` + buyer ownership check (unchanged)
- Removed `POST /auto-escalate` endpoint (was behind `adminAuth`, now handled by cron only — reduces attack surface)

No new injection or validation gaps introduced. B4 adds upper-bound validation on `resolutionAmount` that was previously missing.

---

## No Tier A items proved larger than scoped

All three Tier A items were implemented as specified. The row-lock pattern (Prisma `$queryRaw` + `SELECT FOR UPDATE` inside `$transaction`) is the standard approach for Prisma's lack of native row-level locking. It adds one raw query per resolution call — negligible overhead given these are low-frequency operations.

---

# Questions — Brief: Conditional Push Copy (sale notifications)

## skippedReason availability at each call site

| Site | File:Line | Has skippedReason? | Notes |
|------|-----------|-------------------|-------|
| 1. Cart checkout | `src/controllers/cartCheckoutController.ts:909` | YES (after fix) | Previously stored only `result.success` (boolean). Changed `autoLabelResults` to `Record<string, { success: boolean; skippedReason?: string }>`. For cart (multi-item), uses first failed order's `skippedReason`. |
| 2. Native single-item | `src/controllers/nativePaymentController.ts:782` | YES (after fix) | Previously typed as `{ success: boolean; labelUrl?; trackingNumber? }`, losing `skippedReason`. Added `skippedReason?: string` to the local type. |
| 3. Native cart | `src/controllers/nativePaymentController.ts:1137` | YES (after fix) | Same pattern as site 1 — changed `Record<string, boolean>` to `Record<string, { success: boolean; skippedReason?: string }>`. |
| 4. Stripe webhook | `src/controllers/stripeController.ts:910` | YES (after fix) | Same pattern as site 2 — added `skippedReason?: string` to local type. |

All 4 sites now have access to `skippedReason` from the `autoPurchaseLabel` return value. No site requires a generic fallback due to missing data.

## Confirmation: no inline notification copy duplication remains

All 4 sites now call `getSaleNotificationCopy(allLabelsReady, skippedReason)` from `src/lib/saleNotificationCopy.ts`. No inline title/body/type construction remains in any controller. Verified by checking the diff removes all ternary-based notification copy and replaces with a single destructured call.

## Security scan

- **PII leakage:** The notification copy does NOT include any user-specific data (no names, addresses, emails, or order IDs in title/body). Safe.
- **Notification types preserved:** The helper returns exactly `'sale_label_ready'` or `'sale_action_required'` — the same two types used before. Deep-linking behaviour is unchanged.
- **No new attack surface:** The helper is a pure function with no I/O, no database access, and no external calls.

## Deviations from brief

None. All 4 sites updated as specified. TypeScript compiles clean (`npx tsc --noEmit` passes with no errors).
