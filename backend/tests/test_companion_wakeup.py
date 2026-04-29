"""Tests for the companion-wakeup worker and its integration with the
``POST /internal/builder-events`` route.

The wakeup worker (``app/gateway/workers/companion_wakeup.py``) closes
the gap between async builder completion and the companion's turn-driven
state adoption. When a builder finishes, it triggers a synthetic empty
turn on the companion's LangGraph thread so Sophia proactively surfaces
the artifact in chat — without the user having to type anything.

Locks:

- ``wake()`` queues a ``runs.create`` for ``status in {success, error,
  timeout}`` and skips ``cancelled`` (no proactive announcement on
  cancel).
- ``wake()`` skips when ``thread_id`` is missing.
- ``wake()`` deduplicates the same ``task_id`` across retried webhooks.
- ``wake()`` swallows exceptions from ``client.runs.create`` so the
  webhook path never fails on a wakeup error.
- ``runs.create`` is invoked with the right shape: empty
  ``input.messages``, the companion assistant id, and
  ``multitask_strategy="enqueue"`` so an in-flight user turn isn't
  interrupted.
- The internal POST route schedules a wakeup as a fire-and-forget task.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import install_builder_events_worker
from app.gateway.workers.companion_wakeup import (
    CompanionWakeup,
    install_companion_wakeup,
)


class _FakeRunsClient:
    """Minimal stand-in for ``langgraph_sdk.client.LangGraphClient.runs``.

    Captures the args of every ``create`` call so tests can assert on
    them. Configurable to raise on demand for the error-handling test.
    """

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._raises = raises

    async def create(self, thread_id, assistant_id, **kwargs):
        if self._raises is not None:
            raise self._raises
        self.calls.append({"thread_id": thread_id, "assistant_id": assistant_id, **kwargs})
        return MagicMock()


class _FakeClient:
    def __init__(self, runs: _FakeRunsClient) -> None:
        self.runs = runs


def _make_wakeup_with_fake_client(
    *, raises: Exception | None = None
) -> tuple[CompanionWakeup, _FakeRunsClient]:
    """Build a wakeup worker with its langgraph_sdk client replaced by a fake."""
    wakeup = CompanionWakeup(langgraph_url="http://test-langgraph")
    runs = _FakeRunsClient(raises=raises)
    wakeup._client = _FakeClient(runs)
    return wakeup, runs


# ---- Worker unit tests -----------------------------------------------------


@pytest.mark.anyio
async def test_wake_queues_run_on_success_event():
    wakeup, runs = _make_wakeup_with_fake_client()

    fired = await wakeup.wake({
        "thread_id": "thread-A",
        "task_id": "task-1",
        "status": "success",
        "agent_name": "sophia_builder",
        "user_id": "user-xyz",
    })

    assert fired is True
    assert len(runs.calls) == 1
    call = runs.calls[0]
    assert call["thread_id"] == "thread-A"
    assert call["assistant_id"] == "sophia_companion"
    assert call["input"] == {"messages": []}
    assert call["multitask_strategy"] == "enqueue"
    # Everything goes via ``context`` (langgraph-api 0.7+ rejects requests
    # that set both ``configurable`` and ``context`` at once; the server
    # copies context into configurable so the agent factory still reads
    # ``cfg["user_id"]`` correctly).
    assert "config" not in call
    ctx = call["context"]
    assert ctx["thread_id"] == "thread-A"
    assert ctx["user_id"] == "user-xyz"
    # Synthetic turn shape — text-platform with safe defaults so the
    # companion middleware chain initialises correctly. CLAUDE.md hard
    # rule #6: "Platform signal is mandatory in every DeerFlow request".
    assert ctx["platform"] == "text"
    assert ctx["context_mode"] == "life"
    assert ctx["thinking_enabled"] is False
    assert ctx["is_plan_mode"] is False
    assert ctx["subagent_enabled"] is True
    # Wakeup metadata so downstream code paths can branch.
    assert ctx["is_builder_wakeup"] is True
    assert ctx["builder_task_id"] == "task-1"
    assert ctx["builder_event_status"] == "success"


@pytest.mark.anyio
async def test_wake_queues_run_on_error_and_timeout_events():
    """Failure terminal states still get a proactive announcement so the
    user knows something went wrong without having to ask."""
    for status in ("error", "timeout"):
        wakeup, runs = _make_wakeup_with_fake_client()
        fired = await wakeup.wake({
            "thread_id": "thread-A",
            "task_id": f"task-{status}",
            "status": status,
        })
        assert fired is True, f"expected wakeup for status={status}"
        assert len(runs.calls) == 1


@pytest.mark.anyio
async def test_wake_skips_cancelled_event():
    """User cancellation is self-evident — no proactive announcement."""
    wakeup, runs = _make_wakeup_with_fake_client()

    fired = await wakeup.wake({
        "thread_id": "thread-A",
        "task_id": "task-1",
        "status": "cancelled",
    })

    assert fired is False
    assert runs.calls == []


@pytest.mark.anyio
async def test_wake_skips_when_thread_id_missing():
    wakeup, runs = _make_wakeup_with_fake_client()

    fired = await wakeup.wake({
        "task_id": "task-orphan",
        "status": "success",
        # thread_id intentionally missing
    })

    assert fired is False
    assert runs.calls == []


@pytest.mark.anyio
async def test_wake_deduplicates_same_task_id():
    """Retried webhooks for the same task_id must NOT trigger a second wakeup turn."""
    wakeup, runs = _make_wakeup_with_fake_client()

    event = {"thread_id": "thread-A", "task_id": "task-1", "status": "success"}
    first = await wakeup.wake(event)
    second = await wakeup.wake(event)
    third = await wakeup.wake(event)

    assert first is True
    assert second is False
    assert third is False
    assert len(runs.calls) == 1


@pytest.mark.anyio
async def test_wake_dedup_does_not_block_other_task_ids():
    wakeup, runs = _make_wakeup_with_fake_client()

    await wakeup.wake({"thread_id": "thread-A", "task_id": "task-1", "status": "success"})
    fired = await wakeup.wake({"thread_id": "thread-A", "task_id": "task-2", "status": "success"})

    assert fired is True
    assert len(runs.calls) == 2
    assert runs.calls[1]["context"]["builder_task_id"] == "task-2"


@pytest.mark.anyio
async def test_wake_swallows_client_errors():
    """An exception from ``runs.create`` must NOT propagate.

    The webhook handler is fire-and-forget; failures here should not
    surface to the LangGraph publisher (which has already moved on)
    or break the SSE/channel fan-out that ran successfully.
    """
    wakeup, runs = _make_wakeup_with_fake_client(
        raises=RuntimeError("LangGraph offline")
    )

    fired = await wakeup.wake({
        "thread_id": "thread-A",
        "task_id": "task-1",
        "status": "success",
    })

    assert fired is False  # exception was swallowed; no run queued


@pytest.mark.anyio
async def test_wake_does_not_dedup_when_task_id_missing():
    """Defensive: a task_id-less event still goes through (we can't dedup)."""
    wakeup, runs = _make_wakeup_with_fake_client()

    first = await wakeup.wake({"thread_id": "thread-A", "status": "success"})
    second = await wakeup.wake({"thread_id": "thread-A", "status": "success"})

    assert first is True
    assert second is True
    assert len(runs.calls) == 2


def test_dedup_set_evicts_oldest_when_full():
    """The bounded dedup memory must evict the oldest entries past capacity."""
    from app.gateway.workers.companion_wakeup import _DEDUP_MAX_ENTRIES

    wakeup = CompanionWakeup()
    for i in range(_DEDUP_MAX_ENTRIES + 5):
        wakeup._remember(f"task-{i}")

    # First few should be evicted; last few retained.
    assert "task-0" not in wakeup._seen_task_ids
    assert "task-4" not in wakeup._seen_task_ids
    assert f"task-{_DEDUP_MAX_ENTRIES + 4}" in wakeup._seen_task_ids
    assert len(wakeup._seen_task_ids) == _DEDUP_MAX_ENTRIES


def test_langgraph_url_uses_env_fallback(monkeypatch):
    """LANGGRAPH_URL env var overrides the default."""
    monkeypatch.setenv("LANGGRAPH_URL", "http://my-langgraph:9999")
    wakeup = CompanionWakeup()
    assert wakeup.langgraph_url == "http://my-langgraph:9999"


def test_langgraph_url_explicit_argument_wins_over_env(monkeypatch):
    monkeypatch.setenv("LANGGRAPH_URL", "http://env-url:1111")
    wakeup = CompanionWakeup(langgraph_url="http://explicit:2222")
    assert wakeup.langgraph_url == "http://explicit:2222"


def test_langgraph_url_default_when_nothing_set(monkeypatch):
    monkeypatch.delenv("LANGGRAPH_URL", raising=False)
    wakeup = CompanionWakeup()
    assert wakeup.langgraph_url == "http://localhost:2024"


# ---- HTTP integration: route schedules wakeup ------------------------------


@pytest.fixture
def app_with_wakeup() -> FastAPI:
    """Gateway test app with both the events worker AND wakeup installed."""
    test_app = FastAPI()
    install_builder_events_worker(test_app, cache_ttl_seconds=60)
    install_companion_wakeup(test_app, langgraph_url="http://test-langgraph")
    test_app.include_router(routes.internal_router)
    test_app.include_router(routes.public_router)
    return test_app


@pytest.fixture
def client_with_wakeup(app_with_wakeup: FastAPI) -> httpx.AsyncClient:
    transport = ASGITransport(app=app_with_wakeup)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.anyio
async def test_internal_post_schedules_wakeup_on_success(
    app_with_wakeup: FastAPI, client_with_wakeup: httpx.AsyncClient
):
    """A success POST must schedule a wakeup task that fires the runs.create call."""
    from app.gateway.workers.companion_wakeup import get_companion_wakeup

    wakeup = get_companion_wakeup(app_with_wakeup)
    runs = _FakeRunsClient()
    wakeup._client = _FakeClient(runs)

    async with client_with_wakeup:
        response = await client_with_wakeup.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-route",
                "task_id": "task-route",
                "status": "success",
                "agent_name": "sophia_builder",
            },
        )

    assert response.status_code == 202
    # Yield to the event loop so the fire-and-forget task runs.
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert len(runs.calls) == 1
    assert runs.calls[0]["thread_id"] == "thread-route"
    assert runs.calls[0]["context"]["builder_task_id"] == "task-route"


@pytest.mark.anyio
async def test_internal_post_does_not_schedule_wakeup_on_cancel(
    app_with_wakeup: FastAPI, client_with_wakeup: httpx.AsyncClient
):
    from app.gateway.workers.companion_wakeup import get_companion_wakeup

    wakeup = get_companion_wakeup(app_with_wakeup)
    runs = _FakeRunsClient()
    wakeup._client = _FakeClient(runs)

    async with client_with_wakeup:
        response = await client_with_wakeup.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-cancel",
                "task_id": "task-cancel",
                "status": "cancelled",
            },
        )

    assert response.status_code == 202
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    # Wakeup ran (status filter inside wake()) but didn't queue a run.
    assert runs.calls == []


@pytest.mark.anyio
async def test_internal_post_works_without_wakeup_installed():
    """When the wakeup worker isn't installed, the route still returns 202.

    Existing test fixtures (``test_builder_events_worker``) only install
    the SSE worker. The route must not break their setup.
    """
    test_app = FastAPI()
    install_builder_events_worker(test_app, cache_ttl_seconds=60)
    # Note: install_companion_wakeup is NOT called.
    test_app.include_router(routes.internal_router)
    test_app.include_router(routes.public_router)

    transport = ASGITransport(app=test_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        response = await c.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-no-wakeup",
                "task_id": "task-no-wakeup",
                "status": "success",
            },
        )

    assert response.status_code == 202


@pytest.mark.anyio
async def test_internal_post_wakeup_failure_does_not_break_response(
    app_with_wakeup: FastAPI, client_with_wakeup: httpx.AsyncClient
):
    """If wakeup raises during scheduling, the response is still 202."""
    from app.gateway.workers.companion_wakeup import get_companion_wakeup

    wakeup = get_companion_wakeup(app_with_wakeup)
    runs = _FakeRunsClient(raises=RuntimeError("LangGraph offline"))
    wakeup._client = _FakeClient(runs)

    async with client_with_wakeup:
        response = await client_with_wakeup.post(
            "/internal/builder-events",
            json={
                "thread_id": "thread-err",
                "task_id": "task-err",
                "status": "success",
            },
        )

    # Webhook ack still fires even though the wakeup task will fail
    # asynchronously (and swallow its own exception).
    assert response.status_code == 202
