-- Migration 009: Fast Scan Queue — batch AI processing
-- Run in Supabase SQL Editor

-- ── 1. Add ai_status + brand + expiry_image_url columns to items ──────────────
ALTER TABLE items
    ADD COLUMN IF NOT EXISTS ai_status       VARCHAR(20)  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS brand           VARCHAR(255) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS expiry_image_url TEXT         DEFAULT NULL;

-- Index for querying pending_ai items quickly
CREATE INDEX IF NOT EXISTS idx_items_ai_status
    ON items(organization_id, ai_status)
    WHERE ai_status IS NOT NULL;

-- ── 2. ai_scan_queue table ────────────────────────────────────────────────────
-- Persists the scan queue in case the browser closes before Done is tapped.
-- Frontend also keeps an in-memory copy; this is the durable fallback.
CREATE TABLE IF NOT EXISTS ai_scan_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id         UUID    NOT NULL REFERENCES items(id)         ON DELETE CASCADE,
    barcode         VARCHAR(100),
    expiry_image_url TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    processed_at    TIMESTAMPTZ DEFAULT NULL,
    UNIQUE(item_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_org_unprocessed
    ON ai_scan_queue(organization_id, processed_at)
    WHERE processed_at IS NULL;

-- RLS: service key bypasses all
ALTER TABLE ai_scan_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "queue_all" ON ai_scan_queue FOR ALL USING (true) WITH CHECK (true);

-- ── 3. Function: mark queue entries as processed ──────────────────────────────
CREATE OR REPLACE FUNCTION mark_queue_processed(p_item_ids UUID[])
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ai_scan_queue
    SET processed_at = NOW()
    WHERE item_id = ANY(p_item_ids);
END;
$$;
