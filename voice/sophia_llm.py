from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from vision_agents.core.edge.types import Participant
from vision_agents.core.llm import LLM
from vision_agents.core.llm import events as llm_events
from vision_agents.core.llm.llm import LLMResponseEvent

from voice.adapters import build_backend_adapter
from voice.adapters.base import (
    BackendAdapter,
    BackendEvent,
    BackendRequest,
    BackendStageError,
    REQUIRED_ARTIFACT_FIELDS,
)
from voice.config import VoiceSettings


logger = logging.getLogger(__name__)


@dataclass
class PendingTurnMetrics:
    speech_ended_at: float
    first_text_ms: float | None = None
    first_audio_ms: float | None = None


class SophiaLLM(LLM):
    """Week 1 LLM bridge backed by a normalized shim/deerflow adapter seam."""

    def __init__(
        self,
        settings: VoiceSettings,
        adapter: BackendAdapter | None = None,
    ) -> None:
        super().__init__()
        self.settings = settings
        self.last_artifact: dict[str, Any] = {}
        self._tts_ref: Any = None
        self._call_emitter: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self._backend = adapter or build_backend_adapter(settings)
        self._pending_turn_metrics: dict[str, PendingTurnMetrics] = {}

    def attach_tts(self, tts: Any) -> None:
        self._tts_ref = tts
        attach_hooks = getattr(tts, "attach_runtime_hooks", None)
        if callable(attach_hooks):
            attach_hooks(self.note_tts_audio_emitted, self.note_stage_error)

    def attach_call_emitter(
        self, emitter: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> None:
        """Register a callback to forward artifacts/events as Stream custom events."""
        self._call_emitter = emitter

    async def probe(self) -> None:
        await self._backend.probe()

    async def close(self) -> None:
        await self._backend.close()

    def note_turn_end(self, participant: Participant | None) -> None:
        user_id = self._resolve_user_id(participant)
        self._pending_turn_metrics[user_id] = PendingTurnMetrics(
            speech_ended_at=time.perf_counter()
        )
        logger.info(
            "voice.turn stage=turn_ended user_id=%s backend=%s",
            user_id,
            self.settings.backend_mode,
        )

    def note_first_text_emitted(self, user_id: str) -> None:
        metrics = self._pending_turn_metrics.get(user_id)
        if metrics is None or metrics.first_text_ms is not None:
            return

        metrics.first_text_ms = (time.perf_counter() - metrics.speech_ended_at) * 1000
        logger.info(
            "voice.metric metric=first_text_ms user_id=%s value=%.2f backend=%s",
            user_id,
            metrics.first_text_ms,
            self.settings.backend_mode,
        )

    def note_tts_audio_emitted(self, user_id: str) -> None:
        metrics = self._pending_turn_metrics.get(user_id)
        if metrics is None or metrics.first_audio_ms is not None:
            return

        metrics.first_audio_ms = (time.perf_counter() - metrics.speech_ended_at) * 1000
        logger.info(
            "voice.metric metric=first_audio_ms user_id=%s value=%.2f backend=%s",
            user_id,
            metrics.first_audio_ms,
            self.settings.backend_mode,
        )
        self._pending_turn_metrics.pop(user_id, None)

    def note_stage_error(
        self,
        stage: str,
        message: str,
        user_id: str | None = None,
        *,
        recoverable: bool = True,
    ) -> None:
        if user_id is None:
            self._pending_turn_metrics.clear()
        else:
            self._pending_turn_metrics.pop(user_id, None)

        if self._tts_ref is not None:
            clear_context = getattr(self._tts_ref, "clear_response_context", None)
            if callable(clear_context):
                clear_context(user_id)

        logger.error(
            "voice.error stage=%s user_id=%s recoverable=%s message=%s",
            stage,
            user_id,
            recoverable,
            message,
        )

    async def simple_response(
        self,
        text: str,
        participant: Participant | None = None,
    ) -> LLMResponseEvent[Any]:
        user_id = self._resolve_user_id(participant)
        if not text.strip():
            self.note_stage_error(
                "silence-empty-transcript",
                "Received an empty transcript; skipping backend request.",
                user_id=user_id,
            )
            return LLMResponseEvent(original=None, text="")

        item_id = str(uuid4())
        request_started = time.perf_counter()
        first_token_ms: float | None = None

        request_event = llm_events.LLMRequestStartedEvent(
            plugin_name="sophia_llm",
            model=self.settings.llm_label,
            streaming=True,
        )
        self.events.send(
            request_event
        )

        if self._tts_ref is not None:
            note_response_started = getattr(self._tts_ref, "note_response_started", None)
            if callable(note_response_started):
                note_response_started(user_id)
            # Hint emotion from the user's words so TTS warms up before the
            # backend artifact arrives (especially useful on turn 1).
            hint_fn = getattr(self._tts_ref, "hint_emotion_from_transcript", None)
            if callable(hint_fn):
                hint_fn(text)

        request = BackendRequest(
            text=text,
            user_id=user_id,
            platform=self.settings.platform,
            ritual=self.settings.ritual,
            context_mode=self.settings.context_mode,
        )

        try:
            response_text, original, first_token_ms = await self._stream_backend(
                request=request,
                item_id=item_id,
                request_started=request_started,
            )
        except Exception as exc:
            logger.exception("SophiaLLM request failed")
            stage = exc.stage if isinstance(exc, BackendStageError) else "llm"
            recoverable = exc.recoverable if isinstance(exc, BackendStageError) else True
            self.events.send(
                llm_events.LLMErrorEvent(
                    plugin_name="sophia_llm",
                    error=exc,
                    context=stage,
                    request_id=request_event.request_id,
                    is_recoverable=recoverable,
                )
            )
            self.note_stage_error(
                stage,
                str(exc),
                user_id=user_id,
                recoverable=recoverable,
            )
            raise

        latency_ms = (time.perf_counter() - request_started) * 1000

        self.events.send(
            llm_events.LLMResponseCompletedEvent(
                plugin_name="sophia_llm",
                original=original,
                text=response_text,
                item_id=item_id,
                latency_ms=latency_ms,
                time_to_first_token_ms=first_token_ms,
                model=self.settings.llm_label,
            )
        )

        return LLMResponseEvent(original=original, text=response_text)

    async def _stream_backend(
        self,
        request: BackendRequest,
        item_id: str,
        request_started: float,
    ) -> tuple[str, Any, float | None]:
        text_parts: list[str] = []
        sequence = 0
        first_token_ms: float | None = None
        artifact_seen = False

        async for event in self._backend.stream_events(request):
            if event.kind == "text":
                if not event.text:
                    continue

                if first_token_ms is None:
                    first_token_ms = (time.perf_counter() - request_started) * 1000
                    self.note_first_text_emitted(request.user_id)

                text_parts.append(event.text)
                self.events.send(
                    llm_events.LLMResponseChunkEvent(
                        plugin_name="sophia_llm",
                        item_id=item_id,
                        output_index=0,
                        content_index=sequence,
                        sequence_number=sequence,
                        delta=event.text,
                        is_first_chunk=sequence == 0,
                        time_to_first_token_ms=first_token_ms if sequence == 0 else None,
                    )
                )
                sequence += 1
                continue

            if event.kind == "artifact":
                artifact = self._validate_artifact(event.artifact)
                self.last_artifact = artifact
                if self._tts_ref is not None:
                    self._tts_ref.update_from_artifact(artifact)
                if self._call_emitter is not None:
                    try:
                        await self._call_emitter(
                            {"type": "sophia.artifact", "data": artifact}
                        )
                    except Exception:
                        logger.warning(
                            "voice.call_emitter_error Failed to emit artifact custom event",
                            exc_info=True,
                        )
                artifact_seen = True
                continue

            raise BackendStageError(
                event.stage or "backend-stream",
                event.message or "Backend adapter reported an error.",
                recoverable=event.recoverable,
            )

        if not text_parts:
            raise BackendStageError(
                "backend-contract",
                "Backend stream produced no assistant text.",
                recoverable=False,
            )
        if not artifact_seen:
            raise BackendStageError(
                "backend-contract",
                "Backend stream ended without an artifact payload.",
                recoverable=False,
            )

        return (
            "".join(text_parts),
            {"backend_mode": self.settings.backend_mode, "chunk_count": sequence},
            first_token_ms,
        )

    def _validate_artifact(self, artifact: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(artifact, dict):
            raise BackendStageError(
                "backend-contract",
                "Artifact payload was missing or malformed.",
                recoverable=False,
            )

        missing = sorted(REQUIRED_ARTIFACT_FIELDS.difference(artifact))
        if missing:
            raise BackendStageError(
                "backend-contract",
                f"Artifact payload is missing required fields: {', '.join(missing)}.",
                recoverable=False,
            )

        return dict(artifact)

    def _resolve_user_id(self, participant: Participant | None) -> str:
        if participant is not None and participant.user_id:
            return participant.user_id

        if self._conversation is not None:
            for message in reversed(self._conversation.messages):
                if message.role == "user" and message.user_id:
                    return message.user_id

        return "default_user"
