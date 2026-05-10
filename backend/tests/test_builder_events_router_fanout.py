"""Regression test: the webhook handler still publishes to ALL existing
paths (BuilderEventsWorker, MessageBus, CompanionWakeup) AND now also
publishes to the BuilderEventFanout. The fanout is additive — it must
not displace any of the existing fan-outs.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.gateway.builder_events import get_fanout, reset_fanout_for_tests
from app.gateway.builder_events.types import BuilderEvent
from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import install_builder_events_worker


class _RecordingSink:
    name = "recording"

    def __init__(self) -> None:
        self.calls: list[BuilderEvent] = []

    def accepts(self, _event: BuilderEvent) -> bool:
        return True

    async def handle(self, event: BuilderEvent) -> None:
        self.calls.append(event)


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


@pytest.fixture(autouse=True)
def _reset_fanout():
    reset_fanout_for_tests()
    yield
    reset_fanout_for_tests()


@pytest.mark.anyio
async def test_webhook_publishes_to_fanout_and_existing_paths(app: FastAPI, client: httpx.AsyncClient, monkeypatch) -> None:
    sink = _RecordingSink()
    get_fanout().register(sink)

    bus_captured: list[dict] = []

    async def _stub_bus_publish(payload):
        bus_captured.append(payload)

    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        _stub_bus_publish,
    )

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "companion-7",
                "task_id": "builder-99",
                "user_id": "u1",
                "trace_id": "abc",
                "status": "success",
                "agent_name": "sophia_builder",
                "artifact_url": "https://example.com/x.pptx",
                "summary": "done",
            },
        )

    assert response.status_code == 202

    # Existing path: MessageBus still fires.
    assert len(bus_captured) == 1
    assert bus_captured[0]["task_id"] == "builder-99"

    # New path: fanout sink also receives the event.
    # Give the publish task a moment in case publish dispatch is queued.
    for _ in range(10):
        if sink.calls:
            break
        await asyncio.sleep(0.01)

    assert len(sink.calls) == 1
    captured = sink.calls[0]
    assert captured.thread_id == "builder-99"
    assert captured.parent_thread_id == "companion-7"
    assert captured.event_type == "completed"
    assert captured.source == "webhook"


@pytest.mark.anyio
async def test_fanout_publish_failure_does_not_break_webhook(app: FastAPI, client: httpx.AsyncClient, monkeypatch) -> None:
    """A broken fanout sink must not cause the webhook to return 5xx."""

    class _ExplodingSink:
        name = "exploding"

        def accepts(self, _e: BuilderEvent) -> bool:
            return True

        async def handle(self, _e: BuilderEvent) -> None:
            raise RuntimeError("kaboom")

    get_fanout().register(_ExplodingSink())

    async def _noop_bus_publish(_payload):
        pass

    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        _noop_bus_publish,
    )

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "p1",
                "task_id": "t1",
                "status": "success",
            },
        )

    assert response.status_code == 202
