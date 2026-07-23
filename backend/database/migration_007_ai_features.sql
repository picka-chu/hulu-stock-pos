-- Migration 007: AI Features — usage tracking + premium flag
-- Run in Supabase SQL Editor

-- ── 1. Add is_premium flag to organizations ───────────────────────────────────
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. AI usage tracking table ────────────────────────────────────────────────
-- Tracks daily Gemini API usage per organization
-- Used to enforce per-org daily quota (50 scans/day for premium)
CREATE TABLE IF NOT EXISTS ai_usage (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    usage_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    scan_count      INTEGER NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(organization_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_org_date
    ON ai_usage(organization_id, usage_date);

-- ── 3. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_all" ON ai_usage
    FOR ALL USING (true) WITH CHECK (true);

-- ── 4. Helper function: increment usage and check quota ───────────────────────
-- Returns: {allowed: bool, used: int, limit: int}
CREATE OR REPLACE FUNCTION check_and_increment_ai_usage(
    p_org_id    UUID,
    p_daily_limit INTEGER DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    -- Upsert usage row for today
    INSERT INTO ai_usage (organization_id, usage_date, scan_count, last_used_at)
    VALUES (p_org_id, CURRENT_DATE, 0, NOW())
    ON CONFLICT (organization_id, usage_date) DO NOTHING;

    -- Read current count
    SELECT scan_count INTO v_count
    FROM ai_usage
    WHERE organization_id = p_org_id AND usage_date = CURRENT_DATE;

    IF v_count >= p_daily_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'used',    v_count,
            'limit',   p_daily_limit
        );
    END IF;

    -- Increment
    UPDATE ai_usage
    SET scan_count   = scan_count + 1,
        last_used_at = NOW()
    WHERE organization_id = p_org_id AND usage_date = CURRENT_DATE;

    RETURN jsonb_build_object(
        'allowed', true,
        'used',    v_count + 1,
        'limit',   p_daily_limit
    );
END;
$$;


-- ── 5. Separate check-only and increment functions ────────────────────────────
-- Check quota without incrementing (use before API call)
CREATE OR REPLACE FUNCTION check_ai_quota(
    p_org_id      UUID,
    p_daily_limit INTEGER DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COALESCE(scan_count, 0) INTO v_count
    FROM ai_usage
    WHERE organization_id = p_org_id AND usage_date = CURRENT_DATE;

    v_count := COALESCE(v_count, 0);

    RETURN jsonb_build_object(
        'allowed',   v_count < p_daily_limit,
        'used',      v_count,
        'limit',     p_daily_limit,
        'remaining', GREATEST(0, p_daily_limit - v_count)
    );
END;
$$;

-- Increment only (call after successful API response)
CREATE OR REPLACE FUNCTION increment_ai_usage(
    p_org_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO ai_usage (organization_id, usage_date, scan_count, last_used_at)
    VALUES (p_org_id, CURRENT_DATE, 1, NOW())
    ON CONFLICT (organization_id, usage_date)
    DO UPDATE SET scan_count   = ai_usage.scan_count + 1,
                  last_used_at = NOW();
END;
$$;
