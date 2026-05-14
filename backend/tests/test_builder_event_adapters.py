"""Unit tests for the BuilderEvent adapters."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from app.gateway.builder_events.adapters import adapt_terminal_webhook, adapt_v3_chunk
from app.gateway.builder_events.types import (
    CompletedEvent,
    CustomEvent,
    MessageDeltaEvent,
    ToolCallEvent,
)


class TestAdaptTerminalWebhook:
    def test_success_payload_maps_to_completed(self) -> None:
        payload = {
            "task_id": "t1",
            "thread_id": "th1",
            "status": "success",
            "user_id": "u",
            "summary": "Done.",
            "artifact_filename": "r.pdf",
            "artifact_type": "research",
            "artifact_url": "https://x/r.pdf",
        }
        evt = adapt_terminal_webhook(payload)
        assert isinstance(evt, CompletedEvent)
        assert evt.status == "completed"
        assert evt.companion_summary == "Done."
        assert evt.artifact_filename == "r.pdf"
        assert evt.sequence == sys.maxsize

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("error", "failed"),
            ("failed", "failed"),
            ("cancelled", "cancelled"),
            ("canceled", "cancelled"),
            ("timeout", "timed_out"),
            ("timed_out", "timed_out"),
            ("weird", "failed"),
        ],
    )
    def test_status_mapping(self, raw: str, expected: str) -> None:
        evt = adapt_terminal_webhook(
            {
                "task_id": "t",
                "thread_id": "th",
                "status": raw,
                "user_id": "u",
            }
        )
        assert evt is not None
        assert evt.status == expected

    def test_missing_thread_id_returns_none(self) -> None:
        evt = adapt_terminal_webhook({"task_id": "t", "status": "success"})
        assert evt is None

    def test_missing_task_id_returns_none(self) -> None:
        evt = adapt_terminal_webhook({"thread_id": "th", "status": "success"})
        assert evt is None

    def test_channel_origin_default_and_override(self) -> None:
        payload = {"task_id": "t", "thread_id": "th", "status": "success"}
        evt = adapt_terminal_webhook(payload)
        assert evt is not None and evt.channel_origin == "telegram"
        evt = adapt_terminal_webhook(payload, channel_origin="web")
        assert evt is not None and evt.channel_origin == "web"


class _AIMessageLike:
    def __init__(self, content: str, tool_calls: list[dict] | None = None) -> None:
        self.content = content
        self.tool_calls = tool_calls or []


class TestAdaptV3Chunk:
    _base = {
        "task_id": "t",
        "thread_id": "th",
        "user_id": "u",
        "channel_origin": "telegram",
    }

    def test_messages_tuple_text_delta(self) -> None:
        chunk = ("messages-tuple", (_AIMessageLike("hello"), {"role": "assistant"}))
        evt = adapt_v3_chunk(chunk, **self._base, sequence=1)
        assert isinstance(evt, MessageDeltaEvent)
        assert evt.delta == "hello"

    def test_messages_tuple_block_content(self) -> None:
        chunk = (
            "messages-tuple",
            (_AIMessageLike([{"type": "text", "text": "abc"}, {"type": "text", "text": "def"}]), {}),
        )
        evt = adapt_v3_chunk(chunk, **self._base, sequence=2)
        assert isinstance(evt, MessageDeltaEvent)
        assert evt.delta == "abcdef"

    def test_updates_with_tool_call(self) -> None:
        node_state = {
            "messages": [
                _AIMessageLike(
                    "",
                    tool_calls=[{"id": "call_1", "name": "builder_web_search", "args": {"query": "x"}}],
                )
            ]
        }
        chunk = ("updates", {"agent": node_state})
        evt = adapt_v3_chunk(chunk, **self._base, sequence=3)
        assert isinstance(evt, ToolCallEvent)
        assert evt.tool_name == "builder_web_search"
        assert evt.tool_call_id == "call_1"
        assert evt.status == "started"

    def test_custom_event(self) -> None:
        chunk = ("custom", {"name": "phase", "payload": {"phase": "drafting"}})
        evt = adapt_v3_chunk(chunk, **self._base, sequence=4)
        assert isinstance(evt, CustomEvent)
        assert evt.name == "phase"
        assert evt.payload == {"phase": "drafting"}

    def test_values_returns_none(self) -> None:
        chunk = ("values", {"messages": ["a", "b"]})
        evt = adapt_v3_chunk(chunk, **self._base, sequence=5)
        assert evt is None

    def test_unknown_mode_returns_none(self) -> None:
        evt = adapt_v3_chunk(("something_else", {}), **self._base, sequence=6)
        assert evt is None

    def test_dict_chunk_event_data_shape(self) -> None:
        chunk = {"event": "custom", "data": {"name": "phase", "payload": {"phase": "finalizing"}}}
        evt = adapt_v3_chunk(chunk, **self._base, sequence=7)
        assert isinstance(evt, CustomEvent)
        assert evt.payload["phase"] == "finalizing"

    def test_messages_tuple_with_dict_message(self) -> None:
        chunk = ("messages-tuple", ({"content": "from dict"}, {}))
        evt = adapt_v3_chunk(chunk, **self._base, sequence=8)
        assert isinstance(evt, MessageDeltaEvent)
        assert evt.delta == "from dict"

    def test_empty_messages_tuple_returns_none(self) -> None:
        chunk = ("messages-tuple", (SimpleNamespace(content=""), {}))
        evt = adapt_v3_chunk(chunk, **self._base, sequence=9)
        assert evt is None
