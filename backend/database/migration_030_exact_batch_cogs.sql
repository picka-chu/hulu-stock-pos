-- Migration 030: exact per-batch COGS + backfill NULL batch costs
-- Bug: process_sale stamped every FEFO-split sale_items row with the single
-- client-supplied cost_price, so a sale spanning batches with different
-- unit_costs recorded blended costs and profit reports were wrong.
-- Fix: prefer each batch's own unit_cost; client cost is only a fallback
-- for legacy batches that carry NULL/0 cost. Also backfills those NULL
-- batch costs from the item's buy_price (NULL previously valued stock at 0).
BEGIN;

-- Backfill NULL batch costs from the item's buy_price (better than 0).
UPDATE item_batches b
SET unit_cost = i.buy_price
FROM items i
WHERE b.item_id = i.id
  AND b.unit_cost IS NULL;

CREATE OR REPLACE FUNCTION process_sale(p_sale JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    -- Never trust tenant/branch identifiers supplied by the client.
    IF v_sale_id IS NULL OR v_org_id IS NULL OR v_branch_id IS NULL OR v_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid sale context';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM branches
        WHERE id = v_branch_id
          AND organization_id = v_org_id
          AND COALESCE(is_active, true) = true
    ) THEN
        RAISE EXCEPTION 'Invalid or inactive branch';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = v_user_id
          AND organization_id = v_org_id
          AND COALESCE(is_active, true) = true
          AND role IN ('admin', 'manager', 'cashier')
    ) THEN
        RAISE EXCEPTION 'Invalid sale user';
    END IF;

    -- Admins may operate across branches. Managers/cashiers are restricted
    -- to their assigned branch at the database boundary as well as the API.
    IF EXISTS (
        SELECT 1 FROM users
        WHERE id = v_user_id
          AND organization_id = v_org_id
          AND role IN ('manager', 'cashier')
          AND branch_id IS DISTINCT FROM v_branch_id
    ) THEN
        RAISE EXCEPTION 'User is not authorized to sell for this branch';
    END IF;

    INSERT INTO sales (
        id, organization_id, branch_id, user_id, invoice_number, sold_by,
        total_amount, tax_amount, discount_amount, net_amount,
        payment_status, payment_method, notes
    )
    SELECT
        v_sale_id, v_org_id, v_branch_id, v_user_id,
        p_sale->>'invoice_number',
        p_sale->>'sold_by',
        (p_sale->>'total_amount')::NUMERIC,
        (p_sale->>'tax_amount')::NUMERIC,
        (p_sale->>'discount_amount')::NUMERIC,
        (p_sale->>'net_amount')::NUMERIC,
        'paid',
        p_sale->>'payment_method',
        p_sale->>'notes';

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_sale->'items', '[]'::jsonb)) LOOP
        SELECT * INTO v_product
        FROM items
        WHERE id = (v_item->>'item_id')::UUID
          AND organization_id = v_org_id
          AND is_active = true
          AND (branch_id IS NULL OR branch_id = v_branch_id)
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Item not found or not available in this branch: %', v_item->>'item_id';
        END IF;

        v_sold_qty := (v_item->>'quantity')::NUMERIC;
        v_base_qty := COALESCE(
            ROUND(NULLIF(v_item->>'base_quantity', '')::NUMERIC),
            v_sold_qty::INTEGER
        );

        IF v_base_qty IS NULL OR v_base_qty <= 0 OR v_sold_qty IS NULL OR v_sold_qty <= 0 THEN
            RAISE EXCEPTION 'Invalid quantity for %', v_product.name;
        END IF;

        -- Legacy compatibility: only create a branch-owned opening batch when
        -- the item has stock but no batch rows at all. New batches must always
        -- belong to the selling branch.
        IF COALESCE(v_product.stock_quantity, 0) > 0
           AND NOT EXISTS (
                SELECT 1 FROM item_batches
                WHERE item_id = v_product.id
                  AND organization_id = v_org_id
           )
        THEN
            INSERT INTO item_batches (
                organization_id, branch_id, item_id, batch_number, expiry_date,
                received_quantity, quantity_on_hand, unit_cost, is_active, received_at
            )
            VALUES (
                v_org_id, v_branch_id, v_product.id,
                v_product.batch_number, v_product.expiry_date,
                v_product.stock_quantity, v_product.stock_quantity,
                COALESCE(
                    NULLIF((v_item->>'cost_price')::NUMERIC, 0),
                    v_product.buy_price
                ),
                true,
                COALESCE(v_product.created_at, NOW())
            );
        END IF;

        -- The item aggregate is derived from its branch-owned batch ledger.
        PERFORM sync_item_stock_from_batches(v_product.id);
        SELECT * INTO v_product FROM items WHERE id = v_product.id FOR UPDATE;

        IF v_product.stock_quantity < v_base_qty THEN
            RAISE EXCEPTION
                'Insufficient stock for %: available %, requested %',
                v_product.name, v_product.stock_quantity, v_base_qty;
        END IF;

        v_remaining := v_base_qty;
        v_prev_item_qty := v_product.stock_quantity;

        FOR v_batch IN
            SELECT *
            FROM item_batches
            WHERE item_id = v_product.id
              AND organization_id = v_org_id
              AND branch_id = v_branch_id
              AND is_active = true
              AND quantity_on_hand > 0
              -- Expired stock must never be sold, including on the current day.
              AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
            ORDER BY expiry_date NULLS LAST, received_at, id
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_remaining, v_batch.quantity_on_hand);

            UPDATE item_batches
            SET quantity_on_hand = quantity_on_hand - v_take,
                is_active = (quantity_on_hand - v_take) > 0,
                updated_at = NOW()
            WHERE id = v_batch.id;

            v_new_item_qty := v_prev_item_qty - v_take;
            v_line_qty := ROUND(
                v_sold_qty * (v_take::NUMERIC / NULLIF(v_base_qty, 0)),
                6
            );

            INSERT INTO sale_items (
                id, sale_id, item_id, item_name, quantity, unit_id,
                base_quantity, unit_price, cost_price, total,
                batch_id, batch_number, batch_expiry_date
            )
            VALUES (
                gen_random_uuid(), v_sale_id, v_product.id, v_product.name,
                v_line_qty,
                NULLIF(v_item->>'unit_id', '')::UUID,
                v_take,
                (v_item->>'unit_price')::NUMERIC,
                -- Exact per-batch COGS: the batch's own unit_cost wins.
                -- The client-supplied cost is only a fallback for legacy
                -- batches that carry NULL/0 cost.
                COALESCE(
                    NULLIF(v_batch.unit_cost, 0),
                    NULLIF((v_item->>'cost_price')::NUMERIC, 0),
                    v_product.buy_price,
                    0
                ),
                ROUND((v_item->>'unit_price')::NUMERIC * v_line_qty, 2),
                v_batch.id, v_batch.batch_number, v_batch.expiry_date
            );

            INSERT INTO stock_movements (
                id, item_id, branch_id, type, quantity,
                previous_quantity, new_quantity,
                reference_id, reference_type, created_by,
                batch_id, batch_number, batch_expiry_date
            )
            VALUES (
                gen_random_uuid(), v_product.id, v_branch_id, 'sale', -v_take,
                v_prev_item_qty, v_new_item_qty,
                v_sale_id, 'sale', v_user_id,
                v_batch.id, v_batch.batch_number, v_batch.expiry_date
            );

            v_prev_item_qty := v_new_item_qty;
            v_remaining := v_remaining - v_take;
        END LOOP;

        IF v_remaining > 0 THEN
            RAISE EXCEPTION 'Insufficient non-expired batch stock for %', v_product.name;
        END IF;

        PERFORM sync_item_stock_from_batches(v_product.id);
    END LOOP;

    DECLARE
        v_payment JSONB;
        v_payment_total NUMERIC := 0;
    BEGIN
        FOR v_payment IN
            SELECT * FROM jsonb_array_elements(COALESCE(p_sale->'payments', '[]'::jsonb))
        LOOP
            IF (v_payment->>'payment_method') IS NULL
               OR (v_payment->>'amount')::NUMERIC <= 0
            THEN
                RAISE EXCEPTION 'Invalid payment';
            END IF;

            v_payment_total := v_payment_total + (v_payment->>'amount')::NUMERIC;

            INSERT INTO payments (
                id, sale_id, payment_method, amount, bank_account_id
            )
            VALUES (
                gen_random_uuid(), v_sale_id,
                v_payment->>'payment_method',
                (v_payment->>'amount')::NUMERIC,
                NULLIF(v_payment->>'bank_account_id', '')::UUID
            );

            IF (v_payment->>'payment_method') IN ('bank', 'mobile_money', 'card')
               AND COALESCE(v_payment->>'bank_account_id', '') <> ''
            THEN
                -- The account id column also carries the mobile-money
                -- provider/bank account id (see API); match by id + org so a
                -- sale can never credit another organization's account.
                UPDATE bank_accounts
                SET balance = balance + (v_payment->>'amount')::NUMERIC
                WHERE id = (v_payment->>'bank_account_id')::UUID
                  AND organization_id = v_org_id;
            END IF;
        END LOOP;

        -- A paid sale must have a payment total matching the recorded net total.
        IF ABS(v_payment_total - COALESCE((p_sale->>'net_amount')::NUMERIC, 0)) > 0.01 THEN
            RAISE EXCEPTION
                'Payment total % does not match sale total %',
                v_payment_total, (p_sale->>'net_amount')::NUMERIC;
        END IF;
    END;

    RETURN jsonb_build_object('ok', true, 'sale_id', v_sale_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION process_sale(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION process_sale(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION process_sale(JSONB) TO service_role;

COMMIT;
