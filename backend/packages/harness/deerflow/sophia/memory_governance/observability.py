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
from uuid import uuid4

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
_PROCESS_REF = "process:" + str(uuid4())
_PROCESS_STARTED_AT = datetime.now(UTC).isoformat()
_EVENT_COUNTS: Counter[str] = Counter()
_EXPORT_COUNTS: Counter[str] = Counter()
_METRIC_EVENT_NAMES = frozenset({
    "memory.session.finalized", "memory.session.recap_cleanup",
    "memory.clear.command", "memory.clear.recovery",
    "memory.extraction.completed", "memory.extraction.replacement_queued",
    "memory.projection.job", "memory.projection.database_completion_unavailable",
    "memory.retrieval.denied", "memory.prompt.admission",
    "memory.context.transition", "memory.context.rebuild", "memory.context.pending_input", "memory.context.entry_denied",
    "memory.model.transport", "memory.model.result", "memory.model.tool.origin", "memory.builder.file",
    "memory.source.upload",
    "memory.policy.violation",
})
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
    owned_client = None
    owned_session = None
    try:
        payload = build_memory_langsmith_run_payload(envelope)
        if client is None:
            from langsmith import Client

            from .trace_session import OwnedTraceSession

            owned_session = OwnedTraceSession()

            kwargs: dict[str, Any] = {
                # Completed structural point events use direct posting. Do not
                # allocate a background queue that outlives this owned client.
                "auto_batch_tracing": False,
                # Point-event export does not pull prompts and must not take
                # ownership of the SDK's process-global prompt cache.
                "disable_prompt_cache": True,
                "session": owned_session,
                "api_url": (os.getenv("LANGSMITH_ENDPOINT") or os.getenv("LANGCHAIN_ENDPOINT") or "https://api.smith.langchain.com"),
                "api_key": (os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY") or ""),
            }
            workspace_id = (os.getenv("LANGSMITH_WORKSPACE_ID") or "").strip()
            if workspace_id:
                kwargs["workspace_id"] = workspace_id
            client = Client(**kwargs)
            owned_client = client
        create_run = getattr(client, "create_run")
        create_run(**payload)
        _LAST_EXPORT_STATUS = "exported"
    except Exception:  # noqa: BLE001 - observability cannot weaken product safety.
        _LAST_EXPORT_STATUS = "unavailable"
        logger.warning("memory_langsmith_export status=unavailable contentExcluded=true", exc_info=False)
    finally:
        if owned_client is not None:
            try:
                owned_client.close(timeout=0)
            except Exception:
                _LAST_EXPORT_STATUS = "unavailable"
                logger.warning("memory_langsmith_cleanup status=unavailable contentExcluded=true", exc_info=False)
        if owned_session is not None:
            # Also close after constructor failure or an SDK close that stopped
            # early. The session keeps only the fact of any cleanup failure.
            owned_session.close()
            if owned_session.cleanup_failed:
                _LAST_EXPORT_STATUS = "unavailable"
                logger.warning("memory_langsmith_cleanup status=unavailable contentExcluded=true", exc_info=False)
    return _LAST_EXPORT_STATUS


def _deployment_sha() -> str:
    for name in ("RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "SOPHIA_DEPLOYMENT_SHA"):
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return "unknown"


def _environment() -> str:
    for name in ("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT", "SOPHIA_ENV", "ENVIRONMENT"):
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
    global _LAST_EXPORT_STATUS
    try:
        _validate_structural_payload(fields)
    except ValueError:
        increment_counter("memory_redaction_failure_total")
        raise
    envelope = {
        "schema": EVENT_SCHEMA,
        "event_name": event_name,
        "occurred_at": datetime.now(UTC).isoformat(),
        "environment": _environment(),
        "service": service,
        "deployment_sha": _deployment_sha(),
        "memory_contract_epoch": int(os.getenv("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH", "1")),
        "outcome": outcome,
        **fields,
    }
    logger.info("memory_event %s", json.dumps(envelope, sort_keys=True, separators=(",", ":")))
    export_status = _export_langsmith(
        envelope,
        force_unavailable=_consume_langsmith_fault(fault_owner_id),
    )
    # Fixed dimensions only: never retain owner/query refs or arbitrary payload
    # strings in metrics. This measures this serving process, not a new shell.
    with _LOCK:
        _LAST_EXPORT_STATUS = export_status if export_status in {"exported", "unavailable", "disabled"} else "unknown"
        _EVENT_COUNTS[event_name if event_name in _METRIC_EVENT_NAMES else "other"] += 1
        _EXPORT_COUNTS[_LAST_EXPORT_STATUS] += 1
        if _LAST_EXPORT_STATUS == "unavailable":
            _COUNTERS["memory_observation_gap_total"] += 1
    return export_status


def record_memory_observation_gap() -> None:
    """A local failed observation is evidence loss, not a policy escape."""
    global _LAST_EXPORT_STATUS
    with _LOCK:
        _COUNTERS["memory_observation_gap_total"] += 1
        _LAST_EXPORT_STATUS = "unavailable"


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


def runtime_metric_snapshot() -> dict[str, object]:
    """Live process diagnostics, explicitly not an aggregate release certificate.

    Durable lifecycle gauges and cross-service coverage must be joined separately.
    A process restart creates a new observation window and process reference.
    """
    with _LOCK:
        events = dict(_EVENT_COUNTS)
        exports = dict(_EXPORT_COUNTS)
        zeros = {name: _COUNTERS.get(name, 0) for name in sorted(ZERO_TOLERANCE_COUNTERS)}
        evidence_gaps = _COUNTERS.get("memory_observation_gap_total", 0)
    return {
        "schema": "mem00.runtime-metrics.v1",
        "scope": "serving_process_since_start",
        "process_ref": _PROCESS_REF,
        "started_at": _PROCESS_STARTED_AT,
        "observed_at": datetime.now(UTC).isoformat(),
        "deployment_sha": _deployment_sha(),
        "environment": _environment(),
        "memory_contract_epoch": int(os.getenv("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH", "1")),
        "event_count": sum(events.values()),
        "evidence_gap_count": evidence_gaps,
        "events_by_name": events,
        "exports_by_status": exports,
        "last_export_status": langsmith_export_status(),
        "zero_tolerance_counters": zeros,
        # A default zero is not evidence that a violation detector ran. These
        # declarations describe actual production wiring, not test increments.
        # The redaction detector itself only checks denied keys, not all text.
        "detector_coverage": {
            name: ("denied_key_validation_only" if name == "memory_redaction_failure_total"
                   else "transport_wrapper_only_factory_integration_pending" if name in {"memory_policy_escape_total", "memory_cross_owner_admission_total"}
                   else "not_instrumented")
            for name in sorted(ZERO_TOLERANCE_COUNTERS)
        },
        "security_status": "SECURITY_HOLD" if any(zeros.values()) else "no_violation_observed",
        "coverage": "partial",
        "release_certified": False,
        "missing_coverage": ["zero_tolerance_detector_coverage", "durable_lifecycle_gauges", "latency_histograms", "cross_service_observation_windows", "complete_consumer_fault_matrix"],
    }


def record_raw_provider_write_refusal(owner_id: str) -> None:
    """Observe a governed legacy add attempt, not a successful provider escape.

    The caller has already resolved current durable governed authority and
    continues to refuse the write regardless of exporter availability.
    """
    increment_counter("memory_raw_provider_bypass_total")
    try:
        from .refs import keyed_ref

        emit_memory_event("memory.policy.violation", service="memory-legacy-facade", outcome="SECURITY_HOLD",
            owner_ref=keyed_ref("owner", owner_id), safe_reason_code="raw_memory_write_disabled_by_mem00",
            detection_scope="governed_legacy_add_refusal", provider_called=False)
    except Exception:
        record_memory_observation_gap()


def reset_counters_for_test() -> None:
    global _LAST_EXPORT_STATUS
    with _LOCK:
        _COUNTERS.clear()
        _EVENT_COUNTS.clear()
        _EXPORT_COUNTS.clear()
    _LAST_EXPORT_STATUS = "not_attempted"


def langsmith_export_status() -> str:
    return _LAST_EXPORT_STATUS
