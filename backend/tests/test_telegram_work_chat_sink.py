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
    source: str = "stream",
    run_id: str | None = "run-1",
) -> BuilderEvent:
    return BuilderEvent(
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id="u1",
        trace_id="trace-1",
        event_type=event_type,  # type: ignore[arg-type]
        payload=payload or {},
        source=source,  # type: ignore[arg-type]
        run_id=run_id,
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
async def test_handle_started_does_not_edit_placeholder() -> None:
    """TelegramWorkChannel posts the placeholder ("🔨 Working on your
    request…") BEFORE spawning the consumer. The stream consumer's
    ``started`` event used to render the same text via the sink, which
    Telegram rejects with `400 Message is not modified`, and the
    `_safe_edit` fallback then posts a duplicate message. The fix:
    sink renders empty text for ``started`` so the edit is skipped.
    The fanout still receives the ``started`` event (it's what resets
    the per-thread terminal flag for reused thread_ids)."""
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    await sink.handle(_evt(event_type="started"))

    channel.relay_builder_event_edit.assert_not_called()
    # Placeholder mapping is untouched — subsequent phase/tool events
    # will still find it.
    assert sink.get_placeholder("tid-1") == ("12345", 99)


@pytest.mark.anyio
async def test_handle_renders_tool_started_phase_label() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

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
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

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
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    await sink.handle(
        _evt(
            event_type="completed",
            payload={"companion_summary": "Built the doc."},
            source="webhook",
        )
    )
    channel.relay_builder_event_edit.assert_awaited_once()
    assert channel.relay_builder_event_edit.await_args.kwargs["text"] == "Built the doc."

    # Webhook-source terminal clears the placeholder mapping.
    assert sink.get_placeholder("tid-1") is None


@pytest.mark.anyio
async def test_handle_renders_failed_with_error_message() -> None:
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

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
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Built the doc.",
                "artifact_filename": "report.pptx",
                "artifact_title": "Sophia Report",
            },
            source="webhook",
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
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    await sink.handle(_evt(event_type="failed", payload={"error_message": "boom"}))
    channel.relay_artifact_document.assert_not_called()

    sink.register_placeholder("tid-1", "run-1", "12345", 99)  # re-register after clear
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
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Built.",
                "artifact_filename": "x.pptx",
            },
            source="webhook",
        )
    )
    assert sink.get_placeholder("tid-1") is None


@pytest.mark.anyio
async def test_stream_terminal_keeps_placeholder_for_late_webhook() -> None:
    """A stream-source synthetic terminal is provisional. The sink
    must NOT clear the placeholder mapping so a later webhook (with
    artifact metadata) can re-render the same Telegram message and
    deliver the file. Without this, slow-webhook scenarios would
    leave the user with the synthetic fallback text and no artifact."""
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
        channel=channel,
    )
    sink.register_placeholder("tid-1", "run-1", "12345", 99)

    # Provisional synthetic from the stream consumer's grace fallback.
    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Build finished, but the result wasn't returned in time.",
                "webhook_grace_exhausted": True,
            },
            source="stream",
        )
    )
    # First edit fired but placeholder mapping survives.
    assert channel.relay_builder_event_edit.await_count == 1
    assert channel.relay_artifact_document.await_count == 0
    assert sink.get_placeholder("tid-1") == ("12345", 99)

    # Real webhook lands shortly after (fanout's source-aware dedup
    # lets it through). Sink re-renders with the rich summary and
    # delivers the artifact.
    await sink.handle(
        _evt(
            event_type="completed",
            payload={
                "companion_summary": "Built the report.",
                "artifact_filename": "report.pptx",
                "artifact_title": "Sophia Report",
            },
            source="webhook",
        )
    )
    assert channel.relay_builder_event_edit.await_count == 2
    assert channel.relay_artifact_document.await_count == 1
    artifact_kwargs = channel.relay_artifact_document.await_args.kwargs
    assert artifact_kwargs["filename"] == "report.pptx"
    # Webhook clears the placeholder.
    assert sink.get_placeholder("tid-1") is None


@pytest.mark.anyio
async def test_concurrent_runs_on_same_thread_do_not_clobber_placeholders() -> None:
    """Codex review 2026-05-13: with the previous ``register_placeholder(
    thread_id, chat_id, message_id)`` signature, a user firing a rapid
    second DM before the first build finished would overwrite the first
    build's placeholder mapping. Run A's in-flight events would then
    edit run B's message and vice versa.

    With (thread_id, run_id) keying, each run's events route to its own
    placeholder regardless of arrival order."""
    channel = _FakeChannel()
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-shared", "channel_name": "telegram_work"},
        channel=channel,
    )

    # User sends DM #1 → placeholder #1 posted, run-A registered.
    sink.register_placeholder("tid-shared", "run-A", "12345", 100)
    # User sends DM #2 before #1 finishes → placeholder #2 posted, run-B
    # registered. WITH the bug, this would overwrite run-A's mapping.
    sink.register_placeholder("tid-shared", "run-B", "12345", 200)

    # Run A's stream emits a tool_started event with run_id="run-A".
    await sink.handle(
        _evt(
            event_type="tool_started",
            thread_id="tid-shared",
            payload={"tool_name": "bash"},
            run_id="run-A",
        )
    )
    # Run B's stream emits its own tool_started with run_id="run-B".
    await sink.handle(
        _evt(
            event_type="tool_started",
            thread_id="tid-shared",
            payload={"tool_name": "builder_web_search"},
            run_id="run-B",
        )
    )

    # Each edit routed to the correct message_id — no cross-render.
    edit_calls = channel.relay_builder_event_edit.await_args_list
    assert len(edit_calls) == 2
    routed_msgs = {(c.kwargs["chat_id"], c.kwargs["message_id"]) for c in edit_calls}
    assert routed_msgs == {("12345", 100), ("12345", 200)}

    # A run's completion only clears ITS placeholder; the other survives.
    await sink.handle(
        _evt(
            event_type="completed",
            thread_id="tid-shared",
            payload={"companion_summary": "A done."},
            source="webhook",
            run_id="run-A",
        )
    )
    assert sink.get_placeholder("tid-shared", run_id="run-A") is None
    assert sink.get_placeholder("tid-shared", run_id="run-B") == ("12345", 200)


def test_webhook_without_run_id_falls_back_to_most_recent_placeholder() -> None:
    """The existing webhook wire shape doesn't carry run_id; the sink
    must fall back to the most-recent placeholder for the thread so
    terminal delivery still works in the single-run case (the only case
    this code path is exercised in production today)."""
    sink, _ = _make_sink(
        flag=True,
        origin={"thread_id": "tid-1", "channel_name": "telegram_work"},
    )
    sink.register_placeholder("tid-1", "run-X", "12345", 77)

    # Webhook lookup (run_id=None) → most-recent fallback.
    assert sink.get_placeholder("tid-1", run_id=None) == ("12345", 77)
    # Exact run_id match → hit.
    assert sink.get_placeholder("tid-1", run_id="run-X") == ("12345", 77)
    # Explicit miss → None. NO fallback when run_id is provided — that
    # protects new runs from inheriting a stale predecessor's bubble.
    assert sink.get_placeholder("tid-1", run_id="run-unknown") is None
    # Lookup on an unbound thread returns None.
    assert sink.get_placeholder("tid-other") is None
