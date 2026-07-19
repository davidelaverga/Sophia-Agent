from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import Sha256, ShadowDecision, StableSlideSelector

DeckSelector = Annotated[str, Field(pattern=r"^(?:deck-style:root|slide:[1-9][0-9]*)$")]
FailureCode = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*$")]
AssetId = Annotated[str, Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$")]
WritableSourceRole = Literal["body", "slide_css", "notes", "deck_css"]
QualityVerdict = Literal[
    "failed_to_judge",
    "mechanically_invalid",
    "needs_revision",
    "needs_user_review",
    "satisfied",
]
UncertaintyKind = Literal["taste_score_range", "evidence_limit"]

MAX_AUTOMATIC_REPAIR_TARGETS = 3


class StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _duplicates(values: tuple[str, ...]) -> set[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return duplicates


def _require_unique(values: tuple[str, ...], *, label: str) -> None:
    duplicates = _duplicates(values)
    if duplicates:
        raise ValueError(f"duplicate {label}: {', '.join(sorted(duplicates))}")


def _validate_selector_roles(selector: str, source_roles: tuple[str, ...]) -> None:
    if selector == "deck-style:root":
        if source_roles != ("deck_css",):
            raise ValueError("deck-style:root may authorize only deck_css")
        return
    if "deck_css" in source_roles:
        raise ValueError("deck_css may be authorized only through deck-style:root")


class SkillRef(StrictFrozenModel):
    path: str = Field(min_length=1, max_length=4_096)
    source_hash: Sha256
    excerpt_hash: Sha256

    @field_validator("path")
    @classmethod
    def reject_blank_path(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("skill reference path cannot be blank")
        return value


class RepairRenderEvidence(StrictFrozenModel):
    selector: StableSlideSelector
    path: str = Field(min_length=1, max_length=4_096)
    sha256: Sha256


class SelectorSourceAuthorization(StrictFrozenModel):
    selector: DeckSelector
    source_roles: tuple[WritableSourceRole, ...]
    owned_asset_ids: tuple[AssetId, ...] = ()

    @model_validator(mode="after")
    def validate_authorization(self) -> SelectorSourceAuthorization:
        if not self.source_roles and not self.owned_asset_ids:
            raise ValueError("selector authorization must expose a source role or owned asset")
        _require_unique(tuple(self.source_roles), label="authorized source roles")
        _require_unique(tuple(self.owned_asset_ids), label="owned asset IDs")
        _validate_selector_roles(self.selector, tuple(self.source_roles))
        if self.selector == "deck-style:root" and self.owned_asset_ids:
            raise ValueError("deck-style:root cannot own slide assets")
        return self


class JudgmentRepairFinding(StrictFrozenModel):
    target_selector: DeckSelector
    failure_code: FailureCode
    observation: str = Field(min_length=1, max_length=8_000)
    render_evidence: tuple[RepairRenderEvidence, ...]
    requested_source_roles: tuple[WritableSourceRole, ...] = ()
    retained_content: tuple[str, ...]
    allowed_asset_changes: tuple[AssetId, ...] = ()
    skill_refs: tuple[SkillRef, ...]

    @model_validator(mode="after")
    def require_visible_and_bounded_repair(self) -> JudgmentRepairFinding:
        if not self.observation.strip():
            raise ValueError("repair findings require a visible observation")
        if not self.render_evidence:
            raise ValueError("repair findings require rendered evidence")
        if not self.requested_source_roles and not self.allowed_asset_changes:
            raise ValueError("repair findings must request a source or asset change")
        if not self.retained_content or any(not item.strip() for item in self.retained_content):
            raise ValueError("repair findings require non-blank retained content")
        if not self.skill_refs:
            raise ValueError("repair findings require at least one skill reference")
        _require_unique(
            tuple(item.selector for item in self.render_evidence),
            label="render evidence selectors",
        )
        _require_unique(tuple(self.requested_source_roles), label="requested source roles")
        _require_unique(tuple(self.allowed_asset_changes), label="allowed asset changes")
        _require_unique(
            tuple(f"{item.path}:{item.source_hash}:{item.excerpt_hash}" for item in self.skill_refs),
            label="skill references",
        )
        _validate_selector_roles(self.target_selector, tuple(self.requested_source_roles))
        evidence_selectors = {item.selector for item in self.render_evidence}
        if self.target_selector.startswith("slide:") and self.target_selector not in evidence_selectors:
            raise ValueError("slide-local repairs require rendered evidence for the target slide")
        if self.target_selector == "deck-style:root":
            if len(evidence_selectors) < 2:
                raise ValueError("deck-wide style repairs require evidence from at least two slides")
            if self.allowed_asset_changes:
                raise ValueError("deck-wide style repairs cannot authorize slide assets")
        return self


class RepairCompilerInput(StrictFrozenModel):
    build_id: str = Field(min_length=1, max_length=512)
    initial_quality_run_id: str = Field(min_length=1, max_length=512)
    initial_manifest_revision: int = Field(ge=1)
    initial_decision: ShadowDecision
    prior_repair_count: int = Field(default=0, ge=0)
    plan_revision_allowed: bool = False
    source_authorizations: tuple[SelectorSourceAuthorization, ...]
    findings: tuple[JudgmentRepairFinding, ...]
    additional_must_preserve: tuple[str, ...] = ()
    additional_must_not: tuple[str, ...] = ()
    rubric_version: str = Field(min_length=1, max_length=512)
    instrument_hash: Sha256

    @model_validator(mode="after")
    def require_unique_inputs(self) -> RepairCompilerInput:
        if not self.source_authorizations:
            raise ValueError("repair compilation requires source authorization inventory")
        if not self.findings:
            raise ValueError("repair compilation requires judgment findings")
        _require_unique(
            tuple(item.selector for item in self.source_authorizations),
            label="source authorization selectors",
        )
        if any(not item.strip() for item in self.additional_must_preserve):
            raise ValueError("additional preservation constraints cannot be blank")
        if any(not item.strip() for item in self.additional_must_not):
            raise ValueError("additional forbidden changes cannot be blank")
        return self


class SelectorRepair(StrictFrozenModel):
    selector: DeckSelector
    failure_codes: tuple[FailureCode, ...]
    render_evidence: tuple[RepairRenderEvidence, ...]
    instruction: str = Field(min_length=1, max_length=20_000)
    retained_content: tuple[str, ...]
    allowed_asset_changes: tuple[AssetId, ...] = ()

    @model_validator(mode="after")
    def validate_selector_repair(self) -> SelectorRepair:
        if not self.failure_codes:
            raise ValueError("selector repair requires failure codes")
        if not self.render_evidence:
            raise ValueError("selector repair requires rendered evidence")
        if not self.instruction.strip():
            raise ValueError("selector repair instruction cannot be blank")
        if not self.retained_content or any(not item.strip() for item in self.retained_content):
            raise ValueError("selector repair requires retained content")
        _require_unique(tuple(self.failure_codes), label="selector repair failure codes")
        _require_unique(
            tuple(item.selector for item in self.render_evidence),
            label="selector repair render evidence",
        )
        _require_unique(tuple(self.allowed_asset_changes), label="selector repair asset changes")
        return self


class DeckRepairProgram(StrictFrozenModel):
    schema_version: Literal["sophia-deck-repair-program/v1"] = "sophia-deck-repair-program/v1"
    build_id: str = Field(min_length=1, max_length=512)
    initial_quality_run_id: str = Field(min_length=1, max_length=512)
    initial_manifest_revision: int = Field(ge=1)
    repair_attempt: Literal[1] = 1
    plan_revision_allowed: bool
    authorized_selectors: tuple[DeckSelector, ...]
    authorized_source_roles: dict[DeckSelector, tuple[WritableSourceRole, ...]]
    deck_instruction: str = Field(min_length=1, max_length=20_000)
    selector_repairs: tuple[SelectorRepair, ...]
    must_preserve: tuple[str, ...]
    must_not: tuple[str, ...]
    skill_refs: tuple[SkillRef, ...]
    expected_improvements: tuple[FailureCode, ...]
    forbidden_regressions: tuple[FailureCode, ...]
    rubric_version: str = Field(min_length=1, max_length=512)
    instrument_hash: Sha256
    program_hash: Sha256

    @model_validator(mode="after")
    def validate_frozen_program(self) -> DeckRepairProgram:
        if not self.authorized_selectors:
            raise ValueError("repair program requires authorized selectors")
        if len(self.authorized_selectors) > MAX_AUTOMATIC_REPAIR_TARGETS:
            raise ValueError(
                f"repair program exceeds {MAX_AUTOMATIC_REPAIR_TARGETS} automatic targets"
            )
        _require_unique(tuple(self.authorized_selectors), label="authorized selectors")
        if "deck-style:root" in self.authorized_selectors and len(self.authorized_selectors) != 1:
            raise ValueError("deck-wide style repair cannot be mixed with slide-local targets")
        if set(self.authorized_source_roles) != set(self.authorized_selectors):
            raise ValueError("authorized source-role keys must exactly match authorized selectors")
        repairs_by_selector = {item.selector: item for item in self.selector_repairs}
        for selector, roles in self.authorized_source_roles.items():
            repair = repairs_by_selector.get(selector)
            if not roles and (repair is None or not repair.allowed_asset_changes):
                raise ValueError(
                    "each authorized selector requires a source role or allowed asset change"
                )
            _require_unique(tuple(roles), label=f"authorized roles for {selector}")
            _validate_selector_roles(selector, tuple(roles))
        selector_repairs = tuple(item.selector for item in self.selector_repairs)
        if set(selector_repairs) != set(self.authorized_selectors) or len(selector_repairs) != len(
            self.authorized_selectors
        ):
            raise ValueError("selector repairs must exactly cover authorized selectors")
        if not self.deck_instruction.strip():
            raise ValueError("deck instruction cannot be blank")
        if not self.must_preserve or any(not item.strip() for item in self.must_preserve):
            raise ValueError("repair program requires non-blank preservation constraints")
        if not self.must_not or any(not item.strip() for item in self.must_not):
            raise ValueError("repair program requires non-blank forbidden changes")
        if not self.skill_refs:
            raise ValueError("repair program requires skill provenance")
        _require_unique(
            tuple(f"{item.path}:{item.source_hash}:{item.excerpt_hash}" for item in self.skill_refs),
            label="program skill references",
        )
        if not self.expected_improvements:
            raise ValueError("repair program requires expected improvements")
        if not self.forbidden_regressions:
            raise ValueError("repair program requires forbidden regressions")
        _require_unique(tuple(self.expected_improvements), label="expected improvements")
        _require_unique(tuple(self.forbidden_regressions), label="forbidden regressions")
        repair_failure_codes = {
            code for repair in self.selector_repairs for code in repair.failure_codes
        }
        if repair_failure_codes != set(self.expected_improvements):
            raise ValueError("expected improvements must exactly match selector repair failures")
        expected_hash = canonical_sha256(
            self.model_dump(mode="json", exclude={"program_hash"})
        )
        if self.program_hash != expected_hash:
            raise ValueError("repair program hash does not match canonical program payload")
        return self


class SourceUpdate(StrictFrozenModel):
    selector: DeckSelector
    source_role: WritableSourceRole
    expected_source_hash: Sha256
    content: str = Field(min_length=1, max_length=2_000_000)

    @model_validator(mode="after")
    def validate_source_update(self) -> SourceUpdate:
        if not self.content.strip():
            raise ValueError("source update content cannot be blank")
        _validate_selector_roles(self.selector, (self.source_role,))
        return self


class AssetUpdate(StrictFrozenModel):
    selector: StableSlideSelector
    asset_id: AssetId
    operation: Literal["replace", "remove"]
    path: str | None = Field(default=None, max_length=4_096)
    sha256: Sha256 | None = None
    contains_semantic_text: Literal[False] = False
    full_slide_replacement: Literal[False] = False

    @model_validator(mode="after")
    def validate_asset_operation(self) -> AssetUpdate:
        if self.operation == "replace":
            if not (self.path or "").strip() or self.sha256 is None:
                raise ValueError("replacement assets require a path and SHA-256")
        elif self.path is not None or self.sha256 is not None:
            raise ValueError("removed assets cannot include a replacement path or SHA-256")
        return self


class DeckRepairCandidate(StrictFrozenModel):
    # The production DQ-2 compiler freezes both plans and admits only
    # manifest-addressed source/asset updates.  Keep these explicit nulls in
    # the wire shape so the provider schema is strict-JSON-schema compatible
    # instead of advertising unsupported free-form objects.
    creative_plan_patch: None = None
    design_plan_patch: None = None
    source_updates: tuple[SourceUpdate, ...] = ()
    asset_updates: tuple[AssetUpdate, ...] = ()
    rationale: str = Field(min_length=1, max_length=20_000)

    @model_validator(mode="after")
    def validate_candidate_shape(self) -> DeckRepairCandidate:
        if not self.rationale.strip():
            raise ValueError("repair rationale cannot be blank")
        if not any(
            (
                self.creative_plan_patch,
                self.design_plan_patch,
                self.source_updates,
                self.asset_updates,
            )
        ):
            raise ValueError("repair candidate must contain at least one update")
        if self.creative_plan_patch is not None and not self.creative_plan_patch:
            raise ValueError("creative plan patch cannot be empty")
        if self.design_plan_patch is not None and not self.design_plan_patch:
            raise ValueError("design plan patch cannot be empty")
        _require_unique(
            tuple(f"{item.selector}:{item.source_role}" for item in self.source_updates),
            label="source update targets",
        )
        _require_unique(
            tuple(f"{item.selector}:{item.asset_id}" for item in self.asset_updates),
            label="asset update targets",
        )
        forbidden_plan_keys = {
            "add_slide",
            "add_slides",
            "remove_slide",
            "remove_slides",
            "slide_count",
            "slide_count_delta",
        }
        patch_keys = set(self.creative_plan_patch or ()) | set(self.design_plan_patch or ())
        forbidden = sorted(patch_keys & forbidden_plan_keys)
        if forbidden:
            raise ValueError(f"repair candidate cannot change slide count: {', '.join(forbidden)}")
        return self


class VersionCriterionScore(StrictFrozenModel):
    criterion_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    score: int = Field(ge=1, le=5)
    critical: bool
    failed: bool = False


class VersionQualityEvidence(StrictFrozenModel):
    quality_run_id: str = Field(min_length=1, max_length=512)
    artifact_version_id: str = Field(min_length=1, max_length=512)
    verdict: QualityVerdict
    weighted_score: Decimal = Field(ge=1, le=5)
    criterion_scores: tuple[VersionCriterionScore, ...]
    failure_codes: tuple[FailureCode, ...] = ()
    critical_failure_codes: tuple[FailureCode, ...] = ()
    mechanics_passed: bool
    coverage_complete: bool
    grader_error: bool = False
    uncertainties: tuple[UncertaintyKind, ...] = ()

    @model_validator(mode="after")
    def validate_quality_evidence(self) -> VersionQualityEvidence:
        if not self.criterion_scores:
            raise ValueError("version quality evidence requires criterion scores")
        _require_unique(
            tuple(item.criterion_id for item in self.criterion_scores),
            label="version criterion scores",
        )
        _require_unique(tuple(self.failure_codes), label="version failure codes")
        _require_unique(
            tuple(self.critical_failure_codes),
            label="version critical failure codes",
        )
        if not set(self.critical_failure_codes).issubset(self.failure_codes):
            raise ValueError("critical failure codes must be a subset of failure codes")
        return self


class LocalityProof(StrictFrozenModel):
    authorized_selectors: tuple[DeckSelector, ...]
    changed_component_versions: tuple[DeckSelector, ...]
    unchanged_component_versions: tuple[DeckSelector, ...]
    unexpected_changes: tuple[str, ...] = ()
    shared_dependency_changed: bool
    native_inventory_preserved: bool = True
    render_collateral_within_tolerance: bool = True

    @model_validator(mode="after")
    def validate_locality_sets(self) -> LocalityProof:
        if not self.authorized_selectors:
            raise ValueError("locality proof requires authorized selectors")
        if not self.changed_component_versions:
            raise ValueError("locality proof requires at least one changed component")
        _require_unique(tuple(self.authorized_selectors), label="locality authorized selectors")
        _require_unique(tuple(self.changed_component_versions), label="changed component versions")
        _require_unique(
            tuple(self.unchanged_component_versions),
            label="unchanged component versions",
        )
        overlap = set(self.changed_component_versions) & set(self.unchanged_component_versions)
        if overlap:
            raise ValueError(
                f"components cannot be both changed and unchanged: {', '.join(sorted(overlap))}"
            )
        return self


class ContentPreservationProof(StrictFrozenModel):
    brief_preserved: bool
    initial_slide_count: int = Field(ge=1, le=500)
    candidate_slide_count: int = Field(ge=1, le=500)
    required_content_preserved: bool
    factual_content_preserved: bool
    native_editability_preserved: bool


class DeckVersionComparisonInput(StrictFrozenModel):
    initial: VersionQualityEvidence
    candidate: VersionQualityEvidence
    locality: LocalityProof
    content: ContentPreservationProof
    expected_failure_codes: tuple[FailureCode, ...]
    critical_score_floor: int = Field(default=3, ge=1, le=5)

    @field_validator("expected_failure_codes")
    @classmethod
    def require_expected_failures(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value:
            raise ValueError("comparison requires expected failure codes")
        _require_unique(value, label="expected failure codes")
        return value


class DeckVersionComparison(StrictFrozenModel):
    initial_quality_run_id: str
    candidate_quality_run_id: str
    initial_artifact_version_id: str
    candidate_artifact_version_id: str
    result: Literal["approved_improvement", "not_improved", "regressed", "incomparable"]
    score_deltas: dict[str, float]
    resolved_failure_codes: tuple[FailureCode, ...]
    new_failure_codes: tuple[FailureCode, ...]
    unchanged_critical_scores: tuple[str, ...]
    improved_critical_scores: tuple[str, ...]
    mechanics_preserved: bool
    locality_preserved: bool
    content_preserved: bool
    reasons: tuple[str, ...]

    @model_validator(mode="after")
    def approved_result_requires_preservation(self) -> DeckVersionComparison:
        if self.result == "approved_improvement":
            if not (
                self.mechanics_preserved
                and self.locality_preserved
                and self.content_preserved
            ):
                raise ValueError("approved comparison requires all preservation proofs")
            if self.reasons != ("all_improvement_gates_passed",):
                raise ValueError("approved comparison must record the success reason")
        elif not self.reasons:
            raise ValueError("non-approved comparison requires rejection reasons")
        return self
