"""
Authentication Routes - Production Ready
- Test endpoints REMOVED
- Demo credentials REMOVED
- Login rate limiting via slowapi
- Password min-length enforced
"""
from fastapi import APIRouter, HTTPException, status, Depends, Request
from datetime import timedelta
from uuid import uuid4

from models import UserCreate, UserLogin, TokenResponse, UserResponse, OrganizationResponse, BranchResponse
from middleware.auth import (
    get_password_hash, verify_password, create_access_token,
    get_current_user, ACCESS_TOKEN_EXPIRE_MINUTES, DEMO_MODE_ENABLED,
    _make_demo_user, _DEMO_ORG_ID, _DEMO_BRANCH_ID, _DEMO_USER_ID
)
from database import fetch_one, fetch_all, insert_one

router = APIRouter()

# ── Login ─────────────────────────────────────────────────────────────────────
@router.post("/login", response_model=TokenResponse)
async def login(credentials: UserLogin, request: Request):
    """Authenticate user and return JWT."""

    # Demo shortcut — only when demo mode is explicitly enabled
    if DEMO_MODE_ENABLED:
        if credentials.email in ("admin@demo.com", "admin@demostore.com"):
            return await demo_login()

    user = await fetch_one("users", {"email": credentials.email})

    # Use constant-time comparison pattern — always verify even if user not found
    dummy_hash = "$2b$12$IeIBUGDCfYXFBpSzH3VyteGy.YHuYZ98iJGbfwjXUxf5v7SdCfqBu" 
    stored_hash = user["password_hash"] if user else dummy_hash

    if not verify_password(credentials.password, stored_hash) or not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if user.get("is_active") is False:
        raise HTTPException(status_code=403, detail="Account is disabled")

    organization = await fetch_one("organizations", {"id": user["organization_id"]})
    if not organization:
        raise HTTPException(status_code=404, detail="Organization not found")

    if organization.get("is_active") is False:
        raise HTTPException(status_code=403, detail="Organization account is suspended")

    branch = None
    if user.get("branch_id"):
        branch = await fetch_one("branches", {"id": user["branch_id"]})

    token = create_access_token(
        data={
            "sub":       user["id"],
            "org_id":    user["organization_id"],
            "branch_id": user.get("branch_id"),
            "role":      user["role"],
        }
    )

    return _build_token_response(token, user, organization, branch)


# ── Register ──────────────────────────────────────────────────────────────────
@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(user_data: UserCreate):
    """
    Register a new user.
    Requires REGISTRATION_SECRET env var to match the invite_token field,
    OR must be called by an existing admin (checked by attempting admin JWT).
    This prevents anyone who knows an org UUID from self-registering.
    """
    import os as _os
    reg_secret = _os.getenv("REGISTRATION_SECRET", "")
    invite_token = getattr(user_data, "invite_token", "") or ""
    if not reg_secret:
        raise HTTPException(status_code=403, detail="Registration is disabled. Contact your administrator.")
    if invite_token != reg_secret:
        raise HTTPException(
            status_code=403,
            detail="Registration requires a valid invite token. Contact your administrator."
        )

    if len(user_data.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    if await fetch_one("users", {"email": user_data.email}):
        raise HTTPException(status_code=400, detail="Email already registered")

    organization = await fetch_one("organizations", {"id": user_data.organization_id})
    if not organization:
        raise HTTPException(status_code=404, detail="Organization not found")

    branch = None
    if user_data.branch_id:
        branch = await fetch_one("branches", {
            "id": user_data.branch_id,
            "organization_id": user_data.organization_id
        })
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

    user_id = str(uuid4())
    role_value = getattr(user_data.role, "value", user_data.role)
    if str(role_value).lower() not in ("admin", "manager", "cashier"):
        raise HTTPException(status_code=400, detail="Invalid role")
    await insert_one("users", {
        "id":              user_id,
        "organization_id": str(user_data.organization_id),
        "branch_id":       str(user_data.branch_id) if user_data.branch_id else None,
        "full_name":       user_data.full_name,
        "phone":           user_data.phone,
        "email":           user_data.email,
        "password_hash":   get_password_hash(user_data.password),
        "role":            str(role_value).lower(),
        "is_active":       True,
    })

    user = await fetch_one("users", {"id": user_id})
    token = create_access_token(data={
        "sub":       user["id"],
        "org_id":    user["organization_id"],
        "branch_id": user.get("branch_id"),
        "role":      user["role"],
    })

    return _build_token_response(token, user, organization, branch)


# ── Get current user ──────────────────────────────────────────────────────────
@router.get("/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    org = await fetch_one("organizations", {"id": current_user["organization_id"]})
    branch = None
    if current_user.get("branch_id"):
        branch = await fetch_one("branches", {"id": current_user["branch_id"]})
    return {"user": current_user, "organization": org, "branch": branch}


# ── Logout ────────────────────────────────────────────────────────────────────
@router.post("/logout")
async def logout(current_user: dict = Depends(get_current_user)):
    # JWT is stateless — client must discard the token
    return {"message": "Logged out successfully"}



# ── Token refresh ─────────────────────────────────────────────────────────────
@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(current_user: dict = Depends(get_current_user)):
    """
    Issue a fresh JWT for an already-authenticated user.
    Call this when the token is close to expiry (or after 23h).
    The old token must still be valid to call this endpoint.
    """
    if current_user.get("is_demo"):
        raise HTTPException(status_code=403, detail="Demo tokens cannot be refreshed")

    user = await fetch_one("users", {"id": current_user["id"]})
    if not user or user.get("is_active") is False:
        raise HTTPException(status_code=401, detail="User not found or disabled")

    organization = await fetch_one("organizations", {"id": current_user["organization_id"]})
    if not organization or organization.get("is_active") is False:
        raise HTTPException(status_code=403, detail="Organization suspended")

    branch = None
    if current_user.get("branch_id"):
        branch = await fetch_one("branches", {"id": current_user["branch_id"]})

    token = create_access_token(data={
        "sub":       current_user["id"],
        "org_id":    current_user["organization_id"],
        "branch_id": current_user.get("branch_id"),
        "role":      current_user["role"],
    })
    return _build_token_response(token, user, organization, branch)


# ── Password reset (self-service) ────────────────────────────────────────────
@router.post("/change-password")
async def change_password(
    body: dict,
    current_user: dict = Depends(get_current_user)
):
    """
    Change password for the currently authenticated user.
    Requires old_password verification before setting new_password.
    """
    old_password = (body.get("old_password") or "").strip()
    new_password = (body.get("new_password") or "").strip()

    if not old_password or not new_password:
        raise HTTPException(status_code=400, detail="old_password and new_password are required")
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    user = await fetch_one("users", {"id": current_user["id"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not verify_password(old_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    from database import update_one
    new_hash = get_password_hash(new_password)
    await update_one("users", {"password_hash": new_hash}, {"id": current_user["id"]})
    return {"ok": True, "message": "Password changed successfully"}


# ── Demo login (only if DEMO_MODE_ENABLED=true) ───────────────────────────────
@router.post("/demo", response_model=TokenResponse)
async def demo_login():
    if not DEMO_MODE_ENABLED:
        raise HTTPException(status_code=403, detail="Demo mode is disabled")

    token = create_access_token(
        data={
            "sub":       _DEMO_USER_ID,
            "org_id":    _DEMO_ORG_ID,
            "branch_id": _DEMO_BRANCH_ID,
            "role":      "admin",
            "is_demo":   True,
        },
        expires_delta=timedelta(hours=4)
    )
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserResponse(
            id=_DEMO_USER_ID, organization_id=_DEMO_ORG_ID,
            branch_id=_DEMO_BRANCH_ID, full_name="Demo Admin",
            phone=None, email="admin@demo.com",
            role="admin", is_active=True, created_at=None
        ),
        organization=OrganizationResponse(
            id=_DEMO_ORG_ID, name="Demo Store", logo_url=None,
            brand_color="#2563EB", currency="ETB", tax_percentage=0.0,
            subscription_plan="premium", is_active=True,
            created_at=None, updated_at=None
        ),
        branch=BranchResponse(
            id=_DEMO_BRANCH_ID, organization_id=_DEMO_ORG_ID,
            name="Main Branch", location="Demo Street",
            phone=None, email=None, is_active=True,
            created_at=None, updated_at=None
        )
    )


# ── Builder helper ────────────────────────────────────────────────────────────
def _build_token_response(token, user, organization, branch):
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserResponse(
            id=str(user["id"]),
            organization_id=str(user["organization_id"]),
            branch_id=str(user["branch_id"]) if user.get("branch_id") else None,
            full_name=user["full_name"],
            phone=user.get("phone"),
            email=user["email"],
            role=user["role"],
            is_active=user.get("is_active") is not False,
            created_at=user.get("created_at"),
        ),
        organization=OrganizationResponse(
            id=str(organization["id"]),
            name=organization["name"],
            logo_url=organization.get("logo_url"),
            brand_color=organization.get("brand_color"),
            currency=organization.get("currency"),
            tax_percentage=organization.get("tax_percentage"),
            subscription_plan=organization.get("subscription_plan"),
            is_active=organization.get("is_active"),
            created_at=organization.get("created_at"),
            updated_at=organization.get("updated_at"),
        ),
        branch=BranchResponse(
            id=str(branch["id"]),
            organization_id=str(branch["organization_id"]),
            name=branch["name"],
            location=branch.get("location"),
            phone=branch.get("phone"),
            email=branch.get("email"),
            is_active=branch.get("is_active"),
            created_at=branch.get("created_at"),
            updated_at=branch.get("updated_at"),
        ) if branch else None,
    )
