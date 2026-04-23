"""Internal builder-task status registry (LangGraph → Gateway).

Companion to :mod:`internal_artifacts`. Receives terminal status snapshots
from the LangGraph service's subagent executor and caches them in an
in-memory registry so the channel manager's builder notifier can observe
completion/failure in Render's split-process topology (where the local
``_background_tasks`` dict on the Gateway is always empty for tasks
executed inside LangGraph).

Entries are lightweight — a few hundred bytes of status metadata plus an
optional ``builder_result`` dict — and auto-expire after a fixed TTL so
the registry never grows unbounded.

Not exposed to browsers or end users; bearer-token authentication uses
the same shared ``SOPHIA_INTERNAL_SECRET`` as the artifact router.
"""

from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

logger = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])

_INTERNAL_SECRET_ENV = "SOPHIA_INTERNAL_SECRET"

# TTL for cached builder task status entries. The channel notifier gives
# up waiting after BUILDER_NOTIFIER_MAX_WAIT_SECONDS (20 minutes); we keep
# entries a bit longer to absorb clock skew and let late log consumers
# correlate, then evict.
_REGISTRY_TTL_SECONDS = 30 * 60

# Hard cap on the number of entries to bound memory on busy deployments.
_REGISTRY_MAX_ENTRIES = 2048

_registry: dict[str, dict[str, Any]] = {}
_registry_lock = threading.Lock()


def _load_secret() -> str | None:
    val = os.getenv(_INTERNAL_SECRET_ENV, "").strip()
    return val if val else None


def _constant_time_compare(a: str, b: str) -> bool:
    """Constant-time string equality backed by :func:`hmac.compare_digest`.

    ``hmac.compare_digest`` is the standard hardened comparator in the
    stdlib and avoids timing side-channels a naive Python loop can leak.
    """
    return hmac.compare_digest(a, b)


def _require_secret(request: Request) -> None:
    secret = _load_secret()
    if not secret:
        raise HTTPException(
            status_code=503, detail="Internal builder-task registry not configured"
        )
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    provided = auth[len("Bearer "):].strip()
    if not _constant_time_compare(provided, secret):
        raise HTTPException(status_code=401, detail="Invalid bearer token")


def _prune_expired_locked(now: float) -> None:
    """Drop entries older than the TTL. Caller must hold the lock."""
    cutoff = now - _REGISTRY_TTL_SECONDS
    stale = [
        key
        for key, entry in _registry.items()
        if entry.get("received_at", 0.0) < cutoff
    ]
    for key in stale:
        _registry.pop(key, None)

    # If we're still over the cap, evict the oldest entries first.
    if len(_registry) > _REGISTRY_MAX_ENTRIES:
        ordered = sorted(_registry.items(), key=lambda kv: kv[1].get("received_at", 0.0))
        overflow = len(_registry) - _REGISTRY_MAX_ENTRIES
        for key, _ in ordered[:overflow]:
            _registry.pop(key, None)


def get_pushed_builder_task(task_id: str) -> dict[str, Any] | None:
    """Return the cached status payload for ``task_id``, or ``None``.

    Entries older than the TTL are evicted lazily on access. This is the
    read hook the channel notifier consults before (and in addition to)
    its local process-memory executor store.
    """
    if not isinstance(task_id, str) or not task_id:
        return None
    now = time.monotonic()
    with _registry_lock:
        _prune_expired_locked(now)
        entry = _registry.get(task_id)
        if entry is None:
            return None
        # Return a shallow copy so callers can mutate freely.
        return dict(entry)


def clear_registry() -> None:
    """Drop all cached entries. Intended for tests and graceful shutdown."""
    with _registry_lock:
        _registry.clear()


@router.post("/internal/builder_tasks/{task_id}", status_code=204)
async def push_builder_task_status(
    request: Request,
    task_id: str,
) -> Response:
    """Accept a terminal (or progress) status snapshot from LangGraph.

    The request body is a JSON object. We don't enforce a strict schema
    beyond requiring ``task_id`` in the URL: the canonical producer is
    ``deerflow.sophia.storage.gateway_notify`` and consumers tolerate
    missing fields. Extra keys are preserved verbatim so we can evolve
    the payload shape without breaking either side.
    """
    _require_secret(request)

    if not task_id or not task_id.strip():
        raise HTTPException(status_code=400, detail="task_id is required")

    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object")

    entry = dict(payload)
    entry["task_id"] = task_id
    entry["received_at"] = time.monotonic()

    with _registry_lock:
        _registry[task_id] = entry
        _prune_expired_locked(entry["received_at"])

    logger.info(
        "Cached pushed builder task status: task_id=%s status=%s has_result=%s",
        task_id,
        payload.get("status"),
        isinstance(payload.get("builder_result"), dict),
    )
    return Response(status_code=204)
