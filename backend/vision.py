"""
Vision / AI Routes  v11.0  —  Gemini 2.5 Flash  +  Google Search Grounding
══════════════════════════════════════════════════════════════════════════════

NEW FLOW:
  POST /api/vision/scan
    Receives: barcode (str), expiry_image (b64 JPEG)
    1. Sends barcode + expiry image to Gemini 2.5 Flash
    2. Gemini uses Google Search grounding to look up the product by barcode
    3. Gemini extracts expiry date from the image
    4. Returns full product data including a specific subcategory suggestion
    5. Backend checks/creates category, upserts global catalog
    6. Returns structured product data
══════════════════════════════════════════════════════════════════════════════
"""

import os, re, json, base64, logging, asyncio, time
from datetime import datetime, date
from typing import Optional, List
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from middleware.auth import get_current_user
from database import get_supabase_client
from .gemini_pool import get_active_key as _get_active_key, rotate_after_429, key_count as _key_count

logger         = logging.getLogger("vision")
router         = APIRouter()
AI_DAILY_LIMIT = int(os.getenv("AI_DAILY_LIMIT", "500"))
GEMINI_TIMEOUT = 60

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta/models"

# ── Pydantic models ────────────────────────────────────────────────────────────

class CategoryRef(BaseModel):
    id:   str
    name: str

class ScanRequest(BaseModel):
    barcode:      Optional[str] = None
    expiry_image: Optional[str] = None
    categories:   List[CategoryRef] = []
    branch_id:    Optional[str] = None   # FIX: branch isolation for category creation

class CategoryCreateRequest(BaseModel):
    name:        str
    description: Optional[str] = None
    color:       Optional[str] = None
    branch_id:   Optional[str] = None   # branch to create this category in

class TemplateApplyRequest(BaseModel):
    branch_id: Optional[str] = None   # branch to create template categories in


# ── Gemini helpers ─────────────────────────────────────────────────────────────

def _img_part(b64: str, mime: str = "image/jpeg") -> dict:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return {"inlineData": {"mimeType": mime, "data": b64}}


def _build_prompt(barcode: Optional[str], categories: List[CategoryRef]) -> str:
    cat_list = "\n".join(f"  - id:{c.id}  name:{c.name}" for c in categories) \
               if categories else "  (none yet — suggest a new one)"
    barcode_line = f"Product barcode/EAN/UPC: **{barcode}**" if barcode else "No barcode provided."

    return f"""You are a retail product data expert with access to Google Search.

{barcode_line}

INSTRUCTIONS:
1. Use Google Search to look up this barcode and identify the product name, brand, and a short description.
2. Extract the expiry / best-before date from IMAGE 1 (if provided).
3. Suggest the most SPECIFIC product subcategory (e.g. "Oral Care" not "Personal Care", "Pain Relief" not "Medicine", "Shampoo" not "Hair Care").

EXISTING CATEGORIES (match one if suitable, otherwise suggest a new specific name):
{cat_list}

Return ONLY a valid JSON object — no markdown, no extra text.

{{
  "product_name":    "Full official product name from search",
  "brand":           "Brand or manufacturer name, empty string if unknown",
  "description":     "One sentence description max 120 chars, empty string if unknown",
  "expiry_date":     "YYYY-MM-DD from image, or null. Month/year only → last day of month.",
  "barcode":         "{barcode or ''}",
  "category_id":     "id from existing list if matched, else null",
  "category_name":   "matched existing category name OR new specific subcategory (max 30 chars)",
  "category_is_new": true,
  "confidence":      0.95
}}"""


async def _call_gemini_grounded(parts: list, prompt: str, retries: int = 4) -> dict:
    """
    Call Gemini 2.5 Flash with Google Search grounding.
    Note: responseMimeType JSON cannot be combined with tools — we parse free text.
    """
    last_err = None

    for attempt in range(max(retries, len(_KEYS))):
        key_obj = await _get_active_key()
        if not key_obj:
            raise HTTPException(503, "No Gemini API key configured.")

        payload = {
            "contents": [{"parts": [{"text": prompt}] + parts}],
            "tools": [{"googleSearch": {}}],
            "generationConfig": {
                "maxOutputTokens": 2048,
                "temperature":     0.1,
            },
            "safetySettings": [
                {"category": c, "threshold": "BLOCK_NONE"}
                for c in ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                          "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
            ],
        }

        url = f"{GEMINI_BASE}/{GEMINI_MODEL}:generateContent?key={key_obj.key}"

        try:
            async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT) as client:
                resp = await client.post(url, json=payload,
                                         headers={"Content-Type": "application/json"})

            if resp.status_code == 429:
                await rotate_after_429(key_obj)
                last_err = "429 quota exceeded"
                logger.info(f"[Gemini] 429 on key #{key_obj.idx} → rotating")
                await asyncio.sleep(0.3)
                continue

            if resp.status_code != 200:
                body_txt = resp.text[:400]
                raise HTTPException(502, f"Gemini error {resp.status_code}: {body_txt}")

            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                pf = data.get("promptFeedback", {})
                reason = pf.get("blockReason", "unknown")
                logger.warning(f"[Vision] Gemini no candidates — blockReason={reason}")
                raise HTTPException(502, f"Gemini blocked request: {reason}")

            cand = candidates[0]
            finish = cand.get("finishReason", "STOP")
            if finish == "SAFETY":
                logger.warning("[Vision] Gemini response blocked by SAFETY filter")
                raise HTTPException(502, "Gemini response blocked by safety filter")

            content_parts = cand.get("content", {}).get("parts", [])
            text = " ".join(p.get("text", "") for p in content_parts if p.get("text"))

            if not text:
                raise HTTPException(502, f"Gemini returned empty response (finishReason={finish})")

            return _parse_json(text)

        except HTTPException:
            raise
        except httpx.TimeoutException:
            last_err = "timeout"
            if attempt >= retries - 1:
                raise HTTPException(504, "Gemini API timed out — try again")
        except Exception as e:
            last_err = str(e)
            logger.error(f"[Gemini] Attempt {attempt+1} error: {e}")

    raise HTTPException(503, f"Gemini unavailable after {retries} attempts: {last_err}")


def _parse_json(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(l for l in lines[1:] if l.strip() != "```").strip()
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e != -1:
        text = text[s:e+1]
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        logger.error(f"[Gemini] JSON parse failed: {exc}\nRaw: {raw[:500]}")
        # Return partial data rather than hard-failing — barcode at minimum
        return {"product_name": "", "brand": "", "description": "",
                "expiry_date": None, "barcode": "", "category_id": None,
                "category_name": "", "category_is_new": False, "confidence": 0.0}


# ── Usage helpers ──────────────────────────────────────────────────────────────

async def _get_org(org_id: str) -> dict:
    client = await get_supabase_client()
    if not client:
        return {"is_premium": True, "used": 0, "limit": AI_DAILY_LIMIT}
    try:
        org_r = await asyncio.to_thread(
            lambda: client.table("organizations")
                .select("is_premium,subscription_plan")
                .eq("id", org_id).single().execute())
        org = org_r.data or {}
        is_premium = org.get("is_premium", False) or org.get("subscription_plan") == "premium"
        usage_r = await asyncio.to_thread(
            lambda: client.table("ai_usage").select("scan_count")
                .eq("organization_id", org_id)
                .eq("usage_date", date.today().isoformat()).execute())
        rows = usage_r.data or []
        used = rows[0]["scan_count"] if rows else 0
        return {"is_premium": is_premium, "used": used, "limit": AI_DAILY_LIMIT,
                "remaining": max(0, AI_DAILY_LIMIT - used)}
    except Exception as e:
        logger.error(f"[Vision] org fetch: {e}")
        return {"is_premium": True, "used": 0, "limit": AI_DAILY_LIMIT}


async def _increment_usage(org_id: str):
    client = await get_supabase_client()
    if not client: return
    try:
        await asyncio.to_thread(
            lambda: client.rpc("increment_ai_usage", {"p_org_id": org_id}).execute())
    except Exception as e:
        logger.error(f"[Vision] usage inc: {e}")


# ── Category helpers ───────────────────────────────────────────────────────────

_CAT_COLORS = {
    "medicine":"#ef4444","pharmacy":"#ef4444","health":"#ef4444",
    "vitamin":"#84cc16","supplement":"#84cc16",
    "oral":"#06b6d4","dental":"#06b6d4","tooth":"#06b6d4",
    "cosmetic":"#ec4899","beauty":"#ec4899","makeup":"#e11d48",
    "hair":"#7c3aed","skin":"#ec4899","face":"#ec4899","body":"#f97316",
    "personal":"#f97316","grooming":"#0284c7",
    "food":"#10b981","grocery":"#10b981","snack":"#f59e0b","dairy":"#fbbf24",
    "bakery":"#d97706","frozen":"#60a5fa","beverage":"#06b6d4","drink":"#06b6d4",
    "household":"#6366f1","cleaning":"#6366f1",
    "baby":"#f59e0b","pain":"#ef4444","shampoo":"#7c3aed","deodorant":"#0284c7",
}

def _cat_color(name: str) -> str:
    n = name.lower()
    for k, v in _CAT_COLORS.items():
        if k in n: return v
    return "#6b7280"


async def _ensure_category(org_id: str, cat_id: Optional[str], cat_name: str,
                             is_new: bool, client,
                             branch_id: Optional[str] = None) -> tuple:
    """
    Find or create a category scoped to the given branch.
    Looks for an exact name match within the same org+branch (or shared/null-branch).
    Creates with branch_id so it stays isolated to the correct branch.
    """
    if not cat_name:
        return cat_id, "", False
    try:
        # Search branch-specific + shared categories
        if branch_id:
            r_branch, r_shared = await asyncio.gather(
                asyncio.to_thread(lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).eq("branch_id", str(branch_id)).execute()),
                asyncio.to_thread(lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).is_("branch_id", "null").execute()),
            )
            existing_rows = (r_branch.data or []) + (r_shared.data or [])
        else:
            ex = await asyncio.to_thread(
                lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).execute())
            existing_rows = ex.data or []

        for c in existing_rows:
            if c["name"].strip().lower() == cat_name.strip().lower():
                return c["id"], c["name"], False
        if not is_new and cat_id:
            return cat_id, cat_name, False
        new_id  = str(uuid4())
        new_cat = {
            "id":              new_id,
            "organization_id": org_id,
            "branch_id":       branch_id,   # FIX: scope category to this branch
            "name":            cat_name.strip(),
            "description":     "Auto-created by AI product scan",
            "color":           _cat_color(cat_name),
        }
        await asyncio.to_thread(
            lambda: client.table("categories").insert(new_cat).execute())
        logger.info(f"[Vision] Auto-created category '{cat_name}' id={new_id} branch={branch_id}")
        return new_id, cat_name.strip(), True
    except Exception as e:
        logger.error(f"[Vision] category ensure: {e}")
        return cat_id, cat_name, False


async def _lookup_global_product(barcode: str) -> Optional[dict]:
    if not barcode: return None
    client = await get_supabase_client()
    if not client: return None
    try:
        rows = await asyncio.to_thread(
            lambda: client.rpc("lookup_global_product", {"p_barcode": barcode}).execute())
        data = rows.data
        if isinstance(data, list) and data:
            return data[0]
        return None
    except Exception as e:
        logger.warning(f"[GlobalProducts] lookup error: {e}")
        return None


async def _upsert_global_product(barcode: str, name: str, brand: str = "",
                                   description: str = "", category_hint: str = "",
                                   confidence: float = 1.0, source: str = "user"):
    if not barcode or not name: return
    client = await get_supabase_client()
    if not client: return
    try:
        await asyncio.to_thread(
            lambda: client.rpc("upsert_global_product", {
                "p_barcode":       barcode,
                "p_name":          name,
                "p_brand":         brand or "",
                "p_description":   description or "",
                "p_category_hint": category_hint or "",
                "p_image_url":     "",
                "p_confidence":    confidence,
                "p_source":        source,
            }).execute())
        logger.info(f"[GlobalProducts] upserted barcode={barcode} name='{name}'")
    except Exception as e:
        logger.warning(f"[GlobalProducts] upsert error: {e}")


# ── MAIN SCAN ENDPOINT ────────────────────────────────────────────────────────

@router.post("/scan")
async def scan_product(body: ScanRequest, current_user: dict = Depends(get_current_user)):
    org_id = current_user["organization_id"]

    info = await _get_org(org_id)
    if not info.get("is_premium", False):
        raise HTTPException(403, "AI Scan requires a Premium subscription.")
    if info.get("used", 0) >= info.get("limit", AI_DAILY_LIMIT):
        raise HTTPException(429, f"Daily AI scan limit reached ({info['used']}/{info['limit']}).")
    if not body.barcode and not body.expiry_image:
        raise HTTPException(400, "Barcode or expiry image required.")

    parts = []
    if body.expiry_image:
        parts.append(_img_part(body.expiry_image))

    prompt = _build_prompt(body.barcode, body.categories)
    gemini = await _call_gemini_grounded(parts, prompt)
    gemini["barcode"] = body.barcode or gemini.get("barcode") or ""

    db_client = await get_supabase_client()
    # FIX: resolve branch_id from request body or user JWT
    scan_branch_id = body.branch_id or current_user.get("branch_id") or None
    cat_id, cat_name, cat_created = await _ensure_category(
        org_id,
        gemini.get("category_id"),
        gemini.get("category_name", ""),
        bool(gemini.get("category_is_new", False)),
        db_client,
        branch_id=scan_branch_id,
    )

    if gemini["barcode"] and gemini.get("product_name"):
        await _upsert_global_product(
            barcode       = gemini["barcode"],
            name          = gemini.get("product_name", ""),
            brand         = gemini.get("brand", ""),
            description   = gemini.get("description", ""),
            category_hint = cat_name,
            confidence    = gemini.get("confidence", 0.8),
            source        = "gemini_grounded",
        )

    await _increment_usage(org_id)
    used_now = info.get("used", 0) + 1

    logger.info(
        f"[Vision] scan org={org_id} barcode={gemini['barcode']} "
        f"name='{gemini.get('product_name','')}' cat='{cat_name}' new={cat_created} "
        f"conf={gemini.get('confidence','?')} usage={used_now}/{info.get('limit')}"
    )

    return {
        "ok":               True,
        "product_name":     gemini.get("product_name", ""),
        "brand":            gemini.get("brand", ""),
        "description":      gemini.get("description", ""),
        "expiry_date":      gemini.get("expiry_date"),
        "barcode":          gemini["barcode"],
        "category_id":      cat_id,
        "category_name":    cat_name,
        "category_created": cat_created,
        "confidence":       gemini.get("confidence", 0),
        "source":           "gemini_grounded",
        "usage":            {"used": used_now, "limit": info.get("limit")},
    }


# ── Other endpoints ────────────────────────────────────────────────────────────

@router.get("/usage")
async def get_usage(current_user: dict = Depends(get_current_user)):
    org_id = current_user["organization_id"]
    info   = await _get_org(org_id)
    info["gemini_configured"] = len(_KEYS) > 0
    info["keys_count"]        = len(_KEYS)
    return info

@router.post("/usage/reset")
async def reset_usage(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ("admin", "manager", "superadmin"):
        raise HTTPException(403, "Only admins/managers can reset usage")
    client = await get_supabase_client()
    if not client: raise HTTPException(503, "DB unavailable")
    try:
        await asyncio.to_thread(
            lambda: client.table("ai_usage").update({"scan_count": 0})
                .eq("organization_id", current_user["organization_id"])
                .eq("usage_date", date.today().isoformat()).execute())
        return {"ok": True, "message": "Reset to 0 for today"}
    except Exception as e:
        raise HTTPException(500, f"Reset failed: {e}")

@router.get("/keys/status")
async def keys_status(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ("admin", "superadmin"):
        raise HTTPException(403, "Admins only")
    from .gemini_pool import keys_status as _pool_status
    return {
        "keys":         _pool_status(0),
        "active_model": GEMINI_MODEL,
        "key_count":    _key_count(),
    }

@router.post("/category")
async def create_category(body: CategoryCreateRequest,
                           current_user: dict = Depends(get_current_user)):
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client: raise HTTPException(503, "DB unavailable")
    name = body.name.strip()
    if not name: raise HTTPException(400, "Name required")
    try:
        ex = await asyncio.to_thread(
            lambda: client.table("categories").select("id,name")
                .eq("organization_id", org_id).execute())
        for c in (ex.data or []):
            if c["name"].strip().lower() == name.lower():
                return {"ok": True, "category": c, "created": False}
        # FIX: scope manually-created categories to the requesting user's branch
        req_branch = getattr(body, "branch_id", None) or current_user.get("branch_id") or None
        nc = {"id": str(uuid4()), "organization_id": org_id, "name": name,
              "description": body.description or "Auto-created", "color": body.color or _cat_color(name),
              "branch_id": req_branch}
        res = await asyncio.to_thread(lambda: client.table("categories").insert(nc).execute())
        return {"ok": True, "category": (res.data or [{}])[0], "created": True}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(500, f"Failed: {e}")

@router.post("/category/template/{template_name}")
async def apply_template(template_name: str, body: TemplateApplyRequest, current_user: dict = Depends(get_current_user)):
    # branch_id from request body — create categories scoped to that branch
    # NOTE: body MUST be a Pydantic model (not dict) for FastAPI to parse JSON body correctly
    # Only use branch_id from request body if explicitly provided
    # If not provided, categories will be created as shared (no branch_id)
    branch_id_param = body.branch_id if body.branch_id is not None else None
    TEMPLATES = {
        "pharmacy":    [("Medicine","#ef4444"),("Vitamins & Supplements","#84cc16"),
                        ("Baby Care","#f59e0b"),("Personal Care","#f97316"),
                        ("First Aid","#ef4444"),("Beverages","#06b6d4"),("Household","#6366f1")],
        "cosmetics":   [("Face Care","#ec4899"),("Body Care","#f97316"),("Hair Care","#7c3aed"),
                        ("Makeup","#e11d48"),("Fragrances","#9333ea"),("Nail Care","#db2777"),
                        ("Men's Grooming","#0284c7")],
        "supermarket": [("Food & Grocery","#10b981"),("Beverages","#06b6d4"),("Dairy","#fbbf24"),
                        ("Bakery","#d97706"),("Frozen Foods","#60a5fa"),("Snacks & Sweets","#f59e0b"),
                        ("Fresh Produce","#059669"),("Household","#6366f1"),
                        ("Personal Care","#f97316"),("Baby Products","#f59e0b")],
    }
    cats = TEMPLATES.get(template_name)
    if not cats: raise HTTPException(404, f"Template '{template_name}' not found")
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client: raise HTTPException(503, "DB unavailable")
    created = 0
    for name, color in cats:
        if branch_id_param:
            # STRICT branch scope for templates: only look in this specific branch.
            # Do NOT merge shared categories — the user explicitly chose a branch.
            try:
                r = await asyncio.to_thread(
                    lambda n=name: client.table("categories").select("id,name")
                        .eq("organization_id", org_id)
                        .eq("branch_id", str(branch_id_param))
                        .execute()
                )
                existing = next(
                    (c for c in (r.data or []) if c["name"].strip().lower() == name.strip().lower()),
                    None
                )
                if existing:
                    continue  # already exists in this branch, skip
                # Create strictly in this branch
                from uuid import uuid4 as _uuid4
                new_id = str(_uuid4())
                await asyncio.to_thread(
                    lambda n=name, c=color, nid=new_id: client.table("categories").insert({
                        "id": nid,
                        "organization_id": org_id,
                        "branch_id": str(branch_id_param),
                        "name": n.strip(),
                        "description": f"Auto-created from {template_name} template",
                        "color": c,
                    }).execute()
                )
                created += 1
                logger.info(f"[Vision] Template category '{name}' created in branch={branch_id_param}")
            except Exception as e:
                logger.error(f"[Vision] Template category '{name}' failed: {e}")
        else:
            # No branch selected → create as shared (org-wide)
            _, _, was_created = await _ensure_category(
                org_id, None, name, True, client, branch_id=None
            )
            if was_created: created += 1
    return {"ok": True, "created": created, "template": template_name}


logger.info(f"[Vision] v11.1 ready | Gemini 2.5 Flash + Google Search | {_key_count()} shared key(s) | limit={AI_DAILY_LIMIT}/day")
