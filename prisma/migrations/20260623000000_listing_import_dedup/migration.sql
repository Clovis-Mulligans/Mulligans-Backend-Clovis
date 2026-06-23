ALTER TABLE "listings" ADD COLUMN "external_source" TEXT;
ALTER TABLE "listings" ADD COLUMN "external_id" TEXT;

CREATE UNIQUE INDEX "listings_external_dedup"
  ON "listings" ("seller_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL;
