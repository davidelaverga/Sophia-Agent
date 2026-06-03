"""Voice session API — Stream token generation, agent dispatch, and call lifecycle."""

import asyncio
import logging
import os
import re
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from dotenv import dotenv_values
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.auth import require_authorized_user_scope
from app.gateway.sophia_realtime_context import (
    REALTIME_DYNAMIC_MEMORY_RETRIEVAL_SCHEMA,
    REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER,
    RealtimeContextRequest,
    build_degraded_realtime_context_response,
    build_sophia_realtime_context,
    create_realtime_memory_retrieval_grant,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/sophia",
    tags=["voice"],
    dependencies=[Depends(require_authorized_user_scope)],
)

SUPPORTED_PLATFORMS = {"voice", "text", "ios_voice"}
SUPPORTED_CONTEXT_MODES = {"work", "gaming", "life"}
VOICE_SERVER_DISPATCH_TIMEOUT = 10.0
VOICE_SERVER_WARMUP_TIMEOUT = 5.0
VOICE_SERVER_DOGFOOD_TIMEOUT = 15.0
VOICE_SERVER_DOGFOOD_SIDEBAND_TIMEOUT = 30.0
VOICE_SERVER_PRODUCTION_RUNTIME_TIMEOUT = 15.0
GEMINI_PRECONNECT_CLIENT_TTL_MS = 30_000
GEMINI_PRECONNECT_SERVER_CLEANUP_SECONDS = 65.0
GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG = "SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED"
BACKEND_DIR = Path(__file__).resolve().parents[3]
REPO_ROOT = BACKEND_DIR.parent


@dataclass(frozen=True)
class ActiveVoiceSession:
    call_id: str
    session_id: str
    runtime: str = "legacy_cascade"


_active_voice_sessions: dict[str, ActiveVoiceSession] = {}
_active_voice_session_locks: dict[str, asyncio.Lock] = {}
_active_voice_session_locks_guard = asyncio.Lock()

# Background tasks for fire-and-forget preflight disconnects.
# Held in a module-level set so asyncio doesn't GC them mid-flight.
_background_disconnect_tasks: set[asyncio.Task] = set()


def _schedule_background_disconnect(call_id: str, session_id: str) -> None:
    """Fire-and-forget disconnect of a previous voice session.

    Avoids blocking /voice/connect on the voice server's DELETE response.
    Progressive latency accumulation (1-3s → 5s → 8s → 10s) observed by
    users is caused by awaiting this disconnect while the previous session's
    Cartesia/Deepgram/Stream resources are still tearing down.
    """
    try:
        task = asyncio.create_task(_disconnect_voice_session(call_id, session_id))
    except RuntimeError:
        # No running event loop — nothing to do (shouldn't happen in FastAPI path).
        logger.warning(
            "voice.connect: cannot schedule background disconnect (no loop) call_id=%s",
            call_id,
        )
        return
    _background_disconnect_tasks.add(task)
    task.add_done_callback(_background_disconnect_tasks.discard)


def _schedule_background_active_session_disconnect(session: ActiveVoiceSession) -> None:
    try:
        if session.runtime == "gemini_live":
            task = asyncio.create_task(_disconnect_gemini_production_session(session.session_id))
        else:
            task = asyncio.create_task(_disconnect_voice_session(session.call_id, session.session_id))
    except RuntimeError:
        logger.warning(
            "voice.connect: cannot schedule background disconnect (no loop) runtime=%s session_id=%s",
            session.runtime,
            session.session_id,
        )
        return
    _background_disconnect_tasks.add(task)
    task.add_done_callback(_background_disconnect_tasks.discard)


def _get_voice_server_url() -> str:
    return os.getenv("VOICE_SERVER_URL", "http://localhost:8000").rstrip("/")


async def _get_active_voice_session_lock(user_id: str) -> asyncio.Lock:
    async with _active_voice_session_locks_guard:
        return _active_voice_session_locks.setdefault(user_id, asyncio.Lock())


class VoiceConnectRequest(BaseModel):
    """Request body for establishing a voice session."""

    platform: str = Field(..., description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(default=None, description="Active ritual: prepare | debrief | vent | reset | None")
    session_id: str | None = Field(
        default=None,
        description="Frontend companion session ID for continuity",
    )
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID to reuse for this voice session",
    )
    preconnect: bool = Field(
        default=False,
        description=(
            "Best-effort frontend warmup request. Legacy returns a Stream session; "
            "Gemini production returns a short-lived browser bootstrap without opening "
            "the user's microphone or provider WebSocket."
        ),
    )


class VoiceConnectResponse(BaseModel):
    """Credentials the frontend needs to join the Stream call."""

    runtime: Literal["legacy_cascade"] = "legacy_cascade"
    voice_runtime: Literal["legacy_cascade"] = "legacy_cascade"
    api_key: str
    token: str
    call_type: str
    call_id: str
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID associated with this voice session",
    )
    stream_url: str | None = Field(
        default=None,
        description="Browser-facing SSE endpoint for Sophia transcript and artifact events",
    )
    session_id: str | None = Field(
        default=None,
        description="Voice agent session ID (from Vision Agents server)",
    )


class GeminiVoiceConnectResponse(BaseModel):
    """Production Gemini browser Live bootstrap returned only when explicitly enabled."""

    runtime: Literal["gemini_live"]
    voice_runtime: Literal["gemini_live"]
    production_route: Literal[True]
    session_id: str
    thread_id: str | None = None
    stream_url: str
    event_stream_url: str
    provider_event_relay_url: str
    disconnect_url: str
    browser_audio: str
    transport: str
    websocket_url: str
    websocket_auth: str
    ephemeral_token: dict[str, Any]
    setup: dict[str, Any]
    public_event_boundary: str | None = None
    gemini_voice_name: str | None = None
    gemini_voice_source: str | None = None
    gemini_voice_configured: bool | None = None
    gemini_voice_configured_value_valid: bool | None = None
    gemini_voice_diagnostic: str | None = None
    backendCoreviewFlagParsed: bool | None = None
    backendStillFrameFlagParsed: bool | None = None
    preconnect: bool = False
    preconnect_ttl_ms: int | None = None
    preconnect_expires_at: str | None = None


class GeminiVoicePreconnectSkippedResponse(BaseModel):
    """Safe no-op response for background Gemini preconnect attempts."""

    runtime: Literal["gemini_live"] = "gemini_live"
    voice_runtime: Literal["gemini_live"] = "gemini_live"
    production_route: Literal[True] = True
    preconnect: Literal[True] = True
    preconnect_skipped: Literal[True] = True
    preconnect_skipped_reason: Literal["already_active"] = "already_active"
    active_voice_session_exists: Literal[True] = True
    session_id: str | None = None
    thread_id: str | None = None


class VoiceDisconnectRequest(BaseModel):
    """Request body for ending a voice session."""

    call_id: str = Field(..., description="The call_id returned from /voice/connect")
    session_id: str = Field(..., description="The session_id returned from /voice/connect")
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID associated with the session",
    )


class VoiceWarmupRequest(BaseModel):
    """Request body for backend warmup on an active voice session."""

    call_id: str = Field(..., description="The call_id returned from /voice/connect")
    session_id: str = Field(..., description="The session_id returned from /voice/connect")


class OpenAIBrowserDogfoodStartRequest(BaseModel):
    """Start a protected OpenAI browser WebRTC dogfood session."""

    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")
    instructions: str | None = Field(default=None, description="Optional provider session instructions override")


class OpenAISidebandAttachRequest(BaseModel):
    """Attach the protected backend sideband to a browser OpenAI call."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")
    call_id: str | None = Field(default=None, description="OpenAI Realtime rtc_* call id")
    location: str | None = Field(default=None, description="Raw Location header from POST /v1/realtime/calls")
    webrtc_readiness: dict[str, object] | None = Field(
        default=None,
        description="Browser-observed WebRTC readiness evidence collected before sideband attach",
    )


class OpenAIBrowserDogfoodDisconnectRequest(BaseModel):
    """Close a protected OpenAI browser WebRTC dogfood session."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")


class GeminiBrowserDogfoodStartRequest(BaseModel):
    """Start a protected Gemini browser Live WebSocket dogfood session."""

    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")


class GeminiBrowserDogfoodRelayRequest(BaseModel):
    """Relay one browser-captured Gemini Live server message."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")
    event: dict[str, object] = Field(..., description="Raw Gemini Live server message payload")
    provider_receive_sequence: int | None = Field(
        default=None,
        gt=0,
        description="Browser-assigned monotonic Gemini WebSocket receive sequence for this provider message",
    )
    provider_relay_sequence: int | None = Field(
        default=None,
        gt=0,
        description="Browser-assigned monotonic sequence for relayed Gemini provider messages",
    )
    provider_received_at: str | None = Field(
        default=None,
        description="Browser ISO timestamp recorded when the provider WebSocket message was received",
    )
    relay_correlation_id: str | None = Field(
        default=None,
        description="Browser-stable relay correlation id derived at provider receive time",
    )
    provider_primary_category: str | None = Field(
        default=None,
        description="Browser-classified primary provider event category",
    )
    provider_categories: list[str] | None = Field(
        default=None,
        description="Browser-classified provider event categories",
    )
    artifact_review_context: dict[str, object] | None = Field(
        default=None,
        description="Browser-safe artifact review context for suppressing review-only artifact churn",
    )

    def voice_relay_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"event": self.event}
        for key in (
            "provider_receive_sequence",
            "provider_relay_sequence",
            "provider_received_at",
            "relay_correlation_id",
            "provider_primary_category",
            "provider_categories",
        ):
            value = getattr(self, key)
            if value is not None:
                payload[key] = value
        return payload


class GeminiBrowserDogfoodDisconnectRequest(BaseModel):
    """Close a protected Gemini browser Live WebSocket dogfood session."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")


@lru_cache(maxsize=1)
def _get_voice_env_fallback() -> dict[str, str]:
    values: dict[str, str] = {}

    for env_file in (REPO_ROOT / "voice" / ".env", BACKEND_DIR / ".env", REPO_ROOT / ".env"):
        if not env_file.exists():
            continue

        for key, value in dotenv_values(env_file).items():
            if key in values or value is None:
                continue

            stripped = value.strip()
            if stripped:
                values[key] = stripped

    return values


def _get_configured_env(name: str) -> str:
    direct_value = os.getenv(name, "").strip()
    if direct_value:
        return direct_value

    return _get_voice_env_fallback().get(name, "")


def _get_configured_bool(name: str, default: bool = False) -> bool:
    value = _get_configured_env(name)
    if not value:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_configured_voice_runtime_mode() -> str:
    configured_mode = _get_configured_env("SOPHIA_VOICE_RUNTIME_MODE")
    if configured_mode:
        return configured_mode.strip().lower().replace("-", "_")

    if _gemini_production_route_enabled():
        return "gemini_live"

    return "legacy_cascade"


def _gemini_production_route_enabled() -> bool:
    return _get_configured_bool(GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG, False)


def _get_stream_api_key() -> str:
    key = _get_configured_env("STREAM_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="STREAM_API_KEY not configured")
    return key


def _get_stream_api_secret() -> str:
    secret = _get_configured_env("STREAM_API_SECRET")
    if not secret:
        raise HTTPException(status_code=503, detail="STREAM_API_SECRET not configured")
    return secret


def _sanitize_call_id_fragment(value: str) -> str:
    """Normalize user-derived fragments to the voice server's call_id charset."""

    normalized = re.sub(r"[^a-z0-9_-]+", "-", value.lower()).strip("-_")
    return normalized or "user"


def _build_voice_events_stream_url(user_id: str, call_id: str, session_id: str | None) -> str | None:
    if not session_id:
        return None

    encoded_user_id = quote(user_id, safe="")
    encoded_call_id = quote(call_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return (
        f"/api/sophia/{encoded_user_id}/voice/events"
        f"?call_id={encoded_call_id}&session_id={encoded_session_id}"
    )


def _build_openai_dogfood_events_stream_url(user_id: str, session_id: str) -> str:
    encoded_user_id = quote(user_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/{encoded_user_id}/voice/dogfood/openai/events?session_id={encoded_session_id}"


def _build_gemini_dogfood_events_stream_url(user_id: str, session_id: str) -> str:
    encoded_user_id = quote(user_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/{encoded_user_id}/voice/dogfood/gemini/events?session_id={encoded_session_id}"


def _build_gemini_production_events_stream_url(session_id: str) -> str:
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/voice/gemini/events?session_id={encoded_session_id}"


def _build_gemini_production_relay_url() -> str:
    return "/api/sophia/voice/gemini/relay"


def _build_gemini_production_disconnect_url() -> str:
    return "/api/sophia/voice/gemini/disconnect"


def _safe_prefix(value: object, *, length: int = 24) -> str | None:
    return value[:length] if isinstance(value, str) and value else None


def _safe_voice_error_detail(detail: object) -> str | None:
    if isinstance(detail, str) and detail:
        return detail[:240]
    return None


def _gemini_relay_log_context(
    *,
    user_id: str,
    session_id: str,
    body: "GeminiBrowserDogfoodRelayRequest",
) -> dict[str, object]:
    return {
        "user_id": user_id,
        "session_id_prefix": _safe_prefix(session_id),
        "relay_correlation_id": _safe_prefix(body.relay_correlation_id),
        "provider_receive_sequence": body.provider_receive_sequence,
        "provider_relay_sequence": body.provider_relay_sequence,
        "provider_primary_category": body.provider_primary_category,
        "provider_categories": list(body.provider_categories or [])[:6],
    }


GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
GEMINI_REVIEW_BLOCKED_TOOL_NAMES = {
    "emit_artifact",
    "start_builder_task",
}
ARTIFACT_REVIEW_EMIT_SUPPRESSED_REASON = "artifact_review_emit_artifact_suppressed"


def _record_from_any_key(value: object, *keys: str) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, dict):
            return candidate
    return None


def _array_from_any_key(value: object, *keys: str) -> list[object]:
    if not isinstance(value, dict):
        return []

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def _read_gemini_function_calls(event: dict[str, object]) -> list[dict[str, object]]:
    tool_call = _record_from_any_key(event, "toolCall", "tool_call")
    calls = [
        call
        for call in _array_from_any_key(tool_call, "functionCalls", "function_calls")
        if isinstance(call, dict)
    ]

    server_content = _record_from_any_key(event, "serverContent", "server_content")
    model_turn = _record_from_any_key(server_content, "modelTurn", "model_turn")
    for part in _array_from_any_key(model_turn, "parts"):
        function_call = _record_from_any_key(part, "functionCall", "function_call")
        if function_call is not None:
            calls.append(function_call)

    return calls


def _string_from_any_key(value: object, *keys: str) -> str | None:
    if not isinstance(value, dict):
        return None

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _artifact_review_context_active(context: dict[str, object] | None) -> bool:
    return bool(context and context.get("active") is True)


def _artifact_review_user_intent(context: dict[str, object] | None) -> str:
    value = context.get("user_intent") if context else None
    return value if isinstance(value, str) and value else "unknown"


def _suppressed_review_tool_calls(
    body: GeminiBrowserDogfoodRelayRequest,
) -> list[dict[str, object]]:
    if not _artifact_review_context_active(body.artifact_review_context):
        return []
    if _artifact_review_user_intent(body.artifact_review_context) == "create_update":
        return []

    function_calls = _read_gemini_function_calls(body.event)
    if not function_calls:
        return []

    blocked_calls = [
        call
        for call in function_calls
        if (_string_from_any_key(call, "name") or "") in GEMINI_REVIEW_BLOCKED_TOOL_NAMES
    ]
    if not blocked_calls:
        return []

    return blocked_calls


def _artifact_review_emit_suppression_payload(
    body: GeminiBrowserDogfoodRelayRequest,
) -> dict[str, object] | None:
    blocked_calls = _suppressed_review_tool_calls(body)
    if not blocked_calls:
        return None

    guidance = (
        "Artifact review is active. Use read_artifact_text for exact artifact text and answer from the "
        "existing artifact unless the user explicitly asks to create or update an artifact."
    )
    function_responses: list[dict[str, object]] = []
    tool_diagnostics: list[dict[str, object]] = []

    for index, call in enumerate(blocked_calls):
        tool_call_id = _string_from_any_key(call, "id") or f"artifact-review-emit-{index + 1}"
        tool_name = _string_from_any_key(call, "name") or GEMINI_EMIT_ARTIFACT_TOOL_NAME
        response = {
            "ok": False,
            "status": "rejected",
            "safe_reason": ARTIFACT_REVIEW_EMIT_SUPPRESSED_REASON,
            "recovery_guidance": guidance,
            "raw_artifact_text_excluded": True,
        }
        function_responses.append({
            "id": tool_call_id,
            "name": tool_name,
            "response": response,
        })
        tool_diagnostics.append({
            "id": tool_call_id,
            "name": tool_name,
            "success": False,
            "execution_rejected": True,
            "rejection_reason": ARTIFACT_REVIEW_EMIT_SUPPRESSED_REASON,
            "recovery_guidance": guidance,
            "response": response,
        })

    return {
        "accepted": True,
        "client_actions": [
            {
                "type": "gemini_tool_response",
                "payload": {
                    "toolResponse": {
                        "functionResponses": function_responses,
                    },
                },
                "result_summary": "Review-only emit_artifact call suppressed.",
            },
        ],
        "tool_diagnostics": tool_diagnostics,
        "diagnostics": {
            "schema": "artifact_review_tool_guard_v1",
            "artifact_review_active": True,
            "artifact_review_user_intent": _artifact_review_user_intent(body.artifact_review_context),
            "review_tool_churn_detected": True,
            "suppressed_tool_count": len(blocked_calls),
            "suppressed_tools": sorted({
                _string_from_any_key(call, "name") or GEMINI_EMIT_ARTIFACT_TOOL_NAME
                for call in blocked_calls
            }),
            "raw_artifact_text_excluded": True,
        },
    }


async def _raise_voice_dogfood_error(response: httpx.Response) -> None:
    try:
        payload = response.json()
        detail = payload.get("detail") if isinstance(payload, dict) else None
    except ValueError:
        detail = response.text[:300]

    if not detail:
        detail = f"Voice dogfood request failed with HTTP {response.status_code}."

    status_code = response.status_code if response.status_code in {400, 404, 409, 422} else 502
    raise HTTPException(status_code=status_code, detail=detail)


async def _proxy_voice_dogfood_json(
    method: str,
    path: str,
    *,
    json_body: dict[str, object] | None = None,
    timeout: float = VOICE_SERVER_DOGFOOD_TIMEOUT,
) -> dict[str, object]:
    voice_url = _get_voice_server_url()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{voice_url}{path}",
                json=json_body,
            )
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice dogfood request timed out.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood request failed.",
        ) from exc

    if response.status_code >= 400:
        await _raise_voice_dogfood_error(response)

    if response.status_code == 202 and not response.content:
        return {"accepted": True}

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Voice dogfood server returned invalid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail="Voice dogfood server returned a non-object payload.",
        )

    return dict(payload)


async def _raise_voice_runtime_error(response: httpx.Response) -> None:
    try:
        payload = response.json()
        detail = payload.get("detail") if isinstance(payload, dict) else None
    except ValueError:
        detail = response.text[:300]

    if not detail:
        detail = f"Voice runtime request failed with HTTP {response.status_code}."

    status_code = response.status_code if response.status_code in {400, 404, 409, 422} else 502
    raise HTTPException(status_code=status_code, detail=detail)


async def _proxy_voice_runtime_json(
    method: str,
    path: str,
    *,
    json_body: dict[str, object] | None = None,
    timeout: float = VOICE_SERVER_PRODUCTION_RUNTIME_TIMEOUT,
) -> dict[str, object]:
    voice_url = _get_voice_server_url()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{voice_url}{path}",
                json=json_body,
            )
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice runtime server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice runtime request timed out.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice runtime request failed.",
        ) from exc

    if response.status_code >= 400:
        await _raise_voice_runtime_error(response)

    if response.status_code == 202 and not response.content:
        return {"accepted": True}

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned invalid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned a non-object payload.",
        )

    return dict(payload)


def _generate_stream_token(api_secret: str, user_id: str) -> str:
    """Generate a Stream user token using the getstream SDK.

    Falls back to a JWT-signed token if the SDK is unavailable.
    """
    try:
        from getstream import Stream

        client = Stream(api_key=_get_stream_api_key(), api_secret=api_secret)
        return client.create_token(user_id)
    except ImportError:
        pass

    # Fallback: manual JWT signing (Stream tokens are HS256 JWTs)
    import hashlib
    import hmac
    import json
    from base64 import urlsafe_b64encode

    header = urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).rstrip(b"=")
    payload = urlsafe_b64encode(
        json.dumps({"user_id": user_id, "iat": int(time.time())}).encode()
    ).rstrip(b"=")
    signing_input = header + b"." + payload
    signature = urlsafe_b64encode(
        hmac.new(api_secret.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")
    return (signing_input + b"." + signature).decode()


def _is_gemini_production_runtime_selected() -> bool:
    return _get_configured_voice_runtime_mode() == "gemini_live"


def _utc_iso_from_epoch(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, UTC).isoformat().replace("+00:00", "Z")


async def _start_gemini_production_voice_session(
    user_id: str,
    body: VoiceConnectRequest,
    request_base_url: str | None = None,
) -> GeminiVoiceConnectResponse:
    if not _gemini_production_route_enabled():
        raise HTTPException(
            status_code=409,
            detail=(
                "SOPHIA_VOICE_RUNTIME_MODE='gemini_live' is selected for the production "
                "voice route, but SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true is not set. "
                "Set the promotion flag to use Gemini here, or reset SOPHIA_VOICE_RUNTIME_MODE "
                "to 'legacy_cascade' to roll back."
            ),
        )

    session_id = f"gemini-prod-{uuid.uuid4().hex}"
    realtime_context = await _build_gemini_realtime_context_payload(
        user_id=user_id,
        body=body,
        session_id=session_id,
        request_base_url=request_base_url,
    )
    payload = await _proxy_voice_runtime_json(
        "POST",
        "/production/realtime/gemini/browser-sessions",
        json_body={
            "user_id": user_id,
            "session_id": session_id,
            "platform": body.platform,
            "context_mode": body.context_mode,
            "ritual": body.ritual,
            "realtime_context": realtime_context,
            **(
                {
                    "preconnect": True,
                    "preconnect_ttl_seconds": GEMINI_PRECONNECT_SERVER_CLEANUP_SECONDS,
                }
                if body.preconnect
                else {}
            ),
        },
    )

    returned_session_id = payload.get("session_id")
    if not isinstance(returned_session_id, str):
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned a Gemini bootstrap without session_id.",
        )

    stream_url = _build_gemini_production_events_stream_url(returned_session_id)
    payload["runtime"] = "gemini_live"
    payload["voice_runtime"] = "gemini_live"
    payload["production_route"] = True
    payload["thread_id"] = body.thread_id
    payload["stream_url"] = stream_url
    payload["event_stream_url"] = stream_url
    payload["provider_event_relay_url"] = _build_gemini_production_relay_url()
    payload["disconnect_url"] = _build_gemini_production_disconnect_url()
    payload["preconnect"] = body.preconnect
    if body.preconnect:
        payload["preconnect_ttl_ms"] = GEMINI_PRECONNECT_CLIENT_TTL_MS
        payload["preconnect_expires_at"] = _utc_iso_from_epoch(
            time.time() + (GEMINI_PRECONNECT_CLIENT_TTL_MS / 1000),
        )
    return GeminiVoiceConnectResponse.model_validate(payload)


async def _build_gemini_realtime_context_payload(
    *,
    user_id: str,
    body: VoiceConnectRequest,
    session_id: str,
    request_base_url: str | None = None,
) -> dict[str, Any]:
    request = RealtimeContextRequest(
        thread_id=body.thread_id,
        session_id=session_id,
        platform=body.platform,
        context_mode=body.context_mode,
        ritual=body.ritual,
    )
    try:
        context = await asyncio.to_thread(
            build_sophia_realtime_context,
            user_id=user_id,
            request=request,
        )
    except Exception:
        logger.warning("voice.gemini.context_fetch_failed user_id=%s", user_id, exc_info=True)
        context = build_degraded_realtime_context_response(
            reason="gateway_context_fetch_failed",
            limit=request.limit,
        )
    payload = context.model_dump(mode="json")
    diagnostics = payload.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict):
        diagnostics["dynamic_retrieve_configured"] = False
    if request_base_url:
        grant = create_realtime_memory_retrieval_grant(
            user_id=user_id,
            session_id=session_id,
        )
        base_url = _canonicalize_gemini_callback_base_url(request_base_url)
        payload["dynamic_memory_retrieval"] = {
            "schema": REALTIME_DYNAMIC_MEMORY_RETRIEVAL_SCHEMA,
            "endpoint_url": f"{base_url}/internal/sophia-realtime/memories/retrieve",
            "token": grant.token,
            "token_header": REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER,
            "expires_at": grant.expires_at_iso,
            "source": "gateway",
        }
        if isinstance(diagnostics, dict):
            diagnostics["dynamic_retrieve_configured"] = True
            diagnostics["dynamic_retrieve_source"] = "gateway"
            diagnostics["dynamic_retrieve_token_excluded"] = True
    return payload


def _canonicalize_gemini_callback_base_url(base_url: str) -> str:
    cleaned = base_url.strip().rstrip("/")
    if not cleaned:
        return cleaned
    if "://" not in cleaned:
        cleaned = f"https://{cleaned}"

    parsed = urlsplit(cleaned)
    if parsed.hostname and parsed.hostname.lower().endswith(".onrender.com"):
        parsed = parsed._replace(scheme="https")
    return urlunsplit(parsed).rstrip("/")


@router.post(
    "/{user_id}/voice/connect",
    response_model=VoiceConnectResponse | GeminiVoiceConnectResponse | GeminiVoicePreconnectSkippedResponse,
    summary="Start a voice session",
    description="Generate Stream credentials for the frontend and signal the Voice Agent to join.",
)
async def voice_connect(
    user_id: str,
    body: VoiceConnectRequest,
    request: Request,
) -> VoiceConnectResponse | GeminiVoiceConnectResponse | GeminiVoicePreconnectSkippedResponse:
    """Create a Stream call, dispatch the voice agent, and return credentials."""

    if body.platform not in SUPPORTED_PLATFORMS:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid platform '{body.platform}'. Must be one of: {', '.join(sorted(SUPPORTED_PLATFORMS))}",
        )

    if body.context_mode not in SUPPORTED_CONTEXT_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid context_mode '{body.context_mode}'. Must be one of: {', '.join(sorted(SUPPORTED_CONTEXT_MODES))}",
        )

    if _is_gemini_production_runtime_selected():
        lock = await _get_active_voice_session_lock(user_id)
        async with lock:
            previous_session = _active_voice_sessions.get(user_id)
            if body.preconnect and previous_session is not None:
                logger.info(
                    "voice.connect preconnect skipped because active session exists user_id=%s runtime=%s session_id=%s",
                    user_id,
                    previous_session.runtime,
                    previous_session.session_id,
                )
                return GeminiVoicePreconnectSkippedResponse(
                    session_id=previous_session.session_id,
                    thread_id=body.thread_id,
                )

            gemini_response = await _start_gemini_production_voice_session(
                user_id,
                body,
                request_base_url=str(request.base_url),
            )
            previous_session = _active_voice_sessions.get(user_id)
            if previous_session is not None:
                logger.info(
                    "voice.connect closing previous session (background) user_id=%s runtime=%s call_id=%s session_id=%s",
                    user_id,
                    previous_session.runtime,
                    previous_session.call_id,
                    previous_session.session_id,
                )
                _schedule_background_active_session_disconnect(previous_session)
            _active_voice_sessions[user_id] = ActiveVoiceSession(
                call_id=gemini_response.session_id,
                session_id=gemini_response.session_id,
                runtime="gemini_live",
            )

        logger.info(
            "voice.connect user_id=%s runtime=gemini_live preconnect=%s platform=%s context_mode=%s ritual=%s session_id=%s",
            user_id,
            body.preconnect,
            body.platform,
            body.context_mode,
            body.ritual,
            gemini_response.session_id,
        )
        return gemini_response

    api_key = _get_stream_api_key()
    api_secret = _get_stream_api_secret()

    call_id = f"sophia-{_sanitize_call_id_fragment(user_id)}-{uuid.uuid4().hex[:8]}"
    call_type = "default"
    token = _generate_stream_token(api_secret, user_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        previous_session = _active_voice_sessions.get(user_id)
        if previous_session is not None:
            logger.info(
                "voice.connect closing previous session (background) user_id=%s call_id=%s session_id=%s",
                user_id,
                previous_session.call_id,
                previous_session.session_id,
            )
            # Fire-and-forget: don't block the new connect on the previous
            # session's teardown. The previous call_id is independent of the
            # new one (Stream SFU routes by call_id), so there's no race.
            _schedule_background_active_session_disconnect(previous_session)
            if _active_voice_sessions.get(user_id) == previous_session:
                _active_voice_sessions.pop(user_id, None)

        session_id = await _dispatch_voice_agent(
            call_id=call_id,
            call_type=call_type,
            platform=body.platform,
            context_mode=body.context_mode,
            ritual=body.ritual,
            session_id=body.session_id,
            thread_id=body.thread_id,
        )

        if session_id:
            _active_voice_sessions[user_id] = ActiveVoiceSession(
                call_id=call_id,
                session_id=session_id,
                runtime="legacy_cascade",
            )

    logger.info(
        "voice.connect user_id=%s platform=%s context_mode=%s ritual=%s companion_session_id=%s thread_id=%s call_id=%s session_id=%s",
        user_id,
        body.platform,
        body.context_mode,
        body.ritual,
        body.session_id,
        body.thread_id,
        call_id,
        session_id,
    )

    return VoiceConnectResponse(
        api_key=api_key,
        token=token,
        call_type=call_type,
        call_id=call_id,
        thread_id=body.thread_id,
        stream_url=_build_voice_events_stream_url(user_id, call_id, session_id),
        session_id=session_id,
    )


@router.get(
    "/{user_id}/voice/events",
    summary="Stream voice session events",
    description="Proxy the voice service SSE stream to the authenticated browser client.",
)
async def voice_events(
    user_id: str,
    call_id: str = Query(..., description="The voice call ID returned from /voice/connect"),
    session_id: str = Query(..., description="The voice session ID returned from /voice/connect"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions/{session_id}/events"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers={"Accept": "text/event-stream"},
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/openai/browser-session",
    status_code=201,
    summary="Start an OpenAI browser WebRTC dogfood session",
    description="Internal dogfood path: mint an ephemeral OpenAI client secret and start normalized SSE routing.",
)
async def openai_browser_dogfood_session(
    user_id: str,
    body: OpenAIBrowserDogfoodStartRequest,
) -> dict[str, object]:
    payload = await _proxy_voice_dogfood_json(
        "POST",
        "/dogfood/realtime/openai/browser-sessions",
        json_body={
            "user_id": user_id,
            "session_id": body.session_id,
        },
    )
    session_id = payload.get("session_id")
    if isinstance(session_id, str):
        payload["stream_url"] = _build_openai_dogfood_events_stream_url(user_id, session_id)
    return payload


@router.post(
    "/{user_id}/voice/dogfood/openai/sideband",
    status_code=202,
    summary="Attach OpenAI browser WebRTC backend sideband",
)
async def openai_browser_dogfood_sideband(
    user_id: str,
    body: OpenAISidebandAttachRequest,
) -> dict[str, object]:
    encoded_session_id = quote(body.session_id, safe="")
    payload = await _proxy_voice_dogfood_json(
        "POST",
        f"/dogfood/realtime/openai/browser-sessions/{encoded_session_id}/sideband",
        json_body={
            "call_id": body.call_id,
            "location": body.location,
            "webrtc_readiness": body.webrtc_readiness,
        },
        timeout=VOICE_SERVER_DOGFOOD_SIDEBAND_TIMEOUT,
    )
    payload["stream_url"] = _build_openai_dogfood_events_stream_url(user_id, body.session_id)
    return payload


@router.get(
    "/{user_id}/voice/dogfood/openai/events",
    summary="Stream OpenAI browser dogfood normalized events",
    description="Proxy the voice service dogfood SSE stream to the authenticated browser client.",
)
async def openai_browser_dogfood_events(
    user_id: str,
    session_id: str = Query(..., description="Dogfood session id returned by browser-session"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/dogfood/realtime/sessions/{encoded_session_id}/events"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers={"Accept": "text/event-stream"},
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice dogfood session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice dogfood event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/openai/disconnect",
    status_code=204,
    summary="Close an OpenAI browser WebRTC dogfood session",
)
async def openai_browser_dogfood_disconnect(
    user_id: str,
    body: OpenAIBrowserDogfoodDisconnectRequest,
) -> None:
    encoded_session_id = quote(body.session_id, safe="")
    await _proxy_voice_dogfood_json(
        "DELETE",
        f"/dogfood/realtime/openai/browser-sessions/{encoded_session_id}",
    )


@router.post(
    "/{user_id}/voice/dogfood/gemini/browser-session",
    status_code=201,
    summary="Start a Gemini browser Live WebSocket dogfood session",
    description="Internal dogfood path: mint an ephemeral Gemini auth token and start normalized SSE routing.",
)
async def gemini_browser_dogfood_session(
    user_id: str,
    body: GeminiBrowserDogfoodStartRequest,
) -> dict[str, object]:
    payload = await _proxy_voice_dogfood_json(
        "POST",
        "/dogfood/realtime/gemini/browser-sessions",
        json_body={
            "user_id": user_id,
            "session_id": body.session_id,
        },
    )
    session_id = payload.get("session_id")
    if isinstance(session_id, str):
        payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, session_id)
    return payload


@router.post(
    "/{user_id}/voice/dogfood/gemini/relay",
    status_code=202,
    summary="Relay a Gemini browser Live server message",
)
async def gemini_browser_dogfood_relay(
    user_id: str,
    body: GeminiBrowserDogfoodRelayRequest,
) -> dict[str, object]:
    encoded_session_id = quote(body.session_id, safe="")
    guard_payload = _artifact_review_emit_suppression_payload(body)
    if guard_payload is not None:
        guard_payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, body.session_id)
        return guard_payload

    payload = await _proxy_voice_dogfood_json(
        "POST",
        f"/dogfood/realtime/gemini/browser-sessions/{encoded_session_id}/provider-events",
        json_body=body.voice_relay_payload(),
    )
    payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, body.session_id)
    return payload


@router.get(
    "/{user_id}/voice/dogfood/gemini/events",
    summary="Stream Gemini browser dogfood normalized events",
    description="Proxy the voice service dogfood SSE stream to the authenticated browser client.",
)
async def gemini_browser_dogfood_events(
    user_id: str,
    session_id: str = Query(..., description="Dogfood session id returned by browser-session"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/dogfood/realtime/sessions/{encoded_session_id}/events"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers={"Accept": "text/event-stream"},
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice dogfood session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice dogfood event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/gemini/disconnect",
    status_code=204,
    summary="Close a Gemini browser Live WebSocket dogfood session",
)
async def gemini_browser_dogfood_disconnect(
    user_id: str,
    body: GeminiBrowserDogfoodDisconnectRequest,
) -> None:
    encoded_session_id = quote(body.session_id, safe="")
    await _proxy_voice_dogfood_json(
        "DELETE",
        f"/dogfood/realtime/gemini/browser-sessions/{encoded_session_id}",
    )


@router.post(
    "/{user_id}/voice/gemini/relay",
    status_code=202,
    summary="Relay a production Gemini browser Live server message",
)
async def gemini_production_relay(
    user_id: str,
    body: GeminiBrowserDogfoodRelayRequest,
) -> dict[str, object]:
    encoded_session_id = quote(body.session_id, safe="")
    log_context = _gemini_relay_log_context(user_id=user_id, session_id=body.session_id, body=body)
    guard_payload = _artifact_review_emit_suppression_payload(body)
    if guard_payload is not None:
        logger.info(
            "voice.gemini.relay suppressed review emit_artifact context=%s",
            log_context,
        )
        guard_payload["stream_url"] = _build_gemini_production_events_stream_url(body.session_id)
        return guard_payload

    try:
        payload = await _proxy_voice_runtime_json(
            "POST",
            f"/production/realtime/gemini/browser-sessions/{encoded_session_id}/provider-events",
            json_body=body.voice_relay_payload(),
        )
    except HTTPException as exc:
        logger.warning(
            "voice.gemini.relay failed status=%s detail=%s context=%s",
            exc.status_code,
            _safe_voice_error_detail(exc.detail),
            log_context,
        )
        raise
    logger.info(
        "voice.gemini.relay accepted status=202 context=%s",
        log_context,
    )
    payload["stream_url"] = _build_gemini_production_events_stream_url(body.session_id)
    return payload


@router.get(
    "/{user_id}/voice/gemini/events",
    summary="Stream production Gemini normalized events",
    description="Proxy the voice service Gemini production SSE stream to the authenticated browser client.",
)
async def gemini_production_events(
    user_id: str,
    session_id: str = Query(..., description="Gemini production session id returned by /voice/connect"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/production/realtime/gemini/sessions/{encoded_session_id}/events"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers={"Accept": "text/event-stream"},
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice Gemini event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice Gemini event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice Gemini session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice Gemini event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/gemini/disconnect",
    status_code=204,
    summary="Close a production Gemini browser Live session",
)
async def gemini_production_disconnect(
    user_id: str,
    body: GeminiBrowserDogfoodDisconnectRequest,
) -> None:
    await _disconnect_gemini_production_session(body.session_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        active_session = _active_voice_sessions.get(user_id)
        if (
            active_session is not None
            and active_session.runtime == "gemini_live"
            and active_session.session_id == body.session_id
        ):
            _active_voice_sessions.pop(user_id, None)


@router.post(
    "/{user_id}/voice/warmup",
    status_code=202,
    summary="Warm backend session path",
    description="Schedule a best-effort Sophia backend warmup for an active voice session.",
)
async def voice_warmup(user_id: str, body: VoiceWarmupRequest) -> None:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{body.call_id}/sessions/{body.session_id}/warmup"

    try:
        async with httpx.AsyncClient(timeout=VOICE_SERVER_WARMUP_TIMEOUT) as client:
            resp = await client.post(
                url,
                json={"user_id": user_id},
            )
            resp.raise_for_status()
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice warmup failed because the voice server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice warmup timed out.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Voice warmup failed with status {exc.response.status_code}.",
        ) from exc


async def _dispatch_voice_agent(
    call_id: str,
    call_type: str,
    platform: str,
    context_mode: str,
    ritual: str | None,
    session_id: str | None = None,
    thread_id: str | None = None,
) -> str | None:
    """Tell the Vision Agents voice server to spawn an agent for this call.

    Returns the session_id on success, or None if the voice server is unavailable
    (logged as a warning — the call proceeds without an agent so the frontend
    can display an appropriate error state rather than hanging).
    """
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions"

    try:
        async with httpx.AsyncClient(timeout=VOICE_SERVER_DISPATCH_TIMEOUT) as client:
            resp = await client.post(
                url,
                json={
                    "call_type": call_type,
                    "platform": platform,
                    "context_mode": context_mode,
                    "ritual": ritual,
                    "session_id": session_id,
                    "thread_id": thread_id,
                },
            )
            resp.raise_for_status()
            try:
                data = resp.json()
            except ValueError:
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid JSON for call_id=%s",
                    call_id,
                )
                return None

            if not isinstance(data, dict):
                logger.warning(
                    "voice.dispatch failed — voice server returned non-object payload for call_id=%s",
                    call_id,
                )
                return None

            session_id = data.get("session_id")
            if session_id is not None and not isinstance(session_id, str):
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid session_id for call_id=%s",
                    call_id,
                )
                return None

            logger.info("voice.dispatch call_id=%s session_id=%s", call_id, session_id)
            return session_id
    except httpx.ConnectError:
        logger.warning("voice.dispatch failed — voice server unreachable at %s", voice_url)
        return None
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.dispatch failed — voice server returned %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return None
    except httpx.TimeoutException:
        logger.warning("voice.dispatch timed out after %.1fs for call_id=%s", VOICE_SERVER_DISPATCH_TIMEOUT, call_id)
        return None
    except httpx.RequestError as exc:
        logger.warning(
            "voice.dispatch failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )
        return None


@router.post(
    "/{user_id}/voice/disconnect",
    status_code=204,
    summary="End a voice session",
    description="Signal the Voice Agent to leave the call. Falls back to idle timeout if unreachable.",
)
async def voice_disconnect(user_id: str, body: VoiceDisconnectRequest) -> None:
    """Request the voice server to close the agent session."""
    await _disconnect_voice_session(body.call_id, body.session_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        active_session = _active_voice_sessions.get(user_id)
        if active_session == ActiveVoiceSession(call_id=body.call_id, session_id=body.session_id):
            _active_voice_sessions.pop(user_id, None)

    logger.info(
        "voice.disconnect user_id=%s call_id=%s session_id=%s",
        user_id,
        body.call_id,
        body.session_id,
    )


async def _disconnect_voice_session(call_id: str, session_id: str) -> None:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions/{session_id}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.delete(url)
            if resp.status_code == 404:
                logger.info(
                    "voice.disconnect session already gone call_id=%s session_id=%s",
                    call_id,
                    session_id,
                )
                return
            resp.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.disconnect — voice server unreachable, relying on idle timeout for call_id=%s",
            call_id,
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.disconnect failed — %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        logger.warning(
            "voice.disconnect failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )


async def _disconnect_gemini_production_session(session_id: str) -> None:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/production/realtime/gemini/browser-sessions/{encoded_session_id}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.delete(url)
            if resp.status_code == 404:
                logger.info(
                    "voice.gemini.disconnect session already gone session_id=%s",
                    session_id,
                )
                return
            resp.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.gemini.disconnect — voice server unreachable, relying on idle timeout for session_id=%s",
            session_id,
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.gemini.disconnect failed — %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        logger.warning(
            "voice.gemini.disconnect failed — request error for session_id=%s: %s",
            session_id,
            exc,
        )
