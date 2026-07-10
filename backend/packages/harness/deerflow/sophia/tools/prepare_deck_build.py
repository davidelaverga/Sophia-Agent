"""Model-facing P-1 deck build tool."""

from __future__ import annotations

import json
from typing import Any

from langchain.tools import ToolRuntime, tool

from deerflow.sophia.deck_build.ir_repair import deck_ir_repair_instruction_from_failure
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.tool_contract import DeckCreativePlanInput


@tool("prepare_deck_build", parse_docstring=True)
def prepare_deck_build(
    runtime: ToolRuntime,
    deck_title: str,
    slides: list[dict[str, Any]],
    output_path: str,
    creative_plan: DeckCreativePlanInput,
    register: str = "professional_technical",
    visual_policy: str = "auto",
    style_profile: dict[str, Any] | None = None,
    design_plan: dict[str, Any] | None = None,
) -> str:
    """Build a fresh native PPTX deck from creative plan plus slide HTML.

    Args:
        deck_title: Human-readable deck title.
        slides: Ordered slide dictionaries with title, narrative, role,
            layout_kind, speaker_notes, and html_source. Do not write
            slides/*.html yourself; pass each slide HTML source here.
        output_path: Absolute /mnt/user-data/outputs/*.pptx output path.
        register: Deck register such as professional_technical or executive.
        visual_policy: auto for normal decks, required for legacy callers where
            images are allowed but creative_plan decides, or text_only for explicit
            plain/no-visual deck requests.
        style_profile: Optional compatibility style hints.
        design_plan: Optional compatibility design hints; prefer creative_plan.
        creative_plan: Required fresh-deck DeckCreativePlan. Every
            slide_compositions item requires selector, slide_role,
            headline_intent, layout_name, composition_rationale,
            native_elements, and image_asset_ids.

    Fresh PPTX rules:
        Call this tool once with the complete creative_plan and all slide
        html_source values. Do not call deck.py, html2patch.py,
        build_deck_from_slides, prepare_pptx_image_manifest, image generation
        scripts, python-pptx, or pptxgenjs directly. Generated images must be
        declared in creative_plan.image_assets and used only as assets, not as
        complete slides. If this returns retryable=true, repair the exact
        creative/html/mechanical failure and call prepare_deck_build exactly
        once more. Terminal failures must be emitted with artifact_path=null.
    """
    result = DeckBuildService().prepare_and_build(
        runtime=runtime,
        deck_title=deck_title,
        slides=slides,
        output_path=output_path,
        register=register,
        visual_policy=visual_policy,
        style_profile=style_profile,
        design_plan=design_plan,
        creative_plan=creative_plan.model_dump(),
    )
    payload = result.to_dict()
    if payload.get("repair_instruction") is None:
        payload.pop("repair_instruction", None)
    if result.success is False and result.retryable:
        if payload.get("repair_instruction") is None and result.failure_code == "invalid_deck_ir":
            instruction = deck_ir_repair_instruction_from_failure(
                failure_code=result.failure_code or "",
                failure_summary=result.failure_summary or "",
                retryable=result.retryable,
                attempt_count=0,
            )
            if instruction.should_retry:
                payload["repair_instruction"] = instruction.to_dict()
        elif isinstance(result.repair_instruction, dict):
            payload["repair_instruction"] = result.repair_instruction
        if payload.get("repair_instruction") is None:
            payload["repair_instruction"] = {
                "should_retry": True,
                "max_retry_count": 1,
                "message": (
                    "Repair the creative_plan and slide html_source values, then call "
                    "prepare_deck_build exactly once more."
                ),
                "repair_message": (
                    "Repair the D2.1 deck input and call prepare_deck_build exactly once more. "
                    "Include creative_plan and html_source for every slide."
                ),
            }
    return json.dumps(payload)
