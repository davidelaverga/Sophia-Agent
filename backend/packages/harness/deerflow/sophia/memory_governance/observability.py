"""Content-free MEM00 structural events and zero-tolerance counters."""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

EVENT_SCHEMA = "sophia.memory.event.v1"
ZERO_TOLERANCE_COUNTERS = frozenset(
    {
        "memory_policy_escape_total",
        "memory_cross_owner_admission_total",
        "memory_post_tombstone_admission_total",
        "memory_raw_provider_bypass_total",
        "legacy_identity_loaded_total",
        "memory_redaction_failure_total",
    }
)

_COUNTERS: Counter[str] = Counter()
_LOCK = threading.Lock()
_LAST_EXPORT_STATUS = "not_attempted"
_DENIED_KEYS = frozenset(
    {
        "content",
        "canonical_content",
        "memory",
        "query",
        "transcript",
        "provider_memory_id",
        "user_id",
        "session_id",
        "authorization",
        "api_key",
        "token",
        "secret",
    }
)


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _validate_structural_payload(value: object, *, path: tuple[str, ...] = ()) -> None:
    """Reject content-bearing fields anywhere in a trace payload."""

    if isinstance(value, Mapping):
        for raw_key, nested in value.items():
            key = str(raw_key).lower()
            if key in _DENIED_KEYS:
                raise ValueError("memory_event_contains_denied_fields")
            _validate_structural_payload(nested, path=(*path, key))
        return
    if isinstance(value, (list, tuple)):
        for index, nested in enumerate(value):
            _validate_structural_payload(nested, path=(*path, str(index)))
        return
    if value is not None and not isinstance(value, (str, int, float, bool)):
        raise ValueError("memory_event_contains_unserializable_value")


def build_memory_langsmith_run_payload(envelope: Mapping[str, object]) -> dict[str, Any]:
    """Build the exact content-free payload sent to LangSmith."""

    _validate_structural_payload(envelope)
    event_name = str(envelope.get("event_name") or "memory.unknown")
    safe_reason = envelope.get("safe_reason_code")
    occurred_at = envelope.get("occurred_at")
    try:
        if not isinstance(occurred_at, str):
            raise ValueError
        timestamp = datetime.fromisoformat(occurred_at)
        if timestamp.utcoffset() is None:
            raise ValueError
    except ValueError:
        raise ValueError("memory_event_timestamp_invalid") from None
    return {
        "name": event_name,
        "run_type": "tool",
        "inputs": {},
        "outputs": {
            "outcome": str(envelope.get("outcome") or "unknown"),
            "safe_reason_code": str(safe_reason) if safe_reason is not None else None,
        },
        # Client.create_run persists governance metadata under extra.metadata.
        # A top-level metadata argument is not a hosted searchable metadata join.
        "extra": {"metadata": dict(envelope)},
        # These are completed point events, not an invented operation duration.
        "start_time": occurred_at,
        "end_time": occurred_at,
        "tags": ["sophia", "memory-governance", EVENT_SCHEMA],
        "project_name": (os.getenv("LANGSMITH_PROJECT") or os.getenv("LANGCHAIN_PROJECT") or "Sophia"),
    }


def _export_langsmith(
    envelope: Mapping[str, object],
    *,
    client: object | None = None,
    force_unavailable: bool = False,
) -> str:
    """Export one structural span without making product behavior depend on tracing."""

    global _LAST_EXPORT_STATUS
    if force_unavailable:
        _LAST_EXPORT_STATUS = "unavailable"
        logger.warning("memory_langsmith_export status=unavailable contentExcluded=true", exc_info=False)
        return _LAST_EXPORT_STATUS
    if not _truthy(os.getenv("SOPHIA_MEMORY_LANGSMITH_EXPORT")):
        _LAST_EXPORT_STATUS = "disabled"
        return _LAST_EXPORT_STATUS
    try:
        payload = build_memory_langsmith_run_payload(envelope)
        if client is None:
            from langsmith import Client

            kwargs: dict[str, Any] = {
                "api_url": (os.getenv("LANGSMITH_ENDPOINT") or os.getenv("LANGCHAIN_ENDPOINT") or "https://api.smith.langchain.com"),
                "api_key": (os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY") or ""),
            }
            workspace_id = (os.getenv("LANGSMITH_WORKSPACE_ID") or "").strip()
            if workspace_id:
                kwargs["workspace_id"] = workspace_id
            client = Client(**kwargs)
        create_run = getattr(client, "create_run")
        create_run(**payload)
        _LAST_EXPORT_STATUS = "exported"
    except Exception:  # noqa: BLE001 - observability cannot weaken product safety.
        _LAST_EXPORT_STATUS = "unavailable"
        logger.warning("memory_langsmith_export status=unavailable contentExcluded=true", exc_info=False)
    return _LAST_EXPORT_STATUS


def _deployment_sha() -> str:
    for name in ("RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "SOPHIA_DEPLOYMENT_SHA"):
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return "unknown"


def _consume_langsmith_fault(owner_id: str | None) -> bool:
    if not owner_id:
        return False
    try:
        from .faults import MemoryFaultController

        return MemoryFaultController().consume(
            owner_id=owner_id,
            mode="langsmith_unavailable",
        )
    except Exception:  # noqa: BLE001 - tracing fault checks cannot affect product behavior.
        return False


def emit_memory_event(
    event_name: str,
    *,
    service: str,
    outcome: str,
    fault_owner_id: str | None = None,
    **fields: object,
) -> str:
    try:
        _validate_structural_payload(fields)
    except ValueError:
        increment_counter("memory_redaction_failure_total")
        raise
    envelope = {
        "schema": EVENT_SCHEMA,
        "event_name": event_name,
        "occurred_at": datetime.now(UTC).isoformat(),
        "environment": (os.getenv("SOPHIA_ENV") or os.getenv("ENVIRONMENT") or "unknown"),
        "service": service,
        "deployment_sha": _deployment_sha(),
        "memory_contract_epoch": int(os.getenv("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH", "1")),
        "outcome": outcome,
        **fields,
    }
    logger.info("memory_event %s", json.dumps(envelope, sort_keys=True, separators=(",", ":")))
    return _export_langsmith(
        envelope,
        force_unavailable=_consume_langsmith_fault(fault_owner_id),
    )


def increment_counter(name: str, amount: int = 1) -> None:
    if amount < 0:
        raise ValueError("memory_counter_amount_invalid")
    with _LOCK:
        _COUNTERS[name] += amount


def counter_snapshot() -> Mapping[str, int]:
    with _LOCK:
        result = dict(_COUNTERS)
    for name in ZERO_TOLERANCE_COUNTERS:
        result.setdefault(name, 0)
    return result


def reset_counters_for_test() -> None:
    global _LAST_EXPORT_STATUS
    with _LOCK:
        _COUNTERS.clear()
    _LAST_EXPORT_STATUS = "not_attempted"


def langsmith_export_status() -> str:
    return _LAST_EXPORT_STATUS
