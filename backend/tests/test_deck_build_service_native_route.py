from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.agents.sophia_agent.builder_tools import (
    assert_deck_tool_contract,
    build_builder_tools_for_task_type,
)
from deerflow.sophia.deck_build.models import DeckBuild, DeckSlideSpec
from deerflow.sophia.deck_build.service import DeckBuildFailure, DeckBuildService
from deerflow.sophia.deck_build.tracing import (
    HTML_SCREENSHOT_FALLBACK_COMPILE_MODE,
    NATIVE_DECK_COMPILE_MODE,
    NATIVE_UNAVAILABLE_DECK_COMPILE_MODE,
)
from deerflow.sophia.deck_native import DeckNativeService
from deerflow.sophia.deck_native.models import NativeDeckPatchResult, NativeDeckPreflight

_OUTPUTS = "/mnt/user-data/outputs/"


def _runtime(outputs: Path) -> SimpleNamespace:
    outputs.mkdir(parents=True, exist_ok=True)
    workspace = outputs.parent / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(
        state={
            "thread_id": "builder-thread",
            "parent_thread_id": "companion-thread",
            "user_id": "user-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "builder_pptx_requested_slide_count": 2,
            "delegation_context": {"request": "Build a plain text-only 2 slide deck with no visuals."},
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace),
            },
        },
        context={"thread_id": "builder-thread"},
        config={},
    )


def _slides() -> list[dict[str, str]]:
    return [
        {
            "title": "Native Deck Substrate",
            "narrative": "The deck compile step emits editable PowerPoint text shapes.",
            "role": "cover",
            "layout_kind": "cover_hero",
            "visual_prompt": "",
            "html_source": _html("Native Deck Substrate", "The deck compile step emits editable PowerPoint text shapes."),
        },
        {
            "title": "Shape Inventory",
            "narrative": "Each slide records native title and body shape ids for later co-review.",
            "role": "architecture",
            "layout_kind": "single_visual_focus",
            "visual_prompt": "",
            "html_source": _html("Shape Inventory", "Each slide records native title and body shape ids for later co-review."),
        },
    ]


def _html(title: str, narrative: str) -> str:
    return f"""<!doctype html><html><head><style>
html, body {{ margin: 0; padding: 0; width: 1920px; height: 1080px; background: #0A0E14; }}
body {{ overflow: hidden; color: #EEF4FB; font-family: Aptos, Arial, sans-serif; }}
.canvas {{ position: relative; width: 1920px; height: 1080px; background: #0A0E14; }}
h1 {{ position: absolute; left: 120px; top: 110px; width: 1280px; font-size: 64px; }}
p {{ position: absolute; left: 120px; top: 780px; width: 1240px; font-size: 30px; color: #A7B4C2; }}
.panel {{ position: absolute; left: 120px; top: 300px; width: 1320px; height: 360px; border: 3px solid #38BDF8; background: #111827; }}
</style></head><body><main class="canvas">
<h1 data-deck-id="title" data-deck-role="title" data-deck-required="true">{title}</h1>
<div class="panel" data-deck-id="diagram" data-deck-role="diagram"></div>
<p data-deck-id="narrative" data-deck-role="narrative" data-deck-required="true">{narrative}</p>
</main></body></html>"""


def _creative_plan() -> dict[str, Any]:
    return {
        "subject": "Native Deck",
        "audience": "technical stakeholders",
        "goal": "verify native PowerPoint substrate",
        "viewing_context": "Reviewed live on a standard 16:9 technical presentation display.",
        "subject_materials": ["native text shapes", "shape inventory", "source-retention map"],
        "story_arc": "Show native compile, then inspect shape inventory.",
        "design_plan": {
            "source": "test",
            "subject": "Native Deck",
            "audience": "technical stakeholders",
            "goal": "verify native PowerPoint substrate",
            "style_lane": "technical_blueprint",
            "palette": [
                {"name": "background", "hex": "#0A0E14", "role": "slide substrate"},
                {"name": "surface", "hex": "#111827", "role": "panel"},
                {"name": "ink", "hex": "#EEF4FB", "role": "text"},
                {"name": "accent", "hex": "#38BDF8", "role": "linework"},
            ],
            "typography": {"display": "Aptos Display", "body": "Aptos", "utility": "Aptos"},
            "grid": {"slide_width_px": 1920, "slide_height_px": 1080},
            "signature": "dark native substrate",
            "rhythm": "two native proof slides",
            "anti_slop_profile": ["native text", "no screenshot substrate"],
            "requested_style_terms": ["dark_technical"],
        },
        "image_strategy": "diagram_native",
        "image_strategy_rationale": "The subject is compiler structure, so native shapes are the clearest medium.",
        "image_assets": [],
        "slide_compositions": [
            {
                "selector": "slide:1",
                "slide_role": "cover",
                "headline_intent": "Introduce native compile",
                "layout_name": "native_cover",
                "composition_rationale": "Dark native statement slide.",
                "native_elements": ["title", "panel", "narrative"],
                "image_asset_ids": [],
                "required_element_ids": ["title", "diagram", "narrative"],
                "structural_fingerprint": "cover-left-title-central-proof-panel",
            },
            {
                "selector": "slide:2",
                "slide_role": "architecture",
                "headline_intent": "Show shape inventory",
                "layout_name": "native_inventory",
                "composition_rationale": "Native text and panel structure.",
                "native_elements": ["title", "panel", "narrative"],
                "image_asset_ids": [],
                "required_element_ids": ["title", "diagram", "narrative"],
                "structural_fingerprint": "inventory-top-title-wide-evidence-panel",
            },
        ],
        "skill_refs": ["hands-on-deck/designing-slides", "deck-impeccable/critique"],
        "plan_critique": {
            "initial_scores": {
                "philosophy": 3,
                "hierarchy": 4,
                "execution_feasibility": 4,
                "specificity": 3,
                "restraint": 4,
                "variety": 3,
            },
            "weakest_point": "The proof sequence initially lacked structural distinction.",
            "revision_made": "Separated the cover proof from the inventory evidence composition.",
            "final_scores": {
                "philosophy": 4,
                "hierarchy": 4,
                "execution_feasibility": 4,
                "specificity": 4,
                "restraint": 4,
                "variety": 4,
            },
        },
        "anti_slop_commitments": ["structural variety", "native text"],
    }


class PatchWritingNativeService:
    def __init__(self) -> None:
        self._real = DeckNativeService()

    def html_to_patch(self, *, html_paths: list[str], base_deck_path: str, output_patch_path: str) -> NativeDeckPatchResult:
        ops: list[dict[str, Any]] = []
        for index, _html in enumerate(html_paths):
            ops.extend(
                [
                    {"op": "add-slide", "layout": "Blank"},
                    {
                        "op": "add-shape",
                        "slide": index,
                        "kind": "textbox",
                        "at": [0.8, 0.7],
                        "size": [12.5, 0.8],
                        "text": [f"Native title {index + 1}"],
                        "font_size": 28,
                        "color": "111827",
                        "fill": "FFFFFF",
                        "name": f"s{index + 1}-title-text",
                    },
                    {
                        "op": "add-shape",
                        "slide": index,
                        "kind": "textbox",
                        "at": [0.8, 1.9],
                        "size": [10.5, 0.7],
                        "text": [f"Native body {index + 1}"],
                        "font_size": 20,
                        "color": "111827",
                        "fill": "FFFFFF",
                        "name": f"s{index + 1}-narrative-text",
                    },
                    {
                        "op": "add-shape",
                        "slide": index,
                        "kind": "rect",
                        "at": [0.8, 3.0],
                        "size": [10.5, 2.0],
                        "fill": "E2E8F0",
                        "name": f"s{index + 1}-diagram-box",
                    },
                ]
            )
        patch_path = Path(output_patch_path)
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        patch_path.write_text(json.dumps({"ops": ops}), encoding="utf-8")
        source_map_path = patch_path.with_suffix(".source-map.json")
        source_map_path.write_text(
            json.dumps(
                {
                    "schema_version": "sophia-deck-source-map/v1",
                    "slides": {
                        f"slide:{index}": {
                            "elements": {
                                "title": {
                                    "source_role": "title",
                                    "source_required": True,
                                    "shape_names": [f"s{index}-title-text"],
                                },
                                "diagram": {
                                    "source_role": "diagram",
                                    "source_required": False,
                                    "shape_names": [f"s{index}-diagram-box"],
                                },
                                "narrative": {
                                    "source_role": "narrative",
                                    "source_required": True,
                                    "shape_names": [f"s{index}-narrative-text"],
                                },
                            }
                        }
                        for index in range(1, len(html_paths) + 1)
                    },
                }
            ),
            encoding="utf-8",
        )
        return NativeDeckPatchResult(True, None, str(patch_path), len(ops), 0, [], str(source_map_path))

    def apply_patch(self, **kwargs: Any):
        return self._real.apply_patch(**kwargs)

    def inspect(self, *args: Any, **kwargs: Any):
        return self._real.inspect(*args, **kwargs)

    def lint_fix(self, **kwargs: Any):
        return self._real.lint_fix(**kwargs)

    def render(self, *, pptx_path: str, output_dir: str, slides: list[int] | None = None):
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        for slide in slides or [0]:
            (Path(output_dir) / f"slide-{slide}.jpg").write_bytes(b"fake jpg")
        from deerflow.sophia.deck_native.models import NativeDeckRenderResult

        return NativeDeckRenderResult(True, output_dir, len(slides or [0]), [])

    def diff(self, **_kwargs: Any) -> dict[str, Any]:
        return {"success": True, "changed": True, "errors": []}


class FailingNativeService(PatchWritingNativeService):
    def html_to_patch(self, *, html_paths: list[str], base_deck_path: str, output_patch_path: str) -> NativeDeckPatchResult:
        return NativeDeckPatchResult(False, None, None, 0, 1, ["body is 1.00x1.00in but the slide is 20.00x11.25in"])


class PatchValidationFailingNativeService(PatchWritingNativeService):
    def apply_patch(self, **_kwargs: Any) -> NativeDeckPatchResult:
        return NativeDeckPatchResult(False, None, "deck.patch.json", 3, 1, ["1 validation error: slide index out of range"])


class MissingNativeService(PatchWritingNativeService):
    def preflight(self) -> NativeDeckPreflight:
        return NativeDeckPreflight(
            success=False,
            scripts_dir_exists=True,
            deck_py_exists=False,
            html2patch_py_exists=False,
            errors=[
                "hands-on-deck script not found: deck.py",
                "hands-on-deck script not found: html2patch.py",
            ],
        )


def test_deck_build_service_native_route_builds_editable_deck(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")

    result = DeckBuildService(native_service=PatchWritingNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Native Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}native.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.deck_compile_mode == NATIVE_DECK_COMPILE_MODE
    assert result.native_editability_score >= 0.60
    assert result.native_text_shape_count >= 4
    assert result.full_slide_picture_count == 0
    assert result.quality_warning is None
    assert (tmp_path / "outputs" / "native.pptx").is_file()
    assert (tmp_path / "outputs" / ".builder" / "deck_native" / "base.pptx").is_file()
    assert (tmp_path / "outputs" / ".builder" / "deck_native" / "deck.patch.json").is_file()
    assert (tmp_path / "outputs" / ".builder" / "deck_native" / "rendered").is_dir()
    assert not (tmp_path / "outputs" / "deck_native").exists()
    assert not (tmp_path / "outputs" / "native.inspect.json").exists()
    assert not (tmp_path / "outputs" / "native.shape-inventory.json").exists()
    build = json.loads((tmp_path / "outputs" / "deck_build" / "build.json").read_text(encoding="utf-8"))
    assert build["deck_compile_mode"] == NATIVE_DECK_COMPILE_MODE
    assert build["native_shape_inventory"]["slide:1"]["title"].startswith("s")
    assert build["slides"][0]["gate_results"]["native_shape_inventory"]["title"].startswith("s")


def test_deck_build_service_native_failure_does_not_screenshot_fallback(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")

    result = DeckBuildService(native_service=FailingNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Native Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}native.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_native_html2patch_failed"
    assert result.deck_compile_mode == NATIVE_DECK_COMPILE_MODE
    assert result.pptx_path is None
    assert not (tmp_path / "outputs" / "native.pptx").exists()


def test_native_patch_validation_failure_is_specific(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")

    result = DeckBuildService(native_service=PatchValidationFailingNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Native Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}native.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_native_patch_validation_failed"
    assert result.pptx_path is None
    assert not (tmp_path / "outputs" / "native.pptx").exists()


def test_native_preflight_failure_returns_unavailable_without_pptx(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")

    result = DeckBuildService(native_service=MissingNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Native Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}native.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_native_unavailable"
    assert result.deck_compile_mode == NATIVE_UNAVAILABLE_DECK_COMPILE_MODE
    assert result.pptx_path is None
    assert "deck.py" in (result.failure_summary or "")
    assert not (tmp_path / "outputs" / "native.pptx").exists()


def test_screenshot_debug_does_not_override_production_native_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", "true")
    monkeypatch.setenv("RENDER", "true")
    runtime = _runtime(tmp_path / "outputs")

    result = DeckBuildService(native_service=MissingNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Native Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}native.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_native_unavailable"
    assert result.pptx_path is None
    assert not (tmp_path / "outputs" / "native.pptx").exists()


def test_screenshot_compile_mode_cannot_success(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    deck = DeckBuild(
        build_id="deck-test",
        schema_version="sophia-deck-build/v1",
        user_id="user-1",
        thread_id="builder-thread",
        parent_thread_id="parent-thread",
        run_id="run-1",
        task_id="task-1",
        requested_slide_count=1,
        status="compiled",
        register="professional_technical",
        visual_policy="text_only",
        style_profile={},
        deck_title="Forbidden",
        output_path=f"{_OUTPUTS}forbidden.pptx",
        slides=[],
        expected_visual_count=0,
        deck_compile_mode=HTML_SCREENSHOT_FALLBACK_COMPILE_MODE,
        native_editability_score=0.0,
        native_text_shape_count=0,
        full_slide_picture_count=1,
        pptx_path=f"{_OUTPUTS}forbidden.pptx",
    )

    with pytest.raises(DeckBuildFailure) as exc_info:
        DeckBuildService()._success_result(deck, f"{_OUTPUTS}deck_build/build.json", runtime)

    assert exc_info.value.code == "deck_screenshot_compile_forbidden"


def test_screenshot_substrate_cannot_success(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    deck = DeckBuild(
        build_id="deck-test",
        schema_version="sophia-deck-build/v1",
        user_id="user-1",
        thread_id="builder-thread",
        parent_thread_id="parent-thread",
        run_id="run-1",
        task_id="task-1",
        requested_slide_count=1,
        status="compiled",
        register="professional_technical",
        visual_policy="text_only",
        style_profile={},
        deck_title="Forbidden",
        output_path=f"{_OUTPUTS}forbidden.pptx",
        slides=[
            DeckSlideSpec(
                selector="slide:1",
                index=1,
                role="cover",
                layout_kind="cover_hero",
                title="Screenshot",
                narrative="Screenshot-only substrate.",
            )
        ],
        expected_visual_count=0,
        deck_compile_mode=NATIVE_DECK_COMPILE_MODE,
        native_editability_score=0.9,
        native_text_shape_count=0,
        picture_shape_count=1,
        full_slide_picture_count=1,
        pptx_path=f"{_OUTPUTS}forbidden.pptx",
    )

    with pytest.raises(DeckBuildFailure) as exc_info:
        DeckBuildService()._success_result(deck, f"{_OUTPUTS}deck_build/build.json", runtime)

    assert exc_info.value.code == "deck_screenshot_substrate_forbidden"


def test_prepare_deck_build_remains_only_model_facing_fresh_deck_tool(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)
    tools = build_builder_tools_for_task_type("presentation", vision_enabled=True, artifact_target_ext=".pptx")

    snapshot = assert_deck_tool_contract(tools, task_type="presentation", artifact_target_ext=".pptx")

    assert snapshot is not None
    assert snapshot["prepare_deck_build_exposed"] is True
    assert snapshot["lower_level_deck_tools_exposed"] == []
    assert all(getattr(tool, "name", "") not in {"deck.py", "html2patch.py"} for tool in tools)


def test_pdf_presentation_target_exposes_real_pdf_renderer_not_deck_tools() -> None:
    tools = build_builder_tools_for_task_type("presentation", vision_enabled=True, artifact_target_ext=".pdf")
    tool_names = {getattr(tool, "name", "") for tool in tools}

    assert "render_html_to_pdf" in tool_names
    assert "prepare_deck_build" not in tool_names
    assert "prepare_pptx_image_manifest" not in tool_names
    assert "build_deck_from_slides" not in tool_names
    assert assert_deck_tool_contract(tools, task_type="presentation", artifact_target_ext=".pdf") is None
