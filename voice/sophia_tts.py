from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Iterator

from vision_agents.core.tts.events import TTSAudioEvent, TTSErrorEvent
from vision_agents.plugins.cartesia import TTS as CartesiaTTS
from getstream.video.rtc.track_util import AudioFormat, PcmData

from voice.config import VoiceSettings
from voice.voice_delivery_profile import classify_emotion_family, resolve_voice_delivery

if TYPE_CHECKING:
    from voice.sophia_turn import SophiaTurnDetection


logger = logging.getLogger(__name__)

# Speed label → Cartesia generation_config float (sonic-3).
# See CLAUDE.md and artifact_instructions.md for the spec.
SPEED_MAP: dict[str, float] = {
    "slow": 0.8,
    "gentle": 0.9,
    "normal": 1.0,
    "engaged": 1.05,
    "energetic": 1.15,
}

# Valid Cartesia emotion literals for sonic-3 generation_config.
# Sourced from cartesia.types.generation_config_param.GenerationConfigParam.
CARTESIA_EMOTIONS: frozenset[str] = frozenset({
    "neutral", "happy", "excited", "enthusiastic", "elated", "euphoric",
    "triumphant", "amazed", "surprised", "flirtatious", "curious", "content",
    "peaceful", "serene", "calm", "grateful", "affectionate", "trust",
    "sympathetic", "anticipation", "mysterious", "angry", "mad", "outraged",
    "frustrated", "agitated", "threatened", "disgusted", "contempt", "envious",
    "sarcastic", "ironic", "sad", "dejected", "melancholic", "disappointed",
    "hurt", "guilty", "bored", "tired", "rejected", "nostalgic", "wistful",
    "apologetic", "hesitant", "insecure", "confused", "resigned", "anxious",
    "panicked", "alarmed", "scared", "proud", "confident", "distant",
    "skeptical", "contemplative", "determined",
})

# Warm default artifact for turn 1 — Sophia never sounds robotic on her opening.
WARM_DEFAULT_ARTIFACT: dict[str, str] = {
    "voice_emotion_primary": "content",
    "voice_speed": "gentle",
}

_WARMUP_TRANSCRIPT = "Hey."

# Keyword → (emotion, speed_float) mapping for user-side emotion hinting.
# Scanned before TTS so the *current* turn's voice matches the user's emotional tone.
# The backend artifact overrides this from turn 2+.
_EMOTION_HINT_RULES: list[tuple[re.Pattern[str], str, float]] = [
    # Anger / frustration
    (re.compile(r"\bfed up\b", re.I), "determined", 1.0),
    (re.compile(r"\bfurious\b", re.I), "determined", 1.0),
    (re.compile(r"\bpissed\b", re.I), "determined", 1.0),
    (re.compile(r"\bso angry\b", re.I), "determined", 1.0),
    (re.compile(r"\blivid\b", re.I), "determined", 1.0),
    (re.compile(r"\bhate (this|my|it)\b", re.I), "determined", 1.0),
    (re.compile(r"\bcan't (stand|take)\b", re.I), "determined", 1.0),
    # Grief / deep sadness
    (re.compile(r"\bpassed away\b", re.I), "sympathetic", 0.8),
    (re.compile(r"\b(died|lost (him|her|them|my))\b", re.I), "sympathetic", 0.8),
    (re.compile(r"\bheartbroken\b", re.I), "sympathetic", 0.8),
    (re.compile(r"\bdevastated\b", re.I), "sympathetic", 0.8),
    # Fear / anxiety
    (re.compile(r"\bscared\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\bterrified\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\bfreaking out\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\bpanicking\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\banxious\b", re.I), "calm", 0.9),
    # Excitement / celebration
    (re.compile(r"\bamazing (news|thing)\b", re.I), "excited", 1.05),
    (re.compile(r"\bgot the (job|offer|promotion)\b", re.I), "excited", 1.05),
    (re.compile(r"\bso (happy|excited|proud)\b", re.I), "excited", 1.05),
    (re.compile(r"\bincredible\b", re.I), "excited", 1.05),
    (re.compile(r"\bcan't believe.{0,20}(happened|worked|got)\b", re.I), "excited", 1.05),
    (re.compile(r"\bi did it\b", re.I), "excited", 1.05),
    (re.compile(r"\bwe (won|did it|made it)\b", re.I), "excited", 1.05),
    # Vulnerability / sadness
    (re.compile(r"\b(so (sad|lonely|lost|tired|exhausted))\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\bdon't know what to do\b", re.I), "sympathetic", 0.9),
    (re.compile(r"\bfeel(ing)? (empty|numb|broken|hopeless)\b", re.I), "sympathetic", 0.8),
    (re.compile(r"\bcrying\b", re.I), "sympathetic", 0.8),
    (re.compile(r"\bgive up\b", re.I), "sympathetic", 0.9),
    # Gratitude / warmth
    (re.compile(r"\bthank you (so much|for)\b", re.I), "grateful", 0.9),
    (re.compile(r"\bmeans (a lot|everything)\b", re.I), "affectionate", 0.9),
]


class SophiaTTS(CartesiaTTS):
    """Artifact-driven Cartesia TTS with emotion and speed injection (Week 2)."""

    def __init__(self, settings: VoiceSettings) -> None:
        super().__init__(
            model_id=settings.cartesia_model_id,
            voice_id=settings.cartesia_voice_id,
            sample_rate=settings.cartesia_sample_rate,
        )
        self._next_artifact: dict[str, Any] = dict(WARM_DEFAULT_ARTIFACT)
        self._has_real_artifact: bool = False
        self._hint_emotion: str | None = None
        self._hint_speed: float | None = None
        self._hint_transcript: str | None = None
        self._active_response_user_id: str | None = None
        self._first_audio_reported = False
        self._last_resolved_delivery = None
        self._first_audio_callback: Callable[[str], None] | None = None
        self._error_callback: Callable[[str, str, str | None], None] | None = None
        self._echo_guard: SophiaTurnDetection | None = None
        self._warmup_task: asyncio.Task[None] | None = None
        self._warmup_completed = False

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
            logger.error(
                "[VOICE:TTS] ERROR | user_id=%s | message=%s",
                self._active_response_user_id, event.error_message,
            )
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

    def attach_echo_guard(self, turn_detection: SophiaTurnDetection) -> None:
        """Wire TTS to suppress VAD while the agent is speaking."""
        self._echo_guard = turn_detection

    def start_warmup(self) -> bool:
        if self._warmup_completed:
            return False

        task = self._warmup_task
        if task is not None and not task.done():
            return False

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False

        task = loop.create_task(self._run_warmup())
        self._warmup_task = task
        task.add_done_callback(self._finalize_warmup_task)
        return True

    def _finalize_warmup_task(self, task: asyncio.Task[None]) -> None:
        if self._warmup_task is task:
            self._warmup_task = None

        if task.cancelled():
            return

        exc = task.exception()
        if exc is not None:
            logger.warning("voice.tts_warmup status=failed_unhandled", exc_info=exc)
            return

    async def _consume_warmup_response(self, response: object) -> None:
        if isinstance(response, (bytes, bytearray, memoryview)):
            return

        if hasattr(response, "__aiter__"):
            async for chunk in response:  # type: ignore[attr-defined]
                if chunk:
                    return
            return

        if hasattr(response, "__iter__") and not isinstance(response, str):
            for chunk in response:  # type: ignore[attr-defined]
                if chunk:
                    return

    async def _run_warmup(self) -> None:
        logger.info("voice.tts_warmup status=started model=%s", self.model_id)

        try:
            response = await self.client.tts.generate(
                model_id=self.model_id,
                transcript=_WARMUP_TRANSCRIPT,
                output_format={
                    "container": "raw",
                    "encoding": "pcm_s16le",
                    "sample_rate": self.sample_rate,
                },
                voice={"id": self.voice_id, "mode": "id"},
            )
            await self._consume_warmup_response(response.iter_bytes())
        except asyncio.CancelledError:
            logger.info("voice.tts_warmup status=cancelled model=%s", self.model_id)
            raise
        except Exception:
            logger.warning("voice.tts_warmup status=failed model=%s", self.model_id, exc_info=True)
        else:
            self._warmup_completed = True
            logger.info("voice.tts_warmup status=completed model=%s", self.model_id)

    def note_response_started(self, user_id: str) -> None:
        self._active_response_user_id = user_id
        self._first_audio_reported = False

    def clear_response_context(self, user_id: str | None = None) -> None:
        if user_id is None or user_id == self._active_response_user_id:
            self._active_response_user_id = None
            self._first_audio_reported = False

    def update_from_artifact(self, artifact: dict[str, Any]) -> None:
        self._next_artifact = dict(artifact)
        self._has_real_artifact = True
        # Artifact wins — clear any pending hint.
        self._hint_emotion = None
        self._hint_speed = None
        self._hint_transcript = None
        logger.info(
            "Queued next voice settings: emotion=%s speed=%s",
            artifact.get("voice_emotion_primary"),
            artifact.get("voice_speed"),
        )

    def hint_emotion_from_transcript(self, text: str) -> None:
        """Scan user transcript for emotional keywords and set a hint.

        The hint is used as fallback when no real backend artifact is available
        (e.g. turn 1). Cleared after each ``stream_audio`` call or when a real
        artifact arrives via ``update_from_artifact``.
        """
        for pattern, emotion, speed in _EMOTION_HINT_RULES:
            if pattern.search(text):
                self._hint_emotion = emotion
                self._hint_speed = speed
                self._hint_transcript = text
                logger.info(
                    "[SOPHIA-VOICE] Emotion hint from transcript: '%s' at speed %.2f",
                    emotion,
                    speed,
                )
                return
        # No match — hint stays None, warm default will be used.
        self._hint_emotion = None
        self._hint_speed = None
        self._hint_transcript = text if text.strip() else None

    def _resolve_delivery(self, text: str):
        delivery = resolve_voice_delivery(
            assistant_text=text,
            has_real_artifact=self._has_real_artifact,
            hinted_emotion=self._hint_emotion,
            hinted_speed_label=self._hint_speed_label(),
            queued_artifact=self._next_artifact,
            user_transcript=getattr(self, "_hint_transcript", None),
        )
        self._last_resolved_delivery = delivery
        return delivery

    def _hint_speed_label(self) -> str | None:
        if self._hint_speed is None:
            return None

        for label, speed in SPEED_MAP.items():
            if abs(speed - self._hint_speed) < 0.001:
                return label
        return None

    async def stream_audio(
        self, text: str, *_: Any, **__: Any
    ) -> PcmData | Iterator[PcmData] | AsyncIterator[PcmData]:
        """Generate speech with emotion and speed from the queued artifact."""
        output_format = {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": self.sample_rate,
        }
        voice_param = {"id": self.voice_id, "mode": "id"}

        # Build generation_config from queued artifact (sonic-3 only).
        delivery = self._resolve_delivery(text)
        emotion = delivery.emotion if delivery.emotion in CARTESIA_EMOTIONS else None
        speed = SPEED_MAP.get(delivery.speed_label)

        gen_config: dict[str, Any] = {}
        if emotion is not None:
            gen_config["emotion"] = emotion
        if speed is not None:
            gen_config["speed"] = speed

        # --- Client-visible log tag ---
        source = "artifact" if self._has_real_artifact else ("hint" if self._hint_emotion else "warm-default")
        logger.info(
            "[VOICE:TTS] SYNTHESIS_START | emotion=%s | speed=%s | "
            "source=%s | text='%s'",
            emotion, delivery.speed_label, source, text[:80],
        )
        logger.info(
            "[SOPHIA-VOICE] emitted_family=%s resolved_family=%s emotion=%s speed=%s source=%s",
            classify_emotion_family(self._next_artifact.get("voice_emotion_primary")),
            delivery.family,
            emotion,
            delivery.speed_label,
            source,
        )

        kwargs: dict[str, Any] = {
            "model_id": self.model_id,
            "transcript": text,
            "output_format": output_format,
            "voice": voice_param,
        }
        if gen_config:
            kwargs["generation_config"] = gen_config

        # Suppress VAD before generating audio (mic will pick up our voice).
        if self._echo_guard is not None:
            self._echo_guard.note_agent_will_speak()

        response = await self.client.tts.generate(**kwargs)

        result = PcmData.from_response(
            response.iter_bytes(),
            sample_rate=self.sample_rate,
            channels=1,
            format=AudioFormat.S16,
        )
        logger.info(
            "[VOICE:TTS] AUDIO_SENT | emotion=%s | speed=%s",
            emotion, delivery.speed_label,
        )

        # Estimate playback duration from text length.
        # ~150 wpm ≈ 2.5 words/sec at normal speed. Adjust for Cartesia speed.
        if self._echo_guard is not None:
            word_count = max(len(text.split()), 1)
            speed_factor = speed if speed is not None else 1.0
            estimated_ms = (word_count / 2.5) * 1000 / speed_factor
            self._echo_guard.note_agent_audio_ready(estimated_ms)

        # Clear one-shot hint after use.
        self._hint_emotion = None
        self._hint_speed = None
        self._hint_transcript = None

        return result
