-- Migration: Add item_name snapshot column to sale_items
-- Run this on your existing Supabase database

-- 1. Add item_name column to sale_items
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS item_name VARCHAR(255);

-- 2. Backfill item_name from items table for existing records
UPDATE sale_items si
SET item_name = i.name
FROM items i
WHERE si.item_id = i.id AND si.item_name IS NULL;

-- 3. Make item_id nullable (so deleted items don't break the foreign key)
ALTER TABLE sale_items ALTER COLUMN item_id DROP NOT NULL;

-- 4. Add sold_by column to sales if it doesn't exist
ALTER TABLE sales ADD COLUMN IF NOT EXISTS sold_by VARCHAR(255);

-- 5. Backfill sold_by from users table
UPDATE sales s
SET sold_by = u.full_name
FROM users u
WHERE s.user_id = u.id AND s.sold_by IS NULL;

-- Verify
SELECT 'Migration complete. sale_items now has item_name column.' as status;
