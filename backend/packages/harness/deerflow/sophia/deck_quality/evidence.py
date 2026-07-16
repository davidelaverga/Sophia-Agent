from __future__ import annotations

from typing import Any

from deerflow.sophia.deck_quality.brief import forbidden_brief_marker
from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    BlindVisualEvidence,
    CoverageProof,
    PlanCommitment,
    PlanRealizationEvidence,
    QualityEvidenceSnapshot,
    RubricProjection,
)

_BLIND_FORBIDDEN_KEYS = frozenset(
    {
        "mechanical",
        "mechanical_record",
        "creative_plan",
        "design_plan",
        "expected_verdict",
        "expected_result",
        "fixture_id",
        "human_label",
        "label_source",
        "prior_verdict",
        "attempt_number",
        "repair_budget",
        "builder_provider",
        "builder_model",
    }
)


def _walk_keys(value: Any, *, prefix: str = "") -> tuple[str, ...]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            paths.append(path)
            paths.extend(_walk_keys(child, prefix=path))
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            paths.extend(_walk_keys(child, prefix=f"{prefix}[{index}]"))
    return tuple(paths)


def assert_blind_context_is_clean(evidence: BlindVisualEvidence) -> None:
    payload = evidence.model_dump(mode="json", exclude_none=True)
    leaks = []
    for path in _walk_keys(payload):
        leaf = path.rsplit(".", 1)[-1].split("[", 1)[0]
        if leaf.casefold() in _BLIND_FORBIDDEN_KEYS:
            leaks.append(path)
    if leaks:
        raise ValueError(f"blind evidence contains forbidden context keys: {', '.join(sorted(leaks))}")
    marker = forbidden_brief_marker(evidence.brief.request)
    if marker:
        raise ValueError(f"blind evidence contains forbidden prior-memory section: {marker}")


def prepare_blind_visual_evidence(
    snapshot: QualityEvidenceSnapshot,
    rubric: RubricProjection,
) -> BlindVisualEvidence:
    evidence = BlindVisualEvidence(
        brief=snapshot.brief,
        renders=snapshot.renders,
        visible_text=snapshot.visible_text,
        rubric=rubric,
    )
    assert_blind_context_is_clean(evidence)
    return evidence


def prepare_plan_realization_evidence(
    snapshot: QualityEvidenceSnapshot,
    *,
    rubric: RubricProjection,
    subject_materials: tuple[str, ...],
    signature: str,
    rhythm: str,
    commitments: tuple[PlanCommitment, ...],
    explicit_style_constraints: tuple[str, ...],
) -> PlanRealizationEvidence:
    return PlanRealizationEvidence(
        brief=snapshot.brief,
        renders=snapshot.renders,
        visible_text=snapshot.visible_text,
        creative_plan=snapshot.creative_plan,
        design_plan=snapshot.design_plan,
        subject_materials=subject_materials,
        signature=signature,
        rhythm=rhythm,
        commitments=commitments,
        explicit_style_constraints=explicit_style_constraints,
        rubric=rubric,
    )


def prove_coverage(
    snapshot: QualityEvidenceSnapshot,
    visual: BlindVisualAssessment | None,
) -> CoverageProof:
    expected = snapshot.renders.selectors
    rendered = tuple(str(image.selector) for image in snapshot.renders.slides)
    evaluated = visual.evaluated_selectors if visual is not None else ()
    errors: list[str] = []
    if rendered != expected:
        errors.append("rendered_selector_mismatch")
    if visual is None or not visual.coverage_confirmed:
        errors.append("judge_coverage_not_confirmed")
    if evaluated != expected:
        errors.append("evaluated_selector_mismatch")
    contact_sheet_present = bool(snapshot.renders.contact_sheet.path)
    if not contact_sheet_present:
        errors.append("contact_sheet_missing")
    images_decode = snapshot.renders.contact_sheet.decodes and all(image.decodes for image in snapshot.renders.slides)
    if not images_decode:
        errors.append("image_decode_failed")
    return CoverageProof(
        expected_selectors=expected,
        rendered_selectors=rendered,
        evaluated_selectors=evaluated,
        contact_sheet_present=contact_sheet_present,
        images_decode=images_decode,
        complete=not errors,
        errors=tuple(errors),
    )
