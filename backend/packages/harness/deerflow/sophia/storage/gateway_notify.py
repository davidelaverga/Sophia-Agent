"""Gateway builder-task status notifier (LangGraph → Gateway).

Companion to :mod:`gateway_mirror`. Push-on-complete client that POSTs a
terminal status snapshot from the LangGraph service's subagent executor
to the Gateway's internal ``builder_tasks`` registry. The Gateway channel
manager's builder notifier (which drives Telegram completion pings) reads
that registry instead of its own in-memory ``_background_tasks`` dict,
which is empty in Render's split-process topology because the subagent
actually runs inside the LangGraph process.

All calls are best-effort: if the required environment variables are
missing, or the HTTP request fails, we log and return ``False`` so the
builder flow never regresses.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class GatewayNotifyConfig:
    base_url: str
    secret: str


def _load_config() -> GatewayNotifyConfig | None:
    base_url = os.getenv("SOPHIA_GATEWAY_INTERNAL_URL", "").strip().rstrip("/")
    secret = os.getenv("SOPHIA_INTERNAL_SECRET", "").strip()
    if not base_url or not secret:
        return None
    return GatewayNotifyConfig(base_url=base_url, secret=secret)


def is_configured() -> bool:
    return _load_config() is not None


def notify_builder_task_status(
    task_id: str,
    payload: dict[str, Any],
    *,
    client: httpx.Client | None = None,
) -> bool:
    """POST a builder task status snapshot to the Gateway's internal registry.

    Args:
        task_id: The builder task identifier.
        payload: Terminal status payload. Expected keys:
            ``status`` (str), ``error`` (str | None),
            ``builder_result`` (dict | None), ``completed_at`` (str | None),
            ``trace_id`` (str | None), ``owner_id`` (str | None).
            Extra keys are preserved and forwarded verbatim.
        client: Optional ``httpx.Client`` for connection reuse.

    Returns:
        ``True`` when the Gateway acknowledged with HTTP 204, ``False``
        otherwise (including when the client is not configured).
    """
    config = _load_config()
    if config is None:
        return False

    if not isinstance(task_id, str) or not task_id.strip():
        logger.debug("Gateway notify skipped; empty task_id")
        return False

    url = f"{config.base_url}/internal/builder_tasks/{quote(task_id, safe='')}"
    headers = {
        "Authorization": f"Bearer {config.secret}",
        "Content-Type": "application/json",
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(url, json=payload, headers=headers)
    except Exception:
        logger.exception(
            "Gateway notify failed: task_id=%s url=%s", task_id, url
        )
        return False
    finally:
        if owns_client:
            http.close()

    ok = response.status_code == 204
    if not ok:
        logger.warning(
            "Gateway notify returned non-204: task_id=%s status=%s body=%s",
            task_id,
            response.status_code,
            response.text[:200],
        )
    else:
        logger.info(
            "Gateway notify succeeded: task_id=%s status=%s",
            task_id,
            payload.get("status"),
        )
    return ok
