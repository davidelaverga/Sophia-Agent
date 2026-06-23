"""Image-generation enrichment discipline.

Generated imagery is always offered for PPTX decks and opt-in for
non-deck/generated-image requests, so the discipline must be
harness-enforced: a hard per-build call cap, a
terminal-error short-circuit, and a one-shot stop directive after repeated
failures. These tests cover the deterministic guards in BuilderArtifactMiddleware
plus the gating policy in builder_task and the budget cost telemetry.
"""

from __future__ import annotations

from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _IMAGE_GENERATION_MAX_CALLS,
    BuilderArtifactMiddleware,
    _image_generation_invocations_in_command,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _image_generation_enabled,
    _is_pptx_image_generation_target,
)

_SCRIPT = "/mnt/skills/public/image-generation/scripts/generate.py"


def _runtime():
    return SimpleNamespace(context={}, config={})


def _bash_request(command: str, state: dict):
    return SimpleNamespace(
        tool_call={"id": "tc-bash", "name": "bash_tool", "args": {"command": command}},
        state=state,
        runtime=_runtime(),
    )


def _state_with_image_diagnostics(**diagnostics) -> dict:
    return {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_pptx_diagnostics": diagnostics,
    }


# ---- command counting -------------------------------------------------------


def test_invocation_count_does_not_double_count_overlapping_markers():
    assert _image_generation_invocations_in_command(f"python {_SCRIPT} --x") == 1


def test_invocation_count_handles_chained_commands():
    command = f"python {_SCRIPT} --a && python {_SCRIPT} --b && python {_SCRIPT} --c"
    assert _image_generation_invocations_in_command(command) == 3


def test_invocation_count_zero_for_unrelated_commands():
    assert _image_generation_invocations_in_command("ls /mnt/user-data/outputs") == 0


# ---- hard cap ---------------------------------------------------------------


def test_call_below_cap_passes_through():
    state = _state_with_image_diagnostics(image_generation_attempt_count=1)
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --prompt-file p.json", state)
    )
    assert result is None


def test_call_beyond_cap_is_rejected_with_generated_assets_listed():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=_IMAGE_GENERATION_MAX_CALLS,
        image_generation_success_count=3,
        image_output_paths=["/mnt/user-data/outputs/visuals/hero-launch.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --prompt-file p.json", state)
    )
    assert isinstance(result, Command)
    assert result.goto == "model"
    message = result.update["messages"][0]
    assert message.status == "error"
    assert "budget reached" in message.content
    assert "hero-launch.png" in message.content
    assert "Do not retry image generation" in message.content


def test_chained_command_that_would_exceed_cap_is_rejected():
    state = _state_with_image_diagnostics(image_generation_attempt_count=_IMAGE_GENERATION_MAX_CALLS - 1)
    command = f"python {_SCRIPT} --a && python {_SCRIPT} --b && python {_SCRIPT} --c"
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )
    assert isinstance(result, Command)
    assert "budget reached" in result.update["messages"][0].content


def test_chained_command_without_spaces_around_separator_counts_each_generation():
    state = _state_with_image_diagnostics(image_generation_attempt_count=_IMAGE_GENERATION_MAX_CALLS - 1)
    command = f"python {_SCRIPT} --a&&python {_SCRIPT} --b"

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "budget reached" in content
    assert "this command adds 2" in content


def test_preflight_chained_with_generation_counts_only_real_generation():
    state = _state_with_image_diagnostics(image_generation_attempt_count=_IMAGE_GENERATION_MAX_CALLS)
    command = f"python {_SCRIPT} --preflight && python {_SCRIPT} --slide-visual --prompt-file p.json"

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "budget reached" in content
    assert "this command adds 1" in content


def test_non_bash_tools_are_ignored():
    request = SimpleNamespace(
        tool_call={"id": "tc-w", "name": "write_file_tool", "args": {"command": _SCRIPT}},
        state=_state_with_image_diagnostics(image_generation_attempt_count=9),
        runtime=_runtime(),
    )
    assert BuilderArtifactMiddleware()._image_generation_block_command(request) is None


# ---- terminal-error short-circuit -------------------------------------------


def test_terminal_error_short_circuits_after_single_failure():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=1,
        image_generation_success_count=0,
        image_generation_error_class="missing_api_key",
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --prompt-file p.json", state)
    )
    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "unavailable" in content
    assert "missing_api_key" in content
    assert "artifact_path=null" in content
    assert "PDF" in content
    assert "local chart, table, diagram, and prose" in content


def test_preflight_chained_with_generation_honors_terminal_error_short_circuit():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=1,
        image_generation_success_count=0,
        image_generation_error_class="missing_api_key",
    )
    command = f"python {_SCRIPT} --preflight && python {_SCRIPT} --slide-visual --prompt-file p.json"

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "unavailable" in content
    assert "missing_api_key" in content


def test_transient_error_does_not_short_circuit():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=1,
        image_generation_success_count=0,
        image_generation_error_class="api_error",
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --prompt-file p.json", state)
    )
    assert result is None


# ---- stop directive ----------------------------------------------------------


def test_stop_directive_after_two_failed_attempts():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=2,
        image_generation_success_count=0,
        image_generation_error_class="api_error",
    )
    update = BuilderArtifactMiddleware()._maybe_inject_image_generation_stop(state)
    assert isinstance(update, dict)
    assert update["builder_image_generation_stop_emitted"] is True
    assert "[Sophia/image-generation stop]" in update["messages"][0].content


def test_stop_directive_is_idempotent():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=4,
        image_generation_success_count=0,
    )
    state["builder_image_generation_stop_emitted"] = True
    assert BuilderArtifactMiddleware()._maybe_inject_image_generation_stop(state) is None


def test_stop_directive_not_emitted_after_success():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=3,
        image_generation_success_count=1,
    )
    assert BuilderArtifactMiddleware()._maybe_inject_image_generation_stop(state) is None


# ---- gating policy ----------------------------------------------------------


def test_presentation_task_enables_image_generation_by_default():
    assert _image_generation_enabled(
        {"task": "Build an investor deck about our roadmap"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_presentation_task_fallback_only_applies_without_resolved_extension():
    assert _is_pptx_image_generation_target("", "presentation") is True
    assert _is_pptx_image_generation_target(".pptx", "document") is True
    assert _is_pptx_image_generation_target(".pdf", "presentation") is False
    assert _image_generation_enabled(
        {"task": "Build a presentation and export it as a PDF"},
        artifact_target_ext=".pdf",
        task_type="presentation",
    ) is False


def test_polished_presentation_task_enables_image_generation():
    assert _image_generation_enabled(
        {"task": "Build a polished visual keynote-style deck about our roadmap"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_chart_presentation_still_enables_deck_images():
    assert _image_generation_enabled(
        {"task": "Build a deck with charts and diagrams about our roadmap"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_visual_report_task_does_not_enable_image_generation_by_default():
    assert _image_generation_enabled(
        {"task": "Quarterly visual report"},
        artifact_target_ext=".html",
        task_type="visual_report",
    ) is False


def test_explicit_image_request_enables_generation():
    assert _image_generation_enabled(
        {"task": "Build a deck and generate an image for the title slide"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_plain_deck_marker_does_not_opt_out():
    assert _image_generation_enabled(
        {"task": "Build a plain text-only deck about our roadmap"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_no_image_phrasing_does_not_opt_out_of_deck_images():
    for task in (
        "Build a no-image deck about our roadmap",
        "Build a no image deck about our roadmap",
        "Build a deck without images about our roadmap",
    ):
        assert _image_generation_enabled(
            {"task": task},
            artifact_target_ext=".pptx",
            task_type="presentation",
        ) is True


def test_bare_plain_style_does_not_disable_requested_deck_images():
    assert _image_generation_enabled(
        {"task": "Build a plain-English deck with illustrations"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True
    assert _image_generation_enabled(
        {"task": "Build plain summary slides with generated images"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_explain_does_not_match_plain_opt_out():
    assert _image_generation_enabled(
        {"task": "Build a presentation explaining the architecture"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_minimal_style_still_allows_default_deck_images():
    assert _image_generation_enabled(
        {"task": "A minimal deck, just bullets"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_document_task_stays_off_without_explicit_markers():
    assert _image_generation_enabled(
        {"task": "Write a markdown report"},
        artifact_target_ext=".md",
        task_type="document",
    ) is False


def test_image_target_stays_on():
    assert _image_generation_enabled(
        {"task": "plain image please"},
        artifact_target_ext=".png",
        task_type="document",
    ) is True


def test_explicit_marker_still_wins_for_documents():
    assert _image_generation_enabled(
        {"task": "Write a doc with a generated image of a lighthouse"},
        artifact_target_ext=".md",
        task_type="document",
    ) is True
