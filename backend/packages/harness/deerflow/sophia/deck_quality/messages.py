from __future__ import annotations

import base64
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from deerflow.sophia.deck_quality.prompts import VersionedPrompt
from deerflow.sophia.deck_quality.schemas import BlindVisualEvidence, PlanRealizationEvidence

DIRECT_EVIDENCE_BUDGET_VERSION = "dq1-direct-evidence-v2"
DIRECT_EVIDENCE_MAX_SLIDES = 5
# Calibrated with the official GPT-5.6 input-token counter against the complete
# five-slide Appendix-A A/C payloads. Individual renders use a 2048px long side
# to preserve original-detail evidence while leaving deterministic headroom
# under the locked two-call cost ceiling. The aggregate original-patch guard
# rejects unpriced geometry before the exact remote token-count preflight.
DIRECT_EVIDENCE_MAX_IMAGE_BYTES = 1024 * 1024
DIRECT_EVIDENCE_MAX_TOTAL_IMAGE_BYTES = 3 * 1024 * 1024
DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION = 2048
DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION = 2048
DIRECT_EVIDENCE_MAX_ORIGINAL_SLIDE_PATCHES = 13_500
DIRECT_EVIDENCE_MAX_SLIDE_PIXELS = DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION**2
DIRECT_EVIDENCE_MAX_CONTACT_SHEET_PIXELS = (
    DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION**2
)
DIRECT_EVIDENCE_MAX_TOTAL_PIXELS = (
    DIRECT_EVIDENCE_MAX_SLIDE_PIXELS * DIRECT_EVIDENCE_MAX_SLIDES
    + DIRECT_EVIDENCE_MAX_CONTACT_SHEET_PIXELS
)
DIRECT_EVIDENCE_MAX_TEXT_BYTES = 256 * 1024


class DirectEvidenceBudgetError(ValueError):
    """The complete evidence set cannot use the calibrated direct path."""


@dataclass(frozen=True)
class DirectEvidenceBudgetUsage:
    slide_count: int
    image_count: int
    total_image_bytes: int
    total_pixels: int
    text_bytes: int


def _data_url(path: Path) -> str:
    if path.suffix.casefold() != ".png":
        raise ValueError("DQ-1 rendered evidence must use lossless PNG images")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _image_blocks(
    *,
    contact_sheet_path: str,
    slides: tuple[tuple[str, str], ...],
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [
        {"type": "text", "text": "Whole-deck contact sheet for sequence and rhythm:"},
        {
            "type": "image_url",
            "image_url": {"url": _data_url(Path(contact_sheet_path)), "detail": "high"},
        },
    ]
    for selector, path in slides:
        blocks.extend(
            [
                {"type": "text", "text": f"Individual render {selector}:"},
                {
                    "type": "image_url",
                    # GPT-5.6 preserves the native PNG dimensions only for
                    # original/auto detail.  Keep this explicit because the
                    # DQ-1 instrument locks original-fidelity slide judgment;
                    # the bounded contact sheet above intentionally stays high.
                    "image_url": {"url": _data_url(Path(path)), "detail": "original"},
                },
            ]
        )
    return blocks


def _blind_text_payload(evidence: BlindVisualEvidence) -> dict[str, Any]:
    return {
        "schema_version": evidence.schema_version,
        "brief": evidence.brief.model_dump(mode="json"),
        "expected_slide_count": evidence.renders.expected_slide_count,
        "selectors": evidence.renders.selectors,
        "visible_text": [item.model_dump(mode="json") for item in evidence.visible_text],
        "rubric": evidence.rubric.model_dump(mode="json"),
    }


def _validate_direct_evidence_budget(
    *,
    expected_slide_count: int,
    selectors: tuple[str, ...],
    slides: tuple[tuple[str, str, int, int], ...],
    contact_sheet: tuple[str, int, int],
    text_payload: dict[str, Any],
) -> DirectEvidenceBudgetUsage:
    """Prove the whole evidence set fits the calibrated direct request.

    DQ-1 has no large-deck batching/consolidation implementation yet.  It must
    therefore reject an over-budget deck before a provider-call intent exists;
    silently dropping or truncating any selector would violate complete
    coverage.  Five slide images plus the contact sheet cover Appendix A.
    """

    rendered_selectors = tuple(selector for selector, _path, _width, _height in slides)
    if (
        not 1 <= expected_slide_count <= DIRECT_EVIDENCE_MAX_SLIDES
        or len(selectors) != expected_slide_count
        or len(slides) != expected_slide_count
        or rendered_selectors != selectors
        or len(set(selectors)) != len(selectors)
    ):
        raise DirectEvidenceBudgetError("complete selector set exceeds the direct evidence budget")

    contact_sheet_path, contact_width, contact_height = contact_sheet
    if (
        contact_width <= 0
        or contact_height <= 0
        or max(contact_width, contact_height)
        > DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION
        or contact_width * contact_height > DIRECT_EVIDENCE_MAX_CONTACT_SHEET_PIXELS
    ):
        raise DirectEvidenceBudgetError("contact sheet exceeds the calibrated pixel budget")
    total_pixels = contact_width * contact_height
    original_slide_patches = 0
    for _selector, _path, width, height in slides:
        if (
            width <= 0
            or height <= 0
            or max(width, height) > DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION
            or width * height > DIRECT_EVIDENCE_MAX_SLIDE_PIXELS
        ):
            raise DirectEvidenceBudgetError("slide render exceeds the calibrated pixel budget")
        total_pixels += width * height
        original_slide_patches += math.ceil(width / 32) * math.ceil(height / 32)
    if original_slide_patches > DIRECT_EVIDENCE_MAX_ORIGINAL_SLIDE_PATCHES:
        raise DirectEvidenceBudgetError("slide renders exceed the calibrated original-patch budget")
    if total_pixels > DIRECT_EVIDENCE_MAX_TOTAL_PIXELS:
        raise DirectEvidenceBudgetError("complete direct evidence exceeds its aggregate pixel budget")

    paths = (contact_sheet_path, *(path for _selector, path, _width, _height in slides))
    total_image_bytes = 0
    for value in paths:
        path = Path(value)
        if path.suffix.casefold() != ".png":
            raise DirectEvidenceBudgetError("direct evidence must contain lossless PNG images")
        try:
            image_bytes = path.stat().st_size
        except OSError:
            raise DirectEvidenceBudgetError("direct evidence image is unavailable") from None
        if not 0 < image_bytes <= DIRECT_EVIDENCE_MAX_IMAGE_BYTES:
            raise DirectEvidenceBudgetError("direct evidence image exceeds its byte budget")
        total_image_bytes += image_bytes
    if total_image_bytes > DIRECT_EVIDENCE_MAX_TOTAL_IMAGE_BYTES:
        raise DirectEvidenceBudgetError("complete direct evidence exceeds its aggregate byte budget")

    text_bytes = len(
        json.dumps(
            text_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    if text_bytes > DIRECT_EVIDENCE_MAX_TEXT_BYTES:
        raise DirectEvidenceBudgetError("direct evidence text exceeds its byte budget")
    return DirectEvidenceBudgetUsage(
        slide_count=expected_slide_count,
        image_count=len(paths),
        total_image_bytes=total_image_bytes,
        total_pixels=total_pixels,
        text_bytes=text_bytes,
    )


def validate_blind_visual_direct_evidence(
    evidence: BlindVisualEvidence,
) -> DirectEvidenceBudgetUsage:
    return _validate_direct_evidence_budget(
        expected_slide_count=evidence.renders.expected_slide_count,
        selectors=tuple(str(value) for value in evidence.renders.selectors),
        slides=tuple(
            (str(item.selector), item.path, item.width, item.height)
            for item in evidence.renders.slides
        ),
        contact_sheet=(
            evidence.renders.contact_sheet.path,
            evidence.renders.contact_sheet.width,
            evidence.renders.contact_sheet.height,
        ),
        text_payload=_blind_text_payload(evidence),
    )


def build_blind_visual_messages(
    evidence: BlindVisualEvidence,
    prompt: VersionedPrompt,
) -> list[SystemMessage | HumanMessage]:
    validate_blind_visual_direct_evidence(evidence)
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": "Allowed blind evidence JSON:\n" + json.dumps(_blind_text_payload(evidence), sort_keys=True, separators=(",", ":")),
        }
    ]
    content.extend(
        _image_blocks(
            contact_sheet_path=evidence.renders.contact_sheet.path,
            slides=tuple((str(item.selector), item.path) for item in evidence.renders.slides),
        )
    )
    return [SystemMessage(content=prompt.content), HumanMessage(content=content)]


def _plan_text_payload(evidence: PlanRealizationEvidence) -> dict[str, Any]:
    return {
        "schema_version": evidence.schema_version,
        "brief": evidence.brief.model_dump(mode="json"),
        "expected_slide_count": evidence.renders.expected_slide_count,
        "selectors": evidence.renders.selectors,
        "visible_text": [item.model_dump(mode="json") for item in evidence.visible_text],
        "creative_plan": evidence.creative_plan,
        "design_plan": evidence.design_plan,
        "subject_materials": evidence.subject_materials,
        "signature": evidence.signature,
        "rhythm": evidence.rhythm,
        "commitments": [item.model_dump(mode="json") for item in evidence.commitments],
        "explicit_style_constraints": evidence.explicit_style_constraints,
        "rubric": evidence.rubric.model_dump(mode="json"),
    }


def validate_plan_realization_direct_evidence(
    evidence: PlanRealizationEvidence,
) -> DirectEvidenceBudgetUsage:
    return _validate_direct_evidence_budget(
        expected_slide_count=evidence.renders.expected_slide_count,
        selectors=tuple(str(value) for value in evidence.renders.selectors),
        slides=tuple(
            (str(item.selector), item.path, item.width, item.height)
            for item in evidence.renders.slides
        ),
        contact_sheet=(
            evidence.renders.contact_sheet.path,
            evidence.renders.contact_sheet.width,
            evidence.renders.contact_sheet.height,
        ),
        text_payload=_plan_text_payload(evidence),
    )


def build_plan_realization_messages(
    evidence: PlanRealizationEvidence,
    prompt: VersionedPrompt,
) -> list[SystemMessage | HumanMessage]:
    validate_plan_realization_direct_evidence(evidence)
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": "Allowed plan-realization evidence JSON:\n" + json.dumps(_plan_text_payload(evidence), sort_keys=True, separators=(",", ":")),
        }
    ]
    content.extend(
        _image_blocks(
            contact_sheet_path=evidence.renders.contact_sheet.path,
            slides=tuple((str(item.selector), item.path) for item in evidence.renders.slides),
        )
    )
    return [SystemMessage(content=prompt.content), HumanMessage(content=content)]
