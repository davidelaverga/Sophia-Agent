from __future__ import annotations

from deerflow.sophia.deck_build.asset_policy import resolve_asset_policies
from deerflow.sophia.deck_build.composition import resolve_compositions
from deerflow.sophia.deck_build.design_plan import resolve_deck_design_plan
from deerflow.sophia.deck_build.html_design_renderer import render_designed_slide_html
from deerflow.sophia.deck_build.models import DeckBuild, DeckSlideSpec


def _slide(index: int, role: str, layout: str, prompt: str | None = None) -> DeckSlideSpec:
    return DeckSlideSpec(
        selector=f"slide:{index}",
        index=index,
        role=role,
        layout_kind=layout,
        title=f"Slide {index} Native Story",
        narrative="Native text explains the claim while support shapes carry the visual system.",
        visual_prompt=prompt,
    )


def _deck(slides: list[DeckSlideSpec], *, request_context: str) -> DeckBuild:
    deck = DeckBuild(
        build_id="deck-test",
        schema_version="test",
        user_id=None,
        thread_id="thread",
        parent_thread_id=None,
        run_id=None,
        task_id=None,
        requested_slide_count=len(slides),
        status="planned",
        register="professional_technical",
        visual_policy="auto",
        style_profile={},
        deck_title="Dark Technical Deck",
        output_path="/mnt/user-data/outputs/deck.pptx",
        slides=slides,
        expected_visual_count=0,
    )
    deck.design_plan = resolve_deck_design_plan(
        deck_title=deck.deck_title,
        slides=[{"title": slide.title, "role": slide.role, "layout_kind": slide.layout_kind} for slide in slides],
        register=deck.register,
        style_profile={},
        design_plan=None,
        request_context=request_context,
    )
    resolve_asset_policies(deck, design_plan=deck.design_plan, request_context=request_context)
    resolve_compositions(deck.slides, deck.design_plan)
    return deck


def test_dark_technical_renderer_uses_dark_substrate_on_native_slide() -> None:
    deck = _deck(
        [_slide(1, "architecture", "single_visual_focus")],
        request_context="Build a dark charcoal technical deck.",
    )

    html = render_designed_slide_html(deck.slides[0], deck)

    assert "width: 1920px; height: 1080px" in html
    assert "background: #0A0E14" in html
    assert "<h1>Slide 1 Native Story</h1>" in html
    assert '<section class="system-diagram"' in html
    assert "<img" not in html


def test_renderer_keeps_title_and_narrative_as_semantic_text() -> None:
    deck = _deck(
        [_slide(1, "comparison", "comparison_two_column")],
        request_context="Build a technical deck.",
    )

    html = render_designed_slide_html(deck.slides[0], deck)

    assert "<h1>Slide 1 Native Story</h1>" in html
    assert '<p class="narrative">' in html
    assert '<table class="comparison-table">' in html


def test_generated_asset_slot_uses_contain_by_default_for_non_cover() -> None:
    deck = _deck(
        [_slide(1, "context", "text_left_visual_right", "Supporting illustration of a runtime module")],
        request_context="Build a visual technical deck.",
    )

    html = render_designed_slide_html(deck.slides[0], deck)

    assert deck.expected_visual_count == 1
    assert "Generated asset, not slide text" in html
    assert 'style="object-fit: contain;"' in html
    assert "deck text" not in html.lower()


def test_support_elements_render_as_native_boxes_and_text() -> None:
    deck = _deck(
        [_slide(1, "process", "timeline_flow")],
        request_context="Build a technical deck.",
    )

    html = render_designed_slide_html(deck.slides[0], deck)

    assert '<ul class="flow"' in html
    assert "<li>" in html
    assert "native-panel" in html or "border:" in html
