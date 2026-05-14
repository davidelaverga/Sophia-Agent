"""Unit tests for the companion summon-emit helper (Phase 2)."""

from __future__ import annotations

from app.channels.telegram_workshop_summon import (
    SummonRequest,
    extract_summons_from_result,
)


def _ai_message_with_tool_call(tool_call_id: str, *, description: str) -> dict:
    return {
        "type": "ai",
        "content": "On it — let me bring in the workshop to dig into this.",
        "tool_calls": [
            {
                "id": tool_call_id,
                "name": "start_builder_task",
                "args": {"description": description, "task_type": "research"},
            }
        ],
    }


def _start_builder_tool_message(tool_call_id: str, *, task_id: str) -> dict:
    return {
        "type": "tool",
        "name": "start_builder_task",
        "tool_call_id": tool_call_id,
        "content": (
            f"Launched builder task. task_id: {task_id}. "
            "It runs in the background — keep talking to the user."
        ),
    }


def test_extract_summons_returns_empty_on_no_tool_calls() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "hi"},
            {"type": "ai", "content": "hello back"},
        ]
    }
    assert extract_summons_from_result(result) == []


def test_extract_summons_returns_pair_for_one_call() -> None:
    description = "Research the best electric cars in Europe for families."
    task_id = "task-abc-123"
    result = {
        "messages": [
            {"type": "human", "content": "research best EVs"},
            _ai_message_with_tool_call("call_1", description=description),
            _start_builder_tool_message("call_1", task_id=task_id),
            {"type": "ai", "content": "On it…"},
        ]
    }
    summons = extract_summons_from_result(result)
    assert len(summons) == 1
    assert summons[0].task_id == task_id
    assert summons[0].task_brief == description


def test_extract_summons_scopes_to_current_turn() -> None:
    """A prior-turn tool call must NOT be re-summoned."""
    result = {
        "messages": [
            # Previous turn
            {"type": "human", "content": "earlier ask"},
            _ai_message_with_tool_call("call_old", description="old brief"),
            _start_builder_tool_message("call_old", task_id="task_old"),
            {"type": "ai", "content": "ok"},
            # Current turn
            {"type": "human", "content": "new ask"},
            {"type": "ai", "content": "let me think about that"},
        ]
    }
    summons = extract_summons_from_result(result)
    # Walk stops at the most recent human message — no start_builder_task
    # in the current turn → no summons.
    assert summons == []


def test_extract_summons_dedupes_within_turn() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "do two things"},
            _ai_message_with_tool_call("call_1", description="brief one"),
            _start_builder_tool_message("call_1", task_id="task_1"),
            _start_builder_tool_message("call_1", task_id="task_1"),
            {"type": "ai", "content": "queued"},
        ]
    }
    summons = extract_summons_from_result(result)
    assert len(summons) == 1
    assert summons[0].task_id == "task_1"


def test_extract_summons_handles_two_distinct_tasks() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "do two things at once"},
            {
                "type": "ai",
                "tool_calls": [
                    {"id": "c1", "name": "start_builder_task", "args": {"description": "brief A"}},
                    {"id": "c2", "name": "start_builder_task", "args": {"description": "brief B"}},
                ],
            },
            _start_builder_tool_message("c1", task_id="task_A"),
            _start_builder_tool_message("c2", task_id="task_B"),
        ]
    }
    summons = extract_summons_from_result(result)
    assert {s.task_id for s in summons} == {"task_A", "task_B"}
    briefs = {s.task_brief for s in summons}
    assert "brief A" in briefs and "brief B" in briefs


def test_extract_summons_handles_list_result_shape() -> None:
    messages = [
        {"type": "human", "content": "hi"},
        _ai_message_with_tool_call("call_1", description="brief"),
        _start_builder_tool_message("call_1", task_id="t"),
    ]
    summons = extract_summons_from_result(messages)
    assert len(summons) == 1


def test_extract_summons_skips_when_brief_empty() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "hi"},
            {
                "type": "ai",
                "tool_calls": [
                    {"id": "c", "name": "start_builder_task", "args": {"description": ""}},
                ],
            },
            _start_builder_tool_message("c", task_id="t"),
        ]
    }
    assert extract_summons_from_result(result) == []


def test_render_message_includes_at_mention_first() -> None:
    s = SummonRequest(task_id="t", task_brief="Research best EVs.")
    body = s.render_message(workshop_username="Sophia_work_bot")
    assert body.startswith("@Sophia_work_bot\n\n")
    assert "Research best EVs." in body


def test_render_message_strips_leading_at() -> None:
    s = SummonRequest(task_id="t", task_brief="brief")
    body = s.render_message(workshop_username="@Sophia_work_bot")
    assert body.startswith("@Sophia_work_bot\n\n")
    assert "@@" not in body


def test_render_message_truncates_long_brief() -> None:
    long_brief = "x" * 5000
    s = SummonRequest(task_id="t", task_brief=long_brief)
    body = s.render_message(workshop_username="Sophia_work_bot")
    # body is bounded by the per-summon brief cap + the @-mention prefix
    assert len(body) < 5000
    assert body.endswith("…")
