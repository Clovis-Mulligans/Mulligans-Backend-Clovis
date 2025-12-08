-- CreateTable
CREATE TABLE "listing_attributes" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_attributes_listing_id_idx" ON "listing_attributes"("listing_id");

-- CreateIndex
CREATE INDEX "listing_attributes_key_idx" ON "listing_attributes"("key");

-- CreateIndex
CREATE INDEX "listing_attributes_key_value_idx" ON "listing_attributes"("key", "value");

-- AddForeignKey
ALTER TABLE "listing_attributes" ADD CONSTRAINT "listing_attributes_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;