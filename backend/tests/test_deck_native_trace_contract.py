from __future__ import annotations

import contextlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from deerflow.sophia.deck_build import service as deck_service
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.tracing import DEFAULT_DECK_COMPILE_MODE, NATIVE_DECK_COMPILE_MODE
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
            "user_id": "user-1",
            "task_id": "task-1",
            "run_id": "run-1",
            "builder_pptx_requested_slide_count": 1,
            "delegation_context": {"request": "Build a plain text-only 1 slide deck with no visuals."},
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace),
            },
        },
        context={"thread_id": "builder-thread"},
        config={},
    )


class TraceNativeService:
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
        Path(output_path).write_bytes(b"fake pptx")
        return NativeDeckPatchResult(True, output_path, patch_path, 0, 0, [])

    def inspect(self, _pptx_path: str) -> NativeDeckInspectResult:
        return NativeDeckInspectResult(
            True,
            slide_count=1,
            shape_count=2,
            native_text_shape_count=2,
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


def test_deck_native_spans_are_aggregated_and_mark_native_compile_mode(tmp_path: Path, monkeypatch) -> None:
    spans: list[dict[str, Any]] = []

    @contextlib.contextmanager
    def capture_span(name: str, **kwargs: Any):
        record: dict[str, Any] = {"name": name, "kwargs": kwargs, "outputs": None}
        spans.append(record)

        class CapturedRun:
            def end(self, outputs: dict[str, Any]) -> None:
                record["outputs"] = outputs

        yield CapturedRun()

    monkeypatch.setattr(deck_service, "deck_span", capture_span)

    result = DeckBuildService(native_service=TraceNativeService()).prepare_and_build(
        runtime=_runtime(tmp_path / "outputs"),
        deck_title="Trace Deck",
        slides=[
            {
                "title": "Trace Deck",
                "narrative": "Native compile spans are deck-level and compact.",
                "role": "cover",
                "layout_kind": "cover_hero",
                "visual_prompt": "",
            }
        ],
        output_path=f"{_OUTPUTS}trace.pptx",
        visual_policy="text_only",
    )

    native_spans = [span for span in spans if span["name"].startswith("deck.native.")]
    native_names = [span["name"] for span in native_spans]
    assert result.success is True
    assert native_names == [
        "deck.native.requirement",
        "deck.native.html2patch",
        "deck.native.patch_apply",
        "deck.native.inspect",
        "deck.native.lint_fix",
        "deck.native.render",
        "deck.native.diff",
    ]
    requirement_span = next(span for span in native_spans if span["name"] == "deck.native.requirement")
    assert requirement_span["kwargs"]["deck_compile_mode"] == DEFAULT_DECK_COMPILE_MODE
    assert requirement_span["outputs"]["preflight_success"] is True
    assert requirement_span["outputs"]["deck_py_exists"] is True
    compile_spans = [span for span in native_spans if span["name"] != "deck.native.requirement"]
    assert all(span["kwargs"]["deck_compile_mode"] == NATIVE_DECK_COMPILE_MODE for span in compile_spans)
    inspect_output = next(span["outputs"] for span in native_spans if span["name"] == "deck.native.inspect")
    assert inspect_output["native_editability_score"] == 0.9
    assert "deck.prompt_files.write" not in [span["name"] for span in spans]
