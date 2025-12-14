-- Add quantity to cart_items table (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'cart_items' AND column_name = 'quantity') THEN
        ALTER TABLE cart_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
    END IF;
END $$;

-- Add quantity to orders table (if not exists)  
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'orders' AND column_name = 'quantity') THEN
        ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
    END IF;
END $$;