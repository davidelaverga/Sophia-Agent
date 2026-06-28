"""Image-generation enrichment discipline.

Generated imagery is always offered for PPTX decks and opt-in for
non-deck/generated-image requests, so the discipline must be
harness-enforced: a hard per-build call cap, a
terminal-error short-circuit, and a one-shot stop directive after repeated
failures. These tests cover the deterministic guards in BuilderArtifactMiddleware
plus the gating policy in builder_task and the budget cost telemetry.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _DECK_BATCH_REJECTION_CAP,
    _IMAGE_GENERATION_MAX_CALLS,
    _IMAGE_GENERATION_MAX_CALLS_PDF,
    BuilderArtifactMiddleware,
    _image_generation_images_in_command,
    _image_generation_invocations_in_command,
    _parse_image_batch_summary,
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
        # A batch already ran (realistic way to reach the cap with successes) so
        # the deck-batch backstop yields and the hard image cap is what fires.
        image_generation_manifest_seen=True,
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


# ---- deck hero-anchor batch backstop ----------------------------------------


def _deck_single_slide_command() -> str:
    return f"python {_SCRIPT} --slide-visual --prompt-file s2.prompt.json --output-file s2.png"


def test_deck_batch_backstop_nudges_second_serial_slide_call():
    # Hero already generated (success_count=1); a second SINGLE --slide-visual
    # call is the serial loop — nudge it onto the --manifest batch once.
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert result.goto == "model"
    content = result.update["messages"][0].content
    assert "[Sophia/deck-batch]" in content
    assert "--manifest" in content
    # Each rejection increments the safety-valve counter (summing reducer).
    assert result.update["builder_pptx_diagnostics"]["deck_batch_rejection_count"] == 1


def test_deck_batch_backstop_rejects_bare_generate_py_single_call():
    # Broadened detection: a post-hero single call WITHOUT --slide-visual (a bare
    # generate.py invocation) is still the serial loop and must be rejected — the
    # prior --slide-visual-only matcher missed these (prod 019f0b8a).
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    command = f"python {_SCRIPT} --prompt-file s2.prompt.json --output-file s2.png"
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )
    assert isinstance(result, Command)
    assert "[Sophia/deck-batch]" in result.update["messages"][0].content


def test_deck_batch_backstop_keeps_rejecting_until_manifest():
    # NOT one-shot: after one prior rejection (count=1, below the cap) a further
    # serial call is STILL rejected — the prior one-shot let the model keep
    # serializing (prod 019f0b8a: 0 nudges logged, ~9 serial calls).
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        deck_batch_rejection_count=1,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "[Sophia/deck-batch]" in result.update["messages"][0].content


def test_deck_batch_backstop_safety_valve_yields_at_cap():
    # Bounded safety valve: at the rejection cap, stop rejecting so a model that
    # genuinely cannot author a manifest still ships (serial) instead of looping.
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        deck_batch_rejection_count=_DECK_BATCH_REJECTION_CAP,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


def test_deck_batch_backstop_allows_hero_first_call():
    # No slide generated yet (success_count=0): the hero call must pass.
    state = _state_with_image_diagnostics(image_generation_success_count=0)
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


def test_deck_batch_backstop_allows_manifest_call():
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/visuals/manifest.json"
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )
    assert result is None


def test_deck_batch_backstop_allows_single_repair_after_batch_ran():
    # Once a batch ran, single calls are the legitimate stray-failure repair path.
    state = _state_with_image_diagnostics(
        image_generation_success_count=5,
        image_generation_manifest_seen=True,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


def test_deck_batch_backstop_only_fires_for_pptx():
    # A PDF report's bounded conceptual image must not be redirected to a deck batch.
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "delegation_context": {"task_type": "document"},
        "builder_pptx_diagnostics": {"image_generation_success_count": 1},
    }
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


# ---- images-before-slides ordering guard ------------------------------------


def _slide_write_request(path: str, state: dict):
    return SimpleNamespace(
        tool_call={"id": "tc-wf", "name": "write_file", "args": {"path": path, "content": "<html></html>"}},
        state=state,
        runtime=_runtime(),
    )


def test_slides_before_images_blocks_authoring_before_images():
    # Target known (plan=8), only the hero generated (success=1): authoring a
    # slide HTML now forces a re-author once images land — nudge once.
    state = _state_with_image_diagnostics(image_generation_success_count=1, pptx_plan_slide_count=8)
    result = BuilderArtifactMiddleware()._slides_before_images_block_command(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert isinstance(result, Command)
    assert "[Sophia/deck-order]" in result.update["messages"][0].content
    assert result.update["builder_pptx_diagnostics"]["slides_before_images_directive_emitted"] is True


def test_slides_before_images_allows_when_all_images_present():
    state = _state_with_image_diagnostics(image_generation_success_count=8, pptx_plan_slide_count=8)
    result = BuilderArtifactMiddleware()._slides_before_images_block_command(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert result is None


def test_slides_before_images_allows_after_batch_seen():
    state = _state_with_image_diagnostics(
        image_generation_success_count=2,
        pptx_plan_slide_count=8,
        image_generation_manifest_seen=True,
    )
    result = BuilderArtifactMiddleware()._slides_before_images_block_command(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert result is None


def test_slides_before_images_is_one_shot():
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        pptx_plan_slide_count=8,
        slides_before_images_directive_emitted=True,
    )
    result = BuilderArtifactMiddleware()._slides_before_images_block_command(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert result is None


def test_slides_before_images_allows_when_target_unknown():
    # No plan/requested count: can't determine readiness — never block.
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    result = BuilderArtifactMiddleware()._slides_before_images_block_command(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert result is None


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
    # A .pdf target now enables conceptual image-gen (bounded to 3) regardless
    # of the originating task_type.
    assert _image_generation_enabled(
        {"task": "Build a presentation and export it as a PDF"},
        artifact_target_ext=".pdf",
        task_type="presentation",
    ) is True


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


# ---- image-count accounting (2026-06-24: cap counts IMAGES, not invocations) --


def test_image_caps_are_image_counts() -> None:
    # Deck cap is 20 images (a --manifest batch makes many in one call); PDF 3.
    assert _IMAGE_GENERATION_MAX_CALLS == 20
    assert _IMAGE_GENERATION_MAX_CALLS_PDF == 3


def test_images_in_command_single_call_counts_one() -> None:
    assert _image_generation_images_in_command(f"python {_SCRIPT} --prompt-file p.json --output-file o.png") == 1


def test_images_in_command_preflight_is_free() -> None:
    assert _image_generation_images_in_command(f"python {_SCRIPT} --preflight") == 0


def test_images_in_command_manifest_counts_items(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    manifest.write_text(
        '{"items": [{"prompt_file": "a"}, {"prompt_file": "b"}, {"prompt_file": "c"}]}',
        encoding="utf-8",
    )
    state = {"thread_data": {"outputs_path": str(tmp_path)}}
    count = _image_generation_images_in_command(
        f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json",
        state,
    )
    assert count == 3


def test_images_in_command_mixed_hero_then_batch(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    manifest.write_text('{"items": [{"prompt_file": "a"}, {"prompt_file": "b"}]}', encoding="utf-8")
    state = {"thread_data": {"outputs_path": str(tmp_path)}}
    command = (
        f"python {_SCRIPT} --slide-visual --prompt-file hero.json --output-file hero.png"
        f" && python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json"
    )
    assert _image_generation_images_in_command(command, state) == 3  # 1 hero + 2 batch


def test_manifest_unreadable_falls_back_to_one(tmp_path) -> None:
    # An unreadable manifest must count as >=1 so it never silently bypasses the cap.
    state = {"thread_data": {"outputs_path": str(tmp_path)}}
    assert (
        _image_generation_images_in_command(
            f"python {_SCRIPT} --manifest /mnt/user-data/outputs/missing.json",
            state,
        )
        == 1
    )


def test_parse_image_batch_summary_returns_successful_paths() -> None:
    line = (
        'noise\nIMAGEGEN_BATCH {"images_generated": 2, "requested": 3, "items": ['
        '{"output_file": "a.png", "success": true},'
        '{"output_file": "b.png", "success": false},'
        '{"output_file": "c.png", "success": true}]}'
    )
    requested, paths = _parse_image_batch_summary(line)
    assert requested == 3
    assert paths == ["a.png", "c.png"]


def test_manifest_batch_under_cap_passes_through(tmp_path) -> None:
    # A single manifest of 12 images (under the 20 deck cap) is allowed.
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"items": [{"prompt_file": f"p{i}"} for i in range(12)]}), encoding="utf-8")
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )
    assert result is None


def test_manifest_batch_over_cap_is_rejected(tmp_path) -> None:
    # A manifest whose item count would exceed the remaining image budget is blocked.
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"items": [{"prompt_file": f"p{i}"} for i in range(15)]}), encoding="utf-8")
    state = _state_with_image_diagnostics(image_generation_attempt_count=10)  # 10 + 15 > 20
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )
    assert isinstance(result, Command)
    assert "budget reached" in result.update["messages"][0].content
