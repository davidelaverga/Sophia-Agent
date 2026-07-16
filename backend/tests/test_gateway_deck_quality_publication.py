from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI

from app.gateway.routers import builder_events as routes
from app.gateway.workers import deck_quality_publication as admission
from app.gateway.workers.builder_events import (
    get_builder_events_worker,
    install_builder_events_worker,
)
from app.gateway.workers.deck_quality_publication import (
    install_deck_quality_publication_store,
)
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_HMAC_SECRET_ENV,
    encode_builder_event_body,
    reset_builder_event_replay_guard_for_tests,
    signed_builder_event_headers,
)
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationRecord,
    PublicationRequest,
    PublicationState,
)
from deerflow.sophia.deck_quality.publisher import DeckQualityPublicationIntent
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock

_BUILDER_EVENT_SECRET = "builder-event-test-secret-" + "d" * 40


class _SignedBuilderEventAuth(httpx.Auth):
    requires_request_body = True

    def auth_flow(self, request: httpx.Request):
        if request.url.path == "/internal/deck-quality-publications":
            request.headers.update(signed_builder_event_headers(request.content))
        yield request


@pytest.fixture(autouse=True)
def _builder_event_auth(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _BUILDER_EVENT_SECRET)
    reset_builder_event_replay_guard_for_tests()
    yield
    reset_builder_event_replay_guard_for_tests()


def _instrument() -> QualityInstrumentLock:
    return QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash="a" * 64,
        prompt_hashes={"blind_visual": "b" * 64, "plan_realization": "c" * 64},
        judge_plan_hash="d" * 64,
        judge_profile_version="v1",
        evidence_preprocessor_version="deck-evidence-v2",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={
            "blind_visual": "v4",
            "mechanical": "v1",
            "plan_realization": "v4",
        },
        adjudication_policy_hash="e" * 64,
    )


def _event(
    instrument: QualityInstrumentLock,
    *,
    user_id: str = "canary-user",
) -> dict[str, object]:
    artifact_version_id = "artifact-version-1"
    now = datetime.now(UTC)
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact_version_id,
        campaign_id="DQ-1",
        instrument=instrument,
    )
    intent = DeckQualityPublicationIntent(
        quality_run_id=quality_run_id,
        instrument_identity_hash=canonical_sha256(instrument),
        user_id=user_id,
        thread_id="parent-thread",
        task_id="builder-task",
        build_id="build-1",
        builder_run_id="builder-run-1",
        parent_builder_trace_id="builder-trace-1",
        logical_artifact_id="artifact-1",
        artifact_version_id=artifact_version_id,
        manifest_revision=4,
        artifact_virtual_path="/mnt/user-data/outputs/deck.pptx",
        artifact_storage_object_path=(f"artifacts/{user_id}/parent-thread/foundation/.builder/builds/build-1/deck.pptx"),
        artifact_sha256="f" * 64,
        publication_deadline_at=now + timedelta(minutes=3),
        quality_run_deadline_at=now + timedelta(minutes=15),
    )
    return {
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "builder-run-1",
        "trace_id": "companion-diagnostic-trace",
        "builder_trace_root_run_id": "builder-trace-1",
        "agent_name": "sophia_builder",
        "status": "success",
        "task_type": "presentation",
        "task_brief": "Build the canary deck.",
        "artifact_path": "mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_is_fallback": False,
        "storage_provider": "supabase",
        "storage_status": "available",
        "storage_object_path": intent.artifact_storage_object_path,
        "artifact_sha256": intent.artifact_sha256,
        "manifest_revision": intent.manifest_revision,
        "deck_build_id": intent.build_id,
        "logical_artifact_id": intent.logical_artifact_id,
        "current_artifact_version_id": intent.artifact_version_id,
        "mechanical_gate_results": {"passed": True},
        "user_id": user_id,
        "deck_quality_publication_intent": intent.model_dump(mode="json"),
    }


def _delivery_event(event: dict[str, object]) -> dict[str, object]:
    delivery = dict(event)
    delivery.pop("deck_quality_publication_intent", None)
    return delivery


def _publication_envelope(event: dict[str, object]) -> dict[str, object]:
    fields = (
        "thread_id",
        "task_id",
        "run_id",
        "builder_trace_root_run_id",
        "user_id",
        "status",
        "task_type",
        "artifact_path",
        "artifact_type",
        "artifact_ext",
        "artifact_is_fallback",
        "storage_provider",
        "storage_status",
        "storage_object_path",
        "artifact_sha256",
        "manifest_revision",
        "deck_build_id",
        "logical_artifact_id",
        "current_artifact_version_id",
        "deck_quality_publication_intent",
    )
    mechanical = event.get("mechanical_gate_results")
    return {
        **{field: event.get(field) for field in fields},
        "mechanical_gate_results": {"passed": (mechanical.get("passed") is True if isinstance(mechanical, dict) else False)},
    }


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        auth=_SignedBuilderEventAuth(),
    )


def _record(request: PublicationRequest) -> PublicationRecord:
    instrument = request.instrument
    requested_at = request.deadline_at - timedelta(minutes=1)
    return PublicationRecord.model_validate(
        {
            "quality_run_id": request.quality_run_id,
            "campaign_id": request.campaign_id,
            "scope_kind": "canary",
            "instrument_schema_version": instrument.schema_version,
            "instrument_identity_hash": request.instrument_identity_hash,
            "rubric_version": instrument.rubric_version,
            "rubric_hash": instrument.rubric_hash,
            "prompt_hashes": instrument.prompt_hashes,
            "judge_plan_hash": instrument.judge_plan_hash,
            "judge_profile_version": instrument.judge_profile_version,
            "evidence_preprocessor_version": instrument.evidence_preprocessor_version,
            "judge_invoker_version": instrument.judge_invoker_version,
            "assessment_schema_versions": instrument.assessment_schema_versions,
            "adjudication_policy_hash": instrument.adjudication_policy_hash,
            "user_id": request.user_id,
            "thread_id": request.thread_id,
            "task_id": request.task_id,
            "build_id": request.build_id,
            "builder_run_id": request.builder_run_id,
            "parent_builder_trace_id": request.parent_builder_trace_id,
            "logical_artifact_id": request.logical_artifact_id,
            "artifact_version_id": request.artifact_version_id,
            "manifest_revision": request.manifest_revision,
            "artifact_object_path": request.artifact_object_path,
            "artifact_hash": request.artifact_hash,
            "source_pack_object_path": None,
            "source_pack_hash": None,
            "input_manifest_object_path": None,
            "input_manifest_hash": None,
            "state": PublicationState.AWAITING_INPUTS,
            "attempt_count": 0,
            "max_attempts": request.max_attempts,
            "error_count": 0,
            "next_attempt_at": requested_at,
            "deadline_at": request.deadline_at,
            "quality_max_attempts": request.quality_max_attempts,
            "quality_run_deadline_at": request.quality_run_deadline_at,
            "lease_owner": None,
            "lease_epoch": 0,
            "lease_expires_at": None,
            "claim_token": None,
            "last_operation_kind": None,
            "last_operation_token": None,
            "last_operation_hash": None,
            "last_error_code": None,
            "last_error_stage": None,
            "last_error_at": None,
            "requested_at": requested_at,
            "started_at": None,
            "updated_at": requested_at,
            "finished_at": None,
        }
    )


class _Store:
    def __init__(
        self,
        *,
        request_error: Exception | None = None,
        reconcile: bool = False,
    ) -> None:
        self.request_error = request_error
        self.reconcile = reconcile
        self.requests: list[PublicationRequest] = []
        self.get_calls: list[str] = []

    async def request(self, request: PublicationRequest) -> PublicationRecord:
        self.requests.append(request)
        if self.request_error is not None:
            raise self.request_error
        return _record(request)

    async def get(self, quality_run_id: str) -> PublicationRecord | None:
        self.get_calls.append(quality_run_id)
        if self.reconcile and self.requests:
            return _record(self.requests[-1])
        return None


def _app(store: _Store) -> FastAPI:
    app = FastAPI()
    install_builder_events_worker(app, cache_ttl_seconds=60)
    install_deck_quality_publication_store(app, store)
    app.include_router(routes.internal_router)
    return app


def _configure_canary(
    monkeypatch: pytest.MonkeyPatch,
    instrument: QualityInstrumentLock,
) -> MagicMock:
    config = SimpleNamespace(
        deck_quality=DeckQualityConfig(
            enabled=True,
            mode="shadow",
            canary_user_ids={"canary-user"},
            max_quality_cost_usd=Decimal("0.60"),
        )
    )
    compile_mock = MagicMock(return_value=SimpleNamespace(lock=instrument))
    monkeypatch.setattr(admission, "get_app_config", lambda: config)
    monkeypatch.setattr(admission, "compile_runtime_instrument", compile_mock)
    return compile_mock


@pytest.mark.anyio
async def test_canary_intent_is_durably_requested_and_stripped_from_every_fanout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    persisted: list[dict[str, object]] = []
    registry: list[dict[str, object]] = []
    channel: list[dict[str, object]] = []
    canvas: list[dict[str, object]] = []
    wakeup: list[dict[str, object]] = []

    async def persist(payload: dict[str, object]) -> None:
        persisted.append(payload)

    async def publish_channel(payload: dict[str, object]) -> None:
        channel.append(payload)

    class _Canvas:
        async def publish_completion(self, payload: dict[str, object]) -> None:
            canvas.append(payload)

    class _Wakeup:
        async def wake(self, payload: dict[str, object]) -> None:
            wakeup.append(payload)

    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persist)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", registry.append)
    monkeypatch.setattr(routes, "get_builder_canvas_worker", lambda _app: _Canvas())
    monkeypatch.setattr(
        routes,
        "get_companion_wakeup_or_none",
        lambda _app: _Wakeup(),
    )
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        publish_channel,
    )

    event_payload = _event(instrument)
    async with _client(app) as client:
        delivery_response = await client.post(
            "/internal/builder-events",
            json=_delivery_event(event_payload),
        )
        publication_response = await client.post(
            "/internal/deck-quality-publications",
            json=_publication_envelope(event_payload),
        )
    await asyncio.sleep(0)

    assert delivery_response.status_code == 202
    assert delivery_response.json() == {"delivered_subscribers": 0}
    assert publication_response.status_code == 202
    assert len(store.requests) == 1
    request = store.requests[0]
    intent = DeckQualityPublicationIntent.model_validate(event_payload["deck_quality_publication_intent"])
    assert request.quality_run_id == intent.quality_run_id
    assert request.deadline_at == intent.publication_deadline_at
    assert request.quality_run_deadline_at == intent.quality_run_deadline_at
    assert request.artifact_object_path == intent.artifact_storage_object_path
    assert request.artifact_hash == intent.artifact_sha256
    assert request.parent_builder_trace_id == "builder-trace-1"
    assert request.parent_builder_trace_id != event_payload["trace_id"]
    assert publication_response.json() == {
        "deck_quality_publication_ack": {
            "schema_version": "deck-quality-publication-ack/v1",
            "quality_run_id": intent.quality_run_id,
            "state": "requested",
        },
    }

    last = await get_builder_events_worker(app).get_last("parent-thread")
    for delivered in (*persisted, *registry, *channel, *canvas, *wakeup, last):
        assert delivered is not None
        assert "deck_quality_publication_intent" not in delivered
    assert len(persisted) == len(registry) == len(channel) == len(canvas) == 1
    assert len(wakeup) == 1
    assert "f" * 64 not in publication_response.text


@pytest.mark.anyio
async def test_noncanary_or_missing_intent_makes_zero_publication_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    compile_mock = _configure_canary(monkeypatch, instrument)
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", AsyncMock())
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        AsyncMock(),
    )

    noncanary = _event(instrument, user_id="ordinary-user")
    noncanary["deck_quality_publication_intent"] = {"untrusted": "private-value-must-be-stripped"}
    ordinary = _delivery_event(noncanary)
    disabled_canary = _delivery_event(_event(instrument))

    async with _client(app) as client:
        # A legacy/full terminal request is still delivery-only and strips the
        # intent; producer-side tests lock that new requests omit it entirely.
        first = await client.post("/internal/builder-events", json=noncanary)
        second = await client.post("/internal/builder-events", json=ordinary)
        monkeypatch.setattr(
            admission,
            "get_app_config",
            lambda: SimpleNamespace(deck_quality=DeckQualityConfig()),
        )
        third = await client.post("/internal/builder-events", json=disabled_canary)

    assert first.status_code == second.status_code == third.status_code == 202
    for response in (first, second, third):
        assert response.json() == {"delivered_subscribers": 0}
    assert store.requests == []
    assert store.get_calls == []
    assert compile_mock.call_count == 0
    cached = await get_builder_events_worker(app).get_last("parent-thread")
    assert cached is not None
    assert "deck_quality_publication_intent" not in cached


@pytest.mark.anyio
async def test_terminal_delivery_does_not_require_publication_hmac_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    persisted = AsyncMock()
    channel = AsyncMock()
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/builder-events",
            json=_delivery_event(_event(instrument)),
        )

    assert response.status_code == 202
    persisted.assert_awaited_once()
    channel.assert_awaited_once()
    assert store.requests == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("status", "error"),
        ("artifact_path", "mnt/user-data/outputs/deck.pdf"),
        ("artifact_type", "document"),
        ("artifact_ext", "pdf"),
        ("artifact_is_fallback", True),
        ("storage_provider", "local"),
        ("storage_status", "missing"),
        ("mechanical_gate_results", {"passed": False}),
        ("storage_object_path", None),
        ("artifact_sha256", None),
    ),
)
async def test_ineligible_trigger_field_makes_zero_publication_calls(
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: object,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    compile_mock = _configure_canary(monkeypatch, instrument)
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", AsyncMock())
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        AsyncMock(),
    )
    payload = _event(instrument)
    envelope = _publication_envelope(payload)
    envelope[field] = value

    async with _client(app) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            json=envelope,
        )

    assert response.status_code == 400
    assert response.content == b""
    assert store.requests == []
    assert store.get_calls == []
    assert compile_mock.call_count == 0


@pytest.mark.anyio
async def test_ambiguous_request_reconciles_exact_existing_publication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store(request_error=RuntimeError("lost response"), reconcile=True)
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", AsyncMock())
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        AsyncMock(),
    )

    async with _client(app) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            json=_publication_envelope(_event(instrument)),
        )

    assert response.status_code == 202
    assert store.get_calls == [store.requests[0].quality_run_id]
    assert response.json()["deck_quality_publication_ack"] == {
        "schema_version": "deck-quality-publication-ack/v1",
        "quality_run_id": store.requests[0].quality_run_id,
        "state": "reconciled",
    }


@pytest.mark.anyio
async def test_publication_retries_do_not_replay_terminal_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    secret = "private-supabase-response"
    store = _Store(request_error=RuntimeError(secret))
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    persisted = AsyncMock()
    channel = AsyncMock()
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel,
    )

    event = _event(instrument)
    async with _client(app) as client:
        delivery = await client.post(
            "/internal/builder-events",
            json=_delivery_event(event),
        )
        responses = [
            await client.post(
                "/internal/deck-quality-publications",
                json=_publication_envelope(event),
            )
            for _ in range(4)
        ]

    assert delivery.status_code == 202
    for response in responses:
        assert response.status_code == 503
        assert response.headers["retry-after"] == "5"
        assert response.content == b""
        assert secret not in response.text
    assert persisted.await_count == 1
    assert channel.await_count == 1
    cached = await get_builder_events_worker(app).get_last("parent-thread")
    assert cached is not None
    assert "deck_quality_publication_intent" not in cached
    assert len(store.requests) == 4
    assert store.get_calls == [request.quality_run_id for request in store.requests]


@pytest.mark.anyio
async def test_canary_identity_mismatch_is_not_persisted_and_intent_is_stripped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    persisted = AsyncMock()
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        AsyncMock(),
    )
    payload = _event(instrument)
    payload["artifact_sha256"] = "0" * 64

    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)

    async with _client(app) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            json=_publication_envelope(payload),
        )

    assert response.status_code == 503
    assert store.requests == []
    assert store.get_calls == []
    persisted.assert_not_awaited()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "builder_trace_root_run_id",
    [None, "different-builder-trace-root"],
    ids=["missing", "mismatched"],
)
async def test_canary_requires_exact_builder_trace_root_identity(
    monkeypatch: pytest.MonkeyPatch,
    builder_trace_root_run_id: str | None,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", AsyncMock())
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda _payload: None)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        AsyncMock(),
    )
    payload = _event(instrument)
    if builder_trace_root_run_id is None:
        payload.pop("builder_trace_root_run_id")
    else:
        payload["builder_trace_root_run_id"] = builder_trace_root_run_id

    async with _client(app) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            json=_publication_envelope(payload),
        )

    assert response.status_code == (400 if builder_trace_root_run_id is None else 503)
    assert store.requests == []
    assert store.get_calls == []


@pytest.mark.anyio
async def test_publication_auth_rejects_unauthenticated_tampered_and_replayed_requests(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    persisted = AsyncMock()
    channel = AsyncMock()
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", MagicMock())
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel,
    )

    publication = _publication_envelope(_event(instrument))
    publication_body = encode_builder_event_body(publication)
    headers = signed_builder_event_headers(publication_body)
    private_body = encode_builder_event_body(
        {**publication, "private_body_marker": "private-body-marker"}
    )
    private_headers = signed_builder_event_headers(private_body)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        unsigned_publication = await client.post(
            "/internal/deck-quality-publications",
            content=private_body,
        )
        tampered = await client.post(
            "/internal/deck-quality-publications",
            content=private_body + b" ",
            headers=private_headers,
        )
        accepted = await client.post(
            "/internal/deck-quality-publications",
            content=publication_body,
            headers=headers,
        )
        replayed = await client.post(
            "/internal/deck-quality-publications",
            content=publication_body,
            headers=headers,
        )

    assert unsigned_publication.status_code == tampered.status_code == replayed.status_code == 401
    assert unsigned_publication.content == tampered.content == replayed.content == b""
    assert accepted.status_code == 202
    assert len(store.requests) == 1
    persisted.assert_not_awaited()
    channel.assert_not_awaited()
    assert "private-body-marker" not in caplog.text
    assert _BUILDER_EVENT_SECRET not in caplog.text


@pytest.mark.anyio
async def test_publication_body_is_bounded_before_authentication_or_persistence() -> None:
    store = _Store()
    app = _app(store)
    body = b"x" * (routes._MAX_DECK_QUALITY_PUBLICATION_BODY_BYTES + 1)
    headers = signed_builder_event_headers(body)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/internal/deck-quality-publications",
            content=body,
            headers=headers,
        )

    assert response.status_code == 413
    assert response.content == b""
    assert store.requests == []
    assert store.get_calls == []


@pytest.mark.anyio
async def test_publication_endpoint_rejects_full_terminal_payload_without_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instrument = _instrument()
    store = _Store()
    app = _app(store)
    _configure_canary(monkeypatch, instrument)
    persisted = AsyncMock()
    channel = AsyncMock()
    monkeypatch.setattr(routes, "_persist_builder_terminal_state", persisted)
    monkeypatch.setattr(
        "app.channels.message_bus.publish_builder_completion",
        channel,
    )

    async with _client(app) as client:
        full_terminal_to_publication = await client.post(
            "/internal/deck-quality-publications",
            json=_event(instrument),
        )

    assert full_terminal_to_publication.status_code == 400
    assert full_terminal_to_publication.content == b""
    assert store.requests == []
    persisted.assert_not_awaited()
    channel.assert_not_awaited()
