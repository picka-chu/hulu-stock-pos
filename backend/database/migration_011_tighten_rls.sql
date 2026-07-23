-- Migration 011: Tighten RLS Policies
-- Replaces the open USING(true) policies with proper service-role bypass.
-- The backend uses the service key which bypasses RLS entirely,
-- so these policies protect against direct Supabase API access with the anon key.

-- ═══════════════════════════════════════════════════════════════════════════
-- STRATEGY: deny everything to anon/authenticated roles by default.
-- The backend service key bypasses RLS (Supabase default behaviour).
-- This means: direct requests to Supabase with the anon key return nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Organizations ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "orgs_select" ON organizations;
DROP POLICY IF EXISTS "orgs_insert" ON organizations;
DROP POLICY IF EXISTS "orgs_update" ON organizations;
DROP POLICY IF EXISTS "orgs_delete" ON organizations;

-- Only service role (backend) can read/write organizations
CREATE POLICY "orgs_service_only" ON organizations
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Items: only service role ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "items_service_all" ON items;
CREATE POLICY "items_service_all" ON items
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Sales: only service role ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "sales_service_all" ON sales;
CREATE POLICY "sales_service_all" ON sales
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Sale items: only service role ────────────────────────────────────────────
DROP POLICY IF EXISTS "sale_items_service_all" ON sale_items;
CREATE POLICY "sale_items_service_all" ON sale_items
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Payments: only service role ──────────────────────────────────────────────
DROP POLICY IF EXISTS "payments_service_all" ON payments;
CREATE POLICY "payments_service_all" ON payments
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Users: only service role ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "users_service_all" ON users;
CREATE POLICY "users_service_all" ON users
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Categories, Suppliers, Branches: only service role ───────────────────────
DROP POLICY IF EXISTS "categories_service_all" ON categories;
CREATE POLICY "categories_service_all" ON categories
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "suppliers_service_all" ON suppliers;
CREATE POLICY "suppliers_service_all" ON suppliers
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "branches_service_all" ON branches;
CREATE POLICY "branches_service_all" ON branches
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Notifications, push, expenses, bank accounts ─────────────────────────────
DROP POLICY IF EXISTS "notifications_service_all" ON notifications;
CREATE POLICY "notifications_service_all" ON notifications
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "bank_accounts_service_all" ON bank_accounts;
CREATE POLICY "bank_accounts_service_all" ON bank_accounts
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "expenses_service_all" ON expenses;
CREATE POLICY "expenses_service_all" ON expenses
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "stock_movements_service_all" ON stock_movements;
CREATE POLICY "stock_movements_service_all" ON stock_movements
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- NOTE: ai_scan_queue and ai_usage already have service-role policies.
-- global_products is intentionally readable by all (shared catalog).
