from __future__ import annotations

import base64
import json
from typing import Any

import pytest
from voice.realtime import SophiaEventNormalizer
from voice.realtime.events import ProviderEventType
from voice.realtime.openai_realtime import (
    DEFAULT_OPENAI_REALTIME_MODEL,
    OPENAI_REALTIME_ADAPTER_FEATURE_FLAG,
    OPENAI_REALTIME_CAPABILITIES,
    OPENAI_REALTIME_PROVIDER_NAME,
    OpenAIRealtimeAdapterDisabledError,
    OpenAIRealtimeEventMapper,
    OpenAIRealtimeProviderSession,
    build_openai_realtime_session_config,
)
from voice.realtime.sophia_backend_tools import openai_retrieve_memories_function_declaration


def _artifact(**overrides: object) -> dict[str, object]:
    artifact = {
        "session_goal": "Stay grounded in the voice session.",
        "active_goal": "Help the user name what is happening.",
        "next_step": "Listen for the next turn.",
        "takeaway": "The user wants a steadier moment.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "free_conversation.opening",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "sympathetic",
        "voice_speed": "gentle",
    }
    artifact.update(overrides)
    return artifact


def _payloads(provider_events: list[Any]) -> list[dict[str, Any]]:
    return [
        event.as_payload()
        for event in SophiaEventNormalizer().normalize_events(provider_events)
    ]


def test_capabilities_describe_native_openai_realtime_without_making_it_default() -> None:
    assert OPENAI_REALTIME_PROVIDER_NAME == "openai-gpt-realtime-2"
    assert OPENAI_REALTIME_CAPABILITIES.native_audio_input is True
    assert OPENAI_REALTIME_CAPABILITIES.native_audio_output is True
    assert OPENAI_REALTIME_CAPABILITIES.tool_calls is True
    assert OPENAI_REALTIME_CAPABILITIES.structured_tool_payloads is True
    assert OPENAI_REALTIME_CAPABILITIES.native_cancellation is True
    assert OPENAI_REALTIME_CAPABILITIES.session_updates is True
    assert OPENAI_REALTIME_CAPABILITIES.provider_hints["model"] == DEFAULT_OPENAI_REALTIME_MODEL


def test_session_construction_requires_explicit_feature_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(OPENAI_REALTIME_ADAPTER_FEATURE_FLAG, raising=False)

    with pytest.raises(OpenAIRealtimeAdapterDisabledError):
        OpenAIRealtimeProviderSession()

    monkeypatch.setenv(OPENAI_REALTIME_ADAPTER_FEATURE_FLAG, "true")
    session = OpenAIRealtimeProviderSession()

    assert session.provider_name == OPENAI_REALTIME_PROVIDER_NAME
    assert session.capabilities == OPENAI_REALTIME_CAPABILITIES


@pytest.mark.anyio
async def test_raw_openai_realtime_flow_normalizes_to_existing_sophia_events() -> None:
    raw_events = [
        {
            "type": "session.created",
            "session": {"id": "sess-openai-1", "model": DEFAULT_OPENAI_REALTIME_MODEL},
        },
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "user-item-1",
            "delta": "I had a rough",
        },
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "user-item-1",
            "transcript": "I had a rough day.",
        },
        {"type": "response.created", "response": {"id": "resp-openai-1"}},
        {
            "type": "response.output_audio.delta",
            "response_id": "resp-openai-1",
            "item_id": "assistant-item-1",
            "delta": "AAE=",
        },
        {
            "type": "response.output_audio_transcript.delta",
            "response_id": "resp-openai-1",
            "delta": "That sounds heavy. ",
        },
        {
            "type": "response.output_audio_transcript.delta",
            "response_id": "resp-openai-1",
            "delta": "I'm here with you.",
        },
        {
            "type": "response.output_audio_transcript.done",
            "response_id": "resp-openai-1",
        },
        {
            "type": "response.function_call_arguments.done",
            "response_id": "resp-openai-1",
            "call_id": "artifact-call-1",
            "name": "emit_artifact",
            "arguments": json.dumps(_artifact()),
        },
        {
            "type": "response.done",
            "response": {"id": "resp-openai-1", "status": "completed", "output": []},
        },
    ]
    session = OpenAIRealtimeProviderSession(raw_events, feature_enabled=True)

    provider_events = [provider_event async for provider_event in session.events()]
    payloads = _payloads(provider_events)

    assert [provider_event.type for provider_event in provider_events] == [
        ProviderEventType.USER_TRANSCRIPT_PARTIAL,
        ProviderEventType.USER_TRANSCRIPT_FINAL,
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.ASSISTANT_AUDIO_STARTED,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_FINAL,
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
        ProviderEventType.RESPONSE_ENDED,
    ]
    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {
        "text": "I had a rough day.",
        "utterance_id": "user-item-1",
    }
    assert payloads[3]["data"] == {"text": "That sounds heavy. ", "is_final": False}
    assert payloads[5]["data"] == {
        "text": "That sounds heavy. I'm here with you.",
        "is_final": True,
    }
    assert payloads[6] == {"type": "sophia.artifact", "data": _artifact()}
    assert all(payload["type"].startswith("sophia.") for payload in payloads)
    assert all("response." not in payload["type"] for payload in payloads)
    assert provider_events[0].raw["type"] == "conversation.item.input_audio_transcription.delta"


def test_emit_artifact_function_call_arguments_emit_structured_artifact_event() -> None:
    mapper = OpenAIRealtimeEventMapper(session_id="sess-openai-1")
    events = mapper.map_event(
        {
            "type": "response.function_call_arguments.done",
            "response_id": "resp-openai-1",
            "call_id": "artifact-call-1",
            "name": "emit_artifact",
            "arguments": json.dumps({"artifact": _artifact(voice_speed="energetic")}),
        }
    )

    assert [event.type for event in events] == [
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
    ]
    assert events[0].data["name"] == "emit_artifact"
    assert events[0].data["arguments"] == {"artifact": _artifact(voice_speed="energetic")}
    assert events[1].data["artifact"] == _artifact(voice_speed="energetic")
    assert events[1].delivery_intent is not None
    assert events[1].delivery_intent.pace == "energetic"


def test_response_done_can_carry_full_function_call_payload_without_delta_events() -> None:
    mapper = OpenAIRealtimeEventMapper()
    events = mapper.map_event(
        {
            "type": "response.done",
            "response": {
                "id": "resp-openai-1",
                "status": "completed",
                "output": [
                    {
                        "type": "function_call",
                        "id": "item-artifact-1",
                        "call_id": "artifact-call-1",
                        "name": "emit_artifact",
                        "arguments": json.dumps(_artifact()),
                    }
                ],
            },
        }
    )

    assert [event.type for event in events] == [
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
        ProviderEventType.RESPONSE_ENDED,
    ]
    assert _payloads(events) == [
        {"type": "sophia.artifact", "data": _artifact()},
        {"type": "sophia.turn", "data": {"phase": "agent_ended"}},
    ]


def test_mapper_uses_one_assistant_transcript_surface_per_response() -> None:
    mapper = OpenAIRealtimeEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {
                "type": "response.output_text.delta",
                "response_id": "resp-openai-1",
                "delta": "Text surface. ",
            }
        )
    )
    events.extend(
        mapper.map_event(
            {
                "type": "response.output_audio_transcript.delta",
                "response_id": "resp-openai-1",
                "delta": "Audio transcript duplicate. ",
            }
        )
    )
    events.extend(
        mapper.map_event(
            {
                "type": "response.output_text.done",
                "response_id": "resp-openai-1",
                "text": "Text surface.",
            }
        )
    )

    assert [event.type for event in events] == [
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_FINAL,
    ]
    assert _payloads(events) == [
        {"type": "sophia.transcript", "data": {"text": "Text surface. ", "is_final": False}},
        {"type": "sophia.transcript", "data": {"text": "Text surface.", "is_final": True}},
    ]


def test_builder_tool_output_maps_to_internal_tool_result_and_public_builder_payload() -> None:
    mapper = OpenAIRealtimeEventMapper()
    mapper.map_event(
        {
            "type": "response.function_call_arguments.done",
            "response_id": "resp-openai-1",
            "call_id": "builder-call-1",
            "name": "start_builder_task",
            "arguments": json.dumps({"description": "Draft the note", "task_type": "document"}),
        }
    )

    events = mapper.map_event(
        {
            "type": "conversation.item.created",
            "item": {
                "type": "function_call_output",
                "call_id": "builder-call-1",
                "output": json.dumps(
                    {
                        "builder_task": {
                            "type": "task_started",
                            "task_id": "builder-1",
                            "description": "Draft the note",
                        }
                    }
                ),
            },
        }
    )

    assert [event.type for event in events] == [
        ProviderEventType.TOOL_RESULT_RECEIVED,
        ProviderEventType.BUILDER_TASK_PAYLOAD,
    ]
    assert _payloads(events) == [
        {
            "type": "sophia.builder_task",
            "data": {
                "type": "task_started",
                "task_id": "builder-1",
                "description": "Draft the note",
            },
        }
    ]


def test_cancelled_response_maps_to_existing_turn_diagnostic_shape() -> None:
    mapper = OpenAIRealtimeEventMapper()
    provider_events = []
    provider_events.extend(
        mapper.map_event({"type": "response.created", "response": {"id": "resp-openai-1"}})
    )
    provider_events.extend(
        mapper.map_event(
            {
                "type": "response.done",
                "response": {
                    "id": "resp-openai-1",
                    "status": "cancelled",
                    "status_details": {"reason": "turn_detected"},
                },
            }
        )
    )

    assert [event.type for event in provider_events] == [
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.RESPONSE_CANCELLED,
    ]
    assert _payloads(provider_events) == [
        {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        {
            "type": "sophia.turn",
            "data": {"phase": "agent_ended", "reason": "cancelled"},
        },
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "resp-openai-1",
                "status": "failed",
                "reason": "cancelled",
                "provider": OPENAI_REALTIME_PROVIDER_NAME,
                "response_id": "resp-openai-1",
                "interrupted": False,
            },
        },
    ]


@pytest.mark.anyio
async def test_session_methods_emit_documented_openai_client_event_shapes() -> None:
    sent_events: list[dict[str, Any]] = []

    async def sender(event: dict[str, Any]) -> None:
        sent_events.append(event)

    session = OpenAIRealtimeProviderSession(sender=sender, feature_enabled=True)
    config = build_openai_realtime_session_config(
        instructions="Speak as Sophia.",
        tools=[{"type": "function", "name": "emit_artifact"}],
    )

    await session.configure(config)
    await session.send_audio(b"\x00\x01")
    await session.send_text("hello")
    await session.send_tool_result("call-1", {"ok": True})
    await session.cancel_response("barge_in")

    assert sent_events == session.sent_events
    assert [event["type"] for event in sent_events] == [
        "session.update",
        "input_audio_buffer.append",
        "conversation.item.create",
        "response.create",
        "conversation.item.create",
        "response.create",
        "response.cancel",
    ]
    assert sent_events[0]["session"] == config
    assert sent_events[1]["audio"] == base64.b64encode(b"\x00\x01").decode("ascii")
    assert sent_events[2]["item"] == {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "hello"}],
    }
    assert sent_events[4]["item"] == {
        "type": "function_call_output",
        "call_id": "call-1",
        "output": json.dumps({"ok": True}, ensure_ascii=False, separators=(",", ":")),
    }
    assert sent_events[6]["metadata"] == {"reason": "barge_in"}


def test_retrieve_memories_contract_can_convert_to_openai_function_schema() -> None:
    declaration = openai_retrieve_memories_function_declaration()

    assert declaration["type"] == "function"
    assert declaration["name"] == "retrieve_memories"
    assert "consult_skill" not in json.dumps(declaration)
    assert "explicit memory" in declaration["description"]
    assert "do you remember my favorite childhood movie" in declaration["description"]
    assert "what did we talk about last time" in declaration["description"]
    assert "later specific recall question is a new retrieval opportunity" in declaration["description"]
    assert "simple greetings" in declaration["description"]
    parameters = declaration["parameters"]
    assert parameters["type"] == "object"
    assert set(parameters["properties"]) == {"query"}
    assert parameters["required"] == ["query"]
    assert parameters["additionalProperties"] is False
    assert "user_id" not in parameters["properties"]
    assert "categories" not in parameters["properties"]


def test_openai_realtime_session_config_does_not_add_skill_tool() -> None:
    memory_declaration = openai_retrieve_memories_function_declaration()
    config = build_openai_realtime_session_config(
        instructions="Speak as Sophia.",
        tools=[memory_declaration],
    )

    assert [tool["name"] for tool in config["tools"]] == ["retrieve_memories"]
    assert "consult_skill" not in json.dumps(config)