from __future__ import annotations

import logging
from pathlib import Path

from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.core.stt.events import (
    STTErrorEvent,
    STTPartialTranscriptEvent,
    STTTranscriptEvent,
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

    @turn_det.events.subscribe
    async def _on_turn_ended(event: TurnEndedEvent) -> None:
        llm.note_turn_end(event.participant)
        # Reset adaptive silence state for the next turn.
        if hasattr(turn_det, "reset_transcript"):
            turn_det.reset_transcript()

        # If a merge is pending (cancel-and-merge fired), the coordinator
        # handles resubmission — don't also start a normal response.
        if coordinator.is_merge_pending:
            coordinator.on_merge_turn_ended(event.participant.transcript if hasattr(event.participant, "transcript") else "")
            return

        # Start fragile window for Layer 2 cancel-and-merge.
        transcript = ""
        if hasattr(agent, "_transcript_buffer"):
            transcript = str(agent._transcript_buffer)
        coordinator.on_turn_ended(transcript, event.participant)

    @agent.stt.events.subscribe
    async def _on_partial_transcript(event: STTPartialTranscriptEvent) -> None:
        if hasattr(turn_det, "update_transcript"):
            turn_det.update_transcript(event.text)
        coordinator.on_partial_transcript(event.text)

    @agent.stt.events.subscribe
    async def _on_final_transcript(event: STTTranscriptEvent) -> None:
        # Also feed final transcripts — some STT flows skip partials on fast speech.
        if hasattr(turn_det, "update_transcript"):
            turn_det.update_transcript(event.text)
        coordinator.on_partial_transcript(event.text)

    @agent.stt.events.subscribe
    async def _on_stt_error(event: STTErrorEvent) -> None:
        llm.note_stage_error(
            "stt",
            event.error_message,
            recoverable=event.is_recoverable,
        )


async def create_agent(**kwargs) -> Agent:
    settings = get_settings()

    stt = DeepgramSTT(
        model=settings.deepgram_model,
        language=settings.deepgram_language,
    )
    # We want Smart Turn to decide turn boundaries in Week 1.
    stt.turn_detection = False

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
    )

    # Wire echo guard: TTS tells turn detector when agent is speaking
    # so VAD ignores Sophia's own voice leaking through the mic.
    tts.attach_echo_guard(turn_detection)

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
        fragile_window_ms=settings.fragile_window_ms,
        merge_min_new_words=settings.merge_min_new_words,
        cancel_llm_task=_cancel_llm_task,
        interrupt_tts=tts.interrupt,
        send_acknowledgment=_send_ack,
        resubmit_response=lambda transcript, participant: agent.simple_response(
            transcript, participant
        ),
    )

    attach_runtime_observers(agent, llm, coordinator)
    logger.info(
        "voice.ready state=ok backend=%s platform=%s",
        settings.backend_mode,
        settings.platform,
    )
    return agent


async def join_call(agent: Agent, call_type: str, call_id: str, **kwargs) -> None:
    call = await agent.create_call(call_type, call_id)
    logger.info("Sophia voice agent joining %s/%s", call_type, call_id)

    async with agent.join(call):
        await agent.finish()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    Runner(
        AgentLauncher(create_agent=create_agent, join_call=join_call),
    ).cli()


if __name__ == "__main__":
    main()
