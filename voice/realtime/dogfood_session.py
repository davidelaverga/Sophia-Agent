from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import suppress
from dataclasses import asdict, dataclass, field
from typing import Any
from uuid import uuid4

from voice.realtime.events import ProviderEvent, ProviderEventType
from voice.realtime.gemini_live import build_gemini_live_setup_config
from voice.realtime.gemini_tool_loop import GeminiDogfoodToolError, gemini_dogfood_tool_declarations
from voice.realtime.openai_realtime import build_openai_realtime_session_config
from voice.realtime.runtime_factory import (
    RealtimeRuntimeBundle,
    RealtimeRuntimeFactoryConfig,
    build_realtime_runtime_bundle,
)
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_prompt import build_gemini_live_realtime_instructions

DURABLE_PUBLIC_REPLAY_TYPES = frozenset({"sophia.user_transcript", "sophia.builder_task"})


class RealtimeDogfoodConfigurationError(RuntimeError):
    """Raised when an internal dogfood session is requested for the wrong runtime."""


@dataclass(frozen=True)
class RealtimeRawProviderEvent:
    event: dict[str, Any]
    source_metadata: dict[str, Any] = field(default_factory=dict)


class DogfoodRawEventStream:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[RealtimeRawProviderEvent | None] = asyncio.Queue()
        self._closed = False

    async def push(
        self,
        raw_event: Mapping[str, Any],
        *,
        source_metadata: Mapping[str, Any] | None = None,
    ) -> None:
        if self._closed:
            raise RuntimeError("Cannot ingest provider events after dogfood session close.")
        await self._queue.put(
            RealtimeRawProviderEvent(
                event=dict(raw_event),
                source_metadata=dict(source_metadata or {}),
            )
        )

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._queue.put(None)

    async def __aiter__(self) -> AsyncIterator[RealtimeRawProviderEvent]:
        while True:
            raw_event = await self._queue.get()
            if raw_event is None:
                return
            yield raw_event


@dataclass
class RealtimeDogfoodSession:
    session_id: str
    user_id: str
    runtime_mode: VoiceRuntimeMode
    bundle: RealtimeRuntimeBundle
    raw_events: DogfoodRawEventStream
    sent_client_events: list[dict[str, Any]]
    _public_payloads: list[dict[str, object]] = field(default_factory=list)
    _public_payload_observers: list[Callable[[dict[str, object]], None]] = field(default_factory=list)
    _subscribers: set[asyncio.Queue[dict[str, object] | None]] = field(default_factory=set)
    _history_changed: asyncio.Event = field(default_factory=asyncio.Event)
    _pump_task: asyncio.Task[None] | None = None
    _closed: bool = False

    @property
    def provider_name(self) -> str:
        return self.bundle.provider_session.provider_name

    @property
    def sent_client_event_count(self) -> int:
        return len(self.sent_client_events)

    @property
    def public_payloads(self) -> tuple[dict[str, object], ...]:
        return tuple(dict(payload) for payload in self._public_payloads)

    @property
    def closed(self) -> bool:
        return self._closed

    def start_event_pump(self) -> None:
        if self._pump_task is not None:
            return
        self._pump_task = asyncio.create_task(self._pump_public_events())

    async def configure(self, instructions: str, *, model: str) -> None:
        if self.runtime_mode == VoiceRuntimeMode.OPENAI_REALTIME:
            config = build_openai_realtime_session_config(
                instructions=instructions,
                model=model,
                tools=_dogfood_tool_declarations(self.runtime_mode),
            )
        elif self.runtime_mode == VoiceRuntimeMode.GEMINI_LIVE:
            config = build_gemini_live_setup_config(
                instructions=instructions,
                model=model,
                tools=_dogfood_tool_declarations(self.runtime_mode),
            )
        else:
            raise RealtimeDogfoodConfigurationError(
                "Internal realtime dogfood sessions require openai_realtime or gemini_live."
            )

        await self.bundle.provider_session.configure(config)

    async def send_text(self, text: str) -> None:
        if self._closed:
            raise RuntimeError("Cannot send text after dogfood session close.")
        await self.bundle.provider_session.send_text(text)

    async def send_audio(self, chunk: bytes) -> None:
        if self._closed:
            raise RuntimeError("Cannot send audio after dogfood session close.")
        await self.bundle.provider_session.send_audio(chunk)

    async def send_tool_result(self, tool_call_id: str, result: dict[str, object]) -> None:
        if self._closed:
            raise RuntimeError("Cannot send tool results after dogfood session close.")
        await self.bundle.provider_session.send_tool_result(tool_call_id, result)

    async def cancel_response(self, reason: str | None = None) -> None:
        if self._closed:
            raise RuntimeError("Cannot cancel a response after dogfood session close.")
        await self.bundle.provider_session.cancel_response(reason)

    async def ingest_provider_event(
        self,
        raw_event: Mapping[str, Any],
        *,
        source_metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.raw_events.push(raw_event, source_metadata=source_metadata)

    def subscribe(
        self,
        *,
        replay_types: frozenset[str] | None = DURABLE_PUBLIC_REPLAY_TYPES,
    ) -> asyncio.Queue[dict[str, object] | None]:
        queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self._subscribers.add(queue)
        if replay_types:
            for payload in self._public_payloads:
                if str(payload.get("type")) in replay_types:
                    queue.put_nowait(dict(payload))
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, object] | None]) -> None:
        self._subscribers.discard(queue)

    def add_public_payload_observer(
        self,
        observer: Callable[[dict[str, object]], None],
    ) -> None:
        self._public_payload_observers.append(observer)

    async def wait_for_public_payloads(
        self,
        count: int,
        *,
        timeout: float = 1.0,
    ) -> tuple[dict[str, object], ...]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while len(self._public_payloads) < count:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            await asyncio.wait_for(self._history_changed.wait(), timeout=remaining)
            self._history_changed.clear()
        return self.public_payloads

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.raw_events.aclose()
        await self.bundle.runtime.close()
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._pump_task
        self._close_subscribers()

    async def _pump_public_events(self) -> None:
        try:
            async for public_event in self.bundle.runtime.public_events():
                await self._publish_public_payload(public_event.as_payload())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._publish_provider_error(str(exc))
        finally:
            self._close_subscribers()

    async def _publish_provider_error(self, message: str) -> None:
        provider_error = ProviderEvent.provider_error(
            message,
            stage="realtime-dogfood",
            recoverable=False,
        )
        for public_event in self.bundle.runtime.normalizer.normalize_event(provider_error):
            await self._publish_public_payload(public_event.as_payload())

    async def publish_provider_metric(
        self,
        data: Mapping[str, Any],
        *,
        response_id: str | None = None,
        turn_id: str | None = None,
    ) -> None:
        provider_metric = ProviderEvent(
            ProviderEventType.PROVIDER_METRIC,
            dict(data),
            provider=self.provider_name,
            session_id=self.session_id,
            response_id=response_id,
            turn_id=turn_id,
        )
        for public_event in self.bundle.runtime.normalizer.normalize_event(provider_metric):
            await self._publish_public_payload(public_event.as_payload())

    async def publish_provider_event(self, provider_event: ProviderEvent) -> None:
        for public_event in self.bundle.runtime.normalizer.normalize_event(provider_event):
            await self._publish_public_payload(public_event.as_payload())

    async def _publish_public_payload(self, payload: dict[str, object]) -> None:
        public_payload = {
            "type": payload.get("type", "sophia.turn_diagnostic"),
            "data": dict(payload.get("data", {})) if isinstance(payload.get("data"), Mapping) else {},
        }
        self._public_payloads.append(public_payload)
        for observer in list(self._public_payload_observers):
            observer(public_payload)
        self._history_changed.set()
        for queue in tuple(self._subscribers):
            queue.put_nowait(public_payload)

    def _close_subscribers(self) -> None:
        for queue in tuple(self._subscribers):
            queue.put_nowait(None)
        self._subscribers.clear()

    def metadata(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "user_id": self.user_id,
            "runtime": self.runtime_mode.value,
            "provider": self.provider_name,
            "capabilities": asdict(self.bundle.provider_session.capabilities),
            "public_event_boundary": "SophiaEventNormalizer",
            "browser_audio": "not_implemented",
            "transport": "internal_provider_event_pump",
        }


class RealtimeDogfoodSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, RealtimeDogfoodSession] = {}

    async def start_session(
        self,
        settings: object,
        *,
        user_id: str,
        session_id: str | None = None,
        instructions: str | None = None,
    ) -> RealtimeDogfoodSession:
        selection = settings.voice_runtime_selection
        if selection.mode == VoiceRuntimeMode.LEGACY_CASCADE:
            raise RealtimeDogfoodConfigurationError(
                "Internal realtime dogfood sessions require SOPHIA_VOICE_RUNTIME_MODE=openai_realtime or gemini_live."
            )
        validate_settings = getattr(settings, "validate", None)
        if callable(validate_settings):
            validate_settings()

        resolved_session_id = session_id or f"dogfood-{uuid4()}"
        raw_events = DogfoodRawEventStream()
        sent_client_events: list[dict[str, Any]] = []

        async def sender(event: dict[str, Any]) -> None:
            sent_client_events.append(dict(event))

        factory_config = _factory_config_from_settings(settings, session_id=resolved_session_id)
        bundle = build_realtime_runtime_bundle(
            factory_config,
            raw_events=raw_events,
            sender=sender,
        )
        session = RealtimeDogfoodSession(
            session_id=resolved_session_id,
            user_id=user_id,
            runtime_mode=selection.mode,
            bundle=bundle,
            raw_events=raw_events,
            sent_client_events=sent_client_events,
        )
        await session.configure(
            _instructions_for_selection(settings, selection.mode, instructions),
            model=_model_for_selection(settings, selection.mode),
        )
        session.start_event_pump()
        self._sessions[resolved_session_id] = session
        return session

    def get_session(self, session_id: str) -> RealtimeDogfoodSession | None:
        return self._sessions.get(session_id)

    async def close_session(self, session_id: str) -> bool:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        await session.close()
        return True


def _factory_config_from_settings(
    settings: object,
    *,
    session_id: str,
) -> RealtimeRuntimeFactoryConfig:
    return RealtimeRuntimeFactoryConfig(
        mode=getattr(settings, "voice_runtime_mode", VoiceRuntimeMode.LEGACY_CASCADE),
        shadow_parity_enabled=bool(getattr(settings, "realtime_shadow_parity_enabled", False)),
        experimental_runtime_enabled=bool(getattr(settings, "experimental_realtime_runtime_enabled", False)),
        openai_realtime_adapter_enabled=bool(getattr(settings, "openai_realtime_adapter_enabled", False)),
        openai_realtime_model=str(getattr(settings, "openai_realtime_model", "gpt-realtime-2")),
        gemini_live_adapter_enabled=bool(getattr(settings, "gemini_live_adapter_enabled", False)),
        gemini_live_model=str(getattr(settings, "gemini_live_model", "gemini-3.1-flash-live-preview")),
        session_id=session_id,
    )


def _model_for_selection(settings: object, mode: VoiceRuntimeMode) -> str:
    if mode == VoiceRuntimeMode.OPENAI_REALTIME:
        return str(getattr(settings, "openai_realtime_model", "gpt-realtime-2"))
    if mode == VoiceRuntimeMode.GEMINI_LIVE:
        return str(getattr(settings, "gemini_live_model", "gemini-3.1-flash-live-preview"))
    return "legacy_cascade"


def _instructions_for_selection(
    settings: object,
    mode: VoiceRuntimeMode,
    instructions: str | None,
) -> str:
    if instructions:
        return instructions
    if mode == VoiceRuntimeMode.GEMINI_LIVE:
        return build_gemini_live_realtime_instructions(
            platform=str(getattr(settings, "platform", "voice")),
            context_mode=str(getattr(settings, "context_mode", "life")),
            ritual=getattr(settings, "ritual", None),
        )
    return str(getattr(settings, "instructions", "Speak as Sophia."))


def _dogfood_tool_declarations(mode: VoiceRuntimeMode) -> list[dict[str, object]]:
    if mode == VoiceRuntimeMode.OPENAI_REALTIME:
        return [
            {
                "type": "function",
                "name": "emit_artifact",
                "description": "Emit the structured Sophia companion turn artifact.",
                "parameters": {"type": "object", "additionalProperties": True},
            }
        ]

    if mode == VoiceRuntimeMode.GEMINI_LIVE:
        try:
            return gemini_dogfood_tool_declarations()
        except GeminiDogfoodToolError as exc:
            raise RealtimeDogfoodConfigurationError(str(exc)) from exc

    return []