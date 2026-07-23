"""
Dashboard Routes
Dashboard statistics and overview
FIXED: Use Supabase client directly for aggregate queries
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import Optional
from datetime import date, datetime
from dateutil.relativedelta import relativedelta
import asyncio

from models import DashboardStats
from middleware.auth import get_current_user
from database import fetch_one, fetch_all, get_supabase_client

router = APIRouter()


@router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get dashboard statistics"""
    from loguru import logger
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        return DashboardStats(
            today_sales=0, today_transactions=0, today_profit=0,
            low_stock_count=0, expiring_soon_count=0,
            total_items=0, total_customers=0
        )
    # Handle branch_id
    user_branch_id = None
    if branch_id and branch_id != "undefined" and branch_id.strip():
        try:
            user_branch_id = str(UUID(branch_id))
        except Exception:
            user_branch_id = current_user.get("branch_id")
    else:
        user_branch_id = current_user.get("branch_id")

    today = date.today()
    today_start = datetime.combine(today, datetime.min.time()).isoformat()
    today_end = datetime.combine(today, datetime.max.time()).isoformat()

    # ── Fetch org timezone and compute real "today" boundaries ────────────────
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        org_resp = await asyncio.to_thread(
            lambda: client.table("organizations").select("timezone").eq("id", org_id).limit(1).execute()
        )
        tz_name = (org_resp.data or [{}])[0].get("timezone") or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, Exception):
            tz = ZoneInfo("UTC")

        now_local  = datetime.now(tz)
        today_local = now_local.date()
        # Midnight local time → convert to UTC ISO for Supabase query
        from datetime import timezone as _tz
        today_start = datetime.combine(today_local, datetime.min.time(), tzinfo=tz).astimezone(_tz.utc).isoformat()
        today_end   = datetime.combine(today_local, datetime.max.time(), tzinfo=tz).astimezone(_tz.utc).isoformat()
    except Exception as _tz_err:
        logger.warning(f"Timezone lookup failed, using server date: {_tz_err}")
        # Fallback: use server local date
        today_start = datetime.combine(today, datetime.min.time()).isoformat()
        today_end   = datetime.combine(today, datetime.max.time()).isoformat()

    

    # Today's Sales
    try:
        q = client.table("sales").select("id, net_amount").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid").gte(
            "created_at", today_start
        ).lte("created_at", today_end)
        if user_branch_id:
            q = q.eq("branch_id", user_branch_id)
        resp = await asyncio.to_thread(lambda: q.execute())
        sales_rows = resp.data or []
        today_sales = sum(float(r.get("net_amount", 0)) for r in sales_rows)
        today_transactions = len(sales_rows)
        today_sale_ids = [r["id"] for r in sales_rows if "id" in r]
    except Exception as e:
        logger.error(f"Dashboard today_sales error: {e}")
        today_sales = 0.0
        today_transactions = 0
        today_sale_ids = []

    # Today's Profit
    today_profit = 0.0
    if today_sale_ids:
        try:
            chunk_size = 50
            for i in range(0, len(today_sale_ids), chunk_size):
                chunk = today_sale_ids[i:i + chunk_size]
                qi = client.table("sale_items").select(
                    "total, cost_price, quantity, base_quantity, batch_id, batch_number"
                ).in_("sale_id", chunk)
                resp_i = await asyncio.to_thread(lambda: qi.execute())
                for row in (resp_i.data or []):
                    revenue = float(row.get("total", 0))
                    base_qty = float(row.get("base_quantity") or row.get("quantity", 0))
                    sold_qty = float(row.get("quantity") or row.get("base_quantity", 0))
                    has_batch = bool(row.get("batch_id") or row.get("batch_number"))
                    cost = float(row.get("cost_price", 0)) * (base_qty if has_batch else sold_qty)
                    today_profit += revenue - cost
        except Exception as e:
            logger.error(f"Dashboard profit error: {e}")

    # Low Stock Count
    try:
        lq = client.table("items").select("stock_quantity, min_stock_level").eq(
            "organization_id", org_id
        ).eq("is_active", True)
        if user_branch_id:
            lq = lq.eq("branch_id", user_branch_id)
        resp_l = await asyncio.to_thread(lambda: lq.execute())
        low_stock_count = sum(
            1 for r in (resp_l.data or [])
            if int(r.get("stock_quantity", 0)) <= int(r.get("min_stock_level", 0))
        )
    except Exception as e:
        logger.error(f"Dashboard low_stock error: {e}")
        low_stock_count = 0

    # Expiring Soon (within 7 days)
    try:
        expiry_date = (today + relativedelta(days=7)).isoformat()
        eq = client.table("items").select("id").eq(
            "organization_id", org_id
        ).eq("is_active", True).lte(
            "expiry_date", expiry_date
        ).gte("expiry_date", today.isoformat()).gt("stock_quantity", 0)
        resp_e = await asyncio.to_thread(lambda: eq.execute())
        expiring_soon_count = len(resp_e.data or [])
    except Exception as e:
        logger.error(f"Dashboard expiring error: {e}")
        expiring_soon_count = 0

    # Total Items
    try:
        tq = client.table("items").select("id").eq(
            "organization_id", org_id
        ).eq("is_active", True)
        if user_branch_id:
            tq = tq.eq("branch_id", user_branch_id)
        resp_t = await asyncio.to_thread(lambda: tq.execute())
        total_items = len(resp_t.data or [])
    except Exception as e:
        logger.error(f"Dashboard total_items error: {e}")
        total_items = 0

    # Total Customers (distinct user_ids)
    try:
        cq = client.table("sales").select("user_id").eq("organization_id", org_id)
        if user_branch_id:
            cq = cq.eq("branch_id", user_branch_id)
        resp_c = await asyncio.to_thread(lambda: cq.execute())
        total_customers = len(set(
            r.get("user_id") for r in (resp_c.data or []) if r.get("user_id")
        ))
    except Exception as e:
        logger.error(f"Dashboard customers error: {e}")
        total_customers = 0

    return DashboardStats(
        today_sales=today_sales,
        today_transactions=today_transactions,
        today_profit=today_profit,
        low_stock_count=low_stock_count,
        expiring_soon_count=expiring_soon_count,
        total_items=total_items,
        total_customers=total_customers
    )


@router.get("/recent-sales")
async def get_recent_sales(
    limit: int = 10,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get recent sales"""
    from loguru import logger
    org_id = current_user["organization_id"]

    user_branch_id = None
    if branch_id and branch_id != "undefined" and branch_id.strip():
        try:
            user_branch_id = str(UUID(branch_id))
        except Exception:
            user_branch_id = current_user.get("branch_id")
    else:
        user_branch_id = current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("sales").select("*").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid")
        if user_branch_id:
            q = q.eq("branch_id", user_branch_id)
        q = q.order("created_at", desc=True).limit(limit)
        resp = await asyncio.to_thread(lambda: q.execute())
        return resp.data or []
    except Exception as e:
        logger.error(f"Recent sales error: {e}")
        return []


@router.get("/low-stock-items")
async def get_low_stock_items(
    limit: int = 10,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get low stock items"""
    from loguru import logger
    org_id = current_user["organization_id"]

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("items").select("*").eq(
            "organization_id", org_id
        ).eq("is_active", True)
        if branch_id and branch_id != 'undefined':
            q = q.eq("branch_id", branch_id)
        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        result = [
            r for r in rows
            if int(r.get("stock_quantity", 0)) <= int(r.get("min_stock_level", 0))
        ]
        result.sort(key=lambda x: x.get("stock_quantity", 0))
        return result[:limit]
    except Exception as e:
        logger.error(f"Low stock error: {e}")
        return []


@router.get("/expiring-items")
async def get_expiring_items(
    days: int = 7,
    limit: int = 10,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get expiring items"""
    from loguru import logger
    from datetime import timedelta
    org_id = current_user["organization_id"]
    today = date.today()
    expiry_date = today + timedelta(days=days)

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("items").select("*").eq(
            "organization_id", org_id
        ).eq("is_active", True).lte(
            "expiry_date", expiry_date.isoformat()
        ).gte("expiry_date", today.isoformat()).gt("stock_quantity", 0)
        if branch_id and branch_id != 'undefined':
            q = q.eq("branch_id", branch_id)
        q = q.order("expiry_date").limit(limit)
        resp = await asyncio.to_thread(lambda: q.execute())
        return resp.data or []
    except Exception as e:
        logger.error(f"Expiring items error: {e}")
        return []


@router.get("/sales-chart")
async def get_sales_chart(
    days: int = 30,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get sales chart data - aggregated by day"""
    from loguru import logger
    from datetime import timedelta
    from collections import defaultdict
    org_id = current_user["organization_id"]

    user_branch_id = None
    if branch_id and branch_id != "undefined" and branch_id.strip():
        try:
            user_branch_id = str(UUID(branch_id))
        except Exception:
            user_branch_id = current_user.get("branch_id")
    else:
        user_branch_id = current_user.get("branch_id")

    start_date = (date.today() - timedelta(days=days)).isoformat()

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("sales").select("net_amount, created_at").eq(
            "organization_id", org_id
        ).eq("payment_status", "paid").gte("created_at", start_date)
        if user_branch_id:
            q = q.eq("branch_id", user_branch_id)
        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        # Aggregate by date in Python
        daily = defaultdict(float)
        for row in rows:
            created = row.get("created_at", "")
            if created:
                day = created[:10]  # "YYYY-MM-DD"
                daily[day] += float(row.get("net_amount", 0))

        return [
            {"date": d, "total": round(v, 2)}
            for d, v in sorted(daily.items())
        ]
    except Exception as e:
        logger.error(f"Sales chart error: {e}")
        return []
