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
        cancel_llm_task: Callable[[], Awaitable[None]],
        interrupt_tts: Callable[[], Awaitable[None]],
        send_acknowledgment: Callable[[str], Awaitable[None]],
        resubmit_response: Callable[[str, object], Awaitable[None]],
    ) -> None:
        self._fragile_window_ms = fragile_window_ms
        self._merge_min_new_words = merge_min_new_words

        # Callbacks (injected, not imported)
        self._cancel_llm_task = cancel_llm_task
        self._interrupt_tts = interrupt_tts
        self._send_acknowledgment = send_acknowledgment
        self._resubmit_response = resubmit_response

        # Per-turn state
        self._original_transcript: str = ""
        self._participant: Optional[object] = None
        self._fragile_window_task: Optional[asyncio.Task[None]] = None
        self._merge_pending: bool = False
        self._cancel_count: int = 0  # R12: at most once per user turn
        self._last_ack_index: int = -1

    # ------------------------------------------------------------------
    # Public event handlers
    # ------------------------------------------------------------------

    def on_turn_ended(self, transcript: str, participant: object) -> None:
        """Called when SmartTurn fires TurnEndedEvent.

        Stores the original transcript and starts the fragile window.
        """
        self._original_transcript = transcript
        self._participant = participant
        self._cancel_count = 0
        self._merge_pending = False

        # Start the fragile window timer
        self._start_fragile_window()
        logger.debug(
            "[FLOW] Fragile window started (%dms) transcript=%r",
            self._fragile_window_ms,
            transcript[:60],
        )

    def on_partial_transcript(self, text: str) -> None:
        """Called on each STT partial/final during the fragile window.

        If the user has spoken ≥merge_min_new_words beyond the original
        transcript, triggers cancel-and-merge.
        """
        if not self._is_fragile_window_active():
            return

        new_words = self._count_new_words(self._original_transcript, text)
        if new_words >= self._merge_min_new_words and self._cancel_count == 0:
            logger.info(
                "[FLOW] Cancel-and-merge triggered: %d new word(s) detected",
                new_words,
            )
            self._cancel_count += 1
            self._merge_pending = True
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
        logger.info("[FLOW] Resubmitting merged transcript (%d chars)", len(merged))
        asyncio.ensure_future(self._resubmit_response(merged, self._participant))

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

        # If continuation already starts with the original, use continuation.
        if continuation.lower().startswith(original.lower()):
            return continuation

        return f"{original} {continuation}"
