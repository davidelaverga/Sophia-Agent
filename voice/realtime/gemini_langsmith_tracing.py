"""Manual LangSmith tracing for Sophia's browser-owned Gemini Live sessions.

The production Gemini route owns the provider WebSocket in the browser and
relays provider messages to this service.  That is deliberately different from
the Python-owned ``client.aio.live.connect`` flow supported by
``wrap_gemini_live``.  This module therefore builds the same trace shape with
the low-level RunTree API: one conversation root and one child for each
provider socket event, plus explicit tool and function-response spans.

Tracing is opt-in with ``SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING``.  All payloads
are compacted before they enter LangSmith; provider audio bytes are never
placed in inputs or outputs.  The single combined recording is attached to the
root after the browser closes the session.

Protected Voice Lab runs never allocate a LangSmith trace.  LangSmith SaaS
retention cannot meet the Voice Lab's shorter, verifiable purge contract, so
synthetic evidence remains in the product-owned canonical evidence plane and
is reported as supplementally unavailable.  This is deliberately independent
from ordinary-user tracing.

Content policy.  Governed (MEM00) owners may only receive structure-only
traces: names, types, timings, status, codes and counts.  The voice service is
not told an owner's memory-governance state, so every session is
structure-only by default.  Content (compact payloads, transcript text, tool
arguments and results, error text, the conversation recording) is exported
only when ``SOPHIA_GEMINI_LIVE_LANGSMITH_CONTENT`` is truthy AND the caller
passes ``owner_memory_governance="non_governed"`` from an authoritative source.

Ingest health.  The SDK posts runs on a background thread, so a rejected batch
(for example HTTP 403) never reaches ``RunTree.post``.  One process-wide
``Client`` per (endpoint, key fingerprint, workspace) is built with a
thread-safe ``tracing_error_callback`` that feeds an :class:`IngestHealth`
record.  While the record is ``rejected`` only the root run is posted.
"""

from __future__ import annotations

import atexit
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import wraps
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

try:  # Optional so legacy voice and local tests do not require LangSmith.
    from langsmith import Client
    from langsmith.run_trees import RunTree
    from langsmith.schemas import Attachment
except ImportError:  # pragma: no cover - exercised in slim local environments.
    Client = None  # type: ignore[assignment,misc]
    RunTree = None  # type: ignore[assignment,misc]
    Attachment = None  # type: ignore[assignment,misc]


MAX_TRACE_TEXT_CHARS = 400
MAX_TRACE_LIST_ITEMS = 24
MAX_TRACE_DEPTH = 8
MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024
BACKGROUND_FLUSH_TIMEOUT_SECONDS = 2.0
CONTENT_TRACING_ENV = "SOPHIA_GEMINI_LIVE_LANGSMITH_CONTENT"
OWNER_NON_GOVERNED = "non_governed"
INGEST_REJECTED_UNAVAILABLE_REASON = "langsmith_ingest_rejected"
DEFAULT_GEMINI_LIVE_LANGSMITH_PROJECT = "Sophia-Gemini-Live-Voice"
_DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com"
_REJECTED_HTTP_STATUSES = frozenset({401, 403})
_INGEST_ERROR_CODE_PATTERN = re.compile(r"^[a-z_]{1,64}$")
_TRACE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_TRACE_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_.:+-]{1,128}$")
_STRUCTURAL_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_ERROR_TYPE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_HOSTNAME_PATTERN = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
_PROJECT_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9 _.-]")
_INGEST_FAILURE_LOG_PREFIXES = (
    "Failed to multipart ingest",
    "Failed to send compressed multipart ingest",
    "Failed to batch ingest runs",
)
_INGEST_FAILURE_LOG_SAMPLE_EVERY = 50
_STATUS_BY_ERROR_CLASS = {
    "LangSmithAuthError": 401,
    "LangSmithNotFoundError": 404,
    "LangSmithRequestTimeout": 408,
    "LangSmithConflictError": 409,
    "LangSmithRateLimitError": 429,
}
_LANGSMITH_HANDOFF_HEADER_NAMES = frozenset({"langsmith-trace", "baggage"})
_DEPLOYMENT_SHA_ENV_NAMES = (
    "SOPHIA_DEPLOYMENT_SHA",
    "RENDER_GIT_COMMIT",
    "GIT_COMMIT_SHA",
    "COMMIT_SHA",
)
_BUILDER_LIFECYCLE_TOOLS = frozenset(
    {
        "start_builder_task",
        "edit_builder_artifact",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    }
)
_TERMINAL_BUILDER_STATUSES = frozenset(
    {"success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"}
)
_SPOKEN_READY_CLAIM_PATTERNS = (
    re.compile(
        r"\b(?:the|your|this|that|my)?\s*"
        r"(?:slide\s+deck|deck|presentation|slides?|artifact|document|file)\s+"
        r"(?:is|are|'s|'re|has\s+been|have\s+been)\s+"
        r"(?:now\s+|all\s+)?(?:ready|complete|completed|done|finished)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:it\s+is|it's|that\s+is|that's)\s+"
        r"(?:now\s+|all\s+)?(?:ready|complete|completed|done|finished)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have))\s+"
        r"(?:completed|finished)\s+(?:the|your|this)\s+"
        r"(?:slide\s+deck|deck|presentation|slides?|artifact|document|file)\b",
        re.IGNORECASE,
    ),
)
_SPOKEN_READY_NEGATION_PATTERN = re.compile(
    r"\b(?:not|isn't|isnt|isn’t|aren't|arent|aren’t|wasn't|wasnt|wasn’t|"
    r"won't|wont|won’t|will\s+not|not\s+yet|still\s+(?:building|running|working))\b"
    r".{0,48}\b(?:ready|complete|completed|done|finished)\b",
    re.IGNORECASE,
)
_SPOKEN_READY_FUTURE_PATTERN = re.compile(
    r"\b(?:when|once|until|before)\b.{0,72}\b(?:ready|complete|completed|done|finished)\b"
    r"|\b(?:will|should)\s+be\s+(?:ready|complete|completed|done|finished)\b",
    re.IGNORECASE,
)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _pseudonym(secret: bytes, namespace: str, value: str) -> str:
    if not secret:
        return "hmac_unavailable"
    digest = hmac.new(secret, f"{namespace}:{value}".encode(), hashlib.sha256).hexdigest()
    return f"hmac_{digest[:24]}"


_TRACE_IDENTITY_KEYS = frozenset(
    {"task_id", "thread_id", "run_id", "build_id", "operation_id", "voice_trace_id"}
)


def _trace_identifier(value: Any, namespace: str) -> str | None:
    text = _string_value(value)
    if text is None:
        return None
    secret = os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").encode()
    return _pseudonym(secret, namespace, text) if secret else text


def langsmith_gemini_live_enabled() -> bool:
    """Return whether manual Gemini Live tracing is configured and usable."""

    return bool(
        _env_bool("SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING", False)
        and os.getenv("LANGSMITH_API_KEY", "").strip()
        and os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").strip()
        and Client is not None
        and RunTree is not None
        and Attachment is not None
    )


def content_tracing_allowed(owner_memory_governance: str | None) -> bool:
    """Content needs the explicit env opt-in AND a known non-governed owner."""

    return bool(
        _env_bool(CONTENT_TRACING_ENV, False)
        and owner_memory_governance == OWNER_NON_GOVERNED
    )


def gemini_live_langsmith_project() -> str:
    """Return the configured project with stray quotes and whitespace removed."""

    raw = os.getenv("SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT") or ""
    cleaned = raw.strip().strip("\"'").strip()
    return cleaned or DEFAULT_GEMINI_LIVE_LANGSMITH_PROJECT


def _langsmith_sdk_version() -> str:
    try:
        from importlib.metadata import version

        value = version("langsmith")
    except Exception:
        return "unavailable"
    return value if _TRACE_CODE_PATTERN.fullmatch(value) else "invalid"


def _endpoint_host(endpoint: str | None) -> str:
    try:
        host = urlparse((endpoint or "").strip() or _DEFAULT_LANGSMITH_ENDPOINT).hostname
    except Exception:
        return "invalid"
    return host if host and _HOSTNAME_PATTERN.fullmatch(host) else "invalid"


def _key_kind(api_key: str | None) -> str:
    """Classify a key by prefix only; the prefix itself is never logged."""

    key = (api_key or "").strip()
    if not key:
        return "absent"
    if key.startswith("lsv2_sk_"):
        return "service"
    if key.startswith("lsv2_pt_"):
        return "personal"
    return "other"


def _log_safe_project(project: str) -> str:
    return _PROJECT_UNSAFE_CHARS.sub("_", project)[:128] or "invalid"


def _error_type_name(error: BaseException) -> str:
    name = type(error).__name__
    return name if _ERROR_TYPE_PATTERN.fullmatch(name) else "Exception"


def _ingest_error_details(error: BaseException) -> tuple[int | None, str | None]:
    """Return (HTTP status, allowlisted error code) without reading any message.

    The SDK wraps the HTTP error in a ``LangSmithError`` whose implicit
    exception chain still holds the ``requests`` response.  Only the status
    code and an allowlisted ``error`` field are read from it.
    """

    pending: list[Any] = [error]
    seen: set[int] = set()
    while pending and len(seen) < 16:
        current = pending.pop(0)
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        response = getattr(current, "response", None)
        status = getattr(response, "status_code", None)
        if isinstance(status, int) and not isinstance(status, bool):
            code: str | None = None
            try:
                body = response.json()
                raw_code = body.get("error") if isinstance(body, Mapping) else None
                if isinstance(raw_code, str):
                    candidate = raw_code.strip().lower()
                    if _INGEST_ERROR_CODE_PATTERN.fullmatch(candidate):
                        code = candidate
            except Exception:
                code = None
            return status, code
        pending.append(getattr(current, "__cause__", None))
        pending.append(getattr(current, "__context__", None))
        nested = getattr(current, "exceptions", None)
        if isinstance(nested, (list, tuple)):
            pending.extend(nested[:4])
    return _STATUS_BY_ERROR_CLASS.get(type(error).__name__), None


class IngestHealth:
    """Background-ingest outcome for one shared LangSmith client.

    ``record_failure`` is the SDK ``tracing_error_callback``: it runs on SDK
    worker threads, so it only takes a ``threading.Lock`` and logs.  It never
    touches asyncio state and never raises into the SDK.
    """

    def __init__(self, *, log_context: Mapping[str, str] | None = None) -> None:
        self._lock = threading.Lock()
        self._log_context = {
            "endpoint_host": "invalid",
            "workspace_header": "absent",
            "key_kind": "absent",
            "project": "invalid",
            "sdk": "unavailable",
            **dict(log_context or {}),
        }
        self.state = "unknown"
        self.http_status: int | None = None
        self.error_code: str | None = None
        self.error_type: str | None = None
        self.first_failure_at: float | None = None
        self.last_failure_at: float | None = None
        self.failure_count = 0
        self.last_flush_timed_out: bool | None = None

    @property
    def rejected(self) -> bool:
        return self.state == "rejected"

    def record_failure(self, error: BaseException) -> None:
        try:
            status, code = _ingest_error_details(error)
            error_type = _error_type_name(error)
            state = "rejected" if status in _REJECTED_HTTP_STATUSES else "failing"
            now = time.time()
            with self._lock:
                previous = self.state
                self.failure_count += 1
                if self.first_failure_at is None:
                    self.first_failure_at = now
                self.last_failure_at = now
                self.http_status = status
                self.error_code = code
                self.error_type = error_type
                self.state = state
                failure_count = self.failure_count
            if state != previous:
                context = self._log_context
                logger.warning(
                    "gemini.langsmith.ingest_rejected state=%s previous_state=%s status=%s "
                    "error_code=%s error_type=%s endpoint_host=%s workspace_header=%s "
                    "key_kind=%s project=%s sdk=%s failure_count=%s",
                    state,
                    previous,
                    status,
                    code,
                    error_type,
                    context["endpoint_host"],
                    context["workspace_header"],
                    context["key_kind"],
                    context["project"],
                    context["sdk"],
                    failure_count,
                )
        except Exception:
            pass

    def record_flush(self, *, failures_before: int, timed_out: bool) -> None:
        """A drained flush with no new failure proves the batches were accepted."""

        with self._lock:
            self.last_flush_timed_out = timed_out
            previous = self.state
            recovered = (
                not timed_out
                and self.failure_count == failures_before
                and previous != "ok"
            )
            if recovered:
                self.state = "ok"
            failure_count = self.failure_count
        if recovered and previous in {"rejected", "failing"}:
            logger.info(
                "gemini.langsmith.ingest_recovered state=ok previous_state=%s failure_count=%s",
                previous,
                failure_count,
            )

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self.state,
                "http_status": self.http_status,
                "error_code": self.error_code,
                "error_type": self.error_type,
                "first_failure_at": self.first_failure_at,
                "last_failure_at": self.last_failure_at,
                "failure_count": self.failure_count,
                "last_flush_timed_out": self.last_flush_timed_out,
            }


@dataclass(frozen=True)
class IngestClientHandle:
    client: Any
    health: IngestHealth


_SHARED_INGEST_CLIENTS: dict[tuple[str, str, str], IngestClientHandle] = {}
_SHARED_INGEST_CLIENTS_LOCK = threading.Lock()
_SHUTDOWN_FLUSH_REGISTERED = False


def _ingest_log_context() -> dict[str, str]:
    return {
        "endpoint_host": _endpoint_host(os.getenv("LANGSMITH_ENDPOINT")),
        "workspace_header": (
            "present" if (os.getenv("LANGSMITH_WORKSPACE_ID") or "").strip() else "absent"
        ),
        "key_kind": _key_kind(os.getenv("LANGSMITH_API_KEY")),
        "project": _log_safe_project(gemini_live_langsmith_project()),
        "sdk": _langsmith_sdk_version(),
    }


def shared_ingest_client() -> IngestClientHandle:
    """Return the process-wide client for the configured endpoint/key/workspace."""

    api_url = os.getenv("LANGSMITH_ENDPOINT") or None
    api_key = os.getenv("LANGSMITH_API_KEY") or None
    workspace_id = os.getenv("LANGSMITH_WORKSPACE_ID") or None
    key_fingerprint = hashlib.sha256(api_key.encode()).hexdigest()[:16] if api_key else ""
    registry_key = (api_url or "", key_fingerprint, workspace_id or "")
    global _SHUTDOWN_FLUSH_REGISTERED
    with _SHARED_INGEST_CLIENTS_LOCK:
        handle = _SHARED_INGEST_CLIENTS.get(registry_key)
        if handle is not None:
            return handle
        install_langsmith_ingest_log_filter()
        health = IngestHealth(log_context=_ingest_log_context())
        client = Client(
            api_url=api_url,
            api_key=api_key,
            workspace_id=workspace_id,
            tracing_error_callback=health.record_failure,
        )
        handle = IngestClientHandle(client=client, health=health)
        _SHARED_INGEST_CLIENTS[registry_key] = handle
        if not _SHUTDOWN_FLUSH_REGISTERED:
            atexit.register(flush_shared_ingest_clients)
            _SHUTDOWN_FLUSH_REGISTERED = True
        return handle


def _ingest_pending(client: Any) -> bool:
    try:
        queue = getattr(client, "tracing_queue", None)
        pending = bool(getattr(queue, "unfinished_tasks", 0)) if queue is not None else False
        futures = getattr(client, "_futures", None)
        if futures:
            pending = pending or any(not future.done() for future in list(futures))
        return pending
    except Exception:
        return False


def bounded_flush(client: Any, timeout: float = BACKGROUND_FLUSH_TIMEOUT_SECONDS) -> bool:
    """Flush with a hard cap; return True when work was still pending at the cap."""

    started = time.monotonic()
    flush = getattr(client, "flush", None)
    if callable(flush):
        flush(timeout=timeout)
    return _ingest_pending(client) or (time.monotonic() - started) >= timeout


def flush_shared_ingest_clients(timeout: float = BACKGROUND_FLUSH_TIMEOUT_SECONDS) -> None:
    """Shutdown flush: bounded per client and never raises."""

    with _SHARED_INGEST_CLIENTS_LOCK:
        handles = list(_SHARED_INGEST_CLIENTS.values())
    for handle in handles:
        try:
            failures_before = handle.health.failure_count
            timed_out = bounded_flush(handle.client, timeout)
            handle.health.record_flush(failures_before=failures_before, timed_out=timed_out)
        except Exception:
            pass


def _reset_shared_ingest_clients() -> None:
    """Test helper: drop shared clients so each test builds its own."""

    with _SHARED_INGEST_CLIENTS_LOCK:
        handles = list(_SHARED_INGEST_CLIENTS.values())
        _SHARED_INGEST_CLIENTS.clear()
    for handle in handles:
        cleanup = getattr(handle.client, "cleanup", None)
        if callable(cleanup):
            try:
                cleanup(timeout=0)
            except Exception:
                pass


class _IngestFailureLogSampler(logging.Filter):
    """Keep the first and every Nth SDK ingest-failure line, without detail.

    The SDK formats the response body and error message into these lines;
    kept lines are rewritten to the fixed prefix and an occurrence count.
    """

    def __init__(self, every: int = _INGEST_FAILURE_LOG_SAMPLE_EVERY) -> None:
        super().__init__()
        self._every = max(int(every), 1)
        self._lock = threading.Lock()
        self._counts: dict[str, int] = {}

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        prefix = next(
            (candidate for candidate in _INGEST_FAILURE_LOG_PREFIXES if message.startswith(candidate)),
            None,
        )
        if prefix is None:
            return True
        with self._lock:
            count = self._counts.get(prefix, 0) + 1
            self._counts[prefix] = count
        if count != 1 and count % self._every != 0:
            return False
        record.msg = "%s (occurrence=%s; detail redacted; see gemini.langsmith.ingest_rejected)"
        record.args = (prefix, count)
        record.exc_info = None
        record.exc_text = None
        return True


_INGEST_FAILURE_LOG_SAMPLER = _IngestFailureLogSampler()


def install_langsmith_ingest_log_filter() -> None:
    sdk_logger = logging.getLogger("langsmith.client")
    if _INGEST_FAILURE_LOG_SAMPLER not in sdk_logger.filters:
        sdk_logger.addFilter(_INGEST_FAILURE_LOG_SAMPLER)


def gemini_live_langsmith_startup_status() -> dict[str, Any]:
    return {
        "sdk": _langsmith_sdk_version(),
        "endpoint_host": _endpoint_host(os.getenv("LANGSMITH_ENDPOINT")),
        "key_kind": _key_kind(os.getenv("LANGSMITH_API_KEY")),
        "workspace_present": bool((os.getenv("LANGSMITH_WORKSPACE_ID") or "").strip()),
        "tracing_enabled": langsmith_gemini_live_enabled(),
        "content_mode": (
            "governance_gated" if _env_bool(CONTENT_TRACING_ENV, False) else "structure_only"
        ),
    }


def log_gemini_live_langsmith_startup_status() -> dict[str, Any]:
    """Log one content-free line describing the voice tracing configuration."""

    install_langsmith_ingest_log_filter()
    status = gemini_live_langsmith_startup_status()
    logger.info(
        "gemini.langsmith.startup sdk=%s endpoint_host=%s key_kind=%s workspace_present=%s "
        "tracing_enabled=%s content_mode=%s",
        status["sdk"],
        status["endpoint_host"],
        status["key_kind"],
        status["workspace_present"],
        status["tracing_enabled"],
        status["content_mode"],
    )
    return status


def _trace_code(value: Any) -> Any:
    """Keep code-shaped strings; describe anything else by shape only."""

    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str) and _TRACE_CODE_PATTERN.fullmatch(value.strip()):
        return value.strip()
    return _structural_payload(value)


def _trace_metadata_identifier(value: Any) -> Any:
    """Keep identifier/timestamp-shaped strings only."""

    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, str) and _TRACE_IDENTIFIER_PATTERN.fullmatch(value):
        return value
    return None


def _trace_name(value: Any) -> str:
    return value if isinstance(value, str) and _TRACE_CODE_PATTERN.fullmatch(value) else "unknown"


def uuid7() -> uuid.UUID:
    """Generate an RFC 9562 UUIDv7 without depending on private SDK helpers."""

    timestamp_ms = time.time_ns() // 1_000_000
    random_bits = int.from_bytes(os.urandom(10), "big")
    value = (timestamp_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (random_bits & ((1 << 12) - 1)) << 64
    value |= 0b10 << 62
    value |= (random_bits >> 12) & ((1 << 62) - 1)
    return uuid.UUID(int=value)


def _safe_text(value: str) -> str:
    if len(value) <= MAX_TRACE_TEXT_CHARS:
        return value
    return f"{value[:MAX_TRACE_TEXT_CHARS]}…"


def _safe_payload(value: Any, *, depth: int = 0, parent_key: str | None = None) -> Any:
    """Remove audio/base64 material and bound provider payload size."""

    if depth >= MAX_TRACE_DEPTH:
        return "<max_depth>"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"byte_length": len(value), "raw_audio_excluded": True}
    if isinstance(value, str):
        if parent_key in {"data", "inlineData", "inline_data"}:
            return {"byte_length": len(value), "raw_audio_excluded": True}
        return _safe_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_TRACE_LIST_ITEMS]:
            key_text = str(key)
            if key_text in {"data", "audio", "audio_bytes", "audioBase64", "audio_base64"}:
                if isinstance(item, (str, bytes, bytearray, memoryview)):
                    result[key_text] = {
                        "byte_length": len(item),
                        "raw_audio_excluded": True,
                    }
                else:
                    result[key_text] = "<audio_excluded>"
                continue
            result[key_text] = _safe_payload(item, depth=depth + 1, parent_key=key_text)
        if len(value) > MAX_TRACE_LIST_ITEMS:
            result["truncated_fields"] = len(value) - MAX_TRACE_LIST_ITEMS
        return result
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        result = [
            _safe_payload(item, depth=depth + 1, parent_key=parent_key)
            for item in items[:MAX_TRACE_LIST_ITEMS]
        ]
        if len(items) > MAX_TRACE_LIST_ITEMS:
            result.append({"truncated_items": len(items) - MAX_TRACE_LIST_ITEMS})
        return result
    return _safe_text(repr(value))


def _structural_payload(value: Any, *, depth: int = 0) -> Any:
    """Describe shape and size without exporting conversation/tool content."""

    if depth >= MAX_TRACE_DEPTH:
        return {"kind": "max_depth"}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"kind": "bytes", "byte_length": len(value)}
    if isinstance(value, str):
        return {"kind": "string", "char_length": len(value)}
    if value is None:
        return {"kind": "null"}
    if isinstance(value, bool):
        # A yes/no answer is content, like a number: report the type only.
        return {"kind": "boolean"}
    if isinstance(value, (int, float)):
        return {"kind": "number"}
    if isinstance(value, Mapping):
        items = list(value.items())
        # Schema keys are structure; a data-derived key (free text, URL, UUID)
        # would be content, so anything not identifier-shaped is replaced.
        keys = [
            str(key) if _STRUCTURAL_KEY_PATTERN.fullmatch(str(key)) else f"<redacted_key_{index}>"
            for index, (key, _) in enumerate(items[:MAX_TRACE_LIST_ITEMS])
        ]
        fields = {
            key: _structural_payload(item, depth=depth + 1)
            for key, (_, item) in zip(keys, items[:MAX_TRACE_LIST_ITEMS], strict=True)
        }
        result: dict[str, Any] = {
            "kind": "object",
            "keys": keys,
            "field_count": len(items),
            "fields": fields,
        }
        if len(items) > MAX_TRACE_LIST_ITEMS:
            result["truncated_fields"] = len(items) - MAX_TRACE_LIST_ITEMS
        return result
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        return {
            "kind": "array",
            "item_count": len(items),
            "item_shapes": [
                _structural_payload(item, depth=depth + 1)
                for item in items[:MAX_TRACE_LIST_ITEMS]
            ],
        }
    return {"kind": type(value).__name__}


def _event_name(categories: list[str], event: Mapping[str, Any]) -> str:
    if "toolCallCancellation" in categories:
        return "interrupted"
    if "toolCall" in categories:
        return "function_call"
    if "inputTranscription" in categories:
        return "input_transcription"
    if "outputTranscription" in categories:
        return "output_transcription"
    if "error" in categories:
        return "error"
    if "serverContent" in categories:
        server_content = event.get("serverContent", event.get("server_content"))
        if isinstance(server_content, Mapping):
            if server_content.get("interrupted") is True:
                return "interrupted"
            if server_content.get("turnComplete", server_content.get("turn_complete")) is True:
                return "turn_complete"
        if "modelTurnAudio" in categories or "modelTurnText" in categories:
            return "model_response"
        return "server_content"
    return categories[0] if categories else "gemini_socket_event"


def _string_value(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _mapping_value(value: Mapping[str, Any], *keys: str) -> Mapping[str, Any] | None:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, Mapping):
            return candidate
    return None


def _output_transcription_text(event: Mapping[str, Any]) -> str | None:
    server_content = _mapping_value(event, "serverContent", "server_content")
    if server_content is None:
        return None
    transcription = _mapping_value(
        server_content,
        "outputTranscription",
        "output_transcription",
    )
    return _string_value(transcription.get("text")) if transcription is not None else None


def _provider_turn_complete(event: Mapping[str, Any]) -> bool:
    server_content = _mapping_value(event, "serverContent", "server_content")
    if server_content is None:
        return False
    return server_content.get("turnComplete", server_content.get("turn_complete")) is True


def _is_spoken_ready_claim(text: str | None) -> bool:
    if not text:
        return False
    if _SPOKEN_READY_NEGATION_PATTERN.search(text) or _SPOKEN_READY_FUTURE_PATTERN.search(text):
        return False
    return any(pattern.search(text) is not None for pattern in _SPOKEN_READY_CLAIM_PATTERNS)


def _builder_trace_summary(
    response: Mapping[str, Any] | None,
    *,
    content_allowed: bool = False,
) -> dict[str, Any]:
    response = response or {}
    result = response.get("result") if isinstance(response.get("result"), Mapping) else {}
    task = response.get("async_task") if isinstance(response.get("async_task"), Mapping) else {}
    builder_result = result.get("builder_result") if isinstance(result.get("builder_result"), Mapping) else {}
    summary: dict[str, Any] = {}
    for key in (
        "task_id",
        "thread_id",
        "run_id",
        "build_id",
        "operation_id",
        "voice_trace_id",
        "task_type",
        "status",
        "terminal_status",
        "terminal_reason",
        "failure_code",
        "root_failure_code",
    ):
        value = next(
            (
                source.get(key)
                for source in (response, result, task, builder_result)
                if source.get(key) is not None
            ),
            None,
        )
        if value is not None:
            if key in _TRACE_IDENTITY_KEYS:
                summary[key] = _trace_identifier(value, key)
            elif content_allowed:
                summary[key] = _safe_payload(value)
            else:
                summary[key] = _trace_code(value)
    artifact_path = next(
        (
            source.get("artifact_path") or source.get("artifact_url")
            for source in (result, task, builder_result, response)
            if source.get("artifact_path") or source.get("artifact_url")
        ),
        None,
    )
    summary["artifact_present"] = bool(_string_value(artifact_path))
    return summary


def _builder_gate_records(
    tool_name: str,
    response: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if tool_name not in {"check_async_task", "list_async_tasks"} or not isinstance(response, Mapping):
        return []
    if tool_name == "list_async_tasks":
        raw_records = response.get("tasks")
        records = [dict(item) for item in raw_records or [] if isinstance(item, Mapping)]
    else:
        merged = dict(response)
        if isinstance(response.get("async_task"), Mapping):
            merged.update(response["async_task"])
        if isinstance(response.get("result"), Mapping):
            merged.update(response["result"])
        records = [merged]

    gates: list[dict[str, Any]] = []
    for record in records:
        status = str(record.get("status") or "unknown").strip().lower()
        builder_result = record.get("builder_result") if isinstance(record.get("builder_result"), Mapping) else {}
        artifact_path = (
            _string_value(record.get("artifact_path"))
            or _string_value(record.get("artifact_url"))
            or _string_value(builder_result.get("artifact_path"))
            or _string_value(builder_result.get("artifact_url"))
        )
        ready_status = status in {"success", "completed"}
        artifact_valid = bool(ready_status and artifact_path)
        evidence_failure_code = (
            "ARTIFACT_EVIDENCE_MISSING" if ready_status and not artifact_valid else None
        )
        gates.append(
            {
                "tool_name": tool_name,
                "task_id": _trace_identifier(record.get("task_id"), "task_id"),
                "thread_id": _trace_identifier(record.get("thread_id"), "thread_id"),
                "run_id": _trace_identifier(record.get("run_id"), "run_id"),
                "build_id": _trace_identifier(record.get("build_id"), "build_id"),
                "operation_id": _trace_identifier(record.get("operation_id"), "operation_id"),
                "voice_trace_id": _trace_identifier(record.get("voice_trace_id"), "voice_trace_id"),
                "artifact_status": _trace_code(status),
                "terminal_status_observed": status in _TERMINAL_BUILDER_STATUSES,
                "ready_status_observed": ready_status,
                "artifact_present": bool(artifact_path),
                "artifact_valid": artifact_valid,
                "announced_ready": False,
                "announcement_allowed": artifact_valid,
                "decision": "allow" if artifact_valid else "suppress",
                "failure_code": _trace_code(
                    _string_value(record.get("failure_code")) or evidence_failure_code
                ),
                "false_ready": False,
            }
        )
    return gates


def _canonical_json_text(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _privacy_safe_hash(label: str, value: str) -> str | None:
    secret = os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").encode()
    if not secret:
        return None
    digest = hmac.new(secret, f"{label}:".encode() + value.encode(), hashlib.sha256).hexdigest()
    return f"hmac_sha256_{digest}"


def _deployment_sha() -> str | None:
    for env_name in _DEPLOYMENT_SHA_ENV_NAMES:
        value = _string_value(os.getenv(env_name))
        if value:
            return value[:128]
    return None


def _setup_prompt_text(setup: Mapping[str, Any]) -> str | None:
    instruction = _mapping_value(setup, "systemInstruction", "system_instruction")
    if instruction is None:
        return None
    parts = instruction.get("parts")
    if not isinstance(parts, list):
        return None
    texts = [
        text
        for part in parts
        if isinstance(part, Mapping)
        for text in [_string_value(part.get("text"))]
        if text is not None
    ]
    return "\n".join(texts) if texts else None


def _setup_voice_name(setup: Mapping[str, Any]) -> str | None:
    generation_config = _mapping_value(setup, "generationConfig", "generation_config")
    if generation_config is None:
        return None
    speech_config = _mapping_value(generation_config, "speechConfig", "speech_config")
    if speech_config is None:
        return None
    voice_config = _mapping_value(speech_config, "voiceConfig", "voice_config")
    if voice_config is None:
        return None
    prebuilt = _mapping_value(voice_config, "prebuiltVoiceConfig", "prebuilt_voice_config")
    if prebuilt is None:
        return None
    return _string_value(prebuilt.get("voiceName", prebuilt.get("voice_name")))


def _setup_tool_names(setup: Mapping[str, Any]) -> list[str]:
    tools = setup.get("tools")
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        if "googleSearch" in tool or "google_search" in tool:
            names.append("googleSearch")
        declarations = tool.get("functionDeclarations", tool.get("function_declarations"))
        if not isinstance(declarations, list):
            continue
        for declaration in declarations:
            if not isinstance(declaration, Mapping):
                continue
            name = _string_value(declaration.get("name"))
            if name:
                names.append(name)
    return names


def build_gemini_live_setup_fingerprint(
    setup: Mapping[str, Any],
    *,
    token_owned_fields: list[str] | tuple[str, ...] | set[str],
    browser_owned_fields: list[str] | tuple[str, ...] | set[str],
    provider_epoch: int,
    configured_flags: Mapping[str, bool] | None = None,
    compression_triggered: bool | None = None,
) -> dict[str, Any]:
    """Describe an effective setup without exporting prompt or tool contents."""

    setup_copy = dict(setup)
    setup_fields = sorted(str(field_name) for field_name in setup_copy)
    token_fields = sorted(
        str(field_name)
        for field_name in token_owned_fields
        if str(field_name) in setup_copy
    )
    browser_fields = sorted({str(field_name) for field_name in browser_owned_fields})
    token_setup = {field_name: setup_copy[field_name] for field_name in token_fields}
    tools = setup_copy.get("tools") if isinstance(setup_copy.get("tools"), list) else []
    prompt = _setup_prompt_text(setup_copy)
    tool_names = _setup_tool_names(setup_copy)
    canonical_setup = _canonical_json_text(setup_copy)
    canonical_token_setup = _canonical_json_text(token_setup)
    canonical_tools = _canonical_json_text(tools)
    configured = {
        str(name): bool(value)
        for name, value in (configured_flags or {}).items()
    }
    effective_flags = {
        "continuity_enabled": "sessionResumption" in setup_copy,
        "compression_enabled": "contextWindowCompression" in setup_copy,
        "google_search_enabled": "googleSearch" in tool_names,
        "web_fetch_enabled": "web_fetch" in tool_names,
    }
    for name in ("coreview_enabled", "coreview_still_frame_enabled"):
        if name in configured:
            effective_flags[name] = configured[name]
    compression_configured = configured.get(
        "compression_enabled",
        effective_flags["compression_enabled"],
    )
    return {
        "schema": "sophia_gemini_live_effective_setup_v1",
        "deployment_sha": _deployment_sha(),
        "model": _string_value(setup_copy.get("model")),
        "voice": _setup_voice_name(setup_copy),
        "provider_epoch": max(int(provider_epoch), 1),
        "setup_field_names": setup_fields,
        "token_owned_fields": token_fields,
        "browser_owned_fields": browser_fields,
        "field_ownership": {
            field_name: "browser" if field_name in browser_fields else "token"
            for field_name in setup_fields
        },
        "effective_flags": effective_flags,
        "configured_flags": configured,
        "compression": {
            "configured": compression_configured,
            "effective_in_setup": effective_flags["compression_enabled"],
            "triggered": compression_triggered,
            "trigger_observation": (
                "explicit_provider_signal"
                if compression_triggered is not None
                else "not_exposed_by_gemini_live_server_events"
            ),
        },
        "hash_algorithm": (
            "hmac-sha256"
            if os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").strip()
            else "unavailable_missing_hmac_secret"
        ),
        "setup_hash_scope": "server_baseline_before_browser_owned_overrides",
        "token_setup_hash_scope": "effective_token_locked_connection_fields",
        "tools_hash_scope": "server_baseline_browser_owned",
        "hashes": {
            "setup": _privacy_safe_hash("gemini_live_setup", canonical_setup),
            "token_setup": _privacy_safe_hash("gemini_live_token_setup", canonical_token_setup),
            "tools": _privacy_safe_hash("gemini_live_tools", canonical_tools),
            "prompt": (
                _privacy_safe_hash("gemini_live_prompt", prompt)
                if prompt is not None
                else None
            ),
        },
        "character_counts": {
            "setup": len(canonical_setup),
            "token_setup": len(canonical_token_setup),
            "tools": len(canonical_tools),
            "prompt": len(prompt) if prompt is not None else None,
        },
        "tool_declaration_count": len(tool_names),
        "tool_names": tool_names,
    }


def _fail_open_trace_operation(
    default_factory: Callable[[], Any] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    fallback = default_factory or (lambda: None)

    def decorator(operation: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(operation)
        def wrapped(self: Any, *args: Any, **kwargs: Any) -> Any:
            if not self.enabled or self.root is None or self._closed:
                return fallback()
            try:
                return operation(self, *args, **kwargs)
            except Exception as exc:
                self._disable_tracing(operation.__name__, exc)
                return fallback()

        return wrapped

    return decorator


class GeminiLiveTraceRecorder:
    """Own a single LangSmith root and its manual Gemini Live child spans."""

    def __init__(
        self,
        *,
        session_id: str,
        user_id: str,
        model: str,
        thread_id: str | None = None,
        client: Any | None = None,
        enabled: bool | None = None,
        setup_fingerprint: Mapping[str, Any] | None = None,
        synthetic_context: Mapping[str, Any] | None = None,
        failure_callback: Callable[[str, Exception], None] | None = None,
        owner_memory_governance: str | None = None,
        ingest_health: IngestHealth | None = None,
    ) -> None:
        self.session_id = session_id
        self.user_id = user_id
        self.thread_id = thread_id or session_id
        self.model = model
        self.root: Any | None = None
        self.client = client
        self.enabled = False
        self.audio_capture_enabled = False
        # Governance is not known to the voice service, so the default is
        # structure-only for every session (see module docstring).
        self.content_allowed = content_tracing_allowed(owner_memory_governance)
        self._ingest_health = ingest_health or IngestHealth()
        self._ingest_failure_baseline = 0
        self._ingest_failures_final: int | None = None
        self._children_skipped = 0
        self.flush_timed_out: bool | None = None
        self._flush_thread: threading.Thread | None = None
        self._closed = False
        self._failure_callback = failure_callback
        self._failure_count = 0
        self._disabled_operation: str | None = None
        self._event_count = 0
        self._tool_count = 0
        self._last_provider_sequence: int | None = None
        self._latest_artifact_gate_batch: list[dict[str, Any]] = []
        self._latest_artifact_gate_recorded_at: float | None = None
        self._last_ready_claim_text: str | None = None
        self._ready_claim_count = 0
        self._false_ready_claim_count = 0
        self._setup_fingerprint = dict(setup_fingerprint or {})
        self._synthetic_context = (
            {
                key: value
                for key in (
                    "synthetic",
                    "principal_id",
                    "test_run_id",
                    "scenario_id",
                    "scenario_version",
                    "environment",
                )
                if (value := (synthetic_context or {}).get(key)) is not None
            }
            if (synthetic_context or {}).get("synthetic") is True
            else {}
        )
        self.unavailable_reason: str | None = None
        self.trace_schema = os.getenv(
            "SOPHIA_GEMINI_LIVE_TRACE_SCHEMA",
            "sophia_gemini_live_trace_v2",
        )
        requested_content_mode = os.getenv(
            "SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE",
            "structural",
        ).strip().lower() or "structural"
        self.content_mode = requested_content_mode if self.content_allowed else "structural"
        try:
            if self._synthetic_context:
                # Synthetic traces must not enter the ordinary LangSmith
                # project.  LangSmith deletion is asynchronous and supplies no
                # authoritative deletion confirmation, so even a separately
                # named project cannot satisfy the bounded Voice Lab retention
                # contract.  Keep canonical evidence local and fail open.
                self.unavailable_reason = "synthetic_isolation_policy"
                return
            requested = langsmith_gemini_live_enabled() if enabled is None else enabled
            self.enabled = bool(
                requested
                and Client is not None
                and RunTree is not None
                and Attachment is not None
            )
            hmac_secret = os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").encode()
            self.audio_capture_enabled = bool(
                self.enabled
                and self.content_allowed
                and not self._synthetic_context
                and (
                    _env_bool("SOPHIA_GEMINI_LIVE_AUDIO_CAPTURE_ENABLED", False)
                    or not hmac_secret
                )
            )

            if not self.enabled:
                return

            if self.client is None:
                handle = shared_ingest_client()
                self.client = handle.client
                self._ingest_health = handle.health
            self._ingest_failure_baseline = self._ingest_health.failure_count

            logical_session_ref = _pseudonym(hmac_secret, "logical_session", session_id)
            thread_ref = _pseudonym(hmac_secret, "thread", self.thread_id)
            runtime_ref = _pseudonym(hmac_secret, "voice_runtime", session_id)
            metadata = {
                "ls_modality": "audio",
                "trace_schema_version": self.trace_schema,
                "runtime": "gemini_live",
                "transport": "browser_websocket_ephemeral_token_with_backend_relay",
                "logical_session_ref": logical_session_ref,
                "thread_ref": thread_ref,
                "voice_runtime_ref": runtime_ref,
                "model": model,
                "continuity_feature_enabled": _env_bool("SOPHIA_GEMINI_LIVE_CONTINUITY_ENABLED", False),
                "compression_enabled": _env_bool("SOPHIA_GEMINI_LIVE_COMPRESSION_ENABLED", False),
                "trace_content_mode": self.content_mode,
                "trace_content_policy": (
                    "content_allowed" if self.content_allowed else "structure_only"
                ),
                "audio_capture_enabled": self.audio_capture_enabled,
                "input_transcription_enabled": True,
                "output_transcription_enabled": True,
                "effective_setup_fingerprint": dict(self._setup_fingerprint),
                **(
                    {
                        "synthetic_test": True,
                        "test_principal": self._synthetic_context.get("principal_id"),
                        "test_run_id": self._synthetic_context.get("test_run_id"),
                        "scenario_id": self._synthetic_context.get("scenario_id"),
                        "scenario_version": self._synthetic_context.get("scenario_version"),
                        "test_environment": self._synthetic_context.get("environment"),
                    }
                    if self._synthetic_context
                    else {}
                ),
            }
            if not hmac_secret:
                metadata["thread_id"] = self.thread_id
            self.root = RunTree(
                name="gemini_live_conversation",
                id=uuid7(),
                run_type="chain",
                project_name=gemini_live_langsmith_project(),
                inputs={
                    "trace_schema_version": self.trace_schema,
                    "logical_session_ref": logical_session_ref,
                    "thread_ref": thread_ref,
                    "voice_runtime_ref": runtime_ref,
                    "effective_setup_fingerprint": dict(self._setup_fingerprint),
                    **(
                        {"synthetic_test": dict(self._synthetic_context)}
                        if self._synthetic_context
                        else {}
                    ),
                },
                extra={"metadata": metadata},
                tags=[
                    "sophia",
                    "voice",
                    "gemini_live",
                    "s2s",
                    *(["synthetic_voice_lab"] if self._synthetic_context else []),
                ],
                ls_client=self.client,
                dangerously_allow_filesystem=False,
            )
            if not self._safe_post(self.root, "root"):
                return
            logger.info(
                "gemini.langsmith.trace_started session_id=%s trace_id=%s project=%s "
                "ingest_status=%s flush_timed_out=%s content_policy=%s",
                session_id,
                self._trace_id_unchecked(),
                _log_safe_project(str(self.root.session_name)),
                self.ingest_status,
                self._ingest_health.last_flush_timed_out,
                "content_allowed" if self.content_allowed else "structure_only",
            )
        except Exception as exc:
            self._disable_tracing("construction", exc)

    @property
    def trace_id(self) -> str | None:
        if not self.enabled:
            return None
        try:
            return self._trace_id_unchecked()
        except Exception as exc:
            self._disable_tracing("trace_id", exc)
            return None

    @property
    def failure_count(self) -> int:
        return self._failure_count

    @property
    def disabled_operation(self) -> str | None:
        return self._disabled_operation

    @property
    def ingest_status(self) -> str:
        return self._ingest_health.state

    @property
    def ingest_failure_count(self) -> int:
        """Background ingest failures on this session's client while it was open."""

        if self._ingest_failures_final is not None:
            return self._ingest_failures_final
        return max(self._ingest_health.failure_count - self._ingest_failure_baseline, 0)

    @property
    def ingest_unavailable_reason(self) -> str | None:
        return INGEST_REJECTED_UNAVAILABLE_REASON if self._ingest_health.rejected else None

    @property
    def children_skipped(self) -> int:
        return self._children_skipped

    def _children_suppressed(self) -> bool:
        """While LangSmith rejects ingest, post the root only."""

        if self._ingest_health.rejected:
            self._children_skipped += 1
            return True
        return False

    def _trace_error(
        self,
        error: str | None,
        *,
        error_type: str | None = None,
        response: Mapping[str, Any] | None = None,
        fallback: str = "tool_error",
    ) -> str | None:
        """Structure-only traces carry an error code or class name, never text."""

        if error is None and error_type is None:
            return None
        if self.content_allowed:
            return error if error is not None else error_type
        response_code = response.get("error_type") if isinstance(response, Mapping) else None
        for candidate in (response_code, error_type):
            if isinstance(candidate, str) and _TRACE_CODE_PATTERN.fullmatch(candidate):
                return candidate
        return fallback

    @_fail_open_trace_operation()
    def update_setup_fingerprint(self, setup_fingerprint: Mapping[str, Any]) -> None:
        self._setup_fingerprint = dict(setup_fingerprint)
        metadata = self.root.extra.setdefault("metadata", {})
        if isinstance(metadata, dict):
            metadata["effective_setup_fingerprint"] = dict(self._setup_fingerprint)
        self._safe_patch(self.root, "root_setup_fingerprint")

    @_fail_open_trace_operation()
    def record_provider_event(
        self,
        event: Mapping[str, Any],
        *,
        categories: list[str],
        provider_receive_sequence: int | None = None,
        provider_relay_sequence: int | None = None,
        provider_received_at: str | None = None,
        relay_correlation_id: str | None = None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        self._event_count += 1
        if provider_receive_sequence is not None:
            self._last_provider_sequence = provider_receive_sequence
        name = _trace_name(_event_name(categories, event))
        provider_categories = [_trace_name(category) for category in categories]
        if not self._children_suppressed():
            metadata = {
                "runtime": "gemini_live",
                "socket_event": True,
                "provider_receive_sequence": _trace_metadata_identifier(provider_receive_sequence),
                "provider_relay_sequence": _trace_metadata_identifier(provider_relay_sequence),
                "provider_received_at": _trace_metadata_identifier(provider_received_at),
                "relay_correlation_id": _trace_metadata_identifier(relay_correlation_id),
                "provider_categories": provider_categories,
            }
            child = self.root.create_child(
                name=name,
                run_type="chain",
                run_id=uuid7(),
                inputs={
                    "provider_event": (
                        _structural_payload(event)
                        if self.content_mode == "structural"
                        else _safe_payload(event)
                    )
                },
                extra={"metadata": metadata},
                tags=["gemini_live", "socket_event", name],
            )
            if "error" in categories:
                child.end(
                    outputs={"event_name": name, "provider_categories": provider_categories},
                    error="Gemini Live provider error event",
                )
            else:
                child.end(
                    outputs={
                        "event_name": name,
                        "provider_categories": provider_categories,
                    }
                )
            self._safe_post(child, name)
        if "outputTranscription" in categories:
            self._record_spoken_ready_claim(
                event,
                provider_receive_sequence=provider_receive_sequence,
                relay_correlation_id=relay_correlation_id,
            )
        if _provider_turn_complete(event):
            self._last_ready_claim_text = None

    @_fail_open_trace_operation()
    def record_tool_call(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        success: bool,
        result_summary: str | None = None,
        error: str | None = None,
        response: Mapping[str, Any] | None = None,
        error_type: str | None = None,
    ) -> None:
        child = self.start_tool_call(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            arguments=arguments,
        )
        self.finish_tool_call(
            child,
            tool_name=tool_name,
            success=success,
            result_summary=result_summary,
            error=error,
            response=response,
            error_type=error_type,
        )

    @_fail_open_trace_operation()
    def start_tool_call(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        provider_receive_sequence: int | None = None,
        relay_correlation_id: str | None = None,
    ) -> Any | None:
        """Post an open tool span before awaiting its backend side effect."""

        if not self.enabled or self.root is None or self._closed:
            return None
        self._tool_count += 1
        if self._children_suppressed():
            return None
        safe_tool_name = _trace_name(tool_name)
        child = self.root.create_child(
            name=f"function_call:{safe_tool_name}",
            run_type="tool",
            run_id=uuid7(),
            inputs={
                "tool_call_id": _trace_identifier(tool_call_id, "tool_call_id"),
                "tool_name": safe_tool_name,
                "arguments": (
                    _structural_payload(arguments or {})
                    if self.content_mode == "structural"
                    else _safe_payload(arguments or {})
                ),
            },
            extra={
                "metadata": {
                    "runtime": "gemini_live",
                    "socket_event": False,
                    "tool_call_id": _trace_metadata_identifier(tool_call_id),
                    "provider_receive_sequence": _trace_metadata_identifier(provider_receive_sequence),
                    "relay_correlation_id": _trace_metadata_identifier(relay_correlation_id),
                }
            },
            tags=["gemini_live", "tool", safe_tool_name],
        )
        if not self._safe_post(child, f"tool_open:{safe_tool_name}"):
            return None
        return child

    @_fail_open_trace_operation()
    def finish_tool_call(
        self,
        child: Any | None,
        *,
        tool_name: str,
        success: bool,
        result_summary: str | None = None,
        error: str | None = None,
        response: Mapping[str, Any] | None = None,
        error_type: str | None = None,
    ) -> None:
        if child is None:
            return
        outputs: dict[str, Any] = {
            "success": success,
            "result_summary": (
                _structural_payload(result_summary or "")
                if self.content_mode == "structural"
                else _safe_text(result_summary or "")
            ),
        }
        if tool_name in _BUILDER_LIFECYCLE_TOOLS:
            outputs["builder_lifecycle"] = _builder_trace_summary(
                response,
                content_allowed=self.content_allowed,
            )
        child.end(
            outputs=outputs,
            error=self._trace_error(error, error_type=error_type, response=response),
        )
        self._safe_patch(child, f"tool:{_trace_name(tool_name)}")

    @_fail_open_trace_operation(dict)
    def handoff_headers(self, run: Any | None = None) -> dict[str, str]:
        """Return only LangSmith's distributed-trace headers for HTTP handoff."""

        source = run or self.root
        if not self.enabled or source is None or self._closed:
            return {}
        raw = source.to_headers()
        if not isinstance(raw, Mapping):
            return {}
        return {
            str(key): str(value)
            for key, value in raw.items()
            if str(key).lower() in _LANGSMITH_HANDOFF_HEADER_NAMES and isinstance(value, str)
        }

    @_fail_open_trace_operation()
    def record_function_response(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        response: Mapping[str, Any] | None,
        success: bool,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        if not self._children_suppressed():
            safe_tool_name = _trace_name(tool_name)
            child = self.root.create_child(
                name=f"function_response:{safe_tool_name}",
                run_type="chain",
                run_id=uuid7(),
                inputs={
                    "tool_call_id": _trace_identifier(tool_call_id, "tool_call_id"),
                    "tool_name": safe_tool_name,
                },
                outputs={
                    "success": success,
                    "response": (
                        _structural_payload(response or {})
                        if self.content_mode == "structural"
                        else _safe_payload(response or {})
                    ),
                },
                extra={
                    "metadata": {
                        "runtime": "gemini_live",
                        "socket_event": True,
                        "function_response": True,
                        "tool_call_id": _trace_metadata_identifier(tool_call_id),
                    }
                },
                tags=["gemini_live", "function_response", safe_tool_name],
            )
            child.end()
            self._safe_post(child, f"function_response:{safe_tool_name}")
        self._record_artifact_announcement_gates(tool_name, response)

    @_fail_open_trace_operation()
    def _record_artifact_announcement_gates(
        self,
        tool_name: str,
        response: Mapping[str, Any] | None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        if tool_name not in {"check_async_task", "list_async_tasks"}:
            return
        gates = _builder_gate_records(tool_name, response)
        gate_batch: list[dict[str, Any]] = []
        for gate in gates:
            if self._children_suppressed():
                # Keep the evidence so root ready/false-ready counts stay
                # truthful; only the rejected child post is skipped.
                gate_batch.append({**gate, "gate_run_id": None})
                continue
            child = self.root.create_child(
                name="artifact.announcement_gate",
                run_type="chain",
                run_id=uuid7(),
                inputs={
                    "task_id": gate.get("task_id"),
                    "build_id": gate.get("build_id"),
                    "observed_status": gate.get("artifact_status"),
                },
                extra={
                    "metadata": {
                        "runtime": "gemini_live",
                        "voice_trace_id": self.trace_id,
                        "task_id": gate.get("task_id"),
                        "build_id": gate.get("build_id"),
                        "operation_id": gate.get("operation_id"),
                    }
                },
                tags=["sophia", "voice", "artifact", "announcement_gate"],
            )
            child.end(
                outputs=_safe_payload(gate),
                error=(
                    "ARTIFACT_EVIDENCE_MISSING"
                    if gate.get("ready_status_observed") and not gate.get("artifact_valid")
                    else None
                ),
            )
            if not self._safe_post(child, "artifact.announcement_gate"):
                return
            enriched_gate = dict(gate)
            enriched_gate["gate_run_id"] = str(child.id)
            gate_batch.append(enriched_gate)
        self._latest_artifact_gate_batch = gate_batch
        self._latest_artifact_gate_recorded_at = time.monotonic() if gate_batch else None
        self._last_ready_claim_text = None

    @_fail_open_trace_operation()
    def _record_spoken_ready_claim(
        self,
        event: Mapping[str, Any],
        *,
        provider_receive_sequence: int | None,
        relay_correlation_id: str | None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        transcript = _output_transcription_text(event)
        if not _is_spoken_ready_claim(transcript):
            return
        normalized = " ".join((transcript or "").lower().split())
        previous = self._last_ready_claim_text
        if previous and (normalized.startswith(previous) or previous.startswith(normalized)):
            return
        self._last_ready_claim_text = normalized

        gates = self._latest_artifact_gate_batch
        gate = gates[0] if len(gates) == 1 else {}
        evidence_unambiguous = len(gates) == 1
        announcement_allowed = bool(evidence_unambiguous and gate.get("announcement_allowed"))
        if not gates:
            failure_code = "ARTIFACT_GATE_MISSING"
        elif not evidence_unambiguous:
            failure_code = "ARTIFACT_GATE_AMBIGUOUS"
        elif gate.get("failure_code"):
            failure_code = (
                gate["failure_code"]
                if isinstance(gate["failure_code"], str)
                else "ARTIFACT_GATE_FAILURE"
            )
        elif not gate.get("artifact_valid"):
            failure_code = "ARTIFACT_NOT_READY"
        else:
            failure_code = None
        evidence_age_ms = (
            max(int((time.monotonic() - self._latest_artifact_gate_recorded_at) * 1000), 0)
            if self._latest_artifact_gate_recorded_at is not None
            else None
        )
        outputs = {
            "announced_ready": True,
            "announcement_allowed": announcement_allowed,
            "decision": "allow" if announcement_allowed else "violation",
            "false_ready": not announcement_allowed,
            "failure_code": failure_code,
            "evidence_record_count": len(gates),
            "evidence_age_ms": evidence_age_ms,
            "evidence_tool_name": gate.get("tool_name"),
            "evidence_status": gate.get("artifact_status"),
            "artifact_valid": bool(gate.get("artifact_valid")),
            "task_id": gate.get("task_id"),
            "thread_id": gate.get("thread_id"),
            "run_id": gate.get("run_id"),
            "build_id": gate.get("build_id"),
            "operation_id": gate.get("operation_id"),
            "gate_run_id": gate.get("gate_run_id"),
        }
        if not self._children_suppressed():
            child = self.root.create_child(
                name="voice.ready_spoken",
                run_type="chain",
                run_id=uuid7(),
                inputs={
                    "transcript": (
                        _structural_payload(transcript or "")
                        if self.content_mode == "structural"
                        else _safe_text(transcript or "")
                    ),
                    "provider_receive_sequence": _trace_metadata_identifier(
                        provider_receive_sequence
                    ),
                    "relay_correlation_id": _trace_metadata_identifier(relay_correlation_id),
                },
                extra={
                    "metadata": {
                        "runtime": "gemini_live",
                        "voice_trace_id": self.trace_id,
                        "provider_receive_sequence": _trace_metadata_identifier(
                            provider_receive_sequence
                        ),
                        "relay_correlation_id": _trace_metadata_identifier(relay_correlation_id),
                        "task_id": gate.get("task_id"),
                        "build_id": gate.get("build_id"),
                        "gate_run_id": gate.get("gate_run_id"),
                    }
                },
                tags=["sophia", "voice", "artifact", "ready_spoken"],
            )
            child.end(
                outputs=_safe_payload(outputs),
                error="FALSE_READY" if not announcement_allowed else None,
            )
            self._safe_post(child, "voice.ready_spoken")
        self._ready_claim_count += 1
        if not announcement_allowed:
            self._false_ready_claim_count += 1

    def close(
        self,
        *,
        conversation_audio: bytes | None = None,
        conversation_audio_mime_type: str = "audio/webm",
        error: str | None = None,
    ) -> None:
        if self.root is None or self._closed:
            return
        self._closed = True
        try:
            if not self.enabled:
                return
            audio_attached = False
            if conversation_audio and self.audio_capture_enabled:
                if len(conversation_audio) <= MAX_AUDIO_ATTACHMENT_BYTES:
                    self.root.attachments["conversation_audio"] = Attachment(
                        mime_type=conversation_audio_mime_type,
                        data=conversation_audio,
                    )
                    audio_attached = True
                else:
                    logger.warning(
                        "gemini.langsmith.audio_skipped session_id=%s byte_length=%s reason=attachment_limit",
                        self.session_id,
                        len(conversation_audio),
                    )
            self.root.end(
                outputs={
                    "voice_runtime_ref": _pseudonym(
                        os.getenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "").encode(),
                        "voice_runtime",
                        self.session_id,
                    ),
                    "event_count": self._event_count,
                    "tool_count": self._tool_count,
                    "ready_claim_count": self._ready_claim_count,
                    "false_ready_claim_count": self._false_ready_claim_count,
                    "last_provider_sequence": self._last_provider_sequence,
                    "conversation_audio_attached": audio_attached,
                    "effective_setup_fingerprint": dict(self._setup_fingerprint),
                    "trace_failure_count": self._failure_count,
                    "children_skipped_ingest_rejected": self._children_skipped,
                },
                error=self._trace_error(error, fallback="session_error"),
                metadata={"trace_status": "completed" if error is None else "error"},
            )
            # Captured before the patch is queued, so a rejection of this
            # very patch can never be mistaken for a clean flush.
            failures_before_patch = self._ingest_health.failure_count
            self.root.patch(exclude_inputs=False)
            self._schedule_background_flush(
                failures_before=failures_before_patch,
                audio_attached=audio_attached,
            )
        except Exception as exc:
            self._disable_tracing("close", exc)

    def _schedule_background_flush(self, *, failures_before: int, audio_attached: bool) -> None:
        """Close returns at once; the SDK flush runs on a daemon thread with a cap."""

        def finish() -> None:
            timed_out: bool | None = None
            try:
                timed_out = bounded_flush(self.client, BACKGROUND_FLUSH_TIMEOUT_SECONDS)
                self._ingest_health.record_flush(
                    failures_before=failures_before,
                    timed_out=timed_out,
                )
            except Exception:
                timed_out = None
            self.flush_timed_out = timed_out
            self._ingest_failures_final = max(
                self._ingest_health.failure_count - self._ingest_failure_baseline,
                0,
            )
            try:
                logger.info(
                    "gemini.langsmith.trace_completed session_id=%s trace_id=%s event_count=%s "
                    "tool_count=%s audio_attached=%s ingest_status=%s flush_timed_out=%s "
                    "ingest_failures=%s children_skipped=%s",
                    self.session_id,
                    self._trace_id_unchecked(),
                    self._event_count,
                    self._tool_count,
                    audio_attached,
                    self.ingest_status,
                    timed_out,
                    self._ingest_failures_final,
                    self._children_skipped,
                )
            except Exception:
                pass

        thread = threading.Thread(target=finish, name="gemini-langsmith-flush", daemon=True)
        self._flush_thread = thread
        try:
            thread.start()
        except RuntimeError:
            # Interpreter shutdown: the bounded flush runs inline instead.
            self._flush_thread = None
            finish()

    def _trace_id_unchecked(self) -> str | None:
        return str(self.root.id) if self.root is not None else None

    def _disable_tracing(self, operation: str, exc: Exception) -> None:
        if not self.enabled and self._disabled_operation is not None:
            return
        self.enabled = False
        self.audio_capture_enabled = False
        self._failure_count += 1
        self._disabled_operation = operation
        try:
            # Class name only: SDK exception messages can carry response bodies.
            logger.warning(
                "gemini.langsmith.trace_disabled session_id=%s trace_id=%s operation=%s error_type=%s",
                self.session_id,
                self._trace_id_unchecked(),
                operation,
                _error_type_name(exc),
            )
        except Exception:
            pass
        if self._failure_callback is not None:
            try:
                self._failure_callback(operation, exc)
            except Exception:
                pass

    def _safe_post(self, run: Any, label: str) -> bool:
        try:
            run.post()
            return True
        except Exception as exc:
            self._disable_tracing(f"post:{label}", exc)
            return False

    def _safe_patch(self, run: Any, label: str) -> bool:
        try:
            run.patch()
            return True
        except Exception as exc:
            self._disable_tracing(f"patch:{label}", exc)
            return False
