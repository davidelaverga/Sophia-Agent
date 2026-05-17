"""Tests for the ``/internal/builder-progress`` webhook endpoint.

Phase 4H (webhook relay). The endpoint receives one POST per phase
transition (or per AI message with tool_calls) from the langgraph-
side ``BuilderProgressMiddleware`` and dispatches it through the
gateway-side ``BuilderProgressRegistry``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.builder_progress import get_progress_registry
from app.gateway.builder_progress.registry import reset_for_tests
from app.gateway.routers.builder_events import internal_router


@pytest.fixture
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(internal_router)
    return a


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_for_tests()


def test_endpoint_accepts_event_for_unknown_task(app: FastAPI) -> None:
    """An event for a task without a registered placeholder returns
    202 with applied=False (dropped silently). Common case: middleware
    fires ``starting`` before the channel registers the entry."""
    with TestClient(app) as client:
        response = client.post(
            "/internal/builder-progress",
            json={
                "task_id": "t-unknown",
                "run_id": "r-1",
                "event_name": "custom",
                "data": {"name": "phase", "phase": "starting"},
            },
        )
    assert response.status_code == 202
    assert response.json() == {"applied": False}


def test_endpoint_applies_phase_event_when_entry_registered(app: FastAPI) -> None:
    """Happy path: task is registered, callback is registered,
    endpoint applies the event and the callback receives the new
    placeholder body."""
    registry = get_progress_registry()

    captured: list[tuple[int, int, str]] = []

    async def cb(chat_id: int, message_id: int, body: str) -> None:
        captured.append((chat_id, message_id, body))

    registry.register_channel_callback("telegram", cb)
    registry.register_task(
        task_id="t-1",
        chat_id=42,
        message_id=99,
        channel_name="telegram",
    )

    with TestClient(app) as client:
        response = client.post(
            "/internal/builder-progress",
            json={
                "task_id": "t-1",
                "run_id": "r-1",
                "event_name": "custom",
                "data": {"name": "phase", "phase": "researching"},
            },
        )
    assert response.status_code == 202
    assert response.json() == {"applied": True}
    assert len(captured) == 1
    chat_id, message_id, body = captured[0]
    assert chat_id == 42
    assert message_id == 99
    assert "[ Researching ]" in body


def test_endpoint_handles_updates_event_with_tool_calls(app: FastAPI) -> None:
    """Endpoint accepts the renderer's ``updates`` envelope and the
    callback receives a body containing the activity line."""
    registry = get_progress_registry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    registry.register_channel_callback("telegram", cb)
    registry.register_task(
        task_id="t-1",
        chat_id=1,
        message_id=2,
        channel_name="telegram",
    )

    with TestClient(app) as client:
        response = client.post(
            "/internal/builder-progress",
            json={
                "task_id": "t-1",
                "run_id": "r-1",
                "event_name": "updates",
                "data": {"agent": {"messages": [{"tool_calls": [
                    {"name": "builder_web_search", "args": {"query": "FST"}}
                ]}]}},
            },
        )
    assert response.status_code == 202
    assert response.json() == {"applied": True}
    assert any("🔍 Searching: FST" in body for body in captured)


def test_endpoint_returns_202_when_callback_raises(app: FastAPI) -> None:
    """A failing edit callback is swallowed by the registry; the
    endpoint still returns 202 with applied=False (so the builder
    doesn't perceive the gateway as down)."""
    registry = get_progress_registry()

    async def bad_cb(*_: object) -> None:
        raise RuntimeError("simulated edit failure")

    registry.register_channel_callback("telegram", bad_cb)
    registry.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

    with TestClient(app) as client:
        response = client.post(
            "/internal/builder-progress",
            json={
                "task_id": "t-1",
                "run_id": "r-1",
                "event_name": "custom",
                "data": {"name": "phase", "phase": "drafting"},
            },
        )
    assert response.status_code == 202
    # applied=False because the callback raised (registry caught it).
    assert response.json() == {"applied": False}


def test_endpoint_validates_required_fields(app: FastAPI) -> None:
    """Pydantic rejects payloads missing required fields with 422."""
    with TestClient(app) as client:
        response = client.post(
            "/internal/builder-progress",
            json={"task_id": "t-1"},  # missing run_id, event_name
        )
    assert response.status_code == 422
