"""
Users Routes - Production Ready
All queries use Supabase client directly (no broken SQL parser).
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID, uuid4
from typing import List, Optional
import asyncio

from models import UserCreate, UserUpdate, UserResponse
from middleware.auth import get_current_user, require_manager, get_password_hash, verify_password
from database import fetch_one, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


@router.get("", response_model=List[UserResponse])
async def get_users(
    page: int = 1,
    page_size: int = 10,
    search: Optional[str] = None,
    role: Optional[str] = None,
    branch_id: Optional[UUID] = None,
    current_user: dict = Depends(get_current_user)
):
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        return []

    q = client.table("users").select(
        "id,organization_id,branch_id,full_name,phone,email,role,is_active,created_at"
    ).eq("organization_id", org_id)

    if role:
        q = q.eq("role", role)

    # Branch isolation: use explicit param or fall back to user's JWT branch
    viewer_role = current_user.get("role", "cashier")
    effective_branch = str(branch_id) if branch_id else current_user.get("branch_id")
    if effective_branch:
        q = q.eq("branch_id", str(effective_branch))
    # admin with no branch = sees all users across org

    resp = await asyncio.to_thread(lambda: q.order("created_at", desc=True).execute())
    users = resp.data or []

    # Python-side search (avoids ILIKE SQL parser issue)
    if search:
        s = search.lower()
        users = [u for u in users if
                 s in (u.get("full_name") or "").lower() or
                 s in (u.get("email") or "").lower()]

    # Paginate
    start = (page - 1) * page_size
    return users[start:start + page_size]


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: UUID, current_user: dict = Depends(get_current_user)):
    user = await fetch_one("users", {"id": str(user_id), "organization_id": current_user["organization_id"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(user_data: UserCreate, current_user: dict = Depends(require_manager)):
    if len(user_data.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    role_value = str(user_data.role).lower().strip()
    if role_value not in ("admin", "manager", "cashier"):
        raise HTTPException(status_code=422, detail=f"Invalid role '{role_value}'")

    if await fetch_one("users", {"email": user_data.email}):
        raise HTTPException(status_code=400, detail="Email already registered")

    user_id = str(uuid4())
    result = await insert_one("users", {
        "id":              user_id,
        "organization_id": str(current_user["organization_id"]),
        "branch_id":       str(user_data.branch_id) if user_data.branch_id else None,
        "full_name":       user_data.full_name,
        "phone":           user_data.phone,
        "email":           user_data.email,
        "password_hash":   get_password_hash(user_data.password),
        "role":            role_value,
        "is_active":       True,
    })
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return result


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(user_id: UUID, user_data: UserUpdate, current_user: dict = Depends(require_manager)):
    # Verify ownership
    existing = await fetch_one("users", {"id": str(user_id), "organization_id": current_user["organization_id"]})
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")

    updates = {}
    if user_data.full_name is not None: updates["full_name"] = user_data.full_name
    if user_data.phone     is not None: updates["phone"]     = user_data.phone
    if user_data.role      is not None: updates["role"]      = user_data.role.value
    if user_data.is_active is not None: updates["is_active"] = user_data.is_active
    if user_data.branch_id is not None: updates["branch_id"] = str(user_data.branch_id) if user_data.branch_id else None

    # Email change: check for duplicates before applying
    if user_data.email is not None and user_data.email != existing.get("email"):
        conflict = await fetch_one("users", {"email": user_data.email})
        if conflict and str(conflict["id"]) != str(user_id):
            raise HTTPException(status_code=400, detail="Email already in use by another account")
        updates["email"] = user_data.email

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = await update_one("users", updates, {"id": str(user_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=500, detail="Update failed")
    return result


@router.put("/{user_id}/password")
async def change_password(
    user_id: UUID,
    body: dict,
    current_user: dict = Depends(get_current_user)
):
    old_password = body.get("old_password", "")
    new_password = body.get("new_password", "")

    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    user = await fetch_one("users", {"id": str(user_id), "organization_id": current_user["organization_id"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(old_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    await update_one("users", {"password_hash": get_password_hash(new_password)}, {"id": str(user_id)})
    return {"message": "Password changed successfully"}


@router.delete("/{user_id}")
async def delete_user(user_id: UUID, current_user: dict = Depends(require_manager)):
    if str(user_id) == str(current_user["id"]):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    result = await delete_one("users", {"id": str(user_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=404, detail="User not found")
    return {"message": "User deleted successfully"}
