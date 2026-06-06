"""Tests for the lifecycle-tool matrix rendered by BuildAwarenessMiddleware.

The `_render_active_block` and `_render_terminal_block` functions are the
prompt surface where the companion model first sees the active task's
task_id and the rule "do not call start_builder_task on a duplicate".
These tests lock in the full intent → tool → ack matrix so a future prose
edit cannot silently regress the directive that fixes mid-build updates.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from deerflow.agents.sophia_agent.middlewares.build_awareness import (
    _render_active_block,
    _render_terminal_block,
)


def _now_iso(minutes_ago: int = 0) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _active_task(task_id: str = "abc-uuid-123") -> dict:
    return {
        "task_id": task_id,
        "agent_name": "sophia_builder",
        "thread_id": task_id,
        "run_id": "r-1",
        "status": "running",
        "task_type": "presentation",
        "created_at": _now_iso(minutes_ago=2),
        "last_checked_at": _now_iso(minutes_ago=2),
        "last_updated_at": _now_iso(minutes_ago=2),
    }


@pytest.mark.parametrize(
    "tool_name,ack_marker",
    [
        ("update_async_task", "updating"),
        ("check_async_task", "Checking"),
        ("cancel_async_task", "cancelling"),
        ("list_async_tasks", "Pulling up"),
    ],
)
def test_active_block_includes_tool_and_per_tool_ack(tool_name, ack_marker):
    """Each of the four lifecycle alternatives must appear with its ack
    example so the model sees a complete decision rule, not just one tool."""
    block = _render_active_block(_active_task())
    assert tool_name in block, f"{tool_name} missing from active block"
    assert ack_marker in block, f"ack marker '{ack_marker}' missing from active block"
    assert "abc-uuid-123" in block


def test_active_block_warns_against_stale_history_status():
    """deepagents docs call out stale-status reporting as a common failure
    mode. The active block must say statuses in conversation history are
    stale so the model always calls check_async_task fresh."""
    block = _render_active_block(_active_task())
    # Match the case-insensitive presence of stale-warning phrasing.
    lower = block.lower()
    assert "stale" in lower
    assert "always" in lower


def test_active_block_warns_against_start_builder_task_relaunch():
    block = _render_active_block(_active_task())
    assert "start_builder_task" in block
    assert "duplicate" in block.lower()


def test_active_block_uses_full_task_id_no_truncation():
    full_id = "019fbe43-2c1a-4d7b-91d8-77ae1f6c5e22"
    block = _render_active_block(_active_task(task_id=full_id))
    assert full_id in block
    # The full id should appear at least once for every lifecycle alternative
    # branch that interpolates it (update / check / cancel = 3 branches).
    assert block.count(full_id) >= 3
    assert "…" not in block
    assert "..." not in block


def test_active_block_forbids_chaining_two_lifecycle_tools():
    block = _render_active_block(_active_task())
    assert "never chain a second lifecycle call" in block.lower() or (
        "never chain two lifecycle" in block.lower()
    )


def _terminal_task(status: str = "success") -> dict:
    return {
        "task_id": "done-uuid-456",
        "agent_name": "sophia_builder",
        "thread_id": "done-uuid-456",
        "run_id": "r-done",
        "status": status,
        "created_at": _now_iso(minutes_ago=4),
        "last_checked_at": _now_iso(minutes_ago=2),
        "last_updated_at": _now_iso(minutes_ago=2),
    }


def test_terminal_block_teaches_list_async_tasks_for_recall():
    """When the build just finished, the user may reference it by
    description ('that doc we started'). The terminal block must teach
    list_async_tasks as the recall path."""
    block = _render_terminal_block(_terminal_task("success"))
    assert "list_async_tasks" in block
    assert "check_async_task" in block


def test_terminal_block_recall_defers_check_to_next_turn_no_chaining():
    """Regression guard for the P2 review: the recall path previously said
    'call list_async_tasks first to recall task_ids, then check_async_task
    on the specific id' AND in the same paragraph said 'never chain a
    second lifecycle call'. Those two rules contradicted each other and
    could push the model into invalid 2-tool turns.

    The fix defers the check_async_task call to the NEXT turn so the
    single-lifecycle-tool-per-turn invariant holds. This test pins that
    fix in place."""
    block = _render_terminal_block(_terminal_task("success"))
    # Both tools must still be mentioned (the model needs to know the
    # 2-turn pattern exists).
    assert "list_async_tasks" in block
    assert "check_async_task" in block
    # The deferral must be explicit.
    assert "NEXT turn" in block or "next turn" in block
    # Anti-pattern guard: the prose must NOT instruct the model to call
    # check_async_task immediately after list_async_tasks on the same turn.
    lower = block.lower()
    assert "then check_async_task" not in lower
    assert "list_async_tasks first" not in lower
    # And the one-per-turn invariant must still be present.
    assert "never chain" in lower or "one lifecycle tool per turn" in lower


def test_terminal_block_teaches_edit_builder_artifact_for_modify_cues():
    """When the latest build succeeded, targeted modification cues should edit
    the delivered artifact, not update the terminal builder thread or start a
    vague fresh build."""
    block = _render_terminal_block(_terminal_task("success"))
    # Modify-cue branch must name edit_builder_artifact.
    assert "edit_builder_artifact" in block
    # And must explicitly tell the model NOT to call update_async_task.
    lower = block.lower()
    assert "update_async_task" in block, "block should mention the anti-pattern by name"
    assert "do not call update_async_task" in lower or "not call update_async_task" in lower
    assert "start_builder_task" in block


def test_terminal_block_modify_branch_carries_full_task_id():
    full_id = "019fbe43-2c1a-4d7b-91d8-77ae1f6c5e22"
    task = _terminal_task("success")
    task["task_id"] = full_id
    task["thread_id"] = full_id
    block = _render_terminal_block(task)
    assert full_id in block
    # Guard against task-id truncation specifically — not generic "..."
    # placeholder syntax used elsewhere in the prose.
    assert "…" not in block
    assert f"{full_id[:8]}..." not in block
    assert f"{full_id[:12]}..." not in block


def test_active_block_recall_path_does_not_hardcode_running_filter():
    """Regression guard for the P2 review: ``list_async_tasks(status_filter="running")``
    would miss pending and interrupted tasks (both non-terminal in our
    terminal-blacklist model). The recall path must list ALL tasks so the
    model sees the full active set, not just running ones."""
    block = _render_active_block(_active_task())
    assert 'status_filter="running"' not in block
    # And the block should explicitly call out why (so the next prose edit
    # doesn't quietly re-introduce the narrower filter).
    lower = block.lower()
    assert "pending" in lower or "interrupted" in lower or "no status_filter" in lower
