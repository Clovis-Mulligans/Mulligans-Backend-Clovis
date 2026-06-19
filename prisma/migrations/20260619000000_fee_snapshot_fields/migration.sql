-- SB-02: Fee-Snapshot Schema Fields
-- Purely additive: adds nullable columns with defaults to the orders table.
-- No column drops, no type changes, no data rewrites.

ALTER TABLE "orders" ADD COLUMN "fee_model" TEXT;
ALTER TABLE "orders" ADD COLUMN "fee_payer" TEXT;
ALTER TABLE "orders" ADD COLUMN "fee_percent" DECIMAL(5,4);
ALTER TABLE "orders" ADD COLUMN "fee_fixed" DECIMAL(5,2);
ALTER TABLE "orders" ADD COLUMN "platform_fee_amount" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN "seller_is_pro_at_sale" BOOLEAN DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "insurance_charged" BOOLEAN DEFAULT true;
ALTER TABLE "orders" ADD COLUMN "checkout_group_ref" TEXT;

-- Backfill existing rows so historical orders are explicit, not NULL-ambiguous.
-- fee_percent, fee_fixed, platform_fee_amount, checkout_group_ref left NULL
-- on historical rows (already settled — no need to reconstruct amounts).
UPDATE "orders" SET
  "fee_model" = 'standard',
  "fee_payer" = 'buyer',
  "seller_is_pro_at_sale" = false,
  "insurance_charged" = true
WHERE "fee_model" IS NULL;
