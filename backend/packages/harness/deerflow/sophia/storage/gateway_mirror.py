"""Gateway artifact mirror client.

Best-effort replication of builder-generated files from the LangGraph service
to the Gateway service so the Gateway can serve download requests directly
from its own persistent disk. This is the primary transport for builder
artifacts in the Render split-disk topology; Supabase remains an optional
disaster-recovery fallback.

The client is a graceful no-op when the required environment variables are
missing, so local development and non-Render deployments keep working.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 15.0
_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    return relative or None


@dataclass(frozen=True)
class GatewayMirrorConfig:
    base_url: str
    secret: str


def _load_config() -> GatewayMirrorConfig | None:
    """Resolve mirror configuration from environment.

    Returns ``None`` when any required value is missing so callers can
    degrade silently.
    """
    base_url = os.getenv("SOPHIA_GATEWAY_INTERNAL_URL", "").strip().rstrip("/")
    secret = os.getenv("SOPHIA_INTERNAL_SECRET", "").strip()
    if not base_url or not secret:
        return None
    return GatewayMirrorConfig(base_url=base_url, secret=secret)


def is_configured() -> bool:
    """Return ``True`` when both env vars are present."""
    return _load_config() is not None


def _compute_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def mirror_artifact(
    thread_id: str,
    virtual_path: str,
    content: bytes,
    content_type: str | None = None,
    client: httpx.Client | None = None,
) -> bool:
    """Push a single artifact file to the Gateway's internal replicate endpoint.

    Args:
        thread_id: The thread identifier.
        virtual_path: Sandbox virtual path, e.g.
            ``/mnt/user-data/outputs/report.pdf``.
        content: Raw file bytes.
        content_type: MIME type for the Content-Type header.
        client: Optional ``httpx.Client`` for connection reuse.

    Returns:
        ``True`` on 2xx HTTP response, ``False`` on any failure (network,
        timeout, non-2xx). Failures are logged and swallowed.
    """
    config = _load_config()
    if config is None or not thread_id:
        return False

    rel = _extract_output_relative_path(virtual_path)
    if rel is None:
        logger.debug(
            "Artifact mirror skipped; path not under outputs: %s", virtual_path
        )
        return False

    encoded_path = quote(rel, safe="/")
    url = f"{config.base_url}/internal/artifacts/{quote(thread_id, safe='')}/{encoded_path}"
    headers: dict[str, str] = {
        "Authorization": f"Bearer {config.secret}",
        "Content-Type": content_type or "application/octet-stream",
        "X-Content-SHA256": _compute_sha256(content),
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(url, content=content, headers=headers)
    except Exception:
        logger.exception(
            "Artifact mirror failed: thread_id=%s path=%s url=%s",
            thread_id,
            virtual_path,
            url,
        )
        return False
    finally:
        if owns_client:
            http.close()

    ok = response.status_code == 204
    if not ok:
        logger.warning(
            "Artifact mirror returned non-204: thread_id=%s path=%s status=%s body=%s",
            thread_id,
            virtual_path,
            response.status_code,
            response.text[:200],
        )
    else:
        logger.info(
            "Artifact mirror succeeded: thread_id=%s path=%s bytes=%d",
            thread_id,
            virtual_path,
            len(content),
        )
    return ok


# Startup diagnostic — makes Render env-var propagation immediately observable.
_startup_cfg = _load_config()
logger.info(
    "gateway_mirror startup: configured=%s base_url=%s secret=%s",
    _startup_cfg is not None,
    getattr(_startup_cfg, "base_url", None),
    "set" if (_startup_cfg is not None and getattr(_startup_cfg, "secret", None)) else "missing",
)
