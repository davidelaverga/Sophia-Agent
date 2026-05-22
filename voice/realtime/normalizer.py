from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import replace
from typing import Any
from uuid import uuid4

from voice.realtime.events import ProviderEvent, ProviderEventType, SophiaEvent


ArtifactValidator = Callable[[dict[str, Any]], dict[str, Any]]


class SophiaEventNormalizer:
    """Convert normalized provider events into the public sophia.* contract.

    Provider adapters should stop at ProviderEvent. This class is the Sophia
    boundary that owns public event names, transcript accumulation, cancellation
    shape, artifact routing hooks, and diagnostic envelopes.
    """

    def __init__(
        self,
        *,
        artifact_validator: ArtifactValidator | None = None,
    ) -> None:
        self._artifact_validator = artifact_validator
        self._assistant_text_by_response: dict[str, str] = {}
        self._active_assistant_text_key_by_response: dict[str, str] = {}
        self._highest_transcript_source_sequence_by_key: dict[str, int] = {}
        self._closed_response_source_sequence_by_response: dict[str, int] = {}
        self._active_response_id: str | None = None
        self._agent_started_response_ids: set[str] = set()
        self._agent_ended_response_ids: set[str] = set()

    def normalize_events(self, events: Iterable[ProviderEvent]) -> list[SophiaEvent]:
        normalized: list[SophiaEvent] = []
        for event in events:
            normalized.extend(self.normalize_event(event))
        return normalized

    def normalize_event(self, event: ProviderEvent) -> list[SophiaEvent]:
        event_type = event.type

        if event_type == ProviderEventType.USER_TRANSCRIPT_PARTIAL:
            return []

        if event_type == ProviderEventType.USER_TRANSCRIPT_FINAL:
            text = _string_value(event.data.get("text"))
            if not text:
                return []

            utterance_id = _string_value(event.data.get("utterance_id")) or str(uuid4())
            return [
                SophiaEvent(
                    "sophia.user_transcript",
                    self._user_transcript_payload(text, utterance_id=utterance_id, event=event),
                ),
                SophiaEvent("sophia.turn", {"phase": "user_ended"}),
            ]

        if event_type in {
            ProviderEventType.RESPONSE_STARTED,
            ProviderEventType.ASSISTANT_AUDIO_STARTED,
        }:
            return self._agent_started(event)

        if event_type == ProviderEventType.ASSISTANT_TEXT_DELTA:
            response_id = self._response_id(event)
            transcript_key = self._assistant_text_key(event, response_id=response_id)
            text = _string_value(event.data.get("text"))
            if not text:
                return []

            stale_reason = self._stale_transcript_reason(event, response_id=response_id, transcript_key=transcript_key)
            if stale_reason is not None:
                return [
                    self._diagnostic_event(
                        event,
                        status="completed",
                        reason=stale_reason,
                        extra={
                            "provider_event_name": "transcript_sequence_stale_rejected",
                            "source_sequence": _int_value(event.data.get("source_sequence")),
                            "transcript_key": transcript_key,
                        },
                    )
                ]

            assembly_mode = _string_value(event.data.get("transcript_assembly"))
            is_delta = event.data.get("is_delta") is not False
            previous = self._assistant_text_by_response.get(transcript_key, "")
            if assembly_mode == "auto":
                current = _merge_unknown_transcript_chunk(previous, text)
            elif is_delta:
                current = previous + text
            else:
                current = text
            self._assistant_text_by_response[transcript_key] = current
            self._record_transcript_source_sequence(event, transcript_key=transcript_key)
            return [
                SophiaEvent(
                    "sophia.transcript",
                    self._assistant_transcript_payload(current, is_final=False, event=event),
                )
            ]

        if event_type == ProviderEventType.ASSISTANT_TEXT_FINAL:
            response_id = self._response_id(event)
            transcript_key = self._assistant_text_key(event, response_id=response_id)
            text = _string_value(event.data.get("text"))
            if text is None:
                text = self._assistant_text_by_response.get(transcript_key, "")
            if not text:
                return []

            stale_reason = self._stale_transcript_reason(event, response_id=response_id, transcript_key=transcript_key)
            if stale_reason is not None:
                return [
                    self._diagnostic_event(
                        event,
                        status="completed",
                        reason=stale_reason,
                        extra={
                            "provider_event_name": "transcript_sequence_stale_rejected",
                            "source_sequence": _int_value(event.data.get("source_sequence")),
                            "transcript_key": transcript_key,
                        },
                    )
                ]

            self._assistant_text_by_response[transcript_key] = text
            self._record_transcript_source_sequence(event, transcript_key=transcript_key)
            return [
                SophiaEvent(
                    "sophia.transcript",
                    self._assistant_transcript_payload(text, is_final=True, event=event),
                )
            ]

        if event_type == ProviderEventType.ARTIFACT_PAYLOAD:
            artifact = _record_value(event.data.get("artifact")) or _record_value(event.data)
            if artifact is None:
                return []
            if self._artifact_validator is not None:
                artifact = self._artifact_validator(artifact)
            return [SophiaEvent("sophia.artifact", artifact)]

        if event_type == ProviderEventType.BUILDER_TASK_PAYLOAD:
            builder_task = _record_value(event.data.get("builder_task")) or _record_value(event.data)
            if builder_task is None:
                return []
            return [SophiaEvent("sophia.builder_task", builder_task)]

        if event_type in {
            ProviderEventType.RESPONSE_ENDED,
            ProviderEventType.ASSISTANT_AUDIO_ENDED,
        }:
            return self._agent_ended(event)

        if event_type in {
            ProviderEventType.RESPONSE_CANCELLED,
            ProviderEventType.RESPONSE_INTERRUPTED,
        }:
            reason = "interrupted" if event_type == ProviderEventType.RESPONSE_INTERRUPTED else "cancelled"
            self._record_response_boundary_source_sequence(event)
            self._clear_assistant_text_for_response(self._response_id(event))
            return [
                *self._agent_ended(event, reason=reason),
                self._diagnostic_event(
                    event,
                    status="failed",
                    reason=reason,
                    extra={"interrupted": reason == "interrupted"},
                ),
            ]

        if event_type == ProviderEventType.PROVIDER_ERROR:
            if (
                event.response_id is None
                and event.turn_id is None
                and self._active_response_id is not None
            ):
                event = replace(
                    event,
                    response_id=self._active_response_id,
                    turn_id=self._active_response_id,
                )
            events = []
            if self._active_response_id is not None:
                events.extend(self._agent_ended(event, reason="provider_error"))
            events.append(
                self._diagnostic_event(
                    event,
                    status="failed",
                    reason="provider_error",
                    extra={
                        "stage": _string_value(event.data.get("stage")) or "provider",
                        "message": _string_value(event.data.get("message")) or "Provider error.",
                        "recoverable": event.data.get("recoverable") is not False,
                    },
                )
            )
            return events

        if event_type == ProviderEventType.PROVIDER_METRIC:
            return [
                self._diagnostic_event(
                    event,
                    status="completed",
                    reason="provider_metric",
                    extra=dict(event.data),
                )
            ]

        # Tool calls/results and candidate payloads are internal-only in this
        # phase. Future Sophia runtime code can route them to validators,
        # builder bridges, and provider tool-result handlers without changing
        # the public frontend contract.
        return []

    def _assistant_text_key(self, event: ProviderEvent, *, response_id: str) -> str:
        segment_id = _string_value(event.data.get("segment_id"))
        if not segment_id:
            return self._active_assistant_text_key_by_response.get(response_id, response_id)

        key = f"{response_id}:{segment_id}"
        self._active_assistant_text_key_by_response[response_id] = key
        return key

    def _assistant_transcript_payload(
        self,
        text: str,
        *,
        is_final: bool,
        event: ProviderEvent,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"text": text, "is_final": is_final}
        source_sequence = _int_value(event.data.get("source_sequence"))
        response_id = event.response_id
        segment_id = _string_value(event.data.get("segment_id"))
        if source_sequence is not None and response_id:
            payload["response_id"] = response_id
        if source_sequence is not None and segment_id:
            payload["segment_id"] = segment_id
        if source_sequence is not None:
            payload["source_sequence"] = source_sequence
        provider_received_at = _string_value(event.data.get("provider_received_at"))
        relay_correlation_id = _string_value(event.data.get("relay_correlation_id"))
        if provider_received_at:
            payload["provider_received_at"] = provider_received_at
        if relay_correlation_id:
            payload["relay_correlation_id"] = relay_correlation_id
        return payload

    def _user_transcript_payload(
        self,
        text: str,
        *,
        utterance_id: str,
        event: ProviderEvent,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"text": text, "utterance_id": utterance_id}
        source_sequence = _int_value(event.data.get("source_sequence"))
        provider_relay_sequence = _int_value(event.data.get("provider_relay_sequence"))
        provider_received_at = _string_value(event.data.get("provider_received_at"))
        relay_correlation_id = _string_value(event.data.get("relay_correlation_id"))
        if source_sequence is not None:
            payload["source_sequence"] = source_sequence
        if provider_relay_sequence is not None:
            payload["provider_relay_sequence"] = provider_relay_sequence
        if provider_received_at:
            payload["provider_received_at"] = provider_received_at
        if relay_correlation_id:
            payload["relay_correlation_id"] = relay_correlation_id
        return payload

    def _stale_transcript_reason(
        self,
        event: ProviderEvent,
        *,
        response_id: str,
        transcript_key: str,
    ) -> str | None:
        source_sequence = _int_value(event.data.get("source_sequence"))
        if source_sequence is None:
            return None
        highest = self._highest_transcript_source_sequence_by_key.get(transcript_key)
        if highest is not None and source_sequence <= highest:
            return "transcript_sequence_stale_rejected"
        boundary_sequence = self._closed_response_source_sequence_by_response.get(response_id)
        if boundary_sequence is not None and source_sequence <= boundary_sequence:
            return "transcript_boundary_stale_rejected"
        return None

    def _record_transcript_source_sequence(self, event: ProviderEvent, *, transcript_key: str) -> None:
        source_sequence = _int_value(event.data.get("source_sequence"))
        if source_sequence is None:
            return
        self._highest_transcript_source_sequence_by_key[transcript_key] = max(
            source_sequence,
            self._highest_transcript_source_sequence_by_key.get(transcript_key, 0),
        )

    def _record_response_boundary_source_sequence(self, event: ProviderEvent) -> None:
        source_sequence = _int_value(event.data.get("source_sequence"))
        if source_sequence is None:
            return
        response_id = self._response_id(event)
        self._closed_response_source_sequence_by_response[response_id] = max(
            source_sequence,
            self._closed_response_source_sequence_by_response.get(response_id, 0),
        )

    def _clear_assistant_text_for_response(self, response_id: str) -> None:
        prefix = f"{response_id}:"
        stale_keys = [
            key
            for key in self._assistant_text_by_response
            if key == response_id or key.startswith(prefix)
        ]
        for key in stale_keys:
            self._assistant_text_by_response.pop(key, None)
        self._active_assistant_text_key_by_response.pop(response_id, None)

    def _agent_started(self, event: ProviderEvent) -> list[SophiaEvent]:
        response_id = self._response_id(event)
        self._active_response_id = response_id
        if response_id in self._agent_started_response_ids:
            return []

        self._agent_started_response_ids.add(response_id)
        return [SophiaEvent("sophia.turn", {"phase": "agent_started"})]

    def _agent_ended(
        self,
        event: ProviderEvent,
        *,
        reason: str | None = None,
    ) -> list[SophiaEvent]:
        response_id = self._response_id(event)
        if response_id in self._agent_ended_response_ids:
            return []

        self._agent_ended_response_ids.add(response_id)
        if self._active_response_id == response_id:
            self._active_response_id = None
        self._active_assistant_text_key_by_response.pop(response_id, None)
        self._record_response_boundary_source_sequence(event)

        data: dict[str, Any] = {"phase": "agent_ended"}
        if reason:
            data["reason"] = reason
        return [SophiaEvent("sophia.turn", data)]

    def _diagnostic_event(
        self,
        event: ProviderEvent,
        *,
        status: str,
        reason: str,
        extra: dict[str, Any] | None = None,
    ) -> SophiaEvent:
        data: dict[str, Any] = {
            "turn_id": event.turn_id or self._response_id(event),
            "status": status,
            "reason": reason,
            "provider": event.provider,
            "response_id": event.response_id,
        }
        if extra:
            data.update(extra)
        return SophiaEvent("sophia.turn_diagnostic", data)

    def _response_id(self, event: ProviderEvent) -> str:
        response_id = event.response_id or event.turn_id or "default"
        if event.response_id or event.turn_id:
            return response_id
        if self._active_response_id is not None:
            return self._active_response_id
        return response_id


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    return None


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _merge_unknown_transcript_chunk(previous: str, incoming: str) -> str:
    current = previous.strip()
    candidate = incoming.strip()
    if not candidate:
        return current
    if not current:
        return candidate
    if candidate == current:
        return current
    if candidate.startswith(current):
        return candidate
    if current.startswith(candidate):
        return current
    if candidate in current:
        return current
    if current in candidate:
        return candidate

    overlap = _suffix_prefix_overlap_length(current, candidate)
    if overlap > 0:
        return current + candidate[overlap:]

    if _looks_like_revised_snapshot(current, candidate):
        return candidate

    return _append_transcript_fragment(current, candidate)


def _suffix_prefix_overlap_length(current: str, candidate: str) -> int:
    max_overlap = min(len(current), len(candidate))
    for length in range(max_overlap, 2, -1):
        if current[-length:].lower() == candidate[:length].lower():
            return length
    return 0


def _looks_like_revised_snapshot(current: str, candidate: str) -> bool:
    current_words = _leading_words(current)
    candidate_words = _leading_words(candidate)
    if len(current_words) < 2 or len(candidate_words) < 2:
        return False

    current_length = max(len(current), 1)
    candidate_length = len(candidate)
    if candidate_length < int(current_length * 0.6):
        return False

    if current_words[:2] == candidate_words[:2]:
        return True

    return _longest_contiguous_word_overlap(current, candidate) >= 2


def _leading_words(text: str) -> list[str]:
    words = re.findall(r"[\w']+", text.lower())
    return words[:4]


def _longest_contiguous_word_overlap(current: str, candidate: str) -> int:
    current_words = re.findall(r"[\w']+", current.lower())
    candidate_words = re.findall(r"[\w']+", candidate.lower())
    longest = 0
    for current_index in range(len(current_words)):
        for candidate_index in range(len(candidate_words)):
            length = 0
            while (
                current_index + length < len(current_words)
                and candidate_index + length < len(candidate_words)
                and current_words[current_index + length]
                == candidate_words[candidate_index + length]
            ):
                length += 1
            longest = max(longest, length)
    return longest


def _append_transcript_fragment(current: str, candidate: str) -> str:
    if not current:
        return candidate
    if not candidate:
        return current
    if current[-1].isspace() or candidate[0].isspace():
        return current + candidate
    if current[-1] in "([{\"'" or candidate[0] in ")]},.!?;:%\"'":
        return current + candidate
    return f"{current} {candidate}"