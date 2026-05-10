"""Adapters from external event shapes to ``BuilderEvent``.

Two adapter families:

- ``webhook_payload_to_event`` — converts a ``/internal/builder-events``
  POST body (shape produced by
  ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``)
  into a terminal ``BuilderEvent``.
- ``stream_part_to_events`` — converts a ``langgraph_sdk`` ``StreamPart``
  ``(event, data)`` tuple into zero-or-more ``BuilderEvent`` instances.

The webhook's field naming is asymmetric: ``payload["task_id"]`` is the
Builder's own thread id while ``payload["thread_id"]`` is the parent
companion thread (or ``None`` when Builder is the main agent). The
adapter absorbs this impedance mismatch so sinks see a clean
``BuilderEvent.thread_id`` / ``parent_thread_id`` split.

Stream chunks: the SDK yields ``StreamPart(event: str, data: dict)``
NamedTuples (see ``langgraph_sdk.schema.StreamPart``). ``event`` is the
stream mode name — one of ``metadata`` / ``values`` /
``messages/partial`` / ``messages/complete`` / ``custom`` / ``updates``
/ ``end`` / etc. We translate the subset that's useful for chat surfaces
and trace.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from app.gateway.builder_events.types import BuilderEvent, BuilderEventType

logger = logging.getLogger(__name__)


_WEBHOOK_STATUS_TO_EVENT_TYPE: dict[str, BuilderEventType] = {
    "success": "completed",
    "completed": "completed",
    "error": "failed",
    "failed": "failed",
    "cancelled": "cancelled",
    "timeout": "timed_out",
    "timed_out": "timed_out",
}


# Truncate large payloads so a single event can't blow up trace files or
# SSE buffers. The canonical full content stays in LangGraph state and in
# the existing ProgressTraceWriter / artifact bytes.
_TOOL_RESULT_PREVIEW_CHARS = 200
_TASK_BRIEF_PREVIEW_CHARS = 500
_AI_CHUNK_TEXT_LIMIT = 2000


def webhook_payload_to_event(payload: dict[str, Any]) -> BuilderEvent:
    """Convert ``/internal/builder-events`` POST body to a terminal event."""
    raw_status = (payload.get("status") or "").lower()
    event_type = _WEBHOOK_STATUS_TO_EVENT_TYPE.get(raw_status)
    if event_type is None:
        logger.warning(
            "builder_events.adapter unknown_webhook_status status=%r task_id=%s",
            payload.get("status"),
            payload.get("task_id"),
        )
        event_type = "failed"

    return BuilderEvent(
        thread_id=str(payload.get("task_id") or ""),
        parent_thread_id=payload.get("thread_id") or None,
        user_id=str(payload.get("user_id") or ""),
        trace_id=str(payload.get("trace_id") or ""),
        event_type=event_type,
        payload={
            "artifact_path": payload.get("artifact_filename"),
            "artifact_url": payload.get("artifact_url"),
            "artifact_filename": payload.get("artifact_filename"),
            "artifact_title": payload.get("artifact_title"),
            "artifact_type": payload.get("artifact_type"),
            "companion_summary": payload.get("summary"),
            "user_next_action": payload.get("user_next_action"),
            "error_message": payload.get("error_message"),
            "task_type": payload.get("task_type"),
            "agent_name": payload.get("agent_name"),
            "completed_at": payload.get("completed_at"),
            "webhook_source": payload.get("source"),
        },
        source="webhook",
    )


@dataclass
class StreamAdapterState:
    """Per-consumer dedup / counter state.

    Lives in the stream consumer task closure for one run's lifetime.
    Cleared when the consumer exits.
    """

    # Tool calls we've already announced via tool_started.
    started_tool_ids: set[str] = field(default_factory=set)
    # Tool calls we've already completed via tool_completed.
    completed_tool_ids: set[str] = field(default_factory=set)
    # Per-AI-message chunk counter.
    message_chunk_indices: dict[str, int] = field(default_factory=dict)
    # Most recent todos list (for diff detection).
    last_todos: list[dict[str, Any]] | None = None


def stream_part_to_events(
    part: tuple[str, Any] | Any,
    *,
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    adapter_state: StreamAdapterState,
) -> list[BuilderEvent]:
    """Convert one langgraph_sdk ``StreamPart`` into zero+ BuilderEvents.

    ``part`` may be a ``StreamPart`` NamedTuple ``(event, data, id?)`` or
    a bare ``(event, data)`` tuple. Unknown event types return ``[]`` —
    they're not errors, just modes we don't surface (e.g. ``metadata``,
    ``end``, ``updates``).
    """
    if not isinstance(part, tuple) or len(part) < 2:
        return []

    event_name = part[0]
    data = part[1]

    if not isinstance(event_name, str):
        return []

    # Normalise per-mode-end events ("values/end", "messages/end", etc.)
    base_event = event_name.split("/", 1)[0]

    if base_event == "values":
        return _from_values_snapshot(data, thread_id, parent_thread_id, user_id, trace_id, adapter_state)

    if base_event == "messages":
        return _from_message_chunk(data, thread_id, parent_thread_id, user_id, trace_id, adapter_state)

    if base_event == "custom":
        return _from_custom(data, thread_id, parent_thread_id, user_id, trace_id)

    return []


def _from_values_snapshot(
    data: Any,
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    state: StreamAdapterState,
) -> list[BuilderEvent]:
    """Extract tool_started / tool_completed / todo_updated from a values
    state snapshot."""
    if not isinstance(data, dict):
        return []

    events: list[BuilderEvent] = []
    messages = data.get("messages")
    if isinstance(messages, list):
        events.extend(
            _diff_tool_events(
                messages,
                thread_id,
                parent_thread_id,
                user_id,
                trace_id,
                state,
            )
        )

    todos = data.get("todos")
    if isinstance(todos, list) and todos != state.last_todos:
        state.last_todos = list(todos)
        events.append(
            BuilderEvent(
                thread_id=thread_id,
                parent_thread_id=parent_thread_id,
                user_id=user_id,
                trace_id=trace_id,
                event_type="todo_updated",
                payload={"todos": todos[:20]},  # cap at 20 entries
            )
        )

    return events


def _diff_tool_events(
    messages: list[Any],
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    state: StreamAdapterState,
) -> list[BuilderEvent]:
    events: list[BuilderEvent] = []

    for msg in messages:
        msg_type = _msg_field(msg, "type")
        if msg_type == "ai":
            tool_calls = _msg_field(msg, "tool_calls") or []
            for tc in tool_calls:
                tc_id = _msg_field(tc, "id")
                tc_name = _msg_field(tc, "name")
                if not tc_id or tc_id in state.started_tool_ids:
                    continue
                state.started_tool_ids.add(tc_id)
                args = _msg_field(tc, "args") or {}
                events.append(
                    BuilderEvent(
                        thread_id=thread_id,
                        parent_thread_id=parent_thread_id,
                        user_id=user_id,
                        trace_id=trace_id,
                        event_type="tool_started",
                        payload={
                            "tool_name": tc_name,
                            "tool_call_id": tc_id,
                            "args_preview": _truncate(_to_text(args), _TOOL_RESULT_PREVIEW_CHARS),
                        },
                    )
                )

        elif msg_type == "tool":
            tc_id = _msg_field(msg, "tool_call_id")
            tc_name = _msg_field(msg, "name")
            if not tc_id or tc_id in state.completed_tool_ids:
                continue
            state.completed_tool_ids.add(tc_id)
            content = _msg_field(msg, "content")
            status = _msg_field(msg, "status") or "success"
            events.append(
                BuilderEvent(
                    thread_id=thread_id,
                    parent_thread_id=parent_thread_id,
                    user_id=user_id,
                    trace_id=trace_id,
                    event_type="tool_completed",
                    payload={
                        "tool_name": tc_name,
                        "tool_call_id": tc_id,
                        "success": status != "error",
                        "summary": _truncate(_to_text(content), _TOOL_RESULT_PREVIEW_CHARS),
                    },
                )
            )

    return events


def _from_message_chunk(
    data: Any,
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    state: StreamAdapterState,
) -> list[BuilderEvent]:
    """Translate ``messages/partial`` payloads to ``ai_message_chunk``.

    The SDK delivers messages-tuple data as a list of partial message
    dicts. Each delta carries ``id``, ``type`` (``ai`` / ``tool`` / ...),
    and ``content``. We only surface AI text deltas; tool calls land via
    the values-snapshot path.
    """
    if not isinstance(data, list):
        return []

    events: list[BuilderEvent] = []
    for msg in data:
        if _msg_field(msg, "type") != "ai":
            continue
        msg_id = _msg_field(msg, "id")
        text = _to_text(_msg_field(msg, "content"))
        if not msg_id or not text:
            continue
        idx = state.message_chunk_indices.get(msg_id, 0)
        state.message_chunk_indices[msg_id] = idx + 1
        events.append(
            BuilderEvent(
                thread_id=thread_id,
                parent_thread_id=parent_thread_id,
                user_id=user_id,
                trace_id=trace_id,
                event_type="ai_message_chunk",
                payload={
                    "message_id": msg_id,
                    "chunk_index": idx,
                    "text_delta": _truncate(text, _AI_CHUNK_TEXT_LIMIT),
                },
            )
        )
    return events


def _from_custom(
    data: Any,
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
) -> list[BuilderEvent]:
    """Custom stream events from graph code calling ``StreamWriter``.

    Reserved for the future ``ProgressEmitter`` integration. For now,
    any custom event with ``{"type": "phase", "name": "..."}`` is
    surfaced as a phase event so a follow-up that wires
    ``ProgressEmitter`` to the custom stream channel works without
    touching the adapter.
    """
    if not isinstance(data, dict):
        return []
    if data.get("type") != "phase":
        return []
    return [
        BuilderEvent(
            thread_id=thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            event_type="phase",
            payload={
                "phase_name": data.get("name") or data.get("phase_name"),
                "phase_index": data.get("index"),
                "phase_total": data.get("total"),
            },
        )
    ]


# ---- Misc helpers ---------------------------------------------------------


def _msg_field(msg: Any, key: str) -> Any:
    """Read ``key`` from a message dict OR a BaseMessage-like object."""
    if isinstance(msg, dict):
        return msg.get(key)
    return getattr(msg, key, None)


def _to_text(value: Any) -> str:
    """Normalise message ``content`` (str | list-of-blocks | None) to text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for block in value:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return str(value)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


# Backwards-compat alias for the Stage 1A name (no behaviour).
def chunk_to_events(
    chunk: Any,
    *,
    thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    last_message_ids: dict[str, int],
) -> list[BuilderEvent]:
    """Deprecated — kept for Stage 1A test compatibility. Use
    ``stream_part_to_events`` with an explicit ``StreamAdapterState``."""
    state = StreamAdapterState(message_chunk_indices=dict(last_message_ids))
    events = stream_part_to_events(
        chunk,
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id=user_id,
        trace_id=trace_id,
        adapter_state=state,
    )
    last_message_ids.update(state.message_chunk_indices)
    return events
