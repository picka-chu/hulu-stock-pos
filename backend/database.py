"""
Database Configuration and Connection Management
Supabase REST/Client-based database access
Production-ready, async-friendly, safe for Render or mobile networks
With robust error handling and connection pooling
"""
import os
import asyncio
import re
from urllib.parse import urlparse
from typing import Optional, List, Dict
from uuid import UUID
from datetime import datetime
from loguru import logger
from supabase import create_client, Client

# ---------------------------
# Environment / Config
# ---------------------------
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
# Accept the repo's historical name plus Supabase's current server-side secret name.
SUPABASE_SERVICE_KEY = (
    os.getenv("SUPABASE_SERVICE_KEY")
    or os.getenv("SUPABASE_SECRET_KEY")
    or os.getenv("SUPABASE_KEY")
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or ""
).strip()

# Offline/demo mode flag
OFFLINE_MODE = False

# Connection state
_connection_initialized = False
_connection_error_count = 0
_last_connection_error: Optional[str] = None
MAX_CONNECTION_ERRORS = 5

# Global Supabase admin client (service role - bypasses RLS)
_supabase_admin: Optional[Client] = None
_client_lock = asyncio.Lock()

# ---------------------------
# Initialization helpers
# ---------------------------
async def get_supabase_client() -> Optional[Client]:
    """Get Supabase admin client with service role key (bypasses RLS)."""
    global _supabase_admin, OFFLINE_MODE, _connection_initialized, _connection_error_count, _last_connection_error
    
    if _supabase_admin:
        return _supabase_admin

    async with _client_lock:
        if _supabase_admin:
            return _supabase_admin

        logger.info(f"[DB] Initializing Supabase admin client (service role)...")
        logger.info(f"[DB] SUPABASE_URL set: {bool(SUPABASE_URL)}")
        logger.info(f"[DB] SUPABASE_SERVICE_KEY set: {bool(SUPABASE_SERVICE_KEY)}")
        # Safe key-shape log (never logs the key itself): tells anon vs
        # service_role vs new opaque sb_secret_ format apart from Render logs.
        try:
            import base64 as _b64
            import json as _json
            _k = SUPABASE_SERVICE_KEY.strip()
            if _k.startswith("sb_secret_"):
                logger.info("[DB] key_format=opaque-secret (new Supabase secret key)")
            elif _k.startswith("sb_publishable_"):
                logger.error("[DB] key_role=ANON (publishable key) — this key is subject to RLS and WILL get 403. Use the service_role secret instead.")
            elif _k.count(".") == 2:
                _payload = _k.split(".")[1]
                _payload += "=" * (-len(_payload) % 4)
                _role = _json.loads(_b64.urlsafe_b64decode(_payload).decode()).get("role", "?")
                logger.info(f"[DB] key_role={_role}")
                if _role != "service_role":
                    logger.error("[DB] Configured key is NOT service_role — PostgREST calls will get 403 permission denied. Paste the service_role secret into SUPABASE_SERVICE_KEY.")
            else:
                logger.warning("[DB] key_format=unrecognized — verify it is the service_role secret from Supabase Settings → API.")
        except Exception:
            pass

        parsed = urlparse(SUPABASE_URL)
        if parsed.hostname:
            logger.info(f"[DB] Supabase host: {parsed.hostname}")
        if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
            _last_connection_error = "Supabase environment variables are missing"
            logger.error("[DB] Missing SUPABASE_URL or server-side Supabase key")
            OFFLINE_MODE = True
            return None
        if parsed.scheme not in ("http", "https") or not parsed.hostname or "YOUR_PROJECT" in parsed.hostname:
            _last_connection_error = "SUPABASE_URL is invalid; use https://<project-ref>.supabase.co"
            logger.error("[DB] Invalid SUPABASE_URL configuration")
            OFFLINE_MODE = True
            return None
        if parsed.path not in ("", "/") or parsed.query or parsed.port:
            _last_connection_error = "SUPABASE_URL must be the bare project URL https://<project-ref>.supabase.co (no path, query, or port)"
            logger.error(f"[DB] SUPABASE_URL has unexpected path/query/port: {SUPABASE_URL!r}. Use the bare https://<project-ref>.supabase.co from Supabase Settings → API.")
            OFFLINE_MODE = True
            return None

        try:
            _supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
            _connection_initialized = True
            _connection_error_count = 0
            logger.success("Supabase admin client initialized successfully (bypasses RLS)")
        except Exception as e:
            _last_connection_error = str(e)
            logger.error(f"Failed to initialize Supabase admin client: {e}")
            import traceback
            logger.error(traceback.format_exc())
            OFFLINE_MODE = True
            _supabase_admin = None
            _connection_error_count += 1

        return _supabase_admin


async def reset_connection():
    """Reset the database connection without recursively acquiring the same lock."""
    global _supabase_admin, OFFLINE_MODE, _connection_error_count, _last_connection_error
    async with _client_lock:
        logger.info("[DB] Resetting database connection...")
        _supabase_admin = None
        OFFLINE_MODE = False
        _connection_error_count = 0
        _last_connection_error = None

    # Reconnect after releasing the lock; get_supabase_client() acquires it.
    await get_supabase_client()


def get_last_connection_error() -> Optional[str]:
    """Return the latest Supabase connection/configuration error for API diagnostics."""
    return _last_connection_error


def is_offline_mode() -> bool:
    """Check if offline mode is enabled"""
    return OFFLINE_MODE


# ---------------------------
# CRUD helpers with error handling
# ---------------------------
async def fetch_one(table: str, filters: Optional[Dict[str, any]] = None) -> Optional[dict]:
    """Fetch a single row from a table with optional filters."""
    global _connection_error_count, _last_connection_error
    _last_connection_error = None
    
    if OFFLINE_MODE:
        _last_connection_error = "Database is in offline mode"
        logger.warning(f"Offline mode: fetch_one skipped for table '{table}'")
        return None

    client = await get_supabase_client()
    if not client:
        _last_connection_error = _last_connection_error or "Supabase client unavailable"
        logger.error("[DB] No Supabase client available")
        return None

    query = client.table(table).select("*").limit(1)
    if filters:
        if not isinstance(filters, dict):
            logger.error(f"fetch_one expected dict for filters, got {type(filters)}")
            return None
        for k, v in filters.items():
            query = query.eq(k, v)

    try:
        response = await asyncio.to_thread(lambda: query.execute())
        _connection_error_count = 0
        if response.data:
            return _convert_uuids_to_strings(response.data[0])
        return None
    except Exception as e:
        _connection_error_count += 1
        _last_connection_error = str(e)
        logger.error(f"fetch_one failed on table '{table}': {e}")
        
        # Try to reset connection if too many errors
        if _connection_error_count >= MAX_CONNECTION_ERRORS:
            logger.warning(f"[DB] Too many connection errors ({_connection_error_count}), attempting reset")
            asyncio.create_task(reset_connection())
        
        import traceback
        logger.error(traceback.format_exc())
        return None


async def fetch_all(table: str, filters: Optional[Dict[str, any]] = None) -> List[dict]:
    """Fetch all rows from a table, optionally filtered."""
    global _connection_error_count
    
    if OFFLINE_MODE:
        logger.warning(f"Offline mode: fetch_all skipped for table '{table}'")
        return []

    client = await get_supabase_client()
    if not client:
        return []

    query = client.table(table).select("*")
    if filters:
        if not isinstance(filters, dict):
            logger.error(f"fetch_all expected dict for filters, got {type(filters)}")
            return []
        for k, v in filters.items():
            query = query.eq(k, v)

    try:
        response = await asyncio.to_thread(lambda: query.execute())
        
        # Reset error count on successful query
        _connection_error_count = 0
        
        return [_convert_uuids_to_strings(record) for record in (response.data or [])]
    except Exception as e:
        _connection_error_count += 1
        logger.error(f"fetch_all failed on table '{table}': {e}")
        
        if _connection_error_count >= MAX_CONNECTION_ERRORS:
            logger.warning(f"[DB] Too many connection errors ({_connection_error_count}), attempting reset")
            asyncio.create_task(reset_connection())
            
        return []


async def insert_one(table: str, data: dict) -> Optional[dict]:
    """Insert a single row into a table."""
    global _connection_error_count
    
    if OFFLINE_MODE:
        logger.warning(f"Offline mode: insert_one skipped for table '{table}'")
        return None

    client = await get_supabase_client()
    if not client:
        logger.error(f"insert_one failed: No Supabase client available for table '{table}'")
        return None

    try:
        # Convert UUID / date / datetime objects to strings — Supabase cannot serialize them
        from datetime import date as _date, datetime as _datetime
        processed_data = {}
        for k, v in data.items():
            if isinstance(v, UUID):
                processed_data[k] = str(v)
            elif isinstance(v, _datetime):
                processed_data[k] = v.isoformat()
            elif isinstance(v, _date):
                processed_data[k] = v.isoformat()
            else:
                processed_data[k] = v

        response = await asyncio.to_thread(lambda: client.table(table).insert(processed_data).execute())
        _connection_error_count = 0
        if response.data:
            return _convert_uuids_to_strings(response.data[0])
        return None
    except Exception as e:
        _connection_error_count += 1
        logger.error(f"insert_one failed on table '{table}': {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        
        if _connection_error_count >= MAX_CONNECTION_ERRORS:
            logger.warning(f"[DB] Too many connection errors ({_connection_error_count}), attempting reset")
            asyncio.create_task(reset_connection())
            
        return None


async def update_one(table: str, data: dict, filters: dict) -> Optional[dict]:
    """Update a single row matching filters."""
    global _connection_error_count
    
    if OFFLINE_MODE:
        logger.warning(f"Offline mode: update_one skipped for table '{table}'")
        return None

    client = await get_supabase_client()
    if not client:
        logger.error(f"update_one failed: No Supabase client available for table '{table}'")
        return None

    # Convert UUID / date / datetime objects to strings — Supabase cannot serialize them
    from datetime import date as _date, datetime as _datetime
    processed_data = {}
    for k, v in data.items():
        if isinstance(v, UUID):
            processed_data[k] = str(v)
        elif isinstance(v, _datetime):
            processed_data[k] = v.isoformat()
        elif isinstance(v, _date):
            processed_data[k] = v.isoformat()   # "YYYY-MM-DD"
        else:
            processed_data[k] = v

    query = client.table(table).update(processed_data)
    for k, v in filters.items():
        filter_value = str(v) if isinstance(v, UUID) else v
        query = query.eq(k, filter_value)

    try:
        response = await asyncio.to_thread(lambda: query.execute())
        _connection_error_count = 0
        if response.data:
            return _convert_uuids_to_strings(response.data[0])
        return None
    except Exception as e:
        _connection_error_count += 1
        logger.error(f"update_one failed on table '{table}': {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        
        if _connection_error_count >= MAX_CONNECTION_ERRORS:
            logger.warning(f"[DB] Too many connection errors ({_connection_error_count}), attempting reset")
            asyncio.create_task(reset_connection())
            
        return None


async def delete_one(table: str, filters: dict) -> bool:
    """Delete a row matching filters."""
    global _connection_error_count
    
    if OFFLINE_MODE:
        logger.warning(f"Offline mode: delete_one skipped for table '{table}'")
        return False

    client = await get_supabase_client()
    if not client:
        logger.error(f"delete_one failed: No Supabase client available for table '{table}'")
        return False

    query = client.table(table).delete()
    for k, v in filters.items():
        query = query.eq(k, v)

    try:
        await asyncio.to_thread(lambda: query.execute())
        _connection_error_count = 0
        return True
    except Exception as e:
        _connection_error_count += 1
        logger.error(f"delete_one failed on table '{table}': {e}")
        import traceback
        logger.error(traceback.format_exc())
        
        if _connection_error_count >= MAX_CONNECTION_ERRORS:
            logger.warning(f"[DB] Too many connection errors ({_connection_error_count}), attempting reset")
            asyncio.create_task(reset_connection())
            
        return False


# ---------------------------
# Utility functions
# ---------------------------
def _convert_uuids_to_strings(obj):
    """Recursively convert UUID objects to strings in a dict/list."""
    if isinstance(obj, dict):
        return {k: _convert_uuids_to_strings(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_convert_uuids_to_strings(item) for item in obj]
    elif isinstance(obj, UUID):
        return str(obj)
    elif isinstance(obj, datetime):
        return obj.isoformat()
    else:
        return obj


def enable_offline_mode():
    """Force offline/demo mode (no DB)."""
    global OFFLINE_MODE
    OFFLINE_MODE = True
    logger.warning("Offline mode enabled. Database operations will be skipped.")


async def execute_rpc(function_name: str, params: dict = None) -> any:
    """
    Execute a Supabase PostgreSQL RPC (stored function).
    Used for complex queries like aggregates, JOINs, etc.
    """
    global _connection_error_count

    if OFFLINE_MODE:
        logger.warning(f"Offline mode: execute_rpc skipped for '{function_name}'")
        return None

    client = await get_supabase_client()
    if not client:
        logger.error(f"execute_rpc failed: No Supabase client available")
        return None

    try:
        rpc_params = params or {}
        # Convert UUID objects to strings
        processed = {k: str(v) if isinstance(v, UUID) else v for k, v in rpc_params.items()}
        logger.info(f"[DB] execute_rpc: function={function_name}, params={processed}")
        response = await asyncio.to_thread(lambda: client.rpc(function_name, processed).execute())
        _connection_error_count = 0
        return response.data
    except Exception as e:
        _connection_error_count += 1
        logger.error(f"execute_rpc failed for '{function_name}': {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None


# ---------------------------
# Audit Logging
# ---------------------------
async def log_audit(
    organization_id: str,
    user_id: str,
    action: str,
    entity_type: str,
    entity_id: str = None,
    details: dict = None,
    branch_id: str = None,
):
    """Log a sensitive action to the activity_logs table."""
    try:
        await insert_one("activity_logs", {
            "id": str(__import__("uuid").uuid4()),
            "organization_id": organization_id,
            "user_id": user_id,
            "branch_id": branch_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "details": details or {},
        })
    except Exception as e:
        logger.warning(f"[AUDIT] Failed to log {action}: {e}")


async def close_client():
    """
    Graceful shutdown handler.
    Supabase REST client does not require manual closing.
    This exists for architectural consistency.
    """
    global _supabase_admin
    _supabase_admin = None
    logger.info("Database client closed")



# ---------------------------
# Supabase Storage Helpers
# ---------------------------
async def upload_file_to_storage(
    bucket_name: str,
    file_path: str,
    file_content: bytes,
    content_type: str
) -> Optional[str]:
    """Upload a file to Supabase Storage. Returns public URL or None."""
    client = await get_supabase_client()
    if not client:
        logger.error("[Storage] No Supabase client available")
        return None
    try:
        client.storage.from_(bucket_name).upload(
            path=file_path,
            file=file_content,
            file_options={"content-type": content_type, "upsert": "true"}
        )
        public_url = client.storage.from_(bucket_name).get_public_url(file_path)
        logger.info(f"[Storage] Uploaded: {file_path}")
        return public_url
    except Exception as e:
        logger.error(f"[Storage] Upload failed: {e}")
        return None


async def delete_file_from_storage(bucket_name: str, file_path: str) -> bool:
    """Delete a file from Supabase Storage."""
    client = await get_supabase_client()
    if not client:
        return False
    try:
        client.storage.from_(bucket_name).remove([file_path])
        return True
    except Exception as e:
        logger.error(f"[Storage] Delete failed: {e}")
        return False
