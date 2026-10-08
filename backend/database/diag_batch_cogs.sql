-- ═══════════════════════════════════════════════════════════════════════════
-- Batch COGS diagnostic — READ ONLY, changes nothing.
-- Supabase SQL Editor → Run all → paste EVERY result grid back.
--
-- Expected for the test scenario (10 @ cost 3, 10 @ cost 4, sell 15 @ 5):
--   query 1: migration_030_applied = true
--   query 2: the test item's two batches show unit_cost 3 and 4
--   query 3: latest sale has TWO rows for the item:
--              qty 10, unit_price 5, cost_price 3, total 50
--              qty  5, unit_price 5, cost_price 4, total 25
--   query 4: line_revenue 75, cogs 50, profit 25
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Is migration 030 (exact per-batch COGS) applied to THIS database?
SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'process_sale'
      AND prosrc LIKE '%Exact per-batch COGS%'
) AS migration_030_applied;

-- 2) Your 10 most recent batches — do they store their own unit_cost?
SELECT i.name AS item, b.batch_number, b.quantity_on_hand, b.unit_cost, b.received_at
FROM item_batches b
JOIN items i ON i.id = b.item_id
ORDER BY b.received_at DESC
LIMIT 10;

-- 3) Rows the report actually reads, from your most recent sales.
--    (Each FEFO split row carries the batch's own cost.)
SELECT s.invoice_number, s.created_at, si.item_name, si.quantity,
       si.unit_price, si.cost_price, si.total, si.batch_number
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
ORDER BY s.created_at DESC
LIMIT 20;

-- 4) Per-sale revenue / COGS / profit for your most recent sales.
SELECT s.invoice_number, s.created_at,
       SUM(si.total) AS line_revenue,
       SUM(COALESCE(si.cost_price, 0) * COALESCE(si.base_quantity, si.quantity)) AS cogs,
       SUM(si.total)
         - SUM(COALESCE(si.cost_price, 0) * COALESCE(si.base_quantity, si.quantity)) AS profit
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
GROUP BY s.id, s.invoice_number, s.created_at
ORDER BY s.created_at DESC
LIMIT 10;
