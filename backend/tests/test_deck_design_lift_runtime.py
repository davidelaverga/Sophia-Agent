from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from decimal import Decimal

import anyio
import pytest

from deerflow.sophia.build_manifest import (
    BuildComponent,
    BuildManifest,
    BuildManifestConcurrentModification,
    InMemoryBuildManifestStore,
)
from deerflow.sophia.build_mutation import (
    BuildMutationTransaction,
    InMemoryBuildMutationStore,
)
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.compiler import compile_repair_program
from deerflow.sophia.deck_design_lift.runtime import (
    BlindDeckJudgmentRequest,
    DeckDesignLiftRequest,
    DeckDesignLiftRuntime,
    DeckDesignLiftRuntimeError,
    DeckRepairTraceCompletionPending,
    InitialRenderedJudgment,
    RepairInvocationRequest,
    StagedDeckCandidate,
    _RenewableMutationLease,
    new_dq2_lease_owner,
)
from deerflow.sophia.deck_design_lift.schemas import (
    ContentPreservationProof,
    DeckRepairCandidate,
    JudgmentRepairFinding,
    LocalityProof,
    RepairCompilerInput,
    RepairRenderEvidence,
    SelectorSourceAuthorization,
    SkillRef,
    SourceUpdate,
    VersionCriterionScore,
    VersionQualityEvidence,
)
from deerflow.sophia.deck_quality.schemas import (
    MechanicalCheck,
    MechanicalProjection,
    ShadowDecision,
)

HASH = "a" * 64
OTHER_HASH = "b" * 64
PSI_FAILURES = (
    "weak_subject_specificity",
    "weak_signature_realization",
    "low_sequence_rhythm",
)
TARGETS = ("slide:1", "slide:3", "slide:5")


def _run(coro):
    return asyncio.run(coro)


def _component(selector: str, index: int) -> BuildComponent:
    if selector == "deck-style:root":
        return BuildComponent(
            id="component-style",
            selector=selector,
            type="deck_style",
            index=index,
            source_path="versions/style-v1/deck.css",
            status="gated",
            current_version_id="style-version-1",
            source_roles={"deck_css": "versions/style-v1/deck.css"},
            source_hashes={"deck_css": HASH},
        )
    number = selector.split(":", 1)[1]
    return BuildComponent(
        id=f"component-slide-{number}",
        selector=selector,
        type="slide",
        index=index,
        source_path=f"versions/slide-{number}-v1/body.html",
        status="gated",
        current_version_id=f"slide-{number}-version-1",
        source_roles={
            "body": f"versions/slide-{number}-v1/body.html",
            "slide_css": f"versions/slide-{number}-v1/slide.css",
            "notes": f"versions/slide-{number}-v1/notes.txt",
            "assembled": f"versions/slide-{number}-v1/assembled.html",
        },
        source_hashes={
            "body": HASH,
            "slide_css": HASH,
            "notes": HASH,
            "assembled": HASH,
            "deck_css": HASH,
        },
        shared_dependencies=["deck-style:root"],
    )


def _baseline_manifest() -> BuildManifest:
    return BuildManifest(
        manifest_revision=0,
        build_id="build-psi-001",
        user_id="user-canary-001",
        thread_id="thread-canary-001",
        format="pptx",
        status="complete",
        logical_artifact_id="logical-psi-001",
        current_artifact_version_id="artifact-initial-001",
        deliverable_path="/mnt/user-data/outputs/psi-initial.pptx",
        components=[
            _component("deck-style:root", 0),
            *(_component(f"slide:{index}", index) for index in range(1, 6)),
        ],
    )


def _artifact(*, candidate: bool = False) -> BuildArtifactVersion:
    return BuildArtifactVersion(
        version_id="artifact-candidate-001" if candidate else "artifact-initial-001",
        build_id="build-psi-001",
        logical_artifact_id="logical-psi-001",
        manifest_revision=2 if candidate else 1,
        artifact_path=("/mnt/user-data/outputs/psi-candidate.pptx" if candidate else "/mnt/user-data/outputs/psi-initial.pptx"),
        artifact_hash=OTHER_HASH if candidate else HASH,
        storage_object_path=("artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/artifacts/artifact-candidate-001/psi-candidate.pptx" if candidate else "artifacts/user-canary-001/psi/initial/psi.pptx"),
        verified=True,
    )


def _mechanics(*, passed: bool = True) -> MechanicalProjection:
    check_ids = (
        "authoritative_gate",
        "source_retention",
        "native_editability",
        "contrast",
        "native_lint",
        "overflow_collision_clipping",
        "render_success",
        "visual_asset_completeness",
        "artifact_identity",
    )
    checks = []
    for index, check_id in enumerate(check_ids):
        failed = not passed and index == 0
        checks.append(
            MechanicalCheck(
                check_id=check_id,
                status="failed" if failed else "passed",
                failure_codes=("authoritative_gate_failed",) if failed else (),
            )
        )
    return MechanicalProjection(
        status="passed" if passed else "failed",
        checks=tuple(checks),
        authoritative_record_hash=HASH,
    )


def _criteria(*, candidate: bool) -> tuple[VersionCriterionScore, ...]:
    if not candidate:
        return (
            VersionCriterionScore(criterion_id="subject_specificity", score=2, critical=True, failed=True),
            VersionCriterionScore(criterion_id="signature_realization", score=2, critical=False, failed=True),
            VersionCriterionScore(criterion_id="sequence_rhythm", score=2, critical=False, failed=True),
            VersionCriterionScore(criterion_id="content_fidelity", score=4, critical=True),
        )
    return (
        VersionCriterionScore(criterion_id="subject_specificity", score=4, critical=True),
        VersionCriterionScore(criterion_id="signature_realization", score=4, critical=False),
        VersionCriterionScore(criterion_id="sequence_rhythm", score=3, critical=False),
        VersionCriterionScore(criterion_id="content_fidelity", score=4, critical=True),
    )


def _quality(
    *,
    candidate: bool = False,
    satisfied: bool = False,
    **updates: object,
) -> VersionQualityEvidence:
    values: dict[str, object] = {
        "quality_run_id": "quality-candidate-001" if candidate else "quality-initial-001",
        "artifact_version_id": ("artifact-candidate-001" if candidate else "artifact-initial-001"),
        "verdict": "satisfied" if candidate or satisfied else "needs_revision",
        "weighted_score": Decimal("4.0") if candidate or satisfied else Decimal("2.4"),
        "criterion_scores": _criteria(candidate=candidate or satisfied),
        "failure_codes": () if candidate or satisfied else PSI_FAILURES,
        "critical_failure_codes": (),
        "mechanics_passed": True,
        "coverage_complete": True,
    }
    values.update(updates)
    return VersionQualityEvidence.model_validate(values)


def _skill() -> SkillRef:
    return SkillRef(
        path="skills/public/hands-on-deck/designing-slides.md",
        source_hash=HASH,
        excerpt_hash=OTHER_HASH,
    )


def _finding(selector: str, failure_code: str) -> JudgmentRepairFinding:
    return JudgmentRepairFinding(
        target_selector=selector,
        failure_code=failure_code,
        observation=f"{failure_code} is visible at presentation scale.",
        render_evidence=(
            RepairRenderEvidence(
                selector=selector,
                path=f"renders/{selector.replace(':', '-')}.png",
                sha256=HASH,
            ),
        ),
        requested_source_roles=("body",),
        retained_content=("Preserve the PSI claim and factual wording.",),
        skill_refs=(_skill(),),
    )


def _initial_judgment(*, satisfied: bool = False) -> InitialRenderedJudgment:
    evidence = _quality(satisfied=satisfied)
    decision = ShadowDecision(
        result="satisfied" if satisfied else "needs_revision",
        reason_codes=("all_quality_gates_passed",) if satisfied else ("critical_score_below_floor",),
        weighted_score=evidence.weighted_score,
        critical_score_floor=3,
        failure_codes=() if satisfied else PSI_FAILURES,
        evidence_selectors=() if satisfied else TARGETS,
        rubric_hash=HASH,
        policy_hash=OTHER_HASH,
    )
    return InitialRenderedJudgment(
        evidence=evidence,
        decision=decision,
        findings=(
            ()
            if satisfied
            else (
                _finding("slide:1", "weak_subject_specificity"),
                _finding("slide:3", "weak_signature_realization"),
                _finding("slide:5", "low_sequence_rhythm"),
            )
        ),
    )


def _candidate() -> DeckRepairCandidate:
    return DeckRepairCandidate(
        source_updates=tuple(
            SourceUpdate(
                selector=selector,
                source_role="body",
                expected_source_hash=HASH,
                content=f"<section data-deck-id='{selector}-psi'>PSI repair {selector}</section>",
            )
            for selector in TARGETS
        ),
        rationale="Resolve the three frozen PSI design failures without collateral writes.",
    )


class FakeMechanics:
    def __init__(self, *, fail_candidate: bool = False) -> None:
        self.fail_candidate = fail_candidate
        self.calls: list[str] = []

    async def verify(self, *, artifact, campaign_run_id, experiment_id):
        self.calls.append(artifact.version_id)
        return _mechanics(passed=not (self.fail_candidate and artifact.version_id == "artifact-candidate-001"))


class FakeJudge:
    def __init__(
        self,
        *,
        initial: InitialRenderedJudgment | None = None,
        candidate: VersionQualityEvidence | None = None,
    ) -> None:
        self.initial = initial or _initial_judgment()
        self.candidate = candidate or _quality(candidate=True)
        self.initial_calls: list[BlindDeckJudgmentRequest] = []
        self.candidate_calls: list[BlindDeckJudgmentRequest] = []

    async def judge_initial(self, request):
        self.initial_calls.append(request)
        return self.initial

    async def judge_candidate(self, request):
        self.candidate_calls.append(request)
        return self.candidate


class SimulatedWorkerCrash(BaseException):
    pass


class InvokeOnceRepair:
    def __init__(self, candidate: DeckRepairCandidate | None = None) -> None:
        self.candidate = candidate or _candidate()
        self.cached: dict[str, DeckRepairCandidate] = {}
        self.requests: list[RepairInvocationRequest] = []
        self.model_calls = 0
        self.invocation_calls = 0
        self.crash_after_first_model_call = False

    async def invoke_once(self, request: RepairInvocationRequest):
        self.invocation_calls += 1
        self.requests.append(request)
        if request.operation_id not in self.cached:
            self.model_calls += 1
            self.cached[request.operation_id] = self.candidate
            if self.crash_after_first_model_call:
                self.crash_after_first_model_call = False
                raise SimulatedWorkerCrash()
        return self.cached[request.operation_id]


class TracePendingOnceRepair:
    def __init__(self) -> None:
        self.candidate = _candidate()
        self.invocation_calls = 0
        self.provider_calls = 1

    async def invoke_once(self, _request: RepairInvocationRequest):
        self.invocation_calls += 1
        if self.invocation_calls == 1:
            raise DeckRepairTraceCompletionPending(
                "repair success trace completion is pending"
            )
        return self.candidate


class FakeMaterializer:
    def __init__(self) -> None:
        self.staged: dict[str, StagedDeckCandidate] = {}
        self.rollback_calls = 0

    async def stage(self, *, transaction, program, candidate):
        existing = self.staged.get(transaction.transaction_id)
        if existing is not None:
            return existing
        baseline = _baseline_manifest().model_copy(update={"manifest_revision": 1}, deep=True)
        components = []
        for component in baseline.components:
            if component.selector in program.authorized_selectors:
                components.append(
                    component.model_copy(
                        update={"current_version_id": (f"{component.selector.replace(':', '-')}-quality-version-2")},
                        deep=True,
                    )
                )
            else:
                components.append(component.model_copy(deep=True))
        candidate_manifest = baseline.model_copy(
            update={
                "manifest_revision": 2,
                "current_artifact_version_id": "artifact-candidate-001",
                "deliverable_path": "/mnt/user-data/outputs/psi-candidate.pptx",
                "components": components,
                "format_extensions": {
                    "deck": {
                        "current_pptx_hash": OTHER_HASH,
                    }
                },
            },
            deep=True,
        )
        stage = StagedDeckCandidate(
            artifact=_artifact(candidate=True),
            candidate_manifest=candidate_manifest,
            manifest_object_path=("artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/manifest/manifest-r2.json"),
            manifest_hash=hashlib.sha256(
                json.dumps(
                    candidate_manifest.model_dump(mode="json"),
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=True,
                ).encode()
            ).hexdigest(),
            staged_object_paths=(
                "artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/artifacts/artifact-candidate-001/psi-candidate.pptx",
                "artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/manifest/manifest-r2.json",
            ),
            candidate_version_ids=(
                "artifact-candidate-001",
                *tuple(f"{selector.replace(':', '-')}-quality-version-2" for selector in TARGETS),
            ),
            locality=LocalityProof(
                authorized_selectors=TARGETS,
                changed_component_versions=TARGETS,
                unchanged_component_versions=("deck-style:root", "slide:2", "slide:4"),
                shared_dependency_changed=False,
            ),
            content=ContentPreservationProof(
                brief_preserved=True,
                initial_slide_count=5,
                candidate_slide_count=5,
                required_content_preserved=True,
                factual_content_preserved=True,
                native_editability_preserved=True,
            ),
        )
        self.staged[transaction.transaction_id] = stage
        return stage

    async def load_staged(self, *, transaction):
        return self.staged[transaction.transaction_id]

    async def rollback(self, *, transaction):
        self.rollback_calls += 1


class SubstitutedManifestPathMaterializer(FakeMaterializer):
    async def stage(self, *, transaction, program, candidate):
        staged = await super().stage(
            transaction=transaction,
            program=program,
            candidate=candidate,
        )
        wrong_path = "artifacts/other-user/thread-canary-001/foundation/.builder/builds/build-psi-001/manifest/manifest-r2.json"
        substituted = staged.model_copy(
            update={
                "manifest_object_path": wrong_path,
                "staged_object_paths": (
                    staged.staged_object_paths[0],
                    wrong_path,
                ),
            },
            deep=True,
        )
        self.staged[transaction.transaction_id] = substituted
        return substituted


class EscapedCandidateObjectMaterializer(FakeMaterializer):
    async def stage(self, *, transaction, program, candidate):
        staged = await super().stage(
            transaction=transaction,
            program=program,
            candidate=candidate,
        )
        escaped = staged.model_copy(
            update={
                "staged_object_paths": (
                    "artifacts/other-user/escaped/psi-candidate.pptx",
                    staged.manifest_object_path,
                ),
            },
            deep=True,
        )
        self.staged[transaction.transaction_id] = escaped
        return escaped


class TrackingMutationStore(InMemoryBuildMutationStore):
    def __init__(self) -> None:
        super().__init__()
        self.transition_calls: list[tuple[str, str]] = []

    def transition(self, transaction, *, expected_status):
        self.transition_calls.append((expected_status, transaction.status))
        return super().transition(transaction, expected_status=expected_status)


class ThreadRecordingMutationStore(TrackingMutationStore):
    def __init__(self) -> None:
        super().__init__()
        self.thread_calls: list[tuple[str, int]] = []

    def _record_thread(self, operation: str) -> None:
        self.thread_calls.append((operation, threading.get_ident()))

    def create(self, transaction):
        self._record_thread("create")
        return super().create(transaction)

    def load(self, *, transaction_id, user_id):
        self._record_thread("load")
        return super().load(transaction_id=transaction_id, user_id=user_id)

    def acquire_lease(
        self,
        *,
        transaction_id,
        user_id,
        lease_owner,
        lease_seconds=120,
    ):
        self._record_thread("acquire_lease")
        return super().acquire_lease(
            transaction_id=transaction_id,
            user_id=user_id,
            lease_owner=lease_owner,
            lease_seconds=lease_seconds,
        )

    def renew_lease(self, transaction, *, lease_seconds=120):
        self._record_thread("renew_lease")
        return super().renew_lease(transaction, lease_seconds=lease_seconds)

    def transition(self, transaction, *, expected_status):
        self._record_thread("transition")
        return super().transition(transaction, expected_status=expected_status)


class CrashAfterPersistMutationStore(TrackingMutationStore):
    def __init__(self, *, target_status: str) -> None:
        super().__init__()
        self.target_status = target_status
        self.did_crash = False

    def transition(self, transaction, *, expected_status):
        persisted = super().transition(
            transaction,
            expected_status=expected_status,
        )
        if persisted.status == self.target_status and not self.did_crash:
            self.did_crash = True
            raise SimulatedWorkerCrash()
        return persisted


def _expire_mutation_lease(
    mutations: InMemoryBuildMutationStore,
    transaction: BuildMutationTransaction,
) -> None:
    key = (transaction.user_id, transaction.transaction_id)
    mutations._items[key] = transaction.model_copy(
        update={"lease_expires_at": "2000-01-01T00:00:00+00:00"},
        deep=True,
    )


class FakeAtomicCommitter:
    """Test-only coordinator; production uses the single Supabase commit RPC."""

    def __init__(
        self,
        *,
        manifests: InMemoryBuildManifestStore,
        mutations: InMemoryBuildMutationStore,
        conflict: bool = False,
        crash_after_commit: bool = False,
        lose_response_after_commit: bool = False,
    ) -> None:
        self.manifests = manifests
        self.mutations = mutations
        self.conflict = conflict
        self.crash_after_commit = crash_after_commit
        self.lose_response_after_commit = lose_response_after_commit
        self.calls: list[dict[str, object]] = []

    def commit_manifest(
        self,
        transaction,
        *,
        manifest,
        manifest_object_path,
        manifest_hash,
        acceptance,
    ):
        self.calls.append(
            {
                "transaction": transaction,
                "thread_id": threading.get_ident(),
                "manifest_object_path": manifest_object_path,
                "manifest_hash": manifest_hash,
                "acceptance": acceptance,
            }
        )
        if self.conflict:
            raise BuildManifestConcurrentModification("competing writer")
        manifest_snapshot = {key: value.model_copy(deep=True) for key, value in self.manifests._items.items()}
        mutation_snapshot = {key: value.model_copy(deep=True) for key, value in self.mutations._items.items()}
        try:
            saved = self.manifests.save_cas(
                manifest,
                expected_revision=transaction.expected_manifest_revision,
            )
            key = (transaction.user_id, transaction.transaction_id)
            current = self.mutations._items[key]
            if current.status != "committing" or current != transaction:
                raise ValueError("test_atomic_commit_stale_transaction")
            committed = transaction.model_copy(
                update={
                    "status": "committed",
                    "committed_manifest_revision": saved.manifest_revision,
                },
                deep=True,
            )
            self.mutations._items[key] = committed
        except BaseException:
            self.manifests._items = manifest_snapshot
            self.mutations._items = mutation_snapshot
            raise
        if self.crash_after_commit:
            self.crash_after_commit = False
            raise SimulatedWorkerCrash()
        if self.lose_response_after_commit:
            self.lose_response_after_commit = False
            raise RuntimeError("simulated response loss")
        return committed


def _request(**updates: object) -> DeckDesignLiftRequest:
    values: dict[str, object] = {
        "campaign_run_id": "campaign-dq2-001",
        "experiment_id": "experiment-dq2-001",
        "build_id": "build-psi-001",
        "user_id": "user-canary-001",
        "operation_id": "operation-dq2-001",
        "lease_owner": "worker-render-001",
        "expected_manifest_revision": 1,
        "initial_artifact": _artifact(),
        "source_authorizations": tuple(SelectorSourceAuthorization(selector=selector, source_roles=("body",)) for selector in TARGETS),
        "rubric_version": "sophia-deck-rubric/v1",
        "instrument_hash": HASH,
    }
    values.update(updates)
    return DeckDesignLiftRequest.model_validate(values)


def _runtime(
    *,
    manifest_store=None,
    mutation_store=None,
    mechanics=None,
    judge=None,
    repair=None,
    materializer=None,
    commit_conflict=False,
    commit_crash=False,
    commit_response_loss=False,
    lease_heartbeat_interval_seconds=30.0,
):
    manifests = manifest_store or InMemoryBuildManifestStore()
    try:
        manifests.load(build_id="build-psi-001", user_id="user-canary-001")
    except KeyError:
        manifests.create(_baseline_manifest())
    mutations = mutation_store or TrackingMutationStore()
    mechanics = mechanics or FakeMechanics()
    judge = judge or FakeJudge()
    repair = repair or InvokeOnceRepair()
    materializer = materializer or FakeMaterializer()
    atomic_committer = FakeAtomicCommitter(
        manifests=manifests,
        mutations=mutations,
        conflict=commit_conflict,
        crash_after_commit=commit_crash,
        lose_response_after_commit=commit_response_loss,
    )
    return (
        DeckDesignLiftRuntime(
            mutation_store=mutations,
            manifest_store=manifests,
            mechanics=mechanics,
            judge=judge,
            repair_executor=repair,
            materializer=materializer,
            atomic_committer=atomic_committer,
            lease_heartbeat_interval_seconds=lease_heartbeat_interval_seconds,
        ),
        manifests,
        mutations,
        mechanics,
        judge,
        repair,
        materializer,
    )


def test_production_shaped_five_slide_runtime_commits_one_approved_repair() -> None:
    runtime, manifests, mutations, mechanics, judge, repair, materializer = _runtime()

    result = _run(runtime.run(_request()))

    assert result.disposition == "RUNTIME_COMMITTED_PENDING_AUDIT"
    assert result.terminal_code == "candidate_committed"
    assert result.comparison is not None
    assert result.comparison.result == "approved_improvement"
    assert result.comparison.resolved_failure_codes == tuple(sorted(PSI_FAILURES))
    assert repair.model_calls == 1
    assert mechanics.calls == ["artifact-initial-001", "artifact-candidate-001"]
    assert len(judge.initial_calls) == len(judge.candidate_calls) == 1
    blind_payload = judge.candidate_calls[0].model_dump(mode="json")
    assert not {
        "initial_verdict",
        "initial_scores",
        "repair_program",
        "repair_rationale",
        "expected_improvements",
    }.intersection(blind_payload)

    current = manifests.load(build_id="build-psi-001", user_id="user-canary-001")
    assert current.manifest_revision == 2
    assert current.current_artifact_version_id == "artifact-candidate-001"
    assert {component.selector for component in current.components if component.current_version_id.endswith("quality-version-2")} == set(TARGETS)
    transaction = mutations.load(
        transaction_id=result.transaction_id,
        user_id="user-canary-001",
    )
    assert transaction.status == "committed"
    assert transaction.campaign_run_id == "campaign-dq2-001"
    assert transaction.owner_thread_id == "thread-canary-001"
    assert transaction.committed_manifest_revision == 2
    assert "artifact-candidate-001" in transaction.candidate_version_ids
    assert transaction.candidate_artifact_version_id == "artifact-candidate-001"
    assert transaction.candidate_artifact_hash == OTHER_HASH
    assert transaction.candidate_manifest_object_path.endswith("manifest-r2.json")
    assert transaction.candidate_manifest_hash is not None
    assert materializer.rollback_calls == 0
    assert len(repair.requests) == 1
    assert repair.requests[0].thread_id == transaction.owner_thread_id
    assert repair.requests[0].build_id == transaction.build_id
    assert ("committing", "committed") not in mutations.transition_calls
    atomic_call = runtime._atomic_committer.calls[0]
    assert atomic_call["acceptance"].origin == "quality_repair"
    assert atomic_call["manifest_object_path"].endswith("/foundation/.builder/builds/build-psi-001/manifest/manifest-r2.json")


def test_sync_mutation_boundaries_never_run_on_event_loop_thread() -> None:
    mutations = ThreadRecordingMutationStore()
    runtime, _manifests, _mutations, _mechanics, _judge, _repair, _materializer = _runtime(
        mutation_store=mutations,
    )

    async def scenario() -> tuple[int, object]:
        event_loop_thread = threading.get_ident()
        return event_loop_thread, await runtime.run(_request())

    event_loop_thread, result = _run(scenario())

    assert result.terminal_code == "candidate_committed"
    assert {operation for operation, _thread in mutations.thread_calls} >= {
        "create",
        "renew_lease",
        "transition",
    }
    assert all(thread_id != event_loop_thread for _operation, thread_id in mutations.thread_calls)
    assert runtime._atomic_committer.calls[0]["thread_id"] != event_loop_thread


def test_server_lease_owner_is_unique_and_operation_scoped() -> None:
    operation_id = "operation-dq2-001"
    expected_scope = hashlib.sha256(operation_id.encode()).hexdigest()[:16]

    first = new_dq2_lease_owner(operation_id)
    second = new_dq2_lease_owner(operation_id)

    assert first != second
    assert first.startswith(f"dq2:{expected_scope}:")
    assert len(first) <= 128


@pytest.mark.parametrize("terminal_status", ["committed", "rolled_back", "failed"])
def test_heartbeat_exits_without_renewing_a_terminal_transaction(
    terminal_status: str,
) -> None:
    class TerminalRejectingStore(InMemoryBuildMutationStore):
        def __init__(self) -> None:
            super().__init__()
            self.renew_calls = 0

        def renew_lease(self, transaction, *, lease_seconds=120):
            self.renew_calls += 1
            if transaction.status in {"committed", "rolled_back", "failed"}:
                raise AssertionError("terminal transaction must not renew")
            return super().renew_lease(transaction, lease_seconds=lease_seconds)

    store = TerminalRejectingStore()
    transaction = BuildMutationTransaction.prepare(
        build_id="build-terminal-001",
        user_id="user-canary-001",
        operation_id="operation-terminal-001",
        expected_manifest_revision=1,
        lease_owner="worker-terminal-001",
    ).model_copy(update={"status": terminal_status})
    lease = _RenewableMutationLease(
        store=store,
        transaction=transaction,
        lease_seconds=120,
        heartbeat_interval_seconds=0.001,
    )

    async def run_heartbeat() -> None:
        with anyio.CancelScope() as work_scope:
            await lease.heartbeat(work_scope)

    _run(run_heartbeat())

    assert store.renew_calls == 0


def test_heartbeat_lease_loss_cancels_stale_worker_before_cleanup() -> None:
    class BlockingRepair:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.cancelled = False

        async def invoke_once(self, _request):
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled = True

    repair = BlockingRepair()
    mutations = TrackingMutationStore()
    materializer = FakeMaterializer()
    runtime, _manifests, _mutations, _mechanics, _judge, _repair, _materializer = _runtime(
        mutation_store=mutations,
        repair=repair,
        materializer=materializer,
        lease_heartbeat_interval_seconds=0.005,
    )

    async def race() -> None:
        task = asyncio.create_task(runtime.run(_request()))
        await asyncio.wait_for(repair.started.wait(), timeout=1)
        stale = next(iter(mutations._items.values())).model_copy(deep=True)
        _expire_mutation_lease(mutations, stale)
        takeover = mutations.acquire_lease(
            transaction_id=stale.transaction_id,
            user_id=stale.user_id,
            lease_owner="worker-render-takeover",
            lease_seconds=120,
        )

        with pytest.raises(
            DeckDesignLiftRuntimeError,
            match="heartbeat lost ownership",
        ):
            await asyncio.wait_for(task, timeout=1)

        durable = mutations.load(
            transaction_id=stale.transaction_id,
            user_id=stale.user_id,
        )
        assert durable.lease_owner == takeover.lease_owner
        assert durable.status == "prepared"

    _run(race())

    assert repair.cancelled is True
    assert materializer.rollback_calls == 0


def test_runtime_accepts_exact_shared_style_dependency_closure() -> None:
    baseline = _baseline_manifest().model_copy(update={"manifest_revision": 1}, deep=True)
    finding = JudgmentRepairFinding(
        target_selector="deck-style:root",
        failure_code="default_look_gravity",
        observation="The same generic visual system is visible across the deck.",
        render_evidence=(
            RepairRenderEvidence(
                selector="slide:1",
                path="renders/slide-1.png",
                sha256=HASH,
            ),
            RepairRenderEvidence(
                selector="slide:2",
                path="renders/slide-2.png",
                sha256=OTHER_HASH,
            ),
        ),
        requested_source_roles=("deck_css",),
        retained_content=("Preserve every PSI claim and the five-slide sequence.",),
        skill_refs=(_skill(),),
    )
    decision = ShadowDecision(
        result="needs_revision",
        reason_codes=("critical_score_below_floor",),
        weighted_score=Decimal("2.4"),
        critical_score_floor=3,
        failure_codes=("default_look_gravity",),
        evidence_selectors=("slide:1", "slide:2"),
        rubric_hash=HASH,
        policy_hash=OTHER_HASH,
    )
    program = compile_repair_program(
        RepairCompilerInput(
            build_id=baseline.build_id,
            initial_quality_run_id="quality-initial-001",
            initial_manifest_revision=1,
            initial_decision=decision,
            source_authorizations=(
                SelectorSourceAuthorization(
                    selector="deck-style:root",
                    source_roles=("deck_css",),
                ),
            ),
            findings=(finding,),
            rubric_version="sophia-deck-rubric/v1",
            instrument_hash=HASH,
        )
    )
    expected_versions = {component.selector: component.current_version_id for component in baseline.components}
    transaction = BuildMutationTransaction.prepare(
        build_id=baseline.build_id,
        user_id=baseline.user_id,
        operation_id="operation-dq2-001",
        expected_manifest_revision=1,
        lease_owner="worker-render-001",
        owner_thread_id=baseline.thread_id,
        expected_artifact_version_id="artifact-initial-001",
        expected_artifact_hash=HASH,
        expected_component_versions=expected_versions,
        authorized_selectors=list(program.authorized_selectors),
        campaign_run_id="campaign-dq2-001",
        authorized_source_roles={"deck-style:root": ["deck_css"]},
        repair_program_hash=program.program_hash,
        initial_quality_run_id="quality-initial-001",
        gate_evidence={"deck_design_lift_runtime": {"schema_version": "sophia-deck-design-lift-checkpoint/v1"}},
    )
    changed_components = [
        component.model_copy(
            update={"current_version_id": f"{component.selector.replace(':', '-')}-quality-v2"},
            deep=True,
        )
        for component in baseline.components
    ]
    candidate_manifest = baseline.model_copy(
        update={
            "manifest_revision": 2,
            "current_artifact_version_id": "artifact-candidate-001",
            "components": changed_components,
            "format_extensions": {"deck": {"current_pptx_hash": OTHER_HASH}},
        },
        deep=True,
    )
    artifact = _artifact(candidate=True)
    prefix = "artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/"
    staged = StagedDeckCandidate(
        artifact=artifact,
        candidate_manifest=candidate_manifest,
        manifest_object_path=f"{prefix}manifest/manifest-r2.json",
        manifest_hash=hashlib.sha256(
            json.dumps(
                candidate_manifest.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode()
        ).hexdigest(),
        staged_object_paths=(
            artifact.storage_object_path,
            f"{prefix}manifest/manifest-r2.json",
        ),
        candidate_version_ids=(
            artifact.version_id,
            *(component.current_version_id for component in changed_components),
        ),
        locality=LocalityProof(
            authorized_selectors=("deck-style:root",),
            changed_component_versions=tuple(component.selector for component in changed_components),
            unchanged_component_versions=(),
            shared_dependency_changed=True,
        ),
        content=ContentPreservationProof(
            brief_preserved=True,
            initial_slide_count=5,
            candidate_slide_count=5,
            required_content_preserved=True,
            factual_content_preserved=True,
            native_editability_preserved=True,
        ),
    )

    DeckDesignLiftRuntime._validate_staged_candidate(
        _request(
            source_authorizations=(
                SelectorSourceAuthorization(
                    selector="deck-style:root",
                    source_roles=("deck_css",),
                ),
            )
        ),
        transaction,
        program,
        staged,
    )


def test_runtime_refuses_any_non_atomic_manifest_commit_configuration() -> None:
    manifests = InMemoryBuildManifestStore()
    manifests.create(_baseline_manifest())
    with pytest.raises(ValueError, match="atomic manifest commit"):
        DeckDesignLiftRuntime(
            mutation_store=InMemoryBuildMutationStore(),
            manifest_store=manifests,
            mechanics=FakeMechanics(),
            judge=FakeJudge(),
            repair_executor=InvokeOnceRepair(),
            materializer=FakeMaterializer(),
        )


def test_candidate_manifest_path_substitution_fails_before_atomic_commit() -> None:
    materializer = SubstitutedManifestPathMaterializer()
    runtime, manifests, mutations, _mechanics, _judge, _repair, _materializer = _runtime(materializer=materializer)

    result = _run(runtime.run(_request()))

    assert result.terminal_code == "candidate_materialization_failed"
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 1
    assert (
        mutations.load(
            transaction_id=result.transaction_id,
            user_id="user-canary-001",
        ).status
        == "rolled_back"
    )
    assert runtime._atomic_committer.calls == []


def test_candidate_object_path_escape_fails_before_staging_transition() -> None:
    materializer = EscapedCandidateObjectMaterializer()
    runtime, manifests, mutations, _mechanics, _judge, _repair, _materializer = _runtime(materializer=materializer)

    result = _run(runtime.run(_request()))

    assert result.terminal_code == "candidate_materialization_failed"
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 1
    assert (
        mutations.load(
            transaction_id=result.transaction_id,
            user_id="user-canary-001",
        ).status
        == "rolled_back"
    )
    assert runtime._atomic_committer.calls == []


def test_initial_satisfied_is_control_and_never_prepares_or_repairs() -> None:
    judge = FakeJudge(initial=_initial_judgment(satisfied=True))
    runtime, _manifests, mutations, _mechanics, _judge, repair, _materializer = _runtime(judge=judge)

    result = _run(runtime.run(_request()))

    assert result.disposition == "NO_REPAIR_NEEDED"
    assert result.terminal_code == "no_repair_needed"
    assert result.transaction_id is None
    assert repair.model_calls == 0
    assert mutations._items == {}


def test_unauthorized_model_update_rolls_back_without_materialization() -> None:
    unauthorized = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:2",
                source_role="body",
                expected_source_hash=HASH,
                content="<section>unauthorized collateral write</section>",
            ),
        ),
        rationale="Attempt collateral change.",
    )
    repair = InvokeOnceRepair(unauthorized)
    runtime, manifests, mutations, _mechanics, _judge, _repair, materializer = _runtime(repair=repair)

    result = _run(runtime.run(_request()))

    assert result.disposition == "FAILED_SAFELY"
    assert result.terminal_code == "candidate_rejected"
    assert materializer.staged == {}
    assert materializer.rollback_calls == 1
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").current_artifact_version_id == "artifact-initial-001"
    assert (
        mutations.load(
            transaction_id=result.transaction_id,
            user_id="user-canary-001",
        ).status
        == "rolled_back"
    )


def test_candidate_mechanical_failure_never_reaches_second_judgment() -> None:
    mechanics = FakeMechanics(fail_candidate=True)
    judge = FakeJudge()
    runtime, manifests, _mutations, _mechanics, _judge, repair, materializer = _runtime(
        mechanics=mechanics,
        judge=judge,
    )

    result = _run(runtime.run(_request()))

    assert result.disposition == "REPAIR_NOT_APPROVED"
    assert result.terminal_code == "candidate_mechanics_failed"
    assert repair.model_calls == 1
    assert judge.candidate_calls == []
    assert materializer.rollback_calls == 1
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 1


def test_deterministic_non_improvement_rolls_back_initial_remains_current() -> None:
    non_improving = _quality(
        candidate=True,
        verdict="needs_revision",
        weighted_score=Decimal("2.5"),
        criterion_scores=_criteria(candidate=False),
        failure_codes=PSI_FAILURES,
    )
    judge = FakeJudge(candidate=non_improving)
    runtime, manifests, _mutations, _mechanics, _judge, _repair, _materializer = _runtime(judge=judge)

    result = _run(runtime.run(_request()))

    assert result.disposition == "REPAIR_NOT_APPROVED"
    assert result.terminal_code == "repair_not_approved"
    assert result.comparison is not None
    assert result.comparison.result == "not_improved"
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").current_artifact_version_id == "artifact-initial-001"


def test_second_quality_run_must_be_fresh_before_comparison() -> None:
    stale = _quality(candidate=True, quality_run_id="quality-initial-001")
    judge = FakeJudge(candidate=stale)
    runtime, manifests, _mutations, _mechanics, _judge, _repair, _materializer = _runtime(judge=judge)

    result = _run(runtime.run(_request()))

    assert result.disposition == "FAILED_SAFELY"
    assert result.terminal_code == "quality_run_not_fresh"
    assert result.comparison is None
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 1


def test_manifest_cas_conflict_rolls_back_and_does_not_retry() -> None:
    runtime, manifests, mutations, _mechanics, _judge, repair, materializer = _runtime(commit_conflict=True)

    result = _run(runtime.run(_request()))

    assert result.disposition == "FAILED_SAFELY"
    assert result.terminal_code == "manifest_concurrent_modification"
    assert repair.model_calls == 1
    assert materializer.rollback_calls == 1
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").current_artifact_version_id == "artifact-initial-001"
    assert mutations.load(transaction_id=result.transaction_id, user_id="user-canary-001").status == "rolled_back"


def test_restart_after_model_call_reuses_invoke_once_result_no_second_repair() -> None:
    mutations = InMemoryBuildMutationStore()
    repair = InvokeOnceRepair()
    repair.crash_after_first_model_call = True
    judge = FakeJudge()
    runtime, manifests, mutations, mechanics, judge, repair, materializer = _runtime(
        mutation_store=mutations,
        repair=repair,
        judge=judge,
    )
    request = _request()

    with pytest.raises(SimulatedWorkerCrash):
        _run(runtime.run(request))

    incomplete = [item.model_copy(deep=True) for item in mutations._items.values()]
    assert len(incomplete) == 1
    assert incomplete[0].status == "prepared"
    assert repair.model_calls == 1

    resumed = request.model_copy(update={"transaction_id": incomplete[0].transaction_id})
    result = _run(runtime.run(resumed))

    assert result.terminal_code == "candidate_committed"
    assert repair.invocation_calls == 2
    assert repair.model_calls == 1
    assert len(judge.initial_calls) == 1
    assert len(judge.candidate_calls) == 1
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 2


def test_trace_completion_pending_preserves_prepared_transaction_for_exact_recovery() -> None:
    repair = TracePendingOnceRepair()
    runtime, manifests, mutations, _mechanics, judge, _repair, materializer = _runtime(
        repair=repair,
    )
    request = _request()

    with pytest.raises(
        DeckDesignLiftRuntimeError,
        match="durable repair result is awaiting trace completion",
    ):
        _run(runtime.run(request))

    transaction = next(iter(mutations._items.values())).model_copy(deep=True)
    assert transaction.status == "prepared"
    assert materializer.staged == {}
    assert materializer.rollback_calls == 0
    assert judge.candidate_calls == []
    assert manifests.load(
        build_id="build-psi-001",
        user_id="user-canary-001",
    ).manifest_revision == 1

    resumed = request.model_copy(
        update={"transaction_id": transaction.transaction_id}
    )
    result = _run(runtime.run(resumed))

    assert result.terminal_code == "candidate_committed"
    assert repair.invocation_calls == 2
    assert repair.provider_calls == 1
    assert len(judge.initial_calls) == 1
    assert len(judge.candidate_calls) == 1


@pytest.mark.parametrize("crash_status", ["staged", "verified"])
def test_worker_sweep_recovers_crash_without_a_second_repair(
    crash_status: str,
) -> None:
    mutations = CrashAfterPersistMutationStore(target_status=crash_status)
    repair = InvokeOnceRepair()
    runtime, manifests, mutations, _mechanics, judge, repair, _materializer = _runtime(
        mutation_store=mutations,
        repair=repair,
    )
    request = _request()

    with pytest.raises(SimulatedWorkerCrash):
        _run(runtime.run(request))

    transaction = next(iter(mutations._items.values())).model_copy(deep=True)
    assert transaction.status == crash_status
    assert repair.model_calls == 1
    _expire_mutation_lease(mutations, transaction)

    recovered_id = _run(
        runtime.recover_incomplete(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            user_id=request.user_id,
            operation_id=request.operation_id,
            lease_owner="worker-render-002",
            lease_seconds=900,
            limit=10,
        )
    )
    assert recovered_id == transaction.transaction_id

    result = _run(
        runtime.run(
            request.model_copy(
                update={
                    "transaction_id": recovered_id,
                    "lease_owner": "worker-render-002",
                }
            )
        )
    )

    assert result.terminal_code == "candidate_committed"
    assert repair.model_calls == 1
    assert len(judge.initial_calls) == 1
    assert len(judge.candidate_calls) == 1
    assert (
        manifests.load(
            build_id="build-psi-001",
            user_id="user-canary-001",
        ).manifest_revision
        == 2
    )


def test_worker_sweep_ignores_expired_legacy_row_beside_matching_dq2() -> None:
    mutations = CrashAfterPersistMutationStore(target_status="staged")
    runtime, _manifests, mutations, _mechanics, _judge, _repair, materializer = _runtime(
        mutation_store=mutations,
    )
    request = _request()

    with pytest.raises(SimulatedWorkerCrash):
        _run(runtime.run(request))

    dq2 = next(iter(mutations._items.values())).model_copy(deep=True)
    _expire_mutation_lease(mutations, dq2)
    legacy = BuildMutationTransaction.model_validate(
        {
            "transaction_id": "legacy-transaction-001",
            "build_id": request.build_id,
            "user_id": request.user_id,
            "operation_id": "legacy-operation-001",
            "expected_manifest_revision": 1,
            "lease_owner": "legacy-worker-001",
            "lease_expires_at": "2000-01-01T00:00:00+00:00",
        }
    )
    mutations.create(legacy)
    partial_dq2 = legacy.model_copy(
        update={
            "transaction_id": "partial-dq2-transaction-001",
            "operation_id": "partial-dq2-operation-001",
            "campaign_run_id": "partial-campaign-001",
            "authorized_selectors": ["slide:1"],
        }
    )
    partial_key = (partial_dq2.user_id, partial_dq2.transaction_id)
    mutations._items[partial_key] = partial_dq2.model_copy(deep=True)
    mutations._operations[
        (
            partial_dq2.user_id,
            partial_dq2.build_id,
            partial_dq2.operation_id,
        )
    ] = partial_key

    recovered_id = _run(
        runtime.recover_incomplete(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            user_id=request.user_id,
            operation_id=request.operation_id,
            lease_owner="worker-render-002",
            lease_seconds=900,
            limit=10,
        )
    )

    assert recovered_id == dq2.transaction_id
    assert (
        mutations.load(
            transaction_id=legacy.transaction_id,
            user_id=legacy.user_id,
        )
        == legacy
    )
    assert (
        mutations.load(
            transaction_id=partial_dq2.transaction_id,
            user_id=partial_dq2.user_id,
        )
        == partial_dq2
    )
    assert materializer.rollback_calls == 0


def test_worker_sweep_rolls_back_expired_unrelated_candidate() -> None:
    mutations = CrashAfterPersistMutationStore(target_status="staged")
    runtime, _manifests, mutations, _mechanics, _judge, repair, materializer = _runtime(
        mutation_store=mutations,
    )
    request = _request()

    with pytest.raises(SimulatedWorkerCrash):
        _run(runtime.run(request))

    transaction = next(iter(mutations._items.values())).model_copy(deep=True)
    _expire_mutation_lease(mutations, transaction)

    recovered_id = _run(
        runtime.recover_incomplete(
            campaign_run_id="campaign-dq2-002",
            experiment_id="experiment-dq2-002",
            build_id=request.build_id,
            user_id=request.user_id,
            operation_id="operation-dq2-002",
            lease_owner="worker-render-002",
            lease_seconds=900,
            limit=10,
        )
    )

    assert recovered_id is None
    assert repair.model_calls == 1
    assert materializer.rollback_calls == 1
    assert (
        mutations.load(
            transaction_id=transaction.transaction_id,
            user_id=request.user_id,
        ).status
        == "rolled_back"
    )


def test_worker_sweep_resolves_committed_transaction_when_caller_lost_its_id() -> None:
    runtime, manifests, mutations, _mechanics, judge, repair, _materializer = _runtime(commit_crash=True)
    request = _request()

    with pytest.raises(SimulatedWorkerCrash):
        _run(runtime.run(request))

    committed = next(iter(mutations._items.values())).model_copy(deep=True)
    assert committed.status == "committed"
    assert committed.committed_manifest_revision == 2
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 2

    with pytest.raises(DeckDesignLiftRuntimeError, match="conflicting campaign identity"):
        _run(
            runtime.recover_incomplete(
                campaign_run_id="campaign-dq2-002",
                experiment_id=request.experiment_id,
                build_id=request.build_id,
                user_id=request.user_id,
                operation_id=request.operation_id,
                lease_owner="worker-render-002",
                lease_seconds=900,
                limit=10,
            )
        )

    recovered_id = _run(
        runtime.recover_incomplete(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            user_id=request.user_id,
            operation_id=request.operation_id,
            lease_owner="worker-render-002",
            lease_seconds=900,
            limit=10,
        )
    )
    assert recovered_id == committed.transaction_id

    resumed = request.model_copy(
        update={
            "transaction_id": recovered_id,
            "lease_owner": "worker-render-002",
        }
    )
    result = _run(runtime.run(resumed))

    assert result.terminal_code == "candidate_committed"
    assert result.committed_manifest_revision == 2
    assert repair.model_calls == 1
    assert len(judge.initial_calls) == 1
    assert len(judge.candidate_calls) == 1


def test_lost_atomic_commit_response_is_recovered_from_durable_transaction() -> None:
    runtime, manifests, mutations, _mechanics, _judge, repair, _materializer = _runtime(commit_response_loss=True)

    result = _run(runtime.run(_request()))

    assert result.terminal_code == "candidate_committed"
    assert result.committed_manifest_revision == 2
    assert repair.model_calls == 1
    assert manifests.load(build_id="build-psi-001", user_id="user-canary-001").manifest_revision == 2
    assert (
        mutations.load(
            transaction_id=result.transaction_id,
            user_id="user-canary-001",
        ).status
        == "committed"
    )
