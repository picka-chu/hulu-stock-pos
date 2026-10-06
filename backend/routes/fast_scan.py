"""
Fast Scan Routes  v2.0
══════════════════════════════════════════════════════════════════════════════

POST /api/fast-scan/item
  Instant item creation — no AI wait. Returns item_id < 800 ms.
  Validates: barcode format, image size, price logic.

POST /api/fast-scan/batch-process
  Batch Gemini processing after user taps Done.
  Fixes v1 issues:
    - Parallel DB lookups (asyncio.gather, not serial loop)
    - Shared Gemini key pool with vision.py
    - _ensure_category called ONCE with cached category map
    - Usage increment called ONCE (not N times in a loop)
    - finish_reason:SAFETY handled gracefully
    - Barcode sanitised before injecting into prompt
    - Product lookup maxOutputTokens raised to 2048
    - Image size validated (max 2MB decoded)

GET /api/fast-scan/pending
GET /api/fast-scan/retry
══════════════════════════════════════════════════════════════════════════════
"""

import os, json, re, base64, logging, asyncio, time
from datetime import date, datetime
from typing import Optional, List, Dict
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator, Field

from middleware.auth import get_current_user, require_manager
from database import get_supabase_client, upload_file_to_storage
from .gemini_pool import get_active_key, rotate_after_429, key_count

logger = logging.getLogger("fast_scan")
router = APIRouter()

GEMINI_MODEL    = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE     = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_TIMEOUT  = 90    # per individual Gemini call
MAX_BATCH_SIZE  = 30    # hard cap per batch request
MAX_IMAGE_BYTES = 2 * 1024 * 1024  # 2 MB decoded

# ── Pydantic models ────────────────────────────────────────────────────────────

class QuickItemRequest(BaseModel):
    barcode:          Optional[str]  = None
    expiry_image:     Optional[str]  = None   # base64 JPEG
    expiry_date:      Optional[str]  = None   # YYYY-MM-DD if already known
    buy_price:        float          = Field(default=0.0, ge=0)
    sell_price:       float          = Field(default=0.0, ge=0)
    stock_quantity:   int            = Field(default=0, ge=0)
    min_stock_level:  int            = Field(default=10, ge=0)
    supplier_id:      Optional[str]  = None
    branch_id:        Optional[str]  = None

    @field_validator("barcode", mode="before")
    @classmethod
    def validate_barcode(cls, v):
        if v is None:
            return v
        clean = v.strip()
        if clean and not re.match(r'^[A-Za-z0-9\-]{1,50}$', clean):
            raise ValueError("Barcode contains invalid characters")
        return clean or None

    @field_validator("expiry_image", mode="before")
    @classmethod
    def validate_image_size(cls, v):
        if v is None:
            return v
        b64 = v.split(",", 1)[1] if "," in v else v
        if len(b64) * 3 // 4 > MAX_IMAGE_BYTES:
            raise ValueError(f"Expiry image too large (max {MAX_IMAGE_BYTES//1024}KB)")
        return v


class BatchItem(BaseModel):
    item_id:       str
    barcode:       Optional[str] = None
    expiry_image:  Optional[str] = None   # base64 JPEG
    expiry_date:   Optional[str] = None   # YYYY-MM-DD — manual fallback if AI can't read photo


class BatchProcessRequest(BaseModel):
    items: List[BatchItem]

    @field_validator("items", mode="before")
    @classmethod
    def cap_batch_size(cls, v):
        if len(v) > MAX_BATCH_SIZE:
            raise ValueError(f"Batch too large — max {MAX_BATCH_SIZE} items per request")
        return v


# ── Helpers ────────────────────────────────────────────────────────────────────

def _b64_to_bytes(b64: str) -> bytes:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)


def _sanitize_barcode(bc: str) -> str:
    """Strip any chars that could hijack a prompt injection."""
    return re.sub(r'[^A-Za-z0-9\-]', '', (bc or "").strip())[:50]


_CAT_COLORS = {
    "oral":"#06b6d4","dental":"#06b6d4","medicine":"#ef4444","vitamin":"#84cc16",
    "cosmetic":"#ec4899","hair":"#7c3aed","skin":"#ec4899","body":"#f97316",
    "food":"#10b981","snack":"#f59e0b","dairy":"#fbbf24","beverage":"#06b6d4",
    "household":"#6366f1","baby":"#f59e0b","pain":"#ef4444","shampoo":"#7c3aed",
    "personal":"#f97316","grooming":"#0284c7","supplement":"#84cc16",
}

def _cat_color(name: str) -> str:
    n = name.lower()
    for k, v in _CAT_COLORS.items():
        if k in n: return v
    return "#6b7280"


async def _ensure_category_from_map(
    org_id: str,
    cat_name: str,
    existing_map: Dict[str, str],   # name.lower() → id
    client,
    branch_id: Optional[str] = None,  # FIX: branch-scoped category creation
) -> Optional[str]:
    """
    Find or create a category using an already-loaded map.
    Updates existing_map in place so duplicate names across items
    don't cause multiple DB inserts.
    Categories are now branch-scoped so they don't bleed across branches.
    """
    if not cat_name or not cat_name.strip():
        return None
    name = cat_name.strip()
    key  = name.lower()
    if key in existing_map:
        return existing_map[key]
    # Create new — always attach branch_id so it stays scoped to this branch
    try:
        new_id = str(uuid4())
        await asyncio.to_thread(
            lambda: client.table("categories").insert({
                "id":              new_id,
                "organization_id": org_id,
                "branch_id":       branch_id,  # FIX: branch isolation
                "name":            name,
                "description":     "Auto-created by AI batch scan",
                "color":           _cat_color(name),
            }).execute()
        )
        existing_map[key] = new_id
        logger.info(f"[FastScan] Created category '{name}' id={new_id} branch={branch_id}")
        return new_id
    except Exception as e:
        logger.warning(f"[FastScan] category create '{name}': {e}")
        return None


async def _get_category_map(org_id: str, client, branch_id=None) -> dict:
    """Load categories for this branch (+ shared/null-branch) as name.lower() -> id dict."""
    try:
        if branch_id:
            r_branch, r_shared = await asyncio.gather(
                asyncio.to_thread(lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).eq("branch_id", str(branch_id)).execute()),
                asyncio.to_thread(lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).is_("branch_id", "null").execute()),
            )
            rows = (r_branch.data or []) + (r_shared.data or [])
        else:
            r = await asyncio.to_thread(
                lambda: client.table("categories").select("id,name")
                    .eq("organization_id", org_id).execute()
            )
            rows = r.data or []
        return {c["name"].strip().lower(): c["id"] for c in rows}
    except Exception as e:
        logger.warning(f"[FastScan] get_category_map: {e}")
        return {}


async def _lookup_local(barcode: str, org_id: str, client) -> Optional[dict]:
    """Check if barcode already exists as a completed item in the org."""
    if not barcode: return None
    try:
        r = await asyncio.to_thread(
            lambda: client.table("items")
                .select("name,brand,description,category_id,expiry_date")
                .eq("organization_id", org_id)
                .eq("barcode", barcode)
                .neq("ai_status", "pending_ai")
                .not_.is_("name", "null")
                .limit(1).execute()
        )
        rows = r.data or []
        if rows and rows[0].get("name") and not rows[0]["name"].startswith("[Scanning"):
            return rows[0]
    except Exception as e:
        logger.warning(f"[FastScan] lookup_local barcode={barcode}: {e}")
    return None


async def _lookup_global(barcode: str, client) -> Optional[dict]:
    """Check global_products catalog."""
    if not barcode: return None
    try:
        r = await asyncio.to_thread(
            lambda: client.rpc("lookup_global_product", {"p_barcode": barcode}).execute()
        )
        data = r.data
        if isinstance(data, list) and data:
            return data[0]
    except Exception as e:
        logger.warning(f"[FastScan] lookup_global barcode={barcode}: {e}")
    return None


# ── Gemini calls ───────────────────────────────────────────────────────────────

_SAFETY_OFF = [
    {"category": c, "threshold": "BLOCK_NONE"}
    for c in ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
              "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
]


async def _raw_gemini(payload: dict, retries: int = 3) -> str:
    """
    Fire one Gemini generateContent request.
    - Uses shared key pool (cross-rotates with vision.py)
    - Handles 429, timeouts, SAFETY blocks, empty responses
    - Returns "" on soft failure (caller decides what to do)
    """
    last_err = ""
    for attempt in range(max(retries, key_count() or 1)):
        key = await get_active_key()
        if not key:
            logger.error("[FastScan] No Gemini API key configured")
            return ""

        url = f"{GEMINI_BASE}/{GEMINI_MODEL}:generateContent?key={key.key}"
        try:
            async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT) as http:
                resp = await http.post(url, json=payload,
                                       headers={"Content-Type": "application/json"})

            if resp.status_code == 429:
                await rotate_after_429(key)
                last_err = "429 quota"
                await asyncio.sleep(0.5)
                continue

            if resp.status_code != 200:
                body = resp.text
                logger.error(f"[FastScan] Gemini HTTP {resp.status_code}: {body[:600]}")
                last_err = f"HTTP {resp.status_code}"
                if resp.status_code in (400, 403):
                    return ""   # hard failure — won't improve with retry
                await asyncio.sleep(1)
                continue

            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                # Prompt feedback (safety block before any candidate)
                pf = data.get("promptFeedback", {})
                reason = pf.get("blockReason", "unknown")
                logger.warning(f"[FastScan] Gemini no candidates — blockReason={reason}")
                return ""

            cand = candidates[0]
            # Check finish reason — SAFETY means content was blocked
            finish = cand.get("finishReason", "STOP")
            if finish == "SAFETY":
                logger.warning("[FastScan] Gemini response blocked by SAFETY filter")
                return ""

            parts = cand.get("content", {}).get("parts", [])
            text  = " ".join(p.get("text", "") for p in parts if p.get("text"))
            if not text:
                logger.warning(f"[FastScan] Gemini empty text, finishReason={finish}")
                return ""

            return text

        except httpx.TimeoutException:
            last_err = "timeout"
            logger.warning(f"[FastScan] Gemini timeout attempt {attempt + 1}")
            if attempt >= retries - 1:
                return ""
        except Exception as e:
            last_err = str(e)
            logger.error(f"[FastScan] Gemini attempt {attempt + 1}: {e}")

    logger.error(f"[FastScan] Gemini gave up after {retries} attempts: {last_err}")
    return ""


def _extract_first_json_obj(text: str) -> Optional[str]:
    """
    Extract the FIRST complete, balanced JSON object from text.
    Safer than rfind("}") which picks up stray braces in grounding metadata.
    Returns the raw JSON string, or None if not found.
    """
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i, ch in enumerate(text[start:], start):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_str:
            escape = True
            continue
        if ch == '"' and not escape:
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_json_obj(text: str, item_id: str, barcode: str) -> dict:
    """
    Safely parse a JSON object from Gemini free-text.
    Uses balanced-brace extraction so grounding metadata after the JSON
    doesn't corrupt the parse (fixes rfind("}") bug with Google Search grounding).
    Returns fallback on failure.
    """
    raw = text.strip()
    # Strip markdown code fences
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(l for l in lines[1:] if not l.strip().startswith("```")).strip()
    # Use balanced-brace extractor instead of rfind
    extracted = _extract_first_json_obj(raw)
    if extracted:
        try:
            return json.loads(extracted)
        except Exception as exc:
            logger.warning(f"[FastScan] JSON parse failed item={item_id}: {exc} | raw[:200]={text[:200]}")
    else:
        logger.warning(f"[FastScan] No JSON object found item={item_id} | raw[:200]={text[:200]}")
    return {"item_id": item_id, "barcode": barcode}


async def _call_product_lookup(item_id: str, barcode: str, cat_list: str) -> dict:
    """
    Google Search grounded call — NO images.
    Returns product_name, brand, description, category_name.
    barcode is sanitised before prompt injection.
    """
    safe_bc = _sanitize_barcode(barcode)
    if not safe_bc:
        return {"item_id": item_id, "barcode": barcode}

    prompt = f"""You are a retail product database expert with access to Google Search.

Your task: look up barcode {safe_bc} and return the REAL product details.

SEARCH INSTRUCTIONS:
1. Search for: "{safe_bc} barcode product"
2. Also search for: "{safe_bc} EAN UPC product name"
3. Cross-reference at least 2 results to confirm accuracy

STRICT RULES:
- product_name must be the REAL commercial product name (e.g. "Colgate Total Whitening Toothpaste 75ml")
- Do NOT invent or hallucinate — if you cannot find the product, set product_name to "" and confidence to 0.0
- Do NOT return generic descriptions like "Product 12345678" or "Food Item"
- brand must be the manufacturer/brand name only (e.g. "Colgate", "Nestlé")
- description: one clear sentence max 120 chars, or empty string if unknown
- category_name: specific retail subcategory (e.g. "Oral Care", "Pain Relief", "Shampoo") max 30 chars
- confidence: 0.0-1.0 reflecting how certain you are this is the correct product

Return ONLY this JSON object — no markdown, no explanation, no extra text:
{{
  "item_id":       "{item_id}",
  "barcode":       "{safe_bc}",
  "product_name":  "Full official product name or empty string if not found",
  "brand":         "Brand or manufacturer name, or empty string if unknown",
  "description":   "One sentence max 120 chars, or empty string",
  "category_name": "Specific retail subcategory max 30 chars, or empty string",
  "confidence":    0.95
}}

EXISTING CATEGORIES to prefer matching (use exact name if one fits):
{cat_list}"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"googleSearch": {}}],
        "generationConfig": {
            "maxOutputTokens": 2048,   # raised from 1024 — grounding adds overhead
            "temperature":     0.1,
        },
        "safetySettings": _SAFETY_OFF,
    }

    text = await _raw_gemini(payload)
    if not text:
        return {"item_id": item_id, "barcode": barcode}
    return _parse_json_obj(text, item_id, barcode)


def _normalize_expiry_date(raw_date: Optional[str]) -> Optional[str]:
    """
    Normalize various expiry date formats to YYYY-MM-DD.
    Handles: MM/YYYY, MM/YY, DD/MM/YYYY, YYYY-MM-DD, MMM YYYY, YYYY.MM.DD, etc.
    Returns None if unparseable.
    """
    if not raw_date or not isinstance(raw_date, str):
        return None
    raw_date = raw_date.strip()
    if not raw_date or raw_date.lower() in ("null", "none", "n/a", ""):
        return None

    import re as _re
    from datetime import date as _date
    import calendar as _calendar

    # Already YYYY-MM-DD
    if _re.match(r"^\d{4}-\d{2}-\d{2}$", raw_date):
        try:
            y, m, d = map(int, raw_date.split("-"))
            if 1 <= m <= 12 and 1 <= d <= 31:
                return raw_date
        except Exception:
            pass

    # YYYY.MM.DD (European format with dots)
    m_dot = _re.match(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})$", raw_date)
    if m_dot:
        try:
            yr, mo, d = int(m_dot.group(1)), int(m_dot.group(2)), int(m_dot.group(3))
            if 1 <= mo <= 12 and 1 <= d <= 31:
                return f"{yr:04d}-{mo:02d}-{d:02d}"
        except Exception:
            pass

    # MM/YYYY or MM/YY (no day — use last day of month)
    m1 = _re.match(r"^(\d{1,2})[/\-](\d{2,4})$", raw_date)
    if m1:
        try:
            mon, yr = int(m1.group(1)), int(m1.group(2))
            if yr < 100: yr += 2000
            if 1 <= mon <= 12:
                last_day = _calendar.monthrange(yr, mon)[1]
                return f"{yr:04d}-{mon:02d}-{last_day:02d}"
        except Exception:
            pass

    # DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    m2 = _re.match(r"^(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{2,4})$", raw_date)
    if m2:
        try:
            d, mo, yr = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
            if yr < 100: yr += 2000
            if 1 <= mo <= 12 and 1 <= d <= 31:
                return f"{yr:04d}-{mo:02d}-{d:02d}"
        except Exception:
            pass

    # YYYY/MM/DD or YYYY-MM-DD
    m3 = _re.match(r"^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$", raw_date)
    if m3:
        try:
            yr, mo, d = int(m3.group(1)), int(m3.group(2)), int(m3.group(3))
            if 1 <= mo <= 12 and 1 <= d <= 31:
                return f"{yr:04d}-{mo:02d}-{d:02d}"
        except Exception:
            pass

    # "Jan 2027", "MAR 2026", "JANUARY 2026"
    month_map = {
        "jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,
        "jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12,
        "january":1,"february":2,"march":3,"april":4,"june":6,
        "july":7,"august":8,"september":9,"october":10,"november":11,"december":12,
    }
    m4 = _re.match(r"^([a-zA-Z]+)[\s\-/](\d{2,4})$", raw_date)
    if m4:
        try:
            mon_str = m4.group(1).lower()
            yr = int(m4.group(2))
            if yr < 100: yr += 2000
            mon = month_map.get(mon_str)
            if mon:
                last_day = _calendar.monthrange(yr, mon)[1]
                return f"{yr:04d}-{mon:02d}-{last_day:02d}"
        except Exception:
            pass

    # Format like "27 JUN 2027" or "JUN 27 2027" or "27 June 2027"
    m5 = _re.match(r"^(\d{1,2})[\s]+([a-zA-Z]+)[\s]+(\d{4})$", raw_date)
    if m5:
        try:
            d = int(m5.group(1))
            mon_str = m5.group(2).lower()
            yr = int(m5.group(3))
            mon = month_map.get(mon_str)
            if mon and 1 <= d <= 31:
                return f"{yr:04d}-{mon:02d}-{d:02d}"
        except Exception:
            pass

    # Format like "JUN 2027" or "June 2027" (no day — use last day of month)
    m6 = _re.match(r"^([a-zA-Z]+)[\s]+(\d{4})$", raw_date)
    if m6:
        try:
            mon_str = m6.group(1).lower()
            yr = int(m6.group(2))
            mon = month_map.get(mon_str)
            if mon:
                last_day = _calendar.monthrange(yr, mon)[1]
                return f"{yr:04d}-{mon:02d}-{last_day:02d}"
        except Exception:
            pass

    logger.warning(f"[FastScan] Could not normalize date: {raw_date!r}")
    return None


async def _call_expiry_vision(item_id: str, expiry_b64: str) -> dict:
    """
    Vision-only call — reads expiry date from product label image.
    Fixes:
    - Removed responseMimeType (conflicts with inlineData on some Gemini versions)
    - Uses balanced-brace JSON extractor (not rfind)
    - Normalizes date formats (MM/YYYY, DD/MM/YYYY, etc.) to YYYY-MM-DD
    - Improved prompt with explicit examples and better guidance
    """
    if not expiry_b64:
        return {"item_id": item_id, "expiry_date": None}

    b64 = expiry_b64.split(",", 1)[1] if "," in expiry_b64 else expiry_b64

    prompt = """You are an expert at reading product expiry dates from images.

TASK: Find the expiry date, best-before date, use-by date, expiration date, or EXP date on the product label.

COMMON EXPIRY DATE FORMATS ON PRODUCTS:
- EXP: 06/2027 or 06/27 (means June 2027)
- BEST BEFORE: 15/06/2027 or 15-06-2027 (DD/MM/YYYY)
- USE BY: 2027-06-30
- MFG: JUN 2027 or JUNE 27, 2027
- Expiry on: 30.06.2027 or 30-06-2027
- Shelf life: 24 months from manufacture date

INSTRUCTIONS:
1. Look carefully at ALL text on the product label
2. Focus on areas near "EXP", "BEST BEFORE", "USE BY", "EXPIRY", "MFG" labels
3. Ignore manufacture dates (MFG, MFD, MANUFACTURED)
4. Ignore promotional text or unrelated numbers

OUTPUT FORMAT:
Return ONLY this exact JSON format with no markdown, no explanation:
{"expiry_date": "YYYY-MM-DD"}

DATE CONVERSION RULES (apply these in order):
1. If format is MM/YYYY or MM/YY → last day of that month (06/2027 → 2027-06-30)
2. If format is DD/MM/YYYY or DD-MM-YYYY → convert directly (15/06/2027 → 2027-06-15)
3. If format is YYYY-MM-DD → use as-is
4. If format includes month name (JUN, JUNE, JUL, etc.) → convert to YYYY-MM-DD using last day
5. If you see a date but are unsure → still return it, I will validate

IF NO EXPIRY DATE FOUND:
Return: {"expiry_date": null}

ABSOLUTE RULES:
- Return ONLY the JSON object, nothing else
- Do not add markdown code blocks
- Do not explain your reasoning
- Do not guess if date is completely unreadable
- Always prefer to return a date if you can read ANY part of it"""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": b64}},
            ]
        }],
        "generationConfig": {
            "maxOutputTokens": 512,   # Enough for {"expiry_date": "YYYY-MM-DD"} with headroom
            "temperature":     0.0,   # Zero temp for deterministic date extraction
        },
        "safetySettings": _SAFETY_OFF,
    }

    text = await _raw_gemini(payload)
    if not text:
        logger.warning(f"[FastScan][Expiry] Gemini returned EMPTY response for item={item_id} — check API key, quota, and image size")
        return {"item_id": item_id, "expiry_date": None}
    # Log with WARNING so it's always visible in Render logs regardless of level filters
    logger.warning(
        f"\n{'='*60}\n"
        f"[FastScan][Expiry] GEMINI RESPONSE item={item_id}\n"
        f"RAW TEXT: {text[:600]!r}\n"
        f"{'='*60}"
    )

    # DEBUG: Log raw AI response for troubleshooting expiry date extraction
    logger.info(f"[FastScan] DEBUG Expiry vision raw response (item={item_id}): {text[:500]!r}")

    # Strip markdown fences if present
    raw = text.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(l for l in lines[1:] if not l.strip().startswith("```")).strip()

    # Use balanced-brace extractor (not rfind which picks up stray braces)
    extracted = _extract_first_json_obj(raw)
    if extracted:
        try:
            parsed = json.loads(extracted)
            raw_date = parsed.get("expiry_date")
            # Normalize whatever format Gemini returns to YYYY-MM-DD
            normalized = _normalize_expiry_date(raw_date)
            if normalized:
                logger.info(f"[FastScan] Expiry date extracted: {raw_date!r} → {normalized} (item={item_id})")
            else:
                logger.info(f"[FastScan] No expiry date found in image (item={item_id})")
            return {"item_id": item_id, "expiry_date": normalized}
        except Exception as exc:
            logger.warning(f"[FastScan] expiry parse item={item_id}: {exc} | text[:200]={text[:200]}")
    else:
        # Gemini returned something that's not a complete JSON object
        # (e.g. truncated: '{"expiry_date": "2027-06' due to token limit)
        # Try regex to pull out any date-like pattern directly from the raw text
        import re as _re
        date_patterns = [
            r'(\d{4}-\d{2}-\d{2})',                # YYYY-MM-DD  e.g. 2027-06-30
            r'(\d{1,2}[/\-]\d{4})',                # MM/YYYY     e.g. 06/2027
            r'(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})', # DD/MM/YYYY  e.g. 15/06/2027
            r'([A-Za-z]{3,9}[\s\-]+\d{2,4})',      # MMM YYYY    e.g. JUN 2027
        ]
        for pat in date_patterns:
            m = _re.search(pat, raw)
            if m:
                candidate = m.group(1)
                normalized = _normalize_expiry_date(candidate)
                if normalized:
                    logger.info(f"[FastScan] Expiry extracted via regex from truncated response: {candidate!r} → {normalized} (item={item_id})")
                    return {"item_id": item_id, "expiry_date": normalized}
        # Last resort: try the whole stripped string
        date_candidate = raw.strip().strip('"\'` ')
        normalized = _normalize_expiry_date(date_candidate)
        if normalized:
            logger.info(f"[FastScan] Expiry date from plain text: {date_candidate!r} → {normalized} (item={item_id})")
            return {"item_id": item_id, "expiry_date": normalized}
        logger.warning(f"[FastScan] Could not extract expiry from response item={item_id}: {text[:200]!r}")

    return {"item_id": item_id, "expiry_date": None}


async def _call_gemini_batch(
    items_meta: list,
    image_map: dict,
    cat_list: str
) -> Optional[list]:
    """
    Run all product-lookup + expiry-vision calls concurrently.
    All N*2 calls fire in parallel via asyncio.gather.
    """
    tasks      = []
    task_info  = []

    for m in items_meta:
        iid = m["item_id"]
        bc  = m.get("barcode") or ""
        tasks.append(_call_product_lookup(iid, bc, cat_list))
        task_info.append(("product", iid))
        if m.get("has_img") and iid in image_map:
            tasks.append(_call_expiry_vision(iid, image_map[iid]))
            task_info.append(("expiry", iid))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    merged: Dict[str, dict] = {}
    for (kind, iid), result in zip(task_info, results):
        if isinstance(result, Exception):
            logger.error(f"[FastScan] task ({kind},{iid}) exception: {result}")
            continue
        if iid not in merged:
            merged[iid] = {"item_id": iid}
        if kind == "product":
            # Merge product fields but NEVER let product result overwrite a
            # real expiry_date already set by the expiry-vision task.
            # (Gemini sometimes hallucinates an expiry_date field in product JSON)
            existing_expiry = merged[iid].get("expiry_date")
            merged[iid].update(result)
            if existing_expiry:
                merged[iid]["expiry_date"] = existing_expiry  # restore real expiry
        elif kind == "expiry":
            # Expiry vision result always wins over any product-derived value
            expiry_val = result.get("expiry_date")
            if expiry_val:  # only overwrite if vision actually found a date
                merged[iid]["expiry_date"] = expiry_val
            elif "expiry_date" not in merged[iid]:
                merged[iid]["expiry_date"] = None  # mark as checked but not found

    return list(merged.values()) if merged else None


# ── ENDPOINT 1: Quick item create ─────────────────────────────────────────────

@router.post("/item")
async def create_quick_item(
    body: QuickItemRequest,
    current_user: dict = Depends(require_manager)
):
    """
    Instantly create a skeleton item (ai_status=pending_ai).
    Validates barcode format and image size.
    Returns item_id in < 800 ms.
    """
    org_id  = current_user["organization_id"]
    item_id = str(uuid4())
    client  = await get_supabase_client()
    if not client:
        raise HTTPException(503, "Database unavailable")

    # ── Cross-tenant guards: branch and supplier must belong to this org ─────
    from middleware.auth import verify_branch_in_org
    if body.branch_id and not await verify_branch_in_org(str(body.branch_id), str(org_id)):
        raise HTTPException(404, "Branch not found")
    if body.supplier_id:
        from database import fetch_one as _fetch_one
        if not await _fetch_one("suppliers", {"id": str(body.supplier_id), "organization_id": str(org_id)}):
            raise HTTPException(400, "Supplier not found")

    # ── Upload expiry image ──────────────────────────────────────────────────
    expiry_image_url = None
    if body.expiry_image:
        try:
            img_bytes        = _b64_to_bytes(body.expiry_image)
            path             = f"expiry/{org_id}/{item_id}.jpg"
            expiry_image_url = await upload_file_to_storage(
                bucket_name  = "item-images",
                file_path    = path,
                file_content = img_bytes,
                content_type = "image/jpeg",
            )
        except Exception as e:
            logger.warning(f"[FastScan] expiry image upload failed (non-fatal): {e}")

    # ── Duplicate barcode check ─────────────────────────────────────────────
    # Scoped to the same branch (if provided) to avoid false 409 conflicts
    # when the same barcode legitimately exists in a different branch.
    if body.barcode and body.barcode.strip():
        try:
            effective_branch = body.branch_id or None

            def _build_dup_query():
                q = client.table("items") \
                    .select("id,name,ai_status,branch_id") \
                    .eq("organization_id", org_id) \
                    .eq("barcode", body.barcode.strip()) \
                    .eq("is_active", True)
                if effective_branch:
                    q = q.eq("branch_id", str(effective_branch))
                return q.limit(1).execute()

            dup = await asyncio.to_thread(_build_dup_query)
            existing = (dup.data or [None])[0]
            if existing:
                ex_name = existing["name"]
                ex_id   = existing["id"]
                status  = existing.get("ai_status", "")
                # pending_ai items from a previous session can be re-added to the queue
                # Return 200 with existing_id so frontend adds it to batch without creating a dup
                if status == "pending_ai":
                    return {
                        "ok":          True,
                        "item_id":     ex_id,
                        "name":        ex_name,
                        "reused":      True,
                        "expiry_image_url": existing.get("expiry_image_url"),
                    }
                # Completed item with this barcode already exists — block the duplicate
                raise HTTPException(
                    status_code=409,
                    detail={"message": f"Barcode already exists: '{ex_name}'", "existing_id": ex_id, "existing_name": ex_name}
                )
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"[FastScan] Duplicate check failed (non-fatal): {e}")

    placeholder_name = f"[Scanning…] {body.barcode or item_id[:8]}"

    item_dict = {
        "id":               item_id,
        "organization_id":  org_id,
        "branch_id":        body.branch_id or None,
        "supplier_id":      body.supplier_id or None,
        "category_id":      None,
        "name":             placeholder_name,
        "description":      None,
        "brand":            None,
        "barcode":          body.barcode or None,
        "buy_price":        float(body.buy_price),
        "sell_price":       float(body.sell_price),
        "stock_quantity":   int(body.stock_quantity),
        "min_stock_level":  int(body.min_stock_level),
        "expiry_date":      body.expiry_date or None,
        "expiry_image_url": expiry_image_url,
        "batch_number":     None,
        "image_url":        None,
        "is_active":        True,
        "ai_status":        "pending_ai",
    }

    result = await asyncio.to_thread(
        lambda: client.table("items").insert(item_dict).execute()
    )
    if not result.data:
        raise HTTPException(500, "Failed to create item")

    # Fast-scan stock is a real receipt, so create an opening batch immediately.
    # Later AI enrichment may update the item expiry, but inventory must never
    # exist outside item_batches because FEFO sales only deduct batches.
    if int(body.stock_quantity or 0) > 0:
        batch_id = str(uuid4())
        await asyncio.to_thread(
            lambda: client.table("item_batches").insert({
                "id": batch_id, "organization_id": org_id, "branch_id": body.branch_id or None,
                "item_id": item_id, "batch_number": None, "expiry_date": body.expiry_date or None,
                "received_quantity": int(body.stock_quantity), "quantity_on_hand": int(body.stock_quantity),
                "unit_cost": float(body.buy_price), "supplier_id": body.supplier_id or None, "is_active": True,
            }).execute()
        )
        await asyncio.to_thread(
            lambda: client.table("stock_movements").insert({
                "id": str(uuid4()), "item_id": item_id, "branch_id": body.branch_id or None,
                "type": "restock", "quantity": int(body.stock_quantity),
                "previous_quantity": 0, "new_quantity": int(body.stock_quantity),
                "reference_id": batch_id, "reference_type": "fast_scan_opening_batch",
                "created_by": current_user["id"], "batch_id": batch_id,
                "batch_number": None, "batch_expiry_date": body.expiry_date or None,
            }).execute()
        )

    # Add to ai_scan_queue (non-fatal if fails)
    try:
        await asyncio.to_thread(
            lambda: client.table("ai_scan_queue").insert({
                "id":               str(uuid4()),
                "organization_id":  org_id,
                "item_id":          item_id,
                "barcode":          body.barcode or None,
                "expiry_image_url": expiry_image_url,
            }).execute()
        )
    except Exception as e:
        logger.warning(f"[FastScan] queue insert failed (non-fatal): {e}")

    logger.info(f"[FastScan] Quick item created id={item_id} barcode={body.barcode} branch_id={body.branch_id!r} expiry_date={body.expiry_date!r} has_expiry_image={bool(body.expiry_image)}")
    return {
        "ok":              True,
        "item_id":         item_id,
        "name":            placeholder_name,
        "expiry_image_url": expiry_image_url,
    }


# ── ENDPOINT 2: Batch process ─────────────────────────────────────────────────

@router.post("/batch-process")
async def batch_process(
    body: BatchProcessRequest,
    current_user: dict = Depends(require_manager)
):
    """
    Process queued items with Gemini.
    Fixes: parallel DB lookups, shared key pool, single usage increment,
           category map loaded once, barcode sanitisation.
    """
    org_id = current_user["organization_id"]
    if not body.items:
        return {"ok": True, "processed": 0, "message": "Nothing to process"}
    if len(body.items) > 30:
        raise HTTPException(400, "Max 30 items per batch — split larger scans.")
    logger.info(f"[FastScan] batch-process called: {len(body.items)} items, org={org_id}")

    client = await get_supabase_client()
    if not client:
        raise HTTPException(503, "Database unavailable")

    # ── AI cost gate (same rule as /vision/scan): premium orgs only, ─────────
    # inside the daily quota. Without this any manager could burn unlimited
    # Gemini calls (30 items x 2 calls per request, fully parallel).
    from .vision import _get_org as _ai_org_info
    _ai = await _ai_org_info(org_id)
    if not _ai.get("is_premium", False):
        raise HTTPException(403, "AI Scan requires a Premium subscription.")
    if _ai.get("used", 0) + len(body.items) > _ai.get("limit", 500):
        raise HTTPException(429, f"Daily AI scan limit would be exceeded ({_ai.get('used', 0)}/{_ai.get('limit', 500)} used, {len(body.items)} requested).")

    # Derive the batch branch_id from the first item's DB record (best-effort)
    # This ensures auto-created categories are scoped to the correct branch
    batch_branch_id = current_user.get("branch_id") or None

    # Load categories ONCE for the whole batch (branch-scoped)
    cat_map  = await _get_category_map(org_id, client, branch_id=batch_branch_id)  # name.lower() -> id
    cat_list = "\n".join(f"  - id:{v}  name:{k}" for k, v in cat_map.items()) \
               if cat_map else "  (none yet)"

    # ── Step 1: Send all items directly to Gemini ────────────────────────────
    # DB lookup (local + global catalog) is skipped for speed.
    # Gemini does product lookup via Google Search grounding directly.
    barcodes  = [(it.item_id, (it.barcode or "").strip()) for it in body.items]
    image_map = {it.item_id: it.expiry_image for it in body.items if it.expiry_image}

    for _it in body.items:
        logger.info(
            f"[FastScan][Expiry] item={_it.item_id} barcode={_it.barcode!r} "
            f"has_image={_it.item_id in image_map} "
            f"manual_expiry_date={getattr(_it, 'expiry_date', None)!r}"
        )

    resolved: Dict[str, dict] = {}
    needs_ai: list = [
        {"item_id": item_id, "barcode": bc, "has_img": bool(image_map.get(item_id))}
        for item_id, bc in barcodes
    ]

    # ── Step 2: Gemini batch ──────────────────────────────────────────────────
    if needs_ai:
        items_meta = [{"item_id": m["item_id"], "barcode": m["barcode"], "has_img": m["has_img"]}
                      for m in needs_ai]
        ai_results = await _call_gemini_batch(items_meta, image_map, cat_list)

        if ai_results:
            for ai in ai_results:
                iid = ai.get("item_id")
                if not iid: continue
                resolved[iid] = {
                    "item_id":      iid,
                    "barcode":      ai.get("barcode", ""),
                    "product_name": ai.get("product_name", ""),
                    "brand":        ai.get("brand", ""),
                    "description":  ai.get("description", ""),
                    "expiry_date":  ai.get("expiry_date"),
                    "category_name": ai.get("category_name", ""),
                    "confidence":   ai.get("confidence", 0.0),
                    "source":       "gemini",
                }
        else:
            logger.warning("[FastScan] Gemini returned no results — items remain pending_ai")

    # ── Step 3: Update items in DB ─────────────────────────────────────────────
    updated_count = 0
    failed_ids    = []

    for it in body.items:
        iid = it.item_id
        res = resolved.get(iid)
        if not res:
            continue

        # For low-confidence Gemini product results, skip product fields only.
        # IMPORTANT: expiry_date still gets written — it comes from vision (photo),
        # not from the product lookup, so it must not be skipped.
        skip_product_fields = False
        if res.get("source") == "gemini":
            raw_conf = res.get("confidence", 1.0)
            try:
                conf = float(raw_conf)
            except (TypeError, ValueError):
                conf = 0.0
            pname = (res.get("product_name") or "").strip()
            if conf < 0.5 or not pname or pname.startswith("[Scanning"):
                logger.warning(f"[FastScan] Low-confidence product for {iid}: conf={conf} name='{pname}' — keeping expiry, skipping product fields")
                skip_product_fields = True

        # Resolve category using the shared map (no extra DB call)
        # Fetch the item's own branch_id for correct scoping
        item_branch_id = None
        try:
            item_row = await asyncio.to_thread(
                lambda uid=iid: client.table("items").select("branch_id").eq("id", uid).limit(1).execute()
            )
            if item_row.data:
                item_branch_id = item_row.data[0].get("branch_id") or batch_branch_id
        except Exception:
            item_branch_id = batch_branch_id

        cat_id = res.get("category_id")
        if not cat_id and res.get("category_name"):
            cat_id = await _ensure_category_from_map(
                org_id, res["category_name"], cat_map, client, branch_id=item_branch_id
            )

        update_data: dict = {"updated_at": datetime.utcnow().isoformat()}
        if not skip_product_fields:
            update_data["ai_status"] = "completed"
            if res.get("product_name"): update_data["name"]        = res["product_name"]
            if res.get("brand"):        update_data["brand"]       = res["brand"]
            if res.get("description"):  update_data["description"] = res["description"]
        else:
            # Keep as pending_ai so product name/brand/description get retried later
            update_data["ai_status"] = "pending_ai"
            logger.info(f"[FastScan] item={iid} kept as pending_ai (low confidence) — expiry+category still written")
        # Category and expiry are ALWAYS written regardless of product confidence
        if cat_id: update_data["category_id"] = cat_id

        # Expiry date resolution (priority order):
        # 1. AI vision result (most accurate — read directly from product label image)
        # 2. Manual date typed by user in the details form (reliable fallback)
        # 3. Nothing — leave DB value untouched (already saved from /fast-scan/item call)
        ai_expiry     = res.get("expiry_date")            # from Gemini vision
        manual_expiry = it.expiry_date                    # typed by user in fast-scan UI
        resolved_expiry = ai_expiry or manual_expiry or None
        logger.warning(
            f"[FastScan][Expiry] RESULT item={iid}: "
            f"ai={ai_expiry!r} manual={manual_expiry!r} "
            f"RESOLVED={resolved_expiry!r} source={res.get('source','?')!r}"
        )
        if resolved_expiry:
            update_data["expiry_date"] = resolved_expiry

        # DEBUG: Log expiry date resolution for troubleshooting
        logger.info(
            f"[FastScan] DEBUG item={iid} barcode={it.barcode or 'N/A'}: "
            f"ai_expiry={ai_expiry!r} | manual_expiry={manual_expiry!r} | "
            f"resolved_expiry={resolved_expiry!r} | update_data.expiry_date={update_data.get('expiry_date')!r}"
        )

        try:
            await asyncio.to_thread(
                lambda uid=iid, d=update_data:
                    client.table("items").update(d)
                        .eq("id", uid).eq("organization_id", org_id).execute()
            )
            updated_count += 1

            # Upsert to global catalog (fire-and-forget)
            bc = it.barcode or res.get("barcode", "")
            if bc and res.get("product_name"):
                asyncio.create_task(_upsert_global(
                    bc, res["product_name"], res.get("brand",""),
                    res.get("description",""), res.get("category_name",""),
                    res.get("source","gemini"), client
                ))

        except Exception as e:
            logger.error(f"[FastScan] update item {iid}: {e}")
            failed_ids.append(iid)

    # ── Mark queue processed ──────────────────────────────────────────────────
    processed_ids = [it.item_id for it in body.items if it.item_id in resolved]
    if processed_ids:
        try:
            await asyncio.to_thread(
                lambda: client.rpc("mark_queue_processed",
                                   {"p_item_ids": processed_ids}).execute()
            )
        except Exception as e:
            logger.warning(f"[FastScan] mark_queue_processed: {e}")

    # ── Increment AI usage ONCE ───────────────────────────────────────────────
    ai_lookup_count = len(needs_ai)  # all items go to Gemini now
    if ai_lookup_count > 0:
        try:
            # Use a single RPC call with count instead of N sequential calls
            await asyncio.to_thread(
                lambda: client.rpc("increment_ai_usage_by",
                                   {"p_org_id": org_id, "p_count": ai_lookup_count}).execute()
            )
        except Exception:
            # Fallback: single increment (better than N loops)
            try:
                await asyncio.to_thread(
                    lambda: client.rpc("increment_ai_usage", {"p_org_id": org_id}).execute()
                )
            except Exception as e:
                logger.warning(f"[FastScan] usage increment failed: {e}")

    logger.info(
        f"[FastScan] batch org={org_id} total={len(body.items)} "
        f"updated={updated_count} failed={len(failed_ids)} "
        f"ai_calls={ai_lookup_count} from_cache={len(body.items) - len(needs_ai)}"
    )

    return {
        "ok":        True,
        "total":     len(body.items),
        "updated":   updated_count,
        "failed":    len(failed_ids),
        "failed_ids": failed_ids,
        "results":   list(resolved.values()),
    }


async def _upsert_global(barcode, name, brand, description, category_hint, source, client):
    """Fire-and-forget global catalog upsert."""
    try:
        await asyncio.to_thread(
            lambda: client.rpc("upsert_global_product", {
                "p_barcode": barcode, "p_name": name, "p_brand": brand or "",
                "p_description": description or "", "p_category_hint": category_hint or "",
                "p_image_url": "", "p_confidence": 0.85, "p_source": source or "gemini",
            }).execute()
        )
    except Exception as e:
        logger.warning(f"[FastScan] global upsert: {e}")


# ── ENDPOINT 3: Get pending ───────────────────────────────────────────────────

@router.get("/pending")
async def get_pending(current_user: dict = Depends(get_current_user)):
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client: return {"items": []}
    try:
        r = await asyncio.to_thread(
            lambda: client.table("items")
                .select("id,name,barcode,buy_price,sell_price,stock_quantity,ai_status,expiry_image_url,created_at")
                .eq("organization_id", org_id)
                .eq("ai_status", "pending_ai")
                .eq("is_active", True)
                .order("created_at", desc=True)
                .execute()
        )
        return {"items": r.data or []}
    except Exception as e:
        logger.error(f"[FastScan] get pending: {e}")
        return {"items": []}


# ── ENDPOINT 4: Retry pending ─────────────────────────────────────────────────

@router.post("/retry")
async def retry_pending(current_user: dict = Depends(require_manager)):
    """Re-process all stuck pending_ai items by fetching from ai_scan_queue."""
    org_id = current_user["organization_id"]
    client = await get_supabase_client()
    if not client: raise HTTPException(503, "Database unavailable")
    try:
        q = await asyncio.to_thread(
            lambda: client.table("ai_scan_queue")
                .select("item_id,barcode,expiry_image_url")
                .eq("organization_id", org_id)
                .is_("processed_at", "null").execute()
        )
        queue_items = q.data or []
    except Exception as e:
        raise HTTPException(500, f"Queue fetch failed: {e}")

    if not queue_items:
        return {"ok": True, "message": "No pending items to retry", "total": 0}

    items = [
        BatchItem(item_id=qi["item_id"], barcode=qi.get("barcode"), expiry_image=None)
        for qi in queue_items
    ]
    req = BatchProcessRequest(items=items)
    return await batch_process(req, current_user)


logger.info(f"[FastScan] v2.0 ready | {key_count()} shared Gemini key(s)")
