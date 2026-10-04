"""Content-free LangSmith health signals: ingest rejections and a startup preflight.

Everything logged here is a status code, an allowlisted error code, a class
name, a boolean, a count or an endpoint host. Response bodies, exception
messages, URLs with queries and key material are never logged; exception text
is only scanned for a status code or a ``^[a-z_]{1,64}$`` error code.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import Counter
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_ERROR_CODE_RE = re.compile(r"^[a-z_]{1,64}$")
_BODY_ERROR_CODE_RE = re.compile(r"""["'](?:error|error_code|code)["']\s*:\s*["']([a-z_]{1,64})["']""")
_STATUS_TEXT_RE = re.compile(r"\b([1-5]\d\d) (?:Client|Server) Error\b|\b(?:Server error|status(?:_code)?)\W{1,3}([1-5]\d\d)\b")
_CLASS_STATUS = {
    "LangSmithAuthError": 401,
    "LangSmithNotFoundError": 404,
    "LangSmithRequestTimeout": 408,
    "LangSmithConflictError": 409,
    "LangSmithRateLimitError": 429,
    "LangSmithAPIError": 500,
}
_INGEST_LOG_FIRST = 1
_INGEST_LOG_EVERY = 100
_PREFLIGHT_TIMEOUT_SECONDS = 5.0

_ingest_lock = threading.Lock()
_ingest_counts: Counter[tuple[str, int | None, str | None]] = Counter()
_preflight_lock = threading.Lock()
_preflight_started = False
_preflight_active: ContextVar[bool] = ContextVar("langsmith_preflight_active", default=False)


class _SuppressPreflightRequestLines(logging.Filter):
    """Drop httpx's own ``HTTP Request: GET <url?query>`` line for preflight calls."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not _preflight_active.get()


_HTTPX_REQUEST_FILTER = _SuppressPreflightRequestLines()


def endpoint_host(endpoint: Any) -> str:
    """Host (and port) of an endpoint URL; never the path, query or credentials."""

    if not isinstance(endpoint, str) or not endpoint.strip():
        return "unknown"
    parsed = urlparse(endpoint.strip())
    host = parsed.hostname or ""
    if not host:
        return "unknown"
    return f"{host}:{parsed.port}" if parsed.port else host


def api_key_kind(api_key: Any) -> str:
    """Classify a key by prefix only; the prefix itself is never returned."""

    if not isinstance(api_key, str) or not api_key.strip():
        return "absent"
    key = api_key.strip()
    if key.startswith("lsv2_sk_"):
        return "service"
    if key.startswith("lsv2_pt_"):
        return "personal"
    return "other"


def _exception_chain(error: BaseException, limit: int = 8) -> list[BaseException]:
    chain: list[BaseException] = []
    pending: list[BaseException] = [error]
    while pending and len(chain) < limit:
        current = pending.pop(0)
        if any(current is seen for seen in chain):
            continue
        chain.append(current)
        nested = getattr(current, "exceptions", None)
        if isinstance(nested, (list, tuple)):
            pending.extend(item for item in nested if isinstance(item, BaseException))
        for linked in (current.__cause__, current.__context__):
            if isinstance(linked, BaseException):
                pending.append(linked)
    return chain


def _as_status(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 100 <= value <= 599 else None


def error_http_status(error: BaseException) -> int | None:
    """Best-effort HTTP status of a LangSmith/HTTP failure; ``None`` if unknown."""

    chain = _exception_chain(error)
    for current in chain:
        status = _as_status(getattr(current, "status_code", None))
        if status is None:
            status = _as_status(getattr(getattr(current, "response", None), "status_code", None))
        if status is not None:
            return status
    for current in chain:
        status = _CLASS_STATUS.get(type(current).__name__)
        if status is not None:
            return status
    for current in chain:
        match = _STATUS_TEXT_RE.search(str(current))
        if match:
            return int(match.group(1) or match.group(2))
    return None


def error_code(error: BaseException) -> str | None:
    """An allowlisted (``^[a-z_]{1,64}$``) machine error code, if the failure carries one."""

    for current in _exception_chain(error):
        text = str(current)
        if type(current).__name__ == "LangSmithUserError" and "org-scoped" in text:
            return "org_scoped_key_requires_workspace"
        match = _BODY_ERROR_CODE_RE.search(text)
        if match and _ERROR_CODE_RE.match(match.group(1)):
            return match.group(1)
    return None


def make_ingest_error_callback(*, client_kind: str, endpoint: Any, workspace_header: bool) -> Callable[[Exception], None]:
    """``tracing_error_callback`` for a LangSmith client: rate-limited, content-free.

    The SDK calls it from its background ingest thread when a batch is
    rejected (for example a 403 on ``/runs/multipart``), which is otherwise
    only visible as a generic SDK warning carrying the response body.
    """

    host = endpoint_host(endpoint)

    def on_ingest_error(error: Exception) -> None:
        try:
            status = error_http_status(error)
            code = error_code(error)
            key = (client_kind, status, code)
            with _ingest_lock:
                _ingest_counts[key] += 1
                count = _ingest_counts[key]
            if count > _INGEST_LOG_FIRST and count % _INGEST_LOG_EVERY:
                return
            logger.warning(
                "langsmith_ingest_rejected client=%s http_status=%s error_code=%s error_class=%s endpoint_host=%s workspace_header=%s count=%d",
                client_kind,
                status,
                code,
                type(error).__name__,
                host,
                workspace_header,
                count,
            )
        except Exception:  # noqa: BLE001 - diagnostics must never disturb the SDK thread.
            return

    return on_ingest_error


def reset_ingest_rejections_for_test() -> None:
    with _ingest_lock:
        _ingest_counts.clear()


def _remaining(deadline: float) -> float:
    return deadline - time.monotonic()


def _status_label(error: BaseException) -> str:
    import httpx

    if isinstance(error, httpx.TimeoutException):
        return "timeout"
    if isinstance(error, httpx.ConnectError):
        return "connect_error"
    return "error"


def _project_probe(
    client: Any,
    *,
    api_key: str,
    project: str,
    workspace_id: str | None,
    with_tenant: bool,
    deadline: float,
) -> dict[str, Any]:
    remaining = _remaining(deadline)
    if remaining <= 0:
        return {"status": "deadline", "project_found": None, "tenant_match": None}
    headers = {"x-api-key": api_key}
    if with_tenant and workspace_id:
        headers["X-Tenant-Id"] = workspace_id
    try:
        response = client.get("/sessions", params={"name": project, "limit": 1}, headers=headers, timeout=remaining)
    except Exception as error:  # noqa: BLE001 - preflight fails open.
        return {"status": _status_label(error), "project_found": None, "tenant_match": None, "error_class": type(error).__name__}
    result: dict[str, Any] = {"status": response.status_code, "project_found": None, "tenant_match": None}
    if response.status_code == 200:
        try:
            projects = response.json()
        except ValueError:
            projects = None
        if isinstance(projects, list):
            result["project_found"] = bool(projects)
            first = projects[0] if projects and isinstance(projects[0], dict) else {}
            tenant = first.get("tenant_id")
            if workspace_id and isinstance(tenant, str):
                result["tenant_match"] = tenant == workspace_id
    return result


def run_langsmith_preflight(
    *,
    endpoint: str,
    api_key: str | None,
    workspace_id: str | None,
    project: str,
    timeout_seconds: float = _PREFLIGHT_TIMEOUT_SECONDS,
    transport: Any | None = None,
) -> dict[str, Any]:
    """Probe LangSmith reachability and project/tenant access; logs codes and booleans only."""

    import httpx

    httpx_logger = logging.getLogger("httpx")
    if _HTTPX_REQUEST_FILTER not in httpx_logger.filters:
        httpx_logger.addFilter(_HTTPX_REQUEST_FILTER)
    active_token = _preflight_active.set(True)
    try:
        return _run_preflight(httpx, endpoint=endpoint, api_key=api_key, workspace_id=workspace_id, project=project, timeout_seconds=timeout_seconds, transport=transport)
    finally:
        _preflight_active.reset(active_token)


def _run_preflight(
    httpx: Any,
    *,
    endpoint: str,
    api_key: str | None,
    workspace_id: str | None,
    project: str,
    timeout_seconds: float,
    transport: Any | None,
) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout_seconds
    result: dict[str, Any] = {
        "info_status": None,
        "project_status": None,
        "project_status_without_tenant": None,
        "project_found": None,
        "tenant_match": None,
    }
    error_class: str | None = None
    try:
        with httpx.Client(base_url=endpoint, transport=transport, follow_redirects=False) as client:
            try:
                info = client.get("/info", timeout=max(_remaining(deadline), 0.001))
                result["info_status"] = info.status_code
            except Exception as error:  # noqa: BLE001 - preflight fails open.
                result["info_status"] = _status_label(error)
                error_class = type(error).__name__
            if api_key:
                probe = _project_probe(client, api_key=api_key, project=project, workspace_id=workspace_id, with_tenant=True, deadline=deadline)
                result["project_status"] = probe["status"]
                result["project_found"] = probe["project_found"]
                result["tenant_match"] = probe["tenant_match"]
                error_class = error_class or probe.get("error_class")
                if probe["status"] != 200 and workspace_id:
                    bare = _project_probe(client, api_key=api_key, project=project, workspace_id=workspace_id, with_tenant=False, deadline=deadline)
                    result["project_status_without_tenant"] = bare["status"]
                    if result["project_found"] is None:
                        result["project_found"] = bare["project_found"]
                        result["tenant_match"] = bare["tenant_match"]
                    error_class = error_class or bare.get("error_class")
    except Exception as error:  # noqa: BLE001 - preflight fails open.
        error_class = type(error).__name__
    logger.info(
        "langsmith_preflight info_status=%s project_status=%s project_status_without_tenant=%s project_found=%s tenant_match=%s workspace_header=%s key_kind=%s endpoint_host=%s error_class=%s elapsed_ms=%d",
        result["info_status"],
        result["project_status"],
        result["project_status_without_tenant"],
        result["project_found"],
        result["tenant_match"],
        bool(workspace_id),
        api_key_kind(api_key),
        endpoint_host(endpoint),
        error_class,
        int((time.monotonic() - started) * 1000),
    )
    return result


def start_langsmith_preflight(**kwargs: Any) -> bool:
    """Run the preflight once per process on a daemon thread; never blocks startup."""

    global _preflight_started
    with _preflight_lock:
        if _preflight_started:
            return False
        _preflight_started = True

    def run() -> None:
        try:
            run_langsmith_preflight(**kwargs)
        except Exception:  # noqa: BLE001 - preflight fails open.
            logger.info("langsmith_preflight status=unavailable")

    threading.Thread(target=run, name="langsmith-preflight", daemon=True).start()
    return True
