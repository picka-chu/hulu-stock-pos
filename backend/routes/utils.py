# routes/utils.py — utility helpers (no exposed endpoints)
"""Shared report/query helpers: org-timezone date windows and PostgREST paging."""
import asyncio
from datetime import date, datetime, timezone as _dtz, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from database import fetch_one

# Ethiopia has no DST; EAT = UTC+3 year-round. Used when an org has no
# timezone set — sales bucketed in UTC push 21:00–23:59 sales to the next day.
DEFAULT_TIMEZONE = "Africa/Addis_Ababa"
_EAT = _dtz(timedelta(hours=3))  # fixed-offset fallback needing no tz database


def _safe_zone(name):
    """Resolve an IANA name, falling back to Addis, then to fixed UTC+3
    (never raises — a missing tzdata package must not 500 every report)."""
    for cand in (name, DEFAULT_TIMEZONE):
        if cand:
            try:
                return ZoneInfo(cand)
            except (ZoneInfoNotFoundError, ValueError, Exception):
                continue
    return _EAT


async def _org_zone(org_id) -> ZoneInfo:
    """Resolve the organization's IANA timezone (fallback: Addis Ababa)."""
    try:
        org = await fetch_one("organizations", {"id": str(org_id)})
        name = (org or {}).get("timezone")
    except Exception:
        name = None
    return _safe_zone(name)


def _utc_window(start_date: date, end_date: date, tz: ZoneInfo):
    """[local-day start, local-day end] as UTC ISO strings for created_at filters."""
    lo = datetime.combine(start_date, datetime.min.time(), tzinfo=tz).astimezone(_dtz.utc).isoformat()
    hi = datetime.combine(end_date, datetime.max.time(), tzinfo=tz).astimezone(_dtz.utc).isoformat()
    return lo, hi


def _local_day(ts, tz: ZoneInfo) -> str:
    """created_at → local calendar day (YYYY-MM-DD); '' when unparseable."""
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dtz.utc)
    return dt.astimezone(tz).date().isoformat()


def _local_month(ts, tz: ZoneInfo) -> str:
    d = _local_day(ts, tz)
    return d[:7]


async def _select_paged(client, table: str, build, order_field: str = "created_at", max_rows: int = 100000):
    """Page through a PostgREST query (1000-row response cap).

    `build(q)` must apply only filters; ordering and range are added here so
    pagination is deterministic (unordered range() can repeat/skip rows).
    """
    rows, offset, size = [], 0, 1000
    while offset < max_rows:
        q = build(client.table(table)).order(order_field)
        resp = await asyncio.to_thread(lambda q=q: q.range(offset, offset + size - 1).execute())
        chunk = resp.data or []
        rows.extend(chunk)
        if len(chunk) < size:
            break
        offset += size
    return rows
