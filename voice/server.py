from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.core.llm.llm import LLMResponseEvent
from vision_agents.core.agents.exceptions import (
    InvalidCallId,
    MaxConcurrentSessionsExceeded,
    MaxSessionsPerCallExceeded,
)
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
from vision_agents.core.stt.events import (
    STTErrorEvent,
    STTPartialTranscriptEvent,
    STTTranscriptEvent,
)
from vision_agents.core.tts.events import (
    TTSAudioEvent,
    TTSSynthesisCompleteEvent,
    TTSSynthesisStartEvent,
)
from vision_agents.core.turn_detection.events import TurnEndedEvent
from vision_agents.plugins.deepgram import STT as DeepgramSTT
from vision_agents.plugins.getstream import Edge as StreamEdge
from voice.config import get_settings
from voice.conversation_flow import ConversationFlowCoordinator
from voice.rhythm import RhythmTracker
from voice.sophia_llm import SophiaLLM
from voice.sophia_turn import SophiaTurnDetection
from voice.sophia_tts import SophiaTTS


logger = logging.getLogger(__name__)


def _has_substantive_transcript(text: str) -> bool:
    return any(char.isalnum() for char in text)


class SophiaStartSessionRequest(BaseModel):
    """Request body for joining a call with Sophia-specific runtime context."""

    call_type: str = Field(default="default", description="Type of the call to join")
    platform: str = Field(default="voice", description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(
        default=None,
        description="Active ritual: prepare | debrief | vent | reset | None",
    )


session_router = APIRouter()


def _bind_agent_session_context(
    agent: Agent,
    *,
    platform: str,
    context_mode: str,
    ritual: str | None,
) -> None:
    llm = getattr(agent, "llm", None)
    bind_session_context = getattr(llm, "bind_session_context", None)
    if not callable(bind_session_context):
        raise RuntimeError("Agent LLM does not support runtime session context binding.")

    bind_session_context(
        platform=platform,
        context_mode=context_mode,
        ritual=ritual,
    )


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


def create_fastapi_app(
    launcher: AgentLauncher,
    options: ServeOptions | None = None,
) -> FastAPI:
    resolved_options = options or ServeOptions()
    app = FastAPI(lifespan=runner_http_lifespan)
    app.state.launcher = launcher
    app.state.options = resolved_options

    app.dependency_overrides[can_start_session] = resolved_options.can_start_session
    app.dependency_overrides[can_close_session] = resolved_options.can_close_session
    app.dependency_overrides[can_view_session] = resolved_options.can_view_session
    app.dependency_overrides[can_view_metrics] = resolved_options.can_view_metrics

    app.include_router(session_router)

    runner_api_router = APIRouter()
    for route in runner_http_router.routes:
        if (
            isinstance(route, APIRoute)
            and route.path == "/calls/{call_id}/sessions"
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
        "voice.ready_check backend=%s platform=%s",
        settings.backend_mode,
        settings.platform,
    )
    await llm.probe()


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

        recovered = await coordinator.recover_late_continuation(text, participant)
        if recovered is None:
            return

        llm.note_continuation_handling(getattr(participant, "user_id", None))
        logger.info(
            "[FLOW] Resubmitting recovered late continuation chars=%d",
            len(recovered),
        )
        asyncio.ensure_future(agent.simple_response(recovered, participant))

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
        coordinator.on_agent_started()
        await llm.emit_turn_event("agent_started")
        clear_turn_end_guard = getattr(turn_det, "clear_turn_end_guard", None)
        if callable(clear_turn_end_guard):
            clear_turn_end_guard()
        if hasattr(turn_det, "reset_transcript"):
            turn_det.reset_transcript()

    @agent.tts.events.subscribe
    async def _on_tts_synthesis_complete(_: TTSSynthesisCompleteEvent) -> None:
        coordinator.on_agent_ended()
        await llm.emit_turn_event("agent_ended")

    @agent.tts.events.subscribe
    async def _on_tts_audio_debug(event: TTSAudioEvent) -> None:
        has_data = event.data is not None
        data_len = len(event.data.data) if has_data and hasattr(event.data, "data") else 0
        logger.info(
            "[VOICE:TTS] FRAMEWORK_EVENT | has_data=%s | data_bytes=%d | is_final=%s",
            has_data,
            data_len,
            getattr(event, "is_final_chunk", "unknown"),
        )


async def create_agent(**kwargs) -> Agent:
    settings = get_settings()

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

    agent = Agent(
        edge=StreamEdge(),
        llm=llm,
        agent_user=User(id=settings.agent_user_id, name=settings.agent_user_name),
        instructions=settings.instructions,
        stt=stt,
        tts=tts,
        turn_detection=turn_detection,
        streaming_tts=True,
    )
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

        should_stabilize_submission = getattr(turn_detection, "should_stabilize_submission", None)
        if callable(should_stabilize_submission) and should_stabilize_submission(transcript):
            llm.note_continuation_handling(getattr(participant, "user_id", None))
            await asyncio.sleep(settings.fragile_window_ms / 1000)
            resolved_transcript = _resolve_turn_transcript(participant, transcript)
            logger.info(
                "[FLOW] Stabilized turn submission before backend request chars=%d",
                len(resolved_transcript),
            )

        if not _has_substantive_transcript(resolved_transcript):
            logger.info("[FLOW] Skipping non-substantive transcript before backend request")
            return LLMResponseEvent(original=None, text="")

        coordinator.mark_response_submitted(resolved_transcript, participant)
        return await original_simple_response(resolved_transcript, participant)

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
        resubmit_response=lambda transcript, participant: agent.simple_response(
            transcript, participant
        ),
    )

    original_note_first_text_emitted = llm.note_first_text_emitted

    def _note_first_text_emitted(user_id: str) -> None:
        coordinator.on_backend_progress()
        original_note_first_text_emitted(user_id)

    llm.note_first_text_emitted = _note_first_text_emitted

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
    launcher = AgentLauncher(create_agent=create_agent, join_call=join_call)
    app = create_fastapi_app(launcher)
    Runner(
        launcher,
        serve_options=ServeOptions(fast_api=app),
    ).cli()


if __name__ == "__main__":
    main()
