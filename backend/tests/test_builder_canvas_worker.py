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
    assert events[0]["activity"]["label"] == "Searching web"
    assert events[0]["activity"]["action"] == "searching_web"
    assert "source_domain" not in events[0]["activity"]
    assert "private query" not in str(events)
    assert "https://private.example" not in str(events)
    assert events[0]["event_id"] == "task-1:run-1:1"


@pytest.mark.anyio
async def test_fetch_projection_includes_only_safe_source_domain_and_title() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "updates",
            "data": {
                "agent": {
                    "messages": [{
                        "tool_calls": [{
                            "name": "builder_web_fetch",
                            "args": {
                                "url": "https://www.example.com/private/article?token=secret",
                                "title": "Public Article Title",
                                "query": "private query",
                            },
                        }],
                    }],
                },
            },
        }
    )

    events = await worker.recent_events("parent-1")
    assert events[0]["activity"]["label"] == "Reading source"
    assert events[0]["activity"]["action"] == "reading_source"
    assert events[0]["activity"]["source_domain"] == "example.com"
    assert events[0]["activity"]["source_title"] == "Public Article Title"
    assert "https://www.example.com/private/article" not in str(events)
    assert "private query" not in str(events)
    assert "token=secret" not in str(events)


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
async def test_timeout_completion_preserves_timed_out_canvas_status() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "finalizing"},
        }
    )

    await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-1", "run_id": "run-1", "status": "timeout"}
    )

    events = await worker.recent_events("parent-1")
    assert events[-1]["kind"] == "terminal"
    assert events[-1]["status"] == "timed_out"
    assert events[-1]["activity"]["action"] == "timed_out"
    assert events[-1]["activity"]["label"] == "Timed out"
    assert events[-1]["completion"]["status"] == "timeout"


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
    assert events[0]["activity"] == {
        "kind": "phase",
        "phase": "done",
        "category": "finalize",
        "action": "success",
        "label": "Success",
    }


@pytest.mark.anyio
async def test_out_of_order_paired_progress_events_are_retained_in_sequence_order() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 2,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "researching"},
        }
    )

    delivered = await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "updates",
            "data": {
                "agent": {
                    "messages": [{
                        "tool_calls": [{"name": "builder_web_search", "args": {"query": "private"}}],
                    }],
                },
            },
        }
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert [event["sequence"] for event in events] == [1, 2]
    assert events[0]["activity"]["label"] == "Searching web"
    assert events[0]["activity"]["action"] == "searching_web"
    assert events[1]["activity"]["label"] == "Researching"
    assert events[1]["activity"]["action"] == "researching"


@pytest.mark.anyio
async def test_plan_tool_distinguishes_create_and_update_plan() -> None:
    worker = BuilderCanvasWorker()
    for sequence in (1, 2):
        await worker.publish_progress(
            {
                "parent_thread_id": "parent-1",
                "task_id": "task-1",
                "run_id": "run-1",
                "sequence": sequence,
                "event_name": "updates",
                "data": {
                    "agent": {
                        "messages": [{
                            "tool_calls": [{"name": "write_todos", "args": {"todos": ["private"]}}],
                        }],
                    },
                },
            }
        )

    events = await worker.recent_events("parent-1")
    assert [event["activity"]["label"] for event in events] == ["Creating plan", "Updating plan"]
    assert [event["activity"]["action"] for event in events] == ["creating_plan", "updating_plan"]


@pytest.mark.anyio
async def test_file_and_check_tools_use_normalized_public_labels() -> None:
    worker = BuilderCanvasWorker()
    tool_calls = [
        ("write_file", {"path": "/secret/path/report.html"}, "Writing file", "writing_file"),
        ("read_file", {"path": "/secret/path/report.html"}, "Reading file", "reading_file"),
        ("str_replace", {"path": "/secret/path/report.html"}, "Editing file", "editing_file"),
        ("bash", {"command": "pytest tests/test_private.py -q"}, "Running check", "running_check"),
        ("emit_builder_artifact", {"artifact_title": "Private title"}, "Packaging artifact", "packaging_artifact"),
    ]
    for sequence, (name, args, _, _) in enumerate(tool_calls, start=1):
        await worker.publish_progress(
            {
                "parent_thread_id": "parent-1",
                "task_id": "task-1",
                "run_id": "run-1",
                "sequence": sequence,
                "event_name": "updates",
                "data": {"agent": {"messages": [{"tool_calls": [{"name": name, "args": args}]}]}},
            }
        )

    events = await worker.recent_events("parent-1")
    assert [(event["activity"]["label"], event["activity"]["action"]) for event in events] == [
        (label, action) for _, _, label, action in tool_calls
    ]
    assert "/secret/path" not in str(events)
    assert "pytest tests/test_private.py" not in str(events)
    assert "Private title" not in str(events)


@pytest.mark.anyio
async def test_duplicate_out_of_order_progress_event_is_dropped() -> None:
    worker = BuilderCanvasWorker()
    payload = {
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "sequence": 1,
        "event_name": "custom",
        "data": {"name": "phase", "phase": "researching"},
    }
    await worker.publish_progress(payload)
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 2,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )

    delivered = await worker.publish_progress(payload)

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert [event["sequence"] for event in events] == [1, 2]
    assert len(events) == 2


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
async def test_terminal_sequence_is_allocated_after_racing_final_progress() -> None:
    class RacingWorker(BuilderCanvasWorker):
        def __init__(self) -> None:
            super().__init__()
            self.injected_final_progress = False

        async def _publish_event(self, event):
            if event["kind"] == "terminal" and not self.injected_final_progress:
                self.injected_final_progress = True
                await self.publish_progress(
                    {
                        "parent_thread_id": "parent-1",
                        "task_id": "task-1",
                        "run_id": "run-1",
                        "sequence": 2,
                        "event_name": "custom",
                        "data": {"name": "phase", "phase": "finalizing"},
                    }
                )
            return await super()._publish_event(event)

    worker = RacingWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )

    await worker.publish_completion(
        {
            "thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "status": "success",
            "artifact_path": "mnt/user-data/outputs/report.html",
        }
    )

    events = await worker.recent_events("parent-1")
    assert [(event["kind"], event["sequence"]) for event in events] == [
        ("progress", 1),
        ("progress", 2),
        ("terminal", 3),
    ]
    assert events[-1]["event_id"] == "task-1:run-1:3"
    assert events[-1]["completion"]["artifact_path"] == "mnt/user-data/outputs/report.html"


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
async def test_new_task_supersedes_delayed_terminal_from_prior_task_without_public_activity() -> None:
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
async def test_terminal_only_new_task_replaces_prior_active_task() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-old",
            "run_id": "run-old",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }
    )

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-new", "run_id": "run-new", "status": "success"}
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert len(events) == 1
    assert events[0]["kind"] == "terminal"
    assert events[0]["task_id"] == "task-new"
    assert events[0]["run_id"] == "run-new"


@pytest.mark.anyio
async def test_unobserved_terminal_for_same_active_task_does_not_replace_current_run() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-new",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-1", "run_id": "run-old", "status": "success"}
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert len(events) == 1
    assert events[0]["kind"] == "progress"
    assert events[0]["run_id"] == "run-new"


@pytest.mark.anyio
async def test_unprojectable_old_run_terminal_does_not_replace_current_same_task() -> None:
    worker = BuilderCanvasWorker()
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-old",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "unprojectable"},
        }
    )
    await worker.publish_progress(
        {
            "parent_thread_id": "parent-1",
            "task_id": "task-1",
            "run_id": "run-new",
            "sequence": 1,
            "event_name": "custom",
            "data": {"name": "phase", "phase": "drafting"},
        }
    )

    delivered = await worker.publish_completion(
        {"thread_id": "parent-1", "task_id": "task-1", "run_id": "run-old", "status": "success"}
    )

    assert delivered == 0
    events = await worker.recent_events("parent-1")
    assert len(events) == 1
    assert events[0]["kind"] == "progress"
    assert events[0]["run_id"] == "run-new"


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
