"""
Expenses Routes - Production Ready
All queries use Supabase client directly.
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID, uuid4
from typing import List, Optional
import asyncio

from models import ExpenseCreate, ExpenseUpdate, ExpenseResponse
from middleware.auth import get_current_user, require_manager
from database import fetch_one, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


@router.get("", response_model=List[ExpenseResponse])
async def get_expenses(
    page: int = 1,
    page_size: int = 20,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    expense_type: Optional[str] = None,
    branch_id: Optional[UUID] = None,
    current_user: dict = Depends(get_current_user)
):
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client:
        return []

    q = client.table("expenses").select("*").eq("organization_id", org_id)

    # Branch isolation: explicit param wins, else user's JWT branch, else admin sees all
    viewer_role = current_user.get("role", "cashier")
    branch_filter = str(branch_id) if branch_id else current_user.get("branch_id")
    if branch_filter:
        q = q.eq("branch_id", str(branch_filter))
    # admin with no branch = sees all org expenses
    if expense_type:
        q = q.eq("expense_type", expense_type)
    if start_date:
        q = q.gte("expense_date", start_date)
    if end_date:
        q = q.lte("expense_date", end_date)

    resp = await asyncio.to_thread(lambda: q.order("expense_date", desc=True).execute())
    expenses = resp.data or []

    start = (page - 1) * page_size
    return expenses[start:start + page_size]


@router.get("/{expense_id}", response_model=ExpenseResponse)
async def get_expense(expense_id: UUID, current_user: dict = Depends(get_current_user)):
    expense = await fetch_one("expenses", {"id": str(expense_id), "organization_id": current_user["organization_id"]})
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    return expense


@router.post("", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED)
async def create_expense(expense_data: ExpenseCreate, current_user: dict = Depends(require_manager)):
    from datetime import date as _date
    expense_date = str(expense_data.expense_date) if expense_data.expense_date else str(_date.today())
    result = await insert_one("expenses", {
        "id":              str(uuid4()),
        "organization_id": str(current_user["organization_id"]),
        "branch_id":       str(expense_data.branch_id) if expense_data.branch_id else (str(current_user.get("branch_id")) if current_user.get("branch_id") else None),
        "title":           expense_data.title,
        "description":     expense_data.description,
        "amount":          float(expense_data.amount),
        "expense_type":    expense_data.expense_type.value,
        "expense_date":    expense_date,
        "created_by":      str(current_user["id"]),
        "receipt_url":     expense_data.receipt_url,
    })
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create expense")
    return result


@router.put("/{expense_id}", response_model=ExpenseResponse)
async def update_expense(expense_id: UUID, expense_data: ExpenseUpdate, current_user: dict = Depends(require_manager)):
    existing = await fetch_one("expenses", {"id": str(expense_id), "organization_id": current_user["organization_id"]})
    if not existing:
        raise HTTPException(status_code=404, detail="Expense not found")

    updates = {}
    if expense_data.title        is not None: updates["title"]        = expense_data.title
    if expense_data.description  is not None: updates["description"]  = expense_data.description
    if expense_data.amount       is not None: updates["amount"]       = float(expense_data.amount)
    if expense_data.expense_type is not None: updates["expense_type"] = expense_data.expense_type.value
    if expense_data.expense_date is not None: updates["expense_date"] = str(expense_data.expense_date)
    if expense_data.receipt_url  is not None: updates["receipt_url"]  = expense_data.receipt_url

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = await update_one("expenses", updates, {"id": str(expense_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=500, detail="Update failed")
    return result


@router.delete("/{expense_id}")
async def delete_expense(expense_id: UUID, current_user: dict = Depends(require_manager)):
    result = await delete_one("expenses", {"id": str(expense_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=404, detail="Expense not found")
    return {"message": "Expense deleted successfully"}
