from __future__ import annotations

import inspect
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import get_type_hints

import pytest
import voice.server as server
from fastapi.testclient import TestClient
from vision_agents.core.turn_detection.events import TurnEndedEvent
from vision_agents.core.tts.events import (
    TTSSynthesisCompleteEvent,
    TTSSynthesisStartEvent,
)

from voice.server import attach_runtime_observers
from voice.tests.conftest import make_settings


class FakeEventBus:
    def __init__(self) -> None:
        self._handlers: list = []

    def subscribe(self, handler):  # noqa: ANN001,ANN201
        self._handlers.append(handler)
        return handler

    async def emit(self, event) -> None:  # noqa: ANN001
        for handler in list(self._handlers):
            signature = inspect.signature(handler)
            params = list(signature.parameters.values())
            if params:
                annotation = get_type_hints(handler).get(
                    params[0].name,
                    params[0].annotation,
                )
                if annotation is not inspect.Signature.empty:
                    try:
                        if not isinstance(event, annotation):
                            continue
                    except TypeError:
                        pass
            await handler(event)


class FakeTurnDetection:
    def __init__(self, **kwargs) -> None:  # noqa: ANN003
        self.events = FakeEventBus()
        self.reset_calls = 0
        self.updated: list[tuple[str, bool]] = []
        self.diagnostic_callback = None

    def reset_transcript(self) -> None:
        self.reset_calls += 1

    def update_transcript(self, text: str, *, is_final: bool = False) -> None:
        self.updated.append((text, is_final))

    def set_rhythm_offset(self, offset: int) -> None:
        self.offset = offset

    def attach_diagnostic_callback(self, callback) -> None:  # noqa: ANN001
        self.diagnostic_callback = callback


class FakeCoordinator:
    def __init__(self) -> None:
        self.is_merge_pending = False
        self.partials: list[str] = []
        self.turns: list[tuple[str, object]] = []
        self.merge_turns: list[str] = []
        self.agent_started = 0
        self.agent_ended = 0

    def on_partial_transcript(self, text: str) -> None:
        self.partials.append(text)

    def on_turn_ended(self, transcript: str, participant: object) -> bool:
        self.turns.append((transcript, participant))
        return True

    def on_merge_turn_ended(self, transcript: str) -> None:
        self.merge_turns.append(transcript)

    def on_agent_started(self) -> None:
        self.agent_started += 1

    def on_agent_ended(self) -> None:
        self.agent_ended += 1

    async def defer_response_for_continuation(
        self,
        text: str,
        participant: object,
    ) -> str | None:
        return None

    async def recover_late_continuation(
        self,
        text: str,
        participant: object,
    ) -> str | None:
        return None


class FakeLLMObserver:
    def __init__(self) -> None:
        self.turn_end_participants: list[object] = []
        self.turn_phases: list[str] = []

    def note_turn_end(self, participant: object) -> None:
        self.turn_end_participants.append(participant)

    async def emit_turn_event(self, phase: str, user_id: str | None = None) -> None:
        self.turn_phases.append(phase)

    def note_echo_suppression(self, user_id: str | None) -> None:
        return None

    def note_stage_error(
        self,
        stage: str,
        message: str,
        user_id: str | None = None,
        *,
        recoverable: bool = True,
    ) -> None:
        return None


@pytest.mark.anyio
async def test_attach_runtime_observers_forward_turn_phases() -> None:
    turn_detection = FakeTurnDetection()
    participant = SimpleNamespace(transcript="Need a second", user_id="user-1")
    agent = SimpleNamespace(
        turn_detection=turn_detection,
        stt=SimpleNamespace(events=FakeEventBus()),
        tts=SimpleNamespace(events=FakeEventBus()),
        _transcript_buffer="Need a second",
    )
    llm = FakeLLMObserver()
    coordinator = FakeCoordinator()

    attach_runtime_observers(agent, llm, coordinator)

    await turn_detection.events.emit(TurnEndedEvent(participant=participant))
    await agent.tts.events.emit(TTSSynthesisStartEvent(text="Hello"))
    await agent.tts.events.emit(TTSSynthesisCompleteEvent(text="Hello"))

    assert llm.turn_end_participants == [participant]
    assert llm.turn_phases == ["agent_started", "agent_ended"]
    assert coordinator.turns == [("Need a second", participant)]
    assert coordinator.agent_started == 1
    assert coordinator.agent_ended == 1
    assert turn_detection.reset_calls == 1


@pytest.mark.anyio
async def test_attach_runtime_observers_ignores_non_substantive_turns() -> None:
    turn_detection = FakeTurnDetection()
    participant = SimpleNamespace(transcript="...", user_id="user-1")
    agent = SimpleNamespace(
        turn_detection=turn_detection,
        stt=SimpleNamespace(events=FakeEventBus()),
        tts=SimpleNamespace(events=FakeEventBus()),
        _transcript_buffer="...",
    )
    llm = FakeLLMObserver()
    coordinator = FakeCoordinator()

    attach_runtime_observers(agent, llm, coordinator)

    await turn_detection.events.emit(TurnEndedEvent(participant=participant))

    assert llm.turn_end_participants == []
    assert llm.turn_phases == []
    assert coordinator.turns == []


@pytest.mark.anyio
async def test_create_agent_wires_llm_to_stream_custom_events(monkeypatch) -> None:
    created: dict[str, object] = {}

    class FakeDeepgramSTT:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = True
            self.events = FakeEventBus()

    class FakeTTS:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.events = FakeEventBus()

        def attach_echo_guard(self, turn_detection) -> None:  # noqa: ANN001
            self.turn_detection = turn_detection

        async def interrupt(self) -> None:
            return None

        async def stream_audio(self, phrase: str) -> None:
            return None

    class FakeLLM:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.events = FakeEventBus()
            self.emitter = None
            created["llm"] = self

        def attach_tts(self, tts) -> None:  # noqa: ANN001
            self.tts = tts

        def attach_call_emitter(self, emitter) -> None:  # noqa: ANN001
            self.emitter = emitter

        def note_echo_suppression(self, user_id: str | None) -> None:
            return None

        def note_first_text_emitted(self, user_id: str) -> None:
            return None

    class FakeRhythmTracker:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            return None

        def load(self, user_id: str) -> None:
            self.user_id = user_id

        def compute_silence_offset(self) -> int:
            return 0

        def record_turn(
            self,
            word_count: int,
            pause_durations: list[float],
            was_cancel_merge: bool = False,
        ) -> None:
            return None

        def end_session(self) -> None:
            return None

    class FakeAgent:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = kwargs["turn_detection"]
            self.stt = kwargs["stt"]
            self.tts = kwargs["tts"]
            self.sent_events: list[dict] = []
            created["agent"] = self

        async def send_custom_event(self, data: dict) -> None:
            self.sent_events.append(data)

        async def simple_response(self, transcript: str, participant: object) -> None:
            return None

    async def fake_validate_runtime(settings, llm) -> None:  # noqa: ANN001
        return None

    monkeypatch.setattr(server, "get_settings", lambda: make_settings())
    monkeypatch.setattr(server, "DeepgramSTT", FakeDeepgramSTT)
    monkeypatch.setattr(server, "SophiaTTS", FakeTTS)
    monkeypatch.setattr(server, "SophiaLLM", FakeLLM)
    monkeypatch.setattr(server, "SophiaTurnDetection", FakeTurnDetection)
    monkeypatch.setattr(server, "RhythmTracker", FakeRhythmTracker)
    monkeypatch.setattr(server, "Agent", FakeAgent)
    monkeypatch.setattr(server, "StreamEdge", lambda: object())
    monkeypatch.setattr(server, "User", lambda id, name: SimpleNamespace(id=id, name=name))
    monkeypatch.setattr(server, "validate_runtime", fake_validate_runtime)
    monkeypatch.setattr(server, "attach_runtime_observers", lambda agent, llm, coordinator: None)

    await server.create_agent()

    llm = created["llm"]
    agent = created["agent"]
    assert llm.emitter is not None
    assert agent.turn_detection.diagnostic_callback is not None

    payload = {"type": "sophia.artifact", "data": {"session_goal": "Test"}}
    await llm.emitter(payload)
    assert agent.sent_events == [payload]


def test_start_session_binds_runtime_context_to_agent_llm() -> None:
    bound_context: dict[str, object] = {}

    class FakeLLM:
        def bind_session_context(self, *, platform: str, context_mode: str, ritual: str | None) -> None:
            bound_context.update(
                {
                    "platform": platform,
                    "context_mode": context_mode,
                    "ritual": ritual,
                }
            )

    class FakeLauncher:
        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

        async def start_session(self, call_id: str, call_type: str = "default", video_track_override_path: str | None = None):
            return SimpleNamespace(
                id="session-123",
                call_id=call_id,
                started_at=datetime.now(timezone.utc),
                agent=SimpleNamespace(llm=FakeLLM()),
            )

        async def close_session(self, session_id: str, wait: bool = False) -> bool:
            return True

    app = server.create_fastapi_app(FakeLauncher())

    with TestClient(app) as client:
        response = client.post(
            "/calls/sophia-user_123-abc12345/sessions",
            json={
                "call_type": "default",
                "platform": "ios_voice",
                "context_mode": "gaming",
                "ritual": "vent",
            },
        )

    assert response.status_code == 201
    assert bound_context == {
        "platform": "ios_voice",
        "context_mode": "gaming",
        "ritual": "vent",
    }


@pytest.mark.anyio
async def test_create_agent_skips_non_substantive_simple_response(monkeypatch) -> None:
    created: dict[str, object] = {}

    class FakeDeepgramSTT:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = True
            self.events = FakeEventBus()

    class FakeTTS:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.events = FakeEventBus()

        def attach_echo_guard(self, turn_detection) -> None:  # noqa: ANN001
            self.turn_detection = turn_detection

        async def interrupt(self) -> None:
            return None

        async def stream_audio(self, phrase: str) -> None:
            return None

    class FakeLLM:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.events = FakeEventBus()
            created["llm"] = self

        def attach_tts(self, tts) -> None:  # noqa: ANN001
            self.tts = tts

        def attach_call_emitter(self, emitter) -> None:  # noqa: ANN001
            self.emitter = emitter

        def note_echo_suppression(self, user_id: str | None) -> None:
            return None

        def note_first_text_emitted(self, user_id: str) -> None:
            return None

        def note_continuation_handling(self, user_id: str | None) -> None:
            return None

    class FakeRhythmTracker:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            return None

        def load(self, user_id: str) -> None:
            self.user_id = user_id

        def compute_silence_offset(self) -> int:
            return 0

        def record_turn(
            self,
            word_count: int,
            pause_durations: list[float],
            was_cancel_merge: bool = False,
        ) -> None:
            return None

        def end_session(self) -> None:
            return None

    class FakeTurnDetectionForCreate(FakeTurnDetection):
        def should_stabilize_submission(self, transcript: str | None = None) -> bool:
            return False

    class FakeAgent:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = kwargs["turn_detection"]
            self.stt = kwargs["stt"]
            self.tts = kwargs["tts"]
            self.sent_events: list[dict] = []
            self.base_simple_response_calls: list[tuple[str, object]] = []
            created["agent"] = self

        async def send_custom_event(self, data: dict) -> None:
            self.sent_events.append(data)

        async def simple_response(self, transcript: str, participant: object):
            self.base_simple_response_calls.append((transcript, participant))
            return SimpleNamespace(text=transcript)

    async def fake_validate_runtime(settings, llm) -> None:  # noqa: ANN001
        return None

    monkeypatch.setattr(server, "get_settings", lambda: make_settings())
    monkeypatch.setattr(server, "DeepgramSTT", FakeDeepgramSTT)
    monkeypatch.setattr(server, "SophiaTTS", FakeTTS)
    monkeypatch.setattr(server, "SophiaLLM", FakeLLM)
    monkeypatch.setattr(server, "SophiaTurnDetection", FakeTurnDetectionForCreate)
    monkeypatch.setattr(server, "RhythmTracker", FakeRhythmTracker)
    monkeypatch.setattr(server, "Agent", FakeAgent)
    monkeypatch.setattr(server, "StreamEdge", lambda: object())
    monkeypatch.setattr(server, "User", lambda id, name: SimpleNamespace(id=id, name=name))
    monkeypatch.setattr(server, "validate_runtime", fake_validate_runtime)
    monkeypatch.setattr(server, "attach_runtime_observers", lambda agent, llm, coordinator: None)

    agent = await server.create_agent()
    response = await agent.simple_response("...", SimpleNamespace(user_id="user-1"))

    fake_agent = created["agent"]
    assert response.text == ""
    assert fake_agent.base_simple_response_calls == []