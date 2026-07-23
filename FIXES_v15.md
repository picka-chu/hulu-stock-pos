# Hulu Stock v15 — Fix & Improvement Log

## Critical Crash Fixes

### BUG-1 — `backend/routes/dashboard.py` (App restart loop)
**Problem:** `client` variable was used on line 47 (timezone block) but not
assigned until line 67.  Every request to `/api/dashboard/stats` raised
`NameError: name 'client' is not defined` → HTTP 500 → frontend Promise.all
rejected → dashboard clicked nothing, app restart on Render.

**Fix:** Moved `client = await get_supabase_client()` to **before** the
timezone block (now line 33).  Also added `_safe_float` / `_safe_int` helpers
so `None` DB values no longer crash arithmetic.

---

### BUG-2 — `backend/routes/fast_scan.py` (Backend never starts)
**Problem:** `asyncio.coroutine()` was removed in Python 3.11.  The file used
`asyncio.coroutine(lambda: None)()` as a no-op placeholder (lines 559-562).
On Python 3.12 this raises `AttributeError` the moment the module is imported —
meaning the **whole backend refused to start**.

**Fix:** Replaced with a proper `async def _noop(): return None` coroutine.

---

## UX / Stability Fixes

### BUG-3 — `backend/main.py` + `database.py` (Logging conflict)
**Problem:** `main.py` used stdlib `logging` with `RotatingFileHandler`;
`database.py` used `loguru`. Both libraries fought over handlers causing
duplicate or missing log lines and making crash diagnosis much harder.

**Fix:** Unified to loguru only.  Added an `_InterceptHandler` bridge so
**all** stdlib loggers (uvicorn, httpx, supabase, FastAPI) also route into
loguru — one clean stream, one format.

---

### BUG-4 — `frontend/assets/js/app.js` (Dashboard clicks frozen)
**Problem:** `loadDashboardData()` used `Promise.all` with per-call `.catch`
fallbacks.  When BUG-1 made the stats endpoint crash with 500, the
`APIService.request()` method re-threw the error and the outer `try/catch`
stopped execution mid-render, leaving the UI in a frozen skeleton state.
All click handlers were still attached but the app appeared dead.

**Fix:**
1. Each `Promise.all` call now has its own `.catch` that logs a warning and
   returns an empty default — the dashboard always renders, even with zero data.
2. DOM writes wrapped in individual `try/catch` so a missing element never
   propagates.
3. (Root cause fixed by BUG-1 — the 500 no longer happens.)

---

## Deployment Fixes

### BUG-5 — `frontend/sw.js` (Stale cached JS after deploy)
**Problem:** Service worker cached JS/CSS by URL with no version bump.
After deploying a fix, users (and the developer) were still running the old
broken code from the browser cache.

**Fix:** Bumped `SW_VERSION` from `xpos-sw-v6` to `xpos-sw-v15`.  On next
load the new SW activates, removes all `xpos-sw-v6` / older caches, and
re-fetches fresh assets.  **Remember to bump this string on every future deploy.**

---

### BUG-6 — `backend/main.py` (Crash on Render/Heroku startup)
**Problem:** `logging.handlers.RotatingFileHandler("app.log", ...)` tried to
create a file in the current working directory.  On Render and most PaaS
platforms the filesystem is **read-only** → `PermissionError` before the first
request was ever served.

**Fix:** Removed the file handler entirely.  All log output goes to stdout
which the platform captures automatically.  `LOG_LEVEL` env var controls
verbosity (default `INFO`).

---

## Security Fixes

### BUG-8 — `frontend/assets/js/config.js` (Supabase key hardcoded)
**Problem:** The Supabase anon JWT (`eyJhbGci…`) was hardcoded in plain text in
`config.js`, committed to version control, and visible to anyone who opened
DevTools.

**Fix:** `SUPABASE_KEY` is now read from (in priority order):
1. Build-time env variable `__SUPABASE_KEY__` (Vite / Cloudflare Pages)
2. `window.__SUPABASE_KEY__` injected by server-rendered HTML
3. Empty string (graceful degradation — push notifications disabled, everything
   else works)

**Action required:** Rotate your Supabase anon key in
*Dashboard → Settings → API → Rotate anon key* immediately, since the old key
was committed to source.

---

## Additional Improvements

- **`api.js`:** Added explicit 429 handler with user-friendly message.
  Server error (5xx) responses now attempt to extract and forward the server's
  own error message before falling back to a generic string.
- **`requirements.txt`:** All packages now have minimum version pins for
  reproducible installs.  `asyncpg` and `sqlalchemy` retained as they may be
  needed for future direct Postgres access.
- **`dashboard.py`:** Input validation on `days`, `limit` query params
  (clamped to sane ranges) to prevent accidental DoS via huge queries.
- **`fast_scan.py`:** `_noop()` is documented and clearly named; all
  try/except blocks log at the correct level.
