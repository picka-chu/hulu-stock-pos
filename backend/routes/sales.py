"""
Sales Routes
FIXED:
- Store item name at time of sale (in sale_items.item_name)
- Retrieve item name from stored value, falling back to current item name
- Show ALL payment methods for split payments
- Multi-tenant organization filtering
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID, uuid4
from typing import List, Optional
from datetime import datetime, date
import random
import string
import asyncio

from models import SaleCreate, SaleResponse, SaleItemResponse, PaymentResponse, NotificationType
from middleware.auth import get_current_user, require_cashier
from database import fetch_one, fetch_all, insert_one, update_one, get_supabase_client

router = APIRouter()


def generate_invoice_number() -> str:
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    random_part = ''.join(random.choices(string.digits, k=4))
    return f"INV-{timestamp}-{random_part}"


async def _get_sale_items_with_names(client, sale_id: str) -> list:
    """
    Fetch sale items with item names.
    First tries item_name stored in sale_items (snapshot at sale time),
    then falls back to joining items table. Never returns 'Deleted Item' for
    items that exist — uses the stored snapshot name.
    """
    try:
        # Get sale_items with stored item_name snapshot
        q = client.table("sale_items").select("*").eq("sale_id", sale_id)
        resp = await asyncio.to_thread(lambda: q.execute())
        rows = resp.data or []

        if not rows:
            return []

        # Collect item_ids that don't have a stored name
        ids_needing_names = [
            r["item_id"] for r in rows
            if not r.get("item_name") and r.get("item_id")
        ]

        # Batch fetch current names for those
        live_names = {}
        if ids_needing_names:
            qn = client.table("items").select("id, name").in_("id", ids_needing_names)
            resp_n = await asyncio.to_thread(lambda: qn.execute())
            for item in (resp_n.data or []):
                live_names[item["id"]] = item["name"]

        grouped = {}
        for row in rows:
            name = (
                row.get("item_name")  # stored snapshot (preferred)
                or live_names.get(row.get("item_id"), "Deleted Item")  # live fallback
            )
            # FEFO can split one cart line across multiple batch rows. Aggregate
            # those rows for receipt/sales-history UX while reports can still
            # expose batch details from sale_items when needed.
            key = (row.get("item_id"), row.get("unit_id"), row.get("unit_price"), name)
            if key not in grouped:
                grouped[key] = {**row, "item_name": name}
                continue
            g = grouped[key]
            g["quantity"] = int(g.get("quantity") or 0) + int(row.get("quantity") or 0)
            g["base_quantity"] = float(g.get("base_quantity") or 0) + float(row.get("base_quantity") or row.get("quantity") or 0)
            g["total"] = float(g.get("total") or 0) + float(row.get("total") or 0)
            # Keep cost_price as weighted average per base unit for backward-compatible response shape.
            total_base = float(g.get("base_quantity") or 0)
            if total_base > 0:
                previous_cost = float(g.get("cost_price") or 0) * (total_base - float(row.get("base_quantity") or row.get("quantity") or 0))
                new_cost = float(row.get("cost_price") or 0) * float(row.get("base_quantity") or row.get("quantity") or 0)
                g["cost_price"] = (previous_cost + new_cost) / total_base
        return list(grouped.values())
    except Exception as e:
        from loguru import logger
        logger.error(f"get_sale_items_with_names error: {e}")
        return []


async def _get_payments(client, sale_id: str) -> list:
    try:
        q = client.table("payments").select("*").eq("sale_id", sale_id)
        resp = await asyncio.to_thread(lambda: q.execute())
        return resp.data or []
    except Exception as e:
        from loguru import logger
        logger.error(f"get_payments error: {e}")
        return []


def _build_sale_response(sale: dict, items: list, payments: list, branch_name: str = None) -> SaleResponse:
    """Build SaleResponse, computing payment_method from actual payments."""
    # Derive payment method(s) display from payments list
    if payments:
        methods = list({p["payment_method"] for p in payments if p.get("payment_method")})
        methods_display = " + ".join(sorted(methods))
    else:
        methods_display = sale.get("payment_method") or "cash"

    return SaleResponse(
        id=sale["id"],
        organization_id=sale["organization_id"],
        branch_id=sale["branch_id"],
        branch_name=branch_name or sale.get("branch_name"),
        user_id=sale["user_id"],
        invoice_number=sale["invoice_number"],
        sold_by=sale.get("sold_by", "Walk-in Customer"),
        total_amount=sale["total_amount"],
        tax_amount=sale["tax_amount"],
        discount_amount=sale["discount_amount"],
        net_amount=sale["net_amount"],
        payment_status=sale["payment_status"],
        payment_method=methods_display,
        notes=sale.get("notes"),
        created_at=sale["created_at"],
        items=[SaleItemResponse(**item) for item in items],
        payments=[PaymentResponse(**p) for p in payments]
    )


@router.post("", response_model=SaleResponse, status_code=status.HTTP_201_CREATED)
async def create_sale(
    sale_data: SaleCreate,
    current_user: dict = Depends(require_cashier)
):
    """Process a new sale"""
    from loguru import logger
    org_id = current_user["organization_id"]
    branch_id = str(sale_data.branch_id)
    user_id = current_user["id"]

    # Cashiers/managers may only sell from their assigned branch.
    # Admins are the only role allowed to operate across branches.
    if current_user.get("role") in ("cashier", "manager"):
        assigned_branch = current_user.get("branch_id")
        if not assigned_branch or str(assigned_branch) != branch_id:
            raise HTTPException(
                status_code=403,
                detail="You are not authorized to create sales for this branch."
            )

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    # Verify branch belongs to organization
    branch = await fetch_one("branches", {"id": branch_id, "organization_id": org_id})
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    # Strict False check — NULL/missing is_active means active (handles DB rows without the column set)
    if branch.get("is_active") is False:
        raise HTTPException(
            status_code=403,
            detail=f"Branch '{branch.get('name', branch_id)}' is deactivated. Sales are not allowed on inactive branches."
        )

    # Get organization settings for tax
    org = await fetch_one("organizations", {"id": org_id})
    tax_percentage = float(org["tax_percentage"] or 0) if org else 0

    # Validate items and calculate totals
    total_amount = 0
    items_data = []

    # Batch fetch all items in parallel instead of N sequential DB calls
    item_ids = [str(item.item_id) for item in sale_data.items]
    item_q = client.table("items").select("*") \
        .eq("organization_id", org_id) \
        .eq("is_active", True) \
        .in_("id", item_ids)
    # Items must belong to the sale branch (or be shared/unassigned items)
    batch_resp = await asyncio.to_thread(lambda: item_q.execute())
    products_map = {str(p["id"]): p for p in (batch_resp.data or [])
                    if p.get("branch_id") is None or str(p["branch_id"]) == branch_id}

    # Per-base-unit cost from packaging tiers. items.buy_price is stored per
    # purchase/stock unit (e.g. per carton) for pharmacy items, so it cannot be
    # used directly as a per-base-unit COGS fallback. tier.purchase_cost /
    # tier.base_unit_multiplier gives the true per-base cost; this is sent to
    # process_sale so COGS is correct even when a batch lacks unit_cost.
    base_unit_cost = {}
    if item_ids:
        tiers_q = client.table("item_packaging_tiers").select(
            "item_id, unit_level, base_unit_multiplier, purchase_cost"
        ).eq("organization_id", org_id).in_("item_id", item_ids)
        tiers_resp = await asyncio.to_thread(lambda: tiers_q.execute())
        from collections import defaultdict as _dd
        _tiers_by_item = _dd(list)
        for t in (tiers_resp.data or []):
            _tiers_by_item[str(t.get("item_id"))].append(t)
        for iid, tiers in _tiers_by_item.items():
            priced = [t for t in tiers if float(t.get("purchase_cost") or 0) > 0]
            if not priced:
                continue
            base_t = next((t for t in priced if str(t.get("unit_level") or "").lower() == "base"), None)
            tier = base_t or min(priced, key=lambda t: float(t.get("base_unit_multiplier") or 1))
            mult = float(tier.get("base_unit_multiplier") or 1) or 1
            base_unit_cost[iid] = float(tier.get("purchase_cost") or 0) / mult

    conversion_cache = {}

    async def to_base_quantity(product: dict, sale_item) -> float:
        unit_id = str(sale_item.unit_id) if sale_item.unit_id else str(product.get("sale_unit_id") or product.get("base_unit_id") or "")
        base_unit_id = str(product.get("base_unit_id") or unit_id)
        if not unit_id or unit_id == base_unit_id:
            return float(sale_item.quantity)
        key = (str(product["id"]), unit_id, base_unit_id)
        if key not in conversion_cache:
            resp = await asyncio.to_thread(
                lambda: client.table("unit_conversions").select("multiplier")
                    .eq("organization_id", org_id)
                    .eq("from_unit_id", unit_id)
                    .eq("to_unit_id", base_unit_id)
                    .or_(f"item_id.eq.{product['id']},item_id.is.null")
                    .limit(1).execute()
            )
            rows = resp.data or []
            unit_label = ""
            if not rows:
                # No unit_conversions row. Fall back to the item's packaging
                # tiers. A tier's `unit_level` is an abstract category
                # ('carton'/'box'/'strip'/'base') while `unit_label` holds the
                # free-form display label. Match the sold unit's abbreviation OR
                # name (case-insensitive) against BOTH columns so a unit whose
                # abbreviation isn't literally 'carton'/'box'/'strip' (e.g.
                # "ctn", "Carton (carton)") still resolves instead of failing
                # with an opaque 400 at the POS.
                unit_resp = await asyncio.to_thread(
                    lambda: client.table("units").select("abbreviation,name").eq("id", unit_id).limit(1).execute()
                )
                unit_row = (unit_resp.data or [None])[0] or {}
                unit_label = unit_row.get("abbreviation") or unit_row.get("name") or ""
                labels = {
                    str(unit_row.get("abbreviation") or "").strip().lower(),
                    str(unit_row.get("name") or "").strip().lower(),
                }
                labels.discard("")
                if labels:
                    tier_resp = await asyncio.to_thread(
                        lambda: client.table("item_packaging_tiers")
                            .select("unit_level, unit_label, base_unit_multiplier")
                            .eq("organization_id", org_id).eq("item_id", product["id"]).execute()
                    )
                    for t in (tier_resp.data or []):
                        if (str(t.get("unit_level") or "").strip().lower() in labels
                                or str(t.get("unit_label") or "").strip().lower() in labels):
                            rows = [t]
                            break
            if not rows:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"No unit conversion or packaging tier configured for "
                        f"{product['name']}"
                        + (f" (unit '{unit_label}')" if unit_label else "")
                    ),
                )
            conversion_cache[key] = float(rows[0].get("multiplier") or rows[0].get("base_unit_multiplier"))
        return float(sale_item.quantity) * conversion_cache[key]

    for item in sale_data.items:
        product = products_map.get(str(item.item_id))
        if not product:
            raise HTTPException(status_code=404, detail=f"Item not found: {item.item_id}")
        base_quantity = await to_base_quantity(product, item)
        if product["stock_quantity"] < base_quantity:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient stock for {product['name']}. Available: {product['stock_quantity']} base units"
            )

        item_total = item.quantity * item.unit_price
        total_amount += item_total

        items_data.append({
            "item": product,
            "quantity": item.quantity,
            "unit_id": str(item.unit_id) if item.unit_id else product.get("sale_unit_id"),
            "base_quantity": base_quantity,
            "unit_price": item.unit_price,
            "cost_price": float(product.get("buy_price", 0)),
            "total": item_total,
            "item_name": product["name"]  # Snapshot name at time of sale
        })

    # Calculate totals
    if sale_data.subtotal and sale_data.tax_amount:
        subtotal = sale_data.subtotal
        tax_amount = sale_data.tax_amount
        total_amount = sale_data.total_amount if sale_data.total_amount else subtotal + tax_amount
    else:
        tax_amount = total_amount * (tax_percentage / 100)
        total_amount = total_amount + tax_amount

    discount_amount = sale_data.discount_amount
    net_amount = total_amount - discount_amount

    cash_paid = sale_data.cash_paid or 0
    bank_paid = sale_data.bank_paid or 0
    mobile_money_paid = sale_data.mobile_money_paid or 0

    # Determine primary payment method for sales record (for backwards compat)
    active_methods = []
    if cash_paid > 0: active_methods.append("cash")
    if bank_paid > 0: active_methods.append("bank")
    if mobile_money_paid > 0: active_methods.append("mobile_money")
    primary_payment_method = "+".join(active_methods) if active_methods else "cash"

    invoice_number = generate_invoice_number()
    sale_id = str(uuid4())
    sold_by = current_user.get("full_name", current_user.get("email", "Unknown"))

    # ── Build payments list for atomic RPC ───────────────────────────────────
    payments_for_rpc = []
    if cash_paid > 0:
        payments_for_rpc.append({"payment_method": "cash", "amount": cash_paid, "bank_account_id": ""})
    if bank_paid > 0:
        payments_for_rpc.append({
            "payment_method": "bank", "amount": bank_paid,
            "bank_account_id": str(sale_data.bank_account_id) if sale_data.bank_account_id else ""
        })
    if mobile_money_paid > 0:
        mm_acct_id = str(sale_data.mobile_money_account_id) if sale_data.mobile_money_account_id else ""
        payments_for_rpc.append({
            "payment_method": "mobile_money",
            "amount": mobile_money_paid,
            "bank_account_id": mm_acct_id,   # reuse bank_account_id col to store mobile money provider id
        })
    if not payments_for_rpc:
        method = sale_data.payment_method.value if hasattr(sale_data.payment_method, 'value') else str(sale_data.payment_method)
        payments_for_rpc.append({
            "payment_method": method, "amount": net_amount,
            "bank_account_id": str(sale_data.bank_account_id) if sale_data.bank_account_id else ""
        })

    # Re-read stock with FOR UPDATE before RPC to prevent race conditions
    # (another concurrent request could sell the same stock between our check
    # above and the RPC call below). We do a sequential read inside the
    # transaction — the RPC itself uses FOR UPDATE, so this adds an extra
    # validation layer.
    try:
        for d in items_data:
            stock_check = await asyncio.to_thread(
                lambda iid=str(d["item"]["id"]), oid=org_id: client.table("items")
                    .select("stock_quantity").eq("id", iid).eq("organization_id", oid)
                    .limit(1).execute()
            )
            row = (stock_check.data or [None])[0]
            if row and row.get("stock_quantity", 0) < d.get("base_quantity", d["quantity"]):
                raise HTTPException(
                    status_code=409,
                    detail=f"Insufficient stock for {d['item']['name']}. Available: {row['stock_quantity']}"
                )
    except HTTPException:
        raise
    except Exception:
        pass  # best-effort — RPC will catch real conflicts

    rpc_payload = {
        "sale_id":          sale_id,
        "organization_id":  org_id,
        "branch_id":        branch_id,
        "user_id":          user_id,
        "invoice_number":   invoice_number,
        "sold_by":          sold_by,
        "total_amount":     total_amount,
        "tax_amount":       tax_amount,
        "discount_amount":  discount_amount,
        "net_amount":       net_amount,
        "payment_method":   primary_payment_method,
        "notes":            sale_data.notes or "",
        "items": [
            {
                "item_id":    str(d["item"]["id"]),
                "quantity":   d["quantity"],
                "unit_id":    d.get("unit_id") or "",
                "base_quantity": d.get("base_quantity", d["quantity"]),
                "unit_price": d["unit_price"],
                # Cost is normally taken from the FEFO batch's unit_cost inside
                # process_sale; this per-base-unit cost is the fallback used when
                # a batch has no unit_cost (so COGS never defaults to the raw
                # per-carton buy_price).
                "cost_price": base_unit_cost.get(str(d["item"]["id"]), float(d["item"].get("buy_price") or 0)),
                "total":      d["total"],
            }
            for d in items_data
        ],
        "payments": payments_for_rpc,
    }

    # Single atomic DB call — transaction guaranteed, stock locked with FOR UPDATE
    try:
        rpc_resp = await asyncio.to_thread(
            lambda: client.rpc("process_sale", {"p_sale": rpc_payload}).execute()
        )
        if not rpc_resp.data:
            raise HTTPException(status_code=500, detail="Sale processing returned no data")
    except HTTPException:
        raise
    except Exception as e:
        err_msg = str(e)
        known_business_errors = ("Insufficient stock", "Insufficient batch stock", "Item not found")
        if any(marker in err_msg for marker in known_business_errors):
            # Strip the PostgREST/PostgreSQL error envelope so the cashier
            # sees the actual reason (e.g. "Insufficient batch stock for
            # Paracetamol 500mg") instead of a raw exception repr.
            detail = err_msg
            if "DETAIL" in detail or "CONTEXT" in detail:
                detail = detail.split("\n")[0]
            raise HTTPException(status_code=400, detail=detail)
        logger.error(f"process_sale RPC error: {e}")
        raise HTTPException(status_code=500, detail="Failed to create sale — all changes rolled back")

    # Fetch final sale
    return_sale = await fetch_one("sales", {"id": sale_id, "organization_id": str(current_user["organization_id"])})
    sale_items = await _get_sale_items_with_names(client, sale_id)
    payments = await _get_payments(client, sale_id)

    # ── Fire broadcast notification for admins/managers ──────────────────────
    try:
        from .notifications import fire_sale_notification, fire_low_stock_notification
        branch_name = branch.get("name", "") if branch else ""
        await fire_sale_notification(
            org_id, sale_id, net_amount, sold_by,
            branch_name=branch_name, branch_id=branch_id
        )

        # Re-fetch authoritative post-sale stock from the DB. process_sale
        # recomputes stock_quantity inside the transaction (via
        # sync_item_stock_from_batches), so the in-memory product rows still
        # hold pre-sale quantities; subtracting base_quantity from those can
        # diverge from the real quantity and fire (or miss) low-stock alerts
        # with a wrong number.
        post_sale_qty = {}
        try:
            sold_ids = [str(d["item"]["id"]) for d in items_data]
            if sold_ids:
                sq_resp = await asyncio.to_thread(
                    lambda: client.table("items").select("id, stock_quantity")
                        .in_("id", sold_ids).execute()
                )
                post_sale_qty = {
                    str(r["id"]): r.get("stock_quantity")
                    for r in (sq_resp.data or [])
                }
        except Exception:
            post_sale_qty = {}

        # Fire low-stock alerts scoped to this branch
        for item_data in items_data:
            item = item_data["item"]
            db_qty = post_sale_qty.get(str(item["id"]))
            new_qty = (
                float(db_qty) if db_qty is not None
                else item["stock_quantity"] - item_data.get("base_quantity", item_data["quantity"])
            )
            min_lvl = int(item.get("min_stock_level", 0))
            if new_qty <= min_lvl:
                await fire_low_stock_notification(
                    org_id, str(item["id"]), item["name"], new_qty, min_lvl,
                    branch_name=branch_name, branch_id=branch_id
                )
    except Exception as notif_err:
        from loguru import logger
        logger.warning(f"Notification fire failed (non-critical): {notif_err}")
    # ─────────────────────────────────────────────────────────────────────────

    return _build_sale_response(return_sale, sale_items, payments, branch.get("name") if branch else None)


@router.get("", response_model=List[SaleResponse])
async def get_sales(
    page: int = 1,
    page_size: int = 10,  # capped at 100
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    payment_status: Optional[str] = None,
    payment_method: Optional[str] = None,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get sales for organization"""
    from loguru import logger
    page_size = min(page_size, 100)   # cap to prevent DoS
    org_id = current_user["organization_id"]
    branch_id = branch_id or current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return []

    try:
        q = client.table("sales").select("*").eq("organization_id", org_id)

        # Branch isolation for all roles
        role = current_user.get("role", "cashier")
        effective_branch = branch_id  # from query param (e.g. dashboard selector)
        if not effective_branch:
            effective_branch = current_user.get("branch_id")
        if effective_branch:
            q = q.eq("branch_id", str(effective_branch))
        # admin with no branch and no param = sees all branches

        if start_date:
            q = q.gte("created_at", datetime.combine(start_date, datetime.min.time()).isoformat())
        if end_date:
            q = q.lte("created_at", datetime.combine(end_date, datetime.max.time()).isoformat())
        if payment_status:
            q = q.eq("payment_status", payment_status)
        if payment_method:
            # payment_method can be: "cash", "bank", "mobile_money"
            # or "bank:UUID" / "mobile_money:UUID" for a specific account
            if ":" in payment_method:
                # filter by specific account — matches stored payment_method field or we'll filter post-fetch
                pm_type, pm_id = payment_method.split(":", 1)
                q = q.ilike("payment_method", f"%{pm_type}%")
            else:
                q = q.ilike("payment_method", f"%{payment_method}%")

        q = q.order("created_at", desc=True).range(
            (page - 1) * page_size, page * page_size - 1
        )

        resp = await asyncio.to_thread(lambda: q.execute())
        sales = resp.data or []

        if not sales:
            return []

        sale_ids = [s["id"] for s in sales]

        # Bulk fetch all sale_items and payments in 2 queries (not 2N)
        sale_items_resp, payments_resp = await asyncio.gather(
            asyncio.to_thread(
                lambda: client.table("sale_items").select("*").in_("sale_id", sale_ids).execute()
            ),
            asyncio.to_thread(
                lambda: client.table("payments").select("*").in_("sale_id", sale_ids).execute()
            ),
        )

        # Group by sale_id
        from collections import defaultdict as _dd
        all_items    = _dd(list)
        all_payments = _dd(list)
        for row in (sale_items_resp.data or []):
            all_items[row["sale_id"]].append(row)
        for row in (payments_resp.data or []):
            all_payments[row["sale_id"]].append(row)

        # Resolve item names (batch fetch items that have no stored name)
        needs_name = [
            r["item_id"] for rows in all_items.values()
            for r in rows if not r.get("item_name") and r.get("item_id")
        ]
        live_names = {}
        if needs_name:
            n_resp = await asyncio.to_thread(
                lambda: client.table("items").select("id,name").in_("id", list(set(needs_name))).execute()
            )
            for it in (n_resp.data or []):
                live_names[it["id"]] = it["name"]

        # Bulk fetch branch names for all sales
        branch_ids = list(set(s.get("branch_id") for s in sales if s.get("branch_id")))
        branch_names = {}
        if branch_ids:
            try:
                branch_resp = await asyncio.to_thread(
                    lambda: client.table("branches").select("id,name").in_("id", branch_ids).execute()
                )
                for b in (branch_resp.data or []):
                    branch_names[b["id"]] = b["name"]
            except Exception as e:
                logger.warning(f"Failed to fetch branch names: {e}")

        result = []
        for sale in sales:
            sid = sale["id"]
            items_with_names = [
                {**r, "item_name": r.get("item_name") or live_names.get(r.get("item_id"), "Deleted Item")}
                for r in all_items[sid]
            ]
            branch_name = branch_names.get(sale.get("branch_id")) if sale.get("branch_id") else None
            result.append(_build_sale_response(sale, items_with_names, all_payments[sid], branch_name))

        return result
    except Exception as e:
        logger.error(f"Get sales error: {e}")
        return []


@router.get("/{sale_id}", response_model=SaleResponse)
async def get_sale(sale_id: UUID, current_user: dict = Depends(get_current_user)):
    """Get sale by ID"""
    from loguru import logger
    org_id = current_user["organization_id"]

    sale = await fetch_one("sales", {"id": str(sale_id), "organization_id": org_id})
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    items = await _get_sale_items_with_names(client, str(sale_id))
    payments = await _get_payments(client, str(sale_id))

    # Fetch branch name for this sale
    branch_name = None
    if sale.get("branch_id"):
        try:
            branch = await fetch_one("branches", {"id": str(sale["branch_id"])})
            branch_name = branch.get("name") if branch else None
        except Exception as e:
            logger.warning(f"Failed to fetch branch name for sale {sale_id}: {e}")

    return _build_sale_response(sale, items, payments, branch_name)


@router.get("/receipt/{sale_id}")
async def get_receipt(sale_id: UUID, current_user: dict = Depends(get_current_user)):
    """Get sale receipt"""
    sale = await fetch_one("sales", {"id": str(sale_id), "organization_id": current_user["organization_id"]})
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    sale_items = await _get_sale_items_with_names(client, str(sale_id))
    org = await fetch_one("organizations", {"id": current_user["organization_id"]})
    payments = await _get_payments(client, str(sale_id))

    return {
        "sale": sale,
        "items": sale_items,
        "organization": org,
        "payments": payments
    }


# ── Sale Return / Refund ───────────────────────────────────────────────────────
@router.post("/{sale_id}/return")
async def return_sale(
    sale_id: UUID,
    body: dict,
    current_user: dict = Depends(require_cashier)
):
    """Atomically process a full/partial return while preserving original batch lineage."""
    from loguru import logger

    org_id = str(current_user["organization_id"])
    user_id = str(current_user["id"])
    items = body.get("items") or []
    reason = (body.get("reason") or "Customer return").strip()[:255]

    if not items:
        raise HTTPException(status_code=400, detail="No items specified for return")

    # Validate the public request shape before sending it to the database.
    normalized = []
    for row in items:
        try:
            item_id = str(row.get("item_id") or "")
            qty = float(row.get("quantity") or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid return item")
        if not item_id or qty <= 0:
            raise HTTPException(status_code=400, detail="Every return item needs a valid item and quantity")
        normalized.append({"item_id": item_id, "quantity": qty})

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        resp = await asyncio.to_thread(
            lambda: client.rpc(
                "process_sale_return",
                {
                    "p_sale_id": str(sale_id),
                    "p_organization_id": org_id,
                    "p_user_id": user_id,
                    "p_items": normalized,
                    "p_reason": reason,
                },
            ).execute()
        )
        result = resp.data
        if not result or not result.get("ok"):
            raise HTTPException(status_code=400, detail="Return could not be completed")
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        logger.error(f"[Sales] atomic return failed: {msg}")
        if any(x in msg for x in (
            "Sale not found", "already been fully returned", "not authorized",
            "exceeds the remaining", "Invalid return", "Original batch", "expired batch",
            "No valid return"
        )):
            raise HTTPException(status_code=400, detail=msg.split("\n")[0])
        raise HTTPException(status_code=500, detail="Return failed — no inventory or financial changes were committed")

    # App-level audit record for searchable admin history.
    try:
        from database import log_audit
        await log_audit(
            organization_id=org_id,
            user_id=user_id,
            branch_id=str((await fetch_one("sales", {"id": str(sale_id)} ) or {}).get("branch_id") or ""),
            action="sale_return",
            entity_type="sale",
            entity_id=str(sale_id),
            details={
                "credit_invoice": result.get("credit_invoice"),
                "refund_amount": result.get("refund_amount"),
                "reason": reason,
            },
        )
    except Exception as audit_err:
        logger.warning(f"[Sales] return audit logging failed: {audit_err}")

    return {
        "ok": True,
        "credit_invoice": result.get("credit_invoice"),
        "refund_amount": result.get("refund_amount"),
        "return_type": "full" if (await fetch_one("sales", {"id": str(sale_id)}) or {}).get("payment_status") == "returned" else "partial",
        "items_returned": len(normalized),
    }
