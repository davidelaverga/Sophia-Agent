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

    # Phase 4G: ``messages-tuple`` (PR #120's working mode) replaces
    # ``messages``. See _open_stream docstring for the regression
    # history. The ``updates`` mode is the actual signal source for
    # tool-call activity lines; ``custom`` is for builder-side phase
    # events emitted via ``get_stream_writer`` (Phase 4G Stage 2).
    assert client.runs.join_stream_calls == [
        {
            "thread_id": "th-1",
            "run_id": "run-1",
            "stream_mode": ["messages-tuple", "updates", "custom"],
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
    """A stalled stream (no events arriving) ends cleanly at the per-event timeout.

    Phase 4F: the placeholder must NOT show ``[ Done ]`` on per-event
    timeout — that misleads the user when the builder is still running.
    It shows ``[ Still working ]`` (with reason) instead.
    """

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
    # Final edit MUST be "[ Still working ]" — NOT "[ Done ]".
    assert bot.edits, "subscriber must push at least one final edit"
    final = bot.edits[-1]["text"]
    assert "[ Still working ]" in final, (
        f"per-event timeout must NOT show '[ Done ]' (build may still be live); "
        f"got: {final!r}"
    )
    assert "[ Done ]" not in final, "stall outcome must never finalize as Done"


@pytest.mark.anyio
async def test_subscriber_natural_completion_marks_done(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase 4F: when the stream iterator exhausts naturally (StopAsyncIteration),
    the subscriber finalizes as ``[ Done ]`` — that's the only outcome that
    should claim completion.
    """
    bot = _FakeBot()
    chunks = [
        _FakeStreamPart("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "x"}}
            ])]}
        }),
    ]
    subscriber = _build_subscriber(bot, monkeypatch, chunks=chunks)
    await subscriber.run()
    assert bot.edits
    final = bot.edits[-1]["text"]
    assert "[ Done ]" in final
    assert "[ Still working ]" not in final
    assert "[ Stopped ]" not in final


@pytest.mark.anyio
async def test_subscriber_cancelled_marks_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase 4F: explicit ``asyncio.CancelledError`` produces ``[ Stopped ]``.

    The subscriber's task may be cancelled (channel shutdown, supervisor
    teardown). The placeholder should reflect that, not falsely claim Done.
    """

    class _SlowStream:
        def __aiter__(self):
            async def _gen():
                # Long enough to outlast our cancel
                await asyncio.sleep(60)
                yield None  # pragma: no cover

            return _gen()

    class _SlowClient:
        class _Runs:
            def join_stream(self, *_a, **_k):
                return _SlowStream()

        def __init__(self) -> None:
            self.runs = _SlowClient._Runs()

    bot = _FakeBot()
    subscriber = BuilderProgressSubscriber(
        bot=bot,
        chat_id=1,
        message_id=2,
        thread_id="th",
        run_id="run",
        task_id="task",
    )
    subscriber._per_event_timeout_s = 30  # long enough that cancel hits first
    subscriber._total_timeout_s = 30

    async def _stub_build_client():
        return _SlowClient()

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client)

    task = asyncio.create_task(subscriber.run())
    # Let the subscriber enter its inner loop.
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert bot.edits, "subscriber must push a final edit even on cancel"
    final = bot.edits[-1]["text"]
    assert "[ Stopped ]" in final
    assert "[ Done ]" not in final


@pytest.mark.anyio
async def test_subscriber_no_sdk_marks_stalled_not_done(monkeypatch: pytest.MonkeyPatch) -> None:
    """Codex P1 (post-Phase-4F): if ``_build_client`` returns None
    (SDK unavailable / client construction failed) the subscriber MUST
    finalize as ``[ Still working ]``, NOT ``[ Done ]``. We never joined
    the stream — the run is presumed alive on the langgraph service.
    Pretending it's Done is a misleading user-visible state regression.

    The placeholder doesn't sit forever on "Working on it…" — it gets
    a final ``[ Still working — couldn't connect to progress stream ]``
    edit that accurately reflects "we lost the live signal" without
    claiming completion.
    """
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
    # Final-state edit is attempted as a safety net — but MUST NOT say Done.
    assert bot.edits, "subscriber must push a final edit even on setup failure"
    final = bot.edits[-1]["text"]
    assert "[ Still working ]" in final
    assert "couldn't connect to progress stream" in final
    assert "[ Done ]" not in final


@pytest.mark.anyio
async def test_subscriber_open_stream_failure_marks_stalled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex P1 (post-Phase-4F): if ``runs.join_stream`` raises (transient
    network error, langgraph 502, etc.) the subscriber returns from
    ``_open_stream`` with ``None``. Same defect class as the no-SDK path:
    must finalize as ``[ Still working ]``, not ``[ Done ]`` — the build
    is alive, we just couldn't open the stream.
    """

    class _BrokenRunsClient:
        def join_stream(self, *_args, **_kwargs):
            raise RuntimeError("simulated transient network error")

    class _BrokenClient:
        def __init__(self) -> None:
            self.runs = _BrokenRunsClient()

    bot = _FakeBot()
    subscriber = BuilderProgressSubscriber(
        bot=bot,
        chat_id=1,
        message_id=2,
        thread_id="th",
        run_id="run",
        task_id="task",
    )

    async def _stub_build_client():
        return _BrokenClient()

    monkeypatch.setattr(subscriber, "_build_client", _stub_build_client)
    # Must not raise — _open_stream catches and returns None.
    await subscriber.run()
    assert bot.edits
    final = bot.edits[-1]["text"]
    assert "[ Still working ]" in final
    assert "couldn't open progress stream" in final
    assert "[ Done ]" not in final
