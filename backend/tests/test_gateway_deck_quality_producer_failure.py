from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI

from app.gateway.routers import builder_events as routes
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_HMAC_SECRET_ENV,
    BUILDER_EVENT_PROBE_ACK_HEADER,
    builder_event_canary_scope_proof,
    encode_builder_event_body,
    reset_builder_event_replay_guard_for_tests,
    signed_builder_event_headers,
    verify_builder_event_probe_ack,
)
from deerflow.sophia.deck_quality.producer_failure_signal import (
    MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES,
    ProducerFailureSignal,
    ProducerFailureSignalReceipt,
    producer_failure_hmac_probe_signal,
)

_SECRET = "dq1-producer-failure-endpoint-" + "a" * 40


class _SignalStore:
    def __init__(self) -> None:
        self.records: dict[str, str] = {}
        self.calls = 0
        self.conflicts = 0

    async def record(
        self,
        signal: ProducerFailureSignal,
    ) -> ProducerFailureSignalReceipt:
        self.calls += 1
        existing = self.records.get(signal.candidate_digest)
        if existing is None:
            self.records[signal.candidate_digest] = signal.signal_hash
            outcome = "created"
            receipt_hash = signal.signal_hash
        elif existing == signal.signal_hash:
            outcome = "replayed"
            receipt_hash = existing
        else:
            outcome = "conflict"
            receipt_hash = existing
            self.conflicts += 1
        return ProducerFailureSignalReceipt(
            outcome=outcome,
            candidate_digest=signal.candidate_digest,
            signal_hash=receipt_hash,
            persisted_count=len(self.records),
            unresolved_count=len(self.records),
            conflict_count=self.conflicts,
            oldest_unresolved_at=datetime(2026, 7, 18, tzinfo=UTC),
        )


@pytest.fixture(autouse=True)
def _auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    reset_builder_event_replay_guard_for_tests()
    monkeypatch.setattr(
        routes,
        "get_app_config",
        lambda: type(
            "Config",
            (),
            {
                "deck_quality": DeckQualityConfig(
                    enabled=True,
                    mode="shadow",
                    canary_user_ids={"canary-user"},
                    max_quality_cost_usd="0.60",
                )
            },
        )(),
    )


def _app(store: _SignalStore) -> FastAPI:
    app = FastAPI()
    routes.install_producer_failure_signal_store(app, store)
    app.include_router(routes.internal_router)
    return app


def _wire(
    signal: ProducerFailureSignal,
    *,
    nonce: str,
) -> tuple[bytes, dict[str, str]]:
    body = encode_builder_event_body(signal.model_dump(mode="json"))
    return body, signed_builder_event_headers(body, nonce=nonce)


@pytest.mark.anyio
async def test_reserved_hmac_probe_is_side_effect_free_for_all_auth_outcomes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _SignalStore()
    app = _app(store)
    initial_readiness = {
        "status": "ready",
        "counts": {"persisted": 0, "unresolved": 0, "conflicts": 0},
        "transport": {"status": "ready"},
    }
    routes.set_producer_failure_signal_readiness(app, initial_readiness)
    signal = producer_failure_hmac_probe_signal()
    body, valid_headers = _wire(signal, nonce="a" * 32)

    monkeypatch.setenv(
        BUILDER_EVENT_HMAC_SECRET_ENV,
        "intentionally-mismatched-probe-secret-" + "z" * 40,
    )
    _, mismatch_headers = _wire(signal, nonce="b" * 32)
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    _, unavailable_headers = _wire(signal, nonce="c" * 32)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        matched = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=valid_headers,
        )
        mismatched = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=mismatch_headers,
        )
        monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
        unavailable = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=unavailable_headers,
        )

    assert (
        matched.status_code,
        mismatched.status_code,
        unavailable.status_code,
    ) == (403, 401, 503)
    assert matched.content == mismatched.content == unavailable.content == b""
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    assert verify_builder_event_probe_ack(body, matched.headers) is None
    assert BUILDER_EVENT_PROBE_ACK_HEADER not in mismatched.headers
    assert BUILDER_EVENT_PROBE_ACK_HEADER not in unavailable.headers
    assert store.calls == 0
    assert routes.get_producer_failure_signal_readiness(app) == (
        initial_readiness
    )


@pytest.mark.anyio
async def test_authenticated_probe_requires_exact_keyed_canary_scope() -> None:
    store = _SignalStore()
    app = _app(store)
    matching = producer_failure_hmac_probe_signal(
        canary_scope_proof=builder_event_canary_scope_proof(
            {"canary-user"}
        )
    )
    mismatched = producer_failure_hmac_probe_signal(
        canary_scope_proof=builder_event_canary_scope_proof(
            {"different-synthetic-canary"}
        )
    )
    matched_body, matched_headers = _wire(
        matching,
        nonce="d" * 32,
    )
    mismatched_body, mismatched_headers = _wire(
        mismatched,
        nonce="e" * 32,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        matched = await client.post(
            "/internal/deck-quality-producer-failures",
            content=matched_body,
            headers=matched_headers,
        )
        mismatch = await client.post(
            "/internal/deck-quality-producer-failures",
            content=mismatched_body,
            headers=mismatched_headers,
        )

    assert (matched.status_code, mismatch.status_code) == (403, 409)
    assert matched.content == mismatch.content == b""
    assert verify_builder_event_probe_ack(
        matched_body,
        matched.headers,
    ) is None
    assert BUILDER_EVENT_PROBE_ACK_HEADER not in mismatch.headers
    assert store.calls == 0


@pytest.mark.anyio
async def test_exact_signal_is_durable_and_semantic_response_loss_replay_is_safe() -> None:
    store = _SignalStore()
    app = _app(store)
    signal = ProducerFailureSignal(
        candidate_digest="a" * 64,
        user_id="canary-user",
        failure_stage="producer_bundle",
        upstream_failure_code="producer_bundle_unavailable",
        quality_run_id="quality_" + "b" * 64,
    )
    body, first_headers = _wire(signal, nonce="1" * 32)
    _, replay_headers = _wire(signal, nonce="2" * 32)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        first = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=first_headers,
        )
        replay = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=replay_headers,
        )

    assert (first.status_code, replay.status_code) == (202, 202)
    assert first.content == replay.content == b""
    assert store.calls == 2
    assert store.records == {signal.candidate_digest: signal.signal_hash}
    assert routes.get_producer_failure_signal_readiness(app) == {
        "status": "degraded",
        "reason": "producer_failure_signal_unresolved",
        "counts": {"persisted": 1, "unresolved": 1, "conflicts": 0},
        "transport": {"status": "ready"},
        "oldest_unresolved_at": "2026-07-18T00:00:00+00:00",
    }


@pytest.mark.anyio
async def test_same_authenticated_nonce_is_rejected_before_second_side_effect() -> None:
    store = _SignalStore()
    app = _app(store)
    signal = ProducerFailureSignal(
        candidate_digest="c" * 64,
        user_id="canary-user",
        failure_stage="instrument",
        upstream_failure_code="instrument_invalid",
    )
    body, headers = _wire(signal, nonce="3" * 32)
    _, recovery_headers = _wire(signal, nonce="9" * 32)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        first = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=headers,
        )
        replay = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=headers,
        )
        readiness_after_untrusted_replay = (
            routes.get_producer_failure_signal_readiness(app)
        )
        recovered = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=recovery_headers,
        )

    assert first.status_code == 202
    assert replay.status_code == 401
    assert recovered.status_code == 202
    assert replay.content == b""
    assert store.calls == 2
    assert readiness_after_untrusted_replay["transport"] == {
        "status": "ready"
    }
    readiness = routes.get_producer_failure_signal_readiness(app)
    assert readiness["status"] == "degraded"
    assert readiness["reason"] == "producer_failure_signal_unresolved"
    assert readiness["transport"] == {"status": "ready"}


@pytest.mark.anyio
async def test_semantic_conflict_is_fenced_and_readiness_degrading() -> None:
    store = _SignalStore()
    app = _app(store)
    first_signal = ProducerFailureSignal(
        candidate_digest="d" * 64,
        user_id="canary-user",
        failure_stage="instrument",
        upstream_failure_code="instrument_invalid",
    )
    conflicting_signal = ProducerFailureSignal(
        candidate_digest=first_signal.candidate_digest,
        user_id="canary-user",
        failure_stage="candidate_metadata",
        upstream_failure_code="candidate_metadata_invalid",
    )
    first_body, first_headers = _wire(first_signal, nonce="4" * 32)
    conflict_body, conflict_headers = _wire(
        conflicting_signal,
        nonce="5" * 32,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        first = await client.post(
            "/internal/deck-quality-producer-failures",
            content=first_body,
            headers=first_headers,
        )
        conflict = await client.post(
            "/internal/deck-quality-producer-failures",
            content=conflict_body,
            headers=conflict_headers,
        )

    assert first.status_code == 202
    assert conflict.status_code == 409
    assert conflict.content == b""
    assert routes.get_producer_failure_signal_readiness(app)["counts"] == {
        "persisted": 1,
        "unresolved": 1,
        "conflicts": 1,
    }
    assert routes.get_producer_failure_signal_readiness(app)["reason"] == (
        "producer_failure_signal_conflict"
    )


@pytest.mark.anyio
async def test_noncanary_malformed_and_oversized_requests_have_no_side_effect(
) -> None:
    store = _SignalStore()
    app = _app(store)
    noncanary = ProducerFailureSignal(
        candidate_digest="e" * 64,
        user_id="ordinary-user",
        failure_stage="instrument",
        upstream_failure_code="instrument_invalid",
    )
    noncanary_body, noncanary_headers = _wire(noncanary, nonce="6" * 32)
    malformed = encode_builder_event_body({"campaign_id": "DQ-1"})
    malformed_headers = signed_builder_event_headers(
        malformed,
        nonce="7" * 32,
    )
    trusted_invalid = encode_builder_event_body(
        {
            "schema_version": "deck-quality-producer-failure-signal/v1",
            "campaign_id": "DQ-1",
            "candidate_digest": "1" * 64,
            "user_id": "canary-user",
            "failure_code": "shadow_dispatch_unavailable",
            "failure_stage": "instrument",
            "upstream_failure_code": "candidate_metadata_invalid",
            "quality_run_id": None,
        }
    )
    trusted_invalid_headers = signed_builder_event_headers(
        trusted_invalid,
        nonce="c" * 32,
    )
    oversized = b"x" * (MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES + 1)
    oversized_headers = signed_builder_event_headers(
        oversized,
        nonce="8" * 32,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        forbidden = await client.post(
            "/internal/deck-quality-producer-failures",
            content=noncanary_body,
            headers=noncanary_headers,
        )
        invalid = await client.post(
            "/internal/deck-quality-producer-failures",
            content=malformed,
            headers=malformed_headers,
        )
        trusted_schema_failure = await client.post(
            "/internal/deck-quality-producer-failures",
            content=trusted_invalid,
            headers=trusted_invalid_headers,
        )
        too_large = await client.post(
            "/internal/deck-quality-producer-failures",
            content=oversized,
            headers=oversized_headers,
        )

    assert (
        forbidden.status_code,
        invalid.status_code,
        trusted_schema_failure.status_code,
        too_large.status_code,
    ) == (
        403,
        400,
        400,
        413,
    )
    assert (
        forbidden.content
        == invalid.content
        == trusted_schema_failure.content
        == too_large.content
        == b""
    )
    assert store.calls == 0
    assert routes.get_producer_failure_signal_readiness(app) == {
        "status": "degraded",
        "reason": "producer_failure_signal_schema_failed",
        "transport": {
            "status": "degraded",
            "reason": "producer_failure_signal_schema_failed",
        },
    }


@pytest.mark.anyio
async def test_auth_unavailable_and_store_failure_latch_transport_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FailingStore(_SignalStore):
        async def record(
            self,
            signal: ProducerFailureSignal,
        ) -> ProducerFailureSignalReceipt:
            del signal
            self.calls += 1
            raise RuntimeError("synthetic store failure")

    signal = ProducerFailureSignal(
        candidate_digest="f" * 64,
        user_id="canary-user",
        failure_stage="instrument",
        upstream_failure_code="instrument_invalid",
    )
    body, auth_headers = _wire(signal, nonce="a" * 32)
    auth_store = _SignalStore()
    auth_app = _app(auth_store)
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=auth_app),
        base_url="http://test",
    ) as client:
        auth_response = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=auth_headers,
        )

    assert auth_response.status_code == 503
    assert auth_store.calls == 0
    assert routes.get_producer_failure_signal_readiness(auth_app) == {
        "status": "degraded",
        "reason": "producer_failure_signal_auth_unavailable",
        "transport": {
            "status": "degraded",
            "reason": "producer_failure_signal_auth_unavailable",
            "error_type": "BuilderEventAuthenticationError",
        },
    }

    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    failing_store = _FailingStore()
    failing_app = _app(failing_store)
    _, store_headers = _wire(signal, nonce="b" * 32)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=failing_app),
        base_url="http://test",
    ) as client:
        store_response = await client.post(
            "/internal/deck-quality-producer-failures",
            content=body,
            headers=store_headers,
        )

    assert store_response.status_code == 503
    assert failing_store.calls == 1
    assert routes.get_producer_failure_signal_readiness(failing_app) == {
        "status": "degraded",
        "reason": "producer_failure_signal_persistence_failed",
        "transport": {
            "status": "degraded",
            "reason": "producer_failure_signal_persistence_failed",
            "error_type": "RuntimeError",
        },
    }
