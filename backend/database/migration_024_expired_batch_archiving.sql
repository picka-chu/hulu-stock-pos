-- Migration 024: expired batch archiving and disposal
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds:
--   1. Mark batches as inactive when their expiry_date has passed
--   2. Disposal function for manually destroying expired/waste stock
--   3. Scheduled cleanup via pg_cron (optional) or manual trigger
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Function: Archive expired batches (sets is_active=false, quantity_on_hand=0)
CREATE OR REPLACE FUNCTION archive_expired_batches(p_organization_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_archived INTEGER := 0;
BEGIN
    UPDATE item_batches
    SET is_active = false,
        quantity_on_hand = 0,
        updated_at = NOW()
    WHERE is_active = true
      AND quantity_on_hand > 0
      AND expiry_date IS NOT NULL
      AND expiry_date < NOW()
      AND (p_organization_id IS NULL OR organization_id = p_organization_id);
    GET DIAGNOSTICS v_archived = ROW_COUNT;
    RETURN v_archived;
END;
$$;

GRANT EXECUTE ON FUNCTION archive_expired_batches(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION archive_expired_batches(UUID) TO service_role;

-- 2. Function: Dispose (destroy) a specific batch — for waste, damage, or
--    expired stock that still needs proper deduction from the batch ledger.
CREATE OR REPLACE FUNCTION dispose_batch(
    p_batch_id        UUID,
    p_quantity        INTEGER,
    p_reason          TEXT,
    p_organization_id UUID,
    p_branch_id       UUID,
    p_created_by      UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_batch item_batches%ROWTYPE;
    v_new_qty INTEGER;
    v_item items%ROWTYPE;
BEGIN
    SELECT * INTO v_batch FROM item_batches WHERE id = p_batch_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
    IF v_batch.quantity_on_hand < p_quantity THEN
        RAISE EXCEPTION 'Cannot dispose % units — batch only has % on hand', p_quantity, v_batch.quantity_on_hand;
    END IF;

    v_new_qty := v_batch.quantity_on_hand - p_quantity;
    UPDATE item_batches
    SET quantity_on_hand = v_new_qty,
        is_active = (v_new_qty > 0),
        updated_at = NOW()
    WHERE id = p_batch_id;

    SELECT * INTO v_item FROM items WHERE id = v_batch.item_id AND organization_id = p_organization_id;

    INSERT INTO stock_movements (id, item_id, branch_id, type, quantity, previous_quantity, new_quantity, reference_id, reference_type, created_by, batch_id, batch_number, batch_expiry_date, notes)
    VALUES (gen_random_uuid(), v_batch.item_id, p_branch_id, 'disposal', -p_quantity,
            v_batch.quantity_on_hand, v_new_qty, p_batch_id, 'batch_disposal', p_created_by,
            p_batch_id, v_batch.batch_number, v_batch.expiry_date, p_reason);

    PERFORM sync_item_stock_from_batches(v_batch.item_id);

    RETURN jsonb_build_object('ok', true, 'item_id', v_batch.item_id, 'disposed', p_quantity, 'remaining', v_new_qty);
END;
$$;

GRANT EXECUTE ON FUNCTION dispose_batch(UUID, INTEGER, TEXT, UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION dispose_batch(UUID, INTEGER, TEXT, UUID, UUID, UUID) TO service_role;