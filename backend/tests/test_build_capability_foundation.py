from __future__ import annotations

import asyncio
import json
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from langchain_core.messages import AIMessage

from deerflow.agents.sophia_agent.middlewares.build_deadline import BuildDeadlineMiddleware
from deerflow.config.build_foundation_config import BuildFoundationConfig
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
from deerflow.sophia.build_runtime.events import (
    BuildOperationEvent,
    InMemoryBuildEventSink,
    configure_default_event_sink,
    record_runtime_event,
)
from deerflow.sophia.build_runtime.identity import component_id, new_build_id, new_operation_id, new_version_id
from deerflow.sophia.build_runtime.metrics import derive_prepare_metrics
from deerflow.sophia.build_runtime.startup import (
    BuildFoundationStartupError,
    audit_build_foundation,
    audit_deck_quality_builder_service_startup,
)
from deerflow.sophia.build_sources import materialize_compact_deck_sources
from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_PROBE_ACK_HEADER,
    builder_event_probe_ack,
)
from deerflow.sophia.storage.build_foundation_store import (
    BuildFoundationStoreConfig,
    BuildFoundationStoreError,
    SupabaseBuildFoundationStore,
)


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


def test_runtime_event_scope_uses_configurable_and_metadata_without_context() -> None:
    sink = InMemoryBuildEventSink()
    runtime = SimpleNamespace(
        context=None,
        config={
            "configurable": {"thread_id": "thread-config"},
            "metadata": {"user_id": "user-metadata"},
        }
    )
    configure_default_event_sink(sink)
    try:
        event = record_runtime_event(
            state={"builder_build_id": "build-config-scope"},
            runtime=runtime,
            event_type="prepare.emitted",
            tool_call_id="call-1",
        )
    finally:
        configure_default_event_sink(None)

    assert event is not None
    assert event.thread_id == "thread-config"
    assert event.user_id == "user-metadata"
    assert sink.replay(build_id="build-config-scope") == [event]


def test_deadline_cancels_model_without_provider_retry(monkeypatch) -> None:
    calls = 0
    webhook_calls: list[dict] = []

    async def handler(_request):
        nonlocal calls
        calls += 1
        await __import__("anyio").sleep(1)
        return AIMessage(content="late")

    request = SimpleNamespace(
        runtime=SimpleNamespace(context={"thread_id": "builder-thread"}),
        state={
            "builder_budget": {"tier": "presentation", "terminal_reserve_seconds": 0},
            "builder_task_kickoff_ms": int(time.time() * 1000) - 100,
            "builder_deadline_epoch_ms": int(time.time() * 1000) + 20,
        },
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.build_deadline.fire_completion_webhook_from_artifact",
        lambda **kwargs: webhook_calls.append(kwargs) or True,
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.build_deadline.annotate_builder_completion",
        lambda *_args, **_kwargs: True,
    )
    result = __import__("anyio").run(BuildDeadlineMiddleware().awrap_model_call, request, handler)
    assert calls == 1
    assert result.command.update["builder_result"]["failure_code"] == "deck_deadline_exceeded"
    assert result.model_response.result[0].content == "[Sophia builder stopped at its execution deadline.]"
    assert webhook_calls[0]["status"] == "timed_out"
    assert webhook_calls[0]["artifact"]["terminal_reason"] == "deck_deadline_exceeded"


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

    def get_model_deployment(self, name: str):
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


def test_startup_reuses_process_event_sink(monkeypatch) -> None:
    from deerflow.sophia.build_runtime import startup

    sink = InMemoryBuildEventSink()
    calls = 0

    def store_factory():
        nonlocal calls
        calls += 1
        return sink

    config = SimpleNamespace(
        build_foundation=SimpleNamespace(
            enabled=True,
            manifest_mode="observe",
            persist_event_journal=True,
        ),
        model_routes={},
    )
    configure_default_event_sink(None)
    monkeypatch.setattr(startup, "configured_build_foundation_store", store_factory)
    try:
        audit_build_foundation(tools=[], config=config)
        audit_build_foundation(tools=[], config=config)
    finally:
        configure_default_event_sink(None)

    assert calls == 1


def test_canary_manifest_enforcement_requires_durable_foundation_dependencies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        build_foundation=BuildFoundationConfig(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids={"canary-user"},
            persist_event_journal=False,
        ),
        model_routes={},
    )
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(
        startup.BuildFoundationStoreConfig,
        "from_env",
        classmethod(lambda _cls: None),
    )
    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: True)

    with pytest.raises(BuildFoundationStartupError, match="manifest enforcement requires"):
        audit_build_foundation(tools=[], config=config)


def test_ordinary_builder_construction_has_zero_dq_startup_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.agents.sophia_agent import builder_agent
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        models=[],
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({"synthetic-canary"}),
        ),
        build_foundation=SimpleNamespace(
            enabled=False,
            manifest_mode="observe",
            persist_event_journal=False,
        ),
    )
    baseline_audits: list[object] = []

    def forbidden_dq_validation(*_args, **_kwargs):
        raise AssertionError("per-run builder performed DQ startup validation")

    class _Agent:
        recursion_limit = 0

    monkeypatch.delenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", raising=False)
    monkeypatch.setattr(builder_agent, "get_app_config", lambda: config)
    monkeypatch.setattr(builder_agent, "ChatAnthropic", lambda **_kwargs: object())
    monkeypatch.setattr(builder_agent, "supports_vision", lambda _model: False)
    monkeypatch.setattr(
        builder_agent,
        "build_builder_middleware_chain",
        lambda **_kwargs: [],
    )
    monkeypatch.setattr(
        builder_agent,
        "build_builder_tools_for_task_type",
        lambda *_args, **_kwargs: [],
    )
    monkeypatch.setattr(
        builder_agent,
        "assert_deck_tool_contract",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        builder_agent,
        "create_agent",
        lambda **_kwargs: _Agent(),
    )
    monkeypatch.setattr(
        builder_agent,
        "wrap_builder_agent_for_observability",
        lambda agent, **_kwargs: agent,
    )
    monkeypatch.setattr(
        startup,
        "validate_expected_supabase_project",
        lambda: baseline_audits.append(config),
    )
    monkeypatch.setattr(
        startup,
        "probe_builder_event_auth",
        forbidden_dq_validation,
    )
    monkeypatch.setattr(
        startup,
        "probe_deck_quality_failure_signal_gateway_auth",
        forbidden_dq_validation,
    )
    monkeypatch.setattr(
        startup.supabase_artifact_store,
        "is_configured",
        forbidden_dq_validation,
    )
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
        forbidden_dq_validation,
    )

    agent = builder_agent.make_sophia_builder(
        {
            "configurable": {
                "user_id": "ordinary-user",
                "model_name": "claude-sonnet-5",
            }
        }
    )

    assert isinstance(agent, _Agent)
    # The pre-campaign foundation audit remains on the factory path.
    assert baseline_audits == [config]


def test_distributed_builder_factory_keeps_parent_context_open_for_graph_lifetime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.agents.sophia_agent import builder_agent

    events: list[object] = []
    created_agent = object()

    @contextmanager
    def fake_distributed_context(**kwargs):
        events.append(("enter", kwargs))
        yield
        events.append("exit")

    def fake_create_builder_agent(**kwargs):
        events.append(("create", kwargs))
        return created_agent

    monkeypatch.setattr(
        builder_agent,
        "builder_distributed_trace_context",
        fake_distributed_context,
    )
    monkeypatch.setattr(
        builder_agent,
        "_resolve_builder_model_name",
        lambda _model_name: ("claude-sonnet-5", "config-sonnet"),
    )
    monkeypatch.setattr(builder_agent, "_create_builder_agent", fake_create_builder_agent)

    config = {
        "configurable": {
            "langsmith-trace": "langsmith-parent-header",
            "baggage": "langsmith-project=Sophia,langsmith-tag=channel%3Avoice",
            "user_id": "voice-user",
            "model_name": "claude-sonnet-5",
            "task_type": "presentation",
            "artifact_target_ext": ".pptx",
            "voice_trace_id": "voice-trace-1",
            "voice_tool_call_id": "voice-tool-1",
        }
    }
    async def exercise_factory() -> None:
        async with builder_agent.make_sophia_builder_with_distributed_tracing(config) as agent:
            assert agent is created_agent
            assert events[0][0] == "enter"
            assert events[1][0] == "create"

    asyncio.run(exercise_factory())

    assert events[-1] == "exit"
    context_kwargs = events[0][1]
    assert context_kwargs["parent"] == {
        "langsmith-trace": "langsmith-parent-header",
        "baggage": "langsmith-project=Sophia,langsmith-tag=channel%3Avoice",
    }
    create_kwargs = events[1][1]
    assert create_kwargs["external_trace_context"] is True
    assert create_kwargs["resolved_model_info"] == ("claude-sonnet-5", "config-sonnet")
    assert create_kwargs["task_type"] == "presentation"
    assert create_kwargs["artifact_target_ext"] == ".pptx"


def test_enabled_deck_quality_instrument_is_compiled_at_service_startup(
    monkeypatch,
) -> None:
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({"synthetic-canary"}),
        ),
        build_foundation=SimpleNamespace(
            enabled=False,
            manifest_mode="observe",
            persist_event_journal=False,
        ),
    )
    compiled = []
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(
        startup,
        "probe_deck_quality_failure_signal_gateway_auth",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-key",
    )
    monkeypatch.setenv(
        "SOPHIA_BUILDER_EVENTS_HMAC_SECRET",
        "synthetic-builder-event-secret-" + "a" * 40,
    )
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-baseline-builder-key")
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
        lambda value: compiled.append(value),
    )

    audit_deck_quality_builder_service_startup(config=config)

    assert compiled == [config]


@pytest.mark.parametrize(
    ("status_code", "acknowledged", "expected_error"),
    [
        (403, True, None),
        (403, False, "builder_event_gateway_probe_ack_invalid"),
        (401, False, "builder_event_gateway_auth_mismatch"),
        (409, False, "builder_event_gateway_canary_scope_mismatch"),
        (503, False, "builder_event_gateway_auth_unavailable"),
    ],
)
def test_deck_quality_startup_proves_gateway_hmac_equality(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    acknowledged: bool,
    expected_error: str | None,
) -> None:
    from deerflow.sophia.build_runtime import startup

    calls: list[dict[str, object]] = []

    class _Client:
        def __init__(self, *, timeout: httpx.Timeout) -> None:
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url: str, **kwargs):
            calls.append({"url": url, **kwargs})
            response_headers = (
                {
                    BUILDER_EVENT_PROBE_ACK_HEADER: (
                        builder_event_probe_ack(kwargs["content"])
                    )
                }
                if acknowledged
                else {}
            )
            return SimpleNamespace(
                status_code=status_code,
                headers=response_headers,
            )

    monkeypatch.setenv(
        "SOPHIA_BUILDER_EVENTS_HMAC_SECRET",
        "synthetic-builder-event-secret-" + "a" * 40,
    )
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "https://gateway.internal/")
    monkeypatch.setattr(startup.httpx, "Client", _Client)

    if expected_error is None:
        assert startup.probe_deck_quality_failure_signal_gateway_auth(
            canary_user_ids={"synthetic-canary"},
        ) is None
    else:
        with pytest.raises(
            startup.BuilderEventAuthenticationError,
            match=expected_error,
        ):
            startup.probe_deck_quality_failure_signal_gateway_auth(
                canary_user_ids={"synthetic-canary"},
            )

    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == (
        "https://gateway.internal/internal/deck-quality-producer-failures"
    )
    body = call["content"]
    headers = call["headers"]
    assert isinstance(body, bytes)
    assert isinstance(headers, dict)
    assert headers["Content-Type"] == "application/json"
    assert headers["X-Sophia-Builder-Signature"].startswith("v1=")
    decoded_body = json.loads(body)
    scope_proof = decoded_body.pop("canary_scope_proof")
    assert isinstance(scope_proof, str)
    assert len(scope_proof) == 64
    assert "synthetic-canary" not in scope_proof
    assert decoded_body == {
        "campaign_id": "DQ-1",
        "candidate_digest": (
            "ebf93716177a0c737cf2f0182c333e6c9c08d65817f218de23b491f33cdccc65"
        ),
        "failure_code": "shadow_dispatch_unavailable",
        "failure_stage": "candidate_metadata",
        "quality_run_id": None,
        "schema_version": "deck-quality-producer-failure-signal/v1",
        "upstream_failure_code": "candidate_metadata_invalid",
        "user_id": "__sophia_dq1_hmac_probe_reserved_noncanary__",
    }


def test_enabled_deck_quality_requires_isolated_producer_dependencies_at_service_startup(
    monkeypatch,
) -> None:
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({"synthetic-canary"}),
        ),
        build_foundation=SimpleNamespace(
            enabled=False,
            manifest_mode="observe",
            persist_event_journal=False,
        ),
    )
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(
        startup,
        "probe_deck_quality_failure_signal_gateway_auth",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
        lambda _value: object(),
    )
    monkeypatch.setenv(
        "SOPHIA_BUILDER_EVENTS_HMAC_SECRET",
        "synthetic-builder-event-secret-" + "a" * 40,
    )
    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: False)

    with pytest.raises(
        startup.BuildFoundationStartupError,
        match="durable object storage",
    ):
        audit_deck_quality_builder_service_startup(config=config)

    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-baseline-builder-key")
    monkeypatch.delenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", raising=False)
    with pytest.raises(
        startup.BuildFoundationStartupError,
        match="isolated provider credential",
    ):
        audit_deck_quality_builder_service_startup(config=config)

    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "synthetic-dq-only-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(
        startup.BuildFoundationStartupError,
        match="baseline builder provider credential",
    ):
        audit_deck_quality_builder_service_startup(config=config)

    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "shared-key")
    monkeypatch.setenv("OPENAI_API_KEY", "shared-key")
    with pytest.raises(
        startup.BuildFoundationStartupError,
        match="must be distinct",
    ):
        audit_deck_quality_builder_service_startup(config=config)

    config.deck_quality.allow_shared_provider_credential = True
    audit_deck_quality_builder_service_startup(config=config)


def test_enabled_deck_quality_requires_failure_signal_auth_at_service_startup(
    monkeypatch,
) -> None:
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        deck_quality=SimpleNamespace(enabled=True),
        build_foundation=SimpleNamespace(
            enabled=False,
            manifest_mode="observe",
            persist_event_journal=False,
        ),
    )
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
        lambda _value: object(),
    )
    monkeypatch.delenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", raising=False)

    with pytest.raises(
        startup.BuildFoundationStartupError,
        match="builder-event authentication",
    ):
        audit_deck_quality_builder_service_startup(config=config)


def test_enabled_invalid_deck_quality_instrument_fails_service_startup(
    monkeypatch,
) -> None:
    from deerflow.sophia.build_runtime import startup

    config = SimpleNamespace(
        deck_quality=SimpleNamespace(enabled=True),
        build_foundation=SimpleNamespace(
            enabled=False,
            manifest_mode="observe",
            persist_event_journal=False,
        ),
    )
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(
        "deerflow.sophia.deck_quality.instrument.compile_runtime_instrument",
        lambda _value: (_ for _ in ()).throw(ValueError("invalid instrument")),
    )

    with pytest.raises(ValueError, match="invalid instrument"):
        audit_deck_quality_builder_service_startup(config=config)


def test_build_foundation_rpcs_grant_service_role_execution() -> None:
    migration = Path(__file__).resolve().parents[1] / "migrations" / "2026_07_11_sophia_build_foundation.sql"
    sql = " ".join(migration.read_text(encoding="utf-8").split())

    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_commit_build_manifest( "
        "TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB ) TO service_role;"
    ) in sql
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_append_build_event("
        "TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;"
    ) in sql
    assert sql.startswith("-- Sophia P-2 build foundation.")
    assert "BEGIN;" in sql
    assert sql.endswith("COMMIT;")
    for table in (
        "sophia_build_manifest_heads",
        "sophia_build_registry",
        "sophia_build_operation_events",
        "sophia_build_acceptance_outbox",
        "sophia_build_mutation_transactions",
    ):
        assert f"CREATE TABLE IF NOT EXISTS public.{table}" in sql
        assert f"REVOKE ALL ON TABLE public.{table} FROM PUBLIC, anon, authenticated, service_role;" in sql
    assert "GRANT SELECT ON TABLE public.sophia_build_operation_events TO service_role;" in sql
    assert "GRANT SELECT ON TABLE public.sophia_build_registry TO service_role;" not in sql
    assert "FROM PUBLIC, anon, authenticated;" in sql
    assert "NOTIFY pgrst, 'reload schema';" in sql


def test_build_foundation_store_opens_circuit_after_missing_event_table(caplog) -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(404, request=request, json={"message": "not found"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    store = SupabaseBuildFoundationStore(
        BuildFoundationStoreConfig("https://example.supabase.co", "service-role"),
        client=client,
    )

    with pytest.raises(BuildFoundationStoreError):
        store.replay(build_id="build-1")
    with pytest.raises(BuildFoundationStoreError):
        store.replay(build_id="build-1")

    configure_default_event_sink(store)
    runtime = SimpleNamespace(
        context={"build_id": "build-1", "user_id": "user-1", "thread_id": "thread-1"},
        config={},
    )
    try:
        assert record_runtime_event(state={}, runtime=runtime, event_type="build.created") is None
        assert record_runtime_event(state={}, runtime=runtime, event_type="build.created") is None
    finally:
        configure_default_event_sink(None)

    assert requests == 1
    assert store.availability_status == "unavailable"
    assert caplog.text.count("Build foundation event store unavailable") == 1
    assert "[BuildEvent] persistence failed" not in caplog.text


def test_build_foundation_probe_requires_event_table_and_rpcs() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={"paths": {"/sophia_build_operation_events": {}}},
        )

    store = SupabaseBuildFoundationStore(
        BuildFoundationStoreConfig("https://example.supabase.co", "service-role"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert store.probe() is False
    assert store.availability_status == "unavailable"


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
