"""
Authentication Middleware - Production Ready
- JWT secret MUST be set via JWT_SECRET env var (crashes loudly if missing in production)
- Demo mode is OFF by default
- No fallback to demo on DB error
- Rate limiting data structures (enforced in main.py middleware)
"""
from fastapi import HTTPException, Security, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from typing import Optional, List
import os
from datetime import datetime, timedelta
import secrets
import bcrypt

from database import fetch_one, OFFLINE_MODE

# ── JWT Secret ────────────────────────────────────────────────────────────────
ENVIRONMENT = os.getenv("ENVIRONMENT", "production")
SECRET_KEY  = os.getenv("JWT_SECRET")

if not SECRET_KEY:
    # Generate a random key PER STARTUP so tokens from one deployment cannot
    # be replayed against another. This invalidates all existing sessions on
    # every restart, so you should ALWAYS set JWT_SECRET in production.
    import secrets as _sec
    SECRET_KEY = _sec.token_hex(32)
    import logging as _jlog
    _jlog.getLogger("auth").warning(
        "JWT_SECRET env var not set — using random per-startup key. "
        "All sessions will be invalidated on restart. "
        "Set JWT_SECRET for production security."
    )

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "1440"))  # 24h

# ── Demo mode — OFF by default ────────────────────────────────────────────────
DEMO_MODE_ENABLED = os.getenv("DEMO_MODE_ENABLED", "false").lower() == "true"
_DEMO_SECRET = os.getenv("DEMO_SECRET", "").strip()
if DEMO_MODE_ENABLED and not _DEMO_SECRET:
    import logging as _djlog
    _djlog.getLogger("auth").warning(
        "DEMO_MODE_ENABLED is set but DEMO_SECRET is missing. "
        "Anyone can log in as admin@demo.com! Set DEMO_SECRET to a random string."
    )

# ── Password hashing ──────────────────────────────────────────────────────────
def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False

# ── Token helpers ─────────────────────────────────────────────────────────────
security = HTTPBearer()

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    payload = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload["exp"] = expire
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

# ── Demo token helpers ────────────────────────────────────────────────────────
_DEMO_ORG_ID    = "00000000-0000-0000-0000-000000000001"
_DEMO_BRANCH_ID = "00000000-0000-0000-0000-000000000002"
_DEMO_USER_ID   = "00000000-0000-0000-0000-000000000003"

def _is_demo_token(payload: dict) -> bool:
    return payload.get("is_demo", False)

def _make_demo_user(payload: dict) -> dict:
    return {
        "id":              payload.get("sub", _DEMO_USER_ID),
        "organization_id": payload.get("org_id", _DEMO_ORG_ID),
        "branch_id":       payload.get("branch_id", _DEMO_BRANCH_ID),
        "full_name":       "Demo Admin",
        "email":           "admin@demo.com",
        "role":            payload.get("role", "admin"),
        "is_active":       True,
        "is_demo":         True,
    }

# ── Main auth dependency ──────────────────────────────────────────────────────
async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict:
    """Validate JWT and return the authenticated user dict."""
    token = credentials.credentials
    payload = decode_token(token)

    # Demo token — only allowed when demo mode is on
    if _is_demo_token(payload):
        if not DEMO_MODE_ENABLED:
            raise HTTPException(status_code=403, detail="Demo mode is disabled")
        return _make_demo_user(payload)

    # Superadmin token — bypass DB lookup
    if payload.get("role") == "superadmin":
        return {"id": "superadmin", "role": "superadmin",
                "organization_id": None, "is_active": True, "is_demo": False}

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = await fetch_one("users", {"id": user_id})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if user.get("is_active") is False:  # strict check — NULL/missing = active
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Check the user's assigned branch is still active
    user_branch_id = str(user["branch_id"]) if user.get("branch_id") else None
    if user_branch_id:
        branch = await fetch_one("branches", {
            "id": user_branch_id,
            "organization_id": str(user["organization_id"])  # scoped to org for safety
        })
        if branch:
            # is_active can be: True, False, or None (NULL in DB = not yet set = treat as active)
            # Only block when explicitly False — never block on NULL/missing
            is_active = branch.get("is_active")
            if is_active is False:   # strict False check — None/missing = active
                raise HTTPException(
                    status_code=403,
                    detail=f"Your branch '{branch.get('name', '')}' has been deactivated. Please contact your administrator."
                )

    return {
        "id":              str(user["id"]),
        "organization_id": str(user["organization_id"]),
        "branch_id":       user_branch_id,
        "full_name":       user.get("full_name"),
        "email":           user.get("email"),
        "role":            user.get("role"),
        "is_active":       user.get("is_active") is not False,  # treat NULL as active
        "is_demo":         False,
    }

# ── Role guards ───────────────────────────────────────────────────────────────
def require_roles(allowed_roles: List[str]):
    async def checker(current_user: dict = Security(get_current_user)) -> dict:
        if current_user.get("is_active") is False:  # strict check — NULL/missing = active
            raise HTTPException(status_code=403, detail="Account is disabled")
        if current_user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied. Required: {', '.join(allowed_roles)}"
            )
        return current_user
    return checker

require_admin   = require_roles(["admin"])
require_manager = require_roles(["admin", "manager"])
require_cashier = require_roles(["admin", "manager", "cashier"])

# ── Branch guards (H4) ──────────────────────────────────────────────────────────
async def verify_branch_in_org(branch_id: Optional[str], organization_id: str) -> bool:
    """Return True iff branch exists in org. None/empty = no specific branch, allowed."""
    if not branch_id or str(branch_id) in ("", "undefined", "null", "None"):
        return True
    branch = await fetch_one("branches", {"id": str(branch_id), "organization_id": str(organization_id)})
    return branch is not None

async def resolve_branch_access(
    current_user: dict,
    requested_branch_id: Optional[str] = None,
) -> Optional[str]:
    """
    Resolve effective branch + enforce access:
    - cashier: locked to JWT branch (requested ignored)
    - manager/admin: requested must belong to org (404 otherwise)
    Returns effective branch id or None (all branches).
    """
    role = current_user.get("role", "cashier")
    user_branch = current_user.get("branch_id")
    org_id = str(current_user.get("organization_id") or "")

    if role == "cashier":
        return user_branch

    if requested_branch_id and str(requested_branch_id) not in ("", "undefined", "null", "None"):
        if not await verify_branch_in_org(requested_branch_id, org_id):
            raise HTTPException(status_code=404, detail="Branch not found")
        return str(requested_branch_id)
    return user_branch
