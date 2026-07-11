from __future__ import annotations

import time
from dataclasses import dataclass


class BuildDeadlineExceeded(TimeoutError):
    def __init__(self, *, stage: str, deadline_epoch_ms: int) -> None:
        super().__init__(f"Build deadline exceeded during {stage}")
        self.stage = stage
        self.deadline_epoch_ms = deadline_epoch_ms


@dataclass(frozen=True, slots=True)
class ExecutionEnvelope:
    started_epoch_ms: int
    deadline_epoch_ms: int
    terminal_reserve_seconds: int = 45

    @classmethod
    def from_timeout(
        cls,
        timeout_seconds: int,
        *,
        terminal_reserve_seconds: int = 45,
        now_epoch_ms: int | None = None,
    ) -> ExecutionEnvelope:
        started = now_epoch_ms if now_epoch_ms is not None else int(time.time() * 1000)
        deadline = started + max(0, timeout_seconds) * 1000 if timeout_seconds > 0 else 0
        return cls(started, deadline, terminal_reserve_seconds)

    @classmethod
    def from_state(cls, state: dict, *, terminal_reserve_seconds: int = 45) -> ExecutionEnvelope:
        started = int(state.get("builder_task_kickoff_ms", 0) or 0)
        deadline = int(state.get("builder_deadline_epoch_ms", 0) or 0)
        budget = state.get("builder_budget")
        if isinstance(budget, dict):
            configured_reserve = budget.get("terminal_reserve_seconds")
            if configured_reserve is not None:
                terminal_reserve_seconds = int(configured_reserve)
        return cls(started, deadline, max(0, terminal_reserve_seconds))

    @property
    def enabled(self) -> bool:
        return self.deadline_epoch_ms > 0

    def remaining_seconds(self, *, reserve_terminal: bool = False, now_epoch_ms: int | None = None) -> float:
        if not self.enabled:
            return float("inf")
        now = now_epoch_ms if now_epoch_ms is not None else int(time.time() * 1000)
        remaining = (self.deadline_epoch_ms - now) / 1000
        if reserve_terminal:
            remaining -= self.terminal_reserve_seconds
        return max(0.0, remaining)

    def child_timeout(self, requested_seconds: float, *, reserve_terminal: bool = True, minimum_seconds: float = 0.0) -> float:
        available = self.remaining_seconds(reserve_terminal=reserve_terminal)
        timeout = min(max(0.0, requested_seconds), available)
        if timeout <= minimum_seconds:
            raise BuildDeadlineExceeded(stage="child_reservation", deadline_epoch_ms=self.deadline_epoch_ms)
        return timeout

    def assert_remaining(self, *, stage: str, reserve_terminal: bool = False) -> None:
        if self.enabled and self.remaining_seconds(reserve_terminal=reserve_terminal) <= 0:
            raise BuildDeadlineExceeded(stage=stage, deadline_epoch_ms=self.deadline_epoch_ms)
