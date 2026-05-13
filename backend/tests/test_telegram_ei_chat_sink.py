"""Unit tests for ``TelegramEIBotChatRelaySink`` (Stage 2B)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.gateway.builder_events.sinks.telegram_ei import (
    TelegramEIBotChatRelaySink,
)
from app.gateway.builder_events.types import BuilderEvent


class _FakeChannel:
    def __init__(self, *, post_return: int | None = 4242) -> None:
        self.relay_builder_event_post = AsyncMock(return_value=post_return)
        self.relay_builder_event_edit = AsyncMock()


class _FakeService:
    def __init__(self, channel: _FakeChannel | None, store_origin: dict[str, Any] | None) -> None:
        self._channel = channel
        self._store_origin = store_origin
        self.store = self  # service-as-store shim

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
) -> tuple[TelegramEIBotChatRelaySink, _FakeService, _FakeChannel]:
    fake_channel = channel or _FakeChannel()
    service = _FakeService(fake_channel, origin)
    sink = TelegramEIBotChatRelaySink(
        get_channel_service=lambda: service,
        get_channel_store=lambda: service,
        flag_check=lambda: flag,
    )
    return sink, service, fake_channel


def _evt(
    *,
    event_type: str = "tool_started",
    thread_id: str = "builder-tid-1",
    parent_thread_id: str | None = "parent-tid-1",
    payload: dict[str, Any] | None = None,
    source: str = "stream",
) -> BuilderEvent:
    return BuilderEvent(
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id="u1",
        trace_id="trace-1",
        event_type=event_type,  # type: ignore[arg-type]
        payload=payload or {},
        source=source,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# accepts()
# ---------------------------------------------------------------------------


class TestAccepts:
    def test_accepts_false_when_flag_off(self) -> None:
        sink, _, _ = _make_sink(flag=False, origin={"thread_id": "parent-tid-1", "channel_name": "telegram"})
        assert sink.accepts(_evt()) is False

    def test_accepts_false_for_builder_as_main_mode(self) -> None:
        """parent_thread_id=None → Work bot path owns this, not EI."""
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "parent-tid-1", "channel_name": "telegram"})
        assert sink.accepts(_evt(parent_thread_id=None)) is False

    def test_accepts_false_when_parent_not_bound(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin=None)
        assert sink.accepts(_evt()) is False

    def test_accepts_false_for_wrong_channel(self) -> None:
        """Parent bound to a non-EI channel (e.g. telegram_work) → skip."""
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "parent-tid-1", "channel_name": "telegram_work"})
        assert sink.accepts(_evt()) is False

    def test_accepts_true_for_ei_bot_companion_dispatched(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "parent-tid-1", "channel_name": "telegram"})
        assert sink.accepts(_evt(event_type="phase")) is True


# ---------------------------------------------------------------------------
# handle() — placeholder lifecycle
# ---------------------------------------------------------------------------


class TestPlaceholderLifecycle:
    @pytest.mark.anyio
    async def test_first_event_posts_placeholder(self) -> None:
        """No placeholder yet → sink calls relay_builder_event_post."""
        sink, _, channel = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
        )
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        channel.relay_builder_event_post.assert_awaited_once()
        kwargs = channel.relay_builder_event_post.await_args.kwargs
        assert kwargs["chat_id"] == "11111"
        assert "running scripts" in kwargs["text"]
        channel.relay_builder_event_edit.assert_not_called()

    @pytest.mark.anyio
    async def test_subsequent_events_edit_placeholder(self) -> None:
        """Second event → editing same chat_id+message_id, not posting fresh."""
        sink, _, channel = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
        )
        # First event posts placeholder
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        # Second event edits it
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "builder_web_search"}))
        # post called exactly once, edit called once
        channel.relay_builder_event_post.assert_awaited_once()
        channel.relay_builder_event_edit.assert_awaited_once()
        edit_kwargs = channel.relay_builder_event_edit.await_args.kwargs
        assert edit_kwargs["chat_id"] == "11111"
        assert edit_kwargs["message_id"] == 4242  # _FakeChannel default
        assert "researching" in edit_kwargs["text"]

    @pytest.mark.anyio
    async def test_dedup_no_op_edits(self) -> None:
        """Identical consecutive text → second handle() short-circuits before any IO."""
        sink, _, channel = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
        )
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        channel.relay_builder_event_post.assert_awaited_once()
        channel.relay_builder_event_edit.assert_not_called()

    @pytest.mark.anyio
    async def test_post_failure_does_not_register_placeholder(self) -> None:
        """If post returns None, subsequent events must retry posting (not edit)."""
        channel = _FakeChannel(post_return=None)
        sink, _, _ = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
            channel=channel,
        )
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        # Send a DIFFERENT event so the dedup short-circuit doesn't fire.
        await sink.handle(_evt(event_type="phase", payload={"phase_name": "Drafting"}))
        # Both events retried post; never edit.
        assert channel.relay_builder_event_post.await_count == 2
        channel.relay_builder_event_edit.assert_not_called()

    @pytest.mark.anyio
    async def test_terminal_webhook_clears_placeholder(self) -> None:
        """Webhook-source terminal → placeholder dropped so a stale parent_thread_id is not edited on a future build."""
        sink, _, channel = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
        )
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        await sink.handle(
            _evt(
                event_type="completed",
                source="webhook",
                payload={"companion_summary": "Done!"},
            )
        )
        # Placeholder should be cleared — next event posts fresh, not edits.
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        assert channel.relay_builder_event_post.await_count == 2

    @pytest.mark.anyio
    async def test_terminal_stream_keeps_placeholder(self) -> None:
        """Stream-source terminal is provisional → keep placeholder alive for the webhook to override."""
        sink, _, channel = _make_sink(
            flag=True,
            origin={"thread_id": "parent-tid-1", "chat_id": "11111", "channel_name": "telegram"},
        )
        await sink.handle(_evt(event_type="tool_started", payload={"tool_name": "bash"}))
        await sink.handle(
            _evt(
                event_type="completed",
                source="stream",
                payload={"companion_summary": "Done!"},
            )
        )
        # Re-render same text → dedup, no third call.
        # But a DIFFERENT subsequent text → edit (placeholder preserved).
        await sink.handle(
            _evt(
                event_type="completed",
                source="webhook",
                payload={"companion_summary": "Final summary."},
            )
        )
        # post still exactly once; edit called for the two completed events with new text.
        assert channel.relay_builder_event_post.await_count == 1
        assert channel.relay_builder_event_edit.await_count >= 1


# ---------------------------------------------------------------------------
# Render coverage
# ---------------------------------------------------------------------------


class TestRendering:
    def test_render_started_shows_working_message(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(_evt(event_type="started"))
        assert "🔨" in text and "Working" in text

    def test_render_tool_phase_label(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(_evt(event_type="tool_started", payload={"tool_name": "builder_web_fetch"}))
        assert "fetching source" in text

    def test_render_tool_completed_emit_artifact(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(_evt(event_type="tool_completed", payload={"tool_name": "emit_builder_artifact"}))
        assert "Wrapping up" in text

    def test_render_tool_completed_other_returns_empty(self) -> None:
        """Don't churn the placeholder on every tool_completed — next tool_started overwrites."""
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(_evt(event_type="tool_completed", payload={"tool_name": "bash"}))
        assert text == ""

    def test_render_completed_uses_companion_summary(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(
            _evt(event_type="completed", payload={"companion_summary": "I drafted the report."})
        )
        assert text == "I drafted the report."

    def test_render_failed_includes_error(self) -> None:
        sink, _, _ = _make_sink(flag=True, origin={"thread_id": "p", "chat_id": "1", "channel_name": "telegram"})
        text = sink._render_text(_evt(event_type="failed", payload={"error_message": "Boom."}))
        assert "Boom." in text
