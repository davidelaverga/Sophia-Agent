"""Regression tests for StreamConsumer SDK wiring (PR #125 prod fix)."""

from __future__ import annotations

import pytest

from app.gateway.builder_events.stream_consumer import StreamConsumer


class _StubThreadsClient:
    """Sentinel: tests assert we never reach for ``threads.stream``."""

    def __init__(self) -> None:
        self.stream_calls = 0

    def stream(self, *_args, **_kwargs):
        self.stream_calls += 1
        raise AssertionError(
            "StreamConsumer must NOT call client.threads.stream — it doesn't "
            "exist on the SDK. Use client.runs.join_stream(thread_id, run_id, …)."
        )


class _StubRunsClient:
    def __init__(self) -> None:
        self.join_stream_calls: list[dict] = []
        self.stream_calls = 0

    def join_stream(self, thread_id, run_id, *, stream_mode=None, **_kwargs):
        self.join_stream_calls.append(
            {"thread_id": thread_id, "run_id": run_id, "stream_mode": stream_mode}
        )

        async def _iter():
            if False:  # pragma: no cover — generator
                yield None

        return _iter()

    def stream(self, *_args, **_kwargs):
        self.stream_calls += 1
        raise AssertionError(
            "StreamConsumer must NOT call client.runs.stream — that starts a NEW run. "
            "Use client.runs.join_stream(thread_id, run_id, …) to tail an existing one."
        )


class _StubClient:
    def __init__(self) -> None:
        self.threads = _StubThreadsClient()
        self.runs = _StubRunsClient()


async def _noop_publish(_evt) -> None:
    return None


@pytest.mark.anyio
async def test_open_stream_uses_runs_join_stream() -> None:
    consumer = StreamConsumer(
        task_id="task-1",
        thread_id="th-1",
        user_id="u",
        channel_origin="telegram",
        publish=_noop_publish,
        run_id="run-abc",
    )
    client = _StubClient()
    iterator = await consumer._open_stream(client)
    assert iterator is not None
    assert client.runs.join_stream_calls == [
        {
            "thread_id": "th-1",
            "run_id": "run-abc",
            "stream_mode": ["messages-tuple", "updates", "custom"],
        }
    ]
    # Regression sentinels: must NOT touch the wrong endpoints.
    assert client.threads.stream_calls == 0
    assert client.runs.stream_calls == 0


@pytest.mark.anyio
async def test_open_stream_without_run_id_logs_and_bails() -> None:
    """No run_id → don't try to subscribe (terminal webhook covers the run)."""
    consumer = StreamConsumer(
        task_id="task-1",
        thread_id="th-1",
        user_id="u",
        channel_origin="telegram",
        publish=_noop_publish,
        run_id=None,
    )
    client = _StubClient()
    iterator = await consumer._open_stream(client)
    assert iterator is None
    assert client.runs.join_stream_calls == []


class _RunsWithoutJoinStream:
    """An SDK runs-namespace stand-in that lacks ``join_stream``."""

    def __getattr__(self, name: str):
        if name == "join_stream":
            raise AttributeError("'RunsClient' object has no attribute 'join_stream'")
        raise AttributeError(name)


class _ClientMissingJoinStream:
    def __init__(self) -> None:
        self.runs = _RunsWithoutJoinStream()
        self.threads = object()


@pytest.mark.anyio
async def test_open_stream_falls_back_cleanly_on_missing_method() -> None:
    """If the installed SDK lacks runs.join_stream the consumer logs and exits."""
    consumer = StreamConsumer(
        task_id="task-1",
        thread_id="th-1",
        user_id="u",
        channel_origin="telegram",
        publish=_noop_publish,
        run_id="run-x",
    )
    iterator = await consumer._open_stream(_ClientMissingJoinStream())
    assert iterator is None
