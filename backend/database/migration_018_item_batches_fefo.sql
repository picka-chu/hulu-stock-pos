-- Migration 018: Batch ledger + FEFO stock deduction
-- Adds production batch tracking for retail and pharmacy inventory.

CREATE TABLE IF NOT EXISTS item_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    batch_number VARCHAR(100),
    expiry_date DATE,
    received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
    quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    unit_cost NUMERIC(12,2),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_batches_item_fefo
    ON item_batches(item_id, is_active, expiry_date NULLS LAST, received_at, id)
    WHERE is_active = true AND quantity_on_hand > 0;
CREATE INDEX IF NOT EXISTS idx_item_batches_org_branch ON item_batches(organization_id, branch_id);

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES item_batches(id) ON DELETE SET NULL;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS batch_expiry_date DATE;
CREATE INDEX IF NOT EXISTS idx_sale_items_batch ON sale_items(batch_id);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES item_batches(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_expiry_date DATE;
CREATE INDEX IF NOT EXISTS idx_stock_movements_batch ON stock_movements(batch_id);

-- Backfill one opening batch per item so legacy stock can participate in FEFO.
INSERT INTO item_batches (organization_id, branch_id, item_id, batch_number, expiry_date, received_quantity, quantity_on_hand, unit_cost, supplier_id, received_at)
SELECT i.organization_id, i.branch_id, i.id, i.batch_number, i.expiry_date,
       GREATEST(COALESCE(i.stock_quantity, 0), 0), GREATEST(COALESCE(i.stock_quantity, 0), 0),
       i.buy_price, i.supplier_id, COALESCE(i.created_at, NOW())
FROM items i
WHERE COALESCE(i.stock_quantity, 0) > 0
  AND NOT EXISTS (SELECT 1 FROM item_batches b WHERE b.item_id = i.id);

CREATE OR REPLACE FUNCTION sync_item_stock_from_batches(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_total INTEGER;
BEGIN
    SELECT COALESCE(SUM(quantity_on_hand), 0)::INTEGER INTO v_total
    FROM item_batches
    WHERE item_id = p_item_id AND is_active = true;

    UPDATE items
    SET stock_quantity = v_total,
        batch_number = (SELECT batch_number FROM item_batches WHERE item_id = p_item_id AND is_active = true AND quantity_on_hand > 0 ORDER BY expiry_date NULLS LAST, received_at, id LIMIT 1),
        expiry_date = (SELECT expiry_date FROM item_batches WHERE item_id = p_item_id AND is_active = true AND quantity_on_hand > 0 ORDER BY expiry_date NULLS LAST, received_at, id LIMIT 1),
        updated_at = NOW()
    WHERE id = p_item_id;
    RETURN v_total;
END;
$$;

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
    v_remaining INTEGER;
    v_batch item_batches%ROWTYPE;
    v_take INTEGER;
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
        v_base_qty := COALESCE(ROUND(NULLIF(v_item->>'base_quantity', '')::NUMERIC), (v_item->>'quantity')::INTEGER);
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

            INSERT INTO sale_items (id, sale_id, item_id, item_name, quantity, unit_id, base_quantity, unit_price, cost_price, total, batch_id, batch_number, batch_expiry_date)
            VALUES (gen_random_uuid(), v_sale_id, v_product.id, v_product.name,
                    CASE WHEN v_take = v_base_qty THEN (v_item->>'quantity')::INTEGER ELSE v_take END,
                    NULLIF(v_item->>'unit_id', '')::UUID, v_take, (v_item->>'unit_price')::NUMERIC,
                    COALESCE(v_batch.unit_cost, v_product.buy_price, 0), ROUND(((v_item->>'unit_price')::NUMERIC * (v_item->>'quantity')::NUMERIC * (v_take::NUMERIC / NULLIF(v_base_qty, 0))), 2),
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
GRANT EXECUTE ON FUNCTION process_sale(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION sync_item_stock_from_batches(UUID) TO service_role;
