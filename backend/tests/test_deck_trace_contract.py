from __future__ import annotations

import contextlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from deerflow.sandbox.tools import replace_virtual_path
from deerflow.sophia.deck_build import service as deck_service
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.tracing import (
    DEFAULT_ARTIFACT_TARGET_EXT,
    DEFAULT_DECK_COMPILE_MODE,
    DEFAULT_DECK_ROUTE,
    NATIVE_DECK_COMPILE_MODE,
    base_metadata,
    deck_span,
    finish_span,
    stable_hash,
)
from deerflow.sophia.deck_native.models import (
    NativeDeckInspectResult,
    NativeDeckLintFixResult,
    NativeDeckPatchResult,
    NativeDeckPreflight,
    NativeDeckRenderResult,
)

_OUTPUTS = "/mnt/user-data/outputs/"


def _runtime(outputs: Path) -> SimpleNamespace:
    outputs.mkdir(parents=True, exist_ok=True)
    workspace = outputs.parent / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(
        state={
            "thread_id": "builder-thread",
            "parent_thread_id": "companion-thread",
            "user_id": "user-raw",
            "task_id": "task-1",
            "run_id": "run-1",
            "builder_pptx_requested_slide_count": 3,
            "delegation_context": {"request": "Build a visual 3 slide deck"},
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace),
            },
        },
        context={"thread_id": "builder-thread"},
        config={},
    )


def _slides() -> list[dict[str, str]]:
    slides = []
    for index, (role, layout) in enumerate(
        [
            ("cover", "cover_hero"),
            ("architecture", "single_visual_focus"),
            ("closing", "closing_summary"),
        ],
        start=1,
    ):
        title = f"Slide {index} System Story"
        narrative = "A concise technical narrative explains the point with calm professional framing."
        asset = '<img src="../assets/slide-01.png" alt="" />' if index == 1 else ""
        slides.append(
            {
                "title": title,
                "narrative": narrative,
                "role": role,
                "layout_kind": layout,
                "visual_prompt": f"Professional technical visual metaphor for slide {index}",
                "html_source": f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; margin: 0; padding: 0; background: #0A0E14; }}
body {{ overflow: hidden; color: #EEF4FB; font-family: Aptos, Arial, sans-serif; }}
.canvas {{ position: relative; width: 1920px; height: 1080px; background: #0A0E14; }}
h1 {{ position: absolute; left: 120px; top: 100px; font-size: 64px; }}
p {{ position: absolute; left: 120px; top: 820px; width: 1200px; font-size: 30px; color: #A7B4C2; }}
.panel {{ position: absolute; left: 120px; top: 300px; width: 1380px; height: 400px; border: 3px solid #38BDF8; background: #111827; }}
img {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .25; }}
</style></head><body><main class="canvas">{asset}<h1>{title}</h1><div class="panel"></div><p>{narrative}</p></main></body></html>""",
            }
        )
    return slides


def _creative_plan() -> dict[str, Any]:
    return {
        "subject": "Technical Deck",
        "audience": "technical stakeholders",
        "goal": "explain the system clearly",
        "story_arc": "Cover, architecture, closing synthesis.",
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
                {"name": "accent", "hex": "#38BDF8", "role": "linework"},
            ],
            "typography": {"display": "Aptos Display", "body": "Aptos", "utility": "Aptos"},
            "grid": {"slide_width_px": 1920, "slide_height_px": 1080},
            "signature": "dark native technical diagram language",
            "rhythm": "cover, architecture, closing",
            "anti_slop_profile": ["native text", "structural variety"],
            "requested_style_terms": ["dark_technical"],
        },
        "image_strategy": "hybrid",
        "image_assets": [
            {
                "asset_id": "cover-texture",
                "slide_selector": "slide:1",
                "role": "hero_background",
                "reason": "Atmospheric cover texture.",
                "prompt": "Dark technical abstract system texture, no readable text.",
                "aspect_ratio": "16:9",
                "integration": "full_bleed_background",
                "no_baked_text": True,
            }
        ],
        "slide_compositions": [
            {
                "selector": f"slide:{index}",
                "slide_role": role,
                "headline_intent": "Explain the slide point.",
                "layout_name": layout,
                "composition_rationale": "Native HTML structure with clear hierarchy.",
                "native_elements": ["title", "panel", "narrative"],
                "image_asset_ids": ["cover-texture"] if index == 1 else [],
            }
            for index, (role, layout) in enumerate(
                [("cover", "cover_texture"), ("architecture", "native_diagram"), ("closing", "closing_synthesis")],
                start=1,
            )
        ],
        "anti_slop_commitments": ["structural variety", "native text"],
    }


def _fake_compiler(runtime: SimpleNamespace, output_path: str, _title: str, _slides_dir: str) -> dict[str, Any]:
    host = Path(replace_virtual_path(output_path, runtime.state["thread_data"]))
    host.parent.mkdir(parents=True, exist_ok=True)
    host.write_bytes(b"fake pptx")
    return {
        "success": True,
        "pptx_path": output_path,
        "size_bytes": host.stat().st_size,
        "engine": "fake",
        "overflow_slides": [],
    }


def _fake_batch(manifest_path: str, runtime: SimpleNamespace) -> dict[str, Any]:
    manifest_host = Path(replace_virtual_path(manifest_path, runtime.state["thread_data"]))
    manifest = json.loads(manifest_host.read_text(encoding="utf-8"))
    items: list[dict[str, Any]] = []
    for item in manifest["items"]:
        output_file = item["output_file"]
        host = Path(replace_virtual_path(output_file, runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"png")
        items.append({"output_file": output_file, "success": True, "error_class": None})
    return {
        "summary_present": True,
        "complete": True,
        "requested": len(items),
        "images_generated": len(items),
        "failed": 0,
        "items": items,
        "error_class_histogram": {},
    }


class _FakeNativeService:
    def preflight(self) -> NativeDeckPreflight:
        return NativeDeckPreflight(
            success=True,
            scripts_dir_exists=True,
            deck_py_exists=True,
            html2patch_py_exists=True,
            errors=[],
        )

    def html_to_patch(self, *, html_paths: list[str], base_deck_path: str, output_patch_path: str) -> NativeDeckPatchResult:
        Path(output_patch_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_patch_path).write_text('{"ops":[]}', encoding="utf-8")
        return NativeDeckPatchResult(True, None, output_patch_path, 0, 0, [])

    def apply_patch(self, *, base_deck_path: str, patch_path: str, output_path: str, fix: bool = True) -> NativeDeckPatchResult:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"fake native pptx")
        return NativeDeckPatchResult(True, output_path, patch_path, 0, 0, [])

    def inspect(self, _pptx_path: str) -> NativeDeckInspectResult:
        return NativeDeckInspectResult(
            True,
            slide_count=3,
            shape_count=6,
            native_text_shape_count=6,
            picture_shape_count=0,
            full_slide_picture_count=0,
            native_editability_score=0.9,
            shape_inventory_path=None,
            raw_json_path=None,
            errors=[],
        )

    def lint_fix(self, *, pptx_path: str, touched_slides: list[int] | None = None) -> NativeDeckLintFixResult:
        return NativeDeckLintFixResult(True, 0, 0, 0, len(touched_slides or []), [], [])

    def render(self, *, pptx_path: str, output_dir: str, slides: list[int] | None = None) -> NativeDeckRenderResult:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        return NativeDeckRenderResult(True, output_dir, len(slides or []), [])

    def diff(self, *, before_path: str, after_path: str) -> dict[str, Any]:
        return {"success": True, "changed": True, "errors": []}


def test_base_metadata_uses_d0_contract_and_safe_identity(tmp_path: Path) -> None:
    metadata = base_metadata(
        runtime=_runtime(tmp_path / "outputs"),
        build_id="deck-123",
        visual_policy="required",
        status="planned",
        slide_count=3,
    )

    assert metadata["sophia_schema"] == "deck_trace_v2"
    assert metadata["thread_id"] == "builder-thread"
    assert metadata["session_id"] == "companion-thread"
    assert metadata["user_id_hash"] == stable_hash("user-raw")
    assert metadata["task_id"] == "task-1"
    assert metadata["run_id"] == "run-1"
    assert metadata["build_id"] == "deck-123"
    assert metadata["deck_route"] == DEFAULT_DECK_ROUTE
    assert metadata["deck_compile_mode"] == DEFAULT_DECK_COMPILE_MODE
    assert metadata["artifact_target_ext"] == DEFAULT_ARTIFACT_TARGET_EXT
    assert metadata["deck_build_id"] == "deck-123"
    assert "user-raw" not in json.dumps(metadata)


def test_deck_span_attaches_d0_metadata_to_explicit_child(tmp_path: Path, monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeRun:
        def end(self, outputs: dict[str, Any]) -> None:
            captured["outputs"] = outputs

    class FakeManager:
        def __enter__(self) -> FakeRun:
            return FakeRun()

        def __exit__(self, *_exc: object) -> None:
            captured["closed"] = True

    fake_langsmith = ModuleType("langsmith")

    def fake_trace(name: str, **kwargs: Any) -> FakeManager:
        captured["name"] = name
        captured.update(kwargs)
        return FakeManager()

    fake_langsmith.trace = fake_trace  # type: ignore[attr-defined]
    fake_run_helpers = ModuleType("langsmith.run_helpers")
    fake_run_helpers.get_current_run_tree = lambda: SimpleNamespace(dotted_order="parent-order")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langsmith", fake_langsmith)
    monkeypatch.setitem(sys.modules, "langsmith.run_helpers", fake_run_helpers)

    with deck_span(
        "deck.test.child",
        runtime=_runtime(tmp_path / "outputs"),
        build_id="deck-123",
        visual_policy="required",
        status="planned",
        slide_count=3,
    ) as run:
        finish_span(run, {"ok": True})

    metadata = captured["metadata"]
    assert captured["name"] == "deck.test.child"
    assert captured["parent"] == "parent-order"
    assert metadata["thread_id"] == "builder-thread"
    assert metadata["session_id"] == "companion-thread"
    assert metadata["build_id"] == "deck-123"
    assert metadata["deck_route"] == DEFAULT_DECK_ROUTE
    assert metadata["deck_compile_mode"] == DEFAULT_DECK_COMPILE_MODE
    assert captured["outputs"] == {"ok": True}


def test_current_image_trace_env_projects_deck_context_without_raw_user_id(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    runtime.state["current_deck_build_id"] = "deck-123"

    env = deck_service._current_image_trace_env(runtime)

    assert env["SOPHIA_THREAD_ID"] == "builder-thread"
    assert env["SOPHIA_SESSION_ID"] == "companion-thread"
    assert env["SOPHIA_TASK_ID"] == "task-1"
    assert env["SOPHIA_RUN_ID"] == "run-1"
    assert env["SOPHIA_USER_ID_HASH"] == stable_hash("user-raw")
    assert env["SOPHIA_BUILD_ID"] == "deck-123"
    assert env["SOPHIA_DECK_BUILD_ID"] == "deck-123"
    assert env["SOPHIA_DECK_ROUTE"] == DEFAULT_DECK_ROUTE
    assert env["SOPHIA_DECK_COMPILE_MODE"] == DEFAULT_DECK_COMPILE_MODE
    assert env["SOPHIA_ARTIFACT_TARGET_EXT"] == DEFAULT_ARTIFACT_TARGET_EXT
    assert "user-raw" not in env.values()


def test_image_generation_script_maps_deck_trace_env_metadata(monkeypatch) -> None:
    script_path = (
        Path(__file__).resolve().parents[2]
        / "skills"
        / "public"
        / "image-generation"
        / "scripts"
        / "generate.py"
    )
    spec = importlib.util.spec_from_file_location("image_generation_trace_contract_test", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("SOPHIA_THREAD_ID", "builder-thread")
    monkeypatch.setenv("SOPHIA_SESSION_ID", "companion-thread")
    monkeypatch.setenv("SOPHIA_BUILD_ID", "deck-123")
    monkeypatch.setenv("SOPHIA_DECK_ROUTE", DEFAULT_DECK_ROUTE)
    monkeypatch.setenv("SOPHIA_DECK_COMPILE_MODE", DEFAULT_DECK_COMPILE_MODE)
    monkeypatch.setenv("SOPHIA_ARTIFACT_TARGET_EXT", DEFAULT_ARTIFACT_TARGET_EXT)

    metadata = module._langsmith_parent_metadata()

    assert metadata["thread_id"] == "builder-thread"
    assert metadata["session_id"] == "companion-thread"
    assert metadata["build_id"] == "deck-123"
    assert metadata["deck_route"] == DEFAULT_DECK_ROUTE
    assert metadata["deck_compile_mode"] == DEFAULT_DECK_COMPILE_MODE
    assert metadata["artifact_target_ext"] == DEFAULT_ARTIFACT_TARGET_EXT


def test_deck_service_uses_manifest_span_for_prompt_hashes_not_prompt_write_span(
    tmp_path: Path,
    monkeypatch,
) -> None:
    spans: list[dict[str, Any]] = []

    @contextlib.contextmanager
    def capture_span(name: str, **kwargs: Any):
        record: dict[str, Any] = {"name": name, "inputs": kwargs.get("inputs") or {}, "outputs": None}
        spans.append(record)

        class CapturedRun:
            def end(self, outputs: dict[str, Any]) -> None:
                record["outputs"] = outputs

        yield CapturedRun()

    monkeypatch.setattr(deck_service, "deck_span", capture_span)
    runtime = _runtime(tmp_path / "outputs")
    result = DeckBuildService(
        image_batch_runner=_fake_batch,
        native_service=_FakeNativeService(),
    ).prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    assert result.deck_route == DEFAULT_DECK_ROUTE
    assert result.deck_compile_mode == NATIVE_DECK_COMPILE_MODE
    assert result.native_editability_score == 0.9
    assert result.native_text_shape_count == 6
    assert result.full_slide_picture_count == 0
    build = json.loads((tmp_path / "outputs" / "deck_build" / "build.json").read_text(encoding="utf-8"))
    assert build["deck_route"] == DEFAULT_DECK_ROUTE
    assert build["deck_compile_mode"] == NATIVE_DECK_COMPILE_MODE
    span_names = [span["name"] for span in spans]
    assert "deck.prompt_files.write" not in span_names
    manifest_output = next(span["outputs"] for span in spans if span["name"] == "deck.image_manifest.prepare")
    assert manifest_output["prompt_count"] == 1
    assert len(manifest_output["prompt_hashes"]) == 1
    assert manifest_output["prompt_basenames"] == ["slide-01.json"]
    assert "prompts" not in manifest_output
