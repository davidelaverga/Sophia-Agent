from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildManifest,
    BuildManifestConcurrentModification,
    BuildManifestStore,
    component_dependency_closure,
    manifest_components_by_selector,
)
from deerflow.sophia.build_mutation import (
    BuildMutationStore,
    BuildMutationTransaction,
)
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.comparator import compare_deck_versions
from deerflow.sophia.deck_design_lift.compiler import (
    RepairProgramRejected,
    compile_repair_program,
    validate_candidate_against_program,
)
from deerflow.sophia.deck_design_lift.schemas import (
    ContentPreservationProof,
    DeckRepairCandidate,
    DeckRepairProgram,
    DeckVersionComparison,
    DeckVersionComparisonInput,
    JudgmentRepairFinding,
    LocalityProof,
    RepairCompilerInput,
    SelectorSourceAuthorization,
    VersionQualityEvidence,
)
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import MechanicalProjection, ShadowDecision
from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

CorrelationId = Annotated[
    str,
    Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9:_-]*$",
    ),
]

_CHECKPOINT_KEY = "deck_design_lift_runtime"
_CHECKPOINT_SCHEMA = "sophia-deck-design-lift-checkpoint/v1"


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DeckDesignLiftRuntimeError(RuntimeError):
    """The runtime could not prove that it reached a durable safe state."""


class InitialRenderedJudgment(_StrictFrozenModel):
    evidence: VersionQualityEvidence
    decision: ShadowDecision
    findings: tuple[JudgmentRepairFinding, ...] = ()

    @model_validator(mode="after")
    def align_decision_and_evidence(self) -> InitialRenderedJudgment:
        if self.decision.result != self.evidence.verdict:
            raise ValueError("initial decision and version evidence verdicts disagree")
        if set(self.decision.failure_codes) != set(self.evidence.failure_codes):
            raise ValueError("initial decision and version evidence failures disagree")
        if self.decision.weighted_score is not None and self.decision.weighted_score != self.evidence.weighted_score:
            raise ValueError("initial decision and version evidence scores disagree")
        if self.decision.result == "needs_revision" and not self.findings:
            raise ValueError("needs_revision requires repair findings")
        if self.decision.result != "needs_revision" and self.findings:
            raise ValueError("non-repairable judgments cannot grant repair findings")
        return self


class BlindDeckJudgmentRequest(_StrictFrozenModel):
    """The complete input boundary for a blind rendered judgment.

    It intentionally contains no earlier verdict, scores, repair program, repair
    rationale, or improvement claim.  Initial and candidate adapters receive the
    same shape.
    """

    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    artifact: BuildArtifactVersion
    mechanics: MechanicalProjection


class RepairInvocationRequest(_StrictFrozenModel):
    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    user_id: CorrelationId
    thread_id: CorrelationId
    build_id: CorrelationId
    operation_id: CorrelationId
    transaction_id: CorrelationId
    initial_artifact_version_id: CorrelationId
    program: DeckRepairProgram

    @model_validator(mode="after")
    def validate_durable_scope(self) -> RepairInvocationRequest:
        if self.build_id != self.program.build_id:
            raise ValueError("repair invocation build does not match the frozen program")
        for value, default in (
            (self.thread_id, "thread"),
            (self.build_id, "build"),
        ):
            if safe_object_path_segment(value, default=default) != value:
                raise ValueError("repair invocation storage scope is not canonical")
        return self


class StagedDeckCandidate(_StrictFrozenModel):
    artifact: BuildArtifactVersion
    candidate_manifest: BuildManifest
    manifest_object_path: str = Field(min_length=1, max_length=4_096)
    manifest_hash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    staged_object_paths: tuple[str, ...]
    candidate_version_ids: tuple[CorrelationId, ...]
    locality: LocalityProof
    content: ContentPreservationProof

    @model_validator(mode="after")
    def validate_stage_identity(self) -> StagedDeckCandidate:
        if not self.staged_object_paths:
            raise ValueError("candidate staging requires durable object paths")
        if any(not path.strip() or ".." in path.split("/") for path in self.staged_object_paths):
            raise ValueError("candidate staging contains an unsafe object path")
        if len(set(self.staged_object_paths)) != len(self.staged_object_paths):
            raise ValueError("candidate staging contains duplicate object paths")
        if self.manifest_object_path not in self.staged_object_paths:
            raise ValueError("candidate manifest is outside durable build storage")
        if not self.candidate_version_ids:
            raise ValueError("candidate staging requires immutable version IDs")
        if len(set(self.candidate_version_ids)) != len(self.candidate_version_ids):
            raise ValueError("candidate staging contains duplicate version IDs")
        if self.artifact.version_id != self.candidate_manifest.current_artifact_version_id:
            raise ValueError("candidate artifact and manifest pointers disagree")
        if self.artifact.version_id not in self.candidate_version_ids:
            raise ValueError("candidate artifact version is absent from staged version IDs")
        encoded_manifest = json.dumps(
            self.candidate_manifest.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
        if self.manifest_hash != hashlib.sha256(encoded_manifest).hexdigest():
            raise ValueError("candidate manifest hash does not match canonical bytes")
        if self.artifact.build_id != self.candidate_manifest.build_id:
            raise ValueError("candidate artifact escaped the build scope")
        if not self.artifact.verified:
            raise ValueError("candidate artifact must have verified durable bytes")
        return self


class DeckDesignLiftRequest(_StrictFrozenModel):
    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    user_id: CorrelationId
    operation_id: CorrelationId
    lease_owner: CorrelationId
    expected_manifest_revision: int = Field(ge=1)
    initial_artifact: BuildArtifactVersion
    source_authorizations: tuple[SelectorSourceAuthorization, ...]
    rubric_version: str = Field(min_length=1, max_length=512)
    instrument_hash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    plan_revision_allowed: bool = False
    additional_must_preserve: tuple[str, ...] = ()
    additional_must_not: tuple[str, ...] = ()
    transaction_id: CorrelationId | None = None
    lease_seconds: int = Field(default=120, ge=1, le=900)

    @model_validator(mode="after")
    def validate_initial_identity(self) -> DeckDesignLiftRequest:
        if self.initial_artifact.build_id != self.build_id:
            raise ValueError("initial artifact escaped the build scope")
        if self.initial_artifact.manifest_revision != self.expected_manifest_revision:
            raise ValueError("initial artifact revision does not match the requested manifest")
        if not self.initial_artifact.verified:
            raise ValueError("initial artifact must have verified durable bytes")
        if not self.source_authorizations:
            raise ValueError("runtime requires a frozen source authorization inventory")
        return self


RuntimeDisposition = Literal[
    "RUNTIME_COMMITTED_PENDING_AUDIT",
    "NO_REPAIR_NEEDED",
    "REPAIR_NOT_APPROVED",
    "FAILED_SAFELY",
]

RuntimeTerminalCode = Literal[
    "candidate_committed",
    "no_repair_needed",
    "initial_mechanics_failed",
    "initial_not_repairable",
    "repair_program_rejected",
    "repair_invocation_failed",
    "candidate_rejected",
    "candidate_materialization_failed",
    "candidate_mechanics_failed",
    "candidate_judgment_failed",
    "quality_run_not_fresh",
    "repair_not_approved",
    "manifest_concurrent_modification",
]


class DeckDesignLiftResult(_StrictFrozenModel):
    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    operation_id: CorrelationId
    disposition: RuntimeDisposition
    terminal_code: RuntimeTerminalCode
    transaction_id: CorrelationId | None = None
    initial_quality_run_id: str | None = None
    candidate_quality_run_id: str | None = None
    comparison: DeckVersionComparison | None = None
    committed_manifest_revision: int | None = None

    @model_validator(mode="after")
    def validate_terminal_evidence(self) -> DeckDesignLiftResult:
        if self.disposition == "RUNTIME_COMMITTED_PENDING_AUDIT":
            if self.terminal_code != "candidate_committed" or self.transaction_id is None or self.comparison is None or self.comparison.result != "approved_improvement" or self.committed_manifest_revision is None:
                raise ValueError("committed runtime result lacks approval evidence")
        if self.transaction_id is None and self.terminal_code not in {
            "no_repair_needed",
            "initial_mechanics_failed",
            "initial_not_repairable",
            "repair_program_rejected",
        }:
            raise ValueError("post-repair terminal results require a transaction")
        return self


class DeckMechanics(Protocol):
    async def verify(
        self,
        *,
        artifact: BuildArtifactVersion,
        campaign_run_id: str,
        experiment_id: str,
    ) -> MechanicalProjection: ...


class DeckQualityJudge(Protocol):
    """Durable blind judgments keyed by campaign, experiment, and artifact.

    A retry for the same tuple must return the persisted quality run instead of
    spending another judge call.  A different artifact must receive a distinct
    quality-run identity.
    """

    async def judge_initial(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> InitialRenderedJudgment: ...

    async def judge_candidate(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> VersionQualityEvidence: ...


class DeckRepairExecutor(Protocol):
    async def invoke_once(
        self,
        request: RepairInvocationRequest,
    ) -> DeckRepairCandidate:
        """Return the operation result through a durable idempotency key.

        Implementations MUST make ``operation_id`` an invoke-once boundary: a
        retry may load the prior structured output but may not make a second
        model call.
        """
        ...


class DeckCandidateMaterializer(Protocol):
    async def stage(
        self,
        *,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        candidate: DeckRepairCandidate,
    ) -> StagedDeckCandidate:
        """Idempotently materialize immutable candidate versions.

        Implementations must compare every ``expected_source_hash`` before a
        write and fail closed on mismatch; uploading candidate bytes alone must
        never move a current manifest pointer.
        """
        ...

    async def load_staged(
        self,
        *,
        transaction: BuildMutationTransaction,
    ) -> StagedDeckCandidate: ...

    async def rollback(
        self,
        *,
        transaction: BuildMutationTransaction,
    ) -> None:
        """Idempotently leave all candidate pointers non-current."""
        ...


class AtomicDeckManifestCommitter(Protocol):
    """Atomic manifest-head, registry, outbox, and mutation commit boundary."""

    def commit_manifest(
        self,
        transaction: BuildMutationTransaction,
        *,
        manifest: BuildManifest,
        manifest_object_path: str,
        manifest_hash: str,
        acceptance: ArtifactAcceptedPayload,
    ) -> BuildMutationTransaction: ...


def _transaction_copy(
    transaction: BuildMutationTransaction,
    **updates: object,
) -> BuildMutationTransaction:
    payload = transaction.model_dump(mode="json")
    payload.update(updates)
    return BuildMutationTransaction.model_validate(payload)


def _runtime_checkpoint(transaction: BuildMutationTransaction) -> dict[str, object]:
    checkpoint = transaction.gate_evidence.get(_CHECKPOINT_KEY)
    if not isinstance(checkpoint, dict) or checkpoint.get("schema_version") != _CHECKPOINT_SCHEMA:
        raise DeckDesignLiftRuntimeError("durable DQ-2 runtime checkpoint is missing")
    return checkpoint


def _checkpoint_update(
    transaction: BuildMutationTransaction,
    **updates: object,
) -> dict[str, object]:
    checkpoint = dict(_runtime_checkpoint(transaction))
    checkpoint.update(updates)
    evidence = dict(transaction.gate_evidence)
    evidence[_CHECKPOINT_KEY] = checkpoint
    return evidence


def _program_from_checkpoint(transaction: BuildMutationTransaction) -> DeckRepairProgram:
    try:
        return DeckRepairProgram.model_validate(_runtime_checkpoint(transaction)["repair_program"])
    except Exception:
        raise DeckDesignLiftRuntimeError("durable repair program is invalid") from None


def _initial_from_checkpoint(transaction: BuildMutationTransaction) -> InitialRenderedJudgment:
    try:
        return InitialRenderedJudgment.model_validate(_runtime_checkpoint(transaction)["initial_judgment"])
    except Exception:
        raise DeckDesignLiftRuntimeError("durable initial judgment is invalid") from None


def _comparison_from_checkpoint(
    transaction: BuildMutationTransaction,
) -> DeckVersionComparison:
    try:
        comparison = DeckVersionComparison.model_validate(_runtime_checkpoint(transaction)["comparison"])
    except Exception:
        raise DeckDesignLiftRuntimeError("durable comparison evidence is invalid") from None
    if transaction.comparison_hash != canonical_sha256(comparison.model_dump(mode="json")):
        raise DeckDesignLiftRuntimeError("durable comparison hash does not match evidence")
    if (
        transaction.initial_quality_run_id != comparison.initial_quality_run_id
        or transaction.candidate_quality_run_id != comparison.candidate_quality_run_id
        or transaction.expected_artifact_version_id != comparison.initial_artifact_version_id
    ):
        raise DeckDesignLiftRuntimeError("durable comparison escaped transaction identity")
    return comparison


def _component_versions(manifest: BuildManifest) -> dict[str, str]:
    return {selector: component.current_version_id for selector, component in manifest_components_by_selector(manifest).items()}


def _authorized_roles(program: DeckRepairProgram) -> dict[str, list[str]]:
    return {selector: list(program.authorized_source_roles[selector]) for selector in program.authorized_selectors}


class DeckDesignLiftRuntime:
    """Strict one-repair DQ-2 transaction orchestrator.

    The orchestrator owns ordering, durable checkpoints, authorization checks,
    blind-evaluation boundaries, deterministic comparison, and manifest CAS.
    Rendering/model/storage details remain injected and independently testable.
    """

    def __init__(
        self,
        *,
        mutation_store: BuildMutationStore,
        manifest_store: BuildManifestStore,
        mechanics: DeckMechanics,
        judge: DeckQualityJudge,
        repair_executor: DeckRepairExecutor,
        materializer: DeckCandidateMaterializer,
        atomic_committer: AtomicDeckManifestCommitter | None = None,
    ) -> None:
        resolved_committer = atomic_committer or mutation_store
        if not callable(getattr(resolved_committer, "commit_manifest", None)):
            raise ValueError("DQ-2 runtime requires an atomic manifest commit coordinator")
        self._mutations = mutation_store
        self._manifests = manifest_store
        self._atomic_committer = cast(AtomicDeckManifestCommitter, resolved_committer)
        self._mechanics = mechanics
        self._judge = judge
        self._repair = repair_executor
        self._materializer = materializer

    async def run(self, request: DeckDesignLiftRequest) -> DeckDesignLiftResult:
        if request.transaction_id is not None:
            transaction = self._mutations.load(
                transaction_id=request.transaction_id,
                user_id=request.user_id,
            )
            self._validate_transaction_scope(transaction, request)
            if transaction.status not in {"committed", "rolled_back", "failed"}:
                transaction = self._mutations.acquire_lease(
                    transaction_id=transaction.transaction_id,
                    user_id=request.user_id,
                    lease_owner=request.lease_owner,
                    lease_seconds=request.lease_seconds,
                )
            return await self._resume(request, transaction)

        baseline = self._load_and_validate_baseline(request)
        initial_mechanics = await self._mechanics.verify(
            artifact=request.initial_artifact,
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
        )
        if initial_mechanics.status != "passed":
            return self._result(
                request,
                disposition="FAILED_SAFELY",
                terminal_code="initial_mechanics_failed",
            )

        initial = await self._judge.judge_initial(
            BlindDeckJudgmentRequest(
                campaign_run_id=request.campaign_run_id,
                experiment_id=request.experiment_id,
                build_id=request.build_id,
                artifact=request.initial_artifact,
                mechanics=initial_mechanics,
            )
        )
        self._validate_initial_judgment(request, initial, initial_mechanics)
        if initial.evidence.verdict == "satisfied":
            return self._result(
                request,
                disposition="NO_REPAIR_NEEDED",
                terminal_code="no_repair_needed",
                initial_quality_run_id=initial.evidence.quality_run_id,
            )
        if initial.evidence.verdict != "needs_revision":
            return self._result(
                request,
                disposition="FAILED_SAFELY",
                terminal_code="initial_not_repairable",
                initial_quality_run_id=initial.evidence.quality_run_id,
            )

        compiler_input = RepairCompilerInput(
            build_id=request.build_id,
            initial_quality_run_id=initial.evidence.quality_run_id,
            initial_manifest_revision=request.expected_manifest_revision,
            initial_decision=initial.decision,
            prior_repair_count=0,
            plan_revision_allowed=request.plan_revision_allowed,
            source_authorizations=request.source_authorizations,
            findings=initial.findings,
            additional_must_preserve=request.additional_must_preserve,
            additional_must_not=request.additional_must_not,
            rubric_version=request.rubric_version,
            instrument_hash=request.instrument_hash,
        )
        try:
            program = compile_repair_program(compiler_input)
        except RepairProgramRejected:
            return self._result(
                request,
                disposition="FAILED_SAFELY",
                terminal_code="repair_program_rejected",
                initial_quality_run_id=initial.evidence.quality_run_id,
            )

        checkpoint = {
            "schema_version": _CHECKPOINT_SCHEMA,
            "campaign_run_id": request.campaign_run_id,
            "experiment_id": request.experiment_id,
            "owner_thread_id": baseline.thread_id,
            "initial_mechanics": initial_mechanics.model_dump(mode="json"),
            "initial_judgment": initial.model_dump(mode="json"),
            "repair_program": program.model_dump(mode="json"),
        }
        prepared = BuildMutationTransaction.prepare(
            build_id=request.build_id,
            user_id=request.user_id,
            operation_id=request.operation_id,
            expected_manifest_revision=request.expected_manifest_revision,
            lease_owner=request.lease_owner,
            lease_seconds=request.lease_seconds,
            owner_thread_id=baseline.thread_id,
            expected_artifact_version_id=request.initial_artifact.version_id,
            expected_artifact_hash=request.initial_artifact.artifact_hash,
            expected_component_versions=_component_versions(baseline),
            authorized_selectors=list(program.authorized_selectors),
            campaign_run_id=request.campaign_run_id,
            authorized_source_roles=_authorized_roles(program),
            repair_program_hash=program.program_hash,
            initial_quality_run_id=initial.evidence.quality_run_id,
        )
        prepared = _transaction_copy(
            prepared,
            gate_evidence={_CHECKPOINT_KEY: checkpoint},
        )
        transaction = self._mutations.create(prepared)
        self._validate_transaction_scope(transaction, request)
        return await self._resume(request, transaction)

    async def _resume(
        self,
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
    ) -> DeckDesignLiftResult:
        if transaction.status == "committed":
            return self._committed_result(request, transaction)
        if transaction.status in {"rolled_back", "failed"}:
            return self._rolled_back_result(request, transaction)
        if transaction.status == "rolling_back":
            transaction = await self._finish_rollback(transaction)
            return self._rolled_back_result(request, transaction)

        program = _program_from_checkpoint(transaction)
        initial = _initial_from_checkpoint(transaction)
        self._validate_frozen_scope(transaction, program, initial)

        if transaction.status == "prepared":
            try:
                candidate = await self._repair.invoke_once(
                    RepairInvocationRequest(
                        campaign_run_id=request.campaign_run_id,
                        experiment_id=request.experiment_id,
                        user_id=request.user_id,
                        thread_id=cast(str, transaction.owner_thread_id),
                        build_id=transaction.build_id,
                        operation_id=request.operation_id,
                        transaction_id=transaction.transaction_id,
                        initial_artifact_version_id=request.initial_artifact.version_id,
                        program=program,
                    )
                )
            except Exception:
                return await self._rollback_result(
                    request,
                    transaction,
                    code="repair_invocation_failed",
                    disposition="FAILED_SAFELY",
                )
            try:
                validate_candidate_against_program(candidate, program)
            except (RepairProgramRejected, ValueError):
                return await self._rollback_result(
                    request,
                    transaction,
                    code="candidate_rejected",
                    disposition="FAILED_SAFELY",
                )
            try:
                staged = await self._materializer.stage(
                    transaction=transaction,
                    program=program,
                    candidate=candidate,
                )
                self._validate_staged_candidate(request, transaction, program, staged)
            except Exception:
                return await self._rollback_result(
                    request,
                    transaction,
                    code="candidate_materialization_failed",
                    disposition="FAILED_SAFELY",
                )
            transaction = self._mutations.transition(
                _transaction_copy(
                    transaction,
                    status="staged",
                    staged_object_paths=list(staged.staged_object_paths),
                    candidate_version_ids=list(staged.candidate_version_ids),
                    candidate_manifest_object_path=staged.manifest_object_path,
                    candidate_manifest_hash=staged.manifest_hash,
                    candidate_artifact_version_id=staged.artifact.version_id,
                    candidate_artifact_hash=staged.artifact.artifact_hash,
                    gate_evidence=_checkpoint_update(
                        transaction,
                        candidate_artifact_version_id=staged.artifact.version_id,
                        candidate_artifact_hash=staged.artifact.artifact_hash,
                    ),
                ),
                expected_status="prepared",
            )

        if transaction.status == "staged":
            staged = await self._load_and_validate_staged(
                request,
                transaction,
                program,
            )
            candidate_mechanics = await self._mechanics.verify(
                artifact=staged.artifact,
                campaign_run_id=request.campaign_run_id,
                experiment_id=request.experiment_id,
            )
            if candidate_mechanics.status != "passed":
                return await self._rollback_result(
                    request,
                    transaction,
                    code="candidate_mechanics_failed",
                    disposition="REPAIR_NOT_APPROVED",
                )
            try:
                candidate_quality = await self._judge.judge_candidate(
                    BlindDeckJudgmentRequest(
                        campaign_run_id=request.campaign_run_id,
                        experiment_id=request.experiment_id,
                        build_id=request.build_id,
                        artifact=staged.artifact,
                        mechanics=candidate_mechanics,
                    )
                )
                self._validate_candidate_judgment(staged, candidate_quality, candidate_mechanics)
            except Exception:
                return await self._rollback_result(
                    request,
                    transaction,
                    code="candidate_judgment_failed",
                    disposition="FAILED_SAFELY",
                )
            if candidate_quality.quality_run_id == initial.evidence.quality_run_id:
                return await self._rollback_result(
                    request,
                    transaction,
                    code="quality_run_not_fresh",
                    disposition="FAILED_SAFELY",
                )
            comparison = compare_deck_versions(
                DeckVersionComparisonInput(
                    initial=initial.evidence,
                    candidate=candidate_quality,
                    locality=staged.locality,
                    content=staged.content,
                    expected_failure_codes=program.expected_improvements,
                )
            )
            if comparison.result != "approved_improvement":
                transaction = _transaction_copy(
                    transaction,
                    candidate_quality_run_id=candidate_quality.quality_run_id,
                    comparison_hash=canonical_sha256(comparison.model_dump(mode="json")),
                    gate_evidence=_checkpoint_update(
                        transaction,
                        candidate_mechanics=candidate_mechanics.model_dump(mode="json"),
                        candidate_quality=candidate_quality.model_dump(mode="json"),
                        locality=staged.locality.model_dump(mode="json"),
                        content=staged.content.model_dump(mode="json"),
                        comparison=comparison.model_dump(mode="json"),
                    ),
                )
                return await self._rollback_result(
                    request,
                    transaction,
                    code="repair_not_approved",
                    disposition="REPAIR_NOT_APPROVED",
                )

            comparison_hash = canonical_sha256(comparison.model_dump(mode="json"))
            transaction = self._mutations.transition(
                _transaction_copy(
                    transaction,
                    status="verified",
                    candidate_quality_run_id=candidate_quality.quality_run_id,
                    comparison_hash=comparison_hash,
                    gate_evidence=_checkpoint_update(
                        transaction,
                        candidate_mechanics=candidate_mechanics.model_dump(mode="json"),
                        candidate_quality=candidate_quality.model_dump(mode="json"),
                        locality=staged.locality.model_dump(mode="json"),
                        content=staged.content.model_dump(mode="json"),
                        comparison=comparison.model_dump(mode="json"),
                    ),
                ),
                expected_status="staged",
            )

        if transaction.status == "verified":
            transaction = self._mutations.transition(
                _transaction_copy(transaction, status="committing"),
                expected_status="verified",
            )

        if transaction.status == "committing":
            staged = await self._load_and_validate_staged(
                request,
                transaction,
                program,
            )
            comparison = _comparison_from_checkpoint(transaction)
            if comparison.result != "approved_improvement":
                raise DeckDesignLiftRuntimeError("committing transaction lacks approved comparison")
            try:
                transaction = self._commit_manifest_atomically(
                    transaction,
                    staged,
                )
            except BuildManifestConcurrentModification:
                return await self._rollback_result(
                    request,
                    transaction,
                    code="manifest_concurrent_modification",
                    disposition="FAILED_SAFELY",
                )
            self._validate_transaction_scope(transaction, request)
            self._validate_frozen_scope(transaction, program, initial)
            return self._committed_result(request, transaction)

        raise DeckDesignLiftRuntimeError(f"unsupported DQ-2 transaction status: {transaction.status}")

    def _load_and_validate_baseline(
        self,
        request: DeckDesignLiftRequest,
    ) -> BuildManifest:
        manifest = self._manifests.load(build_id=request.build_id, user_id=request.user_id)
        if manifest.manifest_revision != request.expected_manifest_revision or manifest.current_artifact_version_id != request.initial_artifact.version_id or manifest.build_id != request.build_id or manifest.user_id != request.user_id:
            raise BuildManifestConcurrentModification("initial manifest identity does not match the campaign request")
        return manifest

    @staticmethod
    def _validate_initial_judgment(
        request: DeckDesignLiftRequest,
        judgment: InitialRenderedJudgment,
        mechanics: MechanicalProjection,
    ) -> None:
        if judgment.evidence.artifact_version_id != request.initial_artifact.version_id:
            raise DeckDesignLiftRuntimeError("initial judgment escaped the artifact scope")
        if not judgment.evidence.mechanics_passed or mechanics.status != "passed":
            raise DeckDesignLiftRuntimeError("initial judgment contradicts mechanical truth")
        if not judgment.evidence.coverage_complete or judgment.evidence.grader_error:
            raise DeckDesignLiftRuntimeError("initial rendered judgment is incomplete")

    @staticmethod
    def _validate_candidate_judgment(
        staged: StagedDeckCandidate,
        judgment: VersionQualityEvidence,
        mechanics: MechanicalProjection,
    ) -> None:
        if judgment.artifact_version_id != staged.artifact.version_id:
            raise DeckDesignLiftRuntimeError("candidate judgment escaped the artifact scope")
        if judgment.mechanics_passed != (mechanics.status == "passed"):
            raise DeckDesignLiftRuntimeError("candidate judgment contradicts mechanical truth")

    @staticmethod
    def _validate_transaction_scope(
        transaction: BuildMutationTransaction,
        request: DeckDesignLiftRequest,
    ) -> None:
        try:
            checkpoint = _runtime_checkpoint(transaction)
        except DeckDesignLiftRuntimeError:
            raise
        expected = {
            "build_id": request.build_id,
            "user_id": request.user_id,
            "operation_id": request.operation_id,
            "owner_thread_id": checkpoint.get("owner_thread_id"),
            "campaign_run_id": request.campaign_run_id,
            "expected_manifest_revision": request.expected_manifest_revision,
            "expected_artifact_version_id": request.initial_artifact.version_id,
            "expected_artifact_hash": request.initial_artifact.artifact_hash,
        }
        actual = {
            "build_id": transaction.build_id,
            "user_id": transaction.user_id,
            "operation_id": transaction.operation_id,
            "owner_thread_id": transaction.owner_thread_id,
            "campaign_run_id": transaction.campaign_run_id,
            "expected_manifest_revision": transaction.expected_manifest_revision,
            "expected_artifact_version_id": transaction.expected_artifact_version_id,
            "expected_artifact_hash": transaction.expected_artifact_hash,
        }
        if actual != expected:
            raise DeckDesignLiftRuntimeError("transaction escaped the frozen campaign scope")
        if checkpoint.get("campaign_run_id") != request.campaign_run_id or checkpoint.get("experiment_id") != request.experiment_id:
            raise DeckDesignLiftRuntimeError("transaction correlation identity mismatch")

    @staticmethod
    def _validate_frozen_scope(
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        initial: InitialRenderedJudgment,
    ) -> None:
        if (
            transaction.repair_program_hash != program.program_hash
            or transaction.initial_quality_run_id != initial.evidence.quality_run_id
            or transaction.authorized_selectors != list(program.authorized_selectors)
            or transaction.authorized_source_roles != _authorized_roles(program)
            or program.repair_attempt != 1
        ):
            raise DeckDesignLiftRuntimeError("durable repair authorization mismatch")

    async def _load_and_validate_staged(
        self,
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
    ) -> StagedDeckCandidate:
        staged = await self._materializer.load_staged(transaction=transaction)
        self._validate_staged_candidate(request, transaction, program, staged)
        if (
            transaction.staged_object_paths != list(staged.staged_object_paths)
            or transaction.candidate_version_ids != list(staged.candidate_version_ids)
            or transaction.candidate_manifest_object_path != staged.manifest_object_path
            or transaction.candidate_manifest_hash != staged.manifest_hash
            or transaction.candidate_artifact_version_id != staged.artifact.version_id
            or transaction.candidate_artifact_hash != staged.artifact.artifact_hash
        ):
            raise DeckDesignLiftRuntimeError("staged candidate escaped durable identity")
        return staged

    @staticmethod
    def _validate_staged_candidate(
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        staged: StagedDeckCandidate,
    ) -> None:
        manifest = staged.candidate_manifest
        if (
            manifest.build_id != request.build_id
            or manifest.user_id != request.user_id
            or manifest.thread_id != transaction.owner_thread_id
            or staged.artifact.build_id != request.build_id
            or staged.artifact.manifest_revision != request.expected_manifest_revision + 1
            or manifest.manifest_revision != request.expected_manifest_revision + 1
            or manifest.logical_artifact_id is None
            or manifest.current_artifact_version_id != staged.artifact.version_id
        ):
            raise DeckDesignLiftRuntimeError("candidate escaped the frozen build scope")
        deck_extension = manifest.format_extensions.get("deck")
        if not isinstance(deck_extension, dict) or deck_extension.get("current_pptx_hash") != staged.artifact.artifact_hash:
            raise DeckDesignLiftRuntimeError("candidate manifest does not bind the staged artifact hash")
        baseline_versions = transaction.expected_component_versions
        candidate_versions = _component_versions(manifest)
        if set(candidate_versions) != set(baseline_versions):
            raise DeckDesignLiftRuntimeError("candidate changed the manifest component inventory")
        changed = {selector for selector, version_id in candidate_versions.items() if baseline_versions[selector] != version_id}
        if changed != set(staged.locality.changed_component_versions):
            raise DeckDesignLiftRuntimeError("candidate locality proof does not match manifest versions")
        try:
            expected_changed = set(
                component_dependency_closure(
                    manifest,
                    program.authorized_selectors,
                )
            )
        except ValueError:
            raise DeckDesignLiftRuntimeError("candidate dependency graph is invalid") from None
        if not changed or changed != expected_changed:
            raise DeckDesignLiftRuntimeError("candidate changed an unauthorized component version")
        if set(staged.locality.authorized_selectors) != set(program.authorized_selectors):
            raise DeckDesignLiftRuntimeError("candidate locality authorization mismatch")
        expected_shared_change = DECK_STYLE_ROOT_SELECTOR in program.authorized_selectors
        if staged.locality.shared_dependency_changed != expected_shared_change:
            raise DeckDesignLiftRuntimeError("candidate shared-dependency proof does not match authorization")
        unchanged = set(baseline_versions) - changed
        if unchanged != set(staged.locality.unchanged_component_versions):
            raise DeckDesignLiftRuntimeError("candidate locality proof does not cover every unchanged component")
        changed_version_ids = {candidate_versions[selector] for selector in changed}
        if not changed_version_ids.issubset(set(staged.candidate_version_ids)):
            raise DeckDesignLiftRuntimeError("candidate version inventory omits a changed component version")
        if staged.artifact.version_id == transaction.expected_artifact_version_id:
            raise DeckDesignLiftRuntimeError("candidate artifact version is not distinct")
        expected_manifest_path = (
            "artifacts/"
            f"{safe_object_path_segment(request.user_id, default='user')}/"
            f"{safe_object_path_segment(transaction.owner_thread_id, default='thread')}/"
            "foundation/.builder/builds/"
            f"{safe_object_path_segment(request.build_id, default='build')}/"
            f"manifest/manifest-r{request.expected_manifest_revision + 1}.json"
        )
        if staged.manifest_object_path != expected_manifest_path:
            raise DeckDesignLiftRuntimeError("candidate manifest path is not the canonical immutable revision path")
        expected_object_prefix = expected_manifest_path.rsplit("manifest/", 1)[0]
        expected_artifact_prefix = (
            expected_object_prefix
            + "artifacts/"
            + safe_object_path_segment(
                staged.artifact.version_id,
                default="artifact_version",
            )
            + "/"
        )
        if (
            any(not path.startswith(expected_object_prefix) for path in staged.staged_object_paths)
            or staged.artifact.storage_object_path not in staged.staged_object_paths
            or not staged.artifact.storage_object_path.startswith(expected_artifact_prefix)
        ):
            raise DeckDesignLiftRuntimeError("candidate objects escaped the frozen thread/build storage scope")
        checkpoint = _runtime_checkpoint(transaction)
        checkpoint_artifact_id = checkpoint.get("candidate_artifact_version_id")
        checkpoint_artifact_hash = checkpoint.get("candidate_artifact_hash")
        if checkpoint_artifact_id is not None and (checkpoint_artifact_id != staged.artifact.version_id or checkpoint_artifact_hash != staged.artifact.artifact_hash):
            raise DeckDesignLiftRuntimeError("candidate artifact escaped durable staging identity")
        if transaction.comparison_hash is not None:
            comparison = _comparison_from_checkpoint(transaction)
            if comparison.candidate_artifact_version_id != staged.artifact.version_id:
                raise DeckDesignLiftRuntimeError("candidate artifact does not match the approved comparison")

    def _commit_manifest_atomically(
        self,
        transaction: BuildMutationTransaction,
        staged: StagedDeckCandidate,
    ) -> BuildMutationTransaction:
        manifest = staged.candidate_manifest
        acceptance = ArtifactAcceptedPayload(
            build_id=manifest.build_id,
            logical_artifact_id=str(manifest.logical_artifact_id),
            artifact_version_id=staged.artifact.version_id,
            manifest_revision=transaction.expected_manifest_revision + 1,
            artifact_type=manifest.format,
            artifact_path=staged.artifact.artifact_path,
            storage_object_path=staged.artifact.storage_object_path,
            origin="quality_repair",
        )
        try:
            committed = self._atomic_committer.commit_manifest(
                transaction,
                manifest=manifest,
                manifest_object_path=staged.manifest_object_path,
                manifest_hash=staged.manifest_hash,
                acceptance=acceptance,
            )
        except BuildManifestConcurrentModification:
            raise
        except Exception:
            # A lost RPC response may follow a fully committed database
            # transaction.  Read the durable mutation before declaring the
            # outcome unknown; never perform a split fallback commit.
            try:
                recovered = self._mutations.load(
                    transaction_id=transaction.transaction_id,
                    user_id=transaction.user_id,
                )
            except Exception:
                raise DeckDesignLiftRuntimeError("atomic manifest commit outcome could not be recovered") from None
            if recovered.status == "committed":
                committed = recovered
            else:
                raise DeckDesignLiftRuntimeError("atomic manifest commit remains safely unconfirmed") from None
        expected_revision = transaction.expected_manifest_revision + 1
        if (
            committed.status != "committed"
            or committed.transaction_id != transaction.transaction_id
            or committed.user_id != transaction.user_id
            or committed.build_id != transaction.build_id
            or committed.committed_manifest_revision != expected_revision
            or committed.candidate_quality_run_id != transaction.candidate_quality_run_id
            or committed.comparison_hash != transaction.comparison_hash
        ):
            raise DeckDesignLiftRuntimeError("atomic manifest commit returned an invalid transaction")
        return committed

    async def _rollback_result(
        self,
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
        *,
        code: RuntimeTerminalCode,
        disposition: RuntimeDisposition,
    ) -> DeckDesignLiftResult:
        if transaction.status == "prepared":
            try:
                await self._materializer.rollback(transaction=transaction)
            except Exception:
                raise DeckDesignLiftRuntimeError("pre-stage candidate cleanup did not reach a safe state") from None
            transaction = self._mutations.transition(
                _transaction_copy(
                    transaction,
                    status="failed",
                    failure_code=code,
                    recovery_action=("retain_initial_manifest_and_gc_unreferenced_candidate"),
                ),
                expected_status="prepared",
            )
            return self._result(
                request,
                disposition=disposition,
                terminal_code=code,
                transaction=transaction,
                initial_quality_run_id=transaction.initial_quality_run_id,
            )
        rolling = _transaction_copy(
            transaction,
            status="rolling_back",
            failure_code=code,
            recovery_action="retain_initial_manifest_and_gc_unreferenced_candidate",
        )
        transaction = self._mutations.transition(
            rolling,
            expected_status=transaction.status,
        )
        transaction = await self._finish_rollback(transaction)
        return self._result(
            request,
            disposition=disposition,
            terminal_code=code,
            transaction=transaction,
            initial_quality_run_id=transaction.initial_quality_run_id,
            candidate_quality_run_id=transaction.candidate_quality_run_id,
            comparison=(_comparison_from_checkpoint(transaction) if transaction.comparison_hash is not None else None),
        )

    async def _finish_rollback(
        self,
        transaction: BuildMutationTransaction,
    ) -> BuildMutationTransaction:
        if transaction.status != "rolling_back":
            raise DeckDesignLiftRuntimeError("rollback resumed from an invalid status")
        try:
            await self._materializer.rollback(transaction=transaction)
        except Exception:
            raise DeckDesignLiftRuntimeError("candidate rollback did not reach a safe state") from None
        return self._mutations.transition(
            _transaction_copy(transaction, status="rolled_back"),
            expected_status="rolling_back",
        )

    def _committed_result(
        self,
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
    ) -> DeckDesignLiftResult:
        comparison = _comparison_from_checkpoint(transaction)
        return self._result(
            request,
            disposition="RUNTIME_COMMITTED_PENDING_AUDIT",
            terminal_code="candidate_committed",
            transaction=transaction,
            initial_quality_run_id=transaction.initial_quality_run_id,
            candidate_quality_run_id=transaction.candidate_quality_run_id,
            comparison=comparison,
            committed_manifest_revision=transaction.committed_manifest_revision,
        )

    def _rolled_back_result(
        self,
        request: DeckDesignLiftRequest,
        transaction: BuildMutationTransaction,
    ) -> DeckDesignLiftResult:
        code = transaction.failure_code
        if code not in {
            "repair_invocation_failed",
            "candidate_rejected",
            "candidate_materialization_failed",
            "candidate_mechanics_failed",
            "candidate_judgment_failed",
            "quality_run_not_fresh",
            "repair_not_approved",
            "manifest_concurrent_modification",
        }:
            raise DeckDesignLiftRuntimeError("rolled-back transaction has an unknown failure code")
        disposition: RuntimeDisposition = "REPAIR_NOT_APPROVED" if code in {"candidate_mechanics_failed", "repair_not_approved"} else "FAILED_SAFELY"
        return self._result(
            request,
            disposition=disposition,
            terminal_code=code,  # type: ignore[arg-type]
            transaction=transaction,
            initial_quality_run_id=transaction.initial_quality_run_id,
            candidate_quality_run_id=transaction.candidate_quality_run_id,
            comparison=(_comparison_from_checkpoint(transaction) if transaction.comparison_hash is not None else None),
        )

    @staticmethod
    def _result(
        request: DeckDesignLiftRequest,
        *,
        disposition: RuntimeDisposition,
        terminal_code: RuntimeTerminalCode,
        transaction: BuildMutationTransaction | None = None,
        initial_quality_run_id: str | None = None,
        candidate_quality_run_id: str | None = None,
        comparison: DeckVersionComparison | None = None,
        committed_manifest_revision: int | None = None,
    ) -> DeckDesignLiftResult:
        return DeckDesignLiftResult(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            operation_id=request.operation_id,
            disposition=disposition,
            terminal_code=terminal_code,
            transaction_id=transaction.transaction_id if transaction else None,
            initial_quality_run_id=initial_quality_run_id,
            candidate_quality_run_id=candidate_quality_run_id,
            comparison=comparison,
            committed_manifest_revision=committed_manifest_revision,
        )


__all__ = [
    "AtomicDeckManifestCommitter",
    "BlindDeckJudgmentRequest",
    "DeckCandidateMaterializer",
    "DeckDesignLiftRequest",
    "DeckDesignLiftResult",
    "DeckDesignLiftRuntime",
    "DeckDesignLiftRuntimeError",
    "DeckMechanics",
    "DeckQualityJudge",
    "DeckRepairExecutor",
    "InitialRenderedJudgment",
    "RepairInvocationRequest",
    "RuntimeDisposition",
    "RuntimeTerminalCode",
    "StagedDeckCandidate",
]
