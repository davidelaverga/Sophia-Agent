"""Unit tests for the BuilderEvent pydantic types (spec §10.1)."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from app.gateway.builder_events.types import (
    TERMINAL_STATUSES,
    BuilderEvent,
    CompletedEvent,
    CustomEvent,
    MessageDeltaEvent,
    SubagentEvent,
    ToolCallEvent,
    is_terminal_event,
)

_ADAPTER: TypeAdapter[BuilderEvent] = TypeAdapter(BuilderEvent)


class TestMessageDeltaEvent:
    def test_minimal_fields_round_trip(self) -> None:
        event = MessageDeltaEvent(
            task_id="t1",
            thread_id="th1",
            user_id="u1",
            channel_origin="telegram",
            timestamp_ms=123,
            sequence=1,
            delta="hello",
        )
        assert event.type == "message_delta"
        assert event.role == "assistant"
        assert event.subagent_id is None

    def test_discriminator_routes_to_correct_subclass(self) -> None:
        parsed = _ADAPTER.validate_python(
            {
                "type": "message_delta",
                "task_id": "t1",
                "thread_id": "th1",
                "user_id": "u1",
                "channel_origin": "telegram",
                "timestamp_ms": 123,
                "sequence": 1,
                "delta": "hi",
            }
        )
        assert isinstance(parsed, MessageDeltaEvent)
        assert parsed.delta == "hi"


class TestToolCallEvent:
    def test_required_fields(self) -> None:
        evt = ToolCallEvent(
            task_id="t",
            thread_id="th",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=1,
            sequence=2,
            tool_call_id="call_1",
            tool_name="builder_web_search",
            args={"query": "best EVs"},
            status="started",
        )
        assert evt.type == "tool_call"
        assert evt.args == {"query": "best EVs"}

    def test_invalid_status_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ToolCallEvent(
                task_id="t",
                thread_id="th",
                user_id="u",
                channel_origin="telegram",
                timestamp_ms=1,
                sequence=2,
                tool_call_id="c",
                tool_name="x",
                args={},
                status="weird",  # type: ignore[arg-type]
            )


class TestCompletedEvent:
    @pytest.mark.parametrize("status", sorted(TERMINAL_STATUSES))
    def test_terminal_statuses_accepted(self, status: str) -> None:
        evt = CompletedEvent(
            task_id="t",
            thread_id="th",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=1,
            sequence=999,
            status=status,  # type: ignore[arg-type]
        )
        assert is_terminal_event(evt) is True
        assert evt.status == status

    def test_non_terminal_status_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CompletedEvent(
                task_id="t",
                thread_id="th",
                user_id="u",
                channel_origin="telegram",
                timestamp_ms=1,
                sequence=999,
                status="weird",  # type: ignore[arg-type]
            )


class TestChannelOrigin:
    def test_unknown_origin_rejected(self) -> None:
        with pytest.raises(ValidationError):
            MessageDeltaEvent(
                task_id="t",
                thread_id="th",
                user_id="u",
                channel_origin="discord",  # type: ignore[arg-type]
                timestamp_ms=1,
                sequence=1,
                delta="x",
            )


class TestEventImmutability:
    def test_frozen_blocks_attribute_assignment(self) -> None:
        evt = CustomEvent(
            task_id="t",
            thread_id="th",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=1,
            sequence=1,
            name="phase",
            payload={"phase": "drafting"},
        )
        with pytest.raises(ValidationError):
            evt.name = "different"  # type: ignore[misc]


class TestSubagentEvent:
    def test_status_values(self) -> None:
        evt = SubagentEvent(
            task_id="t",
            thread_id="th",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=1,
            sequence=1,
            subagent_id="sa1",
            subagent_type="research",
            status="spawned",
        )
        assert evt.status == "spawned"
