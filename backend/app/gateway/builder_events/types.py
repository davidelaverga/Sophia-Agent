"""Canonical Builder event envelope shared by all ingress and sinks.

The fanout (``backend/app/gateway/builder_events/fanout.py``) accepts
``BuilderEvent`` instances from two ingress points:

- the existing ``/internal/builder-events`` webhook (terminal events;
  adapted via ``webhook_payload_to_event`` in ``adapters.py``)
- the Stage 2 gateway-side ``runs.stream`` consumer (mid-flight events;
  adapted via ``chunk_to_events`` in ``adapters.py``)

Sinks read the same envelope shape regardless of ingress.

Mode discrimination: ``parent_thread_id is not None`` ⇔ Builder is a
subagent (companion delegated via ``start_builder_task``). ``None`` ⇔
Builder is the main agent (Work bot DM, future direct web). This mirrors
``sophia_builder_as_main_work_bot_spec.md`` D3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

BuilderEventType = Literal[
    "started",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "phase",
    "tool_started",
    "tool_completed",
    "ai_message_chunk",
    "todo_updated",
    "artifact_emitted",
]

_TERMINAL_EVENT_TYPES: frozenset[str] = frozenset({"completed", "failed", "cancelled", "timed_out"})


@dataclass(frozen=True)
class BuilderEvent:
    """Canonical event shape for everything fanout dispatches."""

    thread_id: str
    parent_thread_id: str | None
    user_id: str
    trace_id: str
    event_type: BuilderEventType
    payload: dict[str, Any] = field(default_factory=dict)
    sequence: int = 0
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))
    source: Literal["stream", "webhook"] = "stream"
    # The langgraph run instance this event belongs to. Sinks key
    # placeholders by ``(thread_id, run_id)`` so concurrent or back-to-back
    # builds on the SAME thread don't clobber each other's chat surface
    # (Codex review 2026-05-13). ``None`` is tolerated for webhook-source
    # terminals (the existing wire shape doesn't carry run_id); sinks fall
    # back to the most-recent placeholder for the thread in that case.
    run_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "parent_thread_id": self.parent_thread_id,
            "user_id": self.user_id,
            "trace_id": self.trace_id,
            "event_type": self.event_type,
            "payload": dict(self.payload),
            "sequence": self.sequence,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
            "run_id": self.run_id,
        }

    @property
    def is_terminal(self) -> bool:
        return self.event_type in _TERMINAL_EVENT_TYPES

    @property
    def is_subagent_mode(self) -> bool:
        return self.parent_thread_id is not None
