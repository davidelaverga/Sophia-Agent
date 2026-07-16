from __future__ import annotations

from typing import Any

from deerflow.sophia.deck_quality.schemas import PlanCommitment
from deerflow.sophia.deck_quality.service import PlanRealizationInputs


def _strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(str(item).strip() for item in value if str(item).strip())


def derive_plan_realization_inputs(
    *,
    creative_plan: dict[str, Any],
    design_plan: dict[str, Any],
    selectors: tuple[str, ...],
    explicit_style_constraints: tuple[str, ...],
) -> PlanRealizationInputs:
    subject_materials = _strings(creative_plan.get("subject_materials"))
    signature = str(design_plan.get("signature") or "").strip()
    rhythm = str(design_plan.get("rhythm") or "").strip()
    commitments: list[PlanCommitment] = []
    if subject_materials:
        commitments.append(
            PlanCommitment(
                commitment_id="subject-materials",
                dimension="subject_material",
                promise="; ".join(subject_materials),
                selectors=selectors,
            )
        )
    if signature:
        commitments.append(
            PlanCommitment(
                commitment_id="signature",
                dimension="signature",
                promise=signature,
                selectors=selectors,
            )
        )
    if rhythm:
        commitments.append(
            PlanCommitment(
                commitment_id="rhythm",
                dimension="rhythm",
                promise=rhythm,
                selectors=selectors,
            )
        )
    for composition in creative_plan.get("slide_compositions") or ():
        if not isinstance(composition, dict):
            continue
        selector = str(composition.get("selector") or "")
        fingerprint = str(composition.get("structural_fingerprint") or "").strip()
        if selector in selectors and fingerprint:
            commitments.append(
                PlanCommitment(
                    commitment_id=f"fingerprint-{selector}",
                    dimension="structural_fingerprint",
                    promise=fingerprint,
                    selectors=(selector,),
                )
            )
    image_strategy = str(creative_plan.get("image_strategy") or "").strip()
    image_rationale = str(creative_plan.get("image_strategy_rationale") or "").strip()
    if image_strategy or image_rationale:
        commitments.append(
            PlanCommitment(
                commitment_id="visual-medium",
                dimension="visual_medium",
                promise=" — ".join(item for item in (image_strategy, image_rationale) if item),
                selectors=selectors,
            )
        )
    anti_slop = _strings(design_plan.get("anti_slop_profile"))
    if anti_slop:
        commitments.append(
            PlanCommitment(
                commitment_id="default-look-resistance",
                dimension="default_look",
                promise="; ".join(anti_slop),
                selectors=selectors,
            )
        )
    return PlanRealizationInputs(
        subject_materials=subject_materials,
        signature=signature,
        rhythm=rhythm,
        commitments=tuple(commitments),
        explicit_style_constraints=explicit_style_constraints,
    )
