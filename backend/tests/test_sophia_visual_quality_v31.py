from __future__ import annotations

from types import SimpleNamespace

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_report_figure_quality_metadata,
    _enrich_pdf_render_result_with_requested_pages,
    _repair_deck_plan_for_validation,
    _report_figure_family_problems,
    _validate_deck_plan,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(config={}, context={})


def _briefing(result: dict) -> str:
    blocks = result.get("system_prompt_blocks") or []
    return "\n".join(blocks)


def test_slide_title_strategy_repair_requires_qc_for_baked_titles() -> None:
    repaired = _repair_deck_plan_for_validation(
        {
            "slides": [
                {
                    "type": "cover",
                    "title": "Launch",
                    "title_strategy": "baked",
                    "title_baked_qc_confirmed": True,
                }
            ]
        },
        {"pptx_slide_title_results": [{"slide": 1, "title_present": False}]},
    )

    assert repaired is not None
    assert repaired["slides"][0]["title_strategy"] == "native"
    assert repaired["slides"][0]["title_baked_qc_confirmed"] is False

    repaired = _repair_deck_plan_for_validation(
        {"slides": [{"type": "cover", "title": "Launch"}]},
        {"pptx_slide_title_results": [{"slide": 1, "title_present": True}]},
    )

    assert repaired is not None
    assert repaired["slides"][0]["title_strategy"] == "baked"
    assert repaired["slides"][0]["title_baked_qc_confirmed"] is True
    assert repaired["slides"][0]["title_present"] is True


def test_deck_plan_rejects_mixed_generated_slide_styles() -> None:
    problems = _validate_deck_plan(
        {
            "slides": [
                {
                    "type": "cover",
                    "title": "Launch",
                    "image_path": "/mnt/user-data/outputs/slide-1.png",
                    "visual_style": "clean_flat_vector",
                },
                {
                    "type": "content",
                    "title": "Architecture",
                    "image_path": "/mnt/user-data/outputs/slide-2.png",
                    "visual_style": "blueprint_technical",
                },
            ]
        },
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-1.png"},
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-2.png"},
            ],
        },
    )

    assert any("Deck mixes generated image styles" in problem for problem in problems)


def test_report_figure_family_gate_blocks_once_and_marks_quality_warning() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "builder_visual_diagnostics": {
            "visual_figure_records": [
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/a.png"},
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/b.png"},
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/c.png"},
            ]
        },
    }

    assert _report_figure_family_problems(state)
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit({"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state)

    warned = _apply_report_figure_quality_metadata({"confidence": 0.95}, state)
    assert warned["quality_warning"] == "monotone_figures"
    assert warned["figure_family_warning"] is True
    assert warned["confidence"] == 0.72


def test_pdf_requested_page_target_enriches_render_result() -> None:
    enriched = _enrich_pdf_render_result_with_requested_pages(
        {
            "success": True,
            "page_count": 6,
            "layout_quality": "ok",
            "layout_warning": None,
        },
        {"builder_pdf_requested_page_count": 8},
    )

    assert enriched["requested_page_count"] == 8
    assert enriched["layout_quality"] == "warning"
    assert enriched["layout_warning"] == "page_count_off_target"


def test_builder_task_briefing_extracts_pdf_requested_pages() -> None:
    result = BuilderTaskMiddleware().before_agent(
        {
            "delegation_context": {
                "task_type": "visual_report",
                "task": "Create an 8-page technical PDF report on retrieval systems.",
                "artifact_target_path": "/mnt/user-data/outputs/retrieval-report.pdf",
                "companion_artifact": {},
            }
        },
        _runtime(),
    )

    assert result is not None
    assert result["builder_pdf_requested_page_count"] == 8
    assert "requested_pages=8" in _briefing(result)
