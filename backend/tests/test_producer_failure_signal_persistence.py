from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_quality.persistence import (
    DeckQualityPersistenceProtocolError,
)
from deerflow.sophia.deck_quality.producer_failure_signal import (
    ProducerFailureSignal,
    ProducerFailureSignalReadiness,
    SupabaseProducerFailureSignalStore,
)


class _Rpc:
    def __init__(self, response: object) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.probed = False
        self.closed = False

    async def call(
        self,
        operation: str,
        payload: dict[str, object],
    ) -> object:
        self.calls.append((operation, dict(payload)))
        return self.response

    async def probe(self) -> None:
        self.probed = True

    async def aclose(self) -> None:
        self.closed = True


def _signal() -> ProducerFailureSignal:
    return ProducerFailureSignal(
        candidate_digest="a" * 64,
        user_id="canary-user",
        failure_stage="producer_bundle",
        upstream_failure_code="producer_bundle_unavailable",
        quality_run_id="quality_" + "b" * 64,
    )


def test_signal_hash_and_rpc_payload_are_stable_and_content_free() -> None:
    first = _signal()
    second = ProducerFailureSignal.model_validate(
        dict(reversed(list(first.model_dump().items())))
    )

    assert first.signal_hash == second.signal_hash
    assert first.rpc_payload()["p_signal_hash"] == first.signal_hash
    joined = repr(first.rpc_payload()).casefold()
    for forbidden in (
        "artifact_url",
        "source_bytes",
        "prompt",
        "api_key",
        "model_output",
        "task_brief",
    ):
        assert forbidden not in joined


def test_signal_rejects_stage_code_mismatch_and_extra_content() -> None:
    values = _signal().model_dump()
    values["upstream_failure_code"] = "instrument_invalid"
    with pytest.raises(ValidationError, match="stage/code mismatch"):
        ProducerFailureSignal.model_validate(values)

    values = _signal().model_dump()
    values["artifact_url"] = "https://must-not-be-accepted.test/deck.pptx"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ProducerFailureSignal.model_validate(values)


@pytest.mark.anyio
async def test_store_records_exact_fingerprint_and_probes() -> None:
    signal = _signal()
    rpc = _Rpc(
        [
            {
                "outcome": "created",
                "candidate_digest": signal.candidate_digest,
                "signal_hash": signal.signal_hash,
                "persisted_count": 1,
                "unresolved_count": 1,
                "conflict_count": 0,
                "oldest_unresolved_at": "2026-07-18T00:00:00Z",
            }
        ]
    )
    store = SupabaseProducerFailureSignalStore(rpc)

    await store.probe()
    receipt = await store.record(signal)
    await store.aclose()

    assert rpc.probed is True
    assert rpc.closed is True
    assert receipt.outcome == "created"
    assert rpc.calls == [
        (
            "sophia_record_deck_quality_producer_failure_signal",
            signal.rpc_payload(),
        )
    ]


@pytest.mark.anyio
async def test_store_rejects_mismatched_nonconflict_receipt() -> None:
    signal = _signal()
    rpc = _Rpc(
        [
            {
                "outcome": "replayed",
                "candidate_digest": signal.candidate_digest,
                "signal_hash": "c" * 64,
                "persisted_count": 1,
                "unresolved_count": 1,
                "conflict_count": 0,
                "oldest_unresolved_at": "2026-07-18T00:00:00Z",
            }
        ]
    )

    with pytest.raises(
        DeckQualityPersistenceProtocolError,
        match="receipt identity mismatch",
    ):
        await SupabaseProducerFailureSignalStore(rpc).record(signal)


def test_readiness_never_clears_an_unresolved_signal_on_empty_state() -> None:
    unresolved = ProducerFailureSignalReadiness(
        persisted_count=1,
        unresolved_count=1,
        conflict_count=2,
        oldest_unresolved_at=datetime(2026, 7, 18, tzinfo=UTC),
    )
    empty = ProducerFailureSignalReadiness(
        persisted_count=0,
        unresolved_count=0,
        conflict_count=0,
        oldest_unresolved_at=None,
    )

    assert unresolved.component()["status"] == "degraded"
    assert unresolved.component()["counts"] == {
        "persisted": 1,
        "unresolved": 1,
        "conflicts": 2,
    }
    assert unresolved.component()["transport"] == {"status": "ready"}
    assert empty.component() == {
        "status": "ready",
        "counts": {"persisted": 0, "unresolved": 0, "conflicts": 0},
        "transport": {"status": "ready"},
    }
