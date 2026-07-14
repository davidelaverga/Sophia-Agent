from __future__ import annotations

from deerflow.sophia.deck_build.ir_repair import (
    deck_ir_repair_instruction_from_failure,
    deck_mechanical_repair_instruction_from_reports,
)


def test_retryable_invalid_deck_ir_first_attempt_gets_instruction() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="invalid_deck_ir",
        failure_summary="Slide 2 narrative is required and must be <= 280 chars.",
        retryable=True,
        attempt_count=0,
    )

    assert instruction.should_retry is True
    assert instruction.max_retry_count == 1
    assert "prepare_deck_build exactly once more" in instruction.repair_message
    assert "Slide 2" in instruction.repair_message
    assert instruction.validation_error is not None
    assert instruction.validation_error.slide_index == 2
    assert instruction.validation_error.field == "narrative"


def test_retryable_invalid_deck_ir_second_attempt_does_not_retry() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="invalid_deck_ir",
        failure_summary="Slide 2 narrative is required and must be <= 280 chars.",
        retryable=True,
        attempt_count=1,
    )

    assert instruction.should_retry is False


def test_non_retryable_failure_does_not_retry() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="deck_native_unavailable",
        failure_summary="Native deck service is unavailable.",
        retryable=False,
        attempt_count=0,
    )

    assert instruction.should_retry is False


def test_mechanical_repair_instruction_targets_exact_contrast_text_colors_and_source() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={
            "issues": [
                {
                    "selector": "slide:2",
                    "shape_name": "h2p-2-text-7",
                    "text_excerpt": "Isolated green patches — no continuous forage path between them",
                    "foreground": "6B8E23",
                    "background": "F5E6D3",
                    "contrast_ratio": 3.106,
                    "required_ratio": 4.5,
                    "required_semantic": True,
                    "indeterminate": False,
                },
                {
                    "selector": "slide:4",
                    "shape_name": "h2p-4-text-13",
                    "text_excerpt": "Days 31–70: Plant & Establish",
                    "foreground": "F5E6D3",
                    "background": "FF6B4A",
                    "contrast_ratio": 2.3,
                    "required_ratio": 3.0,
                    "required_semantic": True,
                    "indeterminate": False,
                },
            ]
        },
        source_element_map={
            "slides": {
                "slide:2": {
                    "elements": {
                        "s2-map": {
                            "shape_names": ["h2p-2-s2-map-box-1", "h2p-2-text-7"],
                        }
                    }
                },
                "slide:4": {
                    "elements": {
                        "s4-phase2": {
                            "shape_names": ["h2p-4-s4-phase2-box-1", "h2p-4-text-13"],
                        }
                    }
                },
            }
        },
    )

    assert instruction is not None
    assert instruction["repair_target_count"] == 2
    assert instruction["omitted_repair_target_count"] == 0
    targets = instruction["repair_targets"]
    assert targets[0]["source_ids"] == ["s2-map"]
    assert targets[0]["foreground"] == "#6B8E23"
    assert targets[0]["background"] == "#F5E6D3"
    assert targets[0]["recommended_foreground"] == "#000000"
    assert targets[0]["recommended_contrast_ratio"] >= 4.5
    assert targets[1]["source_ids"] == ["s4-phase2"]
    assert targets[1]["recommended_contrast_ratio"] >= 3.0
    message = instruction["repair_message"]
    assert 'data-deck-id="s2-map"' in message
    assert "Isolated green patches" in message
    assert "#6B8E23 on #F5E6D3 has ratio 3.106, requires >= 4.5" in message
    assert 'data-deck-id="s4-phase2"' in message
    assert "#F5E6D3 on #FF6B4A has ratio 2.3, requires >= 3.0" in message
    assert "prepare_deck_build exactly once more" in message


def test_mechanical_repair_instruction_ignores_advisory_contrast_findings() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={
            "issues": [
                {
                    "selector": "slide:1",
                    "shape_name": "decorative-label",
                    "text_excerpt": "Decoration",
                    "foreground": "777777",
                    "background": "999999",
                    "contrast_ratio": 1.57,
                    "required_ratio": 4.5,
                    "required_semantic": False,
                    "indeterminate": False,
                }
            ]
        },
        source_element_map={},
    )

    assert instruction is None
