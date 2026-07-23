"""
Reports Routes
FIXED: Use Supabase client directly for all aggregate queries
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import Optional
from datetime import date, datetime
from dateutil.relativedelta import relativedelta
from collections import defaultdict
import asyncio

from models import DailySalesReport, SalesByItem, TopSellingItem, ExpenseReport, ProfitReport
from middleware.auth import get_current_user, require_manager
from database import fetch_one, fetch_all, get_supabase_client

router = APIRouter()


@router.get("/daily")
async def get_daily_sales_report(
    start_date: date = None,
    end_date: date = None,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get daily sales report"""
    from loguru import logger
    org_id = current_user["organization_id"]
    if not start_date:
        start_date = date.today()
    if not end_date:
        end_date = date.today()

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("sales").select(
            "id, net_amount, tax_amount, discount_amount, total_amount, created_at"
        ).eq("organization_id", org_id).eq("payment_status", "paid").gte(
            "created_at", datetime.combine(start_date, datetime.min.time()).isoformat()
        ).lte("created_at", datetime.combine(end_date, datetime.max.time()).isoformat())

        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))

        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        # Group by date
        daily = defaultdict(lambda: {
            "total_transactions": 0,
            "total_revenue": 0.0,
            "total_tax": 0.0,
            "total_discount": 0.0,
            "gross_sales": 0.0
        })
        for row in rows:
            day = (row.get("created_at") or "")[:10]
            if day:
                daily[day]["total_transactions"] += 1
                daily[day]["total_revenue"] += float(row.get("net_amount", 0))
                daily[day]["total_tax"] += float(row.get("tax_amount", 0))
                daily[day]["total_discount"] += float(row.get("discount_amount", 0))
                daily[day]["gross_sales"] += float(row.get("total_amount", 0))

        return [
            {
                "sale_date": d,
                "total_transactions": v["total_transactions"],
                "total_revenue": round(v["total_revenue"], 2),
                "total_tax": round(v["total_tax"], 2),
                "total_discount": round(v["total_discount"], 2),
                "gross_sales": round(v["gross_sales"], 2),
            }
            for d, v in sorted(daily.items(), reverse=True)
        ]
    except Exception as e:
        logger.error(f"Daily report error: {e}")
        return []


@router.get("/monthly")
async def get_monthly_sales_report(
    months: int = 12,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get monthly sales report"""
    from loguru import logger
    org_id = current_user["organization_id"]
    end_date = date.today()
    start_date = end_date - relativedelta(months=months)

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("sales").select(
            "id, net_amount, tax_amount, discount_amount, total_amount, created_at"
        ).eq("organization_id", org_id).eq("payment_status", "paid").gte(
            "created_at", datetime.combine(start_date, datetime.min.time()).isoformat()
        )
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))

        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        monthly = defaultdict(lambda: {
            "total_transactions": 0,
            "total_revenue": 0.0,
            "total_tax": 0.0,
            "total_discount": 0.0,
            "gross_sales": 0.0
        })
        for row in rows:
            created = (row.get("created_at") or "")[:7]  # YYYY-MM
            if created:
                monthly[created]["total_transactions"] += 1
                monthly[created]["total_revenue"] += float(row.get("net_amount", 0))
                monthly[created]["total_tax"] += float(row.get("tax_amount", 0))
                monthly[created]["total_discount"] += float(row.get("discount_amount", 0))
                monthly[created]["gross_sales"] += float(row.get("total_amount", 0))

        return [
            {
                "month": m,
                "total_transactions": v["total_transactions"],
                "total_revenue": round(v["total_revenue"], 2),
                "total_tax": round(v["total_tax"], 2),
                "total_discount": round(v["total_discount"], 2),
                "gross_sales": round(v["gross_sales"], 2),
            }
            for m, v in sorted(monthly.items(), reverse=True)
        ]
    except Exception as e:
        logger.error(f"Monthly report error: {e}")
        return []


@router.get("/by-item")
async def get_sales_by_item(
    start_date: date = None,
    end_date: date = None,
    limit: int = 20,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get sales by item"""
    from loguru import logger
    org_id = current_user["organization_id"]
    if not start_date:
        start_date = date.today().replace(day=1)
    if not end_date:
        end_date = date.today()

    client = await get_supabase_client()
    if not client:
        return []

    try:
        # Get sales IDs for the period, scoped to branch if provided
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        q = client.table("sales").select("id").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid").gte(
            "created_at", datetime.combine(start_date, datetime.min.time()).isoformat()
        ).lte("created_at", datetime.combine(end_date, datetime.max.time()).isoformat())
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))
        resp = await asyncio.to_thread(lambda: q.execute())
        sale_ids = [r["id"] for r in (resp.data or [])]

        if not sale_ids:
            return []

        # Get sale_items
        item_totals = defaultdict(lambda: {"quantity": 0, "revenue": 0.0, "cost": 0.0, "item_id": None})

        chunk_size = 100
        for i in range(0, len(sale_ids), chunk_size):
            chunk = sale_ids[i:i + chunk_size]
            qi = client.table("sale_items").select(
                "item_id, quantity, base_quantity, total, cost_price"
            ).in_("sale_id", chunk)
            resp_i = await asyncio.to_thread(lambda: qi.execute())
            for row in (resp_i.data or []):
                iid = row.get("item_id")
                if iid:
                    item_totals[iid]["item_id"] = iid
                    item_totals[iid]["quantity"] += float(row.get("quantity", 0))
                    item_totals[iid]["revenue"] += float(row.get("total", 0))
                    item_totals[iid]["cost"] += float(row.get("cost_price", 0)) * float(row.get("base_quantity") or row.get("quantity", 0))

        if not item_totals:
            return []

        # Get item names - fetch all items for org
        all_item_ids = list(item_totals.keys())
        item_names = {}
        for i in range(0, len(all_item_ids), chunk_size):
            chunk = all_item_ids[i:i + chunk_size]
            qi2 = client.table("items").select("id, name, barcode").in_("id", chunk)
            resp_n = await asyncio.to_thread(lambda: qi2.execute())
            for row in (resp_n.data or []):
                item_names[row["id"]] = {"name": row.get("name", "Unknown"), "barcode": row.get("barcode")}

        result = sorted(
            [
                {
                    "item_id": iid,
                    "item_name": item_names.get(iid, {}).get("name", "Unknown Item"),
                    "barcode": item_names.get(iid, {}).get("barcode"),
                    "total_quantity": v["quantity"],
                    "total_revenue": round(v["revenue"], 2),
                    "total_cost": round(v["cost"], 2),
                }
                for iid, v in item_totals.items()
            ],
            key=lambda x: x["total_quantity"],
            reverse=True
        )
        return result[:limit]
    except Exception as e:
        logger.error(f"Sales by item error: {e}")
        return []


@router.get("/top-selling")
async def get_top_selling_items(
    start_date: date = None,
    end_date: date = None,
    limit: int = 10,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get top selling items"""
    return await get_sales_by_item(start_date, end_date, limit, branch_id, current_user)


@router.get("/expenses")
async def get_expense_report(
    start_date: date = None,
    end_date: date = None,
    expense_type: str = None,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get expense report"""
    from loguru import logger
    org_id = current_user["organization_id"]
    if not start_date:
        start_date = date.today().replace(day=1)
    if not end_date:
        end_date = date.today()

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("expenses").select(
            "expense_type, amount"
        ).eq("organization_id", org_id).gte(
            "expense_date", start_date.isoformat()
        ).lte("expense_date", end_date.isoformat())

        if expense_type:
            q = q.eq("expense_type", expense_type)
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))

        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        totals = defaultdict(lambda: {"count": 0, "total_amount": 0.0})
        for row in rows:
            etype = row.get("expense_type", "other")
            totals[etype]["count"] += 1
            totals[etype]["total_amount"] += float(row.get("amount", 0))

        return sorted(
            [
                {
                    "expense_type": etype,
                    "count": v["count"],
                    "total_amount": round(v["total_amount"], 2)
                }
                for etype, v in totals.items()
            ],
            key=lambda x: x["total_amount"],
            reverse=True
        )
    except Exception as e:
        logger.error(f"Expense report error: {e}")
        return []


@router.get("/profit")
async def get_profit_report(
    start_date: date = None,
    end_date: date = None,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get profit report"""
    from loguru import logger
    org_id = current_user["organization_id"]
    if not start_date:
        start_date = date.today().replace(day=1)
    if not end_date:
        end_date = date.today()

    client = await get_supabase_client()
    if not client:
        return {"start_date": start_date, "end_date": end_date, "total_revenue": 0, "total_cost": 0, "gross_profit": 0, "profit_margin": 0}

    try:
        # Get sales IDs
        q = client.table("sales").select("id").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid").gte(
            "created_at", datetime.combine(start_date, datetime.min.time()).isoformat()
        ).lte("created_at", datetime.combine(end_date, datetime.max.time()).isoformat())
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))

        resp = await asyncio.to_thread(lambda: q.execute())
        sale_ids = [r["id"] for r in (resp.data or [])]

        total_revenue = 0.0
        total_cost = 0.0

        if sale_ids:
            chunk_size = 100
            for i in range(0, len(sale_ids), chunk_size):
                chunk = sale_ids[i:i + chunk_size]
                qi = client.table("sale_items").select(
                    "total, cost_price, quantity, base_quantity"
                ).in_("sale_id", chunk)
                resp_i = await asyncio.to_thread(lambda: qi.execute())
                for row in (resp_i.data or []):
                    total_revenue += float(row.get("total", 0))
                    total_cost += float(row.get("cost_price", 0)) * float(row.get("base_quantity") or row.get("quantity", 0))

        gross_profit = total_revenue - total_cost
        profit_margin = (gross_profit / total_revenue * 100) if total_revenue > 0 else 0

        return {
            "start_date": start_date,
            "end_date": end_date,
            "total_revenue": round(total_revenue, 2),
            "total_cost": round(total_cost, 2),
            "gross_profit": round(gross_profit, 2),
            "profit_margin": round(profit_margin, 2)
        }
    except Exception as e:
        logger.error(f"Profit report error: {e}")
        return {"start_date": start_date, "end_date": end_date, "total_revenue": 0, "total_cost": 0, "gross_profit": 0, "profit_margin": 0}


@router.get("/stock-valuation")
async def get_stock_valuation(
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Get stock valuation report"""
    from loguru import logger
    org_id = current_user["organization_id"]

    client = await get_supabase_client()
    if not client:
        return {"items": [], "total_cost_value": 0, "total_sell_value": 0, "potential_profit": 0}

    try:
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")
        q = client.table("items").select(
            "id, name, barcode, stock_quantity, buy_price, sell_price, category_id"
        ).eq("organization_id", org_id).eq("is_active", True).gt("stock_quantity", 0)
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))
        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        # Get category names
        cat_ids = list({r["category_id"] for r in rows if r.get("category_id")})
        cat_names = {}
        if cat_ids:
            qc = client.table("categories").select("id, name").in_("id", cat_ids)
            resp_c = await asyncio.to_thread(lambda: qc.execute())
            for c in (resp_c.data or []):
                cat_names[c["id"]] = c["name"]

        # Prefer live batch quantities/costs for valuation so mixed-cost lots are
        # valued accurately; fall back to item.buy_price for legacy rows.
        item_ids = [r["id"] for r in rows]
        batch_costs = defaultdict(float)
        if item_ids:
            for i in range(0, len(item_ids), 100):
                chunk = item_ids[i:i + 100]
                br = await asyncio.to_thread(
                    lambda ch=chunk: client.table("item_batches")
                        .select("item_id,quantity_on_hand,unit_cost")
                        .eq("organization_id", org_id)
                        .eq("is_active", True)
                        .gt("quantity_on_hand", 0)
                        .in_("item_id", ch)
                        .execute()
                )
                for b in (br.data or []):
                    batch_costs[b["item_id"]] += float(b.get("quantity_on_hand", 0)) * float(b.get("unit_cost", 0) or 0)

        items = []
        total_cost = 0.0
        total_sell = 0.0
        for row in rows:
            qty = int(row.get("stock_quantity", 0))
            buy = float(row.get("buy_price", 0))
            sell = float(row.get("sell_price", 0))
            cost_val = batch_costs.get(row["id"], qty * buy)
            sell_val = qty * sell
            total_cost += cost_val
            total_sell += sell_val
            items.append({
                **row,
                "category_name": cat_names.get(row.get("category_id"), ""),
                "total_cost_value": round(cost_val, 2),
                "total_sell_value": round(sell_val, 2)
            })

        items.sort(key=lambda x: x["total_sell_value"], reverse=True)

        return {
            "items": items,
            "total_cost_value": round(total_cost, 2),
            "total_sell_value": round(total_sell, 2),
            "potential_profit": round(total_sell - total_cost, 2)
        }
    except Exception as e:
        logger.error(f"Stock valuation error: {e}")
        return {"items": [], "total_cost_value": 0, "total_sell_value": 0, "potential_profit": 0}


@router.get("/by-branch")
async def get_sales_by_branch(
    start_date: date = None,
    end_date: date = None,
    current_user: dict = Depends(require_manager)
):
    """Get sales by branch"""
    from loguru import logger
    org_id = current_user["organization_id"]
    if not start_date:
        start_date = date.today().replace(day=1)
    if not end_date:
        end_date = date.today()

    client = await get_supabase_client()
    if not client:
        return []

    try:
        # Get branches
        qb = client.table("branches").select("id, name").eq(
            "organization_id", org_id
        ).eq("is_active", True)
        resp_b = await asyncio.to_thread(lambda: qb.execute())
        branches = resp_b.data or []

        # Get sales in period
        qs = client.table("sales").select("branch_id, net_amount").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid").gte(
            "created_at", datetime.combine(start_date, datetime.min.time()).isoformat()
        ).lte("created_at", datetime.combine(end_date, datetime.max.time()).isoformat())
        resp_s = await asyncio.to_thread(lambda: qs.execute())
        sales = resp_s.data or []

        branch_totals = defaultdict(lambda: {"total_transactions": 0, "total_revenue": 0.0})
        for sale in sales:
            bid = sale.get("branch_id")
            if bid:
                branch_totals[bid]["total_transactions"] += 1
                branch_totals[bid]["total_revenue"] += float(sale.get("net_amount", 0))

        result = [
            {
                "branch_id": b["id"],
                "branch_name": b["name"],
                "total_transactions": branch_totals[b["id"]]["total_transactions"],
                "total_revenue": round(branch_totals[b["id"]]["total_revenue"], 2)
            }
            for b in branches
        ]
        result.sort(key=lambda x: x["total_revenue"], reverse=True)
        return result
    except Exception as e:
        logger.error(f"Branch report error: {e}")
        return []


@router.get("/sales-export")
async def get_sales_export(
    start_date: date = None,
    end_date: date = None,
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """
    Full sales export: one row per item sold.
    Includes sale date/time, receipt#, item name, barcode, category,
    qty, unit price, subtotal, discount, tax, total, payment method(s),
    customer name, sold by (cashier name), branch name.
    """
    import logging
    logger = logging.getLogger("reports")
    org_id = current_user["organization_id"]

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        # ── 1. Fetch sales in date range ──────────────────────────────────
        if not start_date:
            start_date = date.today().replace(day=1)
        if not end_date:
            end_date = date.today()

        q = client.table("sales").select("*") \
            .eq("organization_id", org_id) \
            .eq("payment_status", "paid") \
            .gte("created_at", start_date.isoformat()) \
            .lte("created_at", f"{end_date.isoformat()}T23:59:59")

        if branch_id:
            q = q.eq("branch_id", branch_id)

        resp = await asyncio.to_thread(lambda: q.order("created_at", desc=True).execute())
        sales = resp.data or []

        if not sales:
            return []

        # ── 2. Batch-fetch lookup maps ────────────────────────────────────
        # Users (cashiers)
        users_resp = await asyncio.to_thread(
            lambda: client.table("users")
                .select("id,full_name,email")
                .eq("organization_id", org_id)
                .execute()
        )
        user_map = {u["id"]: u.get("full_name") or u.get("email", "Unknown")
                    for u in (users_resp.data or [])}

        # Branches
        branch_resp = await asyncio.to_thread(
            lambda: client.table("branches")
                .select("id,name")
                .eq("organization_id", org_id)
                .execute()
        )
        branch_map = {b["id"]: b["name"] for b in (branch_resp.data or [])}

        # Categories
        cat_resp = await asyncio.to_thread(
            lambda: client.table("categories")
                .select("id,name")
                .eq("organization_id", org_id)
                .execute()
        )
        cat_map = {c["id"]: c["name"] for c in (cat_resp.data or [])}

        # ── 3. For each sale, fetch sale_items + payments ─────────────────
        rows = []
        for sale in sales:
            sale_id = sale["id"]
            created_at = sale.get("created_at", "")

            # Format datetime nicely
            try:
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                sale_date = dt.strftime("%Y-%m-%d")
                sale_time = dt.strftime("%H:%M:%S")
            except Exception:
                sale_date = created_at[:10] if created_at else ""
                sale_time = created_at[11:19] if len(created_at) > 10 else ""

            # Payment methods
            pay_resp = await asyncio.to_thread(
                lambda sid=sale_id: client.table("payments")
                    .select("payment_method,amount")
                    .eq("sale_id", sid)
                    .execute()
            )
            payments = pay_resp.data or []
            payment_methods = ", ".join(
                f"{p['payment_method']} ({p['amount']})"
                for p in payments
            ) if payments else (sale.get("payment_method") or "cash")

            # Sale-level info
            cashier_name = user_map.get(sale.get("created_by", ""), "Unknown")
            branch_name  = branch_map.get(sale.get("branch_id", ""), "")
            receipt_no   = sale.get("receipt_number") or sale_id[:8].upper()
            customer     = sale.get("customer_name") or "Walk-in"
            discount     = float(sale.get("discount_amount", 0))
            tax          = float(sale.get("tax_amount", 0))
            net_total    = float(sale.get("net_amount", 0))

            # Fetch sale items
            items_resp = await asyncio.to_thread(
                lambda sid=sale_id: client.table("sale_items")
                    .select("*")
                    .eq("sale_id", sid)
                    .execute()
            )
            sale_items = items_resp.data or []

            if not sale_items:
                # Sale with no line items — include as single row
                rows.append({
                    "Date":             sale_date,
                    "Time":             sale_time,
                    "Receipt #":        receipt_no,
                    "Item Name":        "(no items)",
                    "Barcode":          "",
                    "Category":         "",
                    "Batch ID":         "",
                    "Batch #":          "",
                    "Batch Expiry":     "",
                    "Qty":              0,
                    "Unit Price":       0,
                    "Subtotal":         0,
                    "Discount":         discount,
                    "Tax":              tax,
                    "Total":            net_total,
                    "Payment Method":   payment_methods,
                    "Customer":         customer,
                    "Sold By":          cashier_name,
                    "Branch":           branch_name,
                })
                continue

            for idx, si in enumerate(sale_items):
                qty        = int(si.get("quantity", 1))
                unit_price = float(si.get("unit_price", 0))
                subtotal   = float(si.get("subtotal", unit_price * qty))
                item_name  = si.get("item_name") or si.get("name") or "Deleted Item"
                barcode    = si.get("barcode", "")
                cat_id     = si.get("category_id", "")
                category   = cat_map.get(cat_id, "")
                batch_id   = si.get("batch_id") or ""
                batch_no   = si.get("batch_number") or ""
                batch_exp  = si.get("batch_expiry_date") or ""

                # Only put sale totals on first line item row (cleaner spreadsheet)
                is_first = (idx == 0)

                rows.append({
                    "Date":             sale_date,
                    "Time":             sale_time,
                    "Receipt #":        receipt_no,
                    "Item Name":        item_name,
                    "Barcode":          barcode,
                    "Category":         category,
                    "Batch ID":         batch_id,
                    "Batch #":          batch_no,
                    "Batch Expiry":     batch_exp,
                    "Qty":              qty,
                    "Unit Price":       unit_price,
                    "Subtotal":         subtotal,
                    "Discount":         discount     if is_first else "",
                    "Tax":              tax          if is_first else "",
                    "Total":            net_total    if is_first else "",
                    "Payment Method":   payment_methods if is_first else "",
                    "Customer":         customer     if is_first else "",
                    "Sold By":          cashier_name if is_first else "",
                    "Branch":           branch_name  if is_first else "",
                })

        return {
            "rows": rows,
            "summary": {
                "total_sales":        len(sales),
                "total_items_sold":   sum(1 for r in rows if r.get("Item Name") != "(no items)"),
                "total_revenue":      round(sum(
                    float(r["Total"] or 0) for r in rows if r.get("Total") not in ("", None)
                ), 2),
                "total_discount":     round(sum(
                    float(r["Discount"] or 0) for r in rows if r.get("Discount") not in ("", 0, None)
                ), 2),
                "total_tax":          round(sum(
                    float(r["Tax"] or 0) for r in rows if r.get("Tax") not in ("", 0, None)
                ), 2),
                "period_start":       start_date.isoformat(),
                "period_end":         end_date.isoformat(),
                "organization_name":  "",  # filled client-side
            }
        }

    except Exception as e:
        logger.error(f"Sales export error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


# ── Inventory CSV export ──────────────────────────────────────────────────────

@router.get("/inventory-export")
async def export_inventory(
    branch_id: str = None,
    current_user: dict = Depends(get_current_user)
):
    """
    Export full inventory as CSV, scoped to branch if provided.
    """
    import csv, io
    from fastapi.responses import StreamingResponse
    from database import get_supabase_client
    import asyncio as _asyncio

    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")

    # Fetch all items (scoped to branch if provided)
    _iq = client.table("items").select("*") \
        .eq("organization_id", org_id) \
        .eq("is_active", True) \
        .order("name")
    if effective_branch:
        _iq = _iq.eq("branch_id", str(effective_branch))
    resp = await _asyncio.to_thread(lambda: _iq.execute())
    items = resp.data or []

    # Fetch category names
    cat_ids = list({r["category_id"] for r in items if r.get("category_id")})
    sup_ids = list({r["supplier_id"] for r in items if r.get("supplier_id")})
    cat_map = {}; sup_map = {}
    if cat_ids:
        cr = await _asyncio.to_thread(lambda: client.table("categories").select("id,name").in_("id", cat_ids).execute())
        cat_map = {c["id"]: c["name"] for c in (cr.data or [])}
    if sup_ids:
        sr = await _asyncio.to_thread(lambda: client.table("suppliers").select("id,name").in_("id", sup_ids).execute())
        sup_map = {s["id"]: s["name"] for s in (sr.data or [])}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Name", "Brand", "Barcode", "Category", "Supplier",
        "Buy Price", "Sell Price", "Stock Quantity",
        "Min Stock Level", "Expiry Date", "Description", "AI Status"
    ])
    for item in items:
        writer.writerow([
            item.get("name", ""),
            item.get("brand", ""),
            item.get("barcode", ""),
            cat_map.get(item.get("category_id", ""), ""),
            sup_map.get(item.get("supplier_id", ""), ""),
            item.get("buy_price", 0),
            item.get("sell_price", 0),
            item.get("stock_quantity", 0),
            item.get("min_stock_level", 10),
            item.get("expiry_date", ""),
            item.get("description", ""),
            item.get("ai_status", ""),
        ])

    output.seek(0)
    from datetime import date as _date
    filename = f"inventory_{org_id[:8]}_{_date.today()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
