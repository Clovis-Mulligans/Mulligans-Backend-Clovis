# I-02b Questions & Security Checklist

## Security checklist

| Check | Result |
|---|---|
| Auth bypass | All three endpoints require `authenticateToken`. Tested: no-auth → 401. |
| Ownership bypass | Single publish: non-owner gets 404. Bulk: foreign ID → 403 (immediate halt). Tested. |
| Status transition injection | Only `draft` → `active` allowed. All other statuses return 409. Tested per status. |
| Input validation | Single publish: no user body needed (acts on listing ID). Bulk: `listing_ids` validated as non-empty array, capped at 500. |
| Mass assignment | No request body fields written to listing. Status hardcoded as `'active'`. |
| Bulk abuse | 500-item cap prevents unbounded DB queries. Payout check runs once (not per-listing). |
| Completeness bypass | Validation mirrors create-listing Zod requirements. Draft with missing fields or no images cannot publish. |
| Stripe gate bypass | `sellerIsPayoutReady` checks both `stripe_connect_id` AND `stripe_connect_status === 'active'`. Null/pending/restricted all blocked. |
| Rate limiting | No dedicated limiter — low risk (owner-only, authenticated). Could add if abuse detected. |

## Questions for Harry

### Q1: Image requirement at publish

Normal listing creation doesn't enforce images at the API level (they're uploaded separately). The publish endpoint now requires ≥1 image. This means:
- CSV-imported drafts (I-02) are unpublishable until images are attached (I-03)
- Manually created drafts via the dashboard are also unpublishable without images

This is intentional — a listing with no images shouldn't be active on the marketplace. Confirming this is the right call.

### Q2: Bulk publish partial success — foreign IDs as not_found

The bulk endpoint uses partial-success semantics throughout: valid drafts publish, invalid ones are skipped with reasons. Foreign-owned listings are treated identically to nonexistent IDs (`not_found`) — consistent with the single-publish endpoint's 404-for-non-owner pattern, avoids an existence oracle, and prevents mid-batch 403 from leaving earlier rows published while reporting failure.

Alternative: strict mode where any invalid listing fails the whole batch. I went with partial success because the brief specified it and it's more practical for 50-500 item batches.

### Q3: escrowService consolidation deferred

`escrowService.sellerCanReceivePayout` is a synchronous private function taking a pre-fetched seller object. The new `sellerIsPayoutReady` is async and fetches the seller itself. Different interfaces serve different callers — escrow already has the seller loaded; controllers don't. Left escrow untouched to avoid changing escrow internals.
