-- Migration 031: link legacy-return stock movements to their batch
-- Bug: when returning a pre-batch-era sale row (sale_items.batch_id IS NULL),
-- process_sale_return minted a RETURN-LEGACY item_batches row but the
-- stock_movements row still referenced the NULL original batch_id with
-- previous/new quantities of 0 — restored stock with no linked ledger entry.
-- Fix: capture the minted batch id and use it for the return allocation,
-- the credit row, and the movement (prev 0 -> new restored qty).
BEGIN;

CREATE OR REPLACE FUNCTION process_sale_return(
    p_sale_id UUID,
    p_organization_id UUID,
    p_user_id UUID,
    p_items JSONB,
    p_reason TEXT DEFAULT 'Customer return'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sale sales%ROWTYPE;
    v_user users%ROWTYPE;
    v_req JSONB;
    v_orig sale_items%ROWTYPE;
    v_credit_id UUID := gen_random_uuid();
    v_credit_invoice TEXT;
    v_remaining NUMERIC;
    v_alloc NUMERIC;
    v_base_alloc INTEGER;
    v_available NUMERIC;
    v_total_refund NUMERIC := 0;
    v_refund_factor NUMERIC := 1;
    v_line_refund NUMERIC;
    v_any BOOLEAN := false;
    v_branch UUID;
    v_reason TEXT := left(COALESCE(p_reason,'Customer return'),255);
    v_ret_batch_id UUID;
    v_opay payments%ROWTYPE;
    v_rev NUMERIC;
    v_rev_total NUMERIC := 0;
    v_opay_n INTEGER := 0;
    v_opay_count INTEGER := 0;
BEGIN
    SELECT * INTO v_user FROM users
    WHERE id=p_user_id AND organization_id=p_organization_id AND COALESCE(is_active,true)
      AND role IN ('admin','manager','cashier');
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid return user'; END IF;

    SELECT * INTO v_sale FROM sales
    WHERE id=p_sale_id AND organization_id=p_organization_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
    IF v_sale.payment_status IN ('returned','refunded') THEN
        RAISE EXCEPTION 'Sale has already been fully returned';
    END IF;

    v_branch := v_sale.branch_id;
    -- Preserve the original sale's discount/tax proportion so a full return
    -- refunds exactly the recorded net amount rather than pre-tax line totals.
    IF COALESCE(v_sale.total_amount,0) <> 0 THEN
        v_refund_factor := COALESCE(v_sale.net_amount,0) / v_sale.total_amount;
    END IF;
    IF v_user.role IN ('manager','cashier') AND v_user.branch_id IS DISTINCT FROM v_branch THEN
        RAISE EXCEPTION 'User is not authorized for this sale branch';
    END IF;

    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items)=0 THEN
        RAISE EXCEPTION 'No items specified for return';
    END IF;

    INSERT INTO sales (
        id,organization_id,branch_id,user_id,invoice_number,sold_by,
        total_amount,tax_amount,discount_amount,net_amount,payment_status,
        payment_method,notes
    ) VALUES (
        v_credit_id,p_organization_id,v_branch,p_user_id,
        'PENDING-RETURN',COALESCE(v_user.full_name,'Staff'),
        0,0,0,0,'refunded',v_sale.payment_method,
        format('Return for %s — %s',COALESCE(v_sale.invoice_number,''),v_reason)
    );

    FOR v_req IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_remaining := (v_req->>'quantity')::NUMERIC;
        IF v_remaining IS NULL OR v_remaining <= 0 THEN
            RAISE EXCEPTION 'Invalid return quantity';
        END IF;

        FOR v_orig IN
            SELECT si.*
            FROM sale_items si
            WHERE si.sale_id=p_sale_id
              AND si.item_id=(v_req->>'item_id')::UUID
            ORDER BY si.created_at, si.id
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            SELECT GREATEST(
                v_orig.quantity - COALESCE(SUM(sri.quantity),0), 0
            ) INTO v_available
            FROM sale_return_items sri
            WHERE sri.original_sale_item_id=v_orig.id;

            IF v_available <= 0 THEN CONTINUE; END IF;

            v_alloc := LEAST(v_remaining,v_available);
            v_base_alloc := GREATEST(
                1,
                ROUND(
                    COALESCE(v_orig.base_quantity,0)::NUMERIC
                    * v_alloc / NULLIF(v_orig.quantity,0)
                )::INTEGER
            );

            -- Never return more base units than this original row sold.
            v_base_alloc := LEAST(v_base_alloc, COALESCE(v_orig.base_quantity,0));
            IF v_base_alloc <= 0 THEN CONTINUE; END IF;

            v_ret_batch_id := v_orig.batch_id;

            IF v_orig.batch_id IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM item_batches
                    WHERE id=v_orig.batch_id
                      AND expiry_date IS NOT NULL
                      AND expiry_date <= CURRENT_DATE
                ) THEN
                    RAISE EXCEPTION 'Cannot return stock from an expired batch';
                END IF;

                UPDATE item_batches
                SET quantity_on_hand=quantity_on_hand+v_base_alloc,
                    is_active=true,
                    updated_at=NOW()
                WHERE id=v_orig.batch_id
                  AND organization_id=p_organization_id;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Original batch is no longer available for return';
                END IF;
            ELSE
                INSERT INTO item_batches (
                    organization_id,branch_id,item_id,batch_number,expiry_date,
                    received_quantity,quantity_on_hand,unit_cost,is_active,received_at
                ) VALUES (
                    p_organization_id,v_branch,v_orig.item_id,'RETURN-LEGACY',NULL,
                    v_base_alloc,v_base_alloc,v_orig.cost_price,true,NOW()
                )
                RETURNING id INTO v_ret_batch_id;
            END IF;

            INSERT INTO sale_return_items (
                organization_id,original_sale_id,credit_sale_id,original_sale_item_id,
                batch_id,item_id,quantity,base_quantity,unit_price,cost_price,reason,created_by
            ) VALUES (
                p_organization_id,p_sale_id,v_credit_id,v_orig.id,v_ret_batch_id,
                v_orig.item_id,v_alloc,v_base_alloc,v_orig.unit_price,v_orig.cost_price,
                v_reason,p_user_id
            );

            INSERT INTO sale_items (
                id,sale_id,item_id,item_name,quantity,unit_id,base_quantity,
                unit_price,cost_price,total,batch_id,batch_number,batch_expiry_date
            ) VALUES (
                gen_random_uuid(),v_credit_id,v_orig.item_id,v_orig.item_name,
                -v_alloc,v_orig.unit_id,-v_base_alloc,v_orig.unit_price,
                v_orig.cost_price,-ROUND(v_orig.unit_price*v_alloc,2),
                v_ret_batch_id,v_orig.batch_number,v_orig.batch_expiry_date
            );

            INSERT INTO stock_movements (
                id,item_id,branch_id,type,quantity,previous_quantity,new_quantity,
                reference_id,reference_type,created_by,batch_id,batch_number,
                batch_expiry_date,notes
            )
            SELECT gen_random_uuid(),v_orig.item_id,v_branch,'return',
                   v_base_alloc,
                   COALESCE((SELECT quantity_on_hand FROM item_batches WHERE id=v_ret_batch_id),0)-v_base_alloc,
                   COALESCE((SELECT quantity_on_hand FROM item_batches WHERE id=v_ret_batch_id),0),
                   p_sale_id,'sale_return',p_user_id,v_ret_batch_id,
                   (SELECT batch_number FROM item_batches WHERE id=v_ret_batch_id),
                   (SELECT expiry_date FROM item_batches WHERE id=v_ret_batch_id),
                   v_reason;

            PERFORM sync_item_stock_from_batches(v_orig.item_id);

            v_line_refund := ROUND(v_orig.unit_price * v_alloc * v_refund_factor, 2);
            v_total_refund := v_total_refund + v_line_refund;
            v_remaining := v_remaining-v_alloc;
            v_any := true;
        END LOOP;

        IF v_remaining > 0.000001 THEN
            RAISE EXCEPTION 'Return quantity exceeds the remaining quantity sold for item %',v_req->>'item_id';
        END IF;
    END LOOP;

    IF NOT v_any THEN RAISE EXCEPTION 'No valid return items'; END IF;

    UPDATE sales
    SET total_amount=-v_total_refund,
        net_amount=-v_total_refund,
        notes=format('Return for %s — %s',COALESCE(v_sale.invoice_number,''),v_reason)
    WHERE id=v_credit_id;

    -- Reverse the original tender across its real methods/accounts so
    -- bank/mobile balances net out (sales credit them; returns must debit).
    -- Each account-linked original payment gets a mirror reversal row for
    -- its proportional share of the refund (last row takes the remainder
    -- so rounding always sums exactly). Pure-cash sales keep the single
    -- cash credit row below.
    SELECT COUNT(*) INTO v_opay_count FROM payments
    WHERE sale_id=p_sale_id AND bank_account_id IS NOT NULL;
    FOR v_opay IN
        SELECT * FROM payments
        WHERE sale_id=p_sale_id AND bank_account_id IS NOT NULL
        ORDER BY created_at, id
    LOOP
        v_opay_n := v_opay_n + 1;
        IF v_opay_n < v_opay_count THEN
            v_rev := ROUND(v_opay.amount * v_total_refund / NULLIF(v_sale.net_amount, 0), 2);
        ELSE
            v_rev := ROUND(v_total_refund - v_rev_total, 2);
        END IF;
        v_rev_total := v_rev_total + v_rev;
        UPDATE bank_accounts
        SET balance = balance - v_rev
        WHERE id = v_opay.bank_account_id
          AND organization_id = p_organization_id;
        INSERT INTO payments(id,sale_id,payment_method,amount,bank_account_id)
        VALUES(gen_random_uuid(),v_credit_id,v_opay.payment_method,-v_rev,v_opay.bank_account_id);
    END LOOP;

    IF v_opay_count = 0 THEN
        INSERT INTO payments(id,sale_id,payment_method,amount,bank_account_id)
        VALUES(gen_random_uuid(),v_credit_id,COALESCE(v_sale.payment_method,'cash'),-v_total_refund,NULL);
    END IF;

    -- Determine whether all original sold quantities have now been returned.
    IF NOT EXISTS (
        SELECT 1
        FROM sale_items si
        WHERE si.sale_id=p_sale_id
          AND si.quantity > COALESCE((
              SELECT SUM(sri.quantity) FROM sale_return_items sri
              WHERE sri.original_sale_item_id=si.id
          ),0) + 0.000001
    ) THEN
        UPDATE sales SET payment_status='returned' WHERE id=p_sale_id;
    ELSE
        UPDATE sales SET payment_status='partial_return' WHERE id=p_sale_id;
    END IF;

    UPDATE sales
    SET invoice_number='CR-'||regexp_replace(COALESCE(v_sale.invoice_number,'RETURN'),'[^A-Za-z0-9-]','','g')||'-'||substr(v_credit_id::text,1,6)
    WHERE id=v_credit_id
    RETURNING invoice_number INTO v_credit_invoice;

    RETURN jsonb_build_object(
        'ok',true,'credit_invoice',v_credit_invoice,
        'refund_amount',round(v_total_refund,2),
        'credit_sale_id',v_credit_id
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION process_sale_return(UUID,UUID,UUID,JSONB,TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION process_sale_return(UUID,UUID,UUID,JSONB,TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION process_sale_return(UUID,UUID,UUID,JSONB,TEXT) TO service_role;

COMMIT;
