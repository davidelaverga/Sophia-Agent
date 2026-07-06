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

import pytest
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _DECK_FLOOR_ESCAPE_FRICTION_CAP,
    _IMAGE_GENERATION_MAX_CALLS,
    _IMAGE_GENERATION_MAX_CALLS_PDF,
    BuilderArtifactMiddleware,
    _image_generation_images_in_command,
    _image_generation_invocations_in_command,
    _maybe_attach_image_trace_env,
    _parse_image_batch_summary,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _image_generation_enabled,
    _is_pdf_image_generation_target,
    _is_pptx_image_generation_target,
)
from deerflow.sandbox.tools import replace_virtual_paths_in_command, validate_local_bash_command_paths

_SCRIPT = "/mnt/skills/public/image-generation/scripts/generate.py"
_MANIFEST_SCHEMA = "sophia-pptx-image-manifest/v1"
_MANIFEST_AUTHOR = "prepare_pptx_image_manifest"


@pytest.fixture(autouse=True)
def _legacy_deck_mode_for_legacy_batch_tests(monkeypatch):
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")


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


def _manifest_payload(items: list[dict]) -> dict:
    normalized = []
    for index, item in enumerate(items, start=1):
        normalized.append(
            {
                "schema_version": _MANIFEST_SCHEMA,
                "slide_index": item.get("slide_index", index),
                "slide_visual": item.get("slide_visual", True),
                **item,
            }
        )
    return {
        "schema_version": _MANIFEST_SCHEMA,
        "manifest_author": _MANIFEST_AUTHOR,
        "items": normalized,
    }


# ---- command counting -------------------------------------------------------


def test_invocation_count_does_not_double_count_overlapping_markers():
    assert _image_generation_invocations_in_command(f"python {_SCRIPT} --x") == 1


def test_invocation_count_handles_chained_commands():
    command = f"python {_SCRIPT} --a && python {_SCRIPT} --b && python {_SCRIPT} --c"
    assert _image_generation_invocations_in_command(command) == 3


def test_invocation_count_zero_for_unrelated_commands():
    assert _image_generation_invocations_in_command("ls /mnt/user-data/outputs") == 0


def test_image_trace_env_uses_virtual_roots_before_sandbox_rewrite() -> None:
    thread_data = {
        "outputs_path": "/var/lib/deerflow/threads/t1/user-data/outputs",
        "workspace_path": "/var/lib/deerflow/threads/t1/user-data/workspace",
        "uploads_path": "/var/lib/deerflow/threads/t1/user-data/uploads",
    }
    request = SimpleNamespace(
        tool_call={
            "id": "tc-bash",
            "name": "bash",
            "args": {
                "command": f"python {_SCRIPT} --manifest /mnt/user-data/outputs/assets/slide-visuals.manifest.json"
            },
        },
        state={"thread_data": thread_data, "run_id": "run-1", "thread_id": "thread-1"},
        runtime=_runtime(),
    )

    _maybe_attach_image_trace_env(request)

    command = request.tool_call["args"]["command"]
    assert "SOPHIA_OUTPUTS_HOST_PATH=/mnt/user-data/outputs" in command
    assert "SOPHIA_WORKSPACE_HOST_PATH=/mnt/user-data/workspace" in command
    assert "/var/lib/deerflow" not in command
    validate_local_bash_command_paths(command, thread_data)
    resolved = replace_virtual_paths_in_command(command, thread_data)
    assert "SOPHIA_OUTPUTS_HOST_PATH=/var/lib/deerflow/threads/t1/user-data/outputs" in resolved
    assert "SOPHIA_WORKSPACE_HOST_PATH=/var/lib/deerflow/threads/t1/user-data/workspace" in resolved


# ---- hard cap ---------------------------------------------------------------


def test_serial_repair_below_cap_passes_after_batch_attempt():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=3,
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=3,
        image_generation_manifest_failed_count=1,
        image_generation_manifest_unresolved_outputs=["/mnt/user-data/outputs/s2.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


def test_call_beyond_cap_is_rejected_with_generated_assets_listed():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=_IMAGE_GENERATION_MAX_CALLS,
        image_generation_success_count=3,
        # A batch already ran (realistic way to reach the cap with successes) so
        # the deck-batch backstop yields and the hard image cap is what fires.
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=3,
        image_generation_manifest_failed_count=1,
        image_output_paths=["/mnt/user-data/outputs/visuals/hero-launch.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
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
        _bash_request(_deck_single_slide_command(), state)
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


# ---- deck batch-first backstop ----------------------------------------------


def _deck_single_slide_command() -> str:
    return f"python {_SCRIPT} --slide-visual --prompt-file s2.prompt.json --output-file s2.png"


def test_deck_batch_backstop_nudges_second_serial_slide_call():
    # Before a real manifest batch attempt, any SINGLE --slide-visual call is
    # the serial loop — nudge it onto the --manifest batch.
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


def test_deck_loop_breaker_fires_at_friction_cap_without_degraded_compile():
    # At the friction cap, break the loop without authorizing a placeholder deck.
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        deck_batch_rejection_count=_DECK_FLOOR_ESCAPE_FRICTION_CAP,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert result.goto == "model"
    content = result.update["messages"][0].content
    assert "[Sophia/deck-batch]" in content
    assert "artifact_path=null" in content
    assert "do not compile a partial placeholder deck" in content
    assert result.update["builder_pptx_diagnostics"]["deck_floor_escape_emitted"] is True


def test_deck_loop_breaker_terminal_fails_when_required_visuals_are_zero(monkeypatch):
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)
    state = _state_with_image_diagnostics(
        expected_generated_visual_count=4,
        successful_generated_visual_count=0,
        referenced_visual_count=0,
        missing_expected_visual_count=4,
        image_generation_success_count=0,
        image_generation_manifest_requested_count=4,
        deck_batch_rejection_count=_DECK_FLOOR_ESCAPE_FRICTION_CAP,
    )

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )

    assert isinstance(result, Command)
    assert result.goto == "end"
    assert result.update["builder_result"]["artifact_path"] is None
    assert result.update["builder_result"]["failure_code"] == "deck_batch_loop_break"
    diagnostics = result.update["builder_pptx_diagnostics"]
    assert diagnostics["deck_batch_terminal_failure"] is True
    assert diagnostics["image_generation_status"] == "failed"


def test_deck_loop_breaker_fires_on_mixed_manifest_and_batch_friction():
    # Mixed friction: one unreadable-manifest rejection + one serial-call
    # rejection sum to the cap → floor escape.
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        manifest_rejection_count=1,
        deck_batch_rejection_count=1,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "[Sophia/deck-batch]" in result.update["messages"][0].content


def test_deck_loop_breaker_is_sticky_once_emitted():
    # Once emitted, every further image-gen call keeps getting the loop-breaker
    # directive (so the model can't drift back to serial images), even at zero friction.
    state = _state_with_image_diagnostics(
        image_generation_success_count=1,
        deck_floor_escape_emitted=True,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "[Sophia/deck-batch]" in result.update["messages"][0].content


def test_deck_floor_escape_not_triggered_for_pdf_target():
    # The escape is deck-only; a PDF report below the friction cap is unaffected.
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "delegation_context": {"task_type": "document"},
        "builder_pptx_diagnostics": {
            "image_generation_success_count": 1,
            "deck_batch_rejection_count": _DECK_FLOOR_ESCAPE_FRICTION_CAP,
        },
    }
    assert BuilderArtifactMiddleware()._deck_floor_escape_command(
        _bash_request(_deck_single_slide_command(), state), state
    ) is None


def test_unreadable_manifest_rejection_increments_friction_counter(tmp_path):
    # An unreadable --manifest call (below the friction cap) is rejected AND
    # bumps authoring diagnostics so repeated failures do not unlock serial repair.
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/assets/missing.json"
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )
    assert isinstance(result, Command)
    diag = result.update["builder_pptx_diagnostics"]
    assert diag["manifest_rejection_count"] == 1
    assert diag["manifest_authoring_failure_count"] == 1
    assert diag["primary_image_batch_status"] == "failed"
    assert diag["primary_image_batch_error_class"] == "manifest_not_readable"


def test_deck_batch_backstop_rejects_hero_first_call():
    # The new contract is batch-first: cover/hero is included in the manifest.
    state = _state_with_image_diagnostics(image_generation_success_count=0)
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "including the cover/hero" in result.update["messages"][0].content


def test_deck_batch_backstop_allows_manifest_call(tmp_path):
    manifest_dir = tmp_path / "visuals"
    manifest_dir.mkdir()
    (manifest_dir / "p1.json").write_text('{"prompt":"professional visual 1"}', encoding="utf-8")
    (manifest_dir / "p2.json").write_text('{"prompt":"professional visual 2"}', encoding="utf-8")
    (manifest_dir / "manifest.json").write_text(
        json.dumps(
            _manifest_payload(
                [
                    {"prompt_file": "p1.json", "output_file": "o1.png"},
                    {"prompt_file": "p2.json", "output_file": "o2.png"},
                ]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/visuals/manifest.json"
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(command, state)
    )
    assert result is None


def test_manifest_with_missing_prompt_is_authoring_rejection(tmp_path):
    manifest_dir = tmp_path / "visuals"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        json.dumps(_manifest_payload([{"prompt_file": "missing.json", "output_file": "o1.png"}])),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/visuals/manifest.json"

    result = BuilderArtifactMiddleware()._image_generation_block_command(_bash_request(command, state))

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "prompt_file" in content
    assert "Do not switch to serial" in content
    diag = result.update["builder_pptx_diagnostics"]
    assert diag["manifest_authoring_failure_count"] == 1
    assert diag["primary_image_batch_error_class"] == "manifest_prompt_missing"


def test_manifest_with_non_output_output_file_is_authoring_rejection(tmp_path):
    manifest_dir = tmp_path / "visuals"
    manifest_dir.mkdir()
    (manifest_dir / "p1.json").write_text('{"prompt":"professional visual"}', encoding="utf-8")
    (manifest_dir / "manifest.json").write_text(
        json.dumps(
            _manifest_payload(
                [
                    {"prompt_file": "p1.json", "output_file": "/mnt/user-data/workspace/slide.png"},
                    {"prompt_file": "p1.json", "output_file": "/tmp/slide.png"},
                ]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/visuals/manifest.json"

    result = BuilderArtifactMiddleware()._image_generation_block_command(_bash_request(command, state))

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "output_file" in content
    assert "/mnt/user-data/outputs" in content
    diag = result.update["builder_pptx_diagnostics"]
    assert diag["manifest_authoring_failure_count"] == 1
    assert diag["primary_image_batch_error_class"] == "manifest_output_not_outputs"


def test_workspace_manifest_with_relative_output_is_rejected_before_batch(tmp_path):
    outputs_dir = tmp_path / "outputs"
    workspace_dir = tmp_path / "workspace"
    manifest_dir = workspace_dir / "visuals"
    manifest_dir.mkdir(parents=True)
    outputs_dir.mkdir()
    (manifest_dir / "p1.json").write_text('{"prompt":"professional visual"}', encoding="utf-8")
    (manifest_dir / "manifest.json").write_text(
        json.dumps(_manifest_payload([{"prompt_file": "p1.json", "output_file": "slide.png"}])),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_success_count=1)
    state["thread_data"] = {
        "outputs_path": str(outputs_dir),
        "workspace_path": str(workspace_dir),
    }
    command = f"python {_SCRIPT} --manifest /mnt/user-data/workspace/visuals/manifest.json"

    result = BuilderArtifactMiddleware()._image_generation_block_command(_bash_request(command, state))

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "`/mnt/user-data/outputs/`" in content
    diag = result.update["builder_pptx_diagnostics"]
    assert diag["manifest_authoring_failure_count"] == 1
    assert diag["primary_image_batch_error_class"] == "manifest_path_not_outputs"


def test_deck_batch_backstop_allows_single_repair_after_batch_ran():
    # Once a batch ran, single calls are the legitimate stray-failure repair path.
    state = _state_with_image_diagnostics(
        image_generation_success_count=5,
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=7,
        image_generation_manifest_failed_count=2,
        image_generation_manifest_unresolved_outputs=["/mnt/user-data/outputs/s2.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert result is None


def test_deck_batch_backstop_rejects_serial_repair_for_non_manifest_output():
    state = _state_with_image_diagnostics(
        image_generation_success_count=5,
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=7,
        image_generation_manifest_failed_count=2,
        image_generation_manifest_unresolved_outputs=["/mnt/user-data/outputs/assets/slide-07.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "may only target failed/missing outputs" in result.update["messages"][0].content


def test_deck_batch_backstop_rejects_repair_when_manifest_seen_but_no_generation_attempt():
    state = _state_with_image_diagnostics(
        image_generation_success_count=5,
        image_generation_manifest_seen=True,
        image_generation_manifest_requested_count=4,
        primary_image_batch_error_class="manifest_prompt_missing",
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "did not make a real batch generation attempt" in result.update["messages"][0].content


def test_deck_batch_backstop_rejects_serial_repair_after_repair_budget_spent():
    state = _state_with_image_diagnostics(
        image_generation_success_count=5,
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=7,
        image_generation_manifest_failed_count=1,
        serial_repair_count=2,
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )
    assert isinstance(result, Command)
    assert "Serial image repair is exhausted" in result.update["messages"][0].content


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


# ---- HTML-slide deck path: slide HTML authoring is allowed ------------------


def _slide_write_request(path: str, state: dict):
    return SimpleNamespace(
        tool_call={"id": "tc-wf", "name": "write_file", "args": {"path": path, "content": "<html></html>"}},
        state=state,
        runtime=_runtime(),
    )


def test_slide_html_authoring_is_allowed_for_pptx():
    # HTML-slide deck path restored (2026-06-29): authoring slides/*.html is the
    # sanctioned flow. The image-forward _slides_before_images_block_command is
    # gone, and the improvisation gate explicitly allows .html authoring.
    assert not hasattr(BuilderArtifactMiddleware, "_slides_before_images_block_command")
    state = _state_with_image_diagnostics(image_generation_success_count=1, pptx_plan_slide_count=8)
    result = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _slide_write_request("/mnt/user-data/outputs/slides/02-overview.html", state)
    )
    assert result is None


def test_transient_error_does_not_short_circuit():
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=1,
        image_generation_success_count=0,
        image_generation_error_class="api_error",
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=3,
        image_generation_manifest_failed_count=1,
        image_generation_manifest_unresolved_outputs=["/mnt/user-data/outputs/s2.png"],
    )
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
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


def test_pdf_presentation_target_uses_deck_image_generation_path():
    assert _is_pptx_image_generation_target("", "presentation") is True
    assert _is_pptx_image_generation_target(".pptx", "document") is True
    assert _is_pptx_image_generation_target(".pdf", "presentation") is True
    assert _is_pdf_image_generation_target(".pdf", "presentation") is False
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


def test_plain_text_only_deck_marker_keeps_pptx_image_forward_pipeline():
    assert _image_generation_enabled(
        {"task": "Build a plain text-only deck about our roadmap"},
        artifact_target_ext=".pptx",
        task_type="presentation",
    ) is True


def test_no_image_phrasing_keeps_pptx_image_forward_pipeline():
    for task in (
        "Build a no-image deck about our roadmap",
        "Build a no image deck about our roadmap",
        "Build a deck without images about our roadmap",
        "Build a deck with no visuals about our roadmap",
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
    # Deck cap is 30 images (a --manifest batch makes many in one call); PDF 3.
    assert _IMAGE_GENERATION_MAX_CALLS == 30
    assert _IMAGE_GENERATION_MAX_CALLS_PDF == 3


def test_images_in_command_single_call_counts_one() -> None:
    assert _image_generation_images_in_command(f"python {_SCRIPT} --prompt-file p.json --output-file o.png") == 1


def test_images_in_command_preflight_is_free() -> None:
    assert _image_generation_images_in_command(f"python {_SCRIPT} --preflight") == 0


def test_images_in_command_manifest_counts_items(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    for name in ("a", "b", "c"):
        (tmp_path / f"{name}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            {
                "items": [
                    {"prompt_file": "a.json", "output_file": "a.png"},
                    {"prompt_file": "b.json", "output_file": "b.png"},
                    {"prompt_file": "c.json", "output_file": "c.png"},
                ]
            }
        ),
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
    (tmp_path / "a.json").write_text('{"prompt":"a"}', encoding="utf-8")
    (tmp_path / "b.json").write_text('{"prompt":"b"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            {
                "items": [
                    {"prompt_file": "a.json", "output_file": "a.png"},
                    {"prompt_file": "b.json", "output_file": "b.png"},
                ]
            }
        ),
        encoding="utf-8",
    )
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


def test_manifest_batch_requires_readable_manifest_before_run(tmp_path) -> None:
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/missing.json", state)
    )

    assert isinstance(result, Command)
    assert result.goto == "model"
    message = result.update["messages"][0]
    assert message.status == "error"
    assert "manifest must be prepared" in message.content
    assert "manifest_not_readable" in message.content


def test_parse_image_batch_summary_returns_successful_paths() -> None:
    line = (
        'noise\nIMAGEGEN_BATCH {"images_generated": 2, "requested": 3, "items": ['
        '{"output_file": "a.png", "success": true},'
        '{"output_file": "b.png", "success": false},'
        '{"output_file": "c.png", "success": true}]}'
    )
    summary = _parse_image_batch_summary(line)
    assert summary["requested"] == 3
    assert summary["images_generated"] == 2
    assert summary["complete"] is False
    assert summary["successful_paths"] == ["a.png", "c.png"]


def test_parse_image_batch_summary_ignores_item_progress_lines() -> None:
    text = (
        'IMAGEGEN_BATCH {"images_generated": 1, "requested": 1, "items": ['
        '{"output_file": "a.png", "success": true}]}\n'
        'IMAGEGEN_BATCH_ITEM {"output_file": "a.png", "success": true}'
    )

    summary = _parse_image_batch_summary(text)

    assert summary["summary_present"] is True
    assert summary["requested"] == 1
    assert summary["successful_paths"] == ["a.png"]


def test_parse_image_batch_summary_missing_when_only_item_progress_exists() -> None:
    text = 'IMAGEGEN_BATCH_ITEM {"output_file": "a.png", "success": true}'

    summary = _parse_image_batch_summary(text)

    assert summary["summary_present"] is False
    assert summary["error_class"] == "batch_summary_missing"


def test_single_image_failure_emits_structured_span(tmp_path, monkeypatch) -> None:
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    prompt = tmp_path / "prompt.json"
    prompt.write_text('{"prompt":"professional technical visual"}', encoding="utf-8")
    spans = []
    monkeypatch.setattr(ba, "_safe_langsmith_span", lambda name, **kwargs: spans.append({"name": name, **kwargs}))
    state = {"thread_data": {"outputs_path": str(tmp_path)}, "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx"}
    command = (
        f"python {_SCRIPT} --prompt-file /mnt/user-data/outputs/prompt.json "
        "--output-file /mnt/user-data/outputs/missing.png"
    )

    delta = BuilderArtifactMiddleware._image_generation_bash_delta(command=command, text="", state=state)

    assert delta["image_generation_error_class"] == "missing_output"
    span = next(item for item in spans if item["name"] == "Sophia Image Single Item")
    assert span["inputs"]["prompt_readable"] is True
    assert span["outputs"]["success"] is False
    assert span["outputs"]["error_class"] == "missing_output"


def test_manifest_batch_terminal_failure_updates_image_error_class(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    for index in range(3):
        (tmp_path / f"p{index}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps({"items": [{"prompt_file": f"p{i}.json", "output_file": f"o{i}.png"} for i in range(3)]}),
        encoding="utf-8",
    )
    state = {"thread_data": {"outputs_path": str(tmp_path)}}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json"

    delta = BuilderArtifactMiddleware._image_generation_bash_delta(
        command=command,
        text="worker-1\nIMAGEGEN_FAIL reason=missing_api_key\nworker-2\n",
        state=state,
    )

    assert delta["image_generation_attempt_count"] == 0
    assert delta["image_generation_startup_attempt_count"] == 1
    assert delta["image_generation_success_count"] == 0
    assert delta["image_generation_error_class"] == "missing_api_key"


def test_manifest_batch_missing_summary_does_not_unlock_serial_repair(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    for index in range(3):
        (tmp_path / f"p{index}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            _manifest_payload(
                [
                    {"prompt_file": f"p{i}.json", "output_file": f"/mnt/user-data/outputs/o{i}.png"}
                    for i in range(3)
                ]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json"

    delta = BuilderArtifactMiddleware._image_generation_bash_delta(
        command=command,
        text="worker exited without structured summary",
        state=state,
    )

    assert delta["image_generation_attempt_count"] == 0
    assert delta["image_generation_startup_attempt_count"] == 1
    assert delta["primary_image_batch_error_class"] == "batch_summary_missing"
    assert delta["batch_summary_missing_count"] == 1
    assert delta["image_generation_manifest_generation_attempted"] is False
    assert delta["image_generation_manifest_unresolved_outputs"] == [
        "/mnt/user-data/outputs/o0.png",
        "/mnt/user-data/outputs/o1.png",
        "/mnt/user-data/outputs/o2.png",
    ]

    repaired_state = _state_with_image_diagnostics(**delta)
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), repaired_state)
    )
    assert isinstance(result, Command)
    assert "did not emit a trusted `IMAGEGEN_BATCH`" in result.update["messages"][0].content


def test_manifest_batch_missing_summary_classifies_startup_error(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    (tmp_path / "p0.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps({"items": [{"prompt_file": "p0.json", "output_file": "/mnt/user-data/outputs/o0.png"}]}),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json"
    text = "python: can't open file '/mnt/skills/public/image-generation/scripts/generate.py': [Errno 2] No such file or directory"

    delta = BuilderArtifactMiddleware._image_generation_bash_delta(
        command=command,
        text=text,
        state=state,
    )

    assert delta["primary_image_batch_error_class"] == "image_script_not_found"
    assert delta["image_generation_startup_error_class"] == "image_script_not_found"
    assert delta["image_generation_attempt_count"] == 0
    assert delta["image_generation_startup_attempt_count"] == 1
    assert delta["batch_summary_missing_count"] == 1
    assert delta["image_generation_manifest_generation_attempted"] is False
    assert "can't open file" in delta["image_generation_raw_error_excerpt"]


def test_manifest_batch_missing_summary_classifies_sandbox_path_rejection(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    (tmp_path / "p0.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps({"items": [{"prompt_file": "p0.json", "output_file": "/mnt/user-data/outputs/o0.png"}]}),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    command = f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json"
    text = (
        "Error: Unsafe absolute paths in command: "
        "/var/lib/deerflow/threads/t1/user-data/outputs. Use paths under /mnt/user-data"
    )

    delta = BuilderArtifactMiddleware._image_generation_bash_delta(
        command=command,
        text=text,
        state=state,
    )

    assert delta["primary_image_batch_error_class"] == "sandbox_path_rejected"
    assert delta["image_generation_startup_error_class"] == "sandbox_path_rejected"
    assert delta["image_generation_attempt_count"] == 0
    assert delta["image_generation_startup_attempt_count"] == 1
    assert delta["batch_summary_missing_count"] == 1


def test_second_missing_batch_summary_fails_clearly_without_serial_repair() -> None:
    state = _state_with_image_diagnostics(
        image_generation_manifest_seen=True,
        image_generation_manifest_requested_count=3,
        image_generation_manifest_failed_count=3,
        image_generation_manifest_generation_attempted=False,
        primary_image_batch_status="failed",
        primary_image_batch_error_class="image_script_not_found",
        image_generation_startup_error_class="image_script_not_found",
        batch_summary_missing_count=2,
        image_generation_manifest_unresolved_outputs=[
            "/mnt/user-data/outputs/s2.png",
            "/mnt/user-data/outputs/s3.png",
        ],
    )

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "after the allowed rerun" in content
    assert "image_script_not_found" in content
    assert "Do not attempt serial repairs" in content
    assert "artifact_path=null" in content


def test_null_pptx_emit_is_terminal_error_after_image_failure(monkeypatch) -> None:
    state = _state_with_image_diagnostics(
        image_generation_attempt_count=6,
        image_generation_success_count=0,
        image_generation_error_class="image_script_not_found",
        primary_image_batch_status="failed",
        primary_image_batch_error_class="image_script_not_found",
        image_generation_startup_error_class="image_script_not_found",
        expected_generated_visual_count=6,
        successful_generated_visual_count=0,
        missing_expected_visual_count=6,
    )
    request = SimpleNamespace(
        tool_call={
            "id": "tc-emit",
            "name": "emit_builder_artifact",
            "args": {"artifact_path": "null", "artifact_title": "Deck"},
        },
        state=state,
        runtime=_runtime(),
    )
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_upload_fallback_and_fire",
        staticmethod(lambda **_kwargs: None),
    )

    result = BuilderArtifactMiddleware()._terminal_pptx_failure_emit_command(
        request,
        request.tool_call["args"],
    )

    assert isinstance(result, Command)
    assert result.goto == "end"
    artifact = result.update["builder_result"]
    assert artifact["artifact_path"] is None
    assert artifact["status"] == "error"
    assert artifact["image_generation_status"] == "failed"
    assert artifact["image_generation_startup_error_class"] == "image_script_not_found"
    assert result.update["builder_graph_halted"] is True


def test_missing_pptx_emit_after_terminal_startup_failure_ends_with_error(monkeypatch) -> None:
    state = _state_with_image_diagnostics(
        image_generation_manifest_seen=True,
        image_generation_manifest_requested_count=6,
        image_generation_manifest_generation_attempted=False,
        image_generation_attempt_count=0,
        image_generation_startup_attempt_count=2,
        image_generation_success_count=0,
        primary_image_batch_status="failed",
        primary_image_batch_error_class="sandbox_path_rejected",
        image_generation_error_class="sandbox_path_rejected",
        image_generation_startup_error_class="sandbox_path_rejected",
        batch_summary_missing_count=2,
        expected_generated_visual_count=6,
        successful_generated_visual_count=0,
        missing_expected_visual_count=6,
    )
    request = SimpleNamespace(
        tool_call={
            "id": "tc-emit",
            "name": "emit_builder_artifact",
            "args": {"artifact_path": "/mnt/user-data/outputs/deck.pptx", "artifact_title": "Deck"},
        },
        state=state,
        runtime=_runtime(),
    )
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_upload_fallback_and_fire",
        staticmethod(lambda **_kwargs: None),
    )

    result = BuilderArtifactMiddleware()._terminal_pptx_startup_failure_emit_command(
        request,
        request.tool_call["args"],
    )

    assert isinstance(result, Command)
    assert result.goto == "end"
    artifact = result.update["builder_result"]
    assert artifact["artifact_path"] is None
    assert artifact["status"] == "error"
    assert artifact["artifact_type"] == "presentation"
    assert artifact["image_generation_status"] == "failed"
    assert artifact["image_generation_reason"] == "sandbox_path_rejected"
    assert artifact["image_generation_startup_attempt_count"] == 2
    assert artifact["image_generation_startup_error_class"] == "sandbox_path_rejected"
    assert artifact["primary_image_batch_status"] == "failed"
    assert result.update["builder_graph_halted"] is True


def test_manifest_batch_summary_uses_terminal_error_histogram() -> None:
    summary = _parse_image_batch_summary(
        'IMAGEGEN_BATCH {"requested": 3, "failed": 3, '
        '"error_class_histogram": {"auth_invalid": 3}, "items": []}'
    )

    assert summary["requested"] == 3
    assert summary["error_class"] == "auth_invalid"


def test_manifest_batch_under_cap_passes_through(tmp_path) -> None:
    # A single manifest of 12 images (under the deck cap) is allowed.
    manifest = tmp_path / "m.json"
    for index in range(12):
        (tmp_path / f"p{index}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            _manifest_payload(
                [{"prompt_file": f"p{i}.json", "output_file": f"o{i}.png"} for i in range(12)]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )
    assert result is None


def test_pptx_hand_written_manifest_is_rejected(tmp_path, monkeypatch) -> None:
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    manifest = tmp_path / "m.json"
    (tmp_path / "p0.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps({"items": [{"prompt_file": "p0.json", "output_file": "o0.png"}]}),
        encoding="utf-8",
    )
    spans = []
    monkeypatch.setattr(ba, "_safe_langsmith_span", lambda name, **kwargs: spans.append({"name": name, **kwargs}))
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "prepare_pptx_image_manifest" in content
    assert result.update["builder_pptx_diagnostics"]["primary_image_batch_error_class"] == "manifest_not_deterministic"
    span = next(item for item in spans if item["name"] == "Sophia PPTX Image Manifest Rejected")
    assert span["outputs"]["error_class"] == "manifest_not_deterministic"
    assert span["inputs"]["shape"]["top_level_keys"] == ["items"]


def test_pptx_manifest_larger_than_slide_count_is_rejected(tmp_path) -> None:
    manifest = tmp_path / "m.json"
    for index in range(18):
        (tmp_path / f"p{index}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            _manifest_payload(
                [{"prompt_file": f"p{i}.json", "output_file": f"o{i}.png"} for i in range(18)]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=0)
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    state["builder_pptx_requested_slide_count"] = 6

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "more slide-visual items than the requested deck slide count" in content
    assert "one prompt file per slide" in content


def test_manifest_batch_over_cap_is_rejected(tmp_path) -> None:
    # A manifest whose item count would exceed the remaining image budget is blocked.
    manifest = tmp_path / "m.json"
    for index in range(15):
        (tmp_path / f"p{index}.json").write_text('{"prompt":"x"}', encoding="utf-8")
    manifest.write_text(
        json.dumps(
            _manifest_payload(
                [{"prompt_file": f"p{i}.json", "output_file": f"o{i}.png"} for i in range(15)]
            )
        ),
        encoding="utf-8",
    )
    state = _state_with_image_diagnostics(image_generation_attempt_count=20)  # 20 + 15 > 30
    state["thread_data"] = {"outputs_path": str(tmp_path)}
    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(f"python {_SCRIPT} --manifest /mnt/user-data/outputs/m.json", state)
    )
    assert isinstance(result, Command)
    assert "budget reached" in result.update["messages"][0].content


def test_terminal_provider_batch_error_does_not_unlock_serial_repair() -> None:
    state = _state_with_image_diagnostics(
        image_generation_manifest_seen=True,
        image_generation_manifest_generation_attempted=True,
        image_generation_manifest_requested_count=3,
        image_generation_manifest_failed_count=3,
        primary_image_batch_error_class="auth_invalid",
        image_generation_manifest_unresolved_outputs=["/mnt/user-data/outputs/assets/slide-01.png"],
    )

    result = BuilderArtifactMiddleware()._image_generation_block_command(
        _bash_request(_deck_single_slide_command(), state)
    )

    assert isinstance(result, Command)
    content = result.update["messages"][0].content
    assert "terminal provider error" in content
    assert "artifact_path=null" in content


def test_pptx_route_selected_span_emits_once(monkeypatch) -> None:
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)
    spans = []
    monkeypatch.setattr(ba, "_safe_langsmith_span", lambda name, **kwargs: spans.append({"name": name, **kwargs}))
    state = _state_with_image_diagnostics()

    update = BuilderArtifactMiddleware().before_model(state, _runtime())

    assert update["builder_pptx_route_trace_emitted"] is True
    span = next(item for item in spans if item["name"] == "Sophia PPTX Route Selected")
    assert span["outputs"]["presentation_route"] == "deck_ir_html_raster"
    assert span["outputs"]["deck_route"] == "deck_build_service"
    assert span["outputs"]["deck_build_service_enabled"] is True
    assert span["outputs"]["model_facing_deck_tools"] == ["prepare_deck_build"]
    assert span["outputs"]["visuals_required"] is True
