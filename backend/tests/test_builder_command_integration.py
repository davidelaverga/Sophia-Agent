from __future__ import annotations

from unittest.mock import MagicMock

import pytest
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


def test_presentation_command_with_page_number_prohibition_bypasses_document_fast_path():
    """An incidental ``page`` noun must not steal an explicit PPTX request."""
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content=(
            "Create and deliver one editable 5-slide PowerPoint about the PSI control loop. "
            "Use a distinct spatial composition on every slide. "
            "Do not add recurring chrome, page numbers, or footers. "
            "Deliver the editable .pptx only if all quality gates pass."
        )
    )
    request = _make_request([user_message])
    expected = AIMessage(content="Canonical presentation routing")
    model_called = {"value": False}

    def _model_handler(_request):
        model_called["value"] = True
        return expected

    result = middleware.wrap_model_call(request, _model_handler)

    assert result is expected
    assert model_called["value"] is True


def test_explicit_markdown_document_command_keeps_direct_fast_path():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Create a one-page Markdown document about reliable agent control loops."
    )
    request = _make_request([user_message])

    direct_response = middleware.wrap_model_call(
        request,
        lambda _request: AIMessage(content="This should not run"),
    )

    assert isinstance(direct_response, AIMessage)
    tool_call = direct_response.tool_calls[0]
    assert tool_call["name"] == "start_builder_task"
    assert tool_call["args"]["task_type"] == "document"
    assert tool_call["args"]["description"].startswith("Create exactly one markdown file")


def test_topical_websites_do_not_bypass_markdown_document_fast_path():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Create a one-page document about websites for local museums."
    )
    request = _make_request([user_message])

    direct_response = middleware.wrap_model_call(
        request,
        lambda _request: AIMessage(content="This should not run"),
    )

    assert isinstance(direct_response, AIMessage)
    tool_call = direct_response.tool_calls[0]
    assert tool_call["args"]["task_type"] == "document"
    assert "websites for local museums" in tool_call["args"]["description"]
    assert tool_call["args"]["description"].startswith("Create exactly one markdown file")


def test_topical_excel_spreadsheets_do_not_bypass_markdown_document_fast_path():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Create a one-page document on Excel spreadsheets for small businesses."
    )
    request = _make_request([user_message])

    direct_response = middleware.wrap_model_call(
        request,
        lambda _request: AIMessage(content="This should not run"),
    )

    assert isinstance(direct_response, AIMessage)
    tool_call = direct_response.tool_calls[0]
    assert tool_call["args"]["task_type"] == "document"
    assert "Excel spreadsheets for small businesses" in tool_call["args"]["description"]
    assert tool_call["args"]["description"].startswith("Create exactly one markdown file")


def test_generic_report_without_explicit_pdf_keeps_markdown_fast_path():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Create a one-page report about quarterly planning for a small nonprofit."
    )
    request = _make_request([user_message])

    direct_response = middleware.wrap_model_call(
        request,
        lambda _request: AIMessage(content="This should not run"),
    )

    assert isinstance(direct_response, AIMessage)
    tool_call = direct_response.tool_calls[0]
    assert tool_call["args"]["task_type"] == "document"
    assert "quarterly planning" in tool_call["args"]["description"]
    assert tool_call["args"]["description"].startswith("Create exactly one markdown file")


def test_report_with_explicit_pdf_bypasses_markdown_fast_path():
    middleware = BuilderCommandMiddleware()
    user_message = HumanMessage(
        content="Create a one-page report as PDF about quarterly planning."
    )
    request = _make_request([user_message])
    expected = AIMessage(content="Canonical PDF routing")

    result = middleware.wrap_model_call(request, lambda _request: expected)

    assert result is expected


@pytest.mark.parametrize(
    "request_text",
    [
        "Create a one-page document about Q2 planning and deliver it as a PDF.",
        "Create a one-page document about Q2 planning and deliver it as an editable PowerPoint.",
        "Create a one-page document about Q2 planning and deliver it as a final editable PDF.",
        "Create a one-page document about Q2 planning; then deliver a PowerPoint.",
        "Create a one-page document about Q2 planning. Export the result to deck.pptx.",
    ],
)
def test_trailing_non_markdown_delivery_clause_bypasses_fast_path(request_text):
    middleware = BuilderCommandMiddleware()
    request = _make_request([HumanMessage(content=request_text)])
    expected = AIMessage(content="Canonical trailing-format routing")

    result = middleware.wrap_model_call(request, lambda _request: expected)

    assert result is expected


@pytest.mark.parametrize(
    "request_text",
    [
        "Create a one-page document about how to deliver PowerPoint presentations.",
        "Create a one-page report using source.pdf about quarterly planning.",
        "Create a one-page report using the attached file named source.pdf about quarterly planning.",
        "Create a one-page report, not a PDF, about quarterly planning.",
        "Create a one-page report, not a PDF report, about quarterly planning.",
    ],
)
def test_topical_source_and_negated_format_mentions_keep_markdown_fast_path(request_text):
    middleware = BuilderCommandMiddleware()
    request = _make_request([HumanMessage(content=request_text)])

    direct_response = middleware.wrap_model_call(
        request,
        lambda _request: AIMessage(content="This should not run"),
    )

    assert isinstance(direct_response, AIMessage)
    assert direct_response.tool_calls[0]["args"]["task_type"] == "document"
    assert direct_response.tool_calls[0]["args"]["description"].startswith(
        "Create exactly one markdown file"
    )


def test_unrelated_negation_does_not_hide_explicit_pdf_target():
    middleware = BuilderCommandMiddleware()
    request = _make_request(
        [
            HumanMessage(
                content=(
                    "Do not include footers. Create a one-page PDF report about quarterly planning."
                )
            )
        ]
    )
    expected = AIMessage(content="Canonical PDF routing")

    result = middleware.wrap_model_call(request, lambda _request: expected)

    assert result is expected


# The exact message the web voice bridge sends (buildVoiceBuilderStartMessage
# in frontend/src/app/lib/voice-builder-actions.ts).
def _voice_build_request(brief: str, task_type: str | None = "research") -> str:
    lines = [
        "[Voice build request]",
        "I asked for this by voice and already answered any clarifying questions there.",
        "Start it now with start_builder_task using the brief below. Do not ask me further questions first.",
    ]
    if task_type is not None:
        lines.append(f"Task type: {task_type}")
    lines.append(f"Brief: {brief}")
    return "\n".join(lines)


def _route(content, state: dict | None = None, messages: list | None = None):
    middleware = BuilderCommandMiddleware()
    messages = messages if messages is not None else [HumanMessage(content=content)]
    called = {"model": False}
    expected = AIMessage(content="Model response")

    def _handler(_request):
        called["model"] = True
        return expected

    result = middleware.wrap_model_call(_make_request(messages, state), _handler)
    return result, called["model"], expected


def test_voice_build_request_routes_brief_to_start_builder_task():
    brief = "Research the EU AI Act and write me a short Markdown report.\nKeep it to one page; cite sources."
    result, model_called, _ = _route(_voice_build_request(brief))

    assert model_called is False
    assert isinstance(result, AIMessage) and len(result.tool_calls) == 1
    tool_call = result.tool_calls[0]
    assert tool_call["name"] == "start_builder_task"
    assert tool_call["id"].startswith("builder-direct-")
    assert tool_call["args"] == {"description": brief, "task_type": "research"}


@pytest.mark.anyio
async def test_voice_build_request_routes_on_the_async_path():
    middleware = BuilderCommandMiddleware()
    request = _make_request([HumanMessage(content=_voice_build_request("Build a pricing page.", "frontend"))])

    async def _handler(_request):
        raise AssertionError("model should not run")

    result = await middleware.awrap_model_call(request, _handler)

    assert result.tool_calls[0]["args"] == {"description": "Build a pricing page.", "task_type": "frontend"}


@pytest.mark.parametrize(
    "task_type,expected",
    [(None, "document"), ("report", "document"), ("Research", "research"), ("visual_report", "visual_report")],
)
def test_voice_build_request_task_type_is_always_canonical(task_type, expected):
    result, model_called, _ = _route(_voice_build_request("A brief.", task_type))

    assert model_called is False
    assert result.tool_calls[0]["args"]["task_type"] == expected


def test_voice_build_task_types_match_the_tool_contract():
    from deerflow.agents.sophia_agent.middlewares.builder_command import _VOICE_BUILD_TASK_TYPES
    from deerflow.sophia.tools.start_builder_task import make_start_builder_task_tool
    from deerflow.sophia.tools.update_async_task_wrapper import _CANONICAL_TASK_TYPES

    tool_enum = frozenset(make_start_builder_task_tool("owner").args["task_type"]["enum"])
    assert _VOICE_BUILD_TASK_TYPES == _CANONICAL_TASK_TYPES == tool_enum


@pytest.mark.parametrize(
    "content",
    [
        # Corrections stay with the model, which picks the update or edit tool.
        "[Voice build correction]\nI gave this correction by voice.\nBuild task: task-1\nCorrection: shorter.",
        # The header must open the message; quoting it is not a request.
        "What does this mean?\n" + _voice_build_request("A brief."),
        _voice_build_request(""),
        "[Voice build request]\nTask type: research\nNo brief here.",
        "[Voice build request]",
    ],
)
def test_malformed_or_other_voice_messages_stay_with_the_model(content):
    result, model_called, expected = _route(content)

    assert model_called is True
    assert result is expected


def test_voice_build_request_is_not_routed_again_after_the_tool_result():
    from langchain_core.messages import ToolMessage

    first, _, _ = _route(_voice_build_request("A brief."))
    tool_call = first.tool_calls[0]
    messages = [
        HumanMessage(content=_voice_build_request("A brief.")),
        first,
        ToolMessage(content="Builder run confirmed.", tool_call_id=tool_call["id"], name="start_builder_task"),
    ]

    result, model_called, expected = _route(None, messages=messages)

    assert model_called is True
    assert result is expected


def test_voice_build_request_is_not_routed_on_the_crisis_path():
    content = _voice_build_request("A brief.")
    messages = [HumanMessage(content=content)]
    result, model_called, expected = _route(None, state={"messages": messages, "skip_expensive": True}, messages=messages)

    assert model_called is True
    assert result is expected
