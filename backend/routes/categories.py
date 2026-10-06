"""
Categories Routes
CRUD operations for categories
With proper error handling and REST API compatibility
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import List, Optional
from loguru import logger
import asyncio

from models import CategoryCreate, CategoryUpdate, CategoryResponse
from middleware.auth import get_current_user, require_manager
from database import fetch_one, fetch_all, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


@router.get("", response_model=List[CategoryResponse])
async def get_categories(
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all categories for organization, branch-scoped"""
    try:
        org_id = current_user["organization_id"]
        client = await get_supabase_client()
        if not client:
            return []

        # Branch isolation
        effective_branch = branch_id or current_user.get("branch_id")

        q = client.table("categories").select("*").eq("organization_id", org_id)
        if effective_branch:
            # Show categories that belong to this branch OR have no branch (shared)
            for _attempt in range(2):
                try:
                    r_branch, r_shared = await asyncio.gather(
                        asyncio.to_thread(lambda: q.eq("branch_id", str(effective_branch)).execute()),
                        asyncio.to_thread(lambda: client.table("categories").select("*")
                            .eq("organization_id", org_id).is_("branch_id", "null").execute()),
                    )
                    break
                except Exception as _retry_err:
                    if _attempt == 1:
                        raise
                    await asyncio.sleep(0.3)
            categories = (r_branch.data or []) + (r_shared.data or [])
            # Deduplicate
            seen = set()
            deduped = []
            for c in categories:
                if c["id"] not in seen:
                    seen.add(c["id"])
                    deduped.append(c)
            categories = sorted(deduped, key=lambda x: x.get("name","").lower())
        else:
            resp = await asyncio.to_thread(lambda: q.order("name").execute())
            categories = resp.data or []

        if search:
            categories = [c for c in categories if search.lower() in c.get("name", "").lower()]

        return categories[:page_size]
        
    except Exception as e:
        logger.error(f"Error fetching categories: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch categories"
        )


@router.get("/{category_id}", response_model=CategoryResponse)
async def get_category(category_id: UUID, current_user: dict = Depends(get_current_user)):
    """Get category by ID"""
    try:
        category = await fetch_one(
            "categories", 
            {"id": str(category_id), "organization_id": current_user["organization_id"]}
        )
        
        if not category:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Category not found"
            )
        
        return category
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching category: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch category"
        )


@router.post("", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
async def create_category(
    category_data: CategoryCreate,
    current_user: dict = Depends(require_manager)
):
    """Create new category"""
    try:
        from uuid import uuid4
        category_id = str(uuid4())

        if category_data.branch_id:
            from middleware.auth import verify_branch_in_org
            if not await verify_branch_in_org(str(category_data.branch_id), str(current_user["organization_id"])):
                raise HTTPException(status_code=404, detail="Branch not found")
        
        # Build category data - use organization_id from authenticated user for security
        category_dict = {
            "id": category_id,
            "organization_id": str(current_user["organization_id"]),
            "branch_id": str(category_data.branch_id) if category_data.branch_id else None,
            "name": category_data.name,
            "description": category_data.description,
            "color": category_data.color
        }
        
        # Insert using REST API
        result = await insert_one("categories", category_dict)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create category"
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating category: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create category"
        )


@router.put("/{category_id}", response_model=CategoryResponse)
async def update_category(
    category_id: UUID,
    category_data: CategoryUpdate,
    current_user: dict = Depends(require_manager)
):
    """Update category"""
    try:
        # Build update data - only include non-None fields
        update_data = {}
        
        if category_data.name is not None:
            update_data["name"] = category_data.name
        if category_data.description is not None:
            update_data["description"] = category_data.description
        if category_data.color is not None:
            update_data["color"] = category_data.color
        
        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Use proper update method with filters
        filters = {"id": str(category_id), "organization_id": current_user["organization_id"]}
        result = await update_one("categories", update_data, filters)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Category not found"
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating category: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update category"
        )


@router.delete("/{category_id}")
async def delete_category(
    category_id: UUID,
    current_user: dict = Depends(require_manager)
):
    """Delete category"""
    try:
        # Check if category has items
        items_count = await fetch_one(
            "items",
            {"category_id": str(category_id)}
        )
        
        # Also check with query for count
        if items_count:
            # Category has items - check if we can delete
            logger.warning(f"Category {category_id} may have items associated")
        
        # Delete category using proper delete method
        filters = {"id": str(category_id), "organization_id": current_user["organization_id"]}
        result = await delete_one("categories", filters)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Category not found"
            )
        
        return {"message": "Category deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting category: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete category"
        )
