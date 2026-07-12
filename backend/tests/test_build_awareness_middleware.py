"""Tests for ``BuildAwarenessMiddleware``.

Covers the three rendered states (active / recently-completed / errored),
the SDK-refresh path (with TTL caching), and the no-op default when no
builder task is in state.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from deerflow.agents.sophia_agent.middlewares.build_awareness import (
    BuildAwarenessMiddleware,
)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _builder_task(
    *,
    task_id: str = "task-1",
    status: str = "running",
    created_at_offset_min: int = 0,
    last_updated_offset_min: int | None = None,
) -> dict:
    """Construct a deepagents-shaped AsyncTask dict for ``sophia_builder``."""
    now = datetime.now(UTC)
    created = now - timedelta(minutes=created_at_offset_min)
    last_upd = (
        now - timedelta(minutes=last_updated_offset_min)
        if last_updated_offset_min is not None
        else created
    )
    return {
        "task_id": task_id,
        "agent_name": "sophia_builder",
        "thread_id": task_id,
        "run_id": f"r-{task_id}",
        "status": status,
        "created_at": _iso(created),
        "last_checked_at": _iso(last_upd),
        "last_updated_at": _iso(last_upd),
    }


def _runtime() -> SimpleNamespace:
    """A runtime stub (the middleware doesn't read it for sync render)."""
    return SimpleNamespace()


# ---------- no-op cases -----------------------------------------------------


def test_no_async_tasks_returns_none():
    mw = BuildAwarenessMiddleware()
    assert mw.before_agent({}, _runtime()) is None


def test_async_tasks_with_no_builder_entry_returns_none():
    """Other agents' tasks shouldn't trigger a builder-status block."""
    mw = BuildAwarenessMiddleware()
    state = {
        "async_tasks": {
            "researcher-1": {
                "task_id": "researcher-1",
                "agent_name": "researcher",
                "status": "running",
            }
        }
    }
    assert mw.before_agent(state, _runtime()) is None


def test_terminal_task_outside_window_returns_none():
    """A completed-31-min-ago task is outside the 30-min recent window."""
    mw = BuildAwarenessMiddleware()
    task = _builder_task(status="success", created_at_offset_min=31, last_updated_offset_min=31)
    state = {"async_tasks": {"task-1": task}}
    assert mw.before_agent(state, _runtime()) is None


# ---------- block rendering -------------------------------------------------


def test_active_task_renders_in_flight_block():
    mw = BuildAwarenessMiddleware()
    task = _builder_task(status="running", created_at_offset_min=2)
    state = {"async_tasks": {"task-1": task}}

    result = mw.before_agent(state, _runtime())

    assert result is not None
    block = result["system_prompt_blocks"][-1]
    assert "<build_status>" in block
    assert "in flight" in block.lower()
    # Phase: directive replaces "Don't relaunch" with the explicit
    # start_builder_task duplicate-rejection rule. The full lifecycle-tool
    # matrix lives in test_build_awareness_lifecycle_block.py.
    assert "start_builder_task" in block
    assert "duplicate" in block.lower()
    assert "do NOT bring this up unprompted" in block


def test_pending_status_treated_as_active():
    """LangGraph SDK's ``pending`` status is non-terminal — same block."""
    mw = BuildAwarenessMiddleware()
    task = _builder_task(status="pending", created_at_offset_min=1)
    state = {"async_tasks": {"task-1": task}}

    result = mw.before_agent(state, _runtime())
    assert result is not None
    assert "in flight" in result["system_prompt_blocks"][-1].lower()


def test_completed_within_window_renders_just_finished_block():
    mw = BuildAwarenessMiddleware()
    task = _builder_task(
        status="success", created_at_offset_min=10, last_updated_offset_min=2
    )
    state = {"async_tasks": {"task-1": task}}

    result = mw.before_agent(state, _runtime())

    assert result is not None
    block = result["system_prompt_blocks"][-1]
    assert "<build_status>" in block
    assert "just finished" in block.lower()
    assert "delivered separately" in block.lower()
    assert "Don't bring this up unprompted" in block


def test_errored_task_renders_error_block():
    mw = BuildAwarenessMiddleware()
    task = _builder_task(
        status="error", created_at_offset_min=15, last_updated_offset_min=5
    )
    state = {"async_tasks": {"task-1": task}}

    result = mw.before_agent(state, _runtime())

    assert result is not None
    block = result["system_prompt_blocks"][-1]
    assert "<build_status>" in block
    assert "error" in block.lower()
    assert "address that first" in block.lower()


def test_cancelled_task_renders_cancelled_block():
    mw = BuildAwarenessMiddleware()
    task = _builder_task(
        status="cancelled", created_at_offset_min=8, last_updated_offset_min=2
    )
    state = {"async_tasks": {"task-1": task}}

    result = mw.before_agent(state, _runtime())

    assert result is not None
    block = result["system_prompt_blocks"][-1]
    assert "cancelled" in block.lower()


def test_active_task_wins_over_terminal_one():
    """If multiple builder tasks exist, an active one takes precedence."""
    mw = BuildAwarenessMiddleware()
    state = {
        "async_tasks": {
            "old-completed": _builder_task(
                task_id="old-completed",
                status="success",
                created_at_offset_min=20,
                last_updated_offset_min=18,
            ),
            "current-running": _builder_task(
                task_id="current-running",
                status="running",
                created_at_offset_min=2,
            ),
        }
    }

    result = mw.before_agent(state, _runtime())
    assert result is not None
    block = result["system_prompt_blocks"][-1]
    assert "in flight" in block.lower()


def test_appends_to_existing_system_prompt_blocks():
    mw = BuildAwarenessMiddleware()
    state = {
        "async_tasks": {"task-1": _builder_task(status="running")},
        "system_prompt_blocks": ["<existing>previous</existing>"],
    }

    result = mw.before_agent(state, _runtime())
    blocks = result["system_prompt_blocks"]
    assert len(blocks) == 2
    assert blocks[0] == "<existing>previous</existing>"
    assert "<build_status>" in blocks[1]


# ---------- async refresh path ---------------------------------------------


def test_async_refresh_updates_terminal_status(monkeypatch):
    """SDK reports ``success`` for a task we still see as ``running`` —
    the middleware should rewrite ``async_tasks`` AND render the completion
    block in the same pass."""
    mw = BuildAwarenessMiddleware()
    task = _builder_task(task_id="t-async", status="running", created_at_offset_min=2)

    # Mock the SDK client.
    fake_client = MagicMock()
    fake_client.runs = MagicMock()
    fake_client.runs.get = AsyncMock(return_value={"status": "success"})
    fake_client.threads = MagicMock()
    fake_client.threads.get = AsyncMock(
        return_value={
            "values": {
                "builder_result": {
                    "status": "completed",
                    "terminal_status": "completed",
                    "terminal_reason": "artifact_emitted",
                    "artifact_path": "/mnt/user-data/outputs/deck.pptx",
                }
            }
        }
    )
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    state = {"async_tasks": {"t-async": task}}
    result = asyncio.run(mw.abefore_agent(state, _runtime()))

    assert result is not None
    # async_tasks updated with the new terminal status.
    assert result["async_tasks"]["t-async"]["status"] == "success"
    # Block reflects the new state ("just finished").
    assert "just finished" in result["system_prompt_blocks"][-1].lower()


def test_async_refresh_skips_already_terminal_tasks(monkeypatch):
    """Terminal entries don't get refreshed — saves SDK round-trips."""
    mw = BuildAwarenessMiddleware()
    fake_client = MagicMock()
    fake_client.runs = MagicMock()
    fake_client.runs.get = AsyncMock()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    state = {
        "async_tasks": {
            "done": _builder_task(status="success", created_at_offset_min=5, last_updated_offset_min=3)
        }
    }
    asyncio.run(mw.abefore_agent(state, _runtime()))

    fake_client.runs.get.assert_not_called()


def test_async_refresh_respects_ttl_cache(monkeypatch):
    """Two abefore_agent calls within TTL window → only one SDK round-trip."""
    mw = BuildAwarenessMiddleware()
    fake_client = MagicMock()
    fake_client.runs = MagicMock()
    fake_client.runs.get = AsyncMock(return_value={"status": "running"})
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    state = {
        "async_tasks": {
            "t-cached": _builder_task(task_id="t-cached", status="running", created_at_offset_min=1)
        }
    }
    asyncio.run(mw.abefore_agent(state, _runtime()))
    asyncio.run(mw.abefore_agent(state, _runtime()))

    # First call refreshes; second call hits the TTL cache.
    assert fake_client.runs.get.call_count == 1


def test_async_refresh_handles_sdk_failure_gracefully(monkeypatch):
    """SDK raising must NOT propagate out of the hook — we fall back to
    rendering whatever we already have."""
    mw = BuildAwarenessMiddleware()
    fake_client = MagicMock()
    fake_client.runs = MagicMock()
    fake_client.runs.get = AsyncMock(side_effect=RuntimeError("ASGI down"))
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    state = {
        "async_tasks": {
            "t-err": _builder_task(task_id="t-err", status="running", created_at_offset_min=1)
        }
    }
    # Must not raise.
    result = asyncio.run(mw.abefore_agent(state, _runtime()))

    # The block is still rendered from the (un-refreshed) state.
    assert result is not None
    assert "in flight" in result["system_prompt_blocks"][-1].lower()


def test_async_refresh_prunes_stale_refresh_cache(monkeypatch):
    """Refresh TTL cache should drop task_ids no longer present in state."""
    mw = BuildAwarenessMiddleware()
    mw._last_refresh_at = {"stale-task": 123.0}

    fake_client = MagicMock()
    fake_client.runs = MagicMock()
    fake_client.runs.get = AsyncMock(return_value={"status": "running"})
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    state = {
        "async_tasks": {
            "fresh-task": _builder_task(task_id="fresh-task", status="running", created_at_offset_min=1)
        }
    }

    asyncio.run(mw.abefore_agent(state, _runtime()))

    assert "stale-task" not in mw._last_refresh_at
    assert "fresh-task" in mw._last_refresh_at
