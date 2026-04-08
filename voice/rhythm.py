"""Per-user speech rhythm tracking (Layer 3).

Tracks pause durations and turn characteristics across sessions.
After ≥ ``rhythm_min_sessions`` sessions, computes a silence offset
that biases the adaptive silence threshold (Layer 1) for this user.

Rhythm data is stored as a flat JSON file under
``users/{user_id}/rhythm.json``.  It is NOT stored in Mem0 — rhythm
is operational tuning data, not user memory.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Population-average pause duration used as baseline.
_POPULATION_AVG_PAUSE_MS: float = 1200.0


class RhythmData:
    """In-memory representation of a user's rhythm metrics."""

    __slots__ = (
        "session_count",
        "avg_pause_ms",
        "avg_words_per_turn",
        "multi_clause_frequency",
        "cancel_merge_frequency",
        "last_updated",
    )

    def __init__(
        self,
        session_count: int = 0,
        avg_pause_ms: float = 0.0,
        avg_words_per_turn: float = 0.0,
        multi_clause_frequency: float = 0.0,
        cancel_merge_frequency: float = 0.0,
        last_updated: str = "",
    ) -> None:
        self.session_count = session_count
        self.avg_pause_ms = avg_pause_ms
        self.avg_words_per_turn = avg_words_per_turn
        self.multi_clause_frequency = multi_clause_frequency
        self.cancel_merge_frequency = cancel_merge_frequency
        self.last_updated = last_updated

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_count": self.session_count,
            "avg_pause_ms": self.avg_pause_ms,
            "avg_words_per_turn": self.avg_words_per_turn,
            "multi_clause_frequency": self.multi_clause_frequency,
            "cancel_merge_frequency": self.cancel_merge_frequency,
            "last_updated": self.last_updated,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RhythmData:
        return cls(
            session_count=int(data.get("session_count", 0)),
            avg_pause_ms=float(data.get("avg_pause_ms", 0.0)),
            avg_words_per_turn=float(data.get("avg_words_per_turn", 0.0)),
            multi_clause_frequency=float(data.get("multi_clause_frequency", 0.0)),
            cancel_merge_frequency=float(data.get("cancel_merge_frequency", 0.0)),
            last_updated=str(data.get("last_updated", "")),
        )


class RhythmTracker:
    """Tracks and persists per-user speech rhythm metrics.

    Parameters
    ----------
    users_dir:
        Root directory for user data (contains ``{user_id}/rhythm.json``).
    min_sessions:
        Minimum sessions before rhythm learning activates.
    base_min_ms:
        Floor for the total adaptive silence base (after offset applied).
    base_max_ms:
        Ceiling for the total adaptive silence base (after offset applied).
    """

    def __init__(
        self,
        users_dir: Path,
        *,
        min_sessions: int = 5,
        base_min_ms: int = 800,
        base_max_ms: int = 2400,
    ) -> None:
        self._users_dir = users_dir
        self._min_sessions = min_sessions
        self._base_min_ms = base_min_ms
        self._base_max_ms = base_max_ms

        # Per-session accumulators
        self._turn_pause_ms: list[float] = []
        self._turn_word_counts: list[int] = []
        self._cancel_merge_count: int = 0
        self._multi_clause_count: int = 0
        self._total_turns: int = 0

        # Loaded data
        self._data: RhythmData | None = None
        self._user_id: str | None = None

    # ------------------------------------------------------------------
    # Load / save
    # ------------------------------------------------------------------

    def load(self, user_id: str) -> RhythmData | None:
        """Load rhythm data for *user_id*. Returns None for new users."""
        self._user_id = user_id
        path = self._rhythm_path(user_id)
        if not path.exists():
            logger.debug("[RHYTHM] No rhythm file for user %s — new user", user_id)
            self._data = None
            return None

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            self._data = RhythmData.from_dict(raw)
            logger.info(
                "[RHYTHM] Loaded rhythm for %s: sessions=%d avg_pause=%.0fms",
                user_id,
                self._data.session_count,
                self._data.avg_pause_ms,
            )
            return self._data
        except (json.JSONDecodeError, KeyError, ValueError):
            logger.warning("[RHYTHM] Corrupt rhythm file for %s — treating as new user", user_id)
            self._data = None
            return None

    def end_session(self) -> None:
        """Persist updated rhythm metrics after a session ends."""
        if self._user_id is None:
            return

        if self._data is None:
            self._data = RhythmData()

        # Update running averages with session data
        n = self._data.session_count
        if self._turn_pause_ms:
            session_avg_pause = sum(self._turn_pause_ms) / len(self._turn_pause_ms)
            self._data.avg_pause_ms = _running_avg(
                self._data.avg_pause_ms, session_avg_pause, n
            )

        if self._turn_word_counts:
            session_avg_words = sum(self._turn_word_counts) / len(self._turn_word_counts)
            self._data.avg_words_per_turn = _running_avg(
                self._data.avg_words_per_turn, session_avg_words, n
            )

        if self._total_turns > 0:
            session_multi_freq = self._multi_clause_count / self._total_turns
            self._data.multi_clause_frequency = _running_avg(
                self._data.multi_clause_frequency, session_multi_freq, n
            )
            session_cancel_freq = self._cancel_merge_count / self._total_turns
            self._data.cancel_merge_frequency = _running_avg(
                self._data.cancel_merge_frequency, session_cancel_freq, n
            )

        self._data.session_count = n + 1
        self._data.last_updated = datetime.now(timezone.utc).isoformat()

        # Write
        path = self._rhythm_path(self._user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self._data.to_dict(), indent=2),
            encoding="utf-8",
        )
        logger.info(
            "[RHYTHM] Saved rhythm for %s: sessions=%d avg_pause=%.0fms",
            self._user_id,
            self._data.session_count,
            self._data.avg_pause_ms,
        )

        # Reset accumulators
        self._turn_pause_ms.clear()
        self._turn_word_counts.clear()
        self._cancel_merge_count = 0
        self._multi_clause_count = 0
        self._total_turns = 0

    # ------------------------------------------------------------------
    # Per-turn recording
    # ------------------------------------------------------------------

    def record_turn(
        self,
        word_count: int,
        pause_durations: list[float],
        was_cancel_merge: bool = False,
    ) -> None:
        """Record metrics from a single turn."""
        self._total_turns += 1
        self._turn_word_counts.append(word_count)
        self._turn_pause_ms.extend(pause_durations)

        if was_cancel_merge:
            self._cancel_merge_count += 1

        # Multi-clause heuristic: > 10 words suggests compound thought
        if word_count > 10:
            self._multi_clause_count += 1

    # ------------------------------------------------------------------
    # Silence offset computation
    # ------------------------------------------------------------------

    def compute_silence_offset(self) -> int:
        """Return ms offset to add to the Layer 1 adaptive silence base.

        Positive for slow speakers, negative for fast speakers.
        Returns 0 if insufficient sessions.
        """
        if self._data is None or self._data.session_count < self._min_sessions:
            return 0

        # Compare user's average pause against population baseline
        diff = self._data.avg_pause_ms - _POPULATION_AVG_PAUSE_MS
        # Scale by 0.5 to avoid overreacting
        offset = int(diff * 0.5)

        # Clamp: the TOTAL base (Layer 1 base + offset) must stay within bounds.
        # Since Layer 1 base ranges from ~1000 to ~2000, we clamp the offset
        # so that the minimum possible total (1000 + offset) >= base_min_ms
        # and maximum possible total (2000 + offset) <= base_max_ms.
        min_offset = self._base_min_ms - 1000  # e.g. 800 - 1000 = -200
        max_offset = self._base_max_ms - 2000  # e.g. 2400 - 2000 = +400
        offset = max(min_offset, min(offset, max_offset))

        logger.debug(
            "[RHYTHM] Silence offset=%+dms (avg_pause=%.0fms, population=%.0fms)",
            offset,
            self._data.avg_pause_ms,
            _POPULATION_AVG_PAUSE_MS,
        )
        return offset

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _rhythm_path(self, user_id: str) -> Path:
        return self._users_dir / user_id / "rhythm.json"


def _running_avg(current: float, new_value: float, n: int) -> float:
    """Compute running average: incorporates new_value as the (n+1)th sample."""
    if n == 0:
        return new_value
    return (current * n + new_value) / (n + 1)
