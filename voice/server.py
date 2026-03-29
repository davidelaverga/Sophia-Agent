from __future__ import annotations

import logging

from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.core.stt.events import STTErrorEvent
from vision_agents.core.turn_detection.events import TurnEndedEvent
from vision_agents.plugins.deepgram import STT as DeepgramSTT
from vision_agents.plugins.getstream import Edge as StreamEdge
from vision_agents.plugins.smart_turn import TurnDetection as SmartTurnDetection

from voice.config import get_settings
from voice.sophia_llm import SophiaLLM
from voice.sophia_tts import SophiaTTS


logger = logging.getLogger(__name__)


async def validate_runtime(settings, llm) -> None:  # noqa: ANN001
    logger.info(
        "voice.ready_check backend=%s platform=%s",
        settings.backend_mode,
        settings.platform,
    )
    await llm.probe()


def attach_runtime_observers(agent: Agent, llm: SophiaLLM) -> None:
    @agent.turn_detection.events.subscribe
    async def _on_turn_ended(event: TurnEndedEvent) -> None:
        llm.note_turn_end(event.participant)

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

    agent = Agent(
        edge=StreamEdge(),
        llm=llm,
        agent_user=User(id=settings.agent_user_id, name=settings.agent_user_name),
        instructions=settings.instructions,
        stt=stt,
        tts=tts,
        turn_detection=SmartTurnDetection(
            silence_duration_ms=settings.smart_turn_silence_ms,
            speech_probability_threshold=settings.smart_turn_speech_threshold,
            pre_speech_buffer_ms=settings.smart_turn_pre_speech_buffer_ms,
            vad_reset_interval_seconds=settings.smart_turn_vad_reset_seconds,
        ),
        streaming_tts=True,
    )
    attach_runtime_observers(agent, llm)
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
