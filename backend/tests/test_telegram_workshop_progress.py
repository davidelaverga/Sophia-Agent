"""Unit tests for the progress-target extractor (Phase 3 of workshop architecture)."""

from __future__ import annotations

from app.channels.telegram_workshop_progress import (
    ProgressTarget,
    extract_progress_targets_from_result,
)


def _ai_message_with_tool_call(tool_call_id: str, *, description: str) -> dict:
    return {
        "type": "ai",
        "content": "On it — let me kick off the research.",
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


def test_extract_returns_empty_on_no_tool_calls() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "hi"},
            {"type": "ai", "content": "hello back"},
        ]
    }
    assert extract_progress_targets_from_result(result) == []


def test_extract_returns_target_for_one_call() -> None:
    task_id = "task-abc-123"
    result = {
        "messages": [
            {"type": "human", "content": "research best EVs"},
            _ai_message_with_tool_call("call_1", description="brief"),
            _start_builder_tool_message("call_1", task_id=task_id),
            {"type": "ai", "content": "On it…"},
        ]
    }
    targets = extract_progress_targets_from_result(result)
    assert len(targets) == 1
    assert targets[0].task_id == task_id
    # When async_tasks is missing, run_id is None and the fanout falls
    # back to terminal-webhook-only ingress.
    assert targets[0].run_id is None


def test_extract_pulls_run_id_from_async_tasks() -> None:
    """Production regression: run_id is required for runs.join_stream."""
    task_id = "task-xyz"
    run_id = "run-deadbeef"
    result = {
        "messages": [
            {"type": "human", "content": "do thing"},
            _ai_message_with_tool_call("call_1", description="brief"),
            _start_builder_tool_message("call_1", task_id=task_id),
        ],
        "async_tasks": {
            task_id: {
                "task_id": task_id,
                "thread_id": task_id,
                "run_id": run_id,
                "agent_name": "sophia_builder",
                "status": "running",
            }
        },
    }
    targets = extract_progress_targets_from_result(result)
    assert len(targets) == 1
    assert targets[0].run_id == run_id


def test_extract_scopes_to_current_turn() -> None:
    """A prior-turn tool call must NOT trigger a new progress message."""
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
    targets = extract_progress_targets_from_result(result)
    assert targets == []


def test_extract_dedupes_within_turn() -> None:
    result = {
        "messages": [
            {"type": "human", "content": "do two things"},
            _ai_message_with_tool_call("call_1", description="brief one"),
            _start_builder_tool_message("call_1", task_id="task_1"),
            _start_builder_tool_message("call_1", task_id="task_1"),
            {"type": "ai", "content": "queued"},
        ]
    }
    targets = extract_progress_targets_from_result(result)
    assert len(targets) == 1
    assert targets[0].task_id == "task_1"


def test_extract_handles_two_distinct_tasks() -> None:
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
    targets = extract_progress_targets_from_result(result)
    assert {t.task_id for t in targets} == {"task_A", "task_B"}


def test_extract_handles_list_result_shape() -> None:
    messages = [
        {"type": "human", "content": "hi"},
        _ai_message_with_tool_call("call_1", description="brief"),
        _start_builder_tool_message("call_1", task_id="t"),
    ]
    targets = extract_progress_targets_from_result(messages)
    assert len(targets) == 1


def test_progress_target_is_frozen() -> None:
    """Defensive shape check — receivers stash these and must not mutate."""
    target = ProgressTarget(task_id="t", run_id="r")
    import dataclasses

    assert dataclasses.is_dataclass(target)
    # Frozen dataclass: attribute assignment raises FrozenInstanceError
    try:
        target.task_id = "other"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("ProgressTarget should be frozen")
