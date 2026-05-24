from __future__ import annotations

import json
from typing import Any

import pytest

from voice.realtime import SophiaEventNormalizer
from voice.realtime.artifact_visibility import (
    answer_contains_probe_takeaway,
    build_artifact_visibility_diagnostic,
    classify_next_turn_answer,
    classify_public_artifact_event_visibility,
    default_artifact_visibility_probe,
    record_contains_probe_value,
)
from voice.realtime.events import ProviderEventType
from voice.realtime.gemini_live import (
    GEMINI_LIVE_PROVIDER_NAME,
    GeminiLiveEventMapper,
    GeminiLiveProviderSession,
)
from voice.realtime.gemini_tool_loop import GeminiDogfoodToolExecutor, GeminiLiveFunctionCall
from voice.realtime.openai_realtime import (
    OpenAIRealtimeEventMapper,
    OpenAIRealtimeProviderSession,
)
from voice.realtime.runtime_selection import VoiceRuntimeMode


def _public_payloads(provider_events: list[Any]) -> list[dict[str, Any]]:
    return [
        event.as_payload()
        for event in SophiaEventNormalizer().normalize_events(provider_events)
    ]


def test_artifact_visibility_probe_classifier_requires_exact_takeaway() -> None:
    probe = default_artifact_visibility_probe()

    assert probe.takeaway not in probe.next_turn_question
    assert answer_contains_probe_takeaway(f"It was {probe.takeaway}.", probe) is True
    assert classify_next_turn_answer(f"It was {probe.takeaway}.", probe) == "proven_visible"
    assert classify_next_turn_answer("I do not have that internal note available.", probe) == "proven_not_visible"
    assert classify_next_turn_answer("", probe) == "inconclusive"


def test_public_artifact_event_alone_is_not_provider_context() -> None:
    assert (
        classify_public_artifact_event_visibility(
            public_artifact_seen=True,
            provider_send_count_after_public_event=0,
        )
        == "proven_not_visible"
    )
    assert (
        classify_public_artifact_event_visibility(
            public_artifact_seen=True,
            provider_send_count_after_public_event=1,
        )
        == "inconclusive"
    )


@pytest.mark.anyio
async def test_gemini_probe_separates_function_args_public_event_and_current_tool_response() -> None:
    probe = default_artifact_visibility_probe()
    call = GeminiLiveFunctionCall(
        call_id="artifact-visibility-call-1",
        name="emit_artifact",
        args=probe.function_call_args(),
    )
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-artifact-proof")
    provider_events = mapper.map_event(
        {
            "toolCall": {
                "functionCalls": [
                    {"id": call.call_id, "name": call.name, "args": call.args},
                ],
            },
        },
    )

    assert [event.type for event in provider_events] == [
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
    ]
    assert record_contains_probe_value(provider_events[1].data["arguments"], probe) is True
    assert provider_events[2].data["artifact"]["takeaway"] == probe.takeaway
    assert {"type": "sophia.artifact", "data": probe.artifact_payload()} in _public_payloads(
        provider_events,
    )

    execution = await GeminiDogfoodToolExecutor().execute(
        call,
        session_id="sess-gemini-artifact-proof",
        user_id="user-artifact-proof",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider=GEMINI_LIVE_PROVIDER_NAME,
    )

    assert execution.response["artifact_recorded"] is True
    assert execution.response["artifact_keys"] == sorted(probe.artifact_payload())
    assert record_contains_probe_value(execution.response, probe) is False

    diagnostic = build_artifact_visibility_diagnostic(
        probe=probe,
        provider="gemini_live",
        variant="function_call_args_vs_current_tool_response",
        tool_call_args=call.args,
        tool_response=execution.response,
        public_artifact_seen=True,
        next_turn_user_probe_seen=True,
    )
    assert diagnostic["tool_call_args_contains_probe"] is True
    assert diagnostic["tool_response_contains_probe"] is False
    assert diagnostic["visibility_result"] == "inconclusive"
    diagnostic_json = json.dumps(diagnostic, sort_keys=True)
    assert probe.takeaway not in diagnostic_json
    assert probe.session_goal not in diagnostic_json


@pytest.mark.anyio
async def test_gemini_tool_response_path_can_carry_test_only_probe_output() -> None:
    probe = default_artifact_visibility_probe()
    sent_events: list[dict[str, Any]] = []

    async def sender(event: dict[str, Any]) -> None:
        sent_events.append(event)

    session = GeminiLiveProviderSession(
        [
            {
                "toolCall": {
                    "functionCalls": [
                        {
                            "id": "artifact-visibility-call-2",
                            "name": "emit_artifact",
                            "args": probe.function_call_args(),
                        },
                    ],
                },
            },
        ],
        sender=sender,
        feature_enabled=True,
    )
    _ = [provider_event async for provider_event in session.events()]

    diagnostic_tool_response = {
        "ok": True,
        "diagnostic_probe_takeaway": probe.takeaway,
    }
    await session.send_tool_result("artifact-visibility-call-2", diagnostic_tool_response)

    assert sent_events == [
        {
            "toolResponse": {
                "functionResponses": [
                    {
                        "id": "artifact-visibility-call-2",
                        "name": "emit_artifact",
                        "response": diagnostic_tool_response,
                    },
                ],
            },
        },
    ]
    assert record_contains_probe_value(sent_events[0], probe) is True


@pytest.mark.anyio
async def test_openai_probe_covers_function_args_and_function_call_output_items() -> None:
    probe = default_artifact_visibility_probe()
    mapper = OpenAIRealtimeEventMapper(session_id="sess-openai-artifact-proof")
    function_arg_events = mapper.map_event(
        {
            "type": "response.function_call_arguments.done",
            "response_id": "resp-openai-artifact-proof",
            "call_id": "artifact-visibility-call-3",
            "name": "emit_artifact",
            "arguments": json.dumps(probe.function_call_args()),
        },
    )

    assert [event.type for event in function_arg_events] == [
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
    ]
    assert record_contains_probe_value(function_arg_events[0].data["arguments"], probe) is True
    assert function_arg_events[1].data["artifact"]["takeaway"] == probe.takeaway
    assert {"type": "sophia.artifact", "data": probe.artifact_payload()} in _public_payloads(
        function_arg_events,
    )

    sent_events: list[dict[str, Any]] = []

    async def sender(event: dict[str, Any]) -> None:
        sent_events.append(event)

    session = OpenAIRealtimeProviderSession(sender=sender, feature_enabled=True)
    diagnostic_tool_output = {
        "ok": True,
        "diagnostic_probe_takeaway": probe.takeaway,
    }
    await session.send_tool_result("artifact-visibility-call-3", diagnostic_tool_output)

    assert [event["type"] for event in sent_events] == [
        "conversation.item.create",
        "response.create",
    ]
    assert sent_events[0]["item"]["type"] == "function_call_output"
    assert sent_events[0]["item"]["call_id"] == "artifact-visibility-call-3"
    assert json.loads(sent_events[0]["item"]["output"]) == diagnostic_tool_output
    assert record_contains_probe_value(sent_events[0], probe) is True

    tool_result_events = mapper.map_event(
        {
            "type": "conversation.item.created",
            "item": sent_events[0]["item"],
        },
    )
    assert [event.type for event in tool_result_events] == [ProviderEventType.TOOL_RESULT_RECEIVED]
    assert tool_result_events[0].data["name"] == "emit_artifact"
    assert tool_result_events[0].data["output"] == diagnostic_tool_output


@pytest.mark.anyio
async def test_openai_conversation_item_create_path_exists_without_orientation_bridge() -> None:
    sent_events: list[dict[str, Any]] = []

    async def sender(event: dict[str, Any]) -> None:
        sent_events.append(event)

    session = OpenAIRealtimeProviderSession(sender=sender, feature_enabled=True)
    await session.send_text("hello")

    assert [event["type"] for event in sent_events] == [
        "conversation.item.create",
        "response.create",
    ]
    assert sent_events[0]["item"] == {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "hello"}],
    }