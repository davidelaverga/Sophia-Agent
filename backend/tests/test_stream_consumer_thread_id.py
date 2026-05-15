"""Regression tests for parent-vs-subagent thread_id semantics in StreamConsumer.

Codex P1: streamed events were being stamped with the BUILDER's own
thread id, but the per-conversation sinks (notably
``CompanionContextStore.append_event``) key on the COMPANION thread.
Pre-fix: mid-flight awareness was written under the wrong key and
invisible to the companion's next turn until the terminal webhook
landed.

Post-fix: ``StreamConsumer`` accepts a ``parent_thread_id`` and
forwards it to ``adapt_v3_chunk`` as ``thread_id``. The builder's own
thread id rides along on ``subagent_thread_id`` for diagnostics. When
no parent is supplied (legacy callers), behaviour falls back to the
old "thread_id IS the builder thread" semantic so we don't regress
non-subagent flows.
"""

from __future__ import annotations

import pytest

from app.gateway.builder_events.adapters import adapt_v3_chunk
from app.gateway.builder_events.stream_consumer import StreamConsumer
from app.gateway.builder_events.types import (
    CustomEvent,
    MessageDeltaEvent,
    ToolCallEvent,
)


class _Aimsg:
    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []


class _StreamStub:
    """In-process replacement for ``client.runs.join_stream``."""

    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        async def _gen():
            for c in self._chunks:
                yield c

        return _gen()


class _ClientStub:
    def __init__(self, chunks):
        self.threads = object()

        class _Runs:
            def __init__(self, chunks):
                self._chunks = chunks
                self.join_stream_calls: list[dict] = []

            def join_stream(self, thread_id, run_id, *, stream_mode=None, **_kw):
                self.join_stream_calls.append(
                    {"thread_id": thread_id, "run_id": run_id, "stream_mode": stream_mode}
                )
                return _StreamStub(self._chunks)

        self.runs = _Runs(chunks)


class TestAdapterCarriesParentThread:
    """Direct adapter tests — proves the kwarg actually shapes the event."""

    _base = {
        "task_id": "task-1",
        "user_id": "u",
        "channel_origin": "telegram",
    }

    def test_messages_tuple_uses_parent_thread_id(self) -> None:
        chunk = ("messages-tuple", (_Aimsg("hello"), {}))
        evt = adapt_v3_chunk(
            chunk,
            **self._base,
            thread_id="companion-thread-abc",
            subagent_thread_id="builder-thread-xyz",
            sequence=1,
        )
        assert isinstance(evt, MessageDeltaEvent)
        # event.thread_id is the COMPANION thread — what awareness
        # sinks key on.
        assert evt.thread_id == "companion-thread-abc"
        # The builder thread id is preserved for diagnostics.
        assert evt.subagent_thread_id == "builder-thread-xyz"

    def test_updates_tool_call_uses_parent_thread_id(self) -> None:
        node_state = {
            "messages": [
                _Aimsg(
                    "",
                    tool_calls=[
                        {"id": "c1", "name": "builder_web_search", "args": {"query": "x"}}
                    ],
                )
            ]
        }
        chunk = ("updates", {"agent": node_state})
        evt = adapt_v3_chunk(
            chunk,
            **self._base,
            thread_id="companion-thread",
            subagent_thread_id="builder-thread",
            sequence=2,
        )
        assert isinstance(evt, ToolCallEvent)
        assert evt.thread_id == "companion-thread"
        assert evt.subagent_thread_id == "builder-thread"

    def test_custom_event_uses_parent_thread_id(self) -> None:
        chunk = ("custom", {"name": "phase", "payload": {"phase": "drafting"}})
        evt = adapt_v3_chunk(
            chunk,
            **self._base,
            thread_id="companion",
            subagent_thread_id="builder",
            sequence=3,
        )
        assert isinstance(evt, CustomEvent)
        assert evt.thread_id == "companion"
        assert evt.subagent_thread_id == "builder"


class TestStreamConsumerWiring:
    """End-to-end through StreamConsumer.run — proves the wiring is intact."""

    @pytest.mark.anyio
    async def test_published_events_carry_parent_thread_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        chunks = [
            ("messages-tuple", (_Aimsg("hi"), {})),
            ("custom", {"name": "phase", "payload": {"phase": "researching"}}),
        ]
        client = _ClientStub(chunks)

        async def _build_client_stub():
            return client

        published: list = []

        async def _publish(evt):
            published.append(evt)

        consumer = StreamConsumer(
            task_id="task-A",
            thread_id="builder-thread-A",  # builder's own thread → SDK subscribes here
            user_id="u",
            channel_origin="telegram",
            publish=_publish,
            run_id="run-A",
            parent_thread_id="companion-thread-Z",  # P1 fix: events carry THIS
        )
        # Bypass the real ``get_client``.
        monkeypatch.setattr(consumer, "_build_client", _build_client_stub)
        await consumer.run()

        # SDK was called against the BUILDER thread (transport concern).
        assert client.runs.join_stream_calls == [
            {
                "thread_id": "builder-thread-A",
                "run_id": "run-A",
                "stream_mode": ["messages-tuple", "updates", "custom"],
            }
        ]
        # But every published event carries the COMPANION thread.
        assert len(published) == 2
        for evt in published:
            assert evt.thread_id == "companion-thread-Z"
            assert evt.subagent_thread_id == "builder-thread-A"

    @pytest.mark.anyio
    async def test_omitted_parent_thread_id_falls_back_to_builder_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Backwards-compat: legacy callers that don't pass parent_thread_id
        still get the old "thread_id IS the builder thread" semantic.
        """
        chunks = [("messages-tuple", (_Aimsg("hello"), {}))]
        client = _ClientStub(chunks)

        async def _build_client_stub():
            return client

        published: list = []

        async def _publish(evt):
            published.append(evt)

        consumer = StreamConsumer(
            task_id="t",
            thread_id="builder-only",
            user_id="u",
            channel_origin="telegram",
            publish=_publish,
            run_id="r",
            # parent_thread_id intentionally omitted
        )
        monkeypatch.setattr(consumer, "_build_client", _build_client_stub)
        await consumer.run()

        assert len(published) == 1
        # Falls back: event.thread_id == builder thread.
        assert published[0].thread_id == "builder-only"
        assert published[0].subagent_thread_id == "builder-only"


@pytest.mark.anyio
async def test_companion_context_store_keys_on_parent_thread() -> None:
    """End-to-end binding: an event published via the new wiring lands
    in CompanionContextStore under the COMPANION thread key — which
    is what the companion's BuildAwarenessMiddleware reads back.
    """
    from app.gateway.builder_events.companion_context_store import CompanionContextStore

    store = CompanionContextStore()

    # Synthesise an event the way the post-fix StreamConsumer would.
    evt = adapt_v3_chunk(
        ("messages-tuple", (_Aimsg("progress!"), {})),
        task_id="task-companion-test",
        thread_id="companion-thread-K",
        subagent_thread_id="builder-thread-K",
        user_id="u",
        channel_origin="telegram",
        sequence=1,
    )
    assert evt is not None

    await store.append_event(evt)

    # Snapshot by COMPANION thread → finds the event.
    companion_view = await store.snapshot("companion-thread-K")
    assert len(companion_view) == 1

    # Snapshot by BUILDER thread → empty (pre-fix this is where the
    # event was wrongly stored).
    builder_view = await store.snapshot("builder-thread-K")
    assert builder_view == []
