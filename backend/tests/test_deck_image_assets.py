from __future__ import annotations

import pytest

from deerflow.sophia.deck_build.creative_plan import CreativePlanValidationError, normalize_creative_plan
from deerflow.sophia.deck_build.image_assets import apply_creative_asset_plan, planned_asset_ref_basenames
from deerflow.sophia.deck_build.models import DeckBuild
from test_deck_build_service import _creative_plan, _runtime, _slides


def _deck(tmp_path, *, include_asset: bool = True) -> DeckBuild:
    runtime = _runtime(tmp_path / "outputs")
    slides = _slides(include_asset=include_asset)
    deck = DeckBuild(
        build_id="deck-test",
        schema_version="sophia-deck-build/v1",
        user_id="user",
        thread_id="thread",
        parent_thread_id=None,
        run_id=None,
        task_id=None,
        requested_slide_count=len(slides),
        status="planned",
        register="professional_technical",
        visual_policy="auto",
        style_profile={},
        deck_title="Technical Deck",
        output_path="/mnt/user-data/outputs/deck.pptx",
        slides=[],
        expected_visual_count=0,
    )
    from deerflow.sophia.deck_build.service import DeckBuildService

    deck.slides = DeckBuildService()._build_slide_specs(
        slides,
        visual_policy="auto",
        runtime=runtime,
        style_profile={},
    )
    return deck


def test_creative_asset_plan_sets_counts_from_declared_assets(tmp_path) -> None:
    deck = _deck(tmp_path)
    plan = normalize_creative_plan(_creative_plan(), deck=deck, request_context="")

    apply_creative_asset_plan(deck, plan)

    assert deck.expected_visual_count == 1
    assert deck.generated_asset_count == 1
    assert deck.native_html_slide_count == 2
    assert planned_asset_ref_basenames(deck) == {"slide-01.png"}
    assert deck.slides[0].asset_plan is not None
    assert deck.slides[0].asset_plan.prompt.startswith("Dark technical abstract")


def test_multiple_generated_assets_on_one_slide_are_retryable_invalid_plan(tmp_path) -> None:
    deck = _deck(tmp_path)
    raw = _creative_plan()
    raw["image_assets"].append({**raw["image_assets"][0], "asset_id": "second"})
    raw["slide_compositions"][0]["image_asset_ids"] = ["cover-texture", "second"]
    plan = normalize_creative_plan(raw, deck=deck, request_context="")

    with pytest.raises(CreativePlanValidationError) as exc:
        apply_creative_asset_plan(deck, plan)

    assert exc.value.code == "deck_image_asset_plan_invalid"
