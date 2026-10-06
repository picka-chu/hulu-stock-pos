-- Migration 028: critical fixes (auth-adjacent DB + RLS + constraints)
-- Run in Supabase SQL Editor after 027. Idempotent where possible.
BEGIN;

-- 1) Fix NOT NULL + ON DELETE SET NULL contradiction.
-- sales.user_id, expenses.created_by, shifts.user_id must be nullable so user
-- deletion nulls history instead of raising not-null violation.
ALTER TABLE sales ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE expenses ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE shifts ALTER COLUMN user_id DROP NOT NULL;

-- 2) Allow return statuses set by process_sale_return (migration 027).
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_status_check
    CHECK (payment_status IN ('pending', 'paid', 'partial', 'refunded', 'returned', 'partial_return'));

-- 3) Close open base RLS (fresh installs get service-only from schema.sql;
-- existing DBs created before need the same tightening here).
DROP POLICY IF EXISTS "orgs_select" ON organizations;
DROP POLICY IF EXISTS "orgs_insert" ON organizations;
DROP POLICY IF EXISTS "orgs_update" ON organizations;
DROP POLICY IF EXISTS "orgs_delete" ON organizations;
DROP POLICY IF EXISTS "branches_select" ON branches;
DROP POLICY IF EXISTS "branches_insert" ON branches;
DROP POLICY IF EXISTS "branches_update" ON branches;
DROP POLICY IF EXISTS "branches_delete" ON branches;
DROP POLICY IF EXISTS "notifications_service_all" ON notifications;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'orgs_service_only' AND tablename = 'organizations') THEN
        CREATE POLICY "orgs_service_only" ON organizations
            FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'branches_service_only' AND tablename = 'branches') THEN
        CREATE POLICY "branches_service_only" ON branches
            FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_service_all' AND tablename = 'notifications') THEN
        CREATE POLICY "notifications_service_all" ON notifications
            FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
    END IF;
END $$;

-- 4) Cover tables missed by 011_tighten_rls: enable RLS + service-only policy.
ALTER TABLE IF EXISTS units ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS item_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sale_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cash_transfers ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
    pol TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['units','unit_conversions','item_batches','sale_return_items','shifts','activity_logs','cash_transfers']
    LOOP
        pol := t || '_service_only';
        IF to_regclass(concat('public.', t)) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = pol AND tablename = t) THEN
            EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', pol, t);
        END IF;
    END LOOP;
END $$;

-- 5) Ensure pgcrypto for gen_random_uuid() used across migrations/demo seeds.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

COMMIT;
