"""Tests for ``make_update_async_task_wrapper`` — Phase 2B terminal-thread guard.

The native deepagents ``update_async_task`` creates a new run on the
target builder thread unconditionally. When the target thread has
already reached terminal status, the new run inherits a completed
message history and loops on dangling tool calls (observed in
production at 2026-05-20 19:53–19:57 UTC, ~3.5 min of repeated
``Injecting/reordering 1 ToolMessage(s) for dangling/misplaced tool
calls`` warnings on a single locked worker).

The wrapper:
- On terminal target — returns a directive string and does NOT call
  the native dispatch.
- On non-terminal target — delegates to the native ``coroutine`` / ``func``
  so the existing SDK dispatch logic is preserved exactly.
- Forwards the args (``task_id``, ``message``, ``runtime``) unchanged.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from deerflow.sophia.tools.update_async_task_wrapper import (
    make_update_async_task_wrapper,
)


# ---- helpers ---------------------------------------------------------------


def _make_native_tool(name: str = "update_async_task", description: str = "native desc"):
    """Build a fake StructuredTool-shaped object whose ``func`` / ``coroutine``
    record their call args so tests can assert delegation occurred."""
    sync_calls: list[dict] = []
    async_calls: list[dict] = []

    def native_func(*, task_id, message, runtime):
        sync_calls.append({"task_id": task_id, "message": message, "runtime": runtime})
        return f"native-sync({task_id})"

    async def native_coroutine(*, task_id, message, runtime):
        async_calls.append({"task_id": task_id, "message": message, "runtime": runtime})
        return f"native-async({task_id})"

    native = SimpleNamespace(
        name=name,
        description=description,
        func=native_func,
        coroutine=native_coroutine,
        args_schema=None,
    )
    return native, sync_calls, async_calls


def _runtime(async_tasks: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        state={"async_tasks": async_tasks or {}},
        tool_call_id="tc-test",
    )


# ---- terminal-target rejection --------------------------------------------


@pytest.mark.parametrize(
    "terminal_status",
    [
        "success",
        "completed",
        "error",
        "failed",
        "cancelled",
        "timeout",
        "timed_out",
    ],
)
def test_wrapper_rejects_terminal_target_sync(terminal_status):
    """For every terminal status, the sync wrapper must return a directive
    string and MUST NOT invoke the native dispatch."""
    native, sync_calls, _async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": terminal_status,
                "task_type": "research",
                "thread_id": "task-1",
                "run_id": "r-1",
                "created_at": "2026-05-20T19:43:37Z",
                "last_checked_at": "2026-05-20T19:53:27Z",
                "last_updated_at": "2026-05-20T19:53:27Z",
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert isinstance(response, str)
    # Directive content checks: model is told NOT to call update again and
    # IS told to call start_builder_task with the prior artifact in scope.
    assert "terminal" in response.lower() or terminal_status in response
    assert "start_builder_task" in response
    assert "task-1" in response
    # Native must not have been called.
    assert sync_calls == []


@pytest.mark.parametrize(
    "terminal_status",
    ["success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_wrapper_rejects_terminal_target_async(terminal_status):
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": terminal_status,
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert async_calls == []


# ---- live SDK re-check (defeat cache staleness) ---------------------------


def _stub_sdk_client(monkeypatch, *, run_status: str | None, raise_on_get: bool = False):
    """Install a fake ``langgraph_sdk.get_client`` whose ``runs.get`` returns
    a dict with the given ``status``, or raises if ``raise_on_get`` is set.
    Returns a list that records each (thread_id, run_id) call so tests can
    assert the live check fired exactly once."""
    calls: list[tuple[str, str]] = []

    async def fake_runs_get(thread_id: str, run_id: str):
        calls.append((thread_id, run_id))
        if raise_on_get:
            raise RuntimeError("simulated SDK failure")
        if run_status is None:
            return {"some_other_field": "..."}
        return {"status": run_status}

    fake_runs = MagicMock()
    fake_runs.get = fake_runs_get
    fake_client = MagicMock()
    fake_client.runs = fake_runs

    def fake_get_client(url=None):
        return fake_client

    monkeypatch.setattr("langgraph_sdk.get_client", fake_get_client)
    return calls


def test_async_live_check_redirects_when_cache_stale_but_live_terminal(monkeypatch):
    """The cache says 'running' but the live SDK says 'success' — the
    wrapper MUST redirect and NOT delegate. This is the dangling-tool-loop
    race the P1 review flagged.
    """
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",  # cached, stale
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Live SDK was queried exactly once.
    assert calls == [("task-1", "r-1")]
    # Wrapper redirected.
    assert isinstance(response, str)
    assert "start_builder_task" in response
    # Native dispatch must NOT have run.
    assert async_calls == []


@pytest.mark.parametrize(
    "live_terminal_status",
    ["success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_async_live_check_redirects_for_all_terminal_statuses(monkeypatch, live_terminal_status):
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status=live_terminal_status)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert async_calls == []


def test_async_live_check_delegates_when_live_still_running(monkeypatch):
    """If live SDK confirms the run is still active, delegate to native."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="running")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert calls == [("task-1", "r-1")]
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_live_check_failure_falls_back_to_cache_delegate(monkeypatch):
    """Fail-open: if the SDK live-check raises, the wrapper falls back to
    the cached status and delegates. We never want to block a legitimate
    update_async_task because of SDK transport issues."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status=None, raise_on_get=True)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",  # cache says running
                "thread_id": "task-1",
                "run_id": "r-1",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Fell back to cache, delegated.
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_live_check_skips_when_thread_or_run_id_missing(monkeypatch):
    """If tracked entry has no thread_id / run_id, there is nothing to
    re-check live. Fall back to cache, delegate."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                # Intentionally no thread_id, no run_id.
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Live SDK was never called.
    assert calls == []
    # Delegated normally.
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_terminal_cache_skips_live_check(monkeypatch):
    """Optimization: if the cached status is already terminal, we already
    have the answer — don't waste an SDK round-trip on a live check."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="running")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",  # cache already terminal
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Cache-only path: live check skipped.
    assert calls == []
    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert async_calls == []


# ---- non-terminal delegation ----------------------------------------------


@pytest.mark.parametrize(
    "non_terminal_status",
    ["running", "pending", "interrupted", "queued", "starting"],
)
def test_wrapper_delegates_when_target_not_terminal_sync(non_terminal_status):
    """For any non-terminal status, the wrapper must delegate to the native
    sync func with the exact same args. This preserves the existing SDK
    dispatch behaviour."""
    native, sync_calls, _async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": non_terminal_status,
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert response == "native-sync(task-1)"
    assert len(sync_calls) == 1
    assert sync_calls[0]["task_id"] == "task-1"
    assert sync_calls[0]["message"] == "add X"


@pytest.mark.parametrize(
    "non_terminal_status",
    ["running", "pending", "interrupted", "queued", "starting"],
)
def test_wrapper_delegates_when_target_not_terminal_async(non_terminal_status):
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": non_terminal_status,
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_wrapper_delegates_when_task_unknown():
    """If the task_id isn't in state['async_tasks'], the wrapper has no
    status to check — it must delegate so the native tool can return its
    own 'No tracked task found' error."""
    native, sync_calls, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime({})

    response = wrapped.func(task_id="unknown-1", message="add X", runtime=runtime)

    assert response == "native-sync(unknown-1)"
    assert len(sync_calls) == 1


def test_wrapper_delegates_when_state_missing_async_tasks_key():
    native, sync_calls, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(state={}, tool_call_id="tc")

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert response == "native-sync(task-1)"
    assert len(sync_calls) == 1


# ---- wrapper construction guards ------------------------------------------


def test_wrapper_factory_rejects_none_native():
    with pytest.raises(ValueError, match="requires the native"):
        make_update_async_task_wrapper(None)


def test_wrapper_factory_rejects_wrong_name():
    native, _, _ = _make_native_tool(name="check_async_task")
    with pytest.raises(ValueError, match="Expected native tool"):
        make_update_async_task_wrapper(native)


# ---- directive content guards ---------------------------------------------


def test_directive_includes_task_type_for_v2_brief():
    """The directive prose must surface the prior build's task_type so the
    model knows to call start_builder_task with the matching type when it
    composes the v2 brief."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": "research",
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)
    assert "research" in response


def test_directive_does_not_truncate_task_id():
    full_id = "019fbe43-2c1a-4d7b-91d8-77ae1f6c5e22"
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            full_id: {
                "task_id": full_id,
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": "document",
            }
        }
    )

    response = wrapped.func(task_id=full_id, message="add X", runtime=runtime)
    assert full_id in response
    # Guard against task-id truncation specifically — not generic "..."
    # placeholder syntax used elsewhere in the directive prose.
    assert "…" not in response
    assert f"{full_id[:8]}..." not in response
    assert f"{full_id[:12]}..." not in response
