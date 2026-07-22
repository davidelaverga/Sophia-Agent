"""Model-facing P-1 deck build tool."""

import json
from typing import Any, Literal

from langchain.tools import ToolRuntime
from langchain_core.tools import StructuredTool

from deerflow.sophia.build_runtime.events import record_runtime_event
from deerflow.sophia.deck_build.ir_repair import deck_ir_repair_instruction_from_failure
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.tool_contract import (
    DeckCreativePlanInput,
    DeckSlideInput,
    NormalizedDeckCreativePlan,
    NormalizedDeckSlides,
    PrepareDeckBuildInput,
)


class _PrepareDeckBuildTool(StructuredTool):
    @property
    def tool_call_schema(self):  # type: ignore[override]
        # Preserve the public ``register`` alias while the runtime model uses
        # ``deck_register`` internally to avoid shadowing BaseModel.register.
        return PrepareDeckBuildInput


def _prepare_deck_build_impl(
    runtime: ToolRuntime,
    deck_title: str,
    slides: NormalizedDeckSlides,
    output_path: str,
    creative_plan: NormalizedDeckCreativePlan,
    authoring_contract: Literal["compact_model_html_v1", "compact_model_html_v2"] | None = None,
    deck_stylesheet: str | None = None,
    deck_register: str = "professional_technical",
    visual_policy: str = "auto",
    style_profile: dict[str, Any] | None = None,
    design_plan: dict[str, Any] | None = None,
) -> str:
    """Build a fresh native PPTX deck from creative plan plus compact slide HTML.

    Args:
        deck_title: Human-readable deck title.
        slides: Ordered slide dictionaries with title, narrative, role,
            layout_kind, speaker_notes, html_body, and exactly two
            repair_anchor_ids. For compact_model_html_v2,
            omit slide_css or pass an empty string so the later authenticated
            repair overlay retains its full 1024-byte channel.
        deck_stylesheet: Shared model-authored CSS for all slide bodies.
        output_path: Absolute /mnt/user-data/outputs/*.pptx output path.
        deck_register: Internal name for the public ``register`` deck style.
        visual_policy: auto for normal decks, required for legacy callers where
            images are allowed but creative_plan decides, or text_only for explicit
            plain/no-visual deck requests.
        style_profile: Optional compatibility style hints.
        design_plan: Optional compatibility design hints; prefer creative_plan.
        creative_plan: Required fresh-deck DeckCreativePlan. Every
            slide_compositions item requires selector, slide_role,
            headline_intent, layout_name, composition_rationale,
            native_elements, and image_asset_ids.
        authoring_contract: Required compact_model_html_v2 for new model calls.
            Omit only for queued/internal compact-v1 compatibility.

    Fresh PPTX rules:
        Call this tool once with the complete creative_plan, deck_stylesheet,
        and all slide html_body plus repair_anchor_ids values. Do not call deck.py, html2patch.py,
        build_deck_from_slides, prepare_pptx_image_manifest, image generation
        scripts, python-pptx, or pptxgenjs directly. Generated images must be
        declared in creative_plan.image_assets and used only as assets, not as
        complete slides. If this returns retryable=true, repair the exact
        creative/html/mechanical failure and call prepare_deck_build exactly
        once more. Terminal failures must be emitted with artifact_path=null.
    """
    normalized_slides = [slide.model_dump() if isinstance(slide, DeckSlideInput) else slide for slide in slides]
    normalized_plan = creative_plan.model_dump() if isinstance(creative_plan, DeckCreativePlanInput) else creative_plan
    state = runtime.state if isinstance(getattr(runtime, "state", None), dict) else {}
    tool_call_id = str(getattr(runtime, "tool_call_id", "") or "") or None
    record_runtime_event(
        state=state,
        runtime=runtime,
        event_type="prepare.service_started",
        tool_call_id=tool_call_id,
        metrics={"slide_count": len(normalized_slides)},
    )
    result = DeckBuildService().prepare_and_build(
        runtime=runtime,
        deck_title=deck_title,
        slides=normalized_slides,
        output_path=output_path,
        register=deck_register,
        visual_policy=visual_policy,
        deck_stylesheet=deck_stylesheet,
        authoring_contract=authoring_contract,
        style_profile=style_profile,
        design_plan=design_plan,
        creative_plan=normalized_plan,
    )
    record_runtime_event(
        state=state,
        runtime=runtime,
        event_type="prepare.service_finished",
        tool_call_id=tool_call_id,
        status="completed" if result.success else "failed",
        failure_code=result.failure_code,
        metrics={"slide_count": len(normalized_slides), "success": result.success},
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
                    "Repair the creative_plan, deck_stylesheet, slide html_body, and repair_anchor_ids values, then "
                    "call prepare_deck_build exactly once more."
                ),
                "repair_message": (
                    "Repair the D2.1 deck input and call prepare_deck_build exactly once more. Include "
                    "authoring_contract=compact_model_html_v2, one concise creative_plan, one shared deck_stylesheet, "
                    "html_body, and exactly two repair_anchor_ids for every slide; "
                    "omit slide_css or pass an empty string so the later authenticated "
                    "repair overlay retains its full 1024-byte channel."
                ),
            }
    return json.dumps(payload)


prepare_deck_build = _PrepareDeckBuildTool.from_function(
    func=_prepare_deck_build_impl,
    name="prepare_deck_build",
    args_schema=PrepareDeckBuildInput,
    description="Build a fresh native PPTX deck from a typed creative plan and compiler-supported slide HTML.",
    infer_schema=False,
    parse_docstring=True,
)
