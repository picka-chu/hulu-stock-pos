-- X-POS financial regression tests
-- Run after migrations 025-027. Everything rolls back.
BEGIN;

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_batch UUID := gen_random_uuid();
  v_sale UUID := gen_random_uuid();
  v_credit JSONB;
  v_qty INTEGER;
  v_count INTEGER;
  v_refund NUMERIC;
BEGIN
  INSERT INTO organizations(id,name,currency,tenant_type)
  VALUES(v_org,'XPOS FINANCIAL TEST','ETB','retail');

  INSERT INTO branches(id,organization_id,name)
  VALUES(v_branch,v_org,'FINANCE TEST');

  INSERT INTO users(id,organization_id,branch_id,full_name,email,password_hash,role)
  VALUES(v_user,v_org,v_branch,'Finance Test','xpos-finance@example.invalid','not-real','admin');

  INSERT INTO items(id,organization_id,branch_id,name,buy_price,sell_price,stock_quantity)
  VALUES(v_item,v_org,v_branch,'RETURN TEST ITEM',100,200,10);

  INSERT INTO item_batches(
    id,organization_id,branch_id,item_id,batch_number,expiry_date,
    received_quantity,quantity_on_hand,unit_cost,is_active
  ) VALUES(
    v_batch,v_org,v_branch,v_item,'RET-001',CURRENT_DATE+365,
    10,10,100,true
  );

  PERFORM process_sale(jsonb_build_object(
    'sale_id',v_sale,'organization_id',v_org,'branch_id',v_branch,'user_id',v_user,
    'invoice_number','FIN-001','sold_by','Finance Test',
    'total_amount',1000,'tax_amount',0,'discount_amount',0,'net_amount',1000,
    'payment_method','cash',
    'items',jsonb_build_array(jsonb_build_object(
      'item_id',v_item,'quantity',5,'base_quantity',5,'unit_price',200,'cost_price',100
    )),
    'payments',jsonb_build_array(jsonb_build_object('payment_method','cash','amount',1000))
  ));

  SELECT quantity_on_hand INTO v_qty FROM item_batches WHERE id=v_batch;
  IF v_qty<>5 THEN RAISE EXCEPTION 'TEST FAILED: sale should leave batch at 5'; END IF;

  -- Return 3 units. They must go back into the exact original batch.
  SELECT process_sale_return(
    v_sale,v_org,v_user,
    jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',3)),
    'Customer return'
  ) INTO v_credit;

  IF NOT (v_credit ? 'ok') THEN RAISE EXCEPTION 'TEST FAILED: return did not succeed'; END IF;

  SELECT quantity_on_hand INTO v_qty FROM item_batches WHERE id=v_batch;
  IF v_qty<>8 THEN RAISE EXCEPTION 'TEST FAILED: original batch expected 8 after return, got %',v_qty; END IF;

  SELECT COUNT(*) INTO v_count
  FROM sale_return_items
  WHERE original_sale_id=v_sale AND batch_id=v_batch AND base_quantity=3;
  IF v_count<>1 THEN RAISE EXCEPTION 'TEST FAILED: return lineage missing'; END IF;

  SELECT COALESCE(SUM(total),0) INTO v_refund FROM sale_items
  WHERE sale_id=(v_credit->>'credit_sale_id')::UUID;
  IF v_refund<>-600 THEN RAISE EXCEPTION 'TEST FAILED: refund credit expected -600, got %',v_refund; END IF;

  -- Full remainder return must mark original sale returned.
  PERFORM process_sale_return(
    v_sale,v_org,v_user,
    jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',2)),
    'Customer return remainder'
  );

  IF (SELECT payment_status FROM sales WHERE id=v_sale) <> 'returned'
  THEN RAISE EXCEPTION 'TEST FAILED: original sale should be returned'; END IF;

  -- Expiry archive must create an auditable movement rather than silently
  -- zeroing stock.
  UPDATE item_batches SET expiry_date=CURRENT_DATE-1, is_active=true, quantity_on_hand=2
  WHERE id=v_batch;

  PERFORM archive_expired_batches(v_org);

  SELECT quantity_on_hand INTO v_qty FROM item_batches WHERE id=v_batch;
  IF v_qty<>0 THEN RAISE EXCEPTION 'TEST FAILED: expired batch not archived'; END IF;

  SELECT COUNT(*) INTO v_count
  FROM stock_movements
  WHERE batch_id=v_batch AND type='expired';
  IF v_count<>1 THEN RAISE EXCEPTION 'TEST FAILED: expiry movement missing'; END IF;
END;
$$;

ROLLBACK;
SELECT 'X-POS financial regression tests passed' AS result;
