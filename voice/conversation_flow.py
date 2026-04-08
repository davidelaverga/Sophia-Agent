"""Cancel-and-merge coordinator for conversational flow (Layer 2).

When SmartTurn fires prematurely (user paused mid-thought), the coordinator
opens a *fragile window*.  If the user continues speaking within that window
the coordinator:

1. Cancels the in-flight LLM response.
2. Interrupts TTS playback.
3. Sends a brief acknowledgment ("Go on.", "Mm-hmm.", …).
4. Waits for the user to finish their full thought.
5. Resubmits the merged transcript as a single turn.

If the fragile window expires without new speech, normal response proceeds
with zero added latency (R8).
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# ---- Acknowledgment phrase pool (R9) ----
ACKNOWLEDGMENT_PHRASES: list[str] = [
    "Go on.",
    "Mm-hmm.",
    "Sorry, continue.",
    "I'm listening.",
    "Take your time.",
]


class ConversationFlowCoordinator:
    """Monitors the post-turn-end fragile window and orchestrates cancel-and-merge.

    Parameters
    ----------
    fragile_window_ms:
        Duration (ms) after a turn ends during which new user speech triggers
        cancel-and-merge.
    merge_min_new_words:
        Minimum number of new words (compared to original transcript) required
        to trigger cancel-and-merge inside the fragile window.
    cancel_llm_task:
        Async callback to cancel the active LLM task.
    interrupt_tts:
        Sync or async callback to stop TTS playback immediately.
    send_acknowledgment:
        Async callback that speaks an acknowledgment phrase via TTS.
    resubmit_response:
        Async callback(transcript, participant) to submit a merged transcript
        as a new LLM turn.
    """

    def __init__(
        self,
        *,
        fragile_window_ms: int = 600,
        merge_min_new_words: int = 2,
        backend_stall_timeout_ms: int = 8000,
        same_turn_repeat_debounce_ms: int = 1200,
        cancel_llm_task: Callable[[], Awaitable[None]],
        interrupt_tts: Callable[[], Awaitable[None]],
        send_acknowledgment: Callable[[str], Awaitable[None]],
        on_backend_stall: Callable[[object | None, str], Awaitable[None]],
        record_turn: Callable[[int, list[float], bool], None] | None,
        resubmit_response: Callable[[str, object], Awaitable[None]],
    ) -> None:
        self._fragile_window_ms = fragile_window_ms
        self._merge_min_new_words = merge_min_new_words
        self._backend_stall_timeout_ms = backend_stall_timeout_ms
        self._same_turn_repeat_debounce_ms = same_turn_repeat_debounce_ms

        # Callbacks (injected, not imported)
        self._cancel_llm_task = cancel_llm_task
        self._interrupt_tts = interrupt_tts
        self._send_acknowledgment = send_acknowledgment
        self._on_backend_stall = on_backend_stall
        self._record_turn = record_turn
        self._resubmit_response = resubmit_response

        # Per-turn state
        self._original_transcript: str = ""
        self._participant: Optional[object] = None
        self._fragile_window_task: Optional[asyncio.Task[None]] = None
        self._backend_stall_task: Optional[asyncio.Task[None]] = None
        self._merge_pending: bool = False
        self._cancel_count: int = 0  # R12: at most once per user turn
        self._last_ack_index: int = -1
        self._active_turn_fingerprint: str | None = None
        self._active_turn_word_count: int = 0
        self._active_turn_pause_ms: list[float] = []
        self._active_turn_was_cancel_merge: bool = False
        self._last_turn_end_at: float | None = None
        self._last_resolved_fingerprint: str | None = None
        self._last_resolved_at: float | None = None
        self._submitted_transcript: str = ""
        self._submitted_participant: Optional[object] = None
        self._response_in_progress: bool = False
        self._backend_progress_seen: bool = False

    # ------------------------------------------------------------------
    # Public event handlers
    # ------------------------------------------------------------------

    def on_turn_ended(self, transcript: str, participant: object) -> bool:
        """Called when SmartTurn fires TurnEndedEvent.

        Stores the original transcript and starts the fragile window.
        """
        now = time.monotonic()
        fingerprint = self._fingerprint(transcript)

        if self._should_suppress_repeat(fingerprint):
            if self._last_turn_end_at is not None:
                self._active_turn_pause_ms.append((now - self._last_turn_end_at) * 1000)
            self._last_turn_end_at = now
            logger.info("[FLOW] Suppressing repeat turn end for unchanged transcript")
            return False

        if self._is_recently_resolved_repeat(fingerprint, now):
            logger.debug("[FLOW] Debounced repeat turn end for recently resolved transcript")
            return False

        self._cancel_fragile_window()
        self._cancel_backend_stall()
        self._original_transcript = transcript
        self._participant = participant
        self._cancel_count = 0
        self._merge_pending = False
        self._active_turn_fingerprint = fingerprint
        self._active_turn_word_count = len(transcript.split()) if transcript.strip() else 0
        self._active_turn_pause_ms = []
        self._active_turn_was_cancel_merge = False
        self._backend_progress_seen = False
        self._last_turn_end_at = now

        # Start the fragile window timer
        self._start_fragile_window()
        self._start_backend_stall_timer()
        logger.debug(
            "[FLOW] Fragile window started (%dms) transcript=%r",
            self._fragile_window_ms,
            transcript[:60],
        )
        return True

    def on_partial_transcript(self, text: str) -> None:
        """Called on each STT partial/final during the fragile window.

        If the user has spoken ≥merge_min_new_words beyond the original
        transcript, triggers cancel-and-merge.
        """
        if not self._is_fragile_window_active():
            return

        merged = self._merge_transcripts(self._original_transcript, text)
        new_words = self._count_new_words(self._original_transcript, merged)
        if new_words >= self._merge_min_new_words and self._cancel_count == 0:
            logger.info(
                "[FLOW] Cancel-and-merge triggered: %d new word(s) detected",
                new_words,
            )
            self._cancel_count += 1
            self._merge_pending = True
            self._active_turn_was_cancel_merge = True
            self._cancel_fragile_window()
            asyncio.ensure_future(self._execute_cancel_and_merge())

    def on_merge_turn_ended(self, transcript: str) -> None:
        """Called when the user finishes their continued thought after cancel.

        Merges original + continuation and resubmits.
        """
        if not self._merge_pending:
            return

        self._merge_pending = False
        merged = self._merge_transcripts(self._original_transcript, transcript)
        if not merged.strip():
            logger.warning("[FLOW] Skipping resubmit — merged transcript is empty")
            return
        self._original_transcript = merged
        self._active_turn_fingerprint = self._fingerprint(merged)
        self._active_turn_word_count = len(merged.split()) if merged.strip() else 0
        self._last_turn_end_at = time.monotonic()
        self._start_backend_stall_timer()
        logger.info("[FLOW] Resubmitting merged transcript (%d chars)", len(merged))
        asyncio.ensure_future(self._resubmit_response(merged, self._participant))

    def on_agent_started(self) -> None:
        self._cancel_backend_stall()

    def on_agent_ended(self) -> None:
        self._finish_active_turn(resolved=True)

    def on_backend_progress(self) -> None:
        self._backend_progress_seen = True
        self._cancel_backend_stall()

    def mark_response_submitted(self, transcript: str, participant: object) -> None:
        normalized_transcript = transcript.strip()
        self._submitted_transcript = normalized_transcript
        self._submitted_participant = participant
        self._response_in_progress = bool(normalized_transcript)
        self._backend_progress_seen = False
        if normalized_transcript:
            self._original_transcript = normalized_transcript
            self._participant = participant
            self._active_turn_fingerprint = self._fingerprint(normalized_transcript)
            self._active_turn_word_count = len(normalized_transcript.split())
        self._start_backend_stall_timer()

    async def defer_response_for_continuation(
        self,
        transcript: str,
        participant: object,
    ) -> str | None:
        if not self._response_in_progress or self._backend_progress_seen:
            return None

        if not self._same_participant(participant, self._submitted_participant):
            return None

        updated = transcript.strip()
        original = self._submitted_transcript.strip()
        if not original or not updated:
            return None

        merged = self._merge_transcripts(original, updated)
        new_words = self._count_new_words(original, merged)
        if new_words < self._merge_min_new_words:
            return None

        logger.info(
            "[FLOW] Pre-response continuation detected: %d new word(s) before first text",
            new_words,
        )

        try:
            await self._cancel_llm_task()
        except Exception:
            logger.exception("[FLOW] Failed to cancel LLM task during pre-response continuation")

        try:
            await self._interrupt_tts()
        except Exception:
            logger.exception("[FLOW] Failed to interrupt TTS during pre-response continuation")

        self._cancel_fragile_window()
        self._cancel_backend_stall()
        self._merge_pending = True
        self._active_turn_was_cancel_merge = True
        self._response_in_progress = False
        self._backend_progress_seen = False
        self._submitted_transcript = ""
        self._submitted_participant = None
        self._original_transcript = original
        self._participant = participant
        self._active_turn_fingerprint = self._fingerprint(original)
        self._active_turn_word_count = len(original.split()) if original else 0
        self._last_turn_end_at = time.monotonic()
        return merged

    async def recover_late_continuation(
        self,
        transcript: str,
        participant: object,
    ) -> str | None:
        if not self._response_in_progress:
            return None

        if not self._same_participant(participant, self._submitted_participant):
            return None

        updated = transcript.strip()
        original = self._submitted_transcript.strip()
        if not original or not updated:
            return None

        merged = self._merge_transcripts(original, updated)
        if merged == original:
            return None

        new_words = self._count_new_words(original, merged)
        if new_words < self._merge_min_new_words:
            return None

        logger.info(
            "[FLOW] Late continuation recovery triggered: %d new word(s) after response start",
            new_words,
        )

        try:
            await self._cancel_llm_task()
        except Exception:
            logger.exception("[FLOW] Failed to cancel LLM task during late continuation")

        try:
            await self._interrupt_tts()
        except Exception:
            logger.exception("[FLOW] Failed to interrupt TTS during late continuation")

        self._cancel_fragile_window()
        self._cancel_backend_stall()
        self._merge_pending = False
        self._active_turn_was_cancel_merge = True
        self._response_in_progress = False
        self._submitted_transcript = ""
        self._submitted_participant = None
        self._original_transcript = merged
        self._participant = participant
        self._active_turn_fingerprint = self._fingerprint(merged)
        self._active_turn_word_count = len(merged.split())
        self._last_turn_end_at = time.monotonic()
        return merged

    @property
    def is_merge_pending(self) -> bool:
        """True while waiting for the user to finish after cancel-and-merge."""
        return self._merge_pending

    # ------------------------------------------------------------------
    # Fragile window management
    # ------------------------------------------------------------------

    def _start_fragile_window(self) -> None:
        self._cancel_fragile_window()
        self._fragile_window_task = asyncio.ensure_future(self._fragile_window_timer())

    def _cancel_fragile_window(self) -> None:
        if self._fragile_window_task and not self._fragile_window_task.done():
            self._fragile_window_task.cancel()
            self._fragile_window_task = None

    def _start_backend_stall_timer(self) -> None:
        self._cancel_backend_stall()
        self._backend_stall_task = asyncio.ensure_future(self._backend_stall_timer())

    def _cancel_backend_stall(self) -> None:
        task = self._backend_stall_task
        if task is None:
            return

        self._backend_stall_task = None
        current_task = asyncio.current_task()
        if task is current_task:
            return

        if not task.done():
            task.cancel()

    def _is_fragile_window_active(self) -> bool:
        return (
            self._fragile_window_task is not None
            and not self._fragile_window_task.done()
        )

    async def _fragile_window_timer(self) -> None:
        """Wait for the fragile window to expire. Zero-cost if no user speech (R8)."""
        try:
            await asyncio.sleep(self._fragile_window_ms / 1000)
        except asyncio.CancelledError:
            return
        # Window expired with no new speech — normal response proceeds.
        logger.debug("[FLOW] Fragile window expired — normal response continues")

    async def _backend_stall_timer(self) -> None:
        try:
            await asyncio.sleep(self._backend_stall_timeout_ms / 1000)
        except asyncio.CancelledError:
            return

        participant = self._participant
        transcript = self._original_transcript
        logger.warning(
            "[FLOW] Backend stall after %dms without response progress",
            self._backend_stall_timeout_ms,
        )
        self._finish_active_turn(resolved=False)
        await self._on_backend_stall(participant, transcript)

    # ------------------------------------------------------------------
    # Cancel-and-merge execution
    # ------------------------------------------------------------------

    async def _execute_cancel_and_merge(self) -> None:
        """Cancel LLM + TTS, send acknowledgment."""
        try:
            await self._cancel_llm_task()
        except Exception:
            logger.exception("[FLOW] Failed to cancel LLM task — continuing anyway")

        try:
            await self._interrupt_tts()
        except Exception:
            logger.exception("[FLOW] Failed to interrupt TTS — continuing anyway")

        phrase = self._pick_acknowledgment()
        try:
            await self._send_acknowledgment(phrase)
        except Exception:
            logger.exception("[FLOW] Failed to send acknowledgment")

        logger.info("[FLOW] Cancel-and-merge complete — waiting for user to finish")

    def _finish_active_turn(self, *, resolved: bool) -> None:
        now = time.monotonic()
        if self._active_turn_fingerprint is not None:
            self._last_resolved_fingerprint = self._active_turn_fingerprint
            self._last_resolved_at = now

        if resolved and self._record_turn is not None and self._active_turn_word_count > 0:
            self._record_turn(
                self._active_turn_word_count,
                list(self._active_turn_pause_ms),
                was_cancel_merge=self._active_turn_was_cancel_merge,
            )

        self._cancel_fragile_window()
        self._cancel_backend_stall()
        self._merge_pending = False
        self._active_turn_fingerprint = None
        self._active_turn_word_count = 0
        self._active_turn_pause_ms = []
        self._active_turn_was_cancel_merge = False
        self._last_turn_end_at = None
        self._submitted_transcript = ""
        self._submitted_participant = None
        self._response_in_progress = False
        self._backend_progress_seen = False

    def _should_suppress_repeat(self, fingerprint: str) -> bool:
        return self._active_turn_fingerprint is not None and fingerprint == self._active_turn_fingerprint

    def _is_recently_resolved_repeat(self, fingerprint: str, now: float) -> bool:
        if self._last_resolved_fingerprint != fingerprint:
            return False
        if self._last_resolved_at is None:
            return False
        return (now - self._last_resolved_at) * 1000 < self._same_turn_repeat_debounce_ms

    @staticmethod
    def _same_participant(current: object, previous: object | None) -> bool:
        if previous is None:
            return False

        current_user_id = getattr(current, "user_id", None)
        previous_user_id = getattr(previous, "user_id", None)
        if current_user_id is not None or previous_user_id is not None:
            return current_user_id == previous_user_id

        return current is previous

    @staticmethod
    def _fingerprint(text: str) -> str:
        return " ".join(text.lower().split())

    # ------------------------------------------------------------------
    # Acknowledgment pool (R9)
    # ------------------------------------------------------------------

    def _pick_acknowledgment(self) -> str:
        """Return a phrase from the pool, never the same as the previous one."""
        pool = ACKNOWLEDGMENT_PHRASES
        if len(pool) <= 1:
            return pool[0] if pool else ""

        candidates = [i for i in range(len(pool)) if i != self._last_ack_index]
        idx = random.choice(candidates)
        self._last_ack_index = idx
        return pool[idx]

    # ------------------------------------------------------------------
    # Transcript helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _count_new_words(original: str, updated: str) -> int:
        """Count how many more words *updated* has compared to *original*.

        Uses a simple word-count delta.  This is intentionally not a diff —
        we only care whether the user has said *more*, not whether earlier
        words changed (STT can revise earlier words in partials).
        """
        orig_count = len(original.split()) if original.strip() else 0
        new_count = len(updated.split()) if updated.strip() else 0
        return max(0, new_count - orig_count)

    @staticmethod
    def _merge_transcripts(original: str, continuation: str) -> str:
        """Merge original and continuation into a single clean transcript.

        If the continuation already contains the original text (common with
        full transcript accumulation), just use the continuation as-is.
        """
        original = original.strip()
        continuation = continuation.strip()

        if not original:
            return continuation
        if not continuation:
            return original

        original_lower = original.lower()
        continuation_lower = continuation.lower()

        # If continuation already starts with the original, use continuation.
        if continuation_lower.startswith(original_lower):
            return continuation

        # If the continuation is already fully present inside the original,
        # keep the original instead of duplicating overlapping clauses.
        if continuation_lower in original_lower:
            return original

        original_tokens = original.split()
        continuation_tokens = continuation.split()
        original_tokens_lower = [token.lower() for token in original_tokens]
        continuation_tokens_lower = [token.lower() for token in continuation_tokens]
        max_overlap = min(len(original_tokens_lower), len(continuation_tokens_lower))

        for overlap in range(max_overlap, 0, -1):
            if original_tokens_lower[-overlap:] == continuation_tokens_lower[:overlap]:
                merged_tokens = original_tokens + continuation_tokens[overlap:]
                return " ".join(merged_tokens)

        return f"{original} {continuation}"
