-- Migration 013: Add branch_id to suppliers table
-- Suppliers can now be scoped to a specific branch (branch_id = branch UUID)
-- or remain org-wide (branch_id = NULL, visible to all branches).

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_branch ON suppliers(branch_id);

-- Existing suppliers remain org-wide (branch_id stays NULL)
-- No data migration needed — NULL means "shared across all branches"
