from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
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
from voice.turn_diagnostics import TurnDiagnostic, TurnDiagnosticsTracker
from voice.voice_delivery_profile import (
    classify_emotion_family,
    classify_response_intent,
    classify_user_transcript,
)


logger = logging.getLogger(__name__)

TURN_COMPLETION_GRACE_MS = 400


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
        self._turn_diagnostics = TurnDiagnosticsTracker()
        self._active_response_user_id: str | None = None
        self._turn_completion_tasks: dict[str, asyncio.Task[None]] = {}
        self._pending_user_ended_user_ids: set[str] = set()
        self._runtime_platform = settings.platform
        self._runtime_context_mode = settings.context_mode
        self._runtime_ritual = settings.ritual
        self._runtime_session_id: str | None = None
        self._runtime_thread_id: str | None = None

    def bind_session_context(
        self,
        *,
        platform: str,
        context_mode: str,
        ritual: str | None,
        session_id: str | None,
        thread_id: str | None,
    ) -> None:
        self._runtime_platform = platform
        self._runtime_context_mode = context_mode
        self._runtime_ritual = ritual
        self._runtime_session_id = session_id
        self._runtime_thread_id = thread_id

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

    async def emit_turn_event(
        self,
        phase: str,
        user_id: str | None = None,
    ) -> None:
        emit_phase = True
        resolved_user_id = user_id or self._active_response_user_id

        if resolved_user_id and phase == "agent_started":
            self._cancel_turn_completion(resolved_user_id)

        if resolved_user_id and phase in {"agent_started", "agent_ended"}:
            emit_phase = self._turn_diagnostics.note_agent_phase(
                resolved_user_id,
                phase,
            )

        if emit_phase:
            await self._emit_call_event(
                {"type": "sophia.turn", "data": {"phase": phase}},
                event_type="sophia.turn",
            )

        if resolved_user_id and phase == "agent_ended":
            self._schedule_turn_completion(resolved_user_id)

    async def _emit_turn_diagnostic(self, diagnostic: TurnDiagnostic) -> None:
        await self._emit_call_event(
            {"type": "sophia.turn_diagnostic", "data": diagnostic.as_payload()},
            event_type="sophia.turn_diagnostic",
        )
        logger.info(
            "voice.turn_diagnostic turn_id=%s status=%s reason=%s raw_false_end_count=%d backend=%s",
            diagnostic.turn_id,
            diagnostic.status,
            diagnostic.reason,
            diagnostic.raw_false_end_count,
            self.settings.backend_mode,
        )

        if diagnostic.user_id == self._active_response_user_id:
            self._active_response_user_id = None
        self._turn_completion_tasks.pop(diagnostic.user_id, None)
        self._pending_user_ended_user_ids.discard(diagnostic.user_id)

        if self._tts_ref is not None:
            clear_context = getattr(self._tts_ref, "clear_response_context", None)
            if callable(clear_context):
                clear_context(diagnostic.user_id)

    async def probe(self) -> None:
        await self._backend.probe()

    async def close(self) -> None:
        await self._backend.close()

    def note_turn_end(self, participant: Participant | None) -> None:
        user_id = self._resolve_user_id(participant)
        if user_id is not None:
            self._pending_user_ended_user_ids.add(user_id)
        turn_id = self._turn_diagnostics.note_user_ended(user_id, time.perf_counter())
        logger.info(
            "voice.turn stage=turn_ended user_id=%s turn_id=%s backend=%s",
            user_id,
            turn_id,
            self.settings.backend_mode,
        )

    def has_pending_user_ended(self, user_id: str | None = None) -> bool:
        resolved_user_id = user_id or self._active_response_user_id
        return bool(
            resolved_user_id is not None
            and resolved_user_id in self._pending_user_ended_user_ids
        )

    async def emit_pending_user_ended(self, user_id: str | None = None) -> bool:
        resolved_user_id = user_id or self._active_response_user_id
        if resolved_user_id is None:
            return False

        if resolved_user_id not in self._pending_user_ended_user_ids:
            return False

        await self.emit_turn_event("user_ended", user_id=resolved_user_id)
        self._pending_user_ended_user_ids.discard(resolved_user_id)
        return True

    def note_first_text_emitted(self, user_id: str) -> None:
        first_text_ms = self._turn_diagnostics.note_first_text(user_id, time.perf_counter())
        if first_text_ms is None:
            return

        logger.info(
            "voice.metric metric=first_text_ms user_id=%s value=%.2f backend=%s",
            user_id,
            first_text_ms,
            self.settings.backend_mode,
        )

    def note_backend_completed(self, user_id: str) -> None:
        backend_complete_ms = self._turn_diagnostics.note_backend_complete(
            user_id,
            time.perf_counter(),
        )
        if backend_complete_ms is not None:
            logger.info(
                "voice.metric metric=backend_complete_ms user_id=%s value=%.2f backend=%s",
                user_id,
                backend_complete_ms,
                self.settings.backend_mode,
            )

        self._schedule_turn_completion(user_id)

    def note_tts_audio_emitted(self, user_id: str) -> None:
        first_audio_ms = self._turn_diagnostics.note_first_audio(user_id, time.perf_counter())
        if first_audio_ms is None:
            return

        logger.info(
            "voice.metric metric=first_audio_ms user_id=%s value=%.2f backend=%s",
            user_id,
            first_audio_ms,
            self.settings.backend_mode,
        )

    def note_final_text_emitted(self, user_id: str) -> None:
        self._turn_diagnostics.note_final_text(user_id)
        self._schedule_turn_completion(user_id)

    def note_echo_suppression(self, user_id: str | None) -> None:
        resolved_user_id = user_id or self._active_response_user_id
        if resolved_user_id is None:
            return

        self._turn_diagnostics.annotate_reason(resolved_user_id, "echo_suppression")

    def note_continuation_handling(self, user_id: str | None) -> None:
        resolved_user_id = user_id or self._active_response_user_id
        if resolved_user_id is None:
            return

        self._turn_diagnostics.annotate_reason(resolved_user_id, "continuation_handling")

    def note_stage_error(
        self,
        stage: str,
        message: str,
        user_id: str | None = None,
        *,
        recoverable: bool = True,
    ) -> None:
        resolved_user_id = user_id or self._active_response_user_id
        diagnostic = None
        if resolved_user_id is not None:
            self._cancel_turn_completion(resolved_user_id)
        if resolved_user_id is not None:
            diagnostic = self._turn_diagnostics.fail(
                resolved_user_id,
                self._canonical_reason_for_stage(stage),
            )

        if self._tts_ref is not None:
            clear_context = getattr(self._tts_ref, "clear_response_context", None)
            if callable(clear_context):
                clear_context(user_id)

        if resolved_user_id == self._active_response_user_id:
            self._active_response_user_id = None
        if resolved_user_id is not None:
            self._pending_user_ended_user_ids.discard(resolved_user_id)

        self._schedule_turn_diagnostic(diagnostic)

        logger.error(
            "voice.error stage=%s user_id=%s recoverable=%s message=%s",
            stage,
            user_id,
            recoverable,
            message,
        )

    def _canonical_reason_for_stage(self, stage: str) -> str:
        if stage in {"silence-empty-transcript", "stt"}:
            return "transcript_gap"
        if stage == "echo-suppression":
            return "echo_suppression"
        if stage == "continuation-handling":
            return "continuation_handling"
        if stage in {
            "backend-contract",
            "backend-ready",
            "backend-request",
            "backend-stream",
            "backend-timeout",
            "llm",
            "tts",
        }:
            return "backend_stall"
        return "silence_timing"

    def _schedule_turn_completion(self, user_id: str) -> None:
        if not self._turn_diagnostics.can_finalize(user_id):
            return

        self._cancel_turn_completion(user_id)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        self._turn_completion_tasks[user_id] = loop.create_task(
            self._emit_turn_completion_after_grace(user_id)
        )

    def _cancel_turn_completion(self, user_id: str) -> None:
        task = self._turn_completion_tasks.pop(user_id, None)
        if task is None or task.done():
            return
        task.cancel()

    async def _emit_turn_completion_after_grace(self, user_id: str) -> None:
        if TURN_COMPLETION_GRACE_MS > 0:
            try:
                await asyncio.sleep(TURN_COMPLETION_GRACE_MS / 1000)
            except asyncio.CancelledError:
                return

        diagnostic = self._turn_diagnostics.complete(user_id)
        self._turn_completion_tasks.pop(user_id, None)
        if diagnostic is not None:
            await self._emit_turn_diagnostic(diagnostic)

    def _schedule_turn_diagnostic(self, diagnostic: TurnDiagnostic | None) -> None:
        if diagnostic is None:
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        loop.create_task(self._emit_turn_diagnostic(diagnostic))

    async def simple_response(
        self,
        text: str,
        participant: Participant | None = None,
    ) -> LLMResponseEvent[Any]:
        user_id = self._resolve_user_id(participant)
        logger.info(
            "[VOICE:LLM] GENERATE_START | user_id=%s | platform=%s | "
            "ritual=%s | context_mode=%s | message='%s'",
            user_id, self._runtime_platform, self._runtime_ritual,
            self._runtime_context_mode, text[:80],
        )
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

            self._active_response_user_id = user_id

        request = BackendRequest(
            text=text,
            user_id=user_id,
            platform=self._runtime_platform,
            ritual=self._runtime_ritual,
            context_mode=self._runtime_context_mode,
            session_id=self._runtime_session_id,
            thread_id=self._runtime_thread_id,
        )

        await self._emit_call_event(
            {
                "type": "sophia.user_transcript",
                "data": {
                    "text": request.text,
                    "utterance_id": item_id,
                },
            },
            event_type="sophia.user_transcript",
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
                    logger.info(
                        "[VOICE:LLM] DEERFLOW_STREAMING | user_id=%s | first_token_ms=%.0f",
                        request.user_id, first_token_ms,
                    )
                    self.note_first_text_emitted(request.user_id)
                    await self.emit_pending_user_ended(request.user_id)
                    await self.emit_turn_event("agent_started", request.user_id)

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
                await self._emit_transcript_event(
                    "".join(text_parts),
                    is_final=False,
                )
                sequence += 1
                continue

            if event.kind == "artifact":
                artifact = self._validate_artifact(
                    event.artifact,
                    response_text="".join(text_parts),
                    user_text=request.text,
                )
                self.note_backend_completed(request.user_id)
                await self._emit_transcript_event(
                    "".join(text_parts),
                    is_final=True,
                )
                self.note_final_text_emitted(request.user_id)
                self.last_artifact = artifact
                if self._tts_ref is not None:
                    self._tts_ref.update_from_artifact(artifact)
                await self._emit_call_event(
                    {"type": "sophia.artifact", "data": artifact},
                    event_type="sophia.artifact",
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

        total_ms = (time.perf_counter() - request_started) * 1000
        logger.info(
            "[VOICE:LLM] GENERATE_COMPLETE | user_id=%s | "
            "response_length=%d | artifact_seen=%s | chunks=%d | total_ms=%.0f",
            request.user_id, len("".join(text_parts)),
            artifact_seen, sequence, total_ms,
        )

        return (
            "".join(text_parts),
            {"backend_mode": self.settings.backend_mode, "chunk_count": sequence},
            first_token_ms,
        )

    async def _emit_transcript_event(
        self,
        text: str,
        *,
        is_final: bool,
    ) -> None:
        if not text:
            return

        await self._emit_call_event(
            {
                "type": "sophia.transcript",
                "data": {"text": text, "is_final": is_final},
            },
            event_type="sophia.transcript",
        )

    async def _emit_call_event(
        self,
        payload: dict[str, Any],
        *,
        event_type: str,
    ) -> None:
        if self._call_emitter is None:
            return

        try:
            await self._call_emitter(payload)
            if event_type != "sophia.transcript":
                logger.info(
                    "voice.custom_event type=%s status=sent",
                    event_type,
                )
        except Exception:
            logger.warning(
                "voice.call_emitter_error Failed to emit %s custom event",
                event_type,
                exc_info=True,
            )

    def _validate_artifact(
        self,
        artifact: dict[str, Any] | None,
        *,
        response_text: str = "",
        user_text: str = "",
    ) -> dict[str, Any]:
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

        return self._normalize_artifact(
            dict(artifact),
            response_text=response_text,
            user_text=user_text,
        )

    def _normalize_artifact(
        self,
        artifact: dict[str, Any],
        *,
        response_text: str = "",
        user_text: str = "",
    ) -> dict[str, Any]:
        tone_band = self._artifact_string(artifact.get("active_tone_band"))
        skill = self._artifact_string(artifact.get("skill_loaded"))
        primary_family = classify_emotion_family(
            self._artifact_string(artifact.get("voice_emotion_primary"))
        )
        secondary_emotion = self._artifact_string(artifact.get("voice_emotion_secondary"))
        speed_label = self._artifact_string(artifact.get("voice_speed"))
        response_family = classify_response_intent(response_text)
        user_family = classify_user_transcript(user_text)

        if user_family == "celebratory":
            artifact["active_tone_band"] = "enthusiasm"
            artifact["voice_emotion_primary"] = "excited"
            if secondary_emotion not in {"excited", "enthusiastic", "proud"}:
                artifact["voice_emotion_secondary"] = "proud"
            if speed_label not in {"engaged", "energetic"}:
                artifact["voice_speed"] = "engaged"

        if user_family == "supportive" and response_family not in {"challenging", "celebratory"}:
            artifact["active_tone_band"] = "grief_fear"
            artifact["voice_emotion_primary"] = "sympathetic"
            if secondary_emotion not in {"calm", "sympathetic", "content"}:
                artifact["voice_emotion_secondary"] = "calm"
            if speed_label not in {"slow", "gentle"}:
                artifact["voice_speed"] = "gentle"

        if user_family == "challenging" and response_family != "celebratory":
            artifact["active_tone_band"] = "engagement"
            artifact["voice_emotion_primary"] = "determined"
            if secondary_emotion not in {"calm", "confident", "curious"}:
                artifact["voice_emotion_secondary"] = "curious"
            if speed_label not in {"normal", "engaged"}:
                artifact["voice_speed"] = "normal"

        tone_band = self._artifact_string(artifact.get("active_tone_band"))
        primary_family = classify_emotion_family(
            self._artifact_string(artifact.get("voice_emotion_primary"))
        )
        secondary_emotion = self._artifact_string(artifact.get("voice_emotion_secondary"))
        speed_label = self._artifact_string(artifact.get("voice_speed"))

        if tone_band == "enthusiasm" or skill == "celebrating_breakthrough":
            if primary_family != "celebratory":
                artifact["voice_emotion_primary"] = "excited"
                if secondary_emotion not in {
                    "excited",
                    "enthusiastic",
                    "proud",
                }:
                    artifact["voice_emotion_secondary"] = "proud"

            if speed_label not in {"engaged", "energetic"}:
                artifact["voice_speed"] = "engaged"

        if response_family == "challenging" and primary_family != "challenging":
            artifact["voice_emotion_primary"] = "determined"
            if secondary_emotion not in {"calm", "confident", "determined"}:
                artifact["voice_emotion_secondary"] = "calm"
            if tone_band in {"anger_antagonism", "antagonism"}:
                artifact["active_tone_band"] = "engagement"
            if speed_label not in {"normal", "engaged"}:
                artifact["voice_speed"] = "normal"

        return artifact

    @staticmethod
    def _artifact_string(value: Any) -> str | None:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return None

    def _resolve_user_id(self, participant: Participant | None) -> str:
        if participant is not None and participant.user_id:
            return participant.user_id

        if self._conversation is not None:
            for message in reversed(self._conversation.messages):
                if message.role == "user" and message.user_id:
                    return message.user_id

        return "default_user"
