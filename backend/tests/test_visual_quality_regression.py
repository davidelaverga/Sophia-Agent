from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

from deerflow.agents.sophia_agent.builder_tools import build_builder_tools_for_task_type
from deerflow.agents.sophia_agent.middlewares import builder_artifact as builder_artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _USER_SURFACE_ARTIFACT_FILE_ROLES,
    BuilderArtifactMiddleware,
    _artifact_file_entries,
    _artifact_file_paths_for_roles,
    _deck_plan_validation_problems,
    _presentation_completion_ready,
    _report_visual_grammar_problems,
    _unmet_conditions_from_state,
    _validate_deck_plan,
    _visual_grammar_counts,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import _slide_count_target
from deerflow.sophia.builder_memory_filter import filter_builder_memory_snippets

_FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name: str) -> dict:
    return json.loads((_FIXTURES / name).read_text(encoding="utf-8"))


def _pptx_state(tmp_path: Path, *, qc_results: list[dict]) -> dict:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"fake-pptx")
    return {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_diagnostics": {
            "pptx_generator_success_count": 1,
            "pptx_generator_slide_count": 4,
            "pptx_plan_slide_count": 4,
            "pptx_generator_picture_count": 4,
            "pptx_output_paths": ["/mnt/user-data/outputs/deck.pptx"],
            "pptx_plan_json": _fixture("canonical_image_forward_deck.json"),
            "qc_results": qc_results,
        },
    }


def _presence_qc(index: int, *, ok: bool = True) -> dict:
    return {
        "pass": ok,
        "presence_pass": ok,
        "title_present": ok,
        "caption_present": ok,
        "presence_reasons": [] if ok else ["Required title text was not detected in the top title band"],
        "reasons": [] if ok else ["Required title text was not detected in the top title band"],
        "image_path": f"/mnt/user-data/outputs/slide-{index}.png",
    }


def test_image_forward_compiler_does_not_add_native_title_or_caption_overlays() -> None:
    source = (
        Path(__file__).parents[1]
        / "packages/harness/deerflow/sophia/js/compile_pptx.mjs"
    ).read_text(encoding="utf-8")

    assert "addImageForwardTitleOverlay" not in source
    assert "addCaptionBand" not in source
    assert "rendererForSlideType" not in source
    assert "function slideType" not in source
    assert "addText(" not in source
    assert "renderImageForward" in source


def test_canonical_deck_plan_passes_structural_validation_without_treatment_gate() -> None:
    plan = _fixture("canonical_image_forward_deck.json")
    diagnostics = {
        "qc_results": [_presence_qc(index) for index in range(1, 5)],
    }

    assert not hasattr(builder_artifact_module, "_deck_treatment_problems")
    assert not hasattr(builder_artifact_module, "_presentation_qc_clean_or_advisory_only")
    assert _validate_deck_plan(plan, diagnostics) == []


def test_pptx_terminal_latch_accepts_valid_deck_without_preview(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(tmp_path, qc_results=[_presence_qc(index) for index in range(1, 5)])

    assert _presentation_completion_ready(state) is True
    assert state["builder_presentation_terminal_ready"] is True


def test_pptx_terminal_latch_ignores_native_scratch_base(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(tmp_path, qc_results=[_presence_qc(index) for index in range(1, 5)])
    outputs = Path(state["thread_data"]["outputs_path"])
    (outputs / "deck.pptx").unlink()
    scratch = outputs / ".builder" / "deck_native"
    scratch.mkdir(parents=True)
    (scratch / "base.pptx").write_bytes(b"valid-looking-scratch")
    state["builder_pptx_diagnostics"]["pptx_output_paths"] = [
        "/mnt/user-data/outputs/.builder/deck_native/base.pptx"
    ]

    assert _presentation_completion_ready(state) is False
    assert "builder_presentation_terminal_ready" not in state


def test_pptx_terminal_latch_ignores_stale_baked_title_qc(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(
        tmp_path,
        qc_results=[_presence_qc(1), _presence_qc(2, ok=False), _presence_qc(3), _presence_qc(4)],
    )

    assert _presentation_completion_ready(state) is True
    assert state["builder_presentation_terminal_ready"] is True


def test_pptx_slide_count_repair_is_injected_before_latch_accepts(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(tmp_path, qc_results=[])
    state["delegation_context"] = {"task": "Create a 6-slide technical presentation."}
    state["builder_pptx_requested_slide_count"] = 6

    assert _presentation_completion_ready(state) is False

    update = BuilderArtifactMiddleware().before_model(state, None)

    assert update is not None
    assert update["builder_pptx_slide_count_repair_requested"] == {
        "requested_slide_count": 6,
        "generated_slide_count": 4,
    }
    assert update["builder_pptx_slide_count_repair_pending"] is True
    assert update["builder_pptx_slide_count_repair_directive_emitted"] is True
    assert "exactly 6 total slides" in update["messages"][0].content
    assert "it has 4 slides" in update["messages"][0].content

    state.update({key: value for key, value in update.items() if key != "messages"})
    assert _presentation_completion_ready(state) is False
    state.update({
        "builder_pptx_slide_count_repair_pending": False,
        "builder_pptx_slide_count_repair_attempted": True,
    })
    assert _presentation_completion_ready(state) is True
    assert state["builder_presentation_terminal_ready"] is True


def test_deck_plan_gate_only_blocks_zero_embedded_pictures() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation", "task": "Create a visual presentation"},
        "builder_pptx_diagnostics": {
            "pptx_generator_success_count": 1,
            "pptx_generator_slide_count": 4,
            "pptx_generator_picture_count": 4,
            "pptx_plan_json": {
                "slides": [
                    {"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png"},
                    {"type": "content", "title": "Flow", "image_path": "/mnt/user-data/outputs/slide-2.png"},
                    {"type": "content", "title": "Evidence", "image_path": "/mnt/user-data/outputs/slide-3.png"},
                    {"type": "summary", "title": "Close", "image_path": "/mnt/user-data/outputs/slide-4.png"},
                ]
            },
            "qc_results": [{"pass": False, "presence_pass": False, "reasons": ["stale QC"]}],
        },
    }

    assert _deck_plan_validation_problems(state) == []

    state["builder_pptx_diagnostics"]["pptx_generator_picture_count"] = 0
    assert _deck_plan_validation_problems(state) == [
        "PPTX package contains zero embedded slide pictures."
    ]


def test_terminal_halt_suppresses_followup_model_call() -> None:
    middleware = BuilderArtifactMiddleware()
    request = SimpleNamespace(
        state={"builder_graph_halted": True, "builder_terminal_halt_reason": "artifact_emitted"},
        runtime=None,
        model=object(),
        override=lambda **_kwargs: None,
    )

    def _handler(_request):  # pragma: no cover - should not be reached
        raise AssertionError("model handler should not be called after terminal halt")

    result = middleware.wrap_model_call(request, _handler)

    assert result.content.startswith("[Sophia builder stopped")
    assert not getattr(result, "tool_calls", None)


def test_pptx_picture_count_is_visual_evidence_for_image_forward_decks() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task": "Create a visual technical presentation"},
        "builder_pptx_diagnostics": {"pptx_generator_picture_count": 4},
        "builder_visual_diagnostics": {"visual_asset_success_count": 0},
    }

    assert "visuals_not_embedded" not in _unmet_conditions_from_state(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"},
        state,
    )


def test_report_visual_grammar_gate_rejects_repetitive_diagrams() -> None:
    repetitive_state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "builder_visual_diagnostics": {
            "visual_figure_records": [
                {"grammar": "graphviz_node_link", "path": "/mnt/user-data/outputs/visuals/a.png"},
                {"grammar": "graphviz_node_link", "path": "/mnt/user-data/outputs/visuals/b.png"},
                {"grammar": "graphviz_node_link", "path": "/mnt/user-data/outputs/visuals/c.png"},
                {"grammar": "sankey_flow", "path": "/mnt/user-data/outputs/visuals/d.png"},
            ]
        },
    }

    assert _visual_grammar_counts(repetitive_state) == {
        "graphviz_node_link": 3,
        "sankey_flow": 1,
    }
    assert _report_visual_grammar_problems(repetitive_state)
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        repetitive_state,
    )


def test_report_builder_uses_render_html_to_pdf_not_retired_renderers() -> None:
    tool_names = [
        getattr(tool, "name", "")
        for tool in build_builder_tools_for_task_type("document", vision_enabled=False)
    ]

    # Reports render via HTML→PDF (inline <svg>); the remote chart service and the
    # markdown→pandoc renderer are retired for reports.
    assert "render_html_to_pdf" in tool_names
    assert "generate_chart" not in tool_names
    assert "generate_report_chart" not in tool_names
    assert "render_markdown_to_pdf" not in tool_names


def test_builder_memory_filter_caps_and_removes_cross_modality_style_memories() -> None:
    snippets = [
        "User prefers dark slide decks with huge visual-only diagrams.",
        "Use precise citations for agentic RL reports.",
        "Keep executive summaries short.",
        "User likes presentation title bands in electric purple.",
        "Mention policy gradient baselines when relevant.",
        "Prefer appendix tables for ablations.",
        "This extra report memory should be clipped by the cap.",
    ]

    assert filter_builder_memory_snippets(
        snippets,
        query="Create a 10-page PDF report on agentic RL.",
        task_type="pdf",
        limit=5,
    ) == [
        "Use precise citations for agentic RL reports.",
        "Keep executive summaries short.",
        "Mention policy gradient baselines when relevant.",
        "Prefer appendix tables for ablations.",
        "This extra report memory should be clipped by the cap.",
    ]


def test_builder_memory_filter_keeps_modality_neutral_style_preferences() -> None:
    assert filter_builder_memory_snippets(
        [
            "User prefers minimalist aesthetic.",
            "User likes dark visual style.",
            "Mention policy gradient baselines when relevant.",
        ],
        query="Create a presentation on Kubernetes orchestration.",
        task_type="presentation",
        limit=5,
    ) == [
        "User prefers minimalist aesthetic.",
        "User likes dark visual style.",
        "Mention policy gradient baselines when relevant.",
    ]


def test_builder_memory_filter_removes_stale_topic_scoped_neutral_style() -> None:
    assert filter_builder_memory_snippets(
        [
            "User prefers dark visual style for fintech launches.",
            "User prefers minimalist aesthetic.",
        ],
        query="Create a presentation on Kubernetes orchestration.",
        task_type="presentation",
        limit=5,
    ) == [
        "User prefers minimalist aesthetic.",
    ]


def test_slide_count_target_is_parsed_from_output_context_only() -> None:
    assert _slide_count_target("Create a 6-slide technical presentation on LangGraph.") == 6
    assert _slide_count_target("Summarize the attached 28-slide deck as a concise presentation.") is None


def test_slide_count_target_captures_bare_slide_requests() -> None:
    # Codex P2: a build verb directly before the count is enough — the match
    # already ends in "slides", so no trailing presentation noun is required.
    assert _slide_count_target("create 5 slides about X") == 5
    assert _slide_count_target("make 6 slides") == 6
    assert _slide_count_target("write a 5-slide deck") == 5
    # ...but an incidental slide mention inside a report request must NOT capture.
    assert _slide_count_target("create a report about the 5 slides I saw") is None


def test_slide_count_target_captures_conversion_transition_context() -> None:
    assert _slide_count_target("convert this report into a 5-slide deck") == 5
    assert _slide_count_target("turn the notes into a 7 slide presentation") == 7
    assert _slide_count_target("summarize this memo as a 4-slide deck") == 4
    assert _slide_count_target("summarize the attached 28-slide deck as a concise presentation") is None


def test_slide_qc_fails_visible_prompt_scaffolding(tmp_path: Path, monkeypatch) -> None:
    script = Path(__file__).parents[2] / "skills/public/image-generation/scripts/slide_qc.py"
    spec = importlib.util.spec_from_file_location("slide_qc_under_test", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    image_file = tmp_path / "slide.png"
    image_file.write_bytes(b"not-really-an-image")
    monkeypatch.setattr(module, "_ocr_text", lambda _path: "Prompt: THE TEXT READS: [visual] caption: demo")

    reasons = module._raster_layout_reasons(image_file)

    assert any("THE TEXT READS" in reason for reason in reasons)
    assert any("caption:" in reason for reason in reasons)
    assert any("prompt:" in reason for reason in reasons)
    assert any("[visual]" in reason for reason in reasons)


def test_artifact_file_roles_surface_only_primary_and_preview() -> None:
    args = {
        "artifact_path": "/mnt/user-data/outputs/report.pdf",
        "artifact_preview_filename": "report.preview.pdf",
        "artifact_files": [
            {"path": "/mnt/user-data/outputs/report.pdf.md", "role": "source"},
            {"path": "/mnt/user-data/outputs/report.preview.pdf", "role": "preview"},
        ],
        "supporting_files": [
            "/mnt/user-data/outputs/report.pdf.md",
            "/mnt/user-data/outputs/report.preview.pdf",
        ],
    }

    entries = _artifact_file_entries(args)
    assert {entry["path"]: entry["role"] for entry in entries} == {
        "/mnt/user-data/outputs/report.pdf": "primary",
        "/mnt/user-data/outputs/report.pdf.md": "source",
        "/mnt/user-data/outputs/report.preview.pdf": "preview",
    }
    assert _artifact_file_paths_for_roles(args, _USER_SURFACE_ARTIFACT_FILE_ROLES) == [
        "/mnt/user-data/outputs/report.pdf",
        "/mnt/user-data/outputs/report.preview.pdf",
    ]


def test_explicit_primary_artifact_file_precedes_preview_artifact_path() -> None:
    args = {
        "artifact_path": "/mnt/user-data/outputs/deck.preview.pdf",
        "artifact_preview_filename": "deck.preview.pdf",
        "artifact_files": [
            {"path": "/mnt/user-data/outputs/deck.pptx", "role": "primary"},
            {"path": "/mnt/user-data/outputs/deck.preview.pdf", "role": "preview"},
        ],
    }

    entries = _artifact_file_entries(args)

    assert entries == [
        {"path": "/mnt/user-data/outputs/deck.pptx", "role": "primary"},
        {"path": "/mnt/user-data/outputs/deck.preview.pdf", "role": "preview"},
    ]
    assert _artifact_file_paths_for_roles(args, _USER_SURFACE_ARTIFACT_FILE_ROLES) == [
        "/mnt/user-data/outputs/deck.pptx",
        "/mnt/user-data/outputs/deck.preview.pdf",
    ]
