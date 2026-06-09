from unittest.mock import MagicMock

from langchain_core.messages import AIMessage

from deerflow.agents.middlewares.safety_finish_reason_middleware import SafetyFinishReasonMiddleware


def test_safety_finish_reason_strips_tool_calls() -> None:
    middleware = SafetyFinishReasonMiddleware()
    message = AIMessage(
        content="partial",
        tool_calls=[{"name": "write_file", "args": {"path": "x"}, "id": "call-1"}],
        response_metadata={"finish_reason": "content_filter"},
    )
    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}

    result = middleware.after_model({"messages": [message]}, runtime)

    assert result is not None
    rewritten = result["messages"][0]
    assert rewritten.tool_calls == []
    assert "safety signal" in rewritten.content
    assert rewritten.additional_kwargs["safety_termination"]["suppressed_tool_call_names"] == ["write_file"]

