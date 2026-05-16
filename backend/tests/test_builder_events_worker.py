"""Tests for the gateway-side BuilderEventsWorker and its FastAPI endpoints.

Locks:
- ``publish`` reaches every subscriber for the matching ``thread_id`` and
  records the event in the TTL cache.
- Subscriber cleanup runs on context exit (no leaked queues).
- ``get_last`` returns ``None`` after TTL expiry.
- ``POST /internal/builder-events`` validates the payload, calls the
  worker, and forwards to the channel ``MessageBus`` if installed.
- ``GET /api/threads/{thread_id}/builder-events/last`` returns 204 when
  no event is cached, 200 with JSON when one is.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import (
    BuilderEventsWorker,
    install_builder_events_worker,
)


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    install_builder_events_worker(test_app, cache_ttl_seconds=60)
    test_app.include_router(routes.internal_router)
    test_app.include_router(routes.public_router)
    return test_app


@pytest.fixture
def client(app: FastAPI) -> httpx.AsyncClient:
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


# ---- Worker unit tests -----------------------------------------------------


@pytest.mark.anyio
async def test_publish_fans_out_to_thread_subscribers():
    worker = BuilderEventsWorker()
    received: list[dict] = []

    async def consumer():
        async with worker.subscribe("thread-A") as queue:
            event = await asyncio.wait_for(queue.get(), timeout=1.0)
            received.append(event)

    consumer_task = asyncio.create_task(consumer())
    # Give the consumer a tick to register before publish runs.
    await asyncio.sleep(0)

    delivered = await worker.publish({"thread_id": "thread-A", "task_id": "task-1", "status": "success"})
    await consumer_task

    assert delivered == 1
    assert received == [{"thread_id": "thread-A", "task_id": "task-1", "status": "success"}]


@pytest.mark.anyio
async def test_publish_does_not_leak_to_other_threads():
    worker = BuilderEventsWorker()
    received_a: list[dict] = []
    received_b: list[dict] = []

    async def consumer(thread_id, sink):
        async with worker.subscribe(thread_id) as queue:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.2)
                sink.append(event)
            except TimeoutError:
                return

    task_a = asyncio.create_task(consumer("thread-A", received_a))
    task_b = asyncio.create_task(consumer("thread-B", received_b))
    await asyncio.sleep(0)

    await worker.publish({"thread_id": "thread-A", "task_id": "task-1", "status": "success"})
    await asyncio.gather(task_a, task_b)

    assert received_a == [{"thread_id": "thread-A", "task_id": "task-1", "status": "success"}]
    assert received_b == []


@pytest.mark.anyio
async def test_publish_drops_event_without_thread_id():
    worker = BuilderEventsWorker()
    delivered = await worker.publish({"task_id": "task-1"})
    assert delivered == 0


@pytest.mark.anyio
async def test_subscriber_cleanup_on_context_exit():
    worker = BuilderEventsWorker()
    async with worker.subscribe("thread-cleanup"):
        assert await worker.subscriber_count("thread-cleanup") == 1
    assert await worker.subscriber_count("thread-cleanup") == 0


@pytest.mark.anyio
async def test_get_last_returns_cached_event():
    worker = BuilderEventsWorker(cache_ttl_seconds=60)
    event = {"thread_id": "thread-cache", "task_id": "task-cache", "status": "success"}
    await worker.publish(event)

    last = await worker.get_last("thread-cache")
    assert last == event


@pytest.mark.anyio
async def test_get_last_returns_none_for_unknown_thread():
    worker = BuilderEventsWorker()
    assert await worker.get_last("thread-missing") is None


@pytest.mark.anyio
async def test_get_last_drops_stale_entries(monkeypatch):
    """After TTL elapses, the cached entry is invalidated lazily."""
    worker = BuilderEventsWorker(cache_ttl_seconds=0)
    await worker.publish({"thread_id": "thread-stale", "task_id": "task-stale"})

    # Force monotonic clock forward so the TTL check fires.
    import time as _time

    fake_now = _time.monotonic() + 1.0
    monkeypatch.setattr(_time, "monotonic", lambda: fake_now)

    assert await worker.get_last("thread-stale") is None


# ---- HTTP endpoint tests ---------------------------------------------------


@pytest.mark.anyio
async def test_internal_post_accepts_event_and_publishes(app: FastAPI, client: httpx.AsyncClient):
    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-1",
                "task_id": "task-1",
                "status": "success",
                "agent_name": "sophia_builder",
                "task_brief": "Write a one-pager.",
            },
        )
    assert response.status_code == 202
    body = response.json()
    assert body["delivered_subscribers"] == 0  # nothing subscribed yet


@pytest.mark.anyio
async def test_internal_post_rejects_missing_required_fields(app: FastAPI, client: httpx.AsyncClient):
    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={"task_id": "task-1"},  # no thread_id, no status
        )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_last_endpoint_204_when_empty(app: FastAPI, client: httpx.AsyncClient):
    async with client:
        response = await client.get("/api/threads/thread-empty/builder-events/last")
    assert response.status_code == 204


@pytest.mark.anyio
async def test_last_endpoint_returns_event_after_publish(app: FastAPI, client: httpx.AsyncClient):
    async with client:
        await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-2",
                "task_id": "task-2",
                "status": "success",
                "agent_name": "sophia_builder",
            },
        )
        response = await client.get("/api/threads/thread-2/builder-events/last")
    assert response.status_code == 200
    body = response.json()
    assert body["task_id"] == "task-2"
    assert body["status"] == "success"


@pytest.mark.anyio
async def test_internal_post_forwards_to_channel_bus(app: FastAPI, client: httpx.AsyncClient, monkeypatch):
    """The internal POST also fans the event out to channel adapters via the global bus.

    Production note: the channel fan-out runs as a background asyncio
    task so the webhook returns within milliseconds (the langgraph-side
    daemon-thread timeout is short). Tests must explicitly drain to
    observe the side effects.
    """
    captured: list[dict] = []

    async def _stub_publish(payload):
        captured.append(payload)

    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        _stub_publish,
    )

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-3",
                "task_id": "task-3",
                "status": "success",
                "agent_name": "sophia_builder",
            },
        )
        await routes.drain_background_tasks()

    assert response.status_code == 202
    assert len(captured) == 1
    assert captured[0]["thread_id"] == "thread-3"


@pytest.mark.anyio
async def test_internal_post_returns_fast_when_subscriber_is_slow(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch
):
    """Production regression: the webhook handler must NOT block on slow
    channel-bus subscribers (e.g. the EI bot's artifact upload, which
    takes 5-15s for a real document).

    Pre-fix behavior: the gateway awaited ``publish_builder_completion``
    synchronously, the langgraph-side daemon thread's 2-second timeout
    fired on every artifact-bearing run, and the connection close
    aborted artifact delivery on the gateway side too.

    Post-fix: heavy work runs as background tasks, the handler responds
    in milliseconds, and the daemon thread sees a clean 202.
    """
    import time

    async def _slow_publish(_payload):
        await asyncio.sleep(2.0)  # simulate artifact upload

    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        _slow_publish,
    )

    async with client:
        start = time.perf_counter()
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-slow",
                "task_id": "task-slow",
                "status": "success",
                "agent_name": "sophia_builder",
            },
        )
        elapsed = time.perf_counter() - start

        # Handler must return long before the 2-second sleep completes.
        # Using a generous 0.5s ceiling to avoid CI flakiness; real prod
        # latency should be <50ms.
        assert response.status_code == 202
        assert elapsed < 0.5, f"handler took {elapsed:.3f}s — must return fast even when subscribers are slow"

        # Drain so the test cleans up its background task.
        await routes.drain_background_tasks(timeout=5.0)


@pytest.mark.anyio
async def test_unknown_channel_origin_defaults_to_web_not_telegram(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch
):
    """Codex P2 regression: a webhook payload WITHOUT ``channel_origin``
    must route through the fanout as ``"web"``, not ``"telegram"``.

    Pre-fix: the router defaulted to ``"telegram"`` for missing origin,
    so legacy / non-Telegram terminal events ended up in the
    Telegram-only ``WorkshopTelegramSink`` and could churn its bounded
    (LRU=256) terminal-event cache, evicting real Telegram terminals
    before late receivers register.

    Post-fix: missing origin → ``"web"``. ``WorkshopTelegramSink.accepts``
    gates on ``channel_origin == "telegram"`` so a ``"web"`` event is
    rejected at the sink and never touches the terminal cache.
    """
    # Install a workshop sink + fanout the same way the gateway lifespan does.
    from app.gateway.builder_events import (
        BuilderEventFanout,
        WorkshopTelegramSink,
    )

    fanout = BuilderEventFanout()
    sink = WorkshopTelegramSink()
    fanout.register_sink(sink)
    app.state._builder_event_fanout = fanout

    try:
        async with client:
            response = await client.post(
                "/internal/builder-events",
                json={
                    "thread_id": "thread-no-origin",
                    "task_id": "task-no-origin",
                    "status": "success",
                    "agent_name": "sophia_builder",
                    # NOTE: channel_origin intentionally omitted
                },
            )
            assert response.status_code == 202
            await routes.drain_background_tasks(timeout=5.0)
    finally:
        delattr(app.state, "_builder_event_fanout")

    # The terminal event must NOT have landed in the Telegram sink's
    # cache — the default origin is "web", and the sink's accepts()
    # gates on origin == "telegram".
    assert "task-no-origin" not in sink._terminal_cache, (
        "non-Telegram terminal polluted the Telegram-only cache — "
        "channel_origin default is wrong"
    )


@pytest.mark.anyio
async def test_wakeup_task_held_in_background_tasks(app: FastAPI, client: httpx.AsyncClient, monkeypatch):
    """Codex P2 regression: the companion-wakeup task scheduled via
    ``asyncio.create_task(wakeup.wake(...))`` must hold a strong reference
    until completion. Without it, asyncio's weak internal reference lets
    the GC reclaim the task mid-run and Sophia's proactive completion
    follow-up silently disappears.

    The fix adds the wakeup task to ``_BACKGROUND_TASKS`` (the same set
    the channel-fanout + fanout-publish tasks use) with a done-callback
    to remove it on completion. This test asserts the task lands in the
    set and stays there while running.
    """
    started = asyncio.Event()
    finished = asyncio.Event()

    class _StubWakeup:
        async def wake(self, _payload):
            started.set()
            await finished.wait()

    # Install a fake wakeup worker via the app.state slot the router checks.
    # The attribute name must match _WAKEUP_ATTR in companion_wakeup.py.
    app.state._companion_wakeup = _StubWakeup()
    try:
        async with client:
            await client.post(
                "/internal/builder-events",
                json={
                    "thread_id": "thread-wake",
                    "task_id": "task-wake",
                    "status": "success",
                    "agent_name": "sophia_builder",
                },
            )

            # Wake should have started and not yet completed.
            await asyncio.wait_for(started.wait(), timeout=2.0)
            # The wakeup task is held in _BACKGROUND_TASKS while running.
            wakeup_tasks = [t for t in routes._BACKGROUND_TASKS if not t.done()]
            assert wakeup_tasks, "wakeup task must be tracked while running"

            # Release the stub so the task finishes, then confirm it gets cleared.
            finished.set()
            await routes.drain_background_tasks(timeout=5.0)
            assert not [t for t in routes._BACKGROUND_TASKS if not t.done()]
    finally:
        delattr(app.state, "_companion_wakeup")


@pytest.mark.anyio
async def test_sse_format_helper_emits_data_line():
    """Unit-level coverage for the SSE wire encoder.

    A full end-to-end SSE round-trip via httpx ASGITransport is flaky in CI
    (the stream context never terminates cleanly), so the encoder gets a
    direct unit test. The "subscribe replays from cache" semantics are
    covered by ``test_last_endpoint_returns_event_after_publish`` plus the
    worker-level ``test_publish_fans_out_to_thread_subscribers`` — together
    they prove that publish → cache and subscribe → queue work.
    """
    payload = {"thread_id": "thread-x", "task_id": "task-x", "status": "success"}
    encoded = routes._format_sse_event(payload)
    assert encoded.startswith(b"data: ")
    assert encoded.endswith(b"\n\n")
    body = encoded[len(b"data: "):].split(b"\n\n")[0]
    assert json.loads(body) == payload
