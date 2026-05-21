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
import inspect
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from deerflow.sophia.tools.start_builder_task import _has_active_builder_task
from deerflow.sophia.tools.update_async_task_wrapper import (
    make_update_async_task_wrapper,
)

# ---- helpers ---------------------------------------------------------------


def _make_native_tool(
    name: str = "update_async_task",
    description: str = "native desc",
    args_schema=None,
):
    """Build a fake StructuredTool-shaped object whose ``func`` / ``coroutine``
    record their call args so tests can assert delegation occurred.

    ``args_schema`` defaults to the real deepagents ``UpdateAsyncTaskSchema``
    so the StructuredTool produced by the wrapper has production-shaped
    model-facing args (``task_id``, ``message``).
    """
    if args_schema is None:
        # Lazy import so the module doesn't blow up if deepagents changes
        # location at some point — falls back to None if not importable.
        try:
            from deepagents.middleware.async_subagents import UpdateAsyncTaskSchema
            args_schema = UpdateAsyncTaskSchema
        except ImportError:
            args_schema = None

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
        args_schema=args_schema,
    )
    return native, sync_calls, async_calls


def _runtime(async_tasks: dict | None, tool_call_id: str = "tc-test") -> SimpleNamespace:
    return SimpleNamespace(
        state={"async_tasks": async_tasks or {}},
        tool_call_id=tool_call_id,
    )


def _redirect_text(response):
    """Extract the redirect prose from either a plain-string return (cache-
    terminal branch) or a Command return (live-terminal branch). Returns
    "" for non-redirect responses so substring assertions degrade gracefully."""
    if isinstance(response, str):
        return response
    if isinstance(response, Command):
        for msg in response.update.get("messages", []):
            if isinstance(msg, ToolMessage):
                return msg.content
            content = getattr(msg, "content", None)
            if isinstance(content, str):
                return content
    return ""


# ---- E.2: post-interrupt message augmentation -----------------------------


@pytest.mark.parametrize("non_terminal_status", ["running", "pending", "interrupted"])
def test_wrapper_augments_user_message_with_file_target_directive(non_terminal_status):
    """Phase 2E.2: when the wrapper delegates to native update_async_task on
    a non-terminal target, the user's ``message`` arg is augmented with a
    directive telling the builder to continue editing files under
    ``/mnt/user-data/outputs/`` and NOT to invent scratch files like
    ``test.md`` / ``test2.md``. Production failure 2026-05-21 21:18 UTC:
    without this hint the builder looped on phantom-target write_file calls
    for 28 minutes."""
    native, _, async_calls = _make_native_tool()
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

    asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add a section on auto TTS", runtime=runtime)
    )

    # Native was called.
    assert len(async_calls) == 1
    delegated_message = async_calls[0]["message"]
    # The user's verbatim text is preserved.
    assert "add a section on auto TTS" in delegated_message
    # Directive is appended.
    assert "/mnt/user-data/outputs/" in delegated_message
    assert "test.md" in delegated_message
    assert "test2.md" in delegated_message
    # The directive carries the stable sentinel so retries / double-dispatch
    # don't pile up duplicate directives.
    assert "[Sophia/post-interrupt build directive]" in delegated_message


def test_wrapper_augmentation_includes_prior_artifact_path_when_present():
    """If the tracked entry already carries an ``artifact_path`` (the prior
    builder run produced a deliverable before the interrupt), the directive
    NAMES that path so the model continues editing the exact file rather
    than re-deriving it."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "artifact_path": "/mnt/user-data/outputs/recursive_llms_research.md",
            }
        }
    )

    asyncio.run(wrapped.coroutine(task_id="task-1", message="add TTS section", runtime=runtime))
    msg = async_calls[0]["message"]
    assert "/mnt/user-data/outputs/recursive_llms_research.md" in msg
    assert "CONTINUE editing" in msg


def test_wrapper_augmentation_is_idempotent():
    """If the message already carries the directive sentinel (e.g. a retry,
    or a model that copied the prior directive into a new turn), the
    wrapper does NOT add a second copy."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
            }
        }
    )

    pre_augmented = (
        "please also include reinforcement learning\n\n"
        "[Sophia/post-interrupt build directive]\nold directive content here"
    )
    asyncio.run(wrapped.coroutine(task_id="task-1", message=pre_augmented, runtime=runtime))
    msg = async_calls[0]["message"]
    # The marker appears exactly once.
    assert msg.count("[Sophia/post-interrupt build directive]") == 1
    # Original message preserved.
    assert "please also include reinforcement learning" in msg


def test_wrapper_augmentation_skipped_when_terminal_redirect_fires(monkeypatch):
    """The augmentation is irrelevant on the terminal-target path — the
    wrapper returns the redirect string immediately and never delegates to
    native. This test asserts no augmentation work happens (the native
    coroutine is not called)."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",  # terminal
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, str)
    assert async_calls == []
    # The redirect prose doesn't mention the augmentation marker (different code path).
    assert "[Sophia/post-interrupt build directive]" not in response


# ---- ToolRuntime injection contract (regression: prod TypeError 2026-05-21) -


def test_wrapper_runtime_param_is_recognized_as_directly_injected():
    """Regression guard for 2026-05-21 19:28 UTC production TypeError:
    `aupdate_async_task() missing 1 required positional argument: 'runtime'`.

    LangGraph's ToolNode constructs a ToolRuntime per tool_call and injects
    it into any parameter whose annotation IS the ToolRuntime class. That
    detection lives in ``StructuredTool._injected_args_keys`` which iterates
    the function signature and calls ``_is_directly_injected_arg_type`` —
    that helper checks ``isinstance(annotation, type) and issubclass(...,
    _DirectlyInjectedToolArg)``. If the wrapper module uses
    ``from __future__ import annotations``, every annotation becomes a
    string forward-ref and the isinstance check returns False, so ToolNode
    NEVER injects the runtime and the function is called with only the
    args_schema fields → TypeError on the missing positional.

    This test asserts the wrapper's coroutine ``runtime`` parameter is
    correctly identified as directly-injected. It's the production-truth
    check — same detection ToolNode uses at dispatch time."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    assert "runtime" in wrapped._injected_args_keys, (
        "ToolNode will not inject ToolRuntime for this wrapper — fix the "
        "`runtime: ToolRuntime` annotation (and ensure the module does NOT "
        "use `from __future__ import annotations`, which stringifies the "
        "annotation and breaks isinstance-based detection)."
    )


def test_wrapper_runtime_annotation_resolves_to_toolruntime_class():
    """Belt-and-suspenders: the annotation on the wrapper's runtime
    parameter must resolve to the actual ToolRuntime class at runtime
    (not a forward-ref string). A future regression introducing
    `from __future__ import annotations` to the wrapper module would
    break LangGraph's ToolNode injection silently — this test trips
    such a change."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    for fn_name in ("coroutine", "func"):
        fn = getattr(wrapped, fn_name)
        sig = inspect.signature(fn)
        runtime_param = sig.parameters["runtime"]
        annot = runtime_param.annotation
        assert annot is ToolRuntime, (
            f"{fn_name}.runtime annotation must be the ToolRuntime class, "
            f"got {annot!r}. (If you see a string here, the wrapper module "
            f"has `from __future__ import annotations` — remove it.)"
        )


def test_wrapper_model_facing_args_exclude_runtime():
    """The StructuredTool's model-facing arg list (driven by args_schema)
    must NOT include runtime — that arg comes from the execution context,
    not from the model's tool_call."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    model_args = set(wrapped.args.keys())
    assert "runtime" not in model_args
    assert "task_id" in model_args
    assert "message" in model_args


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
    wrapper MUST return a Command that carries BOTH the redirect prose
    AND a state update flipping the cached status to terminal. Returning
    a plain string would let the model's follow-up start_builder_task
    read the stale cache and reject the relaunch (codex P1 review)."""
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
    # Wrapper redirected via Command, not plain string.
    assert isinstance(response, Command), (
        "live-terminal redirect must return Command so async_tasks state "
        "update is persisted before the model calls start_builder_task"
    )
    # ToolMessage carries the redirect prose.
    text = _redirect_text(response)
    assert "start_builder_task" in text
    assert "task-1" in text
    # async_tasks update carries the FRESH terminal status.
    updated_tasks = response.update.get("async_tasks")
    assert isinstance(updated_tasks, dict)
    assert "task-1" in updated_tasks
    assert updated_tasks["task-1"]["status"] == "success"
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
    assert isinstance(response, Command)
    assert response.update["async_tasks"]["task-1"]["status"] == live_terminal_status
    assert "start_builder_task" in _redirect_text(response)
    assert async_calls == []


def test_live_terminal_redirect_unblocks_start_builder_task_duplicate_guard(monkeypatch):
    """End-to-end P1 regression: after the wrapper returns Command with
    the async_tasks state update, simulate langgraph applying that update
    to state, then call start_builder_task._has_active_builder_task on
    the updated state. It MUST return None — confirming that the model's
    follow-up start_builder_task on the SAME turn will NOT be rejected
    as a duplicate.

    The 2026-05-21 codex P1 review flagged exactly this failure mode:
    without persisting the live terminal status, _has_active_builder_task
    sees the stale non-terminal cache and rejects the relaunch.
    """
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    pre_state_async_tasks = {
        "task-1": {
            "task_id": "task-1",
            "agent_name": "sophia_builder",
            "status": "running",  # stale cache
            "thread_id": "task-1",
            "run_id": "r-1",
            "task_type": "research",
        }
    }
    runtime = _runtime(pre_state_async_tasks)

    # Sanity: before the wrapper runs, start_builder_task would reject.
    assert _has_active_builder_task(runtime.state) == "task-1"

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, Command)

    # Simulate langgraph applying the Command's async_tasks update
    # (the reducer merges {task_id: tracked_now} into existing async_tasks).
    updated_state = {
        "async_tasks": {**pre_state_async_tasks, **response.update["async_tasks"]},
    }
    # start_builder_task now sees the fresh terminal status → no active task → not a duplicate.
    assert _has_active_builder_task(updated_state) is None, (
        "start_builder_task would reject the relaunch as a duplicate; "
        "the live-terminal redirect Command failed to update async_tasks state."
    )


@pytest.mark.parametrize(
    "padded_input",
    ["task-1 ", " task-1", "  task-1  ", "\ttask-1\n"],
)
def test_live_terminal_redirect_writes_state_under_canonical_task_id(monkeypatch, padded_input):
    """Regression for codex P2 review 2026-05-21:
    when the model passes ``task_id`` with surrounding whitespace,
    ``_resolve_tracked`` correctly finds the canonical entry via
    ``task_id.strip()`` — but if the live-redirect state update is keyed
    by the RAW input, the reducer merges a phantom whitespace-keyed
    entry alongside the still-non-terminal canonical entry, and
    ``_has_active_builder_task`` then sees the canonical entry as still
    active → rejects the follow-up ``start_builder_task`` → recovery
    path is broken in exactly the whitespace-tolerance case the wrapper
    is meant to handle.

    Fix asserts: the Command's ``async_tasks`` update writes back under
    the CANONICAL key (``"task-1"``), and a follow-up
    ``_has_active_builder_task`` on the merged state returns None.
    """
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    pre_state_async_tasks = {
        # Canonical key — what BuildAwarenessMiddleware / start_builder_task wrote.
        "task-1": {
            "task_id": "task-1",
            "agent_name": "sophia_builder",
            "status": "running",
            "thread_id": "task-1",
            "run_id": "r-1",
            "task_type": "research",
        }
    }
    runtime = _runtime(pre_state_async_tasks)

    response = asyncio.run(
        wrapped.coroutine(task_id=padded_input, message="add X", runtime=runtime)
    )

    assert isinstance(response, Command)
    updated_tasks = response.update["async_tasks"]
    # Must write back under the canonical key, NOT the raw padded input.
    assert "task-1" in updated_tasks, (
        f"state update must use canonical task_id 'task-1', "
        f"got keys: {list(updated_tasks.keys())!r}"
    )
    assert padded_input not in updated_tasks, (
        f"state update wrote under whitespace key {padded_input!r}; this "
        f"creates a phantom entry and leaves the canonical entry non-terminal"
    )
    assert updated_tasks["task-1"]["status"] == "success"

    # End-to-end: simulate langgraph merging the Command update, then
    # confirm start_builder_task's duplicate guard would NOT reject.
    merged = {**pre_state_async_tasks, **updated_tasks}
    assert _has_active_builder_task({"async_tasks": merged}) is None, (
        "after canonical-key merge, _has_active_builder_task must return None"
    )
    # Native dispatch did not run.
    assert async_calls == []


def test_live_terminal_redirect_message_uses_canonical_task_id_in_prose(monkeypatch):
    """The interpolated task_id in the redirect prose is normalized to
    the canonical form. Otherwise the model may copy the
    whitespace-padded id into a follow-up start_builder_task description,
    which is at best ugly and at worst a future bug."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
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
        wrapped.coroutine(task_id="  task-1  ", message="add X", runtime=runtime)
    )
    text = _redirect_text(response)
    assert "task_id=task-1)" in text, (
        f"redirect prose must show canonical 'task-1', got prose: {text[:200]}"
    )
    assert "  task-1  " not in text


def test_live_terminal_redirect_degrades_to_string_when_tool_call_id_missing(monkeypatch, caplog):
    """When runtime has no tool_call_id (rare — synthetic / test contexts
    only), the wrapper logs a warning and falls back to a plain-string
    return. The redirect prose still reaches the model; only the state
    update is lost. Production always sets tool_call_id."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
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
        },
        tool_call_id="",  # ← empty: triggers degraded fallback
    )

    caplog.set_level("WARNING", logger="deerflow.sophia.tools.update_async_task_wrapper")
    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert any("could not persist state update" in r.message for r in caplog.records)


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
    # Phase 2E.2: the wrapper augments the message with a file-target
    # directive before delegating. The user's verbatim text is preserved
    # at the start; the directive is appended after a marker.
    assert "add X" in sync_calls[0]["message"]


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
