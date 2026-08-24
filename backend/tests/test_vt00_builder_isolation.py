from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from langgraph.types import Command
from pydantic import ValidationError

from app.gateway.artifact_registry import (
    ArtifactRegistry,
    ArtifactRegistryFilters,
    ArtifactUpsertRequest,
    builder_completion_upsert_request,
)
from app.gateway.routers import builder_events as gateway_events
from app.gateway.workers.builder_events import (
    get_builder_events_worker,
    install_builder_events_worker,
)
from deerflow.agents.sophia_agent.middlewares.builder_progress import (
    _web_event_context,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    BuilderTaskMiddleware,
)
from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import (
    BuilderMem0RetrievalMiddleware,
)
from deerflow.sophia import builder_events
from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_HMAC_SECRET_ENV,
    encode_builder_event_body,
    reset_builder_event_replay_guard_for_tests,
    signed_builder_event_headers,
)
from deerflow.sophia.observability import builder_trace_metadata
from deerflow.sophia.synthetic_builder import (
    SyntheticBuilderContextError,
    normalize_synthetic_builder_context,
)

_SECRET = "vt00-builder-event-secret-" + "x" * 40
_SYNTHETIC_PROVIDER_EXPIRES_AT = (
    datetime.now(UTC).replace(microsecond=123000) + timedelta(minutes=30)
).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _synthetic_context(
    *,
    run_id: str = "voice-lab-run-1",
    principal_id: str = "voice-lab-principal",
    cleanup_obligation_id: str | None = None,
) -> dict[str, object]:
    retention_anchor_at = datetime.now(UTC).replace(microsecond=0)
    cleanup_obligation_id = cleanup_obligation_id or str(
        UUID(hex=hashlib.sha256(run_id.encode()).hexdigest()[:32], version=4)
    )
    provider_expires_at = (
        retention_anchor_at + timedelta(minutes=30)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "synthetic": True,
        "test_run_id": run_id,
        "principal_id": principal_id,
        "scenario_id": "builder-presentation",
        "scenario_version": "1.0",
        "environment": "production",
        "cleanup_obligation_id": cleanup_obligation_id,
        "provider_expires_at": provider_expires_at,
        "retention_hours": 1,
        "retention_anchor": "builder_task_created_at_provisional",
        "retention_anchor_at": retention_anchor_at.isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z"),
        "retention_expires_at": (
            retention_anchor_at + timedelta(hours=1)
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "deployment_identity": {
            "frontend_deployment_id": "frontend-deploy-1",
            "voice_deployment_id": "voice-deploy-1",
        },
        "capability_token": "must-not-leak",
        "provider_continuation_handle": "must-not-leak",
    }


def _completion_payload(context: dict[str, object]) -> dict[str, object]:
    source_at = str(context["retention_anchor_at"])
    return {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "builder-run",
        "agent_name": "sophia_builder",
        "status": "success",
        "task_type": "document",
        "task_brief": "Create an evidence brief.",
        "artifact_path": "mnt/user-data/outputs/evidence.md",
        "artifact_title": "Evidence brief",
        "artifact_type": "document",
        "artifact_filename": "evidence.md",
        "summary": "Built the evidence brief.",
        "user_id": context["principal_id"],
        "completed_at": datetime.now(UTC).isoformat(),
        "synthetic_test": True,
        "test_run_id": context["test_run_id"],
        "test_principal_id": context["principal_id"],
        "scenario_id": context["scenario_id"],
        "scenario_version": context["scenario_version"],
        "environment": context["environment"],
        "cleanup_obligation_id": context["cleanup_obligation_id"],
        "provider_expires_at": context["provider_expires_at"],
        "retention_hours": context["retention_hours"],
        "retention_anchor": context["retention_anchor"],
        "retention_anchor_at": context["retention_anchor_at"],
        "retention_expires_at": context["retention_expires_at"],
        "deployment_identity": context["deployment_identity"],
        "isolation_status": "isolated",
        "memory_retrieval_excluded": True,
        "memory_learning_excluded": True,
        "ordinary_artifact_publication_excluded": True,
        "ordinary_analytics_excluded": True,
        "deck_quality_publication_excluded": True,
        "langsmith_export_excluded": True,
        "langsmith_trace_status": "trace_unavailable",
        "langsmith_trace_unavailable_reason": "synthetic_isolation_policy",
        "synthetic_builder_join": {
            "schema": "sophia_synthetic_builder_join_v1",
            "test_run_id": context["test_run_id"],
            "scenario_id": context["scenario_id"],
            "scenario_version": context["scenario_version"],
            "operation_id": "operation-001",
            "utterance_id": "utterance-001",
            "provider_input_sequence": 1,
            "tool_call_id": "tool-call-001",
            "effect_id": "effect-001",
            "provider_connection_epoch": 1,
            "relay_correlation_id": "relay-001",
            "tool_name": "start_builder_task",
            "tool_state": "responded",
            "builder_operation_id": "builder-operation-001",
            "parent_thread_id": "parent-thread",
            "task_id": "builder-task",
            "thread_id": "builder-task",
            "run_id": "builder-run",
            "build_id": "builder-operation-001",
            "artifact_id": None,
            "artifact_path_sha256": None,
            "ui_projection_state": None,
            "cancel_count": 0,
            "no_post_cancel_publication": True,
            "source_tool_received_at": source_at,
            "source_backend_accepted_at": source_at,
            "source_tool_response_sent_at": source_at,
            "source_builder_event_id": None,
            "source_builder_event_at": None,
            "source_ui_projected_at": None,
            "scenario_assertions": {
                "artifact_created": False,
                "artifact_visible_current": False,
                "accepted_turn_count": 1,
                "tool_dispatch_count": 1,
                "owned_task_count": 1,
                "stable_task_identity": True,
                "revision_updated_same_task": False,
                "current_behavior_result": False,
                "cancel_request_count": 0,
                "cancel_terminal_settled": False,
                "no_post_cancel_publication": True,
            },
        },
    }


def test_synthetic_builder_rejects_conflicting_identity_authorities() -> None:
    context = _synthetic_context()
    conflicting = {
        **context,
        "test_run_id": "foreign-run",
        "test_principal_id": "foreign-principal",
    }

    with pytest.raises(SyntheticBuilderContextError) as exc_info:
        normalize_synthetic_builder_context(
            {"synthetic_test": context},
            {"configurable": {"synthetic_test": conflicting}},
        )

    assert str(exc_info.value) == (
        "synthetic_builder_identity_conflict:"
        "test_principal_id,test_run_id"
    )


def test_synthetic_builder_rejects_conflicting_deployment_authorities() -> None:
    context = _synthetic_context()
    context["deployment_identity"] = {
        "frontend_sha": "a" * 40,
        "backend_sha": "b" * 40,
        "voice_sha": "c" * 40,
    }

    with pytest.raises(
        SyntheticBuilderContextError,
        match=r"^synthetic_builder_identity_conflict:deployment_identity\.backend_sha$",
    ):
        normalize_synthetic_builder_context(
            {"synthetic_test": context},
            {
                "metadata": {
                    "synthetic": True,
                    "test_run_id": context["test_run_id"],
                    "test_principal_id": context["principal_id"],
                    "scenario_id": context["scenario_id"],
                    "scenario_version": context["scenario_version"],
                    "environment": context["environment"],
                    "expected_deployment": {
                        "frontend": "a" * 40,
                        "backend": "d" * 40,
                        "voice": "c" * 40,
                    },
                }
            },
        )


@pytest.mark.anyio
async def test_synthetic_builder_makes_zero_mem0_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    def _search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("synthetic Builder must never reach Mem0")

    monkeypatch.setattr("deerflow.sophia.mem0_client.search_memories", _search)
    context = _synthetic_context()
    result = await BuilderMem0RetrievalMiddleware().abefore_agent(
        {
            "synthetic_test": context,
            "user_id": context["principal_id"],
            "delegation_context": {"normalized_brief": "Build a brief."},
        },
        runtime=None,
    )

    assert calls == []
    assert result == {
        "injected_memories": [],
        "injected_memory_contents": [],
    }


def test_synthetic_builder_briefing_excludes_ordinary_memory_and_project() -> None:
    context = _synthetic_context()
    result = BuilderTaskMiddleware().before_agent(
        {
            "synthetic_test": context,
            "delegation_context": {
                "task": "Create an isolated evidence brief.",
                "task_type": "document",
                "synthetic_test": context,
                "relevant_memories": ["ordinary-memory-must-not-enter"],
                "companion_artifact": {
                    "title": "ordinary-project-must-not-enter",
                    "path": "/mnt/user-data/outputs/ordinary.md",
                },
                "active_ritual": "ordinary-ritual-must-not-enter",
                "ritual_phase": "ordinary-phase-must-not-enter",
            },
        },
        SimpleNamespace(
            config={"configurable": {"synthetic_test": context}},
        ),
    )

    assert result is not None
    assert result["injected_memories"] == []
    assert result["injected_memory_contents"] == []
    rendered = repr(result["system_prompt_blocks"])
    assert "ordinary-memory-must-not-enter" not in rendered
    assert "ordinary-project-must-not-enter" not in rendered
    assert "ordinary-ritual-must-not-enter" not in rendered
    assert "ordinary-phase-must-not-enter" not in rendered


def test_synthetic_metadata_propagates_completion_progress_task_and_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _synthetic_context()
    state = {
        "synthetic_test": context,
        "delegation_context": {
            "task": "Create an evidence brief.",
            "task_type": "document",
            "parent_thread_id": "parent-thread",
            "parent_user_id": context["principal_id"],
            "synthetic_test": context,
        },
        "builder_task": {"task_type": "document"},
    }
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(
            thread_id="builder-task",
            run_id="builder-run",
        ),
        context={"thread_id": "builder-task"},
        config={
            "configurable": {
                "thread_id": "builder-task",
                "parent_thread_id": "parent-thread",
                "user_id": context["principal_id"],
                "synthetic_test": context,
            },
            "metadata": {},
        },
    )
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/evidence.md",
        "artifact_title": "Evidence brief",
        "artifact_type": "document",
        "confidence": 0.9,
        "companion_summary": "Built the evidence brief.",
    }

    with patch.object(builder_events, "_signed_artifact_url", return_value=None):
        completion = builder_events.build_completion_payload_from_artifact(
            state=state,
            runtime=runtime,
            artifact=artifact,
            status="completed",
        )
    progress, _sequence = _web_event_context(state)
    existing_task = {
        "task_id": "builder-task",
        "status": "running",
        "description": "Initial description must survive.",
        "synthetic_test": context,
    }
    merged_task = gateway_events._merge_terminal_async_task(
        existing_task,
        completion,
    )
    monkeypatch.setenv("RENDER_GIT_COMMIT", "a" * 40)
    trace = builder_trace_metadata(config=runtime.config)

    for projection in (completion, progress, merged_task, merged_task["builder_result"]):
        assert projection["synthetic_test"]
        assert projection["test_run_id"] == context["test_run_id"]
        assert projection["test_principal_id"] == context["principal_id"]
        assert projection["ordinary_analytics_excluded"] is True
        assert projection["deck_quality_publication_excluded"] is True
        assert projection["langsmith_export_excluded"] is True
        assert projection["langsmith_trace_status"] == "trace_unavailable"
        assert (
            projection["langsmith_trace_unavailable_reason"]
            == "synthetic_isolation_policy"
        )
    assert merged_task["description"] == "Initial description must survive."
    assert merged_task["synthetic_test"]["synthetic"] is True
    assert gateway_events._should_persist_last_builder_artifact(completion) is False
    assert trace["synthetic_test"] is True
    assert trace["test_run_id"] == context["test_run_id"]
    assert trace["deployment_builder_sha"] == "a" * 40
    assert "must-not-leak" not in repr(trace)


def test_synthetic_completion_skips_deck_quality_producer() -> None:
    context = _synthetic_context()
    state = {
        "synthetic_test": context,
        "delegation_context": {
            "task": "Create a brief.",
            "task_type": "document",
            "parent_thread_id": "parent-thread",
            "parent_user_id": context["principal_id"],
            "synthetic_test": context,
        },
    }
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(thread_id="builder-task", run_id="builder-run"),
        context={"thread_id": "builder-task"},
        config={"configurable": {"synthetic_test": context}, "metadata": {}},
    )
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/evidence.md",
        "artifact_type": "document",
        "artifact_title": "Evidence",
        "confidence": 0.9,
    }
    builder_events.reset_for_tests()

    with (
        patch.object(builder_events, "_signed_artifact_url", return_value=None),
        patch.object(
            builder_events,
            "_persist_deck_quality_before_delivery_off_loop",
        ) as persist_quality,
        patch.object(builder_events.threading, "Thread") as thread,
    ):
        fired = builder_events.fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=artifact,
            status="completed",
        )

    assert fired is True
    persist_quality.assert_not_called()
    thread.assert_called_once()


def _synthetic_upsert(
    *,
    context: dict[str, object],
    task_id: str = "builder-task",
) -> ArtifactUpsertRequest:
    now = datetime.now(UTC)
    return ArtifactUpsertRequest(
        user_id=str(context["principal_id"]),
        thread_id="parent-thread",
        task_id=task_id,
        run_id="builder-run",
        local_path="mnt/user-data/outputs/evidence.md",
        title="Evidence",
        filename="evidence.md",
        artifact_type="document",
        renderer_kind="markdown",
        source="builder",
        storage_provider="local",
        created_at=now.isoformat(),
        synthetic_test=True,
        test_run_id=str(context["test_run_id"]),
        test_principal_id=str(context["principal_id"]),
        scenario_id=str(context["scenario_id"]),
        scenario_version=str(context["scenario_version"]),
        environment=str(context["environment"]),
        cleanup_obligation_id=str(context["cleanup_obligation_id"]),
        provider_expires_at=str(context["provider_expires_at"]),
        retention_hours=int(context["retention_hours"]),
        retention_anchor=str(context["retention_anchor"]),
        retention_anchor_at=str(context["retention_anchor_at"]),
        retention_expires_at=str(context["retention_expires_at"]),
        deployment_identity=dict(context["deployment_identity"]),
        memory_retrieval_excluded=True,
        memory_learning_excluded=True,
        ordinary_artifact_publication_excluded=True,
        ordinary_analytics_excluded=True,
        deck_quality_publication_excluded=True,
    )


def test_synthetic_artifacts_are_hidden_and_exact_run_purge_is_bounded(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = ArtifactRegistry(tmp_path)
    first_context = _synthetic_context(run_id="run-one")
    second_context = _synthetic_context(run_id="run-two")
    first_request = _synthetic_upsert(context=first_context, task_id="task-one")
    first_request.storage_provider = "supabase"
    first_request.storage_bucket = "synthetic-builder-artifacts"
    first_request.storage_object_path = (
        "artifacts/voice-lab-principal/parent-thread/artifact-one/evidence.md"
    )
    first = registry.upsert(
        first_request,
        user_id=str(first_context["principal_id"]),
    )
    second_request = _synthetic_upsert(context=second_context, task_id="task-two")
    second_request.local_path = "mnt/user-data/outputs/second.md"
    second_request.filename = "second.md"
    second = registry.upsert(
        second_request,
        user_id=str(second_context["principal_id"]),
    )

    assert first.is_library_visible is False
    assert registry.list(
        user_id=str(first_context["principal_id"]),
        filters=ArtifactRegistryFilters(include_hidden=True),
    ).artifacts == []
    internal = registry.list(
        user_id=str(first_context["principal_id"]),
        filters=ArtifactRegistryFilters(
            include_hidden=True,
            include_synthetic=True,
        ),
    )
    assert {record.artifact_id for record in internal.artifacts} == {
        first.artifact_id,
        second.artifact_id,
    }

    deleted_objects: list[str] = []

    def _delete_object(path: str) -> str:
        deleted_objects.append(path)
        return "deleted"

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.delete_artifact_object_if_present",
        _delete_object,
    )
    receipt = registry.purge_synthetic_run(
        user_id=str(first_context["principal_id"]),
        test_run_id="run-one",
    )
    assert receipt.cleanup_complete is True
    assert receipt.artifact_records_deleted == 1
    assert receipt.artifact_objects_deleted == 1
    assert deleted_objects == [first_request.storage_object_path]
    assert registry.get(first.artifact_id, user_id=str(first_context["principal_id"])) is None
    assert registry.get(second.artifact_id, user_id=str(first_context["principal_id"])) is not None
    assert registry.purge_synthetic_run(
        user_id=str(first_context["principal_id"]),
        test_run_id="run-one",
    ).cleanup_complete is True


def test_builder_completion_registry_record_is_scoped_and_hidden(tmp_path) -> None:
    context = _synthetic_context()
    parsed = builder_completion_upsert_request(_completion_payload(context))
    assert parsed is not None
    user_id, request = parsed
    record = ArtifactRegistry(tmp_path).upsert(request, user_id=user_id)

    assert record.synthetic_test is True
    assert record.test_run_id == context["test_run_id"]
    assert record.test_principal_id == context["principal_id"]
    assert record.is_library_visible is False
    assert record.memory_retrieval_excluded is True
    assert record.deck_quality_publication_excluded is True


class _FakeRuns:
    def __init__(self) -> None:
        self.status = "running"
        self.cancelled: list[tuple[str, str]] = []

    async def list(self, _task_id: str, *, limit: int):
        assert limit == 100
        return [{"run_id": "builder-run", "status": self.status}]

    async def get(self, _task_id: str, run_id: str):
        return {"run_id": run_id, "status": self.status}

    async def cancel(self, task_id: str, run_id: str, **_kwargs):
        self.cancelled.append((task_id, run_id))
        self.status = "interrupted"


class _AdmissionThreads:
    def __init__(self, *, verify_exactly: bool = True) -> None:
        self.thread_id = "synthetic-builder-task"
        self.metadata: dict[str, object] = {}
        self.ttl: int | None = None
        self.deleted = False
        self.verify_exactly = verify_exactly

    async def create(self, *, thread_id: str, metadata, ttl: int):
        self.thread_id = thread_id
        self.metadata = dict(metadata)
        self.ttl = ttl
        return {"thread_id": self.thread_id, "metadata": self.metadata}

    async def get(self, task_id: str):
        assert task_id == self.thread_id
        if self.deleted:
            raise RuntimeError("404 not found")
        metadata = dict(self.metadata)
        if not self.verify_exactly:
            metadata["test_run_id"] = "wrong-run"
        return {"thread_id": self.thread_id, "metadata": metadata}

    async def search(self, *, metadata, limit: int, offset: int):
        assert limit == 100
        if self.deleted or offset > 0:
            return []
        if any(self.metadata.get(key) != value for key, value in metadata.items()):
            return []
        return [{"thread_id": self.thread_id, "metadata": self.metadata}]

    async def delete(self, task_id: str):
        assert task_id == self.thread_id
        self.deleted = True


class _AdmissionRuns:
    def __init__(self) -> None:
        self.run_id = "synthetic-builder-run"
        self.created: dict[str, object] | None = None
        self.status = "running"
        self.cancelled: list[tuple[str, str]] = []

    async def create(self, **kwargs):
        self.created = dict(kwargs)
        return {"run_id": self.run_id}

    async def list(self, task_id: str, *, limit: int):
        assert self.created is not None
        assert task_id == self.created["thread_id"]
        assert limit == 100
        return [{"run_id": self.run_id, "status": self.status}]

    async def get(self, task_id: str, run_id: str):
        assert self.created is not None
        assert task_id == self.created["thread_id"]
        assert run_id == self.run_id
        return {"run_id": self.run_id, "status": self.status}

    async def cancel(self, task_id: str, run_id: str, **_kwargs):
        self.cancelled.append((task_id, run_id))
        self.status = "interrupted"


class _FakeThreads:
    def __init__(self, metadata: dict[str, object]) -> None:
        self.metadata = metadata
        self.deleted = False

    async def get(self, _task_id: str):
        if self.deleted:
            raise RuntimeError("404 not found")
        return {"metadata": self.metadata}

    async def search(self, *, metadata, limit: int, offset: int):
        assert limit == 100
        if self.deleted or offset > 0:
            return []
        if any(self.metadata.get(key) != value for key, value in metadata.items()):
            return []
        return [{"thread_id": "builder-task", "metadata": self.metadata}]

    async def delete(self, _task_id: str):
        self.deleted = True


@pytest.mark.anyio
async def test_cleanup_callable_cancels_task_and_purges_artifacts_idempotently(
    tmp_path,
) -> None:
    context = _synthetic_context()
    registry = ArtifactRegistry(tmp_path)
    registry.upsert(
        _synthetic_upsert(context=context),
        user_id=str(context["principal_id"]),
    )
    client = SimpleNamespace(
        threads=_FakeThreads(context),
        runs=_FakeRuns(),
    )
    cleanup = gateway_events.SyntheticBuilderCleanupRequest(
        test_principal_id=str(context["principal_id"]),
        test_run_id=str(context["test_run_id"]),
        cleanup_obligation_id=str(context["cleanup_obligation_id"]),
        tasks=[{"task_id": "builder-task", "run_id": "builder-run"}],
    )

    receipt = await gateway_events.cleanup_synthetic_builder_run(
        cleanup,
        artifact_registry=registry,
        langgraph_client=client,
    )
    repeated = await gateway_events.cleanup_synthetic_builder_run(
        cleanup,
        artifact_registry=registry,
        langgraph_client=client,
    )

    assert receipt.cleanup_complete is True
    assert receipt.runs_cancelled == 1
    assert receipt.task_threads_deleted == 1
    assert receipt.artifacts.artifact_records_deleted == 1
    assert repeated.cleanup_complete is True
    assert repeated.task_threads_missing == 1


@pytest.mark.anyio
async def test_cleanup_discovers_active_pre_artifact_task_with_empty_input(
    tmp_path,
) -> None:
    context = _synthetic_context()
    client = SimpleNamespace(
        threads=_FakeThreads(context),
        runs=_FakeRuns(),
    )

    receipt = await gateway_events.cleanup_synthetic_builder_run(
        gateway_events.SyntheticBuilderCleanupRequest(
            test_principal_id=str(context["principal_id"]),
            test_run_id=str(context["test_run_id"]),
            cleanup_obligation_id=str(context["cleanup_obligation_id"]),
            tasks=[],
        ),
        artifact_registry=ArtifactRegistry(tmp_path),
        langgraph_client=client,
    )

    assert receipt.discovery_complete is True
    assert receipt.authoritative_zero_tasks is True
    assert receipt.discovered_task_count == 1
    assert receipt.task_threads_deleted == 1
    assert receipt.runs_cancelled == 1
    assert receipt.cleanup_complete is True


@pytest.mark.anyio
async def test_opaque_cleanup_id_alone_recovers_pre_artifact_task(
    tmp_path,
) -> None:
    context = _synthetic_context()
    threads = _FakeThreads(context)
    client = SimpleNamespace(threads=threads, runs=_FakeRuns())

    receipt = await gateway_events.cleanup_synthetic_builder_obligation(
        str(context["cleanup_obligation_id"]),
        artifact_registry=ArtifactRegistry(tmp_path),
        langgraph_client=client,
    )

    assert receipt == {
        "cleanup_complete": True,
        "discovery_complete": True,
        "authoritative_zero_tasks": True,
        "artifacts_cleanup_complete": True,
        "binding_conflict": False,
        "unresolved_count": 0,
        "raw_identity_excluded": True,
    }
    assert threads.deleted is True


@pytest.mark.anyio
async def test_global_builder_reaper_pages_past_poisoned_first_batch(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _synthetic_context()
    authoritative_now = datetime.now(UTC).replace(microsecond=0)
    context["retention_anchor_at"] = (
        authoritative_now - timedelta(hours=2)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    context["retention_expires_at"] = (
        authoritative_now - timedelta(hours=1)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    context["provider_expires_at"] = (
        authoritative_now - timedelta(minutes=90)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    from deerflow.sophia.cleanup_fence import (
        _seed_local_cleanup_obligation_for_tests,
    )

    _seed_local_cleanup_obligation_for_tests(
        str(context["cleanup_obligation_id"]),
        str(context["retention_expires_at"]),
        str(context["provider_expires_at"]),
    )
    valid = {
        "thread_id": "valid-task",
        "metadata": dict(context),
    }
    valid["metadata"]["test_principal_id"] = context["principal_id"]
    poisoned = [
        {"thread_id": f"poison-{index}", "metadata": {"synthetic": True}}
        for index in range(100)
    ]

    class _GlobalThreads:
        async def search(self, *, metadata, limit: int, offset: int):
            assert metadata == {"synthetic": True}
            assert limit == 100
            rows = [*poisoned, valid]
            return rows[offset : offset + limit]

    cleanup = AsyncMock(
        return_value={
            "cleanup_complete": True,
            "discovery_complete": True,
            "authoritative_zero_tasks": True,
            "artifacts_cleanup_complete": True,
            "binding_conflict": False,
            "unresolved_count": 0,
            "raw_identity_excluded": True,
        }
    )
    monkeypatch.setattr(
        gateway_events,
        "cleanup_synthetic_builder_obligation",
        cleanup,
    )
    monkeypatch.setattr(
        "app.gateway.routers.voice_lab_recovery._ensure_retention_cleanup_handle_for_id",
        lambda cleanup_obligation_id, **_kwargs: f"handles/{cleanup_obligation_id}.json",
    )

    result = await gateway_events.reap_expired_synthetic_builder_obligations(
        now=datetime.now(UTC) + timedelta(hours=2),
        limit=1,
        artifact_registry=ArtifactRegistry(tmp_path),
        langgraph_client=SimpleNamespace(threads=_GlobalThreads()),
    )

    assert result["discovery_complete"] is True
    assert result["malformed"] == 100
    assert result["completed"] == 1
    assert result["pending"] == 0
    assert result["_completed_cleanup_handles"] == [
        (
            context["cleanup_obligation_id"],
            f"handles/{context['cleanup_obligation_id']}.json",
        )
    ]
    cleanup.assert_awaited_once()


def test_synthetic_builder_rejects_subminute_thread_ttl() -> None:
    from deerflow.sophia.tools import start_builder_task as start_builder_module

    context = _synthetic_context()
    now = datetime.now(UTC)
    context["retention_anchor_at"] = (
        now - timedelta(minutes=59, seconds=59, milliseconds=500)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    context["retention_expires_at"] = (
        now + timedelta(milliseconds=500)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    with pytest.raises(
        SyntheticBuilderContextError,
        match="synthetic_builder_retention_invalid",
    ):
        start_builder_module._synthetic_thread_ttl_minutes(context)


@pytest.mark.anyio
async def test_cleanup_deletes_exact_run_with_incomplete_admission_metadata(
    tmp_path,
) -> None:
    """A failed admission cannot become an undeletable synthetic orphan."""

    context = _synthetic_context()
    incomplete_metadata = {
        "synthetic": True,
        "principal_id": context["principal_id"],
        "test_run_id": context["test_run_id"],
        "cleanup_obligation_id": context["cleanup_obligation_id"],
    }
    threads = _FakeThreads(incomplete_metadata)
    runs = _FakeRuns()
    client = SimpleNamespace(threads=threads, runs=runs)

    receipt = await gateway_events.cleanup_synthetic_builder_run(
        gateway_events.SyntheticBuilderCleanupRequest(
            test_principal_id=str(context["principal_id"]),
            test_run_id=str(context["test_run_id"]),
            cleanup_obligation_id=str(context["cleanup_obligation_id"]),
            tasks=[],
        ),
        artifact_registry=ArtifactRegistry(tmp_path),
        langgraph_client=client,
    )

    assert receipt.discovery_complete is True
    assert receipt.authoritative_zero_tasks is True
    assert receipt.discovered_task_count == 1
    assert receipt.task_threads_deleted == 1
    assert receipt.cleanup_complete is True
    assert threads.deleted is True


@pytest.mark.anyio
async def test_synthetic_admission_creates_authoritative_pre_artifact_index(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.tools import start_builder_task as start_builder_module

    context = _synthetic_context()
    threads = _AdmissionThreads()
    runs = _AdmissionRuns()
    client = SimpleNamespace(threads=threads, runs=runs)
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: client)
    runtime = SimpleNamespace(
        state={
            "user_id": context["principal_id"],
            "synthetic_test": context,
            "injected_memory_contents": ["ordinary-memory-must-not-enter"],
            "current_artifact": {
                "artifact_path": "/mnt/user-data/outputs/ordinary.md",
                "title": "ordinary-project-must-not-enter",
            },
            "messages": [],
        },
        context={"thread_id": "parent-thread"},
        config={
            "configurable": {
                "thread_id": "parent-thread",
                "user_id": context["principal_id"],
                "synthetic_test": context,
            },
            "metadata": {},
        },
        tool_call_id="synthetic-tool-call",
    )

    response = await start_builder_module.start_builder_task.coroutine(
        description="Create an isolated evidence brief.",
        task_type="document",
        runtime=runtime,
    )

    assert isinstance(response, Command)
    assert threads.metadata["synthetic"] is True
    assert threads.metadata["test_run_id"] == context["test_run_id"]
    assert threads.metadata["test_principal_id"] == context["principal_id"]
    assert threads.metadata["principal_id"] == context["principal_id"]
    assert threads.metadata["parent_thread_id"] == "parent-thread"
    assert 1 <= int(threads.ttl or 0) <= 7 * 24 * 60
    assert runs.created is not None
    run_input = runs.created["input"]
    run_config = runs.created["config"]
    canonical = response.update["synthetic_test"]
    retention_ceiling_minutes = max(
        1,
        int(
            (
                datetime.fromisoformat(canonical["retention_expires_at"])
                - datetime.now(UTC)
            ).total_seconds()
            // 60
        ),
    )
    assert int(threads.ttl or 0) <= retention_ceiling_minutes
    assert run_input["synthetic_test"] == canonical
    assert run_input["delegation_context"]["synthetic_test"] == canonical
    assert run_input["delegation_context"]["relevant_memories"] == []
    assert run_input["delegation_context"]["companion_artifact"] == {}
    assert "ordinary-memory-must-not-enter" not in repr(run_input)
    assert "ordinary-project-must-not-enter" not in repr(run_input)
    for surface in (run_config["metadata"], run_config["configurable"]):
        assert surface["synthetic"] is True
        assert surface["test_run_id"] == context["test_run_id"]
        assert surface["test_principal_id"] == context["principal_id"]
    task = response.update["async_tasks"][threads.thread_id]
    assert task["synthetic_test"] == canonical
    assert task["test_run_id"] == context["test_run_id"]

    receipt = await gateway_events.cleanup_synthetic_builder_run(
        gateway_events.SyntheticBuilderCleanupRequest(
            test_principal_id=str(context["principal_id"]),
            test_run_id=str(context["test_run_id"]),
            cleanup_obligation_id=str(context["cleanup_obligation_id"]),
            tasks=[],
        ),
        artifact_registry=ArtifactRegistry(tmp_path),
        langgraph_client=client,
    )

    assert receipt.discovered_task_count == 1
    assert receipt.discovery_complete is True
    assert receipt.authoritative_zero_tasks is True
    assert receipt.cleanup_complete is True
    assert threads.deleted is True
    assert runs.cancelled == [(threads.thread_id, "synthetic-builder-run")]


@pytest.mark.anyio
async def test_synthetic_admission_metadata_mismatch_prevents_run_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.tools import start_builder_task as start_builder_module

    context = _synthetic_context()
    threads = _AdmissionThreads(verify_exactly=False)
    runs = _AdmissionRuns()
    client = SimpleNamespace(threads=threads, runs=runs)
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: client)
    runtime = SimpleNamespace(
        state={
            "user_id": context["principal_id"],
            "synthetic_test": context,
            "messages": [],
        },
        context={"thread_id": "parent-thread"},
        config={
            "configurable": {
                "thread_id": "parent-thread",
                "user_id": context["principal_id"],
                "synthetic_test": context,
            },
            "metadata": {},
        },
        tool_call_id="synthetic-tool-call",
    )

    response = await start_builder_module.start_builder_task.coroutine(
        description="Create an isolated evidence brief.",
        task_type="document",
        runtime=runtime,
    )

    assert isinstance(response, str)
    assert "synthetic_builder_admission_unverified" in response
    assert runs.created is None
    assert threads.deleted is True


@pytest.mark.anyio
async def test_cleanup_identity_mismatch_retains_artifact_with_hashed_issue(
    tmp_path,
) -> None:
    context = _synthetic_context()
    wrong_context = _synthetic_context(
        run_id="different-run",
        cleanup_obligation_id=str(context["cleanup_obligation_id"]),
    )
    registry = ArtifactRegistry(tmp_path)
    record = registry.upsert(
        _synthetic_upsert(context=context),
        user_id=str(context["principal_id"]),
    )
    client = SimpleNamespace(
        threads=_FakeThreads(wrong_context),
        runs=_FakeRuns(),
    )

    receipt = await gateway_events.cleanup_synthetic_builder_run(
        gateway_events.SyntheticBuilderCleanupRequest(
            test_principal_id=str(context["principal_id"]),
            test_run_id=str(context["test_run_id"]),
            cleanup_obligation_id=str(context["cleanup_obligation_id"]),
            tasks=[{"task_id": "builder-task", "run_id": "builder-run"}],
        ),
        artifact_registry=registry,
        langgraph_client=client,
    )

    assert receipt.cleanup_complete is False
    assert receipt.unresolved[0].code == "task_identity_mismatch"
    assert "builder-task" not in receipt.unresolved[0].identifier_hash
    assert registry.get(record.artifact_id, user_id=str(context["principal_id"])) is not None


@pytest.mark.parametrize(
    "missing_proof",
    ("discovery_complete", "authoritative_zero_tasks"),
)
def test_cleanup_receipt_rejects_success_without_authoritative_zero_proof(
    missing_proof: str,
) -> None:
    proof = {
        "discovery_complete": True,
        "authoritative_zero_tasks": True,
    }
    proof[missing_proof] = False
    with pytest.raises(ValidationError):
        gateway_events.SyntheticBuilderCleanupReceipt.model_validate(
            {
                "test_principal_id": "voice-lab-principal",
                "test_run_id": "voice-lab-run-1",
                **proof,
                "discovered_task_count": 0,
                "task_threads_matched": 0,
                "task_threads_deleted": 0,
                "task_threads_missing": 0,
                "runs_cancelled": 0,
                "artifacts": {
                    "test_principal_id": "voice-lab-principal",
                    "test_run_id": "voice-lab-run-1",
                    "matched_artifact_count": 0,
                    "artifact_records_deleted": 0,
                    "artifact_objects_deleted": 0,
                    "artifact_objects_missing": 0,
                    "artifact_objects_not_applicable": 0,
                    "remaining_artifact_count": 0,
                    "cleanup_complete": True,
                    "unresolved": [],
                },
                "cleanup_complete": True,
                "unresolved": [],
            }
        )


def _gateway_app() -> FastAPI:
    app = FastAPI()
    install_builder_events_worker(app, cache_ttl_seconds=60)
    app.include_router(gateway_events.internal_router)
    app.include_router(gateway_events.public_router)
    return app


def _synthetic_session_record(
    *,
    run_id: str = "voice-lab-run-1",
) -> SimpleNamespace:
    created_at = datetime.now(UTC).replace(microsecond=123000)
    retention_expires_at = created_at + timedelta(hours=1)
    retention_text = retention_expires_at.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    deployment = {
        "frontend": "a" * 40,
        "backend": "b" * 40,
        "voice": "c" * 40,
    }
    cleanup_obligation_id = str(
        UUID(hex=hashlib.sha256(run_id.encode()).hexdigest()[:32], version=4)
    )
    voice_lab_run_id_sha256 = hashlib.sha256(run_id.encode()).hexdigest()
    return SimpleNamespace(
        user_id="voice-lab-principal",
        run_id=run_id,
        status="open",
        ended_at=None,
        created_at=created_at.isoformat(),
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-principal",
                "test_run_id": run_id,
                "scenario_id": "builder-presentation",
                "scenario_version": "1.0",
                "environment": "production",
                "retention_hours": 1,
                "cleanup_obligation_id": cleanup_obligation_id,
                "voice_lab_run_id_sha256": voice_lab_run_id_sha256,
                "browser_worker_id_sha256": "d" * 64,
                "browser_lease_epoch": 1,
                "browser_context_id_sha256": "e" * 64,
                "provider_expires_at": _SYNTHETIC_PROVIDER_EXPIRES_AT,
                "retention_anchor": "session_created_at_provisional",
                "retention_expires_at": retention_text,
            },
            "expected_deployment": deployment,
            "memory_retrieval_disabled": True,
            "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
        },
    )


def _synthetic_session_claims(
    *,
    run_id: str = "voice-lab-run-1",
) -> SimpleNamespace:
    cleanup_obligation_id = str(
        UUID(hex=hashlib.sha256(run_id.encode()).hexdigest()[:32], version=4)
    )
    return SimpleNamespace(
        principal_id="voice-lab-principal",
        test_run_id=run_id,
        scenario_id="builder-presentation",
        scenario_version="1.0",
        environment="production",
        retention_hours=1,
        cleanup_obligation_id=cleanup_obligation_id,
        voice_lab_run_id_sha256=hashlib.sha256(run_id.encode()).hexdigest(),
        browser_worker_id_sha256="d" * 64,
        browser_lease_epoch=1,
        browser_context_id_sha256="e" * 64,
        provider_expires_at=_SYNTHETIC_PROVIDER_EXPIRES_AT,
        expected_deployment={
            "frontend": "a" * 40,
            "backend": "b" * 40,
            "voice": "c" * 40,
        },
    )


@pytest.fixture(autouse=True)
def _builder_event_auth(monkeypatch: pytest.MonkeyPatch):
    from deerflow.sophia.cleanup_fence import _reset_local_cleanup_fences_for_tests

    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    _reset_local_cleanup_fences_for_tests()
    reset_builder_event_replay_guard_for_tests()
    yield
    _reset_local_cleanup_fences_for_tests()
    reset_builder_event_replay_guard_for_tests()


@pytest.mark.anyio
async def test_unauthorized_completion_and_progress_are_rejected_before_mutation() -> None:
    app = _gateway_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        completion = await client.post(
            "/internal/builder-events",
            json={
                "thread_id": "parent-thread",
                "task_id": "builder-task",
                "status": "success",
            },
        )
        progress = await client.post(
            "/internal/builder-progress",
            json={
                "task_id": "builder-task",
                "run_id": "builder-run",
                "event_name": "custom",
                "data": {"name": "phase", "phase": "starting"},
            },
        )
        cleanup = await client.post(
            "/internal/builder-events/synthetic-cleanup",
            json={
                "test_principal_id": "voice-lab-principal",
                "test_run_id": "voice-lab-run-1",
                "tasks": [],
            },
        )

    assert completion.status_code == 401
    assert progress.status_code == 401
    assert cleanup.status_code == 401
    assert await get_builder_events_worker(app).get_last("parent-thread") is None


@pytest.mark.anyio
async def test_signed_completion_is_accepted_and_replay_is_rejected() -> None:
    app = _gateway_app()
    payload = {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "status": "success",
    }
    body = encode_builder_event_body(payload)
    headers = signed_builder_event_headers(body)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        accepted = await client.post(
            "/internal/builder-events",
            content=body,
            headers=headers,
        )
        replay = await client.post(
            "/internal/builder-events",
            content=body,
            headers=headers,
        )

    assert accepted.status_code == 202
    assert replay.status_code == 401


@pytest.mark.anyio
async def test_signed_synthetic_completion_is_tagged_hidden_and_not_published(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _gateway_app()
    context = _synthetic_context()
    payload = _completion_payload(context)
    registry = ArtifactRegistry(tmp_path)
    channel_publish = AsyncMock()
    monkeypatch.setattr(gateway_events, "_artifact_registry", registry)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel_publish,
    )
    monkeypatch.setattr(
        gateway_events,
        "get_companion_wakeup_or_none",
        lambda _app: (_ for _ in ()).throw(
            AssertionError("synthetic completion must not wake ordinary companion")
        ),
    )
    body = encode_builder_event_body(payload)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/builder-events",
            content=body,
            headers=signed_builder_event_headers(body),
        )

    assert response.status_code == 202
    channel_publish.assert_not_awaited()
    cached = await get_builder_events_worker(app).get_last("parent-thread")
    assert cached is not None
    assert cached["test_run_id"] == context["test_run_id"]
    assert cached["ordinary_artifact_publication_excluded"] is True
    internal = registry.list(
        user_id=str(context["principal_id"]),
        filters=ArtifactRegistryFilters(
            include_hidden=True,
            include_synthetic=True,
        ),
    )
    assert len(internal.artifacts) == 1
    assert internal.artifacts[0].is_library_visible is False


@pytest.mark.anyio
async def test_signed_synthetic_progress_skips_ordinary_channel_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _gateway_app()
    context = _synthetic_context()
    synthetic_fields = _completion_payload(context)
    payload = {
        "task_id": "builder-task",
        "run_id": "builder-run",
        "parent_thread_id": "parent-thread",
        "event_name": "custom",
        "data": {"name": "phase", "phase": "starting"},
        **{
            key: synthetic_fields[key]
            for key in gateway_events._SYNTHETIC_BUILDER_FIELDS
        },
    }

    def _ordinary_registry():
        raise AssertionError(
            "synthetic progress reached the ordinary channel registry"
        )

    monkeypatch.setattr(
        "app.gateway.builder_progress.get_progress_registry",
        _ordinary_registry,
    )
    body = encode_builder_event_body(payload)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/builder-progress",
            content=body,
            headers=signed_builder_event_headers(body),
        )

    assert response.status_code == 202
    assert response.json() == {"applied": False, "web_delivered": 0}


@pytest.mark.anyio
async def test_legacy_event_egress_requires_auth_and_exact_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unauthenticated_app = _gateway_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=unauthenticated_app),
        base_url="http://test",
    ) as client:
        missing_auth = await client.get(
            "/api/threads/parent-thread/builder-events/last"
        )
    assert missing_auth.status_code == 401

    owned_app = _gateway_app()
    owned_app.dependency_overrides[gateway_events.require_authenticated_user] = (
        lambda: "principal-a"
    )
    monkeypatch.setattr(
        gateway_events._session_store,
        "find_session_by_thread_id",
        lambda user_id, _thread_id: object() if user_id == "principal-a" else None,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=owned_app),
        base_url="http://test",
    ) as client:
        owned = await client.get(
            "/api/threads/parent-thread/builder-events/last"
        )
    assert owned.status_code == 204

    cross_user_app = _gateway_app()
    cross_user_app.dependency_overrides[gateway_events.require_authenticated_user] = (
        lambda: "principal-b"
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=cross_user_app),
        base_url="http://test",
    ) as client:
        cross_user = await client.get(
            "/api/threads/parent-thread/builder-events/last"
        )
        cross_user_sse = await client.get(
            "/api/threads/parent-thread/builder-events"
        )
    assert cross_user.status_code == 404
    assert cross_user_sse.status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path",
    (
        "/api/threads/parent-thread/builder-events/last",
        "/api/threads/parent-thread/builder-events",
    ),
)
async def test_synthetic_event_egress_requires_capability_before_worker_cache(
    path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _gateway_app()
    app.dependency_overrides[gateway_events.require_authenticated_user] = (
        lambda: "voice-lab-principal"
    )
    monkeypatch.delenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", raising=False)
    monkeypatch.setattr(
        gateway_events._session_store,
        "find_session_by_thread_id",
        lambda _user_id, _thread_id: _synthetic_session_record(),
    )
    monkeypatch.setattr(
        gateway_events,
        "get_builder_events_worker",
        lambda _app: (_ for _ in ()).throw(
            AssertionError("worker/cache touched before capability rejection")
        ),
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(path)

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "voice_lab_capability_missing"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path",
    (
        "/api/threads/parent-thread/builder-events/last",
        "/api/threads/parent-thread/builder-events",
    ),
)
async def test_synthetic_event_egress_rejects_wrong_run_before_worker_cache(
    path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _gateway_app()
    app.dependency_overrides[gateway_events.require_authenticated_user] = (
        lambda: "voice-lab-principal"
    )
    monkeypatch.setattr(
        gateway_events._session_store,
        "find_session_by_thread_id",
        lambda _user_id, _thread_id: _synthetic_session_record(),
    )
    monkeypatch.setattr(
        gateway_events,
        "capability_for_gateway_action",
        lambda *_args, **_kwargs: _synthetic_session_claims(
            run_id="different-run"
        ),
    )
    monkeypatch.setattr(
        gateway_events,
        "get_builder_events_worker",
        lambda _app: (_ for _ in ()).throw(
            AssertionError("worker/cache touched before run-binding rejection")
        ),
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(path)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "voice_lab_session_binding_mismatch"


@pytest.mark.anyio
async def test_synthetic_event_egress_accepts_exact_session_read_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _gateway_app()
    app.dependency_overrides[gateway_events.require_authenticated_user] = (
        lambda: "voice-lab-principal"
    )
    required_operations: list[str] = []

    def _capability(*_args, required_operation: str, **_kwargs):
        required_operations.append(required_operation)
        return _synthetic_session_claims()

    monkeypatch.setattr(
        gateway_events._session_store,
        "find_session_by_thread_id",
        lambda _user_id, _thread_id: _synthetic_session_record(),
    )
    monkeypatch.setattr(
        gateway_events,
        "capability_for_gateway_action",
        _capability,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/api/threads/parent-thread/builder-events/last"
        )

    assert response.status_code == 204
    assert required_operations == ["session:read"]
