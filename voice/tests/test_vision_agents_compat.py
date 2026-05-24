from __future__ import annotations

import importlib
from types import SimpleNamespace


def _reload_compat_with_import_hook(import_hook):
    import voice.vision_agents_compat as compat

    original_import_module = importlib.import_module
    importlib.import_module = import_hook
    try:
        return importlib.reload(compat)
    finally:
        importlib.import_module = original_import_module


def test_compat_prefers_real_symbol_when_present() -> None:
    class SDKTranscriptEvent:
        pass

    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.stt.events":
            return SimpleNamespace(STTTranscriptEvent=SDKTranscriptEvent)
        return SimpleNamespace()

    compat = _reload_compat_with_import_hook(import_hook)

    assert compat.STTTranscriptEvent is SDKTranscriptEvent


def test_compat_returns_fallback_when_module_missing() -> None:
    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.turn_detection.events":
            raise ModuleNotFoundError("missing", name=name)
        return SimpleNamespace()

    compat = _reload_compat_with_import_hook(import_hook)

    assert compat.TurnEndedEvent.__name__ == "TurnEndedEvent"


def test_compat_returns_fallback_when_symbol_missing() -> None:
    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.stt.events":
            return SimpleNamespace(STTTranscriptEvent=object)
        return SimpleNamespace()

    compat = _reload_compat_with_import_hook(import_hook)

    assert compat.STTPartialTranscriptEvent.__name__ == "STTPartialTranscriptEvent"


def test_compat_fallback_exceptions_subclass_exception() -> None:
    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.agents.exceptions":
            raise ModuleNotFoundError("missing", name=name)
        return SimpleNamespace()

    compat = _reload_compat_with_import_hook(import_hook)

    assert issubclass(compat.InvalidCallId, Exception)
    assert issubclass(compat.MaxConcurrentSessionsExceeded, Exception)
    assert issubclass(compat.MaxSessionsPerCallExceeded, Exception)


def test_compat_fallback_events_support_isinstance() -> None:
    def import_hook(name: str, package=None):  # noqa: ANN001
        if name in {
            "vision_agents.core.stt.events",
            "vision_agents.core.turn_detection.events",
        }:
            raise ModuleNotFoundError("missing", name=name)
        return SimpleNamespace()

    compat = _reload_compat_with_import_hook(import_hook)

    turn_event = compat.TurnEndedEvent()
    partial_event = compat.STTPartialTranscriptEvent()

    assert isinstance(turn_event, compat.TurnEndedEvent)
    assert isinstance(partial_event, compat.STTPartialTranscriptEvent)


def test_compat_reraises_unrelated_module_errors() -> None:
    def import_hook(name: str, package=None):  # noqa: ANN001
        if name == "vision_agents.core.stt.events":
            raise ModuleNotFoundError("missing dependency", name="third_party_dependency")
        return SimpleNamespace()

    import voice.vision_agents_compat as compat

    original_import_module = importlib.import_module
    importlib.import_module = import_hook
    try:
        raised = False
        try:
            importlib.reload(compat)
        except ModuleNotFoundError as exc:
            raised = True
            assert exc.name == "third_party_dependency"

        assert raised is True
    finally:
        importlib.import_module = original_import_module
