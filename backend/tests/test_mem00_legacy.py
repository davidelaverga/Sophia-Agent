from __future__ import annotations

from datetime import UTC, datetime

import pytest

from deerflow.sophia.memory_governance.legacy import (
    LegacyEvidence,
    classify_legacy_evidence,
    inventory_legacy_artifacts,
    inventory_legacy_subject,
)
from deerflow.sophia.memory_governance.mem0_projection_adapter import (
    Mem0ProjectionAdapter,
)
from deerflow.sophia.memory_governance.models import MemoryContract
from deerflow.sophia.memory_governance.service import (
    CanonicalMemoryService,
    MemoryProviderContract,
)


@pytest.fixture(autouse=True)
def _reference_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "l" * 32)
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")


@pytest.mark.parametrize(
    ("evidence", "destination"),
    [
        (
            LegacyEvidence(
                exact_owner_provenance=True,
                durable_user_review_receipt_ref="hmac-sha256:receipt:x",
            ),
            "canonical_import_eligible",
        ),
        (
            LegacyEvidence(
                exact_owner_provenance=True,
                exact_pending_review=True,
                trustworthy_session_source=True,
            ),
            "candidate_ledger_eligible",
        ),
        (
            LegacyEvidence(exact_owner_provenance=True, rejected_evidence=True),
            "ineligible_purge_obligation",
        ),
        (LegacyEvidence(local_only=True), "legacy_quarantined"),
        (LegacyEvidence(exact_owner_provenance=True), "legacy_quarantined"),
    ],
)
def test_legacy_classification_requires_exact_authoritative_evidence(evidence: LegacyEvidence, destination: str) -> None:
    assert classify_legacy_evidence(evidence)[0] == destination


def test_provider_approved_metadata_alone_is_quarantined_and_report_is_content_free() -> None:
    class Client:
        def get_all(self, *, filters, page, page_size):
            assert filters == {"user_id": "legacy-subject"}
            if page == 1:
                return {
                    "results": [
                        {
                            "id": "provider-1",
                            "memory": "RAW CONTENT MUST NOT ESCAPE",
                            "metadata": {"status": "approved"},
                        }
                    ]
                }
            return {"results": []}

    report = inventory_legacy_subject(
        adapter=Mem0ProjectionAdapter(client=Client()),
        provider_subject="legacy-subject",
        provider_project="existing-project",
        environment="production",
        page_size=1,
    )

    assert report.pagination_complete
    assert report.page_count == 2
    assert report.record_count == 1
    assert report.items[0].destination == "legacy_quarantined"
    assert report.items[0].metadata_state == "approved"
    assert "provider-1" not in repr(report)
    assert "RAW CONTENT" not in repr(report)


def test_incomplete_pagination_is_never_reported_as_zero_or_complete() -> None:
    class Client:
        def get_all(self, *, filters, page, page_size):
            if page == 1:
                return {"results": [{"id": "provider-1", "metadata": {}}]}
            raise TimeoutError("provider unavailable")

    report = inventory_legacy_subject(
        adapter=Mem0ProjectionAdapter(client=Client()),
        provider_subject="legacy-subject",
        provider_project="existing-project",
        environment="production",
        page_size=1,
    )

    assert not report.pagination_complete
    assert report.record_count == 1
    assert report.safe_error_code == "mem0_pagination_unavailable"


def test_approved_legacy_import_binds_exact_id_and_authoritative_evidence() -> None:
    class Store:
        def __init__(self) -> None:
            self.payload = None

        def manual_create(self, **payload):
            self.payload = payload
            return "receipt"

        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.v1",
                mode="shadow",
                updated_at=datetime.now(UTC),
            )

    store = Store()
    service = CanonicalMemoryService(
        owner_id="owner-1",
        store=store,
        provider=MemoryProviderContract("mem0", "production", "existing-project"),
    )
    receipt = service.import_approved_legacy(
        provider_memory_id="provider-exact-id",
        approval_evidence_ref="hmac-sha256:review-receipt:" + "a" * 64,
        content="Approved content",
        category="fact",
        scope="global",
        user_tier="none",
        idempotency_key="legacy-import-operation",
    )

    assert receipt == "receipt"
    assert store.payload["p_actor_kind"] == "legacy_import"
    assert store.payload["p_request_digest"].startswith("hmac-sha256:request:")
    assert "provider-exact-id" not in store.payload["p_request_digest"]


def test_legacy_import_rejects_non_keyed_approval_claim() -> None:
    service = CanonicalMemoryService(
        owner_id="owner-1",
        store=object(),
        provider=MemoryProviderContract("mem0", "production", "existing-project"),
    )
    with pytest.raises(ValueError, match="legacy_approval_evidence_invalid"):
        service.import_approved_legacy(
            provider_memory_id="provider-exact-id",
            approval_evidence_ref="provider-approved-metadata",
            content="Not authoritative",
            category="fact",
            scope="global",
            user_tier="none",
            idempotency_key="legacy-import-operation",
        )


def test_local_artifact_inventory_never_exposes_paths_or_contents(tmp_path) -> None:
    sidecar = tmp_path / "private-user" / "review.json"
    sidecar.parent.mkdir()
    sidecar.write_text("RAW SIDECAR CONTENT")

    report = inventory_legacy_artifacts((("review_sidecar", tmp_path),))

    assert report.scan_complete
    assert report.counts == {"review_sidecar": 1}
    assert "private-user" not in repr(report)
    assert "RAW SIDECAR" not in repr(report)
