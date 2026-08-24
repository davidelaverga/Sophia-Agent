from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import (
    get_builder_events_worker,
    install_builder_events_worker,
)


def _app() -> FastAPI:
    app = FastAPI()
    install_builder_events_worker(app, cache_ttl_seconds=60)
    app.dependency_overrides[routes.require_builder_event_service_auth] = lambda: None
    app.include_router(routes.internal_router)
    return app


def _legacy_terminal_event() -> dict[str, object]:
    return {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "builder-run",
        "status": "success",
        "task_type": "presentation",
        "artifact_path": "mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_sha256": "f" * 64,
        "user_id": "canary-user",
        "deck_quality_publication_intent": {
            "private_marker": "must-never-reach-baseline-consumers",
        },
    }


@pytest.mark.anyio
async def test_legacy_quality_intent_is_stripped_from_every_baseline_fanout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _app()
    persisted: list[dict[str, object]] = []
    registry: list[dict[str, object]] = []
    channel: list[dict[str, object]] = []
    canvas: list[dict[str, object]] = []
    wakeup: list[dict[str, object]] = []

    async def persist(payload: dict[str, object]) -> None:
        persisted.append(payload)

    async def publish_channel(payload: dict[str, object]) -> None:
        channel.append(payload)

    class _Canvas:
        async def publish_completion(self, payload: dict[str, object]) -> None:
            canvas.append(payload)

    class _Wakeup:
        async def wake(self, payload: dict[str, object]) -> None:
            wakeup.append(payload)

    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persist)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", registry.append)
    monkeypatch.setattr(routes, "get_builder_canvas_worker", lambda _app: _Canvas())
    monkeypatch.setattr(routes, "get_companion_wakeup_or_none", lambda _app: _Wakeup())
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        publish_channel,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/builder-events",
            json=_legacy_terminal_event(),
        )
    await asyncio.sleep(0)

    assert response.status_code == 202
    assert response.json() == {"delivered_subscribers": 0}
    cached = await get_builder_events_worker(app).get_last("parent-thread")
    for delivered in (*persisted, *registry, *channel, *canvas, *wakeup, cached):
        assert delivered is not None
        assert "deck_quality_publication_intent" not in delivered
    assert len(persisted) == len(registry) == len(channel) == len(canvas) == 1
    assert len(wakeup) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "body",
    (
        b"",
        b"not-json",
        b'x' * (128 * 1024),
        b'{"deck_quality_publication_intent":{"private":"value"}}',
    ),
    ids=("empty", "malformed", "oversized", "legacy-shaped"),
)
async def test_retired_publication_endpoint_is_side_effect_free_tombstone(
    monkeypatch: pytest.MonkeyPatch,
    body: bytes,
) -> None:
    app = _app()
    persisted = AsyncMock()
    channel = AsyncMock()
    registry = AsyncMock()
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", registry)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            content=body,
        )

    assert response.status_code == 410
    assert response.content == b""
    persisted.assert_not_awaited()
    channel.assert_not_awaited()
    registry.assert_not_called()
