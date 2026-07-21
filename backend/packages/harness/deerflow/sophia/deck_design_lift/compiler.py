from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from deerflow.sophia.deck_design_lift.schemas import (
    MAX_AUTOMATIC_REPAIR_TARGETS,
    DeckRepairCandidate,
    DeckRepairProgram,
    JudgmentRepairFinding,
    RepairCompilerInput,
    RepairRenderEvidence,
    SelectorRepair,
    SkillRef,
)
from deerflow.sophia.deck_quality.canonical import canonical_sha256


class RepairProgramRejected(ValueError):
    """A stable, policy-addressable rejection from the deterministic compiler."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


_FAILURE_INSTRUCTIONS = {
    "rendered_readability_failure": "Restore legibility at presentation scale without dropping required content.",
    "weak_narrative_arc": "Strengthen the sequence so each page turn advances one clear argument.",
    "weak_closing_synthesis": "Visually consolidate the existing thesis, consequence, and action into one dominant close without depending on new copy.",
    "weak_subject_specificity": "Make existing PSI-specific subject and mechanism labels the spatial anchors of a structure that could not fit an unrelated subject.",
    "weak_visual_hierarchy": "Create a decisive reading order with clearer scale, grouping, and emphasis.",
    "low_sequence_rhythm": "Vary composition and density to create intentional sequence rhythm.",
    "weak_narrative_pacing": "Vary composition and density to create intentional sequence rhythm.",
    "repetitive_structure": "Replace repeated scaffolds with compositions shaped by each content beat.",
    "weak_signature_realization": "Realize the promised deck signature as a functional recurring structural motif; palette-only restyling is insufficient.",
    "weak_typography": "Repair typography hierarchy, wraps, density, and presentation-scale legibility.",
    "inconsistent_typography": "Restore a coherent typographic system while preserving semantic text.",
    "weak_composition": "Rebalance space and relationships around the slide's primary claim.",
    "weak_spatial_tension": "Use scale, placement, and negative space to create purposeful spatial tension.",
    "weak_mechanism_visualization": "Arrange existing labeled elements into a directional, native, inspectable mechanism; generic prose boxes do not count.",
    "mismatched_visual_medium": "Choose a visual medium that directly explains the content and integrate it into the composition.",
    "weak_asset_integration": "Integrate the asset as part of the argument rather than as decoration.",
    "weak_audience_fit": "Tune the visual and narrative emphasis for product and engineering leaders.",
    "deck_neon_cyber_default": "Remove generic neon or cyber styling and restore subject-led visual choices.",
    "decorative_slop": "Remove unsupported decoration and retain only elements that clarify the argument.",
    "dense_card_grid": "Replace card-grid structure with a single coherent composition.",
    "card_soup": "Replace card-grid structure with a single coherent composition.",
    "template_fingerprint": "Remove repeated template scaffolding and make the composition content-specific.",
    "weak_memorability": "Create one distinctive, subject-grounded mental image without decorative excess.",
    "weak_forward_momentum": "Strengthen the page turn and the unresolved-to-resolved sequence.",
    "explicit_taste_mismatch": "Honor the user's explicit taste constraint without changing factual content.",
    "composition_plan_not_realized": "Bring the rendered composition into alignment with the frozen plan commitment.",
    "weak_fingerprint_realization": "Realize the planned structural fingerprint visibly and coherently.",
    "plan_realization_failure": "Repair the failed plan commitment on the authorized slide only.",
    "default_look_gravity": "Replace default template gravity with a content-shaped composition and functional structural motif; palette-only styling is insufficient.",
}

_DECK_WIDE_STYLE_FAILURES = frozenset(
    {
        "default_look_gravity",
        "deck_neon_cyber_default",
        "inconsistent_typography",
        "weak_typography",
        "weak_visual_hierarchy",
    }
)

_MUST_PRESERVE = (
    "The user brief, factual claims, and required content.",
    "The existing slide count.",
    "Native, editable semantic text and PPTX output.",
    "Current source/component versions for every unauthorized selector.",
)

_MUST_NOT = (
    "Do not create screenshot-backed slides or full-slide generated images with semantic text.",
    "Do not write an unauthorized selector, source role, or asset.",
    "Do not change deck-wide CSS unless deck-style:root is explicitly authorized.",
    "Do not add, remove, or reorder slides.",
    "Do not perform a second automatic quality repair.",
)

_FORBIDDEN_REGRESSIONS = (
    "mechanical_regression",
    "critical_score_regression",
    "collateral_source_change",
    "content_regression",
    "slide_count_change",
)


def _selector_sort_key(selector: str) -> tuple[int, int]:
    if selector == "deck-style:root":
        return (0, 0)
    return (1, int(selector.split(":", 1)[1]))


def _unique_in_order(values: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        result.append(value)
        seen.add(value)
    return tuple(result)


def _unique_skill_refs(findings: Iterable[JudgmentRepairFinding]) -> tuple[SkillRef, ...]:
    refs: list[SkillRef] = []
    seen: set[tuple[str, str, str]] = set()
    for finding in findings:
        for ref in finding.skill_refs:
            identity = (ref.path, ref.source_hash, ref.excerpt_hash)
            if identity in seen:
                continue
            refs.append(ref)
            seen.add(identity)
    return tuple(refs)


def _merge_render_evidence(
    findings: Iterable[JudgmentRepairFinding],
) -> tuple[RepairRenderEvidence, ...]:
    evidence_by_selector: dict[str, RepairRenderEvidence] = {}
    for finding in findings:
        for evidence in finding.render_evidence:
            prior = evidence_by_selector.get(evidence.selector)
            if prior is not None and prior != evidence:
                raise RepairProgramRejected(
                    "conflicting_render_evidence",
                    f"multiple render identities were supplied for {evidence.selector}",
                )
            evidence_by_selector[evidence.selector] = evidence
    return tuple(
        evidence_by_selector[selector]
        for selector in sorted(evidence_by_selector, key=_selector_sort_key)
    )


def compile_repair_program(inputs: RepairCompilerInput) -> DeckRepairProgram:
    """Freeze one rendered-judgment repair into a deterministic authorization program."""

    if inputs.initial_decision.result != "needs_revision":
        raise RepairProgramRejected(
            "initial_verdict_not_repairable",
            "only needs_revision may compile an automatic repair program",
        )
    if inputs.prior_repair_count != 0:
        raise RepairProgramRejected(
            "automatic_repair_limit_reached",
            "DQ-2 permits exactly one automatic quality repair",
        )

    grouped: dict[str, list[JudgmentRepairFinding]] = defaultdict(list)
    for finding in inputs.findings:
        grouped[finding.target_selector].append(finding)
    target_selectors = tuple(sorted(grouped, key=_selector_sort_key))
    if len(target_selectors) > MAX_AUTOMATIC_REPAIR_TARGETS:
        raise RepairProgramRejected(
            "excessive_target_count",
            f"at most {MAX_AUTOMATIC_REPAIR_TARGETS} selectors may be repaired",
        )
    if "deck-style:root" in grouped and len(grouped) != 1:
        raise RepairProgramRejected(
            "mixed_shared_and_local_repair",
            "deck-style:root cannot be combined with slide-local repair targets",
        )

    decision_failures = set(inputs.initial_decision.failure_codes)
    decision_selectors = set(inputs.initial_decision.evidence_selectors)
    inventory = {item.selector: item for item in inputs.source_authorizations}
    authorized_source_roles: dict[str, tuple[str, ...]] = {}
    selector_repairs: list[SelectorRepair] = []

    for selector in target_selectors:
        selector_findings = grouped[selector]
        authorization = inventory.get(selector)
        if authorization is None:
            raise RepairProgramRejected(
                "unknown_selector",
                f"judgment attempted to authorize unavailable selector {selector}",
            )

        requested_roles = _unique_in_order(
            role for finding in selector_findings for role in finding.requested_source_roles
        )
        unauthorized_roles = set(requested_roles) - set(authorization.source_roles)
        if unauthorized_roles:
            raise RepairProgramRejected(
                "unauthorized_source_role",
                f"{selector} requested unavailable roles: {', '.join(sorted(unauthorized_roles))}",
            )
        requested_assets = _unique_in_order(
            asset for finding in selector_findings for asset in finding.allowed_asset_changes
        )
        unauthorized_assets = set(requested_assets) - set(authorization.owned_asset_ids)
        if unauthorized_assets:
            raise RepairProgramRejected(
                "unauthorized_asset",
                f"{selector} requested unowned assets: {', '.join(sorted(unauthorized_assets))}",
            )

        failure_codes = _unique_in_order(finding.failure_code for finding in selector_findings)
        unsupported_codes = set(failure_codes) - set(_FAILURE_INSTRUCTIONS)
        if unsupported_codes:
            raise RepairProgramRejected(
                "unsupported_failure_code",
                f"no deterministic repair instruction exists for: {', '.join(sorted(unsupported_codes))}",
            )
        missing_from_decision = set(failure_codes) - decision_failures
        if missing_from_decision:
            raise RepairProgramRejected(
                "failure_not_in_judgment",
                f"repair failures were not adjudicated: {', '.join(sorted(missing_from_decision))}",
            )
        render_evidence = _merge_render_evidence(selector_findings)
        evidence_selectors = {item.selector for item in render_evidence}
        if not evidence_selectors.issubset(decision_selectors):
            missing = evidence_selectors - decision_selectors
            raise RepairProgramRejected(
                "evidence_not_in_judgment",
                f"render selectors were not frozen by the decision: {', '.join(sorted(missing))}",
            )
        if selector == "deck-style:root" and not set(failure_codes).issubset(
            _DECK_WIDE_STYLE_FAILURES
        ):
            raise RepairProgramRejected(
                "shared_style_not_deck_wide",
                "deck-style:root requires an explicitly deck-wide style failure",
            )

        retained_content = _unique_in_order(
            content for finding in selector_findings for content in finding.retained_content
        )
        instruction_parts = []
        for finding in selector_findings:
            instruction_parts.append(
                f"{_FAILURE_INSTRUCTIONS[finding.failure_code]} "
                f"Visible evidence: {finding.observation.strip()}"
            )
        selector_repairs.append(
            SelectorRepair(
                selector=selector,
                failure_codes=failure_codes,
                render_evidence=render_evidence,
                instruction=" ".join(instruction_parts),
                retained_content=retained_content,
                allowed_asset_changes=requested_assets,
            )
        )
        authorized_source_roles[selector] = requested_roles

    expected_improvements = _unique_in_order(
        code for repair in selector_repairs for code in repair.failure_codes
    )
    skill_refs = _unique_skill_refs(inputs.findings)
    must_preserve = _unique_in_order((*_MUST_PRESERVE, *inputs.additional_must_preserve))
    must_not = _unique_in_order((*_MUST_NOT, *inputs.additional_must_not))
    selector_list = ", ".join(target_selectors)
    payload = {
        "schema_version": "sophia-deck-repair-program/v1",
        "build_id": inputs.build_id,
        "initial_quality_run_id": inputs.initial_quality_run_id,
        "initial_manifest_revision": inputs.initial_manifest_revision,
        "repair_attempt": 1,
        "plan_revision_allowed": inputs.plan_revision_allowed,
        "authorized_selectors": target_selectors,
        "authorized_source_roles": authorized_source_roles,
        "deck_instruction": (
            f"Repair only {selector_list}. Resolve the frozen rendered failures while preserving "
            "the brief, factual content, editability, slide count, and all unauthorized sources."
        ),
        "selector_repairs": tuple(selector_repairs),
        "must_preserve": must_preserve,
        "must_not": must_not,
        "skill_refs": skill_refs,
        "expected_improvements": expected_improvements,
        "forbidden_regressions": _FORBIDDEN_REGRESSIONS,
        "rubric_version": inputs.rubric_version,
        "instrument_hash": inputs.instrument_hash,
    }
    return DeckRepairProgram(**payload, program_hash=canonical_sha256(payload))


def validate_candidate_against_program(
    candidate: DeckRepairCandidate,
    program: DeckRepairProgram,
) -> DeckRepairCandidate:
    """Reject every candidate write that falls outside the frozen repair program."""

    if not program.plan_revision_allowed and (
        candidate.creative_plan_patch is not None or candidate.design_plan_patch is not None
    ):
        raise RepairProgramRejected(
            "plan_revision_not_authorized",
            "the frozen program does not permit creative or design plan changes",
        )

    allowed_selectors = set(program.authorized_selectors)
    for update in candidate.source_updates:
        if update.selector not in allowed_selectors:
            raise RepairProgramRejected(
                "unauthorized_selector_write",
                f"source update targets {update.selector}",
            )
        allowed_roles = set(program.authorized_source_roles[update.selector])
        if update.source_role not in allowed_roles:
            raise RepairProgramRejected(
                "unauthorized_source_role_write",
                f"{update.selector} cannot write {update.source_role}",
            )

    asset_allowlist = {
        repair.selector: set(repair.allowed_asset_changes) for repair in program.selector_repairs
    }
    for update in candidate.asset_updates:
        if update.selector not in allowed_selectors:
            raise RepairProgramRejected(
                "unauthorized_selector_write",
                f"asset update targets {update.selector}",
            )
        if update.asset_id not in asset_allowlist.get(update.selector, set()):
            raise RepairProgramRejected(
                "unauthorized_asset_write",
                f"{update.selector} cannot write asset {update.asset_id}",
            )
    return candidate
