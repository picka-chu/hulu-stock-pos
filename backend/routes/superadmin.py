"""
Super Admin Routes - Full Control Panel
- Credentials read from environment variables
- Per-org feature flags via JSONB features column
- Performance metrics, request logs, org settings
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import timedelta, datetime, timezone
from uuid import uuid4
from pathlib import Path
import asyncio
import os
import time

from dotenv import load_dotenv

# Load backend/.env even when the server is started from the repo root.
# Real deployment env vars still win because override=False.
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

from database import fetch_one, fetch_all, insert_one, update_one, get_supabase_client
from middleware.auth import create_access_token, decode_token, get_password_hash

router = APIRouter()
security = HTTPBearer()

# ── Credentials from environment ──────────────────────────────────────────────
_SA_EMAIL    = os.getenv("SUPERADMIN_EMAIL",    "bereket@onyx.com").strip()
_SA_PASSWORD = os.getenv("SUPERADMIN_PASSWORD", "").strip()
_SA_ENV      = os.getenv("ENVIRONMENT", "production")

import logging as _salog
if not _SA_PASSWORD or _SA_PASSWORD in ("050508", "admin", "password", "superadmin", ""):
    if not _SA_PASSWORD:
        _SA_PASSWORD = os.getenv("SUPERADMIN_PASSWORD", "")
    warning_msg = (
        "SUPERADMIN_PASSWORD is not set or uses a weak default. "
        "Set a strong SUPERADMIN_PASSWORD env var in production."
    )
    _salog.getLogger("superadmin").warning(warning_msg)
    if _SA_ENV == "production":
        _salog.getLogger("superadmin").error("CRITICAL: %s", warning_msg)
    if not _SA_PASSWORD:
        _SA_PASSWORD = "050508"

_SA_ROLE = "superadmin"

# ── In-memory request tracking (resets on restart) ────────────────────────────
_request_log: list = []   # [{ts, path, method, status, ms}]
_MAX_LOG = 500

# ── In-memory registration requests ────────────────────────────────────────────
_registration_requests: list = []  # [{id, ts, business_name, full_name, phone, email, address, category, message}]

def log_request(path: str, method: str, status: int, ms: float):
    _request_log.append({
        "ts":     datetime.now(timezone.utc).isoformat(),
        "path":   path,
        "method": method,
        "status": status,
        "ms":     round(ms, 1),
    })
    if len(_request_log) > _MAX_LOG:
        _request_log.pop(0)


DEFAULT_FEATURES = {
    "branches":           True,
    "multi_user":         True,
    "ai_scan":            True,
    "fast_scan":          True,
    "smart_scan":         True,
    "reports":            True,
    "expenses":           True,
    "suppliers":          True,
    "export":             True,
    "push_notifications": True,
    "phone_camera":       True,
    "max_branches":       0,   # 0 = unlimited
    "max_users":          0,   # 0 = unlimited
}


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
        from database import log_audit
        await log_audit(organization_id="", user_id="superadmin",
            action="superadmin_login_failed", entity_type="auth",
            details={"email": email})
        raise HTTPException(
            status_code=401,
            detail="Invalid superadmin credentials. Check SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD on the backend."
        )

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

    async def _enrich(org):
        oid = org["id"]
        b, u, s = await asyncio.gather(
            asyncio.to_thread(lambda: client.table("branches").select("id").eq("organization_id", oid).execute()),
            asyncio.to_thread(lambda: client.table("users").select("id").eq("organization_id", oid).execute()),
            asyncio.to_thread(lambda: client.table("sales").select("id").eq("organization_id", oid).eq("payment_status", "paid").execute()),
        )
        org["branch_count"] = len(b.data or [])
        org["user_count"]   = len(u.data or [])
        org["total_sales"]  = len(s.data or [])
        # Ensure features always has all keys (backfill missing keys)
        f = {**DEFAULT_FEATURES, **(org.get("features") or {})}
        org["features"] = f
        return org

    orgs = await asyncio.gather(*[_enrich(o) for o in orgs])
    return list(orgs)


# ── Get single organisation ───────────────────────────────────────────────────
@router.get("/organizations/{org_id}")
async def get_organization(org_id: str, _: dict = Depends(require_superadmin)):
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    resp = await asyncio.to_thread(
        lambda: client.table("organizations").select("*").eq("id", org_id).execute()
    )
    orgs = resp.data or []
    if not orgs:
        raise HTTPException(status_code=404, detail="Organization not found")
    org = orgs[0]
    org["features"] = {**DEFAULT_FEATURES, **(org.get("features") or {})}
    return org


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

    # Merge supplied features with defaults
    features = {**DEFAULT_FEATURES, **(body.get("features") or {})}

    org = await insert_one("organizations", {
        "id": org_id, "name": name,
        "currency":          body.get("currency", "ETB"),
        "tax_percentage":    float(body.get("tax_percentage", 0)),
        "brand_color":       body.get("brand_color", "#2563EB"),
        "subscription_plan": body.get("subscription_plan", "basic"),
        "tenant_type":       body.get("tenant_type", "retail"),
        "features":          features,
        "notes":             body.get("notes", ""),
        "is_active": True,
    })

    branch = await insert_one("branches", {
        "id": branch_id, "organization_id": org_id,
        "name": "Main Branch",
        "location": body.get("location", ""),
        "phone":    body.get("phone", ""),
        "is_active": True,
    })

    await insert_one("users", {
        "id": user_id, "organization_id": org_id,
        "branch_id": branch_id, "full_name": admin_name,
        "email": admin_email,
        "password_hash": get_password_hash(admin_password),
        "role": "admin", "is_active": True,
    })

    from database import log_audit
    await log_audit(organization_id=org_id, user_id="superadmin",
        action="org_created", entity_type="organization", entity_id=org_id,
        details={"name": name, "admin_email": admin_email})
    return {"organization": org, "branch": branch, "admin_user_id": user_id}


# ── Update organisation (basic fields) ───────────────────────────────────────
@router.put("/organizations/{org_id}")
async def update_organization(org_id: str, body: dict, _: dict = Depends(require_superadmin)):
    allowed = ["name", "currency", "tax_percentage", "brand_color",
               "subscription_plan", "tenant_type", "is_active", "logo_url", "notes"]
    data = {k: v for k, v in body.items() if k in allowed}
    if not data:
        raise HTTPException(status_code=400, detail="No valid fields provided")
    result = await update_one("organizations", data, {"id": org_id})
    if not result:
        raise HTTPException(status_code=404, detail="Organization not found")
    return result


# ── Update organisation features ─────────────────────────────────────────────
@router.patch("/organizations/{org_id}/features")
async def update_org_features(org_id: str, body: dict, _: dict = Depends(require_superadmin)):
    """
    Accepts a partial or full features object.
    Merges with existing features — only keys provided are updated.
    """
    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    # Fetch current features
    resp = await asyncio.to_thread(
        lambda: client.table("organizations").select("features").eq("id", org_id).execute()
    )
    rows = resp.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Organization not found")

    current = {**DEFAULT_FEATURES, **(rows[0].get("features") or {})}

    # Validate and merge incoming feature values
    allowed_bool = {
        "branches", "multi_user", "ai_scan", "fast_scan", "smart_scan",
        "reports", "expenses", "suppliers", "export",
        "push_notifications", "phone_camera"
    }
    allowed_int = {"max_branches", "max_users"}

    for k, v in body.items():
        if k in allowed_bool:
            current[k] = bool(v)
        elif k in allowed_int:
            current[k] = max(0, int(v))

    result = await update_one("organizations", {"features": current}, {"id": org_id})
    if not result:
        raise HTTPException(status_code=500, detail="Update failed")
    return {"id": org_id, "features": current}


# ── Toggle active status ──────────────────────────────────────────────────────
@router.patch("/organizations/{org_id}/toggle")
async def toggle_organization(org_id: str, _: dict = Depends(require_superadmin)):
    org = await fetch_one("organizations", {"id": org_id})
    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")
    new_status = org.get("is_active") is False
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
    from database import log_audit
    await log_audit(organization_id=org_id, user_id="superadmin",
        action="org_deleted", entity_type="organization", entity_id=org_id,
        details={})
    return {"message": "Organization deleted"}


# ── Platform stats ────────────────────────────────────────────────────────────
@router.get("/stats")
async def platform_stats(_: dict = Depends(require_superadmin)):
    client = await get_supabase_client()
    if not client:
        return {}

    orgs, users, sales, branches = await asyncio.gather(
        asyncio.to_thread(lambda: client.table("organizations").select("id,is_active,created_at").execute()),
        asyncio.to_thread(lambda: client.table("users").select("id,is_active").execute()),
        asyncio.to_thread(lambda: client.table("sales").select("id,total_amount,created_at").eq("payment_status", "paid").execute()),
        asyncio.to_thread(lambda: client.table("branches").select("id,is_active").execute()),
    )

    orgs_data    = orgs.data or []
    users_data   = users.data or []
    sales_data   = sales.data or []
    branches_data = branches.data or []

    total_revenue = sum(float(s.get("total_amount") or 0) for s in sales_data)

    # Sales last 7 days
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    recent_sales = [
        s for s in sales_data
        if s.get("created_at") and s["created_at"] > week_ago.isoformat()
    ]

    return {
        "total_orgs":      len(orgs_data),
        "active_orgs":     sum(1 for o in orgs_data if o.get("is_active")),
        "total_users":     len(users_data),
        "active_users":    sum(1 for u in users_data if u.get("is_active")),
        "total_branches":  len(branches_data),
        "total_sales":     len(sales_data),
        "total_revenue":   round(total_revenue, 2),
        "sales_this_week": len(recent_sales),
    }


# ── Request log (in-memory) ───────────────────────────────────────────────────
@router.get("/requests")
async def get_request_log(_: dict = Depends(require_superadmin)):
    return list(reversed(_request_log))


# ── Registration requests (public ─ submit; superadmin ─ view) ─────────────────
@router.post("/register-request")
async def submit_registration_request(body: dict):
    """Public endpoint — no auth required. Accepts a business registration request."""
    business_name = (body.get("business_name") or "").strip()
    full_name     = (body.get("full_name") or "").strip()
    phone         = (body.get("phone") or "").strip()
    email         = (body.get("email") or "").strip()

    if not business_name or not full_name or not phone or not email:
        raise HTTPException(status_code=400, detail="Business name, full name, phone and email are required")

    req = {
        "id":            str(uuid4()),
        "ts":            datetime.now(timezone.utc).isoformat(),
        "business_name": business_name,
        "full_name":     full_name,
        "phone":         phone,
        "email":         email,
        "address":       (body.get("address") or "").strip(),
        "category":      body.get("category", "retail"),
        "message":       (body.get("message") or "").strip(),
    }
    _registration_requests.append(req)
    _salog.getLogger("superadmin").info(f"New registration request from {business_name} ({full_name}, {phone})")
    return {"success": True, "message": "Registration request submitted. We will contact you within 24 hours."}


@router.get("/register-requests")
async def list_registration_requests(_: dict = Depends(require_superadmin)):
    return list(reversed(_registration_requests))


# ── Health / ping ─────────────────────────────────────────────────────────────
@router.get("/health")
async def health_check(_: dict = Depends(require_superadmin)):
    t0 = time.time()
    client = await get_supabase_client()
    db_ok = False
    db_ms = 0.0
    if client:
        try:
            await asyncio.to_thread(
                lambda: client.table("organizations").select("id").limit(1).execute()
            )
            db_ok = True
        except Exception:
            pass
    db_ms = round((time.time() - t0) * 1000, 1)
    return {
        "status":  "ok" if db_ok else "degraded",
        "db_ok":   db_ok,
        "db_ms":   db_ms,
        "ts":      datetime.now(timezone.utc).isoformat(),
    }
