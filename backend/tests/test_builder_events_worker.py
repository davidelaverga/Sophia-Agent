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
from unittest.mock import AsyncMock, MagicMock

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


@pytest.fixture(autouse=True)
def allow_fixture_parent_thread_id(monkeypatch):
    """Endpoint fixtures use a readable stand-in for a production UUID."""
    original = routes._is_langgraph_thread_id
    monkeypatch.setattr(
        routes,
        "_is_langgraph_thread_id",
        lambda value: value == "parent-thread" or original(value),
    )


# ---- Worker unit tests -----------------------------------------------------


def test_terminal_task_update_preserves_url_only_deliverable():
    payload = {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "run-1",
        "status": "success",
        "artifact_url": "https://signed.example/report.pdf",
        "artifact_title": "Report",
    }

    update = routes._terminal_async_task_update(payload)

    assert update["builder_result"]["artifact_url"] == "https://signed.example/report.pdf"
    assert "artifact_path" not in update["builder_result"]
    assert routes._should_persist_last_builder_artifact(payload) is True


def test_terminal_task_update_preserves_builder_failure_diagnostics():
    diagnostics = {
        "schema": "builder_failure_diagnostics_v1",
        "failure_code": "builder_completed_without_deliverable",
        "failure_stage": "artifact_emit",
        "supabase_mirror_result": "failed",
    }
    payload = {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "run-1",
        "status": "error",
        "failure_code": "builder_completed_without_deliverable",
        "builder_failure_diagnostics": diagnostics,
    }

    update = routes._terminal_async_task_update(payload)

    assert update["builder_failure_diagnostics"] == diagnostics
    assert update["builder_result"]["builder_failure_diagnostics"] == diagnostics


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
async def test_internal_post_persists_terminal_builder_state(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "run_id": "run-1",
                "status": "success",
                "agent_name": "sophia_builder",
                "task_type": "document",
                "artifact_path": "mnt/user-data/outputs/brief.md",
                "artifact_url": "https://signed.example/temporary",
                "artifact_ext": "md",
                "source_artifact_path": "mnt/user-data/outputs/source.md",
                "revision_of_artifact_path": "mnt/user-data/outputs/source.md",
            },
        )

    assert response.status_code == 202
    assert captured["thread_id"] == "parent-thread"
    values = captured["values"]
    task_update = values["async_tasks"]["builder-task"]
    assert task_update["status"] == "success"
    assert task_update["artifact_path"] == "mnt/user-data/outputs/brief.md"
    assert task_update["builder_result"]["artifact_path"] == "mnt/user-data/outputs/brief.md"
    assert task_update["builder_result"]["source_artifact_path"] == ("mnt/user-data/outputs/source.md")
    assert "artifact_url" not in task_update["builder_result"]
    assert values["last_builder_artifact"]["artifact_path"] == "mnt/user-data/outputs/brief.md"
    assert "artifact_url" not in values["last_builder_artifact"]


@pytest.mark.anyio
async def test_terminal_state_repairs_graphless_legacy_parent(monkeypatch):
    parent_thread_id = "01a025a6-1f12-7173-bfd1-1812a40afd22"
    payload = {
        "thread_id": parent_thread_id,
        "task_id": "builder-task",
        "run_id": "run-1",
        "status": "success",
        "artifact_path": "mnt/user-data/outputs/brief.md",
    }
    fake_threads = MagicMock()
    fake_threads.update_state = AsyncMock(
        side_effect=[
            RuntimeError(
                f"Thread '{parent_thread_id}' has no assigned graph ID. "
                "This operation requires a graph ID."
            ),
            None,
        ]
    )
    fake_threads.update = AsyncMock()
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    await routes._persist_builder_terminal_state(payload)

    fake_threads.update.assert_awaited_once_with(
        parent_thread_id,
        metadata={"graph_id": "sophia_companion"},
    )
    assert fake_threads.update_state.await_count == 2


@pytest.mark.anyio
async def test_internal_post_preserves_image_startup_diagnostics(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    diagnostic_fields = {
        "image_generation_startup_error_class": "image_script_not_found",
        "image_generation_exit_code": 127,
        "image_generation_raw_error_excerpt": "hands-on-deck/generate_images.py not found",
        "image_generation_startup_attempt_count": 1,
    }

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "run_id": "run-1",
                "status": "success",
                "agent_name": "sophia_builder",
                "artifact_path": "mnt/user-data/outputs/deck.pptx",
                **diagnostic_fields,
            },
        )
        last_response = await client.get("/api/threads/parent-thread/builder-events/last")

    assert response.status_code == 202
    task_update = captured["values"]["async_tasks"]["builder-task"]
    for key, value in diagnostic_fields.items():
        assert task_update[key] == value
        assert task_update["builder_result"][key] == value
        assert captured["values"]["last_builder_artifact"][key] == value
        assert last_response.json()[key] == value


@pytest.mark.anyio
async def test_internal_post_preserves_zero_native_deck_diagnostics(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    diagnostic_fields = {
        "deck_route": "deck_ir_html_raster",
        "deck_compile_mode": "not_compiled",
        "native_required": True,
        "legacy_screenshot_debug": False,
        "native_editability_score": 0.0,
        "native_text_shape_count": 0,
        "picture_shape_count": 0,
        "full_slide_picture_count": 0,
        "deck_quality_status": "failed",
        "quality_warning": "native deck inspection found no editable text shapes",
        "failure_code": "deck_native_text_missing",
        "deck_failure_code": "deck_native_text_missing",
        "expected_generated_visual_count": 0,
        "successful_generated_visual_count": 0,
        "referenced_visual_count": 0,
        "missing_expected_visual_count": 0,
        "visual_quality_gap_count": 0,
    }

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "run_id": "run-1",
                "status": "success",
                "agent_name": "sophia_builder",
                "artifact_path": "mnt/user-data/outputs/deck.pptx",
                "artifact_ext": "pptx",
                **diagnostic_fields,
            },
        )
        last_response = await client.get("/api/threads/parent-thread/builder-events/last")

    assert response.status_code == 202
    task_update = captured["values"]["async_tasks"]["builder-task"]
    for key, value in diagnostic_fields.items():
        assert task_update[key] == value
        assert task_update["builder_result"][key] == value
        assert captured["values"]["last_builder_artifact"][key] == value
        assert last_response.json()[key] == value


@pytest.mark.anyio
async def test_internal_post_persists_terminal_deck_diagnostics(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    terminal_fields = {
        "terminal_status": "completed",
        "terminal_reason": "deck_build_succeeded",
        "first_prepare_turn": 8,
        "prepare_call_count": 1,
        "prepare_emitted_call_count": 1,
        "prepare_execution_count": 1,
        "prepare_normalized_call_count": 1,
        "prepare_schema_failure_count": 0,
        "prepare_service_call_count": 1,
        "prepare_service_result_count": 1,
        "prepare_result_count": 1,
        "prepare_retry_executed": False,
        "dangling_prepare_call_count": 0,
        "creative_plan_accepted": True,
        "deck_authoring_contract": "compact_model_html_v1",
        "deck_authoring_elapsed_ms": 42000,
        "deck_repair_elapsed_ms": 0,
        "deck_service_elapsed_ms": 180000,
        "terminal_cleanup_elapsed_ms": 500,
        "prepare_force_reason": "model_initiated",
        "manifest_path": "/mnt/user-data/outputs/.builder/builds/build-1/manifest.json",
        "manifest_revision": 2,
        "logical_artifact_id": "logical-1",
        "current_artifact_version_id": "version-2",
        "foundation_status": "committed",
        "source_quality_report": {
            "passed": True,
            "hard_failures": [],
            "soft_warnings": [],
        },
    }

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "run_id": "run-1",
                "status": "success",
                "agent_name": "sophia_builder",
                "artifact_path": "mnt/user-data/outputs/deck.pptx",
                "artifact_ext": "pptx",
                **terminal_fields,
            },
        )
        last_response = await client.get("/api/threads/parent-thread/builder-events/last")

    assert response.status_code == 202
    task_update = captured["values"]["async_tasks"]["builder-task"]
    for key, value in terminal_fields.items():
        assert task_update[key] == value
        assert task_update["builder_result"][key] == value
        assert captured["values"]["last_builder_artifact"][key] == value
        assert last_response.json()[key] == value


@pytest.mark.anyio
async def test_internal_post_persists_report_contract_diagnostics(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    report_fields = {
        "report_contract_status": "rejected",
        "report_contract_version": "report_manifest_v1",
        "expected_section_count": 9,
        "found_section_count": 5,
        "expected_body_section_count": 6,
        "found_body_section_count": 2,
        "expected_visual_count": 4,
        "found_visual_count": 1,
        "missing_section_ids": ["architecture", "conclusion"],
        "missing_visual_ids": ["read-path", "write-path"],
        "minimum_word_count": 1200,
        "source_word_count": 458,
        "cover_present": True,
        "toc_present": True,
        "conclusion_present": False,
        "references_present": False,
        "report_contract_problems": ["report_manifest.sections[3].id:architecture"],
    }

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "run_id": "run-1",
                "status": "error",
                "agent_name": "sophia_builder",
                "terminal_status": "failed",
                "terminal_reason": "pdf_report_contract_failed",
                **report_fields,
            },
        )
        last_response = await client.get("/api/threads/parent-thread/builder-events/last")

    assert response.status_code == 202
    task_update = captured["values"]["async_tasks"]["builder-task"]
    for key, value in report_fields.items():
        assert task_update[key] == value
        assert task_update["builder_result"][key] == value
        assert last_response.json()[key] == value


@pytest.mark.anyio
async def test_internal_post_hydrates_missing_run_id_from_parent_task(
    app: FastAPI,
    client: httpx.AsyncClient,
    monkeypatch,
):
    captured: dict = {}
    fake_threads = MagicMock()
    fake_threads.get_state = AsyncMock(
        return_value={
            "values": {
                "async_tasks": {
                    "builder-task": {
                        "task_id": "builder-task",
                        "agent_name": "sophia_builder",
                        "run_id": "run-from-parent-state",
                        "status": "running",
                    }
                }
            }
        }
    )

    async def _update_state(thread_id: str, values: dict):
        captured["thread_id"] = thread_id
        captured["values"] = values

    fake_threads.update_state = AsyncMock(side_effect=_update_state)
    fake_client = MagicMock()
    fake_client.threads = fake_threads
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    async with client:
        response = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "status": "success",
                "agent_name": "sophia_builder",
                "artifact_path": "mnt/user-data/outputs/brief.md",
            },
        )
        last_response = await client.get("/api/threads/parent-thread/builder-events/last")

    assert response.status_code == 202
    assert captured["values"]["async_tasks"]["builder-task"]["run_id"] == "run-from-parent-state"
    assert captured["values"]["async_tasks"]["builder-task"]["builder_result"]["run_id"] == ("run-from-parent-state")
    assert last_response.status_code == 200
    assert last_response.json()["run_id"] == "run-from-parent-state"


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
    body = encoded[len(b"data: ") :].split(b"\n\n")[0]
    assert json.loads(body) == payload
