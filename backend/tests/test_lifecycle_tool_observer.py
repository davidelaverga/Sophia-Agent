"""Tests for LifecycleToolObserverMiddleware — structured-log observability
for the companion's deepagents lifecycle tool selection.

The middleware is purely observational: it emits one structured log line
per lifecycle-tool tool_call on the latest AIMessage. These tests pin the
log shape so we can grep for `lifecycle_tool_call` in production logs and
trust the {tool_name, task_id} fields after deploy.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

from langchain_core.messages import AIMessage

from deerflow.agents.sophia_agent.middlewares.lifecycle_tool_observer import (
    LifecycleToolObserverMiddleware,
)


def _state_with(tool_calls: list[dict]) -> dict:
    msg = AIMessage(content="", tool_calls=tool_calls)
    return {
        "messages": [msg],
        "turn_count": 3,
    }


def _runtime(thread_id: str = "thread-abc", user_id: str = "user-1") -> SimpleNamespace:
    """Mirror the production runtime shape: configurable carries thread_id /
    user_id (LangGraph SDK injects these on every invocation); context
    duplicates thread_id for cross-channel routing."""
    return SimpleNamespace(
        config={"configurable": {"thread_id": thread_id, "user_id": user_id}},
        context={"thread_id": thread_id},
    )


def test_observer_logs_each_lifecycle_tool_call(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = _state_with(
        [
            {
                "name": "update_async_task",
                "args": {"task_id": "abc-uuid-123", "message": "add RL section"},
                "id": "call-1",
            },
        ]
    )
    mw.after_model(state, runtime=_runtime())  # type: ignore[arg-type]
    records = [r for r in caplog.records if r.message == "lifecycle_tool_call"]
    assert len(records) == 1
    record = records[0]
    assert getattr(record, "tool_name") == "update_async_task"
    assert getattr(record, "task_id") == "abc-uuid-123"
    assert getattr(record, "thread_id") == "thread-abc"
    assert getattr(record, "turn_count") == 3
    assert getattr(record, "user_id") == "user-1"


def test_observer_pulls_thread_id_from_runtime_not_state(caplog):
    """Regression guard for the original P2 review: Sophia state does NOT
    carry thread_id in normal runs — it must come from runtime.config /
    runtime.context. Otherwise lifecycle_tool_call logs lose per-conversation
    correlation in production."""
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    # State deliberately has NO thread_id / user_id — production state shape.
    state = _state_with(
        [{"name": "check_async_task", "args": {"task_id": "t-1"}, "id": "1"}]
    )
    mw.after_model(state, runtime=_runtime(thread_id="thread-prod-9", user_id="u-prod"))  # type: ignore[arg-type]
    record = next(r for r in caplog.records if r.message == "lifecycle_tool_call")
    assert getattr(record, "thread_id") == "thread-prod-9"
    assert getattr(record, "user_id") == "u-prod"


def test_observer_falls_back_to_context_when_configurable_missing(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = _state_with(
        [{"name": "check_async_task", "args": {"task_id": "t-1"}, "id": "1"}]
    )
    # config has no configurable.thread_id — must fall back to context.
    runtime = SimpleNamespace(
        config={"configurable": {}},
        context={"thread_id": "context-tid"},
    )
    mw.after_model(state, runtime=runtime)  # type: ignore[arg-type]
    record = next(r for r in caplog.records if r.message == "lifecycle_tool_call")
    assert getattr(record, "thread_id") == "context-tid"


def test_observer_falls_back_to_state_when_runtime_missing(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = {
        "messages": [AIMessage(content="", tool_calls=[
            {"name": "check_async_task", "args": {"task_id": "t-1"}, "id": "1"}
        ])],
        "thread_id": "state-tid",
        "user_id": "state-uid",
    }
    mw.after_model(state, runtime=None)  # type: ignore[arg-type]
    record = next(r for r in caplog.records if r.message == "lifecycle_tool_call")
    assert getattr(record, "thread_id") == "state-tid"
    assert getattr(record, "user_id") == "state-uid"


def test_observer_logs_only_lifecycle_tools_not_emit_artifact(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = _state_with(
        [
            {"name": "emit_artifact", "args": {"session_goal": "..."}, "id": "ea-1"},
            {
                "name": "check_async_task",
                "args": {"task_id": "abc-uuid-123"},
                "id": "ck-1",
            },
        ]
    )
    mw.after_model(state, runtime=_runtime())  # type: ignore[arg-type]
    names = [getattr(r, "tool_name") for r in caplog.records if r.message == "lifecycle_tool_call"]
    assert names == ["check_async_task"]


def test_observer_no_op_when_no_tool_calls(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = _state_with([])
    mw.after_model(state, runtime=_runtime())  # type: ignore[arg-type]
    records = [r for r in caplog.records if r.message == "lifecycle_tool_call"]
    assert records == []


def test_observer_no_op_when_no_messages(caplog):
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    mw.after_model({"messages": []}, runtime=_runtime())  # type: ignore[arg-type]
    mw.after_model({}, runtime=_runtime())  # type: ignore[arg-type]
    records = [r for r in caplog.records if r.message == "lifecycle_tool_call"]
    assert records == []


def test_observer_covers_all_lifecycle_tools(caplog):
    """Each lifecycle-tool name must trigger a log line so
    post-deploy monitoring can measure the full distribution."""
    caplog.set_level(logging.INFO, logger="sophia.lifecycle_tool_observer")
    mw = LifecycleToolObserverMiddleware()
    state = _state_with(
        [
            {"name": "start_builder_task", "args": {"description": "..."}, "id": "1"},
            {"name": "edit_builder_artifact", "args": {"message": "edit it"}, "id": "2"},
            {"name": "update_async_task", "args": {"task_id": "t"}, "id": "3"},
            {"name": "check_async_task", "args": {"task_id": "t"}, "id": "4"},
            {"name": "cancel_async_task", "args": {"task_id": "t"}, "id": "5"},
            {"name": "list_async_tasks", "args": {}, "id": "6"},
        ]
    )
    mw.after_model(state, runtime=_runtime())  # type: ignore[arg-type]
    names = sorted(
        getattr(r, "tool_name") for r in caplog.records if r.message == "lifecycle_tool_call"
    )
    assert names == sorted(
        [
            "start_builder_task",
            "edit_builder_artifact",
            "update_async_task",
            "check_async_task",
            "cancel_async_task",
            "list_async_tasks",
        ]
    )
