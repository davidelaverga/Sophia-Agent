"""End-to-end regression tests for Sophia builder handoff flow."""

import importlib
import json
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_session import BuilderSessionMiddleware
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


def _payload_from_builder_response(response: str | Command) -> dict:
    """Extract the JSON builder handoff payload from a string or Command."""
    if isinstance(response, Command):
        tool_message = response.update["messages"][0]
        return json.loads(tool_message.content)
    return json.loads(response)


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
            "async_tasks": {
                "prior-task": {
                    "task_id": "prior-task",
                    "agent_name": "researcher",
                    "thread_id": "prior-thread",
                    "run_id": "prior-run",
                    "status": "running",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            },
        }
    )

    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build a 5-slide investor deck for tomorrow.",
        task_type="presentation",
        tool_call_id="tc-builder-1",
    )
    assert isinstance(response, Command)
    assert response.update["active_mode"] == "builder"
    assert response.update["builder_task"]["task_id"] == "tc-builder-1"
    assert response.update["builder_result"] is None
    assert response.update["async_tasks"]["tc-builder-1"]["agent_name"] == "sophia_builder"
    assert response.update["async_tasks"]["tc-builder-1"]["status"] == "running"
    assert response.update["async_tasks"]["tc-builder-1"]["thread_id"] == "thread-1"
    assert response.update["async_tasks"]["prior-task"]["agent_name"] == "researcher"
    payload = _payload_from_builder_response(response)

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
    assert captured["kwargs"]["extra_configurable"]["delegation_context"]["allow_web_research"] is False
    assert captured["kwargs"]["extra_configurable"]["delegation_context"]["search_mode"] == "autonomous"

    # Wall-clock plumbing: switch_to_builder propagates the per-run timeout
    # and a kickoff timestamp so BuilderArtifactMiddleware /
    # BuilderTaskMiddleware can compute wall-clock pressure. Without these
    # keys, the wall-clock force-emit gate reverts to today's turn-count-only
    # behavior — verifying their presence here prevents a silent regression.
    extra = captured["kwargs"]["extra_configurable"]
    assert extra["builder_timeout_seconds"] == 1800
    assert isinstance(extra["builder_task_kickoff_ms"], int)
    assert extra["builder_task_kickoff_ms"] > 0

    # Per-turn timeout is wired onto the SubagentConfig replaced in
    # _switch_to_builder_impl. The test's get_subagent_config returns a
    # config without per_turn_timeout_seconds; switch_to_builder must
    # override it via dataclasses.replace().
    submitted_config = captured["kwargs"]["config"]
    assert submitted_config.timeout_seconds == 1800
    assert submitted_config.per_turn_timeout_seconds == 300
    # PR #94: max_turns (LangGraph recursion_limit) raised 150 → 250.
    assert submitted_config.max_turns == 250

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
    payload = _payload_from_builder_response(response)

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
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    assert captured["builder_agent"]["user_id"] == "jorge_test"
    assert handoff_resolution["user_id_source"] == "runtime.config.configurable.user_id"
    assert handoff_resolution["config_user_id_present"] is True
    assert handoff_resolution["state_user_id_present"] is False


def test_make_switch_to_builder_tool_uses_bound_user_id_when_runtime_sources_missing(monkeypatch):
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

        def execute_async(
            self,
            task: str,
            task_id: str | None = None,
            owner_id: str | None = None,
            description: str | None = None,
        ):
            captured["task"] = task
            captured["task_id"] = task_id
            captured["owner_id"] = owner_id
            captured["description"] = description
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: captured.setdefault("builder_agent", {"user_id": user_id, "model_name": model_name}),
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime(
        {
            "current_artifact": {"tone_estimate": 2.1, "active_tone_band": "anger_antagonism"},
        }
    )
    bound_tool = switch_module.make_switch_to_builder_tool("bound_user")
    response = bound_tool.func(
        runtime=runtime,
        task="Build a test doc.",
        task_type="document",
        tool_call_id="tc-builder-bound-user-id",
    )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    assert captured["builder_agent"]["user_id"] == "bound_user"
    assert captured["owner_id"] == "bound_user"
    assert handoff_resolution["user_id_source"] == "configured_builder_user_id"
    assert handoff_resolution["configured_user_id_present"] is True
    assert handoff_resolution["config_user_id_present"] is False
    assert handoff_resolution["state_user_id_present"] is False
    # tool-arg path was not used in this scenario
    assert handoff_resolution["tool_arg_user_id_present"] is False


def test_switch_to_builder_tool_arg_user_id_does_not_override_runtime_config(monkeypatch, caplog):
    """PR-B / security hardening: the LLM's ``user_id`` tool arg must NEVER
    override an authenticated ``runtime.config.configurable.user_id``. When
    the two differ, a WARNING is logged (possible prompt-injection audit
    trail) but the trusted runtime identity wins."""
    import logging

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

        def execute_async(self, task: str, task_id: str | None = None, owner_id: str | None = None, description: str | None = None):
            captured["owner_id"] = owner_id
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: captured.setdefault("builder_agent", {"user_id": user_id, "model_name": model_name}),
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime(
        {
            "current_artifact": {"tone_estimate": 2.0, "active_tone_band": "anger_antagonism"},
        },
        user_id="authenticated_user",  # trusted runtime.config.configurable.user_id
    )

    with caplog.at_level(logging.WARNING, logger=switch_module.logger.name):
        response = switch_module.switch_to_builder.func(
            runtime=runtime,
            task="Build a test doc — attacker supplies different user_id in tool args.",
            task_type="document",
            user_id="attacker_supplied_user",  # UNTRUSTED — must be ignored
            tool_call_id="tc-builder-tool-arg-no-override",
        )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    # Trusted runtime identity wins — builder gets authenticated_user.
    assert captured["builder_agent"]["user_id"] == "authenticated_user"
    assert captured["owner_id"] == "authenticated_user"
    assert handoff_resolution["user_id_source"] == "runtime.config.configurable.user_id"
    # Tool arg is recorded in diagnostics but was NOT used.
    assert handoff_resolution["tool_arg_user_id_present"] is True
    assert handoff_resolution["tool_arg_user_id_matches_trusted"] is False
    # Mismatch must emit WARNING so prompt-injection attempts are visible in ops.
    mismatch = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "tool-arg user_id mismatch" in r.getMessage()
    ]
    assert mismatch, (
        f"Expected a WARNING on tool-arg/trusted mismatch. "
        f"Got: {[r.getMessage() for r in caplog.records]}"
    )


def test_make_switch_to_builder_tool_arg_does_not_override_bound_user(monkeypatch, caplog):
    """PR-B / security hardening: the LLM's ``user_id`` tool arg must NEVER
    override the closure-bound authenticated user set at companion
    construction via ``make_switch_to_builder_tool(user_id)``. Closure-bound
    identity is trusted; the tool arg is not."""
    import logging

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

        def execute_async(self, task: str, task_id: str | None = None, owner_id: str | None = None, description: str | None = None):
            captured["owner_id"] = owner_id
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: captured.setdefault("builder_agent", {"user_id": user_id, "model_name": model_name}),
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    # No runtime / context / state user_id — the only trusted source is the
    # closure-bound one.
    runtime = _make_runtime({})
    bound_tool = switch_module.make_switch_to_builder_tool("bound_authenticated_user")

    with caplog.at_level(logging.WARNING, logger=switch_module.logger.name):
        response = bound_tool.func(
            runtime=runtime,
            task="Build — attacker supplies different user_id via tool args.",
            task_type="document",
            user_id="attacker_supplied_user",
            tool_call_id="tc-builder-tool-arg-no-override-bound",
        )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    # Closure-bound identity wins.
    assert captured["builder_agent"]["user_id"] == "bound_authenticated_user"
    assert captured["owner_id"] == "bound_authenticated_user"
    assert handoff_resolution["user_id_source"] == "configured_builder_user_id"
    assert handoff_resolution["tool_arg_user_id_present"] is True
    assert handoff_resolution["tool_arg_user_id_matches_trusted"] is False
    mismatch = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "tool-arg user_id mismatch" in r.getMessage()
    ]
    assert mismatch, "Expected mismatch WARNING on tool-arg vs bound user."


def test_tool_arg_user_id_matches_trusted_source_no_warning(monkeypatch, caplog):
    """If the LLM supplies the same user_id that the trusted source reports,
    no mismatch WARNING should fire — ``tool_arg_user_id_matches_trusted``
    is True and we use the trusted source silently."""
    import logging

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

        def execute_async(self, task: str, task_id: str | None = None, **_kwargs):
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime({}, user_id="authenticated_user")

    with caplog.at_level(logging.WARNING, logger=switch_module.logger.name):
        response = switch_module.switch_to_builder.func(
            runtime=runtime,
            task="Build.",
            task_type="document",
            user_id="authenticated_user",  # Same as trusted source.
            tool_call_id="tc-builder-tool-arg-match",
        )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    assert handoff_resolution["user_id_source"] == "runtime.config.configurable.user_id"
    assert handoff_resolution["tool_arg_user_id_matches_trusted"] is True
    mismatch = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "tool-arg user_id mismatch" in r.getMessage()
    ]
    assert not mismatch, (
        f"Did not expect a mismatch WARNING when tool arg matches trusted. "
        f"Got: {[r.getMessage() for r in caplog.records]}"
    )


def test_tool_arg_user_id_used_as_last_resort_fallback_with_warning(monkeypatch, caplog):
    """PR-B / security hardening: when every trusted source is empty, the LLM-
    supplied ``user_id`` tool arg is used as the last-resort fallback (strictly
    better than ``default_user``), but a WARNING is logged so ops can detect
    that gateway identity propagation AND the closure binding both failed."""
    import logging

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

        def execute_async(self, task: str, task_id: str | None = None, owner_id: str | None = None, description: str | None = None):
            captured["owner_id"] = owner_id
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: captured.setdefault("builder_agent", {"user_id": user_id, "model_name": model_name}),
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    # No trusted source: no runtime.config.user_id, no context.user_id, no
    # state.user_id, no bound closure (using unbound ``switch_to_builder``).
    runtime = _make_runtime({}, user_id=None)

    with caplog.at_level(logging.WARNING, logger=switch_module.logger.name):
        response = switch_module.switch_to_builder.func(
            runtime=runtime,
            task="Build with only a tool-arg user_id (all trusted sources empty).",
            task_type="document",
            user_id="llm_supplied_user",
            tool_call_id="tc-builder-tool-arg-last-resort",
        )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    # Fallback uses the LLM-supplied value (better than default_user) but
    # labels the source clearly and flags it.
    assert captured["builder_agent"]["user_id"] == "llm_supplied_user"
    assert captured["owner_id"] == "llm_supplied_user"
    assert handoff_resolution["user_id_source"] == "tool_arg_fallback"
    assert handoff_resolution["tool_arg_user_id_present"] is True
    # No trusted source existed — so there's nothing to match against.
    assert handoff_resolution["tool_arg_user_id_matches_trusted"] is None
    fallback_warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING
        and "falling back to LLM-supplied tool arg" in r.getMessage()
    ]
    assert fallback_warnings, (
        f"Expected a WARNING on tool-arg fallback. "
        f"Got: {[r.getMessage() for r in caplog.records]}"
    )


def test_switch_to_builder_default_user_fallback_emits_warning(monkeypatch, caplog):
    """PR-B: when no source supplies a user_id, the resolver MUST emit a
    WARNING log. ``default_user`` is a hard failure signal in production; it
    means tool arg, runtime config, runtime context, state, and bound user
    all failed to provide an authenticated user."""
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")
    import logging

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

        def execute_async(self, task: str, task_id: str | None = None, **_kwargs):
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: (lambda _event: None))

    runtime = _make_runtime({}, user_id=None)

    with caplog.at_level(logging.WARNING, logger=switch_module.logger.name):
        response = switch_module.switch_to_builder.func(
            runtime=runtime,
            task="Build with no user_id anywhere.",
            task_type="document",
            tool_call_id="tc-builder-default-warning",
        )
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    assert handoff_resolution["user_id_source"] == "default_user"
    assert handoff_resolution["tool_arg_user_id_present"] is False
    # A WARNING must be emitted — hard failure signal for ops.
    matching = [r for r in caplog.records if r.levelno == logging.WARNING and "default_user" in r.getMessage()]
    assert matching, (
        f"Expected a WARNING log when user_id falls back to 'default_user'. "
        f"Got: {[r.getMessage() for r in caplog.records]}"
    )


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
    payload = _payload_from_builder_response(response)

    delegation_context = payload["delegation_context"]
    assert delegation_context["companion_artifact"]["tone_estimate"] == 3.5
    assert delegation_context["companion_artifact"]["active_tone_band"] == "enthusiasm"
    handoff_resolution = payload["handoff_resolution"]
    assert handoff_resolution["artifact_source"] == "latest_emit_artifact_tool_call"
    assert handoff_resolution["latest_emit_artifact_present"] is True
    assert handoff_resolution["current_artifact_present"] is True


def test_switch_to_builder_enables_web_research_for_research_task(monkeypatch):
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

    runtime = _make_runtime({"user_id": "user_123"})
    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Research the latest AI voice companion pricing trends and compare current competitors. Use https://example.com/seed as a seed source.",
        task_type="research",
        tool_call_id="tc-builder-research",
    )
    payload = _payload_from_builder_response(response)
    delegation_context = payload["delegation_context"]

    assert delegation_context["allow_web_research"] is True
    assert delegation_context["search_mode"] == "autonomous"
    assert delegation_context["explicit_user_urls"] == ["https://example.com/seed"]
    assert delegation_context["builder_web_budget"]["search_limit"] == 5
    assert delegation_context["builder_web_budget"]["fetch_limit"] == 8

def test_switch_to_builder_ignores_empty_emit_artifact_payload(monkeypatch):
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

    runtime = _make_runtime(
        {
            "user_id": "user_123",
            "current_artifact": {"tone_estimate": 2.4, "active_tone_band": "anger_antagonism"},
            "messages": [
                AIMessage(
                    content="handoff with malformed emit payload",
                    tool_calls=[{"id": "tool-emit-artifact-empty", "name": "emit_artifact", "args": {}}],
                )
            ],
        }
    )

    response = switch_module.switch_to_builder.func(
        runtime=runtime,
        task="Build from fallback artifact context.",
        task_type="document",
        tool_call_id="tc-builder-empty-emit-artifact",
    )
    payload = _payload_from_builder_response(response)

    delegation_context = payload["delegation_context"]
    assert delegation_context["companion_artifact"]["tone_estimate"] == 2.4
    assert delegation_context["companion_artifact"]["active_tone_band"] == "anger_antagonism"
    handoff_resolution = payload["handoff_resolution"]
    assert handoff_resolution["artifact_source"] == "current_artifact_state"
    assert handoff_resolution["latest_emit_artifact_present"] is False
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
    payload = _payload_from_builder_response(response)
    handoff_resolution = payload["handoff_resolution"]

    assert handoff_resolution["user_id_source"] == "default_user"
    assert handoff_resolution["artifact_source"] == "default_empty"
    assert handoff_resolution["tool_arg_user_id_present"] is False
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


# ---------------------------------------------------------------------------
# Memory fix: <previous_builder_task> anchor block
#
# Symptom this guards: in the Telegram session at thread 9c1e24ef, after the
# builder finished and the user asked "is it ready?", Sophia answered without
# referencing the original document topic. Root cause: the original user
# message gets summarized away once token thresholds trip, and the artifact
# synthesis block only describes WHAT WAS BUILT — not WHAT WAS ASKED.
#
# These tests lock the fix: BuilderSessionMiddleware injects the original
# task brief from delegation_context.task into the system prompt for every
# turn while the task is alive (running OR completed OR failed OR
# synthesized), so the anchor survives summarization.
# ---------------------------------------------------------------------------


def _builder_session_state_with_task_brief(task_brief: str, status: str) -> dict:
    return {
        "messages": [],
        "system_prompt_blocks": [],
        "active_tone_band": "engagement",
        "builder_task": {
            "task_id": "task-anchor",
            "task_type": "document",
            "status": status,
            "trace_id": "trace-anchor",
        },
        "delegation_context": {"task": task_brief, "task_type": "document"},
    }


def test_builder_session_injects_task_brief_after_completion():
    """When the builder is completed, the original brief must be in the prompt.

    Otherwise Sophia answers "is it ready?" with a generic acknowledgement
    instead of naming the topic the user originally asked about.
    """
    task_brief = "Create a one-page document about LLM time-series solutions."
    state = _builder_session_state_with_task_brief(task_brief, status="completed")
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    middleware = BuilderSessionMiddleware()
    update = middleware.before_agent(state, runtime)

    assert update is not None, "expected a state update including the brief block"
    blocks = update.get("system_prompt_blocks", [])
    brief_blocks = [b for b in blocks if "<previous_builder_task>" in b]
    assert brief_blocks, "expected <previous_builder_task> block to be appended"
    assert task_brief in brief_blocks[0], "task brief must appear verbatim in the block"
    assert "Status: completed" in brief_blocks[0], "block must include the lifecycle status"


def test_builder_session_injects_task_brief_during_running():
    """The anchor must be present on intermediate 'still working' turns too.

    If the user pings during a 90-second build ("how's it going?"), Sophia
    must still know what topic she's working on — otherwise the in-progress
    block alone leaves her with no anchor.
    """
    task_brief = "Draft a memo summarising the Q2 product strategy review."
    state = _builder_session_state_with_task_brief(task_brief, status="running")
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    # Stub the background task lookup so the running branch executes without
    # touching real subagent infrastructure.
    class _FakeStatus:
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"
        TIMED_OUT = "timed_out"
        PENDING = "pending"

    running_result = SimpleNamespace(
        task_id="task-anchor",
        trace_id="trace-anchor",
        status=_FakeStatus.RUNNING,
        started_at=datetime.now(),
        completed_at=None,
        result=None,
        error=None,
        ai_messages=[],
        final_state=None,
    )

    import deerflow.agents.sophia_agent.middlewares.builder_session as builder_session_module
    original_status = builder_session_module.SubagentStatus
    original_get = builder_session_module.get_background_task_result
    builder_session_module.SubagentStatus = _FakeStatus
    builder_session_module.get_background_task_result = lambda _tid: running_result
    try:
        middleware = BuilderSessionMiddleware()
        update = middleware.before_agent(state, runtime)
    finally:
        builder_session_module.SubagentStatus = original_status
        builder_session_module.get_background_task_result = original_get

    assert update is not None
    blocks = update.get("system_prompt_blocks", [])
    brief_blocks = [b for b in blocks if "<previous_builder_task>" in b]
    assert brief_blocks, "running turns must also carry the task brief anchor"
    assert task_brief in brief_blocks[0]
    assert "Status: running" in brief_blocks[0]
    # The existing in-progress block must still be there too.
    assert any("<builder_task_status>" in b for b in blocks)


def test_builder_session_injects_task_brief_after_failure():
    """On failure, the brief must be present so Sophia can describe the retry intelligently.

    The failure card UX prompts the user "Sorry it seems like the task didn't
    complete. Do you want me to try again?" — when the user replies "yes",
    Sophia needs the original brief in the prompt to re-issue the same task.
    """
    task_brief = "Build a 5-slide investor deck for the Series A round."
    state = _builder_session_state_with_task_brief(task_brief, status="failed")
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    middleware = BuilderSessionMiddleware()
    update = middleware.before_agent(state, runtime)

    assert update is not None
    blocks = update.get("system_prompt_blocks", [])
    brief_blocks = [b for b in blocks if "<previous_builder_task>" in b]
    assert brief_blocks, "failed turns must carry the task brief for retry coherence"
    assert task_brief in brief_blocks[0]


def test_builder_session_skips_brief_when_no_active_task():
    """No builder task ever launched → no anchor block (don't pollute the prompt)."""
    state = {
        "messages": [],
        "system_prompt_blocks": [],
    }
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    middleware = BuilderSessionMiddleware()
    update = middleware.before_agent(state, runtime)

    if update is None:
        return  # No state change at all — fine.
    blocks = update.get("system_prompt_blocks", [])
    assert not any("<previous_builder_task>" in b for b in blocks)


def test_builder_session_skips_brief_when_delegation_context_missing():
    """Builder task exists but delegation_context.task is missing → no block.

    Defensive: if some upstream code cleared delegation_context, we must not
    inject an empty / malformed anchor block.
    """
    state = {
        "messages": [],
        "system_prompt_blocks": [],
        "builder_task": {"task_id": "task-x", "status": "completed"},
        # delegation_context is intentionally absent
    }
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    middleware = BuilderSessionMiddleware()
    update = middleware.before_agent(state, runtime) or {}
    blocks = update.get("system_prompt_blocks", [])
    assert not any("<previous_builder_task>" in b for b in blocks)


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
    # agent.py now constructs summarization via the _create_summarization_middleware
    # helper (which lazily imports SophiaSummarizationMiddleware). Patch that
    # helper directly — this is the public seam exposed by the refactor.
    # FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware" ensures
    # the parity assertion below still matches type(mw).__name__.
    monkeypatch.setattr(
        companion_module,
        "_create_summarization_middleware",
        lambda: FakeSummarizationMiddleware(),
    )
    monkeypatch.setattr(companion_module, "make_retrieve_memories_tool", lambda user_id: {"tool": user_id})
    # `load_sophia_web_tools()` reads the global app_config; the test fixture
    # doesn't seed it, so stub the loader to return an empty list. Native web
    # tools are exercised in dedicated tests (`test_sophia_web_tools_*`).
    monkeypatch.setattr(companion_module, "load_sophia_web_tools", lambda: [])

    def _capture_companion(**kwargs):
        captured_companion["middleware"] = kwargs["middleware"]
        return DummyAgent()

    monkeypatch.setattr(companion_module, "create_agent", _capture_companion)
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    companion_types = [type(mw).__name__ for mw in captured_companion["middleware"]]
    assert "MessageCoercionMiddleware" in companion_types
    assert companion_types.index("MessageCoercionMiddleware") < companion_types.index("CrisisCheckMiddleware")
    assert "BuilderSessionMiddleware" in companion_types
    assert "SummarizationMiddleware" in companion_types

    # B2 — DanglingToolCallMiddleware MUST sit AFTER PromptAssemblyMiddleware
    # and BEFORE AnthropicPromptCachingMiddleware in the companion chain so
    # the cache keys off the patched message list. Lock the position.
    assert "DanglingToolCallMiddleware" in companion_types
    assert "PromptAssemblyMiddleware" in companion_types
    assert "AnthropicPromptCachingMiddleware" in companion_types
    assert (
        companion_types.index("PromptAssemblyMiddleware")
        < companion_types.index("DanglingToolCallMiddleware")
        < companion_types.index("AnthropicPromptCachingMiddleware")
    )

    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-4-6")]),
    )

    def _capture_builder(**kwargs):
        captured_builder["middleware"] = kwargs["middleware"]
        captured_builder["tools"] = kwargs["tools"]
        return DummyAgent()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)
    builder_module._create_builder_agent(user_id="user_123")

    builder_types = [type(mw).__name__ for mw in captured_builder["middleware"]]
    builder_tool_names = [getattr(tool, "name", None) for tool in captured_builder["tools"]]
    assert "SandboxMiddleware" in builder_types
    assert "ToolErrorHandlingMiddleware" in builder_types
    assert "TodoMiddleware" in builder_types
    assert "BuilderResearchPolicyMiddleware" in builder_types
    assert "builder_web_search" in builder_tool_names
    assert "builder_web_fetch" in builder_tool_names
    # B2 — DanglingToolCallMiddleware MUST sit AFTER PromptAssemblyMiddleware
    # in the builder chain too. The builder doesn't currently use Anthropic
    # prompt caching, so we only assert the lower bound.
    assert "DanglingToolCallMiddleware" in builder_types
    assert "PromptAssemblyMiddleware" in builder_types
    assert (
        builder_types.index("PromptAssemblyMiddleware")
        < builder_types.index("DanglingToolCallMiddleware")
    )


def test_builder_agent_anthropic_timeout_and_retries(monkeypatch) -> None:
    """PR-F (Phase 2.3): builder agent uses 120s timeout and 1 retry.

    The builder generates large documents (5k+ tokens) which can take 45-90s.
    A 120s timeout gives headroom without letting a stalled connection hang
    indefinitely. 1 retry recovers from transient blips without burning
    extra budget when the model is genuinely struggling.
    """
    import deerflow.agents.sophia_agent.builder_agent as builder_module

    captured: dict[str, object] = {}

    def _capture_chat_anthropic(**kwargs):
        captured["kwargs"] = kwargs
        return MagicMock()

    monkeypatch.setattr(builder_module, "ChatAnthropic", _capture_chat_anthropic)
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-4-6")]),
    )
    monkeypatch.setattr(builder_module, "create_agent", lambda **kwargs: MagicMock())

    builder_module._create_builder_agent(user_id="user_123")

    assert captured["kwargs"]["timeout"] == 120.0
    assert captured["kwargs"]["max_retries"] == 1
    assert captured["kwargs"]["streaming"] is True
    assert captured["kwargs"]["max_tokens"] == 8192


# ---------------------------------------------------------------------------
# B4 — deepagents v0.5 AsyncSubAgentMiddleware gating + coexistence
#
# The middleware MUST be opt-in via `configurable.async_builder=True` so the
# default behaviour (sync `switch_to_builder` Command path with PR #78's
# JSON-string fallback) is byte-identical to today. When opted in, the 5
# async tools (`start_async_task` / `check_async_task` / `update_async_task`
# / `cancel_async_task` / `list_async_tasks`) live ALONGSIDE
# `switch_to_builder` — both coexist, no replacement.
# ---------------------------------------------------------------------------


def _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured):
    """Apply the patches the parity test relies on, capturing
    `middleware` + `tools` from `create_agent` instead of building a real
    agent. Reused across the B4 gate tests below.
    """

    class _DummyAgent:
        recursion_limit = 0

    class _FakeSummarizationMiddleware:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    _FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware"

    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        companion_module,
        "_create_summarization_middleware",
        lambda: _FakeSummarizationMiddleware(),
    )
    monkeypatch.setattr(
        companion_module, "make_retrieve_memories_tool", lambda user_id: {"name": "retrieve_memories"}
    )
    # If the web-tools loader is wired in (PR B1 may be merged first), stub
    # it so the chain stays deterministic. `raising=False` keeps this test
    # working both before and after B1 lands.
    monkeypatch.setattr(
        companion_module, "load_sophia_web_tools", lambda: [], raising=False
    )

    def _capture(**kwargs):
        captured["middleware"] = kwargs["middleware"]
        captured["tools"] = kwargs["tools"]
        return _DummyAgent()

    monkeypatch.setattr(companion_module, "create_agent", _capture)


def test_async_builder_default_off_does_not_attach_async_middleware(monkeypatch):
    """When `configurable.async_builder` is not supplied, the
    AsyncSubAgentMiddleware MUST NOT be in the chain and the async tool
    pack MUST NOT appear in the tools list. The companion behaves
    byte-identically to today's `switch_to_builder` sync handoff path.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]

    assert "AsyncSubAgentMiddleware" not in middleware_types, (
        "AsyncSubAgentMiddleware must be opt-in via configurable.async_builder=True; "
        "default chain must be byte-identical to the pre-B4 behaviour."
    )
    for async_tool_name in (
        "start_async_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    ):
        assert async_tool_name not in tool_names, (
            f"Async tool {async_tool_name!r} must not appear when "
            "configurable.async_builder is unset."
        )
    # The sync switch_to_builder handoff path stays intact in the default chain.
    assert "switch_to_builder" in tool_names


def test_async_builder_flag_attaches_async_middleware_after_builder_session(monkeypatch):
    """When `configurable.async_builder=True`, AsyncSubAgentMiddleware is
    appended to the chain AFTER `BuilderSessionMiddleware` and
    `BuilderCommandMiddleware` (so they still see every turn). The 5 async
    tools are added on top of `switch_to_builder` — both coexist.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent(
        {"configurable": {"user_id": "user_123", "async_builder": True}}
    )

    middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]

    assert "AsyncSubAgentMiddleware" in middleware_types, (
        "AsyncSubAgentMiddleware must be in the chain when "
        "configurable.async_builder=True."
    )
    # Position contract: AFTER BuilderSessionMiddleware AND
    # BuilderCommandMiddleware so the existing builder lifecycle still
    # observes each turn.
    assert "BuilderSessionMiddleware" in middleware_types
    assert "BuilderCommandMiddleware" in middleware_types
    assert (
        middleware_types.index("BuilderSessionMiddleware")
        < middleware_types.index("AsyncSubAgentMiddleware")
    ), "AsyncSubAgentMiddleware must sit AFTER BuilderSessionMiddleware"
    assert (
        middleware_types.index("BuilderCommandMiddleware")
        < middleware_types.index("AsyncSubAgentMiddleware")
    ), "AsyncSubAgentMiddleware must sit AFTER BuilderCommandMiddleware"

    # Coexistence: `switch_to_builder` stays in the agent-level tools list.
    assert "switch_to_builder" in tool_names

    # The 5 async tools are NOT injected into `create_agent(tools=...)`; the
    # AsyncSubAgentMiddleware exposes them via its own `.tools` attribute and
    # `create_agent` discovers them by inspecting the middleware. Verify they
    # are present on the middleware instance.
    async_middleware = next(
        mw for mw in captured["middleware"] if type(mw).__name__ == "AsyncSubAgentMiddleware"
    )
    middleware_tool_names = {
        getattr(tool, "name", None) for tool in getattr(async_middleware, "tools", [])
    }
    for async_tool_name in (
        "start_async_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    ):
        assert async_tool_name in middleware_tool_names, (
            f"Async tool {async_tool_name!r} missing from "
            "AsyncSubAgentMiddleware.tools — coexistence with switch_to_builder broken."
        )


def test_async_builder_flag_falsy_values_keep_middleware_off(monkeypatch):
    """`bool(cfg.get("async_builder", False))` must reject falsy non-True
    values — empty string, 0, None — to avoid accidentally enabling the
    async pattern via a misconfigured request."""
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")

    for falsy_value in (False, None, 0, "", "false"):
        captured: dict = {}
        _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)
        companion_module.make_sophia_agent(
            {"configurable": {"user_id": "user_123", "async_builder": falsy_value}}
        )
        middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
        # Non-empty strings like "false" are truthy in Python — that's a real
        # caller mistake we want to surface, not silently mask. So we test
        # only the values that `bool(...)` reads as False.
        if not falsy_value:
            assert "AsyncSubAgentMiddleware" not in middleware_types, (
                f"async_builder={falsy_value!r} should keep the middleware off; "
                "check the bool(cfg.get(...)) gate in agent.py."
            )
