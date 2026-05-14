"""Adapters: translate raw stream chunks + webhook payloads → BuilderEvent.

Two entry points:

- :func:`adapt_terminal_webhook` — called from the existing
  ``/internal/builder-events`` router after it dispatches to the legacy
  ``BuilderEventsWorker``. Translates the
  ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``
  shape into a :class:`CompletedEvent`.

- :func:`adapt_v3_chunk` — called from the v3 stream consumer for each
  chunk yielded by ``client.threads.stream(...)``. The exact v3 chunk
  shape is acknowledged as unpinned in the spec (§22 Q1) — this adapter
  is implemented defensively against the modes the LangGraph SDK
  documents today and logs unknown shapes for future tuning.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.2,
§13.1.
"""

from __future__ import annotations

import logging
import sys
import time
from typing import Any

from app.gateway.builder_events.types import (
    BuilderEvent,
    CompletedEvent,
    CustomEvent,
    MessageDeltaEvent,
    SubagentEvent,
    ToolCallEvent,
)

logger = logging.getLogger(__name__)


_NOW_MS = lambda: int(time.time() * 1000)  # noqa: E731 — short alias used in many call sites


# ---- Terminal webhook → CompletedEvent ------------------------------------


_TERMINAL_STATUS_MAP = {
    "completed": "completed",
    "success": "completed",
    "error": "failed",
    "failed": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "timeout": "timed_out",
    "timed_out": "timed_out",
}


def adapt_terminal_webhook(
    payload: dict[str, Any],
    *,
    channel_origin: str = "telegram",
) -> CompletedEvent | None:
    """Translate a builder-completion webhook payload into a CompletedEvent."""
    ids = _validate_terminal_ids(payload)
    if ids is None:
        return None
    thread_id, task_id = ids
    status = _resolve_terminal_status(payload.get("status"), task_id)
    user_id_raw = payload.get("user_id")
    user_id = user_id_raw if isinstance(user_id_raw, str) and user_id_raw else None
    return _build_completed_event(
        task_id=task_id,
        thread_id=thread_id,
        user_id=user_id,
        channel_origin=channel_origin,
        status=status,
        payload=payload,
    )


def _validate_terminal_ids(payload: dict[str, Any]) -> tuple[str, str] | None:
    thread_id = payload.get("thread_id")
    task_id = payload.get("task_id")
    if not isinstance(thread_id, str) or not thread_id:
        logger.warning("adapt_terminal_webhook: missing thread_id task_id=%s", task_id)
        return None
    if not isinstance(task_id, str) or not task_id:
        logger.warning("adapt_terminal_webhook: missing task_id thread_id=%s", thread_id)
        return None
    return thread_id, task_id


def _resolve_terminal_status(raw: Any, task_id: str) -> str:
    text = (raw or "").lower() if isinstance(raw, str) else ""
    mapped = _TERMINAL_STATUS_MAP.get(text)
    if mapped is not None:
        return mapped
    logger.warning("adapt_terminal_webhook: unknown status=%r task_id=%s — coercing to failed", raw, task_id)
    return "failed"


def _build_completed_event(
    *,
    task_id: str,
    thread_id: str,
    user_id: str | None,
    channel_origin: str,
    status: str,
    payload: dict[str, Any],
) -> CompletedEvent | None:
    try:
        return CompletedEvent(
            task_id=task_id,
            thread_id=thread_id,
            user_id=user_id,
            channel_origin=channel_origin,  # type: ignore[arg-type] — validated by pydantic
            timestamp_ms=_NOW_MS(),
            sequence=sys.maxsize,
            status=status,  # type: ignore[arg-type]
            artifact_path=payload.get("artifact_filename"),
            artifact_type=payload.get("artifact_type"),
            artifact_url=payload.get("artifact_url"),
            artifact_filename=payload.get("artifact_filename"),
            companion_summary=payload.get("summary"),
            user_next_action=payload.get("user_next_action"),
            error=payload.get("error_message"),
        )
    except Exception:
        logger.warning(
            "adapt_terminal_webhook: failed to construct CompletedEvent task_id=%s",
            task_id,
            exc_info=True,
        )
        return None


# ---- v3 chunk → BuilderEvent ----------------------------------------------


def adapt_v3_chunk(
    chunk: Any,
    *,
    task_id: str,
    thread_id: str,
    user_id: str | None,
    channel_origin: str,
    sequence: int,
) -> BuilderEvent | None:
    """Translate a single v3 stream chunk into a BuilderEvent.

    The LangGraph SDK's ``threads.stream`` yields tuples or dicts
    depending on configured stream modes. Phase 1 handles the common
    shapes documented in the agent-streaming protocol:

    - ``("messages-tuple", (AIMessage, metadata))`` — text streaming
    - ``("values", state_dict)`` — full state snapshots (skipped — too noisy)
    - ``("updates", node_updates_dict)`` — node-level updates including tools
    - ``("custom", payload)`` — graph-emitted custom events

    Unknown shapes return None and log at INFO so the adapter can be
    tuned without crashing the stream consumer.
    """
    mode, body = _decompose_chunk(chunk)
    if mode is None:
        return None

    base_kwargs = {
        "task_id": task_id,
        "thread_id": thread_id,
        "user_id": user_id,
        "channel_origin": channel_origin,
        "timestamp_ms": _NOW_MS(),
        "sequence": sequence,
    }

    if mode == "messages-tuple":
        return _adapt_messages_tuple(body, base_kwargs)
    if mode == "updates":
        return _adapt_updates(body, base_kwargs)
    if mode == "custom":
        return _adapt_custom(body, base_kwargs)
    if mode == "values":
        return None  # too noisy to convert per chunk; terminal webhook covers final state

    logger.info("adapt_v3_chunk: ignoring chunk mode=%r task_id=%s", mode, task_id)
    return None


def _decompose_chunk(chunk: Any) -> tuple[str | None, Any]:
    """Best-effort split of a chunk into ``(mode, body)``."""
    if isinstance(chunk, tuple) and len(chunk) == 2:
        mode, body = chunk
        if isinstance(mode, str):
            return mode, body
    if isinstance(chunk, dict):
        # Some SDK versions yield ``{"event": <mode>, "data": <body>}``.
        mode = chunk.get("event")
        if isinstance(mode, str):
            return mode, chunk.get("data")
    return None, None


def _adapt_messages_tuple(body: Any, base: dict[str, Any]) -> MessageDeltaEvent | None:
    """``(AIMessage | dict, metadata)`` → MessageDeltaEvent."""
    if not isinstance(body, tuple) or len(body) != 2:
        return None
    message, _metadata = body
    delta_text = _extract_text(message)
    if not delta_text:
        return None
    return MessageDeltaEvent(
        **base,
        delta=delta_text,
        subagent_id=None,
    )


def _adapt_updates(body: Any, base: dict[str, Any]) -> ToolCallEvent | SubagentEvent | None:
    """Node-update dicts can carry tool calls — pull the first useful one out.

    Phase 1 emits a single ``ToolCallEvent(status="started")`` per detected
    tool invocation. Future iterations may correlate completed/failed via
    ``tool_call_id`` matching.
    """
    call = _first_tool_call_from_updates(body)
    if call is None:
        return None
    return _tool_call_event_from_dict(call, base)


def _first_tool_call_from_updates(body: Any) -> dict[str, Any] | None:
    """Walk a node-updates dict and return the first tool-call dict."""
    if not isinstance(body, dict):
        return None
    for _node_name, node_state in body.items():
        if not isinstance(node_state, dict):
            continue
        messages = node_state.get("messages")
        if not isinstance(messages, list):
            continue
        for message in messages:
            for call in _extract_tool_calls(message):
                name = call.get("name") or call.get("tool_name")
                if isinstance(name, str) and name:
                    return call
    return None


def _tool_call_event_from_dict(call: dict[str, Any], base: dict[str, Any]) -> ToolCallEvent:
    args_value = call.get("args")
    return ToolCallEvent(
        **base,
        tool_call_id=str(call.get("id") or call.get("tool_call_id") or ""),
        tool_name=str(call.get("name") or call.get("tool_name") or ""),
        args=args_value if isinstance(args_value, dict) else {},
        status="started",
        subagent_id=None,
    )


def _adapt_custom(body: Any, base: dict[str, Any]) -> CustomEvent | None:
    if not isinstance(body, dict):
        return None
    name = body.get("name") or body.get("event")
    if not isinstance(name, str) or not name:
        return None
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {k: v for k, v in body.items() if k != "name"}
    return CustomEvent(
        **base,
        name=name,
        payload=payload or {},
        subagent_id=None,
    )


# ---- helpers --------------------------------------------------------------


def _extract_text(message: Any) -> str:
    """Pull plain text out of an AIMessage-like value."""
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def _extract_tool_calls(message: Any) -> list[dict[str, Any]]:
    """Pull tool_calls list off an AIMessage-like value."""
    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls is None and isinstance(message, dict):
        tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list):
        return []
    return [tc for tc in tool_calls if isinstance(tc, dict)]


__all__ = ["adapt_terminal_webhook", "adapt_v3_chunk"]
