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
