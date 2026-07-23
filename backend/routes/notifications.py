"""
Notifications Routes
FIXED:
- All queries use Supabase client directly (no broken SQL parser)
- mark_all_as_read uses proper update_one approach
- delete_all uses proper Supabase client delete
- Notification creation is reliable via insert_one
"""
from fastapi import APIRouter, HTTPException, status, Depends
from uuid import UUID, uuid4
from typing import List, Optional
from datetime import datetime
import asyncio

from models import NotificationResponse, NotificationCreate, NotificationUpdate, NotificationType
from middleware.auth import get_current_user
from database import fetch_one, insert_one, update_one, delete_one, get_supabase_client

router = APIRouter()


@router.get("", response_model=List[NotificationResponse])
async def get_notifications(
    page: int = 1,
    page_size: int = 50,
    unread_only: bool = False,
    current_user: dict = Depends(get_current_user)
):
    """
    Get notifications with per-user read state.
    - admin:   all broadcasts + own targeted
    - others:  branch-scoped broadcasts + own targeted
    is_read is resolved per-user via notification_reads table for broadcasts.
    """
    from loguru import logger
    org_id      = current_user["organization_id"]
    user_id     = current_user.get("id")
    role        = current_user.get("role", "cashier")
    user_branch = current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return []

    try:
        # ── Fetch per-user read IDs ───────────────────────────────────────────
        rr = await asyncio.to_thread(
            lambda: client.table("notification_reads")
                .select("notification_id")
                .eq("user_id", user_id)
                .execute()
        )
        read_ids = {r["notification_id"] for r in (rr.data or [])}

        # ── Broadcast notifications ───────────────────────────────────────────
        q_broadcast = (
            client.table("notifications")
            .select("*")
            .eq("organization_id", org_id)
            .is_("user_id", "null")
            .order("created_at", desc=True)
            .limit(200)
        )
        resp_b = await asyncio.to_thread(lambda: q_broadcast.execute())
        broadcast_all = resp_b.data or []

        # Branch filter for non-admins
        if role != "admin":
            broadcast_all = [
                n for n in broadcast_all
                if n.get("branch_id") is None or n.get("branch_id") == user_branch
            ]

        # Inject per-user is_read into broadcast rows
        for n in broadcast_all:
            n["is_read"] = n["id"] in read_ids

        # ── Targeted notifications ────────────────────────────────────────────
        q_targeted = (
            client.table("notifications")
            .select("*")
            .eq("organization_id", org_id)
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(200)
        )
        resp_t = await asyncio.to_thread(lambda: q_targeted.execute())
        targeted = resp_t.data or []

        # ── Merge, dedup, sort ────────────────────────────────────────────────
        seen = set()
        all_notifs = []
        for n in broadcast_all + targeted:
            if n["id"] not in seen:
                seen.add(n["id"])
                if unread_only and n.get("is_read"):
                    continue
                all_notifs.append(n)

        all_notifs.sort(key=lambda x: x.get("created_at", ""), reverse=True)

        start = (page - 1) * page_size
        return all_notifs[start:start + page_size]

    except Exception as e:
        logger.error(f"get_notifications error: {e}")
        return []


@router.get("/unread-count")
async def get_unread_count(current_user: dict = Depends(get_current_user)):
    """Per-user unread count using notification_reads table"""
    from loguru import logger
    org_id      = current_user["organization_id"]
    user_id     = current_user.get("id")
    role        = current_user.get("role", "cashier")
    user_branch = current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return {"unread_count": 0}

    try:
        # Read IDs already read by this user
        rr = await asyncio.to_thread(
            lambda: client.table("notification_reads")
                .select("notification_id")
                .eq("user_id", user_id)
                .execute()
        )
        read_ids = {r["notification_id"] for r in (rr.data or [])}

        # Broadcast notifications visible to this user
        q1 = (
            client.table("notifications").select("id, branch_id")
            .eq("organization_id", org_id)
            .is_("user_id", "null")
        )
        resp1 = await asyncio.to_thread(lambda: q1.execute())
        broadcast = resp1.data or []
        # Scope to user's branch or org-wide (branch_id=None) for non-admins
        if role != "admin" and user_branch:
            broadcast = [r for r in broadcast
                         if r.get("branch_id") is None or r.get("branch_id") == user_branch]
        elif role != "admin" and not user_branch:
            # No branch assigned — only show org-wide broadcasts
            broadcast = [r for r in broadcast if r.get("branch_id") is None]
        unread_broadcast = sum(1 for r in broadcast if r["id"] not in read_ids)

        # Targeted unread (still uses is_read column — only for this user anyway)
        q2 = (
            client.table("notifications").select("id")
            .eq("organization_id", org_id)
            .eq("user_id", user_id)
            .eq("is_read", False)
        )
        resp2 = await asyncio.to_thread(lambda: q2.execute())
        unread_targeted = len(resp2.data or [])

        return {"unread_count": unread_broadcast + unread_targeted}

    except Exception as e:
        logger.error(f"unread_count error: {e}")
        return {"unread_count": 0}


@router.post("", response_model=NotificationResponse)
async def create_notification(
    notification: NotificationCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new notification"""
    org_id = current_user["organization_id"]
    notif_id = str(uuid4())
    now = datetime.utcnow().isoformat()

    notification_dict = {
        "id": notif_id,
        "organization_id": org_id,
        "user_id": str(notification.target_user_id) if notification.target_user_id else None,
        "title": notification.title,
        "message": notification.message,
        "notification_type": notification.notification_type.value,
        "is_read": False,
        "related_id": str(notification.related_id) if notification.related_id else None,
        "link": notification.link,
        "created_at": now
    }

    result = await insert_one("notifications", notification_dict)
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create notification")

    return NotificationResponse(**{**notification_dict, "created_at": datetime.fromisoformat(now)})


@router.put("/{notification_id}/read")
async def mark_as_read(
    notification_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Mark a notification as read"""
    org_id  = current_user["organization_id"]
    user_id = current_user.get("id")  # was missing — caused NameError crash

    notification = await fetch_one(
        "notifications", {"id": str(notification_id), "organization_id": org_id}
    )
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    # Per-user read: insert into notification_reads (ignore if already exists)
    client = await get_supabase_client()
    if client:
        try:
            await asyncio.to_thread(
                lambda: client.table("notification_reads").upsert(
                    {"notification_id": str(notification_id), "user_id": str(user_id)},
                    on_conflict="notification_id,user_id"
                ).execute()
            )
        except Exception:
            pass
    # Also update is_read for targeted notifications (only affects this user)
    if notification.get("user_id"):
        await update_one("notifications", {"is_read": True}, {"id": str(notification_id)})
    return {"success": True, "message": "Notification marked as read"}


@router.put("/read-all")
async def mark_all_as_read(current_user: dict = Depends(get_current_user)):
    """
    Mark all notifications as read — per-user only, no effect on other users.
    Uses notification_reads table for broadcasts.
    """
    from loguru import logger
    org_id      = current_user["organization_id"]
    user_id     = current_user.get("id")
    role        = current_user.get("role", "cashier")
    user_branch = current_user.get("branch_id")

    client = await get_supabase_client()
    if not client:
        return {"success": False}

    try:
        # ── Get all broadcast IDs visible to this user ────────────────────────
        q = (client.table("notifications").select("id, branch_id")
             .eq("organization_id", org_id).is_("user_id", "null"))
        resp = await asyncio.to_thread(lambda: q.execute())
        broadcast = resp.data or []
        # Scope to user's branch or org-wide (branch_id=None) for non-admins
        if role != "admin" and user_branch:
            broadcast = [r for r in broadcast
                         if r.get("branch_id") is None or r.get("branch_id") == user_branch]
        elif role != "admin" and not user_branch:
            # No branch assigned — only show org-wide broadcasts
            broadcast = [r for r in broadcast if r.get("branch_id") is None]

        # Bulk-insert into notification_reads (upsert — safe to re-run)
        if broadcast:
            rows = [{"notification_id": r["id"], "user_id": user_id} for r in broadcast]
            # Insert in chunks to stay within Supabase limits
            for i in range(0, len(rows), 100):
                chunk = rows[i:i+100]
                await asyncio.to_thread(
                    lambda c=chunk: client.table("notification_reads")
                        .upsert(c, on_conflict="notification_id,user_id")
                        .execute()
                )

        # ── Mark targeted notifications as read (is_read still used here) ──────
        await asyncio.to_thread(
            lambda: client.table("notifications")
                .update({"is_read": True})
                .eq("organization_id", org_id)
                .eq("user_id", user_id)
                .eq("is_read", False)
                .execute()
        )

        return {"success": True, "message": "All notifications marked as read"}
    except Exception as e:
        logger.error(f"mark_all_as_read error: {e}")
        return {"success": False}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Delete a notification"""
    org_id = current_user["organization_id"]

    notification = await fetch_one(
        "notifications", {"id": str(notification_id), "organization_id": org_id}
    )
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    await delete_one("notifications", {"id": str(notification_id)})
    return {"success": True, "message": "Notification deleted"}


@router.delete("")
async def delete_all_notifications(current_user: dict = Depends(get_current_user)):
    """Delete all notifications for current user"""
    from loguru import logger
    org_id = current_user["organization_id"]
    user_id = current_user.get("id")

    client = await get_supabase_client()
    if not client:
        return {"success": False}

    try:
        # Only delete this user's own targeted notifications (not org-wide broadcasts)
        # Broadcast deletion is admin-only to prevent data loss for other users
        await asyncio.to_thread(
            lambda: client.table("notifications")
                .delete()
                .eq("organization_id", org_id)
                .eq("user_id", user_id)
                .execute()
        )
        # Also clear this user's read records so the badge resets
        await asyncio.to_thread(
            lambda: client.table("notification_reads")
                .delete()
                .eq("user_id", user_id)
                .execute()
        )
        return {"success": True, "message": "Your notifications cleared"}
    except Exception as e:
        logger.error(f"delete_all_notifications error: {e}")
        return {"success": False}


# ─── Shared helper: fire a notification after a sale ─────────────────────────

async def fire_sale_notification(
    org_id: str, sale_id: str, net_amount: float,
    sold_by: str, branch_name: str = "", branch_id: str = None
):
    """
    Broadcast notification for a completed sale.
    branch_id stored so cashiers/managers only see their branch's sales.
    Admins see all. Title prefixed with branch name when multi-branch.
    """
    from loguru import logger
    try:
        currency_symbol = "Br"
        # Title: always includes branch name so admin sees at a glance which branch
        branch_prefix = f"[{branch_name}] " if branch_name else ""
        title   = f"💰 {branch_prefix}New Sale"
        message = f"{sold_by} completed a sale of {currency_symbol}{net_amount:,.2f}"

        notif_dict = {
            "id":                str(uuid4()),
            "organization_id":   org_id,
            "user_id":           None,        # broadcast
            "branch_id":         branch_id,   # branch filter for cashier/manager
            "title":             title,
            "message":           message,
            "notification_type": NotificationType.NEW_SALE.value,
            "is_read":           False,
            "related_id":        sale_id,
            "link":              "/sales",
            "created_at":        datetime.utcnow().isoformat(),
        }
        await insert_one("notifications", notif_dict)
        logger.info(f"[NOTIF] Sale notification created for sale {sale_id} (branch: {branch_name})")

        # ── Web Push — send to branch users + admins ──────────────────────────
        try:
            from .push import send_push_to_org
            asyncio.create_task(send_push_to_org(
                org_id=org_id,
                title=title,
                body=message,
                tag="xpos-sale",
                url="/sales",
                branch_id=branch_id,
            ))
        except Exception as _pe:
            logger.warning(f"[PUSH] Sale push failed: {_pe}")

    except Exception as e:
        logger.error(f"[NOTIF] Failed to create sale notification: {e}")


async def fire_low_stock_notification(
    org_id: str, item_id: str, item_name: str,
    quantity: int, min_stock: int,
    branch_name: str = "", branch_id: str = None
):
    """
    Broadcast low-stock notification scoped to a branch.
    Cashier/manager only see alerts for their branch. Admin sees all.
    """
    from loguru import logger
    try:
        branch_prefix = f"[{branch_name}] " if branch_name else ""
        title   = f"⚠️ {branch_prefix}Low Stock Alert"
        message = f"{item_name} is running low — only {quantity} left (min: {min_stock})"

        notif_dict = {
            "id":                str(uuid4()),
            "organization_id":   org_id,
            "user_id":           None,
            "branch_id":         branch_id,
            "title":             title,
            "message":           message,
            "notification_type": NotificationType.LOW_STOCK.value,
            "is_read":           False,
            "related_id":        item_id,
            "link":              "/items",
            "created_at":        datetime.utcnow().isoformat(),
        }
        await insert_one("notifications", notif_dict)
        logger.info(f"[NOTIF] Low stock notification for item {item_id} (branch: {branch_name})")

        # ── Web Push ──────────────────────────────────────────────────────────
        try:
            from .push import send_push_to_org
            asyncio.create_task(send_push_to_org(
                org_id=org_id,
                title=title,
                body=message,
                tag=f"xpos-stock-{item_id}",
                url="/items",
                branch_id=branch_id,
            ))
        except Exception as _pe:
            logger.warning(f"[PUSH] Low stock push failed: {_pe}")

    except Exception as e:
        logger.error(f"[NOTIF] Failed to create low-stock notification: {e}")
