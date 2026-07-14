"""In-memory cache for artist name → browseId mappings.

Populated automatically by parsers when they encounter artists WITH IDs.
Used to restore missing IDs when the same artist appears without one.

TTL:1 hour per entry, extended on every access (lazy renewal).
Max entries: 5000. Evicts oldest 10% when full.
Thread-safe: Python GIL protects dict operations.
"""
import time

_TTL = 3600  # 1 hour
_MAX_ENTRIES = 5000
_EVICT_BATCH = 500  # remove 10% at a time
_cache: dict[str, tuple[str, float]] = {}  # normalized_name → (browseId, expires_at)

SEPARATORS = ("&", "и", ",", ";")


def _normalize(name: str) -> str:
    return name.strip().lower()


def _evict() -> None:
    """Remove oldest entries (by expires_at) when cache is full."""
    now = time.time()
    # Sort by expiry time, remove batch of oldest
    sorted_keys = sorted(_cache, key=lambda k: _cache[k][1])
    to_remove = sorted_keys[:_EVICT_BATCH]
    for key in to_remove:
        del _cache[key]


def store(name: str, browse_id: str) -> None:
    """Store artist name → browseId in cache."""
    if not name or not browse_id:
        return
    key = _normalize(name)
    if key:
        if len(_cache) >= _MAX_ENTRIES:
            _evict()
        _cache[key] = (browse_id, time.time() + _TTL)


def lookup(name: str) -> str | None:
    """Look up browseId by artist name. Extends TTL on hit. Returns None if miss."""
    if not name:
        return None
    key = _normalize(name)
    entry = _cache.get(key)
    if entry and entry[1] > time.time():
        # Extend TTL on access
        _cache[key] = (entry[0], time.time() + _TTL)
        return entry[0]
    if entry:
        del _cache[key]  # expired
    return None


def lookup_with_separators(name: str) -> str | None:
    """Look up by name, also trying parts if name contains separators (&, и, etc.)."""
    # Direct lookup first
    direct = lookup(name)
    if direct:
        return direct
    # Try splitting by separators
    for sep in SEPARATORS:
        if sep in name:
            parts = [p.strip() for p in name.split(sep) if p.strip()]
            for part in parts:
                found = lookup(part)
                if found:
                    return found
    return None


def split_artists(name: str) -> list[str] | None:
    """Split combined artist name by separators. Returns None if no separator found."""
    for sep in SEPARATORS:
        if sep in name:
            parts = [p.strip() for p in name.split(sep) if p.strip()]
            return parts if len(parts) > 1 else None
    return None


def resolve_artists(name: str, browse_id: str | None) -> list[dict]:
    """Resolve artist name to list of {name, id} entries.
    
    If browse_id is present, stores in cache and returns single entry.
    If no browse_id, tries splitting combined name and looking up each part.
    """
    if browse_id:
        store(name, browse_id)
        return [{"name": name, "id": browse_id}]
    
    parts = split_artists(name)
    if parts:
        return [{"name": p, "id": lookup_with_separators(p)} for p in parts]
    
    return [{"name": name, "id": lookup_with_separators(name)}]
