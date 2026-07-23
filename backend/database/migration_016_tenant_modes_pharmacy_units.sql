-- Migration 016: Tenant modes + pharmacy item/unit support
-- Adds tenant modes selected by super admin and pharmacy-specific inventory fields.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tenant_type VARCHAR(32) NOT NULL DEFAULT 'retail';

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_tenant_type_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_tenant_type_check
  CHECK (tenant_type IN ('pharma', 'cosmetics', 'retail', 'supermarket'));

CREATE TABLE IF NOT EXISTS units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    abbreviation VARCHAR(20) NOT NULL,
    is_base BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, name),
    UNIQUE (organization_id, abbreviation)
);

CREATE INDEX IF NOT EXISTS idx_units_org ON units(organization_id);

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS generic_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS strength VARCHAR(100),
  ADD COLUMN IF NOT EXISTS dosage_form VARCHAR(100),
  ADD COLUMN IF NOT EXISTS controlled_substance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sale_unit_id UUID REFERENCES units(id) ON DELETE SET NULL;

COMMENT ON COLUMN items.stock_quantity IS 'Quantity stored in the item base unit/smallest unit. Pharmacy example: tablets, capsules, sachets.';
COMMENT ON COLUMN items.generic_name IS 'Pharmacy generic medication name, e.g. Amoxicillin.';
COMMENT ON COLUMN items.brand_name IS 'Pharmacy brand/trade name, e.g. Augmentin.';
COMMENT ON COLUMN items.strength IS 'Medication dosage/strength, e.g. 500mg or 250mg/5ml.';
COMMENT ON COLUMN items.dosage_form IS 'Medication form, e.g. tablet, capsule, syrup, injection, cream.';

CREATE TABLE IF NOT EXISTS unit_conversions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    from_unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    to_unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    multiplier NUMERIC(18,6) NOT NULL CHECK (multiplier > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, item_id, from_unit_id, to_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_conversions_org ON unit_conversions(organization_id);
CREATE INDEX IF NOT EXISTS idx_unit_conversions_item ON unit_conversions(item_id);

ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS base_quantity NUMERIC(18,6);

COMMENT ON COLUMN sale_items.quantity IS 'Quantity in the sold/display unit for the line item.';
COMMENT ON COLUMN sale_items.base_quantity IS 'Quantity converted to the item base unit for stock deduction.';
