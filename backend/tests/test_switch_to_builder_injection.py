"""Real-wrapper integration test for `switch_to_builder.tool_call_id` injection.

Existing builder tests in ``test_sophia_builder_flow.py`` call
``switch_to_builder.func(tool_call_id=...)`` which BYPASSES the
``@tool`` decorator and the ``InjectedToolCallId`` resolution path.
That blind spot let PR-H ship a fallback (``tool_call_id or task_id``)
that crashed in production: when the LLM's real ``toolu_…`` id failed
to flow through, the fallback substituted an internal task UUID that
LangGraph's ``ToolNode._validate_tool_command`` rejects.

This test exercises the *decorated* tool through ``tool.invoke({...})``
with a synthesised ToolCall dict and asserts the resulting
``Command.update["messages"][0].tool_call_id`` matches the LLM-supplied
id verbatim — never an internal UUID prefix.
"""

from __future__ import annotations

import importlib

from langchain_core.messages import ToolMessage
from langgraph.types import Command

# Touch the agents package first so the circular import between
# deerflow.agents.sophia_agent.agent and deerflow.sophia.tools.switch_to_builder
# resolves cleanly before tests start collecting symbols.
import deerflow.agents.sophia_agent  # noqa: F401  pylint: disable=unused-import
from deerflow.subagents.config import SubagentConfig

_FAKE_TOOL_CALL_ID = "toolu_01AbCdEfGhIjKlMnOpQrStUv"


def _switch_module():
    return importlib.import_module("deerflow.sophia.tools.switch_to_builder")


def _install_subagent_stubs(monkeypatch) -> None:
    switch_module = _switch_module()
    captured_kwargs: dict = {}

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
            captured_kwargs["init"] = kwargs

        def execute_async(self, task: str, task_id: str | None = None, **kwargs):
            captured_kwargs["task"] = task
            captured_kwargs["task_id"] = task_id
            captured_kwargs.update(kwargs)
            return task_id or "generated-task-id"

    monkeypatch.setattr(switch_module, "SubagentExecutor", DummyExecutor)
    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: lambda _evt: None)


def _invoke_tool_through_decorator(tool, *, tool_call_id: str) -> Command | str:
    """Mirror what LangGraph's ToolNode does: invoke with the full ToolCall dict."""
    return tool.invoke(
        {
            "name": tool.name,
            "args": {
                "task": "Build a simple document about prompt engineering basics.",
                "task_type": "document",
            },
            "id": tool_call_id,
            "type": "tool_call",
        }
    )


def _extract_tool_message_from_response(response) -> ToolMessage:
    """Pull the ToolMessage out of either path:

    - JSON-string fallback: ``tool.invoke({"id": ..., "type": "tool_call"})``
      auto-wraps the string return in a ``ToolMessage`` with that id.
    - ``Command`` return: messages[0] is the ToolMessage we built.
    """
    if isinstance(response, Command):
        messages = response.update.get("messages") or []
        assert messages, "Command.update.messages must be non-empty"
        assert isinstance(messages[0], ToolMessage)
        return messages[0]
    if isinstance(response, ToolMessage):
        return response
    raise AssertionError(
        f"Unexpected response type {type(response).__name__}: {response!r}"
    )


def test_switch_to_builder_decorated_tool_threads_llm_tool_call_id(monkeypatch):
    """The decorated `switch_to_builder` MUST emit a ToolMessage whose
    `tool_call_id` is the LLM-supplied id (e.g. `toolu_…`) — never a
    fresh uuid4 prefix or any other synthesised value.

    Regression contract: this is the test that would have caught PR-H's
    broken ``tool_call_id or task_id`` fallback. It does not care WHICH
    return path is taken (Command or JSON-string) — both are valid as
    long as the resulting ToolMessage echoes the LLM's exact id.
    """
    _install_subagent_stubs(monkeypatch)
    switch_module = _switch_module()

    response = _invoke_tool_through_decorator(
        switch_module.switch_to_builder,
        tool_call_id=_FAKE_TOOL_CALL_ID,
    )

    tool_message = _extract_tool_message_from_response(response)
    assert tool_message.tool_call_id == _FAKE_TOOL_CALL_ID, (
        f"ToolMessage tool_call_id must equal the LLM's id "
        f"({_FAKE_TOOL_CALL_ID!r}); got {tool_message.tool_call_id!r}"
    )
    assert tool_message.name == "switch_to_builder"


def test_make_switch_to_builder_tool_decorated_threads_llm_tool_call_id(monkeypatch):
    """Same contract for the closure-bound variant produced by
    ``make_switch_to_builder_tool``."""
    _install_subagent_stubs(monkeypatch)
    switch_module = _switch_module()

    bound = switch_module.make_switch_to_builder_tool("bound_user")
    response = _invoke_tool_through_decorator(bound, tool_call_id=_FAKE_TOOL_CALL_ID)

    tool_message = _extract_tool_message_from_response(response)
    assert tool_message.tool_call_id == _FAKE_TOOL_CALL_ID
    assert tool_message.name == "switch_to_builder"
