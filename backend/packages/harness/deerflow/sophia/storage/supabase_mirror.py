"""Supabase mirror for every file written to the builder outputs directory.

PR-E (Phase 2.2): when ``SOPHIA_SUPABASE_MIRROR_ALL`` is set, every file the
builder writes under ``/mnt/user-data/outputs/`` is uploaded to Supabase
Storage as soon as it is written (or immediately after a ``bash`` tool call
that may have created files). Hash-based deduplication prevents re-uploading
unchanged files.

This module is best-effort — all errors are logged and swallowed so the
builder flow never regresses.
"""

from __future__ import annotations

import collections
import hashlib
import logging
import os
from pathlib import Path

from deerflow.sophia.storage import supabase_artifact_store

logger = logging.getLogger(__name__)

# Feature flag — set SOPHIA_SUPABASE_MIRROR_ALL=1 to enable.
# This gates the *automatic* tool-level hooks (write_file, str_replace, bash).
# Explicit callers (e.g. emit-time uploads) bypass the flag and proceed
# regardless so that final artifacts are always uploaded to Supabase.
_MIRROR_ENABLED = os.getenv("SOPHIA_SUPABASE_MIRROR_ALL", "").lower() in ("1", "true", "yes", "on")

# Bounded LRU hash cache: (thread_id, relative_path) -> sha256_hex.
# Max 1000 entries — enough for ~50 builder sessions; oldest evicted on overflow.
_MirrorHashCache = collections.OrderedDict
_MIRROR_HASH_CACHE: _MirrorHashCache[tuple[str, str], str] = _MirrorHashCache()
_MIRROR_CACHE_MAXSIZE = 1000


def _cache_set(key: tuple[str, str], file_hash: str) -> None:
    """Set a cache entry, evicting the oldest entry if at capacity."""
    cache = _MIRROR_HASH_CACHE
    if key in cache:
        cache.move_to_end(key)
    cache[key] = file_hash
    while len(cache) > _MIRROR_CACHE_MAXSIZE:
        cache.popitem(last=False)


def is_mirror_enabled() -> bool:
    """Return ``True`` when the mirror-all feature flag is active."""
    return _MIRROR_ENABLED


def maybe_mirror_file(
    host_path: str,
    thread_id: str,
    outputs_host_path: str | None,
) -> None:
    """Upload a single file to Supabase if it lives under the outputs directory.

    Uses SHA-256 hash deduplication so unchanged files are not re-uploaded.
    Silently no-ops when Supabase is not configured, the path is outside the
    outputs directory, or any error occurs.

    Note: this function does NOT check ``_MIRROR_ENABLED``. The feature flag
    gates the *automatic* tool-level hooks in ``sandbox/tools.py`` only.
    Explicit callers (e.g. emit-time uploads) always proceed so final artifacts
    are uploaded regardless of the incremental mirror setting.
    """
    if not supabase_artifact_store.is_configured():
        return
    if not thread_id or not outputs_host_path:
        return

    try:
        host_file = Path(host_path).resolve()
        outputs_root = Path(outputs_host_path).resolve()
    except (OSError, ValueError) as exc:
        logger.debug("Mirror skipped; path resolution failed path=%s error=%s", host_path, exc)
        return

    # Only mirror files inside the outputs directory
    try:
        host_file.relative_to(outputs_root)
    except ValueError:
        return

    if not host_file.is_file():
        return

    try:
        content = host_file.read_bytes()
    except OSError as exc:
        logger.warning("Mirror skipped; read error path=%s error=%s", host_file, exc)
        return

    file_hash = hashlib.sha256(content).hexdigest()
    relative = host_file.relative_to(outputs_root).as_posix()
    cache_key = (thread_id, relative)

    if _MIRROR_HASH_CACHE.get(cache_key) == file_hash:
        logger.debug("Mirror dedup; unchanged file thread_id=%s path=%s", thread_id, relative)
        return

    try:
        supabase_artifact_store.upload_artifact(
            thread_id=thread_id,
            filename=relative,
            content=content,
        )
        _cache_set(cache_key, file_hash)
        logger.info(
            "Mirrored builder output to Supabase: thread_id=%s path=%s bytes=%d hash=%.8s",
            thread_id,
            relative,
            len(content),
            file_hash,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning(
            "Mirror upload failed; continuing without remote copy thread_id=%s path=%s error=%s",
            thread_id,
            relative,
            exc,
        )


def scan_and_mirror_outputs(
    thread_id: str,
    outputs_host_path: str | None,
) -> None:
    """Walk the outputs directory and mirror every file that has changed.

    Called after ``bash_tool`` executions because shell commands may create
    or overwrite files without going through ``write_file_tool``.

    Note: this function does NOT check ``_MIRROR_ENABLED``. The caller
    (``bash_tool``) gates the feature flag so the incremental mirror is
    opt-in, but emit-time uploads always proceed regardless.
    """
    if not supabase_artifact_store.is_configured():
        return
    if not thread_id or not outputs_host_path:
        return

    try:
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return
    except (OSError, ValueError) as exc:
        logger.debug("Mirror scan skipped; bad outputs path=%s error=%s", outputs_host_path, exc)
        return

    for path in outputs_root.rglob("*"):
        if path.is_file():
            maybe_mirror_file(str(path), thread_id, outputs_host_path)


def invalidate_cache(thread_id: str) -> None:
    """Remove all cached hashes for a given thread_id.

    Useful when a builder session is explicitly reset or a new task starts
    within the same thread.
    """
    keys_to_remove = [key for key in _MIRROR_HASH_CACHE if key[0] == thread_id]
    for key in keys_to_remove:
        _MIRROR_HASH_CACHE.pop(key, None)
