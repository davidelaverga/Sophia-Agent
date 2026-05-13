"""Tests for ``POST /internal/builder-dispatched`` (Stage 2B kick-off).

The endpoint spawns a ``consume_builder_stream`` task in join-existing mode
so registered chat-relay sinks (e.g. ``TelegramEIBotChatRelaySink``) can
render live progress in companion's chat. We assert the contract — wire
shape, flag gating, fire-and-forget task spawn — without exercising the
SDK transport.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.gateway.builder_events import reset_fanout_for_tests
from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import install_builder_events_worker


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    install_builder_events_worker(test_app, cache_ttl_seconds=60)
    test_app.include_router(routes.internal_router)
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
async def test_returns_202_and_spawns_consumer_when_flag_on(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Flag on + valid payload → 202 accepted, ``consume_builder_stream``
    invoked with the right args (we intercept via monkeypatch so the
    SDK transport is never actually exercised)."""
    monkeypatch.setattr(routes, "is_live_stream_enabled", lambda: True)

    captured: dict = {}

    async def _fake_consume(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(routes, "consume_builder_stream", _fake_consume)

    # Stub the langgraph client resolver so we don't actually init httpx.
    monkeypatch.setattr(routes, "_resolve_langgraph_client", lambda: object())

    async with client:
        response = await client.post(
            "/internal/builder-dispatched",
            json={
                "builder_thread_id": "builder-tid-1",
                "parent_thread_id": "parent-tid-1",
                "user_id": "u1",
                "run_id": "run-1",
                "trace_id": "abc12345",
            },
        )

    assert response.status_code == 202
    assert response.json() == {"accepted": True}

    # asyncio.create_task spawns it on the current loop; let it execute.
    import asyncio

    for _ in range(20):
        if captured:
            break
        await asyncio.sleep(0.01)

    assert captured["builder_thread_id"] == "builder-tid-1"
    assert captured["parent_thread_id"] == "parent-tid-1"
    assert captured["user_id"] == "u1"
    assert captured["run_id"] == "run-1"
    assert captured["trace_id"] == "abc12345"
    assert captured["assistant_id"] == "sophia_builder"


@pytest.mark.anyio
async def test_returns_202_no_consumer_when_flag_off(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Flag off → 202 with reason=live_stream_disabled and no consumer spawned.

    Required: ``start_builder_task`` fires this signal every dispatch
    unconditionally; the gateway must short-circuit when the rollout flag
    isn't set so dev / pilot environments aren't accidentally streaming.
    """
    monkeypatch.setattr(routes, "is_live_stream_enabled", lambda: False)

    invoked = {"count": 0}

    async def _fake_consume(**_kwargs):
        invoked["count"] += 1

    monkeypatch.setattr(routes, "consume_builder_stream", _fake_consume)
    monkeypatch.setattr(routes, "_resolve_langgraph_client", lambda: object())

    async with client:
        response = await client.post(
            "/internal/builder-dispatched",
            json={
                "builder_thread_id": "builder-tid-1",
                "parent_thread_id": "parent-tid-1",
                "user_id": "u1",
                "run_id": "run-1",
            },
        )

    assert response.status_code == 202
    assert response.json() == {"accepted": False, "reason": "live_stream_disabled"}

    import asyncio

    await asyncio.sleep(0.02)
    assert invoked["count"] == 0


@pytest.mark.anyio
async def test_rejects_missing_required_fields(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All four — builder_thread_id, parent_thread_id, user_id, run_id —
    are required. Pydantic rejects with 422 when any are missing."""
    monkeypatch.setattr(routes, "is_live_stream_enabled", lambda: True)

    async with client:
        response = await client.post(
            "/internal/builder-dispatched",
            json={"builder_thread_id": "builder-tid-1"},  # missing the others
        )

    assert response.status_code == 422


@pytest.mark.anyio
async def test_falls_back_trace_id_when_omitted(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace_id is optional; endpoint synthesises a short fallback from
    the builder_thread_id so trace_logger always has SOMETHING to key on."""
    monkeypatch.setattr(routes, "is_live_stream_enabled", lambda: True)

    captured: dict = {}

    async def _fake_consume(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(routes, "consume_builder_stream", _fake_consume)
    monkeypatch.setattr(routes, "_resolve_langgraph_client", lambda: object())

    async with client:
        response = await client.post(
            "/internal/builder-dispatched",
            json={
                "builder_thread_id": "builder-thread-xyz",
                "parent_thread_id": "parent-tid-1",
                "user_id": "u1",
                "run_id": "run-1",
            },
        )

    assert response.status_code == 202

    import asyncio

    for _ in range(20):
        if captured:
            break
        await asyncio.sleep(0.01)

    # Fallback trace_id is the first 8 chars of builder_thread_id.
    assert captured["trace_id"] == "builder-"
