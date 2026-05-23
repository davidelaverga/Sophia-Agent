from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import quote, urlparse

import httpx

from voice.realtime.dogfood_session import (
    RealtimeDogfoodConfigurationError,
    RealtimeDogfoodSession,
    RealtimeDogfoodSessionManager,
)
from voice.realtime.openai_realtime import (
    DEFAULT_OPENAI_REALTIME_MODEL,
    build_openai_realtime_session_config,
)
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_prompt import build_sophia_realtime_setup_instructions

OPENAI_REALTIME_API_KEY_ENV = "OPENAI_API_KEY"
OPENAI_REALTIME_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets"
OPENAI_REALTIME_WEBRTC_CALL_URL = "https://api.openai.com/v1/realtime/calls"
OPENAI_REALTIME_SIDEBAND_WS_URL = "wss://api.openai.com/v1/realtime"
OPENAI_REALTIME_BETA_HEADER_VALUE = "realtime=v1"

_CALL_ID_MAX_LENGTH = 160
_CALL_ID_PREFIX = "rtc_"
_CALL_ID_ALLOWED_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
)
_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS = (0.15, 0.35, 0.75)
_WEBSOCKET_HTTP_STATUS_PATTERN = re.compile(r"HTTP\s+(\d{3})")

_LOGGER = logging.getLogger(__name__)


class OpenAIBrowserDogfoodError(RuntimeError):
    """Base error for internal OpenAI browser WebRTC dogfood setup."""


class OpenAIClientSecretMintError(OpenAIBrowserDogfoodError):
    """Raised when the trusted backend cannot mint an OpenAI client secret."""


class OpenAISidebandAttachError(OpenAIBrowserDogfoodError):
    """Raised when a server sideband WebSocket cannot attach safely."""


@dataclass(frozen=True)
class OpenAIDogfoodGateResult:
    api_key: str
    model: str


@dataclass(frozen=True)
class OpenAIWebRTCCallDiagnostics:
    requested_model: str | None
    sdp_status: int | None
    raw_location: str | None
    extracted_call_id: str | None
    location_matches_documented_shape: bool
    call_id_matches_documented_shape: bool
    unexpected_location_variant: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "requested_model": self.requested_model,
            "sdp_status": self.sdp_status,
            "raw_location": self.raw_location,
            "extracted_call_id": self.extracted_call_id,
            "location_matches_documented_shape": self.location_matches_documented_shape,
            "call_id_matches_documented_shape": self.call_id_matches_documented_shape,
            "unexpected_location_variant": self.unexpected_location_variant,
        }


@dataclass(frozen=True)
class OpenAIRealtimeClientSecret:
    value: str
    expires_at: int | None = None
    session: dict[str, Any] = field(default_factory=dict)

    def as_public_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"value": self.value}
        if self.expires_at is not None:
            payload["expires_at"] = self.expires_at
        if self.session:
            payload["session"] = dict(self.session)
        return payload


@dataclass(frozen=True)
class OpenAIBrowserDogfoodSession:
    dogfood_session: RealtimeDogfoodSession
    client_secret: OpenAIRealtimeClientSecret
    requested_model: str
    webrtc_call_url: str = OPENAI_REALTIME_WEBRTC_CALL_URL

    def as_public_payload(self) -> dict[str, Any]:
        session_metadata = self.dogfood_session.metadata()
        return {
            **session_metadata,
            "browser_audio": "openai_webrtc_experimental",
            "transport": "openai_browser_webrtc_with_server_sideband",
            "requested_model": self.requested_model,
            "client_secret": self.client_secret.as_public_payload(),
            "webrtc_call_url": self.webrtc_call_url,
            "openai_diagnostics": {
                "requested_model": self.requested_model,
                "client_secret_session_model": self.client_secret.session.get("model"),
            },
            "event_stream_url": f"/dogfood/realtime/sessions/{self.dogfood_session.session_id}/events",
            "sideband_attach_url": (
                "/dogfood/realtime/openai/browser-sessions/"
                f"{self.dogfood_session.session_id}/sideband"
            ),
        }


class OpenAISidebandConnection(Protocol):
    async def send_json(self, payload: Mapping[str, Any]) -> None:
        ...

    def messages(self) -> AsyncIterator[Mapping[str, Any]]:
        ...

    async def close(self) -> None:
        ...


@dataclass(frozen=True)
class OpenAISidebandAttachment:
    connection: OpenAISidebandConnection
    url: str


class OpenAISidebandConnector(Protocol):
    async def __call__(
        self,
        *,
        call_id: str,
        api_key: str,
        location: str | None = None,
    ) -> OpenAISidebandAttachment:
        ...


class WebsocketsOpenAISidebandConnection:
    def __init__(self, websocket: Any) -> None:
        self._websocket = websocket

    async def send_json(self, payload: Mapping[str, Any]) -> None:
        await self._websocket.send(json.dumps(dict(payload), separators=(",", ":")))

    async def close(self) -> None:
        close = getattr(self._websocket, "close", None)
        if callable(close):
            await close()

    async def messages(self) -> AsyncIterator[Mapping[str, Any]]:
        async for message in self._websocket:
            if isinstance(message, bytes):
                message = message.decode("utf-8", errors="replace")
            if not isinstance(message, str):
                continue
            try:
                parsed = json.loads(message)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, Mapping):
                yield dict(parsed)


async def default_openai_sideband_connector(
    *,
    call_id: str,
    api_key: str,
    location: str | None = None,
) -> OpenAISidebandAttachment:
    try:
        import websockets  # type: ignore[import-not-found]
    except ImportError as exc:
        raise OpenAISidebandAttachError(
            "The optional 'websockets' package is required for live OpenAI sideband dogfood."
        ) from exc

    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Beta": OPENAI_REALTIME_BETA_HEADER_VALUE,
    }
    failures: list[str] = []
    max_attempts = len(_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS) + 1

    for url in build_openai_sideband_ws_urls(call_id=call_id, location=location):
        for attempt in range(1, max_attempts + 1):
            if attempt > 1:
                await asyncio.sleep(_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS[attempt - 2])

            attempt_started = time.monotonic()
            try:
                websocket = await _connect_openai_sideband_websocket(
                    websockets,
                    url=url,
                    headers=headers,
                )
            except Exception as exc:  # pragma: no cover - exercised via focused tests
                elapsed_ms = int((time.monotonic() - attempt_started) * 1000)
                status_code = _extract_websocket_http_status(exc)
                request_id = _extract_websocket_request_id(exc)
                retryable = status_code == 404 and attempt < max_attempts
                failure = _format_sideband_attach_failure(
                    url=url,
                    attempt=attempt,
                    max_attempts=max_attempts,
                    elapsed_ms=elapsed_ms,
                    status_code=status_code,
                    request_id=request_id,
                    retryable=retryable,
                    exc=exc,
                )
                failures.append(failure)
                _LOGGER.warning(
                    "openai.sideband_attach.attempt_failed call_id=%s attempt=%s/%s "
                    "status=%s retryable=%s elapsed_ms=%s request_id=%s url=%s error_type=%s error=%s",
                    call_id,
                    attempt,
                    max_attempts,
                    status_code or "unknown",
                    retryable,
                    elapsed_ms,
                    request_id or "unknown",
                    url,
                    exc.__class__.__name__,
                    _truncate_for_log(str(exc)),
                )
                if retryable:
                    continue
                break

            if attempt > 1:
                elapsed_ms = int((time.monotonic() - attempt_started) * 1000)
                _LOGGER.info(
                    "openai.sideband_attach.retry_succeeded call_id=%s attempt=%s/%s "
                    "elapsed_ms=%s url=%s",
                    call_id,
                    attempt,
                    max_attempts,
                    elapsed_ms,
                    url,
                )
            return OpenAISidebandAttachment(
                connection=WebsocketsOpenAISidebandConnection(websocket),
                url=url,
            )

    attempted = "; ".join(failures) or "no websocket attempts were made"
    raise OpenAISidebandAttachError(f"OpenAI sideband websocket attach failed: {attempted}")


class OpenAIRealtimeClientSecretMinter:
    def __init__(
        self,
        *,
        url: str = OPENAI_REALTIME_CLIENT_SECRET_URL,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._url = url
        self._timeout_seconds = timeout_seconds

    async def mint_client_secret(
        self,
        *,
        api_key: str,
        session_config: Mapping[str, Any],
        safety_identifier: str | None = None,
    ) -> OpenAIRealtimeClientSecret:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if safety_identifier:
            headers["OpenAI-Safety-Identifier"] = safety_identifier

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    self._url,
                    headers=headers,
                    json={"session": dict(session_config)},
                )
        except httpx.RequestError as exc:
            raise OpenAIClientSecretMintError(
                f"OpenAI client secret request failed: {exc.__class__.__name__}."
            ) from exc

        if response.status_code >= 400:
            detail = response.text[:300]
            raise OpenAIClientSecretMintError(
                f"OpenAI client secret mint failed with HTTP {response.status_code}: {detail}"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise OpenAIClientSecretMintError(
                "OpenAI client secret response was not valid JSON."
            ) from exc

        value = payload.get("value")
        if not isinstance(value, str) or not value.strip():
            raise OpenAIClientSecretMintError(
                "OpenAI client secret response omitted the ephemeral value."
            )

        expires_at = payload.get("expires_at")
        session = payload.get("session")
        return OpenAIRealtimeClientSecret(
            value=value,
            expires_at=expires_at if isinstance(expires_at, int) else None,
            session=dict(session) if isinstance(session, Mapping) else {},
        )


@dataclass
class OpenAISidebandSession:
    dogfood_session_id: str
    call_id: str
    connection: OpenAISidebandConnection
    sideband_url: str
    call_diagnostics: dict[str, Any] | None = None
    webrtc_readiness: dict[str, Any] | None = None
    attached_at: float = field(default_factory=time.time)
    _pump_task: asyncio.Task[None] | None = None
    _closed: bool = False

    @property
    def attached(self) -> bool:
        return not self._closed

    def start(self, dogfood_session: RealtimeDogfoodSession) -> None:
        if self._pump_task is not None:
            return
        self._pump_task = asyncio.create_task(self._pump_messages(dogfood_session))

    async def send_client_event(self, payload: Mapping[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("Cannot send OpenAI sideband events after close.")
        await self.connection.send_json(payload)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._pump_task
        await self.connection.close()

    def metadata(self) -> dict[str, Any]:
        return {
            "dogfood_session_id": self.dogfood_session_id,
            "call_id": self.call_id,
            "attached": self.attached,
            "attached_at": self.attached_at,
            "sideband_url": self.sideband_url,
            "call_diagnostics": dict(self.call_diagnostics) if self.call_diagnostics else None,
            "webrtc_readiness": dict(self.webrtc_readiness) if self.webrtc_readiness else None,
        }

    async def _pump_messages(self, dogfood_session: RealtimeDogfoodSession) -> None:
        try:
            async for raw_event in self.connection.messages():
                await dogfood_session.ingest_provider_event(raw_event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await dogfood_session.ingest_provider_event(
                {
                    "type": "error",
                    "error": {
                        "message": f"OpenAI sideband connection failed: {exc}",
                        "code": "sideband_connection_failed",
                    },
                }
            )


class OpenAISidebandSessionManager:
    def __init__(self, connector: OpenAISidebandConnector | None = None) -> None:
        self._connector = connector or default_openai_sideband_connector
        self._sessions: dict[str, OpenAISidebandSession] = {}
        self._attach_tasks: dict[str, asyncio.Task[OpenAISidebandAttachment]] = {}
        self._closing_session_ids: set[str] = set()

    def get(self, dogfood_session_id: str) -> OpenAISidebandSession | None:
        return self._sessions.get(dogfood_session_id)

    async def attach(
        self,
        dogfood_session: RealtimeDogfoodSession,
        *,
        call_id: str,
        api_key: str,
        location: str | None = None,
        call_diagnostics: Mapping[str, Any] | None = None,
        webrtc_readiness: Mapping[str, Any] | None = None,
    ) -> OpenAISidebandSession:
        dogfood_session_id = dogfood_session.session_id
        self._closing_session_ids.discard(dogfood_session_id)
        if dogfood_session.runtime_mode != VoiceRuntimeMode.OPENAI_REALTIME:
            raise OpenAISidebandAttachError(
                "OpenAI sideband can only attach to openai_realtime dogfood sessions."
            )
        if dogfood_session.closed:
            raise OpenAISidebandAttachError(
                "OpenAI sideband cannot attach after the dogfood session has closed."
            )
        if not is_valid_openai_call_id(call_id):
            raise OpenAISidebandAttachError(
                "Missing or invalid OpenAI Realtime call id. Expected the rtc_* id from the WebRTC Location header."
            )

        await self.close(dogfood_session_id, mark_closing=False)
        sanitized_readiness = _sanitize_webrtc_readiness(webrtc_readiness)
        sanitized_call_diagnostics = _sanitize_openai_call_diagnostics(
            call_diagnostics,
            raw_location=location,
            extracted_call_id=call_id,
        )
        _LOGGER.info(
            "openai.sideband_attach.requested session_id=%s call_id=%s readiness=%s call_diagnostics=%s",
            dogfood_session_id,
            call_id,
            _format_webrtc_readiness_for_log(sanitized_readiness),
            _format_openai_call_diagnostics_for_log(sanitized_call_diagnostics),
        )
        attach_task = asyncio.create_task(
            self._connector(
                call_id=call_id,
                api_key=api_key,
                location=location,
            )
        )
        self._attach_tasks[dogfood_session_id] = attach_task
        try:
            attachment = await attach_task
        except asyncio.CancelledError as exc:
            if dogfood_session_id in self._closing_session_ids and not _current_task_is_cancelling():
                raise OpenAISidebandAttachError(
                    "OpenAI sideband attach was cancelled because the dogfood session closed before attach completed."
                ) from exc
            raise
        except OpenAISidebandAttachError as exc:
            raise OpenAISidebandAttachError(
                f"{exc}; browser_webrtc_readiness={_format_webrtc_readiness_for_log(sanitized_readiness)}; "
                f"call_diagnostics={_format_openai_call_diagnostics_for_log(sanitized_call_diagnostics)}"
            ) from exc
        finally:
            if self._attach_tasks.get(dogfood_session_id) is attach_task:
                self._attach_tasks.pop(dogfood_session_id, None)

        if dogfood_session.closed or dogfood_session_id in self._closing_session_ids:
            await attachment.connection.close()
            raise OpenAISidebandAttachError(
                "OpenAI sideband websocket attached after the dogfood session closed; connection was closed."
            )

        sideband_session = OpenAISidebandSession(
            dogfood_session_id=dogfood_session_id,
            call_id=call_id,
            connection=attachment.connection,
            sideband_url=attachment.url,
            call_diagnostics=sanitized_call_diagnostics,
            webrtc_readiness=sanitized_readiness,
        )
        sideband_session.start(dogfood_session)
        self._sessions[dogfood_session_id] = sideband_session
        _LOGGER.info(
            "openai.sideband_attach.attached session_id=%s call_id=%s sideband_url=%s readiness=%s",
            dogfood_session_id,
            call_id,
            sideband_session.sideband_url,
            _format_webrtc_readiness_for_log(sanitized_readiness),
        )
        return sideband_session

    async def close(self, dogfood_session_id: str, *, mark_closing: bool = True) -> bool:
        if mark_closing:
            self._closing_session_ids.add(dogfood_session_id)
        closed_any = False
        attach_task = self._attach_tasks.pop(dogfood_session_id, None)
        if attach_task is not None:
            closed_any = True
            if not attach_task.done():
                attach_task.cancel()
            try:
                attachment = await attach_task
            except asyncio.CancelledError:
                _LOGGER.info(
                    "openai.sideband_attach.cancelled session_id=%s reason=session_closed",
                    dogfood_session_id,
                )
            except Exception as exc:
                _LOGGER.info(
                    "openai.sideband_attach.cancelled session_id=%s reason=session_closed error_type=%s error=%s",
                    dogfood_session_id,
                    exc.__class__.__name__,
                    _truncate_for_log(str(exc)),
                )
            else:
                await attachment.connection.close()

        sideband_session = self._sessions.pop(dogfood_session_id, None)
        if sideband_session is None:
            return closed_any
        await sideband_session.close()
        return True


class OpenAIBrowserDogfoodSessionManager:
    def __init__(
        self,
        realtime_sessions: RealtimeDogfoodSessionManager,
        *,
        client_secret_minter: OpenAIRealtimeClientSecretMinter | None = None,
        sideband_sessions: OpenAISidebandSessionManager | None = None,
    ) -> None:
        self._realtime_sessions = realtime_sessions
        self._client_secret_minter = client_secret_minter or OpenAIRealtimeClientSecretMinter()
        self._sideband_sessions = sideband_sessions or OpenAISidebandSessionManager()

    async def start_browser_session(
        self,
        settings: object,
        *,
        user_id: str,
        session_id: str | None = None,
        instructions: str | None = None,
    ) -> OpenAIBrowserDogfoodSession:
        gate = validate_openai_browser_dogfood_settings(settings)
        session_instructions = instructions or build_sophia_realtime_setup_instructions(
            platform=str(getattr(settings, "platform", "voice")),
            context_mode=str(getattr(settings, "context_mode", "life")),
            ritual=getattr(settings, "ritual", None),
        )
        dogfood_session = await self._realtime_sessions.start_session(
            settings,
            user_id=user_id,
            session_id=session_id,
            instructions=session_instructions,
        )
        session_config = build_openai_realtime_session_config(
            instructions=session_instructions,
            model=gate.model,
            tools=_openai_browser_dogfood_tool_declarations(),
        )
        client_secret = await self._client_secret_minter.mint_client_secret(
            api_key=gate.api_key,
            session_config=session_config,
            safety_identifier=_safety_identifier(user_id),
        )
        return OpenAIBrowserDogfoodSession(
            dogfood_session=dogfood_session,
            client_secret=client_secret,
            requested_model=gate.model,
        )

    async def attach_sideband(
        self,
        settings: object,
        *,
        dogfood_session_id: str,
        call_id: str,
        location: str | None = None,
        call_diagnostics: Mapping[str, Any] | None = None,
        webrtc_readiness: Mapping[str, Any] | None = None,
    ) -> OpenAISidebandSession:
        gate = validate_openai_browser_dogfood_settings(settings)
        dogfood_session = self._realtime_sessions.get_session(dogfood_session_id)
        if dogfood_session is None:
            raise OpenAISidebandAttachError(
                f"Dogfood session with id {dogfood_session_id!r} was not found."
            )
        return await self._sideband_sessions.attach(
            dogfood_session,
            call_id=call_id,
            api_key=gate.api_key,
            location=location,
            call_diagnostics=_sanitize_openai_call_diagnostics(
                call_diagnostics,
                requested_model=gate.model,
                raw_location=location,
                extracted_call_id=call_id,
            ),
            webrtc_readiness=webrtc_readiness,
        )

    async def close_session(self, dogfood_session_id: str) -> bool:
        await self._sideband_sessions.close(dogfood_session_id)
        return await self._realtime_sessions.close_session(dogfood_session_id)

    async def close_sideband(self, dogfood_session_id: str) -> bool:
        return await self._sideband_sessions.close(dogfood_session_id)


def validate_openai_browser_dogfood_settings(settings: object) -> OpenAIDogfoodGateResult:
    selection = settings.voice_runtime_selection
    if selection.mode != VoiceRuntimeMode.OPENAI_REALTIME:
        raise RealtimeDogfoodConfigurationError(
            "OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_RUNTIME_MODE=openai_realtime."
        )
    if not selection.experimental_runtime_enabled:
        raise RealtimeDogfoodConfigurationError(
            "OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true."
        )
    if not selection.openai_realtime_adapter_enabled:
        raise RealtimeDogfoodConfigurationError(
            "OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true."
        )

    api_key = (os.getenv(OPENAI_REALTIME_API_KEY_ENV) or "").strip()
    if not api_key:
        raise RealtimeDogfoodConfigurationError(
            "OpenAI browser WebRTC dogfood requires OPENAI_API_KEY on the trusted backend."
        )

    return OpenAIDogfoodGateResult(
        api_key=api_key,
        model=str(getattr(settings, "openai_realtime_model", DEFAULT_OPENAI_REALTIME_MODEL)),
    )


def build_openai_sideband_ws_urls(
    *,
    call_id: str,
    location: str | None = None,
) -> tuple[str, ...]:
    _ = location
    return (f"{OPENAI_REALTIME_SIDEBAND_WS_URL}?call_id={quote(call_id, safe='')}",)


async def _connect_openai_sideband_websocket(
    websockets_module: Any,
    *,
    url: str,
    headers: Mapping[str, str],
) -> Any:
    connect = getattr(websockets_module, "connect", None)
    if not callable(connect):
        raise OpenAISidebandAttachError(
            "The optional 'websockets' package is required for live OpenAI sideband dogfood."
        )

    try:
        return await connect(url, additional_headers=dict(headers))
    except TypeError as exc:
        try:
            return await connect(url, extra_headers=dict(headers))
        except TypeError:
            raise exc


def is_valid_openai_call_id(call_id: str | None) -> bool:
    if not isinstance(call_id, str):
        return False
    if not call_id.startswith(_CALL_ID_PREFIX):
        return False
    if len(call_id) > _CALL_ID_MAX_LENGTH:
        return False
    return all(char in _CALL_ID_ALLOWED_CHARS for char in call_id)


def _extract_websocket_http_status(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    for candidate in (
        getattr(response, "status_code", None),
        getattr(response, "status", None),
        getattr(exc, "status_code", None),
        getattr(exc, "status", None),
    ):
        if isinstance(candidate, int):
            return candidate

    match = _WEBSOCKET_HTTP_STATUS_PATTERN.search(str(exc))
    if match is None:
        return None
    return int(match.group(1))


def _extract_websocket_request_id(exc: Exception) -> str | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None

    for name in ("x-request-id", "openai-request-id", "cf-ray"):
        get_header = getattr(headers, "get", None)
        if not callable(get_header):
            continue
        value = get_header(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _format_sideband_attach_failure(
    *,
    url: str,
    attempt: int,
    max_attempts: int,
    elapsed_ms: int,
    status_code: int | None,
    request_id: str | None,
    retryable: bool,
    exc: Exception,
) -> str:
    status = f"HTTP {status_code}" if status_code is not None else "status=unknown"
    request_id_part = f"; request_id={request_id}" if request_id else ""
    return (
        f"{url} -> {status}; attempt={attempt}/{max_attempts}; "
        f"retryable={str(retryable).lower()}; elapsed_ms={elapsed_ms}{request_id_part}; "
        f"error_type={exc.__class__.__name__}; error={_truncate_for_log(str(exc))}"
    )


def _truncate_for_log(value: str, *, limit: int = 240) -> str:
    if len(value) <= limit:
        return value
    return f"{value[: limit - 3]}..."


def _sanitize_webrtc_readiness(readiness: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(readiness, Mapping):
        return None

    allowed_keys = (
        "ready",
        "reason",
        "elapsed_ms",
        "session_alive_ms",
        "remote_audio_active",
        "connection_state",
        "ice_connection_state",
        "ice_gathering_state",
        "signaling_state",
        "data_channel_ready_state",
    )
    sanitized: dict[str, Any] = {}
    for key in allowed_keys:
        value = readiness.get(key)
        if isinstance(value, (bool, int, float)):
            sanitized[key] = value
        elif isinstance(value, str):
            sanitized[key] = _truncate_for_log(value, limit=120)
    return sanitized or None


def _format_webrtc_readiness_for_log(readiness: Mapping[str, Any] | None) -> str:
    sanitized = _sanitize_webrtc_readiness(readiness)
    if not sanitized:
        return "not_provided"
    return _truncate_for_log(json.dumps(sanitized, sort_keys=True, separators=(",", ":")), limit=500)


def _current_task_is_cancelling() -> bool:
    current_task = asyncio.current_task()
    return bool(current_task and current_task.cancelling())


def extract_openai_call_id_from_location(location: str | None) -> str | None:
    if not isinstance(location, str) or not location.strip():
        return None
    parsed = urlparse(location)
    path = parsed.path or location
    call_id = path.rstrip("/").split("/")[-1]
    return call_id if is_valid_openai_call_id(call_id) else None


def build_openai_webrtc_call_diagnostics(
    *,
    requested_model: str | None = None,
    sdp_status: int | None = None,
    raw_location: str | None = None,
    extracted_call_id: str | None = None,
) -> OpenAIWebRTCCallDiagnostics:
    normalized_location = _clean_optional_string(raw_location, limit=600)
    normalized_call_id = _clean_optional_string(extracted_call_id, limit=_CALL_ID_MAX_LENGTH)
    location_call_id = extract_openai_call_id_from_location(normalized_location)
    if normalized_call_id is None and location_call_id is not None:
        normalized_call_id = location_call_id

    call_id_matches = is_valid_openai_call_id(normalized_call_id)
    location_matches = _openai_location_matches_documented_shape(
        normalized_location,
        normalized_call_id,
    )
    return OpenAIWebRTCCallDiagnostics(
        requested_model=_clean_optional_string(requested_model, limit=120),
        sdp_status=sdp_status if isinstance(sdp_status, int) else None,
        raw_location=normalized_location,
        extracted_call_id=normalized_call_id,
        location_matches_documented_shape=location_matches,
        call_id_matches_documented_shape=call_id_matches,
        unexpected_location_variant=_describe_openai_location_variant(
            normalized_location,
            normalized_call_id,
        ),
    )


def _sanitize_openai_call_diagnostics(
    diagnostics: Mapping[str, Any] | None,
    *,
    requested_model: str | None = None,
    raw_location: str | None = None,
    extracted_call_id: str | None = None,
) -> dict[str, Any]:
    source = diagnostics if isinstance(diagnostics, Mapping) else {}
    return build_openai_webrtc_call_diagnostics(
        requested_model=_first_string(source.get("requested_model"), requested_model),
        sdp_status=_coerce_optional_int(source.get("sdp_status")),
        raw_location=_first_string(source.get("raw_location"), raw_location),
        extracted_call_id=_first_string(source.get("extracted_call_id"), extracted_call_id),
    ).as_dict()


def _format_openai_call_diagnostics_for_log(diagnostics: Mapping[str, Any] | None) -> str:
    if not diagnostics:
        return "not_provided"
    return _truncate_for_log(json.dumps(dict(diagnostics), sort_keys=True, separators=(",", ":")), limit=900)


def _openai_location_matches_documented_shape(
    raw_location: str | None,
    extracted_call_id: str | None,
) -> bool:
    if not raw_location or not is_valid_openai_call_id(extracted_call_id):
        return False
    path = _openai_location_path(raw_location)
    return path == f"/v1/realtime/calls/{extracted_call_id}"


def _describe_openai_location_variant(
    raw_location: str | None,
    extracted_call_id: str | None,
) -> str | None:
    if not raw_location:
        return "missing_location"

    path = _openai_location_path(raw_location)
    if not path.startswith("/v1/realtime/calls/"):
        return "unexpected_location_path"

    candidate = path.rstrip("/").split("/")[-1]
    if not candidate:
        return "missing_call_id_segment"
    if not candidate.startswith(_CALL_ID_PREFIX):
        prefix = candidate.split("_", 1)[0] if "_" in candidate else candidate[:12]
        return f"unexpected_call_id_prefix:{prefix}"
    if not is_valid_openai_call_id(candidate):
        return "invalid_call_id_shape"
    if extracted_call_id and candidate != extracted_call_id:
        return "extracted_call_id_mismatch"
    return None


def _openai_location_path(location: str) -> str:
    parsed = urlparse(location)
    if parsed.path:
        return parsed.path
    return location.split("?", 1)[0].split("#", 1)[0]


def _clean_optional_string(value: object, *, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    return _truncate_for_log(stripped, limit=limit)


def _first_string(*values: object) -> str | None:
    for value in values:
        cleaned = _clean_optional_string(value, limit=600)
        if cleaned is not None:
            return cleaned
    return None


def _coerce_optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _openai_browser_dogfood_tool_declarations() -> list[dict[str, object]]:
    return [
        {
            "type": "function",
            "name": "emit_artifact",
            "description": "Emit the structured Sophia companion turn artifact.",
            "parameters": {"type": "object", "additionalProperties": True},
        }
    ]


def _safety_identifier(user_id: str) -> str:
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
    return f"sophia_user_{digest}"
