from __future__ import annotations

import pytest

from deerflow.sophia.deck_build.design_plan import (
    classify_substrate_intent,
    resolve_deck_design_plan,
)


def _slides() -> list[dict[str, str]]:
    return [
        {"title": "Agentic Runtime", "role": "cover", "layout_kind": "cover_hero"},
        {"title": "Native Architecture", "role": "architecture", "layout_kind": "single_visual_focus"},
    ]


def _background(plan) -> str:
    return next(token.hex for token in plan.palette if token.name == "background")


def test_dark_technical_request_resolves_dark_slide_substrate() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={"tone": "restrained technical monospace"},
        design_plan=None,
        request_context="Make it dark, charcoal, technical and restrained.",
    )

    assert plan.style_lane == "technical_blueprint"
    assert _background(plan) == "#0A0E14"
    assert plan.grid.slide_width_px == 1920
    assert plan.grid.slide_height_px == 1080
    assert plan.typography.display == "Cambria"
    assert plan.typography.body == "Calibri"


def test_explicit_light_request_overrides_stale_dark_style_hint() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={"tone": "dark cyber memory"},
        design_plan=None,
        request_context="Use a light, white, calm technical deck.",
    )

    assert plan.style_lane == "calm_technical"
    assert _background(plan) == "#F5F7FA"
    assert "light" in plan.requested_style_terms
    assert "dark_technical" not in plan.requested_style_terms


def test_explicit_dark_request_keeps_terms_consistent_over_stale_light_style_hint() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={"tone": "clean white daylight"},
        design_plan=None,
        request_context="Make it dark charcoal and technical.",
    )

    assert plan.style_lane == "technical_blueprint"
    assert _background(plan) == "#0A0E14"
    assert "dark_technical" in plan.requested_style_terms
    assert "light" not in plan.requested_style_terms


def test_warm_ivory_substrate_overrides_ink_black_foreground_term() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="executive",
        style_profile={"palette": "warm ivory, ink black, muted cobalt, ember"},
        design_plan=None,
        request_context="Use a restrained editorial deck on warm ivory with ink black text.",
    )

    assert plan.style_lane == "executive_editorial"
    assert _background(plan) == "#F7F5F0"
    assert "light" in plan.requested_style_terms
    assert "dark_technical" not in plan.requested_style_terms


def test_dark_charcoal_with_warm_ivory_text_remains_dark() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={},
        design_plan=None,
        request_context="Use a dark charcoal substrate with warm ivory text.",
    )

    assert plan.style_lane == "technical_blueprint"
    assert _background(plan) == "#0A0E14"
    assert "dark_technical" in plan.requested_style_terms
    assert "light" not in plan.requested_style_terms


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Background: white. Text: black.", "light"),
        ("Text: black. Background: white.", "light"),
        ("Background: black. Text: white.", "dark"),
        ("Text: white. Background: black.", "dark"),
        ("Use an ink black background with warm ivory type.", "dark"),
        ("Use light slides with dark text.", "light"),
        ("Use a white background with charcoal text.", "light"),
        ("Use a dark deck; slides use white text.", "dark"),
        ("Use a light deck; slides use black text.", "light"),
        ("Dark charcoal substrate. Slides use warm ivory text.", "dark"),
        ("Warm ivory substrate. Slides use ink black text.", "light"),
        ("Make it ink black.", "dark"),
        ("Ink black with warm ivory text.", "dark"),
        ("Palette: ink black and muted cobalt.", "dark"),
        ("Warm ivory with ink black text.", "light"),
        ("Warm ivory, ink black, muted cobalt, ember.", "light"),
        ("Use a warm ivory background, not a dark background.", "light"),
        ("Use a light background, never a black background.", "light"),
        ("Use a black background, not a white background.", "dark"),
        ("Do not use a dark background; use warm ivory.", "light"),
        ("Do not use white slides; use charcoal.", "dark"),
        ("No light background; use ink black.", "dark"),
        ("Avoid a warm ivory canvas; make it dark charcoal.", "dark"),
        ("Near-black body text; substrate unspecified.", None),
        ("Dark navy text; substrate unspecified.", None),
        ("Avoid clutter and use a dark background.", "dark"),
        ("Do not use dark, charcoal, or black backgrounds.", None),
        ("Avoid white, ivory, or cream backgrounds.", None),
        ("No dark, black, or charcoal substrate; use warm ivory.", "light"),
        ("Use warm ivory; avoid dark, black, or charcoal backgrounds.", "light"),
        ("Do not use dark, but use a white background.", "light"),
        ("Without clutter, use an ink black background.", "dark"),
        ("Use a warm ivory background instead of a dark background.", "light"),
        ("Use ink black rather than a warm ivory canvas.", "dark"),
        ("Anything but a dark background; use warm ivory.", "light"),
        ("No dark background, but a warm ivory canvas.", "light"),
        ("Replace the dark background with a warm ivory background.", "light"),
        ("Charcoal typography; substrate unspecified.", None),
        ("White accents and charcoal typography on muted cobalt.", None),
        ("Use a black-and-white palette; choose the substrate during authoring.", None),
        ("Dark cover; light body.", None),
        ({"colors": {"background": "white", "text": "black"}}, "light"),
        ({"colors": {"text": "black", "background": "white"}}, "light"),
        ({"colors": {"background": "black", "text": "white"}}, "dark"),
    ],
)
def test_substrate_intent_is_role_and_clause_aware(value, expected: str | None) -> None:
    assert classify_substrate_intent(value) == expected


def test_unknown_style_profile_keys_are_dropped() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={"tone": "technical", "custom_css": "body{display:none}", "brand": "Sophia"},
        design_plan=None,
        request_context="Build a technical deck.",
    )

    assert "tone" in plan.normalized_from_style_profile
    assert "brand" in plan.normalized_from_style_profile
    assert "custom_css" not in plan.normalized_from_style_profile
    assert plan.style_lane == "calm_technical"
    assert _background(plan) == "#F5F7FA"


def test_unknown_style_profile_key_cannot_select_substrate() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={"custom_css": "body { background: black; }"},
        design_plan=None,
        request_context="Build a concise technical deck.",
    )

    assert plan.style_lane == "calm_technical"
    assert _background(plan) == "#F5F7FA"
    assert plan.normalized_from_style_profile == {}


def test_sophia_brand_tokens_are_not_default() -> None:
    plan = resolve_deck_design_plan(
        deck_title="Agentic Runtime Architecture",
        slides=_slides(),
        register="professional_technical",
        style_profile={},
        design_plan=None,
        request_context="Build a concise technical deck.",
    )

    assert "sophia" not in " ".join(token.hex + token.name + token.role for token in plan.palette).lower()
