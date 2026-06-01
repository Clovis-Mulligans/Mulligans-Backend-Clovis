-- Brief 2: Money Safety Foundations
-- Additive-only, nullable columns — safe to roll back (code tolerates NULL).

-- B3: Buyer deadline on counter_offered disputes (72h for buyer to respond)
ALTER TABLE "disputes" ADD COLUMN "buyer_deadline" TIMESTAMP(3);

-- A1: Track whether the 48h return-ship reminder has been sent (fire-once guard)
ALTER TABLE "return_requests" ADD COLUMN "reminder_sent_at" TIMESTAMP(3);
