from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import ToolMessage
from langgraph.types import Command
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from deerflow.agents.sophia_agent.builder_tools import (
    assert_deck_tool_contract,
    build_builder_tools_for_task_type,
    deck_build_service_enabled,
)
from deerflow.agents.sophia_agent.middlewares import builder_artifact as builder_artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.sandbox.tools import replace_virtual_path
from deerflow.sophia.deck_build import service as deck_service
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.storage import load_deck_build
from deerflow.sophia.deck_build.tool_contract import DeckCreativePlanInput
from deerflow.sophia.deck_build.tracing import NATIVE_DECK_COMPILE_MODE
from deerflow.sophia.deck_native.models import (
    NativeDeckInspectResult,
    NativeDeckLintFixResult,
    NativeDeckPatchResult,
    NativeDeckPreflight,
    NativeDeckRenderResult,
)
from deerflow.sophia.tools.prepare_deck_build import prepare_deck_build

_OUTPUTS = "/mnt/user-data/outputs/"


def _runtime(outputs: Path, *, user_request: str = "Build a visual 3 slide deck") -> SimpleNamespace:
    outputs.mkdir(parents=True, exist_ok=True)
    workspace = outputs.parent / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(
        state={
            "thread_id": "builder-thread",
            "parent_thread_id": "companion-thread",
            "user_id": "user-1",
            "task_id": "task-1",
            "builder_pptx_requested_slide_count": 3,
            "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "delegation_context": {"request": user_request},
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace),
            },
        },
        context={"thread_id": "builder-thread"},
        config={},
    )


def _slide_html(index: int, title: str, narrative: str, *, include_asset: bool = False) -> str:
    asset = f'<figure class="asset"><img src="../assets/slide-{index:02d}.png" alt="" /></figure>' if include_asset else ""
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body {{ margin: 0; padding: 0; width: 1920px; height: 1080px; background: #0A0E14; }}
body {{ overflow: hidden; color: #EEF4FB; font-family: Aptos, Arial, sans-serif; }}
.canvas {{ position: relative; width: 1920px; height: 1080px; background: #0A0E14; }}
h1 {{ position: absolute; left: 120px; top: 90px; width: 1250px; margin: 0; font-size: 64px; line-height: 1.05; }}
.narrative {{ position: absolute; left: 120px; top: 830px; width: 1320px; font-size: 30px; line-height: 1.3; color: #A7B4C2; }}
.diagram {{ position: absolute; left: 120px; top: 280px; width: 1500px; height: 420px; border: 3px solid #38BDF8; background: #111827; }}
.node {{ position: absolute; top: 130px; width: 300px; height: 120px; border: 2px solid #38BDF8; }}
.node.a {{ left: 120px; }} .node.b {{ left: 600px; }} .node.c {{ left: 1080px; }}
.asset {{ position: absolute; inset: 0; margin: 0; }}
.asset img {{ width: 100%; height: 100%; object-fit: cover; }}
</style></head><body><main class="canvas">
{asset}
	<h1 data-deck-id="title-{index}" data-deck-role="title" data-deck-required="true">{title}</h1>
	<section class="diagram" data-deck-id="diagram-{index}" data-deck-role="diagram"><div class="node a"></div><div class="node b"></div><div class="node c"></div></section>
	<p class="narrative" data-deck-id="narrative-{index}" data-deck-role="narrative" data-deck-required="true">{narrative}</p>
</main></body></html>"""


def _slides(count: int = 3, *, include_asset: bool = True) -> list[dict]:
    roles = ["cover", "architecture", "closing"]
    layouts = ["cover_hero", "single_visual_focus", "closing_summary"]
    slides = []
    for index in range(1, count + 1):
        title = f"Slide {index} System Story"
        narrative = "A concise technical narrative explains the point with calm professional framing."
        slides.append(
            {
                "title": f"Slide {index} System Story",
                "narrative": narrative,
                "role": roles[index - 1],
                "layout_kind": layouts[index - 1],
                "visual_prompt": f"Professional technical visual metaphor for slide {index}",
                "speaker_notes": "Optional notes.",
                "html_source": _slide_html(index, title, narrative, include_asset=include_asset and index == 1),
            }
        )
    return slides


def _creative_plan(*, include_asset: bool = True) -> dict:
    image_assets = []
    if include_asset:
        image_assets.append(
            {
                "asset_id": "cover-texture",
                "slide_selector": "slide:1",
                "role": "hero_background",
                "reason": "Establishes subject atmosphere without carrying semantic text.",
                "prompt": "Dark technical abstract system texture, no readable text, no labels.",
                "aspect_ratio": "16:9",
                "integration": "full_bleed_background",
                "no_baked_text": True,
            }
        )
    return {
        "subject": "Technical Deck",
        "audience": "technical stakeholders",
        "goal": "explain the system clearly",
        "viewing_context": "Presented live to technical stakeholders on a 16:9 display.",
        "subject_materials": ["system topology", "signal flow", "operational evidence"],
        "story_arc": "Frame the system, explain the architecture, close with synthesis.",
        "design_plan": {
            "source": "test",
            "subject": "Technical Deck",
            "audience": "technical stakeholders",
            "goal": "explain the system clearly",
            "style_lane": "technical_blueprint",
            "palette": [
                {"name": "background", "hex": "#0A0E14", "role": "slide substrate"},
                {"name": "surface", "hex": "#111827", "role": "panel"},
                {"name": "ink", "hex": "#EEF4FB", "role": "text"},
                {"name": "muted", "hex": "#A7B4C2", "role": "secondary text"},
                {"name": "accent", "hex": "#38BDF8", "role": "linework"},
            ],
            "typography": {"display": "Aptos Display", "body": "Aptos", "utility": "Aptos"},
            "grid": {"slide_width_px": 1920, "slide_height_px": 1080},
            "signature": "dark native technical diagram language",
            "rhythm": "cover, architecture, synthesis",
            "anti_slop_profile": ["native text", "structural variety"],
            "requested_style_terms": ["dark_technical"],
        },
        "image_strategy": "hybrid" if include_asset else "diagram_native",
        "image_strategy_rationale": "Use one atmospheric asset while keeping semantic system structure native.",
        "image_assets": image_assets,
        "slide_compositions": [
            {
                "selector": f"slide:{index}",
                "slide_role": role,
                "headline_intent": f"Explain slide {index}",
                "layout_name": layout,
                "composition_rationale": "Use native structure with clear hierarchy.",
                "native_elements": ["title", "narrative", "diagram"],
                "image_asset_ids": ["cover-texture"] if include_asset and index == 1 else [],
                "required_element_ids": [f"title-{index}", f"diagram-{index}", f"narrative-{index}"],
                "structural_fingerprint": f"{role}-{layout}-slide-{index}",
                "risk_notes": [],
            }
            for index, (role, layout) in enumerate(
                [
                    ("cover", "cover_with_texture"),
                    ("architecture", "architecture_native_diagram"),
                    ("closing", "closing_synthesis"),
                ],
                start=1,
            )
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
            "weakest_point": "The initial structures were too similar.",
            "revision_made": "Assigned a distinct spatial fingerprint to each narrative role.",
            "final_scores": {
                "philosophy": 4,
                "hierarchy": 4,
                "execution_feasibility": 4,
                "specificity": 4,
                "restraint": 4,
                "variety": 4,
            },
        },
        "anti_slop_commitments": ["structural variety across slides", "no screenshot substrate"],
    }


def _fake_compiler(calls: list[dict]):
    def compile_deck(runtime, output_path: str, title: str, slides_dir: str) -> dict:
        calls.append({"output_path": output_path, "title": title, "slides_dir": slides_dir})
        host = Path(replace_virtual_path(output_path, runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"fake pptx")
        slide_count = len(list((host.parent / "slides").glob("*.html")))
        return {
            "success": True,
            "pptx_path": output_path,
            "size_bytes": host.stat().st_size,
            "engine": "fake",
            "slide_count": slide_count,
            "overflow_slides": [],
        }

    return compile_deck


def _fake_batch(runtime: SimpleNamespace, *, create_outputs: bool = True, complete: bool = True):
    def run_batch(manifest_path: str, tool_runtime) -> dict:
        manifest_host = Path(replace_virtual_path(manifest_path, tool_runtime.state["thread_data"]))
        manifest = json.loads(manifest_host.read_text(encoding="utf-8"))
        items = []
        for item in manifest["items"]:
            output_file = item["output_file"]
            if create_outputs:
                host = Path(replace_virtual_path(output_file, tool_runtime.state["thread_data"]))
                host.parent.mkdir(parents=True, exist_ok=True)
                host.write_bytes(b"png")
            items.append({"output_file": output_file, "success": create_outputs, "error_class": None if create_outputs else "api_error"})
        return {
            "summary_present": True,
            "complete": complete and create_outputs,
            "requested": len(items),
            "images_generated": len(items) if create_outputs else 0,
            "failed": 0 if create_outputs else len(items),
            "items": items,
            "error_class_histogram": {},
        }

    return run_batch


class _FakeNativeService:
    def __init__(self, calls: list[dict] | None = None, *, full_slide_picture_count: int = 0) -> None:
        self.calls = calls if calls is not None else []
        self.full_slide_picture_count = full_slide_picture_count
        self.slide_count = 0
        self.source_map_path: str | None = None
        self.inventory_path: str | None = None

    def preflight(self) -> NativeDeckPreflight:
        return NativeDeckPreflight(True, True, True, True, [])

    def html_to_patch(self, *, html_paths: list[str], base_deck_path: str, output_patch_path: str) -> NativeDeckPatchResult:
        self.slide_count = len(html_paths)
        self.calls.append(
            {
                "stage": "html_to_patch",
                "html_basenames": [Path(path).name for path in html_paths],
                "base_file": Path(base_deck_path).name,
                "patch_file": Path(output_patch_path).name,
            }
        )
        patch = Path(output_patch_path)
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text(json.dumps({"ops": []}), encoding="utf-8")
        source_map = {
            "schema_version": "sophia-deck-source-map/v1",
            "slides": {
                f"slide:{index}": {
                    "elements": {
                        f"title-{index}": {
                            "source_role": "title",
                            "source_required": True,
                            "shape_names": [f"s{index}-title-{index}-text"],
                        },
                        f"diagram-{index}": {
                            "source_role": "diagram",
                            "source_required": False,
                            "shape_names": [f"s{index}-diagram-{index}-box"],
                        },
                        f"narrative-{index}": {
                            "source_role": "narrative",
                            "source_required": True,
                            "shape_names": [f"s{index}-narrative-{index}-text"],
                        },
                    }
                }
                for index in range(1, self.slide_count + 1)
            },
        }
        source_map_path = patch.with_suffix(".source-map.json")
        source_map_path.write_text(json.dumps(source_map), encoding="utf-8")
        self.source_map_path = str(source_map_path)
        return NativeDeckPatchResult(
            success=True,
            output_pptx_path=None,
            patch_path=str(patch),
            patch_op_count=0,
            validation_error_count=0,
            errors=[],
            source_map_path=self.source_map_path,
        )

    def apply_patch(self, *, base_deck_path: str, patch_path: str, output_path: str, fix: bool = True) -> NativeDeckPatchResult:
        self.calls.append({"stage": "apply_patch", "output_path": output_path, "fix": fix})
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        presentation = Presentation()
        presentation.slide_width = Inches(13.333333)
        presentation.slide_height = Inches(7.5)
        blank = presentation.slide_layouts[6]
        inventory: dict[str, dict] = {}
        for index in range(1, self.slide_count + 1):
            slide = presentation.slides.add_slide(blank)
            background = slide.background.fill
            background.solid()
            background.fore_color.rgb = RGBColor(0x0A, 0x0E, 0x14)
            title = slide.shapes.add_textbox(Inches(0.8), Inches(0.6), Inches(10), Inches(0.8))
            title.name = f"s{index}-title-{index}-text"
            title.text_frame.paragraphs[0].text = f"Slide {index} System Story"
            title_run = title.text_frame.paragraphs[0].runs[0]
            title_run.font.size = Pt(32)
            title_run.font.color.rgb = RGBColor(0xEE, 0xF4, 0xFB)
            diagram = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.8), Inches(2), Inches(10), Inches(2.5))
            diagram.name = f"s{index}-diagram-{index}-box"
            diagram.fill.solid()
            diagram.fill.fore_color.rgb = RGBColor(0x11, 0x18, 0x27)
            narrative = slide.shapes.add_textbox(Inches(0.8), Inches(5.7), Inches(10), Inches(0.6))
            narrative.name = f"s{index}-narrative-{index}-text"
            narrative.text_frame.paragraphs[0].text = "A concise technical narrative explains the point."
            narrative_run = narrative.text_frame.paragraphs[0].runs[0]
            narrative_run.font.size = Pt(20)
            narrative_run.font.color.rgb = RGBColor(0xEE, 0xF4, 0xFB)
            inventory[f"slide:{index}"] = {
                "native_slide_index": index - 1,
                "title": title.name,
                "body": narrative.name,
                "visual": diagram.name,
                "shapes": [
                    {"name": title.name},
                    {"name": diagram.name},
                    {"name": narrative.name},
                ],
            }
        presentation.save(output)
        inventory_path = output.with_suffix(".shape-inventory.json")
        inventory_path.write_text(json.dumps({"slides": inventory}), encoding="utf-8")
        self.inventory_path = str(inventory_path)
        return NativeDeckPatchResult(True, str(output), patch_path, 0, 0, [])

    def inspect(self, _pptx_path: str) -> NativeDeckInspectResult:
        native_text_shapes = max(1, self.slide_count) * 2
        return NativeDeckInspectResult(
            True,
            slide_count=self.slide_count,
            shape_count=max(1, self.slide_count) * 3 + self.full_slide_picture_count,
            native_text_shape_count=native_text_shapes,
            picture_shape_count=self.full_slide_picture_count,
            full_slide_picture_count=self.full_slide_picture_count,
            native_editability_score=0.9,
            shape_inventory_path=self.inventory_path,
            raw_json_path=None,
            errors=[],
        )

    def lint_fix(self, *, pptx_path: str, touched_slides: list[int] | None = None) -> NativeDeckLintFixResult:
        return NativeDeckLintFixResult(True, 0, 0, 0, len(touched_slides or []), [], [])

    def render(self, *, pptx_path: str, output_dir: str, slides: list[int] | None = None) -> NativeDeckRenderResult:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        for slide in slides or []:
            (Path(output_dir) / f"slide-{slide}.jpg").write_bytes(b"jpg")
        return NativeDeckRenderResult(True, output_dir, len(slides or []), [])

    def diff(self, *, before_path: str, after_path: str) -> dict:
        return {"success": True, "changed": True, "errors": []}


class _InvalidPptxNativeService(_FakeNativeService):
    def apply_patch(
        self,
        *,
        base_deck_path: str,
        patch_path: str,
        output_path: str,
        fix: bool = True,
    ) -> NativeDeckPatchResult:
        result = super().apply_patch(
            base_deck_path=base_deck_path,
            patch_path=patch_path,
            output_path=output_path,
            fix=fix,
        )
        Path(output_path).write_bytes(b"not a valid pptx package")
        return result


def test_deck_build_service_required_deck_writes_manifest_html_pptx_and_build_json(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    native_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(native_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.pptx_path == f"{_OUTPUTS}deck.pptx"
    assert result.deck_route == "deck_creative_html_native"
    assert result.deck_compile_mode == NATIVE_DECK_COMPILE_MODE
    assert result.native_editability_score == 0.9
    assert result.native_text_shape_count >= 6
    assert result.full_slide_picture_count == 0
    assert result.expected_visual_count == 1
    assert result.successful_visual_count == 1
    assert result.referenced_visual_count == 1
    assert result.generated_asset_count == 1
    assert result.native_html_slide_count == 2
    assert result.hybrid_slide_count == 1
    assert native_calls[0]["html_basenames"] == ["01-cover.html", "02-architecture.html", "03-closing.html"]
    outputs = tmp_path / "outputs"
    prompt_files = sorted((outputs / "assets" / "prompts").glob("slide-*.json"))
    assert len(prompt_files) == 1
    prompt_payload = json.loads(prompt_files[0].read_text(encoding="utf-8"))
    assert prompt_payload["style"]["visual_style"] == "asset_only_supporting_visual"
    assert prompt_payload["technical"]["deck_asset"] is True
    assert prompt_payload["technical"]["slide_visual"] is False
    assert prompt_payload["technical"]["slide_index"] == 1
    assert "supporting asset" in prompt_payload["constraints"][0]
    assert "handwritten" not in json.dumps(prompt_payload).lower()
    manifest = json.loads((outputs / "assets" / "slide-visuals.manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_author"] == "DeckBuildService"
    assert len(manifest["items"]) == 1
    assert manifest["items"][0]["deck_asset"] is True
    assert manifest["items"][0]["slide_visual"] is False
    assert len(list((outputs / "slides").glob("*.html"))) == 3
    html = (outputs / "slides" / "02-architecture.html").read_text(encoding="utf-8")
    assert 'class="diagram"' in html
    assert 'data-deck-id="title-2"' in html
    assert ">Slide 2 System Story</h1>" in html
    build = json.loads((outputs / "deck_build" / "build.json").read_text(encoding="utf-8"))
    assert build["schema_version"] == "sophia-deck-build/v1"
    assert build["status"] == "evaluated"
    assert build["deck_route"] == "deck_creative_html_native"
    assert build["deck_compile_mode"] == NATIVE_DECK_COMPILE_MODE
    assert build["native_editability_score"] == 0.9
    assert build["image_generation_status"] == "success"
    assert build["primary_image_batch_status"] == "success"
    assert build["design_plan_path"] == f"{_OUTPUTS}deck_build/design_plan.json"
    assert build["creative_plan_path"] == f"{_OUTPUTS}deck_build/creative_plan.json"
    assert build["asset_policy_path"] == f"{_OUTPUTS}deck_build/asset_policy.json"
    assert build["generated_asset_count"] == 1
    assert build["native_html_slide_count"] == 2
    assert "Dark technical abstract system texture" in build["slides"][0]["visual_prompt"]
    loaded = load_deck_build(result.deck_build_path, runtime)
    assert loaded is not None
    assert loaded.build_id == result.build_id
    assert loaded.slides[0].selector == "slide:1"


def test_deck_build_service_contrast_analyzer_failure_is_clean_terminal_result(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    result = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_InvalidPptxNativeService(),
    ).prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_native_contrast_analysis_failed"
    assert result.retryable is False


def test_deck_build_service_clears_stale_slide_html_before_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    slides_dir = tmp_path / "outputs" / "slides"
    slides_dir.mkdir(parents=True)
    (slides_dir / "99-stale.html").write_text("<html>stale</html>", encoding="utf-8")
    native_calls: list[dict] = []

    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(native_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert "99-stale.html" not in native_calls[0]["html_basenames"]
    assert native_calls[0]["html_basenames"] == ["01-cover.html", "02-architecture.html", "03-closing.html"]


def test_deck_build_service_nested_output_path_evaluates_against_outputs_root(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Nested Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}decks/foo.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.pptx_path == f"{_OUTPUTS}decks/foo.pptx"
    assert (tmp_path / "outputs" / "slides" / "01-cover.html").is_file()
    assert (tmp_path / "outputs" / "decks" / "foo.pptx").is_file()


def test_deck_build_service_full_slide_picture_in_native_deck_warns(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(full_slide_picture_count=1),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Overflow Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.full_slide_picture_count == 1
    assert result.quality_warning == "native_full_bleed_picture_present"


def test_deck_build_service_missing_visual_prompt_does_not_fail_normal_native_slide(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    batch_called = False

    def batch_runner(manifest_path, tool_runtime):
        nonlocal batch_called
        batch_called = True
        return _fake_batch(runtime)(manifest_path, tool_runtime)

    service = DeckBuildService(image_batch_runner=batch_runner, native_service=_FakeNativeService())
    slides = _slides()
    slides[1]["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.expected_visual_count == 1
    assert batch_called is True
    assert (tmp_path / "outputs" / "deck.pptx").exists()


def test_deck_build_service_allows_negated_visual_prompt_guardrails(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )
    slides = _slides()
    slides[0]["visual_prompt"] = "Professional system visual, no axis labels, without formulas, not neon."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True


def test_deck_build_service_allows_explicitly_requested_visual_style(tmp_path: Path) -> None:
    runtime = _runtime(
        tmp_path / "outputs",
        user_request="Make a neon cyberpunk pitch deck about resilient infrastructure.",
    )
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )
    slides = _slides()
    slides[0]["visual_prompt"] = "Neon cyberpunk infrastructure command center with cinematic lighting."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True


def test_deck_build_service_allows_style_profile_visual_style(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )
    slides = _slides()
    slides[0]["visual_prompt"] = "Handwritten sketch of the system rollout with marker-like strokes."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        style_profile={"visual_style": "handwritten_sketch"},
        creative_plan=_creative_plan(),
    )

    assert result.success is True


def test_deck_build_service_sanitizes_positive_banned_visual_prompt_terms(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    batch_called = False

    def batch_runner(_manifest_path, _runtime):
        nonlocal batch_called
        batch_called = True
        return {}

    service = DeckBuildService(image_batch_runner=batch_runner, native_service=_FakeNativeService())
    slides = _slides(include_asset=False)
    slides[0]["visual_prompt"] = "Neon cyberpunk system diagram with dramatic lighting."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(include_asset=False),
    )

    assert result.success is True
    assert result.expected_visual_count == 0
    assert result.image_generation_status == "not_required"
    assert batch_called is False


def test_deck_build_service_missing_batch_summary_fails_without_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    native_calls: list[dict] = []
    single_called = False

    def single_runner(_slide, _runtime, _attempt_no):
        nonlocal single_called
        single_called = True
        return {"success": False, "error_class": "should_not_run"}

    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: {"summary_present": False, "complete": False},
        image_single_runner=single_runner,
        native_service=_FakeNativeService(native_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_visual_batch_startup_failed"
    assert single_called is False
    assert native_calls == []
    assert (tmp_path / "outputs" / "slides" / "01-cover.html").exists()


def test_deck_build_service_salvages_partial_timeout_and_repairs_missing_visual(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    native_calls: list[dict] = []
    repaired: list[int] = []

    def timeout_batch(manifest_path: str, tool_runtime) -> dict:
        manifest_host = Path(replace_virtual_path(manifest_path, tool_runtime.state["thread_data"]))
        manifest = json.loads(manifest_host.read_text(encoding="utf-8"))
        progress = []
        for index, item in enumerate(manifest["items"], start=1):
            if index == 1:
                continue
            output_file = item["output_file"]
            host = Path(replace_virtual_path(output_file, tool_runtime.state["thread_data"]))
            host.parent.mkdir(parents=True, exist_ok=True)
            host.write_bytes(b"png")
            progress.append({"item_index": index, "output_file": output_file, "success": True, "bytes": 3})
        return {
            "summary_present": False,
            "complete": False,
            "exit_code": 124,
            "error_class": "timeout",
            "items": progress,
        }

    def single_runner(slide, tool_runtime, attempt_no: int) -> dict:
        assert attempt_no == 1
        repaired.append(slide.index)
        host = Path(replace_virtual_path(slide.visual_asset_path, tool_runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"png")
        return {"success": True, "bytes": 3}

    service = DeckBuildService(
        image_batch_runner=timeout_batch,
        image_single_runner=single_runner,
        native_service=_FakeNativeService(native_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert repaired == [1]
    assert result.successful_visual_count == 1
    assert result.image_generation_status == "success_after_repair"
    assert result.primary_image_batch_status == "repaired"
    assert result.serial_repair_count == 1
    assert result.batch_timeout_count == 1
    assert result.partial_batch_salvaged is False
    assert native_calls


def test_deck_build_service_timeout_with_zero_outputs_repairs_selected_assets(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    repaired: list[int] = []

    def single_runner(slide, tool_runtime, attempt_no: int) -> dict:
        assert attempt_no == 1
        repaired.append(slide.index)
        host = Path(replace_virtual_path(slide.visual_asset_path, tool_runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"png")
        return {"success": True, "bytes": 3}

    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: {
            "summary_present": False,
            "complete": False,
            "exit_code": 124,
            "error_class": "timeout",
            "items": [],
        },
        image_single_runner=single_runner,
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert repaired == [1]
    assert result.successful_visual_count == 1
    assert result.image_generation_status == "success_after_repair"
    assert result.serial_repair_count == 1
    assert result.partial_batch_salvaged is False


def test_deck_image_batch_timeout_scales_by_manifest_count_and_concurrency(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    manifest_host = tmp_path / "outputs" / "assets" / "slide-visuals.manifest.json"
    manifest_host.parent.mkdir(parents=True)
    manifest_host.write_text(
        json.dumps({"items": [{"output_file": f"{_OUTPUTS}assets/slide-{index:02d}.png"} for index in range(1, 31)]}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOPHIA_IMAGE_GEN_TIMEOUT", "240")
    monkeypatch.delenv("SOPHIA_IMAGE_GEN_MAX_RETRIES", raising=False)
    monkeypatch.setenv("SOPHIA_IMAGE_GEN_CONCURRENCY", "2")
    monkeypatch.delenv("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT", raising=False)

    timeout = deck_service._deck_image_batch_timeout_seconds(f"{_OUTPUTS}assets/slide-visuals.manifest.json", runtime)

    assert timeout == 7260


def test_deck_image_batch_timeout_override_wins(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    monkeypatch.setenv("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT", "999")

    timeout = deck_service._deck_image_batch_timeout_seconds(f"{_OUTPUTS}missing.manifest.json", runtime)

    assert timeout == 999


def test_deck_image_batch_subprocess_timeout_is_structured(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    script = tmp_path / "generate.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    manifest_host = tmp_path / "outputs" / "assets" / "slide-visuals.manifest.json"
    manifest_host.parent.mkdir(parents=True)
    manifest_host.write_text(json.dumps({"items": [{"output_file": f"{_OUTPUTS}assets/slide-01.png"}]}), encoding="utf-8")
    monkeypatch.setattr(deck_service, "_image_script_path", lambda: script)

    def timeout_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd=["python"], timeout=10, output="partial stdout", stderr="provider hung")

    monkeypatch.setattr(deck_service.subprocess, "run", timeout_run)

    result = DeckBuildService()._run_image_batch_subprocess(f"{_OUTPUTS}assets/slide-visuals.manifest.json", runtime)

    assert result["summary_present"] is False
    assert result["complete"] is False
    assert result["exit_code"] == 124
    assert result["error_class"] == "timeout"
    assert "timed out" in result["raw_error_excerpt"]


def test_deck_image_batch_timeout_is_capped_by_shared_deadline(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_deadline_epoch_ms"] = 111_000
    monkeypatch.setattr(deck_service.time, "time", lambda: 1.0)
    manifest_host = tmp_path / "outputs" / "assets" / "slide-visuals.manifest.json"
    manifest_host.parent.mkdir(parents=True, exist_ok=True)
    manifest_host.write_text(
        json.dumps({"items": [{"output_file": f"{_OUTPUTS}assets/slide-01.png"}]}),
        encoding="utf-8",
    )

    timeout = deck_service._deck_image_batch_timeout_seconds(
        f"{_OUTPUTS}assets/slide-visuals.manifest.json",
        runtime,
    )

    assert timeout == 20


def test_expired_shared_deadline_returns_non_retryable_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_deadline_epoch_ms"] = 1_000
    monkeypatch.setattr(deck_service.time, "time", lambda: 2.0)

    result = DeckBuildService().prepare_and_build(
        runtime=runtime,
        deck_title="Deadline",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_deadline_exceeded"
    assert result.retryable is False


def test_deck_build_service_incomplete_visuals_fail_before_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    native_calls: list[dict] = []
    repair_attempts: list[tuple[int, int]] = []

    def single_runner(slide, _runtime, attempt_no: int) -> dict:
        repair_attempts.append((slide.index, attempt_no))
        return {"success": False, "error_class": "timeout"}

    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime, create_outputs=False, complete=False),
        image_single_runner=single_runner,
        native_service=_FakeNativeService(native_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_visuals_incomplete"
    assert result.successful_visual_count == 0
    assert result.missing_visual_count == 1
    assert result.serial_repair_count == 2
    assert repair_attempts == [(1, 1), (1, 2)]
    assert native_calls == []


def test_deck_build_service_terminal_provider_error_does_not_unlock_serial_repair(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    single_called = False

    def single_runner(_slide, _runtime, _attempt_no):
        nonlocal single_called
        single_called = True
        return {"success": False, "error_class": "should_not_run"}

    def auth_batch(manifest_path: str, tool_runtime) -> dict:
        manifest_host = Path(replace_virtual_path(manifest_path, tool_runtime.state["thread_data"]))
        manifest = json.loads(manifest_host.read_text(encoding="utf-8"))
        return {
            "summary_present": True,
            "complete": False,
            "requested": len(manifest["items"]),
            "images_generated": 0,
            "failed": len(manifest["items"]),
            "items": [{"output_file": item["output_file"], "success": False, "error_class": "auth_invalid"} for item in manifest["items"]],
            "error_class_histogram": {"auth_invalid": len(manifest["items"])},
        }

    service = DeckBuildService(
        image_batch_runner=auth_batch,
        image_single_runner=single_runner,
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.failure_code == "deck_visuals_incomplete"
    assert result.image_generation_status == "failed"
    assert result.image_generation_reason == "auth_invalid"
    assert result.serial_repair_count == 0
    assert single_called is False


def test_deck_build_service_text_only_requires_explicit_request_and_compiles_without_visuals(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs", user_request="Please build a plain text-only 3 slide deck with no visuals.")
    native_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: (_ for _ in ()).throw(AssertionError("no image batch")),
        native_service=_FakeNativeService(native_calls),
    )
    slides = _slides(include_asset=False)
    for slide in slides:
        slide["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Text Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(include_asset=False),
    )

    assert result.success is True
    assert result.expected_visual_count == 0
    assert result.successful_visual_count == 0
    assert result.image_generation_status == "not_required"
    assert native_calls
    assert not (tmp_path / "outputs" / "assets" / "prompts").exists()
    cover_html = (tmp_path / "outputs" / "slides" / "01-cover.html").read_text(encoding="utf-8")
    assert "<img" not in cover_html
    assert 'data-deck-id="title-1"' in cover_html
    assert ">Slide 1 System Story</h1>" in cover_html
    assert 'class="diagram"' in cover_html


def test_deck_build_service_text_only_accepts_delegated_task_brief(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs", user_request="")
    runtime.state["delegation_context"] = {"task": "Build a plain text-only deck with no images for the review."}
    native_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: (_ for _ in ()).throw(AssertionError("no image batch")),
        native_service=_FakeNativeService(native_calls),
    )
    slides = _slides(include_asset=False)
    for slide in slides:
        slide["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Text Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        visual_policy="text_only",
        creative_plan=_creative_plan(include_asset=False),
    )

    assert result.success is True
    assert native_calls
    assert not (tmp_path / "outputs" / "assets" / "prompts").exists()


def test_prepare_deck_build_tool_schema_excludes_runtime() -> None:
    schema = prepare_deck_build.tool_call_schema.model_json_schema()

    properties = schema.get("properties", {})
    assert "runtime" not in properties
    assert {"deck_title", "slides", "output_path", "register", "visual_policy"}.issubset(properties)
    assert "creative_plan" in schema.get("required", [])
    composition_schema = schema["$defs"]["DeckSlideCompositionInput"]
    assert set(composition_schema["required"]) == {
        "selector",
        "slide_role",
        "headline_intent",
        "layout_name",
        "composition_rationale",
        "native_elements",
        "image_asset_ids",
        "required_element_ids",
        "structural_fingerprint",
    }


def test_creative_plan_tool_contract_normalizes_only_direct_aliases() -> None:
    payload = _creative_plan(include_asset=False)
    composition = payload["slide_compositions"][0]
    composition["slide"] = 1
    composition["role"] = composition.pop("slide_role")
    composition["layout"] = composition.pop("layout_name")
    composition.pop("selector")

    parsed = DeckCreativePlanInput.model_validate(payload)
    normalized = parsed.slide_compositions[0]

    assert normalized.selector == "slide:1"
    assert normalized.slide_role == "cover"
    assert normalized.layout_name == "cover_with_texture"
    assert normalized.headline_intent == "Explain slide 1"


def test_creative_plan_validation_reports_indexed_nested_path(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    plan = _creative_plan(include_asset=False)
    plan["slide_compositions"][0].pop("headline_intent")

    result = DeckBuildService(native_service=_FakeNativeService()).prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(include_asset=False),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=plan,
    )

    assert result.success is False
    assert result.failure_code == "deck_creative_plan_invalid"
    assert result.failure_summary == "creative_plan.slide_compositions[0].headline_intent is required"


def test_presentation_toolset_uses_prepare_deck_build_by_default(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)

    names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("presentation", vision_enabled=False)]

    assert deck_build_service_enabled() is True
    assert "prepare_deck_build" in names
    assert "prepare_pptx_image_manifest" not in names
    assert "build_deck_from_slides" not in names


def test_presentation_toolset_uses_legacy_only_when_explicitly_disabled(monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")
    monkeypatch.setenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", "true")

    tools = build_builder_tools_for_task_type("presentation", vision_enabled=False)
    names = [getattr(tool, "name", "") for tool in tools]
    contract = assert_deck_tool_contract(tools, task_type="presentation", artifact_target_ext=".pptx")

    assert deck_build_service_enabled() is False
    assert contract is not None
    assert contract["route"] == "legacy_html_slide_to_pptx"
    assert "prepare_deck_build" not in names
    assert "prepare_pptx_image_manifest" in names
    assert "build_deck_from_slides" in names


def test_presentation_toolset_ignores_disabled_flag_without_debug(monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")
    monkeypatch.delenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", raising=False)

    names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("presentation", vision_enabled=False)]

    assert deck_build_service_enabled() is True
    assert "prepare_deck_build" in names
    assert "build_deck_from_slides" not in names


def test_presentation_toolset_forces_deck_service_in_production(monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")
    monkeypatch.setenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", "true")
    monkeypatch.setenv("RENDER", "true")

    names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("presentation", vision_enabled=False)]

    assert deck_build_service_enabled() is True
    assert "prepare_deck_build" in names
    assert "build_deck_from_slides" not in names


def test_pdf_slide_deck_uses_pdf_report_route_even_when_deck_service_default_enabled(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)

    tools = build_builder_tools_for_task_type(
        "presentation",
        vision_enabled=False,
        artifact_target_ext=".pdf",
    )
    names = [getattr(tool, "name", "") for tool in tools]
    contract = assert_deck_tool_contract(tools, task_type="presentation", artifact_target_ext=".pdf")

    assert contract is None
    assert "prepare_deck_build" not in names
    assert "prepare_pptx_image_manifest" not in names
    assert "build_deck_from_slides" not in names
    assert "render_html_to_pdf" in names


def test_pdf_slide_deck_legacy_tools_are_not_rejected_by_deck_service_guard(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)
    state = {
        "builder_artifact_target_path": f"{_OUTPUTS}deck.pdf",
        "delegation_context": {"task_type": "presentation"},
    }
    request = SimpleNamespace(
        tool_call={
            "id": "tc-manifest",
            "name": "prepare_pptx_image_manifest",
            "args": {"prompt_files": [f"{_OUTPUTS}assets/prompts/slide-01.json"]},
        },
        state=state,
        runtime=SimpleNamespace(context={}, config={}),
    )

    assert BuilderArtifactMiddleware._deck_build_service_legacy_tool_rejection(request) is None


def test_prepare_deck_build_failure_is_terminal_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    runtime = _runtime(tmp_path / "outputs")
    request = SimpleNamespace(
        tool_call={"id": "tc-deck", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    payload = {
        "success": False,
        "build_id": "deck-1",
        "deck_build_path": f"{_OUTPUTS}deck_build/build.json",
        "failure_code": "deck_visual_batch_startup_failed",
        "failure_summary": "Image batch did not emit IMAGEGEN_BATCH.",
        "retryable": False,
        "slide_count": 3,
        "expected_visual_count": 3,
        "successful_visual_count": 0,
        "referenced_visual_count": 0,
        "missing_visual_count": 3,
        "quality_status": "failed",
    }
    result = ToolMessage(content=json.dumps(payload), tool_call_id="tc-deck", name="prepare_deck_build")
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    assert command.update["builder_result"]["artifact_path"] is None
    assert command.update["builder_result"]["failure_code"] == "deck_visual_batch_startup_failed"
    diagnostics = command.update["builder_pptx_diagnostics"]
    assert diagnostics["deck_build_id"] == "deck-1"
    assert diagnostics["missing_expected_visual_count"] == 3


def test_prepare_deck_build_retryable_ir_failure_uses_normal_graph_edge(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    runtime = _runtime(tmp_path / "outputs")
    request = SimpleNamespace(
        tool_call={"id": "tc-deck", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    payload = {
        "success": False,
        "build_id": "deck-1",
        "deck_build_path": f"{_OUTPUTS}deck_build/build.json",
        "failure_code": "invalid_deck_ir",
        "failure_summary": "Slide 2 narrative is required and must be <= 280 chars.",
        "retryable": True,
        "slide_count": 0,
        "expected_visual_count": 0,
        "successful_visual_count": 0,
        "referenced_visual_count": 0,
        "missing_visual_count": 0,
        "quality_status": "failed",
    }
    result = ToolMessage(content=json.dumps(payload), tool_call_id="tc-deck", name="prepare_deck_build")

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert not command.goto
    assert command.update["builder_deck_ir_repair_attempt_count"] == 1
    assert command.update["builder_last_deck_ir_failure"]["failure_code"] == "invalid_deck_ir"
    assert command.update["messages"] == [result]
    assert command.update["builder_deck_prepare_phase"] == "retry_pending"
    assert "prepare_deck_build exactly once more" in command.update["builder_deck_prepare_repair_message"]

    state = {**runtime.state, **command.update}
    repair_update = BuilderArtifactMiddleware().before_model(state, runtime)
    assert repair_update is not None
    assert "prepare_deck_build exactly once more" in repair_update["messages"][0].content


def test_prepare_deck_build_retryable_ir_second_failure_is_terminal(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_deck_ir_repair_attempt_count"] = 1
    request = SimpleNamespace(
        tool_call={"id": "tc-deck", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    payload = {
        "success": False,
        "build_id": "deck-1",
        "deck_build_path": f"{_OUTPUTS}deck_build/build.json",
        "failure_code": "invalid_deck_ir",
        "failure_summary": "Slide 2 narrative is required and must be <= 280 chars.",
        "retryable": True,
        "slide_count": 0,
        "expected_visual_count": 0,
        "successful_visual_count": 0,
        "referenced_visual_count": 0,
        "missing_visual_count": 0,
        "quality_status": "failed",
    }
    result = ToolMessage(content=json.dumps(payload), tool_call_id="tc-deck", name="prepare_deck_build")
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    assert command.update["builder_result"]["failure_code"] == "invalid_deck_ir"


def test_prepare_deck_build_schema_failure_gets_one_bounded_retry(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_pptx_diagnostics"] = {"prepare_emitted_call_count": 1, "prepare_call_count": 1}
    request = SimpleNamespace(
        tool_call={"id": "tc-schema-1", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    result = ToolMessage(
        content="creative_plan.slide_compositions.0.headline_intent: Field required",
        tool_call_id="tc-schema-1",
        name="prepare_deck_build",
        status="error",
    )

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert not command.goto
    assert command.update["builder_deck_prepare_phase"] == "retry_pending"
    diagnostics = command.update["builder_pptx_diagnostics"]
    assert diagnostics["prepare_schema_failure_count"] == 1
    assert diagnostics["prepare_result_count"] == 1
    assert "prepare_service_call_count" not in diagnostics
    assert diagnostics["deck_root_failure_code"] == "deck_prepare_argument_invalid"


def test_prepare_deck_build_execution_error_is_terminal_without_repair(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_pptx_diagnostics"] = {
        "prepare_emitted_call_count": 1,
        "prepare_call_count": 1,
    }
    request = SimpleNamespace(
        tool_call={"id": "tc-runtime", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    result = ToolMessage(
        content="The authoritative deck build tool failed during execution.",
        tool_call_id="tc-runtime",
        name="prepare_deck_build",
        status="error",
        additional_kwargs={
            "tool_error": {
                "error_class": "TypeError",
                "retryable": False,
                "stage": "tool_execution",
            }
        },
    )
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    assert command.update["builder_deck_prepare_phase"] == "terminal"
    assert command.update["builder_result"]["failure_code"] == "deck_prepare_execution_error"
    diagnostics = command.update["builder_pptx_diagnostics"]
    assert diagnostics["prepare_execution_count"] == 1
    assert diagnostics["prepare_result_count"] == 1
    assert "prepare_schema_failure_count" not in diagnostics


def test_prepare_deck_build_second_schema_failure_preserves_root_cause(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_pptx_diagnostics"] = {
        "prepare_emitted_call_count": 2,
        "prepare_call_count": 2,
        "prepare_result_count": 1,
        "prepare_schema_failure_count": 1,
        "deck_root_failure_code": "deck_prepare_argument_invalid",
        "deck_root_failure_summary": "The first call omitted headline_intent.",
    }
    request = SimpleNamespace(
        tool_call={"id": "tc-schema-2", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    result = ToolMessage(
        content="creative_plan.slide_compositions.0.layout_name: Field required",
        tool_call_id="tc-schema-2",
        name="prepare_deck_build",
        status="error",
    )
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    artifact = command.update["builder_result"]
    assert artifact["failure_code"] == "deck_prepare_retry_exhausted"
    assert artifact["root_failure_code"] == "deck_prepare_argument_invalid"
    assert artifact["root_failure_summary"] == "The first call omitted headline_intent."


def test_third_prepare_call_is_rejected_before_service_execution(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["builder_pptx_diagnostics"] = {
        "prepare_emitted_call_count": 3,
        "prepare_call_count": 3,
        "prepare_service_result_count": 2,
        "deck_root_failure_code": "deck_creative_plan_invalid",
        "deck_root_failure_summary": "The first plan failed critique validation.",
    }
    request = SimpleNamespace(
        tool_call={"id": "tc-third", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_exhausted_command(request)

    assert command is not None
    assert command.goto == "end"
    assert command.update["builder_result"]["failure_code"] == "deck_prepare_retry_exhausted"
    assert command.update["builder_result"]["root_failure_code"] == "deck_creative_plan_invalid"
    assert "prepare_call_count" not in command.update["builder_pptx_diagnostics"]


def test_parallel_prepare_calls_are_rejected_before_service_execution(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    calls = [
        {"id": "tc-parallel-1", "name": "prepare_deck_build", "args": {}},
        {"id": "tc-parallel-2", "name": "prepare_deck_build", "args": {}},
    ]
    update = BuilderArtifactMiddleware._prepare_call_after_model_update(runtime.state, calls)
    runtime.state.update(update)
    request = SimpleNamespace(
        tool_call=calls[0],
        state=runtime.state,
        runtime=runtime,
    )
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_exhausted_command(request)

    assert command is not None
    assert command.goto == "end"
    artifact = command.update["builder_result"]
    assert artifact["failure_code"] == "deck_prepare_parallel_calls_forbidden"
    assert artifact["root_failure_code"] == "deck_prepare_parallel_calls_forbidden"
    assert artifact["prepare_parallel_call_count"] == 2
    assert artifact.get("prepare_service_call_count") is None


def test_pptx_terminal_outcome_prefers_deck_failure_payload_counts(monkeypatch) -> None:
    captured: dict[str, dict] = {}

    def capture_span(name: str, **kwargs):
        captured["name"] = name
        captured.update(kwargs)

    monkeypatch.setattr(builder_artifact_module, "_safe_langsmith_span", capture_span)
    state = {
        "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
        "builder_pptx_requested_slide_count": 6,
        "builder_pptx_diagnostics": {
            "expected_generated_visual_count": 6,
            "successful_generated_visual_count": 0,
            "referenced_visual_count": 0,
            "missing_expected_visual_count": 6,
            "image_generation_status": "failed",
        },
    }
    artifact = {
        "artifact_path": None,
        "deck_route": "deck_ir_html_raster",
        "deck_compile_mode": "native_html2patch",
        "native_editability_score": 1.0,
        "native_text_shape_count": 12,
        "picture_shape_count": 6,
        "full_slide_picture_count": 1,
        "image_generation_status": "partial",
        "successful_generated_visual_count": 6,
        "referenced_visual_count": 6,
        "missing_expected_visual_count": 0,
        "quality_warning": "native_full_bleed_picture_present",
    }

    builder_artifact_module._trace_pptx_terminal_outcome(
        state=state,
        artifact=artifact,
        status="error",
        failure_code="deck_native_full_slide_picture_forbidden",
    )

    outputs = captured["outputs"]
    assert outputs["image_generation_status"] == "partial"
    assert outputs["successful_generated_visual_count"] == 6
    assert outputs["referenced_visual_count"] == 6
    assert outputs["missing_expected_visual_count"] == 0
    assert outputs["native_editability_score"] == 1.0


def test_prepare_deck_build_missing_success_output_is_terminal_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    runtime = _runtime(tmp_path / "outputs")
    request = SimpleNamespace(
        tool_call={"id": "tc-deck", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    payload = {
        "success": True,
        "build_id": "deck-1",
        "deck_build_path": f"{_OUTPUTS}deck_build/build.json",
        "pptx_path": f"{_OUTPUTS}missing-deck.pptx",
        "slide_count": 3,
        "expected_visual_count": 3,
        "successful_visual_count": 3,
        "referenced_visual_count": 3,
        "missing_visual_count": 0,
        "quality_status": "passed",
    }
    result = ToolMessage(content=json.dumps(payload), tool_call_id="tc-deck", name="prepare_deck_build")
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    assert command.update["builder_result"]["artifact_path"] is None
    assert command.update["builder_result"]["failure_code"] == "missing_output"
    diagnostics = command.update["builder_pptx_diagnostics"]
    assert diagnostics["deck_status"] == "failed_terminal"
    assert diagnostics["deck_failure_code"] == "missing_output"
    assert diagnostics["pptx_generator_success_count"] == 0
