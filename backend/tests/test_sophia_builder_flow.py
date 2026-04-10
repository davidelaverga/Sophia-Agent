"""End-to-end regression tests for Sophia builder handoff flow."""

import importlib
import json
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, ToolMessage

from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_session import BuilderSessionMiddleware
from deerflow.config.summarization_config import ContextSize, SummarizationConfig
from deerflow.subagents.config import SubagentConfig


def _make_runtime(state: dict, thread_id: str = "thread-1", user_id: str | None = None, context_user_id: str | None = None) -> SimpleNamespace:
    configurable = {"thread_id": thread_id}
    if user_id is not None:
        configurable["user_id"] = user_id
    context = {"thread_id": thread_id}
    if context_user_id is not None:
        context["user_id"] = context_user_id

    return SimpleNamespace(
        state=state,
        context=context,
        config={
            "configurable": configurable,
            "metadata": {"model_name": "claude-haiku-4-5-20251001", "trace_id": "trace-1"},
        },
    )


def _apply_update(state: dict, update: dict | None) -> dict:
    if not update:
        return state
    for key, value in update.items():
        state[key] = value
    return state


def test_switch_to_builder_queues_background_task(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")
    events = []
    captured = {}

    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr(
        switch_module,
        "get_subagent_config",
        lambda _name: SubagentConfig(
            name="general-purpose",
            description="test",
            system_prompt="test",
            timeout_seconds=90,
            max_turns=20,
        ),
    )

    class DummyExecutor:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def execute_async(self, task: str, task_id: str | None = None):
            captured["task"] = task
            captured["task_id"] = task_id
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: events.append)

    runtime = _make_runtime(
        {
            "user_id": "user_123",
            "current_artifact": {"tone_estimate": 1.8, "active_tone_band": "grief_fear"},
            "injected_memory_contents": ["Prefers concise slide headlines", "Avoids cluttered visuals"],
            "active_ritual": "prepare",
            "ritual_phase": "prepare.pitch_materials",
        }
    )

    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build a 5-slide investor deck for tomorrow.",
        task_type="presentation",
        tool_call_id="tc-builder-1",
    )
    payload = json.loads(response)

    assert payload["type"] == "builder_handoff"
    assert payload["status"] == "queued"
    assert payload["task_id"] == "tc-builder-1"
    assert payload["task_type"] == "presentation"
    assert payload["builder_task"]["status"] == "queued"
    assert captured["task"] == "Build a 5-slide investor deck for tomorrow."
    assert captured["task_id"] == "tc-builder-1"
    assert captured["kwargs"]["extra_configurable"]["delegation_context"]["relevant_memories"] == [
        "Prefers concise slide headlines",
        "Avoids cluttered visuals",
    ]
    assert events[-1]["type"] == "task_started"
    assert events[-1]["task_id"] == "tc-builder-1"


def test_switch_to_builder_suppresses_duplicate_launch(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    class FailIfCalledExecutor:
        def __init__(self, **kwargs):  # pragma: no cover - this should never run
            raise AssertionError("SubagentExecutor should not be constructed for duplicate builder task")

    monkeypatch.setattr(switch_module, "SubagentExecutor", FailIfCalledExecutor)

    runtime = _make_runtime(
        {
            "builder_task": {
                "task_id": "task-existing",
                "task_type": "presentation",
                "status": "running",
                "delegated_at": "2026-04-09T00:00:00Z",
            }
        }
    )
    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build another deck",
        task_type="presentation",
        tool_call_id="tc-builder-2",
    )
    payload = json.loads(response)

    assert payload["status"] == "already_running"
    assert payload["task_id"] == "task-existing"


def test_switch_to_builder_prefers_runtime_config_user_id(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")
    captured = {}

    monkeypatch.setattr(
        switch_module,
        "get_subagent_config",
        lambda _name: SubagentConfig(
            name="general-purpose",
            description="test",
            system_prompt="test",
            timeout_seconds=90,
            max_turns=20,
        ),
    )

    class DummyExecutor:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def execute_async(self, task: str, task_id: str | None = None):
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: captured.setdefault("builder_agent", {"user_id": user_id, "model_name": model_name}),
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime(
        {
            # state user_id intentionally omitted to validate runtime-config precedence
            "current_artifact": {"tone_estimate": 2.1, "active_tone_band": "anger_antagonism"},
        },
        user_id="jorge_test",
    )
    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build a test doc.",
        task_type="document",
        tool_call_id="tc-builder-runtime-user-id",
    )
    payload = json.loads(response)
    handoff_resolution = payload["handoff_resolution"]

    assert captured["builder_agent"]["user_id"] == "jorge_test"
    assert handoff_resolution["user_id_source"] == "runtime.config.configurable.user_id"
    assert handoff_resolution["config_user_id_present"] is True
    assert handoff_resolution["state_user_id_present"] is False


def test_switch_to_builder_prefers_latest_emit_artifact_payload(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")
    captured = {}

    monkeypatch.setattr(
        switch_module,
        "get_subagent_config",
        lambda _name: SubagentConfig(
            name="general-purpose",
            description="test",
            system_prompt="test",
            timeout_seconds=90,
            max_turns=20,
        ),
    )

    class DummyExecutor:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def execute_async(self, task: str, task_id: str | None = None):
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime(
        {
            "user_id": "user_123",
            "current_artifact": {"tone_estimate": 2.5, "active_tone_band": "engagement"},
            "messages": [
                AIMessage(
                    content="Here is your update plus handoff.",
                    tool_calls=[
                        {
                            "id": "tool-emit-artifact-1",
                            "name": "emit_artifact",
                            "args": {"tone_estimate": 3.5, "active_tone_band": "enthusiasm"},
                        },
                        {"id": "tool-switch-builder-1", "name": "switch_to_builder", "args": {"task_type": "document"}},
                    ],
                )
            ],
        }
    )

    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build docs from latest context.",
        task_type="document",
        tool_call_id="tc-builder-artifact-freshness",
    )
    payload = json.loads(response)

    delegation_context = payload["delegation_context"]
    assert delegation_context["companion_artifact"]["tone_estimate"] == 3.5
    assert delegation_context["companion_artifact"]["active_tone_band"] == "enthusiasm"
    handoff_resolution = payload["handoff_resolution"]
    assert handoff_resolution["artifact_source"] == "latest_emit_artifact_tool_call"
    assert handoff_resolution["latest_emit_artifact_present"] is True
    assert handoff_resolution["current_artifact_present"] is True


def test_switch_to_builder_reports_default_resolution_sources(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    monkeypatch.setattr(
        switch_module,
        "get_subagent_config",
        lambda _name: SubagentConfig(
            name="general-purpose",
            description="test",
            system_prompt="test",
            timeout_seconds=90,
            max_turns=20,
        ),
    )

    class DummyExecutor:
        def __init__(self, **kwargs):
            pass

        def execute_async(self, task: str, task_id: str | None = None):
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime({}, user_id=None)

    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build docs from defaults.",
        task_type="document",
        tool_call_id="tc-builder-default-resolution",
    )
    payload = json.loads(response)
    handoff_resolution = payload["handoff_resolution"]

    assert handoff_resolution["user_id_source"] == "default_user"
    assert handoff_resolution["artifact_source"] == "default_empty"
    assert handoff_resolution["config_user_id_present"] is False
    assert handoff_resolution["context_user_id_present"] is False
    assert handoff_resolution["state_user_id_present"] is False
    assert handoff_resolution["latest_emit_artifact_present"] is False
    assert handoff_resolution["current_artifact_present"] is False
    assert handoff_resolution["previous_artifact_present"] is False


def test_builder_session_to_artifact_synthesis_lifecycle(monkeypatch):
    class _FakeSubagentStatus:
        PENDING = "pending"
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"
        TIMED_OUT = "timed_out"
    task_id = "task-123"
    handoff_payload = {
        "type": "builder_handoff",
        "status": "queued",
        "task_id": task_id,
        "task_type": "presentation",
        "trace_id": "trace-1",
        "builder_task": {
            "task_id": task_id,
            "description": "Build deck",
            "task_type": "presentation",
            "status": "queued",
            "delegated_at": "2026-04-09T00:00:00Z",
        },
        "delegation_context": {"task_type": "presentation"},
    }
    ai_msg = AIMessage(
        content="Delegating to builder",
        tool_calls=[{"id": "tool-1", "name": "switch_to_builder", "args": {"task_type": "presentation"}}],
    )
    tool_msg = ToolMessage(content=json.dumps(handoff_payload), tool_call_id="tool-1", name="switch_to_builder")
    state = {
        "messages": [ai_msg, tool_msg],
        "system_prompt_blocks": [],
        "active_tone_band": "engagement",
    }
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}
    running_result = SimpleNamespace(
        task_id=task_id,
        trace_id="trace-1",
        status=_FakeSubagentStatus.RUNNING,
        started_at=datetime.now(),
        completed_at=None,
        result=None,
        error=None,
        ai_messages=[],
        final_state=None,
    )
    completed_result = SimpleNamespace(
        task_id=task_id,
        trace_id="trace-1",
        status=_FakeSubagentStatus.COMPLETED,
        result="done",
        completed_at=datetime.now(),
        error=None,
        ai_messages=[],
        final_state={
            "builder_result": {
                "artifact_path": "outputs/deck.md",
                "artifact_type": "presentation",
                "artifact_title": "Investor Deck",
                "steps_completed": 4,
                "decisions_made": ["Focused on growth story"],
                "companion_summary": "A focused 5-slide investor deck.",
                "companion_tone_hint": "Reassuring and confident.",
                "user_next_action": "Review slide 3 assumptions.",
                "confidence": 0.86,
            }
        },
    )
    cleanup_calls = []
    results = iter([running_result, completed_result])
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.SubagentStatus",
        _FakeSubagentStatus,
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.cleanup_background_task",
        lambda cleaned_task_id: cleanup_calls.append(cleaned_task_id),
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.get_background_task_result",
        lambda _task_id: next(results),
    )

    builder_session = BuilderSessionMiddleware()
    state = _apply_update(state, builder_session.before_agent(state, runtime))
    assert state["builder_task"]["status"] == "running"
    assert state["active_mode"] == "builder"
    assert any("<builder_task_status>" in block for block in state["system_prompt_blocks"])

    state = _apply_update(state, builder_session.before_agent(state, runtime))
    assert state["builder_task"]["status"] == "completed"
    assert state["active_mode"] == "companion"
    assert state["builder_result"]["artifact_type"] == "presentation"
    assert cleanup_calls == [task_id]

    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("# Artifact Instructions\nUse this block.")
        f.flush()
        artifact_mw = ArtifactMiddleware(Path(f.name))

    synthesis_update = artifact_mw.before_agent(state, runtime)
    assert synthesis_update is not None
    assert synthesis_update["builder_task"]["status"] == "synthesized"
    assert any("<builder_completed>" in block for block in synthesis_update["system_prompt_blocks"])
    Path(f.name).unlink(missing_ok=True)


def test_builder_session_timeout_surfaces_debug_summary(monkeypatch):
    class _FakeSubagentStatus:
        PENDING = "pending"
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"
        TIMED_OUT = "timed_out"

    task_id = "task-timeout-1"
    handoff_payload = {
        "type": "builder_handoff",
        "status": "queued",
        "task_id": task_id,
        "task_type": "presentation",
        "trace_id": "trace-timeout",
        "builder_task": {
            "task_id": task_id,
            "description": "Build deck",
            "task_type": "presentation",
            "status": "queued",
            "delegated_at": "2026-04-09T00:00:00Z",
        },
    }
    ai_msg = AIMessage(
        content="Delegating to builder",
        tool_calls=[{"id": "tool-timeout", "name": "switch_to_builder", "args": {"task_type": "presentation"}}],
    )
    tool_msg = ToolMessage(content=json.dumps(handoff_payload), tool_call_id="tool-timeout", name="switch_to_builder")
    state = {"messages": [ai_msg, tool_msg], "system_prompt_blocks": []}
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-timeout"}

    timed_out_result = SimpleNamespace(
        task_id=task_id,
        trace_id="trace-timeout",
        status=_FakeSubagentStatus.TIMED_OUT,
        completed_at=datetime.now(),
        error="Execution timed out after 120 seconds",
        ai_messages=[],
        final_state=None,
        timed_out_at=datetime.now(),
        last_ai_message_summary={
            "tool_names": ["bash", "write_file"],
            "has_emit_builder_artifact": False,
        },
        late_ai_message_summary={
            "tool_names": ["emit_builder_artifact"],
            "has_emit_builder_artifact": True,
        },
    )

    cleanup_calls = []
    log_contexts = []
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.SubagentStatus",
        _FakeSubagentStatus,
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.cleanup_background_task",
        lambda cleaned_task_id: cleanup_calls.append(cleaned_task_id),
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.get_background_task_result",
        lambda _task_id: timed_out_result,
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.log_middleware",
        lambda name, context, _start_time: log_contexts.append((name, context)),
    )

    builder_session = BuilderSessionMiddleware()
    state = _apply_update(state, builder_session.before_agent(state, runtime))

    assert state["builder_task"]["status"] == "timed_out"
    debug = state["builder_task"]["debug"]
    assert debug["last_tool_names"] == ["bash", "write_file"]
    assert debug["late_tool_names"] == ["emit_builder_artifact"]
    assert debug["late_has_emit_builder_artifact"] is True
    assert cleanup_calls == [task_id]
    assert any("late_tool_calls_after_timeout=emit_builder_artifact" in block for block in state["system_prompt_blocks"])
    assert any(
        name == "BuilderSession"
        and "builder status=timed_out" in context
        and "new_handoff_adopted=true" in context
        and f"task_id={task_id}" in context
        and "last_tool_calls=bash, write_file" in context
        and "late_tool_calls_after_timeout=emit_builder_artifact" in context
        and "late_emit_builder_artifact=true" in context
        for name, context in log_contexts
    )

def test_builder_session_logs_missing_background_task(monkeypatch):
    task_id = "task-missing-1"
    handoff_payload = {
        "type": "builder_handoff",
        "status": "queued",
        "task_id": task_id,
        "task_type": "presentation",
        "trace_id": "trace-missing",
        "builder_task": {
            "task_id": task_id,
            "description": "Build deck",
            "task_type": "presentation",
            "status": "queued",
            "delegated_at": "2026-04-09T00:00:00Z",
            "trace_id": "trace-missing",
        },
    }
    ai_msg = AIMessage(
        content="Delegating to builder",
        tool_calls=[{"id": "tool-missing", "name": "switch_to_builder", "args": {"task_type": "presentation"}}],
    )
    tool_msg = ToolMessage(content=json.dumps(handoff_payload), tool_call_id="tool-missing", name="switch_to_builder")
    state = {"messages": [ai_msg, tool_msg], "system_prompt_blocks": []}
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-missing"}

    log_contexts = []
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.get_background_task_result",
        lambda _task_id: None,
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_session.log_middleware",
        lambda name, context, _start_time: log_contexts.append((name, context)),
    )

    builder_session = BuilderSessionMiddleware()
    state = _apply_update(state, builder_session.before_agent(state, runtime))

    assert state["builder_task"]["status"] == "failed"
    assert state["builder_task"]["error"] == "Builder task state disappeared before completion."
    assert any(
        name == "BuilderSession"
        and "builder status=failed" in context
        and "new_handoff_adopted=true" in context
        and "background_task_missing=true" in context
        and f"task_id={task_id}" in context
        and "trace_id=trace-missing" in context
        for name, context in log_contexts
    )


def test_middleware_parity_in_companion_and_builder_chains(monkeypatch):
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")

    captured_companion = {}
    captured_builder = {}

    class DummyAgent:
        recursion_limit = 0

    class FakeSummarizationMiddleware:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware"

    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(companion_module, "create_chat_model", lambda **kwargs: "summary-model")
    monkeypatch.setattr(companion_module, "SummarizationMiddleware", FakeSummarizationMiddleware)
    monkeypatch.setattr(
        companion_module,
        "get_summarization_config",
        lambda: SummarizationConfig(
            enabled=True,
            trigger=[ContextSize(type="tokens", value=2000)],
            keep=ContextSize(type="messages", value=20),
        ),
    )
    monkeypatch.setattr(companion_module, "make_retrieve_memories_tool", lambda user_id: {"tool": user_id})

    def _capture_companion(**kwargs):
        captured_companion["middleware"] = kwargs["middleware"]
        return DummyAgent()

    monkeypatch.setattr(companion_module, "create_agent", _capture_companion)
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    companion_types = [type(mw).__name__ for mw in captured_companion["middleware"]]
    assert "BuilderSessionMiddleware" in companion_types
    assert "SummarizationMiddleware" in companion_types

    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-4-6")]),
    )

    def _capture_builder(**kwargs):
        captured_builder["middleware"] = kwargs["middleware"]
        return DummyAgent()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)
    builder_module._create_builder_agent(user_id="user_123")

    builder_types = [type(mw).__name__ for mw in captured_builder["middleware"]]
    assert "SandboxMiddleware" in builder_types
    assert "TodoMiddleware" in builder_types
