from __future__ import annotations

from types import SimpleNamespace

from deerflow.agents.sophia_agent.middlewares import builder_artifact as builder_artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_report_figure_quality_metadata,
    _enrich_pdf_render_result_with_requested_pages,
    _pdf_layout_repair_message,
    _presentation_completion_ready,
    _repair_deck_plan_for_validation,
    _report_visual_grammar_problems,
    _validate_deck_plan,
    _visual_grammar_counts,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    BuilderTaskMiddleware,
    _pdf_page_target_updates,
)


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(config={}, context={})


def _briefing(result: dict) -> str:
    blocks = result.get("system_prompt_blocks") or []
    return "\n".join(blocks)


def test_slide_title_presence_repair_requires_qc_for_baked_titles() -> None:
    repaired = _repair_deck_plan_for_validation(
        {
            "slides": [
                {
                    "type": "cover",
                    "title": "Launch",
                    "image_path": "/mnt/user-data/outputs/slide-1.png",
                    "title_baked_qc_confirmed": True,
                }
            ]
        },
        {"pptx_slide_title_results": [{"slide": 1, "title_present": False}]},
    )

    assert repaired is not None
    assert repaired["slides"][0]["title_baked_qc_confirmed"] is False
    assert "title_strategy" not in repaired["slides"][0]

    repaired = _repair_deck_plan_for_validation(
        {"slides": [{"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png"}]},
        {"pptx_slide_title_results": [{"slide": 1, "title_present": True}]},
    )

    assert repaired is not None
    assert repaired["slides"][0]["title_baked_qc_confirmed"] is True
    assert repaired["slides"][0]["title_present"] is True
    assert "title_strategy" not in repaired["slides"][0]


def test_deck_plan_accepts_baked_title_qc_when_compiler_diagnostics_missing() -> None:
    problems = _validate_deck_plan(
        {
            "slides": [
                {
                    "type": "cover",
                    "title": "Launch",
                    "image_path": "/mnt/user-data/outputs/slide-1.png",
                    "visual_style": "clean_flat_vector",
                    "title_baked_qc_confirmed": True,
                }
            ]
        },
        {
            "qc_results": [
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-1.png"},
            ],
        },
    )

    assert problems == []


def test_deck_plan_accepts_mixed_generated_slide_styles() -> None:
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

    assert problems == []


def test_report_variety_gate_functions_are_runtime_owned() -> None:
    assert callable(_report_visual_grammar_problems)
    assert callable(_visual_grammar_counts)
    assert hasattr(BuilderArtifactMiddleware, "_report_visual_grammar_rejection_message")


def test_report_variety_rejects_repetitive_runtime_grammar() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "builder_visual_diagnostics": {
            "visual_figure_records": [
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/a.png"},
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/b.png"},
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/c.png"},
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/d.png"},
            ]
        },
    }

    assert _visual_grammar_counts(state) == {"diagram:architecture": 4}
    assert _report_visual_grammar_problems(state)
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit({"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state)

    warned = _apply_report_figure_quality_metadata({"confidence": 0.95}, state)
    assert warned["quality_warning"] == "report_visual_grammar"
    assert warned["confidence"] == 0.65


def test_report_variety_allows_mixed_grammars() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "builder_visual_diagnostics": {
            "visual_figure_records": [
                {"family": "diagram:architecture", "path": "/mnt/user-data/outputs/visuals/a.png"},
                {"family": "chart:flow", "path": "/mnt/user-data/outputs/visuals/b.png"},
                {"family": "chart:comparison", "path": "/mnt/user-data/outputs/visuals/c.png"},
                {"family": "diagram:timeline", "path": "/mnt/user-data/outputs/visuals/d.png"},
            ]
        },
    }

    assert _report_visual_grammar_problems(state) == []
    assert not BuilderArtifactMiddleware._visual_gate_blocks_emit({"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state)


def test_presentation_completion_ready_allows_advisory_qc_parse_failures(tmp_path, monkeypatch) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    pptx = outputs / "deck.pptx"
    pptx.write_bytes(b"fake-pptx")
    (outputs / "deck.preview.pdf").write_bytes(b"%PDF-1.4\n%%EOF")
    monkeypatch.setattr(builder_artifact_module, "_pptx_integrity_error_for_file", lambda _path: None)
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_diagnostics": {
            "pptx_generator_success_count": 1,
            "pptx_generator_slide_count": 2,
            "pptx_plan_slide_count": 2,
            "pptx_generator_picture_count": 2,
            "pptx_output_paths": ["/mnt/user-data/outputs/deck.pptx"],
            "pptx_plan_json": {
                "slides": [
                    {"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png"},
                    {
                        "type": "content",
                        "title": "Flow",
                        "caption": "The flow keeps every handoff explicit.",
                        "image_path": "/mnt/user-data/outputs/slide-2.png",
                    },
                ]
            },
            "qc_results": [
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-1.png"},
                {
                    "pass": False,
                    "advisory": True,
                    "parser_error": True,
                    "presence_pass": True,
                    "title_present": True,
                    "caption_present": True,
                    "reasons": ["QC reviewer returned invalid JSON"],
                    "image_path": "/mnt/user-data/outputs/slide-2.png",
                },
            ],
        },
    }

    assert _presentation_completion_ready(state) is True


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


def test_pdf_requested_page_target_prefers_state_over_tool_payload() -> None:
    enriched = _enrich_pdf_render_result_with_requested_pages(
        {
            "success": True,
            "page_count": 8,
            "requested_page_count": 8,
            "requested_min_pages": 8,
            "requested_max_pages": 8,
            "layout_quality": "ok",
            "layout_warning": None,
        },
        {"builder_pdf_requested_page_count": 2},
    )

    assert enriched["requested_page_count"] == 2
    assert "requested_min_pages" not in enriched
    assert "requested_max_pages" not in enriched
    assert enriched["layout_quality"] == "warning"
    assert enriched["layout_warning"] == "page_count_off_target"


def test_pdf_requested_page_target_clears_tolerated_renderer_warning() -> None:
    enriched = _enrich_pdf_render_result_with_requested_pages(
        {
            "success": True,
            "page_count": 11,
            "requested_page_count": 10,
            "layout_quality": "warning",
            "layout_warning": "page_count_off_target",
        },
        {"builder_pdf_requested_page_count": 10},
    )

    assert enriched["requested_page_count"] == 10
    assert enriched["layout_quality"] == "ok"
    assert enriched["layout_warning"] is None


def test_pdf_requested_page_range_prefers_state_over_tool_exact_payload() -> None:
    enriched = _enrich_pdf_render_result_with_requested_pages(
        {
            "success": True,
            "page_count": 8,
            "requested_page_count": 8,
            "layout_quality": "ok",
            "layout_warning": None,
        },
        {
            "builder_pdf_requested_min_pages": 2,
            "builder_pdf_requested_max_pages": 3,
        },
    )

    assert "requested_page_count" not in enriched
    assert enriched["requested_min_pages"] == 2
    assert enriched["requested_max_pages"] == 3
    assert enriched["layout_quality"] == "warning"
    assert enriched["layout_warning"] == "page_count_off_target"


def test_pdf_page_count_repair_expands_under_target_report() -> None:
    message = _pdf_layout_repair_message(
        {
            "success": True,
            "page_count": 6,
            "layout_quality": "warning",
            "layout_warning": "page_count_off_target",
            "blank_page_count": 0,
            "short_page_count": 0,
        },
        {"builder_pdf_requested_page_count": 8},
    )

    assert "Target length is exactly 8 pages" in message
    assert "ONE targeted edit" in message
    assert "add or expand a single section" in message
    assert "Do not pad every page" in message


def test_pdf_page_count_repair_compacts_over_target_report() -> None:
    message = _pdf_layout_repair_message(
        {
            "success": True,
            "page_count": 10,
            "layout_quality": "warning",
            "layout_warning": "page_count_off_target",
            "blank_page_count": 0,
            "short_page_count": 0,
        },
        {"builder_pdf_requested_page_count": 8},
    )

    assert "Target length is exactly 8 pages" in message
    assert "ONE targeted edit" in message
    assert "trim or merge a single thin section" in message
    assert "remove unnecessary page breaks" in message


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


def test_pdf_page_target_ignores_source_document_page_mentions() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Summarize this 12-page report as a concise PDF.",
        },
        companion_artifact={"artifact_title": "10-page source memo"},
        artifact_target_path="/mnt/user-data/outputs/summary-12-page-report.pdf",
    )

    assert updates == {}


def test_pdf_page_target_accepts_count_before_output_report_noun() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Write a 2-page report on the failed build attempts.",
        },
        companion_artifact={},
        artifact_target_path="/mnt/user-data/outputs/build-report.pdf",
    )

    assert updates["builder_pdf_requested_page_count"] == 2


def test_pdf_page_target_accepts_count_before_document_as_pdf() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Prepare a 4-page document as PDF about retrieval quality.",
        },
        companion_artifact={},
        artifact_target_path="/mnt/user-data/outputs/retrieval-quality.pdf",
    )

    assert updates["builder_pdf_requested_page_count"] == 4


def test_pdf_page_target_accepts_count_after_report_noun() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Create a PDF report in 2 pages about retrieval quality.",
        },
        companion_artifact={},
        artifact_target_path="/mnt/user-data/outputs/retrieval-quality.pdf",
    )

    assert updates["builder_pdf_requested_page_count"] == 2


def test_pdf_page_target_accepts_count_after_plain_report_noun() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Write the report in 2 pages.",
        },
        companion_artifact={},
        artifact_target_path="/mnt/user-data/outputs/report.pdf",
    )

    assert updates["builder_pdf_requested_page_count"] == 2


def test_pdf_page_target_accepts_count_after_summary_brief_and_article_nouns() -> None:
    cases = [
        ("Write a PDF summary in 2 pages about retrieval quality.", 2),
        ("Write a PDF brief in 3 pages about retrieval quality.", 3),
        ("Create a PDF article in 4 pages about retrieval quality.", 4),
    ]

    for task, expected in cases:
        updates = _pdf_page_target_updates(
            {"task_type": "pdf", "task": task},
            companion_artifact={},
            artifact_target_path="/mnt/user-data/outputs/retrieval-quality.pdf",
        )

        assert updates["builder_pdf_requested_page_count"] == expected


def test_pdf_page_target_ignores_source_n_page_pdf_compound() -> None:
    # Codex P2 (2026-06-29): "N-page PDF" introduced by a demonstrative/possessive
    # or explicit source word names the SOURCE document, not the requested length.
    # The after-PDF heuristic must not target the source count.
    source_cases = [
        "Summarize this 10-page PDF into a 2-page brief.",
        "Shorten my 9-page PDF to the key points.",
        "Condense the attached 12-page PDF for me.",
    ]
    for task in source_cases:
        updates = _pdf_page_target_updates(
            {"task_type": "pdf", "task": task},
            companion_artifact={},
            artifact_target_path="/mnt/user-data/outputs/brief.pdf",
        )
        # The source page count must never become the requested length.
        for source_count in (10, 9, 12):
            assert updates.get("builder_pdf_requested_page_count") != source_count


def test_pdf_page_target_accepts_target_count_after_source_pdf_transition() -> None:
    updates = _pdf_page_target_updates(
        {
            "task_type": "pdf",
            "task": "Summarize this 10-page PDF into a 2-page brief.",
        },
        companion_artifact={},
        artifact_target_path="/mnt/user-data/outputs/brief.pdf",
    )

    assert updates["builder_pdf_requested_page_count"] == 2


def test_pdf_page_target_still_accepts_output_n_page_pdf_compound() -> None:
    # The "N-page PDF" compound fronted by a build verb + indefinite article is a
    # genuine OUTPUT length and must still be captured (regression guard for the
    # source-context veto above).
    output_cases = [
        ("Create a 10-page PDF report on agentic RL.", 10),
        ("Generate a 6-page PDF on retrieval quality.", 6),
    ]
    for task, expected in output_cases:
        updates = _pdf_page_target_updates(
            {"task_type": "pdf", "task": task},
            companion_artifact={},
            artifact_target_path="/mnt/user-data/outputs/retrieval-quality.pdf",
        )
        assert updates["builder_pdf_requested_page_count"] == expected
