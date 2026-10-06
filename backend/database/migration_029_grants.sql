-- Migration 029: grant API roles access to app tables
-- Symptom: PostgREST 403 'permission denied for table organizations' (code 42501)
-- even with the service_role key. service_role bypasses RLS, so a 403 means
-- the role lacks table-level GRANTs (e.g. tables created without default grants).
-- Run once in Supabase SQL Editor (project szjdghdmiovkbtcbazca).
BEGIN;

GRANT USAGE ON SCHEMA public TO service_role, authenticated, anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Future tables (created by later migrations) inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

COMMIT;
