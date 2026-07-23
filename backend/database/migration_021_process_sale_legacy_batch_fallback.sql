-- Migration 021: let process_sale() sell legacy stock that has no batch rows.
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem fixed by this migration:
--
-- process_sale() (migrations 018-020) deducts stock purely from the
-- item_batches FEFO ledger. The migration_018 backfill only created an
-- opening batch for items that had stock_quantity > 0 AT THE TIME it ran.
-- Items created/restocked through code paths that bump items.stock_quantity
-- directly (common for pre-batch legacy items) therefore have real stock but
-- NO item_batches rows. For those items:
--   * sync_item_stock_from_batches() recomputes items.stock_quantity from the
--     (empty) ledger and zeroes it, OR
--   * the FEFO loop iterates over zero batches, leaving v_remaining > 0 and
--     raising "Insufficient batch stock" / "Insufficient stock"
-- — silently blocking every sale of an item that genuinely has stock.
--
-- Fix: at the start of each line item, if the item has NO batch rows at all
-- but items.stock_quantity > 0, lazily create an opening batch from the item's
-- current stock and buy_price (mirroring the migration_018 backfill) BEFORE the
-- sync/FEFO step. This makes the legacy stock participate in FEFO with a real
-- cost basis instead of vanishing.
--
-- Everything else (the always-consistent sold-unit `quantity`, base_quantity
-- driven COGS) is carried over unchanged from migration_020.
-- ─────────────────────────────────────────────────────────────────────────────

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

        -- Legacy fallback: an item with real stock but no batch ledger rows at
        -- all gets a lazily-created opening batch so its stock can be sold via
        -- FEFO. Must run BEFORE sync_item_stock_from_batches(), which would
        -- otherwise zero items.stock_quantity from the empty ledger.
        IF COALESCE(v_product.stock_quantity, 0) > 0
           AND NOT EXISTS (
               SELECT 1 FROM item_batches
               WHERE item_id = v_product.id AND organization_id = v_org_id
           ) THEN
            INSERT INTO item_batches (organization_id, branch_id, item_id, batch_number, expiry_date,
                                      received_quantity, quantity_on_hand, unit_cost, is_active, received_at)
            VALUES (v_org_id, v_product.branch_id, v_product.id, v_product.batch_number, v_product.expiry_date,
                    v_product.stock_quantity, v_product.stock_quantity,
                    COALESCE(NULLIF((v_item->>'cost_price')::NUMERIC, 0), v_product.buy_price), true,
                    COALESCE(v_product.created_at, NOW()));
        END IF;

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
