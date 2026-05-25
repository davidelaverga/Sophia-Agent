from __future__ import annotations

import pytest

from app.gateway.workers.builder_canvas import BuilderCanvasWorker


@pytest.mark.anyio
async def test_progress_projection_is_curated_and_replayable() -> None:
    worker = BuilderCanvasWorker()
    delivered = await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "occurred_at": "2026-05-25T10:00:00Z",
            "event_name": "updates",
            "data": {
                "agent": {
                    "messages": [{
                        "tool_calls": [{
                            "name": "builder_web_search",
                            "args": {"query": "private query", "url": "https://private.example"},
                        }],
                    }],
                },
            },
        }
    )
    assert delivered == 0
    events = await worker.replay_after("parent-1", None)
    assert events[0]["activity"] == {
        "kind": "tool_activity",
        "category": "research",
        "label": "Researching sources",
    }
    assert "private query" not in str(events)
    assert events[0]["event_id"] == "task-1:run-1:1"


@pytest.mark.anyio
async def test_terminal_closes_run_and_replay_starts_after_event_id() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }
    )
    await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-1", "run_id": "run-1", "status": "success"}
    )
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 3,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )
    replay = await worker.replay_after("parent-1", "task-1:run-1:1")
    assert len(replay) == 1
    assert replay[0]["kind"] == "terminal"
    assert replay[0]["status"] == "completed"


@pytest.mark.anyio
async def test_new_run_supersedes_delayed_progress_from_prior_run() -> None:
    worker = BuilderCanvasWorker()
    for run_id, sequence in (("run-old", 1), ("run-new", 1), ("run-old", 2)):
        await worker.publish_progress(
            {
                "parent_thread_id": "parent-1",
                "task_id": "task-1",
                "run_id": run_id,
                "sequence": sequence,
                "event_name": "custom",
                "data": {"name": "phase", "phase": "drafting"},
            }
        )
    events = await worker.recent_events("parent-1")
    assert {event["run_id"] for event in events} == {"run-new"}
