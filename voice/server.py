from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.core.llm.llm import LLMResponseEvent
from vision_agents.core.runner.http.api import lifespan as runner_http_lifespan
from vision_agents.core.runner.http.api import router as runner_http_router
from vision_agents.core.runner.http.dependencies import (
    can_close_session,
    can_start_session,
    can_view_metrics,
    can_view_session,
    get_launcher,
)
from vision_agents.core.runner.http.models import StartSessionResponse
from vision_agents.core.runner.http.options import ServeOptions
from vision_agents.plugins.deepgram import STT as DeepgramSTT
from vision_agents.plugins.getstream import Edge as StreamEdge

from voice.config import get_settings
from voice.conversation_flow import ConversationFlowCoordinator
from voice.realtime.dogfood_session import (
    RealtimeDogfoodConfigurationError,
    RealtimeDogfoodSession,
    RealtimeDogfoodSessionManager,
)
from voice.realtime.gemini_browser_dogfood import (
    GeminiBrowserDogfoodSessionManager,
    GeminiBrowserRelayError,
    GeminiEphemeralTokenMintError,
    GeminiRelaySourceMetadata,
)
from voice.realtime.gemini_production_session import GeminiProductionBrowserSessionManager
from voice.realtime.openai_browser_dogfood import (
    OpenAIBrowserDogfoodSessionManager,
    OpenAIClientSecretMintError,
    OpenAISidebandAttachError,
    extract_openai_call_id_from_location,
)
from voice.realtime.runtime_factory import build_realtime_runtime_bundle_from_settings
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.rhythm import RhythmTracker
from voice.sophia_llm import SophiaLLM
from voice.sophia_tts import SophiaTTS
from voice.sophia_turn import SophiaTurnDetection
from voice.sse_broker import VoiceEventBroker, format_sse_event
from voice.vision_agents_compat import (
    InvalidCallId,
    MaxConcurrentSessionsExceeded,
    MaxSessionsPerCallExceeded,
    STTErrorEvent,
    STTPartialTranscriptEvent,
    STTTranscriptEvent,
    TTSSynthesisStartEvent,
    TurnEndedEvent,
    resolve_agent_constructor_kwargs,
)
from voice.internal_auth import (
    capability_for_production_action,
    capability_for_production_start,
    capability_for_retention_reap,
    require_voice_internal_auth,
    voice_security_readiness,
    voice_service_identity,
)

logger = logging.getLogger(__name__)
voice_event_broker = VoiceEventBroker()
realtime_dogfood_sessions = RealtimeDogfoodSessionManager()
openai_browser_dogfood_sessions = OpenAIBrowserDogfoodSessionManager(realtime_dogfood_sessions)
gemini_browser_dogfood_sessions = GeminiBrowserDogfoodSessionManager(realtime_dogfood_sessions)
gemini_production_browser_sessions = GeminiProductionBrowserSessionManager(gemini_browser_dogfood_sessions)

VOICE_LAB_TRACE_FAULT_SCENARIO_ID = "V-L01"
VOICE_LAB_TRACE_FAULT_MODE = "langsmith_unavailable"
VOICE_LAB_TRACE_FAULT_SCHEMA = "sophia_voice_lab_trace_fault_v1"


@asynccontextmanager
async def _sophia_voice_lifespan(app: FastAPI):  # noqa: ANN201
    async with runner_http_lifespan(app):
        try:
            yield
        finally:
            await gemini_production_browser_sessions.close_all()


def _voice_event_cursor(request: Request) -> int | None:
    candidates = (
        request.headers.get("last-event-id"),
        request.query_params.get("last_event_id"),
        request.query_params.get("lastEventId"),
    )
    for raw_cursor in candidates:
        if raw_cursor is None:
            continue
        try:
            cursor = int(raw_cursor)
        except (TypeError, ValueError):
            continue
        if cursor >= 0:
            return cursor
    return None


def _has_substantive_transcript(text: str) -> bool:
    return any(char.isalnum() for char in text)


def _safe_prefix(value: object, *, length: int = 24) -> str | None:
    return value[:length] if isinstance(value, str) and value else None


def _gemini_relay_context(
    session_id: str,
    request: SophiaGeminiBrowserRelayRequest,
) -> dict[str, object]:
    return {
        "session_id_prefix": _safe_prefix(session_id),
        "relay_correlation_id": _safe_prefix(request.relay_correlation_id),
        "provider_receive_sequence": request.provider_receive_sequence,
        "provider_relay_sequence": request.provider_relay_sequence,
        "provider_primary_category": request.provider_primary_category,
        "provider_categories": list(request.provider_categories or [])[:6],
    }


class SophiaStartSessionRequest(BaseModel):
    """Request body for joining a call with Sophia-specific runtime context."""

    call_type: str = Field(default="default", description="Type of the call to join")
    platform: str = Field(default="voice", description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(
        default=None,
        description="Active ritual: prepare | debrief | vent | reset | None",
    )
    session_id: str | None = Field(
        default=None,
        description="Frontend companion session ID for continuity",
    )
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID to reuse for this voice session",
    )


class SophiaWarmupSessionRequest(BaseModel):
    """Request body for prewarming the backend path for an active Sophia session."""

    user_id: str = Field(..., description="Authenticated user ID for the upcoming turn")


class SophiaRealtimeDogfoodStartRequest(BaseModel):
    """Internal-only request body for an experimental provider event-pump session."""

    user_id: str = Field(default="dogfood-user", description="Internal dogfood user id")
    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")
    instructions: str | None = Field(default=None, description="Optional provider session instructions override")


class SophiaRealtimeDogfoodTextRequest(BaseModel):
    """Internal-only text input for a provider-owned dogfood session."""

    text: str = Field(..., min_length=1, description="Text input to send to the provider session")


class SophiaRealtimeDogfoodProviderEventRequest(BaseModel):
    """Internal-only raw provider event ingress.

    This endpoint accepts provider wire payloads so dogfood harnesses can feed
    real or recorded provider messages into the adapter. It never returns those
    payloads to the browser-facing event stream.
    """

    event: dict[str, Any] = Field(..., description="Raw provider event/message payload")


class SophiaOpenAIBrowserDogfoodStartRequest(BaseModel):
    """Internal-only request body for OpenAI browser WebRTC dogfood."""

    user_id: str = Field(default="dogfood-user", description="Internal dogfood user id")
    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")
    instructions: str | None = Field(default=None, description="Optional provider session instructions override")


class SophiaOpenAISidebandAttachRequest(BaseModel):
    """OpenAI browser WebRTC call id produced by the browser SDP exchange."""

    call_id: str | None = Field(
        default=None,
        description="OpenAI Realtime rtc_* call id parsed from the WebRTC Location header",
    )
    location: str | None = Field(
        default=None,
        description="Optional raw Location header from POST /v1/realtime/calls",
    )
    webrtc_readiness: dict[str, Any] | None = Field(
        default=None,
        description="Browser-observed WebRTC readiness evidence collected before sideband attach",
    )
    call_diagnostics: dict[str, Any] | None = Field(
        default=None,
        description="Browser-captured SDP status, raw Location header, extracted rtc_* id, and shape diagnostics",
    )


class SophiaGeminiBrowserDogfoodStartRequest(BaseModel):
    """Internal-only request body for Gemini browser Live WebSocket dogfood."""

    user_id: str = Field(default="dogfood-user", description="Internal dogfood user id")
    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")


class SophiaGeminiSyntheticToolEvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema: str = Field(pattern=r"^sophia_synthetic_tool_evidence_v1$")
    test_run_id: str = Field(min_length=1, max_length=512)
    scenario_id: str = Field(min_length=1, max_length=512)
    scenario_version: str = Field(min_length=1, max_length=512)
    operation_id: str = Field(min_length=1, max_length=512)
    utterance_id: str = Field(min_length=1, max_length=512)
    provider_input_sequence: int = Field(gt=0)
    public_utterance_id: str | None = Field(default=None, min_length=1, max_length=512)
    tool_call_id: str = Field(min_length=1, max_length=512)
    effect_id: str = Field(pattern=r"^effect:[0-9a-f-]{36}$")
    provider_connection_epoch: int = Field(gt=0)
    relay_correlation_id: str = Field(min_length=1, max_length=512)
    tool_name: str = Field(min_length=1, max_length=256)
    received_at: str = Field(min_length=1, max_length=64)


class SophiaGeminiBrowserRelayRequest(BaseModel):
    """Browser-captured Gemini Live server message for normalized observation."""

    event: dict[str, Any] = Field(..., description="Raw Gemini Live server message payload")
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
    provider_connection_epoch: int | None = Field(default=None, gt=0)
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
    synthetic_tool_evidence: list[SophiaGeminiSyntheticToolEvidenceRequest] = Field(
        default_factory=list,
        max_length=16,
    )

    def source_metadata(self) -> GeminiRelaySourceMetadata | None:
        return GeminiRelaySourceMetadata.from_relay_fields(
            provider_receive_sequence=self.provider_receive_sequence,
            provider_relay_sequence=self.provider_relay_sequence,
            provider_connection_epoch=self.provider_connection_epoch,
            provider_received_at=self.provider_received_at,
            relay_correlation_id=self.relay_correlation_id,
            provider_primary_category=self.provider_primary_category,
            provider_categories=self.provider_categories,
            synthetic_tool_evidence=[
                item.model_dump(mode="json") for item in self.synthetic_tool_evidence
            ],
        )


class SophiaGeminiBrowserDisconnectRequest(BaseModel):
    """Close a Gemini browser session and optionally attach its combined audio."""

    session_id: str = Field(..., description="Gemini browser session id")
    conversation_audio_base64: str | None = Field(
        default=None,
        max_length=28_000_000,
        description="Optional browser-recorded combined conversation audio, base64 encoded",
    )
    conversation_audio_mime_type: str = Field(
        default="audio/webm",
        description="MIME type for the optional combined conversation recording",
    )


class SophiaGeminiProductionStartRequest(BaseModel):
    """Production-route Gemini browser Live bootstrap request."""

    user_id: str = Field(..., description="Trusted authenticated user id")
    session_id: str | None = Field(default=None, description="Optional deterministic realtime session id")
    logical_session_id: str | None = Field(default=None, description="Authenticated Sophia session id")
    thread_id: str | None = Field(default=None, description="Related Sophia conversation thread id")
    platform: str = Field(default="voice", description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(default=None, description="Active ritual: prepare | debrief | vent | reset | None")
    realtime_context: dict[str, Any] | None = Field(
        default=None,
        description="Backend-owned bounded realtime context payload for setup-time continuity",
    )
    preconnect: bool = Field(
        default=False,
        description="True when this bootstrap was prepared before the user clicked the microphone",
    )
    preconnect_ttl_seconds: float | None = Field(
        default=None,
        description="Best-effort cleanup TTL for an unused preconnect bootstrap",
    )
    synthetic_test: dict[str, str | bool | int] | None = Field(
        default=None,
        description="Gateway-authenticated synthetic run identity; never accepted without a capability.",
    )
    synthetic_trace_mode: str | None = Field(
        default=None,
        description="Gateway-authorized synthetic-only trace outage mode.",
    )
    cleanup_admission_id: str | None = Field(
        default=None,
        description="Gateway-authored opaque provider allocation admission.",
    )
    cleanup_admission_expires_at: str | None = Field(
        default=None,
        description="Exact admission quiescence deadline for rolling replicas.",
    )
    cleanup_resource_expires_at: str | None = Field(
        default=None,
        description="Provider-enforced immutable absolute message deadline.",
    )


class SophiaGeminiContinuationBootstrapRequest(BaseModel):
    expected_epoch: int = Field(..., gt=0)
    handle_present: bool = False
    secret_generation: int = Field(default=0, ge=0)


class SophiaGeminiProviderActivationRequest(BaseModel):
    previous_activated_epoch: int = Field(ge=0)
    candidate_epoch: int = Field(gt=0)


def _provider_cleanup_admission_deadline(
    body: SophiaGeminiProductionStartRequest,
    *,
    synthetic: bool,
) -> tuple[float | None, float | None]:
    admission_id = body.cleanup_admission_id
    raw_deadline = body.cleanup_admission_expires_at
    raw_resource_deadline = body.cleanup_resource_expires_at
    if not synthetic:
        if (
            admission_id is not None
            or raw_deadline is not None
            or raw_resource_deadline is not None
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "voice_cleanup_admission_not_allowed"},
            )
        return None, None
    try:
        parsed_id = UUID(str(admission_id))
        parsed_deadline = datetime.fromisoformat(
            str(raw_deadline).replace("Z", "+00:00")
        ).astimezone(UTC)
        parsed_resource_deadline = datetime.fromisoformat(
            str(raw_resource_deadline).replace("Z", "+00:00")
        ).astimezone(UTC)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "voice_lab_cleanup_admission_invalid"},
        ) from None
    canonical_deadline = (
        parsed_deadline.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
    canonical_resource_deadline = (
        parsed_resource_deadline.isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    deadline_epoch = parsed_deadline.timestamp()
    if (
        parsed_id.version != 4
        or str(parsed_id) != admission_id
        or canonical_deadline != raw_deadline
        or canonical_resource_deadline != raw_resource_deadline
        or body.session_id is None
        or parsed_resource_deadline < parsed_deadline
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "voice_lab_cleanup_admission_invalid"},
        )
    return deadline_epoch, parsed_resource_deadline.timestamp()


_internal_dependencies = [Depends(require_voice_internal_auth)]
session_router = APIRouter(dependencies=_internal_dependencies)
dogfood_router = APIRouter(
    prefix="/dogfood/realtime",
    tags=["internal-realtime-dogfood"],
    dependencies=_internal_dependencies,
)
production_realtime_router = APIRouter(
    prefix="/production/realtime",
    tags=["production-realtime"],
    dependencies=_internal_dependencies,
)


def _capability_for_existing_production_session(
    request: Request,
    session_id: str,
    *,
    required_operation: str,
    allow_kill_switch: bool,
):
    synthetic_context = gemini_production_browser_sessions.synthetic_context_for_session(
        session_id
    )
    user_id = (
        str(synthetic_context.get("principal_id"))
        if synthetic_context is not None
        else "ordinary-production-session"
    )
    return capability_for_production_action(
        request,
        user_id=user_id,
        synthetic_context=synthetic_context,
        required_operation=required_operation,
        allow_kill_switch=allow_kill_switch,
    )


def _trace_fault_receipt(
    claims: object,
    *,
    phase: str,
    applied_at: str | None = None,
) -> dict[str, object]:
    now = (
        datetime.now(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    resolved_applied_at = applied_at or now
    return {
        "schema": VOICE_LAB_TRACE_FAULT_SCHEMA,
        "fault": VOICE_LAB_TRACE_FAULT_MODE,
        "phase": phase,
        "principal_id": getattr(claims, "principal_id"),
        "test_run_id": getattr(claims, "test_run_id"),
        "scenario_id": getattr(claims, "scenario_id"),
        "scenario_version": getattr(claims, "scenario_version"),
        "environment": getattr(claims, "environment"),
        "expected_deployment": dict(getattr(claims, "expected_deployment")),
        "trace_unavailable": True,
        "canonical_behavior_unchanged": True,
        "applied_at": resolved_applied_at,
        "restored_at": now if phase == "restored" else None,
    }


def _finalize_or_recover_capability_for_existing_production_session(
    request: Request,
    session_id: str,
):
    synthetic_context = gemini_production_browser_sessions.synthetic_context_for_session(
        session_id
    )
    if (
        synthetic_context is None
        and not gemini_production_browser_sessions.session_exists(session_id)
        and bool(request.headers.get("X-Sophia-Voice-Lab-Capability"))
    ):
        return capability_for_retention_reap(
            request,
            provider_session_id=session_id,
            synthetic_context=None,
        )
    try:
        return _capability_for_existing_production_session(
            request,
            session_id,
            required_operation="session:finalize",
            allow_kill_switch=True,
        )
    except HTTPException as exc:
        if exc.detail != {"code": "voice_lab_capability_operation_denied"}:
            raise
    try:
        return _capability_for_existing_production_session(
            request,
            session_id,
            required_operation="session:recover",
            allow_kill_switch=True,
        )
    except HTTPException as exc:
        if exc.detail != {"code": "voice_lab_capability_operation_denied"}:
            raise
    return capability_for_retention_reap(
        request,
        provider_session_id=session_id,
        synthetic_context=synthetic_context,
    )


def _bind_agent_session_context(
    agent: Agent,
    *,
    platform: str,
    context_mode: str,
    ritual: str | None,
    session_id: str | None,
    thread_id: str | None,
) -> None:
    llm = getattr(agent, "llm", None)
    bind_session_context = getattr(llm, "bind_session_context", None)
    if not callable(bind_session_context):
        raise RuntimeError("Agent LLM does not support runtime session context binding.")

    bind_session_context(
        platform=platform,
        context_mode=context_mode,
        ritual=ritual,
        session_id=session_id,
        thread_id=thread_id,
    )


def _attach_agent_event_emitter(
    agent: Agent,
    *,
    call_id: str,
    session_id: str,
) -> None:
    llm = getattr(agent, "llm", None)
    attach_call_emitter = getattr(llm, "attach_call_emitter", None)
    if not callable(attach_call_emitter):
        raise RuntimeError("Agent LLM does not support runtime event emitter binding.")

    async def _emit(payload: dict[str, object]) -> None:
        await agent.send_custom_event(payload)
        await voice_event_broker.publish(call_id, session_id, payload)

    attach_call_emitter(_emit)


def _schedule_agent_backend_warmup(
    agent: Agent,
    *,
    user_id: str,
) -> bool:
    llm = getattr(agent, "llm", None)
    start_backend_warmup = getattr(llm, "start_backend_warmup", None)
    if not callable(start_backend_warmup):
        raise RuntimeError("Agent LLM does not support backend warmup scheduling.")

    return bool(start_backend_warmup(user_id))


def _schedule_agent_tts_warmup(agent: Agent) -> bool:
    tts = getattr(agent, "tts", None)
    start_warmup = getattr(tts, "start_warmup", None)
    if not callable(start_warmup):
        return False

    return bool(start_warmup())


@session_router.post(
    "/calls/{call_id}/sessions",
    response_model=StartSessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Join call with an agent",
    description="Start a new Sophia agent session and bind per-call runtime context.",
    dependencies=[Depends(can_start_session)],
)
async def start_sophia_session(
    call_id: str,
    request: SophiaStartSessionRequest,
    launcher: AgentLauncher = Depends(get_launcher),
) -> StartSessionResponse:
    """Start an agent session and bind runtime context before the client joins."""

    session_create_time = time.time()
    try:
        validate_vision_agents_session_runtime(get_settings())
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    try:
        session = await launcher.start_session(
            call_id=call_id,
            call_type=request.call_type,
        )
    except InvalidCallId as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid call_id: must contain only a-z, 0-9, _ and -",
        ) from exc
    except MaxConcurrentSessionsExceeded as exc:
        raise HTTPException(
            status_code=429,
            detail="Reached maximum number of concurrent sessions",
        ) from exc
    except MaxSessionsPerCallExceeded as exc:
        raise HTTPException(
            status_code=429,
            detail="Reached maximum number of sessions for this call",
        ) from exc
    except Exception as exc:
        logger.error(
            "[VOICE:SESSION] CREATE_FAILED | call_id=%s | error=%s",
            call_id, str(exc),
        )
        logger.exception("Failed to start Sophia agent")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start agent",
        ) from exc

    try:
        _bind_agent_session_context(
            session.agent,
            platform=request.platform,
            context_mode=request.context_mode,
            ritual=request.ritual,
            session_id=request.session_id,
            thread_id=request.thread_id,
        )
        _attach_agent_event_emitter(
            session.agent,
            call_id=session.call_id,
            session_id=session.id,
        )
    except Exception as exc:
        logger.exception("Failed to bind Sophia session context")
        await launcher.close_session(session.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to bind agent session context",
        ) from exc

    logger.info(
        "[VOICE:SESSION] CREATED | session_id=%s | call_id=%s | "
        "platform=%s | context_mode=%s | ritual=%s | timestamp=%.3f",
        session.id, call_id, request.platform,
        request.context_mode, request.ritual, session_create_time,
    )

    return StartSessionResponse(
        session_id=session.id,
        call_id=session.call_id,
        session_started_at=session.started_at,
    )


@session_router.get(
    "/calls/{call_id}/sessions/{session_id}/events",
    summary="Stream Sophia session events",
    description="Stream browser-facing SSE events for an active Sophia voice session.",
    dependencies=[Depends(can_view_session)],
)
async def stream_sophia_session_events(
    call_id: str,
    session_id: str,
    request: Request,
    launcher: AgentLauncher = Depends(get_launcher),
) -> StreamingResponse:
    session_info = await launcher.get_session_info(call_id, session_id)
    if session_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session with id '{session_id}' not found",
        )

    return StreamingResponse(
        voice_event_broker.stream(
            call_id,
            session_id,
            request,
            after_event_id=_voice_event_cursor(request),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@session_router.post(
    "/calls/{call_id}/sessions/{session_id}/warmup",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Prewarm Sophia backend session path",
    description="Schedule a best-effort backend warmup for an active Sophia voice session.",
    dependencies=[Depends(can_view_session)],
)
async def warmup_sophia_session(
    call_id: str,
    session_id: str,
    request: SophiaWarmupSessionRequest,
    launcher: AgentLauncher = Depends(get_launcher),
) -> Response:
    session = launcher.get_session(session_id)
    if session is None:
        session_info = await launcher.get_session_info(call_id, session_id)
        if session_info is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Session with id '{session_id}' not found",
            )

        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Session is not active on this voice node.",
        )

    try:
        backend_started = _schedule_agent_backend_warmup(
            session.agent,
            user_id=request.user_id,
        )
    except Exception as exc:
        logger.exception("Failed to schedule Sophia backend warmup")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to schedule Sophia backend warmup",
        ) from exc

    tts_started = _schedule_agent_tts_warmup(session.agent)

    logger.info(
        "[VOICE:SESSION] WARMUP | session_id=%s | call_id=%s | user_id=%s | backend_started=%s | tts_started=%s",
        session_id,
        call_id,
        request.user_id,
        backend_started,
        tts_started,
    )
    return Response(status_code=status.HTTP_202_ACCEPTED)


async def _close_sophia_session(
    launcher: AgentLauncher,
    call_id: str,
    session_id: str,
) -> None:
    session_info = await launcher.get_session_info(call_id, session_id)
    if session_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session with id '{session_id}' not found",
        )

    await launcher.request_close_session(call_id, session_id)
    await voice_event_broker.close_session(call_id, session_id)


@session_router.delete(
    "/calls/{call_id}/sessions/{session_id}",
    summary="Request closure of an agent session",
    dependencies=[Depends(can_close_session)],
)
async def close_sophia_session(
    call_id: str,
    session_id: str,
    launcher: AgentLauncher = Depends(get_launcher),
) -> Response:
    await _close_sophia_session(launcher, call_id, session_id)
    return Response(status_code=202)


@session_router.post(
    "/calls/{call_id}/sessions/{session_id}/close",
    summary="Request closure of an agent session (sendBeacon alternative)",
    description="Alternative endpoint for requesting session closure via the browser sendBeacon API.",
    dependencies=[Depends(can_close_session)],
)
async def close_sophia_session_beacon(
    call_id: str,
    session_id: str,
    launcher: AgentLauncher = Depends(get_launcher),
) -> Response:
    await _close_sophia_session(launcher, call_id, session_id)
    return Response(status_code=202)


def _get_dogfood_session_or_404(session_id: str) -> RealtimeDogfoodSession:
    session = realtime_dogfood_sessions.get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dogfood session with id '{session_id}' not found",
        )
    return session


async def _stream_realtime_dogfood_events(
    session: RealtimeDogfoodSession,
    request: Request,
) -> AsyncIterator[str]:
    queue = session.subscribe_events(after_event_id=_voice_event_cursor(request))
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
            except TimeoutError:
                if await request.is_disconnected():
                    break
                yield ": heartbeat\n\n"
                continue

            if event is None:
                break

            yield format_sse_event(event.payload, event_id=event.event_id)
    finally:
        session.unsubscribe_events(queue)


@dogfood_router.post(
    "/sessions",
    status_code=status.HTTP_201_CREATED,
    summary="Start an internal realtime dogfood session",
    description="Start an experimental provider event-pump session without using Stream/Vision Agents media routing.",
)
async def start_realtime_dogfood_session(
    request: SophiaRealtimeDogfoodStartRequest,
) -> dict[str, object]:
    try:
        settings = get_settings()
        validate_live_voice_server_runtime(settings)
        session = await realtime_dogfood_sessions.start_session(
            settings,
            user_id=request.user_id,
            session_id=request.session_id,
            instructions=request.instructions,
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return {
        **session.metadata(),
        "event_stream_url": f"/dogfood/realtime/sessions/{session.session_id}/events",
    }


@dogfood_router.post(
    "/openai/browser-sessions",
    status_code=status.HTTP_201_CREATED,
    summary="Start an OpenAI browser WebRTC dogfood session",
    description=(
        "Mint an OpenAI ephemeral client secret and start the internal provider-event "
        "dogfood session that the server sideband will feed."
    ),
)
async def start_openai_browser_dogfood_session(
    request: SophiaOpenAIBrowserDogfoodStartRequest,
) -> dict[str, object]:
    try:
        settings = get_settings()
        validate_live_voice_server_runtime(settings)
        browser_session = await openai_browser_dogfood_sessions.start_browser_session(
            settings,
            user_id=request.user_id,
            session_id=request.session_id,
            instructions=request.instructions,
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except OpenAIClientSecretMintError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    return browser_session.as_public_payload()


@dogfood_router.post(
    "/openai/browser-sessions/{session_id}/sideband",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Attach the backend OpenAI sideband to a browser WebRTC dogfood session",
)
async def attach_openai_browser_dogfood_sideband(
    session_id: str,
    request: SophiaOpenAISidebandAttachRequest,
) -> dict[str, object]:
    call_id = request.call_id or extract_openai_call_id_from_location(request.location)
    if call_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Provide the OpenAI Realtime rtc_* call id or the WebRTC Location header.",
        )
    _get_dogfood_session_or_404(session_id)

    try:
        settings = get_settings()
        sideband_session = await openai_browser_dogfood_sessions.attach_sideband(
            settings,
            dogfood_session_id=session_id,
            call_id=call_id,
            location=request.location,
            call_diagnostics=request.call_diagnostics,
            webrtc_readiness=request.webrtc_readiness,
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except OpenAISidebandAttachError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    return {
        **sideband_session.metadata(),
        "event_stream_url": f"/dogfood/realtime/sessions/{session_id}/events",
        "public_event_boundary": "SophiaEventNormalizer",
    }


@dogfood_router.delete(
    "/openai/browser-sessions/{session_id}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Close an OpenAI browser WebRTC dogfood session",
)
async def close_openai_browser_dogfood_session(session_id: str) -> Response:
    closed = await openai_browser_dogfood_sessions.close_session(session_id)
    if not closed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dogfood session with id '{session_id}' not found",
        )
    return Response(status_code=status.HTTP_202_ACCEPTED)


@dogfood_router.post(
    "/gemini/browser-sessions",
    status_code=status.HTTP_201_CREATED,
    summary="Start a Gemini browser Live WebSocket dogfood session",
    description=(
        "Mint a Gemini Live ephemeral auth token and start the internal "
        "provider-event dogfood session that the browser relay will feed."
    ),
)
async def start_gemini_browser_dogfood_session(
    request: SophiaGeminiBrowserDogfoodStartRequest,
) -> dict[str, object]:
    try:
        settings = get_settings()
        validate_live_voice_server_runtime(settings)
        browser_session = await gemini_browser_dogfood_sessions.start_browser_session(
            settings,
            user_id=request.user_id,
            session_id=request.session_id,
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except GeminiEphemeralTokenMintError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    return browser_session.as_public_payload()


def _decode_conversation_audio(
    request: SophiaGeminiBrowserDisconnectRequest,
) -> tuple[bytes | None, str]:
    if request.conversation_audio_base64 is None:
        return None, request.conversation_audio_mime_type
    if not request.conversation_audio_mime_type.startswith("audio/"):
        raise ValueError("conversation_audio_mime_type must be an audio MIME type.")
    try:
        audio = base64.b64decode(request.conversation_audio_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("conversation_audio_base64 must be valid base64.") from exc
    if len(audio) > 20 * 1024 * 1024:
        raise ValueError("conversation audio exceeds the 20 MB LangSmith attachment limit.")
    return audio, request.conversation_audio_mime_type


@dogfood_router.post(
    "/gemini/browser-sessions/{session_id}/provider-events",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Relay one browser-captured Gemini Live server message",
    description="Feed a Gemini Live server message into the provider adapter and Sophia normalizer.",
)
async def relay_gemini_browser_dogfood_provider_event(
    session_id: str,
    request: SophiaGeminiBrowserRelayRequest,
) -> dict[str, object]:
    try:
        settings = get_settings()
        payload = await gemini_browser_dogfood_sessions.ingest_browser_provider_event(
            settings,
            dogfood_session_id=session_id,
            event=request.event,
            source_metadata=request.source_metadata(),
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except GeminiBrowserRelayError as exc:
        status_code = status.HTTP_404_NOT_FOUND if "was not found" in str(exc) else status.HTTP_422_UNPROCESSABLE_ENTITY
        raise HTTPException(
            status_code=status_code,
            detail=str(exc),
        ) from exc

    return payload


@dogfood_router.delete(
    "/gemini/browser-sessions/{session_id}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Close a Gemini browser Live WebSocket dogfood session",
)
async def close_gemini_browser_dogfood_session(
    session_id: str,
    request: SophiaGeminiBrowserDisconnectRequest | None = None,
) -> Response:
    disconnect_request = request or SophiaGeminiBrowserDisconnectRequest(session_id=session_id)
    try:
        audio, mime_type = _decode_conversation_audio(disconnect_request)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    closed = await gemini_browser_dogfood_sessions.close_session(
        session_id,
        conversation_audio=audio,
        conversation_audio_mime_type=mime_type,
    )
    if not closed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dogfood session with id '{session_id}' not found",
        )
    return Response(status_code=status.HTTP_202_ACCEPTED)


@production_realtime_router.post(
    "/gemini/browser-sessions",
    status_code=status.HTTP_201_CREATED,
    summary="Start a production-candidate Gemini browser Live voice session",
    description=(
        "Feature-flagged production route candidate: mint a Gemini Live ephemeral auth token "
        "and start normalized Sophia SSE routing without using the debug dogfood URL surface."
    ),
)
async def start_gemini_production_browser_session(
    body: SophiaGeminiProductionStartRequest,
    http_request: Request,
) -> dict[str, object]:
    voice_lab_claims = capability_for_production_start(
        http_request,
        user_id=body.user_id,
        synthetic_context=body.synthetic_test,
    )
    (
        cleanup_admission_deadline_epoch,
        cleanup_resource_deadline_epoch,
    ) = _provider_cleanup_admission_deadline(
        body,
        synthetic=voice_lab_claims is not None,
    )
    trace_fault_receipt: dict[str, object] | None = None
    if voice_lab_claims is not None and voice_lab_claims.scenario_id == VOICE_LAB_TRACE_FAULT_SCENARIO_ID:
        if body.synthetic_trace_mode != VOICE_LAB_TRACE_FAULT_MODE:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "voice_lab_trace_fault_mode_required"},
            )
    if body.synthetic_trace_mode is not None:
        if body.synthetic_trace_mode != VOICE_LAB_TRACE_FAULT_MODE:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "voice_lab_trace_fault_mode_invalid"},
            )
        trace_claims = capability_for_production_action(
            http_request,
            user_id=body.user_id,
            synthetic_context=body.synthetic_test,
            required_operation="trace:fault",
        )
        if (
            trace_claims is None
            or trace_claims.scenario_id != VOICE_LAB_TRACE_FAULT_SCENARIO_ID
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "voice_lab_trace_fault_scope_mismatch"},
            )
        trace_fault_receipt = _trace_fault_receipt(trace_claims, phase="applied")
    realtime_context = dict(body.realtime_context or {})
    if voice_lab_claims is not None:
        if "dynamic_memory_retrieval" in realtime_context:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "voice_lab_memory_retrieval_forbidden"},
            )
        expected_synthetic_context = voice_lab_claims.synthetic_context()
        if realtime_context.get("synthetic_test") != expected_synthetic_context:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "voice_lab_synthetic_context_mismatch"},
            )
        realtime_context["synthetic_test"] = expected_synthetic_context
        diagnostics = realtime_context.setdefault("diagnostics", {})
        if isinstance(diagnostics, dict):
            diagnostics["dynamic_retrieve_configured"] = False
            diagnostics["memory_retrieval_disabled"] = True
            diagnostics["synthetic_test"] = True
    try:
        settings = get_settings()
        validate_live_voice_server_runtime(settings)
        browser_session = await gemini_production_browser_sessions.start_browser_session(
            settings,
            user_id=body.user_id,
            session_id=body.session_id,
            thread_id=body.thread_id,
            platform=body.platform,
            context_mode=body.context_mode,
            ritual=body.ritual,
            realtime_context=realtime_context,
            preconnect_ttl_seconds=(
                body.preconnect_ttl_seconds if body.preconnect else None
            ),
            logical_session_id=body.logical_session_id,
            trace_fault_receipt=trace_fault_receipt,
            cleanup_admission_expires_at_epoch=cleanup_admission_deadline_epoch,
            cleanup_resource_expires_at_epoch=cleanup_resource_deadline_epoch,
            cleanup_admission_id=body.cleanup_admission_id,
            cleanup_obligation_id=(
                voice_lab_claims.cleanup_obligation_id
                if voice_lab_claims is not None
                else None
            ),
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except GeminiEphemeralTokenMintError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    payload = browser_session.as_public_payload()
    if voice_lab_claims is not None:
        payload["synthetic_test"] = voice_lab_claims.synthetic_context()
    if trace_fault_receipt is not None:
        payload["trace_fault"] = trace_fault_receipt
    return payload


@production_realtime_router.post(
    "/gemini/browser-sessions/{session_id}/continuation-bootstrap",
    status_code=status.HTTP_200_OK,
    summary="Mint the next native Gemini Live continuation credential",
)
async def continue_gemini_production_browser_session(
    session_id: str,
    body: SophiaGeminiContinuationBootstrapRequest,
    http_request: Request,
) -> dict[str, object]:
    _capability_for_existing_production_session(
        http_request,
        session_id,
        required_operation="session:create",
        allow_kill_switch=False,
    )
    try:
        settings = get_settings()
        validate_live_voice_server_runtime(settings)
        browser_session = await gemini_production_browser_sessions.continue_browser_session(
            settings,
            session_id=session_id,
            expected_epoch=body.expected_epoch,
            handle_present=body.handle_present,
            secret_generation=body.secret_generation,
        )
    except RealtimeDogfoodConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except GeminiBrowserRelayError as exc:
        status_code = (
            status.HTTP_404_NOT_FOUND
            if "was not found" in str(exc)
            else status.HTTP_409_CONFLICT
        )
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except GeminiEphemeralTokenMintError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    payload = browser_session.as_public_payload()
    synthetic_context = gemini_production_browser_sessions.synthetic_context_for_session(
        session_id
    )
    if synthetic_context is not None:
        payload["synthetic_test"] = synthetic_context
    return payload


@production_realtime_router.post(
    "/gemini/browser-sessions/{session_id}/activate",
    status_code=status.HTTP_200_OK,
    summary="Commit one browser-open synthetic Gemini provider epoch",
)
async def activate_gemini_production_browser_session(
    session_id: str,
    body: SophiaGeminiProviderActivationRequest,
    http_request: Request,
) -> dict[str, object]:
    _capability_for_existing_production_session(
        http_request,
        session_id,
        required_operation="session:create",
        allow_kill_switch=False,
    )
    if (
        gemini_production_browser_sessions.synthetic_context_for_session(session_id)
        is None
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "provider_activation_not_allowed"},
        )
    try:
        activated_epoch = (
            await gemini_production_browser_sessions.activate_browser_session_epoch(
                session_id=session_id,
                previous_activated_epoch=body.previous_activated_epoch,
                candidate_epoch=body.candidate_epoch,
            )
        )
    except (RealtimeDogfoodConfigurationError, GeminiBrowserRelayError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    return {
        "activated": True,
        "session_id": session_id,
        "provider_connection_epoch": activated_epoch,
    }


@production_realtime_router.post(
    "/gemini/browser-sessions/{session_id}/provider-events",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Relay one production Gemini Live server message",
)
async def relay_gemini_production_provider_event(
    session_id: str,
    body: SophiaGeminiBrowserRelayRequest,
    http_request: Request,
) -> dict[str, object]:
    _capability_for_existing_production_session(
        http_request,
        session_id,
        required_operation="session:create",
        allow_kill_switch=False,
    )
    log_context = _gemini_relay_context(session_id, body)
    try:
        settings = get_settings()
        payload = await gemini_production_browser_sessions.ingest_browser_provider_event(
            settings,
            session_id=session_id,
            event=body.event,
            source_metadata=body.source_metadata(),
        )
        logger.info("voice.gemini.production_relay accepted context=%s", log_context)
        return payload
    except RealtimeDogfoodConfigurationError as exc:
        logger.warning(
            "voice.gemini.production_relay rejected reason=configuration_error context=%s",
            log_context,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        logger.warning(
            "voice.gemini.production_relay rejected reason=value_error error_type=%s context=%s",
            exc.__class__.__name__,
            log_context,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except GeminiBrowserRelayError as exc:
        status_code = status.HTTP_404_NOT_FOUND if "was not found" in str(exc) else status.HTTP_422_UNPROCESSABLE_ENTITY
        logger.warning(
            "voice.gemini.production_relay rejected reason=relay_error status=%s error_type=%s context=%s",
            status_code,
            exc.__class__.__name__,
            log_context,
        )
        raise HTTPException(
            status_code=status_code,
            detail=str(exc),
        ) from exc


@production_realtime_router.get(
    "/gemini/sessions/{session_id}/events",
    summary="Stream normalized Sophia events for a production Gemini candidate session",
)
async def stream_gemini_production_session_events(
    session_id: str,
    request: Request,
) -> StreamingResponse:
    _capability_for_existing_production_session(
        request,
        session_id,
        required_operation="session:finalize",
        allow_kill_switch=True,
    )
    session = _get_dogfood_session_or_404(session_id)
    if session.runtime_mode != VoiceRuntimeMode.GEMINI_LIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Production Gemini event stream requires a gemini_live session.",
        )
    return StreamingResponse(
        _stream_realtime_dogfood_events(session, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@production_realtime_router.delete(
    "/gemini/browser-sessions/{session_id}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Close a production-candidate Gemini browser Live voice session",
)
async def close_gemini_production_browser_session(
    session_id: str,
    http_request: Request,
    body: SophiaGeminiBrowserDisconnectRequest | None = None,
) -> Response:
    voice_lab_claims = _finalize_or_recover_capability_for_existing_production_session(
        http_request,
        session_id,
    )
    disconnect_request = body or SophiaGeminiBrowserDisconnectRequest(session_id=session_id)
    if voice_lab_claims is not None and disconnect_request.conversation_audio_base64:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "voice_lab_raw_audio_forbidden"},
        )
    try:
        audio, mime_type = _decode_conversation_audio(disconnect_request)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    applied_trace_fault = gemini_production_browser_sessions.trace_fault_for_session(
        session_id
    )
    if (
        voice_lab_claims is not None
        and "session:retention-reap" in voice_lab_claims.allowed_ops
    ):
        cleanup_requested = await gemini_production_browser_sessions.request_browser_cleanup(
            session_id
        )
        if not cleanup_requested:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Gemini production session with id '{session_id}' not found",
            )
        return JSONResponse(
            {"ok": True, "closed": False, "cleanup_requested": True},
            status_code=status.HTTP_202_ACCEPTED,
        )
    else:
        restored_trace_fault = (
            {
                **applied_trace_fault,
                "phase": "restored",
                "restored_at": datetime.now(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            }
            if applied_trace_fault is not None
            else None
        )
        closed = await gemini_production_browser_sessions.close_session(
            session_id,
            conversation_audio=audio,
            conversation_audio_mime_type=mime_type,
            trace_fault_restore_receipt=restored_trace_fault,
        )
    if not closed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Gemini production session with id '{session_id}' not found",
        )
    payload: dict[str, object] = {"ok": True, "closed": True}
    if restored_trace_fault is not None:
        payload["trace_fault"] = restored_trace_fault
    return JSONResponse(payload, status_code=status.HTTP_202_ACCEPTED)


@dogfood_router.post(
    "/sessions/{session_id}/input/text",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Send text to an internal realtime dogfood session",
)
async def send_realtime_dogfood_text(
    session_id: str,
    request: SophiaRealtimeDogfoodTextRequest,
) -> dict[str, object]:
    session = _get_dogfood_session_or_404(session_id)
    await session.send_text(request.text)
    return {
        "accepted": True,
        "session_id": session.session_id,
        "sent_client_event_count": session.sent_client_event_count,
    }


@dogfood_router.post(
    "/sessions/{session_id}/provider-events",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Ingest one raw provider event into an internal dogfood session",
)
async def ingest_realtime_dogfood_provider_event(
    session_id: str,
    request: SophiaRealtimeDogfoodProviderEventRequest,
) -> dict[str, object]:
    session = _get_dogfood_session_or_404(session_id)
    await session.ingest_provider_event(request.event)
    return {"accepted": True, "session_id": session.session_id}


@dogfood_router.get(
    "/sessions/{session_id}/events",
    summary="Stream normalized Sophia events for an internal realtime dogfood session",
)
async def stream_realtime_dogfood_session_events(
    session_id: str,
    request: Request,
) -> StreamingResponse:
    session = _get_dogfood_session_or_404(session_id)
    return StreamingResponse(
        _stream_realtime_dogfood_events(session, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@dogfood_router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Close an internal realtime dogfood session",
)
async def close_realtime_dogfood_session(session_id: str) -> Response:
    await openai_browser_dogfood_sessions.close_sideband(session_id)
    closed = await realtime_dogfood_sessions.close_session(session_id)
    if not closed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dogfood session with id '{session_id}' not found",
        )
    return Response(status_code=status.HTTP_202_ACCEPTED)


def create_fastapi_app(
    launcher: AgentLauncher,
    options: ServeOptions | None = None,
) -> FastAPI:
    resolved_options = options or ServeOptions()
    app = FastAPI(lifespan=_sophia_voice_lifespan)
    app.state.launcher = launcher
    app.state.options = resolved_options

    @app.get("/version", include_in_schema=False)
    async def voice_version() -> dict[str, str | int | None]:
        return voice_service_identity()

    @app.get("/health", include_in_schema=False)
    async def voice_health() -> dict[str, str]:
        return {"status": "ok", "service": "sophia-voice"}

    @app.get("/ready", include_in_schema=False)
    async def voice_ready() -> dict[str, object]:
        security = voice_security_readiness()
        try:
            settings = get_settings()
            if security["voice_lab_enabled"] is True:
                if (
                    settings.voice_runtime_selection.mode != VoiceRuntimeMode.GEMINI_LIVE
                    or not settings.gemini_production_route_enabled
                ):
                    raise RuntimeError("synthetic production route not selected")
            validate_live_voice_server_runtime(settings)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_provider_configuration_invalid"},
            ) from exc
        return {
            "status": "ready",
            "service": "sophia-voice",
            **security,
            "provider_configured": True,
        }

    @app.middleware("http")
    async def protect_runner_call_resources(request: Request, call_next):  # noqa: ANN001
        if request.url.path.startswith("/calls/"):
            try:
                require_voice_internal_auth(request)
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        return await call_next(request)

    app.dependency_overrides[can_start_session] = resolved_options.can_start_session
    app.dependency_overrides[can_close_session] = resolved_options.can_close_session
    app.dependency_overrides[can_view_session] = resolved_options.can_view_session
    app.dependency_overrides[can_view_metrics] = resolved_options.can_view_metrics

    app.include_router(production_realtime_router)
    app.include_router(dogfood_router)
    app.include_router(session_router)

    runner_api_router = APIRouter()
    for route in runner_http_router.routes:
        if (
            isinstance(route, APIRoute)
            and route.path == "/calls/{call_id}/sessions"
            and route.methods == {"POST"}
        ):
            continue
        if (
            isinstance(route, APIRoute)
            and route.path == "/calls/{call_id}/sessions/{session_id}"
            and route.methods == {"DELETE"}
        ):
            continue
        if (
            isinstance(route, APIRoute)
            and route.path == "/calls/{call_id}/sessions/{session_id}/close"
            and route.methods == {"POST"}
        ):
            continue
        runner_api_router.routes.append(route)

    app.include_router(runner_api_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_options.cors_allow_origins),
        allow_credentials=resolved_options.cors_allow_credentials,
        allow_methods=list(resolved_options.cors_allow_methods),
        allow_headers=list(resolved_options.cors_allow_headers),
    )
    return app


async def validate_runtime(settings, llm) -> None:  # noqa: ANN001
    logger.info(
        "voice.ready_check backend=%s platform=%s runtime=%s",
        settings.backend_mode,
        settings.platform,
        settings.voice_runtime_mode,
    )
    await llm.probe()


def validate_live_voice_server_runtime(settings) -> None:  # noqa: ANN001
    selection = settings.voice_runtime_selection
    if selection.mode == VoiceRuntimeMode.LEGACY_CASCADE:
        return

    build_realtime_runtime_bundle_from_settings(settings)


def validate_vision_agents_session_runtime(settings) -> None:  # noqa: ANN001
    selection = settings.voice_runtime_selection
    if selection.mode == VoiceRuntimeMode.LEGACY_CASCADE:
        return

    raise RuntimeError(
        "Experimental realtime runtime "
        f"{selection.mode.value!r} is enabled for the internal dogfood path. "
        "The Stream/Vision Agents session route is legacy_cascade-only; use "
        "/dogfood/realtime/sessions for provider event-pump dogfooding or "
        "reset SOPHIA_VOICE_RUNTIME_MODE to 'legacy_cascade' for browser voice sessions."
    )


def attach_runtime_observers(
    agent: Agent,
    llm: SophiaLLM,
    coordinator: ConversationFlowCoordinator,
) -> None:
    turn_det = agent.turn_detection
    _first_participant_audio = {"seen": False}

    def _resolve_turn_transcript(participant: object) -> str:
        get_turn_transcript = getattr(turn_det, "get_turn_transcript", None)
        if callable(get_turn_transcript):
            transcript = get_turn_transcript()
            if transcript:
                return transcript

        participant_transcript = getattr(participant, "transcript", "")
        return participant_transcript or ""

    @turn_det.events.subscribe
    async def _on_turn_ended(event: TurnEndedEvent) -> None:
        transcript = _resolve_turn_transcript(event.participant)
        logger.info(
            "[VOICE:TURN] DETECTED | transcript='%s' | substantive=%s",
            transcript[:100], _has_substantive_transcript(transcript),
        )
        if not _has_substantive_transcript(transcript):
            logger.debug("[FLOW] Ignoring non-substantive turn transcript")
            return

        if coordinator.is_merge_pending:
            coordinator.on_merge_turn_ended(transcript)
            return

        llm.note_turn_end(event.participant)
        should_respond = coordinator.on_turn_ended(transcript, event.participant)
        if not should_respond:
            return

    async def _handle_runtime_transcript(
        text: str,
        participant: object | None,
        *,
        is_final: bool,
    ) -> None:
        if hasattr(turn_det, "update_transcript"):
            turn_det.update_transcript(text, is_final=is_final)

        coordinator.on_partial_transcript(text)
        if participant is None:
            return

        deferred = await coordinator.defer_response_for_continuation(text, participant)
        if deferred is not None:
            llm.note_continuation_handling(getattr(participant, "user_id", None))
            return

        recovered = await coordinator.recover_late_continuation(
            text,
            participant,
            queue_for_next_submission=True,
        )
        if recovered is None:
            return

        llm.note_continuation_handling(getattr(participant, "user_id", None))
        logger.info(
            "[FLOW] Queued recovered late continuation chars=%d",
            len(recovered),
        )

    @agent.stt.events.subscribe
    async def _on_partial_transcript(event: STTPartialTranscriptEvent) -> None:
        await _handle_runtime_transcript(
            event.text,
            getattr(event, "participant", None),
            is_final=False,
        )

    @agent.stt.events.subscribe
    async def _on_final_transcript(event: STTTranscriptEvent) -> None:
        if not _first_participant_audio["seen"]:
            _first_participant_audio["seen"] = True
            participant = getattr(event, "participant", None)
            participant_id = getattr(participant, "user_id", "unknown") if participant else "unknown"
            logger.info(
                "[VOICE:PARTICIPANT] FIRST_AUDIO | participant_id=%s",
                participant_id,
            )
        logger.info(
            "[VOICE:STT] TRANSCRIPT | text='%s' | is_final=True",
            event.text[:100],
        )
        # Also feed final transcripts — some STT flows skip partials on fast speech.
        await _handle_runtime_transcript(
            event.text,
            getattr(event, "participant", None),
            is_final=True,
        )

    @agent.stt.events.subscribe
    async def _on_stt_error(event: STTErrorEvent) -> None:
        logger.error(
            "[VOICE:STT] ERROR | error=%s | recoverable=%s",
            event.error_message, event.is_recoverable,
        )
        llm.note_stage_error(
            "stt",
            event.error_message,
            recoverable=event.is_recoverable,
        )

    @agent.tts.events.subscribe
    async def _on_tts_synthesis_start(_: TTSSynthesisStartEvent) -> None:
        clear_turn_end_guard = getattr(turn_det, "clear_turn_end_guard", None)
        if callable(clear_turn_end_guard):
            clear_turn_end_guard()
        if hasattr(turn_det, "reset_transcript"):
            turn_det.reset_transcript()


async def create_agent(**kwargs) -> Agent:
    settings = get_settings()
    validate_live_voice_server_runtime(settings)

    stt = DeepgramSTT(
        model=settings.deepgram_model,
        language=settings.deepgram_language,
    )
    # We want Smart Turn to decide turn boundaries in Week 1.
    stt.turn_detection = False
    logger.info(
        "[VOICE:AUDIO] STT_WIRED | stt_provider=deepgram | model=%s | language=%s",
        settings.deepgram_model, settings.deepgram_language,
    )

    tts = SophiaTTS(settings)
    llm = SophiaLLM(settings)
    llm.attach_tts(tts)
    await validate_runtime(settings, llm)

    turn_detection = SophiaTurnDetection(
        silence_duration_ms=settings.smart_turn_silence_ms,
        speech_probability_threshold=settings.smart_turn_speech_threshold,
        pre_speech_buffer_ms=settings.smart_turn_pre_speech_buffer_ms,
        vad_reset_interval_seconds=settings.smart_turn_vad_reset_seconds,
        adaptive_silence_short_ms=settings.adaptive_silence_short_ms,
        adaptive_silence_medium_ms=settings.adaptive_silence_medium_ms,
        adaptive_silence_long_ms=settings.adaptive_silence_long_ms,
        adaptive_silence_ceiling_ms=settings.adaptive_silence_ceiling_ms,
        adaptive_silence_continuation_bonus_ms=settings.adaptive_silence_continuation_bonus_ms,
        adaptive_silence_fragment_bonus_ms=settings.adaptive_silence_fragment_bonus_ms,
    )

    # Wire echo guard: TTS tells turn detector when agent is speaking
    # so VAD ignores Sophia's own voice leaking through the mic.
    tts.attach_echo_guard(turn_detection)
    attach_diagnostic_callback = getattr(turn_detection, "attach_diagnostic_callback", None)
    if callable(attach_diagnostic_callback):
        attach_diagnostic_callback(llm.note_echo_suppression)

    # --- Layer 3: Per-user rhythm learning ---
    users_dir = Path("users")
    rhythm_tracker = RhythmTracker(
        users_dir=users_dir,
        min_sessions=settings.rhythm_min_sessions,
        base_min_ms=settings.rhythm_base_min_ms,
        base_max_ms=settings.rhythm_base_max_ms,
    )
    # Load rhythm data if a user_id is available at agent creation time.
    # In multi-user deployments, rhythm may be loaded later per-call.
    user_id = kwargs.get("user_id") or getattr(settings, "agent_user_id", None)
    if user_id:
        rhythm_tracker.load(user_id)
        offset = rhythm_tracker.compute_silence_offset()
        if offset:
            turn_detection.set_rhythm_offset(offset)

    agent_kwargs, omitted_agent_kwargs = resolve_agent_constructor_kwargs(
        Agent,
        {
            "edge": StreamEdge(),
            "llm": llm,
            "agent_user": User(id=settings.agent_user_id, name=settings.agent_user_name),
            "instructions": settings.instructions,
            "stt": stt,
            "tts": tts,
            "turn_detection": turn_detection,
        },
        {
            "streaming_tts": True,
        },
    )
    if omitted_agent_kwargs:
        logger.info(
            "[VOICE:AGENT] Omitting unsupported Agent kwargs | kwargs=%s",
            ",".join(omitted_agent_kwargs),
        )
    agent = Agent(**agent_kwargs)
    llm.attach_call_emitter(agent.send_custom_event)

    def _resolve_turn_transcript(participant: object, fallback: str) -> str:
        get_turn_transcript = getattr(turn_detection, "get_turn_transcript", None)
        if callable(get_turn_transcript):
            transcript = get_turn_transcript()
            if transcript:
                return transcript

        participant_transcript = getattr(participant, "transcript", "")
        return participant_transcript or fallback

    original_simple_response = agent.simple_response

    async def _stabilized_simple_response(transcript: str, participant: object):
        resolved_transcript = transcript
        queued_recovered_transcript = coordinator.consume_pending_recovered_response(
            transcript,
            participant,
        )
        if queued_recovered_transcript is not None:
            llm.note_continuation_handling(getattr(participant, "user_id", None))
            resolved_transcript = queued_recovered_transcript
            logger.info(
                "[FLOW] Recovered late continuation before backend request chars=%d",
                len(resolved_transcript),
            )
        else:
            recovered_transcript = await coordinator.recover_late_continuation(
                transcript,
                participant,
            )
            if recovered_transcript is not None:
                llm.note_continuation_handling(getattr(participant, "user_id", None))
                resolved_transcript = recovered_transcript
                logger.info(
                    "[FLOW] Recovered late continuation before backend request chars=%d",
                    len(resolved_transcript),
                )

        stabilization_wait_ms = 0
        stabilization_reason: str | None = None
        get_submission_stabilization_plan = getattr(
            turn_detection,
            "get_submission_stabilization_plan",
            None,
        )
        if callable(get_submission_stabilization_plan):
            stabilization_wait_ms, stabilization_reason = get_submission_stabilization_plan(
                settings.fragile_window_ms,
                transcript,
            )
        else:
            should_stabilize_submission = getattr(turn_detection, "should_stabilize_submission", None)
            if callable(should_stabilize_submission) and should_stabilize_submission(transcript):
                stabilization_wait_ms = settings.fragile_window_ms
                stabilization_reason = "legacy"

        if stabilization_wait_ms > 0:
            llm.note_continuation_handling(getattr(participant, "user_id", None))
            wait_started = time.perf_counter()
            await asyncio.sleep(stabilization_wait_ms / 1000)
            actual_wait_ms = (time.perf_counter() - wait_started) * 1000
            llm.note_submission_stabilized(getattr(participant, "user_id", None), actual_wait_ms)
            resolved_transcript = _resolve_turn_transcript(participant, transcript)
            logger.info(
                "[FLOW] Stabilized turn submission before backend request chars=%d requested_ms=%d actual_ms=%.0f reason=%s",
                len(resolved_transcript),
                stabilization_wait_ms,
                actual_wait_ms,
                stabilization_reason or "unknown",
            )

        if not _has_substantive_transcript(resolved_transcript):
            logger.info("[FLOW] Skipping non-substantive transcript before backend request")
            return LLMResponseEvent(original=None, text="")

        coordinator.mark_response_submitted(resolved_transcript, participant)
        response = await original_simple_response(resolved_transcript, participant)
        coordinator.on_agent_ended()
        await llm.emit_turn_event("agent_ended", user_id=getattr(participant, "user_id", None))
        return response

    agent.simple_response = _stabilized_simple_response

    # --- Layer 2: Cancel-and-merge coordinator ---

    async def _cancel_llm_task() -> None:
        """Cancel the active LLM/pending turn task if one exists."""
        pending = getattr(agent, "_pending_turn", None)
        if pending and hasattr(pending, "task") and pending.task and not pending.task.done():
            pending.task.cancel()
            logger.debug("[FLOW] Cancelled pending LLM task")

    async def _send_ack(phrase: str) -> None:
        """Speak a brief acknowledgment phrase through TTS."""
        await tts.stream_audio(phrase)

    coordinator = ConversationFlowCoordinator(
        backend_stall_timeout_ms=settings.backend_stall_timeout_ms,
        fragile_window_ms=settings.fragile_window_ms,
        merge_min_new_words=settings.merge_min_new_words,
        same_turn_repeat_debounce_ms=settings.same_turn_repeat_debounce_ms,
        cancel_llm_task=_cancel_llm_task,
        interrupt_tts=tts.interrupt,
        on_backend_stall=lambda participant, transcript: _handle_backend_stall(participant),
        record_turn=rhythm_tracker.record_turn,
        send_acknowledgment=_send_ack,
    )

    original_note_first_text_emitted = llm.note_first_text_emitted
    original_note_backend_progress = llm.note_backend_progress

    def _note_first_text_emitted(user_id: str) -> None:
        coordinator.on_backend_progress()
        original_note_first_text_emitted(user_id)

    llm.note_first_text_emitted = _note_first_text_emitted

    def _note_backend_progress(user_id: str) -> None:
        coordinator.on_backend_progress()
        original_note_backend_progress(user_id)

    llm.note_backend_progress = _note_backend_progress

    async def _handle_backend_stall(participant: object | None) -> None:
        user_id = getattr(participant, "user_id", None)
        await _cancel_llm_task()
        clear_turn_end_guard = getattr(turn_detection, "clear_turn_end_guard", None)
        if callable(clear_turn_end_guard):
            clear_turn_end_guard()
        reset_transcript = getattr(turn_detection, "reset_transcript", None)
        if callable(reset_transcript):
            reset_transcript()
        llm.note_stage_error(
            "backend-timeout",
            f"Backend made no response progress within {settings.backend_stall_timeout_ms}ms.",
            user_id=user_id,
            recoverable=True,
        )
        await llm.emit_turn_event("agent_ended", user_id=user_id)

    setattr(agent, "_rhythm_tracker", rhythm_tracker)
    attach_runtime_observers(agent, llm, coordinator)
    logger.info(
        "voice.ready state=ok backend=%s platform=%s",
        settings.backend_mode,
        settings.platform,
    )
    logger.info(
        "[VOICE:SESSION] AGENT_READY | backend=%s | platform=%s | "
        "stt=deepgram | tts=cartesia | turn_detection=smart_turn",
        settings.backend_mode, settings.platform,
    )
    return agent


async def join_call(agent: Agent, call_type: str, call_id: str, **kwargs) -> None:
    call = await agent.create_call(call_type, call_id)
    logger.info("Sophia voice agent joining %s/%s", call_type, call_id)

    try:
        async with agent.join(call):
            await agent.finish()
    finally:
        logger.info(
            "[VOICE:SESSION] AGENT_STOPPED | call_id=%s | call_type=%s",
            call_id, call_type,
        )
        rhythm_tracker = getattr(agent, "_rhythm_tracker", None)
        if rhythm_tracker is not None:
            rhythm_tracker.end_session()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # Drop the per-partial transcript log line emitted by vision_agents.
    # It fires on every STT partial (multiple times per second) and both
    # crowds the logs and slows the event loop under load. We keep final
    # transcripts and all other INFO messages.
    class _SuppressPartialTranscriptFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
            try:
                return "[Transcript Partial]" not in record.getMessage()
            except Exception:
                return True

    logging.getLogger("vision_agents.core.agents.agents").addFilter(
        _SuppressPartialTranscriptFilter()
    )

    launcher = AgentLauncher(create_agent=create_agent, join_call=join_call)
    app = create_fastapi_app(launcher)
    Runner(
        launcher,
        serve_options=ServeOptions(fast_api=app),
    ).cli()


if __name__ == "__main__":
    main()
