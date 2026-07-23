"""
Organization Routes
CRUD operations for organizations
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID
from typing import List, Optional

from models import OrganizationCreate, OrganizationUpdate, OrganizationResponse
from middleware.auth import get_current_user, require_admin
from database import fetch_one, fetch_all, insert_one, update_one, delete_one

router = APIRouter()

@router.get("", response_model=List[OrganizationResponse])
async def get_organizations(
    page: int = 1,
    page_size: int = 10,
    search: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get organizations - admins see only their own org for security"""
    # For security, non-superadmins can only see their own organization
    org_id = current_user.get("organization_id")
    if not org_id:
        return []

    # Super-admin can see all (only allow if explicitly marked)
    # Otherwise restrict to own org
    organization = await fetch_one("organizations", {"id": str(org_id)})
    return [organization] if organization else []


@router.get("/current", response_model=OrganizationResponse)
async def get_current_organization(current_user: dict = Depends(get_current_user)):
    """Get the current user's organization"""
    org_id = current_user.get("organization_id")
    if not org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No organization associated with user"
        )
    organization = await fetch_one("organizations", {"id": org_id})
    if not organization:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )
    return organization


@router.put("/current", response_model=OrganizationResponse)
async def update_current_organization(
    org_data: OrganizationUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update the current user's organization settings"""
    org_id = current_user.get("organization_id")
    if not org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No organization associated with user"
        )

    # Only admin can update organization settings
    if current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can update organization settings"
        )

    update_data = {}
    if org_data.name is not None:
        update_data["name"] = org_data.name
    if org_data.logo_url is not None:
        update_data["logo_url"] = org_data.logo_url
    if org_data.brand_color is not None:
        update_data["brand_color"] = org_data.brand_color
    if org_data.currency is not None:
        update_data["currency"] = org_data.currency
    if org_data.tax_percentage is not None:
        update_data["tax_percentage"] = org_data.tax_percentage
    if org_data.is_active is not None:
        update_data["is_active"] = org_data.is_active

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )

    result = await update_one("organizations", update_data, {"id": str(org_id)})
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )
    return result


@router.post("", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED)
async def create_organization(
    org_data: OrganizationCreate,
    current_user: dict = Depends(require_admin)
):
    """Create new organization"""
    from uuid import uuid4
    org_id = str(uuid4())
    
    # Build organization data
    org_dict = {
        "id": org_id,
        "name": org_data.name,
        "logo_url": org_data.logo_url,
        "brand_color": org_data.brand_color,
        "currency": org_data.currency,
        "tax_percentage": float(org_data.tax_percentage),
        "subscription_plan": "basic",
        "is_active": True
    }
    
    # Insert using REST API
    result = await insert_one("organizations", org_dict)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create organization"
        )
    
    return result

@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    org_id: UUID,
    org_data: OrganizationUpdate,
    current_user: dict = Depends(require_admin)
):
    """Update organization"""
    # Update using proper update method
    update_data = {}
    
    if org_data.name is not None:
        update_data["name"] = org_data.name
    if org_data.logo_url is not None:
        update_data["logo_url"] = org_data.logo_url
    if org_data.brand_color is not None:
        update_data["brand_color"] = org_data.brand_color
    if org_data.currency is not None:
        update_data["currency"] = org_data.currency
    if org_data.tax_percentage is not None:
        update_data["tax_percentage"] = org_data.tax_percentage
    if org_data.is_active is not None:
        update_data["is_active"] = org_data.is_active
    
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )
    
    filters = {"id": str(org_id)}
    result = await update_one("organizations", update_data, filters)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )
    
    return result

@router.delete("/{org_id}")
async def delete_organization(
    org_id: UUID,
    current_user: dict = Depends(require_admin)
):
    """Delete organization — admin can only delete their own org"""
    if str(org_id) != str(current_user["organization_id"]):
        raise HTTPException(status_code=403, detail="Cannot delete another organization")
    filters = {"id": str(org_id)}
    result = await delete_one("organizations", filters)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )
    
    return {"message": "Organization deleted successfully"}
