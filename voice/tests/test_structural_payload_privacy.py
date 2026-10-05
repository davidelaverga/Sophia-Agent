"""Tool content must not be recoverable from structure-only voice traces."""

from unittest.mock import Mock

import pytest
import voice.realtime.gemini_langsmith_tracing as tracing


@pytest.mark.parametrize("value", [True, False])
def test_structural_payload_redacts_boolean_values_at_every_depth(value: bool) -> None:
    shape = {"kind": "boolean"}
    assert tracing._structural_payload(value) == shape
    nested = tracing._structural_payload({"attribute": [value, {"answer": value}]})
    items = nested["fields"]["attribute"]["item_shapes"]
    assert items[0] == shape
    assert items[1]["fields"]["answer"] == shape


@pytest.mark.parametrize("value", [True, False])
def test_recorder_redacts_boolean_tool_arguments_and_function_responses(
    monkeypatch: pytest.MonkeyPatch, value: bool
) -> None:
    monkeypatch.delenv(tracing.CONTENT_TRACING_ENV, raising=False)
    monkeypatch.setattr(tracing, "RunTree", Mock())
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="privacy-test", user_id="synthetic-owner", model="test", client=Mock(), enabled=True
    )
    assert recorder.enabled is True
    assert recorder.content_mode == "structural"
    recorder.start_tool_call(
        tool_call_id="test-call", tool_name="retrieve_memories", arguments={"attribute": value}
    )
    recorder.record_function_response(
        tool_call_id="test-call", tool_name="retrieve_memories", response={"attribute": value}, success=True
    )
    calls = recorder.root.create_child.call_args_list
    assert len(calls) == 2
    assert calls[0].kwargs["inputs"]["arguments"]["fields"]["attribute"] == {"kind": "boolean"}
    assert calls[1].kwargs["outputs"]["response"]["fields"]["attribute"] == {"kind": "boolean"}
    # Program status remains observable; only arbitrary payload booleans are redacted.
    assert calls[1].kwargs["outputs"]["success"] is True


@pytest.mark.parametrize("mode", ["structural", "full"])
def test_trace_error_honors_effective_content_mode(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    monkeypatch.setenv(tracing.CONTENT_TRACING_ENV, "true")
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", mode)
    monkeypatch.setattr(tracing, "RunTree", Mock())
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="privacy-test", user_id="synthetic-owner", model="test", client=Mock(),
        enabled=True, owner_memory_governance="non_governed",
    )
    assert recorder.content_allowed is True
    assert recorder.content_mode == mode
    sentinel = "private exception content"
    recorder.record_tool_call(
        tool_call_id="test-call", tool_name="retrieve_memories", arguments={},
        success=False, error=sentinel, response={"error_type": "provider_error"},
    )
    child = recorder.root.create_child.return_value
    assert child.end.call_args.kwargs["error"] == (
        sentinel if mode == "full" else "provider_error"
    )
    recorder.close(error=sentinel)
    assert recorder.root.end.call_args.kwargs["error"] == (
        sentinel if mode == "full" else "session_error"
    )
