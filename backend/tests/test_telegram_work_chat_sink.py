"""Unit tests for ``TelegramWorkBotChatRelaySink``."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.gateway.builder_events.sinks.telegram_work import (
    TelegramWorkBotChatRelaySink,
)
from app.gateway.builder_events.types import BuilderEvent


class _FakeChannel:
    def __init__(self) -> None:
        self.relay_builder_event_edit = AsyncMock()
        self.relay_artifact_document = AsyncMock()


class _FakeService:
    def __init__(self, channel: _FakeChannel | None, store_origin: dict[str, Any] | None) -> None:
        self._channel = channel
        self._store_origin = store_origin
        self.store = self  # service-as-store shim for the sink's resolver

    def get_channel(self, name: str) -> Any | None:  # noqa: ARG002
        return self._channel

    def find_by_thread_id(
        self,
        thread_id: str,
        *,
        channel_name: str | None = None,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        if self._store_origin and self._store_origin.get("thread_id") == thread_id:
            return self._store_origin
        return None


def _make_sink(
    *,
    flag: bool,
    origin: dict[str, Any] | None,
    channel: _FakeChannel | None = None,
) -> tuple[TelegramWorkBotChatRelaySink, _FakeService]:
    service = _FakeService(channel or _FakeChannel(), origin)
    sink = TelegramWorkBotChatRelaySink(
        get_channel_service=lambda: service,
        get_channel_store=lambda: service,
        flag_check=lambda: flag,
    )
    return sink, service


def _evt(
    *,
    event_type: str = "tool_started",
    thread_id: str = "tid-1",
    parent_thread_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> BuilderEvent:
    return BuilderEvent(
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id="u1",
        trace_id="trace-1",
        event_type=event_type,  # type: ignore[arg-type]
        payload=payload or {},
    )


def test_accepts_false_when_flag_off() -> None:
    sink, _ = _make_sink(flag=False, origin={"thread_id": "tid-1", "channel_name": "telegram_work"})
    assert sink.accepts(_evt()) is False


def test_accepts_false_for_subagent_mode() -> None:
    sink, _ = _make_sink(flag=True, origin={"thread_id": "tid-1", "channel_name": "telegram_work"})
    assert sink.accepts(_evt(parent_thread_id="parent-1")) is False


def test_accepts_false_when_thread_not_bound() -> None:
    sink, _ = _make_sink(flag=True, origin=None)
    assert sink.accepts(_evt()) is False


def test_accepts_false_for_wrong_channel() -> None:
    sink, _ = _make_sink(flag=True, origin={"thread_id": "tid-1", "channel_name": "telegram"})
    assert sink.accepts(_evt()) is False


def test_accepts_true_for_telegram_work_main_mode() -> None:
    sink, _ = _make_sink(flag=True, origin={"thread_id": "tid-1", "channel_name": "telegram_work"})
    assert sink.accepts(_evt(event_type="phase")) is True


@pytest.mark.anyio
async def test_handle_skips_when_no_placeholder() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
    channel.relay_builder_event_edit.assert_not_called()


@pytest.mark.anyio
async def test_handle_renders_tool_started_phase_label() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "builder_web_search"}))
    channel.relay_builder_event_edit.assert_awaited_once()
    kwargs = channel.relay_builder_event_edit.await_args.kwargs
    assert kwargs["chat_id"] == "12345"
    assert kwargs["message_id"] == 99
    assert "🔎" in kwargs["text"] or "researching" in kwargs["text"]


@pytest.mark.anyio
async def test_handle_dedups_repeated_text() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    payload = {"tool_name": "bash"}
    await sink.handle(_evt(event_type="tool_started", payload=payload))
    await sink.handle(_evt(event_type="tool_started", payload=payload))
    assert channel.relay_builder_event_edit.await_count == 1


@pytest.mark.anyio
async def test_handle_renders_completed_summary_and_clears_placeholder() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(_evt(event_type="completed", payload={"companion_summary": "Built the doc."}))
    channel.relay_builder_event_edit.assert_awaited_once()
    assert channel.relay_builder_event_edit.await_args.kwargs["text"] == "Built the doc."

    # After terminal the placeholder mapping is cleared.
    assert sink.get_placeholder("tid-1") is None


@pytest.mark.anyio
async def test_handle_renders_failed_with_error_message() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(_evt(event_type="failed", payload={"error_message": "boom"}))
    channel.relay_builder_event_edit.assert_awaited_once()
    text = channel.relay_builder_event_edit.await_args.kwargs["text"]
    assert "boom" in text


@pytest.mark.anyio
async def test_handle_delivers_artifact_on_completed_with_filename() -> None:
    """Stage 2A streaming path must deliver the artifact file too —
    Stage 1's _render_builder_result is skipped in streaming mode."""
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Built the doc.",
                "artifact_filename": "report.pptx",
                "artifact_title": "Sophia Report",
            },
        )
    )
    channel.relay_builder_event_edit.assert_awaited_once()
    channel.relay_artifact_document.assert_awaited_once()
    kwargs = channel.relay_artifact_document.await_args.kwargs
    assert kwargs["chat_id"] == "12345"
    assert kwargs["thread_id"] == "tid-1"
    assert kwargs["filename"] == "report.pptx"
    assert kwargs["caption"] == "Sophia Report"


@pytest.mark.anyio
async def test_handle_skips_artifact_when_no_filename() -> None:
    """Failures and artifact-less completions: no relay_artifact_document call."""
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(_evt(event_type="failed", payload={"error_message": "boom"}))
    channel.relay_artifact_document.assert_not_called()

    sink.register_placeholder("tid-1", "12345", 99)  # re-register after clear
    await sink.handle(_evt(event_type="completed", payload={"companion_summary": "Done."}))
    channel.relay_artifact_document.assert_not_called()


@pytest.mark.anyio
async def test_handle_artifact_failure_does_not_block_placeholder_cleanup() -> None:
    """If artifact delivery raises, the placeholder mapping still
    clears so the next run on the same thread isn't stuck."""
    channel = _FakeChannel()
    channel.relay_artifact_document.side_effect = RuntimeError("supabase down")
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "12345", 99)

    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Built.",
                "artifact_filename": "x.pptx",
            },
        )
    )
    assert sink.get_placeholder("tid-1") is None
