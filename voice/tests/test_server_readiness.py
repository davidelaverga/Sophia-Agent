from __future__ import annotations

from types import SimpleNamespace

import pytest

import voice.server as server
from voice.adapters.base import BackendStageError
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.server import (
    validate_live_voice_server_runtime,
    validate_runtime,
    validate_vision_agents_session_runtime,
)
from voice.tests.conftest import make_settings


class FakeLLM:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.probed = False

    async def probe(self) -> None:
        self.probed = True
        if self.error is not None:
            raise self.error


@pytest.mark.anyio
async def test_validate_runtime_calls_probe() -> None:
    llm = FakeLLM()

    await validate_runtime(make_settings(), llm)

    assert llm.probed is True


@pytest.mark.anyio
async def test_validate_runtime_propagates_backend_stage_errors() -> None:
    llm = FakeLLM(BackendStageError("backend-ready", "probe failed"))

    with pytest.raises(BackendStageError, match="probe failed"):
        await validate_runtime(make_settings(), llm)


def test_live_voice_server_allows_legacy_runtime() -> None:
    validate_live_voice_server_runtime(make_settings())


def test_live_voice_server_allows_experimental_dogfood_runtime() -> None:
    settings = make_settings(
        voice_runtime_mode=VoiceRuntimeMode.OPENAI_REALTIME.value,
        experimental_realtime_runtime_enabled=True,
        openai_realtime_adapter_enabled=True,
    )

    validate_live_voice_server_runtime(settings)


def test_vision_agents_route_rejects_experimental_runtime_without_silent_fallback() -> None:
    settings = make_settings(
        voice_runtime_mode=VoiceRuntimeMode.OPENAI_REALTIME.value,
        experimental_realtime_runtime_enabled=True,
        openai_realtime_adapter_enabled=True,
    )

    with pytest.raises(RuntimeError, match="dogfood path"):
        validate_vision_agents_session_runtime(settings)


def test_resolve_invalid_call_id_exception_prefers_sdk_symbol(monkeypatch: pytest.MonkeyPatch) -> None:
    class SDKInvalidCallId(Exception):
        pass

    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(InvalidCallId=SDKInvalidCallId),
    )

    resolved = server._resolve_invalid_call_id_exception()

    assert resolved is SDKInvalidCallId


def test_resolve_invalid_call_id_exception_falls_back_to_local_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(),
    )

    resolved = server._resolve_invalid_call_id_exception()

    assert issubclass(resolved, Exception)
    assert resolved.__name__ == "InvalidCallId"


def test_resolve_vision_agents_exception_prefers_sdk_symbol(monkeypatch: pytest.MonkeyPatch) -> None:
    class SDKSessionsExceeded(Exception):
        pass

    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(MaxConcurrentSessionsExceeded=SDKSessionsExceeded),
    )

    resolved = server._resolve_vision_agents_exception("MaxConcurrentSessionsExceeded")

    assert resolved is SDKSessionsExceeded


def test_resolve_vision_agents_exception_falls_back_to_named_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(),
    )

    resolved = server._resolve_vision_agents_exception("MaxSessionsPerCallExceeded")

    assert issubclass(resolved, Exception)
    assert resolved.__name__ == "MaxSessionsPerCallExceeded"


def test_resolve_stt_event_symbol_prefers_sdk_symbol(monkeypatch: pytest.MonkeyPatch) -> None:
    class SDKPartialEvent:
        pass

    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(STTPartialTranscriptEvent=SDKPartialEvent),
    )

    resolved = server._resolve_stt_event_symbol("STTPartialTranscriptEvent")

    assert resolved is SDKPartialEvent


def test_resolve_stt_event_symbol_falls_back_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(STTTranscriptEvent=object),
    )

    resolved = server._resolve_stt_event_symbol("STTPartialTranscriptEvent")

    assert resolved.__name__ == "STTPartialTranscriptEvent"


@pytest.mark.parametrize("missing_symbol", ["STTTranscriptEvent", "STTErrorEvent"])
def test_resolve_stt_event_symbol_falls_back_for_other_missing_symbols(
    monkeypatch: pytest.MonkeyPatch,
    missing_symbol: str,
) -> None:
    monkeypatch.setattr(
        server.importlib,
        "import_module",
        lambda _name: SimpleNamespace(),
    )

    resolved = server._resolve_stt_event_symbol(missing_symbol)

    assert resolved.__name__ == missing_symbol


@pytest.mark.anyio
async def test_create_agent_allows_experimental_runtime_startup_for_dogfood(monkeypatch: pytest.MonkeyPatch) -> None:
    created: dict[str, object] = {}

    class FakeDeepgramSTT:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = False

    class FakeTTS:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.settings = settings

        def attach_echo_guard(self, turn_detection) -> None:  # noqa: ANN001
            self.turn_detection = turn_detection

        async def interrupt(self) -> None:
            return None

        async def stream_audio(self, phrase: str) -> None:
            return None

    class FakeLLM:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self.settings = settings
            created["llm"] = self

        def attach_tts(self, tts) -> None:  # noqa: ANN001
            self.tts = tts

        def attach_call_emitter(self, emitter) -> None:  # noqa: ANN001
            self.emitter = emitter

        def note_echo_suppression(self, user_id: str | None) -> None:
            return None

        def note_first_text_emitted(self, user_id: str) -> None:
            return None

        def note_backend_progress(self, user_id: str) -> None:
            return None

    class FakeTurnDetection:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.diagnostic_callback = None

        def attach_diagnostic_callback(self, callback) -> None:  # noqa: ANN001
            self.diagnostic_callback = callback

        def set_rhythm_offset(self, offset: int) -> None:
            self.rhythm_offset = offset

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

    class FakeAgent:
        def __init__(self, **kwargs) -> None:  # noqa: ANN003
            self.turn_detection = kwargs["turn_detection"]
            self.stt = kwargs["stt"]
            self.tts = kwargs["tts"]
            created["agent"] = self

        async def send_custom_event(self, data: dict) -> None:
            return None

        async def simple_response(self, transcript: str, participant: object):
            return SimpleNamespace(text=transcript)

    async def fake_validate_runtime(settings, llm) -> None:  # noqa: ANN001
        return None

    monkeypatch.setattr(
        server,
        "get_settings",
        lambda: make_settings(
            voice_runtime_mode=VoiceRuntimeMode.OPENAI_REALTIME.value,
            experimental_realtime_runtime_enabled=True,
            openai_realtime_adapter_enabled=True,
        ),
    )
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

    agent = await server.create_agent()

    assert agent is created["agent"]