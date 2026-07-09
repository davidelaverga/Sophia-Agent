from __future__ import annotations

from deerflow.sophia.deck_build.design_plan import resolve_deck_design_plan


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
