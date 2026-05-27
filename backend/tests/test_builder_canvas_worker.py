from __future__ import annotations

import logging

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
        "label": "Searching",
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
async def test_completion_without_run_id_uses_active_same_task_run() -> None:
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

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-1", "status": "success"}
    )

    events = await worker.recent_events("parent-1")
    assert delivered == 0
    assert events[-1]["kind"] == "terminal"
    assert events[-1]["run_id"] == "run-1"
    assert events[-1]["completion"]["run_id"] == "run-1"


@pytest.mark.anyio
async def test_completion_without_run_id_does_not_close_different_active_task() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-active",
            "run_id": "run-active",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }
    )

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-missing", "status": "success"}
    )

    events = await worker.recent_events("parent-1")
    assert delivered == 0
    assert len(events) == 1
    assert events[0]["task_id"] == "task-active"


@pytest.mark.anyio
async def test_done_phase_is_projected_to_browser_activity() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "done"},
        }
    )
    events = await worker.recent_events("parent-1")
    assert events[0]["activity"] == {"kind": "phase", "phase": "done", "label": "Done"}


@pytest.mark.anyio
async def test_canvas_logs_terminal_artifact_presence(caplog) -> None:
    caplog.set_level(logging.INFO)
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
        {
            "thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "status": "success",
            "artifact_path": "mnt/user-data/outputs/brief.md",
        }
    )

    assert "Builder canvas: event accepted" in caplog.text
    assert "has_artifact_path=True" in caplog.text


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


@pytest.mark.anyio
async def test_new_task_supersedes_delayed_progress_from_prior_task() -> None:
    worker = BuilderCanvasWorker()
    for task_id, sequence in (("task-old", 1), ("task-new", 1), ("task-old", 2)):
        await worker.publish_progress(
            {
                "parent_thread_id": "parent-1",
                "task_id": task_id,
                "run_id": "run-1",
                "sequence": sequence,
                "event_name": "custom",
                "data": {"name": "phase", "phase": "drafting"},
            }
        )
    events = await worker.recent_events("parent-1")
    assert {event["task_id"] for event in events} == {"task-new"}


@pytest.mark.anyio
async def test_new_task_supersedes_delayed_terminal_from_unseen_prior_task() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-old",
            "run_id": "run-old",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "unprojectable"},
        }
    )
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-new",
            "run_id": "run-new",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }
    )

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-old", "run_id": "run-old", "status": "success"}
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert {event["task_id"] for event in events} == {"task-new"}


@pytest.mark.anyio
async def test_expired_replaced_run_cannot_reclaim_active_seed() -> None:
    worker = BuilderCanvasWorker(terminal_ttl_seconds=-1)
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-old",
            "run_id": "run-old",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )
    await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-old", "run_id": "run-old", "status": "success"}
    )
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-new",
            "run_id": "run-new",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }
    )

    delivered = await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-old",
            "run_id": "run-old",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "finalizing"},
        }
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert {event["task_id"] for event in events} == {"task-new"}


@pytest.mark.anyio
async def test_evicted_retired_run_purges_retained_state() -> None:
    worker = BuilderCanvasWorker(retired_runs_size=1)
    for task_id in ("task-old", "task-mid", "task-new"):
        await worker.publish_progress(
            {
                "parent_thread_id": "parent-1",
                "task_id": task_id,
                "run_id": "run-1",
                "sequence": 1,
                "event_name": "custom",
                "data": {"name": "phase", "phase": "drafting"},
            }
        )

    evicted_key = ("parent-1", "task-old", "run-1")
    assert evicted_key not in worker._histories
    assert evicted_key not in worker._last_sequence
    assert evicted_key not in worker._terminal_at
    assert ("task-old", "run-1") not in worker._retired_run_keys["parent-1"]

    events = await worker.recent_events("parent-1")
    assert {event["task_id"] for event in events} == {"task-new"}
