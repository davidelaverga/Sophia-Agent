"""Unit tests for BuilderProgressSubscriber wiring (Phase 4D v3 streaming)."""

from __future__ import annotations

import asyncio

import pytest

from app.channels.telegram_progress_subscriber import BuilderProgressSubscriber


class _Aimsg:
    def __init__(self, tool_calls=None) -> None:
        self.tool_calls = tool_calls or []


class _FakeStreamPart:
    """Matches ``langgraph_sdk.schema.StreamPart`` shape (event, data, id)."""

    def __init__(self, event: str, data, id_: str | None = None) -> None:
        self.event = event
        self.data = data
        self.id = id_


class _FakeStream:
    def __init__(self, chunks: list) -> None:
        self._chunks = chunks

    def __aiter__(self):
        async def _gen():
            for c in self._chunks:
                yield c

        return _gen()


class _FakeBot:
    def __init__(self) -> None:
        self.edits: list[dict] = []
        self.fail_edit = False

    async def edit_message_text(self, **kwargs):  # type: ignore[no-untyped-def]
        if self.fail_edit:
            raise RuntimeError("boom")
        self.edits.append(kwargs)


class _FakeRunsClient:
    def __init__(self, chunks: list) -> None:
        self._chunks = chunks
        self.join_stream_calls: list[dict] = []

    def join_stream(self, thread_id, run_id, *, stream_mode=None, **_kw):
        self.join_stream_calls.append(
            {"thread_id": thread_id, "run_id": run_id, "stream_mode": stream_mode}
        )
        return _FakeStream(self._chunks)


class _FakeClient:
    def __init__(self, chunks: list) -> None:
        self.runs = _FakeRunsClient(chunks)


def _build_subscriber(bot, monkeypatch, *, chunks: list, edit_interval_ms: int = 0):
    """Wire a subscriber with the FakeClient instead of the real SDK."""
    subscriber = BuilderProgressSubscriber(
        bot=bot,
        chat_id=42,
        message_id=100,
        thread_id="th-1",
        run_id="run-1",
        task_id="task-1",
    )
    subscriber._edit_interval_ms = edit_interval_ms

    async def _stub_build_client():
        return _FakeClient(chunks)

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client)
    return subscriber


@pytest.mark.anyio
async def test_subscriber_uses_runs_join_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    """Codex learning #1: SDK streaming is on ``runs.join_stream``."""
    bot = _FakeBot()
    chunks = [_FakeStreamPart("messages", {"any": "data"})]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks)
    client = _FakeClient(chunks)

    async def _stub_build_client():
        return client

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client)
    await subscriber.run()

    assert client.runs.join_stream_calls == [
        {
            "thread_id": "th-1",
            "run_id": "run-1",
            "stream_mode": ["messages", "updates", "custom"],
        }
    ]


@pytest.mark.anyio
async def test_subscriber_pushes_edits_for_state_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot()
    chunks = [
        _FakeStreamPart("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "best EVs"}}
            ])]}
        }),
        _FakeStreamPart("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_fetch", "args": {"url": "https://ev-database.org/"}}
            ])]}
        }),
    ]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks)
    await subscriber.run()

    # At least 2 mid-flight edits + 1 final (mark_done).
    assert len(bot.edits) >= 2
    final_text = bot.edits[-1]["text"]
    assert "[ Done ]" in final_text
    # Plain text only — no parse_mode.
    for edit in bot.edits:
        assert "parse_mode" not in edit


@pytest.mark.anyio
async def test_subscriber_pushes_final_edit_on_normal_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot()
    chunks = [_FakeStreamPart("updates", {
        "agent": {"messages": [_Aimsg([
            {"name": "builder_web_search", "args": {"query": "x"}}
        ])]}
    })]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks)
    await subscriber.run()

    final = bot.edits[-1]["text"]
    assert "[ Done ]" in final


@pytest.mark.anyio
async def test_subscriber_disabled_by_env_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUILDER_PROGRESS_ENABLED", "false")
    bot = _FakeBot()
    subscriber = _build_subscriber(bot, monkeypatch, chunks=[])
    await subscriber.run()
    # No edits attempted at all.
    assert bot.edits == []


@pytest.mark.anyio
async def test_subscriber_handles_edit_failure_gracefully(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot()
    bot.fail_edit = True
    chunks = [_FakeStreamPart("updates", {
        "agent": {"messages": [_Aimsg([
            {"name": "builder_web_search", "args": {"query": "x"}}
        ])]}
    })]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks)
    # Must not raise.
    await subscriber.run()
    # Edits attempted but failed.
    assert bot.edits == []  # FakeBot doesn't append on failure


@pytest.mark.anyio
async def test_subscriber_rate_limits_consecutive_edits(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot()
    # 5 rapid-fire chunks; with interval=10s only 1 mid-flight edit lands.
    chunks = [
        _FakeStreamPart("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": f"q{i}"}}
            ])]}
        })
        for i in range(5)
    ]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks, edit_interval_ms=10_000)
    await subscriber.run()
    # Only the first mid-flight edit (rate-limited away the rest)
    # plus the final-state edit on completion.
    mid_flight = [e for e in bot.edits if "[ Done ]" not in e["text"]]
    final = [e for e in bot.edits if "[ Done ]" in e["text"]]
    assert len(mid_flight) <= 1
    assert len(final) == 1


@pytest.mark.anyio
async def test_subscriber_per_event_timeout_closes_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stalled stream (no events arriving) ends cleanly at the per-event timeout."""

    class _StallStream:
        def __aiter__(self):
            async def _gen():
                # Wait forever
                await asyncio.sleep(10)
                yield None  # pragma: no cover

            return _gen()

    class _StallClient:
        class _Runs:
            def join_stream(self, *_a, **_k):
                return _StallStream()

        def __init__(self) -> None:
            self.runs = _StallClient._Runs()

    bot = _FakeBot()
    subscriber = BuilderProgressSubscriber(
        bot=bot,
        chat_id=1,
        message_id=2,
        thread_id="th",
        run_id="run",
        task_id="task",
    )
    # Tight timeouts so the test runs fast.
    subscriber._per_event_timeout_s = 0
    subscriber._total_timeout_s = 1

    async def _stub_build_client():
        return _StallClient()

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client)
    await subscriber.run()
    # Final "Done" edit still posted even on stall.
    assert any("[ Done ]" in e["text"] for e in bot.edits)


@pytest.mark.anyio
async def test_subscriber_no_sdk_returns_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    """If langgraph_sdk is unavailable the subscriber bails without crashing."""
    bot = _FakeBot()
    subscriber = BuilderProgressSubscriber(
        bot=bot,
        chat_id=1,
        message_id=2,
        thread_id="th",
        run_id="run",
        task_id="task",
    )

    async def _stub_build_client_returns_none():
        return None

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client_returns_none)
    # Must not raise.
    await subscriber.run()
    # Final-state edit is still attempted as a safety net.
    assert any("[ Done ]" in e["text"] for e in bot.edits)
