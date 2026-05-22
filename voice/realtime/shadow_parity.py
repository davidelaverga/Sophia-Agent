from __future__ import annotations

import logging
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from voice.realtime.events import ProviderEvent, SophiaEvent
from voice.realtime.legacy_cascade import LegacyCascadeCompatibilityBridge
from voice.realtime.normalizer import SophiaEventNormalizer


logger = logging.getLogger(__name__)


class ShadowParityResult(StrEnum):
    MATCH = "match"
    MISSING_EXPECTED_EVENT = "missing_expected_event"
    UNEXPECTED_ACTUAL_EVENT = "unexpected_actual_event"
    TYPE_MISMATCH = "type_mismatch"
    PAYLOAD_SHAPE_MISMATCH = "payload_shape_mismatch"
    SEQUENCING_MISMATCH = "sequencing_mismatch"


@dataclass(frozen=True)
class ShadowParityDiagnostic:
    result: ShadowParityResult
    expected_event_type: str | None = None
    actual_event_type: str | None = None
    reason: str | None = None
    session_id: str | None = None
    turn_id: str | None = None
    response_id: str | None = None
    sequence: int | None = None
    expected_subset: dict[str, Any] = field(default_factory=dict)
    actual_subset: dict[str, Any] = field(default_factory=dict)

    def as_payload(self) -> dict[str, Any]:
        return {
            "result": self.result.value,
            "expected_event_type": self.expected_event_type,
            "actual_event_type": self.actual_event_type,
            "reason": self.reason,
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "response_id": self.response_id,
            "sequence": self.sequence,
            "expected_subset": dict(self.expected_subset),
            "actual_subset": dict(self.actual_subset),
        }


@dataclass(frozen=True)
class _ExpectedEvent:
    event: SophiaEvent
    provider_event: ProviderEvent | None = None


class ShadowParityComparator:
    def __init__(self, *, session_id: str | None = None) -> None:
        self.session_id = session_id
        self._expected: deque[_ExpectedEvent] = deque()
        self._diagnostics: list[ShadowParityDiagnostic] = []
        self._sequence = 0

    @property
    def diagnostics(self) -> tuple[ShadowParityDiagnostic, ...]:
        return tuple(self._diagnostics)

    @property
    def pending_expected_count(self) -> int:
        return len(self._expected)

    def add_expected_events(
        self,
        events: Iterable[SophiaEvent],
        *,
        provider_event: ProviderEvent | None = None,
    ) -> None:
        for event in events:
            self._expected.append(
                _ExpectedEvent(event=event, provider_event=provider_event)
            )

    def observe_actual(self, payload: Mapping[str, Any]) -> ShadowParityDiagnostic:
        actual = _sophia_event_from_payload(payload)
        if actual is None:
            return self._record(
                ShadowParityResult.UNEXPECTED_ACTUAL_EVENT,
                actual_event_type=_string_value(payload.get("type")),
                reason="Actual payload is not a public Sophia event envelope.",
                actual_subset=_stable_subset(
                    _string_value(payload.get("type")) or "",
                    _record_value(payload.get("data")) or {},
                ),
            )

        if not self._expected:
            return self._record(
                ShadowParityResult.UNEXPECTED_ACTUAL_EVENT,
                actual_event_type=actual.type,
                reason="Actual public event had no pending shadow expectation.",
                actual_subset=_stable_subset(actual.type, actual.data),
            )

        expected = self._expected[0]
        if expected.event.type == actual.type:
            self._expected.popleft()
            return self._compare_payload(expected, actual)

        later_index = self._find_expected_type(actual.type)
        if later_index is not None:
            matched_expected = self._pop_expected_at(later_index)
            return self._record(
                ShadowParityResult.SEQUENCING_MISMATCH,
                expected=matched_expected,
                actual=actual,
                reason=(
                    f"Actual {actual.type!r} arrived before pending "
                    f"{expected.event.type!r}."
                ),
            )

        self._expected.popleft()
        return self._record(
            ShadowParityResult.TYPE_MISMATCH,
            expected=expected,
            actual=actual,
            reason=(
                f"Expected public event {expected.event.type!r} but observed "
                f"{actual.type!r}."
            ),
        )

    def flush_missing_expected(
        self,
        *,
        reason: str = "shadow parity flush",
    ) -> list[ShadowParityDiagnostic]:
        records: list[ShadowParityDiagnostic] = []
        while self._expected:
            expected = self._expected.popleft()
            records.append(
                self._record(
                    ShadowParityResult.MISSING_EXPECTED_EVENT,
                    expected=expected,
                    reason=reason,
                )
            )
        return records

    def _compare_payload(
        self,
        expected: _ExpectedEvent,
        actual: SophiaEvent,
    ) -> ShadowParityDiagnostic:
        expected_subset = _stable_subset(expected.event.type, expected.event.data)
        actual_subset = _stable_subset(actual.type, actual.data)
        if expected_subset == actual_subset:
            return self._record(
                ShadowParityResult.MATCH,
                expected=expected,
                actual=actual,
                expected_subset=expected_subset,
                actual_subset=actual_subset,
            )

        return self._record(
            ShadowParityResult.PAYLOAD_SHAPE_MISMATCH,
            expected=expected,
            actual=actual,
            reason="Stable public payload fields differ.",
            expected_subset=expected_subset,
            actual_subset=actual_subset,
        )

    def _find_expected_type(self, event_type: str) -> int | None:
        for index, expected in enumerate(self._expected):
            if expected.event.type == event_type:
                return index
        return None

    def _pop_expected_at(self, index: int) -> _ExpectedEvent:
        items = list(self._expected)
        expected = items.pop(index)
        self._expected = deque(items)
        return expected

    def _record(
        self,
        result: ShadowParityResult,
        *,
        expected: _ExpectedEvent | None = None,
        actual: SophiaEvent | None = None,
        expected_event_type: str | None = None,
        actual_event_type: str | None = None,
        reason: str | None = None,
        expected_subset: dict[str, Any] | None = None,
        actual_subset: dict[str, Any] | None = None,
    ) -> ShadowParityDiagnostic:
        self._sequence += 1
        provider_event = expected.provider_event if expected is not None else None
        record = ShadowParityDiagnostic(
            result=result,
            expected_event_type=(
                expected.event.type if expected is not None else expected_event_type
            ),
            actual_event_type=actual.type if actual is not None else actual_event_type,
            reason=reason,
            session_id=(
                self.session_id
                or (provider_event.session_id if provider_event is not None else None)
            ),
            turn_id=provider_event.turn_id if provider_event is not None else None,
            response_id=(
                provider_event.response_id if provider_event is not None else None
            ),
            sequence=self._sequence,
            expected_subset=(
                dict(expected_subset)
                if expected_subset is not None
                else _expected_subset(expected)
            ),
            actual_subset=(
                dict(actual_subset)
                if actual_subset is not None
                else _actual_subset(actual)
            ),
        )
        self._diagnostics.append(record)
        if result != ShadowParityResult.MATCH:
            logger.warning(
                "voice.shadow_parity result=%s expected=%s actual=%s reason=%s "
                "session_id=%s turn_id=%s response_id=%s",
                result.value,
                record.expected_event_type,
                record.actual_event_type,
                reason,
                record.session_id,
                record.turn_id,
                record.response_id,
            )
        return record


class LegacyCascadeShadowParity:
    def __init__(
        self,
        *,
        session_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self.bridge = LegacyCascadeCompatibilityBridge(
            session_id=session_id,
            user_id=user_id,
        )
        self.normalizer = SophiaEventNormalizer()
        self.comparator = ShadowParityComparator(session_id=session_id)

    @property
    def diagnostics(self) -> tuple[ShadowParityDiagnostic, ...]:
        return self.comparator.diagnostics

    @property
    def pending_expected_count(self) -> int:
        return self.comparator.pending_expected_count

    def bind_session(
        self,
        *,
        session_id: str | None,
        user_id: str | None = None,
    ) -> None:
        self.bridge.session_id = session_id
        self.comparator.session_id = session_id
        if user_id is not None:
            self.bridge.user_id = user_id

    def start_turn(
        self,
        *,
        turn_id: str | None = None,
        response_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self.flush_missing_expected(reason="new shadow turn started")
        self.bridge.reset_turn(turn_id=turn_id, response_id=response_id)
        if user_id is not None:
            self.bridge.user_id = user_id

    def expect_final_user_transcript(
        self,
        text: str,
        *,
        utterance_id: str | None = None,
    ) -> None:
        self._expect(
            self.bridge.final_user_transcript(text, utterance_id=utterance_id)
        )

    def expect_agent_response_started(self) -> None:
        self._expect(self.bridge.agent_response_started())

    def expect_assistant_transcript(self, text: str, *, is_final: bool) -> None:
        if is_final:
            self._expect(self.bridge.assistant_final_text(text))
            return

        self._expect(self.bridge.assistant_partial_text(text, is_delta=False))

    def expect_artifact(self, artifact: Mapping[str, Any]) -> None:
        self._expect(self.bridge.artifact_payload(artifact))

    def expect_builder_task(self, builder_task: Mapping[str, Any]) -> None:
        self._expect(self.bridge.builder_task_payload(builder_task))

    def expect_agent_response_ended(self) -> None:
        self._expect(self.bridge.agent_response_ended())

    def expect_turn_diagnostic(self, diagnostic: Mapping[str, Any] | Any) -> None:
        self._expect(self.bridge.turn_diagnostic(diagnostic))

    def observe_actual_public_event(
        self,
        payload: Mapping[str, Any],
    ) -> ShadowParityDiagnostic:
        return self.comparator.observe_actual(payload)

    def flush_missing_expected(
        self,
        *,
        reason: str = "shadow parity flush",
    ) -> list[ShadowParityDiagnostic]:
        return self.comparator.flush_missing_expected(reason=reason)

    def _expect(self, provider_event: ProviderEvent) -> None:
        public_events = self.normalizer.normalize_event(provider_event)
        self.comparator.add_expected_events(
            public_events,
            provider_event=provider_event,
        )


_STABLE_FIELDS_BY_TYPE: dict[str, tuple[str, ...]] = {
    "sophia.user_transcript": ("text", "utterance_id"),
    "sophia.turn": ("phase", "reason"),
    "sophia.transcript": ("text", "is_final"),
    "sophia.artifact": (
        "session_goal",
        "active_goal",
        "next_step",
        "takeaway",
        "reflection",
        "tone_estimate",
        "tone_target",
        "active_tone_band",
        "skill_loaded",
        "ritual_phase",
        "voice_emotion_primary",
        "voice_emotion_secondary",
        "voice_speed",
    ),
    "sophia.builder_task": (
        "type",
        "task_id",
        "status",
        "description",
        "detail",
        "error",
        "progress_percent",
    ),
    "sophia.turn_diagnostic": (
        "status",
        "reason",
        "raw_false_end_count",
        "duplicate_phase_counts",
    ),
}


def _sophia_event_from_payload(payload: Mapping[str, Any]) -> SophiaEvent | None:
    event_type = _string_value(payload.get("type"))
    data = _record_value(payload.get("data"))
    if event_type is None or data is None or not event_type.startswith("sophia."):
        return None
    return SophiaEvent(event_type, data)


def _stable_subset(event_type: str, data: Mapping[str, Any]) -> dict[str, Any]:
    fields = _STABLE_FIELDS_BY_TYPE.get(event_type)
    if fields is None:
        return {
            key: value
            for key, value in data.items()
            if not _is_dynamic_field(key)
        }

    return {key: data.get(key) for key in fields if key in data}


def _is_dynamic_field(key: str) -> bool:
    return (
        key == "timestamp"
        or key.endswith("_at")
        or key.endswith("_ms")
        or key in {"provider", "response_id", "turn_id", "session_id"}
    )


def _expected_subset(expected: _ExpectedEvent | None) -> dict[str, Any]:
    if expected is None:
        return {}
    return _stable_subset(expected.event.type, expected.event.data)


def _actual_subset(actual: SophiaEvent | None) -> dict[str, Any]:
    if actual is None:
        return {}
    return _stable_subset(actual.type, actual.data)


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    return None