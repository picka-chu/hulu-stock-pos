-- Migration 012: Performance & Data Integrity
-- 1. Full-text search index on items
-- 2. updated_at auto-trigger
-- 3. page_size guard in SQL

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Full-text search on items (name + description + barcode)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE items ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE items
SET search_vector = to_tsvector('simple',
    coalesce(name,'') || ' ' ||
    coalesce(barcode,'') || ' ' ||
    coalesce(description,'') || ' ' ||
    coalesce(brand,'')
);

CREATE INDEX IF NOT EXISTS idx_items_fts ON items USING GIN(search_vector);

-- Auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION items_search_vector_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple',
        coalesce(NEW.name,'') || ' ' ||
        coalesce(NEW.barcode,'') || ' ' ||
        coalesce(NEW.description,'') || ' ' ||
        coalesce(NEW.brand,'')
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS items_search_vector_trigger ON items;
CREATE TRIGGER items_search_vector_trigger
    BEFORE INSERT OR UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION items_search_vector_update();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. updated_at auto-trigger (applies to all main tables)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Apply to tables that have updated_at column
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['items','sales','organizations','branches','users','categories','suppliers','bank_accounts']
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS set_updated_at_%1$s ON %1$s;
            CREATE TRIGGER set_updated_at_%1$s
                BEFORE UPDATE ON %1$s
                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        ', t);
    END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Compound index on items for common query pattern
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_items_org_active_name
    ON items(organization_id, is_active, name)
    WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Index on sales created_at per org (speeds up reports)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_sales_org_created
    ON sales(organization_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Partial index for pending_ai items (fast queue processing)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_items_pending_ai
    ON items(organization_id, created_at)
    WHERE ai_status = 'pending_ai' AND is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Bulk AI usage increment (called once per batch instead of N times)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION increment_ai_usage_by(p_org_id UUID, p_count INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO ai_usage (organization_id, usage_date, scan_count, last_used_at)
    VALUES (p_org_id, CURRENT_DATE, p_count, NOW())
    ON CONFLICT (organization_id, usage_date)
    DO UPDATE SET
        scan_count   = ai_usage.scan_count + p_count,
        last_used_at = NOW();
END;
$$;
