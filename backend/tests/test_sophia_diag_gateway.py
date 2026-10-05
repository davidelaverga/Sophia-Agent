"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from sophia_diag_fixture import CONTENT, OWNER, SECRET_DETAIL, _assert_content_free, _one
from sophia_diag_fixture import diag_logs as _diag_logs

diag_logs = _diag_logs


class _FakeAsyncClient:
    behaviour = "ok"
    status = 202

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, content=None, headers=None):
        if self.behaviour == "raise":
            raise httpx.ConnectError(SECRET_DETAIL)
        return SimpleNamespace(status_code=self.status, text=SECRET_DETAIL)


@pytest.mark.parametrize(
    ("behaviour", "status", "phase", "level", "outcome"),
    [
        ("raise", None, "starting", logging.WARNING, "failed"),
        ("ok", 500, "starting", logging.WARNING, "rejected"),
        ("ok", 202, "starting", logging.INFO, "delivered"),
        ("ok", 202, "done", logging.INFO, "delivered"),
        ("ok", 202, "researching", logging.DEBUG, "delivered"),
    ],
)
def test_progress_post_levels_and_failure_warning(monkeypatch, diag_logs, behaviour, status, phase, level, outcome):
    from deerflow.agents.sophia_agent.middlewares import builder_progress

    client = type("Client", (_FakeAsyncClient,), {"behaviour": behaviour, "status": status})
    monkeypatch.setattr(builder_progress.httpx, "AsyncClient", client)
    monkeypatch.setattr(builder_progress, "signed_builder_event_headers", lambda body: {})
    task, run, parent = str(uuid4()), str(uuid4()), str(uuid4())
    asyncio.run(builder_progress._post_progress_event(task_id=task, run_id=run, event_name="custom", data={"name": "phase", "phase": phase}, parent_thread_id=parent, sequence=3))
    got_level, event = _one(diag_logs, "builder.progress.post")
    assert got_level == level and event["outcome"] == outcome and event["phase"] == phase
    assert event["task_id"] == task and event["run_id"] == run and event["parent_thread_id"] == parent and event["seq"] == 3
    assert isinstance(event["post_ms"], int)
    if behaviour == "raise":
        assert event["error_type"] == "ConnectError" and "http_status" not in event
    else:
        assert event["http_status"] == status
    _assert_content_free(diag_logs)


def test_gateway_progress_received_event(monkeypatch, diag_logs):
    from datetime import UTC, datetime, timedelta

    from app.gateway.routers.builder_events import BuilderProgressEvent, receive_builder_progress

    class Registry:
        async def apply_event(self, **kwargs):
            return True

    monkeypatch.setattr("app.gateway.builder_progress.get_progress_registry", lambda: Registry())
    task, run, parent = str(uuid4()), str(uuid4()), str(uuid4())
    occurred = (datetime.now(UTC) - timedelta(milliseconds=250)).isoformat()
    event = BuilderProgressEvent(
        task_id=task, run_id=run, parent_thread_id=parent, sequence=1, occurred_at=occurred, event_name="updates", data={"agent": {"messages": [{"tool_calls": [{"name": "web_search", "args": {"query": CONTENT}}]}]}}
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    response = asyncio.run(receive_builder_progress(event, request))
    assert response == {"applied": True, "web_delivered": 0}
    _, logged = _one(diag_logs, "builder.progress.received")
    assert logged["task_id"] == task and logged["run_id"] == run and logged["parent_thread_id"] == parent
    assert logged["event"] == "updates" and logged["applied"] is True and logged["web_delivered"] == 0 and logged["synthetic"] is False
    assert 200 <= logged["lag_ms"] < 5_000
    _assert_content_free(diag_logs)


def test_canvas_delivered_subscriber_count(diag_logs):
    from app.gateway.workers.builder_canvas import BuilderCanvasWorker

    worker = BuilderCanvasWorker()
    parent, task, run = str(uuid4()), str(uuid4()), str(uuid4())

    async def main():
        async with worker.subscribe(parent), worker.subscribe(parent):
            return await worker.publish_progress({"parent_thread_id": parent, "task_id": task, "run_id": run, "sequence": 1, "event_name": "custom", "data": {"name": "phase", "phase": "starting"}})

    assert asyncio.run(main()) == 2
    _, event = _one(diag_logs, "builder.canvas.delivered")
    assert event["parent_thread_id"] == parent and event["task_id"] == task and event["run_id"] == run
    assert event["subscribers"] == 2 and event["delivered"] == 2 and event["dropped"] == 0 and event["seq"] == 1


# ---------------------------------------------------------------------------
# Gateway source intake
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fault", [None, "conflict", "outage"])
def test_source_action_event(monkeypatch, diag_logs, fault):
    from fastapi import HTTPException

    from app.gateway.routers import memory_source
    from deerflow.sophia.memory_governance.source_intake import SourceActionRequest
    from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    session, thread, message = str(uuid4()), str(uuid4()), str(uuid4())

    class Service:
        def __init__(self, *, owner_id, store):
            assert owner_id == OWNER

        def accept(self, *, session_id, action):
            if fault == "conflict":
                raise MemoryGovernanceConflict("governance_revision_conflict")
            if fault == "outage":
                raise RuntimeError(SECRET_DETAIL)
            return SimpleNamespace(sequence=7, idempotent_replay=False, model_dump=lambda **kwargs: {"status": "source_recorded"})

    monkeypatch.setattr(memory_source, "SourceIntakeService", Service)
    monkeypatch.setattr(memory_source, "configured_memory_store", lambda: object())
    action = SourceActionRequest(thread_id=thread, message_id=message, command_key=str(uuid4()), expected_clear_epoch=0, content=CONTENT)
    if fault is None:
        response = memory_source.accept_source_action(session, action=action, owner=OWNER)
        assert response.status_code == 200
    else:
        with pytest.raises(HTTPException) as raised:
            memory_source.accept_source_action(session, action=action, owner=OWNER)
        assert raised.value.status_code == (409 if fault == "conflict" else 503)
    _, event = _one(diag_logs, "source_action")
    assert event["message_id"] == message and event["thread_id"] == thread
    assert event["session_ref"].startswith("hmac-sha256:session:") and isinstance(event["duration_ms"], int)
    assert event["outcome"] == {None: "recorded", "conflict": "conflict", "outage": "unavailable"}[fault]
    assert ("seq" in event) is (fault is None)
    _assert_content_free(diag_logs, session)
