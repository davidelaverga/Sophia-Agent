"""Tests for the builder-events publisher (LangGraph-process side).

The publisher lives in ``deerflow.sophia.builder_events`` and is the bridge
between the subagent runtime and the Gateway worker that fans events out
to the webapp (SSE) and channel adapters (Telegram).

These tests cover the contract — payload shape, dedup semantics,
agent-name filtering, gateway-down resilience — without depending on the
real ``SubagentExecutor`` (the test conftest mocks that module to break a
circular import for lightweight tests). The publisher does its imports of
``SubagentStatus`` / ``_extract_builder_result_from_task_result`` lazily
inside the call, so we patch ``sys.modules`` to inject a stub executor
module just for these tests.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from deerflow.sophia import builder_events


# ---- Stub executor module the publisher imports lazily ---------------------


class _StubStatus:
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"


def _stub_extract_builder_result(result):
    """Mirror the real helper's contract: pull builder_result from final_state."""
    final_state = getattr(result, "final_state", None)
    if isinstance(final_state, dict):
        builder_result = final_state.get("builder_result")
        if isinstance(builder_result, dict) and builder_result:
            return builder_result
    return None


@pytest.fixture
def stub_executor_module(monkeypatch):
    """Replace ``deerflow.subagents.executor`` in sys.modules with a minimal
    stand-in carrying the two symbols the publisher needs.
    """
    stub = SimpleNamespace(
        SubagentStatus=_StubStatus,
        _extract_builder_result_from_task_result=_stub_extract_builder_result,
    )
    monkeypatch.setitem(sys.modules, "deerflow.subagents.executor", stub)
    yield stub


@pytest.fixture(autouse=True)
def _reset_dedup():
    builder_events.reset_for_tests()
    yield
    builder_events.reset_for_tests()


def _make_result(
    *,
    status: str = _StubStatus.COMPLETED,
    task_id: str = "task-1",
    thread_id: str = "thread-1",
    final_state: dict | None = None,
    error: str | None = None,
    description: str | None = None,
    completed_at: datetime | None = None,
    owner_id: str | None = None,
) -> SimpleNamespace:
    """Build a SubagentResult-like object with the fields the publisher reads.

    Uses ``SimpleNamespace`` to avoid importing the real ``SubagentResult``
    (which would trigger the circular import the conftest mock prevents).
    The status is wrapped so ``.value`` access works like the real Enum.
    """
    return SimpleNamespace(
        task_id=task_id,
        trace_id="trace-1",
        status=SimpleNamespace(value=status) if isinstance(status, str) else status,
        thread_id=thread_id,
        completed_at=completed_at or datetime(2026, 4, 26, 21, 2, 51),
        final_state=final_state,
        error=error,
        description=description,
        ai_messages=[],
        owner_id=owner_id,
    )


def _set_status(result: SimpleNamespace, status_value: str) -> None:
    """Bind result.status so the publisher's `not in {...}` check works."""
    result.status = getattr(_StubStatus, status_value.upper())


def _wait_for_capture(captured: list, expected: int = 1, timeout: float = 0.5) -> None:
    """Drain the daemon thread that runs ``_post_webhook``."""
    deadline = time.time() + timeout
    while time.time() < deadline and len(captured) < expected:
        time.sleep(0.005)


# ---- Tests -----------------------------------------------------------------


def test_emit_completion_event_skips_non_terminal_status(stub_executor_module):
    result = _make_result()
    _set_status(result, "running")
    with patch.object(builder_events, "_post_webhook") as post:
        emitted = builder_events.emit_completion_event(result, agent_name="sophia_builder")
    assert emitted is False
    post.assert_not_called()


def test_emit_completion_event_skips_unobserved_agent(stub_executor_module):
    result = _make_result()
    _set_status(result, "completed")
    with patch.object(builder_events, "_post_webhook") as post:
        emitted = builder_events.emit_completion_event(result, agent_name="general-purpose")
    assert emitted is False
    post.assert_not_called()


def test_emit_completion_event_skips_when_task_id_missing(stub_executor_module):
    result = _make_result(task_id="")
    _set_status(result, "completed")
    with patch.object(builder_events, "_post_webhook") as post:
        emitted = builder_events.emit_completion_event(result, agent_name="sophia_builder")
    assert emitted is False
    post.assert_not_called()


def test_emit_completion_event_fires_once_for_observed_agent(stub_executor_module):
    """Even if invoked twice (e.g. cleanup races), only one webhook fires."""
    result = _make_result(
        final_state={
            "builder_task": {"task_type": "document"},
            "builder_result": {
                "artifact_path": "/mnt/user-data/outputs/llm_time_series.md",
                "artifact_title": "LLM Time-Series Solutions",
                "artifact_type": "document",
                "companion_summary": "A focused one-pager.",
                "user_next_action": "Open and review.",
            },
            "delegation_context": {"task": "Write a one-pager about LLM time series."},
        },
    )
    _set_status(result, "completed")

    captured: list[dict] = []

    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        first = builder_events.emit_completion_event(result, agent_name="sophia_builder")
        second = builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert first is True
    assert second is False  # dedup
    assert len(captured) == 1, f"expected exactly one POST, got {len(captured)}"

    payload = captured[0]
    assert payload["thread_id"] == "thread-1"
    assert payload["task_id"] == "task-1"
    assert payload["status"] == "success"  # mapped from "completed"
    assert payload["task_type"] == "document"
    assert payload["task_brief"] == "Write a one-pager about LLM time series."
    assert payload["artifact_title"] == "LLM Time-Series Solutions"
    assert payload["artifact_type"] == "document"
    assert payload["artifact_filename"] == "llm_time_series.md"
    assert payload["summary"] == "A focused one-pager."
    assert payload["user_next_action"] == "Open and review."
    assert payload["error_message"] is None
    assert payload["completed_at"] == "2026-04-26T21:02:51"
    assert payload["agent_name"] == "sophia_builder"
    assert payload["source"] == "subagent_executor"


def test_payload_includes_owner_id_as_user_id(stub_executor_module):
    """The companion-wakeup worker (gateway side) needs ``user_id`` on
    the event so it can construct a properly-attributed synthetic turn.
    Without this, the wakeup falls back to ``user_id="default_user"``
    which loads the wrong identity."""
    result = _make_result(
        final_state={
            "builder_result": {
                "artifact_path": "/mnt/user-data/outputs/note.md",
                "artifact_title": "Note",
                "artifact_type": "document",
                "companion_summary": "Wrote a note.",
            },
            "delegation_context": {"task": "Write a note."},
        },
        owner_id="user-abc",
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert len(captured) == 1
    assert captured[0]["user_id"] == "user-abc"


def test_payload_omits_user_id_when_owner_id_missing(stub_executor_module):
    """``owner_id`` is best-effort: when missing, the payload carries
    ``user_id=None`` so the gateway worker degrades to the existing
    no-user-id fallback path (defaulting to ``"default_user"`` in the
    agent factory) rather than a hard failure."""
    result = _make_result(
        final_state={
            "builder_result": {
                "artifact_path": "/mnt/user-data/outputs/note.md",
                "artifact_title": "Note",
                "artifact_type": "document",
                "companion_summary": "Wrote a note.",
            },
            "delegation_context": {"task": "Write a note."},
        },
        owner_id=None,
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert len(captured) == 1
    assert captured[0]["user_id"] is None


def test_emit_completion_event_maps_status_to_card_enum(stub_executor_module):
    cases = [
        ("completed", "success"),
        ("failed", "error"),
        ("timed_out", "timeout"),
        ("cancelled", "cancelled"),
    ]
    # Provide a real builder_result so the success case isn't coerced to
    # phantom (PR-A added that check). Empty builder_result + completed
    # is a separate test below.
    builder_result_payload = {
        "artifact_path": "/mnt/user-data/outputs/report.md",
        "artifact_type": "document",
        "confidence": 0.9,
    }
    for status_value, expected_card_status in cases:
        builder_events.reset_for_tests()
        result = _make_result(
            task_id=f"task-{status_value}",
            error="boom" if status_value != "completed" else None,
            final_state={"builder_result": builder_result_payload},
        )
        _set_status(result, status_value)

        captured: list[dict] = []
        with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
            emitted = builder_events.emit_completion_event(result, agent_name="sophia_builder")
            _wait_for_capture(captured, expected=1)

        assert emitted is True, f"emit failed for status={status_value}"
        assert captured, f"expected payload for status={status_value}"
        assert captured[0]["status"] == expected_card_status
        if status_value != "completed":
            assert captured[0]["error_message"] == "boom"


def test_emit_completion_event_falls_back_to_description_for_brief(stub_executor_module):
    """If delegation_context.task is missing, fall back to the result.description."""
    result = _make_result(
        description="Build a 5-slide investor deck.",
        final_state={"builder_result": {}},  # no delegation_context
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured)

    assert captured
    assert captured[0]["task_brief"] == "Build a 5-slide investor deck."


def test_post_webhook_short_circuits_when_thread_id_missing():
    """No thread_id → can't route on the gateway side; never call httpx."""
    payload = {"thread_id": None, "task_id": "task-x"}
    with patch("deerflow.sophia.builder_events.httpx.Client") as client_cls:
        builder_events._post_webhook(payload)
    client_cls.assert_not_called()


def test_post_webhook_fires_post_to_configured_gateway(monkeypatch):
    """The webhook hits SOPHIA_GATEWAY_URL/internal/builder-events with JSON."""
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "http://gateway.test:9999")
    payload = {"thread_id": "thread-x", "task_id": "task-x", "status": "success"}

    posted_url: list[str] = []
    posted_json: list[dict] = []

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json):
            posted_url.append(url)
            posted_json.append(json)
            return SimpleNamespace(status_code=200, text="")

    with patch("deerflow.sophia.builder_events.httpx.Client", _FakeClient):
        builder_events._post_webhook(payload)

    assert posted_url == ["http://gateway.test:9999/internal/builder-events"]
    assert posted_json == [payload]


def test_post_webhook_swallows_exceptions(caplog):
    """Gateway down → log a warning, don't raise. The executor must not block."""
    payload = {"thread_id": "thread-x", "task_id": "task-x"}

    class _ExplodingClient:
        def __init__(self, *args, **kwargs):
            raise ConnectionError("gateway unreachable")

    with patch("deerflow.sophia.builder_events.httpx.Client", _ExplodingClient):
        # Must not raise.
        builder_events._post_webhook(payload)

    assert any(
        "Builder-events webhook delivery failed" in record.message
        for record in caplog.records
    )


def test_post_webhook_logs_warning_on_5xx(caplog, monkeypatch):
    """Gateway returns 503 → log it (so operators can correlate)."""
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "http://gateway.test")
    payload = {"thread_id": "thread-x", "task_id": "task-503"}

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json):
            return SimpleNamespace(status_code=503, text="upstream gone")

    with patch("deerflow.sophia.builder_events.httpx.Client", _FakeClient):
        builder_events._post_webhook(payload)

    assert any(
        "Builder-events webhook returned 503" in record.message
        for record in caplog.records
    )


def test_should_emit_for_agent_filter():
    assert builder_events.should_emit_for_agent("sophia_builder") is True
    assert builder_events.should_emit_for_agent("general-purpose") is False
    assert builder_events.should_emit_for_agent(None) is False
    assert builder_events.should_emit_for_agent("") is False


def test_emit_does_not_poison_dedup_when_payload_build_fails(stub_executor_module, monkeypatch):
    """Codex review (PR #87): if ``build_completion_payload`` raises after
    the dedup mark is recorded, the emit_completion_event would silence
    the task forever. The fix releases the claim on failure so a
    subsequent terminal write for the same task_id can still deliver.
    """
    result = _make_result(task_id="task-poison")
    _set_status(result, "completed")

    # Force the payload builder to throw on the first call only.
    call_count = {"n": 0}

    def _maybe_explode(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("payload build crashed")
        return {
            "thread_id": result.thread_id,
            "task_id": result.task_id,
            "status": "success",
            "agent_name": "sophia_builder",
        }

    captured: list[dict] = []
    monkeypatch.setattr(builder_events, "build_completion_payload", _maybe_explode)
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        first = builder_events.emit_completion_event(result, agent_name="sophia_builder")
        # First call: payload build crashed → returns False, dedup released.
        assert first is False

        # Second call should now succeed because the dedup claim was rolled back.
        second = builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert second is True
    assert len(captured) == 1
    assert captured[0]["task_id"] == "task-poison"


def test_phantom_success_is_coerced_to_error(stub_executor_module):
    """PR-A: when the builder reports COMPLETED but produced no deliverable
    (no artifact_path, no artifact_url) AND confidence is below threshold,
    the publisher should coerce status to error so the frontend renders
    the failure card with retry instead of a success card with a broken
    Open button.

    Trigger conditions in the wild: builder hits the hard-ceiling fallback
    with no promotable file, sets confidence=0.2 and artifact_path=None.
    """
    result = _make_result(
        final_state={
            "builder_task": {"task_type": "document"},
            "builder_result": {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task force-stopped",
                "companion_summary": "no deliverable produced",
                "confidence": 0.2,
            },
            "delegation_context": {"task": "Write a one-pager about climate."},
        },
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert captured, "expected a payload"
    payload = captured[0]
    # Coerced to error.
    assert payload["status"] == "error"
    # Retry-friendly default error_message.
    assert payload["error_message"] is not None
    assert "Want me to try again" in payload["error_message"]
    # task_brief preserved so the retry button has context.
    assert payload["task_brief"] == "Write a one-pager about climate."


def test_phantom_success_threshold_keeps_high_confidence_text_only_artifacts(stub_executor_module):
    """A high-confidence completion with no path is a legitimate text-only
    artifact (e.g. a concept summary). It must NOT be coerced to error.
    """
    result = _make_result(
        final_state={
            "builder_task": {"task_type": "research"},
            "builder_result": {
                "artifact_path": None,
                "artifact_type": "research_report",
                "companion_summary": "Synthesis: X is true because Y.",
                "confidence": 0.9,
            },
        },
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert captured
    assert captured[0]["status"] == "success"
    assert captured[0]["error_message"] is None


def test_phantom_success_missing_confidence_is_treated_as_phantom(stub_executor_module):
    """PR-A: if the builder result has no confidence at all AND no path,
    treat as phantom — it's strictly worse than any defined success case.
    """
    result = _make_result(
        final_state={
            "builder_result": {
                "artifact_path": None,
                "artifact_type": "unknown",
                # confidence intentionally absent
            },
        },
    )
    _set_status(result, "completed")

    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        builder_events.emit_completion_event(result, agent_name="sophia_builder")
        _wait_for_capture(captured, expected=1)

    assert captured
    assert captured[0]["status"] == "error"


def test_misconfigured_gateway_warning_fires_in_deployed_env(monkeypatch, caplog):
    """PR-A: when SOPHIA_GATEWAY_URL is unset AND the runtime looks like a
    deployed environment (RENDER, FLY_APP_NAME, K_SERVICE), the publisher
    logs a single WARNING the first time it tries to deliver an event so
    operators see the misconfiguration immediately instead of debugging
    silent drops.
    """
    import logging

    monkeypatch.delenv("SOPHIA_GATEWAY_URL", raising=False)
    monkeypatch.setenv("RENDER", "true")
    builder_events.reset_for_tests()  # clear the latch

    # Block the actual httpx call so we only test the warning path.
    with patch("deerflow.sophia.builder_events.httpx.Client") as client_cls:
        client_cls.side_effect = ConnectionError("blocked in test")
        with caplog.at_level(logging.WARNING, logger=builder_events.logger.name):
            builder_events._post_webhook({"thread_id": "t-1", "task_id": "task-1"})
            # Second invocation must NOT log the misconfiguration warning again
            # — it's a one-shot probe.
            builder_events._post_webhook({"thread_id": "t-2", "task_id": "task-2"})

    misconfig_warnings = [
        r for r in caplog.records
        if "SOPHIA_GATEWAY_URL not set in a deployed environment" in r.getMessage()
    ]
    assert len(misconfig_warnings) == 1, (
        f"Expected exactly one misconfiguration warning, got {len(misconfig_warnings)}"
    )


def test_misconfigured_gateway_warning_does_not_fire_locally(monkeypatch, caplog):
    """PR-A: in local dev (no RENDER/FLY_APP_NAME/K_SERVICE env vars), the
    default localhost URL is correct — no warning.
    """
    import logging

    monkeypatch.delenv("SOPHIA_GATEWAY_URL", raising=False)
    for var in ("RENDER", "RENDER_EXTERNAL_URL", "FLY_APP_NAME", "K_SERVICE"):
        monkeypatch.delenv(var, raising=False)
    builder_events.reset_for_tests()

    with patch("deerflow.sophia.builder_events.httpx.Client") as client_cls:
        client_cls.side_effect = ConnectionError("blocked in test")
        with caplog.at_level(logging.WARNING, logger=builder_events.logger.name):
            builder_events._post_webhook({"thread_id": "t-1", "task_id": "task-1"})

    misconfig_warnings = [
        r for r in caplog.records
        if "SOPHIA_GATEWAY_URL not set in a deployed environment" in r.getMessage()
    ]
    assert misconfig_warnings == []


def test_misconfigured_gateway_warning_skipped_when_explicit_url_set(monkeypatch, caplog):
    """PR-A: if SOPHIA_GATEWAY_URL IS set (any value, even invalid), trust
    the operator and don't warn. Wrong URL still produces a delivery
    failure log via the existing exception handler.
    """
    import logging

    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "http://gateway.internal:8001")
    monkeypatch.setenv("RENDER", "true")
    builder_events.reset_for_tests()

    with patch("deerflow.sophia.builder_events.httpx.Client") as client_cls:
        client_cls.side_effect = ConnectionError("blocked in test")
        with caplog.at_level(logging.WARNING, logger=builder_events.logger.name):
            builder_events._post_webhook({"thread_id": "t-1", "task_id": "task-1"})

    misconfig_warnings = [
        r for r in caplog.records
        if "SOPHIA_GATEWAY_URL not set in a deployed environment" in r.getMessage()
    ]
    assert misconfig_warnings == []


def test_emitted_task_cache_is_lru_bounded(stub_executor_module, monkeypatch):
    """Codex review (PR #87): the dedup set must not grow unbounded.

    Lower the cap and saturate the cache; the oldest entry must be
    evicted so a long-running process can't OOM through the notifier.
    """
    monkeypatch.setattr(builder_events, "_EMITTED_CACHE_MAX", 3)

    # Drive the cache through > the cap.
    for i in range(5):
        result = _make_result(task_id=f"task-{i}")
        _set_status(result, "completed")
        with patch.object(builder_events, "_post_webhook"):
            assert builder_events.emit_completion_event(result, agent_name="sophia_builder") is True

    # Internal cache should now hold at most _EMITTED_CACHE_MAX entries.
    assert len(builder_events._emitted_task_ids) == 3

    # The earliest task IDs (0, 1) should have been evicted; firing for
    # ``task-0`` again must succeed because the cache no longer remembers
    # the previous emit.
    early_result = _make_result(task_id="task-0")
    _set_status(early_result, "completed")
    captured: list[dict] = []
    with patch.object(builder_events, "_post_webhook", side_effect=lambda p: captured.append(p)):
        assert builder_events.emit_completion_event(early_result, agent_name="sophia_builder") is True
        _wait_for_capture(captured, expected=1)
    assert captured and captured[0]["task_id"] == "task-0"

    # The most recent entries (the last three we emitted PLUS task-0
    # we just re-emitted) must still be tracked, and a duplicate fire
    # for one of them must NOT re-emit.
    repeat_result = _make_result(task_id="task-4")
    _set_status(repeat_result, "completed")
    with patch.object(builder_events, "_post_webhook") as post:
        emitted = builder_events.emit_completion_event(repeat_result, agent_name="sophia_builder")
    assert emitted is False
    post.assert_not_called()
