"""Tests for ``make_update_async_task_wrapper`` — Phase 2B terminal-thread guard.

The native deepagents ``update_async_task`` creates a new run on the
target builder thread unconditionally. When the target thread has
already reached terminal status, the new run inherits a completed
message history and loops on dangling tool calls (observed in
production at 2026-05-20 19:53–19:57 UTC, ~3.5 min of repeated
``Injecting/reordering 1 ToolMessage(s) for dangling/misplaced tool
calls`` warnings on a single locked worker).

The wrapper:
- On terminal target — returns a directive string and does NOT call
  the native dispatch.
- On non-terminal target — delegates to the native ``coroutine`` / ``func``
  so the existing SDK dispatch logic is preserved exactly.
- Forwards the args (``task_id``, ``message``, ``runtime``) unchanged.
"""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from deerflow.sophia.tools.start_builder_task import _has_active_builder_task
from deerflow.sophia.tools.update_async_task_wrapper import (
    make_update_async_task_wrapper,
)

# ---- helpers ---------------------------------------------------------------


def _make_native_tool(
    name: str = "update_async_task",
    description: str = "native desc",
    args_schema=None,
):
    """Build a fake StructuredTool-shaped object whose ``func`` / ``coroutine``
    record their call args so tests can assert delegation occurred.

    ``args_schema`` defaults to the real deepagents ``UpdateAsyncTaskSchema``
    so the StructuredTool produced by the wrapper has production-shaped
    model-facing args (``task_id``, ``message``).
    """
    if args_schema is None:
        # Lazy import so the module doesn't blow up if deepagents changes
        # location at some point — falls back to None if not importable.
        try:
            from deepagents.middleware.async_subagents import UpdateAsyncTaskSchema
            args_schema = UpdateAsyncTaskSchema
        except ImportError:
            args_schema = None

    sync_calls: list[dict] = []
    async_calls: list[dict] = []

    def native_func(*, task_id, message, runtime):
        sync_calls.append({"task_id": task_id, "message": message, "runtime": runtime})
        return f"native-sync({task_id})"

    async def native_coroutine(*, task_id, message, runtime):
        async_calls.append({"task_id": task_id, "message": message, "runtime": runtime})
        return f"native-async({task_id})"

    native = SimpleNamespace(
        name=name,
        description=description,
        func=native_func,
        coroutine=native_coroutine,
        args_schema=args_schema,
    )
    return native, sync_calls, async_calls


def _runtime(async_tasks: dict | None, tool_call_id: str = "tc-test") -> SimpleNamespace:
    return SimpleNamespace(
        state={"async_tasks": async_tasks or {}},
        tool_call_id=tool_call_id,
    )


def _redirect_text(response):
    """Extract the redirect prose from either a plain-string return (cache-
    terminal branch) or a Command return (live-terminal branch). Returns
    "" for non-redirect responses so substring assertions degrade gracefully."""
    if isinstance(response, str):
        return response
    if isinstance(response, Command):
        for msg in response.update.get("messages", []):
            if isinstance(msg, ToolMessage):
                return msg.content
            content = getattr(msg, "content", None)
            if isinstance(content, str):
                return content
    return ""


# ---- E.3: terminal-redirect uses prior artifact_path ----------------------


def test_terminal_redirect_includes_prior_artifact_path_when_present():
    """Phase 2E.3: when the terminal builder produced a real artifact, the
    redirect prose names the prior path and instructs the new build to
    READ + EDIT the existing file rather than re-research from scratch.
    Saves ~3-5x runtime for small edits to delivered artifacts."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": "research",
                "artifact_path": "/mnt/user-data/outputs/recursive_llms_research.md",
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add TTS section", runtime=runtime)
    assert isinstance(response, str)
    # The prior artifact path is named explicitly.
    assert "/mnt/user-data/outputs/recursive_llms_research.md" in response
    # Read + edit pattern is described.
    lower = response.lower()
    assert "read" in lower
    assert "do not re-research" in lower or "build on what's already there" in lower
    # Still names start_builder_task as the tool to call next.
    assert "start_builder_task" in response


def test_terminal_redirect_falls_back_when_no_prior_artifact_path():
    """If the tracked entry has no ``artifact_path`` (e.g. builder ended in
    error before emitting one), the redirect uses the generic "v2 brief"
    prose without naming a path. This is the existing Phase 2B behaviour."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "error",
                "task_type": "research",
                # No artifact_path.
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="retry", runtime=runtime)
    assert isinstance(response, str)
    assert "start_builder_task" in response
    # No specific path is named (none to name).
    assert "/mnt/user-data/outputs/" not in response


def test_terminal_redirect_artifact_path_handles_non_string_safely():
    """Defensive: if artifact_path is None or a non-string (corrupt state),
    the redirect falls through to the generic prose without crashing."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    for bad_path in (None, 123, {"nope": True}, ""):
        runtime = _runtime(
            {
                "task-1": {
                    "task_id": "task-1",
                    "agent_name": "sophia_builder",
                    "status": "success",
                    "task_type": "document",
                    "artifact_path": bad_path,
                }
            }
        )
        response = wrapped.func(task_id="task-1", message="add Y", runtime=runtime)
        assert isinstance(response, str)
        assert "start_builder_task" in response


# ---- Codex P1: terminal-redirect must emit a VALID task_type --------------


def test_terminal_redirect_falls_back_to_canonical_task_type_when_tracked_missing():
    """Codex P1 review 2026-05-22: after a mid-build update_async_task
    interrupt, deepagents-native rewrites async_tasks[task_id] without
    necessarily preserving ``task_type``. The redirect previously
    defaulted to ``"build"`` which is NOT in StartBuilderTaskInput's
    accepted set {document, research, presentation, frontend,
    visual_report}. The follow-up start_builder_task call would then
    fail validation.

    Fix: ``_safe_task_type`` falls back to delegation_context, then to
    "document" (canonical). The redirect prose must NEVER emit
    ``task_type="build"`` or any other non-canonical value.
    """
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(
        state={
            "async_tasks": {
                "t1": {
                    "task_id": "t1",
                    "agent_name": "sophia_builder",
                    "status": "success",
                    # NO task_type — the failure mode the reviewer flagged.
                },
            },
            # delegation_context preserves task_type even when tracked drops it.
            "delegation_context": {"task_type": "research", "task": "brief"},
        },
        tool_call_id="tc-x",
    )
    response = wrapped.func(task_id="t1", message="add X", runtime=runtime)
    # Recovered from delegation_context.
    assert 'task_type="research"' in response
    # Forbidden values must not appear.
    assert 'task_type="build"' not in response


def test_terminal_redirect_defaults_to_document_when_nothing_available():
    """When neither tracked nor delegation_context has a valid task_type,
    fall back to ``"document"`` (the safest canonical default) rather
    than ``"build"`` (which is invalid)."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(
        state={
            "async_tasks": {
                "t1": {
                    "task_id": "t1",
                    "agent_name": "sophia_builder",
                    "status": "error",
                    # No task_type anywhere.
                },
            },
            # No delegation_context either.
        },
        tool_call_id="tc-x",
    )
    response = wrapped.func(task_id="t1", message="retry", runtime=runtime)
    assert 'task_type="document"' in response
    assert 'task_type="build"' not in response


def test_terminal_redirect_rejects_invalid_task_type_from_tracked():
    """Defensive: if `tracked["task_type"]` somehow contains a value
    outside the canonical set (state corruption, schema drift), fall
    back to delegation_context / document — don't emit the bad value."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(
        state={
            "async_tasks": {
                "t1": {
                    "task_id": "t1",
                    "agent_name": "sophia_builder",
                    "status": "success",
                    "task_type": "garbage_invalid_value",
                },
            },
            "delegation_context": {"task_type": "presentation"},
        },
        tool_call_id="tc-x",
    )
    response = wrapped.func(task_id="t1", message="add X", runtime=runtime)
    assert 'task_type="presentation"' in response
    assert "garbage_invalid_value" not in response


@pytest.mark.parametrize(
    "canonical", ["document", "research", "presentation", "frontend", "visual_report"]
)
def test_terminal_redirect_passes_through_canonical_task_types(canonical):
    """When tracked has a canonical task_type, that exact value is used.
    Parametrized over all 5 valid values to lock the canonical set."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "t1": {
                "task_id": "t1",
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": canonical,
            }
        }
    )
    response = wrapped.func(task_id="t1", message="add X", runtime=runtime)
    assert f'task_type="{canonical}"' in response


# ---- Codex P2: successful-vs-failed terminal redirect prose ---------------


@pytest.mark.parametrize(
    "failed_status",
    ["error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_terminal_redirect_failed_does_not_claim_artifact_delivered(failed_status):
    """Codex P2 review 2026-05-22: when the prior terminal build ENDED
    IN FAILURE (error / failed / cancelled / timeout / timed_out), the
    redirect prose must NOT claim "the artifact has been delivered to
    the user" — no artifact exists. Telling the model otherwise would
    guide it to reference a non-existent file in the new v2 brief."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": failed_status,
                "task_type": "research",
            }
        }
    )
    response = wrapped.func(task_id="task-1", message="retry with X", runtime=runtime)
    assert isinstance(response, str)
    lower = response.lower()
    # MUST NOT claim delivery.
    assert "has already been delivered" not in lower
    assert "the user has it" not in lower
    assert "the user has the prior" not in lower
    # MUST say NO artifact was delivered.
    assert "no artifact was delivered" in lower or "no deliverable was produced" in lower
    # MUST reference the failure status.
    assert failed_status in response


@pytest.mark.parametrize(
    "failed_status",
    ["error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_terminal_redirect_failed_steers_to_fresh_start(failed_status):
    """Failed-terminal redirect must instruct the model to start FRESH,
    not "build on the prior artifact" / "read the existing file"."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": failed_status,
                "task_type": "document",
            }
        }
    )
    response = wrapped.func(task_id="task-1", message="retry", runtime=runtime)
    assert isinstance(response, str)
    lower = response.lower()
    # Anti-pattern guards: must NOT suggest reading/editing the prior file.
    assert "read the existing artifact" not in lower
    assert "build on what's already there" not in lower
    # Must instruct fresh start.
    assert "fresh" in lower or "clean slate" in lower or "complete brief" in lower
    # Still uses start_builder_task as the launch tool.
    assert "start_builder_task" in response


def test_terminal_redirect_failed_ignores_stray_artifact_path():
    """Defensive: if tracked.artifact_path is somehow populated on a
    failed run (e.g. partial state from a half-completed prior dispatch),
    the redirect must STILL not claim delivery. We treat 'failed' as
    authoritative regardless of stray path fields."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "error",
                "task_type": "research",
                # Stray path field that should NOT be used because the
                # build failed before it could be delivered.
                "artifact_path": "/mnt/user-data/outputs/half-written.md",
            }
        }
    )
    response = wrapped.func(task_id="task-1", message="retry", runtime=runtime)
    lower = response.lower()
    assert "has already been delivered" not in lower
    # Failed-branch fresh-start language present.
    assert "no deliverable was produced" in lower or "no artifact was delivered" in lower


@pytest.mark.parametrize("successful_status", ["success", "completed"])
def test_terminal_redirect_successful_keeps_artifact_delivered_claim(successful_status):
    """The success branch must still claim delivery so the model knows
    the user already has the prior version and the v2 brief can
    reference it."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": successful_status,
                "task_type": "research",
                "artifact_path": "/mnt/user-data/outputs/recursive_llms.md",
            }
        }
    )
    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)
    assert isinstance(response, str)
    lower = response.lower()
    # Success branch: claim delivery + steer to read-edit.
    assert "delivered to" in lower
    assert "the user has it" in lower or "user has it" in lower
    assert "/mnt/user-data/outputs/recursive_llms.md" in response


# ---- Codex P1: directive gates write_file prescription by target type --


@pytest.mark.parametrize("binary_task_type", ["visual_report"])
def test_directive_binary_task_type_does_not_prescribe_write_file_for_binary(binary_task_type):
    """Codex P1 review 2026-05-22: binary deliverables (.pptx /.pdf)
    cannot be authored by write_file — they need a generator
    script run via bash_tool. The directive must NOT tell the model
    "MUST use write_file" for these task_types."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add a section on X",
        tracked={"task_id": "t1", "task_type": binary_task_type},
        delegation_context={"task": "build the deck", "task_type": binary_task_type},
    )
    # Anti-pattern guard: must NOT say "write_file" can author the binary.
    assert "MUST use write_file" not in augmented
    assert "extend via `append=True` chunks" not in augmented
    # Must instruct the script + bash approach.
    assert "BINARY" in augmented
    assert "generator script" in augmented.lower()
    assert "bash_tool" in augmented
    # Final-path requirement still present.
    assert "/mnt/user-data/outputs/" in augmented


def test_directive_pptx_target_requires_presentation_skill_workflow():
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add a section on X",
        tracked={"task_id": "t1", "task_type": "presentation"},
        delegation_context={"task": "build the deck", "task_type": "presentation"},
    )

    assert "PPTX slide-deck update" in augmented
    assert "/mnt/skills/public/ppt-generation/SKILL.md" in augmented
    assert "/mnt/skills/public/image-generation/scripts/generate.py" in augmented
    assert "/mnt/skills/public/ppt-generation/scripts/generate.py" in augmented
    assert "write_file(description=..." in augmented


@pytest.mark.parametrize("text_task_type", ["document", "research", "frontend"])
def test_directive_text_task_type_keeps_write_file_prescription(text_task_type):
    """Text deliverables (markdown, html, plain text) DO use
    write_file. The directive must keep the canonical write_file
    guidance for those task_types."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add a section on X",
        tracked={"task_id": "t1", "task_type": text_task_type},
        delegation_context={"task": "build the doc", "task_type": text_task_type},
    )
    # Canonical write_file prescription is present.
    assert "write_file(description=" in augmented
    assert "path=..." in augmented
    assert "content=..." in augmented
    assert "append=True" in augmented
    # Binary-only prose is NOT mixed in.
    assert "BINARY" not in augmented
    assert "generator script" not in augmented.lower()


def test_directive_missing_task_type_defaults_to_text_branch():
    """When task_type is missing entirely, default to the text-output
    branch (write_file) so we don't accidentally tell a typical
    markdown build to use a generator script."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add X",
        tracked={"task_id": "t1"},  # no task_type
        delegation_context={"task": "the brief"},  # no task_type
    )
    assert "write_file(description=" in augmented
    assert "append=True" in augmented
    assert "BINARY" not in augmented


def test_directive_unknown_task_type_defaults_to_text_branch():
    """Defensive: a task_type the wrapper doesn't recognize falls into
    the text branch so the model gets the more common guidance."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add X",
        tracked={"task_id": "t1", "task_type": "exotic_unknown"},
        delegation_context={"task": "the brief", "task_type": "exotic_unknown"},
    )
    assert "write_file(description=" in augmented
    assert "BINARY" not in augmented


def test_directive_visual_report_html_target_uses_text_writer():
    """A visual_report can still be an HTML document. The concrete target
    extension, not task_type, must choose the authoring workflow."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add one chart",
        tracked={
            "task_id": "t1",
            "task_type": "visual_report",
            "artifact_target_path": "/mnt/user-data/outputs/report.html",
        },
        delegation_context={
            "task": "Build an HTML document with charts and diagrams",
            "task_type": "visual_report",
        },
    )

    assert "Concrete file target: `/mnt/user-data/outputs/report.html`" in augmented
    assert "write_file(description=" in augmented
    assert "BINARY" not in augmented
    assert "generator script" not in augmented.lower()


def test_directive_visual_report_pdf_target_keeps_binary_guidance():
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add one chart",
        tracked={
            "task_id": "t1",
            "task_type": "visual_report",
            "artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        },
        delegation_context={"task": "Build a visual report", "task_type": "visual_report"},
    )

    assert "BINARY" in augmented
    assert "generator script" in augmented.lower()


# ---- F.1: slug-derived filename + resume-not-restart directive ------------


def test_augment_prefix_carries_slug_derived_filename_from_delegation_context():
    """Phase 2F.1: when delegation_context['task'] is present, derive a
    deterministic slugged filename and include it in the directive so the
    builder has a concrete file target to write to.

    Without this, the post-interrupt builder invents random filenames
    (``test.md``, ``test2.md``, etc.) and loops on PermissionError."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    delegation = {
        "task": "Build a comprehensive markdown document on recursive LLMs research",
        "task_type": "research",
    }
    augmented = _augment_update_message(
        message="add a section on Karpathy autoresearch",
        tracked={"task_id": "t1", "task_type": "research"},
        delegation_context=delegation,
    )
    # Concrete file target named explicitly.
    assert "/mnt/user-data/outputs/" in augmented
    assert ".md" in augmented
    # Slug derived from description.
    assert "build-a-comprehensive-markdown-document" in augmented
    # Directive is PREFIXED, not appended — the user message follows.
    user_idx = augmented.find("add a section on Karpathy autoresearch")
    marker_idx = augmented.find("[Sophia/post-interrupt build directive]")
    assert marker_idx >= 0
    assert user_idx > marker_idx, (
        "Phase 2F.1: directive must precede the user message so the model "
        "anchors on the directive at the top of the new HumanMessage"
    )


def test_augment_prefix_preserves_research_but_requires_new_url_fetch():
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="also include https://github.com/RecursiveMAS/RecursiveMAS",
        tracked={"task_id": "t1", "task_type": "research"},
        delegation_context={"task": "Build a report", "task_type": "research"},
    )

    assert "DO NOT re-run web_search" not in augmented
    assert "builder_web_search" in augmented or "builder_web_fetch" in augmented
    assert "Before editing the deliverable" in augmented


def test_augment_prefix_includes_resume_not_restart_language():
    """The directive must explicitly tell the model it is RESUMING, not
    re-running from scratch. Without this language the model re-runs
    research it already did pre-interrupt (Phase 2F root cause)."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add X",
        tracked={"task_id": "t1", "task_type": "research"},
        delegation_context={"task": "research recursive LLMs"},
    )
    assert "RESUMING" in augmented
    assert "not restarting" in augmented.lower() or "do not re-run" in augmented.lower()


def test_augment_extension_matches_task_type():
    """Filename extension must match the task_type's canonical artifact
    extension so the suggested target lines up with downstream
    artifact-validation expectations."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    cases = [
        ("research", ".md"),
        ("document", ".md"),
        ("presentation", ".pptx"),
        ("frontend", ".html"),
        ("visual_report", ".pdf"),
    ]
    for task_type, expected_ext in cases:
        augmented = _augment_update_message(
            message="add X",
            tracked={"task_id": "t1", "task_type": task_type},
            delegation_context={"task": "the original brief", "task_type": task_type},
        )
        assert f"the-original-brief{expected_ext}" in augmented, (
            f"task_type={task_type} should produce {expected_ext} extension"
        )


def test_augment_preserves_html_document_output_format():
    """Static HTML document builds are document-style tasks, but the resumed
    concrete file target must still keep the requested .html output format."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    source_url = "https://github.com/RecursiveMAS/RecursiveMAS"
    augmented = _augment_update_message(
        message=f"add recursive MAS section from {source_url}",
        tracked={"task_id": "t1", "task_type": "document"},
        delegation_context={
            "task": "Build an HTML document about Karpathy autoresearch",
            "task_type": "document",
        },
    )

    assert "/mnt/user-data/outputs/" in augmented
    assert "build-an-html-document-about-karpathy-au.html" in augmented
    assert source_url in augmented
    assert "approved fetch targets" in augmented
    assert "use builder_web_fetch on the exact new URL" in augmented
    assert "add recursive MAS section" in augmented


def test_augment_preserves_html_output_for_visual_report_task_type():
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="also include the Recursive MAS framework",
        tracked={"task_id": "t1", "task_type": "visual_report"},
        delegation_context={
            "task": "Build a concise HTML file document with charts and diagrams about GEPA SkillOpt",
            "task_type": "visual_report",
        },
    )

    assert "build-a-concise-html-file-document-with.html" in augmented
    assert "write_file(description=" in augmented
    assert "BINARY" not in augmented


def test_augment_prefer_prior_artifact_path_over_suggested_filename():
    """If the prior builder already produced an artifact_path, use that
    exact path instead of a derived suggestion. The model should continue
    editing the existing file, not write to a new derived name."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="add X",
        tracked={
            "task_id": "t1",
            "task_type": "research",
            "artifact_path": "/mnt/user-data/outputs/already-written.md",
        },
        delegation_context={"task": "the original brief"},
    )
    # Existing artifact wins.
    assert "/mnt/user-data/outputs/already-written.md" in augmented


def test_augment_reuses_tracked_artifact_target_path_before_artifact_exists():
    """Mid-build updates should keep the canonical launch target even before
    the builder has emitted a real artifact_path."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="also include the new framework",
        tracked={
            "task_id": "t1",
            "task_type": "document",
            "artifact_target_path": "/mnt/user-data/outputs/canonical.html",
        },
        delegation_context={
            "task": "Build an HTML document about the original topic",
            "task_type": "document",
        },
    )

    assert "Concrete file target: `/mnt/user-data/outputs/canonical.html`" in augmented
    assert "build-an-html-document" not in augmented


def test_augment_uses_delegated_artifact_target_path_when_tracking_missing():
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    augmented = _augment_update_message(
        message="also include the new framework",
        tracked={"task_id": "t1", "task_type": "document"},
        delegation_context={
            "task": "Build an HTML document about the original topic",
            "task_type": "document",
            "artifact_target_path": "/mnt/user-data/outputs/original.html",
        },
    )

    assert "Concrete file target: `/mnt/user-data/outputs/original.html`" in augmented


def test_augment_falls_back_to_build_slug_when_description_missing():
    """If delegation_context is missing or has no 'task', fall back to a
    safe default slug (``build.{ext}``) rather than crashing."""
    from deerflow.sophia.tools.update_async_task_wrapper import _augment_update_message

    for missing_dc in (None, {}, {"unrelated": "noise"}):
        augmented = _augment_update_message(
            message="add X",
            tracked={"task_id": "t1", "task_type": "research"},
            delegation_context=missing_dc,
        )
        # Either build.md (no description) or some safe fallback under outputs.
        assert "/mnt/user-data/outputs/" in augmented
        assert ".md" in augmented


def test_augment_slugify_deterministic():
    """Same input → same slug across calls. This guarantees retry
    stability: the model converges on the same filename each turn."""
    from deerflow.sophia.tools.update_async_task_wrapper import _slugify_for_filename

    text = "Build a comprehensive markdown document on recursive LLMs research"
    assert _slugify_for_filename(text) == _slugify_for_filename(text)


def test_augment_slugify_handles_unicode_and_punctuation():
    """Defensive: weird characters in the description shouldn't crash or
    produce invalid filenames."""
    from deerflow.sophia.tools.update_async_task_wrapper import _slugify_for_filename

    cases = [
        ("Hello, World!", "hello-world"),
        ("Café résumé", "caf-r-sum"),  # ASCII-only output
        ("   leading and trailing   ", "leading-and-trailing"),
        ("@@@", "build"),  # nothing alphanumeric → fallback
        ("", "build"),
    ]
    for input_text, expected in cases:
        result = _slugify_for_filename(input_text)
        assert result == expected, f"{input_text!r} → {result!r}, expected {expected!r}"


# ---- E.2: post-interrupt message augmentation -----------------------------


@pytest.mark.parametrize("non_terminal_status", ["running", "pending", "interrupted"])
def test_wrapper_augments_user_message_with_file_target_directive(non_terminal_status):
    """Phase 2E.2: when the wrapper delegates to native update_async_task on
    a non-terminal target, the user's ``message`` arg is augmented with a
    directive telling the builder to continue editing files under
    ``/mnt/user-data/outputs/`` and NOT to invent scratch files like
    ``test.md`` / ``test2.md``. Production failure 2026-05-21 21:18 UTC:
    without this hint the builder looped on phantom-target write_file calls
    for 28 minutes."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": non_terminal_status,
            }
        }
    )

    asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add a section on auto TTS", runtime=runtime)
    )

    # Native was called.
    assert len(async_calls) == 1
    delegated_message = async_calls[0]["message"]
    # The user's verbatim text is preserved.
    assert "add a section on auto TTS" in delegated_message
    # Directive is appended.
    assert "/mnt/user-data/outputs/" in delegated_message
    assert "test.md" in delegated_message
    assert "test2.md" in delegated_message
    # The directive carries the stable sentinel so retries / double-dispatch
    # don't pile up duplicate directives.
    assert "[Sophia/post-interrupt build directive]" in delegated_message


def test_wrapper_augmentation_includes_prior_artifact_path_when_present():
    """If the tracked entry already carries an ``artifact_path`` (the prior
    builder run produced a deliverable before the interrupt), the directive
    NAMES that path so the model continues editing the exact file rather
    than re-deriving it."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "artifact_path": "/mnt/user-data/outputs/recursive_llms_research.md",
            }
        }
    )

    asyncio.run(wrapped.coroutine(task_id="task-1", message="add TTS section", runtime=runtime))
    msg = async_calls[0]["message"]
    assert "/mnt/user-data/outputs/recursive_llms_research.md" in msg
    # Phase 2F.1: directive language asserts "RESUMING (not restarting)"
    # which is the canonical anti-re-research framing.
    assert "RESUMING" in msg or "resume" in msg.lower()


def test_wrapper_persists_update_urls_in_replacement_run_input():
    """Explicit URLs in a mid-build update must reach builder state, not
    only directive prose. builder_web_fetch authorizes against these state
    fields in the replacement run."""
    update_calls: list[dict] = []
    update_url = "https://example.com/source"

    class FakeRuns:
        async def create(self, **kwargs):
            update_calls.append(kwargs)
            return {"run_id": "run-new"}

    class FakeClient:
        runs = FakeRuns()

    class FakeClients:
        def get_async(self, agent_name):
            assert agent_name == "sophia_builder"
            return FakeClient()

    agent_map = {"sophia_builder": {"graph_id": "sophia_builder"}}
    clients = FakeClients()

    async def native_coroutine(*, task_id, message, runtime):
        # Keep these references in the closure so the wrapper can reuse the
        # native deepagents update context, matching production.
        assert agent_map and clients
        raise AssertionError("URL-state dispatch should bypass native fallback")

    native = SimpleNamespace(
        name="update_async_task",
        description="native desc",
        func=None,
        coroutine=native_coroutine,
        args_schema=None,
    )
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(
        state={
            "async_tasks": {
                "task-1": {
                    "task_id": "task-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "builder-thread-1",
                    "run_id": "run-old",
                    "status": "running",
                    "created_at": "2026-05-28T10:00:00Z",
                    "last_checked_at": "2026-05-28T10:00:00Z",
                    "last_updated_at": "2026-05-28T10:00:00Z",
                }
            },
        },
        tool_call_id="tc-update",
        config={"configurable": {"user_id": "user-1", "parent_thread_id": "parent-1"}},
    )

    response = asyncio.run(
        wrapped.coroutine(
            task_id="task-1",
            message=f"also include {update_url}",
            runtime=runtime,
        )
    )

    assert isinstance(response, Command)
    assert len(update_calls) == 1
    run_input = update_calls[0]["input"]
    assert run_input["explicit_user_urls"] == [update_url]
    assert run_input["builder_allowed_urls"] == [update_url]
    assert run_input["builder_update_required_urls"] == [update_url]
    assert "approved fetch targets" in run_input["messages"][0]["content"]
    assert update_calls[0]["config"]["configurable"]["thread_id"] == "builder-thread-1"
    assert response.update["async_tasks"]["task-1"]["run_id"] == "run-new"


def test_wrapper_augmentation_is_idempotent():
    """If the message already carries the directive sentinel (e.g. a retry,
    or a model that copied the prior directive into a new turn), the
    wrapper does NOT add a second copy."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
            }
        }
    )

    pre_augmented = (
        "please also include reinforcement learning\n\n"
        "[Sophia/post-interrupt build directive]\nold directive content here"
    )
    asyncio.run(wrapped.coroutine(task_id="task-1", message=pre_augmented, runtime=runtime))
    msg = async_calls[0]["message"]
    # The marker appears exactly once.
    assert msg.count("[Sophia/post-interrupt build directive]") == 1
    # Original message preserved.
    assert "please also include reinforcement learning" in msg


def test_wrapper_augmentation_skipped_when_terminal_redirect_fires(monkeypatch):
    """The augmentation is irrelevant on the terminal-target path — the
    wrapper returns the redirect string immediately and never delegates to
    native. This test asserts no augmentation work happens (the native
    coroutine is not called)."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",  # terminal
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, str)
    assert async_calls == []
    # The redirect prose doesn't mention the augmentation marker (different code path).
    assert "[Sophia/post-interrupt build directive]" not in response


# ---- ToolRuntime injection contract (regression: prod TypeError 2026-05-21) -


def test_wrapper_runtime_param_is_recognized_as_directly_injected():
    """Regression guard for 2026-05-21 19:28 UTC production TypeError:
    `aupdate_async_task() missing 1 required positional argument: 'runtime'`.

    LangGraph's ToolNode constructs a ToolRuntime per tool_call and injects
    it into any parameter whose annotation IS the ToolRuntime class. That
    detection lives in ``StructuredTool._injected_args_keys`` which iterates
    the function signature and calls ``_is_directly_injected_arg_type`` —
    that helper checks ``isinstance(annotation, type) and issubclass(...,
    _DirectlyInjectedToolArg)``. If the wrapper module uses
    ``from __future__ import annotations``, every annotation becomes a
    string forward-ref and the isinstance check returns False, so ToolNode
    NEVER injects the runtime and the function is called with only the
    args_schema fields → TypeError on the missing positional.

    This test asserts the wrapper's coroutine ``runtime`` parameter is
    correctly identified as directly-injected. It's the production-truth
    check — same detection ToolNode uses at dispatch time."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    assert "runtime" in wrapped._injected_args_keys, (
        "ToolNode will not inject ToolRuntime for this wrapper — fix the "
        "`runtime: ToolRuntime` annotation (and ensure the module does NOT "
        "use `from __future__ import annotations`, which stringifies the "
        "annotation and breaks isinstance-based detection)."
    )


def test_wrapper_runtime_annotation_resolves_to_toolruntime_class():
    """Belt-and-suspenders: the annotation on the wrapper's runtime
    parameter must resolve to the actual ToolRuntime class at runtime
    (not a forward-ref string). A future regression introducing
    `from __future__ import annotations` to the wrapper module would
    break LangGraph's ToolNode injection silently — this test trips
    such a change."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    for fn_name in ("coroutine", "func"):
        fn = getattr(wrapped, fn_name)
        sig = inspect.signature(fn)
        runtime_param = sig.parameters["runtime"]
        annot = runtime_param.annotation
        assert annot is ToolRuntime, (
            f"{fn_name}.runtime annotation must be the ToolRuntime class, "
            f"got {annot!r}. (If you see a string here, the wrapper module "
            f"has `from __future__ import annotations` — remove it.)"
        )


def test_wrapper_model_facing_args_exclude_runtime():
    """The StructuredTool's model-facing arg list (driven by args_schema)
    must NOT include runtime — that arg comes from the execution context,
    not from the model's tool_call."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    model_args = set(wrapped.args.keys())
    assert "runtime" not in model_args
    assert "task_id" in model_args
    assert "message" in model_args


# ---- terminal-target rejection --------------------------------------------


@pytest.mark.parametrize(
    "terminal_status",
    [
        "success",
        "completed",
        "error",
        "failed",
        "cancelled",
        "timeout",
        "timed_out",
    ],
)
def test_wrapper_rejects_terminal_target_sync(terminal_status):
    """For every terminal status, the sync wrapper must return a directive
    string and MUST NOT invoke the native dispatch."""
    native, sync_calls, _async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": terminal_status,
                "task_type": "research",
                "thread_id": "task-1",
                "run_id": "r-1",
                "created_at": "2026-05-20T19:43:37Z",
                "last_checked_at": "2026-05-20T19:53:27Z",
                "last_updated_at": "2026-05-20T19:53:27Z",
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert isinstance(response, str)
    # Directive content checks: model is told NOT to call update again and
    # IS told to call start_builder_task with the prior artifact in scope.
    assert "terminal" in response.lower() or terminal_status in response
    assert "start_builder_task" in response
    assert "task-1" in response
    # Native must not have been called.
    assert sync_calls == []


@pytest.mark.parametrize(
    "terminal_status",
    ["success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_wrapper_rejects_terminal_target_async(terminal_status):
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": terminal_status,
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert async_calls == []


# ---- live SDK re-check (defeat cache staleness) ---------------------------


def _stub_sdk_client(monkeypatch, *, run_status: str | None, raise_on_get: bool = False):
    """Install a fake ``langgraph_sdk.get_client`` whose ``runs.get`` returns
    a dict with the given ``status``, or raises if ``raise_on_get`` is set.
    Returns a list that records each (thread_id, run_id) call so tests can
    assert the live check fired exactly once."""
    calls: list[tuple[str, str]] = []

    async def fake_runs_get(thread_id: str, run_id: str):
        calls.append((thread_id, run_id))
        if raise_on_get:
            raise RuntimeError("simulated SDK failure")
        if run_status is None:
            return {"some_other_field": "..."}
        return {"status": run_status}

    fake_runs = MagicMock()
    fake_runs.get = fake_runs_get
    fake_client = MagicMock()
    fake_client.runs = fake_runs

    def fake_get_client(url=None):
        return fake_client

    monkeypatch.setattr("langgraph_sdk.get_client", fake_get_client)
    return calls


def test_async_live_check_redirects_when_cache_stale_but_live_terminal(monkeypatch):
    """The cache says 'running' but the live SDK says 'success' — the
    wrapper MUST return a Command that carries BOTH the redirect prose
    AND a state update flipping the cached status to terminal. Returning
    a plain string would let the model's follow-up start_builder_task
    read the stale cache and reject the relaunch (codex P1 review)."""
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",  # cached, stale
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Live SDK was queried exactly once.
    assert calls == [("task-1", "r-1")]
    # Wrapper redirected via Command, not plain string.
    assert isinstance(response, Command), (
        "live-terminal redirect must return Command so async_tasks state "
        "update is persisted before the model calls start_builder_task"
    )
    # ToolMessage carries the redirect prose.
    text = _redirect_text(response)
    assert "start_builder_task" in text
    assert "task-1" in text
    # async_tasks update carries the FRESH terminal status.
    updated_tasks = response.update.get("async_tasks")
    assert isinstance(updated_tasks, dict)
    assert "task-1" in updated_tasks
    assert updated_tasks["task-1"]["status"] == "success"
    # Native dispatch must NOT have run.
    assert async_calls == []


@pytest.mark.parametrize(
    "live_terminal_status",
    ["success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"],
)
def test_async_live_check_redirects_for_all_terminal_statuses(monkeypatch, live_terminal_status):
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status=live_terminal_status)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, Command)
    assert response.update["async_tasks"]["task-1"]["status"] == live_terminal_status
    assert "start_builder_task" in _redirect_text(response)
    assert async_calls == []


def test_live_terminal_redirect_unblocks_start_builder_task_duplicate_guard(monkeypatch):
    """End-to-end P1 regression: after the wrapper returns Command with
    the async_tasks state update, simulate langgraph applying that update
    to state, then call start_builder_task._has_active_builder_task on
    the updated state. It MUST return None — confirming that the model's
    follow-up start_builder_task on the SAME turn will NOT be rejected
    as a duplicate.

    The 2026-05-21 codex P1 review flagged exactly this failure mode:
    without persisting the live terminal status, _has_active_builder_task
    sees the stale non-terminal cache and rejects the relaunch.
    """
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    pre_state_async_tasks = {
        "task-1": {
            "task_id": "task-1",
            "agent_name": "sophia_builder",
            "status": "running",  # stale cache
            "thread_id": "task-1",
            "run_id": "r-1",
            "task_type": "research",
        }
    }
    runtime = _runtime(pre_state_async_tasks)

    # Sanity: before the wrapper runs, start_builder_task would reject.
    assert _has_active_builder_task(runtime.state) == "task-1"

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, Command)

    # Simulate langgraph applying the Command's async_tasks update
    # (the reducer merges {task_id: tracked_now} into existing async_tasks).
    updated_state = {
        "async_tasks": {**pre_state_async_tasks, **response.update["async_tasks"]},
    }
    # start_builder_task now sees the fresh terminal status → no active task → not a duplicate.
    assert _has_active_builder_task(updated_state) is None, (
        "start_builder_task would reject the relaunch as a duplicate; "
        "the live-terminal redirect Command failed to update async_tasks state."
    )


@pytest.mark.parametrize(
    "padded_input",
    ["task-1 ", " task-1", "  task-1  ", "\ttask-1\n"],
)
def test_live_terminal_redirect_writes_state_under_canonical_task_id(monkeypatch, padded_input):
    """Regression for codex P2 review 2026-05-21:
    when the model passes ``task_id`` with surrounding whitespace,
    ``_resolve_tracked`` correctly finds the canonical entry via
    ``task_id.strip()`` — but if the live-redirect state update is keyed
    by the RAW input, the reducer merges a phantom whitespace-keyed
    entry alongside the still-non-terminal canonical entry, and
    ``_has_active_builder_task`` then sees the canonical entry as still
    active → rejects the follow-up ``start_builder_task`` → recovery
    path is broken in exactly the whitespace-tolerance case the wrapper
    is meant to handle.

    Fix asserts: the Command's ``async_tasks`` update writes back under
    the CANONICAL key (``"task-1"``), and a follow-up
    ``_has_active_builder_task`` on the merged state returns None.
    """
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    pre_state_async_tasks = {
        # Canonical key — what BuildAwarenessMiddleware / start_builder_task wrote.
        "task-1": {
            "task_id": "task-1",
            "agent_name": "sophia_builder",
            "status": "running",
            "thread_id": "task-1",
            "run_id": "r-1",
            "task_type": "research",
        }
    }
    runtime = _runtime(pre_state_async_tasks)

    response = asyncio.run(
        wrapped.coroutine(task_id=padded_input, message="add X", runtime=runtime)
    )

    assert isinstance(response, Command)
    updated_tasks = response.update["async_tasks"]
    # Must write back under the canonical key, NOT the raw padded input.
    assert "task-1" in updated_tasks, (
        f"state update must use canonical task_id 'task-1', "
        f"got keys: {list(updated_tasks.keys())!r}"
    )
    assert padded_input not in updated_tasks, (
        f"state update wrote under whitespace key {padded_input!r}; this "
        f"creates a phantom entry and leaves the canonical entry non-terminal"
    )
    assert updated_tasks["task-1"]["status"] == "success"

    # End-to-end: simulate langgraph merging the Command update, then
    # confirm start_builder_task's duplicate guard would NOT reject.
    merged = {**pre_state_async_tasks, **updated_tasks}
    assert _has_active_builder_task({"async_tasks": merged}) is None, (
        "after canonical-key merge, _has_active_builder_task must return None"
    )
    # Native dispatch did not run.
    assert async_calls == []


def test_live_terminal_redirect_message_uses_canonical_task_id_in_prose(monkeypatch):
    """The interpolated task_id in the redirect prose is normalized to
    the canonical form. Otherwise the model may copy the
    whitespace-padded id into a follow-up start_builder_task description,
    which is at best ugly and at worst a future bug."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )
    response = asyncio.run(
        wrapped.coroutine(task_id="  task-1  ", message="add X", runtime=runtime)
    )
    text = _redirect_text(response)
    assert "task_id=task-1)" in text, (
        f"redirect prose must show canonical 'task-1', got prose: {text[:200]}"
    )
    assert "  task-1  " not in text


def test_live_terminal_redirect_degrades_to_string_when_tool_call_id_missing(monkeypatch, caplog):
    """When runtime has no tool_call_id (rare — synthetic / test contexts
    only), the wrapper logs a warning and falls back to a plain-string
    return. The redirect prose still reaches the model; only the state
    update is lost. Production always sets tool_call_id."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        },
        tool_call_id="",  # ← empty: triggers degraded fallback
    )

    caplog.set_level("WARNING", logger="deerflow.sophia.tools.update_async_task_wrapper")
    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )
    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert any("could not persist state update" in r.message for r in caplog.records)


def test_async_live_check_delegates_when_live_still_running(monkeypatch):
    """If live SDK confirms the run is still active, delegate to native."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="running")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                "thread_id": "task-1",
                "run_id": "r-1",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert calls == [("task-1", "r-1")]
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_live_check_failure_falls_back_to_cache_delegate(monkeypatch):
    """Fail-open: if the SDK live-check raises, the wrapper falls back to
    the cached status and delegates. We never want to block a legitimate
    update_async_task because of SDK transport issues."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    _stub_sdk_client(monkeypatch, run_status=None, raise_on_get=True)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",  # cache says running
                "thread_id": "task-1",
                "run_id": "r-1",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Fell back to cache, delegated.
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_live_check_skips_when_thread_or_run_id_missing(monkeypatch):
    """If tracked entry has no thread_id / run_id, there is nothing to
    re-check live. Fall back to cache, delegate."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="success")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "running",
                # Intentionally no thread_id, no run_id.
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Live SDK was never called.
    assert calls == []
    # Delegated normally.
    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_async_terminal_cache_skips_live_check(monkeypatch):
    """Optimization: if the cached status is already terminal, we already
    have the answer — don't waste an SDK round-trip on a live check."""
    native, _, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    calls = _stub_sdk_client(monkeypatch, run_status="running")
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",  # cache already terminal
                "thread_id": "task-1",
                "run_id": "r-1",
                "task_type": "research",
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    # Cache-only path: live check skipped.
    assert calls == []
    assert isinstance(response, str)
    assert "start_builder_task" in response
    assert async_calls == []


# ---- non-terminal delegation ----------------------------------------------


@pytest.mark.parametrize(
    "non_terminal_status",
    ["running", "pending", "interrupted", "queued", "starting"],
)
def test_wrapper_delegates_when_target_not_terminal_sync(non_terminal_status):
    """For any non-terminal status, the wrapper must delegate to the native
    sync func with the exact same args. This preserves the existing SDK
    dispatch behaviour."""
    native, sync_calls, _async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": non_terminal_status,
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert response == "native-sync(task-1)"
    assert len(sync_calls) == 1
    assert sync_calls[0]["task_id"] == "task-1"
    # Phase 2E.2: the wrapper augments the message with a file-target
    # directive before delegating. The user's verbatim text is preserved
    # at the start; the directive is appended after a marker.
    assert "add X" in sync_calls[0]["message"]


@pytest.mark.parametrize(
    "non_terminal_status",
    ["running", "pending", "interrupted", "queued", "starting"],
)
def test_wrapper_delegates_when_target_not_terminal_async(non_terminal_status):
    native, _sync_calls, async_calls = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": non_terminal_status,
            }
        }
    )

    response = asyncio.run(
        wrapped.coroutine(task_id="task-1", message="add X", runtime=runtime)
    )

    assert response == "native-async(task-1)"
    assert len(async_calls) == 1


def test_wrapper_delegates_when_task_unknown():
    """If the task_id isn't in state['async_tasks'], the wrapper has no
    status to check — it must delegate so the native tool can return its
    own 'No tracked task found' error."""
    native, sync_calls, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime({})

    response = wrapped.func(task_id="unknown-1", message="add X", runtime=runtime)

    assert response == "native-sync(unknown-1)"
    assert len(sync_calls) == 1


def test_wrapper_delegates_when_state_missing_async_tasks_key():
    native, sync_calls, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = SimpleNamespace(state={}, tool_call_id="tc")

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)

    assert response == "native-sync(task-1)"
    assert len(sync_calls) == 1


# ---- wrapper construction guards ------------------------------------------


def test_wrapper_factory_rejects_none_native():
    with pytest.raises(ValueError, match="requires the native"):
        make_update_async_task_wrapper(None)


def test_wrapper_factory_rejects_wrong_name():
    native, _, _ = _make_native_tool(name="check_async_task")
    with pytest.raises(ValueError, match="Expected native tool"):
        make_update_async_task_wrapper(native)


# ---- directive content guards ---------------------------------------------


def test_directive_includes_task_type_for_v2_brief():
    """The directive prose must surface the prior build's task_type so the
    model knows to call start_builder_task with the matching type when it
    composes the v2 brief."""
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            "task-1": {
                "task_id": "task-1",
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": "research",
            }
        }
    )

    response = wrapped.func(task_id="task-1", message="add X", runtime=runtime)
    assert "research" in response


def test_directive_does_not_truncate_task_id():
    full_id = "019fbe43-2c1a-4d7b-91d8-77ae1f6c5e22"
    native, _, _ = _make_native_tool()
    wrapped = make_update_async_task_wrapper(native)
    runtime = _runtime(
        {
            full_id: {
                "task_id": full_id,
                "agent_name": "sophia_builder",
                "status": "success",
                "task_type": "document",
            }
        }
    )

    response = wrapped.func(task_id=full_id, message="add X", runtime=runtime)
    assert full_id in response
    # Guard against task-id truncation specifically — not generic "..."
    # placeholder syntax used elsewhere in the directive prose.
    assert "…" not in response
    assert f"{full_id[:8]}..." not in response
    assert f"{full_id[:12]}..." not in response
