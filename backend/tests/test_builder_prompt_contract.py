from __future__ import annotations

from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sophia_prompt(name: str) -> str:
    return (_repo_root() / "skills/public/sophia" / name).read_text(encoding="utf-8")


def _skill(name: str) -> str:
    return (_repo_root() / "skills/public" / name / "SKILL.md").read_text(encoding="utf-8")


def test_retired_sophia_prompt_files_are_deleted() -> None:
    sophia_dir = _repo_root() / "skills/public/sophia"

    assert not (sophia_dir / "anti_slop.md").exists()
    assert not (sophia_dir / "artifact_instructions.md").exists()


def test_builder_obligations_are_trimmed_to_artifact_contract() -> None:
    contract = _sophia_prompt("builder_obligations.md")

    assert "Finish with `emit_builder_artifact`" in contract
    assert "requested primary artifact" in contract
    assert "HTML-slide decks" in contract
    assert "build_deck_from_slides" in contract
    assert "Do not\n  bake slide titles" in contract
    assert "full-slide image per slide" not in contract
    # PDF reports are authored as HTML and rendered via render_html_to_pdf; the
    # markdown→pandoc path and remote generate_chart are retired for reports.
    assert "render_html_to_pdf" in contract
    assert "render_markdown_to_pdf" not in contract
    assert "The HTML source and generated assets are supporting files" in contract
    assert "generate_visual_asset" not in contract
    assert "generate_report_chart" not in contract


def test_visual_composition_routes_pptx_and_pdf_to_separate_pipelines() -> None:
    directives = _sophia_prompt("visual_composition.md")

    assert "Presentations (`.pptx`) are HTML-slide image-forward decks" in directives
    assert "16:9 visual asset per slide" in directives
    assert "real HTML text" in directives
    assert "build_deck_from_slides" in directives
    assert "generated 16:9 bitmap" not in directives
    # PDF reports are authored as one self-contained HTML file with inline <svg>
    # figures and rendered via render_html_to_pdf (no remote chart service).
    assert "render_html_to_pdf" in directives
    assert "inline static" in directives
    assert "There is no alternate plain deck mode" in directives
    # Custom excalidraw tool removed AND remote generate_chart retired for reports.
    assert "generate_excalidraw_diagram" not in directives
    assert "no remote `generate_chart`" in directives
    assert "generate_visual_asset" not in directives
    assert "generate_report_chart" not in directives


def test_ppt_generation_skill_authors_html_slides() -> None:
    """Spec D Phase 0: decks are authored as slide HTML; harness converts to PPTX."""
    text = _skill("ppt-generation")

    # New HTML-slide contract.
    assert "slide HTML" in text or "HTML file per slide" in text
    assert "build_deck_from_slides" in text
    assert "slides/" in text and "assets/" in text
    assert "../assets/" in text  # relative image path convention
    assert "--slide-visual" in text
    assert '"slide_visual": true' in text
    # The model never compiles the deck.
    assert "python-pptx" in text  # appears only as a prohibition
    assert "pptxgenjs" in text
    assert "never" in text.lower() or "do not" in text.lower() or "do NOT" in text
    # Old contract retired.
    assert "Every slide is a single 16:9 image" not in text
    assert "--plan-file" not in text  # model no longer runs the compiler
    assert "generate_visual_asset" not in text
    assert "generate_report_chart" not in text


def test_ppt_generation_skeleton_demands_opaque_dark_slide() -> None:
    """White-space defense (prod 019f0b8a): the slide skeleton must paint an
    opaque dark background on html, body (not just .slide) and tell the model the
    slide must be opaque to the edges, so an uncovered region never renders white.
    """
    text = _skill("ppt-generation")
    # html, body carry the dark background, not only .slide.
    assert "html, body { margin: 0; padding: 0; background: #0e1626; }" in text
    # Explicit opaque-to-edges hard rule.
    lowered = text.lower()
    assert "opaque" in lowered
    assert "to all four edges" in lowered or "to the edges" in lowered


def test_pdf_report_skill_uses_html_and_inline_svg() -> None:
    text = _skill("pdf-report")

    # PDF reports are authored as HTML with inline <svg> figures and rendered via
    # render_html_to_pdf; markdown→pandoc and remote generate_chart are retired.
    assert "render_html_to_pdf" in text
    assert "render_markdown_to_pdf" not in text
    assert "inline" in text.lower() and "<svg>" in text
    assert "generate_excalidraw_diagram" not in text
    # generate_chart appears only in the "why not" rationale, never as guidance.
    assert "no remote `generate_chart`" in text.lower() or "not `generate_chart`" in text.lower()
    # No full-slide deck images in a report, but bounded conceptual images are allowed.
    assert "Do not use full-slide deck images" in text
    assert "conceptual" in text.lower()
    assert "generate_report_chart" not in text
    assert "generate_visual_asset" not in text
    # 2026-06-26: code-block + safe two-column + section-label guidance so the
    # model authors layouts that don't clip/collide in a fixed-width PDF.
    assert "<pre><code>" in text
    assert "cols-2" in text
    assert "section-label" in text
    assert "clipped at the page edge" in text  # QA checklist item


def test_image_generation_skill_allows_bounded_pdf_conceptual_images() -> None:
    text = _skill("image-generation")

    assert "--slide-visual" in text
    # Image-gen is now a bounded PDF path for conceptual/editorial figures only;
    # data + structure stay inline SVG in the render_html_to_pdf path.
    assert "3 conceptual/editorial" in text
    assert "render_html_to_pdf" in text
    assert "generate_chart" not in text
    assert "Do NOT bake" in text
    assert "HTML text" in text
    assert "generate_visual_asset" not in text
    assert "anti_slop.md" not in text


def test_forbidden_double_path_prompt_tokens_are_absent() -> None:
    files = [
        _repo_root() / "skills/public/ppt-generation/SKILL.md",
        _repo_root() / "skills/public/pdf-report/SKILL.md",
        _repo_root() / "skills/public/image-generation/SKILL.md",
        _repo_root() / "skills/public/chart-visualization/SKILL.md",
        _repo_root() / "skills/public/sophia/visual_composition.md",
        _repo_root() / "skills/public/sophia/builder_obligations.md",
        _repo_root() / "skills/public/sophia/companion_delegation.md",
    ]
    forbidden = (
        "generate_visual_asset",
        "generate_report_chart",
        "title_strategy",
        "native",
        "fallback",
        "text-only",
        "opt-out",
        "deterministic chart",
        "section-divider",
    )

    offenders = [
        (path.name, token)
        for path in files
        for token in forbidden
        if token in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


def test_brand_tokens_resolve_the_georgia_conflict() -> None:
    tokens = _sophia_prompt("brand/tokens.md")
    assert "Never Aptos or Georgia" in tokens
    assert "Cambria" in tokens
    assert "graphviz" in tokens


# Phase 0 §2.6 — deck steering is a single source of truth. No deck-facing
# correction message may steer the RETIRED full-slide-bitmap + slide-plan-JSON +
# ppt-generation/scripts/generate.py compiler flow. The deck failure (prod
# 2026-06-27, runs 019f0668 timeout + 019f0679 hang) was the turn-3
# `_pptx_skill_correction_message` commanding `generate.py --plan-file` while the
# improvisation backstop blocked that exact script — a deadlock with no path to
# `build_deck_from_slides`. This guard fails if any retired-flow steering returns.

# Retired-flow INSTRUCTION tokens that must never appear in a rendered deck
# correction (python-pptx / pptxgenjs are allowed only as prohibitions, so they
# are intentionally excluded from this list).
# Unambiguous RETIRED-flow instruction tokens. python-pptx / pptxgenjs / "deck
# compiler" / "slide-plan JSON" appear only as PROHIBITIONS in the new messages,
# so they are intentionally excluded (their presence is correct, not a leak).
_RETIRED_DECK_TOKENS = (
    "ppt-generation/scripts/generate.py",
    "--plan-file",
    "image_path",
    "full_bleed_image",
    "full-slide image per slide",
    "full-slide png",
    "pptx compiler",
    "embedded full-slide picture",
    "image-forward",
    "ppt-generation has been attempted",
    "ppt-generation script",
    "re-run the ppt-generation",
    "run the ppt generator",
)


def _render_deck_corrections() -> dict[str, str]:
    """Render every deck-facing correction message the harness can inject."""
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    out = "/mnt/user-data/outputs/"
    ready = {
        "builder_artifact_target_path": f"{out}deck.pptx",
        "builder_pptx_requested_slide_count": 8,
        "builder_pptx_diagnostics": {"image_generation_success_count": 8},
    }
    drifting = {
        "builder_artifact_target_path": f"{out}deck.pptx",
        "builder_pptx_diagnostics": {"image_generation_success_count": 0},
    }
    slide_count_mismatch = {
        "builder_artifact_target_path": f"{out}deck.pptx",
        "builder_pptx_requested_slide_count": 6,
        "builder_pptx_diagnostics": {
            "pptx_generator_slide_count": 8,
            "pptx_generator_picture_count": 8,
        },
    }
    zero_pictures = {
        "builder_artifact_target_path": f"{out}deck.pptx",
        "builder_pptx_diagnostics": {
            "pptx_generator_slide_count": 8,
            "pptx_generator_picture_count": 0,
            "image_generation_enabled": True,
        },
    }
    messages = {
        "compile_latch_ready": ba._pptx_compile_latch_message(ready),
        "compile_latch_drifting": ba._pptx_compile_latch_message(drifting),
        "visual_design": ba._visual_design_skill_message(),
        "deck_plan_rejection": ba.BuilderArtifactMiddleware._deck_plan_rejection_message(zero_pictures),
    }
    repair = ba._pptx_slide_count_repair_injection_update(slide_count_mismatch)
    if repair and repair.get("messages"):
        messages["slide_count_repair"] = repair["messages"][0].content
    return {k: v for k, v in messages.items() if isinstance(v, str) and v}


def test_deck_corrections_use_html_slide_flow_not_retired_compiler() -> None:
    rendered = _render_deck_corrections()
    # The canonical deck-steering message must name the HTML-slide tool + dir.
    canonical = rendered["compile_latch_ready"].lower()
    assert "build_deck_from_slides" in canonical
    assert "slides/" in canonical
    # No rendered deck correction may carry a retired-flow instruction token.
    for name, message in rendered.items():
        low = message.lower()
        for token in _RETIRED_DECK_TOKENS:
            assert token not in low, f"retired deck token {token!r} in {name} correction"


def test_retired_deck_correction_functions_are_deleted() -> None:
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    for gone in (
        "_pptx_skill_correction_message",
        "_pptx_plan_correction_message",
        "_pptx_plan_error_reason",
        "_visual_asset_required_message",
    ):
        assert not hasattr(ba, gone), f"{gone} must be deleted (Phase 0 §2.6 single source of truth)"
    assert not hasattr(
        ba.BuilderArtifactMiddleware, "_maybe_inject_pptx_plan_correction"
    ), "_maybe_inject_pptx_plan_correction must be deleted (no slide-plan JSON in the HTML flow)"


def test_pptx_emit_rejection_messages_use_html_slide_flow(monkeypatch) -> None:
    # The emit-time visual rejection paths (visual-presence + hero gates) are
    # gate-locked, so force them open and assert their pptx branch steers the
    # build_deck_from_slides HTML flow — NOT "presentation plan JSON / re-run the
    # ppt-generation script" (the live leak the 2026-06-27 review caught).
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    out = "/mnt/user-data/outputs/"
    state = {"builder_artifact_target_path": f"{out}deck.pptx"}

    monkeypatch.setattr(ba, "_visuals_requested", lambda _s: True)
    monkeypatch.setattr(ba, "_visual_presence_validated", lambda _a, _s: False)
    monkeypatch.setattr(ba, "_visual_asset_paths", lambda _s: [f"{out}assets/hero.png"])
    monkeypatch.setattr(ba, "_requested_artifact_ext", lambda _s: "pptx")
    visual_presence = ba.BuilderArtifactMiddleware._visual_presence_rejection_message({}, state)
    assert visual_presence, "visual-presence rejection should render for a pptx with unembedded assets"
    assert "build_deck_from_slides" in visual_presence
    for token in _RETIRED_DECK_TOKENS:
        assert token not in visual_presence.lower(), f"retired token {token!r} in visual-presence rejection"

    monkeypatch.setattr(ba.BuilderArtifactMiddleware, "_hero_gate_blocks_emit", classmethod(lambda _cls, _a, _s: True))
    monkeypatch.setattr(ba, "_visuals_requested", lambda _s: False)  # opens the hero guard
    hero = ba.BuilderArtifactMiddleware._hero_rejection_message({}, state)
    assert hero, "hero rejection should render when the hero gate blocks"
    for token in _RETIRED_DECK_TOKENS:
        assert token not in hero.lower(), f"retired token {token!r} in hero rejection"
