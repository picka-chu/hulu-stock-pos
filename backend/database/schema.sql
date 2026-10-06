-- =====================================================
-- RETAILFLOW MULTI-TENANT POS SYSTEM DATABASE SCHEMA
-- Production-ready normalized database for Supabase PostgreSQL
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- ORGANIZATIONS (Tenants)
-- =====================================================
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    logo_url TEXT,
    brand_color VARCHAR(20) DEFAULT '#2563EB',
    currency VARCHAR(10) DEFAULT 'USD',
    tax_percentage DECIMAL(5,2) DEFAULT 0.00,
    subscription_plan VARCHAR(50) DEFAULT 'basic',
    tenant_type VARCHAR(32) NOT NULL DEFAULT 'retail' CHECK (tenant_type IN ('pharma', 'cosmetics', 'retail', 'supermarket')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for organization lookup
CREATE INDEX idx_organizations_name ON organizations(name);
CREATE INDEX idx_organizations_active ON organizations(is_active);

-- =====================================================
-- BRANCHES
-- =====================================================
CREATE TABLE branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    location TEXT,
    phone VARCHAR(50),
    email VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_branches_org ON branches(organization_id);
CREATE INDEX idx_branches_active ON branches(is_active);

-- =====================================================
-- USERS
-- =====================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_branch ON users(branch_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- =====================================================
-- CATEGORIES
-- =====================================================
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    color VARCHAR(20) DEFAULT '#6B7280',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_categories_org ON categories(organization_id);
CREATE INDEX idx_categories_branch ON categories(branch_id);

-- =====================================================
-- SUPPLIERS
-- =====================================================
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    address TEXT,
    contact_person VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suppliers_org ON suppliers(organization_id);
CREATE INDEX idx_suppliers_name ON suppliers(name);

-- =====================================================
-- UNITS
-- =====================================================
CREATE TABLE units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    abbreviation VARCHAR(20) NOT NULL,
    is_base BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, name),
    UNIQUE (organization_id, abbreviation)
);

CREATE INDEX idx_units_org ON units(organization_id);

-- =====================================================
-- ITEMS (PRODUCTS)
-- =====================================================
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    barcode VARCHAR(100),
    generic_name VARCHAR(255),
    brand_name VARCHAR(255),
    strength VARCHAR(100),
    dosage_form VARCHAR(100),
    controlled_substance BOOLEAN NOT NULL DEFAULT false,
    buy_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    sell_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    min_stock_level INTEGER NOT NULL DEFAULT 10,
    expiry_date DATE,
    batch_number VARCHAR(100),
    base_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    purchase_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    sale_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    image_url TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_items_org ON items(organization_id);
CREATE INDEX idx_items_branch ON items(branch_id);
CREATE INDEX idx_items_barcode ON items(barcode);
CREATE INDEX idx_items_category ON items(category_id);
CREATE INDEX idx_items_expiry ON items(expiry_date);
CREATE INDEX idx_items_low_stock ON items(stock_quantity) WHERE stock_quantity <= min_stock_level;

CREATE TABLE unit_conversions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    from_unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    to_unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    multiplier NUMERIC(18,6) NOT NULL CHECK (multiplier > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, item_id, from_unit_id, to_unit_id)
);

CREATE INDEX idx_unit_conversions_org ON unit_conversions(organization_id);
CREATE INDEX idx_unit_conversions_item ON unit_conversions(item_id);

CREATE TABLE item_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    batch_number VARCHAR(100),
    expiry_date DATE,
    received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
    quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    unit_cost DECIMAL(12,2),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_item_batches_item_fefo ON item_batches(item_id, is_active, expiry_date, received_at);
CREATE INDEX idx_item_batches_org_branch ON item_batches(organization_id, branch_id);

-- =====================================================
-- BANK ACCOUNTS
-- =====================================================
CREATE TABLE bank_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    account_name VARCHAR(255) NOT NULL,
    account_number VARCHAR(50),
    bank_name VARCHAR(255),
    balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bank_accounts_org ON bank_accounts(organization_id);
CREATE INDEX idx_bank_accounts_branch ON bank_accounts(branch_id);

-- =====================================================
-- SALES
-- =====================================================
CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    invoice_number VARCHAR(50) NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    net_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'partial', 'refunded', 'returned', 'partial_return')),
    payment_method VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sales_org ON sales(organization_id);
CREATE INDEX idx_sales_branch ON sales(branch_id);
CREATE INDEX idx_sales_user ON sales(user_id);
CREATE INDEX idx_sales_invoice ON sales(invoice_number);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_payment_status ON sales(payment_status);

-- =====================================================
-- SALE ITEMS
-- =====================================================
CREATE TABLE sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE SET NULL,
    item_name VARCHAR(255),  -- Snapshot of item name at time of sale
    quantity INTEGER NOT NULL,
    unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    base_quantity NUMERIC(18,6),
    unit_price DECIMAL(12,2) NOT NULL,
    cost_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total DECIMAL(12,2) NOT NULL,
    batch_id UUID REFERENCES item_batches(id) ON DELETE SET NULL,
    batch_number VARCHAR(100),
    batch_expiry_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_item ON sale_items(item_id);
CREATE INDEX idx_sale_items_batch ON sale_items(batch_id);

-- =====================================================
-- PAYMENTS
-- =====================================================
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN ('cash', 'bank', 'mobile_money', 'card')),
    amount DECIMAL(12,2) NOT NULL,
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    reference_number VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payments_sale ON payments(sale_id);
CREATE INDEX idx_payments_method ON payments(payment_method);

-- =====================================================
-- EXPENSES
-- =====================================================
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    amount DECIMAL(12,2) NOT NULL,
    expense_type VARCHAR(50) NOT NULL,
    expense_date DATE NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    receipt_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expenses_org ON expenses(organization_id);
CREATE INDEX idx_expenses_branch ON expenses(branch_id);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_type ON expenses(expense_type);

-- =====================================================
-- STOCK MOVEMENTS
-- =====================================================
CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('sale', 'restock', 'adjustment', 'return', 'transfer', 'expired', 'disposal')),
    quantity INTEGER NOT NULL,
    previous_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    reference_id UUID,
    reference_type VARCHAR(50),
    batch_id UUID REFERENCES item_batches(id) ON DELETE SET NULL,
    batch_number VARCHAR(100),
    batch_expiry_date DATE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_stock_movements_item ON stock_movements(item_id);
CREATE INDEX idx_stock_movements_branch ON stock_movements(branch_id);
CREATE INDEX idx_stock_movements_type ON stock_movements(type);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);
CREATE INDEX idx_stock_movements_batch ON stock_movements(batch_id);

-- =====================================================
-- CASH TRANSFERS (Cash to Bank)
-- =====================================================
CREATE TABLE cash_transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('cash_to_bank', 'bank_to_cash', 'cash_deposit', 'cash_withdrawal')),
    amount DECIMAL(12,2) NOT NULL,
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    reference_number VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cash_transfers_org ON cash_transfers(organization_id);
CREATE INDEX idx_cash_transfers_branch ON cash_transfers(branch_id);
CREATE INDEX idx_cash_transfers_status ON cash_transfers(status);
CREATE INDEX idx_cash_transfers_created ON cash_transfers(created_at);

-- =====================================================
-- SHIFTS
-- =====================================================
CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    start_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    end_amount DECIMAL(12,2) DEFAULT 0.00,
    expected_amount DECIMAL(12,2),
    actual_amount DECIMAL(12,2),
    difference DECIMAL(12,2),
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed', 'adjusted')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shifts_org ON shifts(organization_id);
CREATE INDEX idx_shifts_branch ON shifts(branch_id);
CREATE INDEX idx_shifts_user ON shifts(user_id);
CREATE INDEX idx_shifts_status ON shifts(status);

-- =====================================================
-- ACTIVITY LOG
-- =====================================================
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    description TEXT,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activity_logs_org ON activity_logs(organization_id);
CREATE INDEX idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_created ON activity_logs(created_at);

-- =====================================================
-- DEFAULT ADMIN USER FUNCTION
-- =====================================================
-- Create password hash function
CREATE OR REPLACE FUNCTION hash_password(password TEXT)
RETURNS TEXT AS $$
BEGIN
    return crypt(password, gen_salt('bf'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Verify password function
CREATE OR REPLACE FUNCTION verify_password(password TEXT, hash TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    return hash = crypt(password, hash);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create default admin user (password: admin123)
CREATE OR REPLACE FUNCTION create_default_admin()
RETURNS VOID AS $$
DECLARE
    org_id UUID;
    branch_id UUID;
    user_id UUID;
    password_hash TEXT;
BEGIN
    -- Create default organization
    INSERT INTO organizations (name, brand_color, currency, tax_percentage, subscription_plan)
    VALUES ('Demo Store', '#2563EB', 'USD', 10.00, 'premium')
    RETURNING id INTO org_id;

    -- Create default branch
    INSERT INTO branches (organization_id, name, location, phone, email)
    VALUES (org_id, 'Main Branch', '123 Main Street', '+1234567890', 'info@demostore.com')
    RETURNING id INTO branch_id;

    -- Create default admin user (password: admin123)
    -- Using bcrypt hash for 'admin123'
    password_hash := '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYqKXlHXrTW';
    
    INSERT INTO users (organization_id, branch_id, full_name, phone, email, password_hash, role)
    VALUES (org_id, branch_id, 'System Admin', '+1234567890', 'admin@demostore.com', password_hash, 'admin')
    RETURNING id INTO user_id;

    -- Create sample categories
    INSERT INTO categories (organization_id, branch_id, name, description, color) VALUES
    (org_id, branch_id, 'Groceries', 'Daily grocery items', '#10B981'),
    (org_id, branch_id, 'Cosmetics', 'Beauty and skincare products', '#EC4899'),
    (org_id, branch_id, 'Beverages', 'Drinks and beverages', '#3B82F6'),
    (org_id, branch_id, 'Snacks', 'Confectionery and snacks', '#F59E0B'),
    (org_id, branch_id, 'Household', 'Home and kitchen items', '#8B5CF6');

    -- Create sample supplier
    INSERT INTO suppliers (organization_id, name, phone, email, address) VALUES
    (org_id, 'Global Supplies Ltd', '+1987654321', 'supplier@global.com', '456 Supply Chain Ave'),
    (org_id, 'Premium Distributors', '+1555123456', 'orders@premium.com', '789 Distribution Blvd');

    -- Create sample bank account
    INSERT INTO bank_accounts (organization_id, branch_id, account_name, account_number, bank_name, balance) VALUES
    (org_id, branch_id, 'Business Account', '1234567890', 'First National Bank', 50000.00),
    (org_id, branch_id, 'Petty Cash', '0987654321', 'Cash Box', 10000.00);

    RAISE NOTICE 'Default data created successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Execute to create default data
-- SELECT create_default_admin();

-- =====================================================
-- VIEWS FOR REPORTS
-- =====================================================

-- Daily Sales Summary View
CREATE OR REPLACE VIEW v_daily_sales AS
SELECT 
    s.organization_id,
    s.branch_id,
    DATE(s.created_at) as sale_date,
    COUNT(s.id) as total_transactions,
    SUM(s.net_amount) as total_revenue,
    SUM(s.tax_amount) as total_tax,
    SUM(s.discount_amount) as total_discount,
    SUM(s.total_amount) as gross_sales
FROM sales s
WHERE s.payment_status = 'paid'
GROUP BY s.organization_id, s.branch_id, DATE(s.created_at);

-- Low Stock Items View
CREATE OR REPLACE VIEW v_low_stock_items AS
SELECT 
    i.id,
    i.organization_id,
    i.branch_id,
    i.name,
    i.barcode,
    i.stock_quantity,
    i.min_stock_level,
    c.name as category_name,
    s.name as supplier_name
FROM items i
LEFT JOIN categories c ON i.category_id = c.id
LEFT JOIN suppliers s ON i.supplier_id = s.id
WHERE i.stock_quantity <= i.min_stock_level AND i.is_active = true;

-- Expiring Items View (7 days)
CREATE OR REPLACE VIEW v_expiring_items AS
SELECT 
    i.id,
    i.organization_id,
    i.branch_id,
    i.name,
    i.barcode,
    i.expiry_date,
    i.stock_quantity,
    i.batch_number,
    c.name as category_name,
    (i.expiry_date - CURRENT_DATE) as days_until_expiry
FROM items i
LEFT JOIN categories c ON i.category_id = c.id
WHERE i.expiry_date IS NOT NULL 
    AND i.expiry_date <= CURRENT_DATE + INTERVAL '7 days'
    AND i.stock_quantity > 0
    AND i.is_active = true
ORDER BY i.expiry_date ASC;

-- =====================================================
-- ROW LEVEL SECURITY POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

-- Organizations: service role only (backend uses service key which bypasses RLS;
-- direct anon-key access is denied). See migration_011_tighten_rls.sql.
CREATE POLICY "orgs_service_only" ON organizations FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Branches: service role only
CREATE POLICY "branches_service_only" ON branches FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Note: Backend uses the Supabase service key which bypasses RLS.
-- These policies deny direct PostgREST access with the anon key.

-- =====================================================
-- STORAGE BUCKET FOR IMAGES
-- =====================================================
-- Run in Supabase Dashboard > Storage > Create bucket "product-images"
-- Set as public bucket
-- Add storage policy to allow authenticated uploads

-- =====================================================
-- NOTIFICATIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    notification_type VARCHAR(50) NOT NULL DEFAULT 'system_alert',
    is_read BOOLEAN DEFAULT false,
    related_id UUID,
    link VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_org     ON notifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read    ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- Enable RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Allow the service role (backend) full access; deny anon key
CREATE POLICY "notifications_service_all" ON notifications
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
