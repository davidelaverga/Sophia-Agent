from __future__ import annotations

import importlib
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


def test_server_import_succeeds_when_turn_detection_events_module_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import_module = importlib.import_module

    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.turn_detection.events":
            raise ModuleNotFoundError("missing", name=name)
        return original_import_module(name, package)

    monkeypatch.setattr(importlib, "import_module", import_hook)

    import voice.vision_agents_compat as compat

    importlib.reload(compat)
    reloaded_server = importlib.reload(server)

    assert reloaded_server.TurnEndedEvent.__name__ == "TurnEndedEvent"


def test_tts_and_server_import_succeed_when_tts_event_symbols_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import_module = importlib.import_module

    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.tts.events":
            return SimpleNamespace()
        return original_import_module(name, package)

    monkeypatch.setattr(importlib, "import_module", import_hook)

    import voice.sophia_tts as sophia_tts
    import voice.vision_agents_compat as compat

    importlib.reload(compat)
    reloaded_tts = importlib.reload(sophia_tts)
    reloaded_server = importlib.reload(server)

    assert reloaded_tts.TTSAudioEvent.__name__ == "TTSAudioEvent"
    assert reloaded_tts.TTSErrorEvent.__name__ == "TTSErrorEvent"
    assert reloaded_server.TTSSynthesisStartEvent.__name__ == "TTSSynthesisStartEvent"


@pytest.mark.parametrize(
    "module_name",
    [
        "voice.sophia_tts",
        "voice.sophia_turn",
        "voice.server",
    ],
)
def test_voice_startup_modules_import(module_name: str) -> None:
    importlib.import_module(module_name)


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
