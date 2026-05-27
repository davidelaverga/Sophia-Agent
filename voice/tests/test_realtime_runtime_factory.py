from __future__ import annotations

import pytest

from voice.realtime import (
    GEMINI_LIVE_PROVIDER_NAME,
    LEGACY_CASCADE_PROVIDER_NAME,
    OPENAI_REALTIME_PROVIDER_NAME,
    RealtimeRuntimeFactoryConfig,
    VoiceRuntimeMode,
    build_realtime_runtime_bundle,
    run_comparative_smoke_harness,
)
from voice.realtime.events import ProviderEvent
from voice.realtime.legacy_cascade import LegacyCascadeProviderSession
from voice.realtime.openai_realtime import OpenAIRealtimeProviderSession


def _artifact() -> dict[str, object]:
    return {
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


@pytest.mark.anyio
async def test_factory_builds_legacy_runtime_by_default() -> None:
    bundle = build_realtime_runtime_bundle(
        RealtimeRuntimeFactoryConfig(),
        provider_events=[
            ProviderEvent.user_transcript_final("hello", utterance_id="utt-1"),
            ProviderEvent.artifact_payload(_artifact()),
        ],
    )

    assert bundle.selection.mode == VoiceRuntimeMode.LEGACY_CASCADE
    assert isinstance(bundle.provider_session, LegacyCascadeProviderSession)
    assert bundle.provider_session.provider_name == LEGACY_CASCADE_PROVIDER_NAME

    payloads = [event.as_payload() async for event in bundle.runtime.public_events()]

    assert payloads[0] == {
        "type": "sophia.user_transcript",
        "data": {"text": "hello", "utterance_id": "utt-1"},
    }
    assert payloads[-1] == {"type": "sophia.artifact", "data": _artifact()}


def test_factory_rejects_experimental_provider_without_double_opt_in() -> None:
    with pytest.raises(ValueError, match="SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED"):
        build_realtime_runtime_bundle(
            RealtimeRuntimeFactoryConfig(
                mode=VoiceRuntimeMode.OPENAI_REALTIME,
                openai_realtime_adapter_enabled=True,
            )
        )

    with pytest.raises(ValueError, match="SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED"):
        build_realtime_runtime_bundle(
            RealtimeRuntimeFactoryConfig(
                mode=VoiceRuntimeMode.OPENAI_REALTIME,
                experimental_runtime_enabled=True,
            )
        )


def test_factory_constructs_explicit_openai_runtime() -> None:
    bundle = build_realtime_runtime_bundle(
        RealtimeRuntimeFactoryConfig(
            mode=VoiceRuntimeMode.OPENAI_REALTIME,
            experimental_runtime_enabled=True,
            openai_realtime_adapter_enabled=True,
            session_id="session-openai",
        ),
        raw_events=[],
    )

    assert bundle.selection.mode == VoiceRuntimeMode.OPENAI_REALTIME
    assert bundle.selection.is_experimental_runtime is True
    assert isinstance(bundle.provider_session, OpenAIRealtimeProviderSession)
    assert bundle.provider_session.provider_name == OPENAI_REALTIME_PROVIDER_NAME


@pytest.mark.anyio
async def test_comparative_smoke_harness_preserves_public_contract() -> None:
    comparison = await run_comparative_smoke_harness()

    assert comparison.passed is True
    assert comparison.missing_required_by_mode == {
        "legacy_cascade": (),
        "openai_realtime": (),
        "gemini_live": (),
    }
    assert comparison.provider_wire_leaks_by_mode == {
        "legacy_cascade": (),
        "openai_realtime": (),
        "gemini_live": (),
    }

    provider_names = {result.provider_name for result in comparison.results}
    assert provider_names == {
        LEGACY_CASCADE_PROVIDER_NAME,
        OPENAI_REALTIME_PROVIDER_NAME,
        GEMINI_LIVE_PROVIDER_NAME,
    }

    for result in comparison.results:
        assert all(event_type.startswith("sophia.") for event_type in result.public_event_types)
        assert "sophia.user_transcript" in result.public_event_types
        assert "sophia.artifact" in result.public_event_types
        assert any(
            payload["type"] == "sophia.transcript"
            and payload["data"].get("is_final") is True
            for payload in result.public_payloads
        )