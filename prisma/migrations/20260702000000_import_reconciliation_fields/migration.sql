ALTER TABLE "listings" ADD COLUMN "last_imported_at" TIMESTAMPTZ;
ALTER TABLE "listings" ADD COLUMN "qty_at_last_import" INT;
