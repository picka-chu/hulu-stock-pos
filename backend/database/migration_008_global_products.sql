-- =====================================================
-- MIGRATION 008 — Global Products Catalog
-- =====================================================
-- One shared table across ALL organizations.
-- Every time any org saves a product with a barcode,
-- it upserts here. Next time anyone scans that barcode
-- (any org) the data is returned instantly — no Gemini needed.
-- =====================================================

-- ── Main catalog table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS global_products (
    barcode         VARCHAR(100) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    brand           VARCHAR(255),
    description     TEXT,
    category_hint   VARCHAR(100),   -- generic category name (no org-specific id)
    image_url       TEXT,
    -- Quality tracking
    scan_count      INTEGER NOT NULL DEFAULT 1,
    confidence      NUMERIC(4,3) DEFAULT 1.0,   -- 0.0–1.0
    source          VARCHAR(50) DEFAULT 'user',  -- 'user' | 'gemini' | 'openfoodfacts' | ...
    -- Timestamps
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast barcode lookup
CREATE INDEX IF NOT EXISTS idx_gp_barcode ON global_products(barcode);

-- Full-text search on name + brand
CREATE INDEX IF NOT EXISTS idx_gp_name ON global_products USING gin(to_tsvector('english', name));

-- Updated_at trigger
CREATE OR REPLACE FUNCTION _gp_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS gp_set_updated_at ON global_products;
CREATE TRIGGER gp_set_updated_at
  BEFORE UPDATE ON global_products
  FOR EACH ROW EXECUTE FUNCTION _gp_set_updated_at();

-- ── RLS: any authenticated user can read; backend service role writes ─────────
ALTER TABLE global_products ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read
DROP POLICY IF EXISTS gp_read ON global_products;
CREATE POLICY gp_read ON global_products
  FOR SELECT TO authenticated USING (true);

-- Allow service role (backend) to do everything
DROP POLICY IF EXISTS gp_service ON global_products;
CREATE POLICY gp_service ON global_products
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Upsert helper function ─────────────────────────────────────────────────────
-- Called by the backend on every item save that has a barcode.
-- If the product already exists, only updates if the new name is
-- non-empty and the new source has equal/higher priority.
CREATE OR REPLACE FUNCTION upsert_global_product(
    p_barcode       TEXT,
    p_name          TEXT,
    p_brand         TEXT DEFAULT NULL,
    p_description   TEXT DEFAULT NULL,
    p_category_hint TEXT DEFAULT NULL,
    p_image_url     TEXT DEFAULT NULL,
    p_confidence    NUMERIC DEFAULT 1.0,
    p_source        TEXT DEFAULT 'user'
)
RETURNS global_products LANGUAGE plpgsql AS $$
DECLARE
    _source_priority INT;
    _existing_priority INT;
    _result global_products;
BEGIN
    -- Source priority: user > gemini > openfoodfacts > unknown
    _source_priority := CASE p_source
        WHEN 'user'          THEN 3
        WHEN 'gemini'        THEN 2
        WHEN 'openfoodfacts' THEN 1
        ELSE 0
    END;

    SELECT * INTO _result FROM global_products WHERE barcode = p_barcode;

    IF NOT FOUND THEN
        -- New product — insert
        INSERT INTO global_products (barcode, name, brand, description,
                                      category_hint, image_url, confidence, source, scan_count)
        VALUES (p_barcode, p_name, p_brand, p_description,
                p_category_hint, p_image_url, p_confidence, p_source, 1)
        RETURNING * INTO _result;
    ELSE
        -- Existing — increment scan_count always
        -- Only overwrite name/brand/description if new source has >= priority
        _existing_priority := CASE _result.source
            WHEN 'user'          THEN 3
            WHEN 'gemini'        THEN 2
            WHEN 'openfoodfacts' THEN 1
            ELSE 0
        END;

        UPDATE global_products SET
            scan_count     = _result.scan_count + 1,
            name           = CASE WHEN _source_priority >= _existing_priority AND p_name <> ''
                                  THEN p_name ELSE _result.name END,
            brand          = COALESCE(NULLIF(p_brand,''), _result.brand),
            description    = COALESCE(NULLIF(p_description,''), _result.description),
            category_hint  = COALESCE(NULLIF(p_category_hint,''), _result.category_hint),
            image_url      = COALESCE(NULLIF(p_image_url,''), _result.image_url),
            confidence     = GREATEST(_result.confidence, p_confidence),
            source         = CASE WHEN _source_priority > _existing_priority
                                  THEN p_source ELSE _result.source END
        WHERE barcode = p_barcode
        RETURNING * INTO _result;
    END IF;

    RETURN _result;
END;
$$;

-- ── Quick lookup function (used by backend on every barcode scan) ─────────────
CREATE OR REPLACE FUNCTION lookup_global_product(p_barcode TEXT)
RETURNS TABLE (
    barcode       TEXT,
    name          TEXT,
    brand         TEXT,
    description   TEXT,
    category_hint TEXT,
    image_url     TEXT,
    scan_count    INT,
    confidence    NUMERIC,
    source        TEXT
) LANGUAGE sql STABLE AS $$
    SELECT barcode::TEXT, name::TEXT, brand::TEXT, description::TEXT,
           category_hint::TEXT, image_url::TEXT, scan_count, confidence, source::TEXT
    FROM global_products
    WHERE barcode = p_barcode
    LIMIT 1;
$$;

-- ── Grant execute on functions ─────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION upsert_global_product TO service_role;
GRANT EXECUTE ON FUNCTION lookup_global_product TO authenticated, service_role;
GRANT SELECT ON global_products TO authenticated;
GRANT ALL ON global_products TO service_role;
