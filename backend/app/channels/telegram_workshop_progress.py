"""Helpers for the companion-side builder-progress placeholder (Phase 3).

When companion's ``start_builder_task`` tool fires in a Telegram-originated
chat, the channel layer sends a follow-up placeholder message in
companion's voice:

    Working on it — I'll show progress here. ☕

The companion bot then EDITS that message live as builder events stream
in. No @-mention, no workshop bot in the chat, no brief dumped to the
user — the builder already has the brief via ``delegation_context``.

This module:

1. Walks a ``runs.wait`` result's ``messages`` list back-to-front, stopping
   at the most recent human message (to scope to "this turn").
2. Identifies any ``start_builder_task`` tool calls in that scope.
3. Cross-references ``result["async_tasks"]`` for ``run_id`` (the v3
   stream consumer needs it to tail the existing builder run).
4. Returns one :class:`ProgressTarget` per new task so the channel
   handler can open a progress-stream for each.

Companion's manager holds an in-memory ``set[str]`` of already-emitted
task_ids so it never double-opens.

Earlier phase 2 of ``sophia_telegram_architecture_spec_v1.md`` shipped
this as a chat @-mention dispatched at the workshop bot via Telegram
Guest Mode. Phase 3 keeps the extraction + run_id plumbing but drops
the chat-text rendering (the placeholder text is built in
``manager.py``).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


_TOOL_NAME = "start_builder_task"
# ToolMessage content shape from start_builder_task.py:
#   "Launched builder task. task_id: {task_id}. It runs in the background..."
_TASK_ID_RE = re.compile(r"task_id:\s*(\S+?)\.")


@dataclass(frozen=True, slots=True)
class ProgressTarget:
    """One pending builder progress-message, scoped to one tool call.

    ``run_id`` is required for tailing the builder run via the LangGraph
    SDK's ``client.runs.join_stream(thread_id, run_id, …)``. It may be
    None when the result didn't expose ``async_tasks`` (legacy paths) —
    in that case the fanout falls back to terminal-webhook ingress only.
    """

    task_id: str
    run_id: str | None = None


def extract_progress_targets_from_result(result: Any) -> list[ProgressTarget]:
    """Scan a LangGraph runs.wait result for new ``start_builder_task`` calls.

    Walks ``result["messages"]`` from the end back to the most recent
    human message and pairs each ``start_builder_task`` ToolMessage with
    its calling AIMessage. Cross-references ``result["async_tasks"]``
    for ``run_id``. Returns an empty list when no such calls are present
    in this turn's scope.
    """
    messages = _extract_messages(result)
    if not messages:
        return []

    tool_messages = _walk_back_for_start_builder(messages)
    if not tool_messages:
        return []

    async_tasks = _extract_async_tasks(result)

    targets: list[ProgressTarget] = []
    seen_task_ids: set[str] = set()
    for tool_msg in tool_messages:
        task_id = _extract_task_id(tool_msg.get("content"))
        if not task_id or task_id in seen_task_ids:
            continue
        seen_task_ids.add(task_id)
        run_id = _extract_run_id(async_tasks, task_id)
        if run_id is None:
            logger.info(
                "progress: no run_id in async_tasks for task_id=%s — workshop sink will see terminal webhook only",
                task_id,
            )
        targets.append(ProgressTarget(task_id=task_id, run_id=run_id))
    return targets


def _extract_messages(result: Any) -> list[dict[str, Any]]:
    if isinstance(result, list):
        raw = result
    elif isinstance(result, dict):
        raw = result.get("messages", [])
    else:
        return []
    return [m for m in raw if isinstance(m, dict)]


def _walk_back_for_start_builder(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the ``start_builder_task`` ToolMessages from this turn.

    Scopes to "this turn" by stopping at the most recent human message.
    """
    tool_messages: list[dict[str, Any]] = []
    for msg in reversed(messages):
        msg_type = msg.get("type") or msg.get("role")
        if msg_type == "human":
            break
        if msg_type == "tool" and msg.get("name") == _TOOL_NAME:
            tool_messages.append(msg)
    return tool_messages


def _extract_async_tasks(result: Any) -> dict[str, dict[str, Any]]:
    """Pull ``async_tasks`` off a runs.wait result dict.

    State is written by ``start_builder_task`` as
    ``{"async_tasks": {task_id: {"task_id": ..., "run_id": ..., …}}}``.
    """
    if not isinstance(result, dict):
        return {}
    raw = result.get("async_tasks")
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, dict)}


def _extract_run_id(async_tasks: dict[str, dict[str, Any]], task_id: str) -> str | None:
    entry = async_tasks.get(task_id)
    if not isinstance(entry, dict):
        return None
    run_id = entry.get("run_id")
    return run_id if isinstance(run_id, str) and run_id else None


def _extract_task_id(content: Any) -> str | None:
    text = content if isinstance(content, str) else ""
    if not text and isinstance(content, list):
        text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    match = _TASK_ID_RE.search(text or "")
    return match.group(1).strip() if match else None


__all__ = ["ProgressTarget", "extract_progress_targets_from_result"]
