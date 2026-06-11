"""Spec VQ-3/4/5 — enrichment outcome accounting, hero/cover gate, PDF scope.

Prod 2026-06-11 (F5): Sonnet silently skipped gpt-image enrichment on the
primary provider — prompt-only policy produced zero generated images with no
signal. These gates make the outcome explicit and the hero enforced (one
bounded repair turn), and extend enrichment to visuals-requested PDFs.
"""

from __future__ import annotations

from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_hero_missing_quality_metadata,
    _builder_image_enrichment_enabled,
    _image_generation_outcome_from_state,
    _image_generation_preflight_delta,
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


def test_visuals_requested_pdf_enables_enrichment():
    assert _image_generation_enabled(
        {"task": "Create a technical PDF with diagrams and visuals"},
        artifact_target_ext=".pdf",
        task_type="document",
    ) is True


def test_plain_pdf_stays_off():
    assert _image_generation_enabled(
        {"task": "Write a markdown-style PDF summary"},
        artifact_target_ext=".pdf",
        task_type="document",
    ) is False


def test_enrichment_enabled_mirror_reads_state():
    assert _builder_image_enrichment_enabled(_deck_state()) is True
    assert _builder_image_enrichment_enabled(_pdf_state()) is True
    assert _builder_image_enrichment_enabled(_pdf_state(task="plain text summary")) is False


def test_pdf_cap_is_two():
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _image_generation_max_calls,
    )

    assert _image_generation_max_calls(_pdf_state()) == 2
    assert _image_generation_max_calls(_deck_state()) == 3


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
    state = _pdf_state(task="plain text summary")
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


def test_hero_gate_blocks_first_emit_with_zero_generated_images():
    state = _deck_state(builder_pptx_diagnostics={})
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is True


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


def test_hero_gate_off_for_plain_decks():
    state = _deck_state()
    state["delegation_context"]["task"] = "a plain text-only deck"
    assert BuilderArtifactMiddleware._hero_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    ) is False


def test_hero_gate_rejection_command_increments_counter():
    mw = BuilderArtifactMiddleware()
    state = _deck_state(builder_pptx_diagnostics={})
    request = SimpleNamespace(
        tool_call={"id": "tc-emit", "name": "emit_builder_artifact", "args": {}},
        state=state,
        runtime=SimpleNamespace(context={}, config={}),
    )
    result = mw._visual_gate_rejection_command(
        request, {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}
    )
    assert isinstance(result, Command)
    assert result.update["builder_hero_gate_rejections"] == 1
    message = result.update["messages"][0]
    assert "--preflight" in message.content
    assert "full_bleed_image" in message.content


def test_pdf_hero_gate_message_names_cover():
    # Visual presence satisfied (charts embedded) so the visual gate defers
    # to the hero/cover gate — realistic sequence: charts first, cover next.
    mw = BuilderArtifactMiddleware()
    state = _pdf_state(
        builder_pptx_diagnostics={},
        builder_visual_diagnostics={"visual_asset_success_count": 1},
    )
    message = mw._emit_rejection_message(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert "cover-<desc>.png" in message


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
