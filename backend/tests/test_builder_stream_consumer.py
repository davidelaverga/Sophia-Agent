"""Unit tests for ``consume_builder_stream``."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.gateway.builder_events.fanout import BuilderEventFanout
from app.gateway.builder_events.stream_consumer import consume_builder_stream
from app.gateway.builder_events.types import BuilderEvent


class _RecordingSink:
    name = "rec"

    def __init__(self) -> None:
        self.calls: list[BuilderEvent] = []

    def accepts(self, _e: BuilderEvent) -> bool:
        return True

    async def handle(self, event: BuilderEvent) -> None:
        self.calls.append(event)


class _StubStream:
    """Async iterable mimicking ``lg_client.runs.stream(...)``."""

    def __init__(self, parts: list[Any]) -> None:
        self._parts = parts

    def __call__(self, *_args, **_kwargs) -> AsyncIterator[Any]:
        async def gen():
            for part in self._parts:
                yield part

        return gen()


class _StubLgClient:
    def __init__(self, parts: list[Any]) -> None:
        self.runs = type("R", (), {"stream": _StubStream(parts)})()


@pytest.mark.anyio
async def test_publishes_started_then_per_part_events() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    parts = [
        ("metadata", {"run_id": "r1"}),
        (
            "values",
            {
                "messages": [
                    {"type": "ai", "tool_calls": [{"id": "c1", "name": "bash", "args": {}}]},
                ]
            },
        ),
        ("end", None),
    ]
    client = _StubLgClient(parts)

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-1",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "do it"}]},
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )

    types = [e.event_type for e in sink.calls]
    # started fires first, then tool_started, then either a webhook-loser
    # synthetic completed (when the grace expires).
    assert types[0] == "started"
    assert "tool_started" in types
    assert types[-1] == "completed"


@pytest.mark.anyio
async def test_synthetic_terminal_when_webhook_never_arrives() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    parts = [("values", {"messages": []}), ("end", None)]
    client = _StubLgClient(parts)

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-2",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )
    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].event_type == "completed"
    assert terminal[0].payload.get("webhook_grace_exhausted") is True


@pytest.mark.anyio
async def test_webhook_winning_drops_synthetic_terminal() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    parts = [("values", {"messages": []}), ("end", None)]
    client = _StubLgClient(parts)

    async def fire_webhook_after(delay):
        await asyncio.sleep(delay)
        await fanout.publish(
            BuilderEvent(
                thread_id="tid-3",
                parent_thread_id=None,
                user_id="u1",
                trace_id="trace-1",
                event_type="completed",
                payload={"companion_summary": "rich result"},
                source="webhook",
            )
        )

    webhook_task = asyncio.create_task(fire_webhook_after(0.02))

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-3",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        fanout=fanout,
        webhook_grace_seconds=0.5,
        consumer_timeout_seconds=5,
    )
    await webhook_task

    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].source == "webhook"
    assert terminal[0].payload["companion_summary"] == "rich result"


@pytest.mark.anyio
async def test_timeout_publishes_timed_out() -> None:
    """If the stream itself stalls past the consumer timeout."""

    class _StallingStream:
        def __call__(self, *_a, **_k):
            async def gen():
                await asyncio.sleep(10)
                yield ("end", None)

            return gen()

    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    client = type("C", (), {"runs": type("R", (), {"stream": _StallingStream()})()})()

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-4",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=0.05,
    )
    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].event_type == "timed_out"


@pytest.mark.anyio
async def test_stream_exception_publishes_synthetic_failed() -> None:
    """If runs.stream raises before the webhook fires, the consumer
    must publish a synthetic ``failed`` so the placeholder isn't stuck."""

    class _ErrorStream:
        def __call__(self, *_a, **_k):
            async def gen():
                raise RuntimeError("network blip")
                yield  # unreachable; makes this an async generator

            return gen()

    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    client = type("C", (), {"runs": type("R", (), {"stream": _ErrorStream()})()})()

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-err",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )
    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].event_type == "failed"
    assert terminal[0].payload.get("stream_exception") is True
    assert "RuntimeError" in (terminal[0].payload.get("error_message") or "")


@pytest.mark.anyio
async def test_started_published_before_stream_attempt_resets_stale_terminal() -> None:
    """Reused thread_id (Work bot one-per-chat) + second runs.stream
    errors immediately. The started event must publish BEFORE the
    stream attempt so the prior run's terminal flag is cleared and
    the synthetic 'failed' (or a webhook terminal) can fire.

    Simulates the Stage 1A webhook-only flow for build 1 (no started
    event ever published) followed by a Stage 2A streaming attempt for
    build 2 that errors immediately."""

    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    # Build 1: Stage 1A webhook-only — only a terminal lands. No
    # started was ever fired. Terminal flag is set on chat-A.
    await fanout.publish(
        BuilderEvent(
            thread_id="chat-A",
            parent_thread_id=None,
            user_id="u1",
            trace_id="trace-1",
            event_type="completed",
            payload={},
            source="webhook",
        )
    )
    assert sum(1 for e in sink.calls if e.event_type == "completed") == 1

    # Build 2 on the same thread. runs.stream raises before yielding a
    # single chunk. Without the started-before-stream fix the terminal
    # flag from build 1 would still be set and the synthetic 'failed'
    # below would be dropped.
    class _ErrorStream:
        def __call__(self, *_a, **_k):
            async def gen():
                raise RuntimeError("immediate API rejection")
                yield  # unreachable

            return gen()

    client = type("C", (), {"runs": type("R", (), {"stream": _ErrorStream()})()})()

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="chat-A",  # SAME thread as build 1
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-2",
        run_input={"messages": [{"role": "user", "content": "build 2"}]},
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )

    types = [e.event_type for e in sink.calls]
    # Build 2's started cleared the stale terminal flag and a synthetic
    # failed fired (stream raised, no webhook arrived).
    assert types == ["completed", "started", "failed"]
    # Sequence resets on build 2's started.
    started_evt = next(e for e in sink.calls if e.event_type == "started")
    failed_evt = next(e for e in sink.calls if e.event_type == "failed")
    assert started_evt.sequence == 1
    assert failed_evt.sequence == 2


@pytest.mark.anyio
async def test_stream_exception_yields_to_webhook_if_it_arrives() -> None:
    """If the webhook lands during the grace after a stream error, the
    rich webhook event wins and the synthetic ``failed`` is dropped."""

    class _ErrorStream:
        def __call__(self, *_a, **_k):
            async def gen():
                raise RuntimeError("blip")
                yield

            return gen()

    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    client = type("C", (), {"runs": type("R", (), {"stream": _ErrorStream()})()})()

    async def fire_webhook_after(delay):
        await asyncio.sleep(delay)
        await fanout.publish(
            BuilderEvent(
                thread_id="tid-err2",
                parent_thread_id=None,
                user_id="u1",
                trace_id="trace-1",
                event_type="completed",
                payload={"companion_summary": "saved by webhook"},
                source="webhook",
            )
        )

    webhook_task = asyncio.create_task(fire_webhook_after(0.02))

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-err2",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        fanout=fanout,
        webhook_grace_seconds=0.5,
        consumer_timeout_seconds=5,
    )
    await webhook_task

    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].source == "webhook"
    assert terminal[0].payload["companion_summary"] == "saved by webhook"


# ---- run_input vs run_id mode selection -----------------------------------


class _StubJoinStream:
    """Mimic ``lg_client.runs.join_stream(thread_id, run_id, stream_mode=...)``."""

    def __init__(self, parts: list[Any]) -> None:
        self._parts = parts
        self.calls: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs) -> AsyncIterator[Any]:
        self.calls.append((args, kwargs))

        async def gen():
            for part in self._parts:
                yield part

        return gen()


@pytest.mark.anyio
async def test_join_stream_branch_when_run_input_is_none() -> None:
    """Stage 2B contract: when ``run_id`` is provided (and ``run_input``
    is None), attach to an existing run via ``runs.join_stream`` rather
    than starting a new one via ``runs.stream(input=...)``."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    join = _StubJoinStream(
        [
            (
                "values",
                {
                    "messages": [
                        {
                            "type": "ai",
                            "tool_calls": [{"id": "c1", "name": "bash", "args": {}}],
                        }
                    ]
                },
            ),
            ("end", None),
        ]
    )
    create = _StubStream([])  # must NOT be called

    client = type(
        "C",
        (),
        {
            "runs": type("R", (), {"stream": create, "join_stream": join})(),
        },
    )()

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-join",
        parent_thread_id="parent-1",
        user_id="u1",
        trace_id="trace-1",
        run_input=None,
        run_id="run-xyz",
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )

    # join_stream was called with the right args/kwargs.
    assert len(join.calls) == 1
    args, kwargs = join.calls[0]
    assert args == ("tid-join", "run-xyz")
    assert kwargs["stream_mode"] == ["values", "messages", "custom"]

    # The stream's events flowed through fanout.
    types = [e.event_type for e in sink.calls]
    assert types[0] == "started"
    assert "tool_started" in types


@pytest.mark.anyio
async def test_misconfiguration_both_run_input_and_run_id_publishes_failed() -> None:
    """Caller bug: both set OR both None. Publish synthetic failed so
    chat surfaces don't dangle, then bail."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    join = _StubJoinStream([("end", None)])
    create = _StubStream([("end", None)])
    client = type("C", (), {"runs": type("R", (), {"stream": create, "join_stream": join})()})()

    # Both set.
    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-bad",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input={"messages": [{"role": "user", "content": "x"}]},
        run_id="run-xyz",
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )

    assert len(join.calls) == 0  # neither path invoked
    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].event_type == "failed"
    assert terminal[0].payload["error_type"] == "ConfigurationError"


@pytest.mark.anyio
async def test_misconfiguration_neither_run_input_nor_run_id_publishes_failed() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    client = type(
        "C",
        (),
        {
            "runs": type(
                "R",
                (),
                {"stream": _StubStream([]), "join_stream": _StubJoinStream([])},
            )(),
        },
    )()

    await consume_builder_stream(
        lg_client=client,
        builder_thread_id="tid-bad",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        run_input=None,
        run_id=None,
        fanout=fanout,
        webhook_grace_seconds=0.05,
        consumer_timeout_seconds=5,
    )

    terminal = [e for e in sink.calls if e.is_terminal]
    assert len(terminal) == 1
    assert terminal[0].event_type == "failed"
