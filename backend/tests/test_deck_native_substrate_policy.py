from __future__ import annotations

from deerflow.sophia.deck_native.policy import classify_native_deck_substrate


def test_screenshot_only_substrate_fails() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=6,
        native_editability_score=0.0,
        native_text_shape_count=0,
        picture_shape_count=6,
        full_slide_picture_count=6,
    )

    assert verdict.passed is False
    assert verdict.hard_failure_code == "deck_screenshot_substrate_forbidden"


def test_weak_native_editability_fails() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=2,
        native_editability_score=0.4,
        native_text_shape_count=4,
        picture_shape_count=0,
        full_slide_picture_count=0,
    )

    assert verdict.passed is False
    assert verdict.hard_failure_code == "deck_native_editability_failed"


def test_missing_native_text_fails() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=2,
        native_editability_score=0.8,
        native_text_shape_count=0,
        picture_shape_count=0,
        full_slide_picture_count=0,
    )

    assert verdict.passed is False
    assert verdict.hard_failure_code == "deck_native_text_missing"


def test_native_text_only_deck_passes() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=2,
        native_editability_score=1.0,
        native_text_shape_count=4,
        picture_shape_count=0,
        full_slide_picture_count=0,
    )

    assert verdict.passed is True
    assert verdict.verdict == "native"


def test_native_deck_with_full_bleed_asset_passes_with_warning() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=6,
        native_editability_score=1.0,
        native_text_shape_count=12,
        picture_shape_count=6,
        full_slide_picture_count=1,
    )

    assert verdict.passed is True
    assert verdict.verdict == "native_with_full_bleed_warning"
    assert verdict.warnings == ["native_full_bleed_picture_present"]


def test_per_slide_inventory_screenshot_substrate_fails() -> None:
    verdict = classify_native_deck_substrate(
        slide_count=2,
        native_editability_score=0.9,
        native_text_shape_count=0,
        picture_shape_count=2,
        full_slide_picture_count=1,
        native_shape_inventory={
            "slide:1": {
                "shape_count": 1,
                "title": None,
                "body": None,
                "shapes": [{"type": "PICTURE", "full_slide": True}],
            },
            "slide:2": {
                "shape_count": 1,
                "title": None,
                "body": None,
                "shapes": [{"type": "PICTURE", "full_slide": True}],
            },
        },
    )

    assert verdict.passed is False
    assert verdict.hard_failure_code == "deck_screenshot_substrate_forbidden"
