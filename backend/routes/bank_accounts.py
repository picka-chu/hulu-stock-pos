"""
Bank Accounts Routes
Branch-aware: each bank account belongs to a branch.
- cashier: sees only their branch's accounts
- manager/admin with branch selected: sees that branch's accounts
- admin with no branch (All Branches): sees all org accounts
"""
from fastapi import APIRouter, HTTPException, status, Depends
from datetime import datetime
from uuid import UUID, uuid4
from typing import List, Optional
import asyncio

from models import BankAccountCreate, BankAccountUpdate, BankAccountResponse, CashTransferCreate, CashTransferResponse
from middleware.auth import get_current_user, require_manager
from database import fetch_one, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


def _resolve_branch(current_user: dict, requested_branch_id: Optional[str] = None) -> Optional[str]:
    """
    Return the branch_id to filter by, or None (= all branches for admin).
    - cashier: always their own branch (cannot override)
    - manager/admin: requested_branch_id if provided, else their JWT branch
    - admin with no branch and no param: None → see everything
    """
    role = current_user.get("role", "cashier")
    user_branch = current_user.get("branch_id")

    if role == "cashier":
        return user_branch  # cashiers always see only their branch

    # manager or admin
    if requested_branch_id and requested_branch_id not in ("", "undefined", "null"):
        return requested_branch_id
    if user_branch:
        return user_branch
    return None  # admin with All Branches selected


@router.get("", response_model=List[BankAccountResponse])
async def get_bank_accounts(
    branch_id: Optional[str] = None,
    account_type: Optional[str] = None,   # "bank" | "mobile_money" | None = all
    current_user: dict = Depends(get_current_user)
):
    org_id = current_user["organization_id"]
    effective_branch = _resolve_branch(current_user, branch_id)

    client = await get_supabase_client()
    if not client:
        return []

    q = client.table("bank_accounts").select("*").eq("organization_id", org_id).eq("is_active", True)
    if effective_branch:
        q = q.eq("branch_id", str(effective_branch))
    if account_type and account_type in ("bank", "mobile_money"):
        q = q.eq("account_type", account_type)

    resp = await asyncio.to_thread(lambda: q.order("account_name").execute())
    return resp.data or []


@router.get("/{account_id}", response_model=BankAccountResponse)
async def get_bank_account(account_id: UUID, current_user: dict = Depends(get_current_user)):
    account = await fetch_one("bank_accounts", {"id": str(account_id), "organization_id": current_user["organization_id"]})
    if not account:
        raise HTTPException(status_code=404, detail="Bank account not found")
    # Branch access check
    effective = _resolve_branch(current_user)
    if effective and account.get("branch_id") and str(account["branch_id"]) != str(effective):
        raise HTTPException(status_code=403, detail="Access denied — not your branch's account")
    return account


@router.post("", response_model=BankAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_bank_account(account_data: BankAccountCreate, current_user: dict = Depends(require_manager)):
    # Default branch_id to user's branch if not specified
    branch_id = str(account_data.branch_id) if account_data.branch_id else current_user.get("branch_id")
    if branch_id:
        from middleware.auth import verify_branch_in_org
        if not await verify_branch_in_org(str(branch_id), str(current_user["organization_id"])):
            raise HTTPException(status_code=404, detail="Branch not found")
    acct_type = (account_data.account_type or "bank").strip().lower()
    if acct_type not in ("bank", "mobile_money"):
        acct_type = "bank"
    result = await insert_one("bank_accounts", {
        "id":              str(uuid4()),
        "organization_id": str(current_user["organization_id"]),
        "branch_id":       branch_id,
        "account_name":    account_data.account_name,
        "account_number":  account_data.account_number,
        "bank_name":       account_data.bank_name,
        "balance":         float(account_data.balance),
        "account_type":    acct_type,
        "is_active":       True,
    })
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create bank account")
    return result


@router.put("/{account_id}", response_model=BankAccountResponse)
async def update_bank_account(account_id: UUID, account_data: BankAccountUpdate, current_user: dict = Depends(require_manager)):
    existing = await fetch_one("bank_accounts", {"id": str(account_id), "organization_id": current_user["organization_id"]})
    if not existing:
        raise HTTPException(status_code=404, detail="Bank account not found")
    updates = {}
    if account_data.account_name   is not None: updates["account_name"]   = account_data.account_name
    if account_data.account_number is not None: updates["account_number"] = account_data.account_number
    if account_data.bank_name      is not None: updates["bank_name"]      = account_data.bank_name
    if account_data.balance        is not None: updates["balance"]        = float(account_data.balance)
    if account_data.account_type   is not None: updates["account_type"]   = account_data.account_type
    if account_data.is_active      is not None: updates["is_active"]      = account_data.is_active
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = await update_one("bank_accounts", updates, {"id": str(account_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=500, detail="Update failed")
    return result


@router.delete("/{account_id}")
async def delete_bank_account(account_id: UUID, current_user: dict = Depends(require_manager)):
    result = await update_one("bank_accounts", {"is_active": False}, {"id": str(account_id), "organization_id": current_user["organization_id"]})
    if not result:
        raise HTTPException(status_code=404, detail="Bank account not found")
    return {"message": "Bank account deactivated"}


# ── Cash Transfers ────────────────────────────────────────────────────────────
@router.post("/transfer", response_model=CashTransferResponse, status_code=status.HTTP_201_CREATED)
async def create_cash_transfer(transfer_data: CashTransferCreate, current_user: dict = Depends(require_manager)):
    branch_id = str(transfer_data.branch_id) if transfer_data.branch_id else current_user.get("branch_id")
    if branch_id:
        from middleware.auth import verify_branch_in_org as _verify_branch
        if not await _verify_branch(str(branch_id), str(current_user["organization_id"])):
            raise HTTPException(status_code=404, detail="Branch not found")
    ref = f"TRF-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    result = await insert_one("cash_transfers", {
        "id":               str(uuid4()),
        "organization_id":  str(current_user["organization_id"]),
        "branch_id":        branch_id,
        "type":             transfer_data.type.value,
        "amount":           float(transfer_data.amount),
        "bank_account_id":  str(transfer_data.bank_account_id) if transfer_data.bank_account_id else None,
        "reference_number": ref,
        "status":           "completed",
        "created_by":       str(current_user["id"]),
        "notes":            transfer_data.notes,
    })
    if transfer_data.bank_account_id:
        account = await fetch_one("bank_accounts", {"id": str(transfer_data.bank_account_id), "organization_id": str(current_user["organization_id"])})
        if not account:
            raise HTTPException(status_code=404, detail="Bank account not found")
        current_bal = float(account.get("balance", 0))
        if transfer_data.type.value == "cash_to_bank":
            new_bal = current_bal + float(transfer_data.amount)
        elif transfer_data.type.value == "bank_to_cash":
            new_bal = current_bal - float(transfer_data.amount)
            if new_bal < 0:
                raise HTTPException(status_code=400, detail="Insufficient bank balance for this withdrawal")
        else:
            new_bal = current_bal  # other transfer types don't change bank balance
        await update_one("bank_accounts", {"balance": new_bal}, {"id": str(transfer_data.bank_account_id), "organization_id": str(current_user["organization_id"])})
    return result


@router.get("/transfers", response_model=List[CashTransferResponse])
async def get_cash_transfers(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    transfer_status: Optional[str] = None,
    branch_id: Optional[str] = None,
    current_user: dict = Depends(require_manager)
):
    org_id = current_user["organization_id"]
    effective_branch = _resolve_branch(current_user, branch_id)
    client = await get_supabase_client()
    if not client:
        return []
    q = client.table("cash_transfers").select("*").eq("organization_id", org_id)
    if effective_branch:
        q = q.eq("branch_id", str(effective_branch))
    if start_date:      q = q.gte("created_at", start_date)
    if end_date:        q = q.lte("created_at", end_date)
    if transfer_status: q = q.eq("status", transfer_status)
    resp = await asyncio.to_thread(lambda: q.order("created_at", desc=True).execute())
    return resp.data or []
