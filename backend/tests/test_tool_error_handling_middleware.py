from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphInterrupt
from pydantic import BaseModel, ValidationError

from deerflow.agents.middlewares.tool_error_handling_middleware import ToolErrorHandlingMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware


def _request(name: str = "web_search", tool_call_id: str | None = "tc-1"):
    tool_call = {"name": name}
    if tool_call_id is not None:
        tool_call["id"] = tool_call_id
    return SimpleNamespace(tool_call=tool_call)


def test_wrap_tool_call_passthrough_on_success():
    middleware = ToolErrorHandlingMiddleware()
    req = _request()
    expected = ToolMessage(content="ok", tool_call_id="tc-1", name="web_search")

    result = middleware.wrap_tool_call(req, lambda _req: expected)

    assert result is expected


def test_wrap_tool_call_returns_error_tool_message_on_exception():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="web_search", tool_call_id="tc-42")

    def _boom(_req):
        raise RuntimeError("network down")

    result = middleware.wrap_tool_call(req, _boom)

    assert isinstance(result, ToolMessage)
    assert result.tool_call_id == "tc-42"
    assert result.name == "web_search"
    assert result.status == "error"
    assert "Tool 'web_search' failed" in result.text
    assert "network down" in result.text


def test_prepare_tool_error_is_structured_and_does_not_expose_raw_detail():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="prepare_deck_build", tool_call_id="tc-deck")

    def _boom(_req):
        raise TypeError("sensitive runtime detail")

    result = middleware.wrap_tool_call(req, _boom)

    assert result.status == "error"
    assert "sensitive runtime detail" not in result.text
    assert result.additional_kwargs["tool_error"] == {
        "error_class": "TypeError",
        "retryable": False,
        "stage": "tool_execution",
    }


def test_prepare_validation_error_surfaces_bounded_indexed_paths_for_repair():
    class SlideComposition(BaseModel):
        headline_intent: str

    class CreativePlan(BaseModel):
        slide_compositions: list[SlideComposition]

    class DeckArguments(BaseModel):
        creative_plan: CreativePlan

    try:
        DeckArguments.model_validate({"creative_plan": {"slide_compositions": [{"secret": "do-not-expose"}]}})
    except ValidationError as exc:
        validation_error = exc
    else:  # pragma: no cover - the fixture must remain invalid.
        raise AssertionError("expected validation failure")

    middleware = ToolErrorHandlingMiddleware()

    def _invalid(_req):
        raise validation_error

    result = middleware.wrap_tool_call(
        _request(name="prepare_deck_build", tool_call_id="tc-schema"),
        _invalid,
    )

    summary = result.additional_kwargs["tool_error"]["validation_summary"]
    assert "creative_plan.slide_compositions[0].headline_intent" in summary
    assert "Field required" in summary
    assert "do-not-expose" not in summary
    assert len(summary) <= 500

    command = BuilderArtifactMiddleware()._prepare_schema_error_command(
        SimpleNamespace(
            state={"builder_pptx_diagnostics": {"prepare_emitted_call_count": 1}},
            runtime=None,
        ),
        result,
    )
    repair_message = command.update["builder_deck_prepare_repair_message"]
    assert "creative_plan.slide_compositions[0].headline_intent" in repair_message
    assert "do-not-expose" not in repair_message


def test_wrap_tool_call_uses_fallback_tool_call_id_when_missing():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="mcp_tool", tool_call_id=None)

    def _boom(_req):
        raise ValueError("bad request")

    result = middleware.wrap_tool_call(req, _boom)

    assert isinstance(result, ToolMessage)
    assert result.tool_call_id == "missing_tool_call_id"
    assert result.name == "mcp_tool"
    assert result.status == "error"


def test_wrap_tool_call_reraises_graph_interrupt():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="ask_clarification", tool_call_id="tc-int")

    def _interrupt(_req):
        raise GraphInterrupt(())

    with pytest.raises(GraphInterrupt):
        middleware.wrap_tool_call(req, _interrupt)


@pytest.mark.anyio
async def test_awrap_tool_call_returns_error_tool_message_on_exception():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="mcp_tool", tool_call_id="tc-async")

    async def _boom(_req):
        raise TimeoutError("request timed out")

    result = await middleware.awrap_tool_call(req, _boom)

    assert isinstance(result, ToolMessage)
    assert result.tool_call_id == "tc-async"
    assert result.name == "mcp_tool"
    assert result.status == "error"
    assert "request timed out" in result.text


@pytest.mark.anyio
async def test_awrap_tool_call_reraises_graph_interrupt():
    middleware = ToolErrorHandlingMiddleware()
    req = _request(name="ask_clarification", tool_call_id="tc-int-async")

    async def _interrupt(_req):
        raise GraphInterrupt(())

    with pytest.raises(GraphInterrupt):
        await middleware.awrap_tool_call(req, _interrupt)
