from __future__ import annotations

import asyncio
from uuid import UUID

from types import SimpleNamespace

import pytest

import voice.sophia_llm as sophia_llm_module
from voice.adapters.base import BackendAdapter, BackendEvent, BackendRequest, BackendStageError
from voice.sophia_llm import SophiaLLM
from voice.tests.conftest import make_settings


class FakeAdapter(BackendAdapter):
    mode = "fake"

    def __init__(self, events: list[BackendEvent]) -> None:
        self._events = events
        self.probed = False
        self.requests: list[BackendRequest] = []
        self.warmup_requests: list[BackendRequest] = []
        self.text_events_consumed = 0

    async def probe(self) -> None:
        self.probed = True

    async def stream_events(self, request: BackendRequest):
        assert request.user_id == "user-1"
        self.requests.append(request)
        for event in self._events:
            yield event
            if event.kind == "text":
                self.text_events_consumed += 1

    async def warmup(self, request: BackendRequest) -> None:
        self.warmup_requests.append(request)


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


def _valid_artifact(**overrides: object) -> dict[str, object]:
    artifact = {
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
    artifact.update(overrides)
    return artifact


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


@pytest.mark.anyio
async def test_artifact_forwarded_via_call_emitter() -> None:
    """When attach_call_emitter is set, artifact is emitted as a custom event."""
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    artifact_events = [payload for payload in emitted if payload["type"] == "sophia.artifact"]
    assert len(artifact_events) == 1
    assert artifact_events[0]["data"]["session_goal"] == "Week 1 voice proof"


@pytest.mark.anyio
async def test_builder_task_forwarded_via_call_emitter() -> None:
    emitted: list[dict] = []
    progress_calls: list[str] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.builder_task_payload(
                {"type": "task_started", "task_id": "builder-1", "description": "Builder: document about the dangers of war"}
            ),
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    original_note_backend_progress = llm.note_backend_progress

    def note_backend_progress(user_id: str) -> None:
        progress_calls.append(user_id)
        original_note_backend_progress(user_id)

    llm.note_backend_progress = note_backend_progress

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    builder_task_events = [payload for payload in emitted if payload["type"] == "sophia.builder_task"]
    assert builder_task_events == [
        {"type": "sophia.builder_task", "data": {"type": "task_started", "task_id": "builder-1", "description": "Builder: document about the dangers of war"}}
    ]
    assert progress_calls == ["user-1"]


@pytest.mark.anyio
async def test_builder_task_waits_for_text_before_emitting_agent_started() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.builder_task_payload(
                {"type": "task_started", "task_id": "builder-1", "description": "Builder: document about the dangers of war"}
            ),
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")
    llm.note_turn_end(participant)

    await llm.simple_response(
        "test",
        participant=participant,
    )

    sequence = [
        f"{payload['type']}:{payload['data']['phase']}"
        if payload["type"] == "sophia.turn"
        else payload["type"]
        for payload in emitted
    ]

    assert sequence.index("sophia.turn:user_ended") < sequence.index("sophia.builder_task")
    assert sequence.index("sophia.builder_task") < sequence.index("sophia.turn:agent_started")


@pytest.mark.anyio
async def test_transcript_events_stream_before_artifact() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("I heard you. "),
            BackendEvent.text_chunk("Let's stay with this for a second."),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    assert [payload["type"] for payload in emitted] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
    ]
    assert emitted[0]["data"]["text"] == "test"
    assert isinstance(emitted[0]["data"].get("utterance_id"), str)
    UUID(emitted[0]["data"]["utterance_id"])
    assert emitted[1]["data"] == {"phase": "agent_started"}
    assert emitted[2]["data"] == {
        "text": "I heard you. ",
        "is_final": False,
    }
    assert emitted[3]["data"] == {
        "text": "I heard you. Let's stay with this for a second.",
        "is_final": False,
    }
    assert emitted[4]["data"] == {
        "text": "I heard you. Let's stay with this for a second.",
        "is_final": True,
    }
    assert emitted[5]["data"] == _valid_artifact()


@pytest.mark.anyio
async def test_simple_response_splits_multi_sentence_backend_chunks_for_earlier_streaming() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("Good. Your pets are the priority."),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    transcript_events = [payload for payload in emitted if payload["type"] == "sophia.transcript"]
    assert transcript_events[0]["data"] == {
        "text": "Good. ",
        "is_final": False,
    }
    assert transcript_events[1]["data"] == {
        "text": "Good. Your pets are the priority.",
        "is_final": False,
    }
    assert transcript_events[2]["data"] == {
        "text": "Good. Your pets are the priority.",
        "is_final": True,
    }


@pytest.mark.anyio
async def test_simple_response_splits_long_clause_backend_chunks_for_earlier_audio() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk(
                "I can hear the relief in that, and I don't want you to rush past it.",
            ),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    transcript_events = [payload for payload in emitted if payload["type"] == "sophia.transcript"]
    assert transcript_events[0]["data"] == {
        "text": "I can hear the relief in that, ",
        "is_final": False,
    }
    assert transcript_events[1]["data"] == {
        "text": "I can hear the relief in that, and I don't want you to rush past it.",
        "is_final": False,
    }
    assert transcript_events[2]["data"] == {
        "text": "I can hear the relief in that, and I don't want you to rush past it.",
        "is_final": True,
    }


@pytest.mark.anyio
async def test_simple_response_soft_splits_long_backend_chunks_without_punctuation() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk(
                "You do not need to solve the whole thing tonight because naming the next honest step is already enough for now",
            ),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )

    transcript_events = [payload for payload in emitted if payload["type"] == "sophia.transcript"]
    assert transcript_events[0]["data"] == {
        "text": "You do not need to solve the whole thing tonight because naming the next ",
        "is_final": False,
    }
    assert transcript_events[1]["data"] == {
        "text": "You do not need to solve the whole thing tonight because naming the next honest step is already enough for now",
        "is_final": False,
    }
    assert transcript_events[2]["data"] == {
        "text": "You do not need to solve the whole thing tonight because naming the next honest step is already enough for now",
        "is_final": True,
    }


@pytest.mark.anyio
async def test_start_backend_warmup_runs_once_per_bound_session_context() -> None:
    adapter = FakeAdapter([])
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.bind_session_context(
        platform="voice",
        context_mode="work",
        ritual="prepare",
        session_id="session-1",
        thread_id="thread-1",
    )

    assert llm.start_backend_warmup("user-1") is True
    await asyncio.sleep(0)
    assert llm.start_backend_warmup("user-1") is False
    assert adapter.warmup_requests == [
        BackendRequest(
            text="[voice backend warmup]",
            user_id="user-1",
            platform="voice",
            ritual="prepare",
            context_mode="work",
            session_id="session-1",
            thread_id="thread-1",
        )
    ]

    llm.bind_session_context(
        platform="voice",
        context_mode="life",
        ritual=None,
        session_id="session-2",
        thread_id="thread-2",
    )
    assert llm.start_backend_warmup("user-1") is True
    await asyncio.sleep(0)
    assert adapter.warmup_requests[-1] == BackendRequest(
        text="[voice backend warmup]",
        user_id="user-1",
        platform="voice",
        ritual=None,
        context_mode="life",
        session_id="session-2",
        thread_id="thread-2",
    )


@pytest.mark.anyio
async def test_pending_user_ended_emits_on_first_backend_progress_before_agent_started() -> None:
    emitted: list[dict] = []
    sequence: list[str] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)
        event_type = payload["type"]
        if event_type == "sophia.turn":
            sequence.append(f"{event_type}:{payload['data']['phase']}")
            return

        sequence.append(event_type)

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")

    original_note_first_text_emitted = llm.note_first_text_emitted

    def note_first_text_emitted(user_id: str) -> None:
        sequence.append("first_text")
        original_note_first_text_emitted(user_id)

    llm.note_first_text_emitted = note_first_text_emitted

    llm.note_turn_end(participant)

    await llm.simple_response(
        "test",
        participant=participant,
    )

    assert [payload["type"] for payload in emitted] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
    ]
    assert emitted[0]["data"]["text"] == "test"
    assert isinstance(emitted[0]["data"].get("utterance_id"), str)
    assert sequence[:4] == [
        "sophia.user_transcript",
        "first_text",
        "sophia.turn:user_ended",
        "sophia.turn:agent_started",
    ]
    assert emitted[1]["data"] == {"phase": "user_ended"}
    assert emitted[2]["data"] == {"phase": "agent_started"}


@pytest.mark.anyio
async def test_user_transcript_event_does_not_block_backend_request_start() -> None:
    backend_requested = asyncio.Event()
    allow_user_transcript_emit = asyncio.Event()

    class SignalingAdapter(FakeAdapter):
        async def stream_events(self, request: BackendRequest):
            assert request.user_id == "user-1"
            self.requests.append(request)
            backend_requested.set()
            for event in self._events:
                yield event
                if event.kind == "text":
                    self.text_events_consumed += 1

    async def fake_emitter(payload: dict) -> None:
        if payload["type"] == "sophia.user_transcript":
            await allow_user_transcript_emit.wait()

    adapter = SignalingAdapter(
        [
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)

    response_task = asyncio.create_task(
        llm.simple_response(
            "test",
            participant=SimpleNamespace(user_id="user-1"),
        )
    )

    await asyncio.wait_for(backend_requested.wait(), timeout=0.1)
    allow_user_transcript_emit.set()

    response = await response_task
    assert response.text == "ok"


@pytest.mark.anyio
async def test_first_transcript_event_does_not_wait_for_turn_event_delivery() -> None:
    transcript_seen = asyncio.Event()
    allow_turn_emit = asyncio.Event()
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        if payload["type"] == "sophia.turn":
            await allow_turn_emit.wait()

        emitted.append(payload)
        if payload["type"] == "sophia.transcript" and payload["data"]["is_final"] is False:
            transcript_seen.set()

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")
    llm.note_turn_end(participant)

    response_task = asyncio.create_task(
        llm.simple_response(
            "test",
            participant=participant,
        )
    )

    await asyncio.wait_for(transcript_seen.wait(), timeout=0.1)
    assert [payload["type"] for payload in emitted[:2]] == [
        "sophia.user_transcript",
        "sophia.transcript",
    ]

    allow_turn_emit.set()
    response = await response_task
    assert response.text == "ok"


@pytest.mark.anyio
async def test_simple_response_emits_completion_diagnostic_without_tts_events() -> None:
    emitted: list[dict] = []

    async def fake_emitter(payload: dict) -> None:
        emitted.append(payload)

    original_grace_ms = sophia_llm_module.TURN_COMPLETION_GRACE_MS
    sophia_llm_module.TURN_COMPLETION_GRACE_MS = 0

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("I'm listening."),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")

    try:
        llm.note_turn_end(participant)

        await llm.simple_response(
            "I lost someone really important to me, and I still don't know how to make sense of it.",
            participant=participant,
        )
        await asyncio.sleep(0)

        assert [payload["type"] for payload in emitted] == [
            "sophia.user_transcript",
            "sophia.turn",
            "sophia.turn",
            "sophia.transcript",
            "sophia.transcript",
            "sophia.artifact",
            "sophia.turn_diagnostic",
        ]
        assert emitted[0]["data"]["text"] == "I lost someone really important to me, and I still don't know how to make sense of it."
        assert isinstance(emitted[0]["data"].get("utterance_id"), str)
        assert emitted[-1]["data"]["reason"] == "completed"
        assert emitted[-1]["data"]["backend_request_start_ms"] is not None
        assert emitted[-1]["data"]["backend_first_event_ms"] is not None
        assert emitted[-1]["data"]["first_audio_ms"] is None
    finally:
        sophia_llm_module.TURN_COMPLETION_GRACE_MS = original_grace_ms


@pytest.mark.anyio
async def test_call_emitter_failure_does_not_break_stream() -> None:
    """A failing call emitter should log but not crash the turn."""

    async def broken_emitter(payload: dict) -> None:
        raise ConnectionError("Stream disconnected")

    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("ok"),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.attach_call_emitter(broken_emitter)

    # Should complete without raising
    response = await llm.simple_response(
        "test",
        participant=SimpleNamespace(user_id="user-1"),
    )
    assert response.text == "ok"
    assert llm.last_artifact == _valid_artifact()


@pytest.mark.anyio
async def test_validate_artifact_normalizes_breakthrough_delivery_contract() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="enthusiasm",
            skill_loaded="celebrating_breakthrough",
            voice_emotion_primary="calm",
            voice_emotion_secondary="curious",
            voice_speed="gentle",
        )
    )

    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] == "proud"
    assert artifact["voice_speed"] == "engaged"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_challenging_response_contract() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="antagonism",
            voice_emotion_primary="calm",
            voice_emotion_secondary="sympathetic",
            voice_speed="gentle",
        ),
        response_text="You're catching yourself. Say it without the \"but\" — just the jealousy part.",
    )

    assert artifact["active_tone_band"] == "engagement"
    assert artifact["voice_emotion_primary"] == "determined"
    assert artifact["voice_emotion_secondary"] == "calm"
    assert artifact["voice_speed"] == "normal"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_explicit_good_news_even_with_weak_backend_artifact() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="interested",
            voice_speed="normal",
        ),
        response_text="I need a bit more context here — what happened?",
        user_text="I got the job and I still can't believe it worked out.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] in {"excited", "proud"}
    assert artifact["voice_speed"] == "engaged"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_noisy_breakthrough_transcript() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="content",
            voice_speed="normal",
        ),
        response_text="I'm not sure I'm tracking — what happened today that you can't believe?",
        user_text="motion today. and I still can believe it. It actually happened.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] in {"excited", "proud"}
    assert artifact["voice_speed"] == "engaged"


@pytest.mark.anyio
async def test_validate_artifact_prefers_celebratory_user_signal_over_supportive_phrase() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="anticipation",
            voice_speed="engaged",
        ),
        response_text="Now I hear you — something actually happened. You're still processing it. What was it?",
        user_text="usher today. I still can't believe it. It actually happened.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] == "proud"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_partial_noisy_breakthrough_transcript() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="content",
            voice_speed="normal",
        ),
        response_text="I'm still catching fragments here. \"It today\" and \"I still can't believe it\"-sounds like something unexpected happened.",
        user_text="it today. and I still can believe it.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] == "proud"
    assert artifact["voice_speed"] == "engaged"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_dropped_prefix_breakthrough_transcript() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="excited",
            voice_speed="engaged",
        ),
        response_text="I need context here — what happened? Help me catch up.",
        user_text="and believe it, it actually happened.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] in {"excited", "proud"}


@pytest.mark.anyio
async def test_validate_artifact_normalizes_leave_it_breakthrough_transcript() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="engagement",
            voice_emotion_primary="curious",
            voice_emotion_secondary="content",
            voice_speed="normal",
        ),
        response_text="I need a bit more context here — what actually happened?",
        user_text="leave it, it actually happened.",
    )

    assert artifact["active_tone_band"] == "enthusiasm"
    assert artifact["voice_emotion_primary"] == "excited"
    assert artifact["voice_emotion_secondary"] in {"excited", "proud"}
    assert artifact["voice_speed"] == "engaged"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_degraded_grief_transcript() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="anger_antagonism",
            voice_emotion_primary="calm",
            voice_emotion_secondary="curious",
            voice_speed="gentle",
        ),
        response_text="I need more context here — what's the thing that's important to you that you can't make sense of?",
        user_text="important to me. I still don't know to make sense with it.",
    )

    assert artifact["active_tone_band"] == "grief_fear"
    assert artifact["voice_emotion_primary"] == "sympathetic"
    assert artifact["voice_emotion_secondary"] == "calm"
    assert artifact["voice_speed"] == "gentle"


@pytest.mark.anyio
async def test_simple_response_uses_bound_runtime_session_context() -> None:
    adapter = FakeAdapter(
        [
            BackendEvent.text_chunk("Love that. "),
            BackendEvent.artifact_payload(_valid_artifact()),
        ]
    )
    llm = SophiaLLM(make_settings(), adapter=adapter)
    llm.attach_tts(FakeTTS())
    llm.bind_session_context(
        platform="ios_voice",
        context_mode="gaming",
        ritual="vent",
        session_id="session-123",
        thread_id="thread-456",
    )

    await llm.simple_response(
        "I finally pulled it off.",
        participant=SimpleNamespace(user_id="user-1"),
    )

    assert len(adapter.requests) == 1
    assert adapter.requests[0].platform == "ios_voice"
    assert adapter.requests[0].context_mode == "gaming"
    assert adapter.requests[0].ritual == "vent"
    assert adapter.requests[0].session_id == "session-123"
    assert adapter.requests[0].thread_id == "thread-456"


@pytest.mark.anyio
async def test_validate_artifact_normalizes_stuck_loop_language_to_challenging_profile() -> None:
    llm = SophiaLLM(make_settings())

    artifact = llm._validate_artifact(
        _valid_artifact(
            active_tone_band="grief_fear",
            voice_emotion_primary="calm",
            voice_emotion_secondary="sympathetic",
            voice_speed="gentle",
        ),
        response_text="What do you actually want here?",
        user_text="I keep getting jealous of my friend and I hate that I keep doing this.",
    )

    assert artifact["active_tone_band"] == "engagement"
    assert artifact["voice_emotion_primary"] == "determined"
    assert artifact["voice_emotion_secondary"] in {"curious", "calm"}
    assert artifact["voice_speed"] == "normal"