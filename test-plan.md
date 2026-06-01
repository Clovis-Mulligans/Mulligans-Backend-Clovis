# Test Plan — Brief 2: Money-Safety Foundations

All tests must use **Stripe test mode** and a **staging/test database**. Never test against production.

---

## A1 — Return safety net (return_ship_deadline + 48h reminder)

1. **Deadline is set on label creation (buyer-pays path)**
   - Create a return request, purchase a buyer-pays label.
   - Assert `return_requests.return_ship_deadline` = now + 3 days.
   - Assert `return_requests.status` = `label_created`.

2. **Deadline is set on label creation (seller-pays path)**
   - Same as above but via the seller-pays endpoint.
   - Assert identical `return_ship_deadline` value.

3. **48h reminder fires once**
   - Manually set `return_ship_deadline` to 23 hours from now, `reminder_sent_at = NULL`.
   - Run `runEscrowJobs()`.
   - Assert a `return_reminder` notification was created for the buyer.
   - Assert `reminder_sent_at` is now set.
   - Run `runEscrowJobs()` again — assert NO duplicate notification.

4. **Auto-expire triggers correctly**
   - Set `return_ship_deadline` to 1 hour ago, status `label_created`.
   - Run `runEscrowJobs()`.
   - Assert return status = `cancelled`.
   - Assert linked dispute status = `admin_resolved`, resolution_type = `no_refund`, resolved_by = `system`.
   - Assert order status reset to `delivered` with new `escrow_release_at`.
   - Assert buyer NOT refunded.

---

## A2 — Idempotency + row locks on dispute resolution

5. **respondToDispute (accept): single refund + single transfer**
   - Create a dispute, call `respondToDispute` with `accept` twice in quick succession (parallel HTTP requests).
   - Assert exactly ONE refund in Stripe (check via `stripe.refunds.list`).
   - Assert `orders.stripe_refund_id` is set.
   - Assert `orders.stripe_transfer_id` is set (if < 100%).

6. **acceptCounterOffer: single refund + single transfer**
   - Create a dispute, seller counters at 50%, buyer accepts twice in quick succession.
   - Assert exactly ONE refund and ONE transfer in Stripe.

7. **acceptCounterOffer at 100%: no transfer attempted**
   - Seller counters at 100%, buyer accepts.
   - Assert refund created, assert NO `stripe.transfers.create` call for this dispute.
   - Assert `orders.stripe_transfer_id` remains null (no transfer needed).

8. **adminResolveDispute: single refund + single transfer**
   - Escalate a dispute, admin resolves with partial refund twice in quick succession.
   - Assert exactly ONE refund and ONE transfer in Stripe.

9. **adminResolveDispute: upper-bound validation (B4)**
   - Attempt `adminResolveDispute` with `resolutionAmount` > `orderAmount`.
   - Assert HTTP 400 with clear error message.

---

## A3 — Hardened confirmReceipt

10. **Double-call: single transfer**
    - Deliver an order, call `confirmReceipt` twice.
    - Assert exactly ONE transfer in Stripe.
    - Assert `orders.stripe_transfer_id` is stored.
    - Second call returns 400 ("already released").

11. **Blocked by active dispute**
    - Deliver an order, open a dispute, then call `confirmReceipt`.
    - Assert HTTP 400 ("active dispute blocking").

12. **Blocked by active return**
    - Deliver an order, create a return (status `approved`), call `confirmReceipt`.
    - Assert HTTP 400 ("active return blocking").

---

## What could not be executed

- No staging environment was available during implementation; all tests above are designed for manual or automated execution in a test environment.
- The SQL count for B5 (`SELECT COUNT(*) FROM orders WHERE seller_payout IS NULL AND status NOT IN ('cancelled')`) could not be run — Clovis does not have database access. Reported in `questions.md`.
- Row-lock concurrency tests (items 5, 6, 8) require two simultaneous HTTP requests and are best verified with a load testing tool (e.g., `ab`, `wrk`, or a simple script with `Promise.all`).
