"""Echo-suppressed turn detection for Sophia voice sessions.

SmartTurnDetection processes ALL incoming mic audio through Silero VAD.
When Sophia speaks, her voice leaks back through the user's microphone
and triggers false turn boundaries (VAD thinks the user started talking).

This subclass suppresses VAD processing while the agent is speaking
and for a brief cooldown afterward (echo tail / room reverb).

It also provides **adaptive silence thresholds** (Layer 1) that scale
the SmartTurn silence window based on utterance word count and trailing
continuation signals.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Optional

from vision_agents.plugins.smart_turn import TurnDetection as SmartTurnDetection

logger = logging.getLogger(__name__)

# Default cooldown after TTS audio ends before re-enabling VAD.
# Accounts for speaker-to-mic echo tail and room reverb.
DEFAULT_ECHO_COOLDOWN_MS = 600

# Continuation signal patterns — trailing words that suggest the user isn't done.
# Checked against the last 1–3 words of the current transcript.
_CONTINUATION_PATTERNS: list[re.Pattern[str]] = [
    # Conjunctions
    re.compile(r"\b(?:and|but|because|so|or|although|though)\s*$", re.I),
    # Fillers
    re.compile(r"\b(?:um|uh|like|basically|actually)\s*$", re.I),
    re.compile(r"\byou know\s*$", re.I),
    re.compile(r"\bI mean\s*$", re.I),
    # Incomplete clauses
    re.compile(r"\bI was\s*$", re.I),
    re.compile(r"\bI think\s*$", re.I),
    re.compile(r"\bit'?s like\s*$", re.I),
    re.compile(r"\bthe thing is\s*$", re.I),
    # Trailing prepositions / articles
    re.compile(r"\b(?:to|for|with|the|a)\s*$", re.I),
]

# Fragment start patterns — short phrases beginning with function words are almost
# always mid-sentence fragments (e.g. "are getting better", "with my friend").
# Only applied when word_count <= _FRAGMENT_MAX_WORDS.
_FRAGMENT_MAX_WORDS = 5
_FRAGMENT_START_PATTERN: re.Pattern[str] = re.compile(
    r"^\s*(?:"
    r"are|is|was|were|am|"                                          # linking / aux verbs
    r"have|has|had|"
    r"do|does|did|"
    r"will|would|could|should|might|can|may|shall|"                 # modals
    r"being|getting|going|having|"                                  # participles
    r"not|never|also|still|just|even|"                              # mid-sentence adverbs
    r"than|then|"                                                   # comparison / sequence
    r"that|which|who|whom|whose|where|when|while|"                  # relative / subordinate
    r"in|on|at|with|for|from|about|into|through|over|under|"        # prepositions
    r"the|a|an"                                                     # articles
    r")\b",
    re.IGNORECASE,
)


class SophiaTurnDetection(SmartTurnDetection):
    """SmartTurnDetection with echo suppression and adaptive silence thresholds."""

    def __init__(
        self,
        echo_cooldown_ms: int = DEFAULT_ECHO_COOLDOWN_MS,
        *,
        adaptive_silence_short_ms: int = 1000,
        adaptive_silence_medium_ms: int = 1500,
        adaptive_silence_long_ms: int = 2000,
        adaptive_silence_ceiling_ms: int = 2800,
        adaptive_silence_continuation_bonus_ms: int = 800,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._echo_cooldown_ms = echo_cooldown_ms
        self._suppress_until: float | None = None

        # Adaptive silence config
        self._short_ms = adaptive_silence_short_ms
        self._medium_ms = adaptive_silence_medium_ms
        self._long_ms = adaptive_silence_long_ms
        self._ceiling_ms = adaptive_silence_ceiling_ms
        self._continuation_bonus_ms = adaptive_silence_continuation_bonus_ms

        # Mutable state — updated by STT events
        self._current_transcript: str = ""
        self._rhythm_offset_ms: int = 0

    def note_agent_will_speak(self) -> None:
        """Call before TTS starts generating. Suppresses VAD immediately."""
        self._suppress_until = float("inf")
        logger.debug("[ECHO-GUARD] Suppression ON — agent will speak")

    def note_agent_audio_ready(self, playback_duration_ms: float) -> None:
        """Call after TTS returns audio. Sets suppression = now + playback + cooldown."""
        total_ms = playback_duration_ms + self._echo_cooldown_ms
        self._suppress_until = time.monotonic() + total_ms / 1000
        logger.info(
            "[ECHO-GUARD] Audio ready — suppressing VAD for %.0fms (playback=%.0f + cooldown=%d)",
            total_ms,
            playback_duration_ms,
            self._echo_cooldown_ms,
        )

    def note_agent_interrupted(self) -> None:
        """Call when the agent is interrupted mid-speech. Starts cooldown immediately."""
        self._suppress_until = time.monotonic() + self._echo_cooldown_ms / 1000
        logger.debug("[ECHO-GUARD] Agent interrupted — cooldown %dms", self._echo_cooldown_ms)

    @property
    def is_suppressed(self) -> bool:
        if self._suppress_until is None:
            return False
        if time.monotonic() < self._suppress_until:
            return True
        self._suppress_until = None
        return False

    # --- Adaptive silence (Layer 1) -----------------------------------

    def update_transcript(self, text: str) -> None:
        """Feed the latest STT partial/final transcript so silence adapts."""
        self._current_transcript = text
        self._apply_adaptive_silence()

    def reset_transcript(self) -> None:
        """Clear transcript state after a turn ends."""
        self._current_transcript = ""
        # Restore base value so SmartTurn uses the word-count default for
        # the next turn until a new transcript arrives.
        self._apply_adaptive_silence()

    def set_rhythm_offset(self, offset_ms: int) -> None:
        """Set a per-user rhythm offset (from Layer 3) for this session."""
        self._rhythm_offset_ms = offset_ms
        logger.debug("[ADAPTIVE-SILENCE] Rhythm offset set to %dms", offset_ms)
        self._apply_adaptive_silence()

    def _apply_adaptive_silence(self) -> None:
        """Compute and set ``_trailing_silence_ms`` on the base SmartTurn class."""
        if not hasattr(self, "_trailing_silence_ms"):
            logger.warning(
                "[ADAPTIVE-SILENCE] SmartTurn base lacks _trailing_silence_ms — "
                "adaptive silence disabled"
            )
            return

        word_count = len(self._current_transcript.split()) if self._current_transcript.strip() else 0

        # Word-count tier
        if word_count <= 3:
            base = self._short_ms
        elif word_count <= 10:
            base = self._medium_ms
        else:
            base = self._long_ms

        # Continuation bonus — trailing signals OR short fragment starts
        continuation = self._has_continuation_signal(self._current_transcript)
        fragment = self._is_fragment(self._current_transcript, word_count)
        bonus = self._continuation_bonus_ms if (continuation or fragment) else 0

        # Rhythm offset
        raw = base + bonus + self._rhythm_offset_ms
        effective = max(self._short_ms, min(raw, self._ceiling_ms))

        self._trailing_silence_ms = effective  # type: ignore[attr-defined]

        reason_parts: list[str] = [f"words={word_count}", f"base={base}"]
        if continuation:
            reason_parts.append(f"continuation=+{self._continuation_bonus_ms}")
        elif fragment:
            reason_parts.append(f"fragment=+{self._continuation_bonus_ms}")
        if self._rhythm_offset_ms:
            reason_parts.append(f"rhythm={self._rhythm_offset_ms:+d}")
        reason_parts.append(f"effective={effective}")

        logger.debug("[ADAPTIVE-SILENCE] %s", " ".join(reason_parts))

    @staticmethod
    def _has_continuation_signal(text: str) -> bool:
        """Return True if trailing words match a continuation pattern."""
        if not text:
            return False
        for pattern in _CONTINUATION_PATTERNS:
            if pattern.search(text):
                return True
        return False

    @staticmethod
    def _is_fragment(text: str, word_count: int) -> bool:
        """Return True if a short phrase starts with a function word (mid-sentence fragment)."""
        if word_count == 0 or word_count > _FRAGMENT_MAX_WORDS:
            return False
        stripped = text.strip()
        return bool(_FRAGMENT_START_PATTERN.match(stripped))

    async def process_audio(
        self,
        audio_data: Any,
        participant: Any,
        conversation: Optional[Any] = None,
    ) -> None:
        if self.is_suppressed:
            return
        await super().process_audio(audio_data, participant, conversation)
