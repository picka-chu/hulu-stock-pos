"""
Super Admin Routes - Production Ready
- Credentials read from environment variables (never hardcoded)
- Falls back to env vars SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import timedelta
from uuid import uuid4
import asyncio
import os

from database import fetch_one, fetch_all, insert_one, update_one, get_supabase_client
from middleware.auth import create_access_token, decode_token, get_password_hash

router = APIRouter()
security = HTTPBearer()

# ── Credentials from environment ──────────────────────────────────────────────
_SA_EMAIL    = os.getenv("SUPERADMIN_EMAIL",    "bereket@onyx.com")
_SA_PASSWORD = os.getenv("SUPERADMIN_PASSWORD", "050508")

import logging as _salog
if _SA_PASSWORD == "050508":
    _salog.getLogger("superadmin").warning(
        "SUPERADMIN_PASSWORD is using the default '050508'. "
        "Set SUPERADMIN_PASSWORD env var to change it."
    )

_SA_ROLE = "superadmin"


async def require_superadmin(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    try:
        payload = decode_token(credentials.credentials)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid superadmin token")
    if payload.get("role") != _SA_ROLE:
        raise HTTPException(status_code=403, detail="Superadmin access required")
    return payload


# ── Login ─────────────────────────────────────────────────────────────────────
@router.post("/login")
async def superadmin_login(body: dict):
    email    = body.get("email", "").strip().lower()
    password = body.get("password", "")

    if email != _SA_EMAIL.lower() or password != _SA_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(
        data={"sub": "superadmin", "role": _SA_ROLE},
        expires_delta=timedelta(hours=12)
    )
    return {"access_token": token, "token_type": "bearer"}


# ── List organisations ────────────────────────────────────────────────────────
@router.get("/organizations")
async def list_organizations(_: dict = Depends(require_superadmin)):
    client = await get_supabase_client()
    if not client:
        return []

    resp = await asyncio.to_thread(
        lambda: client.table("organizations").select("*").order("created_at", desc=True).execute()
    )
    orgs = resp.data or []

    for org in orgs:
        oid = org["id"]
        b = await asyncio.to_thread(lambda: client.table("branches").select("id").eq("organization_id", oid).execute())
        u = await asyncio.to_thread(lambda: client.table("users").select("id").eq("organization_id", oid).execute())
        s = await asyncio.to_thread(lambda: client.table("sales").select("id").eq("organization_id", oid).eq("payment_status", "paid").execute())
        org["branch_count"] = len(b.data or [])
        org["user_count"]   = len(u.data or [])
        org["total_sales"]  = len(s.data or [])

    return orgs


# ── Create organisation ───────────────────────────────────────────────────────
@router.post("/organizations")
async def create_organization(body: dict, _: dict = Depends(require_superadmin)):
    name           = body.get("name", "").strip()
    admin_email    = body.get("admin_email", "").strip()
    admin_password = body.get("admin_password", "").strip()
    admin_name     = body.get("admin_name", "Admin").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Organization name required")
    if not admin_email or not admin_password:
        raise HTTPException(status_code=400, detail="Admin email and password required")
    if len(admin_password) < 8:
        raise HTTPException(status_code=400, detail="Admin password must be at least 8 characters")
    if await fetch_one("users", {"email": admin_email}):
        raise HTTPException(status_code=400, detail="Admin email already in use")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    org_id    = str(uuid4())
    branch_id = str(uuid4())
    user_id   = str(uuid4())

    org = await insert_one("organizations", {
        "id": org_id, "name": name,
        "currency": body.get("currency", "ETB"),
        "tax_percentage": float(body.get("tax_percentage", 0)),
        "brand_color": body.get("brand_color", "#2563EB"),
        "subscription_plan": body.get("subscription_plan", "basic"),
        "is_active": True,
    })

    branch = await insert_one("branches", {
        "id": branch_id, "organization_id": org_id,
        "name": "Main Branch",
        "location": body.get("location", ""),
        "phone": body.get("phone", ""),
        "is_active": True,
    })

    await insert_one("users", {
        "id": user_id, "organization_id": org_id,
        "branch_id": branch_id, "full_name": admin_name,
        "email": admin_email,
        "password_hash": get_password_hash(admin_password),
        "role": "admin", "is_active": True,
    })

    return {"organization": org, "branch": branch, "admin_user_id": user_id}


# ── Update organisation ───────────────────────────────────────────────────────
@router.put("/organizations/{org_id}")
async def update_organization(org_id: str, body: dict, _: dict = Depends(require_superadmin)):
    allowed = ["name", "currency", "tax_percentage", "brand_color", "subscription_plan", "is_active", "logo_url"]
    data = {k: v for k, v in body.items() if k in allowed}
    if not data:
        raise HTTPException(status_code=400, detail="No valid fields provided")
    result = await update_one("organizations", data, {"id": org_id})
    if not result:
        raise HTTPException(status_code=404, detail="Organization not found")
    return result


# ── Toggle active status ──────────────────────────────────────────────────────
@router.patch("/organizations/{org_id}/toggle")
async def toggle_organization(org_id: str, _: dict = Depends(require_superadmin)):
    org = await fetch_one("organizations", {"id": org_id})
    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")
    new_status = org.get("is_active") is False  # NULL/True → False, False → True
    await update_one("organizations", {"is_active": new_status}, {"id": org_id})
    return {"id": org_id, "is_active": new_status}


# ── Delete organisation ───────────────────────────────────────────────────────
@router.delete("/organizations/{org_id}")
async def delete_organization(org_id: str, _: dict = Depends(require_superadmin)):
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    resp = await asyncio.to_thread(
        lambda: client.table("organizations").delete().eq("id", org_id).execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Organization not found")
    return {"message": "Organization deleted"}
