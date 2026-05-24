from __future__ import annotations

from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.sophia_agent.middlewares.builder_command import BuilderCommandMiddleware


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


def test_explicit_document_command_synthesizes_start_builder_task_call():
    """PR-B: BuilderCommandMiddleware synthesizes a ``start_builder_task``
    call (formerly ``switch_to_builder``). Wrapper end-to-end coverage lives
    in ``test_start_builder_task.py``; this test is scoped to the middleware
    contract — synthesized tool name + arg keys + brief content.
    """
    middleware = BuilderCommandMiddleware()

    user_message = HumanMessage(
        content="Sophia create a dummy document of one page about the dangers of war."
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
    assert tool_call["name"] == "start_builder_task"
    assert tool_call["args"]["task_type"] == "document"
    assert "dangers of war" in tool_call["args"]["description"]
    assert "emit_builder_artifact" in tool_call["args"]["description"]
    assert "/mnt/user-data/outputs/the-dangers-of-war.md" in tool_call["args"]["description"]


def test_document_command_middleware_leaves_normal_chat_to_model():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(content="I want to talk about the dangers of war.")
    request = _make_request([user_message])
    expected = AIMessage(content="Normal companion response")

    result = middleware.wrap_model_call(request, lambda _request: expected)

    assert result is expected


def test_reflection_artifact_request_does_not_fast_path_to_builder():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(content="Create a short reflection artifact.")
    request = _make_request([user_message])
    expected = AIMessage(content="Companion artifact path")

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
    assert tool_call["name"] == "start_builder_task"
    assert tool_call["args"]["task_type"] == "document"
    assert "Create a document about the dangers of war" in tool_call["args"]["description"]