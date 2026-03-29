from __future__ import annotations

from types import SimpleNamespace

import pytest

from voice.adapters.base import BackendAdapter, BackendEvent, BackendRequest, BackendStageError
from voice.sophia_llm import SophiaLLM
from voice.tests.conftest import make_settings


class FakeAdapter(BackendAdapter):
    mode = "fake"

    def __init__(self, events: list[BackendEvent]) -> None:
        self._events = events
        self.probed = False
        self.text_events_consumed = 0

    async def probe(self) -> None:
        self.probed = True

    async def stream_events(self, request: BackendRequest):
        assert request.user_id == "user-1"
        for event in self._events:
            yield event
            if event.kind == "text":
                self.text_events_consumed += 1


class FakeTTS:
    def __init__(self, adapter: FakeAdapter | None = None) -> None:
        self.call_order: list[str] = []
        self.artifact: dict[str, object] | None = None
        self.response_user_id: str | None = None
        self.adapter = adapter
        self.text_events_consumed_at_artifact = 0

    def attach_runtime_hooks(self, on_first_audio, on_error) -> None:  # noqa: ANN001
        self._on_first_audio = on_first_audio
        self._on_error = on_error

    def note_response_started(self, user_id: str) -> None:
        self.response_user_id = user_id

    def update_from_artifact(self, artifact: dict[str, object]) -> None:
        self.call_order.append("artifact")
        self.artifact = artifact
        if self.adapter is not None:
            self.text_events_consumed_at_artifact = self.adapter.text_events_consumed

    def clear_response_context(self, user_id: str | None = None) -> None:
        if user_id is None or user_id == self.response_user_id:
            self.response_user_id = None


def _valid_artifact() -> dict[str, object]:
    return {
        "session_goal": "Week 1 voice proof",
        "active_goal": "Keep the user in a short, grounded loop.",
        "next_step": "Listen for the next user turn.",
        "takeaway": "The shim exercised streaming text and artifact delivery.",
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
async def test_simple_response_streams_chunks_and_updates_artifact_after_text() -> None:
    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("I heard you. "),
            BackendEvent.text_chunk("Let's stay with this for a second."),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    tts = FakeTTS(adapter=adapter)
    llm.attach_tts(tts)

    response = await llm.simple_response(
        "hello",
        participant=SimpleNamespace(user_id="user-1"),
    )

    assert response.text == "I heard you. Let's stay with this for a second."
    assert tts.artifact == _valid_artifact()
    assert tts.call_order == ["artifact"]
    assert tts.text_events_consumed_at_artifact == 2


@pytest.mark.anyio
async def test_simple_response_rejects_missing_artifact_after_text() -> None:
    llm = SophiaLLM(
        make_settings(),
        adapter=FakeAdapter([BackendEvent.text_chunk("I heard you.")]),
    )
    llm.attach_tts(FakeTTS())

    with pytest.raises(BackendStageError, match="artifact") as exc_info:
        await llm.simple_response(
            "hello",
            participant=SimpleNamespace(user_id="user-1"),
        )

    assert exc_info.value.stage == "backend-contract"