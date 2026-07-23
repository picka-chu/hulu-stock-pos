-- Migration 011: Fix process_sale user_id casts
-- Fixes UUID insert errors when JSONB user_id is read as text
-- Run in Supabase SQL Editor

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: process_sale
-- Wraps entire sale creation in a single DB transaction.
-- Atomically deducts stock using row-level locking (SELECT ... FOR UPDATE).
-- Returns the created sale id on success, raises exception on failure.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION process_sale(p_sale JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sale_id       UUID := (p_sale->>'sale_id')::UUID;
    v_org_id        UUID := (p_sale->>'organization_id')::UUID;
    v_branch_id     UUID := (p_sale->>'branch_id')::UUID;
    v_user_id       UUID := (p_sale->>'user_id')::UUID;
    v_item          JSONB;
    v_product       items%ROWTYPE;
    v_new_qty       INTEGER;
    v_base_qty      INTEGER;
    v_item_row_id   UUID;
    v_move_id       UUID;
BEGIN
    -- Insert the sale header
    INSERT INTO sales (
        id, organization_id, branch_id, user_id, invoice_number,
        sold_by, total_amount, tax_amount, discount_amount, net_amount,
        payment_status, payment_method, notes
    )
    SELECT
        v_sale_id,
        v_org_id,
        v_branch_id,
        v_user_id,
        p_sale->>'invoice_number',
        p_sale->>'sold_by',
        (p_sale->>'total_amount')::NUMERIC,
        (p_sale->>'tax_amount')::NUMERIC,
        (p_sale->>'discount_amount')::NUMERIC,
        (p_sale->>'net_amount')::NUMERIC,
        'paid',
        p_sale->>'payment_method',
        p_sale->>'notes';

    -- Process each item atomically
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_sale->'items')
    LOOP
        -- Lock the item row for update (prevents concurrent stock deduction)
        SELECT * INTO v_product
        FROM items
        WHERE id = (v_item->>'item_id')::UUID
          AND organization_id = v_org_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Item not found: %', v_item->>'item_id';
        END IF;

        v_base_qty := COALESCE(ROUND(NULLIF(v_item->>'base_quantity', '')::NUMERIC), (v_item->>'quantity')::INTEGER);

        IF v_product.stock_quantity < v_base_qty THEN
            RAISE EXCEPTION 'Insufficient stock for %: available %, requested %',
                v_product.name,
                v_product.stock_quantity,
                v_base_qty;
        END IF;

        v_new_qty := v_product.stock_quantity - v_base_qty;

        -- Deduct stock atomically
        UPDATE items
        SET stock_quantity = v_new_qty,
            updated_at     = NOW()
        WHERE id = v_product.id;

        -- Insert sale_item with name snapshot
        v_item_row_id := gen_random_uuid();
        INSERT INTO sale_items (id, sale_id, item_id, item_name, quantity, unit_id, base_quantity, unit_price, cost_price, total)
        VALUES (
            v_item_row_id,
            v_sale_id,
            v_product.id,
            v_product.name,
            (v_item->>'quantity')::INTEGER,
            NULLIF(v_item->>'unit_id', '')::UUID,
            v_base_qty,
            (v_item->>'unit_price')::NUMERIC,
            (v_item->>'cost_price')::NUMERIC,
            (v_item->>'total')::NUMERIC
        );

        -- Record stock movement
        v_move_id := gen_random_uuid();
        INSERT INTO stock_movements (id, item_id, branch_id, type, quantity,
                                     previous_quantity, new_quantity, reference_id, created_by)
        VALUES (
            v_move_id,
            v_product.id,
            v_branch_id,
            'sale',
            -v_base_qty,
            v_product.stock_quantity,
            v_new_qty,
            v_sale_id,
            v_user_id
        );
    END LOOP;

    -- Insert payment records
    DECLARE
        v_payment JSONB;
    BEGIN
        FOR v_payment IN SELECT * FROM jsonb_array_elements(p_sale->'payments')
        LOOP
            INSERT INTO payments (id, sale_id, payment_method, amount, bank_account_id)
            VALUES (
                gen_random_uuid(),
                v_sale_id,
                v_payment->>'payment_method',
                (v_payment->>'amount')::NUMERIC,
                NULLIF(v_payment->>'bank_account_id', '')::UUID
            );

            -- Update bank account balance if bank payment
            IF (v_payment->>'payment_method') = 'bank'
               AND (v_payment->>'bank_account_id') IS NOT NULL
               AND (v_payment->>'bank_account_id') != '' THEN
                UPDATE bank_accounts
                SET balance = balance + (v_payment->>'amount')::NUMERIC
                WHERE id = (v_payment->>'bank_account_id')::UUID
                  AND organization_id = v_org_id;
            END IF;
        END LOOP;
    END;

    RETURN jsonb_build_object('ok', true, 'sale_id', v_sale_id);

EXCEPTION
    WHEN OTHERS THEN
        -- Transaction rolls back automatically; re-raise with clean message
        RAISE EXCEPTION '%', SQLERRM;
END;
$$;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION process_sale(JSONB) TO service_role;
