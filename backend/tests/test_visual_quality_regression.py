from __future__ import annotations

import json
from pathlib import Path

from deerflow.agents.sophia_agent.middlewares import builder_artifact as builder_artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _USER_SURFACE_ARTIFACT_FILE_ROLES,
    _artifact_file_entries,
    _artifact_file_paths_for_roles,
    _presentation_completion_ready,
    _report_visual_grammar_problems,
    _unmet_conditions_from_state,
    _validate_deck_plan,
)


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
    assert "return count;\n  }\n  return count + 1 + slideBullets" in source


def test_canonical_deck_plan_passes_presence_and_treatment_variety() -> None:
    plan = _fixture("canonical_image_forward_deck.json")
    diagnostics = {
        "qc_results": [_presence_qc(index) for index in range(1, 5)],
    }

    assert _validate_deck_plan(plan, diagnostics) == []


def test_pptx_terminal_latch_accepts_valid_deck_without_preview(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(tmp_path, qc_results=[_presence_qc(index) for index in range(1, 5)])

    assert _presentation_completion_ready(state) is True
    assert state["builder_presentation_terminal_ready"] is True


def test_pptx_terminal_latch_rejects_missing_baked_title_presence(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = _pptx_state(
        tmp_path,
        qc_results=[_presence_qc(1), _presence_qc(2, ok=False), _presence_qc(3), _presence_qc(4)],
    )

    assert _presentation_completion_ready(state) is False
    assert state.get("builder_presentation_terminal_ready") is not True


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


def test_report_visual_grammar_gate_allows_varied_report_and_blocks_dominant_grammar() -> None:
    varied_state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "builder_visual_diagnostics": _fixture("canonical_report_visuals.json"),
    }
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

    assert _report_visual_grammar_problems(varied_state) == []
    assert any("50% or less" in problem for problem in _report_visual_grammar_problems(repetitive_state))


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
