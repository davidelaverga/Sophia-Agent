"""Middleware to fix dangling tool calls in message history.

A dangling tool call occurs when an AIMessage contains tool_calls but there are
no corresponding ToolMessages in the history (e.g., due to user interruption or
request cancellation). This causes LLM errors due to incomplete message format.

This middleware intercepts the model call to detect and patch such gaps by
inserting synthetic ToolMessages with an error indicator immediately after the
AIMessage that made the tool calls, ensuring correct message ordering.

Note: Uses wrap_model_call instead of before_model to ensure patches are inserted
at the correct positions (immediately after each dangling AIMessage), not appended
to the end of the message list as before_model + add_messages reducer would do.
"""

import logging
from collections.abc import Awaitable, Callable
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage

logger = logging.getLogger(__name__)


def patch_dangling_tool_call_messages(messages: list) -> list | None:
    """Ensure every AI ``tool_use`` has exactly ONE in-position ``tool_result``.

    Anthropic rejects requests where an assistant ``tool_use`` block is not
    *immediately* followed by the corresponding user ``tool_result`` block.
    Three kinds of breakage happen in practice:

    * Missing tool_result — the tool never ran (user interrupt, crash,
      or a middleware that jumped before the tool node closed the call).
    * Misplaced tool_result — the ToolMessage exists somewhere else in
      history (e.g., separated from its AI message by a summarization
      ``HumanMessage`` or another injected message), so the shape Anthropic
      sees is ``assistant(tool_use) → user(text) → user(tool_result)``.
    * Duplicate tool_result — two ToolMessages carry the same
      ``tool_call_id``. Anthropic rejects this outright ("each tool_use must
      have a single result. Found multiple tool_result blocks with id …" —
      prod 2026-06-11). Every same-id result after the first is dropped from
      the request.

    Returns a patched copy of the message list, preserving chronological
    order, or ``None`` when the history is already well formed.
    """
    # Index ToolMessages by id for quick lookup (first occurrence wins) and
    # detect duplicates.
    tool_msg_by_id: dict[str, int] = {}
    has_duplicates = False
    for idx, msg in enumerate(messages):
        if isinstance(msg, ToolMessage):
            if msg.tool_call_id in tool_msg_by_id:
                has_duplicates = True
            else:
                tool_msg_by_id[msg.tool_call_id] = idx

    # First pass: detect whether any AI tool_use lacks an in-position tool_result.
    needs_patch = has_duplicates
    for i, msg in enumerate(messages):
        if needs_patch:
            break
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        expected_ids = [tc.get("id") for tc in tool_calls if tc.get("id")]
        if not expected_ids:
            continue
        # Each expected id must appear, in order, starting at i + 1 as a
        # contiguous block of ToolMessages.
        for offset, expected_id in enumerate(expected_ids):
            position = i + 1 + offset
            if position >= len(messages):
                needs_patch = True
                break
            next_msg = messages[position]
            if not isinstance(next_msg, ToolMessage) or next_msg.tool_call_id != expected_id:
                needs_patch = True
                break

    if not needs_patch:
        return None

    # Second pass: build the patched list. For each AI message with tool_use,
    # emit the expected ToolMessages right after it. Prefer a real ToolMessage
    # pulled from elsewhere in history (keeping its content) over a synthetic
    # placeholder; fall back to a placeholder when no ToolMessage exists for
    # the id. Each real ToolMessage is used at most once so we never emit two
    # tool_result blocks for the same tool_call_id (which Anthropic rejects).
    used_real_ids: set[str] = set()
    patched: list = []
    patch_count = 0
    emitted_result_ids: set[str] = set()
    dropped_duplicates: list[str] = []
    for i, msg in enumerate(messages):
        if isinstance(msg, ToolMessage):
            if msg.tool_call_id in emitted_result_ids:
                # A result for this tool_use is already in the patched list
                # (duplicate in state, or pulled up earlier). Anthropic
                # rejects a second tool_result for the same id — drop it.
                # The id+tool log line is the root-cause diagnostic: it names
                # the creator of the duplicate (prod 2026-06-11 F2).
                dropped_duplicates.append(f"{getattr(msg, 'name', None) or 'unknown'}:{msg.tool_call_id}")
                continue
            if msg.tool_call_id in used_real_ids and tool_msg_by_id.get(msg.tool_call_id) == i:
                # This real ToolMessage was already pulled up to satisfy its
                # AI tool_use. Drop its original position to avoid duplicates.
                continue
        patched.append(msg)
        if isinstance(msg, ToolMessage):
            emitted_result_ids.add(msg.tool_call_id)
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        expected = [tc for tc in tool_calls if tc.get("id")]
        if not expected:
            continue
        for offset, tc in enumerate(expected):
            tc_id = tc["id"]
            position = i + 1 + offset
            candidate = messages[position] if position < len(messages) else None
            if isinstance(candidate, ToolMessage) and candidate.tool_call_id == tc_id:
                # In place; the outer loop will append it naturally.
                continue
            if tc_id in emitted_result_ids:
                continue
            real_idx = tool_msg_by_id.get(tc_id)
            if real_idx is not None and tc_id not in used_real_ids:
                # Pull the real ToolMessage up and mark its original slot for removal.
                patched.append(messages[real_idx])
                used_real_ids.add(tc_id)
                emitted_result_ids.add(tc_id)
                patch_count += 1
                continue
            patched.append(
                ToolMessage(
                    content="[Tool call was interrupted and did not return a result.]",
                    tool_call_id=tc_id,
                    name=tc.get("name", "unknown"),
                    status="error",
                )
            )
            emitted_result_ids.add(tc_id)
            patch_count += 1

    logger.warning(
        "Injecting/reordering %s ToolMessage(s) for dangling/misplaced tool calls "
        "(duplicate results dropped: %s)",
        patch_count,
        ", ".join(dropped_duplicates) or "none",
    )
    return patched


class DanglingToolCallMiddleware(AgentMiddleware[AgentState]):
    """Inserts placeholder ToolMessages for dangling tool calls before model invocation.

    Scans the message history for AIMessages whose tool_calls lack corresponding
    ToolMessages, and injects synthetic error responses immediately after the
    offending AIMessage so the LLM receives a well-formed conversation.
    """

    def _build_patched_messages(self, messages: list) -> list | None:
        """Return a new message list with patches inserted at the correct positions.

        For each AIMessage with dangling tool_calls (no corresponding ToolMessage),
        a synthetic ToolMessage is inserted immediately after that AIMessage.
        Returns None if no patches are needed.
        """
        return patch_dangling_tool_call_messages(messages)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        patched = self._build_patched_messages(request.messages)
        if patched is not None:
            request = request.override(messages=patched)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        patched = self._build_patched_messages(request.messages)
        if patched is not None:
            request = request.override(messages=patched)
        return await handler(request)
