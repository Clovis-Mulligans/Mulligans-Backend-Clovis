-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "default_shipping_cost" DECIMAL(10,2),
ADD COLUMN     "offers_free_shipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "postcode_area" TEXT,
ADD COLUMN     "preferred_carriers" TEXT;
