from __future__ import annotations

import hashlib
import hmac
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from deerflow.sophia.build_manifest import BuildManifest, manifest_components_by_selector
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift import compiler as repair_compiler
from deerflow.sophia.deck_design_lift.runtime import (
    BlindDeckJudgmentRequest,
    InitialRenderedJudgment,
)
from deerflow.sophia.deck_design_lift.schemas import (
    JudgmentRepairFinding,
    RepairRenderEvidence,
    SkillRef,
    VersionCriterionScore,
    VersionQualityEvidence,
)
from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.evidence import prove_coverage
from deerflow.sophia.deck_quality.graph import (
    _AssessmentAArtifact,
    _AssessmentCArtifact,
    _MechanicalArtifact,
)
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.persistence import QualityRunRecord
from deerflow.sophia.deck_quality.plan import derive_plan_realization_inputs
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    BlindVisualAssessment,
    MechanicalProjection,
    PlanRealizationAssessment,
    QualityInstrumentLock,
    RubricCriterionProjection,
    RubricProjection,
    ShadowDecision,
)
from deerflow.sophia.deck_quality.snapshot import (
    SnapshotCounts,
    SnapshotDescriptor,
    SnapshotEvidenceBundle,
    SnapshotEvidenceManifest,
    SnapshotRunIdentity,
    _verify_loaded_manifest,
    verify_evidence_manifest_identity,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    normalize_object_path,
    safe_object_path_segment,
)

_DQ1_CAMPAIGN_ID = "DQ-1"
_MAX_STAGE_JSON_BYTES = 4 * 1024 * 1024
_MAX_EVIDENCE_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_EVIDENCE_BUNDLE_BYTES = 4 * 1024 * 1024
_MAX_SKILL_EXCERPT_BYTES = 4 * 1024
_MAX_CANDIDATE_WAIT_SECONDS = 15 * 60
_MAX_CLOCK_SKEW_SECONDS = 30

_STAGE_FILENAMES = {
    "assessment_a_visual": "assessment_a_visual.json",
    "assessment_b_mechanical": "assessment_b_mechanical.json",
    "assessment_c_plan_realization": "assessment_c_plan_realization.json",
    "decision": "decision.json",
}


class DeckQualityEvidenceAdapterError(RuntimeError):
    """Content-free, stable failure emitted by the DQ-1 evidence adapter."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class QualityRunLookup(Protocol):
    async def get(self, quality_run_id: str) -> QualityRunRecord | None: ...


class AsyncImmutableObjectReader(Protocol):
    async def read_bounded(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes | None: ...


class ArtifactManifestLoader(Protocol):
    async def load_for_artifact(self, artifact: BuildArtifactVersion) -> BuildManifest: ...


class CompiledQualityInstrument(Protocol):
    lock: QualityInstrumentLock
    blind_rubric: RubricProjection
    plan_rubric: RubricProjection
    all_criteria: tuple[RubricCriterionProjection, ...]
    policy: AdjudicationPolicy


@dataclass(frozen=True)
class LockedSkillExcerpt:
    """One startup-verified, bounded excerpt from a committed craft source."""

    route_key: str
    ref: SkillRef
    text: str


@dataclass(frozen=True)
class _SkillExcerptSpec:
    route_key: str
    path: str
    source_hash: str
    excerpt_hash: str
    first_line: int
    last_line: int


_SKILL_EXCERPT_SPECS = (
    _SkillExcerptSpec(
        route_key="hands_on_deck",
        path="skills/public/hands-on-deck/designing-slides.md",
        source_hash="31dbd43427849592926e64d86ba968998a681743e832685c9194ed7ad2d2d146",
        excerpt_hash="ad427bac689e2d4f641f3c48c85b32ed99112de4c7b8fbec9e7b804ba8dd0b24",
        first_line=1,
        last_line=40,
    ),
    _SkillExcerptSpec(
        route_key="impeccable_layout",
        path="skills/public/deck-impeccable/reference/layout.md",
        source_hash="6dd9c16b556cfbc3db1afe6cee87e002b3f3d5c0001853217145dc04b6dd9a52",
        excerpt_hash="4c7a6b20e35cd20eb3ae208641ea7c2bdfabb9e7e1acbebe02ab92e272bec0aa",
        first_line=40,
        last_line=60,
    ),
    _SkillExcerptSpec(
        route_key="impeccable_bolder",
        path="skills/public/deck-impeccable/reference/bolder.md",
        source_hash="12b096ab618d00aa4e375910f8997992f43c817f662cec142f402b69d4dac536",
        excerpt_hash="3f322aff5c2fe4a7121474c63ed93629fc35fe9e4151007698e96ba0a1fab61d",
        first_line=1,
        last_line=45,
    ),
    _SkillExcerptSpec(
        route_key="impeccable_quieter",
        path="skills/public/deck-impeccable/reference/quieter.md",
        source_hash="89be275103e671e788789d029587ded0f4987a15addfcc8d5bffd8f5db2b1226",
        excerpt_hash="8ce82759c486ce82c28f4fa05566da142399c33b6589466f321673ad33b92d6d",
        first_line=55,
        last_line=86,
    ),
    _SkillExcerptSpec(
        route_key="hallmark_anti_slop",
        path="skills/public/hallmark/references/anti-patterns.md",
        source_hash="a36eb346ad59cafaa26119ed1e7c0bbb8aca6637209ee110eb630dd1a9307070",
        excerpt_hash="b53b4a3782340c4fd3fabe4bc3f76585713b3a9ee4a0500c39da064bf7eb71bd",
        first_line=1,
        last_line=35,
    ),
    _SkillExcerptSpec(
        route_key="hallmark_structure",
        path="skills/public/hallmark/references/structure.md",
        source_hash="ca5c0296ae428f8c4c5214407d431bbda5c453f98f2e7abdec03d644271af32b",
        excerpt_hash="19944260dc6ae74c26a67f2a133eca23d071587c5d9947d26aa719a6dd39c7a2",
        first_line=119,
        last_line=129,
    ),
    _SkillExcerptSpec(
        route_key="sophia_deck_craft",
        path="skills/public/sophia/deck_craft.md",
        source_hash="b1259666b40d5f281ffe0daf4f13c3d307901452118e5127c319fa9875a1719c",
        excerpt_hash="d421096f0ff3b0d0fc3224474d223aa76bfbfc5e02e46e1eac9541695607b495",
        first_line=79,
        last_line=109,
    ),
    _SkillExcerptSpec(
        route_key="sophia_narrative_rubric",
        path="skills/public/sophia/deck_rubric.md",
        source_hash="8f61dd676f09b1b3dd7d41a2d37dec1dd4d2d6bca30eba887bb1061e4c81e5d0",
        excerpt_hash="2049518fba8dbc03d04d8f617ddf1cac7df5a8d1959365fb9ba25dcf9231b6ef",
        first_line=19,
        last_line=29,
    ),
)


def load_committed_skill_excerpts(
    repository_root: Path | None = None,
) -> tuple[LockedSkillExcerpt, ...]:
    """Load only exact hash-locked excerpts from the committed craft corpus."""

    root = (repository_root or Path(__file__).resolve().parents[6]).resolve()
    loaded: list[LockedSkillExcerpt] = []
    for spec in _SKILL_EXCERPT_SPECS:
        source_path = (root / spec.path).resolve()
        try:
            source_path.relative_to(root)
            content = source_path.read_bytes()
            text = content.decode("utf-8")
        except (OSError, UnicodeError, ValueError):
            raise DeckQualityEvidenceAdapterError("skill_source_unavailable") from None
        if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), spec.source_hash):
            raise DeckQualityEvidenceAdapterError("skill_source_hash_mismatch")
        lines = text.splitlines(keepends=True)
        if spec.first_line < 1 or spec.last_line < spec.first_line or spec.last_line > len(lines):
            raise DeckQualityEvidenceAdapterError("skill_excerpt_range_invalid")
        excerpt = "".join(lines[spec.first_line - 1 : spec.last_line]).strip()
        excerpt_bytes = excerpt.encode("utf-8")
        if not excerpt or len(excerpt_bytes) > _MAX_SKILL_EXCERPT_BYTES or not hmac.compare_digest(_sha256(excerpt_bytes), spec.excerpt_hash):
            raise DeckQualityEvidenceAdapterError("skill_excerpt_invalid")
        loaded.append(
            LockedSkillExcerpt(
                route_key=spec.route_key,
                ref=SkillRef(
                    path=spec.path,
                    source_hash=spec.source_hash,
                    excerpt_hash=spec.excerpt_hash,
                ),
                text=excerpt,
            )
        )
    if len({item.route_key for item in loaded}) != len(loaded):
        raise DeckQualityEvidenceAdapterError("skill_route_duplicate")
    return tuple(loaded)


@dataclass(frozen=True)
class AuthenticatedDeckQualitySnapshot:
    """Authenticated immutable DQ-1 inputs available to repair-context loaders."""

    row: QualityRunRecord
    manifest: BuildManifest
    evidence_manifest: SnapshotEvidenceManifest
    evidence_bundle: SnapshotEvidenceBundle
    visual: BlindVisualAssessment
    mechanical: MechanicalProjection
    plan: PlanRealizationAssessment
    decision: ShadowDecision


@dataclass(frozen=True)
class _FindingSeed:
    selector: str
    failure_code: str
    observation: str
    source_rank: int


_NARRATIVE_FAILURES = frozenset(
    {
        "weak_narrative_arc",
        "weak_closing_synthesis",
        "weak_subject_specificity",
        "weak_audience_fit",
        "weak_forward_momentum",
        "weak_narrative_pacing",
    }
)

_HIERARCHY_FAILURES = frozenset(
    {
        "rendered_readability_failure",
        "weak_visual_hierarchy",
        "weak_typography",
        "inconsistent_typography",
        "weak_composition",
        "weak_spatial_tension",
    }
)

_TEMPLATE_FAILURES = frozenset(
    {
        "default_look_gravity",
        "deck_neon_cyber_default",
        "decorative_slop",
        "dense_card_grid",
        "card_soup",
        "template_fingerprint",
        "repetitive_structure",
    }
)

_SEQUENCE_FAILURES = frozenset(
    {
        "low_sequence_rhythm",
        "weak_signature_realization",
        "weak_fingerprint_realization",
        "weak_memorability",
        "explicit_taste_mismatch",
    }
)

_MEDIUM_FAILURES = frozenset(
    {
        "weak_mechanism_visualization",
        "mismatched_visual_medium",
        "weak_asset_integration",
    }
)

_PLAN_FAILURES_BY_DIMENSION = {
    "subject_material": frozenset({"weak_subject_specificity", "weak_audience_fit", "plan_realization_failure"}),
    "signature": frozenset(
        {
            "weak_signature_realization",
            "weak_fingerprint_realization",
            "composition_plan_not_realized",
            "plan_realization_failure",
        }
    ),
    "rhythm": frozenset(
        {
            "low_sequence_rhythm",
            "weak_narrative_pacing",
            "weak_forward_momentum",
            "plan_realization_failure",
        }
    ),
    "structural_fingerprint": frozenset(
        {
            "repetitive_structure",
            "template_fingerprint",
            "weak_fingerprint_realization",
            "composition_plan_not_realized",
            "plan_realization_failure",
        }
    ),
    "visual_medium": frozenset(
        {
            "weak_mechanism_visualization",
            "mismatched_visual_medium",
            "weak_asset_integration",
            "plan_realization_failure",
        }
    ),
    "default_look": frozenset(
        {
            "default_look_gravity",
            "deck_neon_cyber_default",
            "decorative_slop",
            "dense_card_grid",
            "card_soup",
            "template_fingerprint",
            "plan_realization_failure",
        }
    ),
}


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise DeckQualityEvidenceAdapterError("clock_not_timezone_aware")
    return value.astimezone(UTC)


def _artifact_created_at(artifact: BuildArtifactVersion) -> datetime:
    try:
        return _aware(datetime.fromisoformat(artifact.created_at.replace("Z", "+00:00")))
    except (TypeError, ValueError):
        raise DeckQualityEvidenceAdapterError("artifact_timestamp_invalid") from None


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _is_canonical_object_path(value: str) -> bool:
    try:
        return normalize_object_path(value) == value
    except ValueError:
        return False


def _quality_root(row: QualityRunRecord) -> str:
    manifest_path = row.evidence_manifest_object_path
    if manifest_path is None:
        raise DeckQualityEvidenceAdapterError("evidence_manifest_missing")
    try:
        normalized = normalize_object_path(manifest_path)
    except ValueError:
        raise DeckQualityEvidenceAdapterError("evidence_manifest_path_invalid") from None
    if normalized != manifest_path or not normalized.endswith("/evidence_manifest.json"):
        raise DeckQualityEvidenceAdapterError("evidence_manifest_path_invalid")
    return normalized.removesuffix("/evidence_manifest.json")


def _stage_path(row: QualityRunRecord, key: str) -> str:
    return f"{_quality_root(row)}/{_STAGE_FILENAMES[key]}"


def _parse_canonical[ModelT: BaseModel](content: bytes, model: type[ModelT]) -> ModelT:
    try:
        parsed = model.model_validate_json(content)
    except Exception:
        raise DeckQualityEvidenceAdapterError("quality_object_malformed") from None
    if canonical_json_bytes(parsed) != content:
        raise DeckQualityEvidenceAdapterError("quality_object_not_canonical")
    return parsed


def _selector_sort_key(selector: str) -> int:
    try:
        return int(selector.split(":", 1)[1])
    except (IndexError, ValueError):
        raise DeckQualityEvidenceAdapterError("quality_selector_invalid") from None


def _skill_route_keys(failure_code: str) -> tuple[str, ...]:
    if failure_code in _HIERARCHY_FAILURES:
        return ("impeccable_layout", "impeccable_bolder", "impeccable_quieter")
    if failure_code in _TEMPLATE_FAILURES:
        return ("hallmark_anti_slop", "hallmark_structure")
    if failure_code in _MEDIUM_FAILURES:
        return ("hands_on_deck", "sophia_deck_craft")
    if failure_code in _NARRATIVE_FAILURES:
        if failure_code in {"weak_narrative_arc", "weak_closing_synthesis"}:
            return ("hands_on_deck", "sophia_narrative_rubric")
        return ("hands_on_deck",)
    if failure_code in _SEQUENCE_FAILURES:
        return ("hands_on_deck", "hallmark_structure")
    if failure_code in {
        "composition_plan_not_realized",
        "plan_realization_failure",
    }:
        return ("hands_on_deck", "impeccable_layout")
    return ("sophia_deck_craft",)


class DurableDeckQualityEvidenceAdapter:
    """Read-only DQ-2 projection over immutable, completed DQ-1 evidence.

    This type deliberately has no publication or judge dependency. Candidate
    judgment can therefore only observe a separately submitted DQ-1 run; it
    cannot spend model authority or receive the initial version's evidence.
    """

    def __init__(
        self,
        *,
        store: QualityRunLookup,
        objects: AsyncImmutableObjectReader,
        instrument: CompiledQualityInstrument,
        manifests: ArtifactManifestLoader,
        clock: Callable[[], datetime],
        sleep: Callable[[float], Awaitable[None]],
        candidate_timeout_seconds: float = 120,
        poll_interval_seconds: float = 1,
        skill_excerpts: tuple[LockedSkillExcerpt, ...] | None = None,
    ) -> None:
        if not 0 < candidate_timeout_seconds <= _MAX_CANDIDATE_WAIT_SECONDS or not 0 < poll_interval_seconds <= candidate_timeout_seconds:
            raise ValueError("quality adapter polling bounds are invalid")
        self._store = store
        self._objects = objects
        self._instrument = instrument
        self._manifests = manifests
        self._clock = clock
        self._sleep = sleep
        self._candidate_timeout_seconds = candidate_timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds
        excerpts = skill_excerpts if skill_excerpts is not None else load_committed_skill_excerpts()
        self._skill_excerpts = self._validate_skill_excerpts(excerpts)

    @property
    def skill_excerpts(self) -> tuple[LockedSkillExcerpt, ...]:
        """Return the verified excerpt material for the later repair boundary."""

        return tuple(self._skill_excerpts.values())

    async def judge_initial(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> InitialRenderedJudgment:
        verified = await self.load_initial_snapshot(request)
        evidence = self._version_evidence(verified)
        findings: tuple[JudgmentRepairFinding, ...] = ()
        if verified.decision.result == "needs_revision":
            findings = self._compile_findings(verified)
        return InitialRenderedJudgment(
            evidence=evidence,
            decision=verified.decision,
            findings=findings,
        )

    async def judge_candidate(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> VersionQualityEvidence:
        verified = await self._load_verified(request, candidate=True)
        return self._version_evidence(verified)

    async def load_completed_mechanics(
        self,
        artifact: BuildArtifactVersion,
    ) -> MechanicalProjection:
        """Authenticate and return mechanics from an already-completed DQ-1 run.

        This is the non-circular initial-version mechanics boundary. Candidate
        mechanics must be loaded from the candidate materializer before its
        new DQ-1 run can complete.
        """

        verified = await self._load_verified_artifact(
            artifact=artifact,
            build_id=artifact.build_id,
            requested_mechanics=None,
            candidate=False,
        )
        return verified.mechanical

    async def load_initial_snapshot(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> AuthenticatedDeckQualitySnapshot:
        """Load the exact completed initial DQ-1 snapshot without judging.

        The request's artifact and mechanics are part of the authentication
        boundary. The deterministic DQ-1 run ID is intentionally not supplied
        by the caller.
        """

        return await self._load_verified(request, candidate=False)

    @staticmethod
    def _validate_skill_excerpts(
        excerpts: tuple[LockedSkillExcerpt, ...],
    ) -> dict[str, LockedSkillExcerpt]:
        result: dict[str, LockedSkillExcerpt] = {}
        expected = {spec.route_key: spec for spec in _SKILL_EXCERPT_SPECS}
        for excerpt in excerpts:
            if excerpt.route_key in result:
                raise DeckQualityEvidenceAdapterError("skill_route_duplicate")
            encoded = excerpt.text.encode("utf-8")
            spec = expected.get(excerpt.route_key)
            if (
                spec is None
                or not excerpt.text.strip()
                or len(encoded) > _MAX_SKILL_EXCERPT_BYTES
                or not hmac.compare_digest(_sha256(encoded), excerpt.ref.excerpt_hash)
                or excerpt.ref.path != spec.path
                or excerpt.ref.source_hash != spec.source_hash
                or excerpt.ref.excerpt_hash != spec.excerpt_hash
            ):
                raise DeckQualityEvidenceAdapterError("skill_excerpt_invalid")
            result[excerpt.route_key] = excerpt
        if set(result) != set(expected):
            raise DeckQualityEvidenceAdapterError("skill_route_incomplete")
        return result

    async def _load_verified(
        self,
        request: BlindDeckJudgmentRequest,
        *,
        candidate: bool,
    ) -> AuthenticatedDeckQualitySnapshot:
        return await self._load_verified_artifact(
            artifact=request.artifact,
            build_id=request.build_id,
            requested_mechanics=request.mechanics,
            candidate=candidate,
        )

    async def _load_verified_artifact(
        self,
        *,
        artifact: BuildArtifactVersion,
        build_id: str,
        requested_mechanics: MechanicalProjection | None,
        candidate: bool,
    ) -> AuthenticatedDeckQualitySnapshot:
        if build_id != artifact.build_id:
            raise DeckQualityEvidenceAdapterError("judgment_request_scope_mismatch")
        manifest = await self._load_manifest(artifact)
        expected_run_id = derive_quality_run_id(
            artifact_version_id=artifact.version_id,
            campaign_id=_DQ1_CAMPAIGN_ID,
            instrument=self._instrument.lock,
        )
        row = await self._load_row(
            expected_run_id,
            manifest=manifest,
            artifact=artifact,
            candidate=candidate,
        )
        return await self._verify_objects(
            artifact=artifact,
            requested_mechanics=requested_mechanics,
            manifest=manifest,
            row=row,
        )

    async def _load_manifest(self, artifact: BuildArtifactVersion) -> BuildManifest:
        try:
            manifest = await self._manifests.load_for_artifact(artifact)
        except Exception:
            raise DeckQualityEvidenceAdapterError("artifact_manifest_unavailable") from None
        if not isinstance(manifest, BuildManifest):
            raise DeckQualityEvidenceAdapterError("artifact_manifest_invalid")
        if (
            manifest.build_id != artifact.build_id
            or manifest.manifest_revision != artifact.manifest_revision
            or manifest.logical_artifact_id != artifact.logical_artifact_id
            or manifest.current_artifact_version_id != artifact.version_id
            or manifest.deliverable_path != artifact.artifact_path
            or manifest.format.lower() != "pptx"
            or manifest.status != "complete"
            or not artifact.verified
        ):
            raise DeckQualityEvidenceAdapterError("artifact_manifest_identity_mismatch")
        try:
            storage_path = normalize_object_path(artifact.storage_object_path)
            identities = (
                (manifest.user_id, "user"),
                (manifest.thread_id, "thread"),
                (manifest.build_id, "build"),
            )
            if any(safe_object_path_segment(value, default=default) != value for value, default in identities):
                raise ValueError
            prefix = f"artifacts/{manifest.user_id}/{manifest.thread_id}/foundation/.builder/builds/{manifest.build_id}/"
            manifest_components_by_selector(manifest)
        except (TypeError, ValueError):
            raise DeckQualityEvidenceAdapterError("artifact_manifest_invalid") from None
        if storage_path != artifact.storage_object_path or not storage_path.startswith(prefix):
            raise DeckQualityEvidenceAdapterError("artifact_storage_scope_mismatch")
        current_hash = manifest.format_extensions.get("deck", {}) if isinstance(manifest.format_extensions.get("deck", {}), Mapping) else {}
        recorded_hash = current_hash.get("current_pptx_hash")
        if recorded_hash is not None and recorded_hash != artifact.artifact_hash:
            raise DeckQualityEvidenceAdapterError("artifact_manifest_hash_mismatch")
        return manifest.model_copy(deep=True)

    async def _get_row(self, quality_run_id: str) -> QualityRunRecord | None:
        try:
            return await self._store.get(quality_run_id)
        except Exception:
            raise DeckQualityEvidenceAdapterError("quality_run_store_unavailable") from None

    async def _load_row(
        self,
        quality_run_id: str,
        *,
        manifest: BuildManifest,
        artifact: BuildArtifactVersion,
        candidate: bool,
    ) -> QualityRunRecord:
        if not candidate:
            row = await self._get_row(quality_run_id)
            if row is None or row.state != "completed":
                raise DeckQualityEvidenceAdapterError("initial_quality_run_unavailable")
            self._validate_row_identity(
                row,
                quality_run_id=quality_run_id,
                manifest=manifest,
                artifact=artifact,
                require_fresh=False,
            )
            return row

        deadline = _aware(self._clock()).timestamp() + self._candidate_timeout_seconds
        while True:
            row = await self._get_row(quality_run_id)
            if row is not None:
                self._validate_row_identity(
                    row,
                    quality_run_id=quality_run_id,
                    manifest=manifest,
                    artifact=artifact,
                    require_fresh=True,
                )
                if row.state == "completed":
                    return row
                if row.state in {"failed", "stale"}:
                    raise DeckQualityEvidenceAdapterError("candidate_quality_run_terminal")
            now = _aware(self._clock()).timestamp()
            if now >= deadline:
                raise DeckQualityEvidenceAdapterError("candidate_quality_run_timeout")
            await self._sleep(min(self._poll_interval_seconds, deadline - now))

    def _validate_row_identity(
        self,
        row: QualityRunRecord,
        *,
        quality_run_id: str,
        manifest: BuildManifest,
        artifact: BuildArtifactVersion,
        require_fresh: bool,
    ) -> None:
        if not isinstance(row, QualityRunRecord):
            raise DeckQualityEvidenceAdapterError("quality_run_record_invalid")
        expected_lock = self._instrument.lock
        try:
            actual_lock = row.instrument_lock()
        except Exception:
            raise DeckQualityEvidenceAdapterError("quality_run_identity_mismatch") from None
        if (
            row.quality_run_id != quality_run_id
            or row.campaign_id != _DQ1_CAMPAIGN_ID
            or row.scope_kind != "canary"
            or row.user_id != manifest.user_id
            # Normal builder completion publishes DQ-1 under the parent
            # companion thread while ``task_id`` is the builder thread that
            # owns the foundation manifest. Legacy/direct publications may
            # already be builder-thread scoped. Require one authenticated
            # completion identity to own the manifest; row.thread_id remains
            # bound to the immutable evidence objects below.
            or manifest.thread_id not in {row.thread_id, row.task_id}
            or row.build_id != artifact.build_id
            or row.logical_artifact_id != artifact.logical_artifact_id
            or row.artifact_version_id != artifact.version_id
            or row.manifest_revision != artifact.manifest_revision
            or row.artifact_hash != artifact.artifact_hash
            or actual_lock != expected_lock
            or row.instrument_identity_hash != canonical_sha256(expected_lock)
        ):
            raise DeckQualityEvidenceAdapterError("quality_run_identity_mismatch")
        if row.finished_at is not None and row.finished_at < row.requested_at:
            raise DeckQualityEvidenceAdapterError("quality_run_timestamp_invalid")
        now = _aware(self._clock())
        if row.requested_at > now + timedelta(seconds=_MAX_CLOCK_SKEW_SECONDS):
            raise DeckQualityEvidenceAdapterError("quality_run_timestamp_invalid")
        if require_fresh and row.requested_at < _artifact_created_at(artifact):
            raise DeckQualityEvidenceAdapterError("candidate_quality_run_not_fresh")

    async def _read(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes:
        try:
            content = await self._objects.read_bounded(
                object_path,
                max_bytes=max_bytes,
            )
        except Exception:
            raise DeckQualityEvidenceAdapterError("quality_object_unavailable") from None
        if content is None:
            raise DeckQualityEvidenceAdapterError("quality_object_missing")
        if type(content) is not bytes or not content or len(content) > max_bytes:
            raise DeckQualityEvidenceAdapterError("quality_object_oversized_or_invalid")
        return content

    async def _read_hashed_model[ModelT: BaseModel](
        self,
        *,
        object_path: str,
        expected_hash: str,
        max_bytes: int,
        model: type[ModelT],
    ) -> tuple[ModelT, bytes]:
        content = await self._read(object_path, max_bytes=max_bytes)
        if not hmac.compare_digest(_sha256(content), expected_hash):
            raise DeckQualityEvidenceAdapterError("quality_object_hash_mismatch")
        return _parse_canonical(content, model), content

    async def _read_stage[ModelT: BaseModel](
        self,
        row: QualityRunRecord,
        *,
        key: str,
        model: type[ModelT],
    ) -> ModelT:
        expected_hash = row.stage_artifact_hashes.get(key)
        if expected_hash is None:
            raise DeckQualityEvidenceAdapterError("quality_stage_hash_missing")
        parsed, _content = await self._read_hashed_model(
            object_path=_stage_path(row, key),
            expected_hash=expected_hash,
            max_bytes=_MAX_STAGE_JSON_BYTES,
            model=model,
        )
        return parsed

    async def _verify_objects(
        self,
        *,
        artifact: BuildArtifactVersion,
        requested_mechanics: MechanicalProjection | None,
        manifest: BuildManifest,
        row: QualityRunRecord,
    ) -> AuthenticatedDeckQualitySnapshot:
        evidence_path = row.evidence_manifest_object_path
        evidence_hash = row.evidence_manifest_hash
        if evidence_path is None or evidence_hash is None:
            raise DeckQualityEvidenceAdapterError("evidence_manifest_missing")
        if row.stage_artifact_hashes.get("evidence_manifest") != evidence_hash:
            raise DeckQualityEvidenceAdapterError("evidence_manifest_hash_mismatch")
        evidence_manifest, _manifest_bytes = await self._read_hashed_model(
            object_path=evidence_path,
            expected_hash=evidence_hash,
            max_bytes=_MAX_EVIDENCE_MANIFEST_BYTES,
            model=SnapshotEvidenceManifest,
        )
        try:
            verify_evidence_manifest_identity(
                evidence_manifest,
                SnapshotRunIdentity(
                    campaign_id=_DQ1_CAMPAIGN_ID,
                    quality_run_id=row.quality_run_id,
                    user_id=row.user_id,
                    thread_id=row.thread_id,
                    task_id=row.task_id or "missing-task",
                    build_id=row.build_id,
                    builder_run_id=row.builder_run_id or "missing-builder-run",
                    parent_builder_trace_id=(row.parent_builder_trace_id or "missing-builder-trace"),
                    logical_artifact_id=row.logical_artifact_id,
                    artifact_version_id=row.artifact_version_id,
                    manifest_revision=row.manifest_revision,
                    input_manifest_object_path=row.input_manifest_object_path,
                    input_manifest_hash=row.input_manifest_hash,
                ),
            )
        except Exception:
            raise DeckQualityEvidenceAdapterError("evidence_manifest_identity_mismatch") from None
        if evidence_manifest.snapshot_id != row.quality_run_id or evidence_manifest.artifact.sha256 != artifact.artifact_hash or evidence_manifest.artifact.virtual_path != artifact.artifact_path:
            raise DeckQualityEvidenceAdapterError("evidence_manifest_artifact_mismatch")
        bundle_record = next(
            (item for item in evidence_manifest.objects if item.object_path == evidence_manifest.evidence_bundle_path),
            None,
        )
        if (
            bundle_record is None
            or bundle_record.role != "evidence_bundle"
            or bundle_record.media_type != "application/json"
            or bundle_record.sha256 != evidence_manifest.evidence_bundle_hash
            or bundle_record.size_bytes > _MAX_EVIDENCE_BUNDLE_BYTES
        ):
            raise DeckQualityEvidenceAdapterError("evidence_bundle_inventory_mismatch")
        evidence_bundle, bundle_bytes = await self._read_hashed_model(
            object_path=evidence_manifest.evidence_bundle_path,
            expected_hash=evidence_manifest.evidence_bundle_hash,
            max_bytes=_MAX_EVIDENCE_BUNDLE_BYTES,
            model=SnapshotEvidenceBundle,
        )
        if bundle_record.size_bytes != len(bundle_bytes):
            raise DeckQualityEvidenceAdapterError("evidence_bundle_inventory_mismatch")
        descriptor = SnapshotDescriptor(
            snapshot_id=row.quality_run_id,
            snapshot_path=evidence_path,
            snapshot_hash=evidence_hash,
            counts=SnapshotCounts(
                slide_count=len(evidence_manifest.selectors),
                visible_text_slide_count=len(evidence_manifest.selectors),
                evidence_object_count=len(evidence_manifest.objects) + 4,
            ),
        )
        try:
            _verify_loaded_manifest(
                descriptor=descriptor,
                manifest=evidence_manifest,
                bundle=evidence_bundle,
            )
        except Exception:
            raise DeckQualityEvidenceAdapterError("evidence_bundle_identity_mismatch") from None
        self._verify_render_inventory(
            row=row,
            manifest=evidence_manifest,
            bundle=evidence_bundle,
        )

        visual_stage = await self._read_stage(
            row,
            key="assessment_a_visual",
            model=_AssessmentAArtifact,
        )
        mechanical_stage = await self._read_stage(
            row,
            key="assessment_b_mechanical",
            model=_MechanicalArtifact,
        )
        plan_stage = await self._read_stage(
            row,
            key="assessment_c_plan_realization",
            model=_AssessmentCArtifact,
        )
        decision = await self._read_stage(
            row,
            key="decision",
            model=ShadowDecision,
        )
        if visual_stage.status != "completed" or visual_stage.assessment is None or plan_stage.status != "completed" or plan_stage.assessment is None:
            raise DeckQualityEvidenceAdapterError("quality_assessment_incomplete")
        visual = visual_stage.assessment
        plan = plan_stage.assessment
        mechanical = mechanical_stage.projection
        self._verify_stage_bindings(
            row=row,
            evidence_manifest=evidence_manifest,
            evidence_bundle=evidence_bundle,
            visual_stage=visual_stage,
            mechanical_stage=mechanical_stage,
            plan_stage=plan_stage,
            decision=decision,
            requested_mechanics=requested_mechanics,
        )
        return AuthenticatedDeckQualitySnapshot(
            row=row,
            manifest=manifest,
            evidence_manifest=evidence_manifest,
            evidence_bundle=evidence_bundle,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            decision=decision,
        )

    @staticmethod
    def _verify_render_inventory(
        *,
        row: QualityRunRecord,
        manifest: SnapshotEvidenceManifest,
        bundle: SnapshotEvidenceBundle,
    ) -> None:
        records = {item.object_path: item for item in manifest.objects}
        renders = bundle.snapshot.renders
        expected_paths = {
            *(item.path for item in renders.slides),
            renders.contact_sheet.path,
            manifest.evidence_bundle_path,
        }
        if set(records) != expected_paths:
            raise DeckQualityEvidenceAdapterError("render_inventory_mismatch")
        root = _quality_root(row)
        for index, image in enumerate(renders.slides, start=1):
            expected_path = f"{root}/renders/slide-{index:04d}.png"
            record = records.get(image.path)
            if (
                image.path != expected_path
                or not _is_canonical_object_path(image.path)
                or record is None
                or record.role != "render"
                or record.media_type != "image/png"
                or record.sha256 != image.sha256
                or manifest.render_hashes.get(str(image.selector)) != image.sha256
            ):
                raise DeckQualityEvidenceAdapterError("render_inventory_mismatch")
        contact = renders.contact_sheet
        contact_record = records.get(contact.path)
        if (
            contact.path != f"{root}/renders/contact-sheet.png"
            or not _is_canonical_object_path(contact.path)
            or contact_record is None
            or contact_record.role != "contact_sheet"
            or contact_record.media_type != "image/png"
            or contact_record.sha256 != contact.sha256
            or manifest.render_hashes.get("contact-sheet") != contact.sha256
        ):
            raise DeckQualityEvidenceAdapterError("render_inventory_mismatch")

    def _verify_stage_bindings(
        self,
        *,
        row: QualityRunRecord,
        evidence_manifest: SnapshotEvidenceManifest,
        evidence_bundle: SnapshotEvidenceBundle,
        visual_stage: _AssessmentAArtifact,
        mechanical_stage: _MechanicalArtifact,
        plan_stage: _AssessmentCArtifact,
        decision: ShadowDecision,
        requested_mechanics: MechanicalProjection | None,
    ) -> None:
        lock = self._instrument.lock
        prompt_hashes = lock.prompt_hashes
        if not {"blind_visual", "plan_realization"}.issubset(prompt_hashes):
            raise DeckQualityEvidenceAdapterError("instrument_prompt_lock_incomplete")
        expected_a_input = canonical_sha256(
            {
                "evidence_bundle_hash": evidence_manifest.evidence_bundle_hash,
                "rubric_hash": self._instrument.blind_rubric.rubric_hash,
                "prompt_hash": prompt_hashes["blind_visual"],
                "judge_plan_hash": lock.judge_plan_hash,
            }
        )
        expected_b_input = canonical_sha256(
            {
                "mechanical_record_hash": evidence_bundle.snapshot.mechanical_record_hash,
                "artifact_hash": evidence_bundle.snapshot.artifact_hash,
            }
        )
        expected_c_input = canonical_sha256(
            {
                "evidence_bundle_hash": evidence_manifest.evidence_bundle_hash,
                "rubric_hash": self._instrument.plan_rubric.rubric_hash,
                "prompt_hash": prompt_hashes["plan_realization"],
                "judge_plan_hash": lock.judge_plan_hash,
            }
        )
        if (
            visual_stage.input_hash != expected_a_input
            or mechanical_stage.input_hash != expected_b_input
            or plan_stage.input_hash != expected_c_input
            or (requested_mechanics is not None and mechanical_stage.projection != requested_mechanics)
            or mechanical_stage.projection.authoritative_record_hash != evidence_bundle.snapshot.mechanical_record_hash
        ):
            raise DeckQualityEvidenceAdapterError("quality_stage_input_mismatch")
        for stage, key in (
            (visual_stage, "assessment_a_call_intent"),
            (plan_stage, "assessment_c_call_intent"),
        ):
            if stage.call_intent_hash != row.stage_artifact_hashes.get(key):
                raise DeckQualityEvidenceAdapterError("quality_call_intent_mismatch")
            metrics = stage.metrics
            if metrics is None or metrics.plan_hash != lock.judge_plan_hash or metrics.profile_version != lock.judge_profile_version:
                raise DeckQualityEvidenceAdapterError("quality_invocation_identity_mismatch")
        plan_inputs = derive_plan_realization_inputs(
            creative_plan=evidence_bundle.snapshot.creative_plan,
            design_plan=evidence_bundle.snapshot.design_plan,
            selectors=tuple(str(item) for item in evidence_bundle.snapshot.renders.selectors),
            explicit_style_constraints=(evidence_bundle.snapshot.brief.explicit_brand_style_constraints),
        )
        expected_decision = adjudicate_shadow_result(
            coverage=prove_coverage(evidence_bundle.snapshot, visual_stage.assessment),
            visual=visual_stage.assessment,
            mechanical=mechanical_stage.projection,
            plan=plan_stage.assessment,
            criteria=self._instrument.all_criteria,
            expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
            rubric_hash=self._instrument.blind_rubric.rubric_hash,
            policy=self._instrument.policy,
        )
        if (
            decision != expected_decision
            or decision.visual_assessment_hash != canonical_sha256(visual_stage.assessment)
            or decision.mechanical_projection_hash != canonical_sha256(mechanical_stage.projection)
            or decision.plan_assessment_hash != canonical_sha256(plan_stage.assessment)
            or row.decision_result is None
            or row.decision_result.value != decision.result
            or row.decision_failure_codes != decision.failure_codes
            or row.decision_weighted_score != decision.weighted_score
        ):
            raise DeckQualityEvidenceAdapterError("quality_decision_mismatch")

    def _version_evidence(
        self,
        verified: AuthenticatedDeckQualitySnapshot,
    ) -> VersionQualityEvidence:
        score_by_id = {
            score.criterion_id: score
            for score in (
                *verified.visual.criterion_scores,
                *verified.plan.criterion_scores,
            )
        }
        criteria_by_id = {criterion.id: criterion for criterion in self._instrument.all_criteria}
        if set(score_by_id) != set(criteria_by_id):
            raise DeckQualityEvidenceAdapterError("quality_criterion_coverage_mismatch")
        decision_failures = set(verified.decision.failure_codes)
        scores: list[VersionCriterionScore] = []
        for criterion in self._instrument.all_criteria:
            persisted = score_by_id[criterion.id]
            if not persisted.applicable:
                continue
            if persisted.score is None:
                raise DeckQualityEvidenceAdapterError("quality_criterion_score_missing")
            failed = criterion.id in verified.decision.failing_criterion_ids or bool(set(criterion.allowed_failure_codes) & decision_failures)
            scores.append(
                VersionCriterionScore(
                    criterion_id=criterion.id,
                    score=persisted.score,
                    critical=criterion.critical,
                    failed=failed,
                )
            )
        if not scores or verified.decision.weighted_score is None:
            raise DeckQualityEvidenceAdapterError("quality_score_projection_incomplete")
        critical_codes = tuple(code for code in verified.decision.failure_codes if any(criterion.critical and code in criterion.allowed_failure_codes for criterion in self._instrument.all_criteria))
        uncertainties = tuple(
            dict.fromkeys(
                uncertainty.kind
                for uncertainty in (
                    *verified.visual.uncertainties,
                    *verified.plan.uncertainties,
                )
            )
        )
        coverage = prove_coverage(
            verified.evidence_bundle.snapshot,
            verified.visual,
        )
        return VersionQualityEvidence(
            quality_run_id=verified.row.quality_run_id,
            artifact_version_id=verified.row.artifact_version_id,
            verdict=verified.decision.result,
            weighted_score=verified.decision.weighted_score,
            criterion_scores=tuple(scores),
            failure_codes=verified.decision.failure_codes,
            critical_failure_codes=critical_codes,
            mechanics_passed=verified.mechanical.status == "passed",
            coverage_complete=(coverage.complete and verified.plan.evaluated_selectors == coverage.expected_selectors),
            grader_error=False,
            uncertainties=uncertainties,
        )

    def _compile_findings(
        self,
        verified: AuthenticatedDeckQualitySnapshot,
    ) -> tuple[JudgmentRepairFinding, ...]:
        supported_codes = frozenset(repair_compiler._FAILURE_INSTRUCTIONS)
        decision_codes = tuple(code for code in verified.decision.failure_codes if code in supported_codes)
        decision_selectors = set(verified.decision.evidence_selectors)
        seeds: list[_FindingSeed] = []
        for finding in verified.visual.slide_findings:
            if finding.code not in decision_codes:
                continue
            for selector in finding.evidence_selectors:
                if selector in decision_selectors:
                    seeds.append(
                        _FindingSeed(
                            selector=selector,
                            failure_code=finding.code,
                            observation=finding.observation,
                            source_rank=0,
                        )
                    )
        plan_codes = set(verified.plan.failure_codes) & set(decision_codes)
        for commitment in verified.plan.commitments:
            if commitment.status not in {"partial", "not_realized"}:
                continue
            allowed_codes = _PLAN_FAILURES_BY_DIMENSION[commitment.dimension]
            for code in decision_codes:
                if code not in plan_codes or code not in allowed_codes:
                    continue
                for selector in commitment.evidence_selectors:
                    if selector in decision_selectors:
                        seeds.append(
                            _FindingSeed(
                                selector=selector,
                                failure_code=code,
                                observation=commitment.observation,
                                source_rank=1,
                            )
                        )
        if not seeds:
            raise DeckQualityEvidenceAdapterError("repair_findings_unavailable")
        seeds.sort(
            key=lambda item: (
                decision_codes.index(item.failure_code),
                item.source_rank,
                _selector_sort_key(item.selector),
            )
        )
        selected: list[str] = []
        for code in decision_codes:
            candidate = next(
                (item.selector for item in seeds if item.failure_code == code and item.selector not in selected),
                None,
            )
            if candidate is not None:
                selected.append(candidate)
            if len(selected) == 3:
                break
        if not selected:
            raise DeckQualityEvidenceAdapterError("repair_findings_unavailable")
        selected_set = set(selected)
        unique_seeds: list[_FindingSeed] = []
        identities: set[tuple[str, str]] = set()
        for seed in seeds:
            identity = (seed.selector, seed.failure_code)
            if seed.selector in selected_set and identity not in identities:
                unique_seeds.append(seed)
                identities.add(identity)

        components = manifest_components_by_selector(verified.manifest)
        render_by_selector = {str(item.selector): item for item in verified.evidence_bundle.snapshot.renders.slides}
        text_hash_by_selector = {str(item.selector): item.source_hash for item in verified.evidence_bundle.snapshot.visible_text}
        findings: list[JudgmentRepairFinding] = []
        for seed in unique_seeds:
            component = components.get(seed.selector)
            render = render_by_selector.get(seed.selector)
            text_hash = text_hash_by_selector.get(seed.selector)
            if component is None or component.type != "slide" or render is None or text_hash is None:
                continue
            roles = self._requested_roles(
                component_source_path=component.source_path,
                component_source_roles=component.source_roles,
                failure_code=seed.failure_code,
            )
            if not roles:
                continue
            refs = tuple(self._skill_excerpts[key].ref for key in _skill_route_keys(seed.failure_code))
            findings.append(
                JudgmentRepairFinding(
                    target_selector=seed.selector,
                    failure_code=seed.failure_code,
                    observation=seed.observation,
                    render_evidence=(
                        RepairRenderEvidence(
                            selector=seed.selector,
                            path=render.path,
                            sha256=render.sha256,
                        ),
                    ),
                    requested_source_roles=roles,
                    retained_content=(f"Preserve the exact native semantic text bound by source hash {text_hash}.",),
                    skill_refs=refs,
                )
            )
        if not findings:
            raise DeckQualityEvidenceAdapterError("repair_findings_unavailable")
        return tuple(findings)

    @staticmethod
    def _requested_roles(
        *,
        component_source_path: str,
        component_source_roles: Mapping[str, str],
        failure_code: str,
    ) -> tuple[str, ...]:
        available: set[str] = set()
        for role, path in component_source_roles.items():
            if role not in {"body", "slide_css", "notes"}:
                continue
            if not isinstance(path, str) or not path.strip() or ".." in path.split("/"):
                raise DeckQualityEvidenceAdapterError("manifest_source_role_invalid")
            available.add(role)
        if not component_source_roles:
            if not component_source_path.strip() or ".." in component_source_path.split("/"):
                raise DeckQualityEvidenceAdapterError("manifest_source_role_invalid")
            available.add("body")
        if failure_code in _NARRATIVE_FAILURES:
            return ("body",) if "body" in available else ()
        return tuple(role for role in ("body", "slide_css") if role in available)


__all__ = [
    "AuthenticatedDeckQualitySnapshot",
    "ArtifactManifestLoader",
    "AsyncImmutableObjectReader",
    "DeckQualityEvidenceAdapterError",
    "DurableDeckQualityEvidenceAdapter",
    "LockedSkillExcerpt",
    "QualityRunLookup",
    "load_committed_skill_excerpts",
]
