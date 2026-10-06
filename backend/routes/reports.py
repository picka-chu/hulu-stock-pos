"""
Reports Routes
FIXED: Use Supabase client directly for all aggregate queries
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import Optional
from datetime import date, datetime, timezone
from dateutil.relativedelta import relativedelta
from collections import defaultdict
import asyncio

from models import DailySalesReport, SalesByItem, TopSellingItem, ExpenseReport, ProfitReport
from middleware.auth import get_current_user, require_manager
from database import fetch_one, fetch_all, get_supabase_client

router = APIRouter()


def _fmt_qty(value) -> str:
    """Format a quantity, dropping the decimal part for whole numbers."""
    try:
        n = round(float(value), 2)
    except (TypeError, ValueError):
        return "0"
    return str(int(n)) if n == int(n) else str(n)


def _row_cogs(row: dict) -> float:
    """Cost of goods sold for a single sale_items row.

    Post-batch rows (those carrying a batch reference) store cost_price as a
    per-base-unit cost copied from item_batches.unit_cost, so COGS is
    cost_price * base_quantity. Legacy pre-batch rows stored cost_price as the
    per-purchase-unit price (items.buy_price); multiplying that by base_quantity
    inflates COGS by the units-per-pack factor (e.g. 140x), so those rows must
    use the sold/purchase quantity instead.
    """
    cost_price = float(row.get("cost_price") or 0)
    base_qty = float(row.get("base_quantity") or row.get("quantity") or 0)
    sold_qty = float(row.get("quantity") or row.get("base_quantity") or 0)
    has_batch = bool(row.get("batch_id") or row.get("batch_number"))
    return cost_price * (base_qty if has_batch else sold_qty)


def _tier_base_unit_price(tiers: list, field: str) -> "float | None":
    """Per-base-unit price (selling_price/purchase_cost) derived from an item's
    packaging tiers, mirroring the frontend `buildTierPriceMap`.

    Pharmacy items are sold in tiers (carton/box/strip/base); each tier stores a
    price for ONE tier-unit plus `base_unit_multiplier` (base units per tier).
    The per-base-unit price is therefore tier_price / base_unit_multiplier.
    Prefer an explicit 'base' tier; otherwise use the smallest-multiplier priced
    tier (the dispensing unit). Returns None when no tier carries a positive
    price for the requested field, so callers can fall back to items.* prices.
    """
    priced = [t for t in tiers if float(t.get(field) or 0) > 0]
    if not priced:
        return None
    base_tier = next((t for t in priced if str(t.get("unit_level") or "").lower() == "base"), None)
    tier = base_tier or min(priced, key=lambda t: float(t.get("base_unit_multiplier") or 1))
    mult = float(tier.get("base_unit_multiplier") or 1) or 1
    return float(tier.get(field) or 0) / mult


# ── Timezone + pagination helpers (shared with sales) ────────────────────────
# Reports bucket sales by the ORGANIZATION's local day (Ethiopia runs
# EAT/UTC+3, no DST) — slicing created_at[:10] puts late-night sales on the
# wrong day. Date filters are converted to UTC bounds so the DB range matches.
from routes.utils import _org_zone, _utc_window, _local_day, _local_month, _select_paged


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
        tz = await _org_zone(org_id)
        lo, hi = _utc_window(start_date, end_date, tz)
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")

        def _build(t):
            qq = t.select(
                "id, net_amount, tax_amount, discount_amount, total_amount, created_at"
            ).eq("organization_id", org_id).in_("payment_status", ["paid", "refunded", "returned", "partial_return"]).gte(
                "created_at", lo
            ).lte("created_at", hi)
            if effective_branch:
                qq = qq.eq("branch_id", str(effective_branch))
            return qq

        rows = await _select_paged(client, "sales", _build)

        # Group by date
        daily = defaultdict(lambda: {
            "total_transactions": 0,
            "total_revenue": 0.0,
            "total_tax": 0.0,
            "total_discount": 0.0,
            "gross_sales": 0.0
        })
        for row in rows:
            day = _local_day(row.get("created_at"), tz)
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
        tz = await _org_zone(org_id)
        lo, _hi = _utc_window(start_date, end_date, tz)
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")

        def _build(t):
            qq = t.select(
                "id, net_amount, tax_amount, discount_amount, total_amount, created_at"
            ).eq("organization_id", org_id).in_("payment_status", ["paid", "refunded", "returned", "partial_return"]).gte(
                "created_at", lo
            )
            if effective_branch:
                qq = qq.eq("branch_id", str(effective_branch))
            return qq

        rows = await _select_paged(client, "sales", _build)

        monthly = defaultdict(lambda: {
            "total_transactions": 0,
            "total_revenue": 0.0,
            "total_tax": 0.0,
            "total_discount": 0.0,
            "gross_sales": 0.0
        })
        for row in rows:
            created = _local_month(row.get("created_at"), tz)  # YYYY-MM, local
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
        tz = await _org_zone(org_id)
        lo, hi = _utc_window(start_date, end_date, tz)
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")

        def _build(t):
            qq = t.select("id").eq(
                "organization_id", org_id
            ).in_("payment_status", ["paid", "refunded", "returned", "partial_return"]).gte(
                "created_at", lo
            ).lte("created_at", hi)
            if effective_branch:
                qq = qq.eq("branch_id", str(effective_branch))
            return qq

        sales_rows = await _select_paged(client, "sales", _build, order_field="id")
        sale_ids = [r["id"] for r in sales_rows]

        if not sale_ids:
            return []

        # Get sale_items. We track the sold/display quantity and the base-unit
        # quantity separately: summing base_quantity as "quantity sold" makes the
        # report meaningless for pharmacy mode (shows "280 tablets" instead of
        # "2 boxes").
        item_totals = defaultdict(lambda: {
            "sold_quantity": 0.0, "base_quantity": 0.0, "revenue": 0.0,
            "cost": 0.0, "item_id": None,
        })

        chunk_size = 100
        for i in range(0, len(sale_ids), chunk_size):
            chunk = sale_ids[i:i + chunk_size]

            def _bi(t, _c=chunk):
                return t.select(
                    "item_id, quantity, base_quantity, unit_id, total, cost_price, batch_id, batch_number, batch_expiry_date"
                ).in_("sale_id", _c)

            for row in await _select_paged(client, "sale_items", _bi, order_field="id"):
                iid = row.get("item_id")
                if iid:
                    t = item_totals[iid]
                    t["item_id"] = iid
                    base_qty = float(row.get("base_quantity") or row.get("quantity") or 0)
                    sold_qty = float(row.get("quantity") or row.get("base_quantity") or 0)
                    t["sold_quantity"] += sold_qty
                    t["base_quantity"] += base_qty
                    t["revenue"] += float(row.get("total", 0))
                    t["cost"] += _row_cogs(row)
                    t.setdefault("batch_count", set()).add(row.get("batch_id") or row.get("batch_number") or "")
                    uid = row.get("unit_id")
                    if uid:
                        t.setdefault("unit_ids", set()).add(uid)

        if not item_totals:
            return []

        # Get item names + base unit - fetch all items for org
        all_item_ids = list(item_totals.keys())
        item_names = {}
        for i in range(0, len(all_item_ids), chunk_size):
            chunk = all_item_ids[i:i + chunk_size]
            qi2 = client.table("items").select("id, name, barcode, base_unit_id").in_("id", chunk)
            resp_n = await asyncio.to_thread(lambda: qi2.execute())
            for row in (resp_n.data or []):
                item_names[row["id"]] = {
                    "name": row.get("name", "Unknown"),
                    "barcode": row.get("barcode"),
                    "base_unit_id": row.get("base_unit_id"),
                }

        # Unit id -> label (abbreviation preferred) for sold/base unit display.
        units_map = {}
        try:
            qu = client.table("units").select("id, name, abbreviation").eq("organization_id", org_id)
            resp_u = await asyncio.to_thread(lambda: qu.execute())
            for u in (resp_u.data or []):
                units_map[u["id"]] = u.get("abbreviation") or u.get("name") or ""
        except Exception:
            units_map = {}

        result = []
        for iid, v in item_totals.items():
            info = item_names.get(iid, {})
            sold_q = round(v["sold_quantity"], 2)
            base_q = round(v["base_quantity"], 2)
            unit_ids = {u for u in v.get("unit_ids", set()) if u}
            sold_unit = units_map.get(next(iter(unit_ids))) if len(unit_ids) == 1 else ""
            base_unit = units_map.get(info.get("base_unit_id")) or ""
            mixed_units = len(unit_ids) > 1

            if mixed_units:
                # Sold quantities across different units can't be summed safely.
                quantity_display = f"{_fmt_qty(base_q)} {base_unit or 'base units'} (mixed units)"
            elif sold_unit and abs(base_q - sold_q) > 1e-9:
                quantity_display = f"{_fmt_qty(sold_q)} {sold_unit} ({_fmt_qty(base_q)} {base_unit or 'base units'})"
            elif sold_unit:
                quantity_display = f"{_fmt_qty(sold_q)} {sold_unit}"
            else:
                quantity_display = _fmt_qty(sold_q or base_q)

            result.append({
                "item_id": iid,
                "item_name": info.get("name", "Unknown Item"),
                "barcode": info.get("barcode"),
                "total_quantity": sold_q,
                "total_base_quantity": base_q,
                "sold_unit": sold_unit or None,
                "base_unit": base_unit or None,
                "mixed_units": mixed_units,
                "quantity_display": quantity_display,
                "total_revenue": round(v["revenue"], 2),
                "total_cost": round(v["cost"], 2),
                "batch_count": len([b for b in v.get("batch_count", set()) if b]),
            })

        # Rank by true unit volume (base units), which is comparable across items
        # regardless of the unit each was sold in.
        result.sort(key=lambda x: x["total_base_quantity"], reverse=True)
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
        # Get sales in period (with net/total so line revenue can be scaled
        # for the sale-level discount: line totals are pre-discount).
        tz = await _org_zone(org_id)
        lo, hi = _utc_window(start_date, end_date, tz)
        effective_branch = branch_id if (branch_id and branch_id not in ("undefined","")) else current_user.get("branch_id")

        def _build(t):
            qq = t.select("id, net_amount, total_amount, discount_amount").eq(
                "organization_id", org_id
            ).in_("payment_status", ["paid", "refunded", "returned", "partial_return"]).gte(
                "created_at", lo
            ).lte("created_at", hi)
            if effective_branch:
                qq = qq.eq("branch_id", str(effective_branch))
            return qq

        sales_rows = await _select_paged(client, "sales", _build, order_field="id")
        # net/total ratio scales pre-discount line totals down to what the
        # customer actually paid (ex-tax). Falls back to 1 when unknown.
        sale_scale = {}
        for r in sales_rows:
            tot = float(r.get("total_amount") or 0)
            sale_scale[r["id"]] = (float(r.get("net_amount") or 0) / tot) if tot > 0 else 1.0
        sale_ids = list(sale_scale.keys())

        total_revenue = 0.0
        total_cost = 0.0
        # Per-item accumulation so managers can see which products are actually
        # profitable instead of a single aggregate number.
        per_item = defaultdict(lambda: {"revenue": 0.0, "cost": 0.0, "item_id": None})

        if sale_ids:
            chunk_size = 100
            for i in range(0, len(sale_ids), chunk_size):
                chunk = sale_ids[i:i + chunk_size]

                def _bi(t, _c=chunk):
                    return t.select(
                        "sale_id, item_id, total, cost_price, quantity, base_quantity, batch_id, batch_number"
                    ).in_("sale_id", _c)

                for row in await _select_paged(client, "sale_items", _bi, order_field="id"):
                    scale = sale_scale.get(row.get("sale_id"), 1.0)
                    revenue = float(row.get("total", 0)) * scale
                    cost = _row_cogs(row)
                    total_revenue += revenue
                    total_cost += cost
                    iid = row.get("item_id")
                    if iid:
                        agg = per_item[iid]
                        agg["item_id"] = iid
                        agg["revenue"] += revenue
                        agg["cost"] += cost

        # Resolve item names/barcodes for the breakdown.
        item_info = {}
        item_ids = [iid for iid in per_item.keys() if iid]
        chunk_size = 100
        for i in range(0, len(item_ids), chunk_size):
            chunk = item_ids[i:i + chunk_size]
            qn = client.table("items").select("id, name, barcode").in_("id", chunk)
            resp_n = await asyncio.to_thread(lambda: qn.execute())
            for r in (resp_n.data or []):
                item_info[r["id"]] = {"name": r.get("name", "Unknown"), "barcode": r.get("barcode")}

        breakdown = []
        for iid, v in per_item.items():
            info = item_info.get(iid, {})
            revenue = round(v["revenue"], 2)
            cost = round(v["cost"], 2)
            profit = round(v["revenue"] - v["cost"], 2)
            margin = (profit / revenue * 100) if revenue > 0 else 0
            breakdown.append({
                "item_id": iid,
                "item_name": info.get("name", "Unknown Item"),
                "barcode": info.get("barcode"),
                "revenue": revenue,
                "cost": cost,
                "profit": profit,
                "profit_margin": round(margin, 2),
            })
        breakdown.sort(key=lambda x: x["profit"], reverse=True)

        gross_profit = total_revenue - total_cost

        # Operating expenses are not part of COGS. Keep the terminology explicit:
        # Net operating profit = Gross Profit - Operating Expenses.
        eq = client.table("expenses").select("amount").eq("organization_id", org_id).gte(
            "expense_date", start_date.isoformat()
        ).lte("expense_date", end_date.isoformat())
        if effective_branch:
            eq = eq.eq("branch_id", str(effective_branch))
        er = await asyncio.to_thread(lambda: eq.execute())
        operating_expenses = sum(float(r.get("amount") or 0) for r in (er.data or []))
        net_operating_profit = gross_profit - operating_expenses

        profit_margin = (gross_profit / total_revenue * 100) if total_revenue > 0 else 0
        net_margin = (net_operating_profit / total_revenue * 100) if total_revenue > 0 else 0

        return {
            "start_date": start_date,
            "end_date": end_date,
            "gross_sales": round(total_revenue, 2),
            "net_sales": round(total_revenue, 2),
            "total_revenue": round(total_revenue, 2),
            "total_cost": round(total_cost, 2),
            "cogs": round(total_cost, 2),
            "gross_profit": round(gross_profit, 2),
            "operating_expenses": round(operating_expenses, 2),
            "net_operating_profit": round(net_operating_profit, 2),
            "profit_margin": round(profit_margin, 2),
            "net_margin": round(net_margin, 2),
            "breakdown": breakdown,
        }
    except Exception as e:
        logger.error(f"Profit report error: {e}")
        return {"start_date": start_date, "end_date": end_date, "total_revenue": 0, "total_cost": 0, "gross_profit": 0, "profit_margin": 0, "breakdown": []}


@router.get("/stock-valuation")
async def get_stock_valuation(
    branch_id: str = None,
    current_user: dict = Depends(require_manager)
):
    """Batch-ledger stock valuation. Branch totals come from branch-owned batches."""
    from loguru import logger
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        return {"items": [], "total_cost_value": 0, "total_sell_value": 0, "potential_profit": 0}

    try:
        from middleware.auth import verify_branch_in_org
        if branch_id and branch_id not in ("undefined", "", "null"):
            if not await verify_branch_in_org(branch_id, str(org_id)):
                raise HTTPException(status_code=404, detail="Branch not found")
            effective_branch = branch_id
        else:
            effective_branch = current_user.get("branch_id")

        qb = client.table("item_batches").select(
            "item_id, quantity_on_hand, unit_cost, branch_id, batch_number, expiry_date"
        ).eq("organization_id", org_id).eq("is_active", True).gt("quantity_on_hand", 0)
        if effective_branch:
            qb = qb.eq("branch_id", str(effective_branch))
        batches_resp = await asyncio.to_thread(lambda: qb.execute())
        batches = batches_resp.data or []

        item_ids = list({b.get("item_id") for b in batches if b.get("item_id")})
        if not item_ids:
            return {"items": [], "total_cost_value": 0, "total_sell_value": 0, "potential_profit": 0}

        items_resp = await asyncio.to_thread(
            lambda: client.table("items").select(
                "id,name,barcode,buy_price,sell_price,category_id,base_unit_id"
            ).eq("organization_id", org_id).eq("is_active", True).in_("id", item_ids).execute()
        )
        item_map = {r["id"]: r for r in (items_resp.data or [])}

        tiers_by_item = defaultdict(list)
        for i in range(0, len(item_ids), 100):
            tr = await asyncio.to_thread(
                lambda chunk=item_ids[i:i+100]: client.table("item_packaging_tiers").select(
                    "item_id,unit_level,base_unit_multiplier,selling_price"
                ).eq("organization_id", org_id).in_("item_id", chunk).execute()
            )
            for row in (tr.data or []):
                tiers_by_item[row.get("item_id")].append(row)

        cat_ids = list({r.get("category_id") for r in item_map.values() if r.get("category_id")})
        cat_names = {}
        if cat_ids:
            cr = await asyncio.to_thread(lambda: client.table("categories").select("id,name").in_("id",cat_ids).execute())
            cat_names = {r["id"]: r["name"] for r in (cr.data or [])}

        agg = defaultdict(lambda: {"qty":0,"cost":0.0,"batches":0})
        expired_qty = 0
        expired_cost = 0.0
        from datetime import date as _vdate
        _vtoday = _vdate.today().isoformat()
        for b in batches:
            # Expired lots are unsellable (sale RPC blocks expiry <= today);
            # value them separately instead of mixing into sellable stock.
            _exp = b.get("expiry_date")
            if _exp and str(_exp) <= _vtoday:
                _eq = int(b.get("quantity_on_hand") or 0)
                expired_qty += _eq
                expired_cost += _eq * float(b.get("unit_cost") or 0)
                continue
            iid = b.get("item_id")
            qty = int(b.get("quantity_on_hand") or 0)
            agg[iid]["qty"] += qty
            agg[iid]["cost"] += qty * float(b.get("unit_cost") or 0)
            agg[iid]["batches"] += 1

        rows=[]
        total_cost=total_sell=0.0
        for iid,v in agg.items():
            item=item_map.get(iid,{})
            tier_price=_tier_base_unit_price(tiers_by_item.get(iid,[]),"selling_price")
            sell_per_base=tier_price if tier_price is not None else float(item.get("sell_price") or 0)
            sell_value=v["qty"]*sell_per_base
            total_cost += v["cost"]; total_sell += sell_value
            rows.append({
                "id": iid, "name": item.get("name","Unknown Item"),
                "barcode": item.get("barcode"), "stock_quantity": v["qty"],
                "batch_count": v["batches"], "category_name": cat_names.get(item.get("category_id"),""),
                "total_cost_value": round(v["cost"],2),
                "total_sell_value": round(sell_value,2)
            })
        rows.sort(key=lambda x:x["total_sell_value"], reverse=True)
        return {
            "items": rows,
            "total_cost_value": round(total_cost,2),
            "total_sell_value": round(total_sell,2),
            "potential_profit": round(total_sell-total_cost,2),
            "expired_quantity": expired_qty,
            "expired_cost_value": round(expired_cost,2)
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
        tz = await _org_zone(org_id)
        lo, hi = _utc_window(start_date, end_date, tz)
        sales = await _select_paged(client, "sales", lambda t: t.select("branch_id, net_amount").eq(
            "organization_id", org_id
        ).in_("payment_status", ["paid", "refunded", "returned", "partial_return"]).gte(
            "created_at", lo
        ).lte("created_at", hi))

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

        tz = await _org_zone(org_id)
        lo, hi = _utc_window(start_date, end_date, tz)

        def _build(t):
            qq = t.select("*") \
                .eq("organization_id", org_id) \
                .in_("payment_status", ["paid", "refunded", "returned", "partial_return"]) \
                .gte("created_at", lo) \
                .lte("created_at", hi)
            if branch_id:
                qq = qq.eq("branch_id", branch_id)
            return qq

        sales = await _select_paged(client, "sales", _build)
        sales.sort(key=lambda s: s.get("created_at") or "", reverse=True)

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

            # Format datetime in the org's local timezone
            try:
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                local = dt.astimezone(tz)
                sale_date = local.strftime("%Y-%m-%d")
                sale_time = local.strftime("%H:%M:%S")
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
                qty        = float(si.get("quantity", 1))
                qty        = int(qty) if qty == int(qty) else round(qty, 3)
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
    current_user: dict = Depends(require_manager)
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

    from middleware.auth import verify_branch_in_org
    if branch_id and branch_id not in ("undefined", "", "null"):
        if not await verify_branch_in_org(branch_id, str(org_id)):
            raise HTTPException(status_code=404, detail="Branch not found")
        effective_branch = branch_id
    else:
        effective_branch = current_user.get("branch_id")

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
