"""Unit tests for ``webhook_payload_to_event`` and ``chunk_to_events``."""

from __future__ import annotations

from app.gateway.builder_events.adapters import (
    chunk_to_events,
    webhook_payload_to_event,
)


def test_webhook_field_mapping_task_id_becomes_thread_id() -> None:
    payload = {
        "task_id": "builder-thread-99",
        "thread_id": "companion-thread-7",
        "user_id": "u1",
        "trace_id": "abc123",
        "status": "success",
        "artifact_url": "https://example.com/x.pptx",
        "artifact_filename": "x.pptx",
        "artifact_title": "X",
        "artifact_type": "pptx",
        "summary": "done",
        "user_next_action": "review",
        "task_type": "deck",
        "agent_name": "sophia_builder",
        "completed_at": "2026-05-10T10:00:00Z",
        "source": "subagent_executor",
    }

    event = webhook_payload_to_event(payload)

    # Asymmetric webhook naming absorbed
    assert event.thread_id == "builder-thread-99"
    assert event.parent_thread_id == "companion-thread-7"
    assert event.user_id == "u1"
    assert event.trace_id == "abc123"
    assert event.event_type == "completed"
    assert event.source == "webhook"
    assert event.payload["artifact_url"] == "https://example.com/x.pptx"
    assert event.payload["companion_summary"] == "done"
    assert event.payload["task_type"] == "deck"
    assert event.payload["webhook_source"] == "subagent_executor"


def test_webhook_status_error_maps_to_failed() -> None:
    payload = {
        "task_id": "t1",
        "thread_id": "p1",
        "status": "error",
        "error_message": "boom",
    }
    event = webhook_payload_to_event(payload)
    assert event.event_type == "failed"
    assert event.payload["error_message"] == "boom"


def test_webhook_status_timeout_maps_to_timed_out() -> None:
    event = webhook_payload_to_event({"task_id": "t1", "thread_id": "p1", "status": "timeout"})
    assert event.event_type == "timed_out"


def test_webhook_unknown_status_defaults_to_failed() -> None:
    event = webhook_payload_to_event({"task_id": "t1", "thread_id": "p1", "status": "weird-state"})
    assert event.event_type == "failed"


def test_webhook_main_mode_has_no_parent_thread_id() -> None:
    """Work bot DM: payload['thread_id'] is None/missing → main mode."""
    event = webhook_payload_to_event({"task_id": "builder-1", "status": "success"})
    assert event.parent_thread_id is None
    assert event.is_subagent_mode is False


def test_webhook_subagent_mode_when_thread_id_present() -> None:
    event = webhook_payload_to_event({"task_id": "builder-1", "thread_id": "companion-1", "status": "success"})
    assert event.parent_thread_id == "companion-1"
    assert event.is_subagent_mode is True


def test_chunk_to_events_stage1_returns_empty() -> None:
    """Stage 1A ships an empty stub; Stage 2A fills it in."""
    events = chunk_to_events(
        {"messages": []},
        thread_id="t1",
        parent_thread_id=None,
        user_id="u1",
        trace_id="trace-1",
        last_message_ids={},
    )
    assert events == []
