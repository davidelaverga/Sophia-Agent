"""Correction wave 2026-06-12 — output-format truth is current-turn-first.

Prod incident: two intended-PDF runs dispatched as ``target_ext=pptx``
because the companion-authored description carried prior-artifact deck
context and pptx is matched before pdf. One run failed terminally while a
correct 9-page PDF sat on disk; another shipped an unwanted PPTX.

These tests lock: (1) the current user turn has absolute precedence over
description-derived context; (2) negated format mentions ("not a
presentation", "no slides") never claim the target; (3) edit-flow target
overrides convert to the user's explicitly requested format.
"""

from __future__ import annotations

from deerflow.sophia.tools.start_builder_task import (
    _requested_output_extension_match,
    _requested_output_extension_match_with_vetoes,
    _resolve_target_format,
    _suggest_artifact_target_path,
)

# The verbatim prod brief shape (run 019ebb4f, 2026-06-12T10:09Z).
_PROD_USER_TURN = "Create an actual PDF report (not a presentation) about Sophia's architecture failure points"
_PROD_DESCRIPTION = (
    "[visual_report] Create an actual PDF report (not a presentation) about "
    "Sophia's architecture failure points, based on the prior slide deck "
    "(source: sophia-architecture.pptx)."
)


# ---- two-tier precedence -------------------------------------------------------


def test_prod_incident_brief_resolves_to_pdf_from_current_turn():
    resolution = _resolve_target_format(
        current_user_text=_PROD_USER_TURN,
        description=_PROD_DESCRIPTION,
        task_type="visual_report",
    )
    assert resolution.final_ext == "pdf"
    assert resolution.source == "current_user_turn"
    assert resolution.user_requested_ext == "pdf"


def test_prior_pptx_context_plus_new_deck_request_stays_pptx():
    resolution = _resolve_target_format(
        current_user_text="make another slide deck covering Q3",
        description="[presentation] make another slide deck covering Q3. Prior: q2-deck.pptx",
        task_type="presentation",
    )
    assert resolution.final_ext == "pptx"
    assert resolution.source == "current_user_turn"


def test_presentation_in_pdf_format_resolves_to_pdf():
    resolution = _resolve_target_format(
        current_user_text="I want the presentation in PDF format",
        description="presentation in PDF format about roadmap",
        task_type="presentation",
    )
    assert resolution.final_ext == "pdf"


def test_powerpoint_deck_from_pdf_source_resolves_to_pptx():
    resolution = _resolve_target_format(
        current_user_text="build a PowerPoint deck based on a PDF source document",
        description="build a PowerPoint deck based on a PDF source document",
        task_type="presentation",
    )
    assert resolution.final_ext == "pptx"


def test_silent_current_turn_falls_back_to_description():
    resolution = _resolve_target_format(
        current_user_text="yes, go ahead with that",
        description="[document] write the markdown summary we discussed",
        task_type="document",
    )
    assert resolution.final_ext == "md"
    assert resolution.source == "description"
    assert resolution.user_requested_ext is None


def test_both_silent_falls_back_to_task_type_default():
    resolution = _resolve_target_format(
        current_user_text="do the thing we talked about",
        description="put together the thing we talked about",
        task_type="visual_report",
    )
    assert resolution.final_ext == "pdf"
    assert resolution.source == "task_type_default"
    assert resolution.rule == "task_type_default:visual_report"


def test_description_deck_words_cannot_override_current_turn_pdf():
    """The exact contamination shape: description full of deck language."""
    resolution = _resolve_target_format(
        current_user_text="turn that into a pdf report please",
        description="Revise the slide deck (slides 3-7 of deck.pptx) into a pdf report",
        task_type="presentation",
    )
    assert resolution.final_ext == "pdf"
    assert resolution.source == "current_user_turn"


# ---- negation veto -------------------------------------------------------------


def test_negated_slides_mention_does_not_claim_target():
    ext, reason = _requested_output_extension_match(
        "write a pdf summary about the launch, no slides please"
    )
    assert ext == "pdf"
    assert reason == "explicit_pdf_deliverable"


def test_negated_deck_recorded_as_vetoed_rule():
    ext, _reason, vetoed = _requested_output_extension_match_with_vetoes(
        "I don't want a slide deck, give me a pdf report"
    )
    assert ext == "pdf"
    assert "explicit_presentation_deck" in vetoed


def test_instead_of_slides_resolves_to_pdf():
    ext, _reason = _requested_output_extension_match(
        "a pdf report instead of slides"
    )
    assert ext == "pdf"


def test_affirmative_mention_elsewhere_still_wins():
    """One negated + one affirmative mention of the same family → wins."""
    ext, _reason = _requested_output_extension_match(
        "not a powerpoint... actually yes, make a slide deck"
    )
    assert ext == "pptx"


def test_pure_negation_with_no_other_format_falls_through():
    ext, reason, vetoed = _requested_output_extension_match_with_vetoes(
        "definitely not a slide deck"
    )
    assert ext is None
    assert reason is None
    assert vetoed == ["explicit_presentation_deck"]


# ---- suggest path keeps documented behavior -------------------------------------


def test_suggest_path_with_ext_override():
    target = _suggest_artifact_target_path(
        "presentation", "Quarterly business review", ext_override="pdf"
    )
    assert target.endswith(".pdf")


def test_suggest_path_without_override_unchanged():
    target = _suggest_artifact_target_path(
        "presentation", "Create a PowerPoint slide presentation."
    )
    assert target.endswith(".pptx")


# ---- end-to-end dispatch stamps -------------------------------------------------


def test_dispatch_stamps_user_requested_ext_and_targets_pdf(monkeypatch):
    """Incident replay through the real tool: the current user turn (in
    companion state messages) says PDF-not-presentation; the model-authored
    description carries deck contamination. Dispatch must target .pdf and
    stamp user_requested_ext for the emit-time conflict guard."""
    import asyncio
    import importlib

    from langchain_core.messages import HumanMessage
    from test_start_builder_task import _make_fake_sdk_client, _make_runtime

    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client(thread_id="fmt-1", run_id="run-fmt")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "user_id": "alice",
            "messages": [HumanMessage(content=_PROD_USER_TURN)],
        }
    )

    asyncio.run(
        module.start_builder_task.coroutine(
            description=_PROD_DESCRIPTION,
            task_type="visual_report",
            runtime=runtime,
        )
    )

    run_input = captured["run_kwargs"]["input"]
    delegation = run_input["delegation_context"]
    assert delegation["artifact_target_path"].endswith(".pdf")
    assert delegation["user_requested_ext"] == "pdf"
    assert delegation["format_resolution_source"] == "current_user_turn"
    assert run_input["builder_artifact_target_path"].endswith(".pdf")
