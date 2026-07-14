"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).

PR-D (2026-04-24): adds file-existence verification before accepting an
emit_builder_artifact call. When the referenced file is missing on disk
and in Supabase, the emit is rejected via wrap_tool_call with a
Command(goto="model") so the builder gets another turn to retry instead
of completing with a phantom artifact.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import shlex
import time
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse, ModelRequest, ModelResponse, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from deerflow.agents.sophia_agent.builder_tools import (
    deck_build_service_flag_value,
    deck_route_for_task,
)
from deerflow.agents.sophia_agent.middlewares.builder_budget import (
    USER_BUDGET_TURN_MESSAGE,
    budget_allows_iteration,
    force_emit_remaining_turns,
    force_emit_wall_clock_fraction,
    max_non_artifact_turns,
    prepare_force_after_seconds,
    prepare_force_at_turn,
    presentation_authoring_deadline_seconds,
    presentation_authoring_max_tokens,
    presentation_authoring_timeout_seconds,
    presentation_preflight_timeout_seconds,
    soft_warn_at_turn,
)
from deerflow.agents.sophia_agent.middlewares.builder_task import (
    BuilderTaskMiddleware,
    _image_generation_enabled,
)
from deerflow.agents.sophia_agent.middlewares.slide_quality import (
    SlideQualityInspector,
    SlideSignals,
    format_slide_quality_feedback,
)
from deerflow.agents.sophia_agent.pptx_diagnostics import _merge_builder_pptx_diagnostics
from deerflow.agents.sophia_agent.state import _merge_builder_non_artifact_turns
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.config.paths import VIRTUAL_PATH_PREFIX
from deerflow.sophia.build_condition import (
    brief_gate_unmet_conditions,
    iteration_available,
    iteration_cap,
    iterations_used,
    preview_review_blocks,
    rendered_artifact_review,
)
from deerflow.sophia.build_runtime.events import default_event_sink_status, record_runtime_event
from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.builder_failure_diagnostics import (
    build_builder_failure_diagnostics,
    diagnostic_safe_failure_message,
    merge_builder_failure_diagnostics,
    normalize_emit_failure_code,
)
from deerflow.sophia.builder_provider_fallback import (
    model_provider_label,
    normalize_tool_choice_for_model,
)
from deerflow.sophia.builder_web_policy import extract_explicit_user_urls
from deerflow.sophia.deck_build.compiler_capabilities import compiler_capability_prompt_excerpt
from deerflow.sophia.deck_build.ir_repair import deck_ir_repair_instruction_from_failure
from deerflow.sophia.observability import annotate_builder_completion
from deerflow.sophia.pptx_preview import maybe_render_pptx_preview
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.supabase_mirror import maybe_mirror_file

try:  # pragma: no cover - dependency availability varies in minimal tests.
    from pypdf import PdfReader
except Exception:  # noqa: BLE001
    PdfReader = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_PRESENTATION_PREFLIGHT_TOOLS = frozenset({"builder_web_search", "builder_web_fetch"})
_PRESENTATION_PREFLIGHT_MODEL_MAX_TOKENS = 512
_PRESENTATION_TASK_BRIEF_MAX_BYTES = 12 * 1024
_PRESENTATION_PREFLIGHT_RESULT_MAX_BYTES = 8 * 1024
_PRESENTATION_ATTACHMENT_MEMORY_MAX_BYTES = 8 * 1024
_PRESENTATION_AUTHORING_PROMPT_MAX_BYTES = 24 * 1024
_PRESENTATION_AUTHORING_SYSTEM_PROMPT = (
    "You are Sophia's presentation authoring lane.\n"
    "Produce exactly one prepare_deck_build tool call and no prose. You own the story, design, CSS, "
    "and semantic slide markup. Use authoring_contract=compact_model_html_v2, one concise "
    "creative_plan, one shared deck_stylesheet, html_body for every slide, and only small slide_css "
    "overrides. Keep the shared stylesheet under 8 KiB, each html_body under 3 KiB, each slide_css "
    "under 1 KiB, the creative plan under 12 KiB, and total arguments under 48 KiB. Use an opaque "
    "model-authored canvas background, meaningful data-deck-id values, varied "
    "spatial compositions, and no repeated document/style tags. Do not use deterministic templates, "
    "screenshot slides, lower-level deck tools, or incomplete fallback output. Pass creative_plan as "
    "a JSON object, never as a JSON-encoded string. "
    + compiler_capability_prompt_excerpt()
)
_PRESENTATION_PREFLIGHT_SYSTEM_PROMPT = (
    "You are Sophia's bounded presentation research preflight. Call the single available web tool "
    "exactly once and emit no prose. For builder_web_fetch use the exact supplied URL. For "
    "builder_web_search use one concise query that retrieves the most decision-relevant facts for the "
    "requested deck."
)


def _blocks_to_plaintext(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                block_type = str(block.get("type") or "content")
                if block_type == "text":
                    parts.append(str(block.get("text") or ""))
                else:
                    parts.append(f"[omitted {block_type} block]")
            elif isinstance(block, str):
                parts.append(block)
            elif block is not None:
                parts.append(str(block))
        return "\n".join(part for part in parts if part).strip()
    if content is None:
        return ""
    return str(content)


def _error_tool_content_text_only(content: Any) -> str | list[dict[str, str]]:
    """Anthropic requires ``is_error`` tool results to contain text only."""

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_blocks: list[dict[str, str]] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_blocks.append({"type": "text", "text": str(block.get("text") or "")})
            elif isinstance(block, str):
                text_blocks.append({"type": "text", "text": block})
        if text_blocks:
            return text_blocks
    return [{"type": "text", "text": _blocks_to_plaintext(content)}]


def _error_tool_message(
    *,
    content: Any,
    tool_call_id: Any,
    name: str | None = None,
) -> ToolMessage:
    return ToolMessage(
        content=_error_tool_content_text_only(content),
        tool_call_id=str(tool_call_id or ""),
        name=name,
        status="error",
    )


def _skill_name_from_path(path: str) -> str | None:
    for marker in ("/skills/public/", "/mnt/skills/public/", "/skills/", "/mnt/skills/"):
        if marker in path:
            tail = path.split(marker, 1)[1]
            skill = tail.split("/", 1)[0]
            return skill or None
    return None


def _command_references_skill(command: str, skill_name: str) -> bool:
    return any(
        marker in command
        for marker in (
            f"/skills/{skill_name}/",
            f"/mnt/skills/{skill_name}/",
            f"/skills/public/{skill_name}/",
            f"/mnt/skills/public/{skill_name}/",
        )
    )


def _emit_skill_usage_logs(tool_calls: list[dict[str, Any]]) -> None:
    """Log builder skill discovery / invocation as INFO breadcrumbs.

    Two distinct events are surfaced so the user can grep one line per
    builder run to answer "did the builder pick a skill?":

    - ``[BuilderSkill] manifest_read: skill=<name>`` — the model called
      ``read_file`` on a SKILL.md, i.e. it discovered the skill workflow.
    - ``[BuilderSkill] script_invoked: skill=<name>`` — the model called
      ``bash`` with a command path under ``skills/<name>/``, i.e. it
      executed a skill-bundled script.

    Without these the existing logs only show ``write_file`` and ``bash``
    tool names, with no signal whether the builder is using a pre-tested
    skill workflow or writing its own ``_generate_*.py`` script.
    """
    relevant = BuilderTaskMiddleware._BUILDER_RELEVANT_SKILLS
    for tc in tool_calls:
        name = tc.get("name")
        args = tc.get("args") or {}
        if name in ("read_file", "read_file_tool"):
            path = args.get("path") or args.get("file_path") or ""
            if isinstance(path, str) and "/skills/" in path and path.endswith("/SKILL.md"):
                segment = _skill_name_from_path(path)
                if segment in relevant:
                    logger.info("[BuilderSkill] manifest_read: skill=%s", segment)
        elif name == "bash":
            cmd = args.get("command")
            if not isinstance(cmd, str) or not cmd:
                continue
            for skill_name in relevant:
                # Match both the host (``skills/<name>/``) and container
                # (``/mnt/skills/<name>/``) layouts so this works in
                # local-sandbox and aio-sandbox modes alike.
                if _command_references_skill(cmd, skill_name):
                    logger.info("[BuilderSkill] script_invoked: skill=%s", skill_name)
                    break


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_SIMPLE_PDF_TOOL_NAME = "create_pdf_artifact"
# render_html_to_pdf (2026-06-25) is the report render path (HTML + inline SVG →
# headless chromium). It returns the same result JSON shape as
# render_markdown_to_pdf, so listing it here wires BOTH attempt-detection
# (_pdf_render_attempted) and result-capture (the _PDF_CREATION_TOOL_NAMES
# dispatch → _pdf_result_command → builder_pdf_render_result) with no other change.
_REPORT_PDF_RENDER_TOOL_NAME = "render_html_to_pdf"
_PDF_CREATION_TOOL_NAMES = frozenset({"render_markdown_to_pdf", _REPORT_PDF_RENDER_TOOL_NAME, _SIMPLE_PDF_TOOL_NAME})
_DECK_BUILD_TOOL_NAME = "build_deck_from_slides"
_PPTX_IMAGE_MANIFEST_TOOL_NAME = "prepare_pptx_image_manifest"
_PREPARE_DECK_BUILD_TOOL_NAME = "prepare_deck_build"
_BUILDER_WRITE_TOOL_NAMES = {"write_file", "write_file_tool"}
_BUILDER_EDIT_TOOL_NAMES = {"write_file", "write_file_tool", "str_replace", "str_replace_tool"}
_BUILDER_RESEARCH_TOOL_NAMES = {"builder_web_search", "builder_web_fetch"}
_BUILDER_SUBSTANTIVE_TOOL_NAMES = {
    "write_file",
    "write_file_tool",
    "str_replace",
    "str_replace_tool",
    "emit_builder_artifact",
}
_SIMPLE_PDF_REQUEST_MARKERS = (
    "simple pdf",
    "simple .pdf",
    "simple product review",
    "artifact canvas smoke test",
    "pdf smoke test",
    "demo pdf",
)
_SAFE_BASH_COMMAND_RE = re.compile(r"^\s*(?:pwd|ls|find|cat|sed|head|tail|grep|rg|wc|file|du|stat|jq)\b")
_BASH_WRITE_MARKER_RE = re.compile(r"(?:^|\s)(?:python|node|perl|ruby)\b|[>|]\s*|(?:^|\s)tee\s+|<<")
_FILE_TARGET_HINT_MARKER = "[Sophia/post-interrupt build directive]"
_CONCRETE_FILE_TARGET_RE = re.compile(r"Concrete file target:\s*`([^`]+)`")
_PPTX_SKILL_PATH_MARKERS = (
    "/skills/public/ppt-generation/SKILL.md",
    "/mnt/skills/public/ppt-generation/SKILL.md",
    "/skills/ppt-generation/SKILL.md",
    "/mnt/skills/ppt-generation/SKILL.md",
)
_PPTX_GENERATOR_PATH_MARKERS = (
    "/skills/public/ppt-generation/scripts/generate.py",
    "/mnt/skills/public/ppt-generation/scripts/generate.py",
    "/skills/ppt-generation/scripts/generate.py",
    "/mnt/skills/ppt-generation/scripts/generate.py",
    "compile_pptx.mjs",
)
_IMAGE_GENERATION_PATH_MARKERS = (
    "/skills/public/image-generation/scripts/generate.py",
    "/mnt/skills/public/image-generation/scripts/generate.py",
    "/skills/image-generation/scripts/generate.py",
    "/mnt/skills/image-generation/scripts/generate.py",
)
_SLIDE_QC_PATH_MARKERS = (
    "/skills/public/image-generation/scripts/slide_qc.py",
    "/mnt/skills/public/image-generation/scripts/slide_qc.py",
    "/skills/image-generation/scripts/slide_qc.py",
    "/mnt/skills/image-generation/scripts/slide_qc.py",
)
_SHELL_SEPARATORS = {"&&", "||", ";", "|", "&"}
# Enrichment discipline: generated imagery is on by default for decks, bounded
# by a hard per-build IMAGE cap enforced at bash interception time. Decks
# generate slide images in a single parallel batch (one ``--manifest`` call
# produces N images), so the cap counts IMAGES, not script invocations.
# Terminal error classes short-circuit retries — when the environment cannot
# generate images at all, the build must continue with charts/text instead of
# burning turns.
_IMAGE_GENERATION_MAX_CALLS = 30
# Bounded safety valve for the deck batch-first backstop: after this many
# rejections of serial image-gen calls with no --manifest batch seen,
# stop rejecting so a model that genuinely cannot author a manifest still ships
# (serial, with a quality note) instead of looping. See
# ``_deck_batch_directive_rejection``.
_DECK_BATCH_REJECTION_CAP = 2
# One manifest-authoring correction: prompt/output path mistakes are fixed by
# materializing a readable manifest and rerunning the batch, not by falling back
# to fully serial generation or placeholder slides.
_DECK_FLOOR_ESCAPE_FRICTION_CAP = 2
_PPTX_IMAGE_MANIFEST_SCHEMA_VERSION = "sophia-pptx-image-manifest/v1"
_PPTX_IMAGE_MANIFEST_AUTHOR = "prepare_pptx_image_manifest"
_MANIFEST_AUTHORING_ERRORS = frozenset(
    {
        "manifest_not_deterministic",
        "manifest_prompt_missing",
        "manifest_prompt_or_output_missing",
        "missing_prompt_file",
        "missing_prompt_or_output",
        "manifest_not_readable",
        "manifest_unreadable",
        "manifest_empty",
        "manifest_invalid_json",
        "manifest_items_missing",
        "manifest_item_count_exceeds_slide_count",
        "manifest_output_not_outputs",
        "manifest_path_missing",
        "manifest_path_not_outputs",
        "manifest_state_missing",
    }
)
_SERIAL_REPAIR_ATTEMPTS_PER_FAILED_SLIDE = 2
_PPTX_VISUAL_QUALITY_REPAIR_MAX = 2
_PPTX_TEXT_ONLY_REQUEST_RE = re.compile(
    r"\b(?:plain\s+text[-\s]?only|text[-\s]?only|no[-\s]?image|no\s+images?"
    r"|no\s+visuals?|without\s+(?:images?|visuals?)|with\s+no\s+(?:images?|visuals?))\b",
    re.IGNORECASE,
)
_PPTX_EXTRA_GENERATED_VISUALS_REQUEST_RE = re.compile(
    r"\b(?:extra|additional|multiple|several)\s+(?:generated\s+)?(?:visuals?|images?|illustrations?|assets?)"
    r"|(?:two|three|four|\d+)\s+(?:generated\s+)?(?:visuals?|images?|illustrations?|assets?)\s+per\s+slide\b",
    re.IGNORECASE,
)
_PPTX_SEVERE_QUALITY_CHECKS = frozenset({"overflow", "chrome", "visual_contract", "visual_style", "visual_grader"})
# FIX 2 (2026-06-30) — the deterministic slide-quality gate. One shared inspector
# (declarative checks plus a mockable grader slot) consulted on successful decks.
_SLIDE_QUALITY_INSPECTOR = SlideQualityInspector()
# PDF reports get up to a few conceptual/editorial illustrations (cover/hero +
# key concepts) on by default; all charts and structural diagrams are drawn as
# inline <svg> in the report HTML (rendered via render_html_to_pdf), not images.
# Counts generated conceptual images only.
_IMAGE_GENERATION_MAX_CALLS_PDF = 3
# Two bounded repair attempts: one pass cannot converge an under→over swing
# (prod 2026-06-26: a 2-page first draft over-corrected to 11 vs an 8-page
# request and shipped off-band). The CSS figure caps + first-pass length
# guidance should make repairs rare; 2 is the backstop. (R2-3)
_PDF_PAGE_COUNT_REPAIR_MAX = 2
# Accept a small band around the requested length — an 11-page PDF for a
# "10-page" request is a delivered artifact, not a failure. An off-band render
# after bounded repair ships with a quality_warning, never a terminal failure
# or artifact_path=null.
_PDF_PAGE_COUNT_TOLERANCE_FRACTION = 0.1
# Terminal image-gen error classes: further retries are pointless, so the build
# stops generating and fails honestly instead of looping or compiling a degraded
# placeholder deck. `quota_exceeded` is included because a billing/credit outage
# will fail every call. (rate_limit / timeout stay non-terminal: the SDK already
# retries them and a single slow image should not abort the batch.)
_IMAGE_GENERATION_TERMINAL_ERRORS = frozenset({"missing_api_key", "auth_invalid", "org_not_verified", "egress_blocked", "quota_exceeded"})
_IMAGE_GENERATION_STARTUP_ERRORS = frozenset(
    {
        "image_script_not_found",
        "python_not_found",
        "import_error",
        "permission_denied",
        "shell_error",
        "batch_summary_missing",
        "invalid_batch_summary",
    }
)
_QC_PARSE_FAILURE_MARKERS = (
    "invalid json",
    "parseable verdict",
    "unparseable",
    "could not parse",
    "malformed json",
)


def _image_generation_max_calls(state: dict[str, Any]) -> int:
    return _IMAGE_GENERATION_MAX_CALLS_PDF if _requested_pdf_artifact(state) else _IMAGE_GENERATION_MAX_CALLS


def _repair_iteration_grantable(state: dict[str, Any]) -> bool:
    """VQ-10: a repair iteration needs both loop headroom and budget headroom."""
    if _presentation_completion_ready(state):
        logger.warning("[BuilderPptxReady] repair_denied reason=presentation_completion_ready")
        return False
    if not iteration_available(state):
        return False
    if not budget_allows_iteration(state):
        logger.warning(
            "[BuilderVQ] iteration_denied_by_budget iterations=%d/%d",
            iterations_used(state),
            iteration_cap(),
        )
        return False
    return True


def _presentation_completion_ready(state: dict[str, Any]) -> bool:
    """Positive stop rule for decks that already have a shippable PPTX."""
    if state.get("builder_presentation_terminal_ready") is True:
        return True
    if not _requested_pptx_artifact(state):
        return False
    diagnostics = _pptx_diagnostics(state)
    if int(diagnostics.get("pptx_generator_success_count", 0) or 0) < 1:
        return False
    pptx_file = _latest_valid_pptx_output_file(state)
    if pptx_file is None:
        return False
    if not _pptx_picture_count_satisfies_slide_count(diagnostics):
        return False
    if not _pptx_generated_visuals_complete(state):
        return False
    if _pptx_target_slide_count_needs_one_repair(diagnostics, state):
        return False
    _mark_presentation_terminal_ready(state, diagnostics, pptx_file)
    return True


def _mark_presentation_terminal_ready(
    state: dict[str, Any],
    diagnostics: dict[str, Any],
    pptx_file: Path,
) -> None:
    state["builder_presentation_terminal_ready"] = True
    state["builder_terminal_artifact_path"] = _canonical_outputs_artifact_path(f"/mnt/user-data/outputs/{pptx_file.name}")
    diagnostics.setdefault("pptx_terminal_ready_at_turn", _builder_current_turn_index(state))
    elapsed = _elapsed_since_builder_start_ms(state)
    if elapsed is not None:
        diagnostics.setdefault("time_to_first_valid_artifact_ms", elapsed)
    state["builder_pptx_diagnostics"] = diagnostics


def _terminal_halt_fields(state: dict[str, Any], reason: str) -> dict[str, Any]:
    markers = dict(state.get("builder_lifecycle_markers") or {})
    markers[f"halted:{reason}"] = int(time.time() * 1000)
    return {
        "builder_graph_halted": True,
        "builder_terminal_halt_reason": reason,
        "builder_lifecycle_markers": markers,
    }


def _latest_valid_pptx_output_file(state: dict[str, Any]) -> Path | None:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return None
    min_mtime = _builder_started_min_mtime(state)
    diagnostics = _pptx_diagnostics(state)
    raw_paths = diagnostics.get("pptx_output_paths") or []
    candidates: list[Path] = []
    if isinstance(raw_paths, list):
        for raw_path in reversed(raw_paths):
            relative = _extract_output_relative_path(_canonical_outputs_artifact_path(raw_path))
            if relative:
                candidates.append(outputs_root / relative)
    try:
        candidates.extend(sorted(outputs_root.rglob("*.pptx"), key=lambda path: path.stat().st_mtime, reverse=True))
    except OSError:
        logger.debug(
            "BuilderArtifact._latest_valid_pptx_output_file: scan failed for outputs_path=%s",
            _outputs_host_path_from_state(state),
            exc_info=True,
        )
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if not candidate.is_file() or not _is_public_output_file(candidate):
                continue
            if _is_support_output_path(candidate, outputs_root):
                continue
            if min_mtime is not None and candidate.stat().st_mtime < min_mtime:
                continue
        except OSError:
            continue
        if _pptx_integrity_error_for_file(candidate) is None:
            return candidate
    return None


def _pptx_slide_count_matches_plan(diagnostics: dict[str, Any]) -> bool:
    generated_count = int(diagnostics.get("pptx_generator_slide_count", 0) or 0)
    plan_count = int(diagnostics.get("pptx_plan_slide_count", 0) or 0)
    if generated_count <= 0:
        return False
    return plan_count <= 0 or generated_count == plan_count


def _pptx_picture_count_satisfies_slide_count(diagnostics: dict[str, Any]) -> bool:
    generated_count = int(diagnostics.get("pptx_generator_slide_count", 0) or 0)
    picture_count = int(diagnostics.get("pptx_generator_picture_count", 0) or 0)
    return generated_count > 0 and picture_count >= generated_count


def _pptx_requested_target_slide_count(state: dict[str, Any]) -> int:
    for source in (
        state,
        state.get("delegation_context") if isinstance(state.get("delegation_context"), dict) else {},
    ):
        if not isinstance(source, dict):
            continue
        value = source.get("builder_pptx_requested_slide_count") or source.get("target_slide_count")
        if isinstance(value, int) and value > 0:
            return value
    return 0


def _builder_current_turn_index(state: dict[str, Any]) -> int:
    return int(state.get("builder_non_artifact_turns", 0) or 0) + 1


def _only_artifact_tool_calls(artifact_calls: list[dict[str, Any]], tool_calls: list[dict[str, Any]]) -> bool:
    return bool(artifact_calls) and len(artifact_calls) == len(tool_calls)


def _elapsed_since_builder_start_ms(state: dict[str, Any]) -> int | None:
    started = state.get("builder_task_started_at_ms")
    if not isinstance(started, (int, float)) or started <= 0:
        started = state.get("builder_task_kickoff_ms")
    if not isinstance(started, (int, float)) or started <= 0:
        return None
    return max(0, int(time.time() * 1000) - int(started))


def _elapsed_since_presentation_authoring_start_ms(state: dict[str, Any]) -> int | None:
    """Return one stable authoring clock shared by initial and repair turns.

    Older queued runs do not carry the phase timestamp, so they retain their
    historical kickoff-based behavior instead of receiving a fresh budget.
    """

    started = state.get("builder_presentation_authoring_started_at_ms")
    if not isinstance(started, (int, float)) or started <= 0:
        return _elapsed_since_builder_start_ms(state)
    return max(0, int(time.time() * 1000) - int(started))


def _builder_start_ms_or_now(state: dict[str, Any]) -> int:
    started = state.get("builder_task_started_at_ms")
    return int(started) if isinstance(started, (int, float)) and started > 0 else int(time.time() * 1000)


def _remaining_builder_deadline_seconds(state: dict[str, Any]) -> int | None:
    deadline = state.get("builder_deadline_epoch_ms")
    if not isinstance(deadline, (int, float)) or deadline <= 0:
        kickoff = state.get("builder_task_kickoff_ms")
        timeout = state.get("builder_timeout_seconds")
        if isinstance(kickoff, (int, float)) and kickoff > 0 and isinstance(timeout, (int, float)) and timeout > 0:
            deadline = int(kickoff) + int(timeout) * 1000
    if not isinstance(deadline, (int, float)) or deadline <= 0:
        return None
    return max(0, int((int(deadline) - int(time.time() * 1000)) / 1000))


def _pptx_latch_target_slide_count(state: dict[str, Any]) -> int:
    requested = _pptx_requested_target_slide_count(state)
    if requested > 0:
        return requested
    diagnostics = _pptx_diagnostics(state)
    plan_count = diagnostics.get("pptx_plan_slide_count")
    return int(plan_count or 0) if isinstance(plan_count, int) and plan_count > 0 else 0


def _pptx_assets_success_count(state: dict[str, Any]) -> int:
    diagnostics = _pptx_diagnostics(state)
    return int(diagnostics.get("image_generation_success_count", 0) or 0)


def _pptx_explicit_text_only_requested(state: dict[str, Any]) -> bool:
    return bool(_PPTX_TEXT_ONLY_REQUEST_RE.search(_pptx_request_haystack(state)))


def _pptx_extra_generated_visuals_requested(state: dict[str, Any]) -> bool:
    return bool(_PPTX_EXTRA_GENERATED_VISUALS_REQUEST_RE.search(_pptx_request_haystack(state)))


def _pptx_request_haystack(state: dict[str, Any]) -> str:
    haystack_parts: list[str] = []
    for source in (
        state,
        state.get("delegation_context") if isinstance(state.get("delegation_context"), dict) else {},
        state.get("builder_task") if isinstance(state.get("builder_task"), dict) else {},
    ):
        if not isinstance(source, dict):
            continue
        for key in ("task", "task_brief", "description", "user_request"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                haystack_parts.append(value)
    return "\n".join(haystack_parts)


def _pptx_generated_visuals_required(state: dict[str, Any]) -> bool:
    if _deck_build_service_route_active(state):
        return False
    return _requested_pptx_artifact(state) and _builder_image_enrichment_enabled(state) and not _pptx_explicit_text_only_requested(state)


def _pptx_slide_visual_reference_count(state: dict[str, Any]) -> int:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return 0
    slides_dir = outputs_root / "slides"
    assets_dir = outputs_root / "assets"
    if not slides_dir.is_dir() or not assets_dir.is_dir():
        return 0
    referenced_slides = 0
    try:
        slide_files = sorted(path for path in slides_dir.iterdir() if path.is_file() and path.suffix.lower() in {".html", ".htm"})
    except OSError:
        return 0
    for slide in slide_files:
        try:
            source = slide.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        matches = re.findall(r"<img\b[^>]*\bsrc\s*=\s*[\"']\.\./assets/([^\"']+)[\"']", source, flags=re.IGNORECASE)
        for raw_ref in matches:
            ref = raw_ref.strip().replace("\\", "/")
            pure = PurePosixPath(ref)
            if not ref or pure.is_absolute() or ".." in pure.parts:
                continue
            if (assets_dir / Path(*pure.parts)).is_file():
                referenced_slides += 1
                break
    return referenced_slides


def _pptx_expected_generated_visual_count(state: dict[str, Any]) -> int:
    if not _pptx_generated_visuals_required(state):
        return 0
    diagnostics = _pptx_diagnostics(state)
    target = _pptx_latch_target_slide_count(state)
    requested = diagnostics.get("image_generation_manifest_requested_count")
    if isinstance(requested, int) and requested > 0:
        if target > 0 and requested > target and not _pptx_extra_generated_visuals_requested(state):
            return target
        return requested
    if target > 0:
        return target
    slide_count = _pptx_slide_html_count(state)
    return slide_count if slide_count > 0 else 0


def _pptx_successful_generated_visual_count(state: dict[str, Any]) -> int:
    diagnostics = _pptx_diagnostics(state)
    return int(diagnostics.get("image_generation_success_count", 0) or 0)


def _pptx_visual_completeness_counts(state: dict[str, Any]) -> dict[str, int]:
    expected = _pptx_expected_generated_visual_count(state)
    successful = _pptx_successful_generated_visual_count(state)
    referenced = _pptx_slide_visual_reference_count(state)
    missing = 0
    if expected > 0:
        missing = max(0, expected - successful, expected - referenced)
    return {
        "expected_generated_visual_count": expected,
        "successful_generated_visual_count": successful,
        "referenced_visual_count": referenced,
        "missing_expected_visual_count": missing,
    }


def _pptx_generated_visuals_complete(state: dict[str, Any]) -> bool:
    if not _pptx_generated_visuals_required(state):
        return True
    counts = _pptx_visual_completeness_counts(state)
    return (
        counts["expected_generated_visual_count"] > 0
        and counts["successful_generated_visual_count"] >= counts["expected_generated_visual_count"]
        and counts["referenced_visual_count"] >= counts["expected_generated_visual_count"]
        and counts["missing_expected_visual_count"] == 0
    )


def _pptx_valid_output_already_terminal(state: dict[str, Any]) -> bool:
    latest_pptx = _latest_valid_pptx_output_file(state)
    return latest_pptx is not None and _pptx_picture_count_satisfies_slide_count(_pptx_diagnostics(state)) and _pptx_generated_visuals_complete(state)


def _deck_build_service_route_active(state: dict[str, Any]) -> bool:
    delegation = state.get("delegation_context")
    task_type = str(delegation.get("task_type") or "") if isinstance(delegation, dict) else None
    requested_ext = _requested_artifact_ext(state)
    artifact_target_ext = f".{requested_ext}" if requested_ext else None
    return deck_route_for_task(task_type, artifact_target_ext) == "deck_build_service"


def _pptx_visual_completeness_diagnostics_update(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "presentation_route": "deck_creative_html_native" if _deck_build_service_route_active(state) else "html_slide_to_pptx_raster",
        **_pptx_visual_completeness_counts(state),
    }


def _pptx_slide_assets_ready(state: dict[str, Any]) -> bool:
    if not _requested_pptx_artifact(state):
        return False
    if not _pptx_generated_visuals_complete(state):
        return False
    return not _pptx_valid_output_already_terminal(state)


def _pptx_slide_html_count(state: dict[str, Any]) -> int:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return 0
    slides_dir = outputs_root / "slides"
    if not slides_dir.is_dir():
        return 0
    try:
        return sum(1 for path in slides_dir.iterdir() if path.is_file() and path.suffix.lower() in {".html", ".htm"})
    except OSError:
        return 0


def _pptx_slide_html_ready(state: dict[str, Any]) -> bool:
    slide_html_count = _pptx_slide_html_count(state)
    if slide_html_count <= 0:
        return False
    target_count = _pptx_latch_target_slide_count(state)
    if target_count <= 0:
        return True
    return slide_html_count >= target_count


def _pptx_compile_ready(state: dict[str, Any]) -> bool:
    """Deck is ready to compile via build_deck_from_slides.

    Fires on slide-HTML completeness. Image-generation discipline is enforced
    earlier: the primary path is a readable parallel batch, with bounded serial
    repair only for images that failed after a real batch attempt.
    """
    if not _requested_pptx_artifact(state):
        return False
    if not _pptx_slide_html_ready(state):
        return False
    if state.get("builder_pptx_terminal_quality_failed") is True:
        return False
    if not _pptx_generated_visuals_complete(state):
        return False
    return not _pptx_valid_output_already_terminal(state)


def _pptx_latch_diagnostics_update(
    state: dict[str, Any],
    *,
    compile_forced: bool,
) -> dict[str, Any]:
    diagnostics = _pptx_diagnostics(state)
    current_turn = _builder_current_turn_index(state)
    update: dict[str, Any] = {}
    if diagnostics.get("slide_assets_ready_at_turn") is None:
        update["slide_assets_ready_at_turn"] = current_turn
    if compile_forced and diagnostics.get("compile_forced_at_turn") is None:
        update["compile_forced_at_turn"] = current_turn
    return update


def _pptx_terminal_ready_diagnostics_update(state: dict[str, Any]) -> dict[str, Any]:
    diagnostics = _pptx_diagnostics(state)
    update: dict[str, Any] = {}
    if diagnostics.get("pptx_terminal_ready_at_turn") is None:
        update["pptx_terminal_ready_at_turn"] = _builder_current_turn_index(state)
    if diagnostics.get("time_to_first_valid_artifact_ms") is None:
        elapsed = _elapsed_since_builder_start_ms(state)
        if elapsed is not None:
            update["time_to_first_valid_artifact_ms"] = elapsed
    return update


def _pptx_target_slide_count_needs_one_repair(
    diagnostics: dict[str, Any],
    state: dict[str, Any],
) -> bool:
    """Allow one non-blocking repair turn for explicit slide-count drift."""

    return _pptx_slide_count_repair_request(diagnostics, state) is not None


def _pptx_slide_count_repair_request(
    diagnostics: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, int] | None:
    requested = _pptx_requested_target_slide_count(state)
    generated = int(diagnostics.get("pptx_generator_slide_count", 0) or 0)
    if requested <= 0 or generated <= 0 or requested == generated:
        return None
    if state.get("builder_pptx_slide_count_repair_attempted") is True:
        logger.warning(
            "[BuilderPptxReady] slide_count_mismatch_advisory requested=%d generated=%d",
            requested,
            generated,
        )
        return None
    return {"requested_slide_count": requested, "generated_slide_count": generated}


def _pptx_slide_count_repair_message(repair: dict[str, int]) -> str:
    requested = repair["requested_slide_count"]
    generated = repair["generated_slide_count"]
    direction = "remove" if generated > requested else "add"
    return (
        "[Sophia/PPTX slide-count repair]\n"
        f"The current PPTX is valid, but it has {generated} slides while the "
        f"user explicitly requested exactly {requested} total slides. Use this "
        f"one bounded repair turn to {direction} a slide so "
        f"`/mnt/user-data/outputs/slides/` holds exactly {requested} HTML slide "
        "files (including cover and summary), then call `build_deck_from_slides` "
        "again with the same requested `.pptx` output path. Do not polish "
        "unrelated content."
    )


def _pptx_slide_count_repair_attempt_update(state: dict[str, Any]) -> dict[str, Any]:
    if state.get("builder_pptx_slide_count_repair_pending") is not True:
        return {}
    return {
        "builder_pptx_slide_count_repair_pending": False,
        "builder_pptx_slide_count_repair_attempted": True,
    }


def _pptx_slide_count_repair_injection_update(state: dict[str, Any]) -> dict[str, Any] | None:
    if not _requested_pptx_artifact(state):
        return None
    if state.get("builder_pptx_slide_count_repair_directive_emitted") is True:
        return None
    diagnostics = _pptx_diagnostics(state)
    if int(diagnostics.get("pptx_generator_success_count", 0) or 0) < 1:
        return None
    if _latest_valid_pptx_output_file(state) is None:
        return None
    if not _pptx_picture_count_satisfies_slide_count(diagnostics):
        return None
    repair = _pptx_slide_count_repair_request(diagnostics, state)
    if repair is None:
        return None
    logger.warning(
        "[BuilderPptxReady] slide_count_mismatch_repair_once requested=%d generated=%d",
        repair["requested_slide_count"],
        repair["generated_slide_count"],
    )
    return {
        "messages": [HumanMessage(content=_pptx_slide_count_repair_message(repair))],
        "builder_pptx_slide_count_repair_requested": repair,
        "builder_pptx_slide_count_repair_pending": True,
        "builder_pptx_slide_count_repair_directive_emitted": True,
    }


def _builder_image_enrichment_enabled(state: dict[str, Any]) -> bool:
    """Mirror of builder_task's gating, computed from state at emit time."""
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        delegation = {}
    ext = _requested_artifact_ext(state)
    return _image_generation_enabled(
        delegation,
        artifact_target_ext=f".{ext}" if ext else "",
        task_type=str(delegation.get("task_type") or ""),
    )


def _image_generation_outcome_from_state(state: dict[str, Any]) -> dict[str, Any] | None:
    """Harness-stamped enrichment outcome (Spec VQ-3).

    Never model-supplied: a build where image generation was enabled can
    never end ambiguous — the completion payload always says attempted /
    succeeded / why-not. ``None`` when enrichment was not enabled.
    """
    if not _builder_image_enrichment_enabled(state):
        return None
    diagnostics = _pptx_diagnostics(state)
    attempted = int(diagnostics.get("image_generation_attempt_count", 0) or 0)
    startup_attempted = int(diagnostics.get("image_generation_startup_attempt_count", 0) or 0)
    succeeded = int(diagnostics.get("image_generation_success_count", 0) or 0)
    skip_reason = diagnostics.get("image_generation_skip_reason")
    if not skip_reason and succeeded == 0:
        if attempted == 0 and startup_attempted > 0:
            skip_reason = diagnostics.get("image_generation_startup_error_class") or "startup_failed"
        elif attempted == 0 and int(diagnostics.get("manifest_authoring_failure_count", 0) or 0) > 0:
            skip_reason = diagnostics.get("primary_image_batch_error_class") or "manifest_authoring_failed"
        elif attempted == 0:
            skip_reason = "model_skipped"
        else:
            error_class = str(diagnostics.get("image_generation_error_class") or "")
            if error_class == "content_blocked":
                skip_reason = "content_policy"
            elif error_class in _IMAGE_GENERATION_TERMINAL_ERRORS:
                skip_reason = error_class
            else:
                skip_reason = "failed_after_retry"
    outcome: dict[str, Any] = {"attempted": attempted, "succeeded": succeeded}
    outcome.update(_pptx_visual_completeness_counts(state))
    for source_key, outcome_key in (
        ("primary_image_batch_status", "primary_batch_status"),
        ("primary_image_batch_error_class", "primary_batch_error_class"),
        ("serial_repair_count", "serial_repair_count"),
        ("manifest_authoring_failure_count", "manifest_authoring_failure_count"),
        ("image_generation_startup_error_class", "startup_error_class"),
        ("image_generation_exit_code", "exit_code"),
    ):
        value = diagnostics.get(source_key)
        if value not in (None, "", 0):
            outcome[outcome_key] = value
    if skip_reason and succeeded == 0:
        outcome["skip_reason"] = str(skip_reason)
    return outcome


def _image_generation_preflight_delta(text: str) -> dict[str, Any]:
    """Record the preflight outcome (VQ-3) — never counts as an attempt.

    The script prints exactly one JSON line:
    ``{"preflight": "ok"}`` or ``{"preflight": "failed", "reason": "..."}``.
    """
    status = "ok"
    reason: str | None = None
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and "preflight" in payload:
            status = str(payload.get("preflight") or "ok")
            raw_reason = payload.get("reason")
            reason = str(raw_reason) if raw_reason else None
            break
    else:
        # No parseable line — a crashed preflight is a failed preflight.
        status = "failed"
        reason = "preflight_unparseable"
    logger.info(
        "[BuilderImageGeneration] phase=preflight status=%s reason=%s",
        status,
        reason,
    )
    delta: dict[str, Any] = {"image_generation_preflight": status}
    if status != "ok" and reason:
        delta["image_generation_skip_reason"] = reason
    return delta


def _image_generation_invocations_in_command(command: str) -> int:
    # The path markers are substrings of one another (with/without /mnt, with/
    # without /public) — count the shared canonical suffix instead of summing
    # marker hits, which would double-count a single invocation.
    return command.count("image-generation/scripts/generate.py")


def _image_generation_billable_invocations_in_command(command: str) -> int:
    return sum(1 for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS) if "--preflight" not in _command_parts(segment))


def _host_path_for_manifest_item_path(
    state: dict[str, Any] | None,
    raw_path: object,
    *,
    manifest_host: Path,
) -> Path | None:
    if state is None or not isinstance(raw_path, str) or not raw_path.strip():
        return None
    normalized = raw_path.replace("\\", "/").strip()
    if normalized.startswith(("/mnt/user-data/outputs/", "/mnt/user-data/workspace/")):
        return BuilderArtifactMiddleware._host_path_for_plan_file(state, normalized)
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    return manifest_host.parent / Path(*pure.parts)


def _manifest_output_targets_outputs(raw_path: object) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    normalized = raw_path.replace("\\", "/").strip()
    if normalized.startswith("/mnt/user-data/outputs/"):
        return True
    if normalized.startswith("/mnt/user-data/workspace/"):
        return False
    pure = PurePosixPath(normalized)
    return not pure.is_absolute() and ".." not in pure.parts


def _manifest_schema_authoring_error(state: dict[str, Any] | None, data: Any, items: list[Any]) -> str | None:
    if not isinstance(state, dict) or not _pptx_generated_visuals_required(state):
        return None
    if not isinstance(data, dict):
        return "manifest_items_missing"
    if data.get("schema_version") != _PPTX_IMAGE_MANIFEST_SCHEMA_VERSION:
        return "manifest_not_deterministic"
    if data.get("manifest_author") != _PPTX_IMAGE_MANIFEST_AUTHOR:
        return "manifest_not_deterministic"
    for item in items:
        if not isinstance(item, dict):
            return "manifest_items_missing"
        if item.get("schema_version") != _PPTX_IMAGE_MANIFEST_SCHEMA_VERSION:
            return "manifest_not_deterministic"
        slide_index = item.get("slide_index")
        if not isinstance(slide_index, int) or slide_index <= 0:
            return "manifest_not_deterministic"
        if item.get("slide_visual") is not True:
            return "manifest_not_deterministic"
    return None


def _manifest_authoring_error(
    state: dict[str, Any] | None,
    manifest_host: Path,
    items: list[Any],
) -> str | None:
    for item in items:
        if not isinstance(item, dict):
            return "manifest_items_missing"
        prompt_file = item.get("prompt_file")
        output_file = item.get("output_file")
        if not isinstance(prompt_file, str) or not prompt_file.strip() or not isinstance(output_file, str) or not output_file.strip():
            return "manifest_prompt_or_output_missing"
        if not _manifest_output_targets_outputs(output_file):
            return "manifest_output_not_outputs"
        prompt_host = _host_path_for_manifest_item_path(state, prompt_file, manifest_host=manifest_host)
        if prompt_host is None or not prompt_host.is_file():
            return "manifest_prompt_missing"
    return None


def _manifest_item_count_status(
    state: dict[str, Any] | None,
    manifest_path: str | None,
) -> tuple[int, str | None]:
    """Return ``(item_count, error_reason)`` for an image batch manifest."""

    if not manifest_path:
        return 0, "manifest_path_missing"
    if state is None:
        return 0, "manifest_state_missing"
    normalized_manifest = str(manifest_path).replace("\\", "/").strip()
    if not normalized_manifest.startswith("/mnt/user-data/outputs/"):
        return 0, "manifest_path_not_outputs"
    host = BuilderArtifactMiddleware._host_path_for_plan_file(state, manifest_path)
    if host is None:
        return 0, "manifest_path_not_outputs"
    if not host.is_file():
        return 0, "manifest_not_readable"
    try:
        data = json.loads(host.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0, "manifest_invalid_json"
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        return 0, "manifest_items_missing"
    schema_error = _manifest_schema_authoring_error(state, data, items)
    if schema_error is not None:
        return len(items), schema_error
    authoring_error = _manifest_authoring_error(state, host, items)
    if authoring_error is not None:
        return len(items), authoring_error
    return len(items), None


def _manifest_item_count(state: dict[str, Any] | None, manifest_path: str | None) -> int:
    """Best-effort count of items in an image-gen batch manifest (>=1)."""

    count, error_reason = _manifest_item_count_status(state, manifest_path)
    return count if error_reason is None else 1


def _pptx_manifest_count_rejection_reason(state: dict[str, Any] | None, count: int) -> str | None:
    if not isinstance(state, dict) or count <= 0:
        return None
    if not _pptx_generated_visuals_required(state):
        return None
    target = _pptx_latch_target_slide_count(state)
    if target <= 0 or count <= target:
        return None
    if _pptx_extra_generated_visuals_requested(state):
        return None
    return "manifest_item_count_exceeds_slide_count"


def _serial_repair_output_paths_for_segments(segments: list[str]) -> list[str]:
    outputs: list[str] = []
    for segment in segments:
        output_file = _command_flag_value(segment, "--output-file")
        canonical = _canonical_outputs_artifact_path(output_file)
        outputs.append(canonical or "")
    return outputs


def _serial_repair_allowed_outputs(diagnostics: dict[str, Any]) -> set[str]:
    raw_outputs = diagnostics.get("image_generation_manifest_unresolved_outputs")
    if not isinstance(raw_outputs, list) or not raw_outputs:
        raw_outputs = diagnostics.get("image_generation_manifest_failed_outputs")
    if not isinstance(raw_outputs, list):
        return set()
    return {canonical for raw in raw_outputs for canonical in [_canonical_outputs_artifact_path(raw)] if canonical is not None}


def _serial_repair_output_attempts(diagnostics: dict[str, Any]) -> dict[str, int]:
    raw = diagnostics.get("serial_repair_output_attempts")
    if not isinstance(raw, dict):
        return {}
    return {key: int(value) for key, value in raw.items() if isinstance(key, str) and isinstance(value, int) and value > 0}


def _serial_repair_rejection_reason(
    diagnostics: dict[str, Any],
    billable_segments: list[str],
) -> str | None:
    allowed_outputs = _serial_repair_allowed_outputs(diagnostics)
    if not allowed_outputs:
        return "[Sophia/deck-batch] Serial image repair requires structured batch item diagnostics. Rerun the manifest batch once to obtain `IMAGEGEN_BATCH`, or stop cleanly with artifact_path=null if the batch summary is still missing."
    attempts = _serial_repair_output_attempts(diagnostics)
    requested_this_call: dict[str, int] = {}
    for output_file in _serial_repair_output_paths_for_segments(billable_segments):
        if not output_file:
            return "[Sophia/deck-batch] Serial image repair must write to an explicit `/mnt/user-data/outputs/...` output_file from the failed manifest item."
        if output_file not in allowed_outputs:
            return (
                f"[Sophia/deck-batch] Serial image repair may only target failed/missing outputs from the original manifest. Use the same manifest `prompt_file` and `output_file` for {output_file}, or stop cleanly with artifact_path=null."
            )
        requested_this_call[output_file] = requested_this_call.get(output_file, 0) + 1
        if attempts.get(output_file, 0) + requested_this_call[output_file] > _SERIAL_REPAIR_ATTEMPTS_PER_FAILED_SLIDE:
            return "[Sophia/deck-batch] Serial image repair is exhausted for one or more failed manifest outputs. Stop cleanly with artifact_path=null rather than compiling a partial placeholder deck."
    return None


def _manifest_rejection_reason(command: str, state: dict[str, Any] | None) -> str | None:
    for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS):
        if "--preflight" in _command_parts(segment):
            continue
        manifest_path = _command_flag_value(segment, "--manifest")
        if not manifest_path:
            continue
        count, error_reason = _manifest_item_count_status(state, manifest_path)
        if error_reason is None and count > 0:
            count_rejection = _pptx_manifest_count_rejection_reason(state, count)
            if count_rejection is not None:
                return count_rejection
            continue
        return error_reason or "manifest_not_readable"
    return None


def _unreadable_manifest_rejection(command: str, state: dict[str, Any] | None) -> str | None:
    error_reason = _manifest_rejection_reason(command, state)
    if error_reason is None:
        return None
    diagnostics = _pptx_diagnostics(state or {})
    previous_authoring_failures = int(diagnostics.get("manifest_authoring_failure_count", 0) or 0)
    if error_reason in _MANIFEST_AUTHORING_ERRORS and previous_authoring_failures >= 1:
        return (
            "[Sophia/image-generation] The image batch manifest is still not dispatch-ready after "
            "one correction attempt "
            f"({error_reason}). Stop cleanly with artifact_path=null and explain that the deck image "
            "manifest could not be materialized; do not serialize the remaining deck or compile a "
            "partial placeholder deck."
        )
    if error_reason == "manifest_prompt_missing":
        return (
            "[Sophia/image-generation] The batch manifest exists, but at least one `prompt_file` "
            "does not resolve to a readable JSON prompt. Materialize every prompt JSON first, keep "
            "the same prompt file order, call `prepare_pptx_image_manifest(prompt_files=[...])`, "
            "then rerun the returned `--manifest` batch. Do not switch to serial image calls."
        )
    if error_reason == "manifest_prompt_or_output_missing":
        return (
            "[Sophia/image-generation] The batch manifest is missing required prompt/output fields. "
            "Do not edit the manifest by hand. Write one prompt JSON file per slide, call "
            "`prepare_pptx_image_manifest(prompt_files=[...])`, then rerun the returned "
            "`--manifest` batch. Do not switch to serial image calls."
        )
    if error_reason == "manifest_not_deterministic":
        return (
            "[Sophia/image-generation] Normal PPTX decks must use the deterministic manifest "
            "prepared by `prepare_pptx_image_manifest`; do not hand-write or improvise the "
            "batch manifest JSON. Write one prompt JSON file per requested slide, call "
            "`prepare_pptx_image_manifest(prompt_files=[...])`, then run the returned "
            "`manifest_path` with `image-generation/scripts/generate.py --manifest <path>`. "
            "Do not switch to serial image calls."
        )
    if error_reason == "manifest_output_not_outputs":
        return (
            "[Sophia/image-generation] Every batch manifest item `output_file` must point inside "
            "`/mnt/user-data/outputs/...` or use a relative path under the manifest directory. "
            "Do not edit the manifest by hand; call `prepare_pptx_image_manifest(prompt_files=[...])` "
            "again and rerun the returned `--manifest` batch before any image generation."
        )
    if error_reason == "manifest_item_count_exceeds_slide_count":
        target = _pptx_latch_target_slide_count(state or {})
        return (
            "[Sophia/image-generation] The PPTX image batch manifest has more slide-visual items "
            f"than the requested deck slide count ({target}). Normal decks require exactly one "
            "generated visual per slide. Use exactly one prompt file per slide, call "
            "`prepare_pptx_image_manifest(prompt_files=[...])`, and rerun the returned "
            "`--manifest` batch; do not switch to serial image calls."
        )
    return (
        "[Sophia/image-generation] The image batch manifest must be prepared as a readable JSON "
        "file under `/mnt/user-data/outputs/` before `generate.py --manifest` is invoked. "
        f"The current manifest cannot be used ({error_reason}). Write one prompt JSON file per "
        "slide, call `prepare_pptx_image_manifest(prompt_files=[...])`, then run the returned "
        "manifest path in a separate bash call so the harness can count and enforce the image "
        "budget before any API calls run."
    )


def _manifest_error_class_from_text(text: str, fallback: str = "batch_summary_missing") -> str:
    error_class = _classify_image_generation_error(text, False, 0)
    if error_class in _IMAGE_GENERATION_TERMINAL_ERRORS or error_class == "content_blocked":
        return error_class
    return fallback


def _safe_image_generation_error_excerpt(text: str, *, limit: int = 500) -> str | None:
    if not text:
        return None
    safe_lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if "PROMPT_SENT_FULL" in stripped:
            stripped = "[gen] PROMPT_SENT_FULL: [redacted]"
        stripped = re.sub(r"\bsk-[A-Za-z0-9_-]+", "sk-[redacted]", stripped)
        stripped = re.sub(r"\blsv2_[A-Za-z0-9_-]+", "lsv2_[redacted]", stripped)
        stripped = re.sub(
            r"(api[_-]?key|authorization|bearer)\s*[:=]\s*['\"]?[^'\"\s]+",
            r"\1=[redacted]",
            stripped,
            flags=re.IGNORECASE,
        )
        safe_lines.append(stripped)
    if not safe_lines:
        return None
    excerpt = "\n".join(safe_lines[-8:])
    if len(excerpt) > limit:
        excerpt = excerpt[-limit:]
        excerpt = "...[truncated]" + excerpt
    return excerpt


def _image_generation_exit_code_from_text(text: str) -> int | None:
    patterns = (
        r"\bexit(?:\s+code)?\s*[:=]\s*(\d+)\b",
        r"\breturncode\s*[:=]\s*(\d+)\b",
        r"\bexit_(\d+)\b",
        r"returned non-zero exit status\s+(\d+)",
    )
    for pattern in patterns:
        match = re.search(pattern, text or "", flags=re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except (TypeError, ValueError):
                continue
    return None


def _image_generation_command_basename(command: str | None) -> str | None:
    if not command:
        return None
    for part in _command_parts(command):
        if "image-generation/scripts/generate.py" in part:
            return PurePosixPath(part).name or Path(part).name or "generate.py"
    return None


def _image_generation_script_exists_from_command(command: str | None) -> bool | None:
    if not command:
        return None
    for part in _command_parts(command):
        if "image-generation/scripts/generate.py" not in part:
            continue
        if part.startswith("/mnt/"):
            return None
        try:
            return Path(part).is_file()
        except OSError:
            return False
    return None


def _classify_image_batch_startup_error(text: str, fallback: str) -> str:
    lowered = (text or "").lower()
    if "unsafe absolute paths in command" in lowered or "use paths under /mnt/user-data" in lowered:
        return "sandbox_path_rejected"
    if ("can't open file" in lowered or "no such file or directory" in lowered) and "image-generation/scripts/generate.py" in lowered:
        return "image_script_not_found"
    if re.search(r"\bpython(?:3)?\s*:\s*(?:command not found|not found)", lowered) or "no such file or directory: 'python" in lowered or "failed to find interpreter" in lowered:
        return "python_not_found"
    if "modulenotfounderror" in lowered or "importerror" in lowered or "no module named" in lowered:
        return "import_error"
    if "permission denied" in lowered:
        return "permission_denied"
    if "shell error" in lowered or "syntax error" in lowered or "unexpected eof" in lowered or "bad substitution" in lowered:
        return "shell_error"
    return _manifest_error_class_from_text(text, fallback)


def _image_generation_startup_diagnostics(
    text: str,
    *,
    command: str | None,
    fallback: str,
) -> dict[str, Any]:
    command_hash = hashlib.sha256((command or "").encode("utf-8")).hexdigest()[:16] if command else None
    diagnostics: dict[str, Any] = {
        "startup_error_class": _classify_image_batch_startup_error(text, fallback),
        "raw_error_excerpt": _safe_image_generation_error_excerpt(text),
        "exit_code": _image_generation_exit_code_from_text(text),
        "command_hash": command_hash,
        "command_basename": _image_generation_command_basename(command),
        "script_exists": _image_generation_script_exists_from_command(command),
        "stdout_chars": len(text or ""),
        "stderr_chars": 0,
    }
    return {key: value for key, value in diagnostics.items() if value not in (None, "")}


_MANIFEST_ERROR_KEYS = ("error_class", "error_type", "reason", "error")


def _first_manifest_error_value(record: object) -> str | None:
    if not isinstance(record, dict):
        return None
    return next(
        (value.strip() for key in _MANIFEST_ERROR_KEYS for value in [record.get(key)] if isinstance(value, str) and value.strip()),
        None,
    )


def _manifest_histogram_errors(payload: dict[str, Any]) -> list[str]:
    histogram = payload.get("error_class_histogram")
    if not isinstance(histogram, dict):
        return []
    return [str(key) for key, count in histogram.items() if count]


def _manifest_item_errors(payload: dict[str, Any]) -> list[str]:
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    return [item_error for item in items if isinstance(item, dict) and not item.get("success") for item_error in [_first_manifest_error_value(item)] if item_error]


def _manifest_error_values(payload: dict[str, Any]) -> list[str]:
    values = _manifest_histogram_errors(payload)
    if payload_error := _first_manifest_error_value(payload):
        values.append(payload_error)
    values.extend(_manifest_item_errors(payload))
    return values


def _manifest_error_class_from_payload(payload: dict[str, Any], text: str) -> str | None:
    values = _manifest_error_values(payload)
    terminal = next((value for value in values if value in _IMAGE_GENERATION_TERMINAL_ERRORS), None)
    if terminal:
        return terminal
    if values:
        return values[0]
    classified = _manifest_error_class_from_text(text, fallback="")
    return classified or None


def _empty_image_batch_summary(text: str, fallback: str, *, command: str | None = None) -> dict[str, Any]:
    diagnostics = _image_generation_startup_diagnostics(text, command=command, fallback=fallback)
    error_class = str(diagnostics.get("startup_error_class") or _manifest_error_class_from_text(text, fallback))
    return {
        "requested": 0,
        "successful_paths": [],
        "summary_present": False,
        "error_class": error_class,
        **diagnostics,
    }


def _image_batch_payload_from_text(text: str) -> tuple[dict[str, Any] | None, str]:
    for line in reversed((text or "").splitlines()):
        stripped = line.strip()
        if not (stripped == "IMAGEGEN_BATCH" or stripped.startswith("IMAGEGEN_BATCH ")):
            continue
        payload_str = stripped[len("IMAGEGEN_BATCH") :].strip()
        try:
            payload = json.loads(payload_str)
        except json.JSONDecodeError:
            return None, "invalid_batch_summary"
        return (payload, "") if isinstance(payload, dict) else (None, "invalid_batch_summary")
    return None, "batch_summary_missing"


def _image_batch_items(payload: dict[str, Any]) -> list[Any]:
    items = payload.get("items")
    return items if isinstance(items, list) else []


def _image_batch_successful_paths(items: list[Any]) -> list[str]:
    return [str(item.get("output_file")) for item in items if isinstance(item, dict) and item.get("success") and item.get("output_file")]


def _image_batch_error_histogram(payload: dict[str, Any]) -> dict[Any, Any]:
    histogram = payload.get("error_class_histogram")
    return histogram if isinstance(histogram, dict) else {}


def _image_batch_complete(payload: dict[str, Any], requested: int, generated: int) -> bool:
    if "complete" in payload:
        return bool(payload.get("complete"))
    return requested > 0 and generated == requested


def _image_batch_summary_from_payload(payload: dict[str, Any], text: str) -> dict[str, Any]:
    items = _image_batch_items(payload)
    requested = int(payload.get("requested") or 0) or len(items)
    generated = int(payload.get("images_generated") or 0)
    failed = int(payload.get("failed") or max(0, requested - generated))
    return {
        "requested": requested,
        "images_generated": generated,
        "failed": failed,
        "complete": _image_batch_complete(payload, requested, generated),
        "summary_present": True,
        "concurrency": payload.get("concurrency"),
        "requested_concurrency": payload.get("requested_concurrency"),
        "max_concurrency": payload.get("max_concurrency"),
        "successful_paths": _image_batch_successful_paths(items),
        "items": items,
        "error_class_histogram": _image_batch_error_histogram(payload),
        "error_class": _manifest_error_class_from_payload(payload, text),
        "exit_code": payload.get("exit_code"),
        "raw_error_excerpt": payload.get("raw_error_excerpt"),
    }


def _image_generation_images_in_command(command: str, state: dict[str, Any] | None = None) -> int:
    """Number of IMAGES a billable image-generation command will produce.

    A ``--manifest`` call generates N images in one invocation (the parallel
    batch path); count the manifest's items so the per-build cap and cost
    accounting track images, not script invocations. Non-manifest calls are one
    image each. Preflight-only segments are free.
    """
    total = 0
    for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS):
        if "--preflight" in _command_parts(segment):
            continue
        manifest_path = _command_flag_value(segment, "--manifest")
        total += _manifest_item_count(state, manifest_path) if manifest_path else 1
    return total


def _parse_image_batch_summary(text: str, *, command: str | None = None) -> dict[str, Any]:
    """Parse the ``IMAGEGEN_BATCH`` JSON summary line from a batch run.

    Returns structured batch diagnostics. The harness still verifies reported
    output paths locally before counting them as successful.
    """
    payload, error_class = _image_batch_payload_from_text(text)
    if payload is None:
        return _empty_image_batch_summary(text, error_class, command=command)
    return _image_batch_summary_from_payload(payload, text)


def _existing_image_batch_paths(
    state: dict[str, Any],
    paths: list[str],
) -> tuple[list[str], int, int]:
    existing: list[str] = []
    bytes_total = 0
    missing = 0
    for path in paths:
        exists, bytes_count, _status_reason = _virtual_output_status(state, path)
        if exists:
            existing.append(path)
            bytes_total += bytes_count
        else:
            missing += 1
    return existing, bytes_total, missing


def _manifest_expected_items(state: dict[str, Any], manifest_path: str) -> list[dict[str, Any]]:
    host = BuilderArtifactMiddleware._host_path_for_plan_file(state, manifest_path)
    if host is None or not host.is_file():
        return []
    try:
        data = json.loads(host.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    expected: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        prompt_file = str(item.get("prompt_file") or "")
        prompt_host = _host_path_for_manifest_item_path(state, prompt_file, manifest_host=host)
        prompt_hash = None
        prompt_readable = prompt_host is not None and prompt_host.is_file()
        if prompt_readable:
            try:
                prompt_hash = hashlib.sha256(prompt_host.read_bytes()).hexdigest()[:16]
            except OSError:
                prompt_hash = None
        output_file = str(item.get("output_file") or "")
        canonical_output = _canonical_outputs_artifact_path(output_file)
        slide_index = item.get("slide_index") or item.get("slide_number") or item.get("slide")
        expected.append(
            {
                "item_index": index,
                "slide_index": slide_index if isinstance(slide_index, int) and slide_index > 0 else index,
                "prompt_file": PurePosixPath(prompt_file).name,
                "prompt_hash": prompt_hash,
                "prompt_readable": prompt_readable,
                "output_file": canonical_output or output_file,
                "output_basename": PurePosixPath(output_file).name,
                "slide_visual": bool(item.get("slide_visual")),
            }
        )
    return expected


def _manifest_expected_items_for_paths(state: dict[str, Any], manifest_paths: list[str]) -> list[dict[str, Any]]:
    return [item for manifest_path in manifest_paths for item in _manifest_expected_items(state, manifest_path)]


def _manifest_expected_output_paths(expected_items: list[dict[str, Any]]) -> list[str]:
    return [output_file for item in expected_items for output_file in [item.get("output_file")] if isinstance(output_file, str) and _canonical_outputs_artifact_path(output_file) is not None]


def _unresolved_manifest_output_paths(state: dict[str, Any], expected_items: list[dict[str, Any]]) -> list[str]:
    unresolved: list[str] = []
    for output_file in _manifest_expected_output_paths(expected_items):
        exists, _bytes_count, _reason = _virtual_output_status(state, output_file)
        if not exists:
            unresolved.append(output_file)
    return unresolved


def _image_generation_manifest_result_delta(
    state: dict[str, Any],
    text: str,
    *,
    requested_hint: int = 0,
    manifest_paths: list[str] | None = None,
    command: str | None = None,
) -> tuple[list[str], int, str | None, dict[str, Any]]:
    batch_summary = _parse_image_batch_summary(text, command=command)
    batch_paths, batch_bytes, batch_missing_outputs = _existing_image_batch_paths(
        state,
        list(batch_summary.get("successful_paths") or []),
    )
    requested = int(batch_summary.get("requested", 0) or 0) or int(requested_hint or 0)
    expected_items = _manifest_expected_items_for_paths(state, list(manifest_paths or []))
    if expected_items and requested <= 0:
        requested = len(expected_items)
    generated = len(batch_paths)
    error_class = "missing_batch_output" if batch_missing_outputs else batch_summary.get("error_class")
    manifest_complete = requested > 0 and generated == requested and batch_missing_outputs == 0
    authoring_failure = error_class in _MANIFEST_AUTHORING_ERRORS
    summary_present = bool(batch_summary.get("summary_present"))
    generation_attempted = requested > 0 and summary_present and not authoring_failure
    startup_failure = not summary_present or error_class in {"batch_summary_missing", "invalid_batch_summary", "sandbox_path_rejected"}
    unresolved_outputs = _unresolved_manifest_output_paths(state, expected_items)
    delta: dict[str, Any] = {
        "image_generation_manifest_seen": True,
        "image_generation_manifest_requested_count": requested,
        "image_generation_manifest_success_count": generated,
        "image_generation_manifest_failed_count": max(0, requested - generated),
        "image_generation_manifest_complete": manifest_complete,
        "image_generation_manifest_generation_attempted": generation_attempted,
        "primary_image_batch_status": "success" if manifest_complete else "failed",
        "primary_image_batch_error_class": None if manifest_complete else error_class,
        "expected_generated_visual_count": requested,
        "successful_generated_visual_count": generated,
    }
    if expected_items:
        delta["image_generation_manifest_expected_items"] = expected_items
        delta["image_generation_manifest_unresolved_outputs"] = unresolved_outputs
        delta["image_generation_manifest_failed_outputs"] = unresolved_outputs if generation_attempted else []
    if startup_failure:
        delta["batch_summary_missing_count"] = 1
        delta["image_generation_startup_attempt_count"] = 1
    if authoring_failure:
        delta["manifest_authoring_failure_count"] = 1
    if batch_summary.get("error_class_histogram"):
        delta["image_generation_manifest_error_histogram"] = batch_summary.get("error_class_histogram")
    if batch_summary.get("concurrency") is not None:
        delta["image_generation_manifest_concurrency"] = batch_summary.get("concurrency")
    if batch_summary.get("startup_error_class"):
        delta["image_generation_startup_error_class"] = batch_summary.get("startup_error_class")
    if batch_summary.get("exit_code") is not None:
        delta["image_generation_exit_code"] = batch_summary.get("exit_code")
    if batch_summary.get("raw_error_excerpt"):
        delta["image_generation_raw_error_excerpt"] = batch_summary.get("raw_error_excerpt")
    for source_key, target_key in (
        ("command_hash", "image_generation_command_hash"),
        ("command_basename", "image_generation_command_basename"),
        ("script_exists", "image_generation_script_exists"),
        ("stdout_chars", "image_generation_stdout_chars"),
        ("stderr_chars", "image_generation_stderr_chars"),
    ):
        if source_key in batch_summary:
            delta[target_key] = batch_summary[source_key]
    return batch_paths, batch_bytes, error_class, delta


def _autowire_plan_path(request: "ToolCallRequest") -> str | None:
    """Plan-file path when the bash call is an autowire-eligible pptx run."""
    tool_name = str(request.tool_call.get("name") or "")
    if tool_name not in {"bash", "bash_tool"}:
        return None
    args = request.tool_call.get("args") or {}
    command = str(args.get("command") or "") if isinstance(args, dict) else ""
    if not any(marker in command for marker in _PPTX_GENERATOR_PATH_MARKERS):
        return None
    if _command_flag_values(command, "--slide-images"):
        return None
    return _command_flag_value(command, "--plan-file")


def _load_plan_slides(host_plan: Path) -> tuple[dict | None, list | None]:
    try:
        plan = json.loads(host_plan.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None
    slides = plan.get("slides") if isinstance(plan, dict) else None
    if not isinstance(slides, list) or not slides:
        return None, None
    return plan, slides


def _relative_plan_asset_status(plan_dir: Path, ref: str) -> tuple[bool, int, str | None]:
    normalized = ref.replace("\\", "/").strip()
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or ".." in pure.parts:
        return False, 0, "unsafe_relative_plan_asset"
    host_path = plan_dir / normalized
    if not host_path.is_file():
        return False, 0, "missing_relative_plan_asset"
    try:
        return True, int(host_path.stat().st_size), None
    except OSError:
        return False, 0, "relative_plan_asset_stat_failed"


def _slide_visual_ref_status(
    state: dict[str, Any],
    ref: str,
    *,
    plan_dir: Path | None = None,
) -> tuple[bool, int, str | None]:
    exists, bytes_count, reason = _virtual_output_status(state, ref)
    if exists or plan_dir is None:
        return exists, bytes_count, reason
    return _relative_plan_asset_status(plan_dir, ref)


def _drop_invalid_slide_image_refs(
    slides: list,
    state: dict[str, Any],
    *,
    plan_dir: Path | None = None,
) -> tuple[int, bool]:
    """Strip refs to nonexistent files; return (valid_ref_count, changed)."""
    referenced = 0
    changed = False
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        for key in ("image_path", "image"):
            ref = slide.get(key)
            if not isinstance(ref, str) or not ref.strip():
                continue
            exists, _bytes, _reason = _slide_visual_ref_status(state, ref.strip(), plan_dir=plan_dir)
            if exists:
                referenced += 1
            else:
                slide.pop(key, None)
                changed = True
                logger.warning(
                    "[BuilderVisualDiagnostics] phase=plan_invalid_image_ref_dropped slide_title=%s ref=%s",
                    slide.get("title"),
                    ref,
                )
    return referenced, changed


def _existing_asset_paths(state: dict[str, Any], candidates: list, suffixes: set[str]) -> list[str]:
    assets = []
    for asset in candidates:
        if not isinstance(asset, str):
            continue
        if PurePosixPath(asset).suffix.lower() not in suffixes:
            continue
        exists, _bytes, _reason = _virtual_output_status(state, asset)
        if exists:
            assets.append(asset)
    return assets


def _hero_wire_targets(slides: list) -> list[dict]:
    return [slide for slide in slides if isinstance(slide, dict) and not _slide_image_ref(slide)]


def _wire_hero_assets(slides: list, hero_assets: list[str]) -> int:
    wired = 0
    default_style = next(
        (str(slide.get("visual_style") or slide.get("visualStyle") or "").strip() for slide in slides if isinstance(slide, dict) and str(slide.get("visual_style") or slide.get("visualStyle") or "").strip()),
        "",
    )
    for slide, asset in zip(_hero_wire_targets(slides), hero_assets, strict=False):
        slide["image"] = asset
        if default_style and not (slide.get("visual_style") or slide.get("visualStyle")):
            slide["visual_style"] = default_style
        wired += 1
    return wired


def _wire_plan_visual_assets(slides: list, state: dict[str, Any]) -> bool:
    """Wire generated slide images into unreferenced slides."""
    hero_assets = _existing_asset_paths(
        state,
        _pptx_diagnostics(state).get("image_output_paths") or [],
        {".png", ".jpg", ".jpeg"},
    )
    hero_wired = _wire_hero_assets(slides, hero_assets) if hero_assets else 0
    if hero_wired:
        logger.warning(
            "[BuilderVisualDiagnostics] phase=plan_visuals_autowired hero_wired=%d hero_assets=%d slide_count=%d",
            hero_wired,
            len(hero_assets),
            len(slides),
        )
    return bool(hero_wired)


def _write_plan_file(host_plan: Path, plan: dict, plan_path: str) -> None:
    try:
        host_plan.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        logger.warning(
            "[BuilderVisualDiagnostics] phase=plan_autowire_write_failed plan=%s",
            plan_path,
            exc_info=True,
        )


_PATH_CORRECTABLE_WRITE_ERROR_CLASSES = {
    "path_is_directory",
    "path_not_outputs",
    "path_traversal",
    "permission_denied",
    "write_tool_error",
}
_RUNTIME_WRITE_ERROR_CLASSES = {
    "missing_thread_data",
    "missing_thread_id",
    "sandbox_not_found",
    "sandbox_runtime",
    "unexpected_write_error",
    "write_os_error",
}
_PROMOTABLE_DELIVERABLE_EXTENSIONS = frozenset(
    {
        ".pdf",
        ".pptx",
        ".docx",
        ".xlsx",
        ".png",
        ".jpg",
        ".jpeg",
        ".svg",
        ".html",
        ".htm",
        ".zip",
        ".md",
        ".txt",
        ".csv",
        ".json",
        ".yaml",
        ".yml",
        ".js",
        ".ts",
        ".css",
    }
)
_PROMOTION_SUPPORT_DIR_NAMES = frozenset(
    {
        ".builder",
        "assets",
        "deck_build",
        "slides",
        "source_artifact",
        "sources",
        "visuals",
    }
)
_PDF_FALLBACK_EXTENSIONS = frozenset({".md", ".html"})
_PDF_RENDER_SOURCE_EXTENSIONS = frozenset({".md", ".markdown", ".html", ".htm"})
_PDF_RENDERABLE_HTML_SOURCE_EXTENSIONS = frozenset({".html", ".htm"})
_PPTX_FALLBACK_EXTENSIONS = frozenset({".md", ".html"})
_PPTX_REQUIRED_ZIP_ENTRIES = frozenset(
    {
        "[Content_Types].xml",
        "_rels/.rels",
        "ppt/presentation.xml",
    }
)
_HTML_ARTIFACT_SUFFIXES = frozenset({".html", ".htm"})
_PPTX_MIN_BYTES = 1024
_PPTX_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
_HTML_FALLBACK_MIN_BYTES = 128
_PDF_VISUAL_FALLBACK_MARKERS = (
    "chart",
    "charts",
    "diagram",
    "diagrams",
    "visual",
    "visuals",
    "visualization",
    "visualisation",
    "infographic",
    "layout",
    "image",
    "images",
)
_VISUAL_REQUEST_MARKERS = _PDF_VISUAL_FALLBACK_MARKERS + (
    "flowchart",
    "timeline",
    "matrix",
    "quadrant",
    "concept map",
)
_VISUAL_DESIGN_SKILL_PATH_MARKERS = (
    "/skills/public/visual-design/SKILL.md",
    "/mnt/skills/public/visual-design/SKILL.md",
    "/skills/visual-design/SKILL.md",
    "/mnt/skills/visual-design/SKILL.md",
    "/skills/public/hallmark/SKILL.md",
    "/mnt/skills/public/hallmark/SKILL.md",
    "/skills/hallmark/SKILL.md",
    "/mnt/skills/hallmark/SKILL.md",
)


def _text_marker_present(text: str, marker: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(marker)}(?![a-z0-9])", text) is not None


# Artifact Visual System Phase 5c: the report skill the .pdf target requires.
_PDF_REPORT_SKILL_PATH_MARKERS = (
    "/skills/public/pdf-report/SKILL.md",
    "/mnt/skills/public/pdf-report/SKILL.md",
    "/skills/pdf-report/SKILL.md",
    "/mnt/skills/pdf-report/SKILL.md",
)
_VISUAL_ASSET_TOOL_NAMES = frozenset({"generate_chart"})
_VISUAL_ASSET_EXTENSIONS = frozenset({".svg", ".png", ".jpg", ".jpeg", ".webp"})
_WRITE_ERROR_CLASS_MARKERS = (
    ("missing_thread_id", ("thread id not available", "nonetype' object has no attribute 'get")),
    ("missing_thread_data", ("thread data not available", "no allowed local sandbox directories")),
    ("sandbox_not_found", ("sandbox with id", "sandbox not found")),
    ("sandbox_runtime", ("sandbox",)),
    ("path_traversal", ("path traversal", "access denied")),
    ("permission_denied", ("permission denied",)),
    ("path_is_directory", ("path is a directory",)),
    ("write_os_error", ("failed to write file",)),
    ("unexpected_write_error", ("unexpected error writing file",)),
)


def _merge_builder_write_diagnostics(current: dict | None, update: dict | None) -> dict:
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)
    merged = dict(current)
    for key, value in update.items():
        _merge_builder_write_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_write_diagnostic_value(merged: dict, key: str, value: object) -> None:
    if key in {"success_count", "error_count"} and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in {"successful_output_paths", "successful_deliverable_output_paths"} and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    merged[key] = value


def _merge_string_list(current: object, update: list) -> list[str]:
    seen = {str(item): None for item in current if isinstance(item, str)} if isinstance(current, list) else {}
    for item in update:
        if isinstance(item, str):
            seen[item] = None
    return list(seen)


def _record_merge_key(item: dict[str, Any], fallback: int) -> str:
    for key in ("image_hash", "image_ref", "path", "png_path", "spec_path"):
        value = item.get(key)
        if value:
            return str(value)
    return str(fallback)


def _merge_record_list(current: object, update: list) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    if isinstance(current, list):
        for item in current:
            if isinstance(item, dict):
                merged[_record_merge_key(item, len(merged))] = dict(item)
    for item in update:
        if isinstance(item, dict):
            merged[_record_merge_key(item, len(merged))] = dict(item)
    return list(merged.values())


def _first_non_empty(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _runtime_config_dict(runtime: Runtime | None) -> dict[str, Any]:
    config = getattr(runtime, "config", None)
    return config if isinstance(config, dict) else {}


def _current_langsmith_dotted_order() -> str | None:
    try:
        from langsmith.run_helpers import get_current_run_tree

        run_tree = get_current_run_tree()
    except Exception:  # noqa: BLE001
        return None
    dotted_order = getattr(run_tree, "dotted_order", None)
    return dotted_order.strip() if isinstance(dotted_order, str) and dotted_order.strip() else None


def _nested_trace_env_for_request(request: ToolCallRequest) -> dict[str, str]:
    state = request.state or {}
    delegation_context = state.get("delegation_context") if isinstance(state.get("delegation_context"), dict) else {}
    builder_task = state.get("builder_task") if isinstance(state.get("builder_task"), dict) else {}
    thread_data = state.get("thread_data") if isinstance(state.get("thread_data"), dict) else {}
    config = _runtime_config_dict(getattr(request, "runtime", None))
    configurable = config.get("configurable") if isinstance(config.get("configurable"), dict) else {}
    metadata = config.get("metadata") if isinstance(config.get("metadata"), dict) else {}
    thread_id = _first_non_empty(
        state.get("thread_id"),
        builder_task.get("thread_id"),
        delegation_context.get("thread_id"),
        configurable.get("thread_id"),
        metadata.get("thread_id"),
    )
    parent_run_id = _first_non_empty(
        state.get("run_id"),
        builder_task.get("run_id"),
        delegation_context.get("run_id"),
        configurable.get("run_id"),
        metadata.get("run_id"),
        metadata.get("parent_run_id"),
    )
    parent_trace_id = _first_non_empty(
        state.get("parent_trace_id"),
        builder_task.get("parent_trace_id"),
        delegation_context.get("parent_trace_id"),
        configurable.get("trace_id"),
        metadata.get("trace_id"),
        metadata.get("parent_trace_id"),
    )
    env: dict[str, str] = {}
    if parent_trace_id:
        env["SOPHIA_PARENT_TRACE_ID"] = parent_trace_id
    if parent_run_id:
        env["SOPHIA_PARENT_RUN_ID"] = parent_run_id
    if dotted_order := _current_langsmith_dotted_order():
        env["SOPHIA_PARENT_DOTTED_ORDER"] = dotted_order
    if thread_id:
        env["SOPHIA_THREAD_ID"] = thread_id
    if isinstance(thread_data.get("outputs_path"), str) and str(thread_data.get("outputs_path")).strip():
        env["SOPHIA_OUTPUTS_HOST_PATH"] = f"{VIRTUAL_PATH_PREFIX}/outputs"
    if isinstance(thread_data.get("workspace_path"), str) and str(thread_data.get("workspace_path")).strip():
        env["SOPHIA_WORKSPACE_HOST_PATH"] = f"{VIRTUAL_PATH_PREFIX}/workspace"
    return env


def _image_trace_export_command(env: dict[str, str]) -> str:
    assignments = " ".join(f"{name}={shlex.quote(value)}" for name, value in env.items())
    return f"export {assignments};"


def _maybe_attach_image_trace_env(request: ToolCallRequest) -> None:
    if request.tool_call.get("name") not in {"bash", "bash_tool"}:
        return
    args = request.tool_call.get("args")
    if not isinstance(args, dict):
        return
    command = args.get("command")
    if not isinstance(command, str) or not any(marker in command for marker in _IMAGE_GENERATION_PATH_MARKERS):
        return
    env = _nested_trace_env_for_request(request)
    if not env or (command.lstrip().startswith("export ") and all(f"{name}=" in command for name in env)):
        return
    updated_args = dict(args)
    updated_args["command"] = f"{_image_trace_export_command(env)} {command}"
    request.tool_call["args"] = updated_args


def _safe_langsmith_span(
    name: str,
    *,
    inputs: dict[str, Any] | None = None,
    outputs: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> None:
    try:
        from langsmith import trace
        from langsmith.run_helpers import get_current_run_tree

        run_tree = get_current_run_tree()
        parent = getattr(run_tree, "dotted_order", None) if run_tree is not None else None
        trace_tags = ["sophia", "builder", *(tags or [])]
        trace_metadata = {
            "sophia_component": "builder_pptx_workflow",
            **(metadata or {}),
        }
        with trace(
            name,
            run_type="tool",
            inputs=inputs or {},
            metadata=trace_metadata,
            tags=trace_tags,
            parent=parent,
        ) as run:
            try:
                run.end(outputs=outputs or {})
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith builder span skipped: %s", name, exc_info=True)


def _trace_pptx_route_selected(state: dict[str, Any]) -> None:
    if not _requested_pptx_artifact(state):
        return
    visual_counts = _pptx_visual_completeness_counts(state)
    deck_service_enabled = _deck_build_service_route_active(state)
    deck_route = "deck_build_service" if deck_service_enabled else "legacy_html_slide_to_pptx"
    presentation_route = "deck_creative_html_native" if deck_service_enabled else "html_slide_to_pptx_raster"
    model_facing_deck_tools = ["prepare_deck_build"] if deck_service_enabled else ["prepare_pptx_image_manifest", "build_deck_from_slides"]
    delegation = state.get("delegation_context")
    task_type = delegation.get("task_type") if isinstance(delegation, dict) else None
    _safe_langsmith_span(
        "Sophia PPTX Route Selected",
        inputs={
            "requested_artifact_ext": _requested_artifact_ext(state),
            "task_type": task_type,
            "target_slide_count": _pptx_latch_target_slide_count(state),
            "explicit_text_only": _pptx_explicit_text_only_requested(state),
            "deck_build_service_flag": deck_build_service_flag_value(),
        },
        outputs={
            "presentation_route": presentation_route,
            "deck_route": deck_route,
            "deck_build_service_enabled": deck_service_enabled,
            "model_facing_deck_tools": model_facing_deck_tools,
            "visuals_required": _pptx_generated_visuals_required(state),
            "expected_generated_visual_count": visual_counts["expected_generated_visual_count"],
        },
        metadata={
            "sophia_component": "builder_pptx_route",
            "pptx_route": deck_route,
        },
        tags=["pptx", "route"],
    )
    if not deck_service_enabled:
        _safe_langsmith_span(
            "Sophia PPTX Legacy Mode Warning",
            inputs={
                "requested_artifact_ext": _requested_artifact_ext(state),
                "deck_build_service_flag": deck_build_service_flag_value(),
            },
            outputs={
                "presentation_route": presentation_route,
                "warning": "legacy_deck_mode_enabled",
            },
            metadata={
                "sophia_component": "builder_pptx_route",
                "pptx_route": deck_route,
            },
            tags=["pptx", "route", "legacy"],
        )


def _manifest_shape_summary_for_trace(state: dict[str, Any] | None, manifest_path: str | None) -> dict[str, Any]:
    if state is None or not manifest_path:
        return {"manifest_path_present": bool(manifest_path)}
    host = BuilderArtifactMiddleware._host_path_for_plan_file(state, manifest_path)
    if host is None:
        return {"manifest_path_present": True, "host_resolved": False}
    if not host.is_file():
        return {"manifest_path_present": True, "host_resolved": True, "readable": False}
    try:
        data = json.loads(host.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "manifest_path_present": True,
            "host_resolved": True,
            "readable": True,
            "json_valid": False,
            "error_class": type(exc).__name__,
        }
    if not isinstance(data, dict):
        return {"top_level_type": type(data).__name__, "json_valid": True}
    items = data.get("items")
    return {
        "top_level_type": "object",
        "top_level_keys": sorted(str(key) for key in data.keys())[:20],
        "schema_version": data.get("schema_version"),
        "manifest_author": data.get("manifest_author"),
        "items_type": type(items).__name__ if items is not None else None,
        "item_count": len(items) if isinstance(items, list) else None,
    }


def _trace_pptx_image_manifest_rejected(
    *,
    command: str,
    state: dict[str, Any],
    error_class: str,
) -> None:
    manifest_paths = [path for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS) if (path := _command_flag_value(segment, "--manifest"))]
    for manifest_path in manifest_paths or [None]:
        _safe_langsmith_span(
            "Sophia PPTX Image Manifest Rejected",
            inputs={
                "manifest_file": PurePosixPath(str(manifest_path or "")).name or None,
                "expected_slide_count": _pptx_latch_target_slide_count(state),
                "shape": _manifest_shape_summary_for_trace(state, manifest_path),
            },
            outputs={
                "success": False,
                "error_class": error_class,
            },
            metadata={
                "sophia_component": "builder_pptx_manifest",
                "pptx_manifest_error_class": error_class,
            },
            tags=["pptx", "image_manifest", "manifest_rejected"],
        )


def _trace_pptx_terminal_outcome(
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
    status: str,
    failure_code: str | None = None,
) -> None:
    if not _requested_pptx_artifact(state):
        return
    visual_counts = _pptx_visual_completeness_counts(state)
    for key in (
        "expected_generated_visual_count",
        "successful_generated_visual_count",
        "referenced_visual_count",
        "missing_expected_visual_count",
    ):
        value = artifact.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            visual_counts[key] = value
    image_status, image_reason = _image_generation_metadata_from_state(state)
    artifact_image_status = artifact.get("image_generation_status")
    artifact_image_reason = artifact.get("image_generation_reason")
    if isinstance(artifact_image_status, str) and artifact_image_status:
        image_status = artifact_image_status
    if isinstance(artifact_image_reason, str) and artifact_image_reason:
        image_reason = artifact_image_reason
    _safe_langsmith_span(
        "Sophia PPTX Terminal Outcome",
        inputs={
            "presentation_route": artifact.get("presentation_route") or artifact.get("deck_route") or "html_slide_to_pptx_raster",
            "target_slide_count": _pptx_latch_target_slide_count(state),
        },
        outputs={
            "status": status,
            "artifact_path_present": bool(artifact.get("artifact_path")),
            "failure_code": failure_code,
            "deck_route": artifact.get("deck_route"),
            "deck_compile_mode": artifact.get("deck_compile_mode"),
            "native_editability_score": artifact.get("native_editability_score"),
            "native_text_shape_count": artifact.get("native_text_shape_count"),
            "picture_shape_count": artifact.get("picture_shape_count"),
            "full_slide_picture_count": artifact.get("full_slide_picture_count"),
            "image_generation_status": image_status,
            "image_generation_reason": image_reason,
            "quality_warning": artifact.get("quality_warning"),
            "visual_quality_warning": artifact.get("visual_quality_warning"),
            **visual_counts,
        },
        metadata={
            "sophia_component": "builder_pptx_terminal_outcome",
            "pptx_terminal_status": status,
            "pptx_failure_code": failure_code,
        },
        tags=["pptx", "terminal"],
    )


def _manifest_trace_items(state: dict[str, Any], manifest_path: str) -> tuple[int, list[dict[str, Any]]]:
    host = BuilderArtifactMiddleware._host_path_for_plan_file(state, manifest_path)
    if host is None or not host.is_file():
        return 0, []
    try:
        data = json.loads(host.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0, []
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return 0, []
    traced: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        prompt_file = str(item.get("prompt_file") or "")
        prompt_hash = None
        prompt_host = _host_path_for_manifest_item_path(state, prompt_file, manifest_host=host)
        if prompt_host is not None and prompt_host.is_file():
            try:
                prompt_hash = hashlib.sha256(prompt_host.read_bytes()).hexdigest()[:16]
            except OSError:
                prompt_hash = None
        refs = item.get("reference_images") if isinstance(item.get("reference_images"), list) else []
        traced.append(
            {
                "item_index": index,
                "prompt_file": PurePosixPath(prompt_file).name,
                "prompt_hash": prompt_hash,
                "output_file": PurePosixPath(str(item.get("output_file") or "")).name,
                "reference_image_count": len(refs),
                "reference_images": [PurePosixPath(str(ref)).name for ref in refs],
                "slide_visual": bool(item.get("slide_visual")),
            }
        )
    return len(items), traced


def _trace_pptx_image_manifest_prepared(command: str, state: dict[str, Any]) -> None:
    manifest_paths = [path for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS) if (path := _command_flag_value(segment, "--manifest"))]
    for manifest_path in manifest_paths:
        requested, items = _manifest_trace_items(state, manifest_path)
        shape = _manifest_shape_summary_for_trace(state, manifest_path)
        target = _pptx_latch_target_slide_count(state)
        _safe_langsmith_span(
            "Sophia PPTX Image Manifest Prepared",
            inputs={
                "manifest_file": PurePosixPath(manifest_path).name,
                "schema_version": shape.get("schema_version"),
                "manifest_author": shape.get("manifest_author"),
                "expected_slide_count": target,
                "requested_item_count": requested,
                "prompt_readable_count": sum(1 for item in items if item.get("prompt_hash")),
                "requested_concurrency": None,
                "env_capped_concurrency": os.getenv("SOPHIA_IMAGE_GEN_CONCURRENCY") or "2",
                "items": items,
            },
            outputs={
                "manifest_readable": requested > 0,
                "requested_item_count": requested,
                "shape": shape,
            },
            metadata={
                "sophia_component": "builder_pptx_manifest",
                "pptx_manifest_schema_version": shape.get("schema_version"),
                "pptx_manifest_author": shape.get("manifest_author"),
                "pptx_expected_slide_count": target,
                "manifest_item_count": requested,
            },
            tags=["pptx", "image_manifest"],
        )


def _trace_pptx_compile_decision(
    *,
    state: dict[str, Any],
    decision: str,
    reason: str,
    outputs: dict[str, Any] | None = None,
) -> None:
    diagnostics = _pptx_diagnostics(state)
    target = _pptx_latch_target_slide_count(state)
    visual_counts = _pptx_visual_completeness_counts(state)
    _safe_langsmith_span(
        "Sophia PPTX Compile Decision",
        inputs={
            "target_slide_count": target,
            "image_success_count": int(diagnostics.get("image_generation_success_count", 0) or 0),
            "manifest_seen": bool(diagnostics.get("image_generation_manifest_seen")),
            "manifest_complete": bool(diagnostics.get("image_generation_manifest_complete")),
            "expected_generated_visual_count": visual_counts["expected_generated_visual_count"],
            "referenced_visual_count": visual_counts["referenced_visual_count"],
            "missing_expected_visual_count": visual_counts["missing_expected_visual_count"],
            "pptx_generator_invoked": bool(_pptx_generator_invoked_seen(state)),
        },
        outputs={
            "decision": decision,
            "reason": reason,
            **(outputs or {}),
        },
        metadata={
            "sophia_component": "builder_pptx_compile_decision",
            "pptx_decision": decision,
            "pptx_decision_reason": reason,
        },
        tags=["pptx", "compile_decision"],
    )


def _merge_builder_visual_diagnostics(current: dict | None, update: dict | None) -> dict:
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)
    merged = dict(current)
    for key, value in update.items():
        _merge_builder_visual_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_visual_diagnostic_value(merged: dict, key: str, value: object) -> None:
    if (key.endswith("_count") or key.endswith("_bytes_total")) and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in _VISUAL_DIAGNOSTIC_LIST_KEYS and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    if key in _VISUAL_DIAGNOSTIC_RECORD_KEYS and isinstance(value, list):
        merged[key] = _merge_record_list(merged.get(key), value)
        return
    merged[key] = value


_VISUAL_DIAGNOSTIC_LIST_KEYS = frozenset(
    {
        "visual_asset_paths",
        "visual_svg_paths",
        "visual_png_paths",
    }
)
_VISUAL_DIAGNOSTIC_RECORD_KEYS = frozenset(
    {
        "visual_figure_records",
        "visual_failed_family_records",
    }
)


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX) :].lstrip("/")
    if not relative:
        return None

    # Reject path traversal so emit verification/mirroring cannot resolve
    # outside the outputs root (e.g. "/mnt/user-data/outputs/../../etc/passwd").
    relative_path = PurePosixPath(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    return relative_path.as_posix()


_REQUIRED_SUPABASE_FAILURE_RESULTS = frozenset(
    {
        "required_context_missing",
        "required_not_configured",
        "required_user_missing",
        "required_upload_failed",
        "required_verify_failed",
    }
)


def _is_required_supabase_failure(result: str | None) -> bool:
    return bool(supabase_artifact_store.requires_durable_artifact_upload() and result in _REQUIRED_SUPABASE_FAILURE_RESULTS)


def _durable_upload_error_message() -> str:
    return "Builder artifact storage could not be verified for durable production delivery. Please retry after Supabase artifact storage is configured and healthy."


def _builder_parent_user_id(state: dict[str, Any], runtime: Runtime | None = None) -> str | None:
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        candidate = delegation.get("parent_user_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    config = getattr(runtime, "config", None)
    configurable = config.get("configurable") if isinstance(config, dict) else None
    if isinstance(configurable, dict):
        candidate = configurable.get("parent_user_id") or configurable.get("user_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _attach_durable_upload_identity(
    artifact_args: dict[str, Any],
    state: dict[str, Any],
    runtime: Runtime | None,
) -> None:
    user_id = _builder_parent_user_id(state, runtime)
    if user_id and not artifact_args.get("user_id"):
        artifact_args["user_id"] = user_id


def _required_primary_upload_to_supabase(
    *,
    thread_id: str,
    outputs_root: Path,
    relative: str,
    artifact_args: dict[str, Any],
) -> str:
    if not supabase_artifact_store.is_configured():
        missing = supabase_artifact_store.missing_required_config()
        logger.warning(
            "BuilderArtifact: required Supabase artifact upload skipped; missing_config=%s",
            ",".join(missing) if missing else "unknown",
        )
        return "required_not_configured"

    user_id = artifact_args.get("user_id")
    if not isinstance(user_id, str) or not user_id.strip():
        logger.warning("BuilderArtifact: required Supabase artifact upload skipped; missing user scope")
        return "required_user_missing"

    host_file = outputs_root / relative
    try:
        content = host_file.read_bytes()
    except OSError as exc:
        logger.warning(
            "BuilderArtifact: required Supabase artifact upload read failed path=%s error_type=%s",
            relative,
            exc.__class__.__name__,
        )
        return "required_upload_failed"

    local_path = f"mnt/user-data/outputs/{relative}"
    filename = PurePosixPath(relative).name or "artifact"
    renderer_kind = supabase_artifact_store.builder_renderer_kind(
        local_path,
        artifact_args.get("artifact_type") if isinstance(artifact_args.get("artifact_type"), str) else None,
    )
    artifact_id = artifact_args.get("artifact_id")
    if not isinstance(artifact_id, str) or not artifact_id.strip():
        artifact_id = supabase_artifact_store.builder_artifact_record_id(
            user_id=user_id.strip(),
            thread_id=thread_id,
            local_path=local_path,
            renderer_kind=renderer_kind,
        )

    object_path = supabase_artifact_store.builder_artifact_object_path(
        user_id=user_id.strip(),
        thread_or_session_id=thread_id,
        artifact_id=artifact_id,
        filename=filename,
    )

    try:
        uploaded_path = supabase_artifact_store.upload_artifact_object(object_path, content)
        if uploaded_path != object_path:
            return "required_upload_failed"
        if not supabase_artifact_store.check_artifact_object_exists(object_path):
            logger.warning(
                "BuilderArtifact: required Supabase artifact upload verification failed object_path_hash=%s",
                supabase_artifact_store.safe_object_path_segment(artifact_id, default="artifact"),
            )
            return "required_verify_failed"
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "BuilderArtifact: required Supabase artifact upload failed error_type=%s",
            exc.__class__.__name__,
        )
        return "required_upload_failed"

    artifact_args["artifact_id"] = artifact_id
    artifact_args["storage_provider"] = "supabase"
    artifact_args["storage_bucket"] = supabase_artifact_store.configured_bucket_name()
    artifact_args["storage_object_path"] = object_path
    artifact_args["storage_status"] = "available"
    return "uploaded"


def _upload_builder_outputs_to_supabase(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> str:
    """Upload the builder's outputs to Supabase Storage.

    Local/dev remains best-effort through ``maybe_mirror_file``. Production
    Supabase registry mode requires the primary artifact to upload to the
    user-scoped Artifact Observatory path and pass a HEAD existence check.
    """
    required = supabase_artifact_store.requires_durable_artifact_upload()
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return "required_context_missing" if required and artifact_args.get("artifact_path") else "skipped"

    candidates = _artifact_file_paths_for_roles(artifact_args, _USER_SURFACE_ARTIFACT_FILE_ROLES)

    result = "skipped"
    outputs_root = Path(outputs_host_path)
    for index, candidate in enumerate(candidates):
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        if required and index == 0:
            result = _merge_supabase_mirror_result(
                result,
                _required_primary_upload_to_supabase(
                    thread_id=thread_id,
                    outputs_root=outputs_root,
                    relative=relative,
                    artifact_args=artifact_args,
                ),
            )
            if _is_required_supabase_failure(result):
                return result
            continue
        result = _merge_supabase_mirror_result(
            result,
            maybe_mirror_file(str(host_file), thread_id, outputs_host_path),
        )
    return result


_SOURCE_SIBLING_SUFFIXES = frozenset({".md", ".html", ".htm"})
_ARTIFACT_FILE_ROLES = frozenset({"primary", "source", "preview", "illustration_asset", "internal"})
_USER_SURFACE_ARTIFACT_FILE_ROLES = frozenset({"primary", "preview"})


def _is_source_sibling_of_primary(path: str, primary: object) -> bool:
    """True when ``path`` is the render SOURCE of a binary primary.

    Prod 2026-06-10: ``sophia-roadmap.pdf`` and its markdown source
    ``sophia-roadmap.pdf.md`` were both uploaded next to each other, and the
    frontend's newest-first artifact ranking surfaced the .md to the user.
    The source stays on disk for the edit flow, but it is not re-uploaded as
    a user-facing deliverable at emit time.
    """
    if not isinstance(primary, str) or not primary:
        return False
    primary_pure = PurePosixPath(primary.replace("\\", "/"))
    if primary_pure.suffix.lower() not in {".pdf", ".pptx"}:
        return False
    candidate = PurePosixPath(str(path).replace("\\", "/"))
    if candidate.suffix.lower() not in _SOURCE_SIBLING_SUFFIXES:
        return False
    candidate_stem = candidate.name[: -len(candidate.suffix)]
    return candidate_stem in {primary_pure.name, primary_pure.stem}


def _normalize_artifact_file_role(role: object) -> str:
    value = str(role or "").strip().lower()
    return value if value in _ARTIFACT_FILE_ROLES else "internal"


def _artifact_file_entry(path: object, role: object, name: object = None) -> dict[str, str] | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return None
    entry = {"path": canonical, "role": _normalize_artifact_file_role(role)}
    if isinstance(name, str) and name.strip():
        entry["name"] = name.strip()
    return entry


def _artifact_file_entries_from_payload(raw_entries: object) -> list[dict[str, str]]:
    if not isinstance(raw_entries, list):
        return []
    entries: list[dict[str, str]] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue
        entry = _artifact_file_entry(
            raw_entry.get("path"),
            raw_entry.get("role"),
            raw_entry.get("name"),
        )
        if entry is not None:
            entries.append(entry)
    return entries


def _supporting_artifact_file_entries(
    supporting: object,
    preview_basename: str,
) -> list[dict[str, str]]:
    if not isinstance(supporting, list):
        return []
    entries: list[dict[str, str]] = []
    for raw_path in supporting:
        role = "preview" if preview_basename and PurePosixPath(str(raw_path)).name == preview_basename else "internal"
        entry = _artifact_file_entry(raw_path, role)
        if entry is not None:
            entries.append(entry)
    return entries


def _dedupe_artifact_file_entries(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: dict[str, dict[str, str]] = {}
    role_priority = {"primary": 0, "preview": 1, "source": 2, "illustration_asset": 3, "internal": 4}
    for entry in entries:
        path = entry["path"]
        previous = deduped.get(path)
        if previous is None or role_priority[entry["role"]] < role_priority[previous["role"]]:
            deduped[path] = entry
    return sorted(deduped.values(), key=lambda entry: role_priority.get(entry.get("role", "internal"), 4))


def _artifact_file_entries(artifact_args: dict[str, Any]) -> list[dict[str, str]]:
    primary = artifact_args.get("artifact_path")
    preview_name = str(artifact_args.get("artifact_preview_filename") or "").strip()
    preview_basename = PurePosixPath(preview_name).name if preview_name else ""
    payload_entries = _artifact_file_entries_from_payload(artifact_args.get("artifact_files"))
    primary_role = "preview" if preview_basename and PurePosixPath(str(primary or "")).name == preview_basename else "primary"
    primary_entry = _artifact_file_entry(primary, primary_role)
    payload_has_primary = any(entry.get("role") == "primary" for entry in payload_entries)

    entries: list[dict[str, str]] = []
    if primary_entry is not None and primary_entry.get("role") == "primary":
        matching_payload_primary = next(
            (entry for entry in payload_entries if entry.get("role") == "primary" and entry.get("path") == primary_entry["path"]),
            None,
        )
        entries.append(matching_payload_primary or primary_entry)
        entries.extend(entry for entry in payload_entries if entry.get("role") != "primary" or entry.get("path") == primary_entry["path"])
        primary_entry = None
    elif payload_has_primary:
        entries.extend(payload_entries)
    elif primary_entry is not None:
        entries.append(primary_entry)
        primary_entry = None
        entries.extend(payload_entries)
    else:
        entries.extend(payload_entries)
    if primary_entry is not None:
        entries.append(primary_entry)
    entries.extend(_supporting_artifact_file_entries(artifact_args.get("supporting_files"), preview_basename))
    return _dedupe_artifact_file_entries(entries)


def _artifact_file_paths_for_roles(artifact_args: dict[str, Any], roles: set[str] | frozenset[str]) -> list[str]:
    return [entry["path"] for entry in _artifact_file_entries(artifact_args) if entry.get("role") in roles]


def _merge_supabase_mirror_result(current: str, update: str | None) -> str:
    if update is None:
        return current
    if update in _REQUIRED_SUPABASE_FAILURE_RESULTS:
        return update
    if update == "failed_best_effort":
        return "failed_best_effort"
    if update == "uploaded" and current not in {"failed_best_effort"}:
        return "uploaded"
    if update == "not_configured" and current == "skipped":
        return "not_configured"
    return current


def _outputs_host_path_from_state(state: dict[str, Any]) -> str | None:
    thread_data = state.get("thread_data") or {}
    return thread_data.get("outputs_path") if isinstance(thread_data, dict) else None


def _outputs_root_from_state(state: dict[str, Any]) -> Path | None:
    outputs_host_path = _outputs_host_path_from_state(state)
    if not outputs_host_path:
        return None
    outputs_root = Path(outputs_host_path)
    return outputs_root if outputs_root.is_dir() else None


def _builder_started_min_mtime(state: dict[str, Any]) -> float | None:
    started_ms = state.get("builder_task_started_at_ms")
    if isinstance(started_ms, (int, float)) and started_ms > 0:
        return (float(started_ms) / 1000.0) - 5.0
    return None


def _is_recovery_candidate(entry: Path, *, requested_suffix: str, min_mtime: float | None) -> bool:
    if not entry.is_file() or entry.name.startswith((".", "_")):
        return False
    if requested_suffix and entry.suffix.lower() != requested_suffix:
        return False
    return min_mtime is None or entry.stat().st_mtime >= min_mtime


def _is_fresh_pdf_output(entry: Path, min_mtime: float | None) -> bool:
    if not _is_public_output_file(entry):
        return False
    if entry.suffix.lower() != ".pdf":
        return False
    return min_mtime is None or entry.stat().st_mtime >= min_mtime


def _is_public_output_file(entry: Path) -> bool:
    if not entry.is_file():
        return False
    return not entry.name.startswith((".", "_"))


def _output_tree_has_fresh_pdf(outputs_root: Path, min_mtime: float | None) -> bool:
    for entry in outputs_root.rglob("*"):
        if _is_fresh_pdf_output(entry, min_mtime):
            return True
    return False


def _output_tree_has_completion_candidate(
    outputs_root: Path,
    state: dict[str, Any],
    min_mtime: float | None,
) -> bool:
    for entry in outputs_root.rglob("*"):
        if _is_completion_output_candidate(entry, state, min_mtime):
            return True
    return False


def _is_completion_output_candidate(
    entry: Path,
    state: dict[str, Any],
    min_mtime: float | None,
) -> bool:
    if not _is_public_output_file(entry):
        return False
    if min_mtime is not None and entry.stat().st_mtime < min_mtime:
        return False
    if _completion_candidate_integrity_error(entry, state) is not None:
        return False
    return _output_suffix_allowed_for_request(entry.suffix.lower(), state)


def _completion_candidate_integrity_error(entry: Path, state: dict[str, Any]) -> str | None:
    suffix = entry.suffix.lower()
    if _requested_html_artifact(state) and suffix in _HTML_ARTIFACT_SUFFIXES:
        return _log_completion_candidate_integrity_error(
            entry,
            ext="html",
            reason=_html_fallback_integrity_error_for_file(entry),
        )
    if suffix == ".pptx":
        return _log_completion_candidate_integrity_error(
            entry,
            ext="pptx",
            reason=_pptx_integrity_error_for_file(entry),
        )
    if _requested_pptx_artifact(state) and suffix in {".html", ".htm"}:
        return _log_completion_candidate_integrity_error(
            entry,
            ext="html",
            reason=_html_fallback_integrity_error_for_file(entry),
            requested_ext="pptx",
        )
    return None


def _log_completion_candidate_integrity_error(
    entry: Path,
    *,
    ext: str,
    reason: str | None,
    requested_ext: str | None = None,
) -> str | None:
    if reason is None:
        return None
    requested = f" requested_ext={requested_ext}" if requested_ext else ""
    logger.warning(
        "BuilderArtifact: artifact_integrity ext=%s valid=false reason=%s bytes=%s source=outputs_scan%s",
        ext,
        reason,
        entry.stat().st_size,
        requested,
    )
    return reason


def _output_suffix_allowed_for_request(suffix: str, state: dict[str, Any]) -> bool:
    if _requested_pdf_artifact(state):
        return suffix in _allowed_pdf_artifact_suffixes(state)
    if _requested_pptx_artifact(state):
        return suffix in _allowed_pptx_artifact_suffixes(state)
    if _requested_html_artifact(state):
        return suffix in _HTML_ARTIFACT_SUFFIXES
    return True


def _is_promotable_candidate_path(
    path: Path,
    *,
    outputs_root: Path,
    min_mtime: float | None,
    requested_pdf: bool = False,
    requested_pptx: bool,
    requested_html: bool,
) -> bool:
    if _is_support_output_path(path, outputs_root):
        return False
    if not _is_recent_promotable_path(path, min_mtime):
        return False
    if requested_html:
        if path.suffix.lower() not in _HTML_ARTIFACT_SUFFIXES:
            return False
        return _html_fallback_integrity_error_for_file(path) is None
    if path.suffix.lower() == ".pptx":
        return _pptx_integrity_error_for_file(path) is None
    if requested_pdf and path.suffix.lower() in {".html", ".htm"}:
        return _html_fallback_integrity_error_for_file(path) is None
    if requested_pptx and path.suffix.lower() in {".html", ".htm"}:
        return _html_fallback_integrity_error_for_file(path) is None
    return True


def _is_support_output_path(path: Path, outputs_root: Path) -> bool:
    try:
        relative_parts = path.relative_to(outputs_root).parts
    except ValueError:
        return True
    return bool(relative_parts and relative_parts[0].lower() in _PROMOTION_SUPPORT_DIR_NAMES)


def _is_recent_promotable_path(path: Path, min_mtime: float | None) -> bool:
    return path.is_file() and not path.name.startswith("_") and path.suffix.lower() in _PROMOTABLE_DELIVERABLE_EXTENSIONS and (min_mtime is None or path.stat().st_mtime >= min_mtime)


def _emit_candidate_paths(artifact_args: dict[str, Any]) -> list[str]:
    candidates: list[str] = _invalid_raw_outputs_candidates(artifact_args)
    candidates.extend(
        _artifact_file_paths_for_roles(
            artifact_args,
            _USER_SURFACE_ARTIFACT_FILE_ROLES,
        )
    )
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str) and path.strip())
    deduped: list[str] = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def _invalid_raw_outputs_candidates(artifact_args: dict[str, Any]) -> list[str]:
    return [candidate for candidate in _raw_emit_candidate_paths(artifact_args) if _invalid_outputs_candidate(candidate) and _extract_output_relative_path(candidate) is None]


def _raw_emit_candidate_paths(artifact_args: dict[str, Any]) -> list[str]:
    """Return user-supplied file paths before role normalization drops invalid entries."""
    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str) and primary.strip():
        candidates.append(primary.strip())
    artifact_files = artifact_args.get("artifact_files")
    if isinstance(artifact_files, list):
        for entry in artifact_files:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            if isinstance(path, str) and path.strip():
                candidates.append(path.strip())
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path.strip() for path in supporting if isinstance(path, str) and path.strip())
    deduped: list[str] = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def _invalid_outputs_candidate(candidate: str) -> bool:
    return candidate.strip().startswith(_OUTPUTS_VIRTUAL_PREFIX)


def _path_has_traversal(path: Any) -> bool:
    if not isinstance(path, str):
        return False
    cleaned = path.strip().replace("\\", "/")
    if not cleaned:
        return False
    return ".." in PurePosixPath(cleaned).parts


def _local_emit_candidate_status(
    candidate: str,
    relative: str,
    outputs_host_path: str | None,
) -> str:
    if not outputs_host_path:
        return "missing"
    host_file = Path(outputs_host_path) / relative
    if not host_file.is_file():
        return "missing"
    if PurePosixPath(candidate).suffix.lower() == ".pptx":
        return _local_pptx_candidate_status(host_file)
    return "valid"


def _local_pptx_candidate_status(host_file: Path) -> str:
    reason = _pptx_integrity_error_for_file(host_file)
    if reason is not None:
        logger.warning(
            "BuilderArtifact: artifact_integrity ext=pptx valid=false reason=%s bytes=%s source=local",
            reason,
            host_file.stat().st_size,
        )
        return "invalid"
    logger.info(
        "BuilderArtifact: artifact_integrity ext=pptx valid=true bytes=%s source=local",
        host_file.stat().st_size,
    )
    return "valid"


def _remote_emit_candidate_status(
    candidate: str,
    relative: str,
    remote_thread_ids: list[str],
) -> str:
    if not remote_thread_ids:
        return "missing"
    if PurePosixPath(candidate).suffix.lower() == ".pptx":
        return _remote_pptx_candidate_status(relative, remote_thread_ids)
    if any(supabase_artifact_store.check_artifact_exists(thread_id, relative) for thread_id in remote_thread_ids):
        return "valid"
    return "missing"


def _remote_pptx_candidate_status(relative: str, remote_thread_ids: list[str]) -> str:
    for thread_id in remote_thread_ids:
        result = _download_pptx_candidate(thread_id, relative, remote_thread_ids[0])
        if result is None:
            continue
        content, _mime = result
        reason = _pptx_integrity_error_for_bytes(content)
        if reason is not None:
            logger.warning(
                "BuilderArtifact: artifact_integrity ext=pptx valid=false reason=%s bytes=%s source=supabase",
                reason,
                len(content),
            )
            return "invalid"
        logger.info(
            "BuilderArtifact: artifact_integrity ext=pptx valid=true bytes=%s source=supabase",
            len(content),
        )
        return "valid"
    return "missing"


def _download_pptx_candidate(thread_id: str, relative: str, primary_thread_id: str):
    try:
        return supabase_artifact_store.download_artifact(thread_id, relative)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "BuilderArtifact: pptx remote integrity check failed error_type=%s thread_role=%s",
            exc.__class__.__name__,
            "parent" if thread_id == primary_thread_id else "fallback",
        )
        return None


def _log_missing_emit_candidate(
    candidate: str,
    relative: str,
    outputs_host_path: str | None,
    remote_thread_ids: list[str],
) -> None:
    logger.warning(
        "BuilderArtifact: file missing for emit verification: path=%s local=%s supabase=%s",
        candidate,
        bool(outputs_host_path and (Path(outputs_host_path) / relative).is_file()),
        bool(any(supabase_artifact_store.check_artifact_exists(thread_id, relative) for thread_id in remote_thread_ids)),
    )


def _emit_candidate_verified(
    candidate: str,
    *,
    outputs_host_path: str | None,
    remote_thread_ids: list[str],
) -> bool:
    relative = _extract_output_relative_path(candidate)
    if relative is None:
        if _invalid_outputs_candidate(candidate):
            logger.warning(
                "BuilderArtifact: rejecting invalid outputs artifact path=%s",
                candidate,
            )
            return False
        return True

    local_status = _local_emit_candidate_status(candidate, relative, outputs_host_path)
    if local_status == "valid":
        return True
    if local_status == "invalid":
        return False

    remote_status = _remote_emit_candidate_status(candidate, relative, remote_thread_ids)
    if remote_status == "valid":
        return True
    if remote_status == "invalid":
        return False

    _log_missing_emit_candidate(candidate, relative, outputs_host_path, remote_thread_ids)
    return False


def _is_user_facing_output_path(artifact_path: str | None) -> bool:
    relative = _extract_output_relative_path(artifact_path)
    if relative is None:
        return False
    name = PurePosixPath(relative).name
    if not name or name.startswith((".", "_")):
        return False
    return PurePosixPath(relative).suffix.lower() in _PROMOTABLE_DELIVERABLE_EXTENSIONS


def _requested_target_suffix(state: dict[str, Any]) -> str:
    target = state.get("builder_artifact_target_path")
    if not isinstance(target, str):
        delegation = state.get("delegation_context")
        target = delegation.get("artifact_target_path") if isinstance(delegation, dict) else None
    if not isinstance(target, str):
        return ""
    return PurePosixPath(target.strip()).suffix.lower()


_PRESENTATION_TASK_TYPES = frozenset({"presentation", "slides", "slide_deck", "deck"})


def _requested_pdf_slide_artifact(state: dict[str, Any]) -> bool:
    if _requested_target_suffix(state) != ".pdf":
        return False
    delegation = state.get("delegation_context")
    task_type = ""
    if isinstance(delegation, dict):
        task_type = str(delegation.get("task_type") or "").strip().lower()
    return task_type in _PRESENTATION_TASK_TYPES


# Correction wave 2026-06-12 — emit-time format-conflict guard.
#
# Prod incident: dispatch misderived target_ext=pptx for an explicit "actual
# PDF report (not a presentation)" ask; the builder rendered a correct
# 9-page PDF and the ext gate rejected it on every emit — one run failed
# terminally, another shipped an unwanted PPTX. The dispatch-side fix
# (current-turn-first resolution) is the primary cure; this guard is the
# backstop for when target truth is still wrong.
#
# NOT a weakening of the no-format-swap invariant: the invariant bans
# DEGRADED SUBSTITUTES for the requested format. This path fires only when
# the emitted format literally IS the user's explicitly stated current-turn
# format (the C1 stamp), and the emitted format's own integrity gates still
# apply after the target is re-pointed. .md/.html-for-binary fallback shapes
# never qualify unless the user literally asked for them.
_FORMAT_CONFLICT_RESOLVABLE_EXTS = frozenset({"pdf", "pptx", "docx", "xlsx", "html"})


def _format_conflict_user_override(args: dict[str, Any], state: dict[str, Any]) -> dict[str, str] | None:
    """Return a target-path overlay honoring explicit user format, or None.

    Fires ONLY when ALL hold:
      1. ``delegation_context["user_requested_ext"]`` present (stamped at
         dispatch from the CURRENT user turn, negation-vetoed) and in the
         resolvable whitelist;
      2. it differs from the resolved target ext (a real conflict);
      3. the emitted artifact ext EQUALS the user-requested ext exactly;
      4. the state target still equals the dispatch target and no update
         epoch has advanced — a newer in-build user instruction
         (post-interrupt target rewrite) outranks the dispatch-time stamp.
    """
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        return None
    user_ext = delegation.get("user_requested_ext")
    if not isinstance(user_ext, str) or user_ext not in _FORMAT_CONFLICT_RESOLVABLE_EXTS:
        return None
    target_ext = _requested_target_suffix(state).lstrip(".")
    if not target_ext or target_ext == user_ext:
        return None
    emitted_ext = _artifact_ext_from_path(args.get("artifact_path"))
    if emitted_ext != user_ext:
        return None
    dispatch_target = delegation.get("artifact_target_path")
    state_target = state.get("builder_artifact_target_path")
    if isinstance(state_target, str) and isinstance(dispatch_target, str) and state_target != dispatch_target:
        return None  # post-interrupt target update outranks the dispatch stamp
    if int(state.get("builder_update_epoch", 0) or 0) > 0:
        return None
    target = state_target if isinstance(state_target, str) else dispatch_target
    if not isinstance(target, str) or not target.strip():
        return None
    repointed = str(PurePosixPath(target.strip()).with_suffix(f".{user_ext}"))
    return {"builder_artifact_target_path": repointed}


def _stamp_format_conflict_metadata(args: dict[str, Any], original_target_ext: str, user_ext: str) -> None:
    """Observability stamps: every occurrence is a dispatch-resolution-failed
    signal, not business-as-usual."""
    args["format_conflict_resolved"] = "user_intent"
    args["format_conflict_original_target_ext"] = original_target_ext
    logger.warning(
        "[BuilderArtifact] format_conflict_resolved=user_intent original_target_ext=%s user_requested_ext=%s",
        original_target_ext,
        user_ext,
    )


def _requested_pdf_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) == ".pdf"


def _requested_pptx_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) == ".pptx"


def _requested_html_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) in _HTML_ARTIFACT_SUFFIXES


def _requested_office_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) in {".pptx", ".docx", ".xlsx"}


def _requested_task_text(state: dict[str, Any]) -> str:
    parts = _delegation_task_text_parts(state) + _state_task_text_parts(state)
    return "\n".join(parts).lower()


def _delegation_task_text_parts(state: dict[str, Any]) -> list[str]:
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        return []
    keys = ("task", "task_description", "description", "original_task", "task_type")
    return [value for key in keys if isinstance((value := delegation.get(key)), str)]


def _state_task_text_parts(state: dict[str, Any]) -> list[str]:
    keys = ("task", "task_description", "builder_task_description")
    return [value for key in keys if isinstance((value := state.get(key)), str)]


def _pdf_fallback_suffix(state: dict[str, Any]) -> str:
    task_text = _requested_task_text(state)
    if any(marker in task_text for marker in _PDF_VISUAL_FALLBACK_MARKERS):
        return ".html"
    return ".md"


def _allowed_pdf_artifact_suffixes(state: dict[str, Any]) -> frozenset[str]:
    return frozenset({".pdf", _pdf_fallback_suffix(state)})


def _pptx_fallback_suffix(state: dict[str, Any]) -> str:
    task_text = _requested_task_text(state)
    if any(marker in task_text for marker in _PDF_VISUAL_FALLBACK_MARKERS):
        return ".html"
    return ".md"


def _allowed_pptx_artifact_suffixes(state: dict[str, Any]) -> frozenset[str]:
    return frozenset({".pptx", _pptx_fallback_suffix(state)})


def _runtime_thread_id(runtime: Runtime | None) -> str | None:
    context = getattr(runtime, "context", None)
    if isinstance(context, dict) and isinstance(context.get("thread_id"), str):
        return context["thread_id"]
    config = getattr(runtime, "config", None)
    configurable = config.get("configurable") if isinstance(config, dict) else None
    if isinstance(configurable, dict) and isinstance(configurable.get("thread_id"), str):
        return configurable["thread_id"]
    return None


def _artifact_remote_thread_ids(state: dict[str, Any], runtime: Runtime | None) -> list[str]:
    ids: list[str] = []
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        parent = delegation.get("parent_thread_id")
        if isinstance(parent, str) and parent:
            ids.append(parent)
    runtime_thread_id = _runtime_thread_id(runtime)
    if runtime_thread_id:
        ids.append(runtime_thread_id)
    deduped: list[str] = []
    for thread_id in ids:
        if thread_id not in deduped:
            deduped.append(thread_id)
    return deduped


def _pptx_integrity_error_for_bytes(content: bytes) -> str | None:
    if len(content) < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        from io import BytesIO

        with zipfile.ZipFile(BytesIO(content)) as archive:
            entries = set(archive.namelist())
    except zipfile.BadZipFile:
        return "pptx_not_zip"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return f"pptx_missing_entries:{','.join(missing)}"
    return None


def _pptx_integrity_error_for_file(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return "pptx_stat_failed"
    if size < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        with zipfile.ZipFile(path) as archive:
            entries = set(archive.namelist())
    except zipfile.BadZipFile:
        return "pptx_not_zip"
    except OSError:
        return "pptx_read_failed"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return f"pptx_missing_entries:{','.join(missing)}"
    return None


def _html_fallback_integrity_error_for_text(content: str) -> str | None:
    stripped = content.lstrip("\ufeff \t\r\n")
    lowered = stripped[:512].lower()
    if len(content.encode("utf-8", errors="ignore")) < _HTML_FALLBACK_MIN_BYTES:
        return "html_too_small"
    if lowered.startswith("```"):
        return "html_markdown_fence"
    if lowered.startswith("&lt;!doctype") or lowered.startswith("&lt;html"):
        return "html_escaped"
    if "<html" not in lowered and "<!doctype html" not in lowered:
        return "html_missing_document_root"
    if "<body" not in content.lower():
        return "html_missing_body"
    return None


def _html_fallback_integrity_error_for_bytes(content: bytes) -> str | None:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return "html_not_utf8"
    return _html_fallback_integrity_error_for_text(text)


def _html_fallback_integrity_error_for_file(path: Path) -> str | None:
    if path.name.startswith(("_", ".")) or path.name.lower().startswith(("test_", "test-")):
        return "html_internal_filename"
    try:
        return _html_fallback_integrity_error_for_bytes(path.read_bytes())
    except OSError:
        return "html_read_failed"


def _requested_artifact_ext(state: dict[str, Any]) -> str | None:
    suffix = _requested_target_suffix(state).lstrip(".")
    return suffix or None


def _artifact_ext_from_path(path: Any) -> str | None:
    suffix = PurePosixPath(str(path or "")).suffix.lower().lstrip(".")
    return suffix or None


def _apply_artifact_format_metadata(
    artifact: dict[str, Any],
    requested_ext: str | None,
    artifact_ext: str | None,
    fallback_reason: str | None,
) -> None:
    if requested_ext:
        artifact["requested_artifact_ext"] = requested_ext
    if artifact_ext:
        artifact["artifact_ext"] = artifact_ext
        if requested_ext == "pptx" and artifact_ext in {"html", "htm"}:
            artifact["artifact_type"] = "webpage"
    if _artifact_is_extension_fallback(requested_ext, artifact_ext):
        artifact["artifact_is_fallback"] = True
        artifact["fallback_reason"] = _artifact_fallback_reason(artifact, requested_ext, fallback_reason)
    elif requested_ext and artifact_ext == requested_ext:
        artifact["artifact_is_fallback"] = False
        artifact.pop("fallback_reason", None)
    elif fallback_reason:
        artifact["fallback_reason"] = fallback_reason
    elif requested_ext:
        artifact.setdefault("artifact_is_fallback", False)


def _apply_image_generation_metadata(artifact: dict[str, Any], state: dict[str, Any]) -> None:
    image_status, image_reason = _image_generation_metadata_from_state(state)
    if image_status:
        artifact["image_generation_status"] = image_status
        if image_reason:
            artifact["image_generation_reason"] = image_reason
        else:
            artifact.pop("image_generation_reason", None)
    outcome = _image_generation_outcome_from_state(state)
    if outcome is not None:
        artifact["image_generation_outcome"] = outcome
    diagnostics = _pptx_diagnostics(state)
    visual_completeness = _pptx_visual_completeness_diagnostics_update(state)
    for key in (
        "primary_image_batch_status",
        "primary_image_batch_error_class",
        "serial_repair_count",
        "manifest_authoring_failure_count",
        "image_generation_startup_attempt_count",
        "image_generation_startup_error_class",
        "image_generation_exit_code",
        "image_generation_raw_error_excerpt",
        "presentation_route",
        "expected_generated_visual_count",
        "successful_generated_visual_count",
        "referenced_visual_count",
        "missing_expected_visual_count",
        "pptx_deck_visual_quality_gap_count",
        "deck_route",
        "deck_compile_mode",
        "native_required",
        "legacy_screenshot_debug",
        "native_editability_score",
        "native_text_shape_count",
        "picture_shape_count",
        "full_slide_picture_count",
        "native_mechanical_report",
        "deck_build_id",
        "deck_schema_version",
        "deck_status",
        "deck_register",
        "deck_visual_policy",
        "deck_quality_status",
        "deck_failure_code",
        "deck_template_renderer_version",
        "generated_visuals_complete",
        "deck_build_path",
    ):
        value = diagnostics.get(key)
        if value is None and key in {
            "presentation_route",
            "expected_generated_visual_count",
            "successful_generated_visual_count",
            "referenced_visual_count",
            "missing_expected_visual_count",
        }:
            value = visual_completeness.get(key)
        if value is not None and value != "":
            artifact["visual_quality_gap_count" if key == "pptx_deck_visual_quality_gap_count" else key] = value


def _apply_edit_context_metadata(artifact: dict[str, Any], state: dict[str, Any]) -> None:
    delegation = state.get("delegation_context")
    edit_context = delegation.get("edit_context") if isinstance(delegation, dict) else None
    if not isinstance(edit_context, dict) or edit_context.get("mode") != "edit_existing_artifact":
        return
    source_path = edit_context.get("source_artifact_path")
    if not isinstance(source_path, str) or not source_path.strip():
        return
    artifact.setdefault("source_artifact_path", source_path)
    artifact.setdefault("revision_of_artifact_path", source_path)


def _terminal_reason_is_failure(value: object) -> bool:
    reason = str(value or "").strip().lower()
    if not reason:
        return False
    return reason.endswith(("_failed", "_failure", "_incomplete", "_not_completed")) or reason in {
        "pdf_generation_failed",
        "pdf_page_count_off_target",
        "pdf_report_contract_failed",
        "pdf_report_manifest_invalid",
        "no_deliverable",
    }


def _apply_pdf_contract_metadata(artifact: dict[str, Any], state: dict[str, Any]) -> None:
    result = state.get("builder_pdf_render_result")
    if not isinstance(result, dict):
        return
    for key in (
        "report_contract_status",
        "report_contract_version",
        "expected_section_count",
        "found_section_count",
        "expected_body_section_count",
        "found_body_section_count",
        "missing_section_ids",
        "expected_visual_count",
        "found_visual_count",
        "missing_visual_ids",
        "minimum_word_count",
        "source_word_count",
        "cover_present",
        "toc_present",
        "conclusion_present",
        "references_present",
        "report_contract_problems",
    ):
        value = result.get(key)
        if value is not None:
            artifact.setdefault(key, value)


def _apply_artifact_request_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
    *,
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    requested_ext = _requested_artifact_ext(state)
    artifact_ext = _artifact_ext_from_path(artifact.get("artifact_path"))
    _apply_edit_context_metadata(artifact, state)
    _apply_pdf_contract_metadata(artifact, state)
    _apply_artifact_format_metadata(artifact, requested_ext, artifact_ext, fallback_reason)
    raw_status = str(artifact.get("status") or "").strip().lower()
    if raw_status in {"timed_out", "timeout"} or artifact.get("budget_stop_reason"):
        terminal_status = "timed_out"
    elif raw_status in {"failed", "error"} or not artifact.get("artifact_path"):
        terminal_status = "failed"
    else:
        terminal_status = "completed"
    terminal_reason = artifact.get("budget_stop_reason") or artifact.get("failure_code") or artifact.get("terminal_reason") or fallback_reason
    if terminal_status == "completed" and _terminal_reason_is_failure(terminal_reason):
        terminal_status = "failed"
    if terminal_status == "completed":
        terminal_reason = terminal_reason if str(terminal_reason or "").strip().lower() in {"artifact_emitted", "pdf_render_succeeded", "deck_build_succeeded"} else "artifact_emitted"
    elif not terminal_reason:
        terminal_reason = "no_deliverable"
    artifact["status"] = terminal_status
    artifact["terminal_status"] = terminal_status
    artifact["terminal_reason"] = terminal_reason
    artifact["build_event_store_status"] = default_event_sink_status()
    diagnostics = _pptx_diagnostics(state)
    for key in (
        "first_prepare_turn",
        "prepare_call_count",
        "prepare_emitted_call_count",
        "prepare_execution_count",
        "prepare_result_count",
        "prepare_service_call_count",
        "prepare_service_result_count",
        "prepare_retry_executed",
        "prepare_policy_result_count",
        "prepare_repair_count",
        "dangling_prepare_call_count",
        "creative_plan_accepted",
        "deck_authoring_contract",
        "deck_authoring_elapsed_ms",
        "deck_repair_elapsed_ms",
        "deck_service_elapsed_ms",
        "terminal_cleanup_elapsed_ms",
        "presentation_preflight_status",
        "presentation_preflight_elapsed_ms",
        "deck_authoring_started_at_ms",
        "deck_authoring_budget_ms",
        "deck_authoring_remaining_ms",
        "deck_authoring_prompt_bytes",
        "deck_authoring_prompt_estimated_tokens",
        "deck_authoring_tool_schema_bytes",
        "deck_authoring_context_bytes",
        "deck_authoring_output_bytes",
        "authoring_tool_call_started",
        "prepare_force_reason",
        "last_prepare_failure_code",
        "last_prepare_failure_summary",
        "deck_stylesheet_hash",
        "deck_html_fragment_count",
        "deck_assembled_html_bytes",
    ):
        if diagnostics.get(key) is not None:
            artifact.setdefault(key, diagnostics.get(key))
    if artifact.get("deck_authoring_contract") is not None:
        artifact.setdefault("authoring_contract", artifact.get("deck_authoring_contract"))
    artifact_entries = _artifact_file_entries(artifact)
    if artifact_entries:
        artifact["artifact_files"] = artifact_entries
    _apply_image_generation_metadata(artifact, state)
    used = iterations_used(state)
    if used:
        artifact["iterations_used"] = used
    unmet = _unmet_conditions_from_state(artifact, state)
    if unmet:
        artifact["unmet_conditions"] = unmet
    _log_loop_rescues(artifact, state)
    return artifact


def _unmet_conditions_from_state(artifact: dict[str, Any], state: dict[str, Any]) -> list[str]:
    """Deterministic condition battery at delivery time (VQ-10 honesty).

    Whatever the loop could not fix ships NAMED in the payload — never
    silent. Mirrors the gate predicates exactly.
    """
    planning_accepted = bool(artifact.get("creative_plan_accepted") or _pptx_diagnostics(state).get("creative_plan_accepted"))
    suppress_deck_visual_conditions = _deck_build_service_route_active(state) and _requested_artifact_ext(state) == "pptx" and not planning_accepted
    unmet = [] if suppress_deck_visual_conditions else _visual_unmet_conditions(artifact, state)
    if not suppress_deck_visual_conditions:
        hero_condition = _hero_or_cover_unmet_condition(state)
        if hero_condition:
            unmet.append(hero_condition)
    # Spec D D-5 honesty stamp: gate-flagged brief gaps the model neither
    # recovered (read_session_context) nor disclosed (brief_assumptions)
    # ship NAMED — observability only, never a rejection.
    unmet.extend(brief_gate_unmet_conditions(state, artifact))
    return unmet


def _visual_unmet_conditions(artifact: dict[str, Any], state: dict[str, Any]) -> list[str]:
    unmet: list[str] = []
    if _visuals_requested(state) and not _visual_presence_validated(artifact, state):
        unmet.append("visuals_not_embedded")
    if _report_visual_grammar_problems(state):
        unmet.append("report_visual_grammar_failed")
    return unmet


def _hero_or_cover_unmet_condition(state: dict[str, Any]) -> str | None:
    requested_ext = _requested_artifact_ext(state)
    if not _hero_cover_gate_applies(state, requested_ext):
        return None
    if requested_ext == "pdf":
        if state.get("builder_pdf_cover_required") is False:
            return None
        render_result = state.get("builder_pdf_render_result")
        if isinstance(render_result, dict) and render_result.get("cover_present") is True:
            return None
    diagnostics = _pptx_diagnostics(state)
    succeeded = int(diagnostics.get("image_generation_success_count", 0) or 0)
    if succeeded > 0 or _hero_cover_honest_skip(diagnostics):
        return None
    return "hero_missing" if requested_ext == "pptx" else "cover_missing"


def _hero_cover_gate_applies(state: dict[str, Any], requested_ext: str | None) -> bool:
    return requested_ext in {"pptx", "pdf"} and _builder_image_enrichment_enabled(state)


def _hero_cover_honest_skip(diagnostics: dict[str, Any]) -> bool:
    error_class = str(diagnostics.get("image_generation_error_class") or "")
    return bool(diagnostics.get("image_generation_skip_reason")) or error_class in _IMAGE_GENERATION_TERMINAL_ERRORS or error_class == "content_blocked"


def _log_loop_rescues(artifact: dict[str, Any], state: dict[str, Any]) -> None:
    """Anti-masking telemetry (VQ-10): the loop detects defects, it must not
    hide them. A predicate that needed loop iterations but passes at delivery
    was RESCUED — recurring rescues are standing candidates for deterministic
    fixes upstream (this is how the label-overlap class of bug stays visible
    instead of being buried under lucky retries)."""
    rescued: list[str] = []
    if int(state.get("builder_visual_embed_rejections", 0) or 0) > 0 and _visual_presence_validated(artifact, state):
        rescued.append("visual_embed")
    if int(state.get("builder_hero_gate_rejections", 0) or 0) > 0:
        diagnostics = _pptx_diagnostics(state)
        if int(diagnostics.get("image_generation_success_count", 0) or 0) > 0:
            rescued.append("hero")
    for predicate in rescued:
        logger.warning(
            "[BuilderVQ] loop_masking_candidate predicate=%s iterations=%d",
            predicate,
            iterations_used(state),
        )


def _artifact_is_extension_fallback(requested_ext: str | None, artifact_ext: str | None) -> bool:
    return bool(requested_ext and artifact_ext and artifact_ext != requested_ext)


def _artifact_fallback_reason(
    artifact: dict[str, Any],
    requested_ext: str | None,
    fallback_reason: str | None,
) -> str | None:
    return fallback_reason or artifact.get("fallback_reason") or (f"{requested_ext}_generation_not_completed" if requested_ext else None)


def _pptx_artifact_path_rejection_reason(path: Any, state: dict[str, Any]) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return "pptx_artifact_path_not_under_outputs"
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix not in _allowed_pptx_artifact_suffixes(state):
        return f"pptx_invalid_artifact_extension:{suffix or 'none'}"
    return None


def _pptx_html_fallback_integrity_rejection_reason(
    canonical: str,
    state: dict[str, Any],
    runtime: Runtime,
) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if not _requested_pptx_artifact(state) or suffix not in {".html", ".htm"}:
        return None
    relative = _extract_output_relative_path(canonical)
    if relative is None:
        return "pptx_html_fallback_not_under_outputs"
    outputs_host_path = _outputs_host_path_from_state(state)
    if outputs_host_path:
        host_file = Path(outputs_host_path) / relative
        if host_file.is_file():
            reason = _html_fallback_integrity_error_for_file(host_file)
            if reason is not None:
                return reason
            return None
    for thread_id in _artifact_remote_thread_ids(state, runtime):
        try:
            result = supabase_artifact_store.download_artifact(thread_id, relative)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: html fallback remote integrity check failed error_type=%s",
                exc.__class__.__name__,
            )
            continue
        if result is not None:
            content, _mime = result
            return _html_fallback_integrity_error_for_bytes(content)
    return "html_fallback_missing"


def _html_artifact_path_rejection_reason(path: Any) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return "html_artifact_path_not_under_outputs"
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix not in _HTML_ARTIFACT_SUFFIXES:
        return f"html_invalid_artifact_extension:{suffix or 'none'}"
    return None


def _html_artifact_integrity_rejection_reason(
    canonical: str,
    state: dict[str, Any],
    runtime: Runtime,
) -> str | None:
    relative = _extract_output_relative_path(canonical)
    if relative is None:
        return "html_artifact_path_not_under_outputs"
    outputs_host_path = _outputs_host_path_from_state(state)
    if outputs_host_path:
        host_file = Path(outputs_host_path) / relative
        if host_file.is_file():
            return _html_fallback_integrity_error_for_file(host_file)
    for thread_id in _artifact_remote_thread_ids(state, runtime):
        try:
            result = supabase_artifact_store.download_artifact(thread_id, relative)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: html artifact remote integrity check failed error_type=%s",
                exc.__class__.__name__,
            )
            continue
        if result is not None:
            content, _mime = result
            return _html_fallback_integrity_error_for_bytes(content)
    return "html_artifact_missing"


def _pptx_path_integrity_rejection_reason(
    canonical: str,
    state: dict[str, Any],
    runtime: Runtime,
) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix != ".pptx":
        return None
    relative = _extract_output_relative_path(canonical)
    if relative is None:
        return "pptx_artifact_path_not_under_outputs"
    thread_data = state.get("thread_data") or {}
    outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
    if outputs_host_path:
        host_file = Path(outputs_host_path) / relative
        if host_file.is_file():
            return _pptx_integrity_error_for_file(host_file)
    for thread_id in _artifact_remote_thread_ids(state, runtime):
        try:
            result = supabase_artifact_store.download_artifact(thread_id, relative)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: pptx remote integrity check failed error_type=%s",
                exc.__class__.__name__,
            )
            continue
        if result is not None:
            content, _mime = result
            return _pptx_integrity_error_for_bytes(content)
    return None


def _pdf_render_attempted(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(any(name in _PDF_CREATION_TOOL_NAMES for name in (summary.get("tool_names") or [])) for summary in summaries if isinstance(summary, dict))


def _simple_pdf_writer_attempted(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(_SIMPLE_PDF_TOOL_NAME in (summary.get("tool_names") or []) for summary in summaries if isinstance(summary, dict))


def _requested_simple_pdf_artifact(state: dict[str, Any]) -> bool:
    if not _requested_pdf_artifact(state):
        return False
    task_text = _requested_task_text(state)
    if not task_text:
        return False
    if "simple product review" in task_text and "pdf" in task_text:
        return True
    return any(marker in task_text for marker in _SIMPLE_PDF_REQUEST_MARKERS)


def _successful_pdf_render_result(state: dict[str, Any]) -> dict[str, Any] | None:
    result = state.get("builder_pdf_render_result")
    if not isinstance(result, dict) or result.get("success") is not True:
        return None
    pdf_path = result.get("pdf_path")
    if not isinstance(pdf_path, str) or not pdf_path.strip():
        return None
    return result


def _pdf_render_layout_quality(state: dict[str, Any]) -> str:
    result = _successful_pdf_render_result(state) or {}
    return str(result.get("layout_quality") or "unknown")


def _pdf_layout_repair_attempts(state: dict[str, Any]) -> int:
    return int(state.get("builder_pdf_layout_repair_attempts", 0) or 0)


_PDF_REPORT_CONTRACT_ERROR_TYPES = {
    "report_manifest_required",
    "report_manifest_invalid",
    "report_contract_failed",
}


def _pdf_contract_repair_attempts(state: dict[str, Any]) -> int:
    return int(state.get("builder_pdf_contract_repair_attempts", 0) or 0)


def _visual_report_contract_required(state: dict[str, Any]) -> bool:
    delegation = state.get("delegation_context")
    task_type = str(delegation.get("task_type") or "").strip().lower() if isinstance(delegation, dict) else ""
    return task_type == "visual_report" and _requested_artifact_ext(state) == "pdf"


def _pdf_layout_repair_needed(state: dict[str, Any]) -> bool:
    result = _successful_pdf_render_result(state)
    if result is None:
        return False
    if _pdf_page_count_off_target({**state, **result}):
        return _pdf_layout_repair_attempts(state) < _PDF_PAGE_COUNT_REPAIR_MAX
    quality = _pdf_render_layout_quality(state)
    return quality in {"warning", "unusable"} and _pdf_layout_repair_attempts(state) < 1


def _pdf_render_unusable_after_repair(state: dict[str, Any]) -> bool:
    return _pdf_render_layout_quality(state) == "unusable" and _pdf_layout_repair_attempts(state) >= 1


def _pdf_render_page_count_failed_after_repairs(state: dict[str, Any]) -> bool:
    result = _successful_pdf_render_result(state)
    if result is None:
        return False
    return _pdf_page_count_off_target({**state, **result}) and _pdf_layout_repair_attempts(state) >= _PDF_PAGE_COUNT_REPAIR_MAX


def _pdf_page_count_failure_payload(state: dict[str, Any], result: dict[str, Any]) -> dict[str, int]:
    requested, _high = _pdf_requested_page_bounds({**state, **result})
    actual = result.get("page_count")
    requested_pages = int(requested or 0)
    actual_pages = int(actual or 0) if isinstance(actual, int) else 0
    return {
        "requested_pages": requested_pages,
        "actual_pages": actual_pages,
        "page_delta": actual_pages - requested_pages if requested_pages > 0 else 0,
    }


def _successful_pdf_ready_to_emit(state: dict[str, Any]) -> bool:
    result = _successful_pdf_render_result(state)
    if result is None:
        return False
    if _visual_report_contract_required(state) and result.get("report_contract_status") != "accepted":
        return False
    if _pdf_layout_repair_needed(state):
        return False
    if _pdf_render_unusable_after_repair(state):
        return False
    if _pdf_render_page_count_failed_after_repairs(state):
        return False
    return _canonical_outputs_artifact_path(result.get("pdf_path")) is not None


def _pdf_requested_page_bounds(state_or_result: dict[str, Any]) -> tuple[int | None, int | None]:
    exact = state_or_result.get("requested_page_count") or state_or_result.get("builder_pdf_requested_page_count")
    if isinstance(exact, int) and exact > 0:
        return exact, exact
    low = state_or_result.get("requested_min_pages") or state_or_result.get("builder_pdf_requested_min_pages")
    high = state_or_result.get("requested_max_pages") or state_or_result.get("builder_pdf_requested_max_pages")
    if isinstance(low, int) and isinstance(high, int) and low > 0 and high >= low:
        return low, high
    return None, None


def _pdf_page_target_text(state_or_result: dict[str, Any]) -> str:
    low, high = _pdf_requested_page_bounds(state_or_result)
    if low is None or high is None:
        return "10-15 pages when the user did not ask for a different length"
    if low == high:
        return f"exactly {low} pages"
    return f"{low}-{high} pages"


def _pdf_page_count_tolerance(low: int, high: int) -> int:
    """Pages of slack allowed on either side of the requested band."""
    midpoint = (low + high) / 2
    return max(1, round(midpoint * _PDF_PAGE_COUNT_TOLERANCE_FRACTION))


def _pdf_page_count_off_target(payload: dict[str, Any]) -> bool:
    low, high = _pdf_requested_page_bounds(payload)
    if low is None or high is None:
        return False
    page_count = payload.get("page_count")
    if not isinstance(page_count, int):
        return False
    tolerance = _pdf_page_count_tolerance(low, high)
    return not (low - tolerance <= page_count <= high + tolerance)


def _pdf_page_count_repair_instruction(result: dict[str, Any], state: dict[str, Any]) -> str:
    if result.get("layout_warning") in {"images_missing", "missing_image_resources"}:
        return (
            "One or more referenced figures are missing from the rendered PDF. Every figure must "
            "be inline `<svg>` in the HTML; for the few conceptual images, ensure each "
            '`<img src="visuals/...">` points to a real file under '
            "/mnt/user-data/outputs/visuals/ — fix the inline SVG or the dead `<img>` reference, "
            "then call render_html_to_pdf again. "
        )
    page_count = result.get("page_count")
    low, high = _pdf_requested_page_bounds({**state, **result})
    if result.get("layout_warning") == "page_count_off_target" and isinstance(page_count, int) and low is not None and high is not None:
        if page_count < low:
            return (
                "Make ONE targeted edit to the HTML (do not rewrite the whole document): add or "
                "expand a single section — one focused paragraph or a single figure with caption — "
                "to reach the requested length, then call render_html_to_pdf again. Do not pad "
                "every page; that creates sparse pages. "
            )
        if page_count > high:
            return "Make ONE targeted edit to the HTML (do not rewrite the whole document): trim or merge a single thin section and remove unnecessary page breaks to reach the requested length, then call render_html_to_pdf again. "
    return "Revise the HTML source once: compact sparse tables or continuation pages, remove unnecessary page breaks, combine thin sections, then call render_html_to_pdf again. "


def _enrich_pdf_render_result_with_requested_pages(
    payload: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    low, high = _pdf_requested_page_bounds(state)
    if low is None or high is None:
        return payload
    enriched = dict(payload)
    if low == high:
        enriched["requested_page_count"] = low
        enriched.pop("requested_min_pages", None)
        enriched.pop("requested_max_pages", None)
    else:
        enriched.pop("requested_page_count", None)
        enriched["requested_min_pages"] = low
        enriched["requested_max_pages"] = high
    if enriched.get("success") is True and _pdf_page_count_off_target(enriched) and enriched.get("layout_warning") not in {"all_pages_blank", "blank_pages_detected", "pdf_layout_unreadable"}:
        enriched["layout_quality"] = "warning"
        enriched["layout_warning"] = "page_count_off_target"
    elif enriched.get("layout_warning") == "page_count_off_target":
        enriched["layout_warning"] = None
        if enriched.get("layout_quality") == "warning":
            enriched["layout_quality"] = "ok"
    return enriched


def _pdf_layout_repair_message(result: dict[str, Any], state: dict[str, Any] | None = None) -> str:
    page_count = result.get("page_count")
    blank_count = result.get("blank_page_count")
    short_count = result.get("short_page_count")
    warning = result.get("layout_warning") or "layout_quality_warning"
    state_for_target = state or {}
    target = _pdf_page_target_text({**state_for_target, **result})
    instruction = _pdf_page_count_repair_instruction(result, state_for_target)
    return (
        "[Sophia/PDF layout repair]\n"
        "The PDF rendered successfully, but the layout/page-count quality check found an issue. "
        f"Metrics: page_count={page_count}, blank_page_count={blank_count}, "
        f"short_page_count={short_count}, warning={warning}. Target length is {target}.\n\n"
        f"{instruction}"
        "After this single repair pass, emit the best PDF rather than looping."
    )


def _canonical_outputs_artifact_path(path: Any) -> str | None:
    candidate = _stripped_artifact_path(path)
    if candidate is None:
        return None
    if candidate.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return _valid_prefixed_output_path(candidate)
    return _plain_output_artifact_path(candidate)


def _stripped_artifact_path(path: Any) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return None
    return path.strip()


def _valid_prefixed_output_path(candidate: str) -> str | None:
    return candidate if _extract_output_relative_path(candidate) is not None else None


def _plain_output_artifact_path(candidate: str) -> str | None:
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{candidate}" if _is_plain_output_filename(candidate) else None


def _is_plain_output_filename(candidate: str) -> bool:
    pure = PurePosixPath(candidate)
    return not pure.is_absolute() and ".." not in pure.parts and "/" not in candidate and "\\" not in candidate


def _pdf_artifact_path_rejection_reason(path: Any, state: dict[str, Any]) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return "pdf_artifact_path_not_under_outputs"
    return _pdf_artifact_suffix_rejection_reason(canonical, state)


def _pdf_artifact_suffix_rejection_reason(canonical: str, state: dict[str, Any]) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix not in _allowed_pdf_artifact_suffixes(state):
        return f"pdf_invalid_artifact_extension:{suffix or 'none'}"
    # Page count is never a path/emit rejection — a rendered .pdf off the
    # requested length still ships (with a quality_warning), never null.
    return _pdf_fallback_rejection_reason(suffix, state)


def _pdf_fallback_rejection_reason(suffix: str, state: dict[str, Any]) -> str | None:
    if suffix not in _PDF_FALLBACK_EXTENSIONS:
        return None
    if not _pdf_render_attempted(state):
        return "pdf_fallback_before_render_attempt"
    if _successful_pdf_ready_to_emit(state):
        return "pdf_fallback_when_valid_pdf_exists"
    return None


def _pdf_source_candidate_paths(state: dict[str, Any]) -> list[Path]:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return []
    min_mtime = _builder_started_min_mtime(state)
    try:
        candidates = [
            entry
            for entry in outputs_root.rglob("*")
            if _is_recent_promotable_path(entry, min_mtime) and entry.suffix.lower() in _PDF_RENDER_SOURCE_EXTENSIONS and (entry.suffix.lower() not in {".html", ".htm"} or _html_fallback_integrity_error_for_file(entry) is None)
        ]
    except OSError:
        logger.debug(
            "BuilderArtifact: pdf source scan failed outputs_path=%s",
            _outputs_host_path_from_state(state),
            exc_info=True,
        )
        return []
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates


def _preferred_pdf_render_source_path(state: dict[str, Any]) -> str | None:
    candidates = [candidate for candidate in _pdf_source_candidate_paths(state) if candidate.suffix.lower() in _PDF_RENDERABLE_HTML_SOURCE_EXTENSIONS]
    if not candidates:
        return None
    target = BuilderArtifactMiddleware._target_artifact_path(state)
    target_stem = Path(target or "").stem
    if target_stem:
        for candidate in candidates:
            if candidate.stem == target_stem:
                return BuilderArtifactMiddleware._virtual_output_path(candidate, state)
    return BuilderArtifactMiddleware._virtual_output_path(candidates[0], state)


def _pdf_render_target_path(state: dict[str, Any], source_path: str | None) -> str:
    target = BuilderArtifactMiddleware._target_artifact_path(state)
    if isinstance(target, str) and PurePosixPath(target).suffix.lower() == ".pdf":
        return target
    source = _canonical_outputs_artifact_path(source_path)
    if source:
        relative = PurePosixPath(source.removeprefix(_OUTPUTS_VIRTUAL_PREFIX))
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{relative.with_suffix('.pdf').as_posix()}"
    return f"{_OUTPUTS_VIRTUAL_PREFIX}build.pdf"


def _pdf_render_attempt_missing(state: dict[str, Any]) -> bool:
    if not _requested_pdf_artifact(state):
        return False
    return not _pdf_render_attempted(state)


def _artifact_path_suffix_label(path: object) -> str | None:
    return PurePosixPath(str(path or "")).suffix.lower().lstrip(".") or None


def _recovery_hint(outputs_root: Path, candidates: list[Path]) -> str:
    logger.info(
        "BuilderArtifact: emit_path_missing recovery_candidate_count=%s recovery_accepted=%s",
        len(candidates),
        len(candidates) == 1,
    )
    if len(candidates) != 1:
        return ""
    recovered = candidates[0].relative_to(outputs_root).as_posix()
    return f" I found exactly one plausible output candidate in the artifact directory: `{_OUTPUTS_VIRTUAL_PREFIX}{recovered}`. If that is the intended deliverable, call emit_builder_artifact again with that exact path."


def _first_research_tool_index(tool_names: list[str]) -> int:
    indexes = [index for index, name in enumerate(tool_names) if name in _BUILDER_RESEARCH_TOOL_NAMES]
    return indexes[0] if indexes else len(tool_names) + 1


def _first_write_tool_index(tool_names: list[str]) -> int:
    indexes = [index for index, name in enumerate(tool_names) if name in _BUILDER_WRITE_TOOL_NAMES]
    return indexes[0] if indexes else len(tool_names) + 1


def _diagnostic_int(diagnostics: dict[str, Any], key: str) -> int:
    return int(diagnostics.get(key, 0) or 0)


def _diagnostic_counts(diagnostics: dict[str, Any]) -> tuple[int, int, int]:
    return (
        _diagnostic_int(diagnostics, "builder_web_search_count"),
        _diagnostic_int(diagnostics, "builder_web_fetch_count"),
        _diagnostic_int(diagnostics, "write_file_count"),
    )


def _is_safe_pre_research_bash(command: Any) -> bool:
    """Return whether a bash command is read-only inspection."""
    if not isinstance(command, str) or not command.strip():
        return False
    if _BASH_WRITE_MARKER_RE.search(command):
        return False
    return bool(_SAFE_BASH_COMMAND_RE.search(command))


def _should_warn_missing_web_tools(
    *,
    phase: str,
    allow_web_research: bool,
    search_count: int,
    fetch_count: int,
    write_file_count: int,
) -> bool:
    return allow_web_research and (phase == "completion" or write_file_count > 0) and search_count + fetch_count == 0


def _write_tool_names(tool_names: list[str]) -> list[str]:
    return [name for name in tool_names if name in _BUILDER_WRITE_TOOL_NAMES]


def _builder_web_attempt_count(state: dict[str, Any]) -> int:
    budget = state.get("builder_web_budget") or {}
    if not isinstance(budget, dict):
        return 0
    return int(budget.get("search_calls", 0) or 0) + int(budget.get("fetch_calls", 0) or 0)


def _builder_web_call_count(state: dict[str, Any], key: str) -> int:
    budget = state.get("builder_web_budget") or {}
    if not isinstance(budget, dict):
        return 0
    return int(budget.get(f"{key}_calls", 0) or 0)


def _has_builder_search_source(state: dict[str, Any]) -> bool:
    sources = state.get("builder_search_sources") or []
    return any(isinstance(source, dict) and source.get("url") for source in sources)


def _has_fetchable_builder_source(state: dict[str, Any]) -> bool:
    allowed = state.get("builder_allowed_urls") or []
    sources = state.get("builder_search_sources") or []
    return any(str(url).strip() for url in allowed) or any(isinstance(source, dict) and source.get("url") for source in sources)


def _builder_task_needs_fetch(state: dict[str, Any]) -> bool:
    if _requested_pdf_artifact(state):
        return True
    delegation = state.get("delegation_context")
    task_type = delegation.get("task_type") if isinstance(delegation, dict) else None
    return str(task_type or "").lower() in {"document", "research", "visual_report"}


def _needs_fetch_before_write(state: dict[str, Any]) -> bool:
    if not _builder_task_needs_fetch(state):
        return False
    if _builder_web_call_count(state, "fetch") > 0:
        return False
    return _builder_web_call_count(state, "search") > 0 and _has_fetchable_builder_source(state)


def _pptx_skill_read_seen(state: dict[str, Any]) -> bool:
    reads = _latched_builder_skill_reads(state)
    if reads.get("pptx_skill_read"):
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(bool(summary.get("pptx_skill_read")) for summary in summaries if isinstance(summary, dict))


def _pptx_diagnostics(state: dict[str, Any]) -> dict[str, Any]:
    diagnostics = state.get("builder_pptx_diagnostics")
    return diagnostics if isinstance(diagnostics, dict) else {}


def _pptx_diagnostic_count(state: dict[str, Any], key: str) -> int:
    value = _pptx_diagnostics(state).get(key)
    return int(value or 0) if isinstance(value, int) else 0


def _pptx_generator_invoked_seen(state: dict[str, Any]) -> bool:
    if _pptx_diagnostic_count(state, "pptx_generator_attempt_count") > 0:
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(bool(summary.get("pptx_generator_invoked")) for summary in summaries if isinstance(summary, dict))


def _pptx_fallback_generation_attempt_satisfied(state: dict[str, Any]) -> bool:
    attempts = _pptx_diagnostic_count(state, "pptx_generator_attempt_count")
    if attempts <= 0:
        summaries = state.get("builder_tool_turn_summaries") or []
        return any(bool(summary.get("pptx_generator_invoked")) for summary in summaries if isinstance(summary, dict))
    diagnostics = _pptx_diagnostics(state)
    if diagnostics.get("pptx_generator_error_class") == "invalid_plan_json" and attempts < 2:
        return False
    return True


def _image_generation_invoked_seen(state: dict[str, Any]) -> bool:
    if _pptx_diagnostic_count(state, "image_generation_attempt_count") > 0:
        return True
    if _pptx_diagnostic_count(state, "image_generation_startup_attempt_count") > 0:
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(bool(summary.get("image_generation_invoked")) for summary in summaries if isinstance(summary, dict))


def _command_parts(command: str) -> list[str]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return []


def _command_flag_value(command: str, flag: str) -> str | None:
    parts = _command_parts(command)
    for index, part in enumerate(parts):
        if part == flag and index + 1 < len(parts):
            return parts[index + 1]
        if part.startswith(flag + "="):
            return part.split("=", 1)[1]
    return None


def _command_flag_values(command: str, flag: str) -> list[str]:
    parts = _command_parts(command)
    values: list[str] = []
    collect = False
    for part in parts:
        if collect:
            if part in _SHELL_SEPARATORS or part.startswith("--"):
                collect = False
            else:
                values.append(part)
                continue
        if part == flag:
            collect = True
            continue
        if part.startswith(flag + "="):
            values.append(part.split("=", 1)[1])
    return values


def _command_segment_for_marker(command: str, markers: tuple[str, ...]) -> str:
    parts = _command_parts(command)
    if not parts:
        return command
    marker_index = next(
        (index for index, part in enumerate(parts) if any(marker in part for marker in markers)),
        None,
    )
    if marker_index is None:
        return command
    start = marker_index
    while start > 0 and parts[start - 1] not in _SHELL_SEPARATORS:
        start -= 1
    end = marker_index + 1
    while end < len(parts) and parts[end] not in _SHELL_SEPARATORS:
        end += 1
    return shlex.join(parts[start:end])


def _command_segments_for_marker(command: str, markers: tuple[str, ...]) -> list[str]:
    parts = _command_parts(command)
    if not parts:
        return [command] if any(marker in command for marker in markers) else []
    segments: list[str] = []
    start = 0
    for index, part in enumerate([*parts, "&&"]):
        if part not in _SHELL_SEPARATORS:
            continue
        segment = parts[start:index]
        if segment and any(any(marker in item for marker in markers) for item in segment):
            segments.append(shlex.join(segment))
        start = index + 1
    return segments


def _empty_pptx_skill_flags() -> dict[str, Any]:
    return {
        "pptx_skill_read": False,
        "pptx_generator_invoked": False,
        "image_generation_invoked": False,
        "image_output_paths": [],
        "pptx_output_paths": [],
    }


def _pptx_skill_flags_for_read(args: dict[str, Any]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    path = str(args.get("path") or args.get("file_path") or "")
    flags["pptx_skill_read"] = any(marker in path for marker in _PPTX_SKILL_PATH_MARKERS)
    return flags


def _pptx_skill_flags_for_bash(args: dict[str, Any]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    command = str(args.get("command") or "")
    command_invokes_generator = any(marker in command for marker in _PPTX_GENERATOR_PATH_MARKERS)
    command_invokes_image = any(marker in command for marker in _IMAGE_GENERATION_PATH_MARKERS)
    flags["pptx_generator_invoked"] = command_invokes_generator
    flags["image_generation_invoked"] = command_invokes_image
    output_path = _command_flag_value(command, "--output-file")
    if output_path and command_invokes_image:
        flags["image_output_paths"] = [output_path]
    if output_path and command_invokes_generator:
        flags["pptx_output_paths"] = [output_path]
    return flags


def _merge_pptx_skill_flags(current: dict[str, Any], update: dict[str, Any]) -> None:
    current["pptx_skill_read"] = bool(current["pptx_skill_read"] or update.get("pptx_skill_read"))
    current["pptx_generator_invoked"] = bool(current["pptx_generator_invoked"] or update.get("pptx_generator_invoked"))
    current["image_generation_invoked"] = bool(current["image_generation_invoked"] or update.get("image_generation_invoked"))
    current["image_output_paths"].extend(update.get("image_output_paths") or [])
    current["pptx_output_paths"].extend(update.get("pptx_output_paths") or [])


def _pptx_skill_flags_from_tool_calls(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    for call in tool_calls:
        args = call.get("args") or {}
        if not isinstance(args, dict):
            continue
        name = call.get("name")
        if name in ("read_file", "read_file_tool"):
            _merge_pptx_skill_flags(flags, _pptx_skill_flags_for_read(args))
        elif name in ("bash", "bash_tool"):
            _merge_pptx_skill_flags(flags, _pptx_skill_flags_for_bash(args))
    return flags


def _visual_skill_flags_from_tool_calls(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    # Artifact Visual System Phase 5c: this also records pdf-report reads so
    # the per-target emit gate can require them (the `**visual_skill_flags`
    # spread at the summary sites carries every key it returns).
    flags = {"visual_design_skill_read": False, "pdf_report_skill_read": False}
    for call in tool_calls:
        if call.get("name") not in ("read_file", "read_file_tool"):
            continue
        args = call.get("args") or {}
        if not isinstance(args, dict):
            continue
        path = str(args.get("path") or args.get("file_path") or "")
        if any(marker in path for marker in _VISUAL_DESIGN_SKILL_PATH_MARKERS):
            flags["visual_design_skill_read"] = True
        if any(marker in path for marker in _PDF_REPORT_SKILL_PATH_MARKERS):
            flags["pdf_report_skill_read"] = True
    return flags


def _visual_design_skill_read_seen(state: dict[str, Any]) -> bool:
    reads = _latched_builder_skill_reads(state)
    if reads.get("visual_design_skill_read"):
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    if any(bool(summary.get("visual_design_skill_read")) for summary in summaries if isinstance(summary, dict)):
        return True
    diagnostics = state.get("builder_visual_diagnostics")
    return isinstance(diagnostics, dict) and bool(diagnostics.get("visual_design_skill_read") or diagnostics.get("design_skill_read"))


def _pdf_report_skill_read_seen(state: dict[str, Any]) -> bool:
    reads = _latched_builder_skill_reads(state)
    if reads.get("pdf_report_skill_read"):
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(bool(summary.get("pdf_report_skill_read")) for summary in summaries if isinstance(summary, dict))


def _target_skill_read_seen(state: dict[str, Any], target_ext: str) -> bool:
    """Phase 5c: has the skill REQUIRED for this artifact target been read?

    .pptx → ppt-generation, .pdf → pdf-report, .html → hallmark (the
    hallmark markers live in the visual-design read set). Targets without a
    required skill (.md/.csv/…) return True (nothing to gate).
    """
    if target_ext == ".pptx":
        return _pptx_skill_read_seen(state)
    if target_ext == ".pdf":
        return _pdf_report_skill_read_seen(state)
    if target_ext in {".html", ".htm"}:
        return _visual_design_skill_read_seen(state)
    return True


def _latched_builder_skill_reads(state: dict[str, Any]) -> dict[str, bool]:
    reads = state.get("builder_skill_reads")
    if isinstance(reads, dict):
        return {
            "pptx_skill_read": bool(reads.get("pptx_skill_read")),
            "visual_design_skill_read": bool(reads.get("visual_design_skill_read")),
            "pdf_report_skill_read": bool(reads.get("pdf_report_skill_read")),
        }
    summaries = state.get("builder_tool_turn_summaries") or []
    for summary in reversed(summaries):
        if not isinstance(summary, dict):
            continue
        summary_reads = summary.get("builder_skill_reads")
        if isinstance(summary_reads, dict):
            return {
                "pptx_skill_read": bool(summary_reads.get("pptx_skill_read")),
                "visual_design_skill_read": bool(summary_reads.get("visual_design_skill_read")),
                "pdf_report_skill_read": bool(summary_reads.get("pdf_report_skill_read")),
            }
    return {
        "pptx_skill_read": False,
        "visual_design_skill_read": False,
        "pdf_report_skill_read": False,
    }


def _latch_builder_skill_reads(state: dict[str, Any], turn_flags: dict[str, Any]) -> dict[str, bool]:
    reads = _latched_builder_skill_reads(state)
    for key in ("pptx_skill_read", "visual_design_skill_read", "pdf_report_skill_read"):
        if turn_flags.get(key):
            reads[key] = True
    state["builder_skill_reads"] = reads
    return reads


def _builder_visual_force_count(state: dict[str, Any]) -> int:
    try:
        return int(state.get("builder_visual_force_count", 0) or 0)
    except (TypeError, ValueError):
        return 0


# Phase 5c: the read_file path + human name for each gated target.
_TARGET_REQUIRED_SKILL: dict[str, tuple[str, str]] = {
    ".pptx": ("/mnt/skills/public/ppt-generation/SKILL.md", "ppt-generation"),
    ".pdf": ("/mnt/skills/public/pdf-report/SKILL.md", "pdf-report"),
    ".html": ("/mnt/skills/public/hallmark/SKILL.md", "hallmark"),
    ".htm": ("/mnt/skills/public/hallmark/SKILL.md", "hallmark"),
}


def _visuals_requested(state: dict[str, Any]) -> bool:
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        return False
    combined = "\n".join(str(delegation.get(key) or "").lower() for key in ("task", "description", "artifact_brief", "original_task"))
    return any(_text_marker_present(combined, marker) for marker in _VISUAL_REQUEST_MARKERS)


def _visual_asset_success_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("visual_asset_success_count", 0) or 0)


def _embedded_visual_success_count(state: dict[str, Any]) -> int:
    count = _visual_asset_success_count(state)
    if _requested_pptx_artifact(state):
        diagnostics = _pptx_diagnostics(state)
        count += int(diagnostics.get("pptx_generator_picture_count", 0) or 0)
    return count


def _visual_asset_attempt_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("visual_asset_attempt_count", 0) or 0)


def _visual_asset_paths(state: dict[str, Any]) -> list[str]:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return []
    paths = diagnostics.get("visual_asset_paths") or []
    return [path for path in paths if isinstance(path, str)]


_MARKDOWN_IMAGE_REF_RE = re.compile(r"!\[[^\]]*]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)")
_HTML_IMAGE_SRC_RE = re.compile(r"<img\b[^>]*\bsrc\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)


def _virtual_output_path_from_host(path: Path, state: dict[str, Any]) -> str | None:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return None
    try:
        relative = path.resolve().relative_to(outputs_root.resolve())
    except (OSError, ValueError):
        return None
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{relative.as_posix()}"


def _append_virtual_candidate(candidates: list[Path], state: dict[str, Any], path: object) -> None:
    if not isinstance(path, str) or not path.strip():
        return
    local = _local_output_file_for_artifact(state, path)
    if local is not None:
        candidates.append(local)


def _pdf_source_siblings(pdf_file: Path | None) -> list[Path]:
    if pdf_file is None:
        return []
    return [
        sibling
        for sibling in (
            pdf_file.with_suffix(".md"),
            pdf_file.with_suffix(".markdown"),
            pdf_file.with_suffix(".html"),
        )
        if sibling.is_file()
    ]


def _unique_existing_candidates(candidates: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    unique: list[Path] = []
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(candidate)
    return unique


def _report_source_candidate_files(state: dict[str, Any]) -> list[Path]:
    candidates: list[Path] = []

    render_result = state.get("builder_pdf_render_result")
    if isinstance(render_result, dict):
        _append_virtual_candidate(candidates, state, render_result.get("markdown_path") or render_result.get("source_path"))
        pdf_path = render_result.get("pdf_path")
        candidates.extend(_pdf_source_siblings(_local_output_file_for_artifact(state, pdf_path)))

    target = state.get("builder_artifact_target_path")
    _append_virtual_candidate(candidates, state, target)
    target_file = _local_output_file_for_artifact(state, target)
    if target_file is not None and target_file.suffix.lower() == ".pdf":
        candidates.extend(_pdf_source_siblings(target_file))

    preferred = _preferred_pdf_render_source_path(state)
    _append_virtual_candidate(candidates, state, preferred)
    return _unique_existing_candidates(candidates)


def _markdown_image_refs(text: str) -> list[str]:
    return [ref.strip().strip("<>") for ref in [*_MARKDOWN_IMAGE_REF_RE.findall(text), *_HTML_IMAGE_SRC_RE.findall(text)] if ref.strip()]


def _resolve_markdown_image_ref(ref: str, source_file: Path, state: dict[str, Any]) -> str | None:
    if re.match(r"^(?:https?:|data:)", ref, re.IGNORECASE):
        return None
    canonical = _canonical_outputs_artifact_path(ref)
    if canonical:
        return canonical
    pure = PurePosixPath(ref)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    outputs_root = _outputs_root_from_state(state)
    candidates = [source_file.parent / pure.as_posix()]
    if outputs_root is not None:
        candidates.append(outputs_root / pure.as_posix())
    for candidate in candidates:
        if candidate.is_file():
            return _virtual_output_path_from_host(candidate, state)
    if outputs_root is not None:
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{pure.as_posix()}"
    return None


def _embedded_report_figure_paths(state: dict[str, Any]) -> set[str]:
    embedded: set[str] = set()
    for source_file in _report_source_candidate_files(state):
        try:
            text = source_file.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for ref in _markdown_image_refs(text):
            resolved = _resolve_markdown_image_ref(ref, source_file, state)
            if resolved:
                embedded.add(resolved)
    return embedded


def _visual_record_embedded(record: dict[str, Any], embedded_paths: set[str]) -> bool:
    raw_path = record.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    canonical = _canonical_outputs_artifact_path(raw_path)
    return canonical in embedded_paths if canonical else raw_path.strip() in embedded_paths


def _visual_record_grammar(record: dict[str, Any]) -> str | None:
    for key in ("grammar", "family", "visual_type", "chart_family", "chart_tool"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _visual_figure_records(state: dict[str, Any]) -> list[dict[str, Any]]:
    diagnostics = state.get("builder_visual_diagnostics")
    records = diagnostics.get("visual_figure_records") if isinstance(diagnostics, dict) else None
    if not isinstance(records, list):
        return []
    normalized = _copy_visual_records(records)
    embedded_paths = _embedded_report_figure_paths(state)
    if not embedded_paths:
        return normalized
    return _embedded_visual_records(normalized, embedded_paths)


def _copy_visual_records(records: list[Any]) -> list[dict[str, Any]]:
    copied: list[dict[str, Any]] = []
    for record in records:
        if isinstance(record, dict):
            copied.append(dict(record))
    return copied


def _embedded_visual_records(
    records: list[dict[str, Any]],
    embedded_paths: set[str],
) -> list[dict[str, Any]]:
    embedded: list[dict[str, Any]] = []
    for record in records:
        if _visual_record_embedded(record, embedded_paths):
            embedded.append(record)
    return embedded


def _visual_failed_family_records(state: dict[str, Any]) -> list[dict[str, Any]]:
    diagnostics = state.get("builder_visual_diagnostics")
    records = diagnostics.get("visual_failed_family_records") if isinstance(diagnostics, dict) else None
    return [dict(record) for record in records if isinstance(record, dict)] if isinstance(records, list) else []


def _visual_grammar_counts(state: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in _visual_figure_records(state):
        grammar = _visual_record_grammar(record)
        if not grammar:
            continue
        counts[grammar] = counts.get(grammar, 0) + 1
    return dict(sorted(counts.items()))


def _report_grammar_diversity_problems(figure_count: int, counts: dict[str, int]) -> list[str]:
    problems: list[str] = []
    if len(counts) < 2:
        problems.append(f"report has {figure_count} embedded figures but fewer than two visual grammars")
    if figure_count >= 4:
        problems.extend(f"visual grammar `{grammar}` appears in {count}/{figure_count} figures (>50%)" for grammar, count in counts.items() if count / figure_count > 0.5)
    return problems


def _failed_report_variety_problem(state: dict[str, Any], counts: dict[str, int]) -> str | None:
    if len(counts) >= 2:
        return None
    failed_names = sorted({grammar for record in _visual_failed_family_records(state) if (grammar := _visual_record_grammar(record))})
    if not failed_names:
        return None
    return "chart/diagram variety attempts failed for: " + ", ".join(failed_names[:6])


def _report_visual_grammar_problems(state: dict[str, Any]) -> list[str]:
    if _requested_artifact_ext(state) != "pdf":
        return []
    records = _visual_figure_records(state)
    figure_count = len(records)
    if figure_count < 2:
        return []
    counts = _visual_grammar_counts(state)
    problems = _report_grammar_diversity_problems(figure_count, counts)
    failed_problem = _failed_report_variety_problem(state, counts)
    if failed_problem:
        problems.append(failed_problem)
    return problems


def _local_output_file_for_artifact(state: dict[str, Any], artifact_path: object) -> Path | None:
    canonical = _canonical_outputs_artifact_path(artifact_path)
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if canonical is None or relative is None or outputs_root is None:
        return None
    candidate = outputs_root / relative
    return candidate if candidate.is_file() else None


def _output_file_sha256(state: dict[str, Any], artifact_path: object) -> str | None:
    host_file = _local_output_file_for_artifact(state, artifact_path)
    if host_file is None:
        return None
    digest = hashlib.sha256()
    try:
        with host_file.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _image_record_for_path(
    state: dict[str, Any],
    image_path: str,
    *,
    slide_index: int | None = None,
    qc_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    image_hash = _output_file_sha256(state, image_path)
    if not image_hash:
        return None
    record: dict[str, Any] = {
        "image_ref": image_path,
        "image_basename": PurePosixPath(image_path).name,
        "image_hash": image_hash,
    }
    if slide_index is not None:
        record["slide_index"] = slide_index
    if qc_result is not None:
        record["qc_result"] = qc_result
    return record


def _image_output_records(state: dict[str, Any], image_paths: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, image_path in enumerate(image_paths, 1):
        record = _image_record_for_path(state, image_path, slide_index=index)
        if record is not None:
            records.append(record)
    return records


def _html_contains_visual_evidence(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False
    return "<svg" in text or "/visuals/" in text or "visuals/" in text or "outputs/visuals/" in text


def _pdf_source_contains_visual_evidence(state: dict[str, Any]) -> bool:
    for source in _pdf_source_candidate_paths(state):
        try:
            text = source.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            continue
        if "<svg" in text or "/visuals/" in text or "visuals/" in text or "outputs/visuals/" in text:
            return True
    return False


def _pptx_contains_visual_evidence(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if any(name.startswith("ppt/media/") or name.startswith("ppt/charts/") or name.startswith("ppt/diagrams/") for name in names):
                return True
            for name in names:
                if not name.startswith("ppt/slides/slide") or not name.endswith(".xml"):
                    continue
                slide_xml = archive.read(name)
                if any(marker in slide_xml for marker in (b"<p:cxnSp", b"<a:tbl", b"<p:graphicFrame", b"<p:pic")):
                    return True
                if any(b'txBox="1"' not in shape_xml for shape_xml in re.findall(rb"<p:sp\b.*?</p:sp>", slide_xml, re.S)):
                    return True
    except (OSError, zipfile.BadZipFile):
        return False
    return False


def _pdf_object(value: Any) -> Any:
    getter = getattr(value, "get_object", None)
    if callable(getter):
        try:
            return getter()
        except Exception:  # noqa: BLE001
            return value
    return value


def _pdf_page_image_count(page: Any) -> int:
    try:
        images = getattr(page, "images", None)
        if images:
            return len(images)
    except Exception:  # noqa: BLE001
        pass
    try:
        resources = _pdf_object(page.get("/Resources", {}))
        xobjects = _pdf_object(resources.get("/XObject", {})) if hasattr(resources, "get") else {}
    except Exception:  # noqa: BLE001
        return 0
    count = 0
    if hasattr(xobjects, "values"):
        for value in xobjects.values():
            xobject = _pdf_object(value)
            subtype = xobject.get("/Subtype") if hasattr(xobject, "get") else None
            if subtype == "/Image":
                count += 1
            elif subtype == "/Form":
                count += _pdf_page_image_count(xobject)
    return count


def _render_result_has_required_visual_evidence(render_result: dict[str, Any]) -> bool | None:
    try:
        image_count = int(render_result.get("image_count", 0) or 0)
        vector_count = int(render_result.get("vector_visual_count", 0) or 0)
        expected_count = int(render_result.get("expected_visual_count", 0) or 0)
        found_count = int(render_result.get("found_visual_count", 0) or 0)
    except (TypeError, ValueError):
        return None
    rendered_count = image_count + vector_count
    if expected_count > 0:
        return found_count >= expected_count and rendered_count >= expected_count
    return rendered_count > 0


def _pdf_contains_visual_evidence(path: Path, state: dict[str, Any]) -> bool:
    render_result = state.get("builder_pdf_render_result")
    if isinstance(render_result, dict):
        # Inline <svg> figures are vector in the PDF (not /Image XObjects), so a
        # fully-illustrated HTML→PDF report reads image_count=0. Honor the
        # renderer's vector_visual_count so we don't false-reject it (R2-2,
        # prod 2026-06-26). Either rasterized images OR vector figures count.
        render_evidence = _render_result_has_required_visual_evidence(render_result)
        if render_evidence is not None:
            return render_evidence
    if PdfReader is None:
        return False
    try:
        reader = PdfReader(str(path))
        return sum(_pdf_page_image_count(page) for page in reader.pages) > 0
    except Exception:  # noqa: BLE001
        logger.warning("[BuilderVisualDiagnostics] pdf_visual_inspection_failed", exc_info=True)
        return False


def _visual_presence_validated(artifact_args: dict[str, Any], state: dict[str, Any]) -> bool:
    if not _visuals_requested(state):
        return True
    artifact_path = artifact_args.get("artifact_path")
    artifact_file = _local_output_file_for_artifact(state, artifact_path)
    suffix = PurePosixPath(str(artifact_path or "")).suffix.lower()

    if suffix in {".html", ".htm"} and artifact_file is not None:
        return _html_contains_visual_evidence(artifact_file)
    if suffix == ".pptx" and artifact_file is not None:
        return _pptx_contains_visual_evidence(artifact_file)
    if suffix == ".pdf" and artifact_file is not None:
        return _pdf_contains_visual_evidence(artifact_file, state)
    return _embedded_visual_success_count(state) > 0


def _apply_visual_missing_quality_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """Annotate a rendered primary whose requested visuals did not embed.

    This is a QUALITY warning, never a fallback flag: a successfully rendered
    artifact in the requested format is the deliverable (prod 2026-06-10:
    setting ``artifact_is_fallback=True`` here made the frontend surface the
    markdown source sibling instead of the rendered PDF).
    """
    if not _visuals_requested(state):
        return artifact
    requested_ext = _requested_artifact_ext(state)
    artifact_ext = _artifact_ext_from_path(artifact.get("artifact_path"))
    if requested_ext not in {"pdf", "pptx"} or artifact_ext != requested_ext:
        return artifact
    if _visual_presence_validated(artifact, state):
        return artifact
    updated = dict(artifact)
    updated["requested_artifact_ext"] = requested_ext
    updated["artifact_ext"] = artifact_ext
    updated["visuals_missing"] = True
    updated["quality_warning"] = "visuals_not_embedded"
    confidence = updated.get("confidence")
    if isinstance(confidence, (int, float)):
        updated["confidence"] = min(float(confidence), 0.65)
    tone_hint = str(updated.get("companion_tone_hint") or "").strip()
    degraded_hint = "Explain that the file is usable, but visual embedding did not complete."
    updated["companion_tone_hint"] = f"{tone_hint} {degraded_hint}".strip()
    logger.warning(
        "[BuilderVisualDiagnostics] phase=visual_missing_quality_warning requested_ext=%s final_ext=%s",
        requested_ext,
        artifact_ext,
    )
    return updated


def _apply_pdf_page_count_quality_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """Annotate a rendered PDF whose page count is outside the requested band.

    Page count is NEVER a terminal failure for a delivered .pdf (restores the
    "a delivered artifact in the requested format is never a fallback"
    invariant — prod 2026-06-24: an 11-page PDF for a "10-page" request was
    discarded as artifact_path=null). An off-band render ships with a
    quality_warning + capped confidence instead.
    """
    if _artifact_ext_from_path(artifact.get("artifact_path")) != "pdf":
        return artifact
    result = _successful_pdf_render_result(state)
    if result is None or not _pdf_page_count_off_target({**state, **result}):
        return artifact
    if artifact.get("quality_warning"):
        return artifact
    counts = _pdf_page_count_failure_payload(state, result)
    updated = dict(artifact)
    updated["quality_warning"] = "page_count_off_target"
    updated["page_count_delta"] = counts.get("page_delta")
    confidence = updated.get("confidence")
    if isinstance(confidence, (int, float)):
        updated["confidence"] = min(float(confidence), 0.65)
    tone_hint = str(updated.get("companion_tone_hint") or "").strip()
    degraded_hint = "Note the report is a little off the requested page length but complete and usable."
    updated["companion_tone_hint"] = f"{tone_hint} {degraded_hint}".strip()
    logger.warning(
        "[BuilderArtifact] phase=page_count_off_target_quality_warning requested=%s actual=%s delta=%s",
        counts.get("requested_pages"),
        counts.get("actual_pages"),
        counts.get("page_delta"),
    )
    return updated


def _apply_hero_missing_quality_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """Honest quality note when the hero/cover gate soft-passed (VQ-4).

    Applied only when the repair turn was spent without a successful
    generated image AND no stronger quality warning is already present.
    """
    if artifact.get("quality_warning"):
        return artifact
    requested_ext = _requested_artifact_ext(state)
    if requested_ext not in {"pptx", "pdf"}:
        return artifact
    if int(state.get("builder_hero_gate_rejections", 0) or 0) < 1:
        return artifact
    diagnostics = _pptx_diagnostics(state)
    if int(diagnostics.get("image_generation_success_count", 0) or 0) > 0:
        return artifact
    updated = dict(artifact)
    updated["quality_warning"] = "hero_missing" if requested_ext == "pptx" else "cover_missing"
    updated["visuals_missing"] = True
    confidence = updated.get("confidence")
    if isinstance(confidence, (int, float)):
        updated["confidence"] = min(float(confidence), 0.7)
    logger.warning(
        "[BuilderImageGeneration] phase=hero_missing_quality_warning requested_ext=%s",
        requested_ext,
    )
    return updated


def _apply_pptx_deck_quality_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """Surface partial-image deck builds as honest artifact quality metadata."""
    if _artifact_ext_from_path(artifact.get("artifact_path")) != "pptx":
        return artifact
    diagnostics = _pptx_diagnostics(state)
    warning = diagnostics.get("pptx_deck_quality_warning")
    try:
        missing_count = int(diagnostics.get("pptx_deck_missing_image_count", 0) or 0)
    except (TypeError, ValueError):
        missing_count = 0
    if warning == "visual_quality_warning":
        updated = dict(artifact)
        updated["deck_visual_quality_warning"] = True
        if not updated.get("quality_warning"):
            updated["quality_warning"] = "visual_quality_warning"
            confidence = updated.get("confidence")
            if isinstance(confidence, (int, float)):
                updated["confidence"] = min(float(confidence), 0.75)
            tone_hint = str(updated.get("companion_tone_hint") or "").strip()
            quality_hint = "Note that the deck is valid, but the visual-quality repair was already spent and some slide aesthetics may still need manual polish."
            updated["companion_tone_hint"] = f"{tone_hint} {quality_hint}".strip()
        logger.warning("[BuilderArtifact] phase=pptx_visual_quality_warning")
        return updated
    if warning != "visuals_partial" or missing_count <= 0:
        if warning and not artifact.get("quality_warning"):
            updated = dict(artifact)
            updated["quality_warning"] = warning
            return updated
        return artifact

    updated = dict(artifact)
    updated["deck_visuals_partial"] = True
    updated["missing_image_count"] = missing_count
    if not updated.get("quality_warning"):
        updated["quality_warning"] = "visuals_partial"
        confidence = updated.get("confidence")
        if isinstance(confidence, (int, float)):
            updated["confidence"] = min(float(confidence), 0.75)
        tone_hint = str(updated.get("companion_tone_hint") or "").strip()
        degraded_hint = f"Note that the deck is usable, but {missing_count} slide visual{'' if missing_count == 1 else 's'} used a placeholder because source imagery was missing."
        updated["companion_tone_hint"] = f"{tone_hint} {degraded_hint}".strip()
    logger.warning(
        "[BuilderArtifact] phase=pptx_visuals_partial_quality_warning missing_image_count=%d",
        missing_count,
    )
    return updated


def _apply_report_figure_quality_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    counts = _visual_grammar_counts(state)
    problems = _report_visual_grammar_problems(state)
    if not counts and not problems:
        return artifact
    updated = dict(artifact)
    if counts:
        updated["report_visual_grammar_counts"] = counts
        updated["report_visual_grammar_count"] = len(counts)
    if problems:
        updated["quality_warning"] = "report_visual_grammar"
        updated["report_visual_grammar_problems"] = problems
        confidence = updated.get("confidence")
        if isinstance(confidence, (int, float)):
            updated["confidence"] = min(float(confidence), 0.65)
    return updated


def _visual_payload_grammar(payload: dict[str, Any]) -> str | None:
    chart_grammar = _visual_payload_prefixed_value(payload, "chart_family", "chart")
    if chart_grammar:
        return chart_grammar
    chart_tool = _visual_payload_prefixed_value(payload, "chart_tool", "chart")
    if chart_tool:
        return chart_tool
    visual_type = _visual_payload_prefixed_value(payload, "visual_type", "diagram")
    if visual_type:
        return visual_type
    return None


def _visual_payload_prefixed_value(payload: dict[str, Any], key: str, prefix: str) -> str | None:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    return f"{prefix}:{value.strip()}"


def _copy_visual_payload_record_fields(record: dict[str, Any], payload: dict[str, Any]) -> None:
    for key in ("visual_type", "chart_tool", "chart_family", "error_type", "spec_path"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            record[key] = value.strip()


def _visual_payload_record(payload: dict[str, Any], *, success: bool) -> dict[str, Any] | None:
    grammar = _visual_payload_grammar(payload)
    svg_path, png_path = _visual_payload_paths(payload)
    path = png_path or svg_path
    if grammar is None and not isinstance(path, str):
        return None
    record: dict[str, Any] = {"success": success}
    if grammar is not None:
        record["grammar"] = grammar
        record["family"] = grammar
    if isinstance(path, str) and path.strip():
        record["path"] = path.strip()
    _copy_visual_payload_record_fields(record, payload)
    return record


def _visual_asset_result_delta(result: ToolMessage) -> dict[str, Any] | None:
    payload = _visual_tool_payload(result)
    if payload is None:
        return None
    delta = _visual_tool_payload_delta(payload)
    logger.info(
        "[BuilderVisualDiagnostics] phase=tool_result success=%s visual_type=%s svg_bytes=%s png_bytes=%s png_error=%s",
        delta["visual_asset_success_count"] > 0,
        _visual_payload_kind(payload),
        payload.get("svg_bytes"),
        payload.get("png_bytes") or payload.get("image_bytes"),
        payload.get("png_error"),
    )
    return delta


def _visual_tool_payload(result: ToolMessage) -> dict[str, Any] | None:
    if not isinstance(result.content, str):
        return None
    try:
        payload = json.loads(result.content)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _visual_tool_payload_delta(payload: dict[str, Any]) -> dict[str, Any]:
    success = payload.get("success") is True
    svg_path, png_path = _visual_payload_paths(payload)
    paths, svg_paths, png_paths = _successful_visual_paths(success, svg_path, png_path)
    record = _visual_payload_record(payload, success=success)
    delta: dict[str, Any] = {
        "visual_asset_attempt_count": 1,
        "visual_asset_success_count": 1 if success else 0,
        "visual_asset_bytes_total": _visual_payload_bytes(payload),
        "visual_asset_error_class": None if success else payload.get("error_type", "visual_asset_error"),
        "visual_asset_paths": paths,
        "visual_svg_paths": svg_paths,
        "visual_png_paths": png_paths,
    }
    if record is not None:
        if success:
            delta["visual_figure_records"] = [record]
        else:
            delta["visual_failed_family_records"] = [record]
    return delta


def _successful_visual_paths(
    success: bool,
    svg_path: Any,
    png_path: Any,
) -> tuple[list[str], list[str], list[str]]:
    if not success:
        return [], [], []
    paths = [path for path in (svg_path, png_path) if isinstance(path, str) and path]
    svg_paths = [svg_path] if isinstance(svg_path, str) else []
    png_paths = [png_path] if isinstance(png_path, str) else []
    return paths, svg_paths, png_paths


def _visual_payload_kind(payload: dict[str, Any]) -> Any:
    return payload.get("visual_type") or payload.get("chart_tool")


def _visual_payload_paths(payload: dict[str, Any]) -> tuple[Any, Any]:
    return payload.get("svg_path"), payload.get("png_path") or payload.get("image_path")


def _payload_int(payload: dict[str, Any], key: str, fallback_key: str | None = None) -> int:
    value = payload.get(key)
    if value is None and fallback_key is not None:
        value = payload.get(fallback_key)
    return int(value or 0)


def _visual_payload_bytes(payload: dict[str, Any]) -> int:
    return _payload_int(payload, "svg_bytes") + _payload_int(payload, "png_bytes", "image_bytes")


def _virtual_output_status(state: dict[str, Any], path: str | None) -> tuple[bool, int, str | None]:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return False, 0, "not_outputs_path"
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if relative is None or outputs_root is None:
        return False, 0, "missing_outputs_root"
    host_path = outputs_root / relative
    if not host_path.is_file():
        return False, 0, "missing_output"
    try:
        return True, int(host_path.stat().st_size), None
    except OSError:
        return False, 0, "stat_failed"


def _classify_image_generation_error(text: str, exists: bool, bytes_count: int) -> str | None:
    lowered = text.lower()
    if exists and bytes_count > 0:
        return None
    explicit = re.search(r"\bimagegen_fail\s+reason=([a-z0-9_:-]+)", lowered)
    if explicit:
        return explicit.group(1)
    if ("can't open file" in lowered or "no such file or directory" in lowered) and "image-generation/scripts/generate.py" in lowered:
        return "image_script_not_found"
    if re.search(r"\bpython(?:3)?\s*:\s*(?:command not found|not found)", lowered):
        return "python_not_found"
    if "modulenotfounderror" in lowered or "importerror" in lowered or "no module named" in lowered:
        return "import_error"
    if "permission denied" in lowered:
        return "permission_denied"
    if "openai_api_key" in lowered:
        return "missing_api_key"
    if "openai image generation failed" in lowered:
        return "api_error"
    if "reference image" in lowered and "invalid" in lowered:
        return "invalid_reference_image"
    if "no bytes landed" in lowered or "usable image bytes" in lowered:
        return "empty_output"
    if "error" in lowered or "failed" in lowered:
        return "api_error"
    return "missing_output"


def _extract_image_generation_raw_error(text: str) -> str | None:
    """Pull the raw provider error the image-gen script prints (`raw_error: …`).

    generate.py emits `IMAGEGEN_FAIL reason=… raw_error=…` plus a `raw_error: …`
    stderr line; the harness otherwise logs only the coarse error_class, which hid
    the real OpenAI message (quota vs rate vs verification) in prod. Surface it
    (truncated) so the next outage is diagnosable from Render logs alone, even
    while LangSmith run traces are unavailable.
    """
    if not text:
        return None
    match = re.search(r"raw_error:\s*(.+)", text)
    if not match:
        return None
    detail = match.group(1).strip()
    if len(detail) > 300:
        detail = detail[:300] + "…[truncated]"
    return detail or None


def _host_path_for_image_command_path(state: dict[str, Any], raw_path: str | None) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    normalized = raw_path.replace("\\", "/").strip()
    host = BuilderArtifactMiddleware._host_path_for_plan_file(state, normalized)
    if host is not None:
        return host
    if normalized.startswith("/"):
        return None
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return None
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    return outputs_root / Path(*pure.parts)


def _trace_pptx_image_single_item(
    *,
    segment: str,
    state: dict[str, Any],
    output_path: str | None,
    valid_image: bool,
    bytes_count: int,
    error_class: str | None,
    status_reason: str | None,
    raw_error: str | None,
) -> None:
    prompt_file = _command_flag_value(segment, "--prompt-file")
    prompt_host = _host_path_for_image_command_path(state, prompt_file)
    prompt_hash = None
    if prompt_host is not None and prompt_host.is_file():
        try:
            prompt_hash = hashlib.sha256(prompt_host.read_bytes()).hexdigest()[:16]
        except OSError:
            prompt_hash = None
    diagnostics = _pptx_diagnostics(state)
    real_batch_attempted = bool(diagnostics.get("image_generation_manifest_generation_attempted"))
    canonical_output = _canonical_outputs_artifact_path(output_path)
    allowed_outputs = _serial_repair_allowed_outputs(diagnostics)
    repair_attempts = _serial_repair_output_attempts(diagnostics)
    current_attempts = repair_attempts.get(canonical_output or "", 0)
    _safe_langsmith_span(
        "Sophia Image Single Item",
        inputs={
            "mode": "serial_repair" if real_batch_attempted else "single",
            "command_hash": hashlib.sha256(segment.encode("utf-8", errors="ignore")).hexdigest()[:16],
            "prompt_file": PurePosixPath(str(prompt_file or "")).name or None,
            "prompt_readable": bool(prompt_host is not None and prompt_host.is_file()),
            "prompt_hash": prompt_hash,
            "output_file": PurePosixPath(str(output_path or "")).name or None,
            "reference_count": len(_command_flag_values(segment, "--reference-images")),
            "allowed_manifest_output": bool(canonical_output and canonical_output in allowed_outputs),
            "repair_attempt_no": current_attempts + 1 if real_batch_attempted else None,
        },
        outputs={
            "success": valid_image,
            "bytes": bytes_count,
            "error_class": error_class,
            "status_reason": status_reason,
            "raw_error_excerpt": raw_error,
        },
        metadata={
            "sophia_component": "builder_image_single_item",
            "image_single_success": valid_image,
            "image_single_error_class": error_class,
        },
        tags=["pptx", "image_single"],
    )


def _image_generation_segment_status(
    *,
    segment: str,
    text: str,
    state: dict[str, Any],
) -> tuple[str | None, bool, int, str | None, str | None]:
    output_path = _command_flag_value(segment, "--output-file")
    exists, bytes_count, status_reason = _virtual_output_status(state, output_path)
    suffix = PurePosixPath(str(output_path or "")).suffix.lower()
    valid_image = exists and bytes_count > 0 and suffix in _PPTX_IMAGE_EXTENSIONS
    error_class = None if valid_image else _classify_image_generation_error(text, valid_image, bytes_count)
    raw_error = None if valid_image else _extract_image_generation_raw_error(text)
    logger.info(
        "[BuilderImageGeneration] model=gpt-image-2 success=%s output_ext=%s bytes=%d error_class=%s status_reason=%s raw_error=%s",
        valid_image,
        suffix.lstrip(".") or None,
        bytes_count,
        error_class,
        status_reason,
        raw_error,
    )
    _trace_pptx_image_single_item(
        segment=segment,
        state=state,
        output_path=output_path,
        valid_image=valid_image,
        bytes_count=bytes_count,
        error_class=error_class,
        status_reason=status_reason,
        raw_error=raw_error,
    )
    return output_path, valid_image, bytes_count, error_class, status_reason


def _image_generation_metadata_from_state(state: dict[str, Any]) -> tuple[str | None, str | None]:
    diagnostics = _pptx_diagnostics(state)
    attempts = int(diagnostics.get("image_generation_attempt_count", 0) or 0)
    startup_attempts = int(diagnostics.get("image_generation_startup_attempt_count", 0) or 0)
    manifest_authoring_failures = int(diagnostics.get("manifest_authoring_failure_count", 0) or 0)
    if attempts <= 0 and startup_attempts <= 0 and manifest_authoring_failures <= 0:
        return None, None
    successes = int(diagnostics.get("image_generation_success_count", 0) or 0)
    visual_counts = _pptx_visual_completeness_counts(state)
    if successes > 0 and visual_counts["missing_expected_visual_count"] > 0:
        return "partial", "visuals_partial"
    if successes > 0 and _pptx_diagnostic_count(state, "pptx_deck_missing_image_count") > 0:
        return "partial", "visuals_partial"
    if successes > 0:
        if int(diagnostics.get("serial_repair_count", 0) or 0) > 0 or diagnostics.get("primary_image_batch_status") == "repaired":
            return "success_after_repair", None
        return "success", None
    reason = diagnostics.get("image_generation_startup_error_class") or diagnostics.get("primary_image_batch_error_class") or diagnostics.get("image_generation_error_class")
    return "failed", str(reason) if reason else "api_error"


def _classify_pptx_generation_error(
    state: dict[str, Any],
    path: str | None,
    text: str,
    exists: bool,
) -> str | None:
    if exists:
        integrity_reason = _existing_pptx_generation_error(state, path)
        if integrity_reason != "__inspect_text__":
            return integrity_reason
    return _pptx_generation_error_from_text(text)


def _existing_pptx_generation_error(state: dict[str, Any], path: str | None) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if not canonical:
        return "__inspect_text__"
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if not relative or not outputs_root:
        return "__inspect_text__"
    return _pptx_integrity_error_for_file(outputs_root / relative)


def _pptx_picture_count_from_text(text: str) -> int:
    match = re.search(r"\bpicture_count=(\d+)\b", text)
    if match is None:
        return 0
    try:
        return int(match.group(1))
    except ValueError:
        return 0


def _pptx_slide_count_from_text(text: str) -> int:
    match = re.search(r"\bslide_count=(\d+)\b", text)
    if match is None:
        match = re.search(r"\bslides=(\d+)\b", text)
    if match is None:
        match = re.search(r"\bwith\s+(\d+)\s+slides\b", text, flags=re.IGNORECASE)
    if match is None:
        return 0
    try:
        return int(match.group(1))
    except ValueError:
        return 0


def _plan_image_ref_count(plan: dict[str, Any]) -> int:
    slides = plan.get("slides")
    if not isinstance(slides, list):
        return 0
    count = 0
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        for key in ("image_path", "image"):
            ref = slide.get(key)
            if isinstance(ref, str) and ref.strip():
                count += 1
    return count


def _slide_type(slide: dict[str, Any]) -> str:
    raw = _slide_layout_key(slide.get("type") or slide.get("layout") or "content")
    if raw == "title":
        return "cover"
    if raw in {"section_divider", "divider"}:
        return "section"
    if raw in {"statement", "closing", "quote", "closer"}:
        return "statement"
    if raw in {"conclusion", "takeaways"}:
        return "summary"
    if raw in {"stat_band", "metrics"}:
        return "stat"
    if raw in {"title_visual", "cover"}:
        return "cover"
    return raw


def _slide_layout_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _slide_treatment(slide: dict[str, Any]) -> str:
    return str(slide.get("subtype") or slide.get("treatment") or slide.get("layout") or slide.get("type") or "content").strip().lower().replace("_", "-") or "content"


def _slide_image_ref(slide: dict[str, Any]) -> str | None:
    for key in ("image_path", "image"):
        value = slide.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _slide_requires_generated_image(slide: dict[str, Any]) -> bool:
    return True


def _content_slides(slides: list[Any]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        slide_type = _slide_type(slide)
        if slide_type in {
            "cover",
            "title",
            "agenda",
            "section",
            "section_divider",
            "summary",
            "closing",
            "statement",
        }:
            continue
        content.append(slide)
    return content


def _pptx_slide_title_results_from_text(text: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    pattern = re.compile(
        r"^PPTXGEN slide_diagnostics:\s+slide=(\d+)\s+type=([^\s]+)\s+"
        r"image_forward=(true|false)\s+title_present=(true|false)\s+title_overlay=(true|false)$",
        re.IGNORECASE,
    )
    for raw_line in (text or "").splitlines():
        match = pattern.match(raw_line.strip())
        if match is None:
            continue
        results.append(
            {
                "slide": int(match.group(1)),
                "type": match.group(2),
                "image_forward": match.group(3).lower() == "true",
                "title_present": match.group(4).lower() == "true",
                "title_overlay": match.group(5).lower() == "true",
            }
        )
    return results


def _title_present_by_slide(diagnostics: dict[str, Any]) -> dict[int, bool]:
    results = diagnostics.get("pptx_slide_title_results")
    if not isinstance(results, list):
        return {}
    by_slide: dict[int, bool] = {}
    for result in results:
        if not isinstance(result, dict):
            continue
        slide_number = result.get("slide")
        if isinstance(slide_number, int):
            by_slide[slide_number] = result.get("title_present") is True
    return by_slide


def _add_qc_ref(by_ref: dict[str, dict[str, Any]], image_ref: object, result: dict[str, Any]) -> None:
    if not isinstance(image_ref, str) or not image_ref.strip():
        return
    normalized = image_ref.strip()
    by_ref[normalized] = result
    by_ref[PurePosixPath(normalized).name] = result


def _qc_record_result(record: dict[str, Any]) -> dict[str, Any] | None:
    result = record.get("qc_result")
    return result if isinstance(result, dict) else None


def _add_qc_record_refs(by_ref: dict[str, dict[str, Any]], record: dict[str, Any]) -> None:
    result = _qc_record_result(record)
    if result is None:
        return
    _add_qc_ref(by_ref, record.get("image_ref"), result)
    _add_qc_ref(by_ref, record.get("image_basename"), result)


def _qc_results_by_image_ref(diagnostics: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_ref: dict[str, dict[str, Any]] = {}
    for result in diagnostics.get("qc_results") or []:
        if isinstance(result, dict):
            _add_qc_ref(by_ref, result.get("image_path"), result)
    for record in diagnostics.get("qc_image_records") or []:
        if isinstance(record, dict):
            _add_qc_record_refs(by_ref, record)
    return by_ref


def _qc_results_by_image_hash(diagnostics: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_hash: dict[str, dict[str, Any]] = {}
    for collection_key in ("qc_image_records", "qc_results"):
        records = diagnostics.get(collection_key)
        if not isinstance(records, list):
            continue
        for result in records:
            if not isinstance(result, dict):
                continue
            image_hash = result.get("image_hash")
            qc_result = result.get("qc_result") if isinstance(result.get("qc_result"), dict) else result
            if not isinstance(image_hash, str) or not image_hash.strip() or not isinstance(qc_result, dict):
                continue
            by_hash[image_hash.strip()] = qc_result
    return by_hash


def _qc_result_for_image(
    qc_by_ref: dict[str, dict[str, Any]],
    qc_by_hash: dict[str, dict[str, Any]],
    image_ref: str,
    state: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    result = qc_by_ref.get(image_ref) or qc_by_ref.get(PurePosixPath(image_ref).name)
    if result is not None:
        return result
    image_hash = _output_file_sha256(state or {}, image_ref)
    if image_hash:
        return qc_by_hash.get(image_hash)
    return None


def _qc_result_presence_problem(index: int, result: dict[str, Any]) -> str | None:
    """Blocking QC for v3.3: deterministic title/caption presence only.

    LLM vision quality verdicts remain useful diagnostics, but they must not
    reopen a loop after the artifact has a valid package and the baked text
    bands are present.
    """

    if result.get("presence_skipped") is True or result.get("presence_unavailable") is True:
        return None
    if result.get("skipped") is True and "presence_pass" not in result:
        return f"Slide {index} image was not checked for deterministic title/caption presence."
    if result.get("presence_pass") is True:
        return None
    if result.get("presence_pass") is False:
        reasons = result.get("presence_reasons") or result.get("reasons") or []
        return f"Slide {index} failed title/caption presence QC: {reasons}"
    has_presence_fields = "title_present" in result or "caption_present" in result
    if has_presence_fields:
        if result.get("title_present") is not True:
            return f"Slide {index} failed title/caption presence QC: title missing"
        return None
    if result.get("pass") is True or _qc_result_is_advisory_parse_failure(result):
        return None
    return f"Slide {index} image was not checked for deterministic title/caption presence."


def _qc_title_present_by_slide(
    slides: list[Any],
    diagnostics: dict[str, Any],
    state: dict[str, Any] | None = None,
) -> dict[int, bool]:
    image_slides = _deck_image_slides(slides)
    if not image_slides:
        return {}
    by_slide: dict[int, bool] = {}
    qc_by_ref = _qc_results_by_image_ref(diagnostics)
    qc_by_hash = _qc_results_by_image_hash(diagnostics)
    if qc_by_ref or qc_by_hash:
        for index, image_ref in image_slides:
            result = _qc_result_for_image(qc_by_ref, qc_by_hash, image_ref, state)
            if isinstance(result, dict) and result.get("title_present") is True:
                by_slide[index] = True
        return by_slide
    qc_results = _qc_result_list(diagnostics)
    if len(qc_results) < len(image_slides):
        return by_slide
    for (index, _image_ref), result in zip(image_slides, qc_results[-len(image_slides) :], strict=False):
        if isinstance(result, dict) and result.get("title_present") is True:
            by_slide[index] = True
    return by_slide


def _qc_result_is_advisory_parse_failure(result: dict[str, Any]) -> bool:
    if result.get("parser_error") is True or result.get("advisory") is True:
        return True
    reasons = result.get("reasons") or []
    return any(any(marker in str(reason).lower() for marker in _QC_PARSE_FAILURE_MARKERS) for reason in reasons)


def _deck_image_slides(slides: list[Any]) -> list[tuple[int, str]]:
    return _deck_generated_image_slides(slides)


def _generated_ref_set(diagnostics: dict[str, Any] | None) -> set[str]:
    refs: set[str] = set()
    if not isinstance(diagnostics, dict):
        return refs
    for raw in diagnostics.get("image_output_paths") or []:
        if not isinstance(raw, str) or not raw.strip():
            continue
        value = raw.strip()
        refs.add(value)
        refs.add(PurePosixPath(value).name)
    return refs


def _slide_uses_generated_image_ref(
    slide: dict[str, Any],
    image_ref: str,
    generated_refs: set[str] | None = None,
) -> bool:
    if slide.get("image_path"):
        return True
    if _slide_type(slide) == "image_forward":
        return True
    if _slide_layout_key(slide.get("layout") or slide.get("treatment")) == "image_forward":
        return True
    if generated_refs and (image_ref in generated_refs or PurePosixPath(image_ref).name in generated_refs):
        return True
    return False


def _deck_generated_image_slides(
    slides: list[Any],
    diagnostics: dict[str, Any] | None = None,
) -> list[tuple[int, str]]:
    generated_refs = _generated_ref_set(diagnostics)
    return [(index, image_ref) for index, slide in enumerate(slides, 1) if isinstance(slide, dict) for image_ref in [_slide_image_ref(slide)] if image_ref and _slide_uses_generated_image_ref(slide, image_ref, generated_refs)]


def _qc_result_list(diagnostics: dict[str, Any]) -> list[Any]:
    results = diagnostics.get("qc_results")
    return results if isinstance(results, list) else []


def _validate_deck_plan(
    plan: dict[str, Any],
    diagnostics: dict[str, Any],
    state: dict[str, Any] | None = None,
) -> list[str]:
    slides_raw = plan.get("slides")
    slides = slides_raw if isinstance(slides_raw, list) else []
    return _deck_content_problems(slides)


def _deck_content_problems(slides: list[Any]) -> list[str]:
    return [f"Slide {index} is missing its generated slide image." for index, slide in enumerate(slides, 1) if isinstance(slide, dict) and _slide_requires_generated_image(slide) and not _slide_image_ref(slide)]


def _clone_deck_plan(plan: dict[str, Any]) -> dict[str, Any] | None:
    try:
        cloned = json.loads(json.dumps(plan))
    except (TypeError, ValueError):
        return None
    return cloned if isinstance(cloned, dict) else None


def _repair_slide_title_flag(slide: dict[str, Any], index: int, title_by_slide: dict[int, bool]) -> bool:
    title_qc_confirmed = title_by_slide.get(index) is True
    changed = False
    if title_qc_confirmed:
        if slide.get("title_present") is not True:
            slide["title_present"] = True
            changed = True
        if slide.get("title_baked_qc_confirmed") is not True:
            slide["title_baked_qc_confirmed"] = True
            changed = True
        return changed
    for key in ("title_baked_qc_confirmed", "baked_title_qc_confirmed", "title_in_image_qc_confirmed"):
        if slide.get(key):
            slide[key] = False
            changed = True
    return changed


def _repair_deck_plan_for_validation(
    plan: dict[str, Any],
    diagnostics: dict[str, Any],
) -> dict[str, Any] | None:
    repaired = _clone_deck_plan(plan)
    if repaired is None:
        return None
    slides_raw = repaired.get("slides")
    if not isinstance(slides_raw, list):
        return None
    changed = False
    title_by_slide = _title_present_by_slide(diagnostics)
    for index, slide in enumerate(slides_raw, 1):
        if not isinstance(slide, dict):
            continue
        changed = _repair_slide_title_flag(slide, index, title_by_slide) or changed
    return repaired if changed else None


def _deck_plan_validation_problems(state: dict[str, Any]) -> list[str]:
    if not _requested_pptx_artifact(state) or not _builder_image_enrichment_enabled(state):
        return []
    diagnostics = _pptx_diagnostics(state)
    generated_count = int(diagnostics.get("pptx_generator_slide_count", 0) or 0)
    picture_count = int(diagnostics.get("pptx_generator_picture_count", 0) or 0)
    if generated_count > 0 and picture_count <= 0:
        return ["PPTX package contains zero embedded slide pictures."]
    return []


def _pptx_plan_diagnostics_from_command(command: str, state: dict[str, Any]) -> dict[str, Any]:
    plan_path = _command_flag_value(command, "--plan-file")
    if not plan_path:
        return {}
    host_plan = BuilderArtifactMiddleware._host_path_for_plan_file(state, plan_path)
    if host_plan is None or not host_plan.is_file():
        return {"pptx_plan_path": plan_path}
    try:
        plan = json.loads(host_plan.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"pptx_plan_path": plan_path}
    if not isinstance(plan, dict):
        return {"pptx_plan_path": plan_path}
    slides = plan.get("slides")
    return {
        "pptx_plan_path": plan_path,
        "pptx_plan_json": plan,
        "pptx_plan_slide_count": len(slides) if isinstance(slides, list) else 0,
        "pptx_plan_image_ref_count": _plan_image_ref_count(plan),
    }


def _image_generation_success_path_delta(state: dict[str, Any], successful_paths: list[str]) -> dict[str, Any]:
    if not successful_paths:
        return {}
    delta: dict[str, Any] = {"image_output_paths": successful_paths}
    image_records = _image_output_records(state, successful_paths)
    if image_records:
        delta["image_output_records"] = image_records
    return delta


def _slide_qc_invocations_in_command(command: str) -> int:
    segments = _command_segments_for_marker(command, _SLIDE_QC_PATH_MARKERS)
    return len(segments) if segments else command.count("image-generation/scripts/slide_qc.py")


def _slide_qc_image_files_in_command(command: str) -> list[str]:
    segments = _command_segments_for_marker(command, _SLIDE_QC_PATH_MARKERS)
    if not segments:
        return _command_flag_values(command, "--image-file")
    image_files: list[str] = []
    for segment in segments:
        values = _command_flag_values(segment, "--image-file")
        if values:
            image_files.append(values[0])
    return image_files


def _slide_qc_boolean_flags(payload: dict[str, Any]) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for key in (
        "skipped",
        "advisory",
        "parser_error",
        "presence_skipped",
        "presence_unavailable",
    ):
        if payload.get(key) is True:
            result[key] = True
    for key in ("title_present", "caption_present", "presence_pass"):
        if isinstance(payload.get(key), bool):
            result[key] = payload[key]
    return result


def _slide_qc_json_result_from_line(line: str) -> dict[str, Any] | None:
    if not line.startswith("{"):
        return None
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "pass" not in payload:
        return None
    reasons = payload.get("reasons")
    result: dict[str, Any] = {
        "pass": payload.get("pass") is True,
        "reasons": [str(reason) for reason in reasons] if isinstance(reasons, list) else [],
    }
    result.update(_slide_qc_boolean_flags(payload))
    presence_reasons = payload.get("presence_reasons")
    if isinstance(presence_reasons, list):
        result["presence_reasons"] = [str(reason) for reason in presence_reasons if isinstance(reason, str)]
    return result


def _slide_qc_summary_result_from_line(line: str) -> dict[str, Any] | None:
    if not line.startswith("[qc]"):
        return None
    match = re.match(r"^\[qc\]\s+PASS=(true|false|True|False)\s+reasons=(.*)$", line)
    if match is None:
        return None
    try:
        reasons = json.loads(match.group(2))
    except json.JSONDecodeError:
        reasons = [match.group(2)] if match.group(2) else []
    return {
        "pass": match.group(1).lower() == "true",
        "reasons": [str(reason) for reason in reasons] if isinstance(reasons, list) else [],
    }


def _slide_qc_results_from_text(text: str) -> list[dict[str, Any]]:
    json_results: list[dict[str, Any]] = []
    summary_results: list[dict[str, Any]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        json_result = _slide_qc_json_result_from_line(line)
        if json_result is not None:
            json_results.append(json_result)
            continue
        summary_result = _slide_qc_summary_result_from_line(line)
        if summary_result is not None:
            summary_results.append(summary_result)
    return json_results or summary_results


def _attach_qc_image_paths(
    results: list[dict[str, Any]],
    image_files: list[str],
    state: dict[str, Any] | None,
) -> None:
    for index, result in enumerate(results):
        if index >= len(image_files):
            continue
        result["image_path"] = image_files[index]
        image_hash = _output_file_sha256(state or {}, image_files[index])
        if image_hash:
            result["image_hash"] = image_hash


def _first_skipped_qc_reason(results: list[dict[str, Any]]) -> str | None:
    return next(
        (str(reason) for result in results if isinstance(result, dict) and result.get("skipped") is True for reason in (result.get("reasons") or []) if isinstance(reason, str)),
        None,
    )


def _append_missing_qc_results(
    results: list[dict[str, Any]],
    image_files: list[str],
    invocations: int,
) -> None:
    if invocations <= len(results):
        return
    skipped_reason = _first_skipped_qc_reason(results)
    for index in range(len(results), invocations):
        reason = skipped_reason or "QC subprocess did not emit a parseable verdict"
        result = {
            "pass": False,
            "reasons": [reason],
        }
        if skipped_reason:
            result["skipped"] = True
        else:
            result["advisory"] = True
            result["parser_error"] = True
        if index < len(image_files):
            result["image_path"] = image_files[index]
        results.append(result)


def _qc_reasons(results: list[dict[str, Any]]) -> list[str]:
    return [reason for result in results for reason in (result.get("reasons") or []) if isinstance(reason, str)]


def _qc_image_records_from_results(
    results: list[dict[str, Any]],
    state: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    return [record for index, result in enumerate(results, 1) if isinstance(result.get("image_path"), str) for record in [_image_record_for_path(state or {}, result["image_path"], slide_index=index, qc_result=result)] if record is not None]


def _slide_qc_bash_delta(command: str, text: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    results = _slide_qc_results_from_text(text)
    image_files = _slide_qc_image_files_in_command(command)
    _attach_qc_image_paths(results, image_files, state)
    invocations = max(len(results), _slide_qc_invocations_in_command(command))
    _append_missing_qc_results(results, image_files, invocations)
    passed = sum(1 for result in results if result.get("pass") is True)
    failures = sum(1 for result in results if result.get("pass") is not True and result.get("skipped") is not True and not _qc_result_is_advisory_parse_failure(result))
    reasons = _qc_reasons(results)
    delta: dict[str, Any] = {
        "qc_invocation_count": invocations,
        "qc_pass_count": passed,
        "qc_failure_count": failures,
        "qc_results": results,
    }
    if reasons:
        delta["qc_reasons"] = reasons
    qc_image_records = _qc_image_records_from_results(results, state)
    if qc_image_records:
        delta["qc_image_records"] = qc_image_records
    return delta


def _pptx_generation_error_from_text(text: str) -> str:
    lowered = text.lower()
    if "slide image not found" in lowered:
        return "missing_slide_image"
    if "invalid presentation plan" in lowered or "json" in lowered:
        return "invalid_plan_json"
    if "error" in lowered or "failed" in lowered:
        return "pptx_generation_error"
    return "missing_output"


def _log_pptx_diagnostics(
    *,
    phase: str,
    state: dict[str, Any],
    artifact_path: object = None,
    integrity_reason: str | None = None,
) -> None:
    if not _requested_pptx_artifact(state):
        return
    diagnostics = state.get("builder_write_diagnostics") or {}
    write_arg_errors = _pptx_write_arg_error_count(diagnostics)
    pptx_diagnostics = _pptx_diagnostics(state)
    logger.info(
        "[BuilderPptxDiagnostics] phase=%s pptx_skill_read_seen=%s "
        "pptx_generator_invoked=%s image_generation_invoked=%s "
        "valid_pptx_seen=%s pptx_integrity_reason=%s fallback_ext=%s "
        "write_file_missing_arg_count=%d requested_artifact_ext=%s "
        "final_artifact_ext=%s artifact_is_fallback=%s fallback_reason=%s "
        "image_generation_attempt_count=%d image_generation_success_count=%d "
        "image_generation_bytes_total=%d image_generation_error_class=%s "
        "pptx_generator_attempt_count=%d pptx_generator_success_count=%d "
        "pptx_generator_bytes_total=%d pptx_generator_error_class=%s "
        "pptx_generator_picture_count=%d",
        phase,
        _pptx_skill_read_seen(state),
        _pptx_generator_invoked_seen(state),
        _image_generation_invoked_seen(state),
        BuilderArtifactMiddleware._has_valid_pptx_output(state),
        integrity_reason,
        _pptx_fallback_suffix(state).lstrip("."),
        write_arg_errors,
        _requested_artifact_ext(state),
        _artifact_path_suffix_label(artifact_path),
        _pptx_artifact_is_fallback_label(state, artifact_path),
        _pptx_fallback_reason_label(state, artifact_path),
        _pptx_diagnostic_count(state, "image_generation_attempt_count"),
        _pptx_diagnostic_count(state, "image_generation_success_count"),
        int(pptx_diagnostics.get("image_generation_bytes_total", 0) or 0),
        pptx_diagnostics.get("image_generation_error_class"),
        _pptx_diagnostic_count(state, "pptx_generator_attempt_count"),
        _pptx_diagnostic_count(state, "pptx_generator_success_count"),
        int(pptx_diagnostics.get("pptx_generator_bytes_total", 0) or 0),
        pptx_diagnostics.get("pptx_generator_error_class"),
        _pptx_diagnostic_count(state, "pptx_generator_picture_count"),
    )


def _pptx_write_arg_error_count(diagnostics: object) -> int:
    if not isinstance(diagnostics, dict):
        return 0
    if diagnostics.get("last_error_class") != "missing_required_tool_arg":
        return 0
    return int(diagnostics.get("error_count", 0) or 0)


def _pptx_artifact_is_fallback_label(state: dict[str, Any], artifact_path: object) -> bool:
    requested = _requested_artifact_ext(state)
    artifact = _artifact_path_suffix_label(artifact_path)
    return bool(requested and artifact and artifact != requested)


def _pptx_fallback_reason_label(state: dict[str, Any], artifact_path: object) -> str | None:
    if _requested_pptx_artifact(state) and _artifact_path_suffix_label(artifact_path) not in {None, "pptx"}:
        return "pptx_generation_not_completed"
    return None


_PPTX_DRIFT_TOOL_NAMES = {
    "write_file",
    "write_file_tool",
    "bash",
    "bash_tool",
    "str_replace",
    "str_replace_tool",
    "emit_builder_artifact",
}


def _recent_builder_tool_names(state: dict[str, Any], *, limit: int) -> list[str]:
    summaries = state.get("builder_tool_turn_summaries") or []
    return [name for summary in summaries[-limit:] if isinstance(summary, dict) for name in (summary.get("tool_names") or []) if isinstance(name, str)]


def _pptx_recent_tools_drifted(tool_names: list[str]) -> bool:
    return any(name in _PPTX_DRIFT_TOOL_NAMES for name in tool_names)


def _pptx_write_error_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_write_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("error_count", 0) or 0)


def _log_pptx_skill_correction(
    state: dict[str, Any],
    *,
    non_artifact_turns: int,
    recent_tool_names: list[str],
    generator_invoked_seen: bool,
    valid_pptx_seen: bool,
) -> None:
    logger.warning(
        "BuilderArtifact: presentation target needs ppt-generation correction "
        "turn=%d recent_tools=%s pptx_skill_read_seen=%s "
        "pptx_generator_invoked=%s image_generation_invoked=%s "
        "valid_pptx_seen=%s fallback_ext=%s write_file_missing_arg_count=%s",
        non_artifact_turns,
        ",".join(recent_tool_names[-6:]),
        _pptx_skill_read_seen(state),
        generator_invoked_seen,
        _image_generation_invoked_seen(state),
        valid_pptx_seen,
        _pptx_fallback_suffix(state).lstrip("."),
        _pptx_write_error_count(state),
    )


def _pptx_compile_latch_message(state: dict[str, Any]) -> str:
    """The single source of truth for PPTX deck steering."""
    if _deck_build_service_route_active(state):
        target = state.get("builder_artifact_target_path") or f"{_OUTPUTS_VIRTUAL_PREFIX}deck.pptx"
        return (
            "[Sophia/deck build latch]\n"
            "This is a fresh PPTX deck build. Stop authoring lower-level deck files or compiler "
            "commands. Use the injected deck-craft contract, then call `prepare_deck_build` "
            "with authoring_contract='compact_model_html_v2', one concise creative_plan, one shared "
            "deck_stylesheet, and the complete slide html_body list. Reuse shared classes, keep each "
            "html_body compact, keep slide_css exceptional, and emit no prose outside the tool call "
            f"and output_path='{target}'. DeckBuildService owns HTML sanitization, planned generated assets, "
            "native PowerPoint compilation, inspection, mechanical gates, and terminal failure. It will return either the "
            "deliverable path or a terminal failure. Keep every narrative <= 280 characters. If it "
            "returns retryable=true, repair the exact creative/html/mechanical issue and call prepare_deck_build one "
            "more time. If it succeeds, emit the returned PPTX; if it fails terminally, emit "
            "artifact_path=null with the returned failure code and summary."
        )
    target_count = _pptx_latch_target_slide_count(state)
    slide_html_count = _pptx_slide_html_count(state)
    target = state.get("builder_artifact_target_path") or f"{_OUTPUTS_VIRTUAL_PREFIX}deck.pptx"
    if target_count > 0 and slide_html_count >= target_count:
        opener = f"You have authored {slide_html_count}/{target_count} slide HTML files. Stop authoring or redesigning slides. "
    else:
        opener = "This is a PPTX slide-deck build. Reading SKILL.md is not completion, and you never compile the deck yourself. "
    return (
        "[Sophia/deck compile latch]\n" + opener + "This is an explicit non-production legacy/debug PPTX route because "
        "`prepare_deck_build` is unavailable and lower-level diagnostic tools are exposed. "
        "Author one self-contained 1920x1080 HTML file per slide under "
        "`/mnt/user-data/outputs/slides/` — real DOM title + concise narrative text, plus one "
        "generated VISUAL-ONLY image embedded by a relative `../assets/<file>` path. Text lives in "
        "the HTML and is never baked into the image. Write one prompt JSON file per slide, call "
        "`prepare_pptx_image_manifest(prompt_files=[...])`, then run the returned manifest path "
        "through ONE image-generation `--manifest` batch. If a readable batch attempts generation "
        "but leaves failed/missing visuals, repair only those visuals serially with the same "
        "prompt/output filenames. Do not compile a no-image deck unless the user explicitly "
        "asked for a plain text-only/no-visual presentation.\n\n"
        "When the slide HTML files exist, compile the deck by calling the tool ONCE:\n"
        f"`build_deck_from_slides(output_path='{target}', title='<deck title>')`\n"
        "It renders each slide to a full-bleed PNG and wraps them into the .pptx. Then emit that .pptx.\n\n"
        "Do NOT run `ppt-generation/scripts/generate.py --plan-file`, write custom "
        "python-pptx/pptxgenjs, or emit PDF, Markdown, HTML, prompt JSON, or preview files as a "
        "substitute for the .pptx."
    )


def _pdf_render_correction_message(source_path: str, pdf_path: str) -> str:
    return (
        "[Sophia/PDF render correction]\n"
        "A requested PDF has an HTML source document on disk, but the PDF renderer "
        "has not been attempted and the completion window is active. Your next action must be "
        "a final render with report_manifest listing every section and requested visual:\n"
        f"`render_html_to_pdf(html_path='{source_path}', pdf_path='{pdf_path}', report_manifest={{...}})`.\n"
        "If rendering succeeds, immediately emit that `.pdf`. If rendering "
        "genuinely cannot complete, emit artifact_path=null with an honest summary."
    )


def _pdf_source_write_message(target_path: str) -> str:
    source_path = f"{_OUTPUTS_VIRTUAL_PREFIX}{PurePosixPath(target_path).with_suffix('.html').name}"
    return (
        "[Sophia/PDF source correction]\n"
        "This is a requested PDF build, but no HTML source is available "
        "for the renderer yet. Stop writing helper scripts. Use one complete "
        "`write_file` call to create the self-contained HTML source now (with the "
        "base print CSS and inline `<svg>` figures):\n"
        "`write_file(description='write PDF source', "
        f"path='{source_path}', content='...', append=False)`.\n"
        "After that, call `render_html_to_pdf` to create the PDF."
    )


def _visual_design_skill_message() -> str:
    return (
        "[Sophia/visual-design correction]\n"
        "The user requested charts, diagrams, or visual explanations. Before "
        "creating visual assets or emitting the final artifact, read the visual "
        "design skill now. For HTML/PDF visual reports, also read Hallmark if it "
        "is available:\n"
        "`read_file(description='read visual design skill', "
        "path='/mnt/skills/public/visual-design/SKILL.md')`.\n"
        "For PPTX decks, read the deck craft guidance and call `prepare_deck_build` with "
        "creative_plan, deck_stylesheet, and slide html_body; do not write slide files or call `build_deck_from_slides`. "
        "DeckBuildService owns sanitization, planned assets, native PowerPoint "
        "compilation, inspection, and mechanical gates. If native deck generation fails, emit artifact_path=null with "
        "the returned failure code and summary. For PDF reports, draw both charts AND structural diagrams "
        "as inline static `<svg>` directly in the report HTML (bar / line / column for "
        "data; box-and-arrow flow / comparison / mind-map for structure) — NO remote "
        "`generate_chart`, NO client-side JS — then render via render_html_to_pdf."
    )


def _force_reason(turn_force: bool, clock_force: bool) -> str:
    if turn_force and clock_force:
        return "turns+wall_clock"
    if clock_force:
        return "wall_clock"
    return "turns"


def _wrote_before_research(
    *,
    previous: dict[str, Any],
    search_count: int,
    fetch_count: int,
    write_names: list[str],
    tool_names: list[str],
) -> bool:
    if previous.get("wrote_before_research", False):
        return True
    if not write_names or search_count + fetch_count > 0:
        return False
    return _first_research_tool_index(tool_names) > _first_write_tool_index(tool_names)


class BuilderArtifactState(AgentState):
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[Annotated[int, _merge_builder_non_artifact_turns]]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    builder_skill_reads: NotRequired[dict[str, bool]]
    # Phase 5c latch: the per-target skill-read gate forces the skill read at
    # most ONCE per build (the earlier-churn lesson), then never re-forces.
    builder_target_skill_read_forced: NotRequired[bool]
    builder_research_diagnostics: NotRequired[dict]
    builder_update_epoch: NotRequired[int]
    builder_update_required_urls: NotRequired[list[str]]
    builder_artifact_target_path: NotRequired[str]
    builder_last_successful_output_path: NotRequired[str | None]
    builder_write_diagnostics: NotRequired[Annotated[dict, _merge_builder_write_diagnostics]]
    builder_pptx_diagnostics: NotRequired[Annotated[dict, _merge_builder_pptx_diagnostics]]
    builder_visual_diagnostics: NotRequired[Annotated[dict, _merge_builder_visual_diagnostics]]
    # PR #94: count consecutive emit attempts rejected for empty/missing
    # ``artifact_path``. When this reaches ``_REJECTION_SHORT_CIRCUIT_AT``
    # we route directly to the hard-ceiling fallback instead of letting
    # the model retry into the LangGraph recursion limit.
    builder_consecutive_empty_emit_rejections: NotRequired[int]
    builder_last_missing_emit_path: NotRequired[str | None]
    builder_consecutive_missing_emit_path_rejections: NotRequired[int]
    # Phase 2F.3: idempotency flag. Set once we've injected a path-
    # correction HumanMessage after N consecutive write_file_tool errors,
    # so we don't repeat the correction on every subsequent before_model.
    builder_path_correction_emitted: NotRequired[bool]
    builder_tool_argument_correction_emitted: NotRequired[bool]
    # F1 (2026-06-11): one-shot chunking correction when missing tool args
    # were caused by max_tokens truncation of an oversized single-call write.
    builder_truncation_correction_emitted: NotRequired[bool]
    # VQ-4: legacy hero/cover gate for PDFs and non-normal deck edge cases when
    # enrichment was enabled but zero generated images succeeded without an
    # honest skip.
    builder_hero_gate_rejections: NotRequired[int]
    # FIX 2 (2026-06-30), extended 2026-07-01: two bounded slide-quality
    # re-authors per deck build, then warning/failure depending on severity.
    builder_slide_quality_rejections: NotRequired[int]
    builder_pptx_terminal_quality_failed: NotRequired[bool]
    # VQ-10: shared repair-iteration counter across ALL quality gates
    # (visual embed, hero/cover, advisory). Capped by
    # SOPHIA_BUILDER_MAX_ITERATIONS (default 3; 1 = legacy one-shot).
    build_iterations: NotRequired[int]
    # VQ-10: the advisory holistic pass may consume at most ONE iteration.
    builder_advisory_consumed: NotRequired[bool]
    builder_recovered_deliverable_emitted: NotRequired[bool]
    builder_pdf_render_result: NotRequired[dict | None]
    builder_pdf_requested_page_count: NotRequired[int]
    builder_pdf_requested_min_pages: NotRequired[int]
    builder_pdf_requested_max_pages: NotRequired[int]
    builder_pdf_required_body_section_count: NotRequired[int]
    builder_pdf_required_visual_count: NotRequired[int]
    builder_pdf_required_min_word_count: NotRequired[int]
    builder_pdf_cover_required: NotRequired[bool]
    builder_pdf_toc_required: NotRequired[bool]
    builder_pdf_conclusion_required: NotRequired[bool]
    builder_pdf_references_required: NotRequired[bool]
    builder_pdf_report_contract_version: NotRequired[str]
    builder_pdf_phase: NotRequired[str]
    builder_pdf_contract_repair_attempts: NotRequired[int]
    builder_pdf_contract_repair_pending: NotRequired[bool]
    builder_pdf_layout_repair_attempts: NotRequired[int]
    builder_pdf_layout_repair_requested: NotRequired[bool]
    builder_pdf_layout_repair_pending: NotRequired[bool]
    builder_pdf_render_correction_emitted: NotRequired[bool]
    builder_pdf_source_write_directive_emitted: NotRequired[bool]
    builder_pptx_skill_correction_emitted: NotRequired[bool]
    builder_pptx_plan_correction_emitted: NotRequired[bool]
    builder_pptx_fallback_directive_emitted: NotRequired[bool]
    builder_pptx_slide_count_repair_attempted: NotRequired[bool]
    builder_pptx_slide_count_repair_directive_emitted: NotRequired[bool]
    builder_pptx_slide_count_repair_pending: NotRequired[bool]
    builder_pptx_slide_count_repair_requested: NotRequired[dict[str, int]]
    builder_pptx_compile_latch_pending: NotRequired[bool]
    builder_pptx_compile_repair_pending: NotRequired[bool]
    builder_deck_ir_repair_attempt_count: NotRequired[int]
    builder_last_deck_ir_failure: NotRequired[dict | None]
    builder_deck_creative_repair_attempt_count: NotRequired[int]
    builder_last_deck_creative_failure: NotRequired[dict | None]
    builder_deck_prepare_repair_attempt_count: NotRequired[int]
    builder_deck_prepare_repair_started_at_ms: NotRequired[int]
    builder_deck_prepare_phase: NotRequired[str]
    builder_deck_prepare_repair_message: NotRequired[str | None]
    builder_deck_prepare_repair_prompt_injected: NotRequired[bool]
    builder_deck_prepare_expected_tool_call_id: NotRequired[str | None]
    builder_deck_prepare_latch_active: NotRequired[bool]
    builder_presentation_phase: NotRequired[str]
    builder_presentation_preflight_started_at_ms: NotRequired[int]
    builder_presentation_authoring_started_at_ms: NotRequired[int]
    builder_task_kickoff_ms: NotRequired[int]
    builder_timeout_seconds: NotRequired[int]
    builder_deadline_epoch_ms: NotRequired[int]
    builder_run_id: NotRequired[str]
    builder_pptx_route_trace_emitted: NotRequired[bool]
    builder_visual_design_correction_emitted: NotRequired[bool]
    builder_visual_asset_correction_emitted: NotRequired[bool]
    builder_graph_halted: NotRequired[bool]
    builder_terminal_halt_reason: NotRequired[str]
    builder_lifecycle_markers: NotRequired[dict[str, Any]]
    # Visual hard gate: count emit attempts rejected because requested visuals
    # were not embedded in the artifact. Normal PPTX decks now fail/repair via
    # generated-visual completeness before compile; other visual artifacts keep
    # this bounded warning path.
    builder_visual_embed_rejections: NotRequired[int]
    # Idempotency flag for the one-shot image-generation stop directive
    # (injected after repeated failed image-gen attempts so enrichment-by-
    # default cannot burn the turn budget on a broken environment).
    builder_image_generation_stop_emitted: NotRequired[bool]
    builder_visual_force_count: NotRequired[int]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @staticmethod
    def _tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
        names: list[str] = []
        for call in tool_calls:
            name = call.get("name")
            if isinstance(name, str) and name:
                names.append(name)
        return names

    @staticmethod
    def _append_turn_summary(state: BuilderArtifactState, summary: dict[str, Any]) -> list[dict]:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        reads = _latch_builder_skill_reads(state, summary)
        visual_force_count = _builder_visual_force_count(state)
        enriched_summary = {
            **summary,
            "builder_skill_reads": dict(reads),
            "builder_visual_force_count": visual_force_count,
        }
        history.append(enriched_summary)
        return history[-12:]

    @classmethod
    def _emit_rejection_diagnostics(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any]:
        reason, is_supporting_file = cls._emit_validation_rejection_reason(
            artifact_args,
            state,
            runtime,
        )
        failure_code = normalize_emit_failure_code(
            reason,
            is_supporting_file=is_supporting_file,
        )
        return build_builder_failure_diagnostics(
            state=state,
            runtime=runtime,
            artifact_args=artifact_args,
            failure_stage="emit_rejected",
            failure_reason=diagnostic_safe_failure_message(failure_code, reason),
            failure_code=failure_code,
            emit_attempted=True,
            emit_tool_call_seen=True,
        )

    @classmethod
    def _emit_validation_rejection_reason(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> tuple[str | None, bool]:
        primary = artifact_args.get("artifact_path")
        format_rejection = cls._format_specific_rejection(primary, state, runtime)
        if format_rejection is not None:
            return format_rejection, False
        return cls._candidate_rejection(artifact_args, primary, state, runtime)

    @classmethod
    def _format_specific_rejection(
        cls,
        primary: Any,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if _requested_pdf_artifact(state):
            rejection_reason = _pdf_artifact_path_rejection_reason(primary, state)
            if rejection_reason is not None:
                return cls._path_sensitive_rejection_reason(primary, rejection_reason)
        if _requested_pptx_artifact(state):
            rejection = cls._pptx_format_rejection(primary, state, runtime)
            if rejection is not None:
                return rejection
        if _requested_html_artifact(state):
            rejection = cls._html_format_rejection(primary, state, runtime)
            if rejection is not None:
                return rejection
        return None

    @classmethod
    def _pptx_format_rejection(
        cls,
        primary: Any,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        rejection_reason = _pptx_artifact_path_rejection_reason(primary, state)
        if rejection_reason is not None:
            return cls._path_sensitive_rejection_reason(primary, rejection_reason)
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return None
        integrity_rejection = _pptx_path_integrity_rejection_reason(canonical_primary, state, runtime)
        if integrity_rejection is not None:
            return integrity_rejection
        return _pptx_html_fallback_integrity_rejection_reason(canonical_primary, state, runtime)

    @classmethod
    def _html_format_rejection(
        cls,
        primary: Any,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        rejection_reason = _html_artifact_path_rejection_reason(primary)
        if rejection_reason is not None:
            return cls._path_sensitive_rejection_reason(primary, rejection_reason)
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return None
        return _html_artifact_integrity_rejection_reason(canonical_primary, state, runtime)

    @classmethod
    def _candidate_rejection(
        cls,
        artifact_args: dict[str, Any],
        primary: Any,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> tuple[str | None, bool]:
        candidates = _emit_candidate_paths(artifact_args)
        if not candidates:
            return "artifact_file_missing", False
        thread_data = state.get("thread_data") or {}
        outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        remote_thread_ids = _artifact_remote_thread_ids(state, runtime)
        primary_text = primary.strip() if isinstance(primary, str) else None
        for index, candidate in enumerate(candidates):
            is_supporting = not primary_text or index > 0 or candidate.strip() != primary_text
            reason = cls._emit_candidate_rejection_reason(
                candidate,
                outputs_host_path=outputs_host_path,
                remote_thread_ids=remote_thread_ids,
            )
            if reason is not None:
                return reason, is_supporting
        return "unknown_emit_validation_error", False

    @staticmethod
    def _path_sensitive_rejection_reason(path: Any, reason: str) -> str:
        if _path_has_traversal(path):
            return "artifact_path_traversal"
        return reason

    @staticmethod
    def _emit_candidate_rejection_reason(
        candidate: str,
        *,
        outputs_host_path: str | None,
        remote_thread_ids: list[str],
    ) -> str | None:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            if _invalid_outputs_candidate(candidate):
                return "artifact_path_traversal" if _path_has_traversal(candidate) else "artifact_path_outside_outputs"
            return None
        local_status = _local_emit_candidate_status(candidate, relative, outputs_host_path)
        if local_status == "valid":
            return None
        if local_status == "invalid":
            return "pptx_integrity_failed" if PurePosixPath(candidate).suffix.lower() == ".pptx" else None
        remote_status = _remote_emit_candidate_status(candidate, relative, remote_thread_ids)
        if remote_status == "valid":
            return None
        if remote_status == "invalid":
            return "pptx_integrity_failed" if PurePosixPath(candidate).suffix.lower() == ".pptx" else None
        return "artifact_file_missing"

    @staticmethod
    def _terminal_failure_diagnostics(
        state: BuilderArtifactState,
        runtime: Runtime,
        *,
        fallback: dict[str, Any],
        failure_stage: str,
        failure_code: str,
        failure_reason: str,
        provider_error_reason: str | None = None,
        retryable: bool | None = None,
        emit_attempted: bool,
        emit_tool_call_seen: bool | None,
    ) -> dict[str, Any]:
        current = state.get("builder_failure_diagnostics")
        if isinstance(current, dict) and current:
            return merge_builder_failure_diagnostics(
                current,
                failure_stage=failure_stage,
                failure_code=failure_code,
                failure_reason=failure_reason,
                provider_error_reason=provider_error_reason,
                retryable=retryable,
                emit_attempted=emit_attempted,
                emit_tool_call_seen=emit_tool_call_seen,
                completion_webhook_attempted=True,
                completion_webhook_result="scheduled",
            )
        return build_builder_failure_diagnostics(
            state=state,
            runtime=runtime,
            artifact_args=fallback,
            failure_stage=failure_stage,  # type: ignore[arg-type]
            failure_reason=failure_reason,
            failure_code=failure_code,
            provider_error_reason=provider_error_reason,
            retryable=retryable,
            emit_attempted=emit_attempted,
            emit_tool_call_seen=emit_tool_call_seen,
            completion_webhook_attempted=True,
            completion_webhook_result="scheduled",
        )

    @staticmethod
    def _attach_terminal_failure_diagnostics(
        state: BuilderArtifactState,
        runtime: Runtime,
        fallback: dict[str, Any],
        *,
        failure_stage: str,
        failure_code: str,
        failure_reason: str,
        provider_error_reason: str | None = None,
        retryable: bool | None = None,
        emit_attempted: bool,
        emit_tool_call_seen: bool | None,
    ) -> dict[str, Any]:
        fallback["builder_failure_diagnostics"] = BuilderArtifactMiddleware._terminal_failure_diagnostics(
            state,
            runtime,
            fallback=fallback,
            failure_stage=failure_stage,
            failure_code=failure_code,
            failure_reason=failure_reason,
            provider_error_reason=provider_error_reason,
            retryable=retryable,
            emit_attempted=emit_attempted,
            emit_tool_call_seen=emit_tool_call_seen,
        )
        return fallback

    @staticmethod
    def _model_provider_failure_from_message(msg: Any) -> dict[str, Any] | None:
        additional_kwargs = getattr(msg, "additional_kwargs", None)
        if not isinstance(additional_kwargs, dict):
            return None
        if additional_kwargs.get("deerflow_error_fallback") is not True:
            return None
        reason = str(additional_kwargs.get("error_reason") or "generic").strip().lower()
        if reason not in {"auth", "busy", "generic", "malformed_request", "quota", "transient"}:
            reason = "generic"
        if reason == "malformed_request":
            return {
                "failure_stage": "model_provider",
                "failure_code": "primary_provider_malformed_request",
                "failure_reason": ("Internal model request payload was malformed before the builder produced an artifact."),
                "provider_error_reason": reason,
                "retryable": False,
            }
        retryable = reason in {"busy", "transient"}
        return {
            "failure_stage": "model_provider",
            "failure_code": ("primary_provider_unavailable" if retryable else f"primary_provider_{reason}"),
            "failure_reason": ("Primary model provider was temporarily unavailable before the builder produced an artifact." if retryable else "Primary model provider failed before the builder produced an artifact."),
            "provider_error_reason": reason,
            "retryable": retryable,
        }

    @staticmethod
    def _annotate_supabase_mirror_diagnostics(
        state: BuilderArtifactState,
        runtime: Runtime,
        artifact_args: dict[str, Any],
        *,
        mirror_result: str,
    ) -> None:
        if mirror_result == "uploaded":
            return
        required_failure = _is_required_supabase_failure(mirror_result)
        diagnostic = build_builder_failure_diagnostics(
            state=state,
            runtime=runtime,
            artifact_args=artifact_args,
            failure_stage="storage_mirror",
            failure_reason=(_durable_upload_error_message() if required_failure else "Supabase mirror did not create a remote copy, but the local artifact path remains available."),
            failure_code="durable_storage_unavailable" if required_failure else None,
            emit_attempted=True,
            emit_tool_call_seen=True,
            include_outputs_summary=False,
            supabase_mirror_attempted=mirror_result != "skipped",
            supabase_mirror_result=mirror_result,
        )
        artifact_args["builder_failure_diagnostics"] = merge_builder_failure_diagnostics(
            artifact_args.get("builder_failure_diagnostics") if isinstance(artifact_args.get("builder_failure_diagnostics"), dict) else None,
            **diagnostic,
        )

    @staticmethod
    def _allow_web_research(state: BuilderArtifactState) -> bool:
        if "allow_web_research" in state:
            return state.get("allow_web_research") is True
        delegation = state.get("delegation_context")
        return isinstance(delegation, dict) and delegation.get("allow_web_research") is True

    @staticmethod
    def _is_edit_existing_artifact_state(state: BuilderArtifactState) -> bool:
        delegation = state.get("delegation_context")
        edit_context = delegation.get("edit_context") if isinstance(delegation, dict) else None
        return isinstance(edit_context, dict) and edit_context.get("mode") == "edit_existing_artifact"

    @staticmethod
    def _has_required_edit_research_input(state: BuilderArtifactState) -> bool:
        explicit_urls = state.get("explicit_user_urls") or []
        required_urls = state.get("builder_update_required_urls") or []
        return any(str(url).strip() for url in (*explicit_urls, *required_urls))

    @staticmethod
    def _edit_state_requires_research(state: BuilderArtifactState) -> bool:
        if not BuilderArtifactMiddleware._is_edit_existing_artifact_state(state):
            return True
        return BuilderArtifactMiddleware._has_required_edit_research_input(state)

    @staticmethod
    def _research_attempted(state: BuilderArtifactState) -> bool:
        return _builder_web_attempt_count(state) > 0 or _has_builder_search_source(state)

    @staticmethod
    def _planning_completed(state: BuilderArtifactState) -> bool:
        summaries = state.get("builder_tool_turn_summaries") or []
        if any("write_todos" in (summary.get("tool_names") or []) for summary in summaries if isinstance(summary, dict)):
            return True
        return int(state.get("builder_non_artifact_turns", 0) or 0) > 0

    @classmethod
    def _should_force_research_tool(cls, state: BuilderArtifactState) -> bool:
        return cls._allow_web_research(state) and cls._edit_state_requires_research(state) and cls._planning_completed(state) and not cls._research_attempted(state)

    @classmethod
    def _should_force_fetch_tool(cls, state: BuilderArtifactState) -> bool:
        return cls._allow_web_research(state) and cls._edit_state_requires_research(state) and cls._planning_completed(state) and _needs_fetch_before_write(state)

    @classmethod
    def _research_gate_active(cls, state: BuilderArtifactState) -> bool:
        if not cls._allow_web_research(state):
            return False
        if not cls._edit_state_requires_research(state):
            return False
        return not (cls._research_attempted(state) and not cls._should_force_fetch_tool(state))

    @staticmethod
    def _bash_is_substantive_before_research(tool_call: dict[str, Any]) -> bool:
        args = tool_call.get("args") or {}
        command = args.get("command") if isinstance(args, dict) else None
        return not _is_safe_pre_research_bash(command)

    @classmethod
    def _is_substantive_before_research_tool(cls, state: BuilderArtifactState, tool_call: dict[str, Any]) -> bool:
        if _deck_build_service_route_active(state) and state.get("builder_presentation_phase") in {
            "authoring_pending",
            "prepare_call_emitted",
            "terminal",
        }:
            return False
        if not cls._research_gate_active(state):
            return False
        name = tool_call.get("name")
        if name in _BUILDER_SUBSTANTIVE_TOOL_NAMES:
            return True
        if name == _SIMPLE_PDF_TOOL_NAME:
            return not _requested_simple_pdf_artifact(state)
        if name in {"bash", "bash_tool"}:
            return cls._bash_is_substantive_before_research(tool_call)
        return False

    @staticmethod
    def _update_research_diagnostics(
        state: BuilderArtifactState,
        tool_names: list[str],
    ) -> dict[str, Any]:
        previous = dict(state.get("builder_research_diagnostics") or {})
        search_count, fetch_count, write_file_count = _diagnostic_counts(previous)
        first_content_tool = previous.get("first_content_tool")
        write_names = _write_tool_names(tool_names)
        wrote_before_research = _wrote_before_research(
            previous=previous,
            search_count=search_count,
            fetch_count=fetch_count,
            write_names=write_names,
            tool_names=tool_names,
        )
        search_count += tool_names.count("builder_web_search")
        fetch_count += tool_names.count("builder_web_fetch")
        write_file_count += len(write_names)
        first_content_tool = first_content_tool or (write_names[0] if write_names else None)

        return {
            "builder_web_search_count": search_count,
            "builder_web_fetch_count": fetch_count,
            "write_file_count": write_file_count,
            "first_content_tool": first_content_tool,
            "wrote_before_research": wrote_before_research,
        }

    @staticmethod
    def _log_research_diagnostics(
        *,
        phase: str,
        diagnostics: dict[str, Any],
        allow_web_research: bool,
        sources_used: Any = None,
    ) -> None:
        sources_empty = isinstance(sources_used, list) and len(sources_used) == 0
        search_count, fetch_count, write_file_count = _diagnostic_counts(diagnostics)
        logger.info(
            "[BuilderResearchDiagnostics] phase=%s allow_web_research=%s builder_web_search_count=%d builder_web_fetch_count=%d write_file_count=%d first_content_tool=%s wrote_before_research=%s sources_used_empty=%s",
            phase,
            allow_web_research,
            search_count,
            fetch_count,
            write_file_count,
            diagnostics.get("first_content_tool"),
            bool(diagnostics.get("wrote_before_research", False)),
            sources_empty,
        )
        if _should_warn_missing_web_tools(
            phase=phase,
            allow_web_research=allow_web_research,
            search_count=search_count,
            fetch_count=fetch_count,
            write_file_count=write_file_count,
        ):
            logger.warning(
                "[BuilderResearchDiagnostics] reason=research_enabled_no_web_tools first_content_tool=%s write_file_count=%d",
                diagnostics.get("first_content_tool"),
                write_file_count,
            )
        if allow_web_research and sources_empty:
            logger.warning("[BuilderResearchDiagnostics] reason=research_enabled_empty_sources_used")

    # Legacy defaults retained for compatibility with older tests/importers.
    # Runtime decisions now read per-run caps from ``builder_budget`` through
    # the helper functions imported above, so complex PDF/PPTX work can get a
    # larger budget without globally relaxing simple HTML/Markdown builds.
    _FORCE_EMIT_REMAINING = 3
    _CEILING_FOR_FORCE = 30
    _SOFT_WARN_AT = 18
    # Legacy wall-clock fraction; active value comes from ``builder_budget``.
    _FORCE_EMIT_WALL_CLOCK_FRACTION = 0.70
    # PR #94: when the model emits ``artifact_path=None`` (or any empty
    # path) under forced ``tool_choice=emit_builder_artifact``, we reject
    # and let it retry. After this many consecutive empty rejections we
    # short-circuit straight to the hard-ceiling fallback — synthesizing
    # ``builder_result`` from disk state — rather than letting the rejection
    # loop burn the remaining LangGraph recursion budget. Threshold of 2
    # leaves room for one transient empty-emit (e.g. a typo on the model's
    # first attempt) while still bounding the loop to ~12 super-steps
    # instead of the ~21 the ceiling-only path costs.
    _REJECTION_SHORT_CIRCUIT_AT = 2

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = max_non_artifact_turns(state) - non_artifact_turns
        return remaining <= force_emit_remaining_turns(state) and non_artifact_turns > 0

    @staticmethod
    def _should_force_emit_by_clock(state: BuilderArtifactState, runtime: Runtime | None = None) -> bool:
        """Return True when the wall-clock budget has crossed the force-emit fraction.

        Reads ``builder_timeout_seconds`` and ``builder_task_kickoff_ms`` from
        ``state`` (populated via ``SubagentExecutor``'s ``extra_configurable``
        plumbing in ``switch_to_builder``). Uses ``builder_task_started_at_ms``
        from state when present, falling back to ``builder_task_kickoff_ms``
        (set at queue time) so the very first turn — before ``after_model``
        has had a chance to record ``builder_task_started_at_ms`` — still
        gets the right answer.

        ``runtime`` is accepted for parity with other middleware methods and
        kept as a fallback signal source, but the canonical path is state-only:
        ``executor.py`` already merges ``extra_configurable`` into initial
        state, matching how ``delegation_context`` flows.

        Returns False (today's behavior, turn-count-only) when neither timestamp
        is set or when ``builder_timeout_seconds`` is missing/non-positive. This
        keeps the gate backward-compatible for any caller that doesn't opt in.
        """
        raw_timeout = state.get("builder_timeout_seconds")
        timeout_s = 0
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            timeout_s = int(raw_timeout)
        if timeout_s <= 0:
            return False

        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            return False

        elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
        return elapsed_ms / (timeout_s * 1000) >= force_emit_wall_clock_fraction(state)

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @staticmethod
    def _forced_write_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces write_file.

        PR-A: used in the two-stage forced-emit path when the model is in the
        forced-emit window but hasn't written any deliverable yet. Forcing
        emit at that point traps the model — it can only call emit, the
        emit gets rejected (no file exists), and the loop spins. By forcing
        write_file for one turn first, we guarantee the model has at least
        one chance to land a file before tool_choice locks to emit.
        """
        return {"type": "tool", "name": "write_file"}

    @staticmethod
    def _forced_read_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces read_file."""
        return {"type": "tool", "name": "read_file"}

    @staticmethod
    def _forced_search_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_search."""
        return {"type": "tool", "name": "builder_web_search"}

    @staticmethod
    def _forced_fetch_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_fetch."""
        return {"type": "tool", "name": "builder_web_fetch"}

    @staticmethod
    def _forced_pdf_render_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces the PDF renderer.

        Reports render via HTML→PDF (render_html_to_pdf) — that is the tool in
        the report toolset, so the force must name it (forcing the retired
        render_markdown_to_pdf would reference a tool not offered to the build).
        """
        return {"type": "tool", "name": _REPORT_PDF_RENDER_TOOL_NAME}

    @staticmethod
    def _forced_deck_build_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces the deck compiler tool."""
        return {"type": "tool", "name": _DECK_BUILD_TOOL_NAME}

    @staticmethod
    def _forced_prepare_deck_build_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload for the authoritative fresh-deck service."""
        return {"type": "tool", "name": _PREPARE_DECK_BUILD_TOOL_NAME}

    @staticmethod
    def _presentation_research_enabled(state: BuilderArtifactState) -> bool:
        return state.get("allow_web_research") is True

    @staticmethod
    def _presentation_preflight_tool_name(state: BuilderArtifactState) -> str:
        explicit_urls = [url for url in (state.get("explicit_user_urls") or []) if str(url).strip()]
        return "builder_web_fetch" if explicit_urls else "builder_web_search"

    @staticmethod
    def _presentation_preflight_result_message(state: BuilderArtifactState) -> ToolMessage | None:
        for message in reversed(state.get("messages", []) or []):
            if not isinstance(message, ToolMessage):
                continue
            if str(getattr(message, "name", "") or "") in _PRESENTATION_PREFLIGHT_TOOLS:
                return message
        return None

    @classmethod
    def _presentation_phase_before_model_update(
        cls,
        state: BuilderArtifactState,
    ) -> dict[str, Any] | None:
        """Advance the fresh-deck lane without consuming general-agent turns."""

        if not _deck_build_service_route_active(state):
            return None
        phase = str(state.get("builder_presentation_phase") or "").strip()
        if phase in {"terminal", "authoring_pending", "prepare_call_emitted"}:
            return None
        now_ms = int(time.time() * 1_000)
        if not phase:
            if cls._presentation_research_enabled(state):
                return {
                    "builder_presentation_phase": "preflight_pending",
                    "builder_presentation_preflight_started_at_ms": now_ms,
                    "builder_pptx_diagnostics": {
                        "presentation_preflight_status": "pending",
                        "presentation_preflight_elapsed_ms": 0,
                    },
                }
            return {
                "builder_presentation_phase": "authoring_pending",
                "builder_presentation_authoring_started_at_ms": now_ms,
                "builder_pptx_diagnostics": {
                    "presentation_preflight_status": "skipped",
                    "presentation_preflight_elapsed_ms": 0,
                    "prepare_force_reason": "research_disabled",
                },
            }
        if phase == "preflight_result_received":
            return {
                "builder_presentation_phase": "authoring_pending",
                "builder_presentation_authoring_started_at_ms": int(
                    state.get("builder_presentation_authoring_started_at_ms") or now_ms
                ),
            }
        if phase == "preflight_call_emitted":
            result = cls._presentation_preflight_result_message(state)
            if result is None:
                return None
            started_ms = int(state.get("builder_presentation_preflight_started_at_ms", now_ms) or now_ms)
            content = cls._tool_message_text(result)
            status = str(getattr(result, "status", "") or "").lower()
            failed = status == "error" or content.lstrip().startswith("Error:")
            return {
                "builder_presentation_phase": "authoring_pending",
                "builder_presentation_authoring_started_at_ms": int(
                    state.get("builder_presentation_authoring_started_at_ms") or now_ms
                ),
                "builder_pptx_diagnostics": {
                    "presentation_preflight_status": "failed" if failed else "completed",
                    "presentation_preflight_elapsed_ms": max(0, now_ms - started_ms),
                    "prepare_force_reason": "bounded_preflight_complete",
                },
            }
        return None

    @staticmethod
    def _deck_prepare_force_due(state: BuilderArtifactState) -> bool:
        """Latch the service-owned prepare call by turn or elapsed time."""
        if not _deck_build_service_route_active(state):
            return False
        if state.get("builder_deck_prepare_phase") == "terminal":
            return False
        diagnostics = _pptx_diagnostics(state)
        if int(diagnostics.get("prepare_call_count", 0) or 0) > 0:
            return False
        if state.get("builder_deck_prepare_latch_active"):
            return True
        turn_due = _builder_current_turn_index(state) >= prepare_force_at_turn(state)
        elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state)
        force_after_ms = prepare_force_after_seconds(state) * 1000
        clock_due = bool(force_after_ms > 0 and elapsed_ms is not None and elapsed_ms >= force_after_ms)
        return turn_due or clock_due

    @staticmethod
    def _forced_simple_pdf_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces the deterministic PDF writer."""
        return {"type": "tool", "name": _SIMPLE_PDF_TOOL_NAME}

    def _research_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if self._should_force_fetch_tool(state):
            logger.warning("BuilderArtifact: forcing tool_choice=builder_web_fetch after search before factual artifact writing")
            return self._forced_fetch_tool_choice()
        if not self._should_force_research_tool(state):
            return None
        explicit_urls = [url for url in (state.get("explicit_user_urls") or []) if str(url).strip()]
        if explicit_urls:
            logger.warning(
                "BuilderArtifact: forcing tool_choice=builder_web_fetch before artifact writing (explicit_urls=%d)",
                len(explicit_urls),
            )
            return self._forced_fetch_tool_choice()
        logger.warning("BuilderArtifact: forcing tool_choice=builder_web_search before artifact writing")
        return self._forced_search_tool_choice()

    def _visual_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if not _visual_design_skill_read_seen(state):
            force_count = _builder_visual_force_count(state)
            if force_count >= 2:
                logger.warning(
                    "[BuilderVisualDiagnostics] force_cap_reached count=%d; leaving visual skill workflow unforced",
                    force_count,
                )
                return None
            logger.warning(
                "[BuilderVisualDiagnostics] visual-design skill not read yet; forcing read_file before visual asset creation count=%d",
                force_count + 1,
            )
            return self._forced_read_tool_choice()
        if state.get("builder_visual_asset_correction_emitted") and _embedded_visual_success_count(state) <= 0 and _visual_asset_attempt_count(state) <= 0:
            logger.warning("[BuilderVisualDiagnostics] visual asset correction exists with no asset attempts; leaving creative workflow unforced")
            return None
        return None

    def _completion_tool_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        if _presentation_completion_ready(state):
            logger.warning("BuilderArtifact: forcing tool_choice=emit_builder_artifact (reason=presentation_completion_ready)")
            return self._output_file_completion_tool_choice(
                state,
                state.get("builder_non_artifact_turns"),
                "presentation_completion_ready",
            )
        # Fresh PPTX output is service-owned. The generic completion recovery
        # must never force write_file or a lower-level compiler for this route.
        if _deck_build_service_route_active(state):
            if state.get("builder_deck_prepare_latch_active") or self._deck_prepare_force_due(state) or self._should_force_emit(state) or self._should_force_emit_by_clock(state, runtime):
                return self._forced_prepare_deck_build_tool_choice()
            return None
        turn_force = self._should_force_emit(state)
        clock_force = self._should_force_emit_by_clock(state, runtime)
        if not (turn_force or clock_force):
            return None
        force_reason = _force_reason(turn_force, clock_force)
        non_artifact_turns = state.get("builder_non_artifact_turns")

        if self._has_output_file(state):
            return self._output_file_completion_tool_choice(state, non_artifact_turns, force_reason)

        if self._has_generator_script(state):
            return self._generator_recovery_tool_choice(state, non_artifact_turns, force_reason)

        if _requested_pptx_artifact(state) and not state.get("builder_pptx_skill_correction_emitted"):
            logger.warning(
                "BuilderArtifact: PPTX target has no valid deck/fallback and no skill correction yet; withholding generic write_file force so the presentation-skill correction can steer the next turn (non_artifact_turns=%s, reason=%s)",
                non_artifact_turns,
                force_reason,
            )
            return None

        logger.warning(
            "BuilderArtifact: forcing tool_choice=write_file before emit (non_artifact_turns=%s, ceiling=%s, reason=%s, no output file yet — force prevents phantom-emit loop)",
            non_artifact_turns,
            max_non_artifact_turns(state),
            force_reason,
        )
        return self._forced_write_tool_choice()

    def _output_file_completion_tool_choice(
        self,
        state: BuilderArtifactState,
        non_artifact_turns: object,
        force_reason: str,
    ) -> dict[str, Any]:
        if self._should_force_pdf_render_before_emit(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=render_html_to_pdf before PDF fallback emit (non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                max_non_artifact_turns(state),
                force_reason,
            )
            return self._forced_pdf_render_tool_choice()
        if self._should_force_pdf_source_before_emit(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=write_file before PDF fallback emit because no HTML render source exists (non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                max_non_artifact_turns(state),
                force_reason,
            )
            return self._forced_write_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=emit_builder_artifact (non_artifact_turns=%s, ceiling=%s, reason=%s)",
            non_artifact_turns,
            max_non_artifact_turns(state),
            force_reason,
        )
        return self._forced_tool_choice()

    @classmethod
    def _should_force_pdf_render_before_emit(cls, state: BuilderArtifactState) -> bool:
        if not _requested_pdf_artifact(state):
            return False
        if cls._has_requested_pdf_binary(state):
            return False
        return not _pdf_render_attempted(state) and bool(_preferred_pdf_render_source_path(state))

    @classmethod
    def _should_force_pdf_source_before_emit(cls, state: BuilderArtifactState) -> bool:
        if not _requested_pdf_artifact(state):
            return False
        if cls._has_requested_pdf_binary(state) or _pdf_render_attempted(state):
            return False
        return _preferred_pdf_render_source_path(state) is None

    def _generator_recovery_tool_choice(
        self,
        state: BuilderArtifactState,
        non_artifact_turns: object,
        force_reason: str,
    ) -> dict[str, Any]:
        if _requested_pdf_artifact(state):
            logger.warning(
                "BuilderArtifact: PDF target has generator script but no deliverable; forcing write_file to create a Markdown source/fallback instead (non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                max_non_artifact_turns(state),
                force_reason,
            )
            return self._forced_write_tool_choice()
        if _requested_pptx_artifact(state):
            if not state.get("builder_pptx_skill_correction_emitted"):
                logger.warning(
                    "BuilderArtifact: PPTX target has ad hoc generator script but no valid deck/fallback; withholding bash force until the ppt-generation skill correction runs (non_artifact_turns=%s, reason=%s)",
                    non_artifact_turns,
                    force_reason,
                )
                return None
            logger.warning(
                "BuilderArtifact: PPTX target still has no valid deck after skill correction; forcing write_file only to create a Markdown/HTML fallback, never a Python deck script (non_artifact_turns=%s, reason=%s)",
                non_artifact_turns,
                force_reason,
            )
            return self._forced_write_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=bash before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, generator "
            "script on disk but no binary — three-stage force gives the "
            "model a chance to RUN the generator instead of writing yet "
            "another one)",
            non_artifact_turns,
            max_non_artifact_turns(state),
            force_reason,
        )
        return self._forced_bash_tool_choice()

    @staticmethod
    def _forced_bash_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces bash.

        PR-B (2026-04-28): used by the three-stage forced-emit path when a
        generator script (``_generate_*.py``) exists in outputs/ but no
        user-facing binary (pdf/pptx/png/...) has been produced yet. For
        binary deliverables the recovery action is *running* the generator,
        not writing yet another generator. Forcing write_file in that state
        — as PR-A did — traps the model: each forced write produces another
        ``_generate_*.py`` (which ``_has_output_file`` filters out), so the
        gate stays False and the loop spins. Forcing bash gives the model a
        deterministic chance to produce the binary by running what it
        already has on disk. If bash also fails to produce output, the
        hard-ceiling fallback promotes the generator script with
        ``confidence=0.4`` so the user still gets something.
        """
        return {"type": "tool", "name": "bash"}

    @staticmethod
    def _has_output_file(state: BuilderArtifactState) -> bool:
        """Return True if any user-facing file exists in the sandbox outputs dir.

        PR-A: used by ``wrap_model_call`` to decide whether the forced-emit
        window should immediately force ``tool_choice=emit_builder_artifact``
        or first force ``tool_choice=write_file`` to give a not-yet-written
        deliverable a chance to land.

        Files whose name starts with ``_`` (e.g. generator scripts named
        ``_generate_foo.py``) or ``.`` (hidden files) are excluded — those
        aren't user-facing deliverables.
        """
        outputs_host_path = _outputs_host_path_from_state(state)
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            # No outputs dir configured — assume the model hasn't written
            # anything. Returning False routes through the safer path
            # (force write_file first) instead of forcing a phantom emit.
            return False

        # Ignore stale artifacts from prior builder tasks in the same thread.
        # Keep the same 5s grace used by hard-ceiling promotion.
        min_mtime = _builder_started_min_mtime(state)

        try:
            return _output_tree_has_completion_candidate(outputs_root, state, min_mtime)
        except OSError:
            # Filesystem error (permissions, race) — fall through to True
            # so the existing forced-emit path proceeds. Better to risk one
            # phantom emit than to accidentally trap the model in write_file
            # forcing on every turn when something is genuinely wrong with
            # the sandbox.
            logger.debug(
                "BuilderArtifact._has_output_file: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return True
        return False

    @staticmethod
    def _has_requested_pdf_binary(state: BuilderArtifactState) -> bool:
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            return False
        min_mtime = _builder_started_min_mtime(state)
        try:
            return _output_tree_has_fresh_pdf(outputs_root, min_mtime)
        except OSError:
            logger.debug(
                "BuilderArtifact._has_requested_pdf_binary: scan failed for outputs_path=%s",
                _outputs_host_path_from_state(state),
                exc_info=True,
            )
            return False

    @staticmethod
    def _has_valid_pptx_output(state: BuilderArtifactState) -> bool:
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            return False
        min_mtime = _builder_started_min_mtime(state)
        try:
            for entry in outputs_root.rglob("*.pptx"):
                if not _is_public_output_file(entry):
                    continue
                if _is_support_output_path(entry, outputs_root):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                if _pptx_integrity_error_for_file(entry) is None:
                    return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_valid_pptx_output: scan failed for outputs_path=%s",
                _outputs_host_path_from_state(state),
                exc_info=True,
            )
        return False

    @staticmethod
    def _promotable_output_candidates(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        requested_html: bool,
    ) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [
            p
            for p in outputs_root.rglob("*")
            if _is_promotable_candidate_path(
                p,
                outputs_root=outputs_root,
                min_mtime=min_mtime,
                requested_pdf=requested_pdf,
                requested_pptx=requested_pptx,
                requested_html=requested_html,
            )
        ]
        candidates = BuilderArtifactMiddleware._target_promotable_candidates(
            candidates,
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
            requested_html=requested_html,
        )
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates

    @staticmethod
    def _target_promotable_candidates(
        candidates: list[Path],
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        requested_html: bool,
    ) -> list[Path]:
        if requested_pdf:
            return BuilderArtifactMiddleware._preferred_suffix_candidates(
                candidates,
                primary_suffix=".pdf",
                fallback_suffix=_pdf_fallback_suffix(state),
                primary_disabled=_pdf_render_unusable_after_repair(state),
            )
        if requested_pptx:
            return BuilderArtifactMiddleware._preferred_suffix_candidates(
                candidates,
                primary_suffix=".pptx",
                fallback_suffix=_pptx_fallback_suffix(state),
            )
        if requested_html:
            return [path for path in candidates if path.suffix.lower() in _HTML_ARTIFACT_SUFFIXES]
        return candidates

    @staticmethod
    def _preferred_suffix_candidates(
        candidates: list[Path],
        *,
        primary_suffix: str,
        fallback_suffix: str,
        primary_disabled: bool = False,
    ) -> list[Path]:
        primary = [] if primary_disabled else [p for p in candidates if p.suffix.lower() == primary_suffix]
        fallback = [p for p in candidates if p.suffix.lower() == fallback_suffix]
        return primary or fallback

    @staticmethod
    def _generator_output_candidates(state: BuilderArtifactState) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [p for p in outputs_root.rglob("*") if p.is_file() and p.name.startswith("_generate_") and p.suffix.lower() == ".py" and (min_mtime is None or p.stat().st_mtime >= min_mtime)]
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates

    @staticmethod
    def _virtual_output_path(path: Path, state: BuilderArtifactState) -> str:
        outputs_host_path = _outputs_host_path_from_state(state)
        outputs_root = Path(outputs_host_path or "")
        return f"/mnt/user-data/outputs/{path.relative_to(outputs_root).as_posix()}"

    @staticmethod
    def _promoted_deliverable_from_outputs(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        requested_html: bool,
        reason: str,
    ) -> tuple[str | None, str]:
        try:
            candidates = BuilderArtifactMiddleware._promotable_output_candidates(
                state,
                requested_pdf=requested_pdf,
                requested_pptx=requested_pptx,
                requested_html=requested_html,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort only
            logger.warning(
                "BuilderArtifact: ceiling fallback scan failed reason=%s error=%s",
                reason,
                exc,
            )
            return None, "unknown"
        if not candidates:
            return None, "unknown"
        best = candidates[0]
        return (
            BuilderArtifactMiddleware._virtual_output_path(best, state),
            best.suffix.lower().lstrip(".") or "unknown",
        )

    @staticmethod
    def _promoted_generator_from_outputs(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        requested_html: bool,
        reason: str,
    ) -> str | None:
        try:
            gen_candidates = BuilderArtifactMiddleware._generator_output_candidates(state)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: generator-script fallback scan failed reason=%s error=%s",
                reason,
                exc,
            )
            return None
        if not gen_candidates:
            return None
        promoted_path = BuilderArtifactMiddleware._virtual_output_path(
            gen_candidates[0],
            state,
        )
        if requested_pdf:
            logger.warning(
                "BuilderArtifact: PDF fallback refusing generator script %s (reason=%s, no pdf_or_markdown deliverable found)",
                promoted_path,
                reason,
            )
            return None
        if requested_pptx:
            logger.warning(
                "BuilderArtifact: PPTX fallback refusing generator script %s (reason=%s, no valid deck_or_fallback deliverable found)",
                promoted_path,
                reason,
            )
            return None
        if requested_html:
            logger.warning(
                "BuilderArtifact: HTML fallback refusing generator script %s (reason=%s, no valid html deliverable found)",
                promoted_path,
                reason,
            )
            return None
        logger.warning(
            "BuilderArtifact: fallback promoting generator script %s (reason=%s, no binary deliverable found)",
            promoted_path,
            reason,
        )
        return promoted_path

    @staticmethod
    def _recovered_deliverable_fallback(
        promoted_path: str,
        promoted_type: str,
        *,
        steps_completed: int,
    ) -> dict[str, Any]:
        return {
            "artifact_path": promoted_path,
            "artifact_type": promoted_type,
            "artifact_title": "Build task completed (recovered)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder ran long and didn't call emit cleanly, but the deliverable is on disk — I'm surfacing it now."),
            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
            "user_next_action": "Open the file and let me know if it lands.",
            "confidence": 0.5,
        }

    @staticmethod
    def _generator_script_fallback(
        promoted_generator_path: str,
        *,
        steps_completed: int,
    ) -> dict[str, Any]:
        return {
            "artifact_path": promoted_generator_path,
            "artifact_type": "code",
            "artifact_title": "Build task partial (generator script only)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("I built the generator script but couldn't produce the final binary cleanly — sharing the script so you have something to work with."),
            "companion_tone_hint": ("Honest and constructive — partial deliverable; offer to debug if the user shares the error from running it."),
            "user_next_action": ("Try running `python <path>` yourself, or send me the error and I'll fix it."),
            "confidence": 0.4,
        }

    @staticmethod
    def _pdf_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF build did not complete",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder could not produce a PDF or Markdown fallback. I did not surface the generator script as a completed PDF."),
            "companion_tone_hint": ("Apologetic and direct — PDF rendering did not produce a deliverable; offer to retry."),
            "user_next_action": "Ask me to retry the PDF build.",
            "confidence": 0.2,
        }

    @staticmethod
    def _pptx_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "presentation",
            "artifact_title": "Slide deck did not complete",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder could not produce a valid PowerPoint deck or a usable markdown/html fallback. I did not surface a broken PPTX as completed."),
            "companion_tone_hint": ("Apologetic and direct — deck generation did not produce a valid deliverable; offer to retry."),
            "user_next_action": "Ask me to retry the slide deck build.",
            "confidence": 0.2,
        }

    @staticmethod
    def _html_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "html",
            "artifact_title": "HTML artifact did not complete",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder could not produce a valid standalone HTML artifact. I did not surface Markdown or a broken HTML file as completed."),
            "companion_tone_hint": ("Apologetic and direct — HTML generation did not produce a valid deliverable; offer to retry."),
            "user_next_action": "Ask me to retry the HTML artifact build.",
            "confidence": 0.2,
            "fallback_reason": "html_generation_failed",
        }

    @staticmethod
    def _generic_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "unknown",
            "artifact_title": "Build task force-stopped",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (f"The builder made {steps_completed} edits but didn't finish cleanly. No final deliverable was produced."),
            "companion_tone_hint": "Apologetic — builder ran out of budget.",
            "user_next_action": "Tell me what to try differently and I'll run it again.",
            "confidence": 0.2,
        }

    @staticmethod
    def _fallback_completion_status(fallback: dict[str, Any]) -> str:
        if fallback.get("artifact_path"):
            return "completed"
        if fallback.get("budget_stop_reason"):
            return "timed_out"
        return "failed"

    @staticmethod
    def _budget_stop_fallback(fallback: dict[str, Any], reason: str) -> dict[str, Any]:
        if fallback.get("artifact_path"):
            return fallback
        if reason != "hard_ceiling" and "consecutive_empty_emit_rejections" not in reason:
            return fallback
        updated = dict(fallback)
        updated["budget_stop_reason"] = "turn_limit"
        updated["status"] = "timed_out"
        updated["terminal_status"] = "timed_out"
        updated["terminal_reason"] = "turn_limit"
        updated["failure_code"] = "builder_turn_limit_exceeded"
        updated["companion_summary"] = USER_BUDGET_TURN_MESSAGE
        updated["user_next_action"] = "Tell me if you want me to try again with a narrower scope."
        diagnostics = dict(updated.get("builder_failure_diagnostics") or {})
        diagnostics["failure_code"] = diagnostics.get("failure_code") or "builder_turn_limit_exceeded"
        diagnostics["budget_stop_reason"] = "turn_limit"
        updated["builder_failure_diagnostics"] = diagnostics
        return updated

    @staticmethod
    def _log_missing_pdf_render_attempt_if_needed(
        state: BuilderArtifactState,
        artifact_args: dict[str, Any],
    ) -> None:
        if not _pdf_render_attempt_missing(state):
            return
        logger.warning(
            "BuilderArtifact: requested_ext=pdf render_tool_attempted=false fallback_ext=%s rejected_ext=%s reason=pdf_render_tool_not_attempted",
            _pdf_fallback_suffix(state).lstrip("."),
            _artifact_path_suffix_label(artifact_args.get("artifact_path")),
        )

    @staticmethod
    def _requested_pdf_without_render_fallback(
        state: BuilderArtifactState,
        *,
        promoted_path: str | None,
        steps_completed: int,
    ) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or _pdf_render_attempted(state):
            return None
        if promoted_path:
            promoted_suffix = PurePosixPath(promoted_path).suffix.lower()
            if promoted_suffix == ".pdf":
                return None
            logger.warning(
                "BuilderArtifact: PDF ceiling fallback refused source before render attempt source_ext=%s reason=pdf_render_tool_not_attempted",
                promoted_suffix.lstrip(".") or None,
            )
        elif not _preferred_pdf_render_source_path(state):
            return None
        else:
            logger.warning("BuilderArtifact: PDF ceiling found source but no render attempt reason=pdf_render_tool_not_attempted")
        fallback = BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
            steps_completed=steps_completed,
        )
        return _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pdf_render_tool_not_attempted",
        )

    @staticmethod
    def _requested_pptx_without_generation_fallback(
        state: BuilderArtifactState,
        *,
        promoted_path: str | None,
        steps_completed: int,
    ) -> dict[str, Any] | None:
        if not promoted_path or not _requested_pptx_artifact(state) or _pptx_fallback_generation_attempt_satisfied(state):
            return None
        promoted_suffix = PurePosixPath(promoted_path).suffix.lower()
        if promoted_suffix == ".pptx":
            return None
        logger.warning(
            "BuilderArtifact: PPTX ceiling fallback refused before generator attempt source_ext=%s",
            promoted_suffix.lstrip(".") or None,
        )
        fallback = BuilderArtifactMiddleware._pptx_no_deliverable_fallback(
            steps_completed=steps_completed,
        )
        return _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed",
        )

    @staticmethod
    def _promoted_path_ceiling_fallback(
        state: BuilderArtifactState,
        *,
        promoted_path: str,
        promoted_type: str,
        requested_pdf: bool,
        requested_pptx: bool,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        promoted_suffix = PurePosixPath(promoted_path).suffix.lower()
        # Format-swapped promotion is disabled for pdf/pptx requests:
        # never deliver a different format as the completion artifact.
        if requested_pdf and promoted_suffix != ".pdf":
            logger.warning(
                "BuilderArtifact: ceiling refused format-swap promotion requested_ext=pdf promoted_ext=%s reason=%s",
                promoted_suffix.lstrip(".") or None,
                reason,
            )
            failure = BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return BuilderArtifactMiddleware._budget_stop_fallback(
                _apply_artifact_request_metadata(
                    failure,
                    state,
                    fallback_reason="pdf_generation_failed",
                ),
                reason,
            )
        if requested_pptx and promoted_suffix != ".pptx":
            logger.warning(
                "BuilderArtifact: ceiling refused format-swap promotion requested_ext=pptx promoted_ext=%s reason=%s",
                promoted_suffix.lstrip(".") or None,
                reason,
            )
            failure = BuilderArtifactMiddleware._pptx_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return BuilderArtifactMiddleware._budget_stop_fallback(
                _apply_artifact_request_metadata(
                    failure,
                    state,
                    fallback_reason="pptx_generation_not_completed",
                ),
                reason,
            )
        fallback = BuilderArtifactMiddleware._recovered_deliverable_fallback(
            promoted_path,
            promoted_type,
            steps_completed=steps_completed,
        )
        return _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed" if requested_pptx else reason,
        )

    @staticmethod
    def _build_ceiling_fallback(
        state: BuilderArtifactState,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        """Synthesize a ``builder_result`` dict by scanning ``outputs/`` for
        a deliverable to promote."""
        requested_pdf = _requested_pdf_artifact(state)
        requested_pptx = _requested_pptx_artifact(state)
        requested_html = _requested_html_artifact(state)
        promoted_path, promoted_type = BuilderArtifactMiddleware._promoted_deliverable_from_outputs(
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
            requested_html=requested_html,
            reason=reason,
        )
        fallback = BuilderArtifactMiddleware._requested_pdf_without_render_fallback(
            state,
            promoted_path=promoted_path,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return BuilderArtifactMiddleware._budget_stop_fallback(fallback, reason)
        fallback = BuilderArtifactMiddleware._requested_pptx_without_generation_fallback(
            state,
            promoted_path=promoted_path,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return BuilderArtifactMiddleware._budget_stop_fallback(fallback, reason)
        if promoted_path:
            return BuilderArtifactMiddleware._promoted_path_ceiling_fallback(
                state,
                promoted_path=promoted_path,
                promoted_type=promoted_type,
                requested_pdf=requested_pdf,
                requested_pptx=requested_pptx,
                steps_completed=steps_completed,
                reason=reason,
            )
        fallback = BuilderArtifactMiddleware._requested_pdf_without_render_fallback(
            state,
            promoted_path=None,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return BuilderArtifactMiddleware._budget_stop_fallback(fallback, reason)
        promoted_generator_path = BuilderArtifactMiddleware._promoted_generator_from_outputs(
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
            requested_html=requested_html,
            reason=reason,
        )
        if promoted_generator_path:
            fallback = BuilderArtifactMiddleware._generator_script_fallback(
                promoted_generator_path,
                steps_completed=steps_completed,
            )
            return _apply_artifact_request_metadata(fallback, state, fallback_reason=reason)
        if requested_pdf:
            fallback = BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return BuilderArtifactMiddleware._budget_stop_fallback(
                _apply_artifact_request_metadata(fallback, state, fallback_reason=reason),
                reason,
            )
        if requested_pptx:
            fallback = BuilderArtifactMiddleware._pptx_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return BuilderArtifactMiddleware._budget_stop_fallback(
                _apply_artifact_request_metadata(fallback, state, fallback_reason=reason),
                reason,
            )
        if requested_html:
            fallback = BuilderArtifactMiddleware._html_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return BuilderArtifactMiddleware._budget_stop_fallback(
                _apply_artifact_request_metadata(fallback, state, fallback_reason="html_generation_failed"),
                reason,
            )
        return BuilderArtifactMiddleware._budget_stop_fallback(
            BuilderArtifactMiddleware._generic_no_deliverable_fallback(
                steps_completed=steps_completed,
            ),
            reason,
        )

    @staticmethod
    def _upload_fallback_and_fire(
        state: BuilderArtifactState,
        runtime: Runtime,
        fallback: dict[str, Any],
        status: str,
        *,
        cleanup_started: float | None = None,
    ) -> None:
        """Mirror the ceiling-fallback file to Supabase BEFORE firing the
        completion webhook.

        Phase 4L (2026-05-19): the two ceiling-fallback call sites used
        to fire ``fire_completion_webhook_from_artifact`` directly,
        without uploading the promoted file. If ``SOPHIA_SUPABASE_MIRROR_ALL``
        wasn't enabled (or the per-write mirror missed the file), the
        downstream signed-URL mint returned 404 and Telegram delivery
        fell back to plaintext. Mirrors the upload step from the normal
        happy path at ``after_model`` (the lines that resolve
        ``upload_thread_id`` and call ``_upload_builder_outputs_to_supabase``).

        Safe to call when ``fallback["artifact_path"]`` is None. Local/dev
        upload failures remain best-effort; production Supabase registry
        mode emits a failed completion if the artifact bytes cannot be
        uploaded and verified.
        """
        cleanup_started = cleanup_started or time.perf_counter()
        thread_data = state.get("thread_data") or {}
        outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        delegation = state.get("delegation_context")
        parent_thread_id = delegation.get("parent_thread_id") if isinstance(delegation, dict) else None
        builder_thread_id = runtime.context.get("thread_id") if getattr(runtime, "context", None) else None
        upload_thread_id = parent_thread_id or builder_thread_id
        fallback = _apply_visual_missing_quality_metadata(fallback, state)
        fallback = _apply_pdf_page_count_quality_metadata(fallback, state)
        _attach_durable_upload_identity(fallback, state, runtime)
        mirror_result = _upload_builder_outputs_to_supabase(
            thread_id=upload_thread_id,
            outputs_host_path=outputs_host_path,
            artifact_args=fallback,
        )
        if mirror_result != "uploaded":
            current_diagnostics = fallback.get("builder_failure_diagnostics")
            required_failure = _is_required_supabase_failure(mirror_result)
            if isinstance(current_diagnostics, dict) and current_diagnostics:
                fallback["builder_failure_diagnostics"] = merge_builder_failure_diagnostics(
                    current_diagnostics,
                    supabase_mirror_attempted=mirror_result not in {"skipped", "not_configured"},
                    supabase_mirror_result=mirror_result,
                )
            elif fallback.get("artifact_path"):
                fallback["builder_failure_diagnostics"] = build_builder_failure_diagnostics(
                    state=state,
                    runtime=runtime,
                    artifact_args=fallback,
                    failure_stage="storage_mirror",
                    failure_reason=(_durable_upload_error_message() if required_failure else "Supabase mirror did not create a remote copy, but the local artifact path remains available."),
                    failure_code="durable_storage_unavailable" if required_failure else None,
                    emit_attempted=True,
                    emit_tool_call_seen=True,
                    include_outputs_summary=False,
                    supabase_mirror_attempted=mirror_result not in {"skipped", "not_configured"},
                    supabase_mirror_result=mirror_result,
                )
        fallback["terminal_cleanup_elapsed_ms"] = int(
            (time.perf_counter() - cleanup_started) * 1000
        )
        annotate_builder_completion(state, fallback)
        if _is_required_supabase_failure(mirror_result):
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status="failed",
                error_message=_durable_upload_error_message(),
            )
        else:
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status=status,
            )

    @staticmethod
    def _has_generator_script(state: BuilderArtifactState) -> bool:
        """Return True if a builder-produced ``_generate_*.py`` script exists.

        PR-B (2026-04-28): companion to ``_has_output_file`` for the three-
        stage forced-emit path. The builder prompt instructs binary tasks
        to write ``_generate_<name>.py`` then bash-run it. When no binary
        deliverable has landed yet but a generator script has, the recovery
        action is running the script (force ``bash``), not writing yet
        another script (force ``write_file``).

        Same staleness filtering as ``_has_output_file``: ignores generators
        from prior builder tasks via ``builder_task_started_at_ms``.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                # Match generator scripts produced by the builder per the
                # binary-deliverable prompt (``_generate_<name>.py``).
                if not (entry.name.startswith("_generate_") and entry.suffix.lower() == ".py"):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_generator_script: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            # Conservative on error: report no generator so the existing
            # write_file forcing path proceeds.
            return False
        return False

    @classmethod
    def _artifact_files_exist(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        """Verify that every file referenced in the emit args exists on disk or in Supabase.

        PR-D (2026-04-24): prevents phantom artifacts where the builder calls
        emit_builder_artifact before the file has actually been written.
        Returns ``True`` only when ALL referenced paths resolve to an existing
        local file OR an existing Supabase object.

        PR-A (2026-04-27): tightened the empty-candidates fast-path. When the
        model is in the forced-emit window (``_should_force_emit`` is True),
        an empty ``artifact_path`` is treated as ESCAPE-HATCH-INVALID: it
        almost always means the model gave up under tool_choice pressure
        and is emitting nothing. We reject so the hard-ceiling fallback
        path (which scans outputs/ and produces a deterministic
        confidence=0.5 promotion or confidence=0.2 apology) can take over.
        Outside the forced-emit window the old behaviour applies — text-only
        / conceptual artifacts are still accepted.
        """
        if _requested_pdf_artifact(state) and not cls._pdf_artifact_args_valid(artifact_args, state):
            return False
        if _requested_pptx_artifact(state) and not cls._pptx_artifact_args_valid(artifact_args, state, runtime):
            return False
        if _requested_html_artifact(state) and not cls._html_artifact_args_valid(artifact_args, state, runtime):
            return False
        candidates = _emit_candidate_paths(artifact_args)
        if not candidates:
            # Reject empty artifact_path under EITHER turn-count pressure
            # (existing) OR wall-clock pressure (new). Both indicate the
            # model is emitting under tool_choice pressure with no real
            # deliverable to point at — let the hard-ceiling fallback
            # promote a real file or surface a deterministic apology.
            if cls._should_force_emit(state) or cls._should_force_emit_by_clock(state, runtime):
                logger.warning(
                    "BuilderArtifact: rejecting empty artifact_path during forced-emit (non_artifact_turns=%s) — letting hard ceiling fallback promote a real file or surface a deterministic apology instead of a phantom emit.",
                    state.get("builder_non_artifact_turns"),
                )
                return False
            # No files referenced AND not under forced-emit pressure —
            # accept (builder may be emitting a text-only or conceptual
            # result).
            return True

        thread_data = state.get("thread_data") or {}
        outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        remote_thread_ids = _artifact_remote_thread_ids(state, runtime)

        for candidate in candidates:
            if not _emit_candidate_verified(
                candidate,
                outputs_host_path=outputs_host_path,
                remote_thread_ids=remote_thread_ids,
            ):
                return False

        visual_ok = _visual_presence_validated(artifact_args, state)
        logger.info(
            "[BuilderVisualDiagnostics] phase=emit_validation visuals_requested=%s design_skill_read=%s embedded_visual_count=%d visual_presence_validated=%s requested_ext=%s final_ext=%s",
            _visuals_requested(state),
            _visual_design_skill_read_seen(state),
            _embedded_visual_success_count(state),
            visual_ok,
            _requested_artifact_ext(state),
            _artifact_path_suffix_label(artifact_args.get("artifact_path")),
        )
        if not visual_ok:
            # NOTE: the hard visual gate lives in _visual_gate_blocks_emit
            # (applied only at emit decision points). This predicate is also
            # used by recovery/override helpers that must keep seeing the
            # rendered file as valid.
            logger.warning(
                "[BuilderVisualDiagnostics] phase=emit_visual_missing_soft_pass requested_ext=%s final_ext=%s visual assets are support-only; allowing artifact truth validation to continue",
                _requested_artifact_ext(state),
                _artifact_path_suffix_label(artifact_args.get("artifact_path")),
            )

        return True

    @classmethod
    def _visual_repair_available(cls, state: BuilderArtifactState) -> bool:
        return int(state.get("builder_visual_embed_rejections", 0) or 0) < 1 and _repair_iteration_grantable(state)

    @classmethod
    def _deck_plan_gate_blocks(cls, state: BuilderArtifactState) -> bool | None:
        deck_problems = _deck_plan_validation_problems(state)
        if not deck_problems:
            return None
        hard_problem = any(token in problem.lower() for problem in deck_problems for token in ("zero embedded", "contains zero", "package", "wrong extension"))
        if cls._visual_repair_available(state):
            logger.warning(
                "[BuilderDeckPlanGate] phase=emit_blocked problems=%s",
                deck_problems,
            )
            return True
        if hard_problem:
            logger.warning(
                "[BuilderDeckPlanGate] phase=emit_blocked_hard problems=%s",
                deck_problems,
            )
            return True
        logger.warning(
            "[BuilderDeckPlanGate] phase=emit_soft_pass_after_repair problems=%s",
            deck_problems,
        )
        return False

    @classmethod
    def _report_problem_gate_blocks(
        cls,
        state: BuilderArtifactState,
        *,
        problems: list[str],
        log_tag: str,
    ) -> bool | None:
        if not problems:
            return None
        if cls._visual_repair_available(state):
            logger.warning(
                "[%s] phase=emit_blocked problems=%s",
                log_tag,
                problems,
            )
            return True
        logger.warning(
            "[%s] phase=emit_soft_pass_after_repair problems=%s",
            log_tag,
            problems,
        )
        return False

    @classmethod
    def _visual_gate_blocks_emit(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> bool:
        """Bounded visual discipline gate.

        The creative side remains model-owned, but requested visual artifacts
        must first read the design discipline and get one chance to embed
        generated chart/diagram evidence before terminal success.
        """
        deck_gate = cls._deck_plan_gate_blocks(state)
        if deck_gate is not None:
            return deck_gate
        report_grammar_gate = cls._report_problem_gate_blocks(
            state,
            problems=_report_visual_grammar_problems(state),
            log_tag="BuilderReportGrammarGate",
        )
        if report_grammar_gate is not None:
            return report_grammar_gate
        if not _visuals_requested(state):
            return False
        if not _visual_design_skill_read_seen(state):
            logger.warning(
                "[BuilderVisualDiagnostics] phase=emit_blocked_design_skill_unread requested_ext=%s final_ext=%s",
                _requested_artifact_ext(state),
                _artifact_path_suffix_label(artifact_args.get("artifact_path")),
            )
            return True
        if _visual_presence_validated(artifact_args, state):
            return False
        if cls._visual_repair_available(state):
            logger.warning(
                "[BuilderVisualDiagnostics] phase=emit_blocked_visual_missing requested_ext=%s final_ext=%s",
                _requested_artifact_ext(state),
                _artifact_path_suffix_label(artifact_args.get("artifact_path")),
            )
            return True
        logger.warning(
            "[BuilderVisualDiagnostics] phase=emit_visual_missing_diagnostic requested_ext=%s final_ext=%s — visual embed repair already spent; shipping with quality warning if otherwise valid",
            _requested_artifact_ext(state),
            _artifact_path_suffix_label(artifact_args.get("artifact_path")),
        )
        return False

    @staticmethod
    def _pptx_artifact_args_valid(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        primary = artifact_args.get("artifact_path")
        rejection_reason = _pptx_artifact_path_rejection_reason(primary, state)
        if rejection_reason is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=rejection_reason,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, rejection_reason)
            return False
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return False
        canonical_suffix = PurePosixPath(canonical_primary).suffix.lower()
        if canonical_suffix in _PPTX_FALLBACK_EXTENSIONS:
            if not _pptx_fallback_generation_attempt_satisfied(state):
                rejection = "pptx_fallback_before_generation_attempt"
            elif BuilderArtifactMiddleware._has_valid_pptx_output(state):
                rejection = "pptx_fallback_when_valid_deck_exists"
            else:
                rejection = None
            if rejection is not None:
                _log_pptx_diagnostics(
                    phase="emit_rejected",
                    state=state,
                    artifact_path=primary,
                    integrity_reason=rejection,
                )
                BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, rejection)
                return False
        integrity_rejection = _pptx_path_integrity_rejection_reason(canonical_primary, state, runtime)
        if integrity_rejection is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=integrity_rejection,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, integrity_rejection)
            return False
        html_fallback_rejection = _pptx_html_fallback_integrity_rejection_reason(canonical_primary, state, runtime)
        if html_fallback_rejection is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=html_fallback_rejection,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, html_fallback_rejection)
            return False
        artifact_args["artifact_path"] = canonical_primary
        _apply_artifact_request_metadata(
            artifact_args,
            state,
            fallback_reason="pptx_generation_not_completed",
        )
        return True

    @staticmethod
    def _log_pptx_artifact_rejection(primary: object, rejection_reason: str) -> None:
        rejected_ext = PurePosixPath(str(primary or "")).suffix.lower().lstrip(".") or None
        logger.warning(
            "BuilderArtifact: rejecting PPTX artifact path reason=%s requested_ext=pptx rejected_ext=%s",
            rejection_reason,
            rejected_ext,
        )

    @staticmethod
    def _html_artifact_args_valid(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        primary = artifact_args.get("artifact_path")
        rejection_reason = _html_artifact_path_rejection_reason(primary)
        if rejection_reason is not None:
            BuilderArtifactMiddleware._log_html_artifact_rejection(primary, rejection_reason)
            return False
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return False
        integrity_rejection = _html_artifact_integrity_rejection_reason(
            canonical_primary,
            state,
            runtime,
        )
        if integrity_rejection is not None:
            BuilderArtifactMiddleware._log_html_artifact_rejection(primary, integrity_rejection)
            return False
        artifact_args["artifact_path"] = canonical_primary
        _apply_artifact_request_metadata(
            artifact_args,
            state,
            fallback_reason="html_generation_failed",
        )
        if not artifact_args.get("artifact_type") or str(artifact_args.get("artifact_type")).lower() in {"document", "unknown"}:
            artifact_args["artifact_type"] = "html"
        return True

    @staticmethod
    def _log_html_artifact_rejection(primary: object, rejection_reason: str) -> None:
        rejected_ext = PurePosixPath(str(primary or "")).suffix.lower().lstrip(".") or None
        logger.warning(
            "BuilderArtifact: rejecting HTML artifact path reason=%s requested_ext=html rejected_ext=%s",
            rejection_reason,
            rejected_ext,
        )

    @staticmethod
    def _pdf_artifact_args_valid(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> bool:
        primary = artifact_args.get("artifact_path")
        rejection_reason = _pdf_artifact_path_rejection_reason(primary, state)
        if rejection_reason is not None:
            BuilderArtifactMiddleware._log_pdf_artifact_rejection(primary, rejection_reason, state)
            return False
        return BuilderArtifactMiddleware._canonicalize_pdf_artifact_path(artifact_args, primary, state)

    @staticmethod
    def _log_pdf_artifact_rejection(
        primary: object,
        rejection_reason: str,
        state: BuilderArtifactState,
    ) -> None:
        rejected_ext = PurePosixPath(str(primary or "")).suffix.lower().lstrip(".") or None
        logger.warning(
            "BuilderArtifact: rejecting PDF artifact path reason=%s requested_ext=pdf render_tool_attempted=%s fallback_ext=%s rejected_ext=%s",
            rejection_reason,
            _pdf_render_attempted(state),
            _pdf_fallback_suffix(state).lstrip("."),
            rejected_ext,
        )
        if not _pdf_render_attempted(state):
            BuilderArtifactMiddleware._log_missing_pdf_render_attempt_if_needed(
                state,
                {"artifact_path": primary},
            )

    @staticmethod
    def _canonicalize_pdf_artifact_path(
        artifact_args: dict[str, Any],
        primary: object,
        state: BuilderArtifactState,
    ) -> bool:
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return False
        artifact_args["artifact_path"] = canonical_primary
        _apply_artifact_request_metadata(
            artifact_args,
            state,
            fallback_reason=None if PurePosixPath(canonical_primary).suffix.lower() == ".pdf" else "pdf_generation_failed",
        )
        return True

    @classmethod
    def _missing_artifact_recovery_hint(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        primary = artifact_args.get("artifact_path")
        outputs_host_path = _outputs_host_path_from_state(state)
        if not isinstance(primary, str) or not primary.strip() or not outputs_host_path:
            return ""
        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return ""
            requested_suffix = Path(primary).suffix.lower()
            min_mtime = _builder_started_min_mtime(state)
            candidates = [entry for entry in outputs_root.rglob("*") if _is_recovery_candidate(entry, requested_suffix=requested_suffix, min_mtime=min_mtime)]
        except OSError:
            logger.debug(
                "BuilderArtifact: missing-path recovery scan failed outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return ""
        return _recovery_hint(outputs_root, candidates)

    @classmethod
    def _emit_rejection_message(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        for message in (
            cls._deck_plan_rejection_message(state),
            cls._hero_rejection_message(artifact_args, state),
            cls._report_visual_grammar_rejection_message(state),
            cls._visual_presence_rejection_message(artifact_args, state),
            cls._pdf_request_rejection_message(artifact_args, state),
            cls._pptx_request_rejection_message(state),
            cls._html_request_rejection_message(state),
        ):
            if message:
                return message
        return cls._missing_artifact_rejection_message(artifact_args, state)

    @staticmethod
    def _deck_plan_rejection_message(state: BuilderArtifactState) -> str:
        deck_problems = _deck_plan_validation_problems(state)
        if not deck_problems:
            return ""
        listing = "\n".join(f"- {problem}" for problem in deck_problems[:8])
        if _deck_build_service_route_active(state):
            return (
                "Error: emit_builder_artifact rejected — the PPTX deck failed Sophia "
                "structural validation:\n"
                f"{listing}\n\n"
                "For fresh decks, call `prepare_deck_build` with corrected creative_plan, deck_stylesheet, and slide html_body and "
                "emit only its returned PPTX or its clean null-artifact failure. Do not repair "
                "through lower-level deck files or compiler commands."
            )
        return (
            "Error: emit_builder_artifact rejected — the PPTX deck failed Sophia "
            "structural validation:\n"
            f"{listing}\n\n"
            "Repair the deck now: ensure `/mnt/user-data/outputs/slides/` has one HTML file per "
            "requested slide, each embedding its visual by a relative `../assets/<file>` path, then "
            "call `build_deck_from_slides` again with the requested `.pptx` output path. Do not "
            "write custom python-pptx or emit a fallback file."
        )

    @classmethod
    def _hero_rejection_message(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        if cls._hero_gate_blocks_emit(artifact_args, state) and not (_visuals_requested(state) and not _visual_presence_validated(artifact_args, state)):
            requested_ext = _requested_artifact_ext(state)
            if requested_ext == "pdf":
                wiring = (
                    "name it /mnt/user-data/outputs/visuals/cover-<desc>.png and add "
                    "`sophia-cover: /mnt/user-data/outputs/visuals/cover-<desc>.png` "
                    "to the Markdown frontmatter — the renderer places that current "
                    "source cover on the title page"
                )
                subject = "cover"
            else:
                if _deck_build_service_route_active(state):
                    wiring = "call prepare_deck_build with a complete creative_plan, deck_stylesheet, and slide html_body; declare generated assets only in creative_plan.image_assets"
                else:
                    wiring = "save it as /mnt/user-data/outputs/assets/slide-01.png, embed it in your first slide's HTML by the relative path ../assets/slide-01.png, then call build_deck_from_slides"
                subject = "hero"
            if requested_ext == "pptx" and _deck_build_service_route_active(state):
                return (
                    "Error: emit_builder_artifact rejected — generated imagery is ON for "
                    f"this build but no generated {subject} image succeeded. Do this now: "
                    f"{wiring}. If DeckBuildService cannot produce selected generated assets, emit "
                    "artifact_path=null with its returned failure code and summary."
                )
            return (
                "Error: emit_builder_artifact rejected — generated imagery is ON for "
                f"this build but no generated {subject} image succeeded. Do this now: "
                "(1) run `python /mnt/skills/public/image-generation/scripts/generate.py "
                "--preflight` — if it fails, just emit again (the skip is recorded "
                "honestly); (2) on preflight ok, write a prompt JSON for ONE 16:9 "
                f"{subject} image per the image-generation skill's Business Deck "
                f"section, generate it, {wiring}; (3) emit the regenerated deliverable."
            )
        return ""

    @staticmethod
    def _report_visual_grammar_rejection_message(state: BuilderArtifactState) -> str:
        problems = _report_visual_grammar_problems(state)
        if not problems:
            return ""
        listing = "\n".join(f"- {problem}" for problem in problems[:8])
        counts = _visual_grammar_counts(state)
        counts_text = ", ".join(f"{name}={count}" for name, count in counts.items()) or "none"
        return (
            "Error: emit_builder_artifact rejected — the PDF report visual grammar is too repetitive:\n"
            f"{listing}\n\n"
            f"Current grammar counts: {counts_text}. Regenerate or replace figures so the final "
            "report uses at least two distinct successful visual grammars. For reports with four "
            "or more figures, no single grammar may account for more than 50% of embedded figures. "
            "Draw distinct inline-`<svg>` figure families (bar/line/column charts, box-and-arrow "
            "flow, comparison, mind-map) deliberately, then re-render via render_html_to_pdf and "
            "emit only the primary PDF."
        )

    @staticmethod
    def _visual_presence_rejection_message(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        if _visuals_requested(state) and not _visual_presence_validated(artifact_args, state):
            asset_paths = [path for path in _visual_asset_paths(state) if path.endswith(".png")]
            if asset_paths:
                asset_listing = ", ".join(asset_paths[:6])
                requested_ext = _requested_artifact_ext(state)
                if requested_ext == "pptx":
                    embed_hint = (
                        "For fresh decks, rebuild through `prepare_deck_build` so the harness renders the slide templates and references the generated visuals."
                        if _deck_build_service_route_active(state)
                        else ("Embed each generated PNG in its slide HTML under `/mnt/user-data/outputs/slides/` by a relative `../assets/<file>` path, then call `build_deck_from_slides` to rebuild the deck.")
                    )
                elif requested_ext == "pdf":
                    embed_hint = 'Reference them from the HTML source with `<img src="visuals/<name>.png">` (or an absolute /mnt/user-data/outputs/visuals/<name>.png path), re-run render_html_to_pdf, and emit the regenerated .pdf.'
                else:
                    embed_hint = "Embed or reference them before emitting."
                return f"Error: emit_builder_artifact rejected — the user requested charts, diagrams, or visuals, but the artifact does not embed any. You have ALREADY generated these visual assets: {asset_listing}. {embed_hint}"
            return (
                "Error: emit_builder_artifact rejected — the user requested charts, "
                "diagrams, or visuals, but the artifact does not contain verified "
                "visual evidence yet. Read /mnt/skills/public/visual-design/SKILL.md "
                "if you have not already, create a local visual under "
                "/mnt/user-data/outputs/visuals/ with the medium-appropriate path "
                "(a visual-area image inside an HTML slide, hard-data chart, report "
                "diagram, or inline SVG in HTML), then embed or reference it before emitting."
            )
        return ""

    @staticmethod
    def _pdf_request_rejection_message(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        if _requested_pdf_artifact(state):
            primary = artifact_args.get("artifact_path")
            reason = _pdf_artifact_path_rejection_reason(primary, state)
            if reason is not None:
                if reason == "pdf_fallback_before_render_attempt":
                    return "Error: emit_builder_artifact rejected — this is a PDF request, so you must attempt render_html_to_pdf before emitting. Fix the HTML source if needed and render the real .pdf."
                if reason == "pdf_fallback_when_valid_pdf_exists":
                    return "Error: emit_builder_artifact rejected — this is a PDF request and a valid rendered .pdf already exists. Emit the rendered .pdf instead of a .md/.html fallback."
                return (
                    "Error: emit_builder_artifact rejected — this is a PDF request. "
                    "The final artifact must be a real .pdf rendered via "
                    "render_html_to_pdf. Do not emit Python files, generator "
                    "scripts, bare paths, or files outside /mnt/user-data/outputs/ "
                    "as the user-ready artifact."
                )
        return ""

    @staticmethod
    def _pptx_request_rejection_message(state: BuilderArtifactState) -> str:
        if _requested_pptx_artifact(state):
            return (
                "Error: emit_builder_artifact rejected — this is a slide-deck "
                "request. The normal final artifact must be a structurally valid "
                ".pptx PowerPoint package under /mnt/user-data/outputs/. A .md/.html "
                "fallback is allowed only after the ppt-generation compiler has been attempted, "
                "no valid deck exists, and the fallback is marked with "
                "requested_artifact_ext='pptx', artifact_is_fallback=true, and a "
                "safe fallback_reason. Do not emit Python files, placeholder decks, "
                "tiny/corrupt .pptx files, bare paths, or files outside outputs."
            )
        return ""

    @staticmethod
    def _html_request_rejection_message(state: BuilderArtifactState) -> str:
        if _requested_html_artifact(state):
            return (
                "Error: emit_builder_artifact rejected — this is an HTML request. "
                "The final artifact must be a complete standalone .html/.htm file "
                "under /mnt/user-data/outputs/ with <!doctype html>, <html>, "
                "<head>, and <body>. Do not emit Markdown, code fences, escaped "
                "HTML text, generator scripts, bare paths, or files outside outputs "
                "as the user-ready HTML artifact."
            )
        return ""

    @classmethod
    def _missing_artifact_rejection_message(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        recovery_hint = cls._missing_artifact_recovery_hint(artifact_args, state)
        return (
            "Error: emit_builder_artifact rejected — the referenced "
            f"artifact file ({artifact_args.get('artifact_path')}) does not exist "
            "on disk or in remote storage. Please write the file first, "
            "then call emit_builder_artifact again."
            f"{recovery_hint}"
        )

    @classmethod
    def _recover_emit_args_from_last_write(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        recovered_path = cls._preferred_successful_pdf_render_path(state, runtime) or cls._preferred_successful_deliverable_path(state, runtime)
        if not recovered_path:
            return None
        recovered_args = dict(artifact_args)
        recovered_args["artifact_path"] = recovered_path
        if not cls._artifact_files_exist(recovered_args, state, runtime):
            return None
        logger.warning(
            "BuilderArtifact: emit_path_missing recovered_from_last_successful_write ext=%s",
            Path(recovered_path).suffix.lower().lstrip(".") or None,
        )
        return recovered_args

    @classmethod
    def _recover_emit_args_from_output_scan(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        try:
            candidates = cls._promotable_output_candidates(
                state,
                requested_pdf=_requested_pdf_artifact(state),
                requested_pptx=_requested_pptx_artifact(state),
                requested_html=_requested_html_artifact(state),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: emit_path_missing output_scan_failed reason=%s error=%s",
                reason,
                exc,
            )
            return None
        if not candidates:
            logger.info(
                "BuilderArtifact: emit_path_missing output_scan_empty reason=%s requested_ext=%s",
                reason,
                _requested_artifact_ext(state),
            )
            return None
        for candidate in candidates[:5]:
            recovered_path = cls._virtual_output_path(candidate, state)
            recovered_args = dict(artifact_args)
            recovered_args["artifact_path"] = recovered_path
            if cls._artifact_files_exist(recovered_args, state, runtime):
                logger.warning(
                    "BuilderArtifact: emit_path_missing recovered_from_output_scan reason=%s path=%s ext=%s",
                    reason,
                    recovered_path,
                    candidate.suffix.lower().lstrip(".") or None,
                )
                return recovered_args
        logger.info(
            "BuilderArtifact: emit_path_missing output_scan_no_valid_candidate reason=%s candidates=%d",
            reason,
            len(candidates),
        )
        return None

    @classmethod
    def _authoritative_pdf_emit_args(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        pdf_path = cls._preferred_successful_pdf_render_path(state, runtime)
        if not pdf_path:
            return None
        current_path = _canonical_outputs_artifact_path(artifact_args.get("artifact_path"))
        current_ext = _artifact_ext_from_path(current_path or artifact_args.get("artifact_path"))
        if current_path == pdf_path and current_ext == "pdf":
            return None
        authoritative_args = dict(artifact_args)
        authoritative_args["artifact_path"] = pdf_path
        authoritative_args["requested_artifact_ext"] = "pdf"
        authoritative_args["artifact_ext"] = "pdf"
        authoritative_args["artifact_is_fallback"] = False
        authoritative_args["fallback_reason"] = None
        authoritative_args["artifact_type"] = "pdf"
        logger.warning(
            "BuilderArtifact: pdf_emit_overrode_stale_fallback requested_ext=pdf emitted_ext=%s layout_quality=%s",
            current_ext,
            _pdf_render_layout_quality(state),
        )
        return authoritative_args

    @classmethod
    def _authoritative_pptx_emit_args(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Deck (.pptx) analog of ``_authoritative_pdf_emit_args``.

        The deck compile step has no documented output-path contract, so the
        model often writes the .pptx under an off-target name (e.g. ``t.pptx``)
        while emitting the slug target path — the emit gate then rejects a
        validly-compiled deck as "missing" (prod 2026-06-26, run 019f0178).
        When a valid .pptx exists under outputs/ and the emitted path is NOT a
        usable .pptx, repoint the emit at the real deck rather than reject it —
        the same "a delivered artifact in the requested format is never a
        fallback" invariant the PDF path enforces.
        """
        if not _requested_pptx_artifact(state):
            return None
        # Don't override a validly-emitted deck with a different on-disk .pptx;
        # only act when the emitted path is missing or a non-pptx fallback.
        if cls._artifact_files_exist(artifact_args, state, runtime):
            emitted_ext = _artifact_ext_from_path(artifact_args.get("artifact_path"))
            if emitted_ext == "pptx":
                return None
        pptx_path = cls._preferred_valid_pptx_output_path(state, runtime)
        if not pptx_path:
            return None
        current_path = _canonical_outputs_artifact_path(artifact_args.get("artifact_path"))
        current_ext = _artifact_ext_from_path(current_path or artifact_args.get("artifact_path"))
        if current_path == pptx_path and current_ext == "pptx":
            return None
        authoritative_args = dict(artifact_args)
        authoritative_args["artifact_path"] = pptx_path
        authoritative_args["requested_artifact_ext"] = "pptx"
        authoritative_args["artifact_ext"] = "pptx"
        authoritative_args["artifact_is_fallback"] = False
        authoritative_args["fallback_reason"] = None
        authoritative_args["artifact_type"] = "presentation"
        logger.warning(
            "BuilderArtifact: pptx_emit_repointed_to_compiled_deck emitted_ext=%s emitted_path=%s -> pptx_path=%s",
            current_ext,
            current_path,
            pptx_path,
        )
        return authoritative_args

    @classmethod
    def _preferred_valid_pptx_output_path(
        cls,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if not _requested_pptx_artifact(state):
            return None
        promoted, ext = cls._promoted_deliverable_from_outputs(
            state,
            requested_pdf=False,
            requested_pptx=True,
            requested_html=False,
            reason="authoritative_pptx_emit",
        )
        if not promoted or ext != "pptx":
            return None
        if cls._artifact_files_exist({"artifact_path": promoted}, state, runtime):
            return promoted
        return None

    @classmethod
    def _preferred_successful_pdf_render_path(
        cls,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if not _requested_pdf_artifact(state) or not _successful_pdf_ready_to_emit(state):
            return None
        result = _successful_pdf_render_result(state)
        if result is None:
            return None
        pdf_path = _canonical_outputs_artifact_path(result.get("pdf_path"))
        if pdf_path is None:
            return None
        if cls._artifact_files_exist({"artifact_path": pdf_path}, state, runtime):
            return pdf_path
        return None

    @staticmethod
    def _successful_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        return [path for path in (diagnostics.get("successful_output_paths") or []) if isinstance(path, str) and _extract_output_relative_path(path) is not None]

    @staticmethod
    def _successful_deliverable_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        explicit = [path for path in (diagnostics.get("successful_deliverable_output_paths") or []) if isinstance(path, str) and _is_user_facing_output_path(path)]
        if explicit:
            return explicit
        return [path for path in BuilderArtifactMiddleware._successful_output_paths(state) if _is_user_facing_output_path(path)]

    @staticmethod
    def _target_artifact_path(state: BuilderArtifactState) -> str | None:
        target = state.get("builder_artifact_target_path")
        if isinstance(target, str) and _extract_output_relative_path(target) is not None:
            return target
        delegation = state.get("delegation_context")
        if isinstance(delegation, dict):
            delegated = delegation.get("artifact_target_path")
            if isinstance(delegated, str) and _extract_output_relative_path(delegated) is not None:
                return delegated
        return None

    @classmethod
    def _preferred_successful_deliverable_path(
        cls,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        paths = cls._allowed_successful_deliverable_paths(state)
        diagnostics = state.get("builder_write_diagnostics") or {}
        target_path = cls._target_artifact_path(state)
        target_match = cls._preferred_target_deliverable_path(target_path, paths, state, runtime)
        if target_match is not None:
            return target_match

        target_suffix = Path(target_path or "").suffix.lower()
        matching = [path for path in paths if not target_suffix or Path(path).suffix.lower() == target_suffix]
        if len(matching) == 1:
            return matching[0]

        last_successful = cls._last_successful_deliverable_path(diagnostics)
        last_match = cls._preferred_last_successful_path(
            last_successful,
            paths=paths,
            matching=matching,
        )
        if last_match is not None:
            return last_match

        if len(paths) == 1:
            return paths[0]
        return None

    @classmethod
    def _allowed_successful_deliverable_paths(cls, state: BuilderArtifactState) -> list[str]:
        paths = cls._successful_deliverable_output_paths(state)
        if _requested_pdf_artifact(state):
            return [path for path in paths if PurePosixPath(path).suffix.lower() in _allowed_pdf_artifact_suffixes(state)]
        if _requested_pptx_artifact(state):
            return [path for path in paths if PurePosixPath(path).suffix.lower() in _allowed_pptx_artifact_suffixes(state)]
        if _requested_html_artifact(state):
            return [path for path in paths if PurePosixPath(path).suffix.lower() in _HTML_ARTIFACT_SUFFIXES]
        return paths

    @classmethod
    def _preferred_target_deliverable_path(
        cls,
        target_path: str | None,
        paths: list[str],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if not target_path or not _is_user_facing_output_path(target_path):
            return None
        target_args = {"artifact_path": target_path}
        if target_path in paths or cls._artifact_files_exist(target_args, state, runtime):
            return target_path
        return None

    @staticmethod
    def _last_successful_deliverable_path(diagnostics: object) -> str | None:
        if not isinstance(diagnostics, dict):
            return None
        path = diagnostics.get("last_successful_deliverable_output_path")
        return path if isinstance(path, str) else None

    @staticmethod
    def _preferred_last_successful_path(
        last_successful: str | None,
        *,
        paths: list[str],
        matching: list[str],
    ) -> str | None:
        if last_successful is None:
            return None
        if last_successful in matching:
            return last_successful
        if not matching and last_successful in paths:
            return last_successful
        return None

    @staticmethod
    def _build_recovered_artifact_result(
        artifact_path: str,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        artifact_type = Path(artifact_path).suffix.lower().lstrip(".") or "unknown"
        logger.warning(
            "BuilderArtifact: promoting recovered deliverable reason=%s ext=%s",
            reason,
            artifact_type or None,
        )
        return {
            "artifact_path": artifact_path,
            "artifact_type": artifact_type,
            "artifact_title": "Build task completed (recovered)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder wrote a deliverable but did not emit it cleanly, so I recovered the completed file from the output directory."),
            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
            "user_next_action": "Open the file and let me know if it lands.",
            "confidence": 0.55,
        }

    @classmethod
    def _recover_missing_emit_args_if_possible(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any]:
        authoritative_pdf = cls._authoritative_pdf_emit_args(artifact_args, state, runtime)
        if authoritative_pdf is not None:
            return authoritative_pdf
        authoritative_pptx = cls._authoritative_pptx_emit_args(artifact_args, state, runtime)
        if authoritative_pptx is not None:
            return authoritative_pptx
        if cls._artifact_files_exist(artifact_args, state, runtime):
            return artifact_args
        return (
            cls._recover_emit_args_from_last_write(artifact_args, state, runtime)
            or cls._recover_emit_args_from_output_scan(
                artifact_args,
                state,
                runtime,
                reason="after_model_missing_emit_path",
            )
            or artifact_args
        )

    def _force_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Three-stage forced-tool-choice (PR-A + PR-B) with wall-clock awareness.

        Activates when EITHER the turn-count ceiling is imminent
        (``_should_force_emit``) OR the wall-clock fraction of the per-run
        timeout has been crossed (``_should_force_emit_by_clock``). The
        stage selection within the force window is what changed in PR-B
        for binary deliverables that have written a generator but failed
        to produce the final binary.

        Returns the Anthropic ``tool_choice`` payload appropriate for the
        current state:

        - ``None`` when forcing isn't required yet.
        - ``{"type": "tool", "name": "emit_builder_artifact"}`` when a
          user-facing binary already exists on disk — proceed with emit.
        - ``{"type": "tool", "name": "bash"}`` (PR-B) when no binary exists
          but a ``_generate_*.py`` does — recovery for binary deliverables
          is to RUN the generator, not write yet another one. After this
          forced bash either produces a binary (next turn flips to emit)
          or doesn't (hard-ceiling fallback promotes the script itself).
        - ``{"type": "tool", "name": "write_file"}`` when neither a binary
          nor a generator exists — the model has produced nothing on disk
          and needs to land at least one file before emit is forced.
        """
        choice, _update = self._force_choice_plan_for_state(state, runtime)
        return choice

    def _force_choice_plan_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if state.get("builder_deck_prepare_phase") == "retry_pending":
            logger.warning("BuilderArtifact: forcing tool_choice=prepare_deck_build (reason=deck_prepare_retry_pending)")
            return self._forced_prepare_deck_build_tool_choice(), None

        presentation_plan = self._presentation_phase_force_choice_plan(state)
        if presentation_plan is not None:
            return presentation_plan

        choice = self._pdf_terminal_tool_choice_for_state(state) or self._simple_pdf_tool_choice_for_state(state) or self._research_tool_choice_for_state(state)
        if choice is not None:
            return choice, None

        pptx_compile_choice = self._pptx_compile_tool_choice_for_state(state)
        if pptx_compile_choice is not None:
            return pptx_compile_choice, {
                "builder_pptx_compile_latch_pending": True,
                "builder_pptx_diagnostics": _pptx_latch_diagnostics_update(
                    state,
                    compile_forced=True,
                ),
            }

        visual_choice = self._visual_tool_choice_for_state(state)
        if visual_choice is not None:
            return visual_choice, {
                "builder_visual_force_count": _builder_visual_force_count(state) + 1,
            }

        choice = self._pdf_render_source_tool_choice_for_state(state)
        if choice is not None:
            return choice, None
        choice = self._completion_tool_choice_for_state(state, runtime)
        if choice is not None:
            update = None
            if state.get("builder_presentation_terminal_ready") is True:
                update = {
                    "builder_pptx_diagnostics": _pptx_terminal_ready_diagnostics_update(state),
                }
            return choice, update
        return None, None

    def _presentation_phase_force_choice_plan(
        self,
        state: BuilderArtifactState,
    ) -> tuple[dict[str, Any], dict[str, Any] | None] | None:
        if not _deck_build_service_route_active(state):
            return None
        presentation_phase = str(state.get("builder_presentation_phase") or "")
        if presentation_phase == "preflight_pending":
            tool_name = self._presentation_preflight_tool_name(state)
            logger.info("BuilderArtifact: forcing bounded presentation preflight tool=%s", tool_name)
            choice = self._forced_fetch_tool_choice() if tool_name == "builder_web_fetch" else self._forced_search_tool_choice()
            return choice, {
                "builder_presentation_phase": "preflight_call_emitted",
                "builder_presentation_preflight_started_at_ms": int(
                    state.get("builder_presentation_preflight_started_at_ms") or time.time() * 1_000
                ),
                "builder_pptx_diagnostics": {"presentation_preflight_status": "running"},
            }
        if presentation_phase == "authoring_pending":
            elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state)
            force_reason = str(_pptx_diagnostics(state).get("prepare_force_reason") or "bounded_preflight_complete")
            logger.warning(
                "BuilderArtifact: forcing tool_choice=prepare_deck_build (reason=%s phase=%s elapsed_ms=%s)",
                force_reason,
                presentation_phase,
                elapsed_ms,
            )
            return self._forced_prepare_deck_build_tool_choice(), {
                "builder_deck_prepare_latch_active": True,
                "builder_pptx_diagnostics": {
                    "prepare_forced_count": 1,
                    "prepare_latch_activated_at_turn": _builder_current_turn_index(state),
                    "prepare_force_reason": force_reason,
                    "deck_authoring_elapsed_ms": elapsed_ms,
                },
            }
        if not self._deck_prepare_force_due(state):
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=prepare_deck_build (reason=presentation_prepare_latch turn=%d elapsed_ms=%s)",
            _builder_current_turn_index(state),
            _elapsed_since_presentation_authoring_start_ms(state),
        )
        update: dict[str, Any] | None = None
        if not state.get("builder_deck_prepare_latch_active"):
            elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state)
            force_reason = "turn_limit" if _builder_current_turn_index(state) >= prepare_force_at_turn(state) else "authoring_clock"
            update = {
                "builder_deck_prepare_latch_active": True,
                "builder_presentation_phase": "authoring_pending",
                "builder_pptx_diagnostics": {
                    "prepare_forced_count": 1,
                    "prepare_latch_activated_at_turn": _builder_current_turn_index(state),
                    "prepare_force_reason": force_reason,
                    "deck_authoring_elapsed_ms": elapsed_ms,
                },
            }
        return self._forced_prepare_deck_build_tool_choice(), update

    @staticmethod
    def _command_with_merged_update(command: Command | None, update: dict[str, Any]) -> Command:
        if command is None:
            return Command(update=update)
        command_update = command.update
        if isinstance(command_update, dict):
            command_update = {**command_update, **update}
        elif command_update is None:
            command_update = update
        else:
            command_update = update
        return Command(
            graph=command.graph,
            update=command_update,
            resume=command.resume,
            goto=command.goto,
        )

    @classmethod
    def _model_result_with_state_update(cls, result: Any, update: dict[str, Any] | None) -> Any:
        if not update:
            return result
        if isinstance(result, ExtendedModelResponse):
            return ExtendedModelResponse(
                model_response=result.model_response,
                command=cls._command_with_merged_update(result.command, update),
            )
        if isinstance(result, ModelResponse):
            return ExtendedModelResponse(
                model_response=result,
                command=Command(update=update),
            )
        if isinstance(result, Command):
            return cls._command_with_merged_update(result, update)
        if isinstance(result, AIMessage):
            return Command(update={"messages": [result], **update})
        return result

    def _simple_pdf_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_simple_pdf_artifact(state):
            return None
        if _simple_pdf_writer_attempted(state) or self._has_requested_pdf_binary(state):
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=%s for simple PDF artifact path",
            _SIMPLE_PDF_TOOL_NAME,
        )
        return self._forced_simple_pdf_tool_choice()

    def _pptx_compile_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if state.get("builder_pptx_compile_repair_pending"):
            return None
        if state.get("builder_pptx_terminal_quality_failed"):
            return None
        # Force the deterministic HTML-slide compile (build_deck_from_slides) once
        # all slide HTML exists. Image batch/repair discipline is enforced before
        # this point; compile should not be used as a substitute for serial repair.
        # Restored 2026-06-29 (Codex P2): the hook returned None, so a run that
        # authored slides but skipped the compile call could ignore the one-shot
        # latch message and fall through to the ceiling without a deck.
        if not _pptx_compile_ready(state):
            if _requested_pptx_artifact(state) and _pptx_slide_html_ready(state) and not _pptx_generated_visuals_complete(state):
                _trace_pptx_compile_decision(
                    state=state,
                    decision="compile_latch_blocked",
                    reason="generated_visuals_incomplete",
                    outputs=_pptx_visual_completeness_counts(state),
                )
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=build_deck_from_slides (slide_html_count=%d target_slide_count=%d)",
            _pptx_slide_html_count(state),
            _pptx_latch_target_slide_count(state),
        )
        return self._forced_deck_build_tool_choice()

    def _pdf_terminal_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or not _successful_pdf_ready_to_emit(state):
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=emit_builder_artifact after successful PDF render (layout_quality=%s repair_attempts=%d)",
            _pdf_render_layout_quality(state),
            _pdf_layout_repair_attempts(state),
        )
        return self._forced_tool_choice()

    def _pdf_render_source_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if self._has_requested_pdf_binary(state):
            return None
        # A closed HTML file is only a draft until the model deliberately calls
        # render_html_to_pdf. Force rendering solely in the completion window;
        # this prevents an early write from becoming the final report.
        if not self._should_force_emit(state):
            return None
        if _pdf_render_attempted(state) and state.get("builder_pdf_phase") != "ready_to_render":
            return None
        source_path = _preferred_pdf_render_source_path(state)
        if not source_path:
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=render_html_to_pdf because PDF source exists before render source_ext=%s",
            PurePosixPath(source_path).suffix.lower().lstrip(".") or None,
        )
        return self._forced_pdf_render_tool_choice()

    # Phase 2F.3: after N consecutive write_file_tool errors, inject a
    # corrective HumanMessage so the model breaks out of the loop and
    # writes to the canonical /mnt/user-data/outputs/ path. The threshold
    # is intentionally tight (3) so we recover fast; idempotency is
    # tracked via ``builder_path_correction_emitted`` in state.
    _PATH_CORRECTION_ERROR_THRESHOLD = 3
    _PATH_CORRECTION_LOOKBACK = 8  # cap scan range so we don't walk huge histories

    @staticmethod
    def _count_trailing_write_file_errors(messages: list, lookback: int) -> int:
        """Count trailing ToolMessages from write_file_tool whose content
        starts with "Error". Stops at the first non-error / non-write_file
        ToolMessage so we only count an UNBROKEN trailing streak.

        Other message types (AIMessage, HumanMessage) between the
        trailing tool results are tolerated — we walk backwards through
        the most recent ToolMessages, ignoring intervening ai/human msgs,
        and count only the consecutive write_file ones.
        """
        count = 0
        scanned = 0
        for msg in reversed(messages):
            scanned += 1
            if scanned > lookback:
                break
            if not isinstance(msg, ToolMessage):
                continue
            name = getattr(msg, "name", None) or ""
            if name not in ("write_file", "write_file_tool"):
                # Non-write_file tool result — streak broken.
                return count
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.startswith("Error"):
                count += 1
            else:
                return count
        return count

    @classmethod
    def _trailing_write_file_error_classes(
        cls,
        messages: list,
        lookback: int,
    ) -> list[str]:
        classes: list[str] = []
        scanned = 0
        for msg in reversed(messages):
            scanned += 1
            if scanned > lookback:
                break
            if not isinstance(msg, ToolMessage):
                continue
            name = getattr(msg, "name", None) or ""
            if name not in ("write_file", "write_file_tool"):
                return classes
            text = cls._tool_message_text(msg)
            if text.startswith("Error"):
                classes.append(cls._classify_write_error(text, under_outputs=None))
            else:
                return classes
        return classes

    @staticmethod
    def _tool_message_content_shape(result: ToolMessage) -> str:
        content = result.content
        if isinstance(content, str):
            return "text"
        if isinstance(content, list):
            return "list"
        if isinstance(content, dict):
            return "dict"
        if content is None:
            return "none"
        return type(content).__name__

    @staticmethod
    def _classify_write_error(text: str, under_outputs: bool | None) -> str:
        if not text.startswith("Error"):
            return ""
        lowered = text.lower()
        if "field required" in lowered and any(field in lowered for field in ("description", "path", "content", "command")):
            return "missing_required_tool_arg"
        for error_class, markers in _WRITE_ERROR_CLASS_MARKERS:
            if any(marker in lowered for marker in markers):
                return error_class
        if under_outputs is False:
            return "path_not_outputs"
        return "write_tool_error"

    @staticmethod
    def _is_runtime_write_failure(error_class: str | None) -> bool:
        return bool(error_class and error_class in _RUNTIME_WRITE_ERROR_CLASSES)

    @staticmethod
    def _is_path_correctable_write_failure(error_class: str | None) -> bool:
        return not error_class or error_class in _PATH_CORRECTABLE_WRITE_ERROR_CLASSES

    def _write_runtime_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any]:
        logger.error(
            "[BuilderArtifact] %d consecutive write_file_tool runtime errors detected; stopping build instead of path-correcting error_class=%s",
            count,
            error_class,
        )
        fallback = self._build_ceiling_fallback(
            state,
            steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
            reason=f"runtime_write_failure:{error_class}",
        )
        status = "failed" if not fallback.get("artifact_path") else "completed"
        if runtime is not None:
            self._upload_fallback_and_fire(
                state=state,
                runtime=runtime,
                fallback=fallback,
                status=status,
            )
        return {
            "builder_result": fallback,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_last_missing_emit_path": None,
            "builder_consecutive_missing_emit_path_rejections": 0,
            "builder_runtime_write_failure_emitted": True,
            **_terminal_halt_fields(state, "runtime_write_failure"),
            "jump_to": "end",
        }

    def _recovered_deliverable_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        artifact_path: str,
        reason: str,
    ) -> dict[str, Any]:
        fallback = self._build_recovered_artifact_result(
            artifact_path,
            steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
            reason=reason,
        )
        _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed" if _requested_pptx_artifact(state) else reason,
        )
        if runtime is not None:
            self._upload_fallback_and_fire(
                state=state,
                runtime=runtime,
                fallback=fallback,
                status="completed",
            )
        return {
            "builder_result": fallback,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_last_missing_emit_path": None,
            "builder_consecutive_missing_emit_path_rejections": 0,
            "builder_recovered_deliverable_emitted": True,
            **_terminal_halt_fields(state, "recovered_deliverable"),
            "jump_to": "end",
        }

    def _maybe_promote_recovered_deliverable(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if not self._should_attempt_recovered_deliverable_promotion(state, runtime):
            return None
        candidate = self._preferred_successful_deliverable_path(state, runtime)
        if not candidate:
            return None
        if not self._artifact_files_exist({"artifact_path": candidate}, state, runtime):
            return None
        return self._recovered_deliverable_update(
            state,
            runtime,
            artifact_path=candidate,
            reason=reason,
        )

    def _should_attempt_recovered_deliverable_promotion(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
    ) -> bool:
        if state.get("builder_recovered_deliverable_emitted") or runtime is None:
            return False
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict) or diagnostics.get("last_status") != "success":
            return False
        return self._write_error_threshold_reached(state, diagnostics)

    def _write_error_threshold_reached(
        self,
        state: BuilderArtifactState,
        diagnostics: dict,
    ) -> bool:
        error_count = int(diagnostics.get("error_count", 0) or 0)
        had_correction = bool(state.get("builder_path_correction_emitted") or state.get("builder_tool_argument_correction_emitted"))
        return error_count >= self._PATH_CORRECTION_ERROR_THRESHOLD or had_correction

    @staticmethod
    def _last_ai_truncated(state: BuilderArtifactState) -> bool:
        """True when the most recent AIMessage stopped at the output cap.

        Prod 2026-06-11 (F1): a complete HTML document in ONE write_file call
        overran max_tokens; the truncated tool-call JSON parsed with missing
        args. langchain-anthropic carries the provider stop reason in
        ``response_metadata`` on the merged streamed message.
        """
        for msg in reversed(state.get("messages", []) or []):
            if getattr(msg, "type", None) != "ai":
                continue
            metadata = getattr(msg, "response_metadata", None) or {}
            stop_reason = metadata.get("stop_reason") or (getattr(msg, "additional_kwargs", None) or {}).get("stop_reason")
            return stop_reason == "max_tokens"
        return False

    def _truncation_correction_update(
        self,
        state: BuilderArtifactState,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any] | None:
        """One chunking-specific correction when missing args came from truncation.

        The generic tool-argument correction tells the model to fix its
        arguments — useless when the real cause is the output cap, because
        the retry truncates identically. Granted once, BEFORE the generic
        correction/stop ladder.
        """
        if state.get("builder_truncation_correction_emitted"):
            return None
        if not self._last_ai_truncated(state):
            return None
        logger.warning(
            "[BuilderArtifact] write_file missing-arg errors caused by max_tokens truncation — injecting chunking correction count=%d error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/output-truncation correction]\n"
                "Your last tool call was cut off by the output token limit — the "
                "document is too large for a single write_file call. Do NOT retry "
                "the same single-call write.\n\n"
                "Write the file in CHUNKS to the SAME path instead:\n"
                "1. First call: the opening of the document (for HTML: doctype, "
                "<head> with styles, and the first body section) with "
                "append=False.\n"
                "2. Each following call: the next section (~200-300 lines max) "
                "with append=True.\n"
                "3. Final call appends the closing tags, then verify with ls_tool "
                "and call emit_builder_artifact.\n"
                "Keep every individual write_file call comfortably small."
            )
        )
        return {
            "messages": [correction],
            "builder_truncation_correction_emitted": True,
        }

    def _write_tool_argument_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any] | None:
        candidate = self._preferred_successful_deliverable_path(state, runtime) if runtime is not None else None
        if candidate and self._artifact_files_exist({"artifact_path": candidate}, state, runtime):
            return self._recovered_deliverable_update(
                state,
                runtime,
                artifact_path=candidate,
                reason=error_class,
            )

        truncation_update = self._truncation_correction_update(state, count=count, error_class=error_class)
        if truncation_update is not None:
            return truncation_update

        if state.get("builder_tool_argument_correction_emitted"):
            logger.error(
                "[BuilderArtifact] repeated missing required tool arguments after correction; stopping build count=%d error_class=%s",
                count,
                error_class,
            )
            fallback = self._build_ceiling_fallback(
                state,
                steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
                reason=f"repeated_{error_class}",
            )
            status = "failed" if not fallback.get("artifact_path") else "completed"
            if runtime is not None:
                self._upload_fallback_and_fire(
                    state=state,
                    runtime=runtime,
                    fallback=fallback,
                    status=status,
                )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                "builder_tool_argument_correction_emitted": True,
                **_terminal_halt_fields(state, "tool_argument_failure"),
                "jump_to": "end",
            }

        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool missing-argument errors detected — injecting tool-argument correction instead of path correction. error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/tool-argument correction]\n"
                "Your recent tool call was missing required arguments. "
                "Do not retry the same incomplete call.\n\n"
                "For text deliverables, call the exposed `write_file` tool with "
                "`description`, `path`, and `content` arguments, for example "
                "`write_file(description='write the final report', "
                "path='/mnt/user-data/outputs/report.html', "
                "content='<html>...</html>', append=False)`. If the document is "
                "long, write it in chunks to the same path (first call "
                "append=False, following calls append=True) so no single call "
                "is oversized. For shell work, call `bash_tool` with a "
                "non-empty `command` argument.\n\n"
                "If you have already written the final file under "
                "`/mnt/user-data/outputs/`, call `emit_builder_artifact` with "
                "that exact path and stop."
            )
        )
        return {
            "messages": [correction],
            "builder_tool_argument_correction_emitted": True,
        }

    def _maybe_inject_path_correction(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Phase 2F.3: detect ``write_file_tool`` error loops and inject a
        single corrective HumanMessage so the model recovers.

        Production failure 2026-05-22 19:54-20:14 UTC: builder spent 20+
        minutes retrying write_file_tool with bare filenames (test.md,
        test2.md, etc.), each rejected with PermissionError. The model
        kept retrying with similar bad names. Phase 2F.2 fixes the bare-
        filename case via auto-prefix; Phase 2F.3 is the defensive
        escape hatch for any residual write_file-error loop.

        Idempotent: once we emit the correction (tracked via
        ``builder_path_correction_emitted``), don't emit again on this
        run. The model has already been told; further repetition adds
        noise without value.
        """
        if state.get("builder_path_correction_emitted"):
            return None
        messages = state.get("messages") or []
        count = self._count_trailing_write_file_errors(messages, self._PATH_CORRECTION_LOOKBACK)
        if count < self._PATH_CORRECTION_ERROR_THRESHOLD:
            return None
        error_class = self._write_error_class_from_state(state, messages)
        if self._is_runtime_write_failure(error_class):
            if state.get("builder_runtime_write_failure_emitted"):
                return None
            return self._write_runtime_failure_update(
                state,
                runtime,
                count=count,
                error_class=error_class,
            )
        if error_class == "missing_required_tool_arg":
            return self._write_tool_argument_failure_update(
                state,
                runtime,
                count=count,
                error_class=error_class,
            )
        if not self._is_path_correctable_write_failure(error_class):
            return None
        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool errors detected — injecting path-correction directive (Phase 2F.3 escape hatch). error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/path-correction directive]\n"
                f"Your last {count} write_file calls all failed with "
                "errors. This usually means the path you used is not under "
                "/mnt/user-data/outputs/.\n\n"
                "STOP retrying with the same kind of path. Your NEXT "
                "`write_file` call MUST include `description`, `path`, and "
                "`content`, and the path MUST start with "
                "`/mnt/user-data/outputs/`, e.g. "
                "`write_file(description='write final document', "
                "path='/mnt/user-data/outputs/my-document.md', content='...', "
                "append=False)`. If you only had a "
                "bare filename like `report.md`, prepend "
                "`/mnt/user-data/outputs/` to it.\n\n"
                "After the file is on disk under /mnt/user-data/outputs/, "
                "call emit_builder_artifact with that exact path to deliver "
                "the artifact and end this run."
            )
        )
        return {
            "messages": [correction],
            "builder_path_correction_emitted": True,
        }

    def _write_error_class_from_state(
        self,
        state: BuilderArtifactState,
        messages: list,
    ) -> str:
        diagnostics = state.get("builder_write_diagnostics") or {}
        error_class = diagnostics.get("last_error_class") if isinstance(diagnostics, dict) else None
        if isinstance(error_class, str) and error_class:
            return error_class
        classes = self._trailing_write_file_error_classes(
            messages,
            self._PATH_CORRECTION_LOOKBACK,
        )
        return classes[0] if classes else "write_tool_error"

    @staticmethod
    def _is_post_interrupt_update(messages: list) -> bool:
        """Detect whether the latest HumanMessage in ``messages`` arrived
        AFTER the builder had already started working — the signal that
        ``update_async_task`` interrupted an in-flight run and appended a
        new user message via deepagents' ``multitask_strategy="interrupt"``.

        Heuristic: the latest message is a ``HumanMessage`` AND somewhere
        earlier in the conversation there is an ``AIMessage`` carrying
        ``tool_calls``. That AIMessage proves the builder did work (made
        tool calls) before the new user instruction landed.

        This is a one-shot trigger: as soon as the model responds, the
        latest message becomes an AIMessage and the heuristic stops
        matching for that turn-cycle. The caller resets the counter once,
        then the normal counter-increment logic runs unchanged.
        """
        if not messages:
            return False
        latest = messages[-1]
        if not isinstance(latest, HumanMessage):
            return False
        # Look backward for any AIMessage with tool_calls (builder did
        # real work before this new instruction).
        for msg in reversed(messages[:-1]):
            if isinstance(msg, AIMessage):
                tool_calls = getattr(msg, "tool_calls", None) or []
                if tool_calls:
                    return True
        return False

    @staticmethod
    def _latest_human_content(messages: list) -> str:
        if not messages or not isinstance(messages[-1], HumanMessage):
            return ""
        content = messages[-1].content
        return content if isinstance(content, str) else str(content or "")

    @staticmethod
    def _extract_update_target_path(content: str) -> str | None:
        match = _CONCRETE_FILE_TARGET_RE.search(content or "")
        if not match:
            return None
        target = match.group(1).strip()
        if not target.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            return None
        if _extract_output_relative_path(target) is None:
            return None
        return target

    def _post_interrupt_state_hints(self, state: BuilderArtifactState, messages: list) -> dict[str, Any]:
        content = self._latest_human_content(messages)
        update: dict[str, Any] = {}
        urls = extract_explicit_user_urls(content)
        if urls:
            update["explicit_user_urls"] = urls
            update["builder_allowed_urls"] = urls
            update["builder_update_required_urls"] = urls
        target_path = self._extract_update_target_path(content)
        if target_path:
            update["builder_artifact_target_path"] = target_path
        if _FILE_TARGET_HINT_MARKER in content:
            update["builder_update_epoch"] = int(state.get("builder_update_epoch", 0) or 0) + 1
            logger.info(
                "[BuilderArtifact] post-interrupt update hints: explicit_url_count=%d target_ext=%s",
                len(urls),
                Path(target_path).suffix.lower().lstrip(".") if target_path else None,
            )
        return update

    def _maybe_reset_turn_budget(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        """Reset post-interrupt turn budget while preserving resume hints."""
        messages = state.get("messages") or []
        if not self._is_post_interrupt_update(messages):
            return None
        current = int(state.get("builder_non_artifact_turns", 0) or 0)
        update = self._post_interrupt_state_hints(state, messages)
        if current > 0:
            update["builder_non_artifact_turns"] = 0
            logger.info(
                "[BuilderArtifact] post-interrupt update detected; resetting builder_non_artifact_turns=%d",
                current,
            )
        else:
            logger.info("[BuilderArtifact] post-interrupt update detected; builder_non_artifact_turns already reset")
        return update or None

    def _maybe_inject_pdf_layout_repair(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or state.get("builder_pdf_layout_repair_pending"):
            return None
        result = _successful_pdf_render_result(state)
        if result is None or not _pdf_layout_repair_needed(state):
            return None
        attempts = _pdf_layout_repair_attempts(state) + 1
        logger.warning(
            "BuilderArtifact: requesting PDF layout repair attempt=%d/%d page_count=%s blank_page_count=%s short_page_count=%s layout_quality=%s layout_warning=%s",
            attempts,
            _PDF_PAGE_COUNT_REPAIR_MAX,
            result.get("page_count"),
            result.get("blank_page_count"),
            result.get("short_page_count"),
            result.get("layout_quality"),
            result.get("layout_warning"),
        )
        return {
            "messages": [HumanMessage(content=_pdf_layout_repair_message(result, state))],
            "builder_pdf_render_result": None,
            "builder_pdf_layout_repair_requested": True,
            "builder_pdf_layout_repair_pending": True,
            "builder_pdf_layout_repair_attempts": attempts,
        }

    def _maybe_inject_pdf_render_source_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if state.get("builder_pdf_render_correction_emitted"):
            return None
        if self._has_requested_pdf_binary(state):
            return None
        if not self._should_force_emit(state):
            return None
        if _pdf_render_attempted(state) and state.get("builder_pdf_phase") != "ready_to_render":
            return None
        source_path = _preferred_pdf_render_source_path(state)
        if not source_path:
            return None
        pdf_path = _pdf_render_target_path(state, source_path)
        logger.warning(
            "BuilderArtifact: injecting PDF render correction source_ext=%s target_ext=pdf",
            PurePosixPath(source_path).suffix.lower().lstrip(".") or None,
        )
        return {
            "messages": [HumanMessage(content=_pdf_render_correction_message(source_path, pdf_path))],
            "builder_pdf_render_correction_emitted": True,
        }

    def _maybe_inject_pdf_source_write_directive(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if state.get("builder_pdf_source_write_directive_emitted"):
            return None
        if self._has_requested_pdf_binary(state) or _pdf_render_attempted(state):
            return None
        if _preferred_pdf_render_source_path(state):
            return None
        turn_force = self._should_force_emit(state)
        if not turn_force:
            return None
        target = self._target_artifact_path(state) or f"{_OUTPUTS_VIRTUAL_PREFIX}build.pdf"
        logger.warning("BuilderArtifact: injecting PDF source write directive before force window")
        return {
            "messages": [HumanMessage(content=_pdf_source_write_message(target))],
            "builder_pdf_source_write_directive_emitted": True,
        }

    def _maybe_inject_pptx_compile_latch(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _pptx_compile_ready(state):
            return None
        if state.get("builder_pptx_compile_latch_pending"):
            return None
        logger.warning(
            "BuilderArtifact: slide HTML ready; injecting deck compile latch target_slide_count=%d slide_html_count=%d",
            _pptx_latch_target_slide_count(state),
            _pptx_slide_html_count(state),
        )
        _trace_pptx_compile_decision(
            state=state,
            decision="inject_compile_latch",
            reason="slide_html_ready",
        )
        return {
            "messages": [HumanMessage(content=_pptx_compile_latch_message(state))],
            "builder_pptx_compile_latch_pending": True,
            "builder_pptx_diagnostics": _pptx_latch_diagnostics_update(
                state,
                compile_forced=False,
            ),
        }

    def _maybe_inject_pptx_slide_count_repair(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        update = _pptx_slide_count_repair_injection_update(state)
        if update is None:
            return None
        logger.warning("BuilderArtifact: injecting PPTX slide-count repair directive")
        return update

    def _maybe_inject_pptx_structural_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        # Slide-count repair remains the only structural correction; plan JSON
        # repairs are handled by the ppt-generation compiler diagnostics.
        return self._maybe_inject_pptx_slide_count_repair(state)

    def _maybe_inject_pptx_skill_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pptx_artifact(state):
            return None
        if state.get("builder_pptx_skill_correction_emitted"):
            return None
        valid_pptx_seen = self._has_valid_pptx_output(state)
        generator_invoked_seen = _pptx_generator_invoked_seen(state)
        if valid_pptx_seen or generator_invoked_seen:
            return None
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        recent_tool_names = _recent_builder_tool_names(state, limit=4)
        drifted = _pptx_recent_tools_drifted(recent_tool_names)
        if not drifted and non_artifact_turns < 3:
            return None
        _log_pptx_skill_correction(
            state,
            non_artifact_turns=non_artifact_turns,
            recent_tool_names=recent_tool_names,
            generator_invoked_seen=generator_invoked_seen,
            valid_pptx_seen=valid_pptx_seen,
        )
        return {
            "messages": [
                # Single source of truth: the early drift/skill correction
                # injects the same image-forward deck-steering contract as the
                # compile latch.
                HumanMessage(content=_pptx_compile_latch_message(state))
            ],
            "builder_pptx_skill_correction_emitted": True,
        }

    def _maybe_inject_image_generation_stop(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        """One idempotent stop directive after repeated image-generation failures."""
        if state.get("builder_image_generation_stop_emitted"):
            return None
        if not _requested_pptx_artifact(state):
            return None
        attempts = _pptx_diagnostic_count(state, "image_generation_attempt_count")
        successes = _pptx_diagnostic_count(state, "image_generation_success_count")
        if attempts < 2 or successes > 0:
            return None
        diagnostics = _pptx_diagnostics(state)
        if int(diagnostics.get("batch_summary_missing_count", 0) or 0) > 0 and int(diagnostics.get("batch_summary_missing_count", 0) or 0) < 2:
            return None
        requested = int(diagnostics.get("image_generation_manifest_requested_count", 0) or 0)
        failed = int(diagnostics.get("image_generation_manifest_failed_count", 0) or 0)
        real_batch_attempted = bool(diagnostics.get("image_generation_manifest_generation_attempted")) and requested > 0
        if real_batch_attempted and failed > 0:
            used_repairs = int(diagnostics.get("serial_repair_count", 0) or 0)
            allowed_repairs = failed * _SERIAL_REPAIR_ATTEMPTS_PER_FAILED_SLIDE
            if used_repairs < allowed_repairs:
                return None
        logger.warning(
            "[BuilderImageGeneration] phase=stop_directive attempts=%d error_class=%s",
            attempts,
            diagnostics.get("image_generation_error_class"),
        )
        return {
            "messages": [
                HumanMessage(
                    content=(
                        "[Sophia/image-generation stop]\n"
                        "Image generation has failed "
                        f"{attempts} times with no usable output "
                        f"(last error: {diagnostics.get('image_generation_error_class') or 'unknown'}). "
                        + (
                            "Stop manually retrying lower-level image or deck tools. For fresh PPTX "
                            "decks, use `prepare_deck_build` once with corrected slide intent; if it "
                            "returns failure, stop cleanly with artifact_path=null and its failure metadata."
                            if _deck_build_service_route_active(state)
                            else (
                                "Stop calling the image-generation script in this build and do NOT keep "
                                "retrying images or switch to python-pptx. Your slide HTML under "
                                "`/mnt/user-data/outputs/slides/` may still be useful source material, but "
                                "do not compile a partial placeholder deck. Stop cleanly with artifact_path=null "
                                "and explain that required slide imagery could not be generated."
                            )
                        )
                    )
                )
            ],
            "builder_image_generation_stop_emitted": True,
        }

    def _maybe_inject_pptx_fallback_after_image_failure(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        # v4.1: PPTX does not switch to HTML/Markdown or engine-composed slides
        # after image-generation failure. The stop directive above handles the
        # clean failure path.
        return None

    def _maybe_inject_visual_design_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if _visual_design_skill_read_seen(state):
            return None
        if state.get("builder_visual_design_correction_emitted"):
            return None
        logger.warning("[BuilderVisualDiagnostics] phase=design_skill_missing_blocking_correction design_skill_read=false")
        return {
            "messages": [HumanMessage(content=_visual_design_skill_message())],
            "builder_visual_design_correction_emitted": True,
        }

    def _maybe_inject_visual_asset_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if not (_requested_pdf_artifact(state) or _requested_pptx_artifact(state)):
            return None
        if not _visual_design_skill_read_seen(state):
            return None
        if _embedded_visual_success_count(state) > 0:
            return None
        if state.get("builder_visual_asset_correction_emitted"):
            return None
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        if non_artifact_turns < 2:
            return None
        logger.warning(
            "[BuilderVisualDiagnostics] phase=asset_missing_diagnostic requested_ext=%s embedded_visual_count=0",
            _requested_artifact_ext(state),
        )
        return {
            "builder_visual_asset_correction_emitted": True,
        }

    @staticmethod
    def _merge_if_update(update: dict[str, Any], result: Any) -> bool:
        if not isinstance(result, dict):
            return False
        update.update(result)
        return True

    def _merge_nonblocking_before_model_updates(
        self,
        state: BuilderArtifactState,
        update: dict[str, Any],
    ) -> None:
        for result in (
            self._maybe_inject_visual_design_correction(state),
            self._maybe_inject_visual_asset_correction(state),
        ):
            self._merge_if_update(update, result)

    def _first_blocking_before_model_update(
        self,
        state: BuilderArtifactState,
        update: dict[str, Any],
    ) -> dict[str, Any] | None:
        for probe in (
            self._maybe_inject_deck_prepare_retry,
            self._maybe_inject_pdf_render_source_correction,
            self._maybe_inject_pdf_layout_repair,
            self._maybe_inject_pdf_source_write_directive,
            self._maybe_inject_pptx_compile_latch,
            self._maybe_inject_pptx_structural_correction,
            self._maybe_inject_pptx_fallback_after_image_failure,
            self._maybe_inject_image_generation_stop,
            self._maybe_inject_pptx_skill_correction,
        ):
            if self._merge_if_update(update, probe(state)):
                return update
        return None

    @staticmethod
    def _maybe_inject_deck_prepare_retry(state: BuilderArtifactState) -> dict[str, Any] | None:
        if state.get("builder_deck_prepare_phase") != "retry_pending":
            return None
        if state.get("builder_deck_prepare_repair_prompt_injected"):
            return None
        message = str(state.get("builder_deck_prepare_repair_message") or "").strip()
        if not message:
            message = (
                "Repair the exact prepare_deck_build validation failure and call prepare_deck_build exactly once more "
                "with authoring_contract=compact_model_html_v2, the complete concise creative_plan, one shared "
                "deck_stylesheet, and compact html_body values."
            )
        return {
            "messages": [HumanMessage(content=f"[Sophia/PPTX D2.1 repair]\n{message}")],
            "builder_deck_prepare_repair_prompt_injected": True,
        }

    @staticmethod
    def _real_prepare_result_present(
        state: BuilderArtifactState,
        tool_call_id: str,
    ) -> bool:
        for message in state.get("messages", []) or []:
            if not isinstance(message, ToolMessage):
                continue
            if str(getattr(message, "tool_call_id", "") or "") != tool_call_id:
                continue
            text = BuilderArtifactMiddleware._tool_message_text(message)
            return "[Tool call was interrupted and did not return a result.]" not in text
        return False

    def _missing_prepare_result_terminal_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
    ) -> dict[str, Any] | None:
        if state.get("builder_deck_prepare_phase") in {"retry_pending", "terminal"}:
            return None
        expected_id = str(state.get("builder_deck_prepare_expected_tool_call_id") or "").strip()
        if not expected_id:
            return None
        if expected_id and self._real_prepare_result_present(state, expected_id):
            return None
        if runtime is None:
            return None
        logger.error(
            "[BuilderDeck] phase=prepare_result_missing expected_call_id_present=%s prepare_calls=%d prepare_results=%d",
            bool(expected_id),
            int(_pptx_diagnostics(state).get("prepare_call_count", 0) or 0),
            int(_pptx_diagnostics(state).get("prepare_result_count", 0) or 0),
        )
        delta = {
            "deck_status": "failed_terminal",
            "deck_failure_code": "deck_prepare_tool_result_missing",
            "dangling_prepare_call_count": 1,
        }
        terminal_state = {
            **state,
            "builder_pptx_diagnostics": _merge_builder_pptx_diagnostics(
                _pptx_diagnostics(state),
                delta,
            ),
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
        }
        payload = {
            "success": False,
            "failure_code": "deck_prepare_tool_result_missing",
            "failure_summary": ("The bounded prepare_deck_build retry did not return a real tool result."),
            "retryable": False,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=terminal_state,
            runtime=runtime,
            payload=payload,
            delta=delta,
        )
        return {
            "builder_pptx_diagnostics": delta,
            "builder_result": fallback,
            "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
            "builder_deck_prepare_expected_tool_call_id": None,
            **_terminal_halt_fields(state, "deck_prepare_tool_result_missing"),
            "jump_to": "end",
        }

    def _deck_authoring_terminal_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        failure_code: str,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        if runtime is None or not _deck_build_service_route_active(state):
            return None
        if state.get("builder_deck_prepare_phase") == "terminal":
            return None
        diagnostics = _pptx_diagnostics(state)
        elapsed_ms = _elapsed_since_builder_start_ms(state)
        if failure_code == "deck_authoring_output_truncated":
            failure_summary = "The presentation authoring step exceeded its bounded output budget."
            root_summary = failure_summary
            force_reason = "output_truncated"
        elif failure_code == "deck_authoring_model_invocation_error":
            failure_summary = "The presentation model request could not be invoked because its local request configuration was invalid."
            root_summary = failure_summary
            force_reason = "model_invocation_error"
        elif failure_code == "deck_authoring_model_failed":
            failure_summary = "The presentation authoring model failed before a valid deck build call was available."
            root_summary = failure_summary
            force_reason = "model_error"
        else:
            failure_summary = (
                "The presentation authoring step exceeded its configured cumulative deadline."
            )
            root_summary = failure_summary
            force_reason = "authoring_deadline"
        root_failure_code = diagnostics.get("deck_root_failure_code") or failure_code
        root_failure_summary = diagnostics.get("deck_root_failure_summary") or root_summary
        delta = {
            "deck_status": "failed_terminal",
            "deck_failure_code": failure_code,
            "deck_root_failure_code": root_failure_code,
            "deck_root_failure_summary": root_failure_summary,
            "last_prepare_failure_code": failure_code,
            "last_prepare_failure_summary": failure_summary,
            "deck_authoring_elapsed_ms": elapsed_ms,
            "prepare_force_reason": force_reason,
        }
        result_messages: list[ToolMessage] = []
        prepare_calls = [
            call
            for call in tool_calls or []
            if str(call.get("name") or "") == _PREPARE_DECK_BUILD_TOOL_NAME
        ]
        if prepare_calls:
            call_update = self._prepare_call_after_model_update(state, prepare_calls, runtime)
            call_delta = call_update.get("builder_pptx_diagnostics")
            delta = _merge_builder_pptx_diagnostics(
                call_delta if isinstance(call_delta, dict) else {},
                {
                    **delta,
                    "prepare_result_count": len(prepare_calls),
                    "prepare_policy_result_count": len(prepare_calls),
                    "dangling_prepare_call_count": 0,
                },
            )
            result_payload = {
                "success": False,
                "failure_code": failure_code,
                "failure_summary": failure_summary,
                "retryable": False,
            }
            for call in prepare_calls:
                call_id = str(call.get("id") or "")
                record_runtime_event(
                    state=state,
                    runtime=runtime,
                    event_type="prepare.result_recorded",
                    tool_call_id=call_id or None,
                    status="policy_rejected",
                    failure_code=failure_code,
                )
                result_messages.append(
                    ToolMessage(
                        content=json.dumps(result_payload),
                        tool_call_id=call_id,
                        name=_PREPARE_DECK_BUILD_TOOL_NAME,
                        status="error",
                    )
                )
        payload = {
            "success": False,
            "failure_code": failure_code,
            "failure_summary": failure_summary,
            "root_failure_code": root_failure_code,
            "root_failure_summary": root_failure_summary,
            "last_prepare_failure_code": failure_code,
            "last_prepare_failure_summary": failure_summary,
            "retryable": False,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=state,
            runtime=runtime,
            payload=payload,
            delta=delta,
        )
        update = {
            "builder_pptx_diagnostics": delta,
            "builder_result": fallback,
            "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
            "builder_deck_prepare_expected_tool_call_id": None,
            **_terminal_halt_fields(state, failure_code),
            "jump_to": "end",
        }
        if result_messages:
            update["messages"] = result_messages
        return update

    def _deck_authoring_message_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime,
        latest_ai: Any,
    ) -> dict[str, Any] | None:
        if not _deck_build_service_route_active(state) or latest_ai is None:
            return None
        additional_kwargs = getattr(latest_ai, "additional_kwargs", {})
        elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state) or 0
        deadline_ms = presentation_authoring_deadline_seconds(state) * 1_000
        if additional_kwargs.get("deerflow_error_fallback"):
            error_type = str(additional_kwargs.get("error_type") or "")
            error_reason = str(additional_kwargs.get("error_reason") or "")
            if "timeout" in error_type.lower() or (deadline_ms > 0 and elapsed_ms >= deadline_ms):
                failure_code = "deck_authoring_deadline_exceeded"
            elif error_reason == "malformed_request" or error_type in {"TypeError", "ValidationError", "SchemaError", "ValueError"}:
                failure_code = "deck_authoring_model_invocation_error"
            else:
                failure_code = "deck_authoring_model_failed"
            return self._deck_authoring_terminal_update(
                state,
                runtime,
                failure_code=failure_code,
                tool_calls=getattr(latest_ai, "tool_calls", []) or [],
            )
        if deadline_ms > 0 and elapsed_ms >= deadline_ms:
            return self._deck_authoring_terminal_update(
                state,
                runtime,
                failure_code="deck_authoring_deadline_exceeded",
                tool_calls=getattr(latest_ai, "tool_calls", []) or [],
            )
        if self._last_ai_truncated(state):
            return self._deck_authoring_terminal_update(
                state,
                runtime,
                failure_code="deck_authoring_output_truncated",
                tool_calls=getattr(latest_ai, "tool_calls", []) or [],
            )
        return None

    @classmethod
    def _presentation_preflight_model_failure_update(
        cls,
        state: BuilderArtifactState,
        latest_ai: Any,
    ) -> dict[str, Any] | None:
        if state.get("builder_presentation_phase") != "preflight_call_emitted" or latest_ai is None:
            return None
        tool_calls = getattr(latest_ai, "tool_calls", []) or []
        if any(str(call.get("name") or "") in _PRESENTATION_PREFLIGHT_TOOLS for call in tool_calls):
            return None
        additional_kwargs = getattr(latest_ai, "additional_kwargs", {}) or {}
        status = "timed_out" if additional_kwargs.get("presentation_preflight_timeout") else "failed"
        update = cls._presentation_preflight_terminal_update(state, status)
        update["builder_non_artifact_turns"] = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
        logger.warning(
            "BuilderArtifact: presentation preflight ended without a web tool call status=%s; forcing prepare next",
            status,
        )
        return update

    def _authoring_deadline_terminal_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
    ) -> dict[str, Any] | None:
        elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state)
        deadline_ms = presentation_authoring_deadline_seconds(state) * 1_000
        if elapsed_ms is None or deadline_ms <= 0 or elapsed_ms < deadline_ms:
            return None
        return self._deck_authoring_terminal_update(
            state,
            runtime,
            failure_code="deck_authoring_deadline_exceeded",
        )

    def _combined_before_model_updates(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict | None:
        """Run all before_model state-update probes (Phase 2E.1 turn-budget
        reset + Phase 2F.3 path-correction injection) and merge their
        returns into a single update dict for the langgraph reducer."""
        authoring_deadline = self._authoring_deadline_terminal_update(state, runtime)
        if authoring_deadline is not None:
            return authoring_deadline
        missing_prepare_result = self._missing_prepare_result_terminal_update(state, runtime)
        if missing_prepare_result is not None:
            return missing_prepare_result
        update: dict[str, Any] = {}
        if _requested_pptx_artifact(state) and not state.get("builder_pptx_route_trace_emitted"):
            _trace_pptx_route_selected(state)
            update["builder_pptx_route_trace_emitted"] = True
        if _deck_build_service_route_active(state):
            self._merge_if_update(update, self._presentation_phase_before_model_update(state))
            self._merge_if_update(update, self._maybe_inject_deck_prepare_retry(state))
            # Fresh presentations use the compact, single-purpose lane. Generic
            # skill, visual, todo, path, and write recovery prompts are excluded.
            return update or None
        reset = self._maybe_reset_turn_budget(state)
        if isinstance(reset, dict):
            update.update(reset)
        promotion = self._maybe_promote_recovered_deliverable(
            state,
            runtime,
            reason="successful_write_after_correction",
        )
        if self._merge_if_update(update, promotion):
            return update
        self._merge_nonblocking_before_model_updates(state, update)
        blocking = self._first_blocking_before_model_update(state, update)
        if blocking is not None:
            return blocking
        # Merge: ``messages`` reducer concatenates, scalar flags overwrite.
        self._merge_if_update(update, self._maybe_inject_path_correction(state, runtime))
        return update or None

    @hook_config(can_jump_to=["end"])
    @override
    def before_model(self, state: BuilderArtifactState, runtime: Runtime | None = None) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @hook_config(can_jump_to=["end"])
    @override
    async def abefore_model(self, state: BuilderArtifactState, runtime: Runtime | None = None) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force tool_choice when ceiling is imminent (two-stage)."""
        if request.state.get("builder_graph_halted") is True:
            logger.warning(
                "BuilderArtifact: suppressing model call after terminal halt reason=%s",
                request.state.get("builder_terminal_halt_reason"),
            )
            return AIMessage(content="[Sophia builder stopped: terminal artifact already emitted.]")
        choice, state_update = self._force_choice_plan_for_state(request.state, request.runtime)
        if choice is not None:
            choice = self._provider_normalized_tool_choice(request.model, choice)
            request = request.override(tool_choice=choice)
        request, request_update = self._presentation_request_for_choice(request, choice)
        state_update = self._merged_presentation_state_update(state_update, request_update)
        return self._model_result_with_state_update(handler(request), state_update)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same two-stage logic as wrap_model_call."""
        if request.state.get("builder_graph_halted") is True:
            logger.warning(
                "BuilderArtifact: suppressing async model call after terminal halt reason=%s",
                request.state.get("builder_terminal_halt_reason"),
            )
            return AIMessage(content="[Sophia builder stopped: terminal artifact already emitted.]")
        choice, state_update = self._force_choice_plan_for_state(request.state, request.runtime)
        if choice is not None:
            choice = self._provider_normalized_tool_choice(request.model, choice)
            request = request.override(tool_choice=choice)
        request, request_update = self._presentation_request_for_choice(request, choice)
        state_update = self._merged_presentation_state_update(state_update, request_update)
        tool_name = self._tool_choice_name(choice)
        preflight = tool_name in _PRESENTATION_PREFLIGHT_TOOLS
        remaining = (
            self._presentation_preflight_seconds_remaining(request.state)
            if preflight
            else self._presentation_authoring_seconds_remaining(request.state)
        )
        if remaining is None:
            return self._model_result_with_state_update(await handler(request), state_update)
        if remaining <= 0:
            if preflight:
                state_update = self._merged_presentation_state_update(
                    state_update,
                    self._presentation_preflight_terminal_update(request.state, "timed_out"),
                )
            return self._model_result_with_state_update(
                self._presentation_preflight_timeout_message() if preflight else self._authoring_timeout_message(),
                state_update,
            )
        try:
            async with asyncio.timeout_at(asyncio.get_running_loop().time() + remaining):
                result = await handler(request)
        except TimeoutError:
            if preflight:
                logger.warning("BuilderArtifact: bounded presentation preflight model call timed out; continuing to authoring")
                result = self._presentation_preflight_timeout_message()
                state_update = self._merged_presentation_state_update(
                    state_update,
                    self._presentation_preflight_terminal_update(request.state, "timed_out"),
                )
            else:
                logger.error(
                    "BuilderArtifact: presentation authoring model stream cancelled at absolute deadline elapsed_ms=%s",
                    _elapsed_since_presentation_authoring_start_ms(request.state),
                )
                result = self._authoring_timeout_message()
        return self._model_result_with_state_update(result, state_update)

    @staticmethod
    def _tool_choice_name(choice: Any) -> str | None:
        if not isinstance(choice, dict):
            return None
        if isinstance(choice.get("function"), dict):
            return str(choice["function"].get("name") or "") or None
        return str(choice.get("name") or "") or None

    @staticmethod
    def _bound_tool_name(tool: Any) -> str | None:
        if isinstance(tool, dict):
            function = tool.get("function")
            if isinstance(function, dict):
                return str(function.get("name") or "") or None
            return str(tool.get("name") or "") or None
        return str(getattr(tool, "name", "") or "") or None

    @classmethod
    def _single_request_tool(cls, request: ModelRequest, name: str) -> list[Any]:
        return [tool for tool in request.tools if cls._bound_tool_name(tool) == name]

    @staticmethod
    def _truncate_utf8(value: str, limit: int) -> str:
        encoded = value.encode("utf-8")
        if len(encoded) <= limit:
            return value
        return encoded[:limit].decode("utf-8", errors="ignore") + "\n[truncated]"

    @classmethod
    def _presentation_task_brief(cls, state: BuilderArtifactState, request: ModelRequest) -> str:
        delegation = state.get("delegation_context")
        if isinstance(delegation, dict):
            task = str(delegation.get("task") or delegation.get("task_brief") or "").strip()
            if task:
                return cls._truncate_utf8(task, _PRESENTATION_TASK_BRIEF_MAX_BYTES)
        for message in request.messages:
            if isinstance(message, HumanMessage):
                return cls._truncate_utf8(_blocks_to_plaintext(message.content), _PRESENTATION_TASK_BRIEF_MAX_BYTES)
        return "Create the requested presentation."

    @classmethod
    def _presentation_preflight_context(cls, state: BuilderArtifactState) -> str:
        result = cls._presentation_preflight_result_message(state)
        if result is None:
            return "No external preflight material was available."
        return cls._truncate_utf8(cls._tool_message_text(result), _PRESENTATION_PREFLIGHT_RESULT_MAX_BYTES)

    @staticmethod
    def _unique_presentation_context_values(
        sources: tuple[Any, ...],
        *,
        limit: int | None = None,
    ) -> list[str]:
        values: list[str] = []
        seen: set[str] = set()
        for source in sources:
            for item in source if isinstance(source, list) else []:
                value = str(item).strip()
                if value and value not in seen:
                    seen.add(value)
                    values.append(value)
                if limit is not None and len(values) >= limit:
                    return values
        return values

    @classmethod
    def _presentation_attachment_memory_context(cls, state: BuilderArtifactState) -> str:
        delegation = state.get("delegation_context")
        delegation = delegation if isinstance(delegation, dict) else {}
        memories = cls._unique_presentation_context_values(
            (
                delegation.get("relevant_memories") or [],
                state.get("injected_memory_contents") or [],
            ),
            limit=5,
        )
        attachments = cls._unique_presentation_context_values(
            (
                delegation.get("uploaded_image_paths") or [],
                delegation.get("uploaded_file_paths") or [],
                state.get("uploaded_image_paths") or [],
            )
        )
        lines: list[str] = []
        if attachments:
            lines.append("Attachments:\n" + "\n".join(f"- {value}" for value in attachments))
        if memories:
            lines.append("Filtered memory:\n" + "\n".join(f"- {value}" for value in memories))
        if not lines:
            return "No attachment or memory context was supplied."
        return cls._truncate_utf8("\n\n".join(lines), _PRESENTATION_ATTACHMENT_MEMORY_MAX_BYTES)

    @staticmethod
    def _request_tool_schema_bytes(tools: list[Any]) -> int:
        total = 0
        for tool in tools:
            schema = getattr(tool, "args", None)
            if not isinstance(schema, dict) and isinstance(tool, dict):
                schema = tool
            if isinstance(schema, dict):
                total += len(json.dumps(schema, separators=(",", ":"), default=str).encode("utf-8"))
        return total

    @classmethod
    def _presentation_request_for_choice(
        cls,
        request: ModelRequest,
        choice: Any,
    ) -> tuple[ModelRequest, dict[str, Any] | None]:
        if not _deck_build_service_route_active(request.state):
            return request, None
        tool_name = cls._tool_choice_name(choice)
        if tool_name in _PRESENTATION_PREFLIGHT_TOOLS:
            tools = cls._single_request_tool(request, tool_name)
            brief = cls._presentation_task_brief(request.state, request)
            explicit_urls = [str(url) for url in (request.state.get("explicit_user_urls") or []) if str(url).strip()]
            target = f"\nExact URL: {explicit_urls[0]}" if tool_name == "builder_web_fetch" and explicit_urls else ""
            prompt = cls._truncate_utf8(
                f"Presentation brief:\n{brief}{target}\n\nCall {tool_name} exactly once.",
                _PRESENTATION_AUTHORING_PROMPT_MAX_BYTES,
            )
            timeout_seconds = max(1, min(
                presentation_preflight_timeout_seconds(request.state),
                int(cls._presentation_preflight_seconds_remaining(request.state) or 1),
            ))
            settings = {
                **request.model_settings,
                "max_tokens": _PRESENTATION_PREFLIGHT_MODEL_MAX_TOKENS,
                "timeout": float(timeout_seconds),
            }
            return request.override(
                tools=tools,
                messages=[HumanMessage(content=prompt)],
                system_prompt=_PRESENTATION_PREFLIGHT_SYSTEM_PROMPT,
                model_settings=settings,
            ), None
        if tool_name != _PREPARE_DECK_BUILD_TOOL_NAME:
            return cls._bounded_presentation_model_request(request), None

        tools = cls._single_request_tool(request, _PREPARE_DECK_BUILD_TOOL_NAME)
        brief = cls._presentation_task_brief(request.state, request)
        source_context = cls._presentation_preflight_context(request.state)
        attachment_memory_context = cls._presentation_attachment_memory_context(request.state)
        repair = str(request.state.get("builder_deck_prepare_repair_message") or "").strip()
        target_path = str(request.state.get("builder_artifact_target_path") or "/mnt/user-data/outputs/presentation.pptx")
        requested_slides = request.state.get("builder_pptx_requested_slide_count")
        prompt = (
            f"Presentation brief:\n{brief}\n\n"
            f"Output path: {target_path}\nRequested slides: {requested_slides or 'infer from brief'}\n\n"
            f"Attachments and memory:\n{attachment_memory_context}\n\n"
            f"Bounded preflight result:\n{source_context}"
        )
        if repair:
            prompt += f"\n\nRequired repair:\n{cls._truncate_utf8(repair, 4 * 1024)}"
        prompt = cls._truncate_utf8(prompt, _PRESENTATION_AUTHORING_PROMPT_MAX_BYTES)
        request = cls._bounded_presentation_model_request(request).override(
            tools=tools,
            messages=[HumanMessage(content=prompt)],
            system_prompt=_PRESENTATION_AUTHORING_SYSTEM_PROMPT,
        )
        prompt_bytes = len(prompt.encode("utf-8")) + len(_PRESENTATION_AUTHORING_SYSTEM_PROMPT.encode("utf-8"))
        schema_bytes = cls._request_tool_schema_bytes(tools)
        context_bytes = prompt_bytes + schema_bytes
        if context_bytes > 40 * 1024:
            logger.warning("BuilderArtifact: compact presentation model context exceeds target bytes=%d", context_bytes)
        remaining = cls._presentation_authoring_seconds_remaining(request.state)
        return request, {
            "builder_pptx_diagnostics": {
                "deck_authoring_started_at_ms": int(
                    request.state.get("builder_presentation_authoring_started_at_ms")
                    or time.time() * 1_000
                ),
                "deck_authoring_budget_ms": presentation_authoring_deadline_seconds(request.state) * 1_000,
                "deck_authoring_prompt_bytes": prompt_bytes,
                "deck_authoring_prompt_estimated_tokens": (prompt_bytes + 3) // 4,
                "deck_authoring_tool_schema_bytes": schema_bytes,
                "deck_authoring_context_bytes": context_bytes,
                "deck_authoring_remaining_ms": int(remaining * 1_000) if remaining is not None else None,
                "deck_authoring_output_bytes": 0,
                "authoring_tool_call_started": False,
            }
        }

    @staticmethod
    def _merged_presentation_state_update(
        current: dict[str, Any] | None,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not current:
            return extra
        if not extra:
            return current
        merged = {**current, **extra}
        current_diagnostics = current.get("builder_pptx_diagnostics")
        extra_diagnostics = extra.get("builder_pptx_diagnostics")
        if isinstance(current_diagnostics, dict) and isinstance(extra_diagnostics, dict):
            merged["builder_pptx_diagnostics"] = {**current_diagnostics, **extra_diagnostics}
        return merged

    @staticmethod
    def _presentation_authoring_seconds_remaining(state: BuilderArtifactState) -> float | None:
        if not _deck_build_service_route_active(state):
            return None
        elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state)
        if elapsed_ms is None:
            return None
        return max(0.0, presentation_authoring_deadline_seconds(state) - (elapsed_ms / 1_000.0))

    @staticmethod
    def _presentation_preflight_seconds_remaining(state: BuilderArtifactState) -> float | None:
        if not _deck_build_service_route_active(state):
            return None
        started_ms = state.get("builder_presentation_preflight_started_at_ms")
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            return float(presentation_preflight_timeout_seconds(state))
        elapsed = max(0.0, (time.time() * 1_000 - float(started_ms)) / 1_000.0)
        return max(0.0, presentation_preflight_timeout_seconds(state) - elapsed)

    @staticmethod
    def _presentation_preflight_timeout_message() -> AIMessage:
        return AIMessage(
            content="[Sophia builder: presentation research preflight timed out; continuing without it.]",
            additional_kwargs={
                "presentation_preflight_timeout": True,
                "error_type": "TimeoutError",
                "error_reason": "presentation_preflight_timeout",
            },
        )

    @staticmethod
    def _presentation_preflight_terminal_update(
        state: BuilderArtifactState,
        status: str,
    ) -> dict[str, Any]:
        started_ms = state.get("builder_presentation_preflight_started_at_ms")
        elapsed_ms = (
            max(0, int(time.time() * 1_000) - int(started_ms))
            if isinstance(started_ms, (int, float)) and started_ms > 0
            else 0
        )
        return {
            "builder_presentation_phase": "authoring_pending",
            "builder_presentation_authoring_started_at_ms": int(
                state.get("builder_presentation_authoring_started_at_ms") or time.time() * 1_000
            ),
            "builder_pptx_diagnostics": {
                "presentation_preflight_status": status,
                "presentation_preflight_elapsed_ms": elapsed_ms,
                "prepare_force_reason": "bounded_preflight_complete",
            },
        }

    @staticmethod
    def _authoring_timeout_message() -> AIMessage:
        return AIMessage(
            content="[Sophia builder stopped: presentation authoring deadline exceeded.]",
            additional_kwargs={
                "deerflow_error_fallback": True,
                "error_type": "TimeoutError",
                "error_reason": "authoring_deadline",
            },
        )

    @staticmethod
    def _bounded_presentation_model_request(request: ModelRequest) -> ModelRequest:
        state = request.state
        if not _deck_build_service_route_active(state):
            return request
        elapsed_ms = _elapsed_since_presentation_authoring_start_ms(state) or 0
        authoring_deadline_ms = presentation_authoring_deadline_seconds(state) * 1_000
        remaining_seconds = max(1, (authoring_deadline_ms - elapsed_ms + 999) // 1_000)
        timeout_seconds = min(
            presentation_authoring_timeout_seconds(state),
            remaining_seconds,
        )
        settings = {
            **request.model_settings,
            "max_tokens": presentation_authoring_max_tokens(state),
            "timeout": float(timeout_seconds),
        }
        return request.override(model_settings=settings)

    @staticmethod
    def _provider_normalized_tool_choice(model: Any, choice: dict[str, Any]) -> Any:
        """Translate a forced ``tool_choice`` payload to the bound model's
        provider shape and emit a safe (payload-free) audit log line.

        The forced-choice helpers author Anthropic's native
        ``{"type": "tool", "name": <tool>}``. When the Builder provider
        fallback swaps the bound model to ``ChatOpenAI`` mid-run, the inner
        model node would otherwise receive that Anthropic shape and OpenAI
        rejects it with ``Missing required parameter: 'tool_choice.function'``.
        Normalizing here — at the single point the choice is applied to the
        request — keeps Anthropic byte-identical while making the OpenAI
        retry valid, WITHOUT changing which tool is forced.
        """
        normalized = normalize_tool_choice_for_model(model, choice)
        provider = model_provider_label(model)
        was_normalized = normalized is not choice
        tool_name = choice.get("name") if isinstance(choice, dict) else None
        logger.info(
            "[BuilderToolChoice] builderToolChoiceNormalized=%s builderToolChoiceProvider=%s builderToolChoiceName=%s rawProviderPayloadExcluded=true providerSecretsExcluded=true",
            str(was_normalized).lower(),
            provider,
            tool_name,
        )
        return normalized

    def _block_substantive_tool_before_research(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        if not self._is_substantive_before_research_tool(request.state, request.tool_call):
            return None

        tool_name = request.tool_call.get("name") or "unknown"
        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "[BuilderResearchEnforcement] blocked_content_tool_before_research tool=%s",
            tool_name,
        )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=(
                            "Error: research-before-write enforcement blocked this tool call. "
                            "You may keep your plan, but before writing, editing, running "
                            "artifact-generating bash, or emitting the artifact, call "
                            "builder_web_search first, then builder_web_fetch on one approved "
                            "result URL for factual document/PDF work. If the web tool fails "
                            "or returns weak results, continue afterward with the best "
                            "available context."
                        ),
                        tool_call_id=tool_call_id,
                        name=str(tool_name),
                    ),
                ],
            },
            goto="model",
        )

    def _block_visual_asset_before_design_skill(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        tool_name = request.tool_call.get("name")
        if tool_name not in _VISUAL_ASSET_TOOL_NAMES:
            return None
        if not _visuals_requested(request.state):
            return None
        if _visual_design_skill_read_seen(request.state):
            return None

        tool_call_id = request.tool_call.get("id")
        logger.warning(
            "[BuilderVisualDiagnostics] visual_asset_before_design_skill_blocked tool=%s",
            tool_name,
        )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=("Error: visual asset creation is blocked until you read `/mnt/skills/public/visual-design/SKILL.md`. Then retry with labeled chart data or graphviz nodes/edges."),
                        tool_call_id=tool_call_id,
                        name=str(tool_name),
                    )
                ],
                "builder_visual_design_correction_emitted": True,
            },
            goto="model",
        )

    def _block_emit_before_target_skill(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        """Artifact Visual System Phase 5c: you cannot emit a typed deliverable
        without first reading its skill.

        For a .pptx/.pdf/.html target whose matching skill
        (ppt-generation/pdf-report/hallmark) has not been read, force the read
        ONCE, then latch (``builder_target_skill_read_forced``) so the build is
        never trapped if the model proceeds anyway — the earlier-churn lesson.
        """
        if request.tool_call.get("name") != "emit_builder_artifact":
            return None
        target_ext = _requested_target_suffix(request.state)
        required = _TARGET_REQUIRED_SKILL.get(target_ext)
        if required is None:
            return None
        if _target_skill_read_seen(request.state, target_ext):
            return None
        if request.state.get("builder_target_skill_read_forced"):
            return None  # already forced once — do not trap the build
        skill_path, skill_name = required
        tool_call_id = request.tool_call.get("id")
        logger.warning(
            "[BuilderArtifact] emit_before_target_skill_blocked target_ext=%s skill=%s",
            target_ext,
            skill_name,
        )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=(
                            f"Error: emit_builder_artifact is blocked until you read the "
                            f"{skill_name} skill for this {target_ext} deliverable. Call "
                            f"`read_file(path='{skill_path}')` first, follow its design "
                            "system and workflow, then emit. (This check fires once.)"
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                    )
                ],
                "builder_target_skill_read_forced": True,
            },
            goto="model",
        )

    @staticmethod
    def _normalized_write_path(tool_call: dict[str, Any]) -> str | None:
        args = tool_call.get("args") or {}
        if not isinstance(args, dict):
            return None
        raw_path = args.get("path") or args.get("file_path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            return None
        return BuilderArtifactMiddleware._normalize_requested_write_path(raw_path.strip())

    @staticmethod
    def _normalize_requested_write_path(path: str) -> str:
        if path.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            return path
        if "/" not in path and "\\" not in path:
            return _OUTPUTS_VIRTUAL_PREFIX + path
        return path

    @staticmethod
    def _tool_message_text(result: ToolMessage) -> str:
        content = result.content
        if isinstance(content, str):
            return content
        return str(content or "")

    def _write_result_delta(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any]:
        text = self._tool_message_text(result).strip()
        success = text.startswith("OK")
        path = self._normalized_write_path(request.tool_call)
        ext, under_outputs = self._write_path_metadata(path)
        delta: dict[str, Any] = {
            "success_count": 1 if success else 0,
            "error_count": 0 if success else 1,
            "last_content_shape": self._tool_message_content_shape(result),
            "last_ext": ext,
            "last_under_outputs": under_outputs,
            "last_status": "success" if success else "error",
        }
        if not success:
            delta["last_error_class"] = self._classify_write_error(text, under_outputs)
        if success and under_outputs and path:
            delta["last_successful_output_path"] = path
            delta["successful_output_paths"] = [path]
            if _is_user_facing_output_path(path):
                delta["last_successful_deliverable_output_path"] = path
                delta["successful_deliverable_output_paths"] = [path]
        return delta

    @staticmethod
    def _write_path_metadata(path: str | None) -> tuple[str, bool]:
        if not path:
            return "", False
        return Path(path).suffix.lower().lstrip("."), _extract_output_relative_path(path) is not None

    @staticmethod
    def _is_slide_html_edit(request: ToolCallRequest) -> bool:
        """True when this write/edit targets an ``outputs/slides/*.html`` slide file.

        Only a real slide-HTML edit may clear ``builder_pptx_compile_repair_pending``.
        The repair latch is set by both the slide_render_failed repair and the
        slide-quality gate — in both cases the model must edit the slide HTML before
        the compile force re-fires. If ANY write (a manifest, notes, an asset, scratch)
        cleared the latch, the compile force could recompile UNCHANGED slides and —
        because the one-shot quality gate is already spent — ship the stale deck
        (Codex P2, review 4601126059).
        """
        args = request.tool_call.get("args")
        if not isinstance(args, dict):
            return False
        raw = str(args.get("path") or args.get("file_path") or "").strip().replace("\\", "/")
        if not raw:
            return False
        relative = _extract_output_relative_path(raw)
        if relative is None:
            return False
        pure = PurePosixPath(relative)
        return pure.suffix.lower() in {".html", ".htm"} and len(pure.parts) == 2 and pure.parts[0] == "slides"

    @staticmethod
    def _is_pdf_html_edit(request: ToolCallRequest) -> bool:
        if not _requested_pdf_artifact(request.state or {}):
            return False
        args = request.tool_call.get("args")
        if not isinstance(args, dict):
            return False
        raw = str(args.get("path") or args.get("file_path") or "").strip().replace("\\", "/")
        relative = _extract_output_relative_path(raw) if raw else None
        return bool(relative and PurePosixPath(relative).suffix.lower() in {".html", ".htm"})

    @staticmethod
    def _pdf_edit_phase_update(request: ToolCallRequest) -> dict[str, Any]:
        if not BuilderArtifactMiddleware._is_pdf_html_edit(request):
            return {}
        repairing = bool((request.state or {}).get("builder_pdf_contract_repair_pending"))
        return {
            "builder_pdf_phase": "ready_to_render" if repairing else "drafting",
            **({"builder_pdf_contract_repair_pending": False} if repairing else {}),
        }

    def _write_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name not in _BUILDER_WRITE_TOOL_NAMES or not isinstance(result, ToolMessage):
            return result

        delta = self._write_result_delta(request, result)
        logger.info(
            "[BuilderWriteDiagnostics] tool=%s status=%s path_under_outputs=%s ext=%s error_class=%s content_shape=%s",
            tool_name,
            delta["last_status"],
            delta["last_under_outputs"],
            delta["last_ext"] or None,
            delta.get("last_error_class"),
            delta.get("last_content_shape"),
        )
        return Command(
            update={
                "messages": [result],
                "builder_write_diagnostics": delta,
                # Clear the compile-repair latch ONLY on a successful slide-HTML edit
                # (Codex P2 4601126059) — a scratch/manifest write must not unlock a
                # recompile of unchanged slides past the spent quality gate.
                **({"builder_pptx_compile_repair_pending": False} if delta["last_status"] == "success" and self._is_slide_html_edit(request) else {}),
                **(self._pdf_edit_phase_update(request) if delta["last_status"] == "success" else {}),
            }
        )

    def _edit_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name in _BUILDER_WRITE_TOOL_NAMES:
            return self._write_result_command(request, result)
        if tool_name not in {"str_replace", "str_replace_tool"} or not isinstance(result, ToolMessage):
            return result
        text = self._tool_message_text(result).strip()
        if not text.startswith("OK"):
            return result
        return Command(
            update={
                "messages": [result],
                # Same slide-HTML-only latch clear as _write_result_command.
                **({"builder_pptx_compile_repair_pending": False} if self._is_slide_html_edit(request) else {}),
                **self._pdf_edit_phase_update(request),
            }
        )

    @staticmethod
    def _render_pdf_result_delta(result: ToolMessage) -> dict[str, Any] | None:
        if not isinstance(result.content, str):
            return None
        try:
            payload = json.loads(result.content)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        logger.info(
            "[BuilderPdfDiagnostics] render_success=%s page_count=%s blank_page_count=%s short_page_count=%s layout_quality=%s layout_warning=%s",
            payload.get("success"),
            payload.get("page_count"),
            payload.get("blank_page_count"),
            payload.get("short_page_count"),
            payload.get("layout_quality"),
            payload.get("layout_warning"),
        )
        return {"builder_pdf_render_result": payload}

    @staticmethod
    def _pdf_contract_failure_fallback(
        *,
        steps_completed: int,
        state: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        error_type = str(payload.get("error_type") or "report_contract_failed")
        failure_code = "pdf_report_manifest_invalid" if error_type in {"report_manifest_required", "report_manifest_invalid"} else "pdf_report_contract_failed"
        problems = [str(item) for item in (payload.get("report_contract_problems") or []) if str(item).strip()]
        artifact = {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF report did not satisfy its completion contract",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": "The PDF report stopped because required sections, visuals, or report structure were still incomplete after one targeted repair.",
            "companion_tone_hint": "Direct and apologetic; explain that an incomplete draft was not delivered as a finished report.",
            "user_next_action": "Ask me to retry the report build.",
            "confidence": 0.0,
            "failure_code": failure_code,
            "root_failure_code": failure_code,
            "root_failure_summary": "The final HTML source failed the typed report completion contract.",
            "artifact_acceptance_status": "failed",
            "report_contract_status": payload.get("report_contract_status") or "rejected",
            "report_contract_version": payload.get("report_contract_version") or "report_manifest_v1",
            "report_contract_problems": problems[:12],
            "missing_section_ids": payload.get("missing_section_ids") or [],
            "missing_visual_ids": payload.get("missing_visual_ids") or [],
            "expected_section_count": payload.get("expected_section_count"),
            "found_section_count": payload.get("found_section_count"),
            "expected_visual_count": payload.get("expected_visual_count"),
            "found_visual_count": payload.get("found_visual_count"),
        }
        return _apply_artifact_request_metadata(artifact, state, fallback_reason=failure_code)

    def _pdf_contract_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
    ) -> Command:
        attempts = _pdf_contract_repair_attempts(request.state)
        problems = [str(item) for item in (payload.get("report_contract_problems") or []) if str(item).strip()]
        if attempts < 1 and payload.get("retryable") is not False:
            logger.warning(
                "BuilderArtifact: requesting PDF contract repair attempt=1/1 error_type=%s problem_count=%d",
                payload.get("error_type"),
                len(problems),
            )
            problem_lines = "\n".join(f"- {item}" for item in problems[:10]) or "- report_manifest is required and must match the final HTML."
            return Command(
                update={
                    "messages": [
                        result,
                        HumanMessage(
                            content=(
                                "[Sophia/PDF contract repair]\n"
                                "The report was not rendered because its final HTML is still incomplete. "
                                "Make one targeted source edit, preserving completed content, then call "
                                "render_html_to_pdf again with the complete report_manifest. Missing requirements:\n"
                                f"{problem_lines}"
                            )
                        ),
                    ],
                    "builder_pdf_render_result": payload,
                    "builder_pdf_contract_repair_attempts": 1,
                    "builder_pdf_contract_repair_pending": True,
                    "builder_pdf_phase": "repair_pending",
                },
                goto="model",
            )

        fallback = self._pdf_contract_failure_fallback(
            steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
            state=request.state,
            payload=payload,
        )
        logger.error(
            "BuilderArtifact: terminal PDF contract failure error_type=%s problem_count=%d",
            payload.get("error_type"),
            len(problems),
        )
        self._upload_fallback_and_fire(
            state=request.state,
            runtime=request.runtime,
            fallback=fallback,
            status="failed",
        )
        return Command(
            update={
                "messages": [result],
                "builder_pdf_render_result": payload,
                "builder_pdf_contract_repair_pending": False,
                "builder_pdf_phase": "terminal",
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                **_terminal_halt_fields(request.state, str(fallback.get("failure_code") or "pdf_report_contract_failed")),
            },
            goto="end",
        )

    @staticmethod
    def _pdf_generation_failed_fallback(
        *,
        steps_completed: int,
        error_type: str,
    ) -> dict[str, Any]:
        safe_reason = error_type if error_type == "pdf_generation_failed" else "pdf_generation_failed"
        return {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF generation failed",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The builder tried to create the PDF, but PDF generation failed before a valid file could be written."),
            "companion_tone_hint": "Direct and apologetic — PDF generation failed; offer to retry.",
            "user_next_action": "Ask me to retry the PDF build.",
            "confidence": 0.0,
            "error_reason": safe_reason,
        }

    def _pdf_generation_failure_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
    ) -> Command:
        error_type = str(payload.get("error_type") or "pdf_generation_failed")
        fallback = self._pdf_generation_failed_fallback(
            steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
            error_type=error_type,
        )
        logger.warning(
            "BuilderArtifact: terminal PDF generation failure reason=%s",
            fallback["error_reason"],
        )
        self._upload_fallback_and_fire(
            state=request.state,
            runtime=request.runtime,
            fallback=fallback,
            status="failed",
        )
        return Command(
            update={
                "messages": [result],
                "builder_pdf_render_result": payload,
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
            },
            goto="end",
        )

    @staticmethod
    def _pdf_page_count_failure_fallback(
        *,
        steps_completed: int,
        state: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        page_counts = _pdf_page_count_failure_payload(state, payload)
        requested = page_counts["requested_pages"]
        actual = page_counts["actual_pages"]
        return {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF layout did not meet the requested page count",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (f"The builder rendered the PDF and attempted bounded layout repairs, but it ended at {actual} pages instead of the requested {requested}."),
            "companion_tone_hint": ("Direct and apologetic — PDF rendering completed, but exact page-count acceptance failed after bounded repairs."),
            "user_next_action": "Ask me to retry the PDF build with a revised length target.",
            "confidence": 0.0,
            "error_reason": "pdf_page_count_off_target",
            "artifact_acceptance_status": "failed",
            "failure_code": "pdf_page_count_off_target",
            "requested_pages": requested,
            "actual_pages": actual,
            "page_delta": page_counts["page_delta"],
            "layout_quality": payload.get("layout_quality"),
            "layout_warning": payload.get("layout_warning"),
        }

    def _pdf_page_count_failure_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
    ) -> Command:
        fallback = _apply_artifact_request_metadata(
            self._pdf_page_count_failure_fallback(
                steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
                state=request.state,
                payload=payload,
            ),
            request.state,
            fallback_reason="pdf_page_count_off_target",
        )
        logger.warning(
            "BuilderArtifact: terminal PDF page-count failure requested_pages=%s actual_pages=%s page_delta=%s repair_attempts=%d",
            fallback["requested_pages"],
            fallback["actual_pages"],
            fallback["page_delta"],
            _pdf_layout_repair_attempts(request.state),
        )
        self._upload_fallback_and_fire(
            state=request.state,
            runtime=request.runtime,
            fallback=fallback,
            status="failed",
        )
        return Command(
            update={
                "messages": [result],
                "builder_pdf_render_result": payload,
                "builder_pdf_layout_repair_pending": False,
                "builder_pdf_phase": "terminal",
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                **_terminal_halt_fields(request.state, "pdf_page_count_off_target"),
            },
            goto="end",
        )

    def _pdf_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> ToolMessage | Command:
        delta = self._render_pdf_result_delta(result)
        if delta is None:
            return result
        payload = _enrich_pdf_render_result_with_requested_pages(
            delta["builder_pdf_render_result"],
            request.state,
        )
        delta["builder_pdf_render_result"] = payload
        delta["builder_pdf_layout_repair_pending"] = False
        error_type = str(payload.get("error_type") or "")
        if error_type in _PDF_REPORT_CONTRACT_ERROR_TYPES:
            return self._pdf_contract_result_command(request, result, payload)
        if request.tool_call.get("name") == _SIMPLE_PDF_TOOL_NAME and payload.get("success") is False and payload.get("error_type") == "pdf_generation_failed":
            return self._pdf_generation_failure_command(request, result, payload)
        if payload.get("success") is True:
            delta["builder_pdf_phase"] = "rendered"
            delta["builder_pdf_contract_repair_pending"] = False
            terminal_state = {**request.state, "builder_pdf_render_result": payload}
            if _pdf_render_page_count_failed_after_repairs(terminal_state):
                return self._pdf_page_count_failure_command(request, result, payload)
        return Command(update={"messages": [result], **delta})

    @staticmethod
    def _image_generation_bash_delta(
        *,
        command: str,
        text: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        image_segments = _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS)
        preflight_delta, preflight_blocked = BuilderArtifactMiddleware._image_generation_preflight_result(
            image_segments,
            text,
        )
        if preflight_blocked:
            return preflight_delta
        billable_segments = BuilderArtifactMiddleware._billable_image_generation_segments(image_segments)
        if not billable_segments:
            return preflight_delta

        manifest_segments = [s for s in billable_segments if _command_flag_value(s, "--manifest")]
        single_segments = [s for s in billable_segments if not _command_flag_value(s, "--manifest")]

        # Single-image segments keep the existing per-segment output validation.
        statuses = [_image_generation_segment_status(segment=segment, text=text, state=state) for segment in single_segments]
        successful_paths = [output_path for output_path, valid_image, _bytes_count, _error_class, _status_reason in statuses if output_path and valid_image]
        bytes_total = sum(bytes_count for _output_path, valid_image, bytes_count, _error_class, _status_reason in statuses if valid_image)
        error_class = next(
            (status_error for _output_path, valid_image, _bytes_count, status_error, _status_reason in statuses if not valid_image and status_error),
            None,
        )

        manifest_delta: dict[str, Any] = {}
        if manifest_segments:
            manifest_paths = [manifest_path for segment in manifest_segments for manifest_path in [_command_flag_value(segment, "--manifest")] if manifest_path]
            manifest_requested_hint = sum(_manifest_item_count(state, manifest_path) for manifest_path in manifest_paths)
            batch_paths, batch_bytes, batch_error_class, manifest_delta = _image_generation_manifest_result_delta(
                state,
                text,
                requested_hint=manifest_requested_hint,
                manifest_paths=manifest_paths,
                command=command,
            )
            successful_paths.extend(batch_paths)
            bytes_total += batch_bytes
            error_class = error_class or batch_error_class

        # attempt_count tracks provider image attempts, not control-plane
        # startup failures. A missing manifest summary before any structured
        # batch attempt did not reach the provider and should not consume the
        # image budget/cost breaker.
        startup_only_failure = bool(manifest_delta.get("image_generation_startup_attempt_count")) and not bool(manifest_delta.get("image_generation_manifest_generation_attempted")) and not single_segments and not successful_paths
        attempt_count = 0 if startup_only_failure else max(1, _image_generation_images_in_command(command, state))
        delta: dict[str, Any] = {
            **preflight_delta,
            "image_generation_attempt_count": attempt_count,
            "image_generation_success_count": len(successful_paths),
            "image_generation_bytes_total": bytes_total,
            "image_generation_error_class": error_class,
        }
        diagnostics = _pptx_diagnostics(state)
        expected_visuals = int(manifest_delta.get("expected_generated_visual_count") or diagnostics.get("expected_generated_visual_count") or _pptx_latch_target_slide_count(state) or 0)
        if expected_visuals > 0:
            delta["expected_generated_visual_count"] = expected_visuals
        delta["successful_generated_visual_count"] = int(diagnostics.get("image_generation_success_count", 0) or 0) + len(successful_paths)
        if single_segments and diagnostics.get("image_generation_manifest_generation_attempted") and int(diagnostics.get("image_generation_manifest_requested_count", 0) or 0) > 0:
            delta["serial_repair_count"] = len(single_segments)
            repair_attempts = _serial_repair_output_attempts(diagnostics)
            for output_file in _serial_repair_output_paths_for_segments(single_segments):
                if output_file:
                    repair_attempts[output_file] = repair_attempts.get(output_file, 0) + 1
            if repair_attempts:
                delta["serial_repair_output_attempts"] = repair_attempts
            if len(successful_paths) > 0 and diagnostics.get("primary_image_batch_status") == "failed":
                delta["primary_image_batch_status"] = "repaired"
        delta.update(manifest_delta)
        delta.update(_image_generation_success_path_delta(state, successful_paths))
        return delta

    @staticmethod
    def _image_generation_preflight_result(
        image_segments: list[str],
        text: str,
    ) -> tuple[dict[str, Any], bool]:
        if not any("--preflight" in _command_parts(segment) for segment in image_segments):
            return {}, False
        preflight_delta = _image_generation_preflight_delta(text)
        return preflight_delta, preflight_delta.get("image_generation_preflight") != "ok"

    @staticmethod
    def _billable_image_generation_segments(image_segments: list[str]) -> list[str]:
        return [segment for segment in image_segments if "--preflight" not in _command_parts(segment)]

    @staticmethod
    def _attach_pptx_canvas_preview(
        args: dict[str, Any],
        state: dict[str, Any],
    ) -> dict[str, Any]:
        """Render a ``<deck>.preview.pdf`` sibling for an accepted .pptx emit.

        The webapp has no native PPTX renderer; the preview lets the existing
        PDF canvas display the deck (paging/zoom/voice commands) while the
        download still serves the original PowerPoint. Best-effort: requires
        soffice on PATH, never blocks acceptance.
        """
        artifact_path = args.get("artifact_path")
        if _artifact_ext_from_path(artifact_path) != "pptx":
            return args
        updated = dict(args)
        artifact_files = [entry for entry in (updated.get("artifact_files") or []) if isinstance(entry, dict)]
        deck_build_path = _pptx_diagnostics(state).get("deck_build_path")
        if isinstance(deck_build_path, str) and deck_build_path.strip():
            deck_build_name = PurePosixPath(deck_build_path).name
            if not any(entry.get("path") == deck_build_path for entry in artifact_files):
                artifact_files.append({"path": deck_build_path, "role": "internal", "name": deck_build_name})
        if artifact_files:
            updated["artifact_files"] = _artifact_file_entries({**updated, "artifact_files": artifact_files})
        host_file = _local_output_file_for_artifact(state, artifact_path)
        if host_file is None or not host_file.is_file():
            return updated
        remaining = _remaining_builder_deadline_seconds(state)
        if remaining is not None and remaining <= 5:
            logger.warning(
                "[PptxPreview] skipped because builder deadline has %ss remaining",
                remaining,
            )
            return updated
        preview = (
            maybe_render_pptx_preview(
                host_file,
                timeout_seconds=min(300, remaining - 2),
            )
            if remaining is not None
            else maybe_render_pptx_preview(host_file)
        )
        if preview is None:
            return updated
        updated["artifact_preview_filename"] = preview.name
        preview_virtual = str(PurePosixPath(str(artifact_path)).parent / preview.name)
        supporting = [path for path in (updated.get("supporting_files") or []) if isinstance(path, str)]
        if preview_virtual not in supporting:
            supporting.append(preview_virtual)
        updated["supporting_files"] = supporting
        artifact_files = [entry for entry in (updated.get("artifact_files") or []) if isinstance(entry, dict)]
        if not any(entry.get("path") == preview_virtual for entry in artifact_files):
            artifact_files.append({"path": preview_virtual, "role": "preview", "name": preview.name})
        updated["artifact_files"] = _artifact_file_entries({**updated, "artifact_files": artifact_files})
        return updated

    @staticmethod
    def _host_path_for_plan_file(state: dict[str, Any], plan_path: str) -> Path | None:
        normalized = str(plan_path).replace("\\", "/").strip()
        thread_data = state.get("thread_data") or {}
        if not isinstance(thread_data, dict):
            return None
        for prefix, key in (
            ("/mnt/user-data/workspace/", "workspace_path"),
            ("/mnt/user-data/outputs/", "outputs_path"),
        ):
            root = thread_data.get(key)
            if normalized.startswith(prefix) and isinstance(root, str) and root:
                relative = normalized[len(prefix) :].strip("/")
                if ".." in PurePosixPath(relative).parts:
                    return None
                return Path(root) / relative
        return None

    @classmethod
    def _maybe_autowire_pptx_plan_visuals(cls, request: ToolCallRequest) -> None:
        """Deterministically wire generated visual PNGs into the slide plan.

        Prod 2026-06-10: two decks shipped with ``slide_image_count=0`` while
        the chart PNGs the model generated sat unused under
        ``outputs/visuals/`` — the (fallback-provider) model never referenced
        them from the plan JSON. Before the ppt-generation script runs, this
        hook (a) drops slide image refs pointing at nonexistent files (which
        would abort composition with FileNotFoundError) and (b) if visuals
        were requested but no slide references one, assigns the existing
        assets (hero images first, then chart PNGs) across the slides.
        """
        state = request.state or {}
        plan_path = _autowire_plan_path(request)
        if plan_path is None:
            return
        host_plan = cls._host_path_for_plan_file(state, plan_path)
        if host_plan is None or not host_plan.is_file():
            return
        plan, slides = _load_plan_slides(host_plan)
        if plan is None or slides is None:
            return

        referenced, changed = _drop_invalid_slide_image_refs(slides, state, plan_dir=host_plan.parent)
        if referenced == 0 and _visuals_requested(state) and _outputs_root_from_state(state) is not None:
            changed = _wire_plan_visual_assets(slides, state) or changed

        if changed:
            _write_plan_file(host_plan, plan, plan_path)

    @staticmethod
    def _pptx_generation_bash_delta(
        *,
        command: str,
        text: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        pptx_command = _command_segment_for_marker(command, _PPTX_GENERATOR_PATH_MARKERS)
        output_path = _command_flag_value(pptx_command, "--output-file")
        exists, bytes_count, status_reason = _virtual_output_status(state, output_path)
        error_class = _classify_pptx_generation_error(state, output_path, text, exists)
        valid_pptx = error_class is None
        slide_count = len(_command_flag_values(pptx_command, "--slide-images"))
        generated_slide_count = _pptx_slide_count_from_text(text)
        picture_count = _pptx_picture_count_from_text(text)
        logger.info(
            "[BuilderPptxGeneration] success=%s output_ext=%s bytes=%d slide_image_count=%d slide_count=%d picture_count=%d error_class=%s status_reason=%s",
            valid_pptx,
            PurePosixPath(str(output_path or "")).suffix.lower().lstrip(".") or None,
            bytes_count,
            slide_count,
            generated_slide_count,
            picture_count,
            error_class,
            status_reason,
        )
        _safe_langsmith_span(
            "Sophia PPTX Compile",
            inputs={
                "compiler": "ppt-generation/scripts/generate.py",
                "output_file": output_path,
                "expected_slide_image_count": slide_count,
                "plan": _pptx_plan_diagnostics_from_command(pptx_command, state).get("pptx_plan_json"),
            },
            outputs={
                "success": valid_pptx,
                "output_bytes": bytes_count if valid_pptx else 0,
                "slide_count": generated_slide_count,
                "picture_count": picture_count,
                "error_class": error_class,
                "status_reason": status_reason,
            },
            metadata={
                "sophia_component": "builder_pptx_compile",
                "pptx_compile_success": valid_pptx,
                "pptx_compile_error_class": error_class,
            },
            tags=["pptx", "compile"],
        )
        delta: dict[str, Any] = {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 1 if valid_pptx else 0,
            "pptx_generator_bytes_total": bytes_count if valid_pptx else 0,
            "pptx_generator_error_class": error_class,
            # Absolute properties of the latest compiled deck; retries replace these counts.
            "pptx_generator_slide_count": generated_slide_count,
            "pptx_generator_picture_count": picture_count,
            "pptx_slide_title_results": _pptx_slide_title_results_from_text(text),
            **_pptx_plan_diagnostics_from_command(pptx_command, state),
        }
        if output_path and valid_pptx:
            delta["pptx_output_paths"] = [output_path]
            if _pptx_diagnostics(state).get("time_to_first_valid_artifact_ms") is None:
                elapsed = _elapsed_since_builder_start_ms(state)
                if elapsed is not None:
                    delta["time_to_first_valid_artifact_ms"] = elapsed
        return delta

    @staticmethod
    def _pptx_bash_result_delta(
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any] | None:
        args = request.tool_call.get("args") or {}
        if not isinstance(args, dict):
            return None
        command = str(args.get("command") or "")
        text = BuilderArtifactMiddleware._tool_message_text(result)
        state = request.state or {}
        delta: dict[str, Any] = {}
        if any(marker in command for marker in _IMAGE_GENERATION_PATH_MARKERS):
            delta = _merge_builder_pptx_diagnostics(
                delta,
                BuilderArtifactMiddleware._image_generation_bash_delta(
                    command=command,
                    text=text,
                    state=state,
                ),
            )
        if any(marker in command for marker in _SLIDE_QC_PATH_MARKERS):
            delta = _merge_builder_pptx_diagnostics(delta, _slide_qc_bash_delta(command, text, state))
        if any(marker in command for marker in _PPTX_GENERATOR_PATH_MARKERS):
            delta = _merge_builder_pptx_diagnostics(
                delta,
                BuilderArtifactMiddleware._pptx_generation_bash_delta(
                    command=command,
                    text=text,
                    state=state,
                ),
            )
        return delta or None

    def _pptx_bash_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        delta = self._pptx_bash_result_delta(request, result)
        if delta is None:
            return result
        update: dict[str, Any] = {
            "messages": [result],
            "builder_pptx_diagnostics": delta,
        }
        if "pptx_generator_attempt_count" in delta:
            update["builder_pptx_compile_latch_pending"] = False
        return Command(update=update)

    def _visual_asset_result_command(
        self,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        delta = _visual_asset_result_delta(result)
        if delta is None:
            return result
        return Command(
            update={
                "messages": [result],
                "builder_visual_diagnostics": delta,
            }
        )

    @staticmethod
    def _deck_builder_result_payload(result: ToolMessage) -> dict[str, Any] | None:
        text = BuilderArtifactMiddleware._tool_message_text(result)
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _pptx_manifest_tool_result_delta(result: ToolMessage) -> dict[str, Any] | None:
        text = BuilderArtifactMiddleware._tool_message_text(result)
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        success = payload.get("success") is True
        expected_count = int(payload.get("expected_count") or 0)
        raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
        expected_items: list[dict[str, Any]] = []
        unresolved_outputs: list[str] = []
        for index, item in enumerate(raw_items, start=1):
            if not isinstance(item, dict):
                continue
            output_path = str(item.get("output_path") or "")
            expected_items.append(
                {
                    "item_index": index,
                    "slide_index": item.get("slide_index") if isinstance(item.get("slide_index"), int) else index,
                    "prompt_file": str(item.get("prompt_file") or ""),
                    "prompt_hash": item.get("prompt_hash"),
                    "prompt_readable": True,
                    "output_file": output_path,
                    "output_basename": PurePosixPath(output_path).name,
                    "slide_visual": True,
                }
            )
            if _canonical_outputs_artifact_path(output_path) is not None:
                unresolved_outputs.append(output_path)
        if success:
            return {
                "image_generation_manifest_seen": True,
                "image_generation_manifest_requested_count": expected_count,
                "image_generation_manifest_complete": False,
                "image_generation_manifest_generation_attempted": False,
                "image_generation_manifest_expected_items": expected_items,
                "image_generation_manifest_unresolved_outputs": unresolved_outputs,
                "expected_generated_visual_count": expected_count,
                "successful_generated_visual_count": 0,
                "primary_image_batch_status": "skipped",
                "primary_image_batch_error_class": None,
            }
        error_type = str(payload.get("error_type") or "manifest_authoring_failed")
        return {
            "manifest_authoring_failure_count": 1,
            "primary_image_batch_status": "failed",
            "primary_image_batch_error_class": error_type,
            "expected_generated_visual_count": expected_count,
            "successful_generated_visual_count": 0,
        }

    @staticmethod
    def _prepare_repair_attempt_count(state: dict[str, Any]) -> int:
        """Return the single repair budget, honoring legacy queued state."""

        diagnostics = _pptx_diagnostics(state)
        return max(
            int(state.get("builder_deck_prepare_repair_attempt_count", 0) or 0),
            int(bool(int(state.get("builder_deck_ir_repair_attempt_count", 0) or 0))),
            int(bool(int(state.get("builder_deck_creative_repair_attempt_count", 0) or 0))),
            int(bool(int(diagnostics.get("prepare_schema_failure_count", 0) or 0))),
            int(bool(diagnostics.get("prepare_retry_executed"))),
        )

    @staticmethod
    def _prepare_deck_build_result_delta(
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any] | None:
        payload = BuilderArtifactMiddleware._deck_builder_result_payload(result)
        if payload is None:
            return None
        success = payload.get("success") is True
        pptx_path = payload.get("pptx_path") if isinstance(payload.get("pptx_path"), str) else None
        exists, bytes_count, status_reason = _virtual_output_status(request.state or {}, pptx_path)
        if success and not exists:
            success = False
        slide_count = int(payload.get("slide_count") or 0)
        expected = int(payload.get("expected_visual_count") or 0)
        successful = int(payload.get("successful_visual_count") or 0)
        referenced = int(payload.get("referenced_visual_count") if payload.get("referenced_visual_count") is not None else successful or 0)
        missing = int(payload.get("missing_visual_count") if payload.get("missing_visual_count") is not None else max(0, expected - min(successful, referenced)))
        quality_status = str(payload.get("quality_status") or ("passed" if success else "failed"))
        creative_plan_accepted = bool(str(payload.get("creative_plan_path") or "").strip())
        repair_count = BuilderArtifactMiddleware._prepare_repair_attempt_count(request.state or {})
        retry_executed = repair_count > 0
        failure_code = payload.get("failure_code") or (None if success else status_reason or "deck_build_failed")
        prior_diagnostics = _pptx_diagnostics(request.state or {})
        root_failure_code = payload.get("root_failure_code") or prior_diagnostics.get("deck_root_failure_code") or (failure_code if not success else None)
        root_failure_summary = payload.get("root_failure_summary") or prior_diagnostics.get("deck_root_failure_summary") or (payload.get("failure_summary") if not success else None)
        image_generation_status = str(payload.get("image_generation_status") or ("success" if success else "failed"))
        primary_image_batch_status = str(payload.get("primary_image_batch_status") or ("success" if success else "failed"))
        primary_image_batch_error_class = payload.get("primary_image_batch_error_class") or (None if success else failure_code)
        deck_route = str(payload.get("deck_route") or "deck_creative_html_native")
        deck_compile_mode = str(payload.get("deck_compile_mode") or "not_compiled")
        delta: dict[str, Any] = {
            "presentation_route": deck_route,
            "deck_route": deck_route,
            "deck_compile_mode": deck_compile_mode,
            "native_required": bool(payload.get("native_required", True)),
            "legacy_screenshot_debug": bool(payload.get("legacy_screenshot_debug", False)),
            "deck_build_id": payload.get("build_id"),
            "deck_schema_version": "sophia-deck-build/v1",
            "deck_status": "evaluated" if success else "failed_terminal",
            "deck_quality_status": quality_status,
            "deck_failure_code": failure_code,
            "deck_root_failure_code": root_failure_code,
            "deck_root_failure_summary": root_failure_summary,
            "last_prepare_failure_code": failure_code if not success else None,
            "last_prepare_failure_summary": payload.get("failure_summary") if not success else None,
            "deck_template_renderer_version": "deck_creative_html_native_v1",
            "expected_generated_visual_count": expected,
            "successful_generated_visual_count": successful,
            "referenced_visual_count": referenced,
            "missing_expected_visual_count": missing,
            "creative_plan_accepted": creative_plan_accepted,
            "generated_visuals_complete": (creative_plan_accepted and expected == successful == referenced and missing == 0),
            "prepare_execution_count": 1,
            "prepare_result_count": 1,
            "prepare_normalized_call_count": 1,
            "prepare_service_call_count": 1,
            "prepare_service_result_count": 1,
            "prepare_retry_executed": retry_executed,
            "prepare_repair_count": repair_count,
            "image_generation_status": image_generation_status,
            "image_generation_reason": payload.get("image_generation_reason"),
            "primary_image_batch_status": primary_image_batch_status,
            "primary_image_batch_error_class": primary_image_batch_error_class,
            "serial_repair_count": int(payload.get("serial_repair_count") or 0),
            "batch_timeout_count": int(payload.get("batch_timeout_count") or 0),
            "partial_batch_salvaged": bool(payload.get("partial_batch_salvaged")),
            "pptx_plan_slide_count": slide_count,
            "pptx_generator_slide_count": slide_count if success else 0,
            "pptx_generator_picture_count": int(payload.get("picture_shape_count") or 0) if success else 0,
            "pptx_generator_attempt_count": 1 if success else 0,
            "pptx_generator_success_count": 1 if success else 0,
            "pptx_generator_bytes_total": bytes_count if success else 0,
            "pptx_generator_error_class": None if success else failure_code,
        }
        service_elapsed_ms = payload.get("service_elapsed_ms")
        if isinstance(service_elapsed_ms, int) and not isinstance(service_elapsed_ms, bool):
            delta["deck_service_elapsed_ms"] = max(0, service_elapsed_ms)
        repair_started_ms = (request.state or {}).get("builder_deck_prepare_repair_started_at_ms")
        if isinstance(repair_started_ms, (int, float)) and repair_started_ms > 0:
            delta["deck_repair_elapsed_ms"] = max(
                0,
                int(time.time() * 1000) - int(repair_started_ms),
            )
        delta.update(
            BuilderArtifactMiddleware._prepare_deck_build_optional_delta(
                payload=payload,
                pptx_path=pptx_path,
                success=success,
                state=request.state or {},
            )
        )
        return delta

    @staticmethod
    def _prepare_deck_build_optional_delta(
        *,
        payload: dict[str, Any],
        pptx_path: str | None,
        success: bool,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        delta: dict[str, Any] = {}
        native_editability_score = payload.get("native_editability_score")
        if isinstance(native_editability_score, (int, float)) and not isinstance(native_editability_score, bool):
            delta["native_editability_score"] = native_editability_score
        for key in ("native_text_shape_count", "picture_shape_count", "full_slide_picture_count"):
            value = payload.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                delta[key] = value
        if pptx_path and success:
            delta["pptx_output_paths"] = [pptx_path]
            if _pptx_diagnostics(state).get("time_to_first_valid_artifact_ms") is None:
                elapsed = _elapsed_since_builder_start_ms(state)
                if elapsed is not None:
                    delta["time_to_first_valid_artifact_ms"] = elapsed
        if payload.get("quality_warning"):
            delta["pptx_deck_quality_warning"] = payload.get("quality_warning")
        native_mechanical = payload.get("native_mechanical_report")
        if isinstance(native_mechanical, dict):
            delta["native_mechanical_report"] = native_mechanical
        mechanical_gates = payload.get("mechanical_gate_results")
        if isinstance(mechanical_gates, dict):
            delta["mechanical_gate_results"] = mechanical_gates
        html_validation = payload.get("html_source_validation")
        if isinstance(html_validation, dict):
            delta["html_source_validation"] = html_validation
        source_retention = payload.get("source_retention_report")
        if isinstance(source_retention, dict):
            delta["source_retention_report"] = source_retention
        native_contrast = payload.get("native_contrast_report")
        if isinstance(native_contrast, dict):
            delta["native_contrast_report"] = native_contrast
        creative_plan_path = payload.get("creative_plan_path")
        if isinstance(creative_plan_path, str) and creative_plan_path.strip():
            delta["creative_plan_path"] = creative_plan_path
        deck_build_path = payload.get("deck_build_path")
        if isinstance(deck_build_path, str) and deck_build_path.strip():
            delta["deck_build_path"] = deck_build_path
        for key in (
            "source_bundle_path",
            "manifest_path",
            "logical_artifact_id",
            "current_artifact_version_id",
            "foundation_status",
        ):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                delta[key] = value.strip()
        manifest_revision = payload.get("manifest_revision")
        if isinstance(manifest_revision, int) and not isinstance(manifest_revision, bool):
            delta["manifest_revision"] = manifest_revision
        delta.update(BuilderArtifactMiddleware._prepare_deck_build_authoring_delta(payload))
        return delta

    @staticmethod
    def _prepare_deck_build_authoring_delta(payload: dict[str, Any]) -> dict[str, Any]:
        delta: dict[str, Any] = {}
        authoring_contract = payload.get("deck_authoring_contract")
        if isinstance(authoring_contract, str) and authoring_contract.strip():
            delta["deck_authoring_contract"] = authoring_contract.strip()
        for key in ("deck_html_fragment_count", "deck_assembled_html_bytes"):
            value = payload.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                delta[key] = value
        stylesheet_hash = payload.get("deck_stylesheet_hash")
        if isinstance(stylesheet_hash, str) and stylesheet_hash.strip():
            delta["deck_stylesheet_hash"] = stylesheet_hash.strip()[:128]
        return delta

    @staticmethod
    def _prepare_deck_build_retry_command(
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
        delta: dict[str, Any],
    ) -> Command | None:
        failure_code = str(payload.get("failure_code") or delta.get("deck_failure_code") or "")
        retryable = bool(payload.get("retryable"))
        retryable_codes = {
            "invalid_deck_ir",
            "deck_creative_plan_required",
            "deck_creative_plan_invalid",
            "deck_slide_html_missing",
            "deck_slide_html_invalid",
            "deck_image_asset_plan_invalid",
            "deck_mechanical_gate_failed",
        }
        if failure_code not in retryable_codes or not retryable:
            return None
        state = request.state or {}
        repair_attempt_count = BuilderArtifactMiddleware._prepare_repair_attempt_count(state)
        if failure_code == "invalid_deck_ir":
            instruction = deck_ir_repair_instruction_from_failure(
                failure_code=failure_code,
                failure_summary=str(payload.get("failure_summary") or ""),
                retryable=retryable,
                attempt_count=repair_attempt_count,
            )
            should_retry = repair_attempt_count < 1 and instruction.should_retry
            message = instruction.repair_message
            counter_key = "builder_deck_ir_repair_attempt_count"
            last_failure_key = "builder_last_deck_ir_failure"
            component = "deck_ir_repair"
        else:
            should_retry = repair_attempt_count < 1
            repair_payload = payload.get("repair_instruction")
            message = ""
            if isinstance(repair_payload, dict):
                message = str(repair_payload.get("repair_message") or repair_payload.get("message") or "")
            if not message:
                message = "Repair the D2.1 creative deck input and call prepare_deck_build exactly once more. Provide creative_plan, shared deck_stylesheet, and html_body for every slide; keep generated images as planned assets only."
            counter_key = "builder_deck_creative_repair_attempt_count"
            last_failure_key = "builder_last_deck_creative_failure"
            component = "deck_creative_repair"
        _safe_langsmith_span(
            "deck.prepare.repair_instruction",
            inputs={
                "failure_code": failure_code,
                "retryable": retryable,
                "attempt_count": repair_attempt_count,
            },
            outputs={
                "should_retry": should_retry,
                "max_retry_count": 1,
            },
            metadata={"sophia_component": component},
            tags=["pptx", "deck_build", "repair"],
        )
        if not should_retry:
            return None
        _safe_langsmith_span(
            "deck.prepare.retry",
            inputs={"failure_code": failure_code, "attempt_count": repair_attempt_count},
            outputs={"next_attempt_count": repair_attempt_count + 1},
            metadata={"sophia_component": component},
            tags=["pptx", "deck_build", "retry"],
        )
        return Command(
            update={
                # Preserve the real tool result and let the normal tools ->
                # model edge advance the graph. The repair prompt is injected
                # by before_model after tool-result adjacency is complete.
                "messages": [result],
                "builder_pptx_diagnostics": {
                    **delta,
                    "prepare_retry_executed": True,
                    "prepare_repair_count": 1,
                },
                "builder_deck_prepare_repair_attempt_count": 1,
                "builder_deck_prepare_repair_started_at_ms": int(time.time() * 1000),
                counter_key: 1,
                last_failure_key: {
                    "failure_code": failure_code,
                    "failure_summary": payload.get("failure_summary"),
                    "retryable": retryable,
                    "attempt_count": repair_attempt_count,
                },
                "builder_deck_prepare_phase": "retry_pending",
                "builder_deck_prepare_repair_message": message,
                "builder_deck_prepare_repair_prompt_injected": False,
                "builder_deck_prepare_expected_tool_call_id": None,
                "builder_pptx_compile_latch_pending": False,
                "builder_pptx_compile_repair_pending": False,
            }
        )

    def _prepare_execution_error_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        tool_error: dict[str, Any],
    ) -> Command:
        state = request.state or {}
        error_class = str(tool_error.get("error_class") or "tool_execution_error")
        delta = {
            "prepare_execution_count": 1,
            "prepare_result_count": 1,
            "deck_status": "failed_terminal",
            "deck_failure_code": "deck_prepare_execution_error",
            "deck_root_failure_code": "deck_prepare_execution_error",
            "deck_root_failure_summary": "prepare_deck_build failed during tool execution.",
            "prepare_error_class": error_class[:128],
        }
        payload = {
            "success": False,
            "failure_code": "deck_prepare_execution_error",
            "failure_summary": "The presentation build could not start because its deck tool failed.",
            "root_failure_code": "deck_prepare_execution_error",
            "root_failure_summary": "prepare_deck_build failed during tool execution.",
            "retryable": False,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=state,
            runtime=request.runtime,
            payload=payload,
            delta=delta,
        )
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": delta,
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_deck_prepare_phase": "terminal",
                "builder_presentation_phase": "terminal",
                "builder_deck_prepare_expected_tool_call_id": None,
                **_terminal_halt_fields(state, "deck_prepare_execution_error"),
            },
            goto="end",
        )

    def _prepare_schema_error_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> Command:
        state = request.state or {}
        diagnostics = _pptx_diagnostics(state)
        repair_attempt_count = self._prepare_repair_attempt_count(state)
        validation_summary = ""
        tool_error = result.additional_kwargs.get("tool_error")
        if isinstance(tool_error, dict):
            validation_summary = str(tool_error.get("validation_summary") or "").strip()
        schema_delta = {
            "prepare_execution_count": 1,
            "prepare_result_count": 1,
            "prepare_schema_failure_count": 1,
            "deck_status": "failed_terminal" if repair_attempt_count >= 1 else "repair_pending",
            "deck_failure_code": "deck_prepare_argument_invalid",
            "deck_root_failure_code": diagnostics.get("deck_root_failure_code") or "deck_prepare_argument_invalid",
            "deck_root_failure_summary": diagnostics.get("deck_root_failure_summary") or "prepare_deck_build arguments failed typed schema validation.",
            "last_prepare_failure_code": "deck_prepare_argument_invalid",
            "last_prepare_failure_summary": validation_summary or "prepare_deck_build arguments failed typed schema validation.",
            "prepare_repair_count": repair_attempt_count,
            "prepare_retry_executed": repair_attempt_count > 0,
        }
        if repair_attempt_count < 1:
            repair_message = (
                "Repair the prepare_deck_build arguments using compact_model_html_v2 and the canonical typed schema. "
                "Pass creative_plan as a JSON object, not a JSON-encoded string; include every required creative_plan "
                "field, deck_stylesheet, and slide html_body, then call prepare_deck_build exactly once more."
            )
            if validation_summary:
                repair_message += f" Fix these validation errors: {validation_summary}"
            return Command(
                update={
                    "messages": [result],
                    "builder_pptx_diagnostics": {
                        **schema_delta,
                        "prepare_repair_count": 1,
                        "prepare_retry_executed": True,
                    },
                    "builder_deck_prepare_repair_attempt_count": 1,
                    "builder_deck_prepare_phase": "retry_pending",
                    "builder_deck_prepare_repair_message": repair_message,
                    "builder_deck_prepare_repair_prompt_injected": False,
                    "builder_deck_prepare_expected_tool_call_id": None,
                }
            )
        failure_payload = {
            "success": False,
            "failure_code": "deck_prepare_retry_exhausted",
            "failure_summary": "prepare_deck_build exhausted its single repair after typed argument validation failed.",
            "root_failure_code": schema_delta["deck_root_failure_code"],
            "root_failure_summary": schema_delta["deck_root_failure_summary"],
            "last_prepare_failure_code": schema_delta["last_prepare_failure_code"],
            "last_prepare_failure_summary": schema_delta["last_prepare_failure_summary"],
            "retryable": False,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=state,
            runtime=request.runtime,
            payload=failure_payload,
            delta=schema_delta,
        )
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": schema_delta,
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_deck_prepare_phase": "terminal",
                "builder_presentation_phase": "terminal",
                "builder_deck_prepare_expected_tool_call_id": None,
                **_terminal_halt_fields(state, "deck_prepare_retry_exhausted"),
            },
            goto="end",
        )

    def _prepare_retry_exhausted_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
        delta: dict[str, Any],
    ) -> Command:
        state = request.state or {}
        diagnostics = _pptx_diagnostics(state)
        last_failure_code = str(payload.get("failure_code") or delta.get("deck_failure_code") or "deck_build_failed")
        last_failure_summary = str(payload.get("failure_summary") or "The repaired deck input still failed validation.")
        terminal_delta = {
            **delta,
            "deck_status": "failed_terminal",
            "deck_failure_code": "deck_prepare_retry_exhausted",
            "deck_root_failure_code": diagnostics.get("deck_root_failure_code") or delta.get("deck_root_failure_code") or last_failure_code,
            "deck_root_failure_summary": diagnostics.get("deck_root_failure_summary") or delta.get("deck_root_failure_summary") or last_failure_summary,
            "last_prepare_failure_code": last_failure_code,
            "last_prepare_failure_summary": last_failure_summary,
            "prepare_repair_count": max(1, self._prepare_repair_attempt_count(state)),
            "prepare_retry_executed": True,
        }
        failure_payload = {
            "success": False,
            "failure_code": "deck_prepare_retry_exhausted",
            "failure_summary": "prepare_deck_build exhausted its single structured repair.",
            "root_failure_code": terminal_delta["deck_root_failure_code"],
            "root_failure_summary": terminal_delta["deck_root_failure_summary"],
            "last_prepare_failure_code": last_failure_code,
            "last_prepare_failure_summary": last_failure_summary,
            "retryable": False,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=state,
            runtime=request.runtime,
            payload=failure_payload,
            delta=terminal_delta,
        )
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": terminal_delta,
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_deck_prepare_phase": "terminal",
                "builder_presentation_phase": "terminal",
                "builder_deck_prepare_expected_tool_call_id": None,
                **_terminal_halt_fields(state, "deck_prepare_retry_exhausted"),
            },
            goto="end",
        )

    def _prepare_deck_build_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        tool_error = result.additional_kwargs.get("tool_error")
        execution_error = str(getattr(result, "status", "") or "").lower() == "error" and isinstance(tool_error, dict) and tool_error.get("stage") != "argument_validation"
        if execution_error:
            return self._prepare_execution_error_command(request, result, tool_error)
        payload = self._deck_builder_result_payload(result)
        delta = self._prepare_deck_build_result_delta(request, result)
        if delta is None or payload is None:
            return self._prepare_schema_error_command(request, result)
        if delta.get("deck_status") == "failed_terminal":
            retry_command = self._prepare_deck_build_retry_command(request, result, payload, delta)
            if retry_command is not None:
                return retry_command
            retryable_codes = {
                "invalid_deck_ir",
                "deck_creative_plan_required",
                "deck_creative_plan_invalid",
                "deck_slide_html_missing",
                "deck_slide_html_invalid",
                "deck_image_asset_plan_invalid",
                "deck_mechanical_gate_failed",
            }
            failure_code = str(payload.get("failure_code") or delta.get("deck_failure_code") or "")
            if (
                bool(payload.get("retryable"))
                and failure_code in retryable_codes
                and self._prepare_repair_attempt_count(request.state or {}) >= 1
            ):
                return self._prepare_retry_exhausted_result_command(request, result, payload, delta)
            fallback = self._prepare_deck_build_failure_fallback(
                state=request.state or {},
                runtime=request.runtime,
                payload=payload,
                delta=delta,
            )
            return Command(
                update={
                    "messages": [result],
                    "builder_pptx_diagnostics": delta,
                    "builder_result": fallback,
                    "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                    "builder_non_artifact_turns": 0,
                    "builder_task_started_at_ms": 0,
                    "builder_deck_prepare_phase": "terminal",
                    "builder_presentation_phase": "terminal",
                    "builder_deck_prepare_expected_tool_call_id": None,
                    **_terminal_halt_fields(request.state or {}, "deck_build_service_failed"),
                },
                goto="end",
            )
        return self._finalize_prepare_deck_build_success(request, result, payload, delta)

    def _finalize_prepare_deck_build_success(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
        delta: dict[str, Any],
    ) -> Command:
        cleanup_started = time.perf_counter()
        state = request.state or {}
        diagnostics = _merge_builder_pptx_diagnostics(
            _pptx_diagnostics(state),
            delta,
        )
        final_state = {
            **state,
            "builder_pptx_diagnostics": diagnostics,
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
        }
        args = request.tool_call.get("args") or {}
        artifact_path = str(payload.get("pptx_path") or args.get("output_path") or "").strip()
        artifact_title = str(args.get("deck_title") or "PowerPoint presentation").strip()
        deck_build_path = str(payload.get("deck_build_path") or "").strip()
        creative_plan_path = str(payload.get("creative_plan_path") or "").strip()
        artifact_files: list[dict[str, Any]] = [
            {
                "path": artifact_path,
                "role": "primary",
                "name": PurePosixPath(artifact_path).name,
            }
        ]
        for internal_path in (
            deck_build_path,
            creative_plan_path,
            str(payload.get("manifest_path") or "").strip(),
        ):
            if internal_path:
                artifact_files.append(
                    {
                        "path": internal_path,
                        "role": "internal",
                        "name": PurePosixPath(internal_path).name,
                    }
                )
        artifact: dict[str, Any] = {
            "artifact_path": artifact_path,
            "artifact_type": "presentation",
            "artifact_title": artifact_title,
            "artifact_files": artifact_files,
            "steps_completed": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
            "decisions_made": [
                "Used the native creative deck service",
                "Kept semantic text and diagrams editable",
                "Applied deterministic mechanical gates before delivery",
            ],
            "companion_summary": f"Created the {int(payload.get('slide_count') or 0)}-slide PowerPoint presentation.",
            "companion_tone_hint": "Confident and concise — the requested native deck is ready.",
            "user_next_action": "Open the presentation and review the speaker flow.",
            "confidence": 0.9 if str(payload.get("quality_status") or "") == "passed" else 0.8,
            "status": "completed",
            "terminal_reason": "deck_build_succeeded",
            "artifact_acceptance_status": "passed",
            "requested_artifact_ext": "pptx",
            "artifact_ext": "pptx",
            "artifact_is_fallback": False,
            "fallback_reason": None,
            "deck_build_id": payload.get("build_id"),
            "deck_build_path": deck_build_path or None,
            "deck_route": delta.get("deck_route"),
            "deck_compile_mode": delta.get("deck_compile_mode"),
            "native_required": delta.get("native_required"),
            "legacy_screenshot_debug": delta.get("legacy_screenshot_debug"),
            "native_editability_score": delta.get("native_editability_score"),
            "native_text_shape_count": delta.get("native_text_shape_count"),
            "picture_shape_count": delta.get("picture_shape_count"),
            "full_slide_picture_count": delta.get("full_slide_picture_count"),
            "native_mechanical_report": delta.get("native_mechanical_report"),
            "mechanical_gate_results": delta.get("mechanical_gate_results"),
            "html_source_validation": delta.get("html_source_validation"),
            "source_retention_report": delta.get("source_retention_report"),
            "native_contrast_report": delta.get("native_contrast_report"),
            "creative_plan_path": creative_plan_path or None,
            "creative_plan_accepted": bool(delta.get("creative_plan_accepted")),
            "deck_quality_status": payload.get("quality_status") or "passed",
            "quality_warning": payload.get("quality_warning"),
            "image_generation_status": delta.get("image_generation_status"),
            "image_generation_reason": delta.get("image_generation_reason"),
            "primary_image_batch_status": delta.get("primary_image_batch_status"),
            "primary_image_batch_error_class": delta.get("primary_image_batch_error_class"),
            "serial_repair_count": delta.get("serial_repair_count"),
            "batch_timeout_count": delta.get("batch_timeout_count"),
            "partial_batch_salvaged": delta.get("partial_batch_salvaged"),
            "expected_generated_visual_count": delta.get("expected_generated_visual_count"),
            "successful_generated_visual_count": delta.get("successful_generated_visual_count"),
            "referenced_visual_count": delta.get("referenced_visual_count"),
            "missing_expected_visual_count": delta.get("missing_expected_visual_count"),
            "root_failure_code": delta.get("deck_root_failure_code"),
            "root_failure_summary": delta.get("deck_root_failure_summary"),
            "last_prepare_failure_code": diagnostics.get("last_prepare_failure_code"),
            "last_prepare_failure_summary": diagnostics.get("last_prepare_failure_summary"),
            "prepare_call_count": diagnostics.get("prepare_call_count"),
            "prepare_emitted_call_count": diagnostics.get("prepare_emitted_call_count"),
            "prepare_execution_count": diagnostics.get("prepare_execution_count"),
            "prepare_normalized_call_count": diagnostics.get("prepare_normalized_call_count"),
            "prepare_schema_failure_count": diagnostics.get("prepare_schema_failure_count"),
            "prepare_parallel_call_count": diagnostics.get("prepare_parallel_call_count"),
            "prepare_service_call_count": diagnostics.get("prepare_service_call_count"),
            "prepare_service_result_count": diagnostics.get("prepare_service_result_count"),
            "prepare_result_count": diagnostics.get("prepare_result_count"),
            "prepare_policy_result_count": diagnostics.get("prepare_policy_result_count"),
            "prepare_repair_count": diagnostics.get("prepare_repair_count"),
            "deck_authoring_contract": diagnostics.get("deck_authoring_contract"),
            "deck_authoring_elapsed_ms": diagnostics.get("deck_authoring_elapsed_ms"),
            "deck_repair_elapsed_ms": diagnostics.get("deck_repair_elapsed_ms"),
            "deck_service_elapsed_ms": diagnostics.get("deck_service_elapsed_ms"),
            "presentation_preflight_status": diagnostics.get("presentation_preflight_status"),
            "presentation_preflight_elapsed_ms": diagnostics.get("presentation_preflight_elapsed_ms"),
            "deck_authoring_started_at_ms": diagnostics.get("deck_authoring_started_at_ms"),
            "deck_authoring_budget_ms": diagnostics.get("deck_authoring_budget_ms"),
            "deck_authoring_remaining_ms": diagnostics.get("deck_authoring_remaining_ms"),
            "deck_authoring_prompt_bytes": diagnostics.get("deck_authoring_prompt_bytes"),
            "deck_authoring_prompt_estimated_tokens": diagnostics.get("deck_authoring_prompt_estimated_tokens"),
            "deck_authoring_tool_schema_bytes": diagnostics.get("deck_authoring_tool_schema_bytes"),
            "deck_authoring_context_bytes": diagnostics.get("deck_authoring_context_bytes"),
            "deck_authoring_output_bytes": diagnostics.get("deck_authoring_output_bytes"),
            "authoring_tool_call_started": diagnostics.get("authoring_tool_call_started"),
            "prepare_force_reason": diagnostics.get("prepare_force_reason"),
            "manifest_path": delta.get("manifest_path"),
            "manifest_revision": delta.get("manifest_revision"),
            "logical_artifact_id": delta.get("logical_artifact_id"),
            "current_artifact_version_id": delta.get("current_artifact_version_id"),
            "foundation_status": delta.get("foundation_status"),
        }
        artifact = _apply_artifact_request_metadata(artifact, final_state)
        artifact = _apply_visual_missing_quality_metadata(artifact, final_state)
        artifact = _apply_hero_missing_quality_metadata(artifact, final_state)
        artifact = _apply_pptx_deck_quality_metadata(artifact, final_state)
        artifact = self._attach_pptx_canvas_preview(artifact, final_state)
        _trace_pptx_terminal_outcome(
            state=final_state,
            artifact=artifact,
            status="completed",
        )
        self._upload_fallback_and_fire(
            state=final_state,
            runtime=request.runtime,
            fallback=artifact,
            status="completed",
            cleanup_started=cleanup_started,
        )
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": delta,
                "builder_result": artifact,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_deck_prepare_phase": "terminal",
                "builder_presentation_phase": "terminal",
                "builder_deck_prepare_expected_tool_call_id": None,
                "builder_pptx_compile_latch_pending": False,
                "builder_pptx_compile_repair_pending": False,
                **_terminal_halt_fields(state, "deck_build_succeeded"),
            },
            goto="end",
        )

    def _prepare_deck_build_failure_fallback(
        self,
        *,
        state: dict[str, Any],
        runtime: Runtime,
        payload: dict[str, Any],
        delta: dict[str, Any],
    ) -> dict[str, Any]:
        failure_code = str(payload.get("failure_code") or delta.get("deck_failure_code") or "deck_build_failed")
        failure_summary = str(payload.get("failure_summary") or "DeckBuildService failed before a deliverable was available.")
        prior_diagnostics = _pptx_diagnostics(state)
        root_failure_code = str(payload.get("root_failure_code") or delta.get("deck_root_failure_code") or prior_diagnostics.get("deck_root_failure_code") or failure_code)
        root_failure_summary = str(payload.get("root_failure_summary") or delta.get("deck_root_failure_summary") or prior_diagnostics.get("deck_root_failure_summary") or failure_summary)
        terminal_status = "timed_out" if failure_code in {"deck_deadline_exceeded", "deck_authoring_deadline_exceeded"} else "failed"
        diagnostics = _merge_builder_pptx_diagnostics(
            _pptx_diagnostics(state),
            delta,
        )
        terminal_state = {**state, "builder_pptx_diagnostics": diagnostics}
        image_failure = "image" in failure_code.lower() or "visual" in failure_code.lower()
        fallback = {
            "artifact_path": None,
            "artifact_type": "presentation",
            "artifact_title": state.get("builder_artifact_target_title") or payload.get("deck_title") or "PPTX deck generation failed",
            "steps_completed": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
            "decisions_made": [],
            "companion_summary": failure_summary,
            "companion_tone_hint": "Direct and apologetic — the deck build failed before a quality PPTX was available.",
            "user_next_action": (
                "Retry after correcting the production image-generation issue named in the failure metadata."
                if image_failure
                else "Retry after correcting the exact deck input or runtime issue named in the failure metadata."
            ),
            "confidence": 0.0,
            "status": terminal_status,
            "terminal_status": terminal_status,
            "terminal_reason": failure_code,
            "error_reason": failure_code,
            "artifact_acceptance_status": "failed",
            "failure_code": failure_code,
            "failure_summary": failure_summary,
            "root_failure_code": root_failure_code,
            "root_failure_summary": root_failure_summary,
            "last_prepare_failure_code": payload.get("last_prepare_failure_code") or delta.get("last_prepare_failure_code") or diagnostics.get("last_prepare_failure_code"),
            "last_prepare_failure_summary": payload.get("last_prepare_failure_summary") or delta.get("last_prepare_failure_summary") or diagnostics.get("last_prepare_failure_summary"),
            "deck_build_id": payload.get("build_id"),
            "deck_build_path": payload.get("deck_build_path"),
            "deck_route": delta.get("deck_route") or payload.get("deck_route"),
            "deck_compile_mode": delta.get("deck_compile_mode") or payload.get("deck_compile_mode"),
            "native_required": delta.get("native_required"),
            "legacy_screenshot_debug": delta.get("legacy_screenshot_debug"),
            "native_editability_score": delta.get("native_editability_score"),
            "native_text_shape_count": delta.get("native_text_shape_count"),
            "picture_shape_count": delta.get("picture_shape_count"),
            "full_slide_picture_count": delta.get("full_slide_picture_count"),
            "native_mechanical_report": delta.get("native_mechanical_report"),
            "mechanical_gate_results": delta.get("mechanical_gate_results"),
            "html_source_validation": delta.get("html_source_validation"),
            "source_retention_report": delta.get("source_retention_report"),
            "native_contrast_report": delta.get("native_contrast_report"),
            "creative_plan_path": delta.get("creative_plan_path"),
            "deck_quality_status": payload.get("quality_status") or "failed",
            "quality_warning": payload.get("quality_warning"),
            "image_generation_status": delta.get("image_generation_status"),
            "image_generation_reason": delta.get("image_generation_reason"),
            "primary_image_batch_status": delta.get("primary_image_batch_status"),
            "primary_image_batch_error_class": delta.get("primary_image_batch_error_class"),
            "serial_repair_count": delta.get("serial_repair_count"),
            "batch_timeout_count": delta.get("batch_timeout_count"),
            "partial_batch_salvaged": delta.get("partial_batch_salvaged"),
            "expected_generated_visual_count": delta.get("expected_generated_visual_count"),
            "successful_generated_visual_count": delta.get("successful_generated_visual_count"),
            "referenced_visual_count": delta.get("referenced_visual_count"),
            "missing_expected_visual_count": delta.get("missing_expected_visual_count"),
            "prepare_call_count": diagnostics.get("prepare_call_count"),
            "prepare_emitted_call_count": diagnostics.get("prepare_emitted_call_count"),
            "prepare_execution_count": diagnostics.get("prepare_execution_count"),
            "prepare_normalized_call_count": diagnostics.get("prepare_normalized_call_count"),
            "prepare_schema_failure_count": diagnostics.get("prepare_schema_failure_count"),
            "prepare_parallel_call_count": diagnostics.get("prepare_parallel_call_count"),
            "prepare_service_call_count": diagnostics.get("prepare_service_call_count"),
            "prepare_service_result_count": diagnostics.get("prepare_service_result_count"),
            "prepare_result_count": diagnostics.get("prepare_result_count"),
            "prepare_policy_result_count": diagnostics.get("prepare_policy_result_count"),
            "prepare_repair_count": diagnostics.get("prepare_repair_count"),
            "deck_authoring_contract": diagnostics.get("deck_authoring_contract"),
            "deck_authoring_elapsed_ms": diagnostics.get("deck_authoring_elapsed_ms"),
            "deck_repair_elapsed_ms": diagnostics.get("deck_repair_elapsed_ms"),
            "deck_service_elapsed_ms": diagnostics.get("deck_service_elapsed_ms"),
            "presentation_preflight_status": diagnostics.get("presentation_preflight_status"),
            "presentation_preflight_elapsed_ms": diagnostics.get("presentation_preflight_elapsed_ms"),
            "deck_authoring_started_at_ms": diagnostics.get("deck_authoring_started_at_ms"),
            "deck_authoring_budget_ms": diagnostics.get("deck_authoring_budget_ms"),
            "deck_authoring_remaining_ms": diagnostics.get("deck_authoring_remaining_ms"),
            "deck_authoring_prompt_bytes": diagnostics.get("deck_authoring_prompt_bytes"),
            "deck_authoring_prompt_estimated_tokens": diagnostics.get("deck_authoring_prompt_estimated_tokens"),
            "deck_authoring_tool_schema_bytes": diagnostics.get("deck_authoring_tool_schema_bytes"),
            "deck_authoring_context_bytes": diagnostics.get("deck_authoring_context_bytes"),
            "deck_authoring_output_bytes": diagnostics.get("deck_authoring_output_bytes"),
            "authoring_tool_call_started": diagnostics.get("authoring_tool_call_started"),
            "prepare_force_reason": diagnostics.get("prepare_force_reason"),
        }
        deck_build_path = payload.get("deck_build_path")
        if isinstance(deck_build_path, str) and deck_build_path.strip():
            fallback["artifact_files"] = [
                {
                    "path": deck_build_path,
                    "role": "internal",
                    "name": PurePosixPath(deck_build_path).name,
                }
            ]
        fallback = _apply_artifact_request_metadata(
            fallback,
            terminal_state,
            fallback_reason="deck_build_service_failed",
        )
        self._attach_terminal_failure_diagnostics(
            terminal_state,
            runtime,
            fallback,
            failure_stage="deck_build_service",
            failure_code=failure_code,
            failure_reason=failure_summary,
            retryable=bool(payload.get("retryable")),
            emit_attempted=True,
            emit_tool_call_seen=False,
        )
        _trace_pptx_terminal_outcome(
            state=terminal_state,
            artifact=fallback,
            status=terminal_status,
            failure_code=failure_code,
        )
        self._upload_fallback_and_fire(
            state=terminal_state,
            runtime=runtime,
            fallback=fallback,
            status=terminal_status,
        )
        return fallback

    @staticmethod
    def _deck_builder_output_path(request: ToolCallRequest, payload: dict[str, Any]) -> str | None:
        args = request.tool_call.get("args") or {}
        pptx_path = payload.get("pptx_path")
        if not isinstance(pptx_path, str) or not pptx_path.strip():
            pptx_path = args.get("output_path") if isinstance(args, dict) else None
        return pptx_path if isinstance(pptx_path, str) and pptx_path.strip() else None

    @staticmethod
    def _deck_builder_base_delta(
        *,
        success: bool,
        bytes_count: int,
        error_class: object,
        slide_count: int,
    ) -> dict[str, Any]:
        return {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 1 if success else 0,
            "pptx_generator_bytes_total": bytes_count if success else 0,
            "pptx_generator_error_class": error_class,
            # Every rendered slide is one full-bleed picture, so picture_count == slide_count.
            "pptx_generator_slide_count": slide_count,
            "pptx_generator_picture_count": slide_count if success else 0,
        }

    @staticmethod
    def _attach_deck_builder_success_fields(
        delta: dict[str, Any],
        *,
        pptx_path: str | None,
        state: dict[str, Any],
    ) -> None:
        if not pptx_path:
            return
        delta["pptx_output_paths"] = [pptx_path]
        if _pptx_diagnostics(state).get("time_to_first_valid_artifact_ms") is None:
            elapsed = _elapsed_since_builder_start_ms(state)
            if elapsed is not None:
                delta["time_to_first_valid_artifact_ms"] = elapsed

    @staticmethod
    def _deck_builder_result_delta(
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any] | None:
        """Record PPTX diagnostics from a ``build_deck_from_slides`` JSON result."""
        payload = BuilderArtifactMiddleware._deck_builder_result_payload(result)
        if payload is None:
            return None
        state = request.state or {}
        pptx_path = BuilderArtifactMiddleware._deck_builder_output_path(request, payload)
        exists, bytes_count, status_reason = _virtual_output_status(request.state or {}, pptx_path)
        success = payload.get("success") is True and exists
        slide_count = int(payload.get("slide_count") or 0)
        error_class = None if success else payload.get("error_type") or status_reason or "deck_build_failed"
        visual_counts = _pptx_visual_completeness_diagnostics_update(state)
        try:
            missing_count = int(payload.get("missing_image_count", 0) or 0)
        except (TypeError, ValueError):
            missing_count = 0
        overflow_slides = payload.get("overflow_slides") if isinstance(payload.get("overflow_slides"), list) else []
        _safe_langsmith_span(
            "Sophia PPTX Compile",
            inputs={
                "compiler": "build_deck_from_slides",
                "output_file": pptx_path,
                "expected_slide_count": _pptx_latch_target_slide_count(state),
                "expected_image_count": visual_counts["expected_generated_visual_count"],
                "presentation_route": "html_slide_to_pptx_raster",
            },
            outputs={
                "success": success,
                "output_bytes": bytes_count if success else 0,
                "actual_slide_count": slide_count,
                "picture_count": slide_count if success else 0,
                "missing_images": missing_count,
                "successful_generated_visual_count": visual_counts["successful_generated_visual_count"],
                "referenced_visual_count": visual_counts["referenced_visual_count"],
                "missing_expected_visual_count": visual_counts["missing_expected_visual_count"],
                "overflow_slides": overflow_slides,
                "quality_warning": payload.get("quality_warning"),
                "error_class": error_class,
                "status_reason": status_reason,
            },
            metadata={
                "sophia_component": "builder_pptx_compile",
                "pptx_compile_path": "build_deck_from_slides",
                "pptx_compile_success": success,
                "pptx_compile_error_class": error_class,
            },
            tags=["pptx", "compile"],
        )
        delta = BuilderArtifactMiddleware._deck_builder_base_delta(
            success=success,
            bytes_count=bytes_count,
            error_class=error_class,
            slide_count=slide_count,
        )
        delta.update(visual_counts)
        if pptx_path and success:
            BuilderArtifactMiddleware._attach_deck_builder_success_fields(
                delta,
                pptx_path=pptx_path,
                state=state,
            )
            if payload.get("quality_warning") == "visuals_partial":
                if missing_count > 0:
                    delta["pptx_deck_quality_warning"] = "visuals_partial"
                    delta["pptx_deck_missing_image_count"] = missing_count
        return delta

    def _deck_builder_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        delta = self._deck_builder_result_delta(request, result)
        if delta is None:
            return result
        success = delta.get("pptx_generator_success_count") == 1
        if success:
            # FIX 2 (2026-06-30): a compiled deck still has to pass the deterministic
            # slide-quality gate (overflow / chrome / density). One bounded re-author
            # turn when it doesn't — HTML only, images reused.
            quality_gate = self._slide_quality_rejection_command(request, result, delta)
            if quality_gate is not None:
                return quality_gate
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": delta,
                "builder_pptx_compile_latch_pending": False,
                "builder_pptx_compile_repair_pending": not success,
            }
        )

    def _collect_slide_quality_signals(self, request: ToolCallRequest, result: ToolMessage) -> SlideSignals | None:
        """Read the build_deck result + slide HTML sources into pure check inputs."""
        state = request.state or {}
        payload = self._deck_builder_result_payload(result)
        overflow_slides = payload.get("overflow_slides") if isinstance(payload, dict) else None
        outputs_root = _outputs_root_from_state(state)
        slide_sources: list[tuple[str, str]] = []
        prompt_sources: list[tuple[str, str]] = []
        if outputs_root is not None:
            slides_dir = outputs_root / "slides"
            if slides_dir.is_dir():
                try:
                    for path in sorted(slides_dir.iterdir(), key=lambda p: p.name):
                        if path.is_file() and path.suffix.lower() in {".html", ".htm"}:
                            try:
                                slide_sources.append((path.name, path.read_text(encoding="utf-8", errors="replace")))
                            except OSError:
                                continue
                except OSError:
                    slide_sources = []
            assets_dir = outputs_root / "assets"
            if assets_dir.is_dir():
                try:
                    for path in sorted(assets_dir.iterdir(), key=lambda p: p.name):
                        if path.is_file() and path.suffix.lower() == ".json":
                            try:
                                prompt_sources.append((path.name, path.read_text(encoding="utf-8", errors="replace")))
                            except OSError:
                                continue
                except OSError:
                    prompt_sources = []
        if not slide_sources and not prompt_sources and not overflow_slides:
            return None
        return SlideSignals(
            slide_sources=slide_sources,
            prompt_sources=prompt_sources,
            overflow_slides=list(overflow_slides) if isinstance(overflow_slides, list) else [],
        )

    def _slide_quality_rejection_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        delta: dict[str, Any],
    ) -> Command | None:
        """One bounded slide-quality re-author turn (FIX 2). None = accept."""
        state = request.state or {}
        if not _requested_pptx_artifact(state):
            return None
        signals = self._collect_slide_quality_signals(request, result)
        if signals is None:
            return None
        gaps = _SLIDE_QUALITY_INSPECTOR.inspect(signals)
        if not gaps:
            return None
        used_quality_repairs = int(state.get("builder_slide_quality_rejections", 0) or 0)
        severe_gaps = [gap for gap in gaps if gap.check in _PPTX_SEVERE_QUALITY_CHECKS]
        if used_quality_repairs >= _PPTX_VISUAL_QUALITY_REPAIR_MAX:
            if severe_gaps:
                logger.warning(
                    "[BuilderSlideQuality] gate=terminal_failure gaps=%d severe=%d checks=%s slides=%s",
                    len(gaps),
                    len(severe_gaps),
                    sorted({gap.check for gap in gaps}),
                    sorted({gap.slide for gap in gaps}),
                )
                _trace_pptx_compile_decision(
                    state=state,
                    decision="slide_quality_failed",
                    reason="severe_gaps_after_repairs",
                    outputs={"gap_count": len(gaps), "checks": sorted({gap.check for gap in gaps})},
                )
                return Command(
                    update={
                        "messages": [
                            _error_tool_message(
                                content=(format_slide_quality_feedback(gaps) + "\nTwo visual-quality repair turns are already spent and severe issues remain. Stop cleanly with artifact_path=null; do not recompile or ship this deck."),
                                tool_call_id=request.tool_call.get("id", ""),
                                name=_DECK_BUILD_TOOL_NAME,
                            ),
                        ],
                        "builder_pptx_terminal_quality_failed": True,
                        "builder_pptx_compile_repair_pending": False,
                        "builder_pptx_diagnostics": {
                            "pptx_deck_quality_warning": "visual_quality_failed",
                            "pptx_deck_visual_quality_gap_count": len(gaps),
                        },
                    },
                    goto="model",
                )
            delta["pptx_deck_quality_warning"] = "visual_quality_warning"
            delta["pptx_deck_visual_quality_gap_count"] = len(gaps)
            logger.warning(
                "[BuilderSlideQuality] gate=soft_pass_after_repair gaps=%d checks=%s slides=%s",
                len(gaps),
                sorted({gap.check for gap in gaps}),
                sorted({gap.slide for gap in gaps}),
            )
            _trace_pptx_compile_decision(
                state=state,
                decision="slide_quality_soft_pass",
                reason="repair_spent_or_not_grantable",
                outputs={"gap_count": len(gaps), "checks": sorted({gap.check for gap in gaps})},
            )
            return None
        if not _repair_iteration_grantable(state):
            delta["pptx_deck_quality_warning"] = "visual_quality_warning"
            delta["pptx_deck_visual_quality_gap_count"] = len(gaps)
            logger.warning(
                "[BuilderSlideQuality] gate=soft_pass_budget_denied gaps=%d checks=%s slides=%s",
                len(gaps),
                sorted({gap.check for gap in gaps}),
                sorted({gap.slide for gap in gaps}),
            )
            _trace_pptx_compile_decision(
                state=state,
                decision="slide_quality_soft_pass",
                reason="repair_not_grantable",
                outputs={"gap_count": len(gaps), "checks": sorted({gap.check for gap in gaps})},
            )
            return None
        logger.warning(
            "[BuilderSlideQuality] gate=blocked gaps=%d checks=%s slides=%s",
            len(gaps),
            sorted({gap.check for gap in gaps}),
            sorted({gap.slide for gap in gaps}),
        )
        _trace_pptx_compile_decision(
            state=state,
            decision="slide_quality_reauthor",
            reason="deterministic_gate_gaps",
            outputs={"gap_count": len(gaps), "checks": sorted({gap.check for gap in gaps})},
        )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=format_slide_quality_feedback(gaps),
                        tool_call_id=request.tool_call.get("id", ""),
                        name=_DECK_BUILD_TOOL_NAME,
                    ),
                ],
                # Codex P2 (review 4598184111): do NOT persist the success `delta`
                # (pptx_generator_success_count / picture_count / pptx_output_paths)
                # while the quality repair is pending — it would make
                # _pptx_valid_output_already_terminal() treat this REJECTED deck as a
                # valid terminal PPTX, so _pptx_compile_ready() goes False and the
                # compile force never re-fires after the model edits the slides,
                # shipping the stale pre-repair deck. The repaired build_deck call
                # records its own (legitimately terminal) delta; the .pptx on disk is
                # still found by the filesystem rglob in _latest_valid_pptx_output_file.
                "builder_pptx_compile_latch_pending": False,
                # Suppress the compile force until the model edits a slide (the
                # write clears this) so it can't immediately re-compile the same deck.
                "builder_pptx_compile_repair_pending": True,
                "builder_slide_quality_rejections": used_quality_repairs + 1,
                "build_iterations": iterations_used(state) + 1,
            },
            goto="model",
        )

    def _tool_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name in _BUILDER_EDIT_TOOL_NAMES:
            return self._edit_result_command(request, result)
        if tool_name in _PDF_CREATION_TOOL_NAMES and isinstance(result, ToolMessage):
            return self._pdf_result_command(request, result)
        if tool_name == _PREPARE_DECK_BUILD_TOOL_NAME:
            if isinstance(result, ToolMessage):
                record_runtime_event(
                    state=request.state or {},
                    runtime=request.runtime,
                    event_type="prepare.result_recorded",
                    tool_call_id=str(request.tool_call.get("id") or "") or None,
                    status="error" if str(getattr(result, "status", "")).lower() == "error" else "completed",
                )
            return self._prepare_deck_build_result_command(request, result)
        if tool_name == _DECK_BUILD_TOOL_NAME:
            return self._deck_builder_result_command(request, result)
        if tool_name == _PPTX_IMAGE_MANIFEST_TOOL_NAME and isinstance(result, ToolMessage):
            delta = self._pptx_manifest_tool_result_delta(result)
            if delta:
                return Command(update={"messages": [result], "builder_pptx_diagnostics": delta})
            return result
        if tool_name in {"bash", "bash_tool"}:
            return self._pptx_bash_result_command(request, result)
        if tool_name in _VISUAL_ASSET_TOOL_NAMES:
            return self._visual_asset_result_command(result)
        return result

    @classmethod
    def _presentation_preflight_tool_result_command(
        cls,
        request: ToolCallRequest,
        result: ToolMessage | Command,
        *,
        status: str | None = None,
    ) -> Command:
        message: ToolMessage | None = result if isinstance(result, ToolMessage) else None
        if message is None and isinstance(result, Command) and isinstance(result.update, dict):
            message = next(
                (item for item in reversed(result.update.get("messages", []) or []) if isinstance(item, ToolMessage)),
                None,
            )
        if status is None:
            text = cls._tool_message_text(message) if message is not None else ""
            message_status = str(getattr(message, "status", "") or "").lower() if message is not None else ""
            status = "failed" if message_status == "error" or text.lstrip().startswith("Error:") else "completed"
        update = cls._presentation_preflight_terminal_update(request.state or {}, status)
        update["builder_presentation_phase"] = "preflight_result_received"
        if isinstance(result, Command):
            return cls._command_with_merged_update(result, update)
        return Command(update={"messages": [result], **update})

    def _prepare_deck_build_exhausted_command(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        if request.tool_call.get("name") != _PREPARE_DECK_BUILD_TOOL_NAME:
            return None
        diagnostics = _pptx_diagnostics(request.state or {})
        emitted_count = int(diagnostics.get("prepare_emitted_call_count") or diagnostics.get("prepare_call_count") or 0)
        service_result_count = int(diagnostics.get("prepare_service_result_count", 0) or 0)
        parallel_call_count = int(diagnostics.get("prepare_parallel_call_count", 0) or 0)
        if parallel_call_count <= 1 and emitted_count <= 2 and service_result_count < 2:
            return None
        root_failure_code = diagnostics.get("deck_root_failure_code") or diagnostics.get("deck_failure_code")
        root_failure_summary = diagnostics.get("deck_root_failure_summary")
        failure_code = "deck_prepare_parallel_calls_forbidden" if parallel_call_count > 1 else "deck_prepare_retry_exhausted"
        failure_summary = "prepare_deck_build calls must be sequential; multiple calls were emitted in one model turn." if parallel_call_count > 1 else "prepare_deck_build already used its one bounded repair attempt."
        payload = {
            "success": False,
            "failure_code": failure_code,
            "failure_summary": failure_summary,
            "retryable": False,
            "root_failure_code": root_failure_code,
            "root_failure_summary": root_failure_summary,
        }
        delta = {
            "deck_status": "failed_terminal",
            "deck_failure_code": failure_code,
            "deck_root_failure_code": root_failure_code,
            "deck_root_failure_summary": root_failure_summary,
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=request.state or {},
            runtime=request.runtime,
            payload=payload,
            delta=delta,
        )
        result = ToolMessage(
            content=json.dumps(payload),
            tool_call_id=str(request.tool_call.get("id") or ""),
            name=_PREPARE_DECK_BUILD_TOOL_NAME,
        )
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": delta,
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_non_artifact_turns": 0,
                "builder_deck_prepare_phase": "terminal",
                "builder_presentation_phase": "terminal",
                **_terminal_halt_fields(request.state or {}, failure_code),
            },
            goto="end",
        )

    @staticmethod
    def _is_null_artifact_path(value: object) -> bool:
        return value is None or (isinstance(value, str) and value.strip().lower() in {"", "null", "none"})

    @staticmethod
    def _intentional_pptx_failure_emit_reason(args: dict[str, Any], state: dict[str, Any]) -> str | None:
        if not _requested_pptx_artifact(state):
            return None
        if not BuilderArtifactMiddleware._is_null_artifact_path(args.get("artifact_path")):
            return None
        diagnostics = _pptx_diagnostics(state)
        image_status, image_reason = _image_generation_metadata_from_state(state)
        visual_counts = _pptx_visual_completeness_diagnostics_update(state)
        missing_expected = int(visual_counts.get("missing_expected_visual_count") or diagnostics.get("missing_expected_visual_count") or 0)
        attempted = int(diagnostics.get("image_generation_attempt_count", 0) or 0)
        if image_status in {"failed", "partial"} or missing_expected > 0 or attempted > 0:
            return image_reason or str(diagnostics.get("primary_image_batch_error_class") or "") or str(diagnostics.get("image_generation_startup_error_class") or "") or "required_slide_visuals_missing"
        return None

    @staticmethod
    def _terminal_pptx_startup_failure_reason(state: dict[str, Any]) -> str | None:
        if not _requested_pptx_artifact(state) or _pptx_explicit_text_only_requested(state):
            return None
        diagnostics = _pptx_diagnostics(state)
        if bool(diagnostics.get("deck_batch_terminal_failure")):
            return str(diagnostics.get("primary_image_batch_error_class") or "deck_batch_loop_break")
        if not diagnostics.get("image_generation_manifest_seen"):
            return None
        if int(diagnostics.get("image_generation_manifest_requested_count", 0) or 0) <= 0:
            return None
        if bool(diagnostics.get("image_generation_manifest_generation_attempted")):
            return None
        if int(diagnostics.get("image_generation_success_count", 0) or 0) > 0:
            return None
        if int(diagnostics.get("batch_summary_missing_count", 0) or 0) < 2:
            return None
        reason = diagnostics.get("image_generation_startup_error_class") or diagnostics.get("primary_image_batch_error_class") or diagnostics.get("image_generation_error_class")
        return str(reason or "batch_summary_missing")

    def _terminal_pptx_failure_fallback(
        self,
        args: dict[str, Any],
        state: dict[str, Any],
        runtime: Runtime,
        *,
        reason: str,
        steps_completed: int,
    ) -> dict[str, Any]:
        fallback = {
            "artifact_path": None,
            "artifact_type": "presentation",
            "artifact_title": args.get("artifact_title") or "PPTX deck generation failed",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": ("The PPTX build stopped before creating a deck because required generated slide visuals could not be completed."),
            "companion_tone_hint": "Direct and apologetic — the build failed before a quality deck was available.",
            "user_next_action": "Ask me to retry after the image-generation issue is fixed.",
            "confidence": 0.0,
            "status": "error",
            "error_reason": reason,
            "artifact_acceptance_status": "failed",
            "failure_code": reason,
        }
        fallback = _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed",
        )
        diagnostics = _pptx_diagnostics(state)
        _trace_pptx_compile_decision(
            state=state,
            decision="terminal_fail",
            reason=reason,
            outputs={
                "primary_image_batch_status": diagnostics.get("primary_image_batch_status"),
                "primary_image_batch_error_class": diagnostics.get("primary_image_batch_error_class"),
                "image_generation_startup_error_class": diagnostics.get("image_generation_startup_error_class"),
                "image_generation_command_hash": diagnostics.get("image_generation_command_hash"),
                "image_generation_command_basename": diagnostics.get("image_generation_command_basename"),
                **_pptx_visual_completeness_counts(state),
            },
        )
        self._attach_terminal_failure_diagnostics(
            state,
            runtime,
            fallback,
            failure_stage="image_generation",
            failure_code=reason,
            failure_reason=("Builder intentionally emitted artifact_path=null after required PPTX slide imagery failed or remained incomplete."),
            emit_attempted=True,
            emit_tool_call_seen=True,
        )
        _trace_pptx_terminal_outcome(
            state=state,
            artifact=fallback,
            status="error",
            failure_code=reason,
        )
        self._upload_fallback_and_fire(
            state=state,
            runtime=runtime,
            fallback=fallback,
            status="failed",
        )
        return fallback

    def _terminal_pptx_failure_emit_command(
        self,
        request: ToolCallRequest,
        args: dict[str, Any],
    ) -> Command | None:
        reason = self._intentional_pptx_failure_emit_reason(args, request.state)
        if reason is None:
            return None
        fallback = self._terminal_pptx_failure_fallback(
            args,
            request.state,
            request.runtime,
            reason=reason,
            steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
        )
        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: accepted terminal PPTX failure emit reason=%s",
            reason,
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=json.dumps(fallback, default=str),
                        tool_call_id=str(tool_call_id or ""),
                        name="emit_builder_artifact",
                    )
                ],
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                **_terminal_halt_fields(request.state, "pptx_image_generation_failed"),
            },
            goto="end",
        )

    def _terminal_pptx_startup_failure_emit_command(
        self,
        request: ToolCallRequest,
        args: dict[str, Any],
    ) -> Command | None:
        reason = self._terminal_pptx_startup_failure_reason(request.state)
        if reason is None:
            return None
        fallback = self._terminal_pptx_failure_fallback(
            args,
            request.state,
            request.runtime,
            reason=reason,
            steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
        )
        logger.warning(
            "BuilderArtifact: terminal PPTX startup failure reason=%s",
            reason,
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=json.dumps(fallback, default=str),
                        tool_call_id=str(request.tool_call.get("id", "") or ""),
                        name="emit_builder_artifact",
                    )
                ],
                "builder_result": fallback,
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                **_terminal_halt_fields(request.state, "pptx_image_generation_failed"),
            },
            goto="end",
        )

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept emit_builder_artifact to verify the file exists before executing.

        PR-D (2026-04-24): when the referenced file is missing, we bypass the
        normal tool execution (which has ``return_direct=True`` and would end the
        builder graph) and instead return a ``Command(goto=\"model\")`` with an
        error ToolMessage. This lets the model see the rejection and retry.
        """
        tool_name = str(request.tool_call.get("name") or "")
        if (
            tool_name in _PRESENTATION_PREFLIGHT_TOOLS
            and _deck_build_service_route_active(request.state or {})
            and request.state.get("builder_presentation_phase") == "preflight_call_emitted"
        ):
            started = time.monotonic()
            result = handler(request)
            allotted = float(presentation_preflight_timeout_seconds(request.state or {}))
            status = "timed_out" if time.monotonic() - started >= allotted else None
            return self._presentation_preflight_tool_result_command(request, result, status=status)
        exhausted = self._prepare_deck_build_exhausted_command(request)
        if exhausted is not None:
            return exhausted
        latch_block = self._deck_prepare_latch_rejection(request)
        if latch_block is not None:
            return latch_block
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block
        visual_design_block = self._block_visual_asset_before_design_skill(request)
        if visual_design_block is not None:
            return visual_design_block
        if request.tool_call.get("name") != "emit_builder_artifact":
            deck_service_block = self._deck_build_service_legacy_tool_rejection(request)
            if deck_service_block is not None:
                return deck_service_block
            deck_block = self._deck_improvisation_rejection(request)
            if deck_block is not None:
                return deck_block
            deck_compile_block = self._deck_compile_visuals_rejection(request)
            if deck_compile_block is not None:
                return deck_compile_block
            image_block = self._image_generation_block_command(request)
            if image_block is not None:
                return image_block
            self._maybe_autowire_pptx_plan_visuals(request)
            _maybe_attach_image_trace_env(request)
            if request.tool_call.get("name") == _PREPARE_DECK_BUILD_TOOL_NAME:
                record_runtime_event(
                    state=request.state or {},
                    runtime=request.runtime,
                    event_type="prepare.execution_started",
                    tool_call_id=str(request.tool_call.get("id") or "") or None,
                )
            return self._tool_result_command(request, handler(request))

        args = request.tool_call.get("args", {})
        # Correction wave 2026-06-12: the user-intent override must run BEFORE
        # _authoritative_pdf_emit_args — in the reverse conflict (target=pdf,
        # user explicitly asked pptx) that helper would otherwise hijack the
        # emit and rewrite artifact_path to a rendered PDF.
        format_conflict = _format_conflict_user_override(args, request.state)
        if format_conflict is not None:
            original_target_ext = _requested_target_suffix(request.state).lstrip(".")
            request.state = {**request.state, **format_conflict}
            _stamp_format_conflict_metadata(
                args,
                original_target_ext,
                _requested_target_suffix(request.state).lstrip("."),
            )
        # Phase 5c runs AFTER the format-conflict override so it gates the
        # RESOLVED target's skill (not a misderived dispatch target).
        target_skill_block = self._block_emit_before_target_skill(request)
        if target_skill_block is not None:
            return target_skill_block
        terminal_pptx_failure = self._terminal_pptx_failure_emit_command(request, args)
        if terminal_pptx_failure is not None:
            return terminal_pptx_failure
        authoritative_pdf_args = self._authoritative_pdf_emit_args(args, request.state, request.runtime)
        if authoritative_pdf_args is not None:
            request.tool_call["args"] = authoritative_pdf_args
            return handler(request)
        authoritative_pptx_args = self._authoritative_pptx_emit_args(args, request.state, request.runtime)
        if authoritative_pptx_args is not None:
            request.tool_call["args"] = authoritative_pptx_args
            return handler(request)
        if self._artifact_files_exist(args, request.state, request.runtime):
            visual_rejection = self._visual_gate_rejection_command(request, args)
            if visual_rejection is not None:
                return visual_rejection
            return handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return handler(request)
        recovered_args = self._recover_emit_args_from_output_scan(
            args,
            request.state,
            request.runtime,
            reason="wrap_tool_call_missing_emit_path",
        )
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return handler(request)

        terminal_startup_failure = self._terminal_pptx_startup_failure_emit_command(request, args)
        if terminal_startup_failure is not None:
            return terminal_startup_failure

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in wrap_tool_call — artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        diagnostics = self._emit_rejection_diagnostics(args, request.state, request.runtime)
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=self._emit_rejection_message(args, request.state),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                    ),
                ],
                "builder_failure_diagnostics": diagnostics,
            },
            goto="model",
        )

    @staticmethod
    def _image_generation_terminal_rejection(
        *,
        attempts: int,
        startup_attempts: int = 0,
        successes: int,
        error_class: object,
    ) -> str | None:
        no_prior_failure = attempts < 1 and startup_attempts < 1
        if no_prior_failure or successes != 0 or error_class not in _IMAGE_GENERATION_TERMINAL_ERRORS:
            return None
        return (
            f"Error: image generation is unavailable in this environment ({error_class}). "
            "Do not call it again. For PPTX, emit artifact_path=null unless usable "
            "generated slide images already exist. For PDF, proceed with local chart, "
            "table, diagram, and prose content only."
        )

    @staticmethod
    def _image_generation_budget_rejection(
        state: dict[str, Any],
        diagnostics: dict[str, Any],
        *,
        attempts: int,
        billable_in_command: int,
    ) -> str | None:
        max_calls = _image_generation_max_calls(state)
        if attempts + billable_in_command <= max_calls:
            return None
        generated = [path for path in (diagnostics.get("image_output_paths") or []) if isinstance(path, str)]
        generated_note = f" Use the images already generated: {', '.join(generated[:4])}." if generated else ""
        return (
            f"Error: image generation budget reached ({attempts}/{max_calls} "
            f"calls used; this command adds {billable_in_command}).{generated_note} "
            "Do not retry image generation. For PPTX, use already-generated slide images "
            "only or stop cleanly. For PDF, continue with local charts, diagrams, tables, "
            "and prose."
        )

    @staticmethod
    def _image_generation_rejection_text(
        state: dict[str, Any],
        *,
        billable_in_command: int,
    ) -> tuple[str | None, int, int, object]:
        attempts = _pptx_diagnostic_count(state, "image_generation_attempt_count")
        startup_attempts = _pptx_diagnostic_count(state, "image_generation_startup_attempt_count")
        successes = _pptx_diagnostic_count(state, "image_generation_success_count")
        diagnostics = _pptx_diagnostics(state)
        error_class = diagnostics.get("image_generation_error_class")
        rejection = BuilderArtifactMiddleware._image_generation_terminal_rejection(
            attempts=attempts,
            startup_attempts=startup_attempts,
            successes=successes,
            error_class=error_class,
        ) or BuilderArtifactMiddleware._image_generation_budget_rejection(
            state,
            diagnostics,
            attempts=attempts,
            billable_in_command=billable_in_command,
        )
        return rejection, attempts, successes, error_class

    @staticmethod
    def _deck_batch_directive_rejection(command: str, state: dict[str, Any]) -> str | None:
        """Backstop the deck batch-first image workflow at bash time.

        Legacy/direct image workflows must generate selected deck assets in ONE
        ``--manifest`` batch. Single image-generation calls are allowed only as
        bounded serial repair after a readable batch made a real generation
        attempt and left failed/missing images.

        Returns the directive text to reject with, or ``None`` to allow.
        """
        if _requested_artifact_ext(state) != "pptx":
            return None
        diagnostics = _pptx_diagnostics(state)
        if _pptx_explicit_text_only_requested(state):
            return None
        if _deck_build_service_route_active(state):
            return (
                "[Sophia/deck-build] Fresh PPTX deck visuals are generated internally by "
                "`prepare_deck_build`. Do not call image-generation scripts directly. Submit "
                "the complete creative_plan, deck_stylesheet, and slide html_body list through prepare_deck_build; the harness owns "
                "asset preparation, native PowerPoint compilation, inspection, and mechanical gates."
            )
        billable = [segment for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS) if "--preflight" not in _command_parts(segment)]
        if not billable:
            return None
        if any(_command_flag_value(segment, "--manifest") for segment in billable):
            return None  # this IS a batch call — allow
        requested = int(diagnostics.get("image_generation_manifest_requested_count", 0) or 0)
        real_batch_attempted = bool(diagnostics.get("image_generation_manifest_generation_attempted")) and requested > 0
        if real_batch_attempted:
            failed_count = int(diagnostics.get("image_generation_manifest_failed_count", 0) or 0)
            error_class = str(diagnostics.get("primary_image_batch_error_class") or "")
            if error_class in _IMAGE_GENERATION_TERMINAL_ERRORS or error_class == "content_blocked":
                return (
                    "[Sophia/deck-batch] The primary image batch failed with a terminal provider "
                    f"error ({error_class}). Do not retry the same provider call serially for every "
                    "slide. Stop cleanly with artifact_path=null and report the image-generation "
                    "failure metadata."
                )
            allowed_repairs = failed_count * _SERIAL_REPAIR_ATTEMPTS_PER_FAILED_SLIDE
            used_repairs = int(diagnostics.get("serial_repair_count", 0) or 0)
            if failed_count <= 0:
                return "[Sophia/deck-batch] The primary image batch already completed; do not make extra single image-generation calls. Use the generated assets, author the slide HTML, and call `build_deck_from_slides`."
            if used_repairs + len(billable) > allowed_repairs:
                return (
                    "[Sophia/deck-batch] Serial image repair is exhausted for this deck. The primary "
                    f"batch left {failed_count} failed image(s), allowing at most {allowed_repairs} "
                    "single-image repair attempt(s). Stop cleanly with artifact_path=null rather than "
                    "compiling a partial placeholder deck."
                )
            repair_rejection = _serial_repair_rejection_reason(diagnostics, billable)
            if repair_rejection is not None:
                return repair_rejection
            return None  # a readable batch attempted generation; bounded serial repairs are allowed
        if diagnostics.get("image_generation_manifest_seen") and requested > 0:
            error_class = diagnostics.get("primary_image_batch_error_class") or "manifest_authoring_failed"
            missing_summary_count = int(diagnostics.get("batch_summary_missing_count", 0) or 0)
            if missing_summary_count > 0:
                startup_error = diagnostics.get("image_generation_startup_error_class") or error_class
                if missing_summary_count >= 2:
                    return (
                        "[Sophia/deck-batch] The manifest batch still did not emit a trusted "
                        "`IMAGEGEN_BATCH` summary after the allowed rerun "
                        f"({startup_error}). Do not attempt serial repairs because there is no "
                        "structured batch item diagnostic table. Stop cleanly with artifact_path=null."
                    )
                return (
                    "[Sophia/deck-batch] The manifest batch did not emit a trusted `IMAGEGEN_BATCH` "
                    f"summary ({startup_error}). Rerun the exact same `--manifest` batch once before "
                    "any serial repairs. If the summary is still missing, stop cleanly with "
                    "artifact_path=null."
                )
            return (
                "[Sophia/deck-batch] A manifest was seen, but it did not make a real batch generation "
                f"attempt ({error_class}). Fix/materialize one prompt JSON file per slide, call "
                "`prepare_pptx_image_manifest(prompt_files=[...])`, and rerun the returned "
                "`--manifest` batch before any serial repairs."
            )
        # Any billable deck image-gen call WITHOUT --manifest before a real batch
        # is the serial loop the batch path exists to prevent (bare
        # ``generate.py`` counts too).
        if _pptx_diagnostic_count(state, "deck_batch_rejection_count") >= _DECK_BATCH_REJECTION_CAP:
            return (
                "[Sophia/deck-batch] A readable image batch manifest is still required before "
                "serial image repair is allowed. Write one prompt JSON file per slide, call "
                "`prepare_pptx_image_manifest(prompt_files=[...])`, then run the returned "
                "manifest path with `image-generation/scripts/generate.py --manifest <path>`. "
                "If you cannot create or run that manifest, stop cleanly with artifact_path=null "
                "rather than serializing the whole deck."
            )
        return (
            "[Sophia/deck-batch] Do NOT generate deck visuals one at a time. Write one prompt JSON "
            "file for every slide visual, including the cover/hero, call "
            "`prepare_pptx_image_manifest(prompt_files=[...])`, then call the image-generation "
            "script ONCE with `--manifest <returned manifest_path>`. All slide visuals generate concurrently. "
            "Single image-gen calls are allowed only to repair failed or missing images AFTER a "
            "readable batch actually attempts generation."
        )

    @staticmethod
    def _deck_build_service_legacy_tool_rejection(request: ToolCallRequest) -> Command | None:
        state = request.state or {}
        if not _deck_build_service_route_active(state):
            return None
        name = str(request.tool_call.get("name") or "")
        args = request.tool_call.get("args")
        if not isinstance(args, dict):
            return None
        blocked = name in {_PPTX_IMAGE_MANIFEST_TOOL_NAME, _DECK_BUILD_TOOL_NAME}
        command = str(args.get("command") or "")
        path = str(args.get("path") or args.get("file_path") or "")
        if name in {"bash", "bash_tool"} and ("image-generation/scripts/generate.py" in command or "ppt-generation/scripts/generate.py" in command or "compile_pptx" in command):
            blocked = True
        if name in {"write_file", "write_file_tool", "str_replace", "str_replace_tool"} and ("/mnt/user-data/outputs/slides/" in path or "/mnt/user-data/outputs/assets/prompts/" in path):
            blocked = True
        if not blocked:
            return None
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=(
                            "[Sophia/deck-build] Fresh PPTX decks are built through "
                            "`prepare_deck_build`. Do not call image-generation scripts, "
                            "prepare_pptx_image_manifest, build_deck_from_slides, python-pptx, "
                            "or pptxgenjs directly. Submit creative_plan, deck_stylesheet, and slide html_body through prepare_deck_build; "
                            "DeckBuildService owns sanitization, planned assets, native PowerPoint "
                            "compilation, inspection, mechanical gates, and terminal failure. Screenshot-backed PPTX is not an "
                            "acceptable fallback."
                        ),
                        tool_call_id=request.tool_call.get("id", ""),
                        name=name,
                    )
                ],
            },
            goto="model",
        )

    @staticmethod
    def _deck_prepare_latch_rejection(request: ToolCallRequest) -> Command | None:
        """Reject unrelated work once fresh-deck preparation is authoritative."""
        state = request.state or {}
        if not state.get("builder_deck_prepare_latch_active"):
            return None
        if not _deck_build_service_route_active(state):
            return None
        name = str(request.tool_call.get("name") or "")
        if name in {_PREPARE_DECK_BUILD_TOOL_NAME, "emit_builder_artifact"}:
            return None
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=("[Sophia/deck-build] The prepare latch is active. Call prepare_deck_build now. Todo, write, replace, shell, research, image-generation, and lower-level deck tools are no longer allowed."),
                        tool_call_id=request.tool_call.get("id", ""),
                        name=name or "unknown",
                    )
                ],
            },
            goto="model",
        )

    @staticmethod
    def _deck_improvisation_haystack(name: str, args: dict[str, Any]) -> str | None:
        if name in {"bash", "bash_tool"}:
            return str(args.get("command") or "").lower()
        if name not in {"write_file", "write_file_tool", "str_replace", "str_replace_tool"}:
            return None
        path = str(args.get("path") or args.get("file_path") or "").lower()
        if path.endswith((".html", ".htm")):
            return None  # slide HTML authoring is the sanctioned HTML-slide deck path
        if not path.endswith((".py", ".js", ".mjs", ".ts")):
            return None  # only code files can carry deck-compilation improvisation
        content = str(args.get("content") or args.get("new_str") or args.get("new_string") or "")
        return f"{path}\n{content}".lower()

    @staticmethod
    def _deck_improvisation_rejection(request: ToolCallRequest) -> Command | None:
        """Block custom model-run deck compilation for `.pptx` targets.

        Fresh decks compile through ``prepare_deck_build``. The lower-level
        ``build_deck_from_slides`` path is only an explicit non-production
        legacy/debug diagnostic route when those tools are exposed. Custom
        python-pptx/pptxgenjs and direct JS compiler scripts remain blocked.
        """
        state = request.state or {}
        if _requested_artifact_ext(state) != "pptx":
            return None
        name = str(request.tool_call.get("name") or "")
        args = request.tool_call.get("args")
        if not isinstance(args, dict):
            return None
        haystack = BuilderArtifactMiddleware._deck_improvisation_haystack(name, args)
        if haystack is None:
            return None
        signals = (
            "import pptx",
            "from pptx",
            "pptxgenjs",
            "python-pptx",
            "compile_pptx",
            "presentation(",  # python-pptx API constructor
        )
        if not any(sig in haystack for sig in signals):
            return None
        logger.warning("[BuilderDeck] phase=improvisation_blocked tool=%s", name)
        if _deck_build_service_route_active(state):
            content = (
                "[Sophia/deck-build] Fresh PPTX decks are built through `prepare_deck_build`. "
                "Do not write custom deck compiler code or invoke deck compilers directly. "
                "Submit creative_plan, deck_stylesheet, and slide html_body through prepare_deck_build; DeckBuildService owns assembly, sanitization, "
                "planned assets, native PowerPoint compilation, inspection, mechanical gates, and terminal failure. "
                "Screenshot-backed PPTX is not an acceptable fallback."
            )
        else:
            content = (
                "[Sophia/deck-build] Do not write custom python-pptx/pptxgenjs code or "
                "invoke deck compilers directly. This is an explicit non-production "
                "legacy/debug route: author one self-contained 1920x1080 HTML file per "
                "slide under `/mnt/user-data/outputs/slides/` (real DOM title + "
                "narrative + one embedded `../assets/<file>` visual), then call "
                "`build_deck_from_slides(output_path, title)` — it renders each slide and "
                "compiles the .pptx for you."
            )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=content,
                        tool_call_id=request.tool_call.get("id", ""),
                        name=name,
                    ),
                ],
            },
            goto="model",
        )

    @staticmethod
    def _deck_compile_visuals_rejection(request: ToolCallRequest) -> Command | None:
        if request.tool_call.get("name") != _DECK_BUILD_TOOL_NAME:
            return None
        state = request.state or {}
        if _deck_build_service_route_active(state):
            return Command(
                update={
                    "messages": [
                        _error_tool_message(
                            content=("[Sophia/deck-build] Fresh PPTX decks are compiled internally by `prepare_deck_build`; do not call build_deck_from_slides directly. Submit corrected slide intent through prepare_deck_build."),
                            tool_call_id=request.tool_call.get("id", ""),
                            name=_DECK_BUILD_TOOL_NAME,
                        )
                    ],
                },
                goto="model",
            )
        if not _pptx_generated_visuals_required(state) or _pptx_generated_visuals_complete(state):
            return None
        diagnostics = _pptx_diagnostics(state)
        counts = _pptx_visual_completeness_diagnostics_update(state)
        manifest_attempted = bool(diagnostics.get("image_generation_manifest_generation_attempted"))
        if manifest_attempted:
            next_step = (
                "The primary manifest batch has run but required visuals are still missing. Generate only the failed/missing slide visuals serially using the same prompt files and output filenames, then call `build_deck_from_slides`."
            )
        else:
            next_step = "Before compiling, write one prompt JSON file per slide, call `prepare_pptx_image_manifest(prompt_files=[...])`, then run the returned `manifest_path` with `image-generation/scripts/generate.py --manifest <path>`."
        _trace_pptx_compile_decision(
            state=state,
            decision="compile_blocked_missing_visuals",
            reason="generated_visuals_incomplete",
            outputs=counts,
        )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=(
                            "[Sophia/PPTX visual completeness]\n"
                            "Do not compile this presentation yet. Expected "
                            f"{counts['expected_generated_visual_count']} generated slide visual(s), "
                            f"found {counts['successful_generated_visual_count']} successful generation(s), "
                            f"and {counts['referenced_visual_count']} slide HTML visual reference(s). "
                            f"{next_step} If the required visuals cannot be produced after bounded batch "
                            "plus serial recovery, stop cleanly with artifact_path=null."
                        ),
                        tool_call_id=request.tool_call.get("id", ""),
                        name=_DECK_BUILD_TOOL_NAME,
                    )
                ],
                "builder_pptx_diagnostics": counts,
            },
            goto="model",
        )

    @staticmethod
    def _deck_floor_escape_directive() -> str:
        return (
            "[Sophia/deck-batch] Image generation has repeatedly been rejected before a readable "
            "parallel batch could run. STOP making serial image-generation calls. If the prompt "
            "JSON files can be materialized, write/fix them now, call "
            "`prepare_pptx_image_manifest(prompt_files=[...])`, and rerun the returned "
            "`--manifest` batch. If they cannot, stop cleanly with artifact_path=null and explain "
            "that the deck image manifest could not be prepared; do not compile a partial "
            "placeholder deck."
        )

    def _deck_floor_escape_command(self, request: ToolCallRequest, state: dict[str, Any]) -> Command | None:
        """Break manifest_rejected ↔ deck_batch_nudge loops without degrading.

        The loop breaker no longer routes to placeholder deck compilation. It
        gives one more explicit manifest-correction path and otherwise tells the
        builder to fail cleanly instead of serializing the whole deck.
        """
        if _requested_artifact_ext(state) != "pptx":
            return None
        if _deck_build_service_route_active(state):
            return None
        diagnostics = _pptx_diagnostics(state)
        already = bool(diagnostics.get("deck_floor_escape_emitted"))
        friction = _pptx_diagnostic_count(state, "manifest_rejection_count") + _pptx_diagnostic_count(state, "deck_batch_rejection_count")
        if not already and friction < _DECK_FLOOR_ESCAPE_FRICTION_CAP:
            return None
        logger.warning(
            "[BuilderImageGeneration] phase=deck_batch_loop_break friction=%d already=%s",
            friction,
            already,
        )
        _trace_pptx_compile_decision(
            state=state,
            decision="deck_batch_loop_break",
            reason="image_gen_friction_cap_reached",
            outputs={"friction": friction},
        )
        counts = _pptx_visual_completeness_counts(state)
        expected = int(counts.get("expected_generated_visual_count", 0) or 0)
        successful = int(counts.get("successful_generated_visual_count", 0) or 0)
        if _pptx_generated_visuals_required(state) and expected > 0 and successful == 0:
            args = request.tool_call.get("args")
            fallback = self._terminal_pptx_failure_fallback(
                args if isinstance(args, dict) else {},
                state,
                request.runtime,
                reason="deck_batch_loop_break",
                steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
            )
            logger.warning(
                "BuilderArtifact: terminal PPTX legacy batch loop break expected=%d successful=%d",
                expected,
                successful,
            )
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=json.dumps(fallback, default=str),
                            tool_call_id=str(request.tool_call.get("id", "") or ""),
                            name="emit_builder_artifact",
                        )
                    ],
                    "builder_result": fallback,
                    "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                    "builder_pptx_diagnostics": {
                        **counts,
                        "deck_floor_escape_emitted": True,
                        "deck_batch_terminal_failure": True,
                        "primary_image_batch_status": "failed",
                        "primary_image_batch_error_class": "deck_batch_loop_break",
                        "image_generation_status": "failed",
                    },
                    "builder_non_artifact_turns": 0,
                    "builder_task_started_at_ms": 0,
                    "builder_consecutive_empty_emit_rejections": 0,
                    "builder_last_missing_emit_path": None,
                    "builder_consecutive_missing_emit_path_rejections": 0,
                    **_terminal_halt_fields(state, "pptx_image_generation_failed"),
                },
                goto="end",
            )
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=self._deck_floor_escape_directive(),
                        tool_call_id=request.tool_call.get("id", ""),
                        name=str(request.tool_call.get("name") or "bash"),
                    ),
                ],
                "builder_pptx_diagnostics": {"deck_floor_escape_emitted": True},
            },
            goto="model",
        )

    def _image_generation_block_command(self, request: ToolCallRequest) -> Command | None:
        """Enforce the per-build image-generation discipline at bash time.

        Two deterministic guards (enrichment is on by default, so both must
        be harness-enforced rather than prompt-hoped):
        - hard cap: at most ``_IMAGE_GENERATION_MAX_CALLS`` script calls per
          build (a single ``&&``-chained command can carry several);
        - terminal-error short-circuit: once a call failed with an
          environment-level error class (missing key, auth), further calls
          are pointless — redirect to charts/text immediately.
        """
        tool_name = str(request.tool_call.get("name") or "")
        if tool_name not in {"bash", "bash_tool"}:
            return None
        args = request.tool_call.get("args") or {}
        command = str(args.get("command") or "") if isinstance(args, dict) else ""
        in_command = _image_generation_invocations_in_command(command)
        if in_command <= 0:
            return None
        billable_in_command = _image_generation_billable_invocations_in_command(command)
        if billable_in_command <= 0:
            # VQ-3: preflight-only checks are free — never counted, never blocked.
            return None
        state = request.state or {}
        # FIX 1 (2026-06-30): once a deck has accumulated repeated image-gen
        # friction (unreadable --manifest + premature serial rejections), break
        # the loop with one explicit manifest correction path and otherwise fail
        # cleanly. Checked BEFORE the manifest/batch rejections so it pre-empts
        # the deadlock; it does NOT touch the pre-spend manifest read.
        floor_escape = self._deck_floor_escape_command(request, state)
        if floor_escape is not None:
            return floor_escape
        manifest_rejection = _unreadable_manifest_rejection(command, state)
        if manifest_rejection is not None:
            manifest_reason = _manifest_rejection_reason(command, state) or "manifest_not_readable"
            logger.warning("[BuilderImageGeneration] phase=manifest_rejected")
            _trace_pptx_image_manifest_rejected(
                command=command,
                state=state,
                error_class=manifest_reason,
            )
            return Command(
                update={
                    "messages": [
                        _error_tool_message(
                            content=manifest_rejection,
                            tool_call_id=request.tool_call.get("id", ""),
                            name=tool_name,
                        ),
                    ],
                    # Friction toward the floor escape (summing reducer).
                    "builder_pptx_diagnostics": {
                        "manifest_rejection_count": 1,
                        "manifest_authoring_failure_count": 1,
                        "primary_image_batch_status": "failed",
                        "primary_image_batch_error_class": manifest_reason,
                    },
                },
                goto="model",
            )
        if any(_command_flag_value(segment, "--manifest") for segment in _command_segments_for_marker(command, _IMAGE_GENERATION_PATH_MARKERS)):
            _trace_pptx_image_manifest_prepared(command, state)
        # The cap counts IMAGES: a single ``--manifest`` call produces N images,
        # so the budget math uses the manifest item count, not the invocation count.
        images_in_command = max(1, _image_generation_images_in_command(command, state))
        rejection, attempts, successes, error_class = self._image_generation_rejection_text(
            state,
            billable_in_command=images_in_command,
        )
        if rejection is not None:
            logger.warning(
                "[BuilderImageGeneration] phase=call_blocked attempts=%d in_command=%d successes=%d error_class=%s",
                attempts,
                billable_in_command,
                successes,
                error_class,
            )
            _trace_pptx_compile_decision(
                state=state,
                decision="image_generation_blocked",
                reason=str(error_class or "budget_or_terminal_rejection"),
                outputs={"billable_images_in_command": images_in_command},
            )
            return Command(
                update={
                    "messages": [
                        _error_tool_message(
                            content=rejection,
                            tool_call_id=request.tool_call.get("id", ""),
                            name=tool_name,
                        ),
                    ],
                },
                goto="model",
            )
        # Deck batch-first backstop: reject serial image-gen calls until a
        # readable --manifest batch has made a real generation attempt. Keeps
        # rejecting until a batch runs, bounded by a safety valve.
        deck_batch_directive = self._deck_batch_directive_rejection(command, state)
        # Always log the gate decision so a missed batch is diagnosable from prod
        # logs (LangSmith run traces are 403-blocked; bash args are not logged).
        logger.info(
            "[BuilderImageGeneration] phase=deck_batch_check rejected=%s manifest_seen=%s success_count=%d rejection_count=%d",
            deck_batch_directive is not None,
            bool(_pptx_diagnostics(state).get("image_generation_manifest_seen")),
            _pptx_diagnostic_count(state, "image_generation_success_count"),
            _pptx_diagnostic_count(state, "deck_batch_rejection_count"),
        )
        if deck_batch_directive is not None:
            logger.warning("[BuilderImageGeneration] phase=deck_batch_nudge")
            _trace_pptx_compile_decision(
                state=state,
                decision="image_batch_nudge",
                reason="post_hero_serial_image_call_without_manifest",
            )
            return Command(
                update={
                    "messages": [
                        _error_tool_message(
                            content=deck_batch_directive,
                            tool_call_id=request.tool_call.get("id", ""),
                            name=tool_name,
                        ),
                    ],
                    # Summing reducer: each rejection increments toward the
                    # safety-valve cap (_DECK_BATCH_REJECTION_CAP).
                    "builder_pptx_diagnostics": {"deck_batch_rejection_count": 1},
                },
                goto="model",
            )
        if _requested_artifact_ext(state) == "pptx":
            _trace_pptx_compile_decision(
                state=state,
                decision="image_generation_allowed",
                reason="within_budget_and_not_terminal",
                outputs={"billable_images_in_command": images_in_command},
            )
        return None

    def _visual_gate_rejection_command(
        self,
        request: ToolCallRequest,
        args: dict[str, Any],
    ) -> Command | None:
        """One bounded repair turn when requested visuals are not embedded.

        Returns a rejection Command (with the spent-repair-turn counter in
        the update so the next emit soft-passes) or ``None`` to accept.
        """
        state = request.state or {}
        counter_key: str | None = None
        if self._visual_gate_blocks_emit(args, state):
            counter_key = "builder_visual_embed_rejections"
            rejection_text = self._emit_rejection_message(args, state)
        elif self._hero_gate_blocks_emit(args, state):
            counter_key = "builder_hero_gate_rejections"
            rejection_text = self._emit_rejection_message(args, state)
        else:
            advisory = self._advisory_rejection_text(args, state)
            if advisory is None:
                return None
            rejection_text = advisory
        tool_call_id = request.tool_call.get("id", "")
        content = self._repair_turn_content(rejection_text, args, state)
        update: dict[str, Any] = {
            "messages": [
                _error_tool_message(
                    content=content,
                    tool_call_id=tool_call_id,
                    name="emit_builder_artifact",
                ),
            ],
            "build_iterations": iterations_used(state) + 1,
        }
        if counter_key is None:
            update["builder_advisory_consumed"] = True
        else:
            update[counter_key] = int(state.get(counter_key, 0) or 0) + 1
        return Command(update=update, goto="model")

    def _advisory_rejection_text(
        self,
        args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str | None:
        """VQ-10 advisory holistic pass — at most ONE iteration, never spins.

        Runs only when every deterministic gate passed, the loop/budget have
        headroom, and it has not been consumed yet.
        """
        if state.get("builder_advisory_consumed"):
            return None
        if _requested_artifact_ext(state) not in {"pptx", "pdf"}:
            return None
        if not _repair_iteration_grantable(state):
            return None
        preview = self._repair_preview_pdf(args, state)
        if preview is None:
            return None
        review = rendered_artifact_review(preview)
        if not review:
            return None
        findings = review.get("findings")
        findings_text = "\n".join(f"- {item}" for item in findings[:5]) if isinstance(findings, list) else ""
        if not findings_text:
            findings_text = str(review.get("verdict") or "repair")
        logger.warning(
            "[BuilderVQ] phase=rendered_review_findings verdict=%s iteration=%d/%d",
            review.get("verdict"),
            iterations_used(state) + 1,
            iteration_cap(),
        )
        return (
            f"Error: emit_builder_artifact deferred — a review of the rendered preview found concrete polish issues:\n{findings_text}\nFix these (regenerate the affected figures/sections), then emit again. This review happens at most once."
        )

    @classmethod
    def _repair_preview_pdf(
        cls,
        args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> Path | None:
        """PDF to rasterize for a repair turn: the deck's preview or the PDF itself."""
        artifact_path = args.get("artifact_path")
        host_file = _local_output_file_for_artifact(state, artifact_path)
        if host_file is None or not host_file.is_file():
            return None
        suffix = host_file.suffix.lower()
        if suffix == ".pdf":
            return host_file
        if suffix == ".pptx":
            remaining = _remaining_builder_deadline_seconds(state)
            if remaining is not None and remaining <= 5:
                return None
            return (
                maybe_render_pptx_preview(
                    host_file,
                    timeout_seconds=min(300, remaining - 2),
                )
                if remaining is not None
                else maybe_render_pptx_preview(host_file)
            )
        return None

    @classmethod
    def _repair_turn_content(
        cls,
        rejection_text: str,
        args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str | list[dict[str, Any]]:
        """VQ-6: attach preview rasters + the review checklist to repair turns.

        Falls back to the plain rejection text when rasters are unavailable
        (no poppler, no file yet, vision-off builds keep working).
        """
        preview = cls._repair_preview_pdf(args, state)
        if preview is None:
            return rejection_text
        blocks = preview_review_blocks(preview)
        if not blocks:
            return rejection_text
        return [{"type": "text", "text": rejection_text}, *blocks]

    @classmethod
    def _hero_gate_blocks_emit(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> bool:
        """Legacy hero/cover gate (Spec VQ-4), bounded to one repair turn.

        "On by default" becomes enforced-by-default: an enrichment-enabled
        deck/PDF with ZERO successful generated images, no honest skip_reason
        (preflight env failure / terminal error / content policy), and an
        unspent repair turn gets exactly one rejection telling the model to
        run preflight → generate the hero/cover → wire it. Afterwards the
        build ships honestly with quality_warning=hero_missing/cover_missing.
        """
        if _requested_artifact_ext(state) not in {"pptx", "pdf"}:
            return False
        if not _builder_image_enrichment_enabled(state):
            return False
        diagnostics = _pptx_diagnostics(state)
        if int(diagnostics.get("image_generation_success_count", 0) or 0) > 0:
            return False
        if diagnostics.get("image_generation_skip_reason"):
            return False  # preflight already recorded an honest skip
        error_class = str(diagnostics.get("image_generation_error_class") or "")
        if error_class and (error_class in _IMAGE_GENERATION_TERMINAL_ERRORS or error_class == "content_blocked"):
            return False  # attempts failed for environment/policy reasons — honest skip
        logger.warning(
            "[BuilderImageGeneration] phase=hero_missing_diagnostic requested_ext=%s attempts=%d — generated imagery is guided by the workflow; rendered vision QA will judge final quality when available",
            _requested_artifact_ext(state),
            int(diagnostics.get("image_generation_attempt_count", 0) or 0),
        )
        return False

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant — same logic as wrap_tool_call."""
        tool_name = str(request.tool_call.get("name") or "")
        if (
            tool_name in _PRESENTATION_PREFLIGHT_TOOLS
            and _deck_build_service_route_active(request.state or {})
            and request.state.get("builder_presentation_phase") == "preflight_call_emitted"
        ):
            remaining = self._presentation_preflight_seconds_remaining(request.state or {})
            try:
                async with asyncio.timeout(max(0.001, remaining or 0.001)):
                    result = await handler(request)
            except TimeoutError:
                logger.warning("BuilderArtifact: presentation web preflight timed out; continuing to authoring")
                result = ToolMessage(
                    content="Error: Presentation web preflight exceeded its bounded time budget.",
                    tool_call_id=str(request.tool_call.get("id") or ""),
                    name=tool_name,
                    status="error",
                )
                return self._presentation_preflight_tool_result_command(request, result, status="timed_out")
            return self._presentation_preflight_tool_result_command(request, result)
        exhausted = self._prepare_deck_build_exhausted_command(request)
        if exhausted is not None:
            return exhausted
        latch_block = self._deck_prepare_latch_rejection(request)
        if latch_block is not None:
            return latch_block
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block
        visual_design_block = self._block_visual_asset_before_design_skill(request)
        if visual_design_block is not None:
            return visual_design_block
        if request.tool_call.get("name") != "emit_builder_artifact":
            deck_service_block = self._deck_build_service_legacy_tool_rejection(request)
            if deck_service_block is not None:
                return deck_service_block
            deck_block = self._deck_improvisation_rejection(request)
            if deck_block is not None:
                return deck_block
            deck_compile_block = self._deck_compile_visuals_rejection(request)
            if deck_compile_block is not None:
                return deck_compile_block
            image_block = self._image_generation_block_command(request)
            if image_block is not None:
                return image_block
            self._maybe_autowire_pptx_plan_visuals(request)
            _maybe_attach_image_trace_env(request)
            if request.tool_call.get("name") == _PREPARE_DECK_BUILD_TOOL_NAME:
                record_runtime_event(
                    state=request.state or {},
                    runtime=request.runtime,
                    event_type="prepare.execution_started",
                    tool_call_id=str(request.tool_call.get("id") or "") or None,
                )
            return self._tool_result_command(request, await handler(request))

        args = request.tool_call.get("args", {})
        # Correction wave 2026-06-12: see wrap_tool_call — the user-intent
        # override must precede _authoritative_pdf_emit_args.
        format_conflict = _format_conflict_user_override(args, request.state)
        if format_conflict is not None:
            original_target_ext = _requested_target_suffix(request.state).lstrip(".")
            request.state = {**request.state, **format_conflict}
            _stamp_format_conflict_metadata(
                args,
                original_target_ext,
                _requested_target_suffix(request.state).lstrip("."),
            )
        # Phase 5c runs AFTER the format-conflict override so it gates the
        # RESOLVED target's skill (not a misderived dispatch target).
        target_skill_block = self._block_emit_before_target_skill(request)
        if target_skill_block is not None:
            return target_skill_block
        terminal_pptx_failure = self._terminal_pptx_failure_emit_command(request, args)
        if terminal_pptx_failure is not None:
            return terminal_pptx_failure
        authoritative_pdf_args = self._authoritative_pdf_emit_args(args, request.state, request.runtime)
        if authoritative_pdf_args is not None:
            request.tool_call["args"] = authoritative_pdf_args
            return await handler(request)
        authoritative_pptx_args = self._authoritative_pptx_emit_args(args, request.state, request.runtime)
        if authoritative_pptx_args is not None:
            request.tool_call["args"] = authoritative_pptx_args
            return await handler(request)
        if self._artifact_files_exist(args, request.state, request.runtime):
            visual_rejection = self._visual_gate_rejection_command(request, args)
            if visual_rejection is not None:
                return visual_rejection
            return await handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return await handler(request)
        recovered_args = self._recover_emit_args_from_output_scan(
            args,
            request.state,
            request.runtime,
            reason="awrap_tool_call_missing_emit_path",
        )
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return await handler(request)

        terminal_startup_failure = self._terminal_pptx_startup_failure_emit_command(request, args)
        if terminal_startup_failure is not None:
            return terminal_startup_failure

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in awrap_tool_call — artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        diagnostics = self._emit_rejection_diagnostics(args, request.state, request.runtime)
        return Command(
            update={
                "messages": [
                    _error_tool_message(
                        content=self._emit_rejection_message(args, request.state),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                    ),
                ],
                "builder_failure_diagnostics": diagnostics,
            },
            goto="model",
        )

    @staticmethod
    def _prepare_call_after_model_update(
        state: BuilderArtifactState,
        tool_calls: list[dict[str, Any]],
        runtime: Runtime | None = None,
    ) -> dict[str, Any]:
        calls = [call for call in tool_calls if str(call.get("name") or "") == _PREPARE_DECK_BUILD_TOOL_NAME]
        if not calls:
            return {}
        for call in calls:
            record_runtime_event(
                state=state,
                runtime=runtime,
                event_type="prepare.emitted",
                tool_call_id=str(call.get("id") or "") or None,
            )
        diagnostics: dict[str, Any] = {
            "prepare_call_count": len(calls),
            "prepare_emitted_call_count": len(calls),
        }
        if len(calls) > 1:
            diagnostics.update(
                {
                    "prepare_parallel_call_count": len(calls),
                }
            )
        if _pptx_diagnostics(state).get("first_prepare_turn") is None:
            diagnostics["first_prepare_turn"] = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
        call_id = str(calls[-1].get("id") or "").strip()
        call_args = calls[-1].get("args") if isinstance(calls[-1].get("args"), dict) else {}
        diagnostics["deck_authoring_output_bytes"] = len(
            json.dumps(call_args, separators=(",", ":"), default=str).encode("utf-8")
        )
        diagnostics["authoring_tool_call_started"] = True
        diagnostics["deck_authoring_contract"] = (
            str(call_args.get("authoring_contract") or "compact_model_html_v1")
            if str(call_args.get("deck_stylesheet") or "").strip()
            else "legacy_full_html_v1"
        )
        diagnostics["deck_authoring_elapsed_ms"] = _elapsed_since_presentation_authoring_start_ms(state)
        diagnostics.setdefault("prepare_force_reason", "model_initiated")
        update: dict[str, Any] = {
            "builder_pptx_diagnostics": diagnostics,
            "builder_deck_prepare_latch_active": True,
            "builder_deck_prepare_expected_tool_call_id": call_id or None,
            "builder_presentation_phase": "prepare_call_emitted",
        }
        if state.get("builder_deck_prepare_phase") == "retry_pending":
            update.update(
                {
                    "builder_deck_prepare_phase": "retry_call_emitted",
                }
            )
        return update

    def _parallel_prepare_terminal_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime,
        tool_calls: list[dict[str, Any]],
        prepare_call_update: dict[str, Any],
    ) -> dict[str, Any] | None:
        calls = [
            call
            for call in tool_calls
            if str(call.get("name") or "") == _PREPARE_DECK_BUILD_TOOL_NAME
        ]
        if len(calls) <= 1:
            return None

        prior_diagnostics = _pptx_diagnostics(state)
        root_failure_code = (
            prior_diagnostics.get("deck_root_failure_code")
            or "deck_prepare_parallel_calls_forbidden"
        )
        root_failure_summary = (
            prior_diagnostics.get("deck_root_failure_summary")
            or "Multiple prepare_deck_build calls were emitted in one model turn."
        )
        call_delta = prepare_call_update.get("builder_pptx_diagnostics")
        if not isinstance(call_delta, dict):
            call_delta = {}
        terminal_delta = _merge_builder_pptx_diagnostics(
            call_delta,
            {
                "prepare_result_count": len(calls),
                "prepare_policy_result_count": len(calls),
                "dangling_prepare_call_count": 0,
                "deck_status": "failed_terminal",
                "deck_failure_code": "deck_prepare_parallel_calls_forbidden",
                "deck_root_failure_code": root_failure_code,
                "deck_root_failure_summary": root_failure_summary,
                "last_prepare_failure_code": "deck_prepare_parallel_calls_forbidden",
                "last_prepare_failure_summary": (
                    "Multiple prepare_deck_build calls were emitted in one model turn."
                ),
                "prepare_repair_count": self._prepare_repair_attempt_count(state),
                "prepare_retry_executed": self._prepare_repair_attempt_count(state) > 0,
            },
        )
        payload = {
            "success": False,
            "failure_code": "deck_prepare_parallel_calls_forbidden",
            "failure_summary": (
                "prepare_deck_build calls must be sequential; multiple calls were emitted in one model turn."
            ),
            "root_failure_code": root_failure_code,
            "root_failure_summary": root_failure_summary,
            "last_prepare_failure_code": "deck_prepare_parallel_calls_forbidden",
            "last_prepare_failure_summary": (
                "Multiple prepare_deck_build calls were emitted in one model turn."
            ),
            "retryable": False,
        }
        terminal_state = {
            **state,
            "builder_pptx_diagnostics": _merge_builder_pptx_diagnostics(
                prior_diagnostics,
                terminal_delta,
            ),
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
        }
        fallback = self._prepare_deck_build_failure_fallback(
            state=state,
            runtime=runtime,
            payload=payload,
            delta=terminal_delta,
        )
        result_messages: list[ToolMessage] = []
        for call in calls:
            call_id = str(call.get("id") or "")
            record_runtime_event(
                state=terminal_state,
                runtime=runtime,
                event_type="prepare.result_recorded",
                tool_call_id=call_id or None,
                status="policy_rejected",
                failure_code="deck_prepare_parallel_calls_forbidden",
            )
            result_messages.append(
                ToolMessage(
                    content=json.dumps(payload),
                    tool_call_id=call_id,
                    name=_PREPARE_DECK_BUILD_TOOL_NAME,
                    status="error",
                    additional_kwargs={
                        "tool_error": {
                            "error_class": "ParallelPrepareCallError",
                            "retryable": False,
                            "stage": "prepare_policy",
                        }
                    },
                )
            )
        return {
            "messages": result_messages,
            "builder_pptx_diagnostics": terminal_delta,
            "builder_result": fallback,
            "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_deck_prepare_phase": "terminal",
            "builder_presentation_phase": "terminal",
            "builder_deck_prepare_expected_tool_call_id": None,
            **_terminal_halt_fields(state, "deck_prepare_parallel_calls_forbidden"),
            "jump_to": "end",
        }

    @hook_config(can_jump_to=["end"])
    @override
    def after_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_builder_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()

        # Don't overwrite a previously captured result
        if state.get("builder_result") is not None:
            log_middleware("BuilderArtifact", "already captured, skipping", _t0)
            return None

        messages = state.get("messages", [])
        latest_ai = next(
            (message for message in reversed(messages) if getattr(message, "type", None) == "ai"),
            None,
        )
        preflight_failure = self._presentation_preflight_model_failure_update(state, latest_ai)
        if preflight_failure is not None:
            return preflight_failure
        authoring_failure = self._deck_authoring_message_failure_update(state, runtime, latest_ai)
        if authoring_failure is not None:
            return authoring_failure

        # Scan messages in reverse for an AI message with tool_calls
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue

            tool_calls = getattr(msg, "tool_calls", []) or []

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                # Surface skill-discovery / skill-invocation breadcrumbs
                # before any control-flow branches return. The user
                # complained about zero visibility into which skills the
                # builder picks; this resolves that without changing
                # behaviour.
                _emit_skill_usage_logs(tool_calls)
                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_builder_artifact"]
                tool_names = self._tool_names(tool_calls)
                pptx_skill_flags = _pptx_skill_flags_from_tool_calls(tool_calls)
                visual_skill_flags = _visual_skill_flags_from_tool_calls(tool_calls)
                research_diagnostics = self._update_research_diagnostics(state, tool_names)
                allow_web_research = self._allow_web_research(state)
                prepare_call_update = self._prepare_call_after_model_update(state, tool_calls, runtime)
                parallel_prepare_terminal = self._parallel_prepare_terminal_update(
                    state,
                    runtime,
                    tool_calls,
                    prepare_call_update,
                )
                if parallel_prepare_terminal is not None:
                    return parallel_prepare_terminal

                if _only_artifact_tool_calls(artifact_calls, tool_calls):
                    args = artifact_calls[-1].get("args", {})

                    # PR-D (2026-04-24): verify the referenced file exists before
                    # accepting the emit. If missing, let wrap_tool_call handle the
                    # retry (Command(goto="model")) instead of completing with a
                    # phantom artifact.
                    #
                    # Codex fix (2026-04-24): on rejection we MUST still increment
                    # builder_non_artifact_turns. If the builder is in the forced-emit
                    # window (_should_force_emit is True) and the counter stays
                    # frozen, the model is trapped: tool_choice forces emit →
                    # emit is rejected → tool_choice forces emit again → loop.
                    # Incrementing lets the hard ceiling (10) trigger after a few
                    # retries and terminate the run instead of spinning forever.
                    args = self._recover_missing_emit_args_if_possible(args, state, runtime)

                    # Correction wave 2026-06-12: explicit current-turn user
                    # format beats a misderived dispatch target. Rebinding the
                    # local ``state`` makes every downstream gate — files-exist,
                    # visual/hero gates, and the acceptance-path metadata
                    # stamper — evaluate under the corrected target.
                    format_conflict = _format_conflict_user_override(args, state)
                    if format_conflict is not None:
                        original_target_ext = _requested_target_suffix(state).lstrip(".")
                        state = {**state, **format_conflict}
                        _stamp_format_conflict_metadata(
                            args,
                            original_target_ext,
                            _requested_target_suffix(state).lstrip("."),
                        )

                    terminal_reason = self._intentional_pptx_failure_emit_reason(args, state)
                    if terminal_reason is not None:
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "terminal_failed_artifact": True,
                                **pptx_skill_flags,
                                **visual_skill_flags,
                            },
                        )
                        fallback = self._terminal_pptx_failure_fallback(
                            args,
                            state,
                            runtime,
                            reason=terminal_reason,
                            steps_completed=non_artifact_turns,
                        )
                        return {
                            "builder_result": fallback,
                            "builder_non_artifact_turns": 0,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_skill_reads": state.get("builder_skill_reads"),
                            "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                            "builder_research_diagnostics": research_diagnostics,
                            "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                            "builder_task_started_at_ms": 0,
                            "builder_consecutive_empty_emit_rejections": 0,
                            "builder_last_missing_emit_path": None,
                            "builder_consecutive_missing_emit_path_rejections": 0,
                            **_terminal_halt_fields(state, "pptx_image_generation_failed"),
                            "jump_to": "end",
                        }

                    emit_files_ok = self._artifact_files_exist(args, state, runtime)
                    visual_gate_blocked = emit_files_ok and self._visual_gate_blocks_emit(args, state)
                    hero_gate_blocked = emit_files_ok and not visual_gate_blocked and self._hero_gate_blocks_emit(args, state)
                    if not emit_files_ok or visual_gate_blocked or hero_gate_blocked:
                        logger.warning(
                            "BuilderArtifact: emit rejected in after_model — artifact_path %s %s. Builder will retry via wrap_tool_call.",
                            args.get("artifact_path"),
                            ("not found on disk or in Supabase" if not emit_files_ok else ("exists but requested visuals are not embedded" if visual_gate_blocked else "exists but no generated hero/cover image succeeded")),
                        )
                        diagnostics = self._emit_rejection_diagnostics(args, state, runtime)
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1

                        # PR #94: track *empty* artifact_path rejections separately
                        # so we can short-circuit before the LangGraph recursion
                        # limit blows. The model's ``artifact_path=None`` under
                        # forced ``tool_choice`` is a strong signal that further
                        # retries won't help — collapse to the hard-ceiling
                        # fallback after _REJECTION_SHORT_CIRCUIT_AT consecutive
                        # such rejections.
                        primary = args.get("artifact_path")
                        is_empty_path_rejection = not (isinstance(primary, str) and primary.strip())
                        consecutive_rejections = int(state.get("builder_consecutive_empty_emit_rejections", 0) or 0)
                        if is_empty_path_rejection:
                            consecutive_rejections += 1
                        else:
                            consecutive_rejections = 0
                        missing_path = str(primary).strip() if isinstance(primary, str) and primary.strip() else None
                        previous_missing_path = state.get("builder_last_missing_emit_path")
                        same_missing_path = isinstance(previous_missing_path, str) and missing_path is not None and previous_missing_path == missing_path
                        consecutive_missing_path_rejections = int(state.get("builder_consecutive_missing_emit_path_rejections", 0) or 0)
                        if missing_path is None:
                            consecutive_missing_path_rejections = 0
                        elif same_missing_path:
                            consecutive_missing_path_rejections += 1
                        else:
                            consecutive_missing_path_rejections = 1

                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "emit_rejected": True,
                                "empty_artifact_path": is_empty_path_rejection,
                                "missing_artifact_path": missing_path,
                                **pptx_skill_flags,
                                **visual_skill_flags,
                            },
                        )
                        write_diagnostics = state.get("builder_write_diagnostics") or {}
                        write_success_count = int(write_diagnostics.get("success_count", 0) or 0)
                        write_error_count = int(write_diagnostics.get("error_count", 0) or 0)
                        if write_success_count == 0 and write_error_count >= 3:
                            logger.warning(
                                "BuilderArtifact: stopping after repeated write failures with no successful output write (write_errors=%d)",
                                write_error_count,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason="repeated_write_failures_no_output",
                            )
                            if not fallback.get("artifact_path"):
                                self._attach_terminal_failure_diagnostics(
                                    {**state, "builder_failure_diagnostics": diagnostics},
                                    runtime,
                                    fallback,
                                    failure_stage="generation",
                                    failure_code="artifact_file_missing",
                                    failure_reason=("Builder stopped after repeated write failures with no successful output."),
                                    emit_attempted=True,
                                    emit_tool_call_seen=True,
                                )
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status=self._fallback_completion_status(fallback),
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_skill_reads": state.get("builder_skill_reads"),
                                "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                **_terminal_halt_fields(state, "repeated_write_failures_no_output"),
                                "jump_to": "end",
                            }

                        if is_empty_path_rejection and consecutive_rejections >= self._REJECTION_SHORT_CIRCUIT_AT:
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive empty-artifact_path rejections at turn=%d (ceiling=%d) — routing to ceiling fallback to avoid GraphRecursionError.",
                                consecutive_rejections,
                                non_artifact_turns,
                                max_non_artifact_turns(state),
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=f"consecutive_empty_emit_rejections={consecutive_rejections}",
                            )
                            if not fallback.get("artifact_path"):
                                self._attach_terminal_failure_diagnostics(
                                    {**state, "builder_failure_diagnostics": diagnostics},
                                    runtime,
                                    fallback,
                                    failure_stage="emit_rejected",
                                    failure_code=diagnostics.get("failure_code") or "artifact_file_missing",
                                    failure_reason=diagnostics.get("failure_reason") or ("Builder stopped after consecutive empty artifact emit rejections."),
                                    emit_attempted=True,
                                    emit_tool_call_seen=True,
                                )
                            # Phase 4L: upload the promoted file to
                            # Supabase BEFORE firing the webhook so the
                            # signed-URL mint + Telegram bytes-download
                            # both succeed. Without this the ceiling
                            # fallback delivered plaintext instead of
                            # the actual file (2026-05-19 production
                            # smoke test).
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status="failed" if not fallback.get("artifact_path") else "completed",
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_skill_reads": state.get("builder_skill_reads"),
                                "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "builder_last_missing_emit_path": None,
                                "builder_consecutive_missing_emit_path_rejections": 0,
                                **_terminal_halt_fields(state, "empty_emit_rejections"),
                                "jump_to": "end",
                            }

                        if missing_path is not None and consecutive_missing_path_rejections >= self._REJECTION_SHORT_CIRCUIT_AT:
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive missing artifact_path rejections for the same path at turn=%d path=%s — routing to ceiling fallback.",
                                consecutive_missing_path_rejections,
                                non_artifact_turns,
                                missing_path,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=(f"consecutive_missing_emit_path_rejections={consecutive_missing_path_rejections}"),
                            )
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status=self._fallback_completion_status(fallback),
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_skill_reads": state.get("builder_skill_reads"),
                                "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "builder_last_missing_emit_path": None,
                                "builder_consecutive_missing_emit_path_rejections": 0,
                                **_terminal_halt_fields(state, "missing_emit_path_rejections"),
                                "jump_to": "end",
                            }

                        rejection_update: dict[str, Any] = {
                            "builder_non_artifact_turns": non_artifact_turns,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_skill_reads": state.get("builder_skill_reads"),
                            "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                            "builder_research_diagnostics": research_diagnostics,
                            "builder_failure_diagnostics": diagnostics,
                            "builder_consecutive_empty_emit_rejections": consecutive_rejections,
                            "builder_last_missing_emit_path": missing_path,
                            "builder_consecutive_missing_emit_path_rejections": consecutive_missing_path_rejections,
                            **_pptx_slide_count_repair_attempt_update(state),
                        }
                        # NOTE: gate counters (builder_visual_embed_rejections,
                        # builder_hero_gate_rejections) and the shared
                        # build_iterations increment ONLY in
                        # _visual_gate_rejection_command (wrap_tool_call).
                        # after_model runs BEFORE tool execution — an
                        # increment here would make wrap_tool_call see the
                        # gate as already spent and ACCEPT the emit without
                        # ever delivering the repair instruction.
                        return rejection_update

                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                            **pptx_skill_flags,
                            **visual_skill_flags,
                        },
                    )
                    _apply_artifact_request_metadata(
                        args,
                        state,
                        fallback_reason="pptx_generation_not_completed" if _requested_pptx_artifact(state) else None,
                    )
                    args = _apply_visual_missing_quality_metadata(args, state)
                    args = _apply_pdf_page_count_quality_metadata(args, state)
                    args = _apply_hero_missing_quality_metadata(args, state)
                    args = _apply_pptx_deck_quality_metadata(args, state)
                    args = _apply_report_figure_quality_metadata(args, state)
                    args = self._attach_pptx_canvas_preview(args, state)
                    _log_pptx_diagnostics(
                        phase="emit_accepted",
                        state={**state, "builder_tool_turn_summaries": history},
                        artifact_path=args.get("artifact_path"),
                    )
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    # Phase-1 async migration created a fresh builder thread
                    # per build (deepagents native dispatch). The Telegram
                    # channel adapter looks up artifact bytes via the
                    # CONVERSATION thread_id (parent / companion), not the
                    # ephemeral build thread, so we namespace the upload
                    # under the parent thread to keep the storage path and
                    # the channel-adapter download path aligned.
                    #
                    # Production traceback (2026-05-06T22:18:16): Telegram
                    # downloaded from sophia_builder/<parent>/<file> and got
                    # 400 because the file lived at sophia_builder/<builder>/<file>.
                    # Switching to parent_thread_id here restores the legacy
                    # SubagentExecutor convention.
                    delegation_for_upload = state.get("delegation_context") if isinstance(state.get("delegation_context"), dict) else {}
                    parent_thread_id = delegation_for_upload.get("parent_thread_id") if isinstance(delegation_for_upload, dict) else None
                    builder_thread_id = runtime.context.get("thread_id") if runtime.context else None
                    upload_thread_id = parent_thread_id or builder_thread_id
                    _attach_durable_upload_identity(args, state, runtime)
                    mirror_result = _upload_builder_outputs_to_supabase(
                        thread_id=upload_thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    self._annotate_supabase_mirror_diagnostics(
                        state,
                        runtime,
                        args,
                        mirror_result=mirror_result,
                    )
                    self._log_missing_pdf_render_attempt_if_needed(state, args)
                    self._log_research_diagnostics(
                        phase="completion",
                        diagnostics=research_diagnostics,
                        allow_web_research=allow_web_research,
                        sources_used=args.get("sources_used"),
                    )
                    _trace_pptx_terminal_outcome(
                        state=state,
                        artifact=args,
                        status="completed",
                    )
                    annotate_builder_completion(state, args)
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, confidence={args.get('confidence')}",
                        _t0,
                    )
                    # Fire the gateway webhook so the Telegram channel adapter
                    # (and webapp SSE) deliver the artifact bytes to the user.
                    # Replaces the deleted ``SubagentExecutor`` terminal-flip
                    # call site after the Phase-1 async migration.
                    if _is_required_supabase_failure(mirror_result):
                        fire_completion_webhook_from_artifact(
                            state=state,
                            runtime=runtime,
                            artifact=args,
                            status="failed",
                            error_message=_durable_upload_error_message(),
                        )
                    else:
                        fire_completion_webhook_from_artifact(
                            state=state,
                            runtime=runtime,
                            artifact=args,
                            status="completed",
                        )
                    return {
                        "builder_result": args,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_skill_reads": state.get("builder_skill_reads"),
                        "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "builder_last_missing_emit_path": None,
                        "builder_consecutive_missing_emit_path_rejections": 0,
                        **_terminal_halt_fields(state, "artifact_emitted"),
                        "jump_to": "end",
                    }

                if artifact_calls:
                    log_middleware("BuilderArtifact", "mixed tool calls with builder artifact; loop continues", _t0)
                    return None

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                # Record task start wall-clock on the first non-emit turn so
                # the ceiling fallback can scan ONLY files produced during
                # this task (prevents promoting a stale file from a prior
                # builder task that ran in the same thread).
                builder_task_started_at_ms = _builder_start_ms_or_now(state)
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                        **pptx_skill_flags,
                        **visual_skill_flags,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"
                recovered = self._maybe_promote_recovered_deliverable(
                    state,
                    runtime,
                    reason="non_emit_after_successful_deliverable_write",
                )
                if recovered is not None:
                    recovered.update(
                        {
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_skill_reads": state.get("builder_skill_reads"),
                            "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                            "builder_research_diagnostics": research_diagnostics,
                        }
                    )
                    return recovered

                # PR-C F6 (2026-04-24): soft-warn halfway so the model sees
                # an early wrap-up signal in logs (and future trace events).
                # Emitted exactly once per task, at the ``_SOFT_WARN_AT`` turn.
                hard_ceiling = max_non_artifact_turns(state)
                soft_warn = soft_warn_at_turn(state)
                if non_artifact_turns == soft_warn:
                    logger.warning(
                        "BuilderArtifact: soft ceiling warning at turn=%d (hard_ceiling=%d, remaining=%d). Builder should wrap up — emit_builder_artifact with what's on disk instead of continuing to iterate.",
                        non_artifact_turns,
                        hard_ceiling,
                        hard_ceiling - non_artifact_turns,
                    )

                # Hard ceiling: force end before hitting the recursion limit.
                # Builds that haven't emitted by this point almost never recover
                # — the budget is better spent recovering whatever file is
                # already on disk than letting bash thrash. PR #94 extracted
                # the fallback-construction logic into ``_build_ceiling_fallback``
                # so the consecutive-rejection short-circuit can reuse it.
                _HARD_CEILING = hard_ceiling
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    fallback = self._build_ceiling_fallback(
                        state,
                        steps_completed=non_artifact_turns,
                        reason="hard_ceiling",
                    )
                    if not fallback.get("artifact_path"):
                        self._attach_terminal_failure_diagnostics(
                            state,
                            runtime,
                            fallback,
                            failure_stage="generation",
                            failure_code="builder_completed_without_deliverable",
                            failure_reason=("Builder reached its hard ceiling before emitting a deliverable artifact."),
                            emit_attempted=False,
                            emit_tool_call_seen=False,
                        )
                    # Phase 4L: upload-before-webhook (see
                    # ``_upload_fallback_and_fire`` docstring). Same
                    # contract as the consecutive-rejection short-circuit
                    # above — ensures the ceiling-fallback file actually
                    # lands in Supabase before the channel adapter
                    # tries to download bytes for the user.
                    self._upload_fallback_and_fire(
                        state=state,
                        runtime=runtime,
                        fallback=fallback,
                        status=self._fallback_completion_status(fallback),
                    )
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_skill_reads": state.get("builder_skill_reads"),
                        "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "builder_last_missing_emit_path": None,
                        "builder_consecutive_missing_emit_path_rejections": 0,
                        **_terminal_halt_fields(state, "hard_ceiling"),
                        "jump_to": "end",
                    }

                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                self._log_research_diagnostics(
                    phase="progress",
                    diagnostics=research_diagnostics,
                    allow_web_research=allow_web_research,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                    "builder_skill_reads": state.get("builder_skill_reads"),
                    "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                    "builder_research_diagnostics": research_diagnostics,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                    # PR #94: any non-emit turn breaks the empty-rejection
                    # streak. Reset so the short-circuit only fires on
                    # *consecutive* empty emits.
                    "builder_consecutive_empty_emit_rejections": 0,
                    "builder_last_missing_emit_path": None,
                    "builder_consecutive_missing_emit_path_rejections": 0,
                    **_pptx_slide_count_repair_attempt_update(state),
                    **prepare_call_update,
                }

            terminal_startup_reason = self._terminal_pptx_startup_failure_reason(state)
            if terminal_startup_reason is not None:
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                        "tool_names": [],
                        "has_emit_builder_artifact": False,
                        "ended_with_plain_text": True,
                        "terminal_pptx_startup_failure": True,
                    },
                )
                fallback = self._terminal_pptx_failure_fallback(
                    {"artifact_title": "PPTX deck generation failed"},
                    state,
                    runtime,
                    reason=terminal_startup_reason,
                    steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                )
                return {
                    "builder_result": fallback,
                    "builder_non_artifact_turns": 0,
                    "builder_last_tool_names": [],
                    "builder_tool_turn_summaries": history,
                    "builder_skill_reads": state.get("builder_skill_reads"),
                    "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                    "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                    "builder_task_started_at_ms": 0,
                    "builder_consecutive_empty_emit_rejections": 0,
                    "builder_last_missing_emit_path": None,
                    "builder_consecutive_missing_emit_path_rejections": 0,
                    **_terminal_halt_fields(state, "pptx_image_generation_failed"),
                    "jump_to": "end",
                }

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            message_text = _blocks_to_plaintext(getattr(msg, "content", ""))
            loop_hard_stop = bool(state.get("loop_detection_hard_stop")) or ("[FORCED STOP]" in message_text)
            provider_failure = self._model_provider_failure_from_message(msg)
            failure_code = "builder_loop_limit_exceeded" if loop_hard_stop else provider_failure["failure_code"] if provider_failure else "builder_completed_without_deliverable"
            terminal_reason = "loop_limit" if loop_hard_stop else "model_provider_unavailable" if provider_failure else "no_deliverable"
            companion_summary = "The builder stopped after repeating the same tool call too many times." if loop_hard_stop else "The build task ended before producing a deliverable."
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task did not complete",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": companion_summary,
                "companion_tone_hint": "Direct and apologetic — no deliverable was produced.",
                "user_next_action": "Retry with a narrower scope.",
                "confidence": 0.0,
                "status": "failed",
                "terminal_status": "failed",
                "terminal_reason": terminal_reason,
                "artifact_acceptance_status": "failed",
                "failure_code": failure_code,
            }
            self._attach_terminal_failure_diagnostics(
                state,
                runtime,
                fallback,
                failure_stage=(provider_failure["failure_stage"] if provider_failure else "generation"),
                failure_code=(failure_code),
                failure_reason=("Repeated tool calls exceeded the builder loop safety limit." if loop_hard_stop else provider_failure["failure_reason"] if provider_failure else "Builder finished without producing a deliverable artifact."),
                provider_error_reason=(provider_failure["provider_error_reason"] if provider_failure else None),
                retryable=provider_failure["retryable"] if provider_failure else None,
                emit_attempted=False,
                emit_tool_call_seen=False,
            )
            history = self._append_turn_summary(
                state,
                {
                    "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                    "tool_names": [],
                    "has_emit_builder_artifact": False,
                    "ended_with_plain_text": True,
                },
            )
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            # Fire an explicit failure webhook: this fallback has no real
            # deliverable, so it must not surface as a ready/completed card.
            annotate_builder_completion(state, fallback)
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status="failed",
                error_message=(companion_summary),
            )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
                "builder_skill_reads": state.get("builder_skill_reads"),
                "builder_visual_force_count": state.get("builder_visual_force_count", 0),
                "builder_failure_diagnostics": fallback.get("builder_failure_diagnostics"),
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                **_terminal_halt_fields(state, terminal_reason),
                "jump_to": "end",
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
