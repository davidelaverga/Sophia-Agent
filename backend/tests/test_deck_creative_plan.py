from __future__ import annotations

import pytest
from test_deck_build_service import _creative_plan, _runtime, _slides

from deerflow.sophia.deck_build.creative_plan import CreativePlanValidationError, normalize_creative_plan
from deerflow.sophia.deck_build.models import DeckBuild
from deerflow.sophia.deck_build.service import DeckBuildService


def _deck(tmp_path) -> DeckBuild:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService()
    slides = service._build_slide_specs(
        _slides(),
        visual_policy="auto",
        runtime=runtime,
        style_profile={},
    )
    return DeckBuild(
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
        slides=slides,
        expected_visual_count=0,
    )


def test_missing_creative_plan_is_retryable_validation_error(tmp_path) -> None:
    with pytest.raises(CreativePlanValidationError) as exc:
        normalize_creative_plan(None, deck=_deck(tmp_path), request_context="")

    assert exc.value.code == "deck_creative_plan_required"


def test_creative_plan_requires_all_slide_compositions(tmp_path) -> None:
    raw = _creative_plan()
    raw["slide_compositions"] = raw["slide_compositions"][:2]

    with pytest.raises(CreativePlanValidationError) as exc:
        normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert exc.value.code == "deck_creative_plan_invalid"
    assert "slide:3" in exc.value.summary


def test_creative_plan_forces_native_base_canvas_size(tmp_path) -> None:
    raw = _creative_plan()
    raw["design_plan"]["grid"] = {"slide_width_px": 1280, "slide_height_px": 720}

    plan = normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert plan.design_plan.grid.slide_width_px == 1920
    assert plan.design_plan.grid.slide_height_px == 1080


def test_creative_plan_normalizes_page_chrome_policies_to_none(tmp_path) -> None:
    raw = _creative_plan()
    raw["design_plan"]["grid"] = {
        "footer_policy": "page_numbers",
        "eyebrow_policy": "only_when_meaningful",
    }

    plan = normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert plan.design_plan.grid.footer_policy == "none"
    assert plan.design_plan.grid.eyebrow_policy == "none"


def test_creative_plan_normalizes_renderer_unsafe_typography(tmp_path) -> None:
    raw = _creative_plan()
    raw["design_plan"]["typography"] = {
        "display": "Georgia",
        "body": "Aptos",
        "utility": "Trebuchet MS",
    }

    plan = normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert plan.design_plan.typography.display == "Cambria"
    assert plan.design_plan.typography.body == "Calibri"
    assert plan.design_plan.typography.utility == "Calibri"


def test_creative_plan_accepts_required_element_ids_with_underscore(tmp_path) -> None:
    raw = _creative_plan()
    raw["slide_compositions"][0]["required_element_ids"] = ["title_1"]
    deck = _deck(tmp_path)
    deck.slides[0].html_source = (deck.slides[0].html_source or "").replace("title-1", "title_1")

    plan = normalize_creative_plan(raw, deck=deck, request_context="")

    assert plan.slide_compositions[0].required_element_ids == ["title_1"]


def test_creative_plan_rejects_unfinished_critique_revision(tmp_path) -> None:
    raw = _creative_plan()
    raw["plan_critique"]["final_scores"]["specificity"] = 2

    with pytest.raises(CreativePlanValidationError) as exc:
        normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert "final_scores.specificity" in exc.value.summary


def test_creative_plan_rejects_repeated_structural_fingerprint(tmp_path) -> None:
    raw = _creative_plan()
    for composition in raw["slide_compositions"]:
        composition["structural_fingerprint"] = "same-layout"

    with pytest.raises(CreativePlanValidationError) as exc:
        normalize_creative_plan(raw, deck=_deck(tmp_path), request_context="")

    assert "structural_fingerprint" in exc.value.summary
