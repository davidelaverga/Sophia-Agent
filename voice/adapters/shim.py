from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from voice.adapters.base import (
    BackendAdapter,
    BackendEvent,
    BackendRequest,
    BackendStageError,
)
from voice.config import VoiceSettings


class ShimBackendAdapter(BackendAdapter):
    mode = "shim"

    def __init__(self, settings: VoiceSettings) -> None:
        self.settings = settings

    async def probe(self) -> None:
        if self.settings.shim_failure_stage == "ready":
            raise BackendStageError(
                "backend-ready",
                self.settings.shim_failure_message,
            )

    async def stream_events(
        self,
        request: BackendRequest,
    ) -> AsyncIterator[BackendEvent]:
        failure_stage = self.settings.shim_failure_stage
        if failure_stage == "request":
            yield BackendEvent.error_event(
                "backend-request",
                self.settings.shim_failure_message,
            )
            return

        chunks = self._build_chunks(request)
        for index, chunk in enumerate(chunks):
            if self.settings.shim_chunk_delay_ms > 0:
                await asyncio.sleep(self.settings.shim_chunk_delay_ms / 1000)
            yield BackendEvent.text_chunk(chunk)
            if failure_stage == "stream" and index == 0:
                yield BackendEvent.error_event(
                    "backend-stream",
                    self.settings.shim_failure_message,
                )
                return

        if failure_stage == "timeout":
            yield BackendEvent.error_event(
                "backend-timeout",
                self.settings.shim_failure_message,
            )
            return

        if failure_stage == "artifact":
            yield BackendEvent.error_event(
                "backend-artifact",
                self.settings.shim_failure_message,
                recoverable=False,
            )
            return

        artifact = self._build_artifact(request)
        if self.settings.shim_emit_invalid_artifact:
            artifact = {
                "voice_emotion_primary": artifact["voice_emotion_primary"],
                "voice_speed": artifact["voice_speed"],
            }
        yield BackendEvent.artifact_payload(artifact)

    def _build_chunks(self, request: BackendRequest) -> list[str]:
        response_text = self.settings.shim_response_text.strip()
        if request.text.strip():
            return [
                "I heard you.",
                response_text,
            ]
        return [response_text]

    def _build_artifact(self, request: BackendRequest) -> dict[str, object]:
        ritual_prefix = request.ritual or "free_conversation"
        return {
            "session_goal": "Week 1 voice proof",
            "active_goal": "Keep the user in a short, grounded loop.",
            "next_step": "Listen for the next user turn.",
            "takeaway": "The shim exercised streaming text and artifact delivery.",
            "reflection": None,
            "tone_estimate": 2.0,
            "tone_target": 2.5,
            "active_tone_band": "engagement",
            "skill_loaded": "active_listening",
            "ritual_phase": f"{ritual_prefix}.opening",
            "voice_emotion_primary": "calm",
            "voice_emotion_secondary": "sympathetic",
            "voice_speed": "gentle",
        }