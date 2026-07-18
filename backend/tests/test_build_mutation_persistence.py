from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import (
    BuildManifest,
    BuildManifestConcurrentModification,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction, InMemoryBuildMutationStore
from deerflow.sophia.storage.build_mutation_store import (
    BuildMutationPersistenceConfigurationError,
    BuildMutationPersistenceProtocolError,
    BuildMutationPersistenceScopeError,
    BuildMutationPersistenceStaleLeaseError,
    BuildMutationStoreConfig,
    SupabaseBuildMutationStore,
)

CANARY_USER = "canary-user"
FUTURE_LEASE = "2099-07-20T12:00:00+00:00"


def _transaction(
    *,
    user_id: str = CANARY_USER,
    status: str = "prepared",
    lease_owner: str = "worker-1",
    lease_expires_at: str = FUTURE_LEASE,
    include_comparison: bool = False,
) -> BuildMutationTransaction:
    candidate_fields: dict[str, object] = {}
    if status != "prepared":
        candidate_fields = {
            "staged_object_paths": [
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json",
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx",
            ],
            "candidate_version_ids": [
                "component-version-2",
                "artifact-version-2",
            ],
            "candidate_manifest_object_path": ("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
            "candidate_manifest_hash": "e" * 64,
            "candidate_artifact_version_id": "artifact-version-2",
            "candidate_artifact_hash": "d" * 64,
        }
    return BuildMutationTransaction.model_validate(
        {
            "transaction_id": "transaction-1",
            "campaign_run_id": "campaign-run-1",
            "build_id": "build-1",
            "user_id": user_id,
            "operation_id": "operation-1",
            "owner_thread_id": "thread-1",
            "expected_manifest_revision": 3,
            "status": status,
            "lease_owner": lease_owner,
            "lease_expires_at": lease_expires_at,
            "expected_artifact_version_id": "artifact-version-1",
            "expected_artifact_hash": "c" * 64,
            "expected_component_versions": {"slide:2": "component-version-1"},
            "authorized_selectors": ["slide:2"],
            "authorized_source_roles": {"slide:2": ["body", "slide_css"]},
            "repair_program_hash": "a" * 64,
            "initial_quality_run_id": "quality-initial-1",
            "candidate_quality_run_id": "quality-candidate-1" if include_comparison else None,
            "comparison_hash": "b" * 64 if include_comparison else None,
            "gate_evidence": {"checkpoint": "dq2-safe-evidence"},
            **candidate_fields,
        }
    )


def _row(transaction: BuildMutationTransaction, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "transaction_id": transaction.transaction_id,
        "build_id": transaction.build_id,
        "user_id": transaction.user_id,
        "operation_id": transaction.operation_id,
        "expected_manifest_revision": transaction.expected_manifest_revision,
        "status": transaction.status,
        "lease_owner": transaction.lease_owner,
        "lease_expires_at": transaction.lease_expires_at,
        "transaction_payload": transaction.model_dump(mode="json"),
        "created_at": "2026-07-20T00:00:00+00:00",
        "updated_at": "2026-07-20T00:00:00+00:00",
    }
    row.update(overrides)
    return row


def _store(handler: Callable[[httpx.Request], httpx.Response]) -> SupabaseBuildMutationStore:
    return SupabaseBuildMutationStore(
        BuildMutationStoreConfig(
            url="https://example.supabase.co/",
            service_role_key="service-role",
            canary_user_ids=frozenset({CANARY_USER}),
        ),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_v1_rows_load_without_dq2_fields_and_new_fields_round_trip() -> None:
    legacy = BuildMutationTransaction.model_validate(
        {
            "build_id": "legacy-build",
            "user_id": "legacy-user",
            "operation_id": "legacy-operation",
            "expected_manifest_revision": 1,
            "lease_owner": "legacy-worker",
            "lease_expires_at": FUTURE_LEASE,
        }
    )

    assert legacy.campaign_run_id is None
    assert legacy.authorized_source_roles == {}
    assert legacy.repair_program_hash is None
    assert legacy.initial_quality_run_id is None
    assert legacy.candidate_quality_run_id is None
    assert legacy.comparison_hash is None

    transaction = _transaction(include_comparison=True)
    assert BuildMutationTransaction.model_validate(transaction.model_dump(mode="json")) == transaction


def test_supabase_store_uses_scoped_rpc_contract_for_full_lifecycle() -> None:
    prepared = _transaction()
    leased = prepared.model_copy(
        update={
            "lease_owner": "worker-2",
            "lease_expires_at": "2099-07-20T12:02:00+00:00",
        }
    )
    renewed = leased.model_copy(update={"lease_expires_at": "2099-07-20T12:03:00+00:00"})
    staged = renewed.model_copy(
        update={
            "status": "staged",
            "staged_object_paths": [
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json",
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx",
            ],
            "candidate_version_ids": ["component-version-2", "artifact-version-2"],
            "candidate_manifest_object_path": ("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
            "candidate_manifest_hash": "e" * 64,
            "candidate_artifact_version_id": "artifact-version-2",
            "candidate_artifact_hash": "d" * 64,
        }
    )
    recovered = staged.model_copy(
        update={
            "lease_owner": "recovery-worker",
            "lease_expires_at": "2099-07-20T12:04:00+00:00",
        }
    )
    observed: list[tuple[str, dict[str, object]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer service-role"
        operation = request.url.path.rsplit("/", 1)[-1]
        payload = json.loads(request.content)
        observed.append((operation, payload))
        responses = {
            "sophia_create_build_mutation_transaction": [_row(prepared)],
            "sophia_get_build_mutation_transaction": [_row(prepared)],
            "sophia_get_build_mutation_transaction_by_operation": [_row(prepared)],
            "sophia_acquire_build_mutation_lease": [_row(leased)],
            "sophia_renew_build_mutation_lease": [_row(renewed)],
            "sophia_transition_build_mutation_transaction": [_row(staged)],
            "sophia_recover_build_mutation_transactions": [_row(recovered)],
        }
        return httpx.Response(200, request=request, json=responses[operation])

    store = _store(handler)
    assert store.create(prepared) == prepared
    assert store.load(transaction_id=prepared.transaction_id, user_id=CANARY_USER) == prepared
    assert (
        store.load_by_operation(
            build_id=prepared.build_id,
            user_id=CANARY_USER,
            operation_id=prepared.operation_id,
        )
        == prepared
    )
    assert (
        store.acquire_lease(
            transaction_id=prepared.transaction_id,
            user_id=CANARY_USER,
            lease_owner="worker-2",
        )
        == leased
    )
    assert store.renew_lease(leased) == renewed
    assert store.transition(staged, expected_status="prepared") == staged
    assert store.recover_incomplete(
        build_id="build-1",
        user_id=CANARY_USER,
        lease_owner="recovery-worker",
        limit=1,
    ) == [recovered]

    assert [operation for operation, _ in observed] == [
        "sophia_create_build_mutation_transaction",
        "sophia_get_build_mutation_transaction",
        "sophia_get_build_mutation_transaction_by_operation",
        "sophia_acquire_build_mutation_lease",
        "sophia_renew_build_mutation_lease",
        "sophia_transition_build_mutation_transaction",
        "sophia_recover_build_mutation_transactions",
    ]
    assert observed[0][1]["p_user_id"] == CANARY_USER
    assert observed[2][1] == {
        "p_build_id": "build-1",
        "p_user_id": CANARY_USER,
        "p_operation_id": "operation-1",
    }
    assert observed[4][1] == {
        "p_transaction_id": "transaction-1",
        "p_user_id": CANARY_USER,
        "p_lease_owner": "worker-2",
        "p_expected_lease_expires_at": leased.lease_expires_at,
        "p_lease_seconds": 120,
    }
    assert observed[5][1]["p_expected_status"] == "prepared"
    assert observed[5][1]["p_new_status"] == "staged"
    assert observed[6][1] == {
        "p_build_id": "build-1",
        "p_user_id": CANARY_USER,
        "p_lease_owner": "recovery-worker",
        "p_lease_seconds": 120,
        "p_limit": 1,
    }


def test_create_replay_is_idempotent_by_operation_id_after_progress() -> None:
    requested = _transaction()
    existing = requested.model_copy(
        update={
            "transaction_id": "existing-transaction",
            "status": "staged",
            "lease_owner": "recovery-worker",
            "lease_expires_at": "2099-07-20T12:04:00+00:00",
            "staged_object_paths": [
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json",
                "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx",
            ],
            "candidate_version_ids": ["component-version-2", "artifact-version-2"],
            "candidate_manifest_object_path": ("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
            "candidate_manifest_hash": "e" * 64,
            "candidate_artifact_version_id": "artifact-version-2",
            "candidate_artifact_hash": "d" * 64,
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json=[_row(existing)])

    assert _store(handler).create(requested) == existing


def test_operation_lookup_reports_absence_without_fabricating_a_transaction() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/rpc/sophia_get_build_mutation_transaction_by_operation")
        assert json.loads(request.content) == {
            "p_build_id": "build-1",
            "p_user_id": CANARY_USER,
            "p_operation_id": "operation-missing",
        }
        return httpx.Response(200, request=request, json=[])

    assert (
        _store(handler).load_by_operation(
            build_id="build-1",
            user_id=CANARY_USER,
            operation_id="operation-missing",
        )
        is None
    )


def test_in_memory_replay_precedes_freshness_and_frozen_identity_cannot_change() -> None:
    transaction = BuildMutationTransaction.prepare(
        build_id="build-1",
        user_id=CANARY_USER,
        operation_id="operation-1",
        expected_manifest_revision=3,
        lease_owner="worker-1",
        owner_thread_id="thread-1",
        expected_artifact_version_id="artifact-version-1",
        expected_artifact_hash="c" * 64,
        expected_component_versions={"slide:2": "component-version-1"},
        authorized_selectors=["slide:2"],
        campaign_run_id="campaign-run-1",
        authorized_source_roles={"slide:2": ["body", "slide_css"]},
        repair_program_hash="a" * 64,
        initial_quality_run_id="quality-initial-1",
        gate_evidence={"checkpoint": "dq2-safe-evidence"},
    ).model_copy(update={"transaction_id": "transaction-1"})
    store = InMemoryBuildMutationStore()
    assert store.create(transaction) == transaction
    assert (
        store.load_by_operation(
            build_id="build-1",
            user_id=CANARY_USER,
            operation_id="operation-1",
        )
        == transaction
    )
    assert (
        store.load_by_operation(
            build_id="build-1",
            user_id=CANARY_USER,
            operation_id="missing-operation",
        )
        is None
    )

    replay = transaction.model_copy(
        update={
            "transaction_id": "replay-transaction",
            "lease_owner": "old-worker",
            "lease_expires_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
        }
    )
    assert store.create(replay) == transaction

    changed = transaction.model_copy(update={"status": "staged", "expected_artifact_hash": "d" * 64})
    with pytest.raises(ValueError, match="identity_changed"):
        store.transition(changed, expected_status="prepared")

    staged = store.transition(
        transaction.model_copy(
            update={
                "status": "staged",
                "staged_object_paths": [
                    "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json",
                    "artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx",
                ],
                "candidate_version_ids": ["artifact-version-2"],
                "candidate_manifest_object_path": ("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
                "candidate_manifest_hash": "e" * 64,
                "candidate_artifact_version_id": "artifact-version-2",
                "candidate_artifact_hash": "d" * 64,
            }
        ),
        expected_status="prepared",
    )
    with pytest.raises(ValueError, match="staged_identity_changed"):
        store.transition(
            staged.model_copy(
                update={
                    "status": "verified",
                    "candidate_quality_run_id": "quality-candidate-1",
                    "comparison_hash": "b" * 64,
                    "candidate_version_ids": ["unevaluated-artifact-version"],
                }
            ),
            expected_status="staged",
        )

    with pytest.raises(ValueError, match="lease_duration"):
        BuildMutationTransaction.prepare(
            build_id="build-1",
            user_id=CANARY_USER,
            operation_id="too-long",
            expected_manifest_revision=3,
            lease_owner="worker-1",
            lease_seconds=901,
        )


def test_paused_clock_renewal_fences_stale_owner_after_takeover() -> None:
    now = [datetime(2026, 7, 20, 12, 0, tzinfo=UTC)]
    store = InMemoryBuildMutationStore(clock=lambda: now[0])
    original = _transaction(
        lease_expires_at=(now[0] + timedelta(seconds=10)).isoformat(),
    )
    store.create(original)

    renewed = store.renew_lease(original, lease_seconds=10)

    assert datetime.fromisoformat(renewed.lease_expires_at) > datetime.fromisoformat(original.lease_expires_at)
    now[0] = datetime.fromisoformat(renewed.lease_expires_at) + timedelta(seconds=1)
    takeover = store.acquire_lease(
        transaction_id=original.transaction_id,
        user_id=original.user_id,
        lease_owner="worker-2-unique",
        lease_seconds=10,
    )
    assert takeover.lease_owner == "worker-2-unique"

    with pytest.raises(ValueError, match="stale_lease"):
        store.renew_lease(renewed, lease_seconds=10)
    with pytest.raises(ValueError, match="stale_lease"):
        store.transition(
            renewed.model_copy(update={"status": "rolling_back"}),
            expected_status="prepared",
        )

    # Even after the newer lease expires, the old heartbeat cannot use renew
    # as a hidden reacquire path because owner and expiry are exact CAS tokens.
    now[0] = datetime.fromisoformat(takeover.lease_expires_at) + timedelta(seconds=1)
    with pytest.raises(ValueError, match="stale_lease"):
        store.renew_lease(renewed, lease_seconds=10)


def test_recovery_leaves_expired_legacy_row_unclaimed_beside_dq2() -> None:
    now = [datetime(2026, 7, 20, 12, 0, tzinfo=UTC)]
    store = InMemoryBuildMutationStore(clock=lambda: now[0])
    dq2 = _transaction(
        lease_expires_at=(now[0] + timedelta(seconds=1)).isoformat(),
    )
    legacy = BuildMutationTransaction.model_validate(
        {
            "transaction_id": "legacy-transaction-1",
            "build_id": dq2.build_id,
            "user_id": dq2.user_id,
            "operation_id": "legacy-operation-1",
            "expected_manifest_revision": 1,
            "lease_owner": "legacy-worker",
            "lease_expires_at": (now[0] - timedelta(seconds=1)).isoformat(),
        }
    )
    partial_dq2 = legacy.model_copy(
        update={
            "transaction_id": "partial-dq2-transaction-1",
            "operation_id": "partial-dq2-operation-1",
            "campaign_run_id": "partial-campaign-1",
        }
    )
    store.create(dq2)
    store.create(legacy)
    partial_key = (partial_dq2.user_id, partial_dq2.transaction_id)
    store._items[partial_key] = partial_dq2.model_copy(deep=True)
    store._operations[
        (
            partial_dq2.user_id,
            partial_dq2.build_id,
            partial_dq2.operation_id,
        )
    ] = partial_key
    now[0] += timedelta(seconds=2)

    recovered = store.recover_incomplete(
        build_id=dq2.build_id,
        user_id=dq2.user_id,
        lease_owner="dq2-recovery-worker",
        lease_seconds=120,
    )

    assert [transaction.transaction_id for transaction in recovered] == [dq2.transaction_id]
    assert (
        store.load(
            transaction_id=legacy.transaction_id,
            user_id=legacy.user_id,
        )
        == legacy
    )
    assert (
        store.load(
            transaction_id=partial_dq2.transaction_id,
            user_id=partial_dq2.user_id,
        )
        == partial_dq2
    )


def test_supabase_recovery_rejects_legacy_row_if_rpc_violates_filter() -> None:
    legacy = BuildMutationTransaction.model_validate(
        {
            "transaction_id": "legacy-transaction-1",
            "build_id": "build-1",
            "user_id": CANARY_USER,
            "operation_id": "legacy-operation-1",
            "expected_manifest_revision": 1,
            "lease_owner": "dq2-recovery-worker",
            "lease_expires_at": FUTURE_LEASE,
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/rpc/sophia_recover_build_mutation_transactions")
        return httpx.Response(200, request=request, json=[_row(legacy)])

    with pytest.raises(
        BuildMutationPersistenceProtocolError,
        match="DQ-2 mutation evidence identity",
    ):
        _store(handler).recover_incomplete(
            build_id="build-1",
            user_id=CANARY_USER,
            lease_owner="dq2-recovery-worker",
        )


def test_atomic_manifest_commit_and_head_read_use_service_role_rpcs() -> None:
    committing = _transaction(status="committing", include_comparison=True).model_copy(update={"candidate_version_ids": ["artifact-version-2"]})
    committed = committing.model_copy(update={"status": "committed", "committed_manifest_revision": 4})
    manifest = BuildManifest(
        manifest_revision=4,
        build_id="build-1",
        user_id=CANARY_USER,
        thread_id="thread-1",
        format="pptx",
        status="complete",
        logical_artifact_id="artifact-1",
        current_artifact_version_id="artifact-version-2",
        format_extensions={"deck": {"current_pptx_hash": "d" * 64}},
    )
    acceptance = ArtifactAcceptedPayload(
        build_id="build-1",
        logical_artifact_id="artifact-1",
        artifact_version_id="artifact-version-2",
        manifest_revision=4,
        artifact_type="pptx",
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        storage_object_path=("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx"),
        origin="quality_repair",
    )
    head = {
        "build_id": "build-1",
        "user_id": CANARY_USER,
        "owner_thread_id": "thread-1",
        "manifest_revision": 3,
        "manifest_object_path": ("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r3.json"),
        "manifest_hash": "d" * 64,
        "logical_artifact_id": "artifact-1",
        "current_artifact_version_id": "artifact-version-1",
        "status": "complete",
        "format": "pptx",
        "updated_at": "2026-07-20T00:00:00+00:00",
    }
    observed: list[str] = []
    commit_payload: dict[str, object] | None = None

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal commit_payload
        operation = request.url.path.rsplit("/", 1)[-1]
        observed.append(operation)
        response: object = [head]
        if operation == "sophia_commit_build_mutation_manifest":
            commit_payload = json.loads(request.content)
            response = [_row(committed)]
        return httpx.Response(200, request=request, json=response)

    store = _store(handler)
    assert store.load_manifest_head(build_id="build-1", user_id=CANARY_USER).manifest_revision == 3
    assert (
        store.commit_manifest(
            committing,
            manifest=manifest,
            manifest_object_path=("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
            manifest_hash="e" * 64,
            acceptance=acceptance,
        )
        == committed
    )
    assert observed == [
        "sophia_get_build_manifest_head",
        "sophia_commit_build_mutation_manifest",
    ]
    assert commit_payload is not None
    assert commit_payload["p_lease_expires_at"] == committing.lease_expires_at
    assert commit_payload["p_owner_thread_id"] == "thread-1"


def test_all_store_operations_reject_noncanary_before_http() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500, request=request)

    store = _store(handler)
    ordinary = _transaction(user_id="ordinary-user")
    operations = (
        lambda: store.create(ordinary),
        lambda: store.load(transaction_id="transaction-1", user_id="ordinary-user"),
        lambda: store.load_by_operation(
            build_id="build-1",
            user_id="ordinary-user",
            operation_id="operation-1",
        ),
        lambda: store.acquire_lease(
            transaction_id="transaction-1",
            user_id="ordinary-user",
            lease_owner="worker-2",
        ),
        lambda: store.renew_lease(ordinary),
        lambda: store.transition(
            ordinary.model_copy(update={"status": "staged"}),
            expected_status="prepared",
        ),
        lambda: store.recover_incomplete(
            build_id="build-1",
            user_id="ordinary-user",
            lease_owner="recovery-worker",
        ),
    )

    for operation in operations:
        with pytest.raises(BuildMutationPersistenceScopeError, match="exact canary"):
            operation()
    assert request_count == 0


def test_verified_transition_requires_candidate_comparison_before_http() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500, request=request)

    store = _store(handler)
    with pytest.raises(BuildMutationPersistenceProtocolError, match="evidence identity"):
        store.transition(
            _transaction(status="verified"),
            expected_status="staged",
        )
    assert request_count == 0


def test_generic_store_transition_rejects_committed_before_http() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500, request=request)

    store = _store(handler)
    committing = _transaction(status="committing", include_comparison=True)
    committed = committing.model_copy(update={"status": "committed", "committed_manifest_revision": 4})

    with pytest.raises(
        BuildMutationPersistenceProtocolError,
        match="atomic manifest commit RPC",
    ):
        store.transition(committed, expected_status="committing")
    assert request_count == 0


@pytest.mark.parametrize(
    ("safe_message", "error_type"),
    [
        ("build_manifest_concurrent_modification", BuildManifestConcurrentModification),
        ("build_registry_concurrent_modification", BuildManifestConcurrentModification),
        ("build_mutation_stale_commit_lease", BuildMutationPersistenceStaleLeaseError),
    ],
)
def test_atomic_commit_maps_only_allowlisted_sanitized_errors(
    safe_message: str,
    error_type: type[Exception],
) -> None:
    committing = _transaction(status="committing", include_comparison=True)
    manifest = BuildManifest(
        manifest_revision=4,
        build_id="build-1",
        user_id=CANARY_USER,
        thread_id="thread-1",
        format="pptx",
        status="complete",
        logical_artifact_id="artifact-1",
        current_artifact_version_id="artifact-version-2",
        format_extensions={"deck": {"current_pptx_hash": "d" * 64}},
    )
    acceptance = ArtifactAcceptedPayload(
        build_id="build-1",
        logical_artifact_id="artifact-1",
        artifact_version_id="artifact-version-2",
        manifest_revision=4,
        artifact_type="pptx",
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        storage_object_path=("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/artifacts/artifact-version-2/deck.pptx"),
        origin="quality_repair",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            request=request,
            json={"message": safe_message, "details": "must-not-be-exposed"},
        )

    with pytest.raises(error_type) as error:
        _store(handler).commit_manifest(
            committing,
            manifest=manifest,
            manifest_object_path=("artifacts/canary-user/thread-1/foundation/.builder/builds/build-1/manifest/manifest-r4.json"),
            manifest_hash="e" * 64,
            acceptance=acceptance,
        )
    assert "must-not-be-exposed" not in str(error.value)


def test_renewal_maps_stale_expiry_without_exposing_rpc_details() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/rpc/sophia_renew_build_mutation_lease")
        return httpx.Response(
            409,
            request=request,
            json={
                "message": "build_mutation_stale_lease",
                "details": "must-not-be-exposed",
            },
        )

    with pytest.raises(BuildMutationPersistenceStaleLeaseError) as error:
        _store(handler).renew_lease(_transaction())
    assert "must-not-be-exposed" not in str(error.value)


def test_store_rejects_row_payload_mismatch_without_exposing_payload() -> None:
    transaction = _transaction()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json=[_row(transaction, build_id="different-build")],
        )

    store = _store(handler)
    with pytest.raises(BuildMutationPersistenceProtocolError) as error:
        store.load(transaction_id=transaction.transaction_id, user_id=CANARY_USER)

    assert "campaign-run-1" not in str(error.value)
    assert "different-build" not in str(error.value)


def test_probe_requires_every_mutation_rpc() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={
                "paths": {
                    "/rpc/sophia_create_build_mutation_transaction": {},
                    "/rpc/sophia_get_build_mutation_transaction": {},
                }
            },
        )

    with pytest.raises(BuildMutationPersistenceProtocolError, match="missing required RPCs"):
        _store(handler).probe()


def test_probe_accepts_terminal_operation_lookup_in_complete_rpc_surface() -> None:
    paths = {
        f"/rpc/{operation}": {}
        for operation in (
            "sophia_create_build_mutation_transaction",
            "sophia_get_build_mutation_transaction",
            "sophia_get_build_mutation_transaction_by_operation",
            "sophia_acquire_build_mutation_lease",
            "sophia_renew_build_mutation_lease",
            "sophia_transition_build_mutation_transaction",
            "sophia_recover_build_mutation_transactions",
            "sophia_get_build_manifest_head",
            "sophia_commit_build_mutation_manifest",
        )
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"paths": paths})

    _store(handler).probe()


def test_store_configuration_requires_explicit_dq2_canary_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role")

    with pytest.raises(
        BuildMutationPersistenceConfigurationError,
        match="exact canary user set",
    ):
        BuildMutationStoreConfig.from_env(canary_user_ids=frozenset())
