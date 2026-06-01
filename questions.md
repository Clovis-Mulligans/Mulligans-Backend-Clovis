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
