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
import zipfile
from io import BytesIO
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
_PPTX_MIN_BYTES = 1024
_PPTX_REQUIRED_ZIP_ENTRIES = frozenset({
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
})


def _pptx_integrity_error(content: bytes) -> str | None:
    if len(content) < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            entries = set(archive.namelist())
    except zipfile.BadZipFile:
        return "pptx_not_zip"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return f"pptx_missing_entries:{','.join(missing)}"
    return None


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
) -> str:
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
        return "not_configured"
    if not thread_id or not outputs_host_path:
        return "skipped"

    resolved = _resolved_mirror_paths(host_path, outputs_host_path)
    if resolved is None:
        return "skipped"
    host_file, outputs_root = resolved

    # Only mirror files inside the outputs directory
    if not _is_output_file(host_file, outputs_root):
        return "skipped"

    try:
        content = host_file.read_bytes()
    except OSError as exc:
        logger.warning("Mirror skipped; read error path=%s error=%s", host_file, exc)
        return "failed_best_effort"

    relative = host_file.relative_to(outputs_root).as_posix()
    if not _valid_mirror_artifact(thread_id, relative, host_file, content):
        return "skipped"

    file_hash = hashlib.sha256(content).hexdigest()
    cache_key = (thread_id, relative)

    if _MIRROR_HASH_CACHE.get(cache_key) == file_hash:
        logger.debug("Mirror dedup; unchanged file thread_id=%s path=%s", thread_id, relative)
        return "uploaded"

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
        return "uploaded"
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning(
            "Mirror upload failed; continuing without remote copy thread_id=%s path=%s error=%s",
            thread_id,
            relative,
            exc,
        )
        return "failed_best_effort"


def _valid_mirror_artifact(thread_id: str, relative: str, host_file: Path, content: bytes) -> bool:
    if host_file.suffix.lower() != ".pptx":
        return True
    integrity_error = _pptx_integrity_error(content)
    if integrity_error is None:
        return True
    logger.warning(
        "Mirror skipped; invalid pptx thread_id=%s path=%s reason=%s bytes=%d",
        thread_id,
        relative,
        integrity_error,
        len(content),
    )
    return False


def _resolved_mirror_paths(host_path: str, outputs_host_path: str) -> tuple[Path, Path] | None:
    try:
        return Path(host_path).resolve(), Path(outputs_host_path).resolve()
    except (OSError, ValueError) as exc:
        logger.debug("Mirror skipped; path resolution failed path=%s error=%s", host_path, exc)
        return None


def _is_output_file(host_file: Path, outputs_root: Path) -> bool:
    try:
        host_file.relative_to(outputs_root)
    except ValueError:
        return False
    return host_file.is_file()


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
