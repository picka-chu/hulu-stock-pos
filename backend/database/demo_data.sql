-- =====================================================
-- DEMO USER CREATION SCRIPT
-- Run this in Supabase SQL Editor to create demo user
-- =====================================================

-- First, run the schema.sql file to create all tables

-- Then run this script to create the demo admin user
-- Password: admin123

-- Insert demo organization
INSERT INTO organizations (id, name, subscription_plan, brand_color, currency, tax_percentage, created_at, updated_at)
VALUES 
    ('11111111-1111-1111-1111-111111111111', 'Demo Store', 'premium', '#2563EB', 'USD', 10.00, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Insert demo branch
INSERT INTO branches (id, organization_id, name, location, phone, email, is_active, created_at, updated_at)
VALUES 
    ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Main Branch', '123 Demo Street', '+1234567890', 'info@demostore.com', true, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Insert admin user (password: admin123)
-- The hash $2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYqKXlHXrTW is the bcrypt hash of 'admin123'
INSERT INTO users (id, organization_id, branch_id, full_name, phone, email, password_hash, role, is_active, created_at, updated_at)
VALUES 
    ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Demo Admin', '+1234567890', 'admin@demostore.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYqKXlHXrTW', 'admin', true, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Insert demo categories
INSERT INTO categories (id, organization_id, branch_id, name, description, color, created_at, updated_at)
VALUES 
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Groceries', 'Daily grocery items', '#10B981', NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Cosmetics', 'Beauty and skincare products', '#EC4899', NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Beverages', 'Drinks and beverages', '#3B82F6', NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Snacks', 'Confectionery and snacks', '#F59E0B', NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Household', 'Home and kitchen items', '#8B5CF6', NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Insert demo suppliers
INSERT INTO suppliers (id, organization_id, name, phone, email, address, is_active, created_at, updated_at)
VALUES 
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Global Supplies Ltd', '+1987654321', 'supplier@global.com', '456 Supply Chain Ave', true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Premium Distributors', '+1555123456', 'orders@premium.com', '789 Distribution Blvd', true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Insert demo bank accounts
INSERT INTO bank_accounts (id, organization_id, branch_id, account_name, account_number, bank_name, balance, is_active, created_at, updated_at)
VALUES 
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Business Account', '1234567890', 'First National Bank', 50000.00, true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Petty Cash', '0987654321', 'Cash Box', 10000.00, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Insert demo items (products)
INSERT INTO items (id, organization_id, branch_id, name, description, barcode, buy_price, sell_price, stock_quantity, min_stock_level, is_active, created_at, updated_at)
VALUES 
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Organic Milk', 'Fresh organic milk 1L', 'MILK001', 2.50, 4.99, 50, 10, true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Fresh Bread', 'Whole wheat bread', 'BREAD001', 1.50, 3.49, 30, 10, true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Orange Juice', 'Fresh orange juice 1L', 'JUICE001', 3.00, 5.99, 25, 10, true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Shampoo', 'Anti-dandruff shampoo', 'SHAM001', 5.00, 8.99, 40, 10, true, NOW(), NOW()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Face Cream', 'Moisturizing face cream', 'FACE001', 8.00, 12.99, 20, 10, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

SELECT 'Demo data created successfully!' as message;
