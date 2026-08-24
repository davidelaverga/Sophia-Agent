from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from inspect import Parameter, signature
from typing import Any


class _FallbackEvent:
    def __init__(self, **attributes: object) -> None:
        self.__dict__.update(attributes)


def _missing_requested_module(exc: ModuleNotFoundError, module_name: str) -> bool:
    missing_name = getattr(exc, "name", None)
    if not missing_name:
        return False
    return missing_name == module_name or module_name.startswith(f"{missing_name}.")


def _make_fallback_type(symbol_name: str, fallback_base: type = _FallbackEvent) -> type:
    # ``importlib.reload`` re-executes this module in the existing module
    # dictionary. Reuse an earlier fallback so subscribers and test doubles
    # that retained the class keep matching ``isinstance`` after a readiness
    # probe reloads the compatibility layer.
    existing = globals().get(symbol_name)
    if (
        isinstance(existing, type)
        and existing.__module__ == __name__
        and existing.__name__ == symbol_name
    ):
        return existing

    fallback_type = type(symbol_name, (fallback_base,), {})
    fallback_type.__module__ = __name__
    return fallback_type


def resolve_symbol(
    module_name: str,
    symbol_name: str,
    *,
    fallback_base: type = _FallbackEvent,
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


def agent_constructor_supports_kwarg(agent_cls: type, kwarg: str) -> bool:
    try:
        parameters = signature(agent_cls.__init__).parameters
    except (TypeError, ValueError):
        return True

    parameter = parameters.get(kwarg)
    if parameter is not None and parameter.kind is not Parameter.POSITIONAL_ONLY:
        return True

    return any(parameter.kind is Parameter.VAR_KEYWORD for parameter in parameters.values())


def resolve_agent_constructor_kwargs(
    agent_cls: type,
    required_kwargs: Mapping[str, Any],
    optional_kwargs: Mapping[str, Any],
) -> tuple[dict[str, Any], tuple[str, ...]]:
    agent_kwargs = dict(required_kwargs)
    omitted_kwargs: list[str] = []

    for key, value in optional_kwargs.items():
        if agent_constructor_supports_kwarg(agent_cls, key):
            agent_kwargs[key] = value
        else:
            omitted_kwargs.append(key)

    return agent_kwargs, tuple(omitted_kwargs)


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
TTSAudioEvent = resolve_symbol(
    "vision_agents.core.tts.events",
    "TTSAudioEvent",
)
TTSErrorEvent = resolve_symbol(
    "vision_agents.core.tts.events",
    "TTSErrorEvent",
)
TTSSynthesisStartEvent = resolve_symbol(
    "vision_agents.core.tts.events",
    "TTSSynthesisStartEvent",
)
TurnEndedEvent = resolve_symbol(
    "vision_agents.core.turn_detection.events",
    "TurnEndedEvent",
)
