"""Deterministic slide-quality checks (FIX 2, 2026-06-30)."""

from __future__ import annotations

from deerflow.agents.sophia_agent.middlewares.slide_quality import (
    GraderConfig,
    SlideQualityInspector,
    SlideSignals,
    chrome_check,
    density_check,
    format_slide_quality_feedback,
    overflow_check,
    visual_contract_check,
    visual_style_check,
    QualityGap,
)

_CLEAN_SLIDE = (
    "<html><head><style>.slide{background:#0e1626}</style></head>"
    "<body><div class='slide'><h1 class='title'>Qwen as a World Model</h1>"
    "<div class='visual'><img src='../assets/01.png'></div>"
    "<p class='narrative'>A concise narrative under a hundred words.</p></div></body></html>"
)


def test_overflow_check_flags_clipped_slide():
    signals = SlideSignals(
        slide_sources=[("01.html", _CLEAN_SLIDE)],
        overflow_slides=[{"slide": 1, "overflow_px": 240}],
    )
    gaps = overflow_check(signals)
    assert len(gaps) == 1
    assert gaps[0].check == "overflow"
    assert gaps[0].slide == "01.html"
    assert "240px" in gaps[0].detail


def test_overflow_check_ignores_subpixel_overflow():
    signals = SlideSignals(slide_sources=[("01.html", _CLEAN_SLIDE)], overflow_slides=[{"slide": 1, "overflow_px": 4}])
    assert overflow_check(signals) == []


def test_chrome_check_flags_nav_and_eyebrow_and_pagefooter():
    nav = "<body><nav class='eyebrow'>A B C D</nav><h1>T</h1><footer>page 2 of 4</footer></body>"
    gaps = chrome_check(SlideSignals(slide_sources=[("02.html", nav)]))
    assert len(gaps) == 1
    detail = gaps[0].detail.lower()
    assert "chrome" in detail
    assert "nav" in detail or "footer" in detail


def test_chrome_check_flags_icon_strip_class():
    html = "<body><div class='bottom icon-strip'>x</div><h1>T</h1></body>"
    gaps = chrome_check(SlideSignals(slide_sources=[("s.html", html)]))
    assert gaps and "icon-strip" in gaps[0].detail


def test_chrome_check_passes_clean_slide():
    assert chrome_check(SlideSignals(slide_sources=[("01.html", _CLEAN_SLIDE)])) == []


def test_density_check_flags_wall_of_text():
    body = " ".join(f"word{i}" for i in range(160))
    html = f"<body><div class='slide'><p>{body}</p></div></body>"
    gaps = density_check(SlideSignals(slide_sources=[("d.html", html)]))
    assert any("dense" in g.detail for g in gaps)


def test_density_check_flags_too_many_columns():
    html = "<body><div style='display:grid;grid-template-columns:repeat(6,1fr)'>x</div></body>"
    gaps = density_check(SlideSignals(slide_sources=[("c.html", html)]))
    assert any("column" in g.detail for g in gaps)


def test_density_check_allows_three_columns_and_short_text():
    html = "<body><div style='grid-template-columns:1fr 1fr 1fr'><p>Short.</p></div></body>"
    assert density_check(SlideSignals(slide_sources=[("ok.html", html)])) == []


def test_inspector_aggregates_all_checks_and_feedback_is_actionable():
    overflowing_dense = "<body><p>" + " ".join(f"w{i}" for i in range(160)) + "</p></body>"
    signals = SlideSignals(
        slide_sources=[("01.html", overflowing_dense)],
        overflow_slides=[{"slide": 1, "overflow_px": 300}],
    )
    gaps = SlideQualityInspector().inspect(signals)
    checks = {g.check for g in gaps}
    assert "overflow" in checks and "density" in checks
    feedback = format_slide_quality_feedback(gaps)
    assert feedback.startswith("[Sophia/slide-quality]")
    assert "build_deck_from_slides" in feedback
    assert "Reuse existing good images" in feedback
    assert "01.html" in feedback


def test_inspector_clean_deck_has_no_gaps():
    signals = SlideSignals(slide_sources=[("01.html", _CLEAN_SLIDE)], overflow_slides=[])
    assert SlideQualityInspector().inspect(signals) == []


def test_grader_slot_is_off_by_default():
    inspector = SlideQualityInspector()
    assert inspector.grader is None
    # The socket exists but is inert: a disabled grader adds no gaps.
    inspector_with_disabled_grader = SlideQualityInspector(grader=GraderConfig(enabled=False))
    assert inspector_with_disabled_grader.inspect(SlideSignals(slide_sources=[("01.html", _CLEAN_SLIDE)])) == []


def test_visual_contract_check_flags_generated_text_and_banned_style():
    signals = SlideSignals(
        prompt_sources=[
            (
                "02.prompt.json",
                '{"prompt":"chalkboard system diagram. THE TEXT READS: model loop"}',
            )
        ]
    )
    gaps = visual_contract_check(signals)
    assert len(gaps) == 1
    assert gaps[0].check == "visual_contract"
    assert "chalkboard" in gaps[0].detail


def test_visual_contract_check_ignores_negated_banned_style():
    signals = SlideSignals(prompt_sources=[("ok.prompt.json", '{"prompt":"professional visual, no chalkboard style"}')])
    assert visual_contract_check(signals) == []


def test_visual_style_check_flags_neon_tiny_text_and_card_overload():
    html = (
        "<html><body><section class='neon matrix'>"
        "<style>.tiny{font-size:12px}</style>"
        + "".join("<div class='card'>x</div>" for _ in range(5))
        + "</section></body></html>"
    )
    gaps = visual_style_check(SlideSignals(slide_sources=[("bad.html", html)]))
    assert len(gaps) == 1
    assert gaps[0].check == "visual_style"
    assert "neon" in gaps[0].detail
    assert "font-size" in gaps[0].detail
    assert "card-style" in gaps[0].detail


def test_enabled_grader_uses_mocked_judge():
    def _judge(_signals):
        return [QualityGap(slide="01.html", check="visual_grader", detail="unrequested aesthetic")]

    inspector = SlideQualityInspector(grader=GraderConfig(enabled=True, judge=_judge))
    gaps = inspector.inspect(SlideSignals(slide_sources=[("01.html", _CLEAN_SLIDE)]))
    assert any(gap.check == "visual_grader" for gap in gaps)
