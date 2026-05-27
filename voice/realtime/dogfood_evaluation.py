from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from typing import Any


TimestampValue = str | int | float


@dataclass(frozen=True)
class DogfoodEventSummary:
    session_id: str | None = None
    provider: str | None = None
    transport: str | None = None
    evidence_status: str = "empty"
    total_events: int = 0
    normalized_event_count: int = 0
    event_counts: dict[str, int] = field(default_factory=dict)
    first_event_type: str | None = None
    last_event_type: str | None = None
    first_event_at: TimestampValue | None = None
    last_event_at: TimestampValue | None = None
    first_event_at_by_type: dict[str, TimestampValue] = field(default_factory=dict)
    has_user_transcript: bool = False
    has_agent_started: bool = False
    has_agent_ended: bool = False
    has_final_transcript: bool = False
    has_artifact: bool = False
    has_builder_task: bool = False
    diagnostic_count: int = 0
    interruption_marker_count: int = 0
    provider_error_count: int = 0
    close_reason: str | None = None
    missing_required_events: tuple[str, ...] = ()
    non_sophia_event_types: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_dogfood_events(
    events: Iterable[Mapping[str, Any] | object],
    *,
    session_id: str | None = None,
    provider: str | None = None,
    transport: str | None = None,
) -> DogfoodEventSummary:
    payloads = [_payload_from_event(event) for event in events]
    payloads = [payload for payload in payloads if payload is not None]

    event_counts: Counter[str] = Counter()
    first_event_at_by_type: dict[str, TimestampValue] = {}
    non_sophia_event_types: set[str] = set()

    first_event_type: str | None = None
    last_event_type: str | None = None
    first_event_at: TimestampValue | None = None
    last_event_at: TimestampValue | None = None
    has_user_transcript = False
    has_agent_started = False
    has_agent_ended = False
    has_final_transcript = False
    has_artifact = False
    has_builder_task = False
    diagnostic_count = 0
    interruption_marker_count = 0
    provider_error_count = 0
    close_reason: str | None = None

    for payload in payloads:
        event_type = _string_value(payload.get("type")) or "unknown"
        data = _record_value(payload.get("data")) or {}
        event_counts[event_type] += 1
        if first_event_type is None:
            first_event_type = event_type
        last_event_type = event_type

        if not event_type.startswith("sophia."):
            non_sophia_event_types.add(event_type)

        timestamp = _timestamp_value(payload, data)
        if timestamp is not None:
            if first_event_at is None:
                first_event_at = timestamp
            last_event_at = timestamp
            first_event_at_by_type.setdefault(event_type, timestamp)

        if event_type == "sophia.user_transcript":
            has_user_transcript = True
        elif event_type == "sophia.transcript":
            has_final_transcript = has_final_transcript or data.get("is_final") is True
        elif event_type == "sophia.artifact":
            has_artifact = True
        elif event_type == "sophia.builder_task":
            has_builder_task = True
        elif event_type == "sophia.turn":
            phase = _string_value(data.get("phase"))
            reason = _string_value(data.get("reason"))
            has_agent_started = has_agent_started or phase == "agent_started"
            has_agent_ended = has_agent_ended or phase == "agent_ended"
            if reason in {"interrupted", "cancelled"}:
                interruption_marker_count += 1
            if phase == "agent_ended" and reason:
                close_reason = reason
        elif event_type == "sophia.turn_diagnostic":
            diagnostic_count += 1
            reason = _string_value(data.get("reason"))
            if data.get("interrupted") is True or reason in {"interrupted", "cancelled"}:
                interruption_marker_count += 1
            if reason == "provider_error":
                provider_error_count += 1
            if reason and close_reason is None:
                close_reason = reason

    missing_required_events = _missing_required_events(
        has_user_transcript=has_user_transcript,
        has_agent_started=has_agent_started,
        has_agent_ended=has_agent_ended,
        has_final_transcript=has_final_transcript,
        has_artifact=has_artifact,
    )
    evidence_status = _evidence_status(
        total_events=len(payloads),
        missing_required_events=missing_required_events,
        provider_error_count=provider_error_count,
        non_sophia_event_types=non_sophia_event_types,
    )

    return DogfoodEventSummary(
        session_id=session_id,
        provider=provider,
        transport=transport,
        evidence_status=evidence_status,
        total_events=len(payloads),
        normalized_event_count=sum(
            count for event_type, count in event_counts.items() if event_type.startswith("sophia.")
        ),
        event_counts=dict(sorted(event_counts.items())),
        first_event_type=first_event_type,
        last_event_type=last_event_type,
        first_event_at=first_event_at,
        last_event_at=last_event_at,
        first_event_at_by_type=dict(sorted(first_event_at_by_type.items())),
        has_user_transcript=has_user_transcript,
        has_agent_started=has_agent_started,
        has_agent_ended=has_agent_ended,
        has_final_transcript=has_final_transcript,
        has_artifact=has_artifact,
        has_builder_task=has_builder_task,
        diagnostic_count=diagnostic_count,
        interruption_marker_count=interruption_marker_count,
        provider_error_count=provider_error_count,
        close_reason=close_reason,
        missing_required_events=missing_required_events,
        non_sophia_event_types=tuple(sorted(non_sophia_event_types)),
    )


def _payload_from_event(event: Mapping[str, Any] | object) -> dict[str, Any] | None:
    if isinstance(event, Mapping):
        return dict(event)

    as_payload = getattr(event, "as_payload", None)
    if not callable(as_payload):
        return None

    payload = as_payload()
    return dict(payload) if isinstance(payload, Mapping) else None


def _missing_required_events(
    *,
    has_user_transcript: bool,
    has_agent_started: bool,
    has_agent_ended: bool,
    has_final_transcript: bool,
    has_artifact: bool,
) -> tuple[str, ...]:
    missing: list[str] = []
    if not has_user_transcript:
        missing.append("sophia.user_transcript")
    if not has_agent_started:
        missing.append("sophia.turn:agent_started")
    if not has_final_transcript:
        missing.append("sophia.transcript:is_final")
    if not has_artifact:
        missing.append("sophia.artifact")
    if not has_agent_ended:
        missing.append("sophia.turn:agent_ended")
    return tuple(missing)


def _evidence_status(
    *,
    total_events: int,
    missing_required_events: tuple[str, ...],
    provider_error_count: int,
    non_sophia_event_types: set[str],
) -> str:
    if total_events == 0:
        return "empty"
    if non_sophia_event_types:
        return "provider_leak"
    if provider_error_count:
        return "provider_error"
    if missing_required_events:
        return "incomplete"
    return "complete"


def _timestamp_value(
    payload: Mapping[str, Any],
    data: Mapping[str, Any],
) -> TimestampValue | None:
    for key in ("timestamp", "created_at", "captured_at", "received_at", "at"):
        value = payload.get(key)
        if isinstance(value, str | int | float):
            return value
        data_value = data.get(key)
        if isinstance(data_value, str | int | float):
            return data_value
    return None


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None