"""
Web Push Notification Routes
Implements VAPID-based Web Push so notifications reach the device
even when the app tab is in the background or closed.

Flow:
  1. GET  /api/push/vapid-public-key   → browser fetches public key
  2. POST /api/push/subscribe          → browser sends its PushSubscription object
  3. Backend stores subscription in push_subscriptions table
  4. POST /api/push/send (internal)    → sends push to all subs for an org
  5. Subscriptions auto-expire/clean on 410 Gone responses
"""
import os
import json
import asyncio
import logging
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel

from middleware.auth import get_current_user
from database import get_supabase_client

logger = logging.getLogger("push")
router = APIRouter()

# ── VAPID keys ────────────────────────────────────────────────────────────────
_VAPID_PUBLIC  = os.getenv("VAPID_PUBLIC_KEY", "").strip()
_VAPID_PRIVATE = os.getenv("VAPID_PRIVATE_KEY", "").strip()
_VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@xpos.app")


def _normalize_vapid_private_key(raw: str) -> str:
    """
    Convert ANY VAPID private key format into raw urlsafe-base64 of the
    32-byte EC scalar — the only format pywebpush reliably accepts.

    Handles:
      A) Raw 32-byte urlsafe-base64 (correct already)
      B) PEM  -----BEGIN EC PRIVATE KEY-----  (SEC1)
      C) PEM  -----BEGIN PRIVATE KEY-----     (PKCS8)
      D) base64url-encoded PEM text
      E) DER bytes in base64url (SEC1 or PKCS8)
      F) Hex string (64 hex chars = 32 bytes)
    """
    import base64
    from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey
    from cryptography.hazmat.primitives.serialization import (
        load_pem_private_key, load_der_private_key,
    )

    key = raw.strip()

    def _ec_to_raw_b64(priv) -> str:
        n = priv.private_numbers().private_value
        return base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()

    def _try_pem(data: bytes):
        try:
            priv = load_pem_private_key(data, password=None)
            if isinstance(priv, EllipticCurvePrivateKey):
                return _ec_to_raw_b64(priv)
        except Exception:
            pass
        return None

    def _try_der(data: bytes):
        try:
            priv = load_der_private_key(data, password=None)
            if isinstance(priv, EllipticCurvePrivateKey):
                return _ec_to_raw_b64(priv)
        except Exception:
            pass
        return None

    # B/C: PEM string
    if key.startswith("-----"):
        result = _try_pem(key.encode())
        if result:
            logger.info("[Push] Private key: decoded from PEM")
            return result
        raise ValueError("PEM string could not be parsed as EC key")

    # F: Hex (64 chars)
    if len(key) == 64:
        try:
            raw_bytes = bytes.fromhex(key)
            logger.info("[Push] Private key: decoded from hex")
            return base64.urlsafe_b64encode(raw_bytes).rstrip(b"=").decode()
        except Exception:
            pass

    # Try both urlsafe and standard base64
    for b64 in [key, key.replace("-", "+").replace("_", "/")]:
        padded = b64 + "=" * ((4 - len(b64) % 4) % 4)
        try:
            decoded = base64.b64decode(padded)
        except Exception:
            continue

        # A: Raw 32-byte scalar
        if len(decoded) == 32:
            logger.info("[Push] Private key: raw 32-byte scalar")
            return base64.urlsafe_b64encode(decoded).rstrip(b"=").decode()

        # D: base64url of PEM
        if decoded.startswith(b"-----"):
            result = _try_pem(decoded)
            if result:
                logger.info("[Push] Private key: base64-encoded PEM")
                return result

        # E: DER
        result = _try_der(decoded)
        if result:
            logger.info("[Push] Private key: DER bytes")
            return result

    raise ValueError(
        f"Cannot decode VAPID private key (len={len(key)}). "
        "Regenerate using: python3 -c \"from py_vapid import Vapid; v=Vapid(); v.generate_keys(); print(v.private_key)\"  "
        "or see TROUBLESHOOTING.md"
    )


def _normalize_vapid_public_key(raw: str) -> str:
    """Normalize public key to urlsafe-b64 of 65-byte uncompressed EC point."""
    import base64
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PublicFormat, load_der_public_key,
    )
    key = raw.strip()
    for b64 in [key, key.replace("-", "+").replace("_", "/")]:
        padded = b64 + "=" * ((4 - len(b64) % 4) % 4)
        try:
            decoded = base64.b64decode(padded)
        except Exception:
            continue
        if len(decoded) == 65 and decoded[0] == 0x04:
            return base64.urlsafe_b64encode(decoded).rstrip(b"=").decode()
        try:
            pub = load_der_public_key(decoded)
            point = pub.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
            return base64.urlsafe_b64encode(point).rstrip(b"=").decode()
        except Exception:
            pass
    return key


# ── Normalize keys once at startup ───────────────────────────────────────────
if _VAPID_PRIVATE:
    try:
        _VAPID_PRIVATE = _normalize_vapid_private_key(_VAPID_PRIVATE)
        logger.info(f"[Push] VAPID private key ready — len={len(_VAPID_PRIVATE)}")
    except Exception as e:
        logger.error(f"[Push] VAPID private key FAILED: {e}")
        logger.error("[Push] Regenerate keys — see TROUBLESHOOTING.md")
        _VAPID_PRIVATE = ""

if _VAPID_PUBLIC:
    try:
        _VAPID_PUBLIC = _normalize_vapid_public_key(_VAPID_PUBLIC)
        logger.info(f"[Push] VAPID public key ready — len={len(_VAPID_PUBLIC)}")
    except Exception as e:
        logger.error(f"[Push] VAPID public key FAILED: {e}")
        _VAPID_PUBLIC = ""

if not _VAPID_PUBLIC or not _VAPID_PRIVATE:
    logger.warning("[Push] VAPID keys not set or invalid — Web Push disabled")


class PushSubscriptionBody(BaseModel):
    subscription: dict   # Full PushSubscription JSON from browser
    user_agent: Optional[str] = None


class PushPayload(BaseModel):
    title: str
    body: str
    icon: Optional[str] = "/favicon.ico"
    badge: Optional[str] = "/favicon.ico"
    tag: Optional[str] = "xpos"
    url: Optional[str] = "/"
    org_id: str
    notification_type: Optional[str] = "info"


# ── VAPID public key endpoint ─────────────────────────────────────────────────
@router.get("/vapid-public-key")
async def get_vapid_public_key():
    if not _VAPID_PUBLIC:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    return {"publicKey": _VAPID_PUBLIC}


# ── Subscribe ─────────────────────────────────────────────────────────────────
@router.post("/subscribe")
async def subscribe(body: PushSubscriptionBody, current_user: dict = Depends(get_current_user)):
    if not _VAPID_PUBLIC:
        raise HTTPException(status_code=503, detail="Push notifications not configured")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    endpoint = body.subscription.get("endpoint", "")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Missing endpoint")

    org_id  = current_user["organization_id"]
    user_id = current_user["id"]

    sub_data = {
        "organization_id": org_id,
        "user_id":         user_id,
        "endpoint":        endpoint,
        "subscription":    json.dumps(body.subscription),
        "user_agent":      body.user_agent or "",
        "created_at":      datetime.utcnow().isoformat(),
    }

    try:
        # Upsert by endpoint (one row per device/browser)
        await asyncio.to_thread(
            lambda: client.table("push_subscriptions")
                .upsert(sub_data, on_conflict="endpoint")
                .execute()
        )
        logger.info(f"Push subscription saved for user {user_id}")
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to save push subscription: {e}")
        raise HTTPException(status_code=500, detail="Failed to save subscription")


# ── Unsubscribe ───────────────────────────────────────────────────────────────
@router.post("/unsubscribe")
async def unsubscribe(body: dict, current_user: dict = Depends(get_current_user)):
    endpoint = body.get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Missing endpoint")

    client = await get_supabase_client()
    if not client:
        return {"ok": True}

    try:
        await asyncio.to_thread(
            lambda: client.table("push_subscriptions").delete().eq("endpoint", endpoint).execute()
        )
    except Exception as e:
        logger.warning(f"Unsubscribe error: {e}")

    return {"ok": True}


# ── Internal: send push to all subscribers of an org ─────────────────────────
async def send_push_to_org(
    org_id: str,
    title: str,
    body: str,
    tag: str = "xpos",
    url: str = "/",
    icon: str = "/favicon.ico",
    user_id: Optional[str] = None,    # if set, only send to this specific user
    branch_id: Optional[str] = None,  # if set, send to this branch + all admins
):
    """
    Send Web Push to subscribed devices.
    - If branch_id is set: send to users of that branch AND org admins.
    - If branch_id is None: send to everyone (global alert).
    - If user_id is set: send only to that one user (overrides branch logic).
    """
    if not _VAPID_PUBLIC or not _VAPID_PRIVATE:
        return

    client = await get_supabase_client()
    if not client:
        return

    try:
        if user_id:
            # Targeted: single user only
            q = (client.table("push_subscriptions")
                 .select("endpoint, subscription, user_id")
                 .eq("organization_id", org_id)
                 .eq("user_id", user_id))
            resp = await asyncio.to_thread(lambda: q.execute())
            subscriptions = resp.data or []

        elif branch_id:
            # Branch-scoped: fetch all subscriptions with user info
            # Then keep only: users on that branch OR admins (role = 'admin')
            q = (client.table("push_subscriptions")
                 .select("endpoint, subscription, user_id")
                 .eq("organization_id", org_id))
            resp = await asyncio.to_thread(lambda: q.execute())
            all_subs = resp.data or []

            # Fetch user roles and branch assignments for those user ids
            user_ids = list({s["user_id"] for s in all_subs if s.get("user_id")})
            if not user_ids:
                return

            # Fetch users in chunks of 50
            user_map = {}
            chunk_size = 50
            for i in range(0, len(user_ids), chunk_size):
                chunk = user_ids[i:i+chunk_size]
                ur = await asyncio.to_thread(
                    lambda c=chunk: client.table("users")
                        .select("id, role, branch_id")
                        .in_("id", c)
                        .execute()
                )
                for u in (ur.data or []):
                    user_map[u["id"]] = u

            # Filter: admin gets all, others only their branch
            subscriptions = [
                s for s in all_subs
                if s.get("user_id") and (
                    user_map.get(s["user_id"], {}).get("role") == "admin" or
                    user_map.get(s["user_id"], {}).get("branch_id") == branch_id
                )
            ]
        else:
            # Global: all subscriptions for this org
            q = (client.table("push_subscriptions")
                 .select("endpoint, subscription")
                 .eq("organization_id", org_id))
            resp = await asyncio.to_thread(lambda: q.execute())
            subscriptions = resp.data or []

    except Exception as e:
        logger.error(f"Failed to fetch push subscriptions: {e}")
        return

    if not subscriptions:
        return

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        logger.warning("[Push] pywebpush not installed — skipping push notification")
        return

    payload = json.dumps({
        "title": title,
        "body":  body,
        "icon":  icon,
        "badge": "/favicon.ico",
        "tag":   tag,
        "data":  {"url": url},
        "vibrate": [100, 50, 100],
    })

    stale_endpoints = []
    for sub_row in subscriptions:
        try:
            sub = json.loads(sub_row["subscription"])
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=_VAPID_PRIVATE,
                vapid_claims={"sub": _VAPID_SUBJECT},
                ttl=86400,
                content_encoding="aesgcm",
                headers={"Content-Type": "application/json"},
            )
            logger.info(f"[Push] ✅ Sent to {sub_row['endpoint'][:50]}")
        except WebPushException as e:
            resp_status = e.response.status_code if e.response else None
            resp_body   = e.response.text[:400] if e.response else str(e)
            if resp_status in (404, 410):
                stale_endpoints.append(sub_row["endpoint"])
                logger.info(f"[Push] Stale subscription removed: {resp_status}")
            else:
                logger.error(f"[Push] WebPushException status={resp_status} body={resp_body}")
        except Exception as e:
            logger.error(f"[Push] Send error {type(e).__name__}: {e}", exc_info=True)

    # Clean up stale subscriptions
    if stale_endpoints:
        try:
            for ep in stale_endpoints:
                await asyncio.to_thread(
                    lambda ep=ep: client.table("push_subscriptions").delete().eq("endpoint", ep).execute()
                )
            logger.info(f"Removed {len(stale_endpoints)} stale push subscriptions")
        except Exception as e:
            logger.warning(f"Failed to clean stale subscriptions: {e}")


# ── Debug endpoint — diagnose push configuration ─────────────────────────────
@router.get("/debug")
async def push_debug(current_user: dict = Depends(get_current_user)):
    """Diagnose push notification setup. Only for admins."""
    import base64
    info = {
        "vapid_public_set":  bool(_VAPID_PUBLIC),
        "vapid_private_set": bool(_VAPID_PRIVATE),
        "vapid_subject":     _VAPID_SUBJECT,
        "public_key_len":    len(_VAPID_PUBLIC) if _VAPID_PUBLIC else 0,
        "private_key_len":   len(_VAPID_PRIVATE) if _VAPID_PRIVATE else 0,
        "private_key_format": "raw_b64" if (_VAPID_PRIVATE and not _VAPID_PRIVATE.startswith("-----")) else "pem",
    }
    client = await get_supabase_client()
    if client:
        try:
            resp = await asyncio.to_thread(
                lambda: client.table("push_subscriptions")
                    .select("id, user_id, endpoint", count="exact")
                    .eq("organization_id", current_user["organization_id"])
                    .execute()
            )
            info["subscriptions_in_org"] = resp.count or len(resp.data or [])
            info["user_subscriptions"] = sum(
                1 for r in (resp.data or []) if r.get("user_id") == current_user["id"]
            )
        except Exception as e:
            info["db_error"] = str(e)
    return info


# ── Check push status for current user ───────────────────────────────────────
@router.get("/status")
async def push_status(current_user: dict = Depends(get_current_user)):
    if not _VAPID_PUBLIC:
        return {"configured": False, "reason": "VAPID keys not set"}

    client = await get_supabase_client()
    if not client:
        return {"configured": True, "subscribed": False}

    try:
        resp = await asyncio.to_thread(
            lambda: client.table("push_subscriptions")
                .select("endpoint")
                .eq("user_id", current_user["id"])
                .execute()
        )
        count = len(resp.data or [])
        return {"configured": True, "subscribed": count > 0, "devices": count}
    except Exception:
        return {"configured": True, "subscribed": False, "devices": 0}


# ── Test endpoint — sends a real push to the calling user's devices ──────────
@router.post("/test")
async def test_push(current_user: dict = Depends(get_current_user)):
    """Send a test push notification to the logged-in user's subscribed devices."""
    if not _VAPID_PUBLIC or not _VAPID_PRIVATE:
        raise HTTPException(status_code=503, detail="VAPID keys not configured on server")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    user_id = current_user["id"]

    # Check subscriptions exist
    resp = await asyncio.to_thread(
        lambda: client.table("push_subscriptions")
            .select("endpoint, subscription")
            .eq("user_id", user_id)
            .execute()
    )
    subs = resp.data or []
    if not subs:
        raise HTTPException(status_code=404, detail="No push subscriptions found for this user. Allow notifications in the browser first.")

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        raise HTTPException(503, "Push notifications unavailable — pywebpush not installed")

    payload = json.dumps({
        "title": "🔔 Hulu Stock Push Test",
        "body":  "Push notifications are working on this device!",
        "tag":   "xpos-test",
        "data":  {"url": "/"},
        "vibrate": [200, 100, 200],
    })

    results = []
    for sub_row in subs:
        try:
            sub = json.loads(sub_row["subscription"])
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=_VAPID_PRIVATE,
                vapid_claims={"sub": _VAPID_SUBJECT},
                ttl=86400,
                content_encoding="aesgcm",
                headers={"Content-Type": "application/json"},
            )
            results.append({"endpoint": sub_row["endpoint"][:40] + "...", "status": "sent"})
            logger.info(f"[Push] ✅ Test sent to {sub_row['endpoint'][:60]}")
        except WebPushException as e:
            status = e.response.status_code if e.response else None
            body = e.response.text[:400] if e.response else str(e)
            results.append({"endpoint": sub_row["endpoint"][:40] + "...", "status": f"failed:{status}", "detail": body})
            logger.error(f"[Push] Test WebPushException status={status} body={body}")
        except Exception as e:
            results.append({"endpoint": sub_row["endpoint"][:40] + "...", "status": f"error:{type(e).__name__}", "detail": str(e)})
            logger.error(f"[Push] Test error {type(e).__name__}: {e}", exc_info=True)

    sent = sum(1 for r in results if r["status"] == "sent")
    return {"sent": sent, "total": len(results), "results": results}
