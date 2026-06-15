-- Shipment-not-scanned deadline: 4 new columns + index on orders
-- Tracks a shipping deadline that survives label creation (unlike auto_cancel_at),
-- plus idempotency timestamps for grace notification, recovery, and escalation.

ALTER TABLE "orders" ADD COLUMN "shipment_deadline_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "grace_notified_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "grace_recovered_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "shipment_escalated_at" TIMESTAMP(3);

CREATE INDEX "orders_shipment_deadline_at_idx" ON "orders"("shipment_deadline_at");
