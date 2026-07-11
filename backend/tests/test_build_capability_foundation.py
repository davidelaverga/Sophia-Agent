from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

from deerflow.agents.sophia_agent.middlewares.build_deadline import BuildDeadlineMiddleware
from deerflow.config.model_config import ModelConfig
from deerflow.config.model_route_config import HarnessProfileConfig, ModelRouteConfig
from deerflow.models.route_resolver import ModelRouteResolutionError, ModelRouteResolver
from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload, InMemoryArtifactAcceptanceOutbox
from deerflow.sophia.build_manifest import (
    BuildManifest,
    BuildManifestConcurrentModification,
    InMemoryBuildManifestStore,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction, InMemoryBuildMutationStore
from deerflow.sophia.build_runtime.budget import ResourceBudgetExceeded, ResourceBudgetLedger
from deerflow.sophia.build_runtime.events import BuildOperationEvent, InMemoryBuildEventSink
from deerflow.sophia.build_runtime.identity import component_id, new_build_id, new_operation_id, new_version_id
from deerflow.sophia.build_runtime.metrics import derive_prepare_metrics
from deerflow.sophia.build_sources import materialize_compact_deck_sources


def test_identity_is_sortable_and_component_identity_is_selector_stable() -> None:
    first = new_build_id()
    second = new_build_id()
    assert first < second
    assert component_id(first, " Slide:4 ") == component_id(first, "slide:4")
    assert component_id(first, "slide:4") != component_id(first, "slide:5")
    assert new_operation_id().startswith("op_")
    assert new_version_id("artifact_version").startswith("artifact_version_")


def test_manifest_cas_rejects_stale_writer() -> None:
    store = InMemoryBuildManifestStore()
    manifest = BuildManifest(
        manifest_revision=0,
        build_id=new_build_id(),
        user_id="user-1",
        thread_id="thread-1",
        format="pptx",
        status="building",
    )
    created = store.create(manifest)
    writer_a = created.model_copy(update={"status": "complete"})
    writer_b = created.model_copy(update={"status": "failed"})
    saved = store.save_cas(writer_a, expected_revision=1)
    assert saved.manifest_revision == 2
    with pytest.raises(BuildManifestConcurrentModification):
        store.save_cas(writer_b, expected_revision=1)
    assert store.load(build_id=manifest.build_id, user_id="user-1").status == "complete"


def test_compact_source_bundle_is_immutable_and_reproducible(tmp_path) -> None:
    slides = [
        SimpleNamespace(
            selector="slide:1",
            html_body="<main><h1>Hello</h1></main>",
            slide_css="h1{color:#111}",
            speaker_notes="Opening",
            html_source="<!doctype html><html><body><main><h1>Hello</h1></main></body></html>",
        )
    ]
    materialized = materialize_compact_deck_sources(
        build_id="build-test",
        root=tmp_path,
        deck_stylesheet="body{margin:0}",
        slides=slides,
    )
    assert materialized.stylesheet_path.read_text() == "body{margin:0}"
    version = materialized.versions[0]
    assert version.source_hashes["deck.css"]
    assert version.resolved_output_hash
    repeated = materialize_compact_deck_sources(
        build_id="build-test",
        root=tmp_path,
        deck_stylesheet="body{margin:0}",
        slides=slides,
    )
    assert repeated.total_source_bytes == materialized.total_source_bytes


def test_prepare_metrics_are_exact_call_id_sets() -> None:
    sink = InMemoryBuildEventSink()
    base = {
        "sequence": 1,
        "user_id": "u",
        "thread_id": "t",
        "build_id": "build-1",
    }
    events = [
        BuildOperationEvent(**base, event_type="prepare.emitted", tool_call_id="a"),
        BuildOperationEvent(**{**base, "sequence": 2}, event_type="prepare.execution_started", tool_call_id="a"),
        BuildOperationEvent(**{**base, "sequence": 3}, event_type="prepare.result_recorded", tool_call_id="a"),
        BuildOperationEvent(**{**base, "sequence": 4}, event_type="prepare.emitted", tool_call_id="b"),
        BuildOperationEvent(**{**base, "sequence": 5}, event_type="prepare.service_started", tool_call_id="a"),
        BuildOperationEvent(**{**base, "sequence": 6}, event_type="prepare.service_finished", tool_call_id="a"),
    ]
    for event in events:
        sink.append(event)
        sink.append(event)
    metrics = derive_prepare_metrics(sink.replay(build_id="build-1"))
    assert metrics["prepare_emitted_call_count"] == 2
    assert metrics["prepare_execution_count"] == 1
    assert metrics["prepare_result_count"] == 1
    assert metrics["dangling_prepare_call_ids"] == ["b"]
    assert metrics["prepare_service_call_count"] == 1


def test_deadline_cancels_model_without_provider_retry() -> None:
    calls = 0

    async def handler(_request):
        nonlocal calls
        calls += 1
        await __import__("anyio").sleep(1)
        return AIMessage(content="late")

    request = SimpleNamespace(
        state={
            "builder_budget": {"tier": "presentation", "terminal_reserve_seconds": 0},
            "builder_task_kickoff_ms": int(time.time() * 1000) - 100,
            "builder_deadline_epoch_ms": int(time.time() * 1000) + 20,
        }
    )
    result = __import__("anyio").run(BuildDeadlineMiddleware().awrap_model_call, request, handler)
    assert calls == 1
    assert result.command.update["builder_result"]["failure_code"] == "deck_authoring_deadline_exceeded"


class _RouteConfig:
    def __init__(self, model: ModelConfig) -> None:
        self._model = model
        self.model_routes = {
            "deck.judge.visual": ModelRouteConfig(
                primary=model.name,
                profile="visual-v1",
                required_capabilities={"image_input", "strict_structured_output"},
            )
        }
        self.harness_profiles = {"visual-v1": HarnessProfileConfig(version="1", model_overrides={"max_tokens": 4096})}

    def get_model_config(self, name: str):
        return self._model if name == self._model.name else None


def test_model_route_resolution_is_deterministic_and_capability_checked() -> None:
    model = ModelConfig(
        name="judge",
        provider="anthropic",
        use="langchain_anthropic:ChatAnthropic",
        model="claude",
        capabilities={"image_input", "strict_structured_output"},
    )
    resolver = ModelRouteResolver(_RouteConfig(model))  # type: ignore[arg-type]
    first = resolver.resolve(route_name="deck.judge.visual")
    second = resolver.resolve(route_name="deck.judge.visual")
    assert first.plan_hash == second.plan_hash
    assert first.provider == "anthropic"
    missing = model.model_copy(update={"capabilities": {"image_input"}})
    with pytest.raises(ModelRouteResolutionError, match="lacks capabilities"):
        ModelRouteResolver(_RouteConfig(missing)).resolve(route_name="deck.judge.visual")  # type: ignore[arg-type]


def test_resource_budget_reservation_and_usage() -> None:
    ledger = ResourceBudgetLedger(max_model_calls=1, max_tokens=100, max_cost_usd=1.0)
    ledger.reserve("judge", tokens=80, cost_usd=0.5)
    ledger.record_usage("judge", tokens=70, cost_usd=0.4)
    assert ledger.model_calls == 1
    with pytest.raises(ResourceBudgetExceeded):
        ledger.reserve("repair", tokens=40)


def test_mutation_store_requires_expected_state() -> None:
    transaction = BuildMutationTransaction.prepare(
        build_id="build-1",
        user_id="user-1",
        operation_id="op-1",
        expected_manifest_revision=2,
        lease_owner="worker-1",
    )
    store = InMemoryBuildMutationStore()
    store.create(transaction)
    verified = transaction.model_copy(update={"status": "verified"})
    store.transition(verified, expected_status="prepared")
    with pytest.raises(ValueError, match="stale"):
        store.transition(transaction.model_copy(update={"status": "committed"}), expected_status="prepared")


def test_acceptance_outbox_is_idempotent() -> None:
    payload = ArtifactAcceptedPayload(
        build_id="build-1",
        logical_artifact_id="artifact-1",
        artifact_version_id="version-1",
        manifest_revision=1,
        artifact_type="pptx",
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        storage_object_path="artifacts/u/t/foundation/.builder/builds/build-1/artifacts/version-1/deck.pptx",
        origin="fresh",
    )
    outbox = InMemoryArtifactAcceptanceOutbox()
    assert outbox.enqueue(payload) is True
    assert outbox.enqueue(payload) is False
    assert len(outbox.pending()) == 1
