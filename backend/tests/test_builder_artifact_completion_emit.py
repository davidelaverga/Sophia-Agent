"""Tests for the native-dispatch builder-completion webhook helpers.

After the Phase-1 async migration, ``BuilderArtifactMiddleware`` fires the
gateway webhook directly (via ``fire_completion_webhook_from_artifact``)
instead of relying on the deleted ``SubagentExecutor``. These tests lock
the wire shape, the dedup, and the phantom-success guard.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from deerflow.sophia import builder_events


@pytest.fixture(autouse=True)
def _reset_dedup_cache():
    """Each test starts with a clean dedup set."""
    builder_events.reset_for_tests()
    yield
    builder_events.reset_for_tests()


def _make_runtime(
    *,
    builder_thread_id: str = "task-builder-1",
    parent_thread_id: str = "thread-companion-1",
    user_id: str = "alice",
    trace_id: str = "trace-1",
) -> SimpleNamespace:
    """Build a stand-in for ``langgraph.runtime.Runtime`` matching what
    ``start_builder_task._dispatch_via_asgi`` puts in the run config."""
    return SimpleNamespace(
        config={
            "configurable": {
                "thread_id": builder_thread_id,
                "parent_thread_id": parent_thread_id,
                "user_id": user_id,
            },
            "metadata": {"trace_id": trace_id},
        }
    )


def _make_state(
    *,
    task_brief: str = "Build a one-pager about X",
    task_type: str = "document",
    parent_thread_id: str | None = None,
    parent_user_id: str | None = None,
) -> dict:
    """Build a state dict matching what ``start_builder_task._dispatch_via_asgi``
    puts in ``input["delegation_context"]``.

    PR-fix (2026-05-06): ``parent_thread_id`` + ``parent_user_id`` are now
    embedded in delegation_context because langgraph-api 0.8.1 does not
    forward custom ``configurable`` keys to the running graph's
    ``runtime.config``. Tests cover both the state-present path AND the
    legacy state-absent / config-fallback path.
    """
    delegation: dict = {"task": task_brief, "task_type": task_type}
    if parent_thread_id is not None:
        delegation["parent_thread_id"] = parent_thread_id
    if parent_user_id is not None:
        delegation["parent_user_id"] = parent_user_id
    return {
        "delegation_context": delegation,
        "builder_task": {"task_type": task_type},
    }


def _success_artifact(**overrides) -> dict:
    base = {
        "artifact_path": "/mnt/user-data/outputs/foo.md",
        "artifact_title": "Foo One-Pager",
        "artifact_type": "document",
        "confidence": 0.88,
        "companion_summary": "Wrote the one-pager you asked for.",
        "companion_tone_hint": "Confident",
        "user_next_action": "Open or download to review.",
        "decisions_made": ["Used a single markdown file"],
    }
    base.update(overrides)
    return base


def _phantom_artifact() -> dict:
    """Apology fallback shape: no artifact_path, low confidence."""
    return {
        "artifact_path": None,
        "artifact_type": "unknown",
        "artifact_title": "Build task completed",
        "steps_completed": 0,
        "decisions_made": [],
        "companion_summary": "The build task was completed.",
        "companion_tone_hint": "Neutral.",
        "user_next_action": None,
        "confidence": 0.2,
    }


# ---------- payload shape ----------------------------------------------------


def test_build_completion_payload_from_artifact_success_shape():
    runtime = _make_runtime(builder_thread_id="t-build", parent_thread_id="t-parent", user_id="alice")
    state = _make_state(task_brief="Build a brief about X", task_type="document")

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/foo.md"):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    # ``thread_id`` in webhook = COMPANION thread (where Telegram chat lives).
    assert payload["thread_id"] == "t-parent"
    # ``task_id`` = builder thread (also key in async_tasks dict).
    assert payload["task_id"] == "t-build"
    assert payload["agent_name"] == "sophia_builder"
    assert payload["status"] == "success"  # _map_status normalizes "completed" -> "success"
    assert payload["task_type"] == "document"
    assert payload["task_brief"] == "Build a brief about X"
    assert payload["artifact_url"] == "https://supabase.test/foo.md"
    assert payload["artifact_filename"] == "foo.md"
    assert payload["artifact_title"] == "Foo One-Pager"
    assert payload["summary"] == "Wrote the one-pager you asked for."
    assert payload["user_next_action"] == "Open or download to review."
    assert payload["error_message"] is None
    assert payload["user_id"] == "alice"
    assert payload["source"] == "builder_artifact_middleware"
    assert payload["trace_id"] == "trace-1"


def test_phantom_success_coerces_to_error():
    """No artifact path + low confidence + no signed URL → status=error with retry message."""
    runtime = _make_runtime()
    state = _make_state()

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_phantom_artifact(), status="completed"
        )

    assert payload["status"] == "error"
    assert payload["error_message"] is not None
    assert "try again" in payload["error_message"].lower()


def test_failed_status_passes_through():
    runtime = _make_runtime()
    state = _make_state()

    payload = builder_events.build_completion_payload_from_artifact(
        state=state,
        runtime=runtime,
        artifact=_success_artifact(),
        status="failed",
        error_message="Builder timed out after 1800s.",
    )

    assert payload["status"] == "error"  # _map_status: failed -> error
    assert payload["error_message"] == "Builder timed out after 1800s."


def test_timed_out_status_passes_through():
    runtime = _make_runtime()
    state = _make_state()

    payload = builder_events.build_completion_payload_from_artifact(
        state=state, runtime=runtime, artifact=_success_artifact(), status="timed_out"
    )

    assert payload["status"] == "timeout"


# ---------- dedup + dispatch -------------------------------------------------


def test_fire_webhook_dedups_by_task_id():
    """Two firings for the same task_id must result in exactly one POST."""
    runtime = _make_runtime(builder_thread_id="dedup-1")
    state = _make_state()

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/x.md"), \
         patch.object(builder_events, "_post_webhook"):
        first = builder_events.fire_completion_webhook_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )
        second = builder_events.fire_completion_webhook_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    assert first is True
    assert second is False  # dedup hit
    # Daemon thread is started for the first; the dedup contract is the
    # load-bearing assertion. We don't join the daemon thread because
    # _post_webhook is patched and never actually fires.


def test_fire_webhook_returns_false_without_thread_id():
    runtime = SimpleNamespace(config={"configurable": {}, "metadata": {}})
    state = _make_state()

    result = builder_events.fire_completion_webhook_from_artifact(
        state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
    )

    assert result is False


def test_fire_webhook_returns_false_for_non_terminal_status():
    runtime = _make_runtime()
    state = _make_state()

    result = builder_events.fire_completion_webhook_from_artifact(
        state=state, runtime=runtime, artifact=_success_artifact(), status="running"
    )

    assert result is False


def test_payload_handles_missing_task_brief():
    """When delegation_context.task is empty, task_brief is None (not a crash)."""
    runtime = _make_runtime()
    state = {"delegation_context": {}, "builder_task": {"task_type": "research"}}

    payload = builder_events.build_completion_payload_from_artifact(
        state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
    )

    assert payload["task_brief"] is None
    assert payload["task_type"] == "research"


def test_payload_handles_missing_state_fields():
    """Defensive: empty state dict should still yield a valid payload."""
    runtime = _make_runtime()

    payload = builder_events.build_completion_payload_from_artifact(
        state={}, runtime=runtime, artifact=_success_artifact(), status="completed"
    )

    assert payload["task_brief"] is None
    assert payload["task_type"] is None
    assert payload["thread_id"] == "thread-companion-1"  # from runtime config


# ---------- state-first plumbing (the actual prod-bug fix) ------------------


def test_payload_reads_parent_thread_id_from_state_when_config_missing():
    """Production scenario: langgraph-api 0.8.1 doesn't propagate custom
    configurable keys, so parent_thread_id arrives None in
    runtime.config.configurable. State must carry the canonical value.
    """
    # Runtime simulates the broken propagation: only thread_id and user_id
    # made it through; parent_thread_id was dropped.
    runtime = SimpleNamespace(
        config={
            "configurable": {
                "thread_id": "t-build",
                "user_id": "alice",
                # parent_thread_id intentionally absent
            },
            "metadata": {"trace_id": "trace-1"},
        }
    )
    state = _make_state(
        parent_thread_id="real-companion-thread",
        parent_user_id="alice",
    )

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/foo.md"):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    # Without the state fallback, this would be None and _post_webhook
    # would early-return, dropping the Telegram delivery silently.
    assert payload["thread_id"] == "real-companion-thread"
    assert payload["user_id"] == "alice"


def test_payload_state_takes_precedence_over_config():
    """When both state and config have parent_thread_id, state wins.

    This matters for the deliberate redundancy: ``start_builder_task``
    writes parent_thread_id to BOTH state (canonical) and config
    (back-compat). State is the source of truth.
    """
    runtime = _make_runtime(parent_thread_id="config-thread", user_id="config-user")
    state = _make_state(parent_thread_id="state-thread", parent_user_id="state-user")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    assert payload["thread_id"] == "state-thread"
    assert payload["user_id"] == "state-user"




def test_payload_user_id_falls_back_to_parent_user_id_config_key():
    """If state omits parent_user_id, prefer configurable.parent_user_id.

    Some callers may set the parent-specific key in config; payload building
    should honor it before the generic user_id fallback.
    """
    runtime = SimpleNamespace(
        config={
            "configurable": {
                "thread_id": "t-build",
                "parent_thread_id": "legacy-config-thread",
                "parent_user_id": "parent-user",
                "user_id": "generic-user",
            },
            "metadata": {"trace_id": "trace-1"},
        }
    )
    state = {
        "delegation_context": {"task": "Build something", "task_type": "document"},
        "builder_task": {"task_type": "document"},
    }

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    assert payload["thread_id"] == "legacy-config-thread"
    assert payload["user_id"] == "parent-user"
def test_payload_falls_back_to_config_when_state_parent_thread_id_missing():
    """When state.delegation_context omits parent_thread_id, the runtime
    config value is used as a fallback (covers the legacy pre-PR behaviour).
    """
    runtime = _make_runtime(parent_thread_id="legacy-config-thread", user_id="legacy-user")
    # State has delegation_context.task but NO parent_thread_id key.
    state = {
        "delegation_context": {"task": "Build something", "task_type": "document"},
        "builder_task": {"task_type": "document"},
    }

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(
            state=state, runtime=runtime, artifact=_success_artifact(), status="completed"
        )

    assert payload["thread_id"] == "legacy-config-thread"
    assert payload["user_id"] == "legacy-user"
