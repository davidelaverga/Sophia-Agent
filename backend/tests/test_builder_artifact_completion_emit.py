"""Tests for the native-dispatch builder-completion webhook helpers.

After the Phase-1 async migration, ``BuilderArtifactMiddleware`` fires the
gateway webhook directly (via ``fire_completion_webhook_from_artifact``)
instead of relying on the deleted ``SubagentExecutor``. These tests lock
the wire shape, the dedup, and the phantom-success guard.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

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


def test_exact_canary_primary_is_create_only_public_and_immutable(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    content = b"exact canary pptx bytes"
    (outputs / "deck.pptx").write_bytes(content)
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    creates: list[tuple[str, bytes, str]] = []

    class _ImmutableStore:
        def create_if_absent(self, object_path, stored, *, content_type):
            creates.append((object_path, stored, content_type))
            return "created"

        def read_bounded(self, *_args, **_kwargs):  # pragma: no cover - must not run
            raise AssertionError("an acknowledged create must not re-read the PPTX")

    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        _ImmutableStore,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda *_args, **_kwargs: pytest.fail("canary primary must not use upsert"),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: True,
    )
    artifact = _quality_artifact(user_id="alice")
    for key in ("storage_provider", "storage_status", "storage_object_path", "artifact_sha256"):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    artifact_sha256 = hashlib.sha256(content).hexdigest()
    version_digest = hashlib.sha256(b"version-1").hexdigest()
    expected_path = (
        "artifacts/alice/thread-1/logical-1/versions/"
        f"{version_digest}/{artifact_sha256}/deck.pptx"
    )
    assert result == "uploaded"
    assert creates == [
        (
            expected_path,
            content,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
    ]
    assert artifact["storage_object_path"] == expected_path
    assert artifact["artifact_sha256"] == artifact_sha256
    assert "/.builder/" not in expected_path


def test_exact_canary_primary_reconciles_create_response_loss(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    content = b"exact canary pptx bytes"
    (outputs / "deck.pptx").write_bytes(content)
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    reads: list[tuple[str, int]] = []

    class _ResponseLostStore:
        def create_if_absent(self, *_args, **_kwargs):
            raise RuntimeError("synthetic response loss after commit")

        def read_bounded(self, object_path, *, max_bytes):
            reads.append((object_path, max_bytes))
            return content

    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        _ResponseLostStore,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda *_args, **_kwargs: pytest.fail("canary primary must not use upsert"),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: True,
    )
    artifact = _quality_artifact(user_id="alice")
    for key in ("storage_provider", "storage_status", "storage_object_path", "artifact_sha256"):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "uploaded"
    assert reads == [(artifact["storage_object_path"], len(content))]


def test_exact_canary_primary_conflict_fails_without_storage_metadata(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"exact canary pptx bytes")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")

    class _ConflictStore:
        def create_if_absent(self, *_args, **_kwargs):
            return "exists"

        def read_bounded(self, *_args, **_kwargs):
            return b"different bytes at immutable key"

    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        _ConflictStore,
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: pytest.fail("conflicting bytes cannot be acknowledged"),
    )
    artifact = _quality_artifact(user_id="alice")
    for key in ("storage_provider", "storage_status", "storage_object_path", "artifact_sha256"):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "required_verify_failed"
    assert "storage_object_path" not in artifact
    assert "artifact_sha256" not in artifact


@pytest.mark.parametrize(
    "invalid_identity_field",
    ["deck_build_id", "logical_artifact_id", "current_artifact_version_id"],
)
def test_exact_canary_invalid_immutable_identity_never_falls_back_to_upsert(
    tmp_path,
    monkeypatch,
    invalid_identity_field,
):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"exact canary pptx bytes")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        lambda: pytest.fail("invalid immutable identity must not construct storage"),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda *_args, **_kwargs: pytest.fail(
            "invalid exact canary must not use mutable upsert"
        ),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: pytest.fail("invalid exact canary has no uploaded object"),
    )
    artifact = _quality_artifact(user_id="alice")
    artifact.pop(invalid_identity_field)
    for key in (
        "storage_provider",
        "storage_status",
        "storage_object_path",
        "artifact_sha256",
    ):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "required_immutable_identity_invalid"
    assert "storage_object_path" not in artifact
    assert "artifact_sha256" not in artifact


def test_candidate_shaped_primary_fails_closed_when_dq_config_is_unavailable(
    tmp_path,
    monkeypatch,
):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"candidate-shaped pptx bytes")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: (_ for _ in ()).throw(RuntimeError("synthetic config failure")),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        lambda: pytest.fail("unroutable candidate must not construct storage"),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda *_args, **_kwargs: pytest.fail(
            "unroutable candidate must not use mutable upsert"
        ),
    )
    artifact = _quality_artifact(user_id="alice")
    for key in (
        "storage_provider",
        "storage_status",
        "storage_object_path",
        "artifact_sha256",
    ):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "required_immutable_identity_invalid"
    assert "storage_object_path" not in artifact
    assert "artifact_sha256" not in artifact


def test_exact_canary_path_construction_failure_never_escapes_or_upserts(
    tmp_path,
    monkeypatch,
):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"exact canary pptx bytes")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(),
    )
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.publisher.deck_quality_immutable_artifact_snapshot_path",
        lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("synthetic immutable path failure")
        ),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        lambda: pytest.fail("invalid immutable path must not construct storage"),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "upload_artifact_object",
        lambda *_args, **_kwargs: pytest.fail(
            "invalid immutable path must not use mutable upsert"
        ),
    )
    artifact = _quality_artifact(user_id="alice")
    for key in (
        "storage_provider",
        "storage_status",
        "storage_object_path",
        "artifact_sha256",
    ):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "required_immutable_identity_invalid"
    assert "storage_object_path" not in artifact
    assert "artifact_sha256" not in artifact


def test_noncanary_presentation_keeps_ordinary_upsert_and_no_dq_store_reads(
    tmp_path,
    monkeypatch,
):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    content = b"ordinary pptx bytes"
    (outputs / "deck.pptx").write_bytes(content)
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-placeholder")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    uploaded: list[tuple[str, bytes]] = []
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _quality_config(canary_user_ids=frozenset({"canary-only"})),
    )
    monkeypatch.setattr(
        builder_artifact_module.supabase_artifact_store,
        "SupabaseImmutableObjectStore",
        lambda: pytest.fail("ordinary users must not construct the DQ object store"),
    )

    def upload_object(object_path, stored, **_kwargs):
        uploaded.append((object_path, stored))
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
    artifact = _quality_artifact(user_id="alice")
    for key in (
        "deck_build_id",
        "logical_artifact_id",
        "current_artifact_version_id",
    ):
        artifact.pop(key, None)
    for key in ("storage_provider", "storage_status", "storage_object_path", "artifact_sha256"):
        artifact.pop(key, None)

    result = builder_artifact_module._upload_builder_outputs_to_supabase(
        thread_id="thread-1",
        outputs_host_path=str(outputs),
        artifact_args=artifact,
    )

    assert result == "uploaded"
    assert uploaded == [(artifact["storage_object_path"], content)]
    assert "/versions/" not in artifact["storage_object_path"]
    assert f"/{artifact['artifact_id']}/deck.pptx" in artifact["storage_object_path"]


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
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.text = "response"


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
            calls.append({"url": url, **kwargs})
            result = responses[min(len(calls) - 1, len(responses) - 1)]
            if isinstance(result, BaseException):
                raise result
            return result

    class _AsyncClient:
        def __init__(self, **_kwargs) -> None:
            pass

        async def post(self, url: str, **kwargs):
            calls.append({"url": url, **kwargs})
            result = responses[min(len(calls) - 1, len(responses) - 1)]
            if isinstance(result, BaseException):
                raise result
            return result

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(builder_events.httpx, "Client", lambda **_kwargs: _Client())
    monkeypatch.setattr(builder_events.httpx, "AsyncClient", _AsyncClient)
    monkeypatch.setattr(builder_events.time, "sleep", lambda *_args: None)
    monkeypatch.setattr(builder_events, "_gateway_url", lambda: "http://gateway.test")
    monkeypatch.setattr(builder_events, "_warn_if_misconfigured", lambda _payload: None)
    return calls


def _quality_config(
    *,
    enabled: bool = True,
    canary_user_ids: frozenset[str] = frozenset({"alice"}),
) -> SimpleNamespace:
    return SimpleNamespace(
        deck_quality=SimpleNamespace(
            enabled=enabled,
            mode="shadow" if enabled else "off",
            scope="canary",
            canary_user_ids=canary_user_ids,
        )
    )


def _quality_state() -> dict:
    state = _make_state(
        task_brief="Build the fixed DQ-1 presentation canary.",
        task_type="presentation",
    )
    state["thread_data"] = {"outputs_path": "/mnt/user-data/outputs"}
    return state


def _quality_artifact(**overrides) -> dict:
    artifact = _success_artifact(
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_type="presentation",
        artifact_ext="pptx",
        artifact_is_fallback=False,
        storage_provider="supabase",
        storage_status="available",
        storage_object_path="artifacts/alice/thread-companion-1/deck.pptx",
        artifact_sha256="f" * 64,
        manifest_revision=1,
        deck_build_id="build-1",
        logical_artifact_id="logical-1",
        current_artifact_version_id="version-1",
        builder_trace_root_run_id="builder-trace-root",
        mechanical_gate_results={"passed": True},
    )
    artifact.update(overrides)
    return artifact


def _quality_completion_payload(**overrides) -> dict[str, object]:
    payload: dict[str, object] = {
        "thread_id": "thread-companion-1",
        "task_id": "builder-task",
        "run_id": "builder-run",
        "builder_trace_root_run_id": "builder-trace-root",
        "user_id": "alice",
        "status": "success",
        "task_type": "presentation",
        "task_brief": "Build the fixed DQ-1 presentation canary.",
    }
    payload.update(overrides)
    return payload


def _quality_receipt() -> SimpleNamespace:
    return SimpleNamespace(
        quality_run_id=_QUALITY_RUN_ID,
        bundle_object_path=f"dq1/producer/v1/{_QUALITY_RUN_ID}/bundle.bin",
        bundle_hash="e" * 64,
        bundle_size_bytes=4096,
    )


def _quality_intent() -> SimpleNamespace:
    return SimpleNamespace(quality_run_id=_QUALITY_RUN_ID)


def test_exact_canary_is_durable_before_thread_start_and_only_posts_baseline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _quality_state()
    artifact = _quality_artifact()
    state_before = copy.deepcopy(state)
    artifact_before = copy.deepcopy(artifact)
    prepared = object()
    instrument = object()
    order: list[str] = []
    threads: list[object] = []
    calls = _install_webhook_responses(monkeypatch, [_WebhookResponse(202)])
    post_webhook = builder_events._post_webhook

    class _SynchronousThread:
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

    def derive(**_kwargs):
        order.append("derive")
        return "d" * 64

    def prepare(**_kwargs):
        order.append("prepare")
        return prepared

    def compile_instrument(_config):
        order.append("compile")
        return instrument

    def build_intent(**_kwargs):
        order.append("intent")
        return _quality_intent()

    def persist(**_kwargs):
        order.append("persist-complete")
        return _quality_receipt()

    def post(payload):
        order.append("post")
        post_webhook(payload)

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", _SynchronousThread),
        patch.object(builder_events, "_post_webhook", side_effect=post) as posted,
        patch("deerflow.config.app_config.get_app_config", return_value=_quality_config()),
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
            side_effect=derive,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            side_effect=prepare,
        ),
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            side_effect=compile_instrument,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.build_deck_quality_producer_intent",
            side_effect=build_intent,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle",
            side_effect=persist,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure"
        ) as persist_failure,
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            artifact=artifact,
            status="completed",
        )

    assert result is True
    assert order == [
        "derive",
        "prepare",
        "compile",
        "intent",
        "persist-complete",
        "thread-init",
        "thread-start",
        "post",
    ]
    assert len(threads) == 1
    assert threads[0].kwargs["target"] is posted
    delivery_payload = threads[0].kwargs["args"][0]
    assert calls == [
        {
            "url": "http://gateway.test/internal/builder-events",
            "json": delivery_payload,
        }
    ]
    assert "deck_quality_publication_intent" not in delivery_payload
    assert state == state_before
    assert artifact == artifact_before
    persist_failure.assert_not_called()


def test_quality_persistence_exception_still_schedules_identical_baseline() -> None:
    baseline = _quality_completion_payload(
        artifact_path="mnt/user-data/outputs/deck.pptx",
        artifact_type="presentation",
        artifact_ext="pptx",
    )
    baseline_before = copy.deepcopy(baseline)
    thread = MagicMock()
    prepared = object()
    instrument = object()
    post = MagicMock()
    order: list[str] = []

    def fail_marker(**_kwargs) -> None:
        order.append("failure-marker")
        raise RuntimeError("storage unavailable")

    def send_signal(**_kwargs) -> bool:
        order.append("failure-signal")
        return True

    def make_thread(**_kwargs):
        order.append("thread-init")
        return thread

    thread.start.side_effect = lambda: order.append("thread-start")

    with (
        patch.object(
            builder_events,
            "build_completion_payload_from_artifact",
            return_value=baseline,
        ),
        patch.object(builder_events.time, "monotonic", return_value=100.0),
        patch.object(
            builder_events.threading,
            "Thread",
            side_effect=make_thread,
        ) as thread_cls,
        patch.object(builder_events, "_post_webhook", post),
        patch("deerflow.config.app_config.get_app_config", return_value=_quality_config()),
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
            return_value="d" * 64,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            return_value=prepared,
        ),
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            return_value=instrument,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.build_deck_quality_producer_intent",
            return_value=_quality_intent(),
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle",
            side_effect=RuntimeError("database unavailable"),
        ) as persist_bundle,
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure",
            side_effect=fail_marker,
        ) as persist_failure,
        patch.object(
            builder_events,
            "_post_deck_quality_producer_failure_signal",
            side_effect=send_signal,
        ) as failure_signal,
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=_quality_state(),
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            artifact=_quality_artifact(),
            status="completed",
        )

    assert result is True
    assert baseline == baseline_before
    assert order == [
        "failure-marker",
        "failure-signal",
        "thread-init",
        "thread-start",
    ]
    assert thread_cls.call_args.kwargs["target"] is post
    assert thread_cls.call_args.kwargs["args"] == (baseline,)
    thread.start.assert_called_once_with()
    persist_bundle.assert_called_once_with(
        prepared=prepared,
        instrument=instrument,
        intent=_quality_intent(),
        deadline=101.15,
    )
    post.assert_not_called()
    persist_failure.assert_called_once_with(
        candidate_digest="d" * 64,
        failure_stage="producer_bundle",
        failure_code="producer_bundle_unavailable",
        quality_run_id=_QUALITY_RUN_ID,
        prepared=prepared,
        instrument=instrument,
        intent=_quality_intent(),
        deadline=101.5,
    )
    failure_signal.assert_called_once()
    signal_arguments = dict(failure_signal.call_args.kwargs)
    deadline = signal_arguments.pop("deadline")
    assert deadline == 102.0
    assert signal_arguments == {
        "candidate_digest": "d" * 64,
        "user_id": "alice",
        "failure_stage": "producer_bundle",
        "upstream_failure_code": "producer_bundle_unavailable",
        "quality_run_id": _QUALITY_RUN_ID,
    }


def test_independent_failure_signal_retries_response_loss_with_same_body_new_nonce(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [RuntimeError("response lost"), _WebhookResponse(202)],
    )

    result = builder_events._post_deck_quality_producer_failure_signal(
        candidate_digest="d" * 64,
        user_id="alice",
        failure_stage="producer_bundle",
        upstream_failure_code="producer_bundle_unavailable",
        quality_run_id=_QUALITY_RUN_ID,
    )

    assert result is True
    assert len(calls) == 2
    assert {
        str(call["url"]) for call in calls
    } == {"http://gateway.test/internal/deck-quality-producer-failures"}
    assert calls[0]["content"] == calls[1]["content"]
    first_headers = calls[0]["headers"]
    second_headers = calls[1]["headers"]
    assert isinstance(first_headers, dict)
    assert isinstance(second_headers, dict)
    assert first_headers["X-Sophia-Builder-Nonce"] != (
        second_headers["X-Sophia-Builder-Nonce"]
    )
    decoded = json.loads(calls[0]["content"])
    assert decoded == {
        "campaign_id": "DQ-1",
        "candidate_digest": "d" * 64,
        "failure_code": "shadow_dispatch_unavailable",
        "failure_stage": "producer_bundle",
        "quality_run_id": _QUALITY_RUN_ID,
        "schema_version": "deck-quality-producer-failure-signal/v1",
        "upstream_failure_code": "producer_bundle_unavailable",
        "user_id": "alice",
    }


def test_failure_signal_attempt_timeouts_share_one_absolute_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timeouts: list[float] = []
    attempts = 0

    class _AsyncClient:
        def __init__(self, *, timeout: float) -> None:
            timeouts.append(timeout)

        async def post(self, *_args, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("synthetic response loss")
            await asyncio.sleep(1.0)

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(builder_events.httpx, "AsyncClient", _AsyncClient)
    monkeypatch.setattr(builder_events, "_gateway_url", lambda: "http://gateway.test")
    # Leave enough scheduling margin for a loaded full-suite worker while the
    # second synthetic request still exceeds the single absolute deadline.
    deadline = time.monotonic() + 0.5
    started = time.monotonic()

    result = builder_events._post_deck_quality_producer_failure_signal(
        candidate_digest="d" * 64,
        user_id="alice",
        failure_stage="producer_bundle",
        upstream_failure_code="producer_bundle_unavailable",
        quality_run_id=_QUALITY_RUN_ID,
        deadline=deadline,
    )

    assert result is False
    assert time.monotonic() - started < 0.75
    assert attempts == 2
    assert len(timeouts) == 1
    assert 0 < timeouts[0] <= 0.5


@pytest.mark.parametrize("failure_point", ["constructor", "start"])
def test_preparation_thread_failure_is_signaled_before_delivery(
    failure_point: str,
) -> None:
    delivery = _quality_completion_payload()
    delivery_before = copy.deepcopy(delivery)
    delivery_thread = MagicMock()
    marker_arguments: dict[str, object] = {}
    signal_arguments: dict[str, object] = {}
    order: list[str] = []

    class _FailingPreparationThread:
        def __init__(self, **_kwargs) -> None:
            order.append("preparation-thread-init")
            if failure_point == "constructor":
                raise RuntimeError("preparation thread construction failed")

        def start(self) -> None:
            order.append("preparation-thread-start")
            raise RuntimeError("preparation thread start failed")

    def derive(**_kwargs) -> str:
        order.append("derive")
        return "d" * 64

    def fail_marker(**kwargs) -> None:
        marker_arguments.update(kwargs)
        order.append("failure-marker")
        raise RuntimeError("object store unavailable")

    def persist_signal(**kwargs) -> bool:
        signal_arguments.update(kwargs)
        order.append("failure-signal")
        return True

    def make_delivery_thread(**_kwargs):
        order.append("delivery-thread-init")
        return delivery_thread

    delivery_thread.start.side_effect = lambda: order.append(
        "delivery-thread-start"
    )
    with (
        patch.object(
            builder_events,
            "build_completion_payload_from_artifact",
            return_value=delivery,
        ),
        patch.object(
            builder_events,
            "_READ_ONLY_PREPARATION_THREAD",
            _FailingPreparationThread,
        ),
        patch.object(
            builder_events.threading,
            "Thread",
            side_effect=make_delivery_thread,
        ),
        patch(
            "deerflow.config.app_config.get_app_config",
            return_value=_quality_config(),
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
            side_effect=derive,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication"
        ) as prepare,
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument"
        ) as compile_instrument,
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle"
        ) as persist_bundle,
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure",
            side_effect=fail_marker,
        ),
        patch.object(
            builder_events,
            "_post_deck_quality_producer_failure_signal",
            side_effect=persist_signal,
        ),
        patch.object(builder_events, "_post_webhook", MagicMock()),
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=_quality_state(),
            artifact=_quality_artifact(),
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            status="completed",
        )

    expected_thread_order = ["preparation-thread-init"]
    if failure_point == "start":
        expected_thread_order.append("preparation-thread-start")
    assert result is True
    assert order == [
        "derive",
        *expected_thread_order,
        "failure-marker",
        "failure-signal",
        "delivery-thread-init",
        "delivery-thread-start",
    ]
    marker_deadline = marker_arguments.pop("deadline")
    signal_deadline = signal_arguments.pop("deadline")
    assert isinstance(marker_deadline, float)
    assert isinstance(signal_deadline, float)
    assert marker_deadline < signal_deadline
    assert marker_arguments == {
        "candidate_digest": "d" * 64,
        "failure_stage": "candidate_metadata",
        "failure_code": "candidate_metadata_invalid",
        "quality_run_id": None,
        "prepared": None,
        "instrument": None,
        "intent": None,
    }
    assert signal_arguments == {
        "candidate_digest": "d" * 64,
        "user_id": "alice",
        "failure_stage": "candidate_metadata",
        "upstream_failure_code": "candidate_metadata_invalid",
        "quality_run_id": None,
    }
    assert delivery == delivery_before
    prepare.assert_not_called()
    compile_instrument.assert_not_called()
    persist_bundle.assert_not_called()


def test_stalled_read_only_preparation_delivers_with_content_free_evidence() -> None:
    delivery = _quality_completion_payload()
    delivery_before = copy.deepcopy(delivery)
    preparation_entered = threading.Event()
    release_preparation = threading.Event()
    delivery_started = threading.Event()
    delivery_thread = MagicMock()
    marker_arguments: dict[str, object] = {}
    signal_arguments: dict[str, object] = {}
    order: list[str] = []

    def derive(**_kwargs) -> str:
        order.append("derive")
        return "d" * 64

    def stalled_preparation(**kwargs) -> None:
        order.append("preparation-entered")
        preparation_entered.set()
        release_preparation.wait(timeout=1.0)
        kwargs["progress"].finish()

    def fail_marker(**kwargs):
        marker_arguments.update(kwargs)
        order.append("failure-marker")
        raise RuntimeError("object store unavailable")

    def persist_signal(**kwargs):
        signal_arguments.update(kwargs)
        order.append("failure-signal")
        return True

    def make_delivery_thread(**_kwargs):
        order.append("thread-init")
        return delivery_thread

    def start_delivery() -> None:
        order.append("thread-start")
        delivery_started.set()

    delivery_thread.start.side_effect = start_delivery
    persist_bundle = MagicMock()
    try:
        with (
            patch.object(
                builder_events,
                "_PRODUCER_PREDELIVERY_DEADLINE_SECONDS",
                0.15,
            ),
            patch.object(
                builder_events,
                "_PRODUCER_FAILURE_MARKER_RESERVE_SECONDS",
                0.04,
            ),
            patch.object(
                builder_events,
                "_PRODUCER_FAILURE_SIGNAL_RESERVE_SECONDS",
                0.04,
            ),
            patch.object(
                builder_events,
                "build_completion_payload_from_artifact",
                return_value=delivery,
            ),
            patch.object(
                builder_events.threading,
                "Thread",
                side_effect=make_delivery_thread,
            ),
            patch.object(
                builder_events,
                "_prepare_deck_quality_read_only",
                side_effect=stalled_preparation,
            ),
            patch("deerflow.config.app_config.get_app_config", return_value=_quality_config()),
            patch(
                "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
                side_effect=derive,
            ),
            patch(
                "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            ) as prepare,
            patch(
                "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            ) as compile_instrument,
            patch(
                "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle",
                persist_bundle,
            ),
            patch(
                "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure",
                side_effect=fail_marker,
            ),
            patch.object(
                builder_events,
                "_post_deck_quality_producer_failure_signal",
                side_effect=persist_signal,
            ),
            patch.object(builder_events, "_post_webhook", MagicMock()),
        ):
            started = time.monotonic()
            result = builder_events.fire_completion_webhook_from_artifact(
                state=_quality_state(),
                artifact=_quality_artifact(),
                runtime=_make_runtime(
                    builder_thread_id="builder-task",
                    builder_run_id="builder-run",
                ),
                status="completed",
            )
            elapsed = time.monotonic() - started

        assert result is True
        assert preparation_entered.is_set()
        assert delivery_started.is_set()
        assert elapsed < 0.3
        assert order == [
            "derive",
            "preparation-entered",
            "failure-marker",
            "failure-signal",
            "thread-init",
            "thread-start",
        ]
        marker_deadline = marker_arguments.pop("deadline")
        signal_deadline = signal_arguments.pop("deadline")
        assert isinstance(marker_deadline, float)
        assert isinstance(signal_deadline, float)
        assert marker_deadline < signal_deadline
        assert marker_arguments == {
            "candidate_digest": "d" * 64,
            "failure_stage": "candidate_metadata",
            "failure_code": "candidate_metadata_invalid",
            "quality_run_id": None,
            "prepared": None,
            "instrument": None,
            "intent": None,
        }
        assert signal_arguments == {
            "candidate_digest": "d" * 64,
            "user_id": "alice",
            "failure_stage": "candidate_metadata",
            "upstream_failure_code": "candidate_metadata_invalid",
            "quality_run_id": None,
        }
        assert delivery == delivery_before
        prepare.assert_not_called()
        compile_instrument.assert_not_called()
        persist_bundle.assert_not_called()
    finally:
        release_preparation.set()
    time.sleep(0.02)
    # The abandoned worker owns preparation only; completing it late cannot
    # gain an object-store call after baseline delivery has detached.
    persist_bundle.assert_not_called()


def test_unexpected_quality_boundary_error_still_schedules_baseline() -> None:
    baseline = _quality_completion_payload()
    thread = MagicMock()
    post = MagicMock()
    order: list[str] = []

    def fail_quality(**_kwargs) -> None:
        order.append("producer-attempt")
        raise RuntimeError("unexpected quality boundary error")

    def make_thread(**_kwargs):
        order.append("thread-init")
        return thread

    thread.start.side_effect = lambda: order.append("thread-start")
    with (
        patch.object(
            builder_events,
            "build_completion_payload_from_artifact",
            return_value=baseline,
        ),
        patch.object(
            builder_events,
            "_persist_deck_quality_before_delivery",
            side_effect=fail_quality,
        ),
        patch.object(
            builder_events.threading,
            "Thread",
            side_effect=make_thread,
        ) as thread_cls,
        patch.object(builder_events, "_post_webhook", post),
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=_quality_state(),
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            artifact=_quality_artifact(),
            status="completed",
        )

    assert result is True
    assert order == ["producer-attempt", "thread-init", "thread-start"]
    assert thread_cls.call_args.kwargs["target"] is post
    assert thread_cls.call_args.kwargs["args"] == (baseline,)


@pytest.mark.parametrize(
    ("failure_stage", "failure_code", "expected_quality_run_id"),
    [
        ("candidate_metadata", "candidate_metadata_invalid", None),
        ("instrument", "instrument_invalid", None),
        ("producer_bundle", "producer_bundle_unavailable", _QUALITY_RUN_ID),
    ],
)
def test_every_candidate_failure_is_marked_before_identical_delivery(
    failure_stage: str,
    failure_code: str,
    expected_quality_run_id: str | None,
) -> None:
    delivery = _quality_completion_payload()
    delivery_before = copy.deepcopy(delivery)
    prepared = object()
    instrument = object()
    prepare = MagicMock(
        return_value=None if failure_stage == "candidate_metadata" else prepared
    )
    compile_instrument = MagicMock(return_value=instrument)
    build_intent = MagicMock(return_value=_quality_intent())
    persist_bundle = MagicMock(return_value=_quality_receipt())
    if failure_stage == "instrument":
        compile_instrument.side_effect = RuntimeError("instrument unavailable")
    elif failure_stage == "producer_bundle":
        persist_bundle.side_effect = RuntimeError("bundle unavailable")
    failure = SimpleNamespace(candidate_digest="d" * 64, sha256="c" * 64)
    post = MagicMock()
    thread = MagicMock()
    order: list[str] = []

    def persist_failure_marker(**_kwargs):
        order.append("failure-marker")
        return failure

    def make_delivery_thread(**_kwargs):
        order.append("thread-init")
        return thread

    thread.start.side_effect = lambda: order.append("thread-start")

    with (
        patch.object(
            builder_events,
            "build_completion_payload_from_artifact",
            return_value=delivery,
        ),
        patch.object(
            builder_events.threading,
            "Thread",
            side_effect=make_delivery_thread,
        ) as thread_cls,
        patch("deerflow.config.app_config.get_app_config", return_value=_quality_config()),
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
            return_value="d" * 64,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            prepare,
        ),
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            compile_instrument,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.build_deck_quality_producer_intent",
            build_intent,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle",
            persist_bundle,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure",
            side_effect=persist_failure_marker,
        ) as persist_failure,
        patch.object(
            builder_events,
            "_post_deck_quality_producer_failure_signal",
        ) as failure_signal,
        patch.object(builder_events, "_post_webhook", post),
    ):
        result = builder_events.fire_completion_webhook_from_artifact(
            state=_quality_state(),
            artifact=_quality_artifact(),
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            status="completed",
        )

    assert result is True
    failure_arguments = dict(persist_failure.call_args.kwargs)
    marker_deadline = failure_arguments.pop("deadline")
    assert isinstance(marker_deadline, float)
    assert marker_deadline > 0
    assert failure_arguments == {
        "candidate_digest": "d" * 64,
        "failure_stage": failure_stage,
        "failure_code": failure_code,
        "quality_run_id": expected_quality_run_id,
        "prepared": prepared if failure_stage == "producer_bundle" else None,
        "instrument": (
            instrument if failure_stage == "producer_bundle" else None
        ),
        "intent": (
            _quality_intent()
            if failure_stage == "producer_bundle"
            else None
        ),
    }
    failure_signal.assert_not_called()
    assert order == ["failure-marker", "thread-init", "thread-start"]
    assert thread_cls.call_args.kwargs["target"] is post
    assert thread_cls.call_args.kwargs["args"] == (delivery,)
    post.assert_not_called()
    assert delivery == delivery_before


def test_async_artifact_middleware_keeps_loop_live_during_slow_producer() -> None:
    started = threading.Event()
    release = threading.Event()
    middleware = builder_artifact_module.BuilderArtifactMiddleware()

    def slow_after_model(_state, _runtime) -> dict[str, bool]:
        # Stand in for the sync accepted-artifact path while its bounded DQ-1
        # producer storage call is in progress.
        started.set()
        release.wait(timeout=1.0)
        return {"completed": True}

    async def exercise() -> tuple[dict[str, bool] | None, int]:
        ticks = 0
        ticking = True

        async def ticker() -> None:
            nonlocal ticks
            while ticking:
                ticks += 1
                await asyncio.sleep(0.002)

        ticker_task = asyncio.create_task(ticker())
        middleware_task = asyncio.create_task(
            middleware.aafter_model({}, SimpleNamespace())
        )
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.002)
        await asyncio.sleep(0.03)
        ticking = False
        await ticker_task
        release.set()
        return await middleware_task, ticks

    with patch.object(
        middleware,
        "after_model",
        side_effect=slow_after_model,
    ) as after_model:
        result, ticks = asyncio.run(exercise())

    release.set()
    assert result == {"completed": True}
    assert started.is_set()
    assert ticks >= 5
    after_model.assert_called_once()


@pytest.mark.parametrize(
    ("config", "artifact"),
    [
        (_quality_config(enabled=False), _quality_artifact()),
        (
            _quality_config(canary_user_ids=frozenset({"somebody-else"})),
            _quality_artifact(),
        ),
        (_quality_config(), _quality_artifact(mechanical_gate_results={"passed": False})),
    ],
    ids=["disabled", "noncanary", "ineligible"],
)
def test_non_candidates_do_no_compile_persist_source_or_provider_work(
    config: SimpleNamespace,
    artifact: dict,
) -> None:
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=config),
        patch.object(
            builder_events,
            "_READ_ONLY_PREPARATION_THREAD",
        ) as preparation_thread,
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument"
        ) as compile_instrument,
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest"
        ) as derive,
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication"
        ) as prepare,
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle"
        ) as persist,
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_failure"
        ) as persist_failure,
        patch(
            "deerflow.sophia.deck_quality.publisher.capture_deck_quality_source_pack"
        ) as capture,
        patch(
            "deerflow.sophia.deck_quality.publisher.AsyncSupabaseImmutableObjectStore"
        ) as provider,
        patch.object(
            builder_events,
            "_post_deck_quality_producer_failure_signal",
        ) as failure_signal,
    ):
        result = builder_events._persist_deck_quality_before_delivery(
            state=_quality_state(),
            artifact=artifact,
            completion_payload=_quality_completion_payload(),
        )

    assert result is None
    preparation_thread.assert_not_called()
    compile_instrument.assert_not_called()
    derive.assert_not_called()
    prepare.assert_not_called()
    persist.assert_not_called()
    persist_failure.assert_not_called()
    capture.assert_not_called()
    provider.assert_not_called()
    failure_signal.assert_not_called()


def test_process_style_replay_reconciles_durable_publication_without_dq_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(202), _WebhookResponse(202)],
    )
    prepared = object()
    instrument = object()
    persist = MagicMock(return_value=_quality_receipt())

    class _SynchronousThread:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

        def start(self) -> None:
            self.kwargs["target"](
                *self.kwargs.get("args", ()),
                **self.kwargs.get("kwargs", {}),
            )

    def invoke() -> bool:
        return builder_events.fire_completion_webhook_from_artifact(
            state=_quality_state(),
            runtime=_make_runtime(
                builder_thread_id="builder-task",
                builder_run_id="builder-run",
            ),
            artifact=_quality_artifact(),
            status="completed",
        )

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(builder_events.threading, "Thread", _SynchronousThread),
        patch("deerflow.config.app_config.get_app_config", return_value=_quality_config()),
        patch(
            "deerflow.sophia.deck_quality.publisher.derive_deck_quality_candidate_digest",
            return_value="d" * 64,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.prepare_deck_quality_publication",
            return_value=prepared,
        ),
        patch(
            "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
            return_value=instrument,
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.build_deck_quality_producer_intent",
            return_value=_quality_intent(),
        ),
        patch(
            "deerflow.sophia.deck_quality.publisher.persist_deck_quality_producer_bundle",
            persist,
        ),
    ):
        assert invoke() is True
        # A fresh process has an empty in-memory delivery dedup cache. The
        # durable request is intentionally replayed and reconciles by identity.
        builder_events.reset_for_tests()
        assert invoke() is True

    assert persist.call_count == 2
    assert len(calls) == 2
    assert all(
        call["url"] == "http://gateway.test/internal/builder-events"
        for call in calls
    )
    assert all("deck-quality-publications" not in str(call["url"]) for call in calls)


def test_delivery_retries_never_replay_quality(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_webhook_responses(
        monkeypatch,
        [_WebhookResponse(503), _WebhookResponse(503), _WebhookResponse(202)],
    )
    payload = _quality_completion_payload()

    with patch.object(
        builder_events,
        "_persist_deck_quality_before_delivery",
    ) as persist:
        builder_events._post_webhook(payload)

    persist.assert_not_called()
    assert len(calls) == 3
    assert all(
        call["url"] == "http://gateway.test/internal/builder-events"
        for call in calls
    )
    assert all(call["json"] == payload for call in calls)


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
