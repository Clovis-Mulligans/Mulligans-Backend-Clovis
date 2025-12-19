-- Add listing snapshot fields to orders table
-- This preserves listing data even if the listing is later deleted

ALTER TABLE "orders" ADD COLUMN "listing_title" TEXT;
ALTER TABLE "orders" ADD COLUMN "listing_image" TEXT;
ALTER TABLE "orders" ADD COLUMN "listing_price" DECIMAL(10, 2);

-- Backfill existing orders with current listing data
UPDATE "orders" o
SET 
  listing_title = l.title,
  listing_price = l.price,
  listing_image = (
    SELECT image_url 
    FROM images i 
    WHERE i.listing_id = o.listing_id 
    ORDER BY display_order ASC 
    LIMIT 1
  )
FROM listings l
WHERE o.listing_id = l.id
AND o.listing_title IS NULL;