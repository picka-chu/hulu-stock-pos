"""
Items Routes
CRUD operations for items/products
"""
from fastapi import APIRouter, HTTPException, status, Depends, UploadFile, File
from uuid import UUID, uuid4
from typing import List, Optional
from datetime import date, datetime, timedelta
import base64
import os
from loguru import logger

from models import ItemCreate, ItemUpdate, ItemResponse, ItemWithDetails, NotificationType
from middleware.auth import get_current_user, require_manager
from database import fetch_one, fetch_all, insert_one, update_one, delete_one, upload_file_to_storage, get_supabase_client
import asyncio

router = APIRouter()


async def _deduct_batches_fefo(client, item: dict, quantity: int, org_id: str, branch_id: str | None, user_id: str, reference_type: str, notes: str | None = None) -> int:
    """Deduct adjustment/shrinkage quantities from batches in FEFO order.

    Sales already use the database RPC. Manager stock reductions also need to
    consume item_batches so item totals cannot diverge from batch quantities.
    Returns the synchronized item quantity after all batch deductions.
    """
    if quantity <= 0:
        return int(item.get("stock_quantity") or 0)
    item_id = str(item["id"])
    prev_item_qty = int(item.get("stock_quantity") or 0)
    if prev_item_qty < quantity:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Insufficient stock")

    from datetime import date as _date
    _today = _date.today().isoformat()
    _q = client.table("item_batches") \
        .select("id,batch_number,expiry_date,quantity_on_hand") \
        .eq("organization_id", org_id) \
        .eq("item_id", item_id) \
        .eq("is_active", True) \
        .gt("quantity_on_hand", 0) \
        .or_(f"expiry_date.is.null,expiry_date.gt.{_today}")
    if branch_id:
        _q = _q.eq("branch_id", str(branch_id))
    resp = await asyncio.to_thread(
        lambda: _q
            .order("expiry_date", desc=False, nullsfirst=False)
            .order("received_at", desc=False)
            .order("id", desc=False)
            .execute()
    )
    remaining = quantity
    for batch in (resp.data or []):
        if remaining <= 0:
            break
        take = min(remaining, int(batch.get("quantity_on_hand") or 0))
        if take <= 0:
            continue
        new_batch_qty = int(batch.get("quantity_on_hand") or 0) - take
        await asyncio.to_thread(
            lambda bid=batch["id"], nbq=new_batch_qty: client.table("item_batches")
                .update({"quantity_on_hand": nbq, "is_active": nbq > 0, "updated_at": datetime.utcnow().isoformat()})
                .eq("id", bid).execute()
        )
        new_item_qty = prev_item_qty - take
        await insert_one("stock_movements", {
            "id": str(uuid4()),
            "item_id": item_id,
            "branch_id": branch_id,
            "type": "adjustment",
            "quantity": -take,
            "previous_quantity": prev_item_qty,
            "new_quantity": new_item_qty,
            "reference_id": batch["id"],
            "reference_type": reference_type,
            "notes": notes,
            "created_by": user_id,
            "batch_id": batch["id"],
            "batch_number": batch.get("batch_number"),
            "batch_expiry_date": batch.get("expiry_date"),
        })
        prev_item_qty = new_item_qty
        remaining -= take

    if remaining > 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Insufficient batch stock")

    sync_resp = await asyncio.to_thread(lambda: client.rpc("sync_item_stock_from_batches", {"p_item_id": item_id}).execute())
    try:
        return int(sync_resp.data)
    except (TypeError, ValueError):
        return prev_item_qty

# ── Global product catalog upsert ─────────────────────────────────────────────

async def _sync_to_global_catalog(item: dict):
    """
    After saving any item with a barcode, sync its name/brand/description
    into the shared global_products table so other orgs benefit from it.
    Fire-and-forget — never blocks item save if it fails.
    """
    barcode = (item.get("barcode") or "").strip()
    name    = (item.get("name") or "").strip()
    if not barcode or not name:
        return
    client = await get_supabase_client()
    if not client:
        return
    try:
        await asyncio.to_thread(
            lambda: client.rpc("upsert_global_product", {
                "p_barcode":       barcode,
                "p_name":          name,
                "p_brand":         item.get("brand") or "",
                "p_description":   item.get("description") or "",
                "p_category_hint": "",   # no global category mapping
                "p_image_url":     item.get("image_url") or "",
                "p_confidence":    1.0,
                "p_source":        "user",
            }).execute()
        )
        logger.info(f"[GlobalProducts] synced barcode={barcode} name='{name}'")
    except Exception as e:
        logger.warning(f"[GlobalProducts] sync failed (non-fatal): {e}")



@router.get("/units")
async def get_units(current_user: dict = Depends(get_current_user)):
    """List inventory units for this organization."""
    return await fetch_all("units", {"organization_id": str(current_user["organization_id"])})


@router.post("/units", status_code=status.HTTP_201_CREATED)
async def create_unit(body: dict, current_user: dict = Depends(require_manager)):
    """Create an inventory unit such as box, strip, tablet, capsule, or sachet."""
    name = (body.get("name") or "").strip()
    abbreviation = (body.get("abbreviation") or name[:10]).strip()
    if not name or not abbreviation:
        raise HTTPException(status_code=400, detail="Unit name and abbreviation are required")
    return await insert_one("units", {
        "organization_id": str(current_user["organization_id"]),
        "name": name,
        "abbreviation": abbreviation,
        "is_base": bool(body.get("is_base", False)),
    })


@router.get("/unit-conversions")
async def get_unit_conversions(item_id: Optional[str] = None, current_user: dict = Depends(get_current_user)):
    """List unit conversion rules. Multiplier converts from_unit to to_unit/base units."""
    filters = {"organization_id": str(current_user["organization_id"])}
    if item_id:
        filters["item_id"] = item_id
    return await fetch_all("unit_conversions", filters)


@router.post("/unit-conversions", status_code=status.HTTP_201_CREATED)
async def create_unit_conversion(body: dict, current_user: dict = Depends(require_manager)):
    """Create a conversion such as 1 box = 10 strips or 1 strip = 10 tablets."""
    required = ["from_unit_id", "to_unit_id", "multiplier"]
    if any(not body.get(k) for k in required):
        raise HTTPException(status_code=400, detail="from_unit_id, to_unit_id and multiplier are required")
    return await insert_one("unit_conversions", {
        "organization_id": str(current_user["organization_id"]),
        "item_id": body.get("item_id") or None,
        "from_unit_id": body["from_unit_id"],
        "to_unit_id": body["to_unit_id"],
        "multiplier": float(body["multiplier"]),
    })


@router.get("/{item_id}/packaging-tiers")
async def get_packaging_tiers(item_id: UUID, current_user: dict = Depends(get_current_user)):
    """List pharmacy packaging tier prices/barcodes for an item."""
    item = await fetch_one("items", {"id": str(item_id), "organization_id": str(current_user["organization_id"])})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return await fetch_all("item_packaging_tiers", {
        "organization_id": str(current_user["organization_id"]),
        "item_id": str(item_id),
    })


@router.get("/{item_id}/batches")
async def get_item_batches(item_id: UUID, current_user: dict = Depends(get_current_user)):
    """List active stock batches/lots for an item in FEFO order."""
    org_id = str(current_user["organization_id"])
    item = await fetch_one("items", {"id": str(item_id), "organization_id": org_id})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        response = await asyncio.to_thread(
            lambda: client.table("item_batches")
                .select("id,batch_number,expiry_date,received_quantity,quantity_on_hand,unit_cost,supplier_id,received_at,is_active,created_at")
                .eq("organization_id", org_id)
                .eq("item_id", str(item_id))
                .order("is_active", desc=True)
                .order("expiry_date", desc=False, nullsfirst=False)
                .order("received_at", desc=False)
                .order("id", desc=False)
                .execute()
        )
        return response.data or []
    except Exception as e:
        logger.error(f"[Items] Failed to list batches for item {item_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list item batches")


@router.put("/{item_id}/packaging-tiers")
async def save_packaging_tiers(item_id: UUID, body: dict, current_user: dict = Depends(require_manager)):
    """Replace pharmacy packaging tier configuration for an item."""
    org_id = str(current_user["organization_id"])
    item = await fetch_one("items", {"id": str(item_id), "organization_id": org_id})
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    tiers = body.get("tiers") or []
    if not isinstance(tiers, list):
        raise HTTPException(status_code=400, detail="tiers must be a list")

    allowed_levels = {"carton", "box", "strip", "base"}
    await delete_one("item_packaging_tiers", {"organization_id": org_id, "item_id": str(item_id)})
    await delete_one("unit_conversions", {"organization_id": org_id, "item_id": str(item_id)})

    saved = []
    base_unit_id = item.get("base_unit_id")
    for index, tier in enumerate(tiers):
        unit_level = str(tier.get("unit_level") or "").strip().lower()
        if unit_level not in allowed_levels:
            raise HTTPException(status_code=400, detail=f"Invalid packaging tier level: {unit_level}")
        multiplier = float(tier.get("base_unit_multiplier") or 1)
        if multiplier <= 0:
            raise HTTPException(status_code=400, detail="base_unit_multiplier must be greater than zero")
        row = await insert_one("item_packaging_tiers", {
            "organization_id": org_id,
            "item_id": str(item_id),
            "unit_level": unit_level,
            "unit_label": (tier.get("unit_label") or unit_level.title())[:80],
            "base_unit_multiplier": multiplier,
            "purchase_cost": float(tier.get("purchase_cost") or 0),
            "selling_price": float(tier.get("selling_price") or 0),
            "barcode": (tier.get("barcode") or None),
            "sort_order": int(tier.get("sort_order") or index),
        })
        # Pharmacy sales convert the selected unit to base units before FEFO
        # deduction. Keep unit_conversions in sync with packaging tiers so the
        # POS can sell mixed packs such as 1 strip + 2 capsules safely.
        try:
            units_resp = await asyncio.to_thread(
                lambda lvl=unit_level: client.table("units").select("id")
                    .eq("organization_id", org_id).eq("abbreviation", lvl).limit(1).execute()
            )
            unit_rows = units_resp.data or []
            base_unit_id = item.get("base_unit_id")
            if unit_rows and base_unit_id:
                await insert_one("unit_conversions", {
                    "organization_id": org_id,
                    "item_id": str(item_id),
                    "from_unit_id": unit_rows[0]["id"],
                    "to_unit_id": base_unit_id,
                    "multiplier": multiplier,
                })
        except Exception as e:
            logger.warning(f"[Items] Could not sync packaging conversion for {item_id}/{unit_level}: {e}")
        if row:
            saved.append(row)

    # New pharmacy items create their opening batch before packaging tiers are
    # saved. Since migration_023, buy_price is stored per-base-unit (e.g. 3 per
    # tablet), so the batch cost is already correct for newly created items.
    # This normalisation pass handles legacy items whose batch unit_cost still
    # carries the per-purchase-unit buy_price from before the fix.
    try:
        per_base_costs = [
            float(t.get("purchase_cost") or 0) / float(t.get("base_unit_multiplier") or 1)
            for t in tiers
            if float(t.get("purchase_cost") or 0) > 0 and float(t.get("base_unit_multiplier") or 1) > 0
        ]
        per_base_cost = min(per_base_costs) if per_base_costs else 0
        # Normalise EVERY batch for this item. Since migration_023, new items
        # already have a correct per-base-unit cost in both buy_price and batch
        # unit_cost, but legacy pharmacy items may still have inflated batch
        # costs from the pre-fix era. Rewriting all batches ensures the batch
        # ledger, inventory valuation and direct DB queries see correct costs.
        if per_base_cost > 0:
            await asyncio.to_thread(
                lambda: client.table("item_batches")
                    .update({"unit_cost": per_base_cost, "updated_at": datetime.utcnow().isoformat()})
                    .eq("organization_id", org_id)
                    .eq("item_id", str(item_id))
                    .execute()
            )
    except Exception as e:
        logger.warning(f"[Items] Could not normalize opening batch unit cost for {item_id}: {e}")
    return {"ok": True, "tiers": saved}


@router.get("", response_model=List[ItemWithDetails])
async def get_items(
    page: int = 1,
    page_size: int = 50,  # capped at 200 below
    search: Optional[str] = None,
    barcode: Optional[str] = None,
    category_id: Optional[str] = None,
    supplier_id: Optional[str] = None,
    low_stock: Optional[bool] = None,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all items for organization"""
    org_id = current_user["organization_id"]
    branch_id = branch_id or current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return []

    try:
        # Cap page_size to prevent DoS
        page_size = min(page_size, 200)

        q = client.table("items").select("*").eq("organization_id", org_id).eq("is_active", True)

        # Branch isolation: apply for all roles
        # cashier: always their branch | manager/admin: their branch or all if none set
        role = current_user.get("role", "cashier")
        effective_branch = branch_id  # may be passed as query param
        if not effective_branch:
            effective_branch = current_user.get("branch_id")
        # admin with no branch set = sees all (intended for admin overview)
        if effective_branch or role == "cashier":
            branch_to_use = effective_branch or (current_user.get("branch_id") if role == "cashier" else None)
            if branch_to_use:
                # Fetch items for this branch OR shared items (branch_id=null) in parallel
                import asyncio as _asyncio
                _q_branch = client.table("items").select("*").eq("organization_id", org_id).eq("is_active", True).eq("branch_id", str(branch_to_use))
                _q_shared = client.table("items").select("*").eq("organization_id", org_id).eq("is_active", True).is_("branch_id", "null")
                # Apply same filters to both
                if barcode:
                    _q_branch = _q_branch.eq("barcode", barcode)
                    _q_shared = _q_shared.eq("barcode", barcode)
                if category_id and category_id not in ('undefined', '', None):
                    try:
                        from uuid import UUID as _UUID
                        _q_branch = _q_branch.eq("category_id", str(_UUID(category_id)))
                        _q_shared = _q_shared.eq("category_id", str(_UUID(category_id)))
                    except (ValueError, TypeError):
                        pass
                _r1, _r2 = await _asyncio.gather(
                    _asyncio.to_thread(lambda: _q_branch.order("name").execute()),
                    _asyncio.to_thread(lambda: _q_shared.order("name").execute()),
                )
                _seen = set(); rows = []
                for _r in (_r1.data or []) + (_r2.data or []):
                    if _r["id"] not in _seen:
                        _seen.add(_r["id"]); rows.append(_r)
                rows.sort(key=lambda x: (x.get("name") or "").lower())
                if low_stock:
                    rows = [r for r in rows if int(r.get("stock_quantity",0)) <= int(r.get("min_stock_level",0))]
                start = (page - 1) * page_size
                rows = rows[start:start + page_size]
                # Enrich and return early
                cat_ids = list({r["category_id"] for r in rows if r.get("category_id")})
                sup_ids = list({r["supplier_id"] for r in rows if r.get("supplier_id")})
                cat_names = {}
                if cat_ids:
                    resp_c = await _asyncio.to_thread(lambda: client.table("categories").select("id,name").in_("id", cat_ids).execute())
                    for c in (resp_c.data or []): cat_names[c["id"]] = c["name"]
                sup_names = {}
                if sup_ids:
                    resp_s = await _asyncio.to_thread(lambda: client.table("suppliers").select("id,name").in_("id", sup_ids).execute())
                    for s in (resp_s.data or []): sup_names[s["id"]] = s["name"]
                return [{**r, "category_name": cat_names.get(r.get("category_id")), "supplier_name": sup_names.get(r.get("supplier_id"))} for r in rows]

        # Barcode exact match
        if barcode:
            q = q.eq("barcode", barcode)

        # Category filter
        if category_id and category_id not in ('undefined', '', None):
            try:
                q = q.eq("category_id", str(UUID(category_id)))
            except (ValueError, TypeError):
                pass

        # Supplier filter
        if supplier_id and supplier_id not in ('undefined', '', None):
            try:
                q = q.eq("supplier_id", str(UUID(supplier_id)))
            except (ValueError, TypeError):
                pass

        # Push search to DB using ILIKE (much faster than Python-side filtering)
        if search and search.strip():
            clean = search.strip().replace("%", r"\%").replace("_", r"\_")
            pattern = f"%{clean}%"
            # Supabase supports .ilike() on a single column;
            # For multi-column OR, we fetch with name ilike and also barcode ilike
            # then deduplicate — still 2 queries but avoids loading entire table
            q_name    = q.ilike("name", pattern)
            q_barcode = q.ilike("barcode", pattern)
            r1, r2 = await asyncio.gather(
                asyncio.to_thread(lambda: q_name.order("name").execute()),
                asyncio.to_thread(lambda: q_barcode.order("name").execute()),
            )
            seen = set(); rows = []
            for row in (r1.data or []) + (r2.data or []):
                if row["id"] not in seen:
                    seen.add(row["id"]); rows.append(row)
            rows.sort(key=lambda x: (x.get("name") or "").lower())
            # Pagination on merged result
            start = (page - 1) * page_size
            rows  = rows[start:start + page_size]
        else:
            # Low stock filter (DB-side)
            if low_stock:
                # Fetch a bounded set and filter in Python — cap at 500 to protect memory
                resp = await asyncio.to_thread(lambda: q.order("stock_quantity").limit(500).execute())
                rows = [r for r in (resp.data or [])
                        if int(r.get("stock_quantity", 0)) <= int(r.get("min_stock_level", 0))]
                rows = rows[:page_size]
            else:
                # DB-side pagination + sort
                q = q.order("name").range((page - 1) * page_size, page * page_size - 1)
                resp = await asyncio.to_thread(lambda: q.execute())
                rows = resp.data or []

        # Enrich with category and supplier names
        cat_ids = list({r["category_id"] for r in rows if r.get("category_id")})
        sup_ids = list({r["supplier_id"] for r in rows if r.get("supplier_id")})

        cat_names = {}
        if cat_ids:
            qc = client.table("categories").select("id, name").in_("id", cat_ids)
            resp_c = await asyncio.to_thread(lambda: qc.execute())
            for c in (resp_c.data or []):
                cat_names[c["id"]] = c["name"]

        sup_names = {}
        if sup_ids:
            qs = client.table("suppliers").select("id, name").in_("id", sup_ids)
            resp_s = await asyncio.to_thread(lambda: qs.execute())
            for s in (resp_s.data or []):
                sup_names[s["id"]] = s["name"]

        return [
            {
                **row,
                "category_name": cat_names.get(row.get("category_id")),
                "supplier_name": sup_names.get(row.get("supplier_id"))
            }
            for row in rows
        ]
    except Exception as e:
        logger.error(f"Get items error: {e}")
        return []


@router.get("/barcode/{barcode}", response_model=ItemWithDetails)
async def get_item_by_barcode(barcode: str, current_user: dict = Depends(get_current_user)):
    """Get item by barcode - used by scanner"""
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        resp = await asyncio.to_thread(
            lambda: client.table("items").select("*")
                .eq("organization_id", org_id)
                .eq("barcode", barcode)
                .eq("is_active", True)
                .limit(1)
                .execute()
        )
        items = resp.data or []
        matched_tier = None

        if not items:
            # Pharmacy items are saved with items.barcode = NULL; each
            # packaging tier (carton/box/strip/base) carries its own barcode
            # in item_packaging_tiers.barcode instead. Without this fallback,
            # scanning a box/carton/strip barcode for a pharmacy item always
            # returned 404 "Item not found" even though the item exists.
            tier_resp = await asyncio.to_thread(
                lambda: client.table("item_packaging_tiers").select("*, items(*)")
                    .eq("organization_id", org_id)
                    .eq("barcode", barcode)
                    .limit(1)
                    .execute()
            )
            tier_rows = tier_resp.data or []
            if tier_rows and tier_rows[0].get("items") and tier_rows[0]["items"].get("is_active", True):
                matched_tier = {k: v for k, v in tier_rows[0].items() if k != "items"}
                items = [tier_rows[0]["items"]]

        if not items:
            raise HTTPException(status_code=404, detail="Item not found")

        item = items[0]
        if matched_tier:
            item["matched_tier"] = matched_tier

        # Enrich with category and supplier names
        if item.get("category_id"):
            cat = await fetch_one("categories", {"id": item["category_id"]})
            item["category_name"] = cat["name"] if cat else None
        else:
            item["category_name"] = None

        if item.get("supplier_id"):
            sup = await fetch_one("suppliers", {"id": item["supplier_id"]})
            item["supplier_name"] = sup["name"] if sup else None
        else:
            item["supplier_name"] = None

        return item
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Barcode lookup error: {e}")
        raise HTTPException(status_code=500, detail="Barcode lookup failed")

@router.get("/{item_id}", response_model=ItemWithDetails)
async def get_item(item_id: UUID, current_user: dict = Depends(get_current_user)):
    """Get item by ID — enriched with packaging tiers, unit details, and batch info."""
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        resp = await asyncio.to_thread(
            lambda: client.table("items").select("*")
                .eq("id", str(item_id))
                .eq("organization_id", str(org_id))
                .eq("is_active", True)
                .limit(1)
                .execute()
        )
        items = resp.data or []
        if not items:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")

        item = items[0]

        # Enrich with category and supplier names
        if item.get("category_id"):
            cat = await fetch_one("categories", {"id": item["category_id"]})
            item["category_name"] = cat["name"] if cat else None
        else:
            item["category_name"] = None

        if item.get("supplier_id"):
            sup = await fetch_one("suppliers", {"id": item["supplier_id"]})
            item["supplier_name"] = sup["name"] if sup else None
        else:
            item["supplier_name"] = None

        # ── Pharmacy enrichment: packaging tiers, unit names, fallback barcode ──
        _has_pharmacy_fields = bool(item.get("generic_name") or item.get("dosage_form") or item.get("strength") or item.get("base_unit_id"))

        if _has_pharmacy_fields:
            # Load packaging tiers
            try:
                tiers_resp = await asyncio.to_thread(
                    lambda: client.table("item_packaging_tiers")
                        .select("*")
                        .eq("organization_id", org_id)
                        .eq("item_id", str(item_id))
                        .order("sort_order")
                        .execute()
                )
                item["packaging_tiers"] = tiers_resp.data or []
            except Exception:
                item["packaging_tiers"] = []

            # Fallback barcode from tier if item-level barcode is empty
            if not item.get("barcode") and item.get("packaging_tiers"):
                for t in item["packaging_tiers"]:
                    if t.get("barcode"):
                        item["barcode"] = t["barcode"]
                        break

            # Load unit names for base/purchase/sale units
            _unit_ids = set()
            for _f in ("base_unit_id", "purchase_unit_id", "sale_unit_id"):
                if item.get(_f):
                    _unit_ids.add(str(item[_f]))
            if _unit_ids:
                try:
                    units_resp = await asyncio.to_thread(
                        lambda: client.table("units")
                            .select("id,name,abbreviation")
                            .in_("id", list(_unit_ids))
                            .execute()
                    )
                    _unit_map = {u["id"]: u for u in (units_resp.data or [])}
                    for _f in ("base_unit_id", "purchase_unit_id", "sale_unit_id"):
                        _uid = str(item.get(_f) or "")
                        if _uid in _unit_map:
                            item[f"{_f}_name"] = _unit_map[_uid].get("name")
                            item[f"{_f}_abbreviation"] = _unit_map[_uid].get("abbreviation")
                except Exception:
                    pass

            # Count active batches
            try:
                batch_count_resp = await asyncio.to_thread(
                    lambda: client.table("item_batches")
                        .select("id", count="exact")
                        .eq("organization_id", org_id)
                        .eq("item_id", str(item_id))
                        .eq("is_active", True)
                        .execute()
                )
                item["active_batch_count"] = batch_count_resp.count or 0
            except Exception:
                item["active_batch_count"] = 0

        return item

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get item error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch item")

@router.post("", response_model=ItemResponse, status_code=status.HTTP_201_CREATED)
async def create_item(
    item_data: ItemCreate,
    current_user: dict = Depends(require_manager)
):
    """Create new item"""
    from uuid import uuid4
    from database import fetch_one as _fetch_one
    org_id  = str(current_user["organization_id"])
    item_id = str(uuid4())

    # ── Block item creation on inactive branches ───────────────────────────────
    item_branch_id = str(item_data.branch_id) if item_data.branch_id else current_user.get("branch_id")
    if item_branch_id:
        branch = await _fetch_one("branches", {"id": item_branch_id, "organization_id": org_id})
        # Strict False check — NULL/missing is_active means active
        if branch and branch.get("is_active") is False:
            raise HTTPException(
                status_code=403,
                detail=f"Branch '{branch.get('name', '')}' is deactivated. Cannot add items to an inactive branch."
            )

    # ── Duplicate barcode check (backend-enforced, not just frontend) ──────────
    if item_data.barcode and item_data.barcode.strip():
        client_check = await get_supabase_client()
        if client_check:
            try:
                _dup_branch = str(item_branch_id) if item_branch_id else None
                _dup_q = client_check.table("items") \
                    .select("id,name") \
                    .eq("organization_id", org_id) \
                    .eq("barcode", item_data.barcode.strip()) \
                    .eq("is_active", True)
                if _dup_branch:
                    _dup_q = _dup_q.eq("branch_id", _dup_branch)
                dup_resp = await asyncio.to_thread(lambda: _dup_q.limit(1).execute())
                existing = (dup_resp.data or [None])[0]
                if existing:
                    raise HTTPException(
                        status_code=409,
                        detail="An item with this barcode already exists: " + str(existing["name"]) + ". Edit the existing item."
                    )
            except HTTPException:
                raise
            except Exception as e:
                logger.warning(f"[Items] Duplicate barcode check failed (non-fatal): {e}")

    # Build item data - use organization_id from authenticated user for security
    item_dict = {
        "id": item_id,
        "organization_id": str(current_user["organization_id"]),
        "branch_id": str(item_branch_id) if item_branch_id else None,
        "category_id": str(item_data.category_id) if item_data.category_id else None,
        "supplier_id": str(item_data.supplier_id) if item_data.supplier_id else None,
        "name": item_data.name,
        "description": item_data.description,
        "barcode": item_data.barcode,
        "buy_price": float(item_data.buy_price),
        "sell_price": float(item_data.sell_price),
        "stock_quantity": int(item_data.stock_quantity),
        "min_stock_level": int(item_data.min_stock_level),
        "expiry_date": item_data.expiry_date.isoformat() if item_data.expiry_date else None,
        "batch_number": item_data.batch_number,
        "image_url": item_data.image_url,
        "brand": item_data.brand,
        "generic_name": item_data.generic_name,
        "brand_name": item_data.brand_name,
        "strength": item_data.strength,
        "dosage_form": item_data.dosage_form,
        "controlled_substance": bool(item_data.controlled_substance),
        "base_unit_id": str(item_data.base_unit_id) if item_data.base_unit_id else None,
        "purchase_unit_id": str(item_data.purchase_unit_id) if item_data.purchase_unit_id else None,
        "sale_unit_id": str(item_data.sale_unit_id) if item_data.sale_unit_id else None,
        "is_active": True
    }
    
    # Insert using REST API
    result = await insert_one("items", item_dict)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create item"
        )
    
    from database import log_audit
    await log_audit(
        organization_id=str(current_user["organization_id"]),
        user_id=str(current_user["id"]),
        branch_id=str(item_data.branch_id or current_user.get("branch_id", "")),
        action="item_created", entity_type="item",
        entity_id=str(item_id),
        details={"name": item_data.name, "buy_price": item_data.buy_price, "sell_price": item_data.sell_price},
    )
    
    # Create an opening stock batch for the received quantity. New receipts are
    # represented as separate batches so the same item can have multiple active
    # lots and sales can deduct by FEFO (first-expire-first-out).
    if int(item_data.stock_quantity or 0) > 0:
        batch_id = str(uuid4())
        batch_dict = {
            "id": batch_id,
            "organization_id": str(current_user["organization_id"]),
            "branch_id": str(item_branch_id) if item_branch_id else None,
            "item_id": item_id,
            "batch_number": item_data.batch_number,
            "expiry_date": item_data.expiry_date.isoformat() if item_data.expiry_date else None,
            "received_quantity": int(item_data.stock_quantity),
            "quantity_on_hand": int(item_data.stock_quantity),
            # The frontend now always converts buy_price to per-base-unit
            # (e.g. 600/carton ÷ 200 = 3/tablet) before sending, so the
            # opening batch cost is correct without a separate cost field.
            "unit_cost": float(item_data.buy_price),
            "supplier_id": str(item_data.supplier_id) if item_data.supplier_id else None,
            "is_active": True,
        }
        try:
            await insert_one("item_batches", batch_dict)
            await insert_one("stock_movements", {
                "id": str(uuid4()),
                "item_id": item_id,
                "branch_id": batch_dict["branch_id"],
                "type": "restock",
                "quantity": int(item_data.stock_quantity),
                "previous_quantity": 0,
                "new_quantity": int(item_data.stock_quantity),
                "reference_id": batch_id,
                "reference_type": "opening_batch",
                "notes": "Opening stock batch created with item",
                "created_by": str(current_user["id"]),
                "batch_id": batch_id,
                "batch_number": item_data.batch_number,
                "batch_expiry_date": item_data.expiry_date.isoformat() if item_data.expiry_date else None,
            })
        except Exception as e:
            logger.warning(f"[Items] Failed to create opening batch for item {item_id}: {e}")

    # Sync to global catalog (fire-and-forget)
    asyncio.create_task(_sync_to_global_catalog(item_dict))

    # Check for low stock and expiry notifications for new items
    min_stock = item_data.min_stock_level or 0
    stock_quantity = item_data.stock_quantity or 0
    
    if stock_quantity <= min_stock:
        await create_low_stock_notification(
            org_id=current_user["organization_id"],
            item_id=item_id,
            item_name=item_data.name,
            quantity=stock_quantity,
            min_stock=min_stock
        )
    
    # Check expiry (if within 30 days)
    if item_data.expiry_date:
        try:
            expiry_date = item_data.expiry_date
            # Handle both string and date objects
            if isinstance(expiry_date, str):
                from datetime import datetime
                expiry_date = datetime.fromisoformat(expiry_date.replace('Z', '+00:00')).date()
            
            # Calculate days until expiry
            from datetime import date as date_module
            today = date_module.today()
            days_until_expiry = (expiry_date - today).days
            
            if 0 <= days_until_expiry <= 30:
                await create_expiry_notification(
                    org_id=current_user["organization_id"],
                    item_id=item_id,
                    item_name=item_data.name,
                    expiry_date=expiry_date
                )
        except Exception as e:
            logger.warning(f"[EXPIRY CHECK] Failed to parse expiry date: {e}")
    
    return result

@router.post("/upload-image/{item_id}", response_model=ItemResponse)
async def upload_item_image(
    item_id: UUID,
    image: UploadFile = File(...),
    current_user: dict = Depends(require_manager)
):
    """Upload item image to Supabase Storage"""
    from loguru import logger
    import uuid
    
    # Check if item exists
    _client = await get_supabase_client()
    if not _client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    _resp = await asyncio.to_thread(
        lambda: _client.table("items").select("*")
            .eq("id", str(item_id))
            .eq("organization_id", str(current_user["organization_id"]))
            .eq("is_active", True).limit(1).execute()
    )
    item = (_resp.data or [None])[0]

    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found"
        )

    # Read image content
    image_content = await image.read()
    
    # Validate file type by BOTH content-type header AND magic bytes
    # (content-type alone can be spoofed)
    allowed_types = ["image/jpeg", "image/png", "image/gif", "image/webp"]
    if image.content_type not in allowed_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Invalid image type. Allowed: JPEG, PNG, GIF, WEBP")

    MAGIC = {
        b"\xff\xd8\xff": "image/jpeg",
        b"\x89PNG":        "image/png",
        b"GIF8":            "image/gif",
        b"RIFF":            "image/webp",   # RIFF....WEBP
    }
    content_ok = any(image_content[:4].startswith(sig) for sig in MAGIC)
    if not content_ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="File content does not match a valid image format")
    
    # Validate file size (max 5MB)
    if len(image_content) > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image too large. Maximum size: 5MB"
        )
    
    # Generate safe unique filename — use UUID only, never trust user-supplied filename
    allowed_extensions = {"jpg", "jpeg", "png", "gif", "webp"}
    raw_ext = image.filename.rsplit('.', 1)[-1].lower() if '.' in image.filename else 'jpg'
    file_extension = raw_ext if raw_ext in allowed_extensions else 'jpg'
    unique_filename = f"{uuid.uuid4()}.{file_extension}"
    storage_path = f"items/{current_user['organization_id']}/{unique_filename}"
    
    # Upload to Supabase Storage
    image_url = await upload_file_to_storage(
        bucket_name="item-images",
        file_path=storage_path,
        file_content=image_content,
        content_type=image.content_type
    )
    
    if not image_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload image to storage"
        )
    
    # Update item with image URL
    result = await update_one(
        "items",
        {"image_url": image_url},
        {"id": str(item_id), "organization_id": str(current_user["organization_id"])}
    )
    
    logger.info(f"[Item] Image uploaded successfully for item {item_id}")
    
    return result

@router.put("/{item_id}", response_model=ItemResponse)
async def update_item(
    item_id: UUID,
    item_data: ItemUpdate,
    current_user: dict = Depends(require_manager)
):
    """Update item"""
    from uuid import UUID

    # Only include fields the client actually sent — never default-None fields
    raw = item_data.model_dump(exclude_unset=True)

    # stock_quantity is managed exclusively by the batch system; ignore it here
    raw.pop("stock_quantity", None)

    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )

    # Convert UUID / date / datetime objects to strings for Supabase
    update_data = {}
    for k, v in raw.items():
        if isinstance(v, UUID):
            update_data[k] = str(v)
        elif isinstance(v, (date, datetime)):
            update_data[k] = v.isoformat()
        else:
            update_data[k] = v
    
    logger.info(f"[UPDATE ITEM] item_id={item_id}, org_id={current_user['organization_id']}")
    logger.info(f"[UPDATE ITEM] update_data={update_data}")
    
    # If barcode is being changed, check it doesn't conflict with another item
    if "barcode" in update_data and update_data["barcode"]:
        new_bc = str(update_data["barcode"]).strip()
        _uc2 = await get_supabase_client()
        if _uc2:
            try:
                _dup = await asyncio.to_thread(
                    lambda: _uc2.table("items")
                        .select("id,name")
                        .eq("organization_id", str(current_user["organization_id"]))
                        .eq("barcode", new_bc)
                        .eq("is_active", True)
                        .neq("id", str(item_id))   # exclude the item being edited
                        .limit(1)
                        .execute()
                )
                _existing = (_dup.data or [None])[0]
                if _existing:
                    raise HTTPException(
                        status_code=409,
                        detail="Barcode is already used by: " + str(_existing["name"]) + ". Each barcode must be unique."
                    )
            except HTTPException:
                raise
            except Exception as e:
                logger.warning(f"[Items] Barcode uniqueness check on update failed: {e}")

    filters = {"id": str(item_id), "organization_id": str(current_user["organization_id"])}
    result = await update_one("items", update_data, filters)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found"
        )

    # Re-sync stock_quantity from batch ledger to prevent drift. The frontend
    # may send stock_quantity in the update payload, but only the batch system
    # (update_stock, bulk_stock_adjust, or process_sale) is authoritative.
    _uc = await get_supabase_client()
    if _uc:
        try:
            await asyncio.to_thread(
                lambda: _uc.rpc("sync_item_stock_from_batches", {"p_item_id": str(item_id)}).execute()
            )
            # Re-fetch the corrected stock_quantity for the update_data passed below
            corrected = await asyncio.to_thread(
                lambda: _uc.table("items").select("stock_quantity").eq("id", str(item_id)).limit(1).execute()
            )
            if corrected.data:
                update_data["stock_quantity"] = corrected.data[0].get("stock_quantity", update_data.get("stock_quantity", 0))
        except Exception:
            pass  # best-effort — non-batch items don't have sync function

    # Sync to global catalog if barcode/name changed (fire-and-forget)
    if any(k in update_data for k in ("barcode", "name", "description", "image_url")):
        asyncio.create_task(_sync_to_global_catalog(update_data))
    
    # Check for low stock and expiry notifications after update
    # Get the updated item to check conditions
    _ur = await asyncio.to_thread(
        lambda: _uc.table("items").select("*")
            .eq("id", str(item_id))
            .eq("organization_id", str(current_user["organization_id"]))
            .limit(1).execute()
    ) if _uc else None
    updated_item = (_ur.data or [None])[0] if _ur else None
    
    if updated_item:
        # Check low stock
        min_stock = updated_item.get("min_stock_level", 0)
        current_stock = updated_item.get("stock_quantity", 0)
        if current_stock <= min_stock:
            await create_low_stock_notification(
                org_id=current_user["organization_id"],
                item_id=str(item_id),
                item_name=updated_item.get("name", "Unknown Item"),
                quantity=current_stock,
                min_stock=min_stock
            )
        
        # Check expiry (if within 30 days)
        expiry_date_raw = updated_item.get("expiry_date")
        if expiry_date_raw:
            try:
                from datetime import date as _date
                if isinstance(expiry_date_raw, str):
                    exp_date = _date.fromisoformat(expiry_date_raw[:10])
                else:
                    exp_date = expiry_date_raw
                days_until_expiry = (exp_date - _date.today()).days
                if 0 <= days_until_expiry <= 30:
                    await create_expiry_notification(
                        org_id=current_user["organization_id"],
                        item_id=str(item_id),
                        item_name=updated_item.get("name", "Unknown Item"),
                        expiry_date=exp_date
                    )
            except Exception as _ed:
                logger.warning(f"[EXPIRY CHECK] update_item expiry parse: {_ed}")
    
    return result

@router.put("/{item_id}/stock")
async def update_stock(
    item_id: UUID,
    body: dict,
    current_user: dict = Depends(require_manager)
):
    """Update item stock — accepts JSON body: {quantity, type}"""
    quantity = body.get("quantity")
    type     = body.get("type")
    if quantity is None or type is None:
        raise HTTPException(status_code=422, detail="quantity and type are required")
    try:
        quantity = int(quantity)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="quantity must be an integer")
    # Get current item
    _sc = await get_supabase_client()
    if not _sc:
        raise HTTPException(status_code=503, detail="Database unavailable")
    _sr = await asyncio.to_thread(
        lambda: _sc.table("items").select("*")
            .eq("id", str(item_id))
            .eq("organization_id", str(current_user["organization_id"]))
            .eq("is_active", True).limit(1).execute()
    )
    item = (_sr.data or [None])[0]

    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found"
        )

    # Calculate new quantity. Positive receipts always create a new batch
    # instead of merging into existing stock so FEFO can choose the correct lot.
    if type == "add":
        batch_id = str(uuid4())
        await insert_one("item_batches", {
            "id": batch_id,
            "organization_id": str(current_user["organization_id"]),
            "branch_id": str(item.get("branch_id") or current_user.get("branch_id")) if (item.get("branch_id") or current_user.get("branch_id")) else None,
            "item_id": str(item_id),
            "batch_number": body.get("batch_number") or None,
            "expiry_date": body.get("expiry_date") or None,
            "received_quantity": quantity,
            "quantity_on_hand": quantity,
            "unit_cost": body.get("unit_cost") or item.get("buy_price"),
            "supplier_id": body.get("supplier_id") or item.get("supplier_id"),
            "is_active": True,
        })
        # Always re-derive stock_quantity from the batch ledger rather than
        # adding to item["stock_quantity"] directly. If a return or any other
        # operation had already left stock_quantity out of sync with the real
        # batch totals, naive addition would silently perpetuate the drift.
        sync_resp = await asyncio.to_thread(
            lambda: _sc.rpc("sync_item_stock_from_batches", {"p_item_id": str(item_id)}).execute()
        )
        try:
            new_quantity = int(sync_resp.data)
        except (TypeError, ValueError):
            new_quantity = item["stock_quantity"] + quantity
    elif type == "subtract":
        # Negative manager adjustments consume real batches in FEFO order so
        # items.stock_quantity remains a projection of item_batches.
        new_quantity = await _deduct_batches_fefo(
            _sc, item, quantity, str(current_user["organization_id"]),
            str(item.get("branch_id") or current_user.get("branch_id")) if (item.get("branch_id") or current_user.get("branch_id")) else None,
            str(current_user["id"]), "stock_adjustment", body.get("reason") or "Quick stock reduction"
        )
        result = await fetch_one("items", {"id": str(item_id)})
    elif type == "set":
        new_quantity = quantity
        current_qty = int(item.get("stock_quantity", 0))
        if new_quantity == current_qty:
            return item
        if new_quantity > current_qty:
            quantity = new_quantity - current_qty
            batch_id = str(uuid4())
            await insert_one("item_batches", {
                "id": batch_id, "organization_id": str(current_user["organization_id"]),
                "branch_id": str(item.get("branch_id") or current_user.get("branch_id")) if (item.get("branch_id") or current_user.get("branch_id")) else None,
                "item_id": str(item_id), "batch_number": body.get("batch_number") or item.get("batch_number"),
                "expiry_date": body.get("expiry_date") or item.get("expiry_date"),
                "received_quantity": quantity, "quantity_on_hand": quantity,
                "unit_cost": body.get("unit_cost") or item.get("buy_price"),
                "supplier_id": body.get("supplier_id") or item.get("supplier_id"), "is_active": True,
            })
            # Re-derive from the ledger (same as add) so the projection cannot drift.
            try:
                _set_sync = await asyncio.to_thread(
                    lambda: _sc.rpc("sync_item_stock_from_batches", {"p_item_id": str(item_id)}).execute()
                )
                new_quantity = int(_set_sync.data)
            except (TypeError, ValueError):
                pass
        else:  # new_quantity < current_qty
            quantity = current_qty - new_quantity
            new_quantity = await _deduct_batches_fefo(
                _sc, item, quantity, str(current_user["organization_id"]),
                str(item.get("branch_id") or current_user.get("branch_id")) if (item.get("branch_id") or current_user.get("branch_id")) else None,
                str(current_user["id"]), "stock_adjustment", body.get("reason") or "Quick stock set-down"
            )
            result = await fetch_one("items", {"id": str(item_id)})
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid type. Use: add, subtract, or set"
        )
    
    if "result" not in locals():
        # Positive stock changes write a receipt batch above, then update the
        # item projection and attach the movement to the created batch.
        update_data = {"stock_quantity": new_quantity}
        result = await update_one("items", update_data, {"id": str(item_id), "organization_id": str(current_user["organization_id"])})
        movement_dict = {
            "id": str(uuid4()),
            "item_id": str(item_id),
            "branch_id": str(item.get("branch_id") or current_user.get("branch_id")) if (item.get("branch_id") or current_user.get("branch_id")) else None,
            "type": "restock" if type == "add" else "adjustment",
            "quantity": quantity if type == "add" else new_quantity - int(item.get("stock_quantity", 0)),
            "previous_quantity": item["stock_quantity"],
            "new_quantity": new_quantity,
            "reference_id": locals().get("batch_id"),
            "reference_type": "stock_receiving" if type == "add" else "stock_adjustment",
            "created_by": str(current_user["id"]),
            "batch_id": locals().get("batch_id"),
            "batch_number": (body.get("batch_number") or item.get("batch_number")) if locals().get("batch_id") else None,
            "batch_expiry_date": (body.get("expiry_date") or item.get("expiry_date")) if locals().get("batch_id") else None,
        }
        await insert_one("stock_movements", movement_dict)
    
    from database import log_audit
    await log_audit(
        organization_id=str(current_user["organization_id"]),
        user_id=str(current_user["id"]),
        branch_id=str(current_user.get("branch_id", "")),
        action=f"stock_{type}", entity_type="item",
        entity_id=str(item_id),
        details={"quantity": quantity, "previous": int(item.get("stock_quantity", 0)), "new": new_quantity},
    )
    
    # Check for low stock and create notification
    min_stock = item.get("min_stock_level", 0)
    if new_quantity <= min_stock:
        await create_low_stock_notification(
            org_id=current_user["organization_id"],
            item_id=str(item_id),
            item_name=item.get("name", "Unknown Item"),
            quantity=new_quantity,
            min_stock=min_stock
        )
    
    return result



@router.post("/bulk-stock-adjust")
async def bulk_stock_adjust(
    body: dict,
    current_user: dict = Depends(require_manager)
):
    """
    Adjust stock for multiple items at once.
    body: { adjustments: [{item_id, quantity, type, reason}] }
    type: 'add' | 'subtract' | 'set'
    """
    org_id = current_user["organization_id"]
    adjustments = body.get("adjustments", [])
    if not adjustments:
        raise HTTPException(status_code=400, detail="No adjustments provided")
    if len(adjustments) > 200:
        raise HTTPException(status_code=400, detail="Max 200 adjustments per request")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    results = {"ok": [], "failed": []}
    for adj in adjustments:
        item_id = str(adj.get("item_id", ""))
        qty     = int(adj.get("quantity", 0))
        atype   = adj.get("type", "add")
        reason  = (adj.get("reason") or "Bulk adjustment")[:255]
        if not item_id or atype not in ("add","subtract","set"):
            results["failed"].append({"item_id": item_id, "reason": "Invalid params"})
            continue
        try:
            r = await asyncio.to_thread(
                lambda iid=item_id: client.table("items").select("id,name,stock_quantity,buy_price")
                    .eq("id", iid).eq("organization_id", org_id)
                    .eq("is_active", True).limit(1).execute()
            )
            item = (r.data or [None])[0]
            if not item:
                results["failed"].append({"item_id": item_id, "reason": "Not found"}); continue
            prev = int(item["stock_quantity"] or 0)
            if atype == "add":        new_qty = prev + qty
            elif atype == "subtract": new_qty = prev - qty
            else:                     new_qty = max(0, qty)
            if new_qty < 0:
                results["failed"].append({"item_id": item_id, "reason": "Insufficient stock"}); continue

            batch_id = None
            movement_written = False
            if atype == "add" or (atype == "set" and new_qty > prev):
                receipt_qty = qty if atype == "add" else new_qty - prev
                batch_id = str(uuid4())
                await insert_one("item_batches", {
                    "id": batch_id, "organization_id": org_id, "branch_id": current_user.get("branch_id"),
                    "item_id": item_id, "batch_number": adj.get("batch_number"),
                    "expiry_date": adj.get("expiry_date"), "received_quantity": receipt_qty,
                    "quantity_on_hand": receipt_qty,
                    "unit_cost": adj.get("unit_cost") if adj.get("unit_cost") not in (None, "") else item.get("buy_price"),
                    "supplier_id": adj.get("supplier_id"), "is_active": True,
                })
                # Re-derive the projection from the ledger so it cannot drift.
                try:
                    _sync = await asyncio.to_thread(lambda iid=item_id: client.rpc("sync_item_stock_from_batches", {"p_item_id": iid}).execute())
                    new_qty = int(_sync.data)
                except (TypeError, ValueError):
                    pass
            elif atype == "subtract" or (atype == "set" and new_qty < prev):
                deduct_qty = qty if atype == "subtract" else prev - new_qty
                new_qty = await _deduct_batches_fefo(
                    client, item, deduct_qty, org_id, current_user.get("branch_id"),
                    current_user["id"], "bulk_stock_adjustment", reason
                )
                movement_written = True

            if not movement_written:
                await asyncio.to_thread(
                    lambda iid=item_id, nq=new_qty, oid=str(org_id): client.table("items")
                        .update({"stock_quantity": nq}).eq("id", iid).eq("organization_id", oid).execute()
                )
                await insert_one("stock_movements", {
                    "id": str(__import__("uuid").uuid4()),
                    "item_id": item_id, "branch_id": current_user.get("branch_id"),
                    "type": "adjustment", "quantity": new_qty - prev,
                    "previous_quantity": prev, "new_quantity": new_qty,
                    "created_by": current_user["id"],
                    "batch_id": batch_id,
                    "batch_number": adj.get("batch_number") if batch_id else None,
                    "batch_expiry_date": adj.get("expiry_date") if batch_id else None,
                })
            results["ok"].append({"item_id": item_id, "name": item["name"], "old": prev, "new": new_qty})
            from database import log_audit
            await log_audit(
                organization_id=str(current_user["organization_id"]),
                user_id=str(current_user["id"]),
                branch_id=str(current_user.get("branch_id", "")),
                action=f"bulk_stock_{atype}", entity_type="item",
                entity_id=item_id,
                details={"reason": reason, "previous": prev, "new": new_qty},
            )
        except Exception as e:
            results["failed"].append({"item_id": item_id, "reason": str(e)})

    return {"ok": True, "adjusted": len(results["ok"]), "failed": len(results["failed"]), "results": results}

@router.delete("/{item_id}")
async def delete_item(
    item_id: UUID,
    current_user: dict = Depends(require_manager)
):
    """Delete item (soft delete)"""
    filters = {"id": str(item_id), "organization_id": str(current_user["organization_id"])}
    result = await update_one("items", {"is_active": False}, filters)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found"
        )
    
    return {"message": "Item deleted successfully"}


# ── Batch Disposal / Archive ───────────────────────────────────────────────────
@router.post("/{item_id}/batches/dispose")
async def dispose_batch(
    body: dict,
    current_user: dict = Depends(require_manager)
):
    """
    Dispose (destroy) a specific batch — for waste, damage, or expired stock.
    body: { batch_id, quantity, reason }
    Deducts from the batch ledger so items.stock_quantity stays in sync.
    """
    batch_id = body.get("batch_id")
    quantity = int(body.get("quantity", 0))
    reason   = (body.get("reason") or "Manual disposal").strip()[:255]
    if not batch_id or quantity <= 0:
        raise HTTPException(status_code=400, detail="batch_id and positive quantity required")
    org_id = current_user["organization_id"]
    branch_id = current_user.get("branch_id")
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    try:
        result = await asyncio.to_thread(
            lambda: client.rpc("dispose_batch", {
                "p_batch_id": str(batch_id),
                "p_quantity": quantity,
                "p_reason": reason,
                "p_organization_id": str(org_id),
                "p_branch_id": str(branch_id) if branch_id else None,
                "p_created_by": str(current_user["id"]),
            }).execute()
        )
        if result.data:
            return {"ok": True, **result.data}
        raise HTTPException(status_code=500, detail="Disposal returned no data")
    except HTTPException:
        raise
    except Exception as e:
        err = str(e)
        if "Cannot dispose" in err or "Batch not found" in err:
            raise HTTPException(status_code=400, detail=err)
        logger.error(f"dispose_batch error: {e}")
        raise HTTPException(status_code=500, detail="Failed to dispose batch")


@router.post("/batches/archive-expired")
async def archive_expired_batches(
    current_user: dict = Depends(require_manager)
):
    """Mark all expired batches as inactive for this organization."""
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    try:
        result = await asyncio.to_thread(
            lambda: client.rpc("archive_expired_batches", {"p_organization_id": str(org_id)}).execute()
        )
        archived = int(result.data) if result.data else 0
        return {"ok": True, "archived": archived}
    except Exception as e:
        logger.error(f"archive_expired_batches error: {e}")
        raise HTTPException(status_code=500, detail="Failed to archive expired batches")


# Helper functions for notifications

async def create_low_stock_notification(org_id: str, item_id: str, item_name: str, quantity: int, min_stock: int):
    """Create a low stock notification"""
    try:
        notification_dict = {
            "id": str(uuid4()),
            "organization_id": org_id,
            "user_id": None,  # Broadcast to all users in org
            "title": "Low Stock Alert",
            "message": f"{item_name} is running low ({quantity} remaining, minimum: {min_stock})",
            "notification_type": NotificationType.LOW_STOCK.value,
            "is_read": False,
            "related_id": item_id,
            "link": "/items",
            "created_at": datetime.utcnow()
        }
        await insert_one("notifications", notification_dict)
        logger.info(f"[NOTIFICATION] Low stock notification created for item {item_id}")
    except Exception as e:
        logger.error(f"[NOTIFICATION] Failed to create low stock notification: {e}")


async def create_expiry_notification(org_id: str, item_id: str, item_name: str, expiry_date):
    """Create an expiring item notification (accepts date or datetime)."""
    try:
        from datetime import date as _d
        if isinstance(expiry_date, str):
            expiry_date = _d.fromisoformat(expiry_date[:10])
        _exp = expiry_date.date() if isinstance(expiry_date, datetime) else expiry_date
        days_until_expiry = (_exp - _d.today()).days
        
        notification_dict = {
            "id": str(uuid4()),
            "organization_id": org_id,
            "user_id": None,  # Broadcast to all users in org
            "title": "Expiring Item Alert",
            "message": f"{item_name} will expire in {days_until_expiry} days",
            "notification_type": NotificationType.EXPIRING_ITEMS.value,
            "is_read": False,
            "related_id": item_id,
            "link": "/items",
            "created_at": datetime.utcnow()
        }
        await insert_one("notifications", notification_dict)
        logger.info(f"[NOTIFICATION] Expiry notification created for item {item_id}")
    except Exception as e:
        logger.error(f"[NOTIFICATION] Failed to create expiry notification: {e}")
