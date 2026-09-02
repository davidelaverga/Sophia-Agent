from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from deerflow.sophia.memory_governance.faults import (
    MemoryFaultControlError,
    MemoryFaultController,
)
from deerflow.sophia.memory_governance.flags import (
    MemoryFeatureFlags,
    MemoryFlagConfigurationError,
    memory_feature_flags_for_owner,
)
from deerflow.sophia.memory_governance.identity import (
    MemoryIdentityConfigurationError,
    memory_certification_principal,
)
from deerflow.sophia.memory_governance.mem0_projection_adapter import (
    Mem0ContractError,
    Mem0ProjectionAdapter,
    ProviderMutationResult,
)
from deerflow.sophia.memory_governance.models import (
    CanonicalMemory,
    MemoryContract,
    ProjectionLease,
    ProviderHit,
    UserGovernance,
)
from deerflow.sophia.memory_governance.observability import (
    _export_langsmith,
    build_memory_langsmith_run_payload,
    counter_snapshot,
    emit_memory_event,
    reset_counters_for_test,
)
from deerflow.sophia.memory_governance.reader import GovernedMemoryReader
from deerflow.sophia.memory_governance.service import (
    CanonicalMemoryService,
    MemoryProviderContract,
)
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable


@pytest.fixture(autouse=True)
def _memory_ref_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "m" * 32)
    monkeypatch.setenv("MEM0_ORG_ID", "existing-org")
    monkeypatch.setenv("MEM0_PROJECT_ID", "existing-project")
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER_PROJECT", "existing-project")


def test_flags_are_default_closed_and_invalid_combinations_fail() -> None:
    assert not any(MemoryFeatureFlags.from_environ({}).as_dict().values())
    with pytest.raises(MemoryFlagConfigurationError):
        MemoryFeatureFlags.from_environ({"SOPHIA_MEMORY_GOVERNED_RUNTIME_READ": "true"})


def test_enabled_flags_require_exact_owner_cohort() -> None:
    enabled = {
        "SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE": "true",
        "SOPHIA_MEMORY_COHORT_PRINCIPALS": "mem00-cert-owner,approved-owner",
    }
    assert memory_feature_flags_for_owner("mem00-cert-owner", enabled).candidate_ledger_write
    assert not memory_feature_flags_for_owner("near-match-mem00-cert-owner", enabled).candidate_ledger_write
    with pytest.raises(MemoryFlagConfigurationError, match="memory_features_without_cohort"):
        memory_feature_flags_for_owner(
            "mem00-cert-owner",
            {"SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE": "true"},
        )


def test_provider_contract_prefers_the_explicit_mem00_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER", "mem0")
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_ENV", "legacy-shadow")
    monkeypatch.setenv("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH", "1")

    contract = MemoryProviderContract.from_environ()

    assert contract.environment == "production"
    assert contract.project == "existing-project"


def test_worker_requires_certification_principal_in_exact_cohort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.gateway.workers.memory_governance import (
        build_configured_memory_governance_worker,
    )

    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "mem00-cert-owner")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "different-owner")
    with pytest.raises(
        MemoryFlagConfigurationError,
        match="memory_certification_principal_not_in_cohort",
    ):
        build_configured_memory_governance_worker(flags=MemoryFeatureFlags(candidate_ledger_write=True))


def _enable_fault_plane(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "CANDIDATE_LEDGER_WRITE",
        "CANDIDATE_LEDGER_READ",
        "CANONICAL_POOL_READ",
        "PROVIDER_PROJECTION",
        "GOVERNED_RUNTIME_READ",
        "FAULT_INJECTION",
    ):
        monkeypatch.setenv(f"SOPHIA_MEMORY_{name}", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "mem00-cert-owner")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "mem00-cert-owner")


def test_fault_plane_is_exact_principal_one_shot_ttl_bounded_and_audited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_fault_plane(monkeypatch)

    class Store:
        consumed = False
        armed = None

        def arm_fault(self, **payload):
            self.armed = payload
            return {"mode": payload["mode"], "remaining_uses": 1}

        def consume_fault(self, **payload):
            if self.consumed:
                return False
            self.consumed = True
            return True

        def clear_faults(self, **payload):
            return 1

    store = Store()
    controller = MemoryFaultController(store=store)
    receipt = controller.arm(
        owner_id="mem00-cert-owner",
        mode="provider_commit_response_loss",
        ttl_seconds=60,
        operation_ref="synthetic-operation-1",
    )
    assert receipt == {"mode": "provider_commit_response_loss", "remaining_uses": 1}
    assert store.armed["audit_ref"].startswith("hmac-sha256:fault-operation:")
    assert controller.consume(
        owner_id="mem00-cert-owner",
        mode="provider_commit_response_loss",
    )
    assert not controller.consume(
        owner_id="mem00-cert-owner",
        mode="provider_commit_response_loss",
    )
    assert controller.clear(owner_id="mem00-cert-owner") == 1
    with pytest.raises(MemoryFaultControlError, match="memory_fault_principal_denied"):
        controller.arm(
            owner_id="ordinary-owner",
            mode="provider_timeout_before_effect",
            operation_ref="denied-operation",
        )
    with pytest.raises(MemoryFaultControlError, match="memory_fault_setting_invalid"):
        controller.arm(
            owner_id="mem00-cert-owner",
            mode="provider_timeout_before_effect",
            ttl_seconds=301,
            operation_ref="invalid-ttl",
        )


def test_generic_memory_containment_is_cohort_scoped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    from app.gateway.routers.memory import _reject_when_mem00_owns_sophia_memory

    for name in (
        "CANDIDATE_LEDGER_WRITE",
        "CANDIDATE_LEDGER_READ",
        "CANONICAL_POOL_READ",
        "PROVIDER_PROJECTION",
        "GOVERNED_RUNTIME_READ",
    ):
        monkeypatch.setenv(f"SOPHIA_MEMORY_{name}", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "mem00-cert-owner")

    _reject_when_mem00_owns_sophia_memory("ordinary-owner")
    with pytest.raises(HTTPException) as exc_info:
        _reject_when_mem00_owns_sophia_memory("mem00-cert-owner")
    assert exc_info.value.status_code == 410


def test_mem0_adapter_requires_exact_deployed_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("importlib.metadata.version", lambda _: "2.0.0")
    with pytest.raises(Mem0ContractError, match="mem0_sdk_version_mismatch"):
        Mem0ProjectionAdapter(client=object())


def test_mem0_adapter_pins_existing_org_and_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import patch

    monkeypatch.setenv("MEM0_API_KEY", "synthetic-key")
    with patch("mem0.MemoryClient") as client_type:
        adapter = Mem0ProjectionAdapter()
        adapter._get_client()
    client_type.assert_called_once_with(
        api_key="synthetic-key",
        host=None,
        org_id="existing-org",
        project_id="existing-project",
    )


def test_mem0_adapter_rejects_project_identity_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEM0_API_KEY", "synthetic-key")
    monkeypatch.setenv("MEM0_PROJECT_ID", "wrong-project")
    with pytest.raises(Mem0ContractError, match="mem0_provider_project_mismatch"):
        Mem0ProjectionAdapter()._get_client()


def test_mem0_adapter_initial_write_preserves_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")
    metadata = {"projection_operation_id": "op-1", "canonical_revision": 1}

    class Client:
        def add(self, **kwargs):
            assert kwargs["infer"] is False
            assert kwargs["metadata"] == metadata
            return {"results": [{"id": "provider-1", "memory": "untrusted"}]}

        def get(self, provider_id):
            assert provider_id == "provider-1"
            return {"id": provider_id, "memory": "untrusted", "metadata": metadata}

    result = Mem0ProjectionAdapter(client=Client()).project_revision(
        canonical_content="canonical",
        provider_subject="sophia-memory-v2-subject",
        metadata=metadata,
    )
    assert result.provider_ids == ("provider-1",)
    assert not hasattr(result, "content")


class _ReaderStore:
    def __init__(self, *, unavailable_after_search: bool = False, catalog_changes: bool = False) -> None:
        self.unavailable_after_search = unavailable_after_search
        self.catalog_changes = catalog_changes
        self.governance_calls = 0
        self.authorization_calls = 0
        self.prompt_payload = None

    def get_contract(self):
        return MemoryContract(
            contract_epoch=1,
            schema_version="mem00.v1",
            mode="enforced",
            updated_at=datetime.now(UTC),
        )

    def get_user_governance(self, user_id):
        self.governance_calls += 1
        if self.unavailable_after_search and self.governance_calls > 1:
            raise MemoryGovernanceUnavailable()
        return UserGovernance(
            user_id=user_id,
            user_catalog_generation=4 + int(self.catalog_changes and self.governance_calls > 1),
            user_revocation_epoch=2,
            provider_subject="sophia-memory-v2-subject",
        )

    def authorize_provider_hits(self, **kwargs):
        self.authorization_calls += 1
        return (
            (
                CanonicalMemory(
                    memory_id=uuid4(),
                    user_id=kwargs["user_id"],
                    lifecycle="active",
                    user_tier="conscious",
                    current_content_revision=3,
                    memory_governance_revision=7,
                    canonical_content="CANONICAL TEXT",
                    content_ref="hmac-sha256:canonical-content:x",
                    category="fact",
                    scope="global",
                ),
                0.91,
            ),
        ), {}

    def record_prompt_admission(self, payload):
        self.prompt_payload = payload
        return uuid4()


class _ReaderAdapter:
    def search_ids(self, **kwargs):
        return (ProviderHit(provider_memory_id="provider-1", score=0.91),)


def _reader(store):
    return GovernedMemoryReader(
        store=store,
        adapter=_ReaderAdapter(),
        provider=MemoryProviderContract("mem0", "production", "existing-project", 1),
        service_name="test",
    )


def test_governed_reader_discards_provider_text_and_renders_canonical_only() -> None:
    store = _ReaderStore()
    result = _reader(store).retrieve(owner_id="owner-1", caller="text", scope="global", query="provider poison")
    assert result.context_text == "- CANONICAL TEXT"
    assert "provider poison" not in result.context_text
    assert result.receipt.provider_hit_count == 1
    assert store.prompt_payload["authorized_manifest"][0]["content_revision"] == 3
    assert store.prompt_payload["provider_project"] == "existing-project"


def test_governed_reader_rejects_unknown_schema_before_provider_search() -> None:
    class WrongSchemaStore(_ReaderStore):
        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.unknown",
                mode="enforced",
                updated_at=datetime.now(UTC),
            )

    result = _reader(WrongSchemaStore()).retrieve(
        owner_id="owner-1",
        caller="text",
        scope="global",
        query="anything",
    )
    assert result.context_text == ""
    assert result.receipt.provider_status == "disabled"


def test_governance_outage_after_provider_search_fails_closed() -> None:
    result = _reader(_ReaderStore(unavailable_after_search=True)).retrieve(owner_id="owner-1", caller="voice", scope="global", query="anything")
    assert result.context_text == ""
    assert result.memories == ()
    assert result.receipt.safe_reason_code == "governance_unavailable_after_search"


def test_catalog_change_reauthorizes_every_hit_before_prompt_admission() -> None:
    store = _ReaderStore(catalog_changes=True)
    result = _reader(store).retrieve(owner_id="owner-1", caller="text", scope="global", query="anything")
    assert result.context_text == "- CANONICAL TEXT"
    assert store.authorization_calls == 2
    assert result.receipt.catalog_generation_checked == 5


def test_unexpected_governance_error_fails_closed() -> None:
    class BrokenStore(_ReaderStore):
        def authorize_provider_hits(self, **kwargs):
            raise ValueError("malformed database row")

    result = _reader(BrokenStore()).retrieve(owner_id="owner-1", caller="text", scope="global", query="anything")
    assert result.memories == ()
    assert result.receipt.safe_reason_code == "governance_unavailable_after_search"


def test_certification_principal_must_not_overlap_voice_lab(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "synthetic-principal")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "synthetic-principal")
    with pytest.raises(MemoryIdentityConfigurationError, match="memory_and_voice_lab_principals_overlap"):
        memory_certification_principal()


def test_mem0_adapter_pagination_is_complete_and_delete_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")

    class Client:
        def __init__(self):
            self.rows = [{"id": "keep", "metadata": {}}, {"id": "delete", "metadata": {}}]
            self.pages: list[int] = []
            self.deleted: list[str] = []

        def get_all(self, *, filters, page, page_size):
            assert filters == {"user_id": "subject"}
            self.pages.append(page)
            start = (page - 1) * page_size
            return {"results": self.rows[start : start + page_size]}

        def delete(self, memory_id):
            self.deleted.append(memory_id)
            self.rows = [row for row in self.rows if row["id"] != memory_id]

    client = Client()
    adapter = Mem0ProjectionAdapter(client=client)
    found = tuple(row["id"] for page in adapter._all_pages(provider_subject="subject", page_size=1) for row in page)
    assert found == ("keep", "delete")
    assert client.pages == [1, 2, 3]
    client.pages.clear()
    result = adapter.delete_ids(("delete", "already-absent"), provider_subject="subject")
    assert result.provider_ids == ("delete", "already-absent")
    assert client.deleted == ["delete"]
    assert client.pages == [1, 1]


def test_mem0_delete_does_not_treat_pagination_outage_as_absence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")

    class Client:
        def get_all(self, **kwargs):
            raise TimeoutError("provider unavailable")

    with pytest.raises(Mem0ContractError, match="mem0_pagination_unavailable"):
        Mem0ProjectionAdapter(client=Client()).delete_ids(("unknown",), provider_subject="subject")


def test_projection_completion_can_fence_late_success() -> None:
    from deerflow.sophia.memory_governance.projection import MemoryProjectionReconciler

    lease = ProjectionLease(
        projection_job_id=uuid4(),
        user_id="owner-1",
        memory_id=uuid4(),
        provider="mem0",
        environment="production",
        provider_project="existing-project",
        provider_namespace="sophia-memory-v2-subject",
        desired_content_revision=1,
        desired_governance_revision=1,
        operation="project_revision",
        state="leased",
        lease_token=uuid4(),
        projection_operation_id="op-1",
        canonical_content="CANONICAL TEXT",
    )

    class Store:
        payload = None

        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.v1",
                mode="shadow",
                updated_at=datetime.now(UTC),
            )

        def claim_projection(self, **kwargs):
            return lease

        def complete_projection(self, payload):
            self.payload = payload
            return {"state": "stale", "eligible": False}

    class Adapter:
        def find_by_operation_marker(self, **kwargs):
            return ()

        def project_revision(self, **kwargs):
            return ProviderMutationResult(status="created", provider_ids=("late-provider-id",), metadata_verified=True)

    store = Store()
    reconciler = MemoryProjectionReconciler(store=store, adapter=Adapter(), lease_owner="worker", service_name="test")
    assert reconciler.run_once()
    assert store.payload["p_provider_ids"] == ["late-provider-id"]
    assert store.payload["p_result_state"] == "active"


def _projection_fault_fixture(mode: str, *, operation: str = "project_revision"):
    from deerflow.sophia.memory_governance.projection import MemoryProjectionReconciler

    lease = ProjectionLease(
        projection_job_id=uuid4(),
        user_id="mem00-cert-owner",
        memory_id=uuid4(),
        provider="mem0",
        environment="production",
        provider_project="existing-project",
        provider_namespace="sophia-memory-v2-subject",
        desired_content_revision=1,
        desired_governance_revision=1,
        operation=operation,
        state="leased" if operation == "project_revision" else "purging",
        lease_token=uuid4(),
        projection_operation_id="synthetic-fault-operation",
        canonical_content="CANONICAL TEXT" if operation == "project_revision" else None,
    )

    class Store:
        payload = None
        expired = False

        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.v1",
                mode="shadow",
                updated_at=datetime.now(UTC),
            )

        def claim_projection(self, **kwargs):
            return lease

        def complete_projection(self, payload):
            self.payload = payload
            if self.expired:
                raise MemoryGovernanceUnavailable("memory_projection_lease_stale")
            return {"state": payload["p_result_state"]}

        def projection_binding_ids(self, lease):
            return ("provider-existing",)

        def expire_projection_lease(self, lease):
            self.expired = True
            return True

    class Adapter:
        projected = False
        deleted = False

        def find_by_operation_marker(self, **kwargs):
            return ()

        def project_revision(self, **kwargs):
            self.projected = True
            return ProviderMutationResult(
                status="created",
                provider_ids=("provider-created",),
                metadata_verified=True,
            )

        def delete_ids(self, *args, **kwargs):
            self.deleted = True

    class Faults:
        consumed = False

        def consume(self, *, owner_id, mode: str):
            if mode != selected_mode or self.consumed:
                return False
            self.consumed = True
            return True

    selected_mode = mode
    store = Store()
    adapter = Adapter()
    reconciler = MemoryProjectionReconciler(
        store=store,
        adapter=adapter,
        lease_owner="worker",
        service_name="test",
        faults=Faults(),
    )
    return reconciler, store, adapter


@pytest.mark.parametrize("mode", ["provider_timeout_before_effect", "provider_429_5xx"])
def test_projection_pre_effect_faults_do_not_call_provider(mode: str) -> None:
    reconciler, store, adapter = _projection_fault_fixture(mode)
    assert reconciler.run_once()
    assert not adapter.projected
    assert store.payload["p_result_state"] == "failed_retryable"
    assert store.payload["p_provider_ids"] == []


def test_projection_commit_response_loss_retains_every_returned_id_for_reconciliation() -> None:
    reconciler, store, adapter = _projection_fault_fixture("provider_commit_response_loss")
    assert reconciler.run_once()
    assert adapter.projected
    assert store.payload["p_result_state"] == "ambiguous"
    assert store.payload["p_provider_ids"] == ["provider-created"]


def test_projection_delete_block_fault_preserves_retryable_purge() -> None:
    reconciler, store, adapter = _projection_fault_fixture(
        "provider_delete_blocked",
        operation="purge_binding",
    )
    assert reconciler.run_once()
    assert not adapter.deleted
    assert store.payload["p_result_state"] == "failed_retryable"


def test_database_failure_after_provider_success_leaves_durable_job_for_reconciliation() -> None:
    reconciler, store, adapter = _projection_fault_fixture(
        "database_failure_after_provider_success"
    )
    with pytest.raises(
        MemoryGovernanceUnavailable,
        match="memory_database_failure_after_provider_success",
    ):
        reconciler.run_once()
    assert adapter.projected
    assert store.payload is None


def test_projection_lease_expiry_rejects_stale_completion_after_provider_success() -> None:
    reconciler, store, adapter = _projection_fault_fixture("projection_lease_expiry")
    with pytest.raises(MemoryGovernanceUnavailable, match="memory_projection_lease_stale"):
        reconciler.run_once()
    assert adapter.projected
    assert store.expired


def test_disabled_contract_refuses_projection_before_provider_call() -> None:
    from deerflow.sophia.memory_governance.projection import MemoryProjectionReconciler

    class Store:
        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.v1",
                mode="disabled",
                updated_at=datetime.now(UTC),
            )

        def claim_projection(self, **kwargs):
            raise AssertionError("must not claim while contract is disabled")

    class Adapter:
        def project_revision(self, **kwargs):
            raise AssertionError("must not call provider while contract is disabled")

    with pytest.raises(MemoryGovernanceUnavailable, match="memory_contract_not_active"):
        MemoryProjectionReconciler(
            store=Store(),
            adapter=Adapter(),
            lease_owner="worker",
            service_name="test",
        ).run_once()


def test_disabled_contract_refuses_canonical_pool_before_read() -> None:
    class Store:
        def get_contract(self):
            return MemoryContract(
                contract_epoch=1,
                schema_version="mem00.v1",
                mode="disabled",
                updated_at=datetime.now(UTC),
            )

        def list_pool(self, **kwargs):
            raise AssertionError("must not read canonical rows while contract is disabled")

    service = CanonicalMemoryService(
        owner_id="owner-1",
        store=Store(),
        provider=MemoryProviderContract("mem0", "production", "existing-project"),
    )
    with pytest.raises(MemoryGovernanceUnavailable, match="memory_contract_not_active"):
        service.list_pool()


def test_langsmith_outbound_payload_contains_only_structural_references(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    envelope = {
        "schema": "sophia.memory.event.v1",
        "event_name": "memory.prompt.admission",
        "outcome": "authorized",
        "owner_ref": "hmac-sha256:owner:safe",
        "query_ref": "hmac-sha256:query:safe",
        "authorized_count": 1,
        "denial_counts_by_reason": {"tombstoned": 2},
    }
    calls = []

    class Client:
        def create_run(self, **payload):
            calls.append(payload)

    assert _export_langsmith(envelope, client=Client()) == "exported"
    assert calls == [build_memory_langsmith_run_payload(envelope)]
    serialized = __import__("json").dumps(calls[0], sort_keys=True)
    assert "raw query text" not in serialized
    assert "canonical memory text" not in serialized
    assert '"inputs": {}' in serialized
    assert "hmac-sha256:query:safe" in serialized


def test_langsmith_outage_fault_is_one_event_scoped_and_content_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deerflow.sophia.memory_governance.observability as observability

    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    monkeypatch.setattr(observability, "_consume_langsmith_fault", lambda owner_id: owner_id == "mem00-cert-owner")
    monkeypatch.setattr(
        observability,
        "_export_langsmith",
        lambda envelope, *, client=None, force_unavailable=False: (
            "unavailable" if force_unavailable else "exported"
        ),
    )
    assert (
        observability.emit_memory_event(
            "memory.synthetic.outage",
            service="test",
            outcome="safe",
            fault_owner_id="mem00-cert-owner",
            owner_ref="hmac-sha256:owner:synthetic",
        )
        == "unavailable"
    )


def test_observability_rejects_nested_content_bearing_fields() -> None:
    reset_counters_for_test()
    with pytest.raises(ValueError, match="memory_event_contains_denied_fields"):
        emit_memory_event(
            "memory.bad",
            service="test",
            outcome="rejected",
            nested={"canonical_content": "must never serialize"},
        )
    assert counter_snapshot()["memory_redaction_failure_total"] == 1
