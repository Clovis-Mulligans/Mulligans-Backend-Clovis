# I-04 Questions & Security Checklist

## Security checklist

| Check | Result |
|---|---|
| Auth bypass | Both endpoints require `authenticateToken`. Tested: no-auth → 401. |
| Ownership bypass | Non-owner gets 404 (not 403, to avoid leaking listing existence). Tested. |
| Status transition injection | Only `active`/`reserved` → `off_sale` allowed. All other transitions return 409. Tested for every invalid source status. |
| Active order protection | Listings with orders in `['pending','paid','to_ship','shipped','in_transit','delivered']` cannot be taken off-sale. Returns 409 with descriptive message. |
| Input validation | No user-supplied body data — endpoints act on the listing ID only. No injection surface. |
| Mass assignment | No request body fields are written to the listing — status is hardcoded in the controller (`'off_sale'` / `'active'`). |
| Rate limiting | Inherits auth middleware but no dedicated rate limiter. Low risk — these are single-listing owner operations, not bulk. |
| Stripe gate bypass | Relist checks `stripe_connect_id` AND `stripe_connect_status === 'active'`. Pending/restricted/null all correctly blocked. Tested. |

## Questions for Harry

### Q1: `sellerCanReceivePayout` extraction

The Stripe payout check (`!!stripe_connect_id && stripe_connect_status === 'active'`) exists as a private function in `escrowService.ts:151`. I inlined the same logic in `relistListing` rather than modifying `escrowService.ts` to export it. Consider extracting to a shared utility if more endpoints need this gate (I-02b publish will).

**My recommendation:** Extract to `src/lib/stripeUtils.ts` in a follow-up. Not blocking.

### Q2: Push notification wording for off-sale expiry

When offers are expired via `expireOffersForSoldItem`, the notification says "has been sold to another buyer". For off-sale (not actually sold on Mulligans), this wording is slightly misleading. Options:
- A: Leave as-is (buyer just knows item is unavailable — good enough for v1)
- B: Create a separate `expireOffersForOffSaleItem` with different wording
- C: Add a `reason` parameter to `expireOffersForSoldItem`

**My recommendation:** A for now. The distinction doesn't matter to the buyer — the item is gone either way. Revisit if sellers report confusion.

### Q3: Dashboard error handling

The brief says "error toast on 409". The existing dashboard has no toast system — existing actions silently fail (catch blocks are empty). I used `alert()` for error display on the new off-sale/relist actions since it was the simplest approach that surfaces the server error message. Existing pause/resume/mark-sold actions still silently fail.

**My recommendation:** Add a proper toast component in a future UI pass. The `alert()` is functional for v1.
