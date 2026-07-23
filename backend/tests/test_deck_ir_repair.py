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


def test_retryable_invalid_deck_ir_parses_zero_based_slide_field_target() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="invalid_deck_ir",
        failure_summary=(
            "slides[1].html_body must contain both repair anchors declared by "
            "repair_anchor_ids."
        ),
        retryable=True,
        attempt_count=0,
    )

    assert instruction.should_retry is True
    assert instruction.validation_error is not None
    assert instruction.validation_error.slide_index == 1
    assert instruction.validation_error.field == "html_body"
    assert "zero-based index 1 = visible slide 2" in instruction.repair_message
    assert "do not change only creative_plan" in instruction.repair_message


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
    assert overlap["suggested_move"] == {
        "shape": "s8",
        "native_delta_in": [0.0, 2.22],
        "css_delta_px": [0.0, 213.12],
    }
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
    assert "native_box_in=[1.25, 2.396]+[8.233, 2.625]" in message
    assert "native delta [0, 2.22]in = CSS delta [0px, 213.12px]" in message
    assert "sparse_rendered_slide" in message


def test_overlap_repair_uses_direct_leaf_source_id_for_nested_shape_mapping() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 0,
                    "shape": "s1",
                    "kind": "overlap",
                    "overlap_area": 0.2,
                    "issue": "overlaps s2 by 0.2 sq in",
                    "suggest": "move s2 by [0.25, -0.5]",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_severe_overlap",
                    "selector": "slide:1",
                    "summary": "Native lint/fix left a material shape overlap.",
                    "repair_hint": "Separate the semantic elements.",
                }
            ]
        },
        native_shape_inventory={
            "slide:1": {
                "shapes": [
                    {"id": "s1", "name": "h2p-1-leaf-a-box", "pos": [1, 1], "size": [2, 2]},
                    {"id": "s2", "name": "h2p-1-leaf-b-text", "pos": [2, 2], "size": [2, 1]},
                ]
            }
        },
        source_element_map={
            "slides": {
                "slide:1": {
                    "elements": {
                        "ancestor": {"shape_names": ["h2p-1-leaf-a-box", "h2p-1-leaf-b-text"]},
                        "leaf-a": {"shape_names": ["h2p-1-leaf-a-box"]},
                        "leaf-b": {"shape_names": ["h2p-1-leaf-b-text"]},
                    }
                }
            }
        },
    )

    assert instruction is not None
    target = instruction["repair_targets"][0]
    assert target["pair_shapes"][0]["source_ids"] == ["leaf-a"]
    assert target["pair_shapes"][1]["source_ids"] == ["leaf-b"]
    assert target["source_ids"] == ["leaf-a", "leaf-b"]
    assert target["suggested_move"]["css_delta_px"] == [24.0, -48.0]


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
    assert message.startswith("Repair every listed source-quality and mechanical issue")
    assert "OVERLAP slide:2 area 0.2" in message
    assert "required_source_element_missing" in message


def test_repeated_quality_issues_group_all_thirty_slide_selectors() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        source_element_map={},
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_severe_overlap",
                    "selector": "slide:2",
                    "summary": "Slide 2 contains a material overlap.",
                    "repair_hint": "Separate the two source elements.",
                }
            ]
        },
        source_quality_report={
            "hard_failures": [
                {
                    "id": "slide_chrome",
                    "selector": f"slide:{index}",
                    "check": "chrome",
                    "detail": "remove invented chrome — chrome classes (eyebrow)",
                    "repair_hint": "Remove the eyebrow from this slide.",
                }
                for index in range(1, 31)
            ]
        },
    )

    assert instruction is not None
    assert instruction["source_quality_issue_count"] == 30
    assert instruction["source_quality_repair_target_count"] == 1
    quality_target = next(
        target for target in instruction["repair_targets"] if target["target_type"] == "quality"
    )
    assert quality_target["selectors"] == [f"slide:{index}" for index in range(1, 31)]
    for index in range(1, 31):
        assert f"slide:{index}" in instruction["repair_message"]


def test_canary_typography_and_alignment_repair_is_compact_and_source_addressable() -> None:
    typography_sources = [
        ("slide:2", "perception-label"),
        ("slide:2", "appraisal-label"),
        ("slide:2", "motives-label"),
        ("slide:2", "action-label"),
        ("slide:2", "feedback-label"),
        ("slide:3", "scenario-label"),
        ("slide:3", "motive-row-curiosity"),
        ("slide:3", "motive-row-certainty"),
        ("slide:3", "motive-row-affiliation"),
    ]
    source_element_map = {
        "slides": {
            "slide:1": {
                "elements": {
                    "cover-rule": {"shape_names": ["h2p-1-cover-rule-box-1"]},
                    "cover-anchor": {"shape_names": ["h2p-1-cover-anchor-box-1"]},
                    "cover-title": {"shape_names": ["h2p-1-cover-title-box-1"]},
                }
            },
            "slide:2": {
                "elements": {
                    "perception-label": {},
                    "appraisal-label": {},
                    "motives-label": {},
                    "action-label": {},
                    "feedback-label": {},
                    "conn-4": {"shape_names": ["h2p-2-conn-4-box-1"]},
                    "node-3": {"shape_names": ["h2p-2-node-3-box-1"]},
                    "node-5": {"shape_names": ["h2p-2-node-5-box-1"]},
                }
            },
            "slide:3": {
                "elements": {
                    "scenario-label": {},
                    "motive-row-curiosity": {},
                    "motive-row-certainty": {},
                    "motive-row-affiliation": {},
                }
            },
        }
    }
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 0,
                    "shape": "s7-2",
                    "kind": "misaligned",
                    "details": ['right edge 0.04" off gridline 18.75" (3 shapes: s4-2,s8,s7-2)'],
                    "issue": 'right edge 0.04" off gridline 18.75" (3 shapes: s4-2,s8,s7-2)',
                    "suggest": "align the rule's right edge to the reported gridline",
                },
                {
                    "slide": 1,
                    "shape": "s14",
                    "kind": "misaligned",
                    "details": ['hcenter edge 0.03" off gridline 4.17" (3 shapes: s13,s15,s14)'],
                    "issue": 'hcenter edge 0.03" off gridline 4.17" (3 shapes: s13,s15,s14)',
                    "suggest": "align the source connector to the peer centerline",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:1",
                    "summary": "Native shape alignment remains inconsistent: right edge is off gridline.",
                    "repair_hint": "Align the matching source shape to its intended right edge.",
                },
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:2",
                    "summary": "Native shape alignment remains inconsistent: hcenter 0.03in off gridline.",
                    "repair_hint": "Align the matching source connector to its intended centerline.",
                },
                *[
                    {
                        "code": "native_required_text_too_small",
                        "selector": selector,
                        "summary": (
                            f"Required/body text '{source_id}' compiles at 15.75pt (21px), "
                            "below the 18pt (24px) floor."
                        ),
                        "repair_hint": "Use at least 24px for required body/narrative text.",
                    }
                    for selector, source_id in typography_sources
                ],
            ]
        },
        native_shape_inventory={
            "slide:1": {
                "shapes": [
                    {
                        "id": "s4-2",
                        "name": "h2p-1-cover-anchor-box-1",
                        "pos": [1.25, 6.0],
                        "size": [0.1, 0.1],
                    },
                    {
                        "id": "s7-2",
                        "name": "h2p-1-cover-rule-box-1",
                        "pos": [1.25, 6.2],
                        "size": [17.46, 0.06],
                    },
                    {
                        "id": "s8",
                        "name": "h2p-1-cover-title-box-1",
                        "pos": [1.25, 2.0],
                        "size": [17.5, 1.0],
                    },
                ]
            },
            "slide:2": {
                "shapes": [
                    {
                        "id": "s13",
                        "name": "h2p-2-node-3-box-1",
                        "pos": [3.0, 2.0],
                        "size": [1.0, 1.0],
                    },
                    {
                        "id": "s14",
                        "name": "h2p-2-conn-4-box-1",
                        "pos": [4.0, 2.5],
                        "size": [0.06, 1.5],
                    },
                    {
                        "id": "s15",
                        "name": "h2p-2-node-5-box-1",
                        "pos": [4.5, 3.0],
                        "size": [1.0, 1.0],
                    },
                ]
            }
        },
        source_element_map=source_element_map,
    )

    assert instruction is not None
    assert instruction["repair_target_count"] == 3
    assert instruction["alignment_repair_target_count"] == 2
    assert instruction["generic_repair_target_count"] == 1
    alignments = [
        target for target in instruction["repair_targets"] if target["target_type"] == "alignment"
    ]
    assert [(target["shape"], target["alignment_role"]) for target in alignments] == [
        ("s7-2", "right"),
        ("s14", "hcenter"),
    ]
    assert alignments[0]["source_ids"] == ["cover-rule"]
    assert alignments[0]["peer_ids"] == ["s4-2", "s8"]
    assert alignments[0]["css_target"] == {
        "canvas_property": "left",
        "canvas_value_px": 123.84,
        "gridline_in": 18.75,
    }
    assert alignments[1]["source_ids"] == ["conn-4"]
    assert alignments[1]["peer_ids"] == ["s13", "s15"]
    assert alignments[1]["css_target"] == {
        "canvas_property": "left",
        "canvas_value_px": 397.44,
        "gridline_in": 4.17,
    }
    typography = next(
        target
        for target in instruction["repair_targets"]
        if target.get("typography_occurrences")
    )
    assert [
        (item["selector"], item["source_ids"])
        for item in typography["typography_occurrences"]
    ] == [(selector, [source_id]) for selector, source_id in typography_sources]
    message = instruction["repair_message"]
    assert len(message.encode("utf-8")) < 2_200
    assert message.count("TYPE REQUIRED descendants") == 1
    for selector, source_id in typography_sources:
        assert f'{selector}/data-deck-id="{source_id}"' in message
    assert 's14/data-deck-id="conn-4" native-in-box=[4.0, 2.5]+[0.06, 1.5]' in message
    assert 's7-2/data-deck-id="cover-rule" native-in-box=[1.25, 6.2]+[17.46, 0.06]' in message
    assert 's4-2/data-deck-id="cover-anchor"' in message
    assert "role=right" in message
    assert "role=hcenter" in message
    assert "Cpx=96*C_in" in message
    assert "right-edge left=Cpx-Wpx" in message
    assert "hcenter left=Cpx-Wpx/2" in message
    assert "vcenter top=Cpx-Hpx/2" in message
    assert "Target canvas left=123.84px" in message
    assert "local_left=target_canvas_left-parent_canvas_left" in message


def test_large_typography_failure_set_is_chunked_before_message_bounding() -> None:
    issues = [
        {
            "code": "native_required_text_too_small",
            "selector": f"slide:{(index % 64) + 1}",
            "source_ids": [f"required-label-{index}-" + ("x" * 40)],
            "summary": (
                f"Required/body text 'required-label-{index}' compiles at 15.75pt (21px), "
                "below the 18pt (24px) floor."
            ),
            "repair_hint": "Use at least 24px for required text.",
        }
        for index in range(200)
    ]

    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        source_element_map={},
        mechanical_gate_results={"issues": issues},
    )

    assert instruction is not None
    assert instruction["generic_repair_target_count"] > 1
    assert instruction["included_repair_target_count"] > 0
    assert instruction["included_generic_repair_target_count"] > 0
    assert 'data-deck-id="required-label-0-' in instruction["repair_message"]
    assert len(instruction["repair_message"].encode("utf-8")) <= 8 * 1024
    for line in instruction["repair_message"].splitlines():
        if ". TYPE " in line:
            assert len(line.encode("utf-8")) <= 1024


def test_alignment_repair_preserves_both_axes_for_one_shape() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 1,
                    "shape": "s14",
                    "kind": "misaligned",
                    "details": [
                        'right edge 0.03" off gridline 8.0" (peers s13,s14)',
                        'bottom edge 0.04" off gridline 6.0" (peers s15,s14)',
                    ],
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:2",
                    "summary": "Native shape alignment remains inconsistent on two axes.",
                    "repair_hint": "Align both reported edges.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:2": {
                    "elements": {
                        "aligned-shape": {"shape_names": ["h2p-2-aligned-shape-box-1"]},
                    }
                }
            }
        },
        native_shape_inventory={
            "slide:2": {
                "shapes": [
                    {
                        "id": "s14",
                        "name": "h2p-2-aligned-shape-box-1",
                        "pos": [6.03, 5.04],
                        "size": [2.0, 1.0],
                    }
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["alignment_repair_target_count"] == 2
    assert [target["alignment_role"] for target in instruction["repair_targets"]] == [
        "right",
        "bottom",
    ]
    assert [target["css_target"] for target in instruction["repair_targets"]] == [
        {"canvas_property": "left", "canvas_value_px": 576.0, "gridline_in": 8.0},
        {"canvas_property": "top", "canvas_value_px": 480.0, "gridline_in": 6.0},
    ]
    assert "role=right" in instruction["repair_message"]
    assert "role=bottom" in instruction["repair_message"]
    assert "Target canvas left=576px" in instruction["repair_message"]
    assert "Target canvas top=480px" in instruction["repair_message"]


def test_canary_alignment_targets_include_exact_canvas_coordinates() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 1,
                    "shape": "s24",
                    "kind": "misaligned",
                    "details": ['top edge 0.03" off gridline 4.72" (3 shapes: s23,s24,s25)'],
                },
                {
                    "slide": 2,
                    "shape": "s8",
                    "kind": "misaligned",
                    "details": ['hcenter edge 0.04" off gridline 10.04" (3 shapes: s7,s8,s9)'],
                },
                {
                    "slide": 2,
                    "shape": "s19",
                    "kind": "misaligned",
                    "details": ['bottom edge 0.04" off gridline 6.77" (3 shapes: s18,s19,s20)'],
                },
                {
                    "slide": 2,
                    "shape": "s21",
                    "kind": "misaligned",
                    "details": ['hcenter edge 0.04" off gridline 10.04" (3 shapes: s20,s21,s22)'],
                },
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:2",
                    "summary": "Native shape alignment remains inconsistent.",
                    "repair_hint": "Align the exact source geometry.",
                },
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:3",
                    "summary": "Native shape alignment remains inconsistent.",
                    "repair_hint": "Align the exact source geometry.",
                },
            ]
        },
        source_element_map={
            "slides": {
                "slide:2": {
                    "elements": {"loop-return-v1": {"shape_names": ["h2p-2-loop-return-v1-box-1"]}}
                },
                "slide:3": {
                    "elements": {
                        "motive-competence": {"shape_names": ["h2p-3-motive-competence-box-1"]},
                        "conv-bar": {"shape_names": ["h2p-3-conv-bar-box-1"]},
                        "arbitration-result": {"shape_names": ["h2p-3-arbitration-result-box-1"]},
                    }
                },
            }
        },
        native_shape_inventory={
            "slide:2": {
                "shapes": [
                    {
                        "id": "s24",
                        "name": "h2p-2-loop-return-v1-box-1",
                        "pos": [3.0, 4.75],
                        "size": [0.08, 0.5],
                    }
                ]
            },
            "slide:3": {
                "shapes": [
                    {
                        "id": "s8",
                        "name": "h2p-3-motive-competence-box-1",
                        "pos": [7.29, 3.0],
                        "size": [5.42, 1.0],
                    },
                    {
                        "id": "s19",
                        "name": "h2p-3-conv-bar-box-1",
                        "pos": [7.0, 6.73],
                        "size": [6.0, 0.08],
                    },
                    {
                        "id": "s21",
                        "name": "h2p-3-arbitration-result-box-1",
                        "pos": [6.88, 7.0],
                        "size": [6.25, 1.0],
                    },
                ]
            },
        },
    )

    assert instruction is not None
    assert [target["css_target"] for target in instruction["repair_targets"]] == [
        {"canvas_property": "top", "canvas_value_px": 453.12, "gridline_in": 4.72},
        {"canvas_property": "left", "canvas_value_px": 703.68, "gridline_in": 10.04},
        {"canvas_property": "top", "canvas_value_px": 642.24, "gridline_in": 6.77},
        {"canvas_property": "left", "canvas_value_px": 663.84, "gridline_in": 10.04},
    ]
    for expected in ("top=453.12px", "left=703.68px", "top=642.24px", "left=663.84px"):
        assert f"Target canvas {expected}" in instruction["repair_message"]


def test_alignment_target_outside_canvas_omits_unsafe_numeric_assignment() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 0,
                    "shape": "s2",
                    "kind": "misaligned",
                    "details": ['right edge 0.04" off gridline .5in (3 shapes: s1,s2,s3)'],
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_misaligned",
                    "selector": "slide:1",
                    "summary": "Native shape alignment remains inconsistent.",
                    "repair_hint": "Recompose the source geometry.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:1": {"elements": {"wide-shape": {"shape_names": ["h2p-1-wide-shape-box-1"]}}}
            }
        },
        native_shape_inventory={
            "slide:1": {
                "shapes": [
                    {
                        "id": "s2",
                        "name": "h2p-1-wide-shape-box-1",
                        "pos": [0.54, 2.0],
                        "size": [2.0, 1.0],
                    }
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["repair_targets"][0]["css_target"] is None
    assert "-144px" not in instruction["repair_message"]


def test_gate_confirmed_overflow_is_source_addressable_and_parent_local() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 3,
                    "shape": "s10",
                    "kind": "slide_overflow_non_text",
                    "issue": "extends 8.79in beyond the right edge",
                    "suggest": "move the divider inside the slide",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_unapproved_bleed",
                    "selector": "slide:4",
                    "summary": "A non-text shape extends off-slide.",
                    "repair_hint": "Keep it inside the canvas.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:4": {
                    "elements": {
                        "compare-divider": {"shape_names": ["h2p-4-compare-divider-box-1"]},
                        "compare-motive": {"shape_names": ["h2p-4-compare-divider-box-1"]},
                    }
                }
            }
        },
        native_shape_inventory={
            "slide:4": {
                "shapes": [
                    {
                        "id": "s10",
                        "name": "h2p-4-compare-divider-box-1",
                        "pos": [19.79, 4.4],
                        "size": [9.0, 0.04],
                    }
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["overflow_repair_target_count"] == 1
    assert instruction["generic_repair_target_count"] == 0
    target = instruction["repair_targets"][0]
    assert target["source_ids"] == ["compare-divider", "compare-motive"]
    message = instruction["repair_message"]
    assert "OVERFLOW slide:4" in message
    assert 'data-deck-id="compare-divider","compare-motive"' in message
    assert "local_left=target_canvas_left-parent_canvas_left" in message
    assert "set box-sizing:border-box on that exact data-deck-id only" in message
    assert "never add a global or universal box-sizing reset" in message
    assert "do not enlarge or reposition its parent" in message


def test_allowed_ancestor_does_not_hide_direct_overflow_repair_target() -> None:
    shape_name = "h2p-1-evidence-panel-box-1"
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 0,
                    "shape": "s10",
                    "kind": "slide_overflow_non_text",
                    "issue": "extends beyond the right edge",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_unapproved_bleed",
                    "selector": "slide:1",
                    "summary": "A non-text shape extends off-slide.",
                    "repair_hint": "Keep it inside the canvas.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:1": {
                    "elements": {
                        "panel": {"source_role": "background", "shape_names": [shape_name]},
                        "evidence-panel": {
                            "source_role": "evidence_panel",
                            "shape_names": [shape_name],
                        },
                    }
                }
            }
        },
        native_shape_inventory={
            "slide:1": {
                "shapes": [
                    {"id": "s10", "name": shape_name, "pos": [19.0, 2.0], "size": [2.0, 1.0]}
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["overflow_repair_target_count"] == 1
    assert instruction["repair_targets"][0]["source_role"] == "evidence_panel"


def test_direct_background_overflow_stays_advisory_when_same_slide_has_unapproved_gate() -> None:
    shape_name = "h2p-1-background-line-1-part-2"
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 0,
                    "shape": "s10",
                    "kind": "slide_overflow_non_text",
                    "issue": "intentional background bleed",
                }
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_unapproved_bleed",
                    "selector": "slide:1",
                    "summary": "Another non-text shape extends off-slide.",
                    "repair_hint": "Keep the semantic shape inside the canvas.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:1": {
                    "elements": {
                        "canvas": {"source_role": "diagram", "shape_names": [shape_name]},
                        "background": {"source_role": "background", "shape_names": [shape_name]},
                    }
                }
            }
        },
        native_shape_inventory={
            "slide:1": {
                "shapes": [
                    {"id": "s10", "name": shape_name, "pos": [-0.1, -0.1], "size": [20.2, 11.45]}
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["overflow_repair_target_count"] == 0
    assert instruction["generic_repair_target_count"] == 1


def test_overflow_without_gate_or_source_mapping_keeps_only_generic_gate() -> None:
    residue = {
        "slide": 0,
        "shape": "s10",
        "kind": "slide_overflow_non_text",
        "issue": "extends beyond the right edge",
    }
    no_gate = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={"lint_residue": [residue]},
        mechanical_gate_results={
            "issues": [
                {
                    "code": "sparse_rendered_slide",
                    "selector": "slide:1",
                    "summary": "Rendered slide is sparse.",
                    "repair_hint": "Restore content.",
                }
            ]
        },
        source_element_map={},
        native_shape_inventory={},
    )
    unresolved = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={"lint_residue": [residue]},
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_unapproved_bleed",
                    "selector": "slide:1",
                    "summary": "A non-text shape extends off-slide.",
                    "repair_hint": "Keep it inside the canvas.",
                }
            ]
        },
        source_element_map={},
        native_shape_inventory={},
    )

    assert no_gate is not None
    assert no_gate["overflow_repair_target_count"] == 0
    assert no_gate["generic_repair_target_count"] == 1
    assert unresolved is not None
    assert unresolved["overflow_repair_target_count"] == 0
    assert unresolved["generic_repair_target_count"] == 1
    assert "exact data-deck-id" not in unresolved["repair_message"]


def test_reversed_overlap_residue_pair_is_deduplicated() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        native_mechanical_report={
            "lint_residue": [
                {
                    "slide": 2,
                    "shape": "s13",
                    "kind": "overlap",
                    "overlap_area": 0.43,
                    "issue": "overlaps s7 by 0.43 sq in",
                    "suggest": "move s7 left",
                },
                {
                    "slide": 2,
                    "shape": "s7",
                    "kind": "overlap",
                    "overlap_area": 0.43,
                    "issue": "overlaps s13 by 0.43 sq in",
                    "suggest": "move s13 right",
                },
            ]
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_lint_severe_overlap",
                    "selector": "slide:3",
                    "summary": "Native lint/fix left a material shape overlap.",
                    "repair_hint": "Separate the semantic elements.",
                }
            ]
        },
        source_element_map={
            "slides": {
                "slide:3": {
                    "elements": {
                        "compare-vs": {"shape_names": ["h2p-3-compare-vs-box-1"]},
                        "compare-static": {"shape_names": ["h2p-3-compare-static-box-1"]},
                    }
                }
            }
        },
        native_shape_inventory={
            "slide:3": {
                "shapes": [
                    {"id": "s13", "name": "h2p-3-compare-vs-box-1", "pos": [9, 4], "size": [2, 2]},
                    {"id": "s7", "name": "h2p-3-compare-static-box-1", "pos": [8, 4], "size": [2, 2]},
                ]
            }
        },
    )

    assert instruction is not None
    assert instruction["overlap_repair_target_count"] == 1
    assert instruction["overflow_repair_target_count"] == 0
    target = instruction["repair_targets"][0]
    assert target["pair"] == ["s13", "s7"]
    assert target["source_ids"] == ["compare-static", "compare-vs"]
    assert instruction["repair_message"].count("OVERLAP slide:3") == 1
    assert "box-sizing:border-box on that exact source element only" in instruction["repair_message"]
    assert "never add a global or universal box-sizing reset" in instruction["repair_message"]
    assert "move s7 left" in instruction["repair_message"]


def test_single_oversized_typography_source_id_remains_a_bounded_target() -> None:
    oversized_id = "required-" + ('quote-\\-"-🙂-' * 2_000)
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        source_element_map={},
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_required_text_too_small",
                    "selector": "slide:2",
                    "source_ids": [oversized_id],
                    "summary": (
                        "Required/body text 'oversized-label' compiles at 15.75pt (21px), "
                        "below the 18pt (24px) floor."
                    ),
                    "repair_hint": "Use at least 24px for required text.",
                }
            ]
        },
    )

    assert instruction is not None
    assert instruction["included_repair_target_count"] == 1
    occurrence = instruction["repair_targets"][0]["typography_occurrences"][0]
    assert occurrence["source_ids_truncated"] is True
    assert len(occurrence["source_ids"][0].encode("utf-8")) <= 72
    assert "data-deck-id≈" in instruction["repair_message"]
    type_line = next(line for line in instruction["repair_message"].splitlines() if ". TYPE " in line)
    assert len(type_line.encode("utf-8")) <= 1024


def test_typography_lookup_retains_all_three_source_ancestors_from_long_summary() -> None:
    source_ids = [
        "required-ancestor-one-" + ("a" * 32),
        "required-ancestor-two-" + ("b" * 32),
        "exact-visible-descendant-" + ("c" * 32),
    ]
    source_label = ", ".join(source_ids)
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        source_element_map={
            "slides": {
                "slide:2": {
                    "elements": {source_id: {} for source_id in source_ids},
                }
            }
        },
        mechanical_gate_results={
            "issues": [
                {
                    "code": "native_required_text_too_small",
                    "selector": "slide:2",
                    "summary": (
                        f"Required/body text '{source_label}' compiles at 15.75pt (21px), "
                        "below the 18pt (24px) floor."
                    ),
                    "repair_hint": "Use at least 24px for required text.",
                }
            ]
        },
    )

    assert len(source_label) > 140
    assert instruction is not None
    occurrence = instruction["repair_targets"][0]["typography_occurrences"][0]
    assert occurrence["source_ids"] == source_ids
    assert occurrence["source_id_omitted_count"] == 0
    assert occurrence["source_ids_truncated"] is False
    for source_id in source_ids:
        assert json.dumps(source_id) in instruction["repair_message"]


def test_visual_contract_repair_can_update_creative_plan_image_prompt() -> None:
    instruction = deck_mechanical_repair_instruction_from_reports(
        native_contrast_report={},
        source_element_map={},
        source_quality_report={
            "hard_failures": [
                {
                    "id": "slide_visual_contract",
                    "selector": "slide:2",
                    "check": "visual_contract",
                    "detail": "rewrite the visual prompt without image-baked labels",
                    "repair_hint": "Revise the planned image asset prompt.",
                }
            ]
        },
    )

    assert instruction is not None
    message = instruction["repair_message"]
    assert "creative_plan image prompt/asset record" in message
    assert "QUALITY slide:2 [visual_contract]" in message
