from __future__ import annotations

from deerflow.sophia.deck_build.asset_policy import normalize_visual_policy, resolve_asset_policies
from deerflow.sophia.deck_build.design_plan import resolve_deck_design_plan
from deerflow.sophia.deck_build.models import DeckBuild, DeckSlideSpec


def _deck(slides: list[DeckSlideSpec], *, visual_policy: str = "auto") -> DeckBuild:
    return DeckBuild(
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
        visual_policy=normalize_visual_policy(visual_policy),
        style_profile={},
        deck_title="Technical Deck",
        output_path="/mnt/user-data/outputs/deck.pptx",
        slides=slides,
        expected_visual_count=0,
    )


def _slide(index: int, role: str, layout: str, prompt: str | None = None) -> DeckSlideSpec:
    return DeckSlideSpec(
        selector=f"slide:{index}",
        index=index,
        role=role,
        layout_kind=layout,
        title=f"Slide {index}",
        narrative="A concise technical narrative explains the point.",
        visual_prompt=prompt,
    )


def _plan(deck: DeckBuild):
    return resolve_deck_design_plan(
        deck_title=deck.deck_title,
        slides=[{"title": slide.title, "role": slide.role, "layout_kind": slide.layout_kind} for slide in deck.slides],
        register=deck.register,
        style_profile={},
        design_plan=None,
        request_context="Build a visual technical deck.",
    )


def test_technical_content_slides_default_to_native_html() -> None:
    slides = [
        _slide(1, "architecture", "single_visual_focus", "Technical system diagram"),
        _slide(2, "process", "timeline_flow", "Process illustration"),
        _slide(3, "comparison", "comparison_two_column", "Comparison visual"),
        _slide(4, "evidence", "single_visual_focus", "Evidence photo"),
    ]
    deck = _deck(slides)

    resolve_asset_policies(deck, design_plan=_plan(deck), request_context="Build a visual technical deck.")

    assert deck.expected_visual_count == 0
    assert {slide.asset_plan.visual_mode for slide in deck.slides if slide.asset_plan} == {"native_html"}


def test_cover_with_prompt_becomes_hybrid_asset() -> None:
    deck = _deck([_slide(1, "cover", "cover_hero", "Abstract hero texture for an agent runtime")])

    resolve_asset_policies(deck, design_plan=_plan(deck), request_context="Build a visual technical deck.")

    assert deck.expected_visual_count == 1
    assert deck.generated_asset_count == 1
    assert deck.hybrid_slide_count == 1
    assert deck.slides[0].asset_plan is not None
    assert deck.slides[0].asset_plan.visual_mode == "hybrid"
    assert deck.slides[0].asset_plan.allow_full_bleed is True


def test_missing_visual_prompt_does_not_require_generated_image() -> None:
    deck = _deck([_slide(1, "architecture", "single_visual_focus", None)])

    resolve_asset_policies(deck, design_plan=_plan(deck), request_context="Build a visual technical deck.")

    assert deck.expected_visual_count == 0
    assert deck.slides[0].visual_required is False


def test_text_only_policy_disables_generated_images() -> None:
    deck = _deck([_slide(1, "cover", "cover_hero", "Hero texture")], visual_policy="text_only")

    resolve_asset_policies(deck, design_plan=_plan(deck), request_context="Build a plain text-only deck with no visuals.")

    assert deck.expected_visual_count == 0
    assert deck.text_only_slide_count == 1
    assert deck.slides[0].asset_plan is not None
    assert deck.slides[0].asset_plan.visual_mode == "text_only"


def test_required_policy_maps_to_auto_with_images_allowed() -> None:
    assert normalize_visual_policy("required") == "auto_with_images_allowed"
