-- ============================================================
-- Migration 004: Web Push Subscriptions + Org Timezone
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add timezone column to organizations (if not exists)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'Africa/Addis_Ababa';

-- 2. Create push_subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint         TEXT NOT NULL UNIQUE,
    subscription     TEXT NOT NULL,
    user_agent       TEXT DEFAULT '',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_org
    ON push_subscriptions(organization_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions(user_id);

-- RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- DROP first to avoid "already exists" errors, then recreate
DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select
    ON push_subscriptions FOR SELECT
    USING (TRUE);

DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_insert
    ON push_subscriptions FOR INSERT
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete
    ON push_subscriptions FOR DELETE
    USING (TRUE);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_push_subscription_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS push_subscriptions_updated_at ON push_subscriptions;
CREATE TRIGGER push_subscriptions_updated_at
    BEFORE UPDATE ON push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_push_subscription_timestamp();
