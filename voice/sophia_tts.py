from __future__ import annotations

import logging
from typing import Any, Callable

from vision_agents.core.tts.events import TTSAudioEvent, TTSErrorEvent
from vision_agents.plugins.cartesia import TTS as CartesiaTTS

from voice.config import VoiceSettings


logger = logging.getLogger(__name__)


class SophiaTTS(CartesiaTTS):
    """Thin Week 1 wrapper that keeps room for artifact-driven voice settings."""

    def __init__(self, settings: VoiceSettings) -> None:
        super().__init__(
            model_id=settings.cartesia_model_id,
            voice_id=settings.cartesia_voice_id,
            sample_rate=settings.cartesia_sample_rate,
        )
        self._next_artifact: dict[str, Any] = {}
        self._active_response_user_id: str | None = None
        self._first_audio_reported = False
        self._first_audio_callback: Callable[[str], None] | None = None
        self._error_callback: Callable[[str, str, str | None], None] | None = None

        @self.events.subscribe
        async def _on_tts_audio(event: TTSAudioEvent) -> None:
            if (
                event.data is None
                or self._active_response_user_id is None
                or self._first_audio_reported
            ):
                return

            self._first_audio_reported = True
            if self._first_audio_callback is not None:
                self._first_audio_callback(self._active_response_user_id)

        @self.events.subscribe
        async def _on_tts_error(event: TTSErrorEvent) -> None:
            logger.error("voice.error stage=tts user_id=%s message=%s", self._active_response_user_id, event.error_message)
            if self._error_callback is not None:
                self._error_callback(
                    "tts",
                    event.error_message,
                    self._active_response_user_id,
                )
            self.clear_response_context()

    @property
    def next_artifact(self) -> dict[str, Any]:
        return dict(self._next_artifact)

    def attach_runtime_hooks(
        self,
        on_first_audio: Callable[[str], None],
        on_error: Callable[[str, str, str | None], None],
    ) -> None:
        self._first_audio_callback = on_first_audio
        self._error_callback = on_error

    def note_response_started(self, user_id: str) -> None:
        self._active_response_user_id = user_id
        self._first_audio_reported = False

    def clear_response_context(self, user_id: str | None = None) -> None:
        if user_id is None or user_id == self._active_response_user_id:
            self._active_response_user_id = None
            self._first_audio_reported = False

    def update_from_artifact(self, artifact: dict[str, Any]) -> None:
        self._next_artifact = dict(artifact)
        logger.info(
            "Queued next voice settings: emotion=%s speed=%s",
            artifact.get("voice_emotion_primary"),
            artifact.get("voice_speed"),
        )
