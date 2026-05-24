from __future__ import annotations

from importlib import import_module


def _missing_requested_module(exc: ModuleNotFoundError, module_name: str) -> bool:
    missing_name = getattr(exc, "name", None)
    if not missing_name:
        return False
    return missing_name == module_name or module_name.startswith(f"{missing_name}.")


def _make_fallback_type(symbol_name: str, fallback_base: type = object) -> type:
    fallback_type = type(symbol_name, (fallback_base,), {})
    fallback_type.__module__ = __name__
    return fallback_type


def resolve_symbol(
    module_name: str,
    symbol_name: str,
    *,
    fallback_base: type = object,
    expect_exception: bool = False,
) -> type:
    try:
        module = import_module(module_name)
    except ModuleNotFoundError as exc:
        if not _missing_requested_module(exc, module_name):
            raise
        return _make_fallback_type(symbol_name, fallback_base)

    symbol = getattr(module, symbol_name, None)
    if isinstance(symbol, type):
        if not expect_exception or issubclass(symbol, Exception):
            return symbol

    return _make_fallback_type(symbol_name, fallback_base)


InvalidCallId = resolve_symbol(
    "vision_agents.core.agents.exceptions",
    "InvalidCallId",
    fallback_base=Exception,
    expect_exception=True,
)
MaxConcurrentSessionsExceeded = resolve_symbol(
    "vision_agents.core.agents.exceptions",
    "MaxConcurrentSessionsExceeded",
    fallback_base=Exception,
    expect_exception=True,
)
MaxSessionsPerCallExceeded = resolve_symbol(
    "vision_agents.core.agents.exceptions",
    "MaxSessionsPerCallExceeded",
    fallback_base=Exception,
    expect_exception=True,
)
STTPartialTranscriptEvent = resolve_symbol(
    "vision_agents.core.stt.events",
    "STTPartialTranscriptEvent",
)
STTTranscriptEvent = resolve_symbol(
    "vision_agents.core.stt.events",
    "STTTranscriptEvent",
)
STTErrorEvent = resolve_symbol(
    "vision_agents.core.stt.events",
    "STTErrorEvent",
)
TurnEndedEvent = resolve_symbol(
    "vision_agents.core.turn_detection.events",
    "TurnEndedEvent",
)