"""
Suppliers Routes - with branch filtering
Suppliers can be org-wide (branch_id=null) or branch-specific.
When branch_id is active, shows that branch's suppliers + org-wide ones.
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID, uuid4
from typing import List, Optional
import asyncio

from models import SupplierCreate, SupplierUpdate, SupplierResponse
from middleware.auth import get_current_user, require_manager
from database import fetch_one, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


@router.get("", response_model=List[SupplierResponse])
async def get_suppliers(
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        return []

    # Resolve effective branch: explicit param → user JWT branch → None (all)
    effective_branch = branch_id or current_user.get("branch_id") or None

    if effective_branch:
        # Show suppliers belonging to this branch OR org-wide (branch_id=null)
        r_branch, r_shared = await asyncio.gather(
            asyncio.to_thread(lambda: client.table("suppliers").select("*")
                .eq("organization_id", org_id)
                .eq("branch_id", str(effective_branch))
                .eq("is_active", True).execute()),
            asyncio.to_thread(lambda: client.table("suppliers").select("*")
                .eq("organization_id", org_id)
                .is_("branch_id", "null")
                .eq("is_active", True).execute()),
        )
        suppliers = (r_branch.data or []) + (r_shared.data or [])
        # Deduplicate and sort
        seen = set()
        deduped = []
        for s in suppliers:
            if s["id"] not in seen:
                seen.add(s["id"])
                deduped.append(s)
        suppliers = sorted(deduped, key=lambda x: x.get("name", "").lower())
    else:
        # All branches — return everything for this org
        resp = await asyncio.to_thread(
            lambda: client.table("suppliers").select("*")
                .eq("organization_id", org_id)
                .eq("is_active", True)
                .order("name").execute()
        )
        suppliers = resp.data or []

    if search:
        s = search.lower()
        suppliers = [x for x in suppliers if
                     s in (x.get("name") or "").lower() or
                     s in (x.get("contact_person") or "").lower() or
                     s in (x.get("email") or "").lower()]

    start = (page - 1) * page_size
    return suppliers[start:start + page_size]


@router.get("/{supplier_id}", response_model=SupplierResponse)
async def get_supplier(supplier_id: UUID, current_user: dict = Depends(get_current_user)):
    supplier = await fetch_one("suppliers", {"id": str(supplier_id), "organization_id": current_user["organization_id"]})
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return supplier


@router.post("", response_model=SupplierResponse, status_code=status.HTTP_201_CREATED)
async def create_supplier(supplier_data: SupplierCreate, current_user: dict = Depends(require_manager)):
    # branch_id from body, or fall back to user's branch, or null (org-wide)
    resolved_branch = (str(supplier_data.branch_id)
                       if supplier_data.branch_id
                       else current_user.get("branch_id") or None)
    if resolved_branch:
        from middleware.auth import verify_branch_in_org
        if not await verify_branch_in_org(resolved_branch, str(current_user["organization_id"])):
            raise HTTPException(status_code=404, detail="Branch not found")
    result = await insert_one("suppliers", {
        "id":              str(uuid4()),
        "organization_id": str(current_user["organization_id"]),
        "branch_id":       resolved_branch,
        "name":            supplier_data.name,
        "phone":           supplier_data.phone,
        "email":           supplier_data.email,
        "address":         supplier_data.address,
        "contact_person":  supplier_data.contact_person,
        "is_active":       True,
    })
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create supplier")
    return result


@router.put("/{supplier_id}", response_model=SupplierResponse)
async def update_supplier(supplier_id: UUID, supplier_data: SupplierUpdate, current_user: dict = Depends(require_manager)):
    existing = await fetch_one("suppliers", {"id": str(supplier_id), "organization_id": current_user["organization_id"]})
    if not existing:
        raise HTTPException(status_code=404, detail="Supplier not found")

    updates = {}
    for field in ("name", "phone", "email", "address", "contact_person", "is_active"):
        val = getattr(supplier_data, field, None)
        if val is not None:
            updates[field] = val
    if supplier_data.branch_id is not None:
        updates["branch_id"] = str(supplier_data.branch_id)

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = await update_one("suppliers", updates, {"id": str(supplier_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=500, detail="Update failed")
    return result


@router.delete("/{supplier_id}")
async def delete_supplier(supplier_id: UUID, current_user: dict = Depends(require_manager)):
    result = await delete_one("suppliers", {"id": str(supplier_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return {"message": "Supplier deleted successfully"}
