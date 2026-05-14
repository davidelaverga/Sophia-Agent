"""BuilderEvent typed projections — Phase 1 foundation.

The fanout consumes deepagents v3 stream projections + the terminal
completion webhook, normalises both into the discriminated union
``BuilderEvent`` below, and dispatches to sinks. The shape is
content-block-centric so sinks don't have to disambiguate between
``messages-tuple`` / ``values`` / custom mode payloads.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.1.

Design notes:

- ``channel_origin`` determines which sinks accept the event. ``"voice"``
  and ``"web"`` are reserved but only ``"telegram"`` activates the
  ``WorkshopTelegramSink`` in Phase 1.
- ``sequence`` is a per-task monotonic int. The fanout uses
  ``(task_id, type, sequence)`` for dedup. Stream consumer increments
  it; the terminal webhook adapter uses ``sys.maxsize`` (always last).
- ``subagent_id == None`` means "this is the main builder agent". Phase
  1 does not render nested subagents in Telegram (spec §13.2).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ChannelOrigin = Literal["telegram", "web", "voice"]


class BuilderEventBase(BaseModel):
    """Common fields for every BuilderEvent variant."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    task_id: str
    thread_id: str
    user_id: str | None = None
    channel_origin: ChannelOrigin = "telegram"
    timestamp_ms: int
    sequence: int


class MessageDeltaEvent(BuilderEventBase):
    """Streaming text from an assistant turn (``messages-tuple`` channel)."""

    type: Literal["message_delta"] = "message_delta"
    role: Literal["assistant"] = "assistant"
    delta: str
    subagent_id: str | None = None  # None == main builder


class ToolCallEvent(BuilderEventBase):
    """Tool-call lifecycle event (started / completed / failed)."""

    type: Literal["tool_call"] = "tool_call"
    tool_call_id: str
    tool_name: str
    args: dict[str, Any] = Field(default_factory=dict)
    status: Literal["started", "completed", "failed"]
    result_preview: str | None = None
    subagent_id: str | None = None


class SubagentEvent(BuilderEventBase):
    """Nested-subagent lifecycle (Phase 1 does not render these)."""

    type: Literal["subagent"] = "subagent"
    subagent_id: str
    subagent_type: str
    status: Literal["spawned", "running", "completed", "failed"]
    description: str | None = None


class CustomEvent(BuilderEventBase):
    """``custom`` channel event — phase tags etc."""

    type: Literal["custom"] = "custom"
    name: str
    payload: dict[str, Any] = Field(default_factory=dict)
    subagent_id: str | None = None


class CompletedEvent(BuilderEventBase):
    """Terminal completion event.

    Sourced from the existing ``/internal/builder-events`` webhook in
    Phase 1; the v3 stream consumer may also emit one once it sees the
    builder graph reach a terminal lifecycle event.
    """

    type: Literal["completed"] = "completed"
    status: Literal["completed", "failed", "cancelled", "timed_out"]
    artifact_path: str | None = None
    artifact_type: str | None = None
    artifact_url: str | None = None
    artifact_filename: str | None = None
    companion_summary: str | None = None
    user_next_action: str | None = None
    error: str | None = None


BuilderEvent = Annotated[
    MessageDeltaEvent | ToolCallEvent | SubagentEvent | CustomEvent | CompletedEvent,
    Field(discriminator="type"),
]


TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled", "timed_out"})


def is_terminal_event(event: BuilderEvent) -> bool:
    """Return True for ``CompletedEvent`` regardless of inner status."""
    return event.type == "completed"


__all__ = [
    "BuilderEvent",
    "BuilderEventBase",
    "ChannelOrigin",
    "CompletedEvent",
    "CustomEvent",
    "MessageDeltaEvent",
    "SubagentEvent",
    "TERMINAL_STATUSES",
    "ToolCallEvent",
    "is_terminal_event",
]
