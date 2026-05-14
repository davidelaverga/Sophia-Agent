"""Helpers for the companion-side @Sophia_work_bot summon emit (Phase 2).

When companion's ``start_builder_task`` tool fires in a Telegram-originated
chat, the channel layer must post a second message in the chat:

    @Sophia_work_bot

    {delegation_brief}

Telegram detects the ``@``-mention and dispatches a guest update to the
workshop bot's polling endpoint. The workshop handler resolves
``(chat_id, summoning_message_id) → task_id`` via the gateway's
``TaskResolutionCache`` and opens its streaming reply.

This module is the small composable piece that:

1. Walks a ``runs.wait`` result's ``messages`` list back-to-front, stopping
   at the most recent human message (to scope to "this turn").
2. Identifies any ``start_builder_task`` tool calls in that scope.
3. Returns ``(task_id, task_brief)`` tuples the channel handler can act on.

The companion handler holds an in-memory ``set[str]`` of already-summoned
task_ids so it never double-summons.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §12.
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
_BRIEF_MAX_CHARS = 3500  # Telegram max - mention - newlines headroom


@dataclass(frozen=True, slots=True)
class SummonRequest:
    """One pending @Sophia_work_bot summon, scoped to one tool call."""

    task_id: str
    task_brief: str

    def render_message(self, *, workshop_username: str) -> str:
        """Render the summoning message body per spec §12.3."""
        username = workshop_username.lstrip("@")
        brief = self.task_brief.strip()
        if len(brief) > _BRIEF_MAX_CHARS:
            brief = brief[: _BRIEF_MAX_CHARS - 1] + "…"
        return f"@{username}\n\n{brief}"


def extract_summons_from_result(result: Any) -> list[SummonRequest]:
    """Scan a LangGraph runs.wait result for new ``start_builder_task`` calls.

    Walks ``result["messages"]`` from the end back to the most recent
    human message and pairs each ``start_builder_task`` ToolMessage with
    its calling AIMessage to extract ``(task_id, brief)``. Returns an
    empty list when no such calls are present in this turn's scope.
    """
    messages = _extract_messages(result)
    if not messages:
        return []

    tool_calls_by_id, tool_messages = _walk_back_for_start_builder(messages)
    if not tool_messages:
        return []

    summons: list[SummonRequest] = []
    seen_task_ids: set[str] = set()
    for tool_msg in tool_messages:
        summon = _build_summon(tool_msg, tool_calls_by_id)
        if summon is None or summon.task_id in seen_task_ids:
            continue
        seen_task_ids.add(summon.task_id)
        summons.append(summon)
    return summons


def _extract_messages(result: Any) -> list[dict[str, Any]]:
    if isinstance(result, list):
        raw = result
    elif isinstance(result, dict):
        raw = result.get("messages", [])
    else:
        return []
    return [m for m in raw if isinstance(m, dict)]


def _walk_back_for_start_builder(
    messages: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Return (tool_calls_by_call_id, tool_messages_for_start_builder)."""
    tool_calls_by_id: dict[str, dict[str, Any]] = {}
    tool_messages: list[dict[str, Any]] = []
    for msg in reversed(messages):
        msg_type = msg.get("type") or msg.get("role")
        if msg_type == "human":
            break
        if msg_type == "tool" and msg.get("name") == _TOOL_NAME:
            tool_messages.append(msg)
        elif msg_type == "ai":
            for tc in _iter_tool_calls(msg):
                tc_id = tc.get("id") or tc.get("tool_call_id")
                if isinstance(tc_id, str) and tc_id:
                    tool_calls_by_id[tc_id] = tc
    return tool_calls_by_id, tool_messages


def _iter_tool_calls(ai_msg: dict[str, Any]):
    tool_calls = ai_msg.get("tool_calls")
    if isinstance(tool_calls, list):
        for tc in tool_calls:
            if isinstance(tc, dict) and (tc.get("name") or tc.get("tool_name")) == _TOOL_NAME:
                yield tc


def _build_summon(
    tool_msg: dict[str, Any],
    tool_calls_by_id: dict[str, dict[str, Any]],
) -> SummonRequest | None:
    tool_call_id = tool_msg.get("tool_call_id")
    task_id = _extract_task_id(tool_msg.get("content"))
    if not task_id:
        logger.debug("summon: couldn't extract task_id from ToolMessage content=%r", tool_msg.get("content"))
        return None
    matching_call = tool_calls_by_id.get(tool_call_id) if isinstance(tool_call_id, str) else None
    brief = _extract_brief(matching_call)
    if not brief:
        logger.debug("summon: empty brief for task_id=%s tool_call_id=%s", task_id, tool_call_id)
        return None
    return SummonRequest(task_id=task_id, task_brief=brief)


def _extract_task_id(content: Any) -> str | None:
    text = content if isinstance(content, str) else ""
    if not text and isinstance(content, list):
        text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    match = _TASK_ID_RE.search(text or "")
    return match.group(1).strip() if match else None


def _extract_brief(tool_call: dict[str, Any] | None) -> str | None:
    if not tool_call:
        return None
    args = tool_call.get("args")
    if not isinstance(args, dict):
        return None
    raw = args.get("description")
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    return cleaned or None


__all__ = ["SummonRequest", "extract_summons_from_result"]
