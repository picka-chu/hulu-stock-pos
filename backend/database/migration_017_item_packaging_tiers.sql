-- Migration 017: Pharmacy multi-tier packaging prices and barcodes
-- Stores calculated carton/box/strip/base unit metadata created by the pharmacy item dialog.

CREATE TABLE IF NOT EXISTS item_packaging_tiers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    unit_level VARCHAR(32) NOT NULL CHECK (unit_level IN ('carton', 'box', 'strip', 'base')),
    unit_label VARCHAR(80) NOT NULL,
    base_unit_multiplier NUMERIC(18,6) NOT NULL CHECK (base_unit_multiplier > 0),
    purchase_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    barcode VARCHAR(100),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, item_id, unit_level)
);

CREATE INDEX IF NOT EXISTS idx_item_packaging_tiers_org ON item_packaging_tiers(organization_id);
CREATE INDEX IF NOT EXISTS idx_item_packaging_tiers_item ON item_packaging_tiers(item_id);
CREATE INDEX IF NOT EXISTS idx_item_packaging_tiers_barcode ON item_packaging_tiers(barcode) WHERE barcode IS NOT NULL;

COMMENT ON TABLE item_packaging_tiers IS 'Pharmacy packaging hierarchy tiers with per-tier cost, selling price, and optional barcode.';
