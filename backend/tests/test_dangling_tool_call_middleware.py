"""Tests for ``patch_dangling_tool_call_messages``.

Covers the two shapes that trigger Anthropic's ``messages.N: tool_use ids
were found without tool_result blocks immediately after`` error:

1. Missing tool_result (the tool never produced a result).
2. Misplaced tool_result (a ToolMessage exists but is separated from its
   AI tool_use by another message, e.g. the summarization HumanMessage).
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deerflow.agents.middlewares.dangling_tool_call_middleware import (
    patch_dangling_tool_call_messages,
)


def _ai_tool_use(tc_id: str, name: str = "emit_artifact") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"id": tc_id, "name": name, "args": {}}],
    )


def test_returns_none_when_history_is_well_formed() -> None:
    messages = [
        HumanMessage(content="hello"),
        _ai_tool_use("toolu_1"),
        ToolMessage(content="ok", tool_call_id="toolu_1", name="emit_artifact"),
        HumanMessage(content="next"),
        _ai_tool_use("toolu_2"),
        ToolMessage(content="ok", tool_call_id="toolu_2", name="emit_artifact"),
    ]

    assert patch_dangling_tool_call_messages(messages) is None


def test_inserts_placeholder_for_missing_tool_result() -> None:
    messages = [
        HumanMessage(content="hi"),
        _ai_tool_use("toolu_1"),
        HumanMessage(content="next"),
    ]

    patched = patch_dangling_tool_call_messages(messages)

    assert patched is not None
    assert len(patched) == 4
    inserted = patched[2]
    assert isinstance(inserted, ToolMessage)
    assert inserted.tool_call_id == "toolu_1"
    assert inserted.status == "error"
    assert isinstance(patched[3], HumanMessage)


def test_moves_misplaced_tool_result_into_position_without_duplicating() -> None:
    """Summarization can drop a HumanMessage between an AI tool_use and its
    ToolMessage. The patcher must move the ToolMessage up, not duplicate it."""
    summary = HumanMessage(
        content="Here is a summary of the conversation to date: ..."
    )
    ai = _ai_tool_use("toolu_misplaced")
    tool_msg = ToolMessage(
        content="Artifact recorded.",
        tool_call_id="toolu_misplaced",
        name="emit_artifact",
    )
    messages = [HumanMessage(content="hi"), ai, summary, tool_msg]

    patched = patch_dangling_tool_call_messages(messages)

    assert patched is not None
    # The real ToolMessage must be immediately after the AI tool_use.
    assert patched[1] is ai
    assert patched[2] is tool_msg
    # The summary HumanMessage still appears, but now after the tool_result.
    assert patched[3] is summary
    # And the tool_result id appears exactly once (no duplicates).
    tool_result_ids = [
        m.tool_call_id for m in patched if isinstance(m, ToolMessage)
    ]
    assert tool_result_ids == ["toolu_misplaced"]


def test_preserves_ordering_for_multiple_tool_calls_in_one_ai_message() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[
            {"id": "toolu_a", "name": "tool_a", "args": {}},
            {"id": "toolu_b", "name": "tool_b", "args": {}},
        ],
    )
    tr_a = ToolMessage(content="a", tool_call_id="toolu_a", name="tool_a")
    tr_b = ToolMessage(content="b", tool_call_id="toolu_b", name="tool_b")
    messages = [HumanMessage(content="hi"), ai, tr_a, tr_b]

    # Already well-formed → no patching.
    assert patch_dangling_tool_call_messages(messages) is None


def test_multiple_dangling_tool_calls_are_all_patched() -> None:
    messages = [
        _ai_tool_use("toolu_1"),
        HumanMessage(content="oops interrupted"),
        _ai_tool_use("toolu_2"),
        HumanMessage(content="oops again"),
    ]

    patched = patch_dangling_tool_call_messages(messages)

    assert patched is not None
    tool_results = [m for m in patched if isinstance(m, ToolMessage)]
    assert [m.tool_call_id for m in tool_results] == ["toolu_1", "toolu_2"]
    # Each placeholder must sit right after its AI tool_use.
    assert isinstance(patched[1], ToolMessage)
    assert patched[1].tool_call_id == "toolu_1"
    assert isinstance(patched[4], ToolMessage)
    assert patched[4].tool_call_id == "toolu_2"


# ---- Duplicate tool_result hardening (prod 2026-06-11, F2) -------------------
#
# Anthropic 400: "each tool_use must have a single result. Found multiple
# tool_result blocks with id: toolu_...". The patcher previously assumed
# duplicates-later-in-history were tolerated; they are not. Every same-id
# tool_result after the first must be dropped from the request.


def _ai_with_call(call_id: str, name: str = "write_file") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}],
    )


def test_duplicate_tool_result_is_dropped():
    messages = [
        HumanMessage(content="go"),
        _ai_with_call("tc-1"),
        ToolMessage(content="ok", tool_call_id="tc-1"),
        ToolMessage(content="ok again (duplicate)", tool_call_id="tc-1"),
    ]
    patched = patch_dangling_tool_call_messages(messages)
    assert patched is not None
    result_ids = [m.tool_call_id for m in patched if isinstance(m, ToolMessage)]
    assert result_ids == ["tc-1"]
    # The FIRST result is the one kept.
    kept = next(m for m in patched if isinstance(m, ToolMessage))
    assert kept.content == "ok"


def test_duplicate_scattered_later_in_history_is_dropped():
    messages = [
        _ai_with_call("tc-1"),
        ToolMessage(content="ok", tool_call_id="tc-1"),
        AIMessage(content="thinking"),
        HumanMessage(content="continue"),
        ToolMessage(content="stray duplicate", tool_call_id="tc-1"),
    ]
    patched = patch_dangling_tool_call_messages(messages)
    assert patched is not None
    result_ids = [m.tool_call_id for m in patched if isinstance(m, ToolMessage)]
    assert result_ids == ["tc-1"]


def test_duplicate_and_dangling_combination():
    # tc-1 duplicated AND tc-2 dangling: both fixed in one pass.
    messages = [
        _ai_with_call("tc-1"),
        ToolMessage(content="ok", tool_call_id="tc-1"),
        ToolMessage(content="dup", tool_call_id="tc-1"),
        _ai_with_call("tc-2"),
        AIMessage(content="moved on without a result"),
    ]
    patched = patch_dangling_tool_call_messages(messages)
    assert patched is not None
    result_ids = [m.tool_call_id for m in patched if isinstance(m, ToolMessage)]
    assert result_ids.count("tc-1") == 1
    assert result_ids.count("tc-2") == 1


def test_well_formed_history_still_returns_none():
    messages = [
        _ai_with_call("tc-1"),
        ToolMessage(content="ok", tool_call_id="tc-1"),
        AIMessage(content="done"),
    ]
    assert patch_dangling_tool_call_messages(messages) is None
