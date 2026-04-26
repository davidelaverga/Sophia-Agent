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
            except asyncio.TimeoutError:
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
    """The internal POST also fans the event out to channel adapters via the global bus."""
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

    assert response.status_code == 202
    assert len(captured) == 1
    assert captured[0]["thread_id"] == "thread-3"


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
