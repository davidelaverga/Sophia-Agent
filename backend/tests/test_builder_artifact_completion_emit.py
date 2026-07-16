"""Tests for the native-dispatch builder-completion webhook helpers.

After the Phase-1 async migration, ``BuilderArtifactMiddleware`` fires the
gateway webhook directly (via ``fire_completion_webhook_from_artifact``)
instead of relying on the deleted ``SubagentExecutor``. These tests lock
the wire shape, the dedup, and the phantom-success guard.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from deerflow.agents.sophia_agent.middlewares import builder_artifact as builder_artifact_module
from deerflow.sophia import builder_events
from deerflow.sophia.builder_event_auth import BUILDER_EVENT_HMAC_SECRET_ENV

_BUILDER_EVENT_SECRET = "builder-event-test-secret-" + "a" * 40


@pytest.fixture(autouse=True)
def _reset_dedup_cache(monkeypatch: pytest.MonkeyPatch):
    """Each test starts with a clean dedup set."""
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _BUILDER_EVENT_SECRET)
    builder_events.reset_for_tests()
    yield
    builder_events.reset_for_tests()


def _make_runtime(
    *,
    builder_thread_id: str | None = "task-builder-1",
    builder_run_id: str | None = "run-builder-1",
    parent_thread_id: str | None = "thread-companion-1",
    user_id: str = "alice",
    trace_id: str = "trace-1",
    builder_thread_id_in_context: bool = True,
    builder_thread_id_in_execution_info: bool = True,
    include_execution_info: bool = True,
) -> SimpleNamespace:
    """Build a stand-in for ``langgraph.runtime.Runtime``.

    Production reality (langgraph >= 1.0.6, confirmed 2026-05-06):

    - ``runtime.execution_info.thread_id`` — canonical, populated by
      ``pregel/_algo.py`` on every task. This is the production source
      of truth.
    - ``runtime.context["thread_id"]`` — auto-populated by langgraph-api
      on ASGI in-process dispatch. Useful as a fallback when test stubs
      pre-date the execution_info pattern, or under older langgraph.
    - ``runtime.config["configurable"]["thread_id"]`` — legacy fallback;
      langgraph-api 0.8.1 doesn't forward our custom keys reliably.

    Defaults populate execution_info AND context (matching prod). Pass
    flags to opt out for fallback-path coverage.
    """
    context: dict = {}
    config_configurable: dict = {
        "parent_thread_id": parent_thread_id,
        "user_id": user_id,
    }
    execution_info: SimpleNamespace | None = None

    if builder_thread_id is not None:
        if builder_thread_id_in_context:
            context["thread_id"] = builder_thread_id
        else:
            # Fallback path: only in config.
            config_configurable["thread_id"] = builder_thread_id

    if include_execution_info:
        ei_thread_id = builder_thread_id if builder_thread_id_in_execution_info else None
        execution_info = SimpleNamespace(
            thread_id=ei_thread_id,
            run_id=builder_run_id,
        )

    runtime = SimpleNamespace(
        context=context,
        config={
            "configurable": config_configurable,
            "metadata": {"trace_id": trace_id},
        },
    )
    if execution_info is not None:
        runtime.execution_info = execution_info
    return runtime


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


def test_pdf_presentation_target_uses_pdf_artifact_route():
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pdf",
        "delegation_context": {
            "task": "Build a technical presentation and deliver it as a PDF.",
            "task_type": "presentation",
            "artifact_target_path": "/mnt/user-data/outputs/deck.pdf",
        },
    }

    assert builder_artifact_module._requested_pdf_artifact(state) is True
    assert builder_artifact_module._requested_pptx_artifact(state) is False


def test_build_completion_payload_from_artifact_success_shape():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
        user_id="alice",
    )
    state = _make_state(task_brief="Build a brief about X", task_type="document")

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/foo.md"):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    _assert_success_completion_payload_shape(payload)


def _assert_success_completion_payload_shape(payload: dict) -> None:
    expected = {
        "thread_id": "t-parent",
        "task_id": "t-build",
        "run_id": "r-1",
        "agent_name": "sophia_builder",
        "status": "success",
        "task_type": "document",
        "task_brief": "Build a brief about X",
        "artifact_path": "mnt/user-data/outputs/foo.md",
        "artifact_url": "https://supabase.test/foo.md",
        "artifact_filename": "foo.md",
        "artifact_title": "Foo One-Pager",
        "summary": "Wrote the one-pager you asked for.",
        "user_next_action": "Open or download to review.",
        "error_message": None,
        "user_id": "alice",
        "source": "builder_artifact_middleware",
        "trace_id": "trace-1",
    }
    for key, value in expected.items():
        assert payload[key] == value


def test_completion_payload_preserves_artifact_path_when_signed_url_missing():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
    )
    state = _make_state(task_brief="Build a brief about X", task_type="document")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert payload["status"] == "success"
    assert payload["artifact_path"] == "mnt/user-data/outputs/foo.md"
    assert payload["artifact_filename"] == "foo.md"
    assert payload["artifact_url"] is None


def test_completion_payload_preserves_verified_storage_metadata():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
    )
    state = _make_state(task_brief="Build a brief about X", task_type="document")
    artifact = _success_artifact(
        artifact_id="artifact_123",
        storage_provider="supabase",
        storage_bucket="sophia-builder-artifacts",
        storage_object_path="artifacts/alice/t-parent/artifact_123/foo.md",
        storage_status="available",
        artifact_sha256="a" * 64,
    )

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert payload["artifact_id"] == "artifact_123"
    assert payload["storage_provider"] == "supabase"
    assert payload["storage_bucket"] == "sophia-builder-artifacts"
    assert payload["storage_object_path"] == "artifacts/alice/t-parent/artifact_123/foo.md"
    assert payload["storage_status"] == "available"
    assert payload["artifact_sha256"] == "a" * 64
    serialized = repr(payload)
    assert "signed.example" not in serialized
    assert "svc-role" not in serialized


def test_completion_payload_records_signed_url_failure_without_dropping_artifact_path():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
    )
    state = _make_state(task_brief="Build a brief about X", task_type="document")

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch("deerflow.sophia.storage.supabase_artifact_store.is_configured", return_value=True),
    ):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert payload["status"] == "success"
    assert payload["artifact_path"] == "mnt/user-data/outputs/foo.md"
    assert payload["artifact_url"] is None
    diagnostic = payload["builder_failure_diagnostics"]
    assert diagnostic["failure_stage"] == "storage_mirror"
    assert diagnostic["supabase_mirror_result"] == "signed_url_failed"
    assert diagnostic["signed_url_created"] is False
    assert "https://" not in repr(diagnostic)


def test_required_builder_upload_missing_env_fails_closed(tmp_path, monkeypatch, caplog):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "foo.md").write_text("# Foo", encoding="utf-8")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_BUILDER_BUCKET", raising=False)
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/foo.md",
        "artifact_type": "document",
        "user_id": "alice",
    }

    with caplog.at_level("WARNING"):
        result = builder_artifact_module._upload_builder_outputs_to_supabase(
            thread_id="thread-1",
            outputs_host_path=str(outputs),
            artifact_args=artifact,
        )

    assert result == "required_not_configured"
    assert "storage_object_path" not in artifact
    assert "storage_bucket" not in artifact
    assert "SUPABASE_URL" in caplog.text
    assert "SUPABASE_SERVICE_ROLE_KEY" in caplog.text
    assert "SUPABASE_BUILDER_BUCKET" in caplog.text
    assert "svc-role" not in caplog.text


def test_required_builder_upload_failure_does_not_set_storage_metadata(tmp_path, monkeypatch, caplog):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "foo.md").write_text("# Foo", encoding="utf-8")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-secret")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")

    def fail_upload(*_args, **_kwargs):
        raise RuntimeError("svc-role-secret should not leak")

    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        fail_upload,
    )
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/foo.md",
        "artifact_type": "document",
        "user_id": "alice",
    }

    with caplog.at_level("WARNING"):
        result = builder_artifact_module._upload_builder_outputs_to_supabase(
            thread_id="thread-1",
            outputs_host_path=str(outputs),
            artifact_args=artifact,
        )

    assert result == "required_upload_failed"
    assert "storage_object_path" not in artifact
    assert "storage_bucket" not in artifact
    assert "svc-role-secret" not in caplog.text


def test_required_builder_upload_verify_failure_does_not_set_storage_metadata(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "foo.md").write_text("# Foo", encoding="utf-8")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda object_path, _content, **_kwargs: object_path,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: False,
    )
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/foo.md",
        "artifact_type": "document",
        "user_id": "alice",
    }

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "required_verify_failed"
    assert "storage_object_path" not in artifact
    assert "storage_bucket" not in artifact


def test_required_builder_upload_success_sets_verified_user_scoped_metadata(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "foo.md").write_text("# Foo", encoding="utf-8")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    uploaded: list[tuple[str, bytes]] = []

    def upload_object(object_path, content, **_kwargs):
        uploaded.append((object_path, content))
        return object_path

    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        upload_object,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: True,
    )
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/foo.md",
        "artifact_type": "document",
        "user_id": "alice",
    }

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "uploaded"
    assert uploaded == [(artifact["storage_object_path"], b"# Foo")]
    assert artifact["storage_provider"] == "supabase"
    assert artifact["storage_bucket"] == "sophia-builder-artifacts"
    assert artifact["storage_status"] == "available"
    assert artifact["storage_object_path"].startswith("artifacts/alice/thread-1/")
    assert f"/{artifact['artifact_id']}/" in artifact["storage_object_path"]
    assert artifact["artifact_sha256"] == hashlib.sha256(b"# Foo").hexdigest()
    serialized = repr(artifact)
    assert "# Foo" not in serialized
    assert "signed" not in serialized.lower()


def test_required_builder_upload_promotes_primary_artifact_before_preview(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"pptx bytes")
    (outputs / "deck.preview.pdf").write_bytes(b"preview bytes")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    uploaded: list[tuple[str, bytes]] = []
    mirrored: list[str] = []

    def upload_object(object_path, content, **_kwargs):
        uploaded.append((object_path, content))
        return object_path

    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        upload_object,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: True,
    )

    def mirror_file(host_path, *_args):
        mirrored.append(host_path)
        return "uploaded"

    monkeypatch.setattr(builder_artifact_module, "maybe_mirror_file", mirror_file)
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "user_id": "alice",
        "artifact_files": [
            {"path": "/mnt/user-data/outputs/deck.preview.pdf", "role": "preview"},
            {"path": "/mnt/user-data/outputs/deck.pptx", "role": "primary"},
        ],
    }

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "uploaded"
    assert uploaded[0] == (artifact["storage_object_path"], b"pptx bytes")
    assert mirrored == [str(outputs / "deck.preview.pdf")]
    assert artifact["storage_object_path"].endswith("/deck.pptx")


def test_artifact_files_promote_repointed_artifact_path_over_stale_payload_primary():
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/compiled-deck.pptx",
        "artifact_type": "presentation",
        "artifact_files": [
            {"path": "/mnt/user-data/outputs/model-deck.pptx", "role": "primary"},
            {"path": "/mnt/user-data/outputs/compiled-deck.preview.pdf", "role": "preview"},
        ],
    }

    entries = builder_artifact_module._artifact_file_entries(artifact)
    primary_paths = [entry["path"] for entry in entries if entry.get("role") == "primary"]

    assert primary_paths == ["/mnt/user-data/outputs/compiled-deck.pptx"]
    assert entries[0]["path"] == "/mnt/user-data/outputs/compiled-deck.pptx"
    assert "/mnt/user-data/outputs/model-deck.pptx" not in {entry["path"] for entry in entries}


def test_completion_payload_preserves_fallback_metadata():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
    )
    state = _make_state(task_brief="Build a slide deck", task_type="presentation")
    artifact = _success_artifact(
        artifact_path="/mnt/user-data/outputs/deck.html",
        artifact_type="webpage",
        artifact_title="Deck fallback",
        requested_artifact_ext="pptx",
        artifact_ext="html",
        artifact_is_fallback=True,
        fallback_reason="pptx_generation_not_completed",
    )

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert payload["status"] == "success"
    assert payload["artifact_path"] == "mnt/user-data/outputs/deck.html"
    assert payload["artifact_type"] == "webpage"
    assert payload["requested_artifact_ext"] == "pptx"
    assert payload["artifact_ext"] == "html"
    assert payload["artifact_is_fallback"] is True
    assert payload["fallback_reason"] == "pptx_generation_not_completed"


def test_completion_payload_preserves_image_generation_metadata():
    runtime = _make_runtime(
        builder_thread_id="t-build",
        builder_run_id="r-1",
        parent_thread_id="t-parent",
    )
    state = _make_state(task_brief="Build a slide deck with generated images", task_type="presentation")
    artifact = _success_artifact(
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_type="pptx",
        image_generation_status="failed",
        image_generation_reason="org_not_verified",
        primary_image_batch_status="failed",
        primary_image_batch_error_class="auth_invalid",
        image_generation_startup_error_class="import_error",
        image_generation_exit_code=1,
        image_generation_raw_error_excerpt="ModuleNotFoundError: No module named openai",
        serial_repair_count=2,
        manifest_authoring_failure_count=1,
        presentation_route="html_slide_to_pptx_raster",
        expected_generated_visual_count=5,
        successful_generated_visual_count=3,
        referenced_visual_count=3,
        missing_expected_visual_count=2,
        visual_quality_gap_count=4,
    )

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert payload["image_generation_status"] == "failed"
    assert payload["image_generation_reason"] == "org_not_verified"
    assert payload["primary_image_batch_status"] == "failed"
    assert payload["primary_image_batch_error_class"] == "auth_invalid"
    assert payload["image_generation_startup_error_class"] == "import_error"
    assert payload["image_generation_exit_code"] == 1
    assert payload["image_generation_raw_error_excerpt"] == "ModuleNotFoundError: No module named openai"
    assert payload["serial_repair_count"] == 2
    assert payload["manifest_authoring_failure_count"] == 1
    assert payload["presentation_route"] == "html_slide_to_pptx_raster"
    assert payload["expected_generated_visual_count"] == 5
    assert payload["successful_generated_visual_count"] == 3
    assert payload["referenced_visual_count"] == 3
    assert payload["missing_expected_visual_count"] == 2
    assert payload["visual_quality_gap_count"] == 4


def test_build_completion_payload_run_id_is_none_when_runtime_missing_it():
    """Pre-4I in-flight payloads: if runtime.execution_info doesn't
    expose ``run_id`` (e.g. older test stubs / langgraph runtimes),
    the payload carries ``run_id=None``. Downstream registry treats
    None as "skip the check" so older deployments don't break.
    """
    runtime = _make_runtime(builder_thread_id="t-build", builder_run_id=None)
    state = _make_state()
    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")
    assert payload["run_id"] is None


def test_resolve_runtime_run_id_reads_execution_info():
    """``_resolve_runtime_run_id`` returns ``runtime.execution_info.run_id``
    when present."""
    runtime = _make_runtime(builder_run_id="r-42")
    assert builder_events._resolve_runtime_run_id(runtime) == "r-42"


def test_resolve_runtime_run_id_falls_back_to_context():
    """If execution_info doesn't carry run_id, the context dict is
    consulted as a fallback (legacy test stubs)."""
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="t", run_id=None),
        context={"run_id": "r-from-context"},
    )
    assert builder_events._resolve_runtime_run_id(runtime) == "r-from-context"


def test_resolve_runtime_run_id_returns_none_when_unavailable():
    """Missing on both execution_info and context → None (callers
    skip the run_id check)."""
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="t", run_id=None),
        context={},
    )
    assert builder_events._resolve_runtime_run_id(runtime) is None


def test_builder_completion_event_pydantic_accepts_run_id():
    """Wire-contract lock: the gateway's pydantic model MUST keep
    ``run_id`` (not silently drop it). Without this, a webhook
    arriving with ``run_id`` populated would have it stripped at
    parse time and the registry's run-id guard would be effectively
    disabled on the direct terminal-arrival path — exactly the gap
    codex P1 flagged.
    """
    from app.gateway.routers.builder_events import BuilderCompletionEvent

    parsed = BuilderCompletionEvent(
        thread_id="t-parent",
        task_id="t-build",
        run_id="r-NEW",
        status="success",
        builder_failure_diagnostics={
            "schema": "builder_failure_diagnostics_v1",
            "failure_code": "builder_completed_without_deliverable",
            "emit_attempted": False,
        },
    )
    # The field round-trips through ``model_dump`` (what the router
    # uses to forward the payload).
    dumped = parsed.model_dump()
    assert dumped["run_id"] == "r-NEW"
    assert dumped["builder_failure_diagnostics"]["failure_code"] == "builder_completed_without_deliverable"
    # Back-compat: run_id is optional. Pre-4I in-flight payloads
    # without the field still parse.
    legacy = BuilderCompletionEvent(thread_id="t-p", task_id="t-b", status="success")
    assert legacy.run_id is None


def test_completion_payload_preserves_terminal_and_prepare_metadata():
    from app.gateway.routers.builder_events import BuilderCompletionEvent

    artifact = {
        "artifact_path": None,
        "artifact_type": "presentation",
        "artifact_title": "Deck did not complete",
        "status": "failed",
        "terminal_status": "failed",
        "terminal_reason": "deck_prepare_tool_result_missing",
        "failure_code": "deck_prepare_tool_result_missing",
        "first_prepare_turn": 8,
        "prepare_call_count": 2,
        "prepare_emitted_call_count": 2,
        "prepare_execution_count": 1,
        "prepare_normalized_call_count": 1,
        "prepare_schema_failure_count": 1,
        "prepare_service_call_count": 1,
        "prepare_service_result_count": 1,
        "prepare_result_count": 1,
        "prepare_retry_executed": True,
        "dangling_prepare_call_count": 1,
        "creative_plan_accepted": False,
        "deck_authoring_contract": "compact_model_html_v1",
        "deck_authoring_elapsed_ms": 119000,
        "deck_repair_elapsed_ms": 12000,
        "deck_service_elapsed_ms": 480000,
        "terminal_cleanup_elapsed_ms": 800,
        "prepare_force_reason": "authoring_deadline",
        "manifest_path": "/mnt/user-data/outputs/.builder/builds/build-1/manifest.json",
        "manifest_revision": 2,
        "deck_build_id": "build-1",
        "builder_trace_root_run_id": "builder-trace-root-1",
        "logical_artifact_id": "logical-1",
        "current_artifact_version_id": "version-2",
        "foundation_status": "committed",
        "root_failure_code": "deck_prepare_argument_invalid",
        "root_failure_summary": "The first prepare call failed schema validation.",
        "source_quality_report": {
            "passed": False,
            "hard_failures": [{"selector": "slide:2", "check": "chrome"}],
        },
        "source_retention_report": {"passed": False, "missing_required_count": 1},
        "native_contrast_report": {"passed": False, "required_issue_count": 1},
        "confidence": 0.0,
    }

    payload = builder_events.build_completion_payload_from_artifact(
        state=_make_state(task_type="presentation"),
        runtime=_make_runtime(),
        artifact=artifact,
        status="failed",
    )
    parsed = BuilderCompletionEvent(**payload)

    assert payload["status"] == "error"
    assert parsed.terminal_status == "failed"
    assert parsed.terminal_reason == "deck_prepare_tool_result_missing"
    assert parsed.first_prepare_turn == 8
    assert parsed.prepare_call_count == 2
    assert parsed.prepare_emitted_call_count == 2
    assert parsed.prepare_execution_count == 1
    assert parsed.prepare_normalized_call_count == 1
    assert parsed.prepare_schema_failure_count == 1
    assert parsed.prepare_service_call_count == 1
    assert parsed.prepare_service_result_count == 1
    assert parsed.prepare_result_count == 1
    assert parsed.prepare_retry_executed is True
    assert parsed.dangling_prepare_call_count == 1
    assert parsed.creative_plan_accepted is False
    assert parsed.deck_authoring_contract == "compact_model_html_v1"
    assert parsed.deck_authoring_elapsed_ms == 119000
    assert parsed.deck_repair_elapsed_ms == 12000
    assert parsed.deck_service_elapsed_ms == 480000
    assert parsed.terminal_cleanup_elapsed_ms == 800
    assert parsed.prepare_force_reason == "authoring_deadline"
    assert parsed.manifest_revision == 2
    assert parsed.deck_build_id == "build-1"
    assert parsed.builder_trace_root_run_id == "builder-trace-root-1"
    assert parsed.trace_id == "trace-1"
    assert parsed.builder_trace_root_run_id != parsed.trace_id
    assert parsed.logical_artifact_id == "logical-1"
    assert parsed.current_artifact_version_id == "version-2"
    assert parsed.foundation_status == "committed"
    assert parsed.root_failure_code == "deck_prepare_argument_invalid"
    assert parsed.source_quality_report == {
        "passed": False,
        "hard_failures": [{"selector": "slide:2", "check": "chrome"}],
    }
    assert parsed.source_retention_report == {"passed": False, "missing_required_count": 1}
    assert parsed.native_contrast_report == {"passed": False, "required_issue_count": 1}


def test_phantom_success_coerces_to_error():
    """No artifact path + low confidence + no signed URL → status=error with retry message."""
    runtime = _make_runtime()
    state = _make_state()

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_phantom_artifact(), status="completed")

    assert payload["status"] == "error"
    assert payload["error_message"] is not None
    assert "try again" in payload["error_message"].lower()
    diagnostic = payload["builder_failure_diagnostics"]
    assert diagnostic["failure_stage"] == "completion_reconciliation"
    assert diagnostic["failure_code"] == "builder_completed_without_deliverable"
    assert diagnostic["supabase_mirror_result"] != "signed_url_failed"


def test_phantom_success_threshold_includes_point_three_confidence():
    runtime = _make_runtime()
    state = _make_state()
    artifact = _phantom_artifact()
    artifact["confidence"] = 0.3

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert payload["status"] == "error"
    assert payload["error_message"] is not None


def test_phantom_success_missing_confidence_coerces_to_error():
    runtime = _make_runtime()
    state = _make_state()
    artifact = _phantom_artifact()
    artifact.pop("confidence", None)

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert payload["status"] == "error"
    assert payload["error_message"] is not None


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

    payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="timed_out")

    assert payload["status"] == "timeout"


# ---------- dedup + dispatch -------------------------------------------------


def test_fire_webhook_dedups_by_task_id_and_run_id():
    """Two firings for the same task_id/run_id must result in one POST."""
    runtime = _make_runtime(builder_thread_id="dedup-1", builder_run_id="run-1")
    state = _make_state()

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/x.md"), patch.object(builder_events, "_post_webhook"):
        first = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")
        second = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert first is True
    assert second is False  # dedup hit
    # Daemon thread is started for the first; the dedup contract is the
    # load-bearing assertion. We don't join the daemon thread because
    # _post_webhook is patched and never actually fires.


_QUALITY_RUN_ID = f"quality_{'a' * 64}"


class _WebhookResponse:
    def __init__(self, status_code: int, body: object) -> None:
        self.status_code = status_code
        self.text = "response"
        self._body = body

    def json(self) -> object:
        if isinstance(self._body, BaseException):
            raise self._body
        return self._body


def _install_webhook_responses(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[_WebhookResponse | BaseException],
) -> list[dict[str, object]]:
    calls: list[dict[str, object]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url: str, **kwargs):
            index = len(calls)
            if "json" in kwargs:
                wire_json = kwargs["json"]
                body = None
                headers: dict[str, str] = {}
            else:
                body = kwargs["content"]
                wire_json = json.loads(body)
                headers = kwargs["headers"]
            calls.append(
                {
                    "url": url,
                    "body": body,
                    "json": wire_json,
                    "headers": headers,
                }
            )
            result = responses[min(index, len(responses) - 1)]
            if isinstance(result, BaseException):
                raise result
            return result

    monkeypatch.setattr(builder_events.httpx, "Client", lambda **_kwargs: _Client())
    monkeypatch.setattr(builder_events.time, "sleep", lambda *_args: None)
    monkeypatch.setattr(builder_events, "_gateway_url", lambda: "http://gateway.test")
    monkeypatch.setattr(builder_events, "_warn_if_misconfigured", lambda _payload: None)
    return calls


def _quality_webhook_payload() -> dict[str, object]:
    return {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "builder-run",
        "builder_trace_root_run_id": "builder-trace-root",
        "user_id": "canary-user",
        "status": "success",
        "task_type": "presentation",
        "task_brief": "Prohibited user-visible content",
        "trace_id": "prohibited-companion-trace",
        "artifact_path": "mnt/user-data/outputs/deck.pptx",
        "artifact_url": "https://signed.example/private",
        "artifact_title": "Prohibited title",
        "artifact_filename": "prohibited.pptx",
        "artifact_files": [{"path": "prohibited"}],
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_is_fallback": False,
        "storage_provider": "supabase",
        "storage_status": "available",
        "storage_object_path": "artifacts/canary-user/parent-thread/deck.pptx",
        "artifact_sha256": "f" * 64,
        "manifest_revision": 1,
        "deck_build_id": "build-1",
        "logical_artifact_id": "logical-1",
        "current_artifact_version_id": "version-1",
        "mechanical_gate_results": {"passed": True, "diagnostics": "prohibited"},
        "source_retention_report": {"source": "prohibited"},
        "native_contrast_report": {"diagnostics": "prohibited"},
        "creative_plan_path": "/mnt/user-data/outputs/private-plan.json",
        "builder_failure_diagnostics": {"details": "prohibited"},
        "summary": "prohibited",
        "error_message": "prohibited",
        "deck_quality_publication_intent": {
            "quality_run_id": _QUALITY_RUN_ID,
        },
    }


def _quality_ack(*, state: str = "requested", quality_run_id: str = _QUALITY_RUN_ID) -> dict[str, object]:
    return {
        "deck_quality_publication_ack": {
            "schema_version": "deck-quality-publication-ack/v1",
            "quality_run_id": quality_run_id,
            "state": state,
        },
    }


def _quality_handoff(
    callback: Callable[[], None],
) -> Callable[[], tuple[dict[str, Any], Callable[[], None]]]:
    return lambda: (_quality_webhook_payload(), callback)


@pytest.mark.parametrize("ack_state", ["requested", "reconciled"])
def test_post_webhook_continues_only_after_exact_durable_ack(
    monkeypatch: pytest.MonkeyPatch,
    ack_state: str,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [
            _WebhookResponse(202, {"delivered_subscribers": 1}),
            _WebhookResponse(202, _quality_ack(state=ack_state)),
        ],
    )
    callback_observations: list[int] = []

    builder_events._post_webhook(
        _quality_webhook_payload(),
        _quality_handoff(lambda: callback_observations.append(len(calls))),
    )

    assert len(calls) == 2
    assert callback_observations == [2]
    assert calls[0]["url"] == "http://gateway.test/internal/builder-events"
    assert calls[1]["url"] == ("http://gateway.test/internal/deck-quality-publications")
    delivery = calls[0]["json"]
    publication = calls[1]["json"]
    assert isinstance(delivery, dict)
    assert isinstance(publication, dict)
    assert "deck_quality_publication_intent" not in delivery
    assert publication["mechanical_gate_results"] == {"passed": True}
    for prohibited in (
        "task_brief",
        "artifact_url",
        "artifact_title",
        "artifact_filename",
        "artifact_files",
        "source_retention_report",
        "native_contrast_report",
        "creative_plan_path",
        "builder_failure_diagnostics",
        "trace_id",
        "summary",
        "error_message",
    ):
        assert prohibited not in publication
    assert calls[0]["headers"] == {}
    assert calls[1]["headers"]["X-Sophia-Builder-Nonce"]


def test_post_webhook_retries_5xx_but_continues_once_on_later_exact_ack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [
            _WebhookResponse(202, {"delivered_subscribers": 1}),
            _WebhookResponse(503, _quality_ack()),
            _WebhookResponse(202, _quality_ack()),
        ],
    )
    callback = MagicMock()

    builder_events._post_webhook(
        _quality_webhook_payload(),
        _quality_handoff(callback),
    )

    assert len(calls) == 3
    assert calls[0]["url"].endswith("/internal/builder-events")
    assert all(call["url"].endswith("/internal/deck-quality-publications") for call in calls[1:])
    assert len(
        {
            call["headers"]["X-Sophia-Builder-Nonce"]
            for call in calls[1:]
        }
    ) == 2
    callback.assert_called_once_with()


@pytest.mark.parametrize(
    "body",
    [
        {"delivered_subscribers": 1},
        _quality_ack(quality_run_id=f"quality_{'b' * 64}"),
        _quality_ack(state="completed"),
        {
            **_quality_ack(),
            "deck_quality_publication_ack": {
                **_quality_ack()["deck_quality_publication_ack"],
                "extra": True,
            },
        },
        ValueError("not JSON"),
    ],
    ids=["legacy", "run-mismatch", "invalid-state", "extra-ack-field", "non-json"],
)
def test_publication_retries_legacy_mismatched_or_invalid_ack(
    monkeypatch: pytest.MonkeyPatch,
    body: object,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [
            _WebhookResponse(202, {"delivered_subscribers": 1}),
            *[_WebhookResponse(202, body) for _ in range(4)],
        ],
    )
    callback = MagicMock()

    builder_events._post_webhook(
        _quality_webhook_payload(),
        _quality_handoff(callback),
    )

    assert len(calls) == 5
    callback.assert_not_called()


@pytest.mark.parametrize(
    ("responses", "expected_calls"),
    [
        ([_WebhookResponse(400, _quality_ack())], 2),
        ([_WebhookResponse(302, _quality_ack())], 2),
        ([_WebhookResponse(503, _quality_ack())] * 4, 5),
    ],
    ids=["4xx", "redirect", "exhausted-5xx"],
)
def test_post_webhook_never_continues_without_a_2xx_exact_ack(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[_WebhookResponse],
    expected_calls: int,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(202, {"delivered_subscribers": 1}), *responses],
    )
    callback = MagicMock()

    builder_events._post_webhook(
        _quality_webhook_payload(),
        _quality_handoff(callback),
    )

    assert len(calls) == expected_calls
    callback.assert_not_called()


def test_publication_response_loss_retries_without_replaying_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [
            _WebhookResponse(202, {"delivered_subscribers": 1}),
            httpx.ReadError("response lost"),
            _WebhookResponse(202, _quality_ack(state="reconciled")),
        ],
    )
    callback = MagicMock()

    builder_events._post_webhook(
        _quality_webhook_payload(),
        _quality_handoff(callback),
    )

    assert len(calls) == 3
    assert sum(call["url"].endswith("/internal/builder-events") for call in calls) == 1
    assert sum(call["url"].endswith("/internal/deck-quality-publications") for call in calls) == 2
    callback.assert_called_once_with()


def test_ordinary_delivery_never_calls_publication_endpoint_or_source_capture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _quality_webhook_payload()
    payload.pop("deck_quality_publication_intent")
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(202, {"delivered_subscribers": 1})],
    )

    handoff = MagicMock(return_value=(payload, None))
    with patch("deerflow.sophia.deck_quality.publisher.capture_deck_quality_source_pack") as capture:
        builder_events._post_webhook(
            payload,
            handoff,
        )

    assert len(calls) == 1
    assert calls[0]["url"].endswith("/internal/builder-events")
    handoff.assert_called_once_with()
    capture.assert_not_called()


def test_quality_preparation_never_runs_before_successful_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _quality_webhook_payload()
    payload.pop("deck_quality_publication_intent")
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(503, {})] * 4,
    )
    handoff = MagicMock()

    builder_events._post_webhook(payload, handoff)

    assert len(calls) == 4
    assert all(call["url"].endswith("/internal/builder-events") for call in calls)
    assert all(call["headers"] == {} for call in calls)
    handoff.assert_not_called()


def test_quality_ack_callback_calls_exact_publisher_continuation() -> None:
    prepared = object()
    intent = object()
    instrument = object()

    with patch("deerflow.sophia.deck_quality.publisher.complete_deck_quality_publication_after_ack") as complete:
        callback = builder_events._deck_quality_publication_ack_callback(
            prepared=prepared,
            intent=intent,
            instrument=instrument,
        )
        complete.assert_not_called()
        callback()

    complete.assert_called_once_with(
        prepared=prepared,
        intent=intent,
        instrument=instrument,
    )


def test_quality_handoff_snapshot_is_selective_and_stable() -> None:
    state = {
        "thread_data": {"outputs_path": "/tmp/original"},
        "messages": [{"content": "must not be captured"}],
    }
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "mechanical_gate_results": {
            "passed": True,
            "issues": [{"code": "original"}],
        },
        "source_retention_report": {"items": [{"path": "original"}]},
        "unrelated_private_field": "must not be captured",
    }
    completion = {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "task_brief": "bounded brief",
        "artifact_path": "mnt/user-data/outputs/deck.pptx",
        "summary": "must not be captured",
    }

    state_snapshot, artifact_snapshot, completion_snapshot = (
        builder_events._snapshot_deck_quality_handoff_inputs(
            state=state,
            artifact=artifact,
            completion_payload=completion,
        )
    )
    state["thread_data"]["outputs_path"] = "/tmp/mutated"
    artifact["mechanical_gate_results"]["issues"][0]["code"] = "mutated"
    artifact["source_retention_report"]["items"][0]["path"] = "mutated"
    completion["task_brief"] = "mutated"

    assert state_snapshot == {"thread_data": {"outputs_path": "/tmp/original"}}
    assert "messages" not in state_snapshot
    assert artifact_snapshot["mechanical_gate_results"]["issues"] == [
        {"code": "original"}
    ]
    assert artifact_snapshot["source_retention_report"]["items"] == [
        {"path": "original"}
    ]
    assert "unrelated_private_field" not in artifact_snapshot
    assert completion_snapshot["task_brief"] == "bounded brief"
    assert "summary" not in completion_snapshot


def test_quality_snapshot_failure_still_schedules_baseline_delivery() -> None:
    runtime = _make_runtime(builder_thread_id="dq1-snapshot-isolation")
    thread = MagicMock()

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", return_value=thread) as thread_cls,
        patch.object(
            builder_events,
            "_snapshot_deck_quality_handoff_inputs",
            side_effect=RuntimeError("snapshot failed"),
        ),
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=_make_state(),
            runtime=runtime,
            artifact=_success_artifact(),
            status="completed",
        )

    assert result is True
    thread.start.assert_called_once_with()
    assert (
        thread_cls.call_args.kwargs["kwargs"][
            "prepare_deck_quality_publication_handoff"
        ]
        is None
    )


def test_exact_canary_is_prepared_only_after_detached_delivery_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _make_runtime(
        builder_thread_id="dq1-canary",
        builder_run_id="run-1",
    )
    state = _make_state()
    config = object()
    prepared = object()
    instrument = object()
    intent_wire = {
        "schema_version": "deck-quality-publication-intent/v1",
        "quality_run_id": _QUALITY_RUN_ID,
    }
    intent = SimpleNamespace(model_dump=lambda **_kwargs: intent_wire)
    callback = MagicMock()
    order: list[str] = []
    threads: list[object] = []
    calls = _install_webhook_responses(
        monkeypatch,
        [
            _WebhookResponse(202, {"delivered_subscribers": 1}),
            _WebhookResponse(202, _quality_ack()),
        ],
    )

    class _DetachedThread:
        def __init__(self, **kwargs) -> None:
            order.append("thread-init")
            self.kwargs = kwargs
            threads.append(self)

        def start(self) -> None:
            order.append("thread-start")
            self.kwargs["target"](
                *self.kwargs.get("args", ()),
                **self.kwargs.get("kwargs", {}),
            )

    def prepare(**_kwargs):
        assert len(calls) == 1
        assert calls[0]["url"].endswith("/internal/builder-events")
        order.append("prepare")
        return prepared

    def compile_instrument(_config):
        order.append("compile")
        return instrument

    def build_intent(**_kwargs):
        order.append("build-intent")
        return intent

    def build_callback(**_kwargs):
        order.append("build-callback")
        return callback

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", _DetachedThread),
        patch.object(
            builder_events,
            "_deck_quality_publication_ack_callback",
            side_effect=build_callback,
        ),
        patch("deerflow.config.app_config.get_app_config", return_value=config),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            side_effect=prepare,
        ),
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            side_effect=compile_instrument,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.build_deck_quality_publication_intent",
            side_effect=build_intent,
        ),
        patch("deerflow.sophia.deck_quality.publisher.capture_deck_quality_source_pack") as capture,
        patch("deerflow.sophia.deck_quality.publisher.complete_deck_quality_publication_after_ack") as complete,
    ):

        async def invoke_from_active_event_loop() -> bool:
            assert asyncio.get_running_loop().is_running()
            return builder_events.fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=_success_artifact(),
                status="completed",
            )

        result = asyncio.run(invoke_from_active_event_loop())

    assert result is True
    assert order == [
        "thread-init",
        "thread-start",
        "prepare",
        "compile",
        "build-intent",
        "build-callback",
    ]
    assert len(threads) == 1
    thread_kwargs = threads[0].kwargs
    assert thread_kwargs["target"] is builder_events._post_webhook
    assert thread_kwargs["daemon"] is True
    assert "deck_quality_publication_intent" not in thread_kwargs["args"][0]
    assert callable(
        thread_kwargs["kwargs"]["prepare_deck_quality_publication_handoff"]
    )
    assert len(calls) == 2
    assert calls[0]["headers"] == {}
    assert calls[1]["headers"]["X-Sophia-Builder-Signature"].startswith("v1=")
    callback.assert_called_once_with()
    capture.assert_not_called()
    complete.assert_not_called()


@pytest.mark.parametrize(
    "quality",
    [
        SimpleNamespace(
            enabled=False,
            mode="off",
            scope="canary",
            canary_user_ids=frozenset(),
        ),
        SimpleNamespace(
            enabled=True,
            mode="shadow",
            scope="canary",
            canary_user_ids=frozenset({"another-user"}),
        ),
        SimpleNamespace(
            enabled=True,
            mode="shadow",
            scope="canary",
            canary_user_ids=frozenset({"alice"}),
        ),
    ],
    ids=["disabled", "noncanary", "ineligible-artifact"],
)
def test_ordinary_paths_do_no_quality_compilation_callback_or_source_reads(
    quality: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _make_runtime(builder_thread_id=f"ordinary-{quality.mode}-{len(quality.canary_user_ids)}")
    state = _make_state()
    thread = MagicMock()
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(202, {"delivered_subscribers": 1})],
    )

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", return_value=thread) as thread_cls,
        patch(
            "deerflow.config.app_config.get_app_config",
            return_value=SimpleNamespace(deck_quality=quality),
        ),
        patch("deerflow.sophia.deck_quality.instrument.compile_runtime_instrument") as compile_instrument,
        patch.object(builder_events, "_deck_quality_publication_ack_callback") as callback_factory,
        patch("deerflow.sophia.deck_quality.publisher.capture_deck_quality_source_pack") as capture,
        patch("deerflow.sophia.deck_quality.publisher.complete_deck_quality_publication_after_ack") as complete,
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=_success_artifact(),
            status="completed",
        )
        detached = thread_cls.call_args.kwargs
        detached["target"](*detached["args"], **detached["kwargs"])

    assert result is True
    thread_cls.assert_called_once()
    thread.start.assert_called_once_with()
    dispatched = thread_cls.call_args.kwargs["args"][0]
    assert "deck_quality_publication_intent" not in dispatched
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/internal/builder-events")
    compile_instrument.assert_not_called()
    callback_factory.assert_not_called()
    capture.assert_not_called()
    complete.assert_not_called()


def test_quality_intent_preparation_failure_cannot_change_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _make_runtime(
        builder_thread_id="dq1-isolation",
        builder_run_id="run-1",
    )
    state = _make_state()
    thread = MagicMock()
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(202, {"delivered_subscribers": 1})],
    )

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", return_value=thread) as thread_cls,
        patch("deerflow.config.app_config.get_app_config", return_value=object()),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            side_effect=RuntimeError("isolated quality failure"),
        ),
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=_success_artifact(),
            status="completed",
        )
        detached = thread_cls.call_args.kwargs
        detached["target"](*detached["args"], **detached["kwargs"])

    assert result is True
    thread.start.assert_called_once_with()
    dispatched = thread_cls.call_args.kwargs["args"][0]
    assert dispatched["status"] == "success"
    assert "deck_quality_publication_intent" not in dispatched
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/internal/builder-events")


def test_fire_webhook_allows_new_run_on_same_task_id():
    """A revised builder run must not be blocked by the stale run's claim."""
    state = _make_state()
    first_runtime = _make_runtime(builder_thread_id="dedup-1", builder_run_id="run-old")
    second_runtime = _make_runtime(builder_thread_id="dedup-1", builder_run_id="run-new")

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/x.md"), patch.object(builder_events, "_post_webhook"):
        first = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=first_runtime,
            artifact=_success_artifact(),
            status="completed",
        )
        second = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=second_runtime,
            artifact=_success_artifact(),
            status="completed",
        )

    assert first is True
    assert second is True


def test_fire_webhook_legacy_without_run_id_still_dedups_by_task_id():
    runtime = _make_runtime(builder_thread_id="dedup-legacy", builder_run_id=None)
    state = _make_state()

    with patch.object(builder_events, "_signed_artifact_url", return_value="https://supabase.test/x.md"), patch.object(builder_events, "_post_webhook"):
        first = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")
        second = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert first is True
    assert second is False


def test_fire_webhook_returns_false_without_thread_id():
    runtime = SimpleNamespace(config={"configurable": {}, "metadata": {}})
    state = _make_state()

    result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is False


def test_fire_webhook_returns_false_for_non_terminal_status():
    runtime = _make_runtime()
    state = _make_state()

    result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="running")

    assert result is False


def test_payload_handles_missing_task_brief():
    """When delegation_context.task is empty, task_brief is None (not a crash)."""
    runtime = _make_runtime()
    state = {"delegation_context": {}, "builder_task": {"task_type": "research"}}

    payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert payload["task_brief"] is None
    assert payload["task_type"] == "research"


def test_payload_handles_missing_state_fields():
    """Defensive: empty state dict should still yield a valid payload."""
    runtime = _make_runtime()

    payload = builder_events.build_completion_payload_from_artifact(state={}, runtime=runtime, artifact=_success_artifact(), status="completed")

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
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

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
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

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
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

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
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert payload["thread_id"] == "legacy-config-thread"
    assert payload["user_id"] == "legacy-user"


# ---------- builder thread_id resolution (context-first / config-fallback) --


def test_fire_webhook_resolves_builder_thread_id_from_context():
    """Production scenario (langgraph-api 0.8.1): builder's own thread_id
    arrives in ``runtime.context["thread_id"]``, NOT in
    ``runtime.config["configurable"]["thread_id"]``. Without context-first
    resolution the webhook silently fails — exactly the bug captured at
    2026-05-06T20:38:18.369682Z in production logs.
    """
    runtime = _make_runtime(
        builder_thread_id="ctx-builder-1",
        builder_thread_id_in_context=True,  # default; spelling out for clarity
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True


def test_fire_webhook_resolves_builder_thread_id_from_config_fallback():
    """Legacy fallback: when context has no thread_id (older langgraph-api
    versions or uncommon dispatch paths), runtime.config.configurable still
    serves as the source of truth.
    """
    runtime = _make_runtime(
        builder_thread_id="cfg-builder-1",
        builder_thread_id_in_context=False,  # only in config
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True


def test_fire_webhook_returns_false_when_thread_id_missing_everywhere():
    """When neither context nor config has thread_id, refuse to dispatch
    (we'd have nowhere to attribute the webhook payload's ``task_id``).
    """
    runtime = _make_runtime(builder_thread_id=None)
    # builder_thread_id=None drops it from BOTH context and config.
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook") as mock_post:
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is False
    mock_post.assert_not_called()


def test_payload_uses_context_thread_id_when_config_lacks_it():
    """``build_completion_payload_from_artifact`` puts the builder's
    thread_id into the payload's ``task_id`` field. Verify it picks
    context first."""
    runtime = _make_runtime(
        builder_thread_id="ctx-builder-2",
        builder_thread_id_in_context=True,
        parent_thread_id="parent-2",
    )
    state = _make_state(parent_thread_id="parent-2", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert payload["task_id"] == "ctx-builder-2"
    assert payload["thread_id"] == "parent-2"


# ---------- execution_info canonical source (Codex bot review on PR #113) ---


def test_resolves_thread_id_from_execution_info_when_only_source():
    """Production-future scenario: only ``runtime.execution_info.thread_id``
    is populated (LangGraph Platform / distributed runtime). Webhook must
    still dispatch.
    """
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="ei-builder-1"),
        context={},
        config={"configurable": {}, "metadata": {}},
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True


def test_execution_info_takes_precedence_over_context_and_config():
    """When all three sources populate thread_id with different values,
    execution_info wins (canonical per langgraph >= 1.0)."""
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="ei-thread"),
        context={"thread_id": "ctx-thread"},
        config={
            "configurable": {"thread_id": "cfg-thread", "parent_thread_id": "parent-1"},
            "metadata": {"trace_id": "trace-1"},
        },
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    # execution_info wins over both fallbacks.
    assert payload["task_id"] == "ei-thread"


def test_falls_back_to_context_when_execution_info_thread_id_is_none():
    """Edge case: ``execution_info`` exists but ``thread_id`` is None
    (no-checkpointer scenario per langgraph docstring). Resolver must
    fall through to the context lookup, not return None prematurely.
    """
    runtime = _make_runtime(
        builder_thread_id="ctx-thread-only",
        builder_thread_id_in_context=True,
        builder_thread_id_in_execution_info=False,  # execution_info.thread_id = None
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True


def test_handles_runtime_without_execution_info_attribute():
    """Defensive: older test stubs (or older langgraph) may not have
    ``execution_info`` at all. Resolver must not crash with AttributeError.
    """
    runtime = _make_runtime(
        builder_thread_id="legacy-stub-thread",
        include_execution_info=False,  # SimpleNamespace lacks the attribute entirely
    )
    state = _make_state(parent_thread_id="parent-1", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True


# ---------- production Runtime-shape regression (line-575 AttributeError) ---


def test_handles_runtime_without_config_attribute_at_all():
    """Production langgraph.runtime.Runtime does NOT expose ``.config``
    directly — that lives on ToolRuntime / RunnableConfig paths. Confirmed
    via 2026-05-06 traceback:

        File ".../sophia/builder_events.py", line 575, in
        build_completion_payload_from_artifact
        AttributeError: 'Runtime' object has no attribute 'config'

    The resolver and payload builder MUST handle this shape gracefully
    using execution_info as the primary source.
    """
    # A runtime that mirrors production langgraph 1.x Runtime: only
    # ``execution_info`` and ``context``; no ``config``, no ``metadata``.
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="prod-builder-thread"),
        context={},
    )
    state = _make_state(parent_thread_id="prod-parent-thread", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        # Payload builder must NOT raise when runtime lacks .config.
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    # Builder thread_id resolved via execution_info.
    assert payload["task_id"] == "prod-builder-thread"
    # parent_thread_id resolved via state (delegation_context).
    assert payload["thread_id"] == "prod-parent-thread"
    assert payload["user_id"] == "alice"
    # trace_id is None when runtime has no .config — that's expected;
    # the webhook payload is still well-formed and dispatchable.
    assert payload["trace_id"] is None


def test_fire_webhook_succeeds_when_runtime_lacks_config_attribute():
    """The end-to-end dispatcher must reach the daemon-thread step even
    when runtime exposes no ``.config`` — the diagnostic log line must
    fire and the dedup gate must claim the task_id.
    """
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="prod-builder-2"),
        context={},
    )
    state = _make_state(parent_thread_id="prod-parent-2", parent_user_id="alice")

    with patch.object(builder_events, "_signed_artifact_url", return_value=None), patch.object(builder_events, "_post_webhook"):
        result = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    assert result is True
    # ``_post_webhook`` is patched out so the daemon thread never POSTs.
    # The dedup contract below proves dispatch advanced past the
    # build_payload step (which is where the AttributeError previously
    # raised).
    second = builder_events.fire_completion_webhook_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")
    assert second is False  # dedup hit confirms the first call wrote to _emitted_task_ids


def test_resolver_handles_runtime_without_config_attribute():
    """``_resolve_runtime_thread_id`` is the load-bearing helper. Direct
    test that it returns the execution_info thread_id when ``.config``
    doesn't exist on the runtime at all (no AttributeError).
    """
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="ei-only"),
        context={},
    )
    assert builder_events._resolve_runtime_thread_id(runtime) == "ei-only"


def test_resolver_handles_runtime_without_config_or_execution_info():
    """Even with neither config nor execution_info, the resolver must
    return None gracefully — never raise AttributeError into the caller."""
    runtime = SimpleNamespace(context={"thread_id": "ctx-only"})
    assert builder_events._resolve_runtime_thread_id(runtime) == "ctx-only"

    bare = SimpleNamespace()
    assert builder_events._resolve_runtime_thread_id(bare) is None


# ---------- Option-B alignment: signed URL uses parent_thread_id ------------


def test_signed_url_uses_parent_thread_id_when_state_has_it():
    """``BuilderArtifactMiddleware.after_model`` uploads the artifact under
    the PARENT thread_id (Option B; restores the pre-migration convention
    where artifacts are conversation-scoped, not build-scoped). The signed
    URL must point to the same path so the user-clickable URL fallback
    works AND the channel-adapter bytes-download path lands at the right
    Supabase key.

    Production traceback (2026-05-06T22:18:16): the bytes-download
    request hit a 400 because the file was at sophia_builder/<builder>/<file>
    but Telegram looked at sophia_builder/<parent>/<file>. Aligning both
    sides to parent_thread_id closes the gap.
    """
    runtime = _make_runtime(builder_thread_id="builder-thread")
    state = _make_state(parent_thread_id="parent-thread", parent_user_id="alice")

    captured_thread_id: list[str | None] = []

    def _spy(thread_id, artifact_path, *, storage_object_path=None, authenticated_user_id=None):
        captured_thread_id.append(thread_id)
        return f"https://supabase.test/{thread_id}/{artifact_path}"

    with patch.object(builder_events, "_signed_artifact_url", side_effect=_spy):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=_success_artifact(), status="completed")

    # _signed_artifact_url called once with parent_thread_id (NOT builder_thread_id).
    assert captured_thread_id == ["parent-thread"]
    # Sanity: the signed URL ends up in the payload.
    assert "parent-thread" in payload["artifact_url"]


def test_signed_url_falls_back_to_builder_thread_id_when_parent_missing():
    """When delegation_context lacks parent_thread_id (legacy / partial
    state), the signed URL falls back to the builder thread_id so we
    don't lose URL delivery entirely."""
    state = {
        "delegation_context": {"task": "x", "task_type": "document"},
        "builder_task": {"task_type": "document"},
    }
    # NB: state has no parent_thread_id; the runtime below intentionally
    # also lacks parent_thread_id in config so the resolver falls all
    # the way through to builder_thread_id.

    captured_thread_id: list[str | None] = []

    def _spy(thread_id, artifact_path, *, storage_object_path=None, authenticated_user_id=None):
        captured_thread_id.append(thread_id)
        return f"https://supabase.test/{thread_id}/{artifact_path}"

    runtime_no_parent_in_cfg = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="builder-only-thread"),
        context={"thread_id": "builder-only-thread"},
        config={"configurable": {}, "metadata": {}},
    )

    with patch.object(builder_events, "_signed_artifact_url", side_effect=_spy):
        builder_events.build_completion_payload_from_artifact(
            state=state,
            runtime=runtime_no_parent_in_cfg,
            artifact=_success_artifact(),
            status="completed",
        )

    # Falls back to builder_thread_id when parent_thread_id is missing
    # everywhere — keeps URL delivery functional even on partial state.
    assert captured_thread_id == ["builder-only-thread"]


def test_signed_url_uses_storage_object_path_when_artifact_has_it():
    runtime = _make_runtime(builder_thread_id="builder-thread")
    state = _make_state(parent_thread_id="parent-thread", parent_user_id="alice")
    artifact = _success_artifact(
        storage_object_path="artifacts/alice/parent-thread/artifact_123/report.md",
        storage_provider="supabase",
    )

    captured: list[tuple[str | None, str | None, str | None, str | None]] = []

    def _spy(thread_id, artifact_path, *, storage_object_path=None, authenticated_user_id=None):
        captured.append((thread_id, artifact_path, storage_object_path, authenticated_user_id))
        return f"https://supabase.test/signed/{storage_object_path}"

    with patch.object(builder_events, "_signed_artifact_url", side_effect=_spy):
        payload = builder_events.build_completion_payload_from_artifact(state=state, runtime=runtime, artifact=artifact, status="completed")

    assert captured == [
        (
            "parent-thread",
            "foo.md",
            "artifacts/alice/parent-thread/artifact_123/report.md",
            "alice",
        )
    ]
    assert payload["artifact_url"].endswith("/artifacts/alice/parent-thread/artifact_123/report.md")


def test_signed_artifact_url_validates_storage_object_path_before_signing(monkeypatch):
    captured: dict[str, str | None] = {}

    def _create_signed_url(**kwargs):
        captured.update(kwargs)
        return "https://supabase.test/signed/report.md"

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.create_signed_url",
        _create_signed_url,
    )

    url = builder_events._signed_artifact_url(
        "parent-thread",
        "foo.md",
        storage_object_path="artifacts/alice/parent-thread/artifact_123/report.md",
        authenticated_user_id="alice",
    )

    assert url == "https://supabase.test/signed/report.md"
    assert captured["object_path"] == "artifacts/alice/parent-thread/artifact_123/report.md"


def test_signed_url_refuses_internal_storage_object_path(monkeypatch):
    runtime = _make_runtime(builder_thread_id="builder-thread")
    state = _make_state(parent_thread_id="parent-thread", parent_user_id="alice")
    artifact = _success_artifact(
        storage_object_path="parent-thread/ledger/session.jsonl",
        storage_provider="supabase",
    )

    def _create_signed_url(**_kwargs):  # pragma: no cover - must not be reached
        raise AssertionError("internal storage object paths must not be signed")

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.create_signed_url",
        _create_signed_url,
    )

    payload = builder_events.build_completion_payload_from_artifact(
        state=state,
        runtime=runtime,
        artifact=artifact,
        status="completed",
    )

    assert payload["artifact_url"] is None
