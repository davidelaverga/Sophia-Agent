from __future__ import annotations

import importlib
from enum import Enum
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_command import BuilderCommandMiddleware
from deerflow.subagents.config import SubagentConfig


class FakeSubagentStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"


def _make_request(messages: list, state: dict | None = None):
    request = MagicMock()
    request.messages = messages
    request.state = state or {"messages": messages}

    def _override(**kwargs):
        new_req = MagicMock()
        new_req.messages = kwargs.get("messages", messages)
        new_req.state = request.state
        return new_req

    request.override = _override
    return request


def _make_runtime() -> SimpleNamespace:
    return SimpleNamespace(
        state={
            "user_id": "builder-user",
            "current_artifact": {"tone_estimate": 2.7},
            "injected_memories": ["mem-1"],
            "sandbox": {"sandbox_id": "local"},
            "thread_data": {
                "workspace_path": "/tmp/workspace",
                "uploads_path": "/tmp/uploads",
                "outputs_path": "/tmp/outputs",
            },
        },
        context={"thread_id": "thread-direct-doc"},
        config={
            "configurable": {"user_id": "builder-user", "thread_id": "thread-direct-doc"},
            "metadata": {"model_name": "test-parent-model", "trace_id": "trace-direct-doc"},
        },
    )


def test_explicit_document_command_routes_through_builder_and_returns_artifact(monkeypatch):
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")
    middleware = BuilderCommandMiddleware()

    user_message = HumanMessage(content="Sophia create a dummy document of one page about the dangers of war.")
    request = _make_request([user_message])

    model_called = {"value": False}

    def _should_not_run_handler(_request):
        model_called["value"] = True
        return AIMessage(content="This should not run")

    direct_response = middleware.wrap_model_call(request, _should_not_run_handler)

    assert isinstance(direct_response, AIMessage)
    assert model_called["value"] is False
    assert len(direct_response.tool_calls) == 1

    tool_call = direct_response.tool_calls[0]
    assert tool_call["name"] == "switch_to_builder"
    assert tool_call["args"]["task_type"] == "document"
    assert "dangers of war" in tool_call["args"]["task"]
    assert "emit_builder_artifact" in tool_call["args"]["task"]
    assert "/mnt/user-data/outputs/the-dangers-of-war.md" in tool_call["args"]["task"]

    captured: dict = {}
    cleaned_task_ids: list[str] = []
    expected_result = {
        "artifact_path": "/mnt/user-data/outputs/the-dangers-of-war.md",
        "artifact_type": "document",
        "artifact_title": "One-Page Document: the dangers of war",
        "steps_completed": 3,
        "decisions_made": [
            "Used default audience and tone",
            "Created a single markdown deliverable",
        ],
        "companion_summary": "Created the requested one-page document about the dangers of war.",
        "companion_tone_hint": "Confident",
        "user_next_action": "Open or download the document and tell me what to revise next.",
        "confidence": 0.86,
    }

    class DummyExecutor:
        def __init__(self, **kwargs):
            captured["executor_kwargs"] = kwargs

        def execute_async(self, prompt, task_id=None, owner_id=None):
            captured["prompt"] = prompt
            captured["task_id"] = task_id
            captured["owner_id"] = owner_id
            return task_id

    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.builder_agent._create_builder_agent",
        lambda user_id, model_name=None: {"user_id": user_id, "model_name": model_name},
    )
    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr(switch_module, "SubagentStatus", FakeSubagentStatus)
    monkeypatch.setattr(
        switch_module,
        "get_subagent_config",
        lambda _: SubagentConfig(
            name="general-purpose",
            description="General helper",
            system_prompt="Base system prompt",
            max_turns=150,
            timeout_seconds=600,
        ),
    )
    monkeypatch.setattr(
        switch_module,
        "get_background_task_result",
        lambda _: SimpleNamespace(
            status=FakeSubagentStatus.COMPLETED,
            final_state={"builder_result": expected_result},
            ai_messages=[],
            result="done",
            error=None,
        ),
    )
    monkeypatch.setattr(switch_module, "cleanup_background_task", cleaned_task_ids.append)
    monkeypatch.setattr(switch_module.time, "sleep", lambda _: None)

    output = switch_module.switch_to_builder.func(
        task=tool_call["args"]["task"],
        task_type=tool_call["args"]["task_type"],
        runtime=_make_runtime(),
        tool_call_id=tool_call["id"],
    )

    assert isinstance(output, Command)
    assert output.update["builder_result"] == expected_result
    assert output.update["builder_task"]["status"] == "completed"
    assert output.update["builder_task"]["task_type"] == "document"
    tool_message = output.update["messages"][0]
    assert isinstance(tool_message, ToolMessage)
    assert tool_message.tool_call_id == tool_call["id"]
    assert "Builder completed successfully." in tool_message.content
    assert "One-Page Document: the dangers of war" in tool_message.content
    assert '"artifact_path": "/mnt/user-data/outputs/the-dangers-of-war.md"' in tool_message.content
    assert captured["prompt"] == tool_call["args"]["task"]
    assert captured["task_id"] == tool_call["id"]
    assert captured["owner_id"] == "builder-user"
    assert captured["executor_kwargs"]["thread_id"] == "thread-direct-doc"
    assert captured["executor_kwargs"]["parent_model"] == "test-parent-model"
    assert captured["executor_kwargs"]["config"].max_turns == 150
    assert captured["executor_kwargs"]["config"].timeout_seconds == 600
    assert captured["executor_kwargs"]["extra_configurable"]["delegation_context"]["task_type"] == "document"
    assert cleaned_task_ids == [tool_call["id"]]


def test_document_command_middleware_leaves_normal_chat_to_model():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(content="I want to talk about the dangers of war.")
    request = _make_request([user_message])
    expected = AIMessage(content="Normal companion response")

    result = middleware.wrap_model_call(request, lambda _request: expected)

    assert result is expected


def test_document_command_middleware_routes_after_conversational_preamble():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Actually, I need your help, Sofia. Create a document about the dangers of war."
    )
    request = _make_request([user_message])

    model_called = {"value": False}

    def _should_not_run_handler(_request):
        model_called["value"] = True
        return AIMessage(content="This should not run")

    direct_response = middleware.wrap_model_call(request, _should_not_run_handler)

    assert isinstance(direct_response, AIMessage)
    assert model_called["value"] is False
    assert len(direct_response.tool_calls) == 1

    tool_call = direct_response.tool_calls[0]
    assert tool_call["name"] == "switch_to_builder"
    assert tool_call["args"]["task_type"] == "document"
    assert "Create a document about the dangers of war" in tool_call["args"]["task"]