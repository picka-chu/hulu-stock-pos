-- Migration 026: inventory integrity constraints
-- Prevent duplicate active barcodes and duplicate batch identifiers within
-- the same organization/branch/item while allowing the same product/barcode
-- to exist in multiple branch-owned item records.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_items_active_barcode_scope
ON items (
    organization_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    barcode
)
WHERE is_active = true
  AND barcode IS NOT NULL
  AND btrim(barcode) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_batches_batch_number_scope
ON item_batches (
    organization_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    item_id,
    batch_number
)
WHERE batch_number IS NOT NULL
  AND btrim(batch_number) <> '';

COMMIT;
