from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.sophia.build_runtime.identity import new_monotonic_id

logger = logging.getLogger(__name__)
_DEFAULT_EVENT_SINK: BuildEventSink | None = None
_DEFAULT_EVENT_SINK_LOCK = threading.Lock()

BuildEventType = Literal[
    "build.created",
    "build.deadline_exceeded",
    "prepare.emitted",
    "prepare.execution_started",
    "prepare.result_recorded",
    "prepare.service_started",
    "prepare.service_finished",
    "manifest.created",
    "manifest.committed",
    "component.version_created",
    "artifact.version_created",
    "mutation.prepared",
    "mutation.verified",
    "mutation.committed",
    "mutation.rolled_back",
    "boundary.reached",
    "artifact.accepted",
    "build.terminal",
]

_ALLOWED_METRICS = frozenset(
    {
        "elapsed_ms",
        "duration_ms",
        "attempt",
        "slide_count",
        "source_bytes",
        "assembled_bytes",
        "success",
        "retryable",
        "result_count",
        "cost_usd",
        "input_tokens",
        "output_tokens",
    }
)


class BuildOperationEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["sophia-build-event/v1"] = "sophia-build-event/v1"
    event_id: str = Field(default_factory=lambda: new_monotonic_id("event"))
    sequence: int = Field(ge=1)
    event_type: BuildEventType
    occurred_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    user_id: str
    thread_id: str
    task_id: str | None = None
    run_id: str | None = None
    build_id: str
    operation_id: str | None = None
    tool_call_id: str | None = None
    transaction_id: str | None = None
    quality_run_id: str | None = None
    manifest_revision: int | None = None
    status: str | None = None
    failure_code: str | None = None
    route_name: str | None = None
    deployment_name: str | None = None
    profile_version: str | None = None
    metrics: dict[str, int | float | bool | str | None] = Field(default_factory=dict)

    @field_validator("metrics")
    @classmethod
    def validate_metrics(cls, value: dict[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(value) - _ALLOWED_METRICS)
        if unknown:
            raise ValueError(f"unsupported build event metrics: {', '.join(unknown)}")
        encoded = json.dumps(value, separators=(",", ":"), sort_keys=True)
        if len(encoded.encode()) > 4096:
            raise ValueError("build event metrics exceed 4096 bytes")
        return value


class BuildEventSink(Protocol):
    def append(self, event: BuildOperationEvent) -> None: ...

    def replay(self, *, build_id: str) -> Iterable[BuildOperationEvent]: ...


def configure_default_event_sink(sink: BuildEventSink | None) -> None:
    global _DEFAULT_EVENT_SINK
    with _DEFAULT_EVENT_SINK_LOCK:
        _DEFAULT_EVENT_SINK = sink


def configure_default_event_sink_once(
    factory: Callable[[], BuildEventSink | None],
) -> BuildEventSink | None:
    """Install one process-owned sink without constructing replacements."""
    global _DEFAULT_EVENT_SINK
    with _DEFAULT_EVENT_SINK_LOCK:
        if _DEFAULT_EVENT_SINK is None:
            _DEFAULT_EVENT_SINK = factory()
        return _DEFAULT_EVENT_SINK


def default_event_sink_status() -> str:
    sink = _DEFAULT_EVENT_SINK
    if sink is None:
        return "disabled"
    status = getattr(sink, "availability_status", None)
    return str(status or "available")


class InMemoryBuildEventSink:
    def __init__(self) -> None:
        self._events: dict[str, dict[str, BuildOperationEvent]] = {}

    def append(self, event: BuildOperationEvent) -> None:
        self._events.setdefault(event.build_id, {}).setdefault(event.event_id, event)

    def replay(self, *, build_id: str) -> list[BuildOperationEvent]:
        return sorted(self._events.get(build_id, {}).values(), key=lambda event: event.sequence)


class JsonlBuildEventProjection:
    """Single-process JSONL projection; durable event authority lives in Postgres."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def append(self, event: BuildOperationEvent) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = event.model_dump_json(exclude_none=True) + "\n"
        with self._lock, self._path.open("a", encoding="utf-8") as handle:
            handle.write(line)

    def replay(self, *, build_id: str) -> list[BuildOperationEvent]:
        if not self._path.is_file():
            return []
        events: dict[str, BuildOperationEvent] = {}
        for line in self._path.read_text(encoding="utf-8").splitlines():
            event = BuildOperationEvent.model_validate_json(line)
            if event.build_id == build_id:
                events.setdefault(event.event_id, event)
        return sorted(events.values(), key=lambda event: event.sequence)


def record_runtime_event(
    *,
    state: dict[str, Any],
    runtime: Any,
    event_type: BuildEventType,
    tool_call_id: str | None = None,
    status: str | None = None,
    failure_code: str | None = None,
    metrics: dict[str, int | float | bool | str | None] | None = None,
) -> BuildOperationEvent | None:
    """Record an event through an injected sink without coupling to storage."""
    context = _runtime_context(runtime)
    sink = context.get("build_event_sink") or _DEFAULT_EVENT_SINK
    scope = _runtime_event_scope(state, runtime, context)
    if sink is None or scope is None or not callable(getattr(sink, "append", None)):
        return None
    sequence = _next_sequence(sink, build_id=scope["build_id"], event_type=event_type)
    if sequence is None:
        return None
    event = BuildOperationEvent(
        sequence=sequence,
        event_type=event_type,
        user_id=scope["user_id"],
        thread_id=scope["thread_id"],
        task_id=str(state.get("task_id") or "") or None,
        run_id=str(state.get("run_id") or "") or None,
        build_id=scope["build_id"],
        operation_id=str(state.get("builder_operation_id") or state.get("operation_id") or "") or None,
        tool_call_id=tool_call_id,
        status=status,
        failure_code=failure_code,
        metrics=metrics or {},
    )
    return event if _append_event(sink, event) else None


def _runtime_context(runtime: Any) -> dict[str, Any]:
    value = getattr(runtime, "context", None) if runtime is not None else None
    return value if isinstance(value, dict) else {}


def _runtime_event_scope(
    state: dict[str, Any],
    runtime: Any,
    context: dict[str, Any],
) -> dict[str, str] | None:
    scope = {
        "build_id": _runtime_identity_value(state, runtime, context, "builder_build_id", "build_id"),
        "user_id": _runtime_identity_value(state, runtime, context, "user_id"),
        "thread_id": _runtime_identity_value(state, runtime, context, "thread_id"),
    }
    return scope if all(scope.values()) else None


def _runtime_identity_value(
    state: dict[str, Any],
    runtime: Any,
    context: dict[str, Any],
    *keys: str,
) -> str:
    for source in (state, state.get("builder_task"), state.get("delegation_context")):
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            if value not in (None, ""):
                return str(value).strip()

    execution_info = getattr(runtime, "execution_info", None) if runtime is not None else None
    for key in keys:
        value = getattr(execution_info, key, None) if execution_info is not None else None
        if value not in (None, ""):
            return str(value).strip()

    for key in keys:
        value = context.get(key)
        if value not in (None, ""):
            return str(value).strip()

    config = getattr(runtime, "config", None) if runtime is not None else None
    if isinstance(config, dict):
        for source_name in ("configurable", "metadata"):
            source = config.get(source_name)
            if not isinstance(source, dict):
                continue
            for key in keys:
                value = source.get(key)
                if value not in (None, ""):
                    return str(value).strip()
    return ""


def _next_sequence(sink: Any, *, build_id: str, event_type: str) -> int | None:
    replay = getattr(sink, "replay", None)
    try:
        prior = list(replay(build_id=build_id)) if callable(replay) else []
    except Exception as exc:
        if str(getattr(sink, "availability_status", "")) == "unavailable":
            return None
        logger.warning(
            "[BuildEvent] replay failed event_type=%s error_class=%s payloadExcluded=true",
            event_type,
            type(exc).__name__,
        )
        return None
    return max((item.sequence for item in prior), default=0) + 1


def _append_event(sink: Any, event: BuildOperationEvent) -> bool:
    try:
        sink.append(event)
        return True
    except Exception as exc:
        if str(getattr(sink, "availability_status", "")) == "unavailable":
            return False
        logger.warning(
            "[BuildEvent] persistence failed event_type=%s error_class=%s payloadExcluded=true",
            event.event_type,
            type(exc).__name__,
        )
        return False
