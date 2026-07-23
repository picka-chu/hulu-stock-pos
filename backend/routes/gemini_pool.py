"""
Shared Gemini Key Pool — used by both vision.py and fast_scan.py.
All keys are rotated from a single shared pool so a 429 on key #1
from vision.py is visible to fast_scan.py and vice versa.
"""
import os, time, asyncio, logging
from typing import Optional

logger = logging.getLogger("gemini_pool")

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiKey:
    def __init__(self, key: str, idx: int):
        self.key            = key
        self.idx            = idx
        self.hits_429       = 0
        self.cooldown_until = 0.0

    @property
    def available(self) -> bool:
        return bool(self.key) and time.time() > self.cooldown_until

    def mark_429(self):
        self.hits_429 += 1
        self.cooldown_until = time.time() + 3600
        logger.warning(f"[GeminiPool] Key #{self.idx} 429 — cooldown 60 min")

    def __repr__(self):
        return f"Key#{self.idx}(ok={self.available},hits={self.hits_429})"


def _load_keys() -> list:
    raw = [
        os.getenv("GEMINI_API_KEY",   "").strip(),
        os.getenv("GEMINI_API_KEY_2", "").strip(),
        os.getenv("GEMINI_API_KEY_3", "").strip(),
        os.getenv("GEMINI_API_KEY_4", "").strip(),
    ]
    keys = [GeminiKey(k, i + 1) for i, k in enumerate(raw) if k]
    logger.info(f"[GeminiPool] {len(keys)} key(s) loaded")
    return keys


_KEYS: list = _load_keys()
_idx   = 0
_lock  = asyncio.Lock()


async def get_active_key() -> Optional[GeminiKey]:
    """Return the best available key, rotating on 429 hits."""
    global _idx
    async with _lock:
        if not _KEYS:
            return None
        for offset in range(len(_KEYS)):
            k = _KEYS[(_idx + offset) % len(_KEYS)]
            if k.available:
                _idx = _KEYS.index(k)
                return k
        # All on cooldown — use the one whose cooldown expires soonest
        best = min(_KEYS, key=lambda k: k.cooldown_until)
        logger.error("[GeminiPool] All keys on cooldown — using least-cooled key")
        _idx = _KEYS.index(best)
        return best


async def rotate_after_429(key: GeminiKey):
    """Mark key as throttled and advance the index."""
    global _idx
    key.mark_429()
    async with _lock:
        _idx = (_idx + 1) % max(len(_KEYS), 1)


def key_count() -> int:
    return len(_KEYS)


def keys_status(current_idx: int) -> list:
    now = time.time()
    return [
        {
            "index":                k.idx,
            "available":            k.available,
            "hits_429":             k.hits_429,
            "cooldown_seconds_left": max(0, int(k.cooldown_until - now)),
            "is_current":           (_KEYS.index(k) == _idx),
        }
        for k in _KEYS
    ]
