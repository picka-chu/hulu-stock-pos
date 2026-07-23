-- Migration 020: Fix batch/sale consistency bugs
-- ─────────────────────────────────────────────────────────────────────────────
-- Problems fixed by this migration:
--
-- 1. sale_items.quantity was written INCONSISTENTLY by process_sale():
--      - when a single batch covered the whole line item -> quantity was the
--        SOLD-UNIT quantity (e.g. "2" boxes)
--      - when the line item had to split across >=2 batches (common once an
--        item has batches with different buy/sell price and expiry dates)
--        -> quantity was the BASE-UNIT quantity taken from that specific
--        batch (e.g. "140" tablets), while unit_price stayed the per-box
--        price. Reports/receipts that read `quantity` therefore showed
--        nonsense numbers and badly wrong totals specifically in the
--        multi-batch scenario.
--    Fix: quantity now ALWAYS stores the proportional SOLD-UNIT quantity
--    (can be fractional when a line item straddles batches), so summing
--    quantity across the split rows for one sale always reconstructs the
--    original sold quantity, and unit_price always matches the unit that
--    quantity is expressed in. base_quantity (already on the table)
--    continues to always be the BASE-unit amount actually removed from that
--    batch, which is what COGS math should use.
--
-- 2. sale_items.quantity was INTEGER, which cannot hold the fractional
--    sold-unit amounts produced by a split. Widened to NUMERIC(18,6).
--
-- 3. Added restock_return_batch() — sale returns must put stock back into a
--    real item_batches row (not just bump items.stock_quantity directly),
--    otherwise the next sale's sync_item_stock_from_batches() call silently
--    erases the returned quantity because it recomputes items.stock_quantity
--    from the batch ledger only.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Widen the column so split-batch lines can store a fractional sold-unit
--    quantity without truncation/rounding errors.
ALTER TABLE sale_items ALTER COLUMN quantity TYPE NUMERIC(18,6);

COMMENT ON COLUMN sale_items.quantity IS 'Quantity in the sold/display unit for this line item (may be fractional when a single sale line is split across batches). Always use base_quantity, not quantity, for COGS math.';
COMMENT ON COLUMN sale_items.base_quantity IS 'Quantity actually removed from item_batches, expressed in the item base unit. Always an integer count of base units. Use this column (not quantity) to compute cost-of-goods-sold: cost_price * base_quantity.';

-- 2) Re-create process_sale() with the corrected, always-consistent quantity.
CREATE OR REPLACE FUNCTION process_sale(p_sale JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sale_id UUID := (p_sale->>'sale_id')::UUID;
    v_org_id UUID := (p_sale->>'organization_id')::UUID;
    v_branch_id UUID := (p_sale->>'branch_id')::UUID;
    v_user_id UUID := (p_sale->>'user_id')::UUID;
    v_item JSONB;
    v_product items%ROWTYPE;
    v_base_qty INTEGER;
    v_sold_qty NUMERIC;
    v_remaining INTEGER;
    v_batch item_batches%ROWTYPE;
    v_take INTEGER;
    v_line_qty NUMERIC;
    v_prev_item_qty INTEGER;
    v_new_item_qty INTEGER;
BEGIN
    INSERT INTO sales (id, organization_id, branch_id, user_id, invoice_number, sold_by, total_amount, tax_amount, discount_amount, net_amount, payment_status, payment_method, notes)
    SELECT v_sale_id, v_org_id, v_branch_id, v_user_id, p_sale->>'invoice_number', p_sale->>'sold_by',
           (p_sale->>'total_amount')::NUMERIC, (p_sale->>'tax_amount')::NUMERIC, (p_sale->>'discount_amount')::NUMERIC,
           (p_sale->>'net_amount')::NUMERIC, 'paid', p_sale->>'payment_method', p_sale->>'notes';

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_sale->'items') LOOP
        SELECT * INTO v_product FROM items
        WHERE id = (v_item->>'item_id')::UUID AND organization_id = v_org_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Item not found: %', v_item->>'item_id'; END IF;

        PERFORM sync_item_stock_from_batches(v_product.id);
        SELECT * INTO v_product FROM items WHERE id = v_product.id FOR UPDATE;
        v_sold_qty := (v_item->>'quantity')::NUMERIC;
        v_base_qty := COALESCE(ROUND(NULLIF(v_item->>'base_quantity', '')::NUMERIC), v_sold_qty::INTEGER);
        IF v_product.stock_quantity < v_base_qty THEN
            RAISE EXCEPTION 'Insufficient stock for %: available %, requested %', v_product.name, v_product.stock_quantity, v_base_qty;
        END IF;

        v_remaining := v_base_qty;
        v_prev_item_qty := v_product.stock_quantity;
        FOR v_batch IN
            SELECT * FROM item_batches
            WHERE item_id = v_product.id AND organization_id = v_org_id AND is_active = true AND quantity_on_hand > 0
            ORDER BY expiry_date NULLS LAST, received_at, id
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;
            v_take := LEAST(v_remaining, v_batch.quantity_on_hand);
            UPDATE item_batches SET quantity_on_hand = quantity_on_hand - v_take,
                is_active = (quantity_on_hand - v_take) > 0, updated_at = NOW()
            WHERE id = v_batch.id;
            v_new_item_qty := v_prev_item_qty - v_take;

            -- `quantity` is always the SOLD-UNIT quantity proportional to how
            -- much of this batch-split row represents of the whole line item.
            -- When a single batch covers the whole line (the common case),
            -- v_take = v_base_qty and this reduces to exactly v_sold_qty.
            v_line_qty := ROUND(v_sold_qty * (v_take::NUMERIC / NULLIF(v_base_qty, 0)), 6);

            INSERT INTO sale_items (id, sale_id, item_id, item_name, quantity, unit_id, base_quantity, unit_price, cost_price, total, batch_id, batch_number, batch_expiry_date)
            VALUES (gen_random_uuid(), v_sale_id, v_product.id, v_product.name,
                    v_line_qty,
                    NULLIF(v_item->>'unit_id', '')::UUID, v_take, (v_item->>'unit_price')::NUMERIC,
                    COALESCE(v_batch.unit_cost, v_product.buy_price, 0),
                    ROUND(((v_item->>'unit_price')::NUMERIC * v_line_qty), 2),
                    v_batch.id, v_batch.batch_number, v_batch.expiry_date);

            INSERT INTO stock_movements (id, item_id, branch_id, type, quantity, previous_quantity, new_quantity, reference_id, reference_type, created_by, batch_id, batch_number, batch_expiry_date)
            VALUES (gen_random_uuid(), v_product.id, v_branch_id, 'sale', -v_take, v_prev_item_qty, v_new_item_qty, v_sale_id, 'sale', v_user_id, v_batch.id, v_batch.batch_number, v_batch.expiry_date);

            v_prev_item_qty := v_new_item_qty;
            v_remaining := v_remaining - v_take;
        END LOOP;
        IF v_remaining > 0 THEN RAISE EXCEPTION 'Insufficient batch stock for %', v_product.name; END IF;
        PERFORM sync_item_stock_from_batches(v_product.id);
    END LOOP;

    DECLARE v_payment JSONB; BEGIN
        FOR v_payment IN SELECT * FROM jsonb_array_elements(p_sale->'payments') LOOP
            INSERT INTO payments (id, sale_id, payment_method, amount, bank_account_id)
            VALUES (gen_random_uuid(), v_sale_id, v_payment->>'payment_method', (v_payment->>'amount')::NUMERIC, NULLIF(v_payment->>'bank_account_id', '')::UUID);
            IF (v_payment->>'payment_method') = 'bank' AND COALESCE(v_payment->>'bank_account_id','') != '' THEN
                UPDATE bank_accounts SET balance = balance + (v_payment->>'amount')::NUMERIC WHERE id = (v_payment->>'bank_account_id')::UUID AND organization_id = v_org_id;
            END IF;
        END LOOP;
    END;
    RETURN jsonb_build_object('ok', true, 'sale_id', v_sale_id);
END;
$$;

GRANT EXECUTE ON FUNCTION process_sale(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION process_sale(JSONB) TO service_role;

-- 3) Restock helper for returns — creates a real batch entry (so FEFO and
--    cost basis stay correct) instead of letting Python directly edit
--    items.stock_quantity, which the next sale's sync would silently undo.
CREATE OR REPLACE FUNCTION restock_return_batch(
    p_item_id UUID,
    p_organization_id UUID,
    p_branch_id UUID,
    p_quantity INTEGER,
    p_unit_cost NUMERIC,
    p_reference_id UUID,
    p_reference_type VARCHAR,
    p_created_by UUID,
    p_notes VARCHAR
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_batch_id UUID := gen_random_uuid();
    v_prev_qty INTEGER;
    v_new_qty INTEGER;
BEGIN
    IF p_quantity <= 0 THEN
        SELECT stock_quantity INTO v_prev_qty FROM items WHERE id = p_item_id;
        RETURN COALESCE(v_prev_qty, 0);
    END IF;

    SELECT stock_quantity INTO v_prev_qty FROM items WHERE id = p_item_id FOR UPDATE;

    INSERT INTO item_batches (id, organization_id, branch_id, item_id, batch_number, expiry_date,
                               received_quantity, quantity_on_hand, unit_cost, is_active, received_at)
    VALUES (v_batch_id, p_organization_id, p_branch_id, p_item_id, 'RETURN', NULL,
            p_quantity, p_quantity, p_unit_cost, true, NOW());

    v_new_qty := COALESCE(v_prev_qty, 0) + p_quantity;

    INSERT INTO stock_movements (id, item_id, branch_id, type, quantity, previous_quantity, new_quantity,
                                  reference_id, reference_type, created_by, batch_id, notes)
    VALUES (gen_random_uuid(), p_item_id, p_branch_id, 'return', p_quantity, COALESCE(v_prev_qty, 0), v_new_qty,
            p_reference_id, p_reference_type, p_created_by, v_batch_id, p_notes);

    RETURN sync_item_stock_from_batches(p_item_id);
END;
$$;

GRANT EXECUTE ON FUNCTION restock_return_batch(UUID, UUID, UUID, INTEGER, NUMERIC, UUID, VARCHAR, UUID, VARCHAR) TO authenticated;
GRANT EXECUTE ON FUNCTION restock_return_batch(UUID, UUID, UUID, INTEGER, NUMERIC, UUID, VARCHAR, UUID, VARCHAR) TO service_role;
