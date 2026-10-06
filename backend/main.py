"""
Hulu Stock Multi-Tenant POS System - Production Ready
"""
import os
import logging
import logging.handlers
import asyncio
import time
from contextlib import asynccontextmanager
from collections import defaultdict

from fastapi import FastAPI, Request, status, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

PORT        = int(os.getenv("PORT", 8000))
ENVIRONMENT = os.getenv("ENVIRONMENT", "production")

# ── Logging ───────────────────────────────────────────────────────────────────
# Render captures stdout/stderr — no file handler needed (avoids read-only FS crash)
_log_handlers = [logging.StreamHandler()]
try:
    # Try to add file handler — works locally, silently skipped on Render
    _log_handlers.append(
        logging.handlers.RotatingFileHandler("app.log", maxBytes=10_485_760, backupCount=5)
    )
except (PermissionError, OSError):
    pass  # Read-only filesystem — stdout only

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=_log_handlers
)

# Explicitly set all Hulu Stock loggers to INFO so Render shows them
# basicConfig alone sometimes doesn't propagate to named loggers
for _log_name in ("main", "fast_scan", "vision", "auth", "database", "items", "sales"):
    _l = logging.getLogger(_log_name)
    _l.setLevel(logging.INFO)
    if not _l.handlers:          # avoid duplicate handlers
        _l.propagate = True      # send to root handler (stdout)

logger = logging.getLogger("main")
logger.info(f"Starting Hulu Stock — environment={ENVIRONMENT} port={PORT}")

# ── Routes ────────────────────────────────────────────────────────────────────
from routes import (
    auth, organizations, branches, users,
    categories, suppliers, items, sales,
    reports, bank_accounts, expenses, dashboard,
    notifications, superadmin, push, vision
)

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    from database import fetch_one, get_supabase_client
    logger.info("Hulu Stock starting up…")

    for attempt in range(3):
        try:
            await fetch_one("organizations", {})
            logger.info("✅ Database connected")
            break
        except Exception as e:
            logger.warning(f"DB connect attempt {attempt+1}/3 failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2)

    task = asyncio.create_task(_keep_alive())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    from database import close_client
    await close_client()
    logger.info("Hulu Stock shut down cleanly")


async def _keep_alive():
    """Ping Supabase every 40s to prevent idle disconnection."""
    while True:
        try:
            await asyncio.sleep(40)
            from database import get_supabase_client
            client = await get_supabase_client()
            if client:
                await asyncio.to_thread(
                    lambda: client.table("organizations").select("id").limit(1).execute()
                )
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug(f"Keep-alive ping failed: {e}")


# ── App ────────────────────────────────────────────────────────────────────────
# Hide API docs in production
_docs_url   = None if ENVIRONMENT == "production" else "/api/docs"
_redoc_url  = None if ENVIRONMENT == "production" else "/api/redoc"
_openapi    = None if ENVIRONMENT == "production" else "/api/openapi.json"

app = FastAPI(
    title="Hulu Stock API",
    version="1.0.0",
    docs_url=_docs_url,
    redoc_url=_redoc_url,
    openapi_url=_openapi,
    lifespan=lifespan,
    redirect_slashes=False,   # prevent 307 redirect turning POST into GET
)

# ── CORS ──────────────────────────────────────────────────────────────────────
def _cors_origins():
    origins = []
    for env_key in ("FRONTEND_URL", "ALLOWED_ORIGINS"):
        val = os.getenv(env_key, "").strip()
        if val:
            origins.extend([o.strip().rstrip("/") for o in val.split(",") if o.strip()])
    if ENVIRONMENT != "production":
        origins += ["http://localhost:3000", "http://localhost:5173",
                    "http://127.0.0.1:3000", "http://127.0.0.1:5173"]
    if not origins:
        if ENVIRONMENT == "production":
            logger.critical("⚠️  FRONTEND_URL not set — CORS will deny all origins! Set FRONTEND_URL in env.")
            return []  # deny all — fail closed
        logger.warning("⚠️  No FRONTEND_URL set — CORS is open to all origins (dev only)!")
        return ["*"]
    return list(set(origins))

ALLOWED_ORIGINS = _cors_origins()
logger.info(f"CORS origins: {ALLOWED_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"],
    allow_headers=["Authorization","Content-Type","X-Requested-With"],
)

# ── GZip compression ──────────────────────────────────────────────────────────
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1024)

# ── Security headers ──────────────────────────────────────────────────────────
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]          = "DENY"
    response.headers["X-XSS-Protection"]         = "1; mode=block"
    response.headers["Referrer-Policy"]           = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]        = "camera=(), microphone=(), geolocation=()"
    if ENVIRONMENT == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

# ── CSRF / Origin check for state-changing requests ──────────────────────────
_CSRF_EXEMPT_PATHS = {"/api/auth/login", "/api/superadmin/login", "/api/health",
                       "/api/health/ping", "/api/register-request", "/"}

@app.middleware("http")
async def csrf_origin_check(request: Request, call_next):
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return await call_next(request)
    if request.url.path in _CSRF_EXEMPT_PATHS:
        return await call_next(request)
    # State-changing requests must include an Origin or Referer header matching
    # an allowed origin. Behind a proxy the host header is the internal address,
    # so we check Origin against ALLOWED_ORIGINS.
    origin = request.headers.get("origin") or request.headers.get("referer") or ""
    if origin:
        origin = origin.rstrip("/")
        allowed = ALLOWED_ORIGINS
        if allowed and allowed != ["*"] and not any(origin.startswith(o) for o in allowed):
            return JSONResponse(
                status_code=403,
                content={"success": False, "message": "CSRF check failed: unknown origin"},
            )
    return await call_next(request)

# ── Request body size limit (10 MB max — prevents memory exhaustion) ─────────
_MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB

@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            cl = int(content_length)
        except (ValueError, TypeError):
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": "Invalid Content-Length header"}
            )
        if cl > _MAX_BODY_SIZE:
            return JSONResponse(
                status_code=413,
                content={"success": False, "message": "Request body too large (max 10 MB)"}
            )
    return await call_next(request)

# ── Rate limiting (simple in-memory — replace with Redis for multi-instance) ──
_rate_store: dict = defaultdict(list)
_RATE_LIMIT_WINDOW = 60   # seconds
_RATE_LIMIT_MAX    = 120  # requests per window per IP (general)
_LOGIN_RATE_MAX    = 10   # login attempts per window per IP

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # Use X-Forwarded-For when behind a proxy (Render, Nginx, etc.)
    forwarded = request.headers.get("X-Forwarded-For", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "unknown"
    )
    path = request.url.path
    now  = time.time()

    # Choose limit
    is_login = path in ("/api/auth/login", "/api/superadmin/login")
    limit    = _LOGIN_RATE_MAX if is_login else _RATE_LIMIT_MAX

    # Clean old entries
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < _RATE_LIMIT_WINDOW]

    if len(_rate_store[ip]) >= limit:
        return JSONResponse(
            status_code=429,
            content={"success": False, "message": "Too many requests. Please wait and try again."}
        )

    _rate_store[ip].append(now)
    return await call_next(request)


# ── Request logging ───────────────────────────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    try:
        response = await call_next(request)
        ms = round((time.time() - start) * 1000)
        logger.info(f"{request.method} {request.url.path} → {response.status_code} ({ms}ms)")
        return response
    except HTTPException:
        # Let FastAPI's HTTPException handler build the proper status/JSON
        # (e.g. the 503 from superadmin stats on DB failure). Swallowing it
        # here turns every deliberate error into a misleading 500.
        raise
    except Exception as e:
        logger.error(f"Unhandled: {request.method} {request.url.path} — {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "message": "An unexpected error occurred."}
        )


# ── Global error handlers ─────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exc_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"success": False, "message": "An unexpected error occurred."}
    )

@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "message": exc.detail}
    )


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    import os as _os
    from database import fetch_one, get_supabase_client
    db_ok = False
    try:
        await fetch_one("organizations", {})
        db_ok = True
    except Exception:
        pass
    client = await get_supabase_client()
    gemini_ok = bool(_os.getenv("GEMINI_API_KEY","").strip())
    return {
        "status":      "healthy" if db_ok else "degraded",
        "service":     "Hulu Stock API",
        "version":     "1.0.0",
        "environment": ENVIRONMENT,
        "database":    "connected" if db_ok else "disconnected",
        "supabase":    "connected" if client else "disconnected",
        "gemini":      "configured" if gemini_ok else "not configured",
        "jwt_secret":  "set" if _os.getenv("JWT_SECRET") else "using fallback",
    }

@app.api_route("/api/health/ping", methods=["GET", "HEAD"])
async def ping():
    return {"ok": True}


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router,          prefix="/api/auth",          tags=["Auth"])
app.include_router(organizations.router, prefix="/api/organizations",  tags=["Organizations"])
app.include_router(branches.router,      prefix="/api/branches",       tags=["Branches"])
app.include_router(users.router,         prefix="/api/users",          tags=["Users"])
app.include_router(categories.router,    prefix="/api/categories",     tags=["Categories"])
app.include_router(suppliers.router,     prefix="/api/suppliers",      tags=["Suppliers"])
app.include_router(items.router,         prefix="/api/items",          tags=["Items"])
app.include_router(sales.router,         prefix="/api/sales",          tags=["Sales"])
app.include_router(reports.router,       prefix="/api/reports",        tags=["Reports"])
app.include_router(bank_accounts.router, prefix="/api/bank-accounts",  tags=["Bank Accounts"])
app.include_router(expenses.router,      prefix="/api/expenses",       tags=["Expenses"])
app.include_router(dashboard.router,     prefix="/api/dashboard",      tags=["Dashboard"])
app.include_router(notifications.router, prefix="/api/notifications",  tags=["Notifications"])
app.include_router(superadmin.router,    prefix="/api/superadmin",     tags=["Super Admin"])
app.include_router(push.router,          prefix="/api/push",            tags=["Push Notifications"])
app.include_router(vision.router,        prefix="/api/vision",          tags=["Vision AI"])
from routes import fast_scan
app.include_router(fast_scan.router,     prefix="/api/fast-scan",        tags=["Fast Scan"])

def _root_payload():
    return {"service": "Hulu Stock API", "version": "1.0.0", "health": "/api/health"}

@app.get("/")
async def root():
    return _root_payload()

@app.head("/")
async def root_head():
    return JSONResponse(status_code=200, content=None)

@app.options("/{full_path:path}")
async def cors_preflight(full_path: str):
    return JSONResponse(status_code=200, content={"ok": True})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=(ENVIRONMENT == "development"))
