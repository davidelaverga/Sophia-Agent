from __future__ import annotations

import json
from types import SimpleNamespace

from deerflow.sophia.deck_build.ir_repair import (
    deck_ir_repair_instruction_from_failure,
    deck_mechanical_repair_instruction_from_reports,
)
from deerflow.sophia.deck_build.service import DeckBuildFailure, _repair_instruction_for_failure


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
    assert "#6B8E23/#F5E6D3 ratio 3.106, needs 4.5" in message
    assert 'data-deck-id="s4-phase2"' in message
    assert "#F5E6D3/#FF6B4A ratio 2.3, needs 3.0" in message
    assert "call prepare_deck_build once" in message


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


def test_mechanical_repair_instruction_combines_contrast_overlap_and_generic_targets() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={
            "issues": [
                {
                    "selector": "slide:4",
                    "shape_name": "phase-label",
                    "text_excerpt": "Days 31–70",
                    "foreground": "F5E6D3",
                    "background": "FF6B4A",
                    "contrast_ratio": 2.3,
                    "required_ratio": 3.0,
                    "required_semantic": True,
                }
            ]
        },
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 1,
                    "shape": "s5",
                    "kind": "overlap",
                    "overlap_area": 0.2,
                    "issue": "overlaps s8 by 0.20 sq in (needs judgment)",
                    "suggest": "move s8 by [0, 2.22]",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_text_contrast_failed",
                    "selector": "slide:4",
                    "summary": "Required text contrast is too low.",
                    "repair_hint": "Use a compliant text color.",
                },
                {
                    "code": "native_lint_severe_overlap",
                    "selector": "slide:2",
                    "summary": "Native lint/fix left a material shape overlap.",
                    "repair_hint": "Separate the semantic elements.",
                },
                {
                    "code": "sparse_rendered_slide",
                    "selector": "slide:5",
                    "summary": "Rendered slide is near-blank.",
                    "repair_hint": "Restore the required semantic elements.",
                },
            ]
        },
        native_shape_inventory={
            "slide:2": {
                "shapes": [
                    {
                        "id": "s5",
                        "name": "h2p-2-problem-narrative-text-1",
                        "text_preview": "Three isolated habitat patches leave pollinators stranded.",
                        "pos": [1.25, 2.396],
                        "size": [8.233, 2.625],
                    },
                    {
                        "id": "s8",
                        "name": "h2p-2-text-3",
                        "text_preview": "Share of Insect Pollinator Species at Extinction Risk",
                        "pos": [9.042, 2.417],
                        "size": [9.562, 0.469],
                    },
                ]
            }
        },
        source_element_map={
            "slides": {
                "slide:2": {
                    "elements": {
                        "problem-narrative": {"shape_names": ["h2p-2-problem-narrative-text-1"]},
                        "problem-chart": {"shape_names": ["h2p-2-text-3"]},
                    }
                }
            }
        },
    )

    assert instruction is not None
    assert instruction["repair_target_count"] == 3
    assert instruction["contrast_repair_target_count"] == 1
    assert instruction["overlap_repair_target_count"] == 1
    assert instruction["generic_repair_target_count"] == 1
    targets = instruction["repair_targets"]
    overlap = next(target for target in targets if target["target_type"] == "overlap")
    assert overlap["selector"] == "slide:2"
    assert overlap["pair"] == ["s5", "s8"]
    assert overlap["area"] == 0.2
    assert overlap["suggest"] == "move s8 by [0, 2.22]"
    assert overlap["source_ids"] == ["problem-chart", "problem-narrative"]
    assert overlap["pair_shapes"][0] == {
        "id": "s5",
        "name": "h2p-2-problem-narrative-text-1",
        "source_ids": ["problem-narrative"],
        "text_excerpt": "Three isolated habitat patches leave pollinators stranded.",
        "pos": [1.25, 2.396],
        "size": [8.233, 2.625],
    }
    generic = next(target for target in targets if target["target_type"] == "generic")
    assert generic["code"] == "sparse_rendered_slide"
    message = instruction["repair_message"]
    assert "#F5E6D3/#FF6B4A" in message
    assert "OVERLAP slide:2 area 0.2" in message
    assert "move s8 by [0, 2.22]" in message
    assert 's5/data-deck-id="problem-narrative"' in message
    assert "Three isolated habitat patches" in message
    assert "box=[1.25, 2.396]+[8.233, 2.625]" in message
    assert "sparse_rendered_slide" in message


def test_mechanical_repair_instruction_is_bounded_without_hiding_target_categories() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={
            "issues": [
                {
                    "selector": f"slide:{index + 1}",
                    "shape_name": f"text-{index}",
                    "text_excerpt": "Required text " + ("x" * 500),
                    "foreground": "777777",
                    "background": "FFFFFF",
                    "contrast_ratio": 4.478,
                    "required_ratio": 4.5,
                    "required_semantic": True,
                }
                for index in range(30)
            ]
        },
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": index,
                    "shape": f"s{index}",
                    "kind": "overlap",
                    "overlap_area": 0.2,
                    "issue": f"overlaps p{index} by 0.20 sq in " + ("x" * 500),
                    "suggest": f"move p{index} by [0, 0.5] " + ("x" * 500),
                }
                for index in range(30)
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "sparse_rendered_slide",
                    "selector": f"slide:{index + 1}",
                    "summary": f"Sparse slide {index} " + ("x" * 500),
                    "repair_hint": "Restore semantic content " + ("x" * 500),
                }
                for index in range(10)
            ]
        },
        native_shape_inventory={},
        source_element_map={},
    )

    assert instruction is not None
    assert instruction["repair_target_count"] == 70
    assert 3 <= instruction["included_repair_target_count"] <= 24
    assert instruction["omitted_repair_target_count"] == 70 - instruction["included_repair_target_count"]
    assert {target["target_type"] for target in instruction["repair_targets"]} == {
        "contrast",
        "generic",
        "overlap",
    }
    message = instruction["repair_message"]
    assert len(message.encode("utf-8")) <= 8 * 1024
    numbered_lines = [line for line in message.splitlines() if line.split(".", 1)[0].isdigit()]
    assert len(numbered_lines) == instruction["included_repair_target_count"]
    assert numbered_lines[-1].startswith(f"{instruction['included_repair_target_count']}.")
    assert "additional targets were omitted by the prompt bound" in message
    assert len(json.dumps(instruction).encode("utf-8")) < 24 * 1024


def test_service_preserves_base_repair_context_when_adding_exact_mechanical_targets() -> None:
    deck = SimpleNamespace(
        native_contrast_report={"issues": []},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 1,
                    "shape": "s5",
                    "kind": "overlap",
                    "overlap_area": 0.2,
                    "issue": "overlaps s8 by 0.20 sq in",
                    "suggest": "move s8 by [0, 2.22]",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_severe_overlap",
                    "selector": "slide:2",
                    "summary": "Native lint/fix left a material shape overlap.",
                    "repair_hint": "Separate the semantic elements.",
                },
                {
                    "code": "required_source_element_missing",
                    "selector": "slide:3",
                    "summary": "Required semantic element is missing.",
                    "repair_hint": "Preserve its data-deck-id.",
                },
            ]
        },
        native_shape_inventory={},
        source_element_map={},
    )

    instruction = _repair_instruction_for_failure(
        DeckBuildFailure(
            "deck_mechanical_gate_failed",
            "Native lint/fix left a material shape overlap.",
            retryable=True,
        ),
        deck=deck,
    )

    assert instruction is not None
    message = instruction["repair_message"]
    assert message.startswith("Repair every listed mechanical issue")
    assert "OVERLAP slide:2 area 0.2" in message
    assert "required_source_element_missing" in message
