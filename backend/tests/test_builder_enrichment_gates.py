"""Spec VQ-3/4/5 — enrichment outcome accounting, image diagnostics, PDF scope.

Prod 2026-06-11 (F5): Sonnet silently skipped gpt-image enrichment on the
primary provider — prompt-only policy produced zero generated images with no
signal. The middleware now records the outcome and lets rendered artifact QA
own the bounded repair pass. PDFs now get conceptual/editorial images on by
default (cap 3); data charts and structural diagrams still route through
generate_chart (chart-visualization).
"""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_hero_missing_quality_metadata,
    _builder_image_enrichment_enabled,
    _image_generation_outcome_from_state,
    _image_generation_preflight_delta,
    _visuals_requested,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _image_generation_enabled,
)

_SCRIPT = "/mnt/skills/public/image-generation/scripts/generate.py"


def _deck_state(**overrides) -> dict:
    state = {
        "delegation_context": {
            "task": "Build a professional technical presentation",
            "task_type": "presentation",
        },
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
    }
    state.update(overrides)
    return state


def _pdf_state(task: str = "Create a technical PDF with diagrams and visuals", **overrides) -> dict:
    state = {
        "delegation_context": {"task": task, "task_type": "document"},
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
    }
    state.update(overrides)
    return state


# ---- VQ-5: PDF enrichment scope ----------------------------------------------


def test_pdf_enables_generated_images_by_default():
    # New policy: PDF reports get up to 3 conceptual/editorial images on by
    # default; charts/diagrams are authored as inline SVG and rendered via
    # render_html_to_pdf.
    assert _image_generation_enabled(
        {"task": "Create a technical PDF with diagrams and visuals"},
        artifact_target_ext=".pdf",
        task_type="document",
    ) is True


def test_explicit_image_pdf_enables_enrichment():
    assert _image_generation_enabled(
        {"task": "Create a technical PDF with generated illustrations"},
        artifact_target_ext=".pdf",
        task_type="document",
    ) is True


def test_pdf_image_generation_on_by_default_even_for_plain_brief():
    # PDFs enable image-gen unconditionally (the cap bounds it to 3); the prompt
    # steers the model to reserve generated images for conceptual figures, so a
    # plain brief simply yields few or none.
    assert _image_generation_enabled(
        {"task": "Write a markdown-style PDF summary"},
        artifact_target_ext=".pdf",
        task_type="document",
    ) is True


def test_plain_no_image_deck_still_requests_visual_gate():
    state = _deck_state()
    state["delegation_context"]["task"] = "Build a plain text-only deck with no images"

    assert _visuals_requested(state) is True
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"},
        state,
    ) is True


def test_no_image_phrasing_still_requests_visual_gate():
    for task in (
        "Build a no-image deck about our roadmap",
        "Build a no image deck about our roadmap",
        "Build a deck without images about our roadmap",
    ):
        state = _deck_state()
        state["delegation_context"]["task"] = task

        assert _visuals_requested(state) is True


def test_no_image_deck_with_deterministic_diagram_still_requests_visual_gate():
    state = _deck_state()
    state["delegation_context"]["task"] = (
        "Build a no images architecture deck with a deterministic timeline diagram"
    )

    assert _visuals_requested(state) is True


def test_enrichment_enabled_mirror_reads_state():
    assert _builder_image_enrichment_enabled(_deck_state()) is True
    assert _builder_image_enrichment_enabled(_pdf_state()) is True
    assert _builder_image_enrichment_enabled(_pdf_state(task="plain text summary")) is True


def test_pdf_cap_is_three_and_deck_cap_is_twenty():
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _image_generation_max_calls,
    )

    # Caps count IMAGES (a --manifest batch produces N images in one call).
    assert _image_generation_max_calls(_pdf_state()) == 3
    assert _image_generation_max_calls(_deck_state()) == 20


# ---- VQ-3: preflight delta + outcome accounting -------------------------------


def test_preflight_failure_records_skip_reason():
    delta = _image_generation_preflight_delta('{"preflight": "failed", "reason": "env_missing"}')
    assert delta["image_generation_preflight"] == "failed"
    assert delta["image_generation_skip_reason"] == "env_missing"
    assert "image_generation_attempt_count" not in delta  # never an attempt


def test_preflight_ok_records_status_only():
    delta = _image_generation_preflight_delta('{"preflight": "ok"}')
    assert delta == {"image_generation_preflight": "ok"}


def test_preflight_unparseable_output_is_failed():
    delta = _image_generation_preflight_delta("Traceback (most recent call last): ...")
    assert delta["image_generation_preflight"] == "failed"
    assert delta["image_generation_skip_reason"] == "preflight_unparseable"


def test_preflight_command_not_counted_or_blocked():
    mw = BuilderArtifactMiddleware()
    state = _deck_state(
        builder_pptx_diagnostics={"image_generation_attempt_count": 3}
    )
    request = SimpleNamespace(
        tool_call={"id": "tc", "name": "bash_tool", "args": {"command": f"python {_SCRIPT} --preflight"}},
        state=state,
        runtime=SimpleNamespace(context={}, config={}),
    )
    assert mw._image_generation_block_command(request) is None


def test_outcome_none_when_enrichment_disabled():
    # Enrichment is disabled for non-image, non-pptx, non-pdf targets (e.g. HTML)
    # with no explicit imagery request — so the outcome is None.
    state = {
        "delegation_context": {"task": "Build a plain HTML page", "task_type": "frontend"},
        "builder_artifact_target_path": "/mnt/user-data/outputs/page.html",
    }
    assert _image_generation_outcome_from_state(state) is None


def test_outcome_model_skipped_when_no_attempts():
    state = _deck_state(builder_pptx_diagnostics={})
    outcome = _image_generation_outcome_from_state(state)
    assert outcome == {"attempted": 0, "succeeded": 0, "skip_reason": "model_skipped"}


def test_outcome_env_missing_from_preflight():
    state = _deck_state(
        builder_pptx_diagnostics={"image_generation_skip_reason": "env_missing"}
    )
    outcome = _image_generation_outcome_from_state(state)
    assert outcome["skip_reason"] == "env_missing"


def test_outcome_success_has_no_skip_reason():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 2,
            "image_generation_success_count": 2,
        }
    )
    outcome = _image_generation_outcome_from_state(state)
    assert outcome == {"attempted": 2, "succeeded": 2}


def test_outcome_failed_after_retry():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 2,
            "image_generation_success_count": 0,
            "image_generation_error_class": "api_error",
        }
    )
    outcome = _image_generation_outcome_from_state(state)
    assert outcome["skip_reason"] == "failed_after_retry"


def test_outcome_content_policy():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 0,
            "image_generation_error_class": "content_blocked",
        }
    )
    outcome = _image_generation_outcome_from_state(state)
    assert outcome["skip_reason"] == "content_policy"


def test_outcome_stamped_into_artifact_metadata():
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _apply_artifact_request_metadata,
    )

    state = _deck_state(builder_pptx_diagnostics={})
    artifact = {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}
    updated = _apply_artifact_request_metadata(artifact, state)
    assert updated["image_generation_outcome"]["skip_reason"] == "model_skipped"


# ---- VQ-4: hero/cover gate ----------------------------------------------------


def test_hero_gate_is_diagnostic_with_zero_generated_images():
    state = _deck_state(builder_pptx_diagnostics={})
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_passes_with_successful_image():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 1,
        }
    )
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_honors_preflight_skip():
    state = _deck_state(
        builder_pptx_diagnostics={"image_generation_skip_reason": "env_missing"}
    )
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_honors_terminal_error():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 0,
            "image_generation_error_class": "missing_api_key",
        }
    )
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_is_one_shot():
    state = _deck_state(
        builder_pptx_diagnostics={},
        builder_hero_gate_rejections=1,
    )
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_does_not_block_plain_decks_after_gate_was_softened():
    state = _deck_state()
    state["delegation_context"]["task"] = "a plain text-only deck"
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_rejection_command_does_not_block_without_render_review():
    mw = BuilderArtifactMiddleware()
    state = _deck_state(builder_pptx_diagnostics={"pptx_plan_json": {"slides": []}})
    request = SimpleNamespace(
        tool_call={"id": "tc-emit", "name": "emit_builder_artifact", "args": {}},
        state=state,
        runtime=SimpleNamespace(context={}, config={}),
    )
    result = mw._visual_gate_rejection_command(
        request, {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}
    )
    assert result is None


def test_pdf_without_image_enrichment_uses_normal_missing_file_message():
    mw = BuilderArtifactMiddleware()
    state = _pdf_state(
        builder_pptx_diagnostics={},
        builder_visual_diagnostics={"visual_asset_success_count": 1},
    )
    message = mw._emit_rejection_message(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert "cover-<desc>.png" not in message
    assert "does not exist on disk" in message


def test_hero_missing_quality_warning_after_spent_repair():
    state = _deck_state(
        builder_pptx_diagnostics={},
        builder_hero_gate_rejections=1,
    )
    updated = _apply_hero_missing_quality_metadata(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx", "confidence": 0.9},
        state,
    )
    assert updated["quality_warning"] == "hero_missing"
    assert updated["confidence"] == 0.7


def test_cover_missing_quality_warning_for_pdf():
    state = _pdf_state(
        builder_pptx_diagnostics={},
        builder_hero_gate_rejections=1,
    )
    updated = _apply_hero_missing_quality_metadata(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        state,
    )
    assert updated["quality_warning"] == "cover_missing"


def test_stronger_quality_warning_not_overwritten():
    state = _deck_state(builder_hero_gate_rejections=1, builder_pptx_diagnostics={})
    artifact = {"quality_warning": "visuals_not_embedded"}
    assert _apply_hero_missing_quality_metadata(artifact, state) is artifact
