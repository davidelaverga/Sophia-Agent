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
from collections.abc import Callable
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
    re.compile(r"\b(?:wait|sorry)\s*$", re.I),
    re.compile(r"\byou know\s*$", re.I),
    re.compile(r"\bI mean\s*$", re.I),
    # Incomplete clauses
    re.compile(r"\bI was\s*$", re.I),
    re.compile(r"\bI think\s*$", re.I),
    re.compile(r"\blet me\s*$", re.I),
    re.compile(r"\bit'?s like\s*$", re.I),
    re.compile(r"\bthe thing is\s*$", re.I),
    # Trailing prepositions (only strong mid-sentence ones, not articles)
    re.compile(r"\b(?:to|for|with)\s*$", re.I),
]

# Fragment start patterns — short phrases beginning with function words are often
# mid-sentence fragments (e.g. "are getting better", "with my friend").
# Only applied when word_count <= _FRAGMENT_MAX_WORDS, except for a slightly
# longer conjunction-led restart like "but I still feel off sometimes".
_FRAGMENT_MAX_WORDS = 3
_CONJUNCTION_FRAGMENT_MAX_WORDS = 4
_FRAGMENT_CONJUNCTION_START_PATTERN: re.Pattern[str] = re.compile(
    r"^\s*(?:and|but|because|so|or|although|though)\b",
    re.IGNORECASE,
)
_FRAGMENT_START_PATTERN: re.Pattern[str] = re.compile(
    r"^\s*(?:"
    r"are|is|was|were|am|"                                          # linking / aux verbs
    r"have|has|had|"
    r"do|does|did|"
    r"will|would|could|should|might|can|may|shall|"                 # modals
    r"being|getting|going|having|"                                  # participles
    r"not|never|also|still|just|even|wait|sorry|"                   # mid-sentence adverbs / corrections
    r"than|then|"                                                   # comparison / sequence
    r"that|which|who|whom|whose|where|when|while|"                  # relative / subordinate
    r"in|on|at|with|for|from|about|into|through|over|under|"        # prepositions
    r"the|a|an"                                                     # articles
    r")\b",
    re.IGNORECASE,
)

_TURN_END_GUARD_RELEASE_NEW_WORDS = 4
_NON_FINAL_STABLE_SUBMISSION_MAX_WORDS = 6
_SUBMISSION_STABILIZATION_RATIO = 0.25
_MIN_SUBMISSION_STABILIZATION_MS = 120

# Debounce window for TurnStartedEvent. Without this, Silero VAD fires a new
# "turn started" every time the speaker pauses mid-sentence (", Um, ... "),
# which triggers redundant agent interrupts during a single user utterance.
_DEFAULT_TURN_START_DEBOUNCE_MS = 1200


class SophiaTurnDetection(SmartTurnDetection):
    """SmartTurnDetection with echo suppression and adaptive silence thresholds."""

    def __init__(
        self,
        echo_cooldown_ms: int = DEFAULT_ECHO_COOLDOWN_MS,
        *,
        adaptive_silence_short_ms: int = 600,
        adaptive_silence_medium_ms: int = 800,
        adaptive_silence_long_ms: int = 1200,
        adaptive_silence_ceiling_ms: int = 1400,
        adaptive_silence_continuation_bonus_ms: int = 300,
        adaptive_silence_fragment_bonus_ms: int = 500,
        turn_start_debounce_ms: int = _DEFAULT_TURN_START_DEBOUNCE_MS,
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
        self._fragment_bonus_ms = adaptive_silence_fragment_bonus_ms

        # TurnStarted debounce — collapses repeat starts inside a single
        # utterance into one, preventing triple-interrupts on natural pauses.
        self._turn_start_debounce_sec = max(0.0, turn_start_debounce_ms / 1000)
        self._last_turn_start_at: dict[Optional[str], float] = {}

        # Mutable state — updated by STT events
        self._current_transcript: str = ""
        self._current_transcript_is_final = False
        self._rhythm_offset_ms: int = 0
        self._diagnostic_callback: Callable[[str | None], None] | None = None
        self._turn_end_guard_active = False
        self._turn_end_guard_fingerprint: str | None = None
        self._turn_end_guard_transcript: str = ""
        self._turn_end_guard_was_final = False

    def attach_diagnostic_callback(
        self,
        callback: Callable[[str | None], None],
    ) -> None:
        self._diagnostic_callback = callback

    def note_agent_will_speak(self) -> None:
        """Call before TTS starts generating. Suppresses VAD immediately."""
        self.clear_turn_end_guard()
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
        self.clear_turn_end_guard()
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

    def update_transcript(self, text: str, *, is_final: bool = False) -> None:
        """Feed the latest STT partial/final transcript so silence adapts."""
        self._current_transcript = text
        self._current_transcript_is_final = is_final
        self._apply_adaptive_silence()

    def reset_transcript(self) -> None:
        """Clear transcript state after a turn ends."""
        self._current_transcript = ""
        self._current_transcript_is_final = False
        # Restore base value so SmartTurn uses the word-count default for
        # the next turn until a new transcript arrives.
        self._apply_adaptive_silence()

    def get_turn_transcript(self) -> str:
        return self._current_transcript.strip()

    def should_stabilize_submission(self, transcript: str | None = None) -> bool:
        text = (transcript or self._current_transcript).strip()
        if not text:
            return True

        word_count = len(text.split())
        if self._has_continuation_signal(text) or self._is_fragment(text, word_count):
            return True

        if self._current_transcript_is_final:
            return False

        # Non-final transcripts are common even when the spoken thought is
        # already stable. Only pay the extra stabilization delay for short
        # phrases where pause-mid-thought risk is still high.
        return word_count <= _NON_FINAL_STABLE_SUBMISSION_MAX_WORDS

    def get_submission_stabilization_plan(
        self,
        max_window_ms: int,
        transcript: str | None = None,
    ) -> tuple[int, str | None]:
        if max_window_ms <= 0:
            return 0, None

        text = (transcript or self._current_transcript).strip()
        if not text:
            return max_window_ms, "empty"

        if not self.should_stabilize_submission(text):
            return 0, None

        word_count = len(text.split())
        if self._is_fragment(text, word_count):
            reason = "fragment"
        elif self._has_continuation_signal(text):
            reason = "continuation"
        else:
            reason = "short_non_final"

        adaptive_window_ms = getattr(self, "_trailing_silence_ms", self._short_ms)
        delay_ms = max(
            _MIN_SUBMISSION_STABILIZATION_MS,
            int(adaptive_window_ms * _SUBMISSION_STABILIZATION_RATIO),
        )
        return min(max_window_ms, delay_ms), reason

    def clear_turn_end_guard(self) -> None:
        self._turn_end_guard_active = False
        self._turn_end_guard_fingerprint = None
        self._turn_end_guard_transcript = ""
        self._turn_end_guard_was_final = False

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

        # Continuation bonus — trailing signals OR short fragment starts.
        # Non-final fragmentary clauses get a stronger hold because they are the
        # common pause-mid-thought pattern in live sessions.
        continuation = self._has_continuation_signal(self._current_transcript)
        fragment = self._is_fragment(self._current_transcript, word_count)
        fragment_hold = fragment and not self._current_transcript_is_final
        if fragment_hold:
            bonus = self._fragment_bonus_ms
        elif continuation or fragment:
            bonus = self._continuation_bonus_ms
        else:
            bonus = 0

        # Rhythm offset
        raw = base + bonus + self._rhythm_offset_ms
        effective = max(self._short_ms, min(raw, self._ceiling_ms))

        self._trailing_silence_ms = effective  # type: ignore[attr-defined]

        reason_parts: list[str] = [f"words={word_count}", f"base={base}"]
        if fragment_hold:
            reason_parts.append(f"fragment_hold=+{self._fragment_bonus_ms}")
        elif continuation:
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
        if word_count == 0:
            return False
        stripped = text.strip()
        if word_count <= _FRAGMENT_MAX_WORDS and _FRAGMENT_START_PATTERN.match(stripped):
            return True

        return bool(
            word_count <= _CONJUNCTION_FRAGMENT_MAX_WORDS
            and _FRAGMENT_CONJUNCTION_START_PATTERN.match(stripped)
        )

    def _emit_start_turn_event(self, event: Any) -> None:
        """Debounce TurnStartedEvent inside a single utterance.

        Silero VAD re-triggers on every short silence (commas, "um", mid-sentence
        pauses), which the agent layer treats as barge-in and calls
        ``tts.interrupt`` repeatedly. We collapse starts that arrive within the
        debounce window to a single event per participant.
        """
        participant = getattr(event, "participant", None)
        pid = getattr(participant, "user_id", None)
        now = time.monotonic()
        last = self._last_turn_start_at.get(pid)
        if (
            self._turn_start_debounce_sec > 0.0
            and last is not None
            and (now - last) < self._turn_start_debounce_sec
        ):
            logger.info(
                "[VAD] TURN_START_DEBOUNCED participant=%s since_last_ms=%.0f window_ms=%.0f",
                pid,
                (now - last) * 1000,
                self._turn_start_debounce_sec * 1000,
            )
            return
        self._last_turn_start_at[pid] = now
        super()._emit_start_turn_event(event)

    async def _emit_end_turn_event(self, *args: Any, **kwargs: Any) -> None:
        if self._should_suppress_turn_end():
            logger.info(
                "[VAD] TURN_END_SUPPRESSED fingerprint=%r transcript_chars=%d",
                self._turn_end_guard_fingerprint,
                len(self._current_transcript.strip()),
            )
            return

        self._turn_end_guard_active = True
        self._turn_end_guard_fingerprint = self._normalized_transcript(self._current_transcript)
        self._turn_end_guard_transcript = self._current_transcript.strip()
        self._turn_end_guard_was_final = self._current_transcript_is_final
        logger.info(
            "[VAD] TURN_ENDED transcript_chars=%d is_final=%s preview=%r",
            len(self._turn_end_guard_transcript),
            self._turn_end_guard_was_final,
            self._turn_end_guard_transcript[:80],
        )
        await super()._emit_end_turn_event(*args, **kwargs)

    def _should_suppress_turn_end(self) -> bool:
        if not self._turn_end_guard_active:
            return False

        current_transcript = self._current_transcript.strip()
        if not current_transcript:
            return True

        fingerprint = self._normalized_transcript(current_transcript)
        new_word_count = self._count_new_words(
            self._turn_end_guard_transcript,
            current_transcript,
        )
        word_count = len(current_transcript.split())
        has_continuation_signal = self._has_continuation_signal(current_transcript)
        is_fragment = self._is_fragment(current_transcript, word_count)

        if self._current_transcript_is_final and not self._turn_end_guard_was_final:
            self.clear_turn_end_guard()
            return False

        if (
            fingerprint
            and fingerprint != self._turn_end_guard_fingerprint
            and new_word_count >= _TURN_END_GUARD_RELEASE_NEW_WORDS
            and not has_continuation_signal
            and not is_fragment
        ):
            self.clear_turn_end_guard()
            return False

        return True

    @staticmethod
    def _normalized_transcript(text: str) -> str:
        return " ".join(text.lower().split())

    @staticmethod
    def _count_new_words(previous: str, current: str) -> int:
        previous_count = len(previous.split()) if previous else 0
        current_count = len(current.split()) if current else 0
        return max(0, current_count - previous_count)

    async def process_audio(
        self,
        audio_data: Any,
        participant: Any,
        conversation: Optional[Any] = None,
    ) -> None:
        if self.is_suppressed:
            if self._diagnostic_callback is not None:
                self._diagnostic_callback(getattr(participant, "user_id", None))
            return
        await super().process_audio(audio_data, participant, conversation)
