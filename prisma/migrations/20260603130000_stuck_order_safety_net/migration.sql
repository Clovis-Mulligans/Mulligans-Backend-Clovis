-- Stuck-order safety net: track blocked payouts
ALTER TABLE "orders" ADD COLUMN "payout_blocked_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "payout_reminder_sent_at" TIMESTAMP(3);
CREATE INDEX "idx_orders_payout_blocked" ON "orders" ("payout_blocked_at") WHERE "payout_blocked_at" IS NOT NULL;
