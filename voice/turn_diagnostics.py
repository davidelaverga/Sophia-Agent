from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4


TurnDiagnosticReason = Literal[
    "backend_stall",
    "completed",
    "continuation_handling",
    "echo_suppression",
    "silence_timing",
    "transcript_gap",
]
TurnDiagnosticStatus = Literal["completed", "failed"]


@dataclass
class TurnDiagnostic:
    user_id: str
    turn_id: str
    status: TurnDiagnosticStatus
    reason: TurnDiagnosticReason
    raw_false_end_count: int
    duplicate_phase_counts: dict[str, int]
    backend_request_start_ms: float | None = None
    backend_first_event_ms: float | None = None
    first_text_ms: float | None = None
    backend_complete_ms: float | None = None
    first_audio_ms: float | None = None

    def as_payload(self) -> dict[str, object]:
        return {
            "turn_id": self.turn_id,
            "status": self.status,
            "reason": self.reason,
            "raw_false_end_count": self.raw_false_end_count,
            "duplicate_phase_counts": dict(self.duplicate_phase_counts),
            "backend_request_start_ms": self.backend_request_start_ms,
            "backend_first_event_ms": self.backend_first_event_ms,
            "first_text_ms": self.first_text_ms,
            "backend_complete_ms": self.backend_complete_ms,
            "first_audio_ms": self.first_audio_ms,
        }


@dataclass
class _ActiveTurn:
    user_id: str
    speech_ended_at: float
    turn_id: str = field(default_factory=lambda: str(uuid4()))
    raw_false_end_count: int = 1
    duplicate_phase_counts: dict[str, int] = field(default_factory=dict)
    backend_request_start_ms: float | None = None
    backend_first_event_ms: float | None = None
    first_text_ms: float | None = None
    backend_complete_ms: float | None = None
    first_audio_ms: float | None = None
    final_text_emitted: bool = False
    agent_cycle_count: int = 0
    completed_audio_cycles: int = 0
    audio_cycle_open: bool = False
    agent_started_emitted: bool = False
    agent_ended_emitted: bool = False
    reason_hint: TurnDiagnosticReason = "silence_timing"
    terminal_status: TurnDiagnosticStatus | None = None


class TurnDiagnosticsTracker:
    def __init__(self) -> None:
        self._turns: dict[str, _ActiveTurn] = {}

    def note_user_ended(self, user_id: str, now: float) -> str:
        current = self._turns.get(user_id)
        if current is None or current.terminal_status is not None:
            current = _ActiveTurn(user_id=user_id, speech_ended_at=now)
            self._turns[user_id] = current
            return current.turn_id

        current.raw_false_end_count += 1
        return current.turn_id

    def note_agent_phase(
        self,
        user_id: str,
        phase: Literal["agent_started", "agent_ended"],
    ) -> bool:
        current = self._turns.get(user_id)
        if current is None:
            return True

        if phase == "agent_started":
            if current.audio_cycle_open:
                current.duplicate_phase_counts[phase] = (
                    current.duplicate_phase_counts.get(phase, 0) + 1
                )
                return False

            current.agent_cycle_count += 1
            current.audio_cycle_open = True
            if current.agent_started_emitted:
                current.duplicate_phase_counts[phase] = (
                    current.duplicate_phase_counts.get(phase, 0) + 1
                )
                return False

            current.agent_started_emitted = True
            return True

        if current.audio_cycle_open:
            current.completed_audio_cycles += 1
            current.audio_cycle_open = False
        else:
            current.duplicate_phase_counts[phase] = (
                current.duplicate_phase_counts.get(phase, 0) + 1
            )
            return False

        if current.agent_ended_emitted:
            current.duplicate_phase_counts[phase] = (
                current.duplicate_phase_counts.get(phase, 0) + 1
            )
            return False

        current.agent_ended_emitted = True
        return True

    def note_backend_request_start(
        self,
        user_id: str,
        now: float,
    ) -> float | None:
        current = self._turns.get(user_id)
        if current is None or current.backend_request_start_ms is not None:
            return None

        current.backend_request_start_ms = (now - current.speech_ended_at) * 1000
        return current.backend_request_start_ms

    def note_backend_first_event(
        self,
        user_id: str,
        now: float,
    ) -> float | None:
        current = self._turns.get(user_id)
        if current is None or current.backend_first_event_ms is not None:
            return None

        current.backend_first_event_ms = (now - current.speech_ended_at) * 1000
        return current.backend_first_event_ms

    def note_first_text(self, user_id: str, now: float) -> float | None:
        current = self._turns.get(user_id)
        if current is None or current.first_text_ms is not None:
            return None

        current.first_text_ms = (now - current.speech_ended_at) * 1000
        return current.first_text_ms

    def note_backend_complete(
        self,
        user_id: str,
        now: float,
    ) -> float | None:
        current = self._turns.get(user_id)
        if current is None:
            return None

        if current.backend_complete_ms is None:
            current.backend_complete_ms = (now - current.speech_ended_at) * 1000

        return current.backend_complete_ms

    def note_first_audio(self, user_id: str, now: float) -> float | None:
        current = self._turns.get(user_id)
        if current is None or current.first_audio_ms is not None:
            return None

        current.first_audio_ms = (now - current.speech_ended_at) * 1000
        return current.first_audio_ms

    def note_final_text(self, user_id: str) -> None:
        current = self._turns.get(user_id)
        if current is None:
            return

        current.final_text_emitted = True

    def annotate_reason(self, user_id: str, reason: TurnDiagnosticReason) -> None:
        current = self._turns.get(user_id)
        if current is None or current.terminal_status is not None:
            return

        current.reason_hint = reason

    def fail(
        self,
        user_id: str,
        reason: TurnDiagnosticReason,
    ) -> TurnDiagnostic | None:
        current = self._turns.get(user_id)
        if current is None or current.terminal_status is not None:
            return None

        current.terminal_status = "failed"
        current.reason_hint = reason
        diagnostic = self._build_diagnostic(current)
        self._turns.pop(user_id, None)
        return diagnostic

    def can_finalize(self, user_id: str) -> bool:
        current = self._turns.get(user_id)
        if current is None or current.terminal_status is not None:
            return False

        if current.backend_complete_ms is None:
            return False
        if current.agent_cycle_count == 0:
            return False

        if current.completed_audio_cycles >= current.agent_cycle_count:
            return True

        return (
            current.agent_started_emitted
            and current.final_text_emitted
            and current.first_audio_ms is None
        )

    def complete(self, user_id: str) -> TurnDiagnostic | None:
        current = self._turns.get(user_id)
        if current is None or current.terminal_status is not None:
            return None
        if not self.can_finalize(user_id):
            return None

        current.terminal_status = "completed"
        current.reason_hint = "completed"
        diagnostic = self._build_diagnostic(current)
        self._turns.pop(user_id, None)
        return diagnostic

    @staticmethod
    def _build_diagnostic(current: _ActiveTurn) -> TurnDiagnostic:
        status = current.terminal_status or "failed"
        return TurnDiagnostic(
            user_id=current.user_id,
            turn_id=current.turn_id,
            status=status,
            reason=current.reason_hint,
            raw_false_end_count=current.raw_false_end_count,
            duplicate_phase_counts=dict(current.duplicate_phase_counts),
            backend_request_start_ms=current.backend_request_start_ms,
            backend_first_event_ms=current.backend_first_event_ms,
            first_text_ms=current.first_text_ms,
            backend_complete_ms=current.backend_complete_ms,
            first_audio_ms=current.first_audio_ms,
        )