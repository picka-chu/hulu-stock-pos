"""
Branches Routes
CRUD operations for branches
Admin-only for create, update, delete operations
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import List, Optional
from loguru import logger

from models import BranchCreate, BranchUpdate, BranchResponse
from middleware.auth import get_current_user, require_admin, require_manager
from database import fetch_one, fetch_all, insert_one, update_one, delete_one

router = APIRouter()


@router.get("", response_model=List[BranchResponse])
async def get_branches(
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    active_only: bool = True,   # default: only return active branches (for selectors)
    current_user: dict = Depends(get_current_user)
):
    """Get all branches for organization.
    active_only=true (default): only return is_active=true branches — used for all selectors
    active_only=false: return all branches including inactive — used for admin management page
    """
    try:
        org_id = current_user["organization_id"]

        filters = {"organization_id": org_id}
        branches = await fetch_all("branches", filters)

        if not branches:
            return []

        # Filter by active status
        if active_only:
            branches = [b for b in branches if b.get("is_active") is not False]

        # Apply search filter if provided
        if search:
            branches = [b for b in branches if
                search.lower() in b.get("name", "").lower() or
                search.lower() in b.get("location", "").lower()]

        # Apply pagination
        offset = (page - 1) * page_size
        return branches[offset:offset + page_size] if page_size else branches

    except Exception as e:
        logger.error(f"Error fetching branches: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch branches"
        )


@router.get("/{branch_id}", response_model=BranchResponse)
async def get_branch(branch_id: UUID, current_user: dict = Depends(get_current_user)):
    """Get branch by ID"""
    try:
        branch = await fetch_one(
            "branches",
            {"id": str(branch_id), "organization_id": current_user["organization_id"]}
        )
        
        if not branch:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Branch not found"
            )
        
        return branch
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching branch: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch branch"
        )


@router.post("", response_model=BranchResponse, status_code=status.HTTP_201_CREATED)
async def create_branch(
    branch_data: BranchCreate,
    current_user: dict = Depends(require_admin)  # Changed from require_manager to require_admin
):
    """Create new branch - Admin only"""
    try:
        from uuid import uuid4
        branch_id = str(uuid4())
        
        # Build branch data
        branch_dict = {
            "id": branch_id,
            "organization_id": str(branch_data.organization_id),
            "name": branch_data.name,
            "location": branch_data.location,
            "phone": branch_data.phone,
            "email": branch_data.email,
            "is_active": True
        }
        
        # Insert using REST API
        result = await insert_one("branches", branch_dict)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create branch"
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating branch: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create branch"
        )


@router.put("/{branch_id}", response_model=BranchResponse)
async def update_branch(
    branch_id: UUID,
    branch_data: BranchUpdate,
    current_user: dict = Depends(require_admin)  # Changed from require_manager to require_admin
):
    """Update branch - Admin only"""
    try:
        # Build update data - only include non-None fields
        update_data = {}
        
        if branch_data.name is not None:
            update_data["name"] = branch_data.name
        if branch_data.location is not None:
            update_data["location"] = branch_data.location
        if branch_data.phone is not None:
            update_data["phone"] = branch_data.phone
        if branch_data.email is not None:
            update_data["email"] = branch_data.email
        if branch_data.is_active is not None:
            update_data["is_active"] = branch_data.is_active
        
        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Use proper update method with filters
        filters = {"id": str(branch_id), "organization_id": current_user["organization_id"]}
        result = await update_one("branches", update_data, filters)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Branch not found"
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating branch: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update branch"
        )


@router.delete("/{branch_id}")
async def delete_branch(
    branch_id: UUID,
    current_user: dict = Depends(require_admin)  # Changed from require_manager to require_admin
):
    """Delete branch - Admin only"""
    try:
        # Delete branch using proper delete method
        filters = {"id": str(branch_id), "organization_id": current_user["organization_id"]}
        result = await delete_one("branches", filters)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Branch not found"
            )
        
        return {"message": "Branch deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting branch: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete branch"
        )
