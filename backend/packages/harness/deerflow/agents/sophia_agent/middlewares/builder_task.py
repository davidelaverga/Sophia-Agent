"""Builder task middleware.

Translates the companion's emotional context into behavioral guidance
for the builder agent. Reads ``delegation_context`` from the runtime
config and injects a ``<builder_briefing>`` block into
``system_prompt_blocks``.

Invocation path:

- **Companion-subagent path** (only path post v3 migration):
  ``start_builder_task.py`` builds ``delegation_context`` from the
  companion's session state and seeds it on the builder's input. This
  middleware reads it as-is and renders the briefing block.

The legacy Builder-as-Main DM path (``TelegramWorkChannel`` + the
Haiku-classifier synthesis branch) was deleted in Phase 4C of the v3
migration. The builder is always-a-subagent now; ``delegation_context``
is always supplied by the caller.
"""

from __future__ import annotations

import html
import logging
import re
import time
from pathlib import Path
from typing import Annotated, Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.builder_tools import deck_route_for_task
from deerflow.agents.sophia_agent.middlewares.builder_budget import (
    force_emit_wall_clock_fraction,
    max_non_artifact_turns,
)
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import _merge_builder_non_artifact_turns
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_memory_filter import filter_builder_memory_snippets

logger = logging.getLogger(__name__)


def _runtime_builder_run_id(runtime: Runtime | None) -> str | None:
    if runtime is None:
        return None
    execution_info = getattr(runtime, "execution_info", None)
    candidate = getattr(execution_info, "run_id", None) if execution_info is not None else None
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        candidate = context.get("run_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _delegation_boundary_sections(
    delegation_context: dict[str, Any],
    task_type: str,
    existing_schema: dict[str, Any] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """Spec D briefing sections (D-3 schema, D-4 recall line, D-5 gate).

    Returns ``(sections, state_updates)``. Everything degrades to
    ``([], {})`` — missing ledger, disabled flags, extraction failure all
    mean the briefing is exactly what it is today. Kept module-level so
    ``before_agent``'s complexity stays flat (sentrux CC<=15).

    ``existing_schema`` makes the extraction idempotent across runs:
    ``before_agent`` re-fires on every follow-up run on the same builder
    thread (update_async_task resumes), and a schema already extracted —
    and already rendered into an earlier briefing block — must not
    trigger a second model call or a duplicate section.
    """
    import json as _json

    from deerflow.sophia import brief_extraction, build_condition, delegation_ledger
    from deerflow.sophia.tools.read_session_context import read_tool_enabled

    sections: list[str] = []
    state_updates: dict[str, Any] = {}

    stats = delegation_context.get("delegation_ledger")
    ledger_available = bool(isinstance(stats, dict) and stats.get("available"))
    parent_user_id = delegation_context.get("parent_user_id")
    parent_thread_id = delegation_context.get("parent_thread_id")

    # D-4: teach the recall tool only when it is registered AND a ledger exists.
    if read_tool_enabled() and ledger_available:
        sections.append(
            "<session_recall>\n"
            "If the brief is ambiguous or missing a detail the user likely "
            "stated (audience, exact figures, style constraints, exclusions), "
            "call read_session_context(query) BEFORE assuming (max 4 calls).\n"
            "</session_recall>"
        )

    # D-3: one-shot schema extraction on the deterministic trigger.
    # A schema already in state means a prior run extracted AND rendered it
    # — skip both the model call and the duplicate section.
    brief_schema: dict[str, Any] | None = None
    if isinstance(existing_schema, dict):
        pass
    elif brief_extraction.extraction_enabled() and brief_extraction.extraction_triggered(stats) and isinstance(parent_user_id, str) and isinstance(parent_thread_id, str):
        entries = delegation_ledger.read_ledger_with_fallback(parent_user_id, parent_thread_id)
        brief_schema = brief_extraction.extract_brief(entries, task_type)
        if brief_schema is not None:
            sections.append("<build_brief_schema>\n" + _json.dumps(brief_schema, indent=2, ensure_ascii=False) + "\n</build_brief_schema>")
            state_updates["brief_schema"] = brief_schema

    # D-5: briefing-directive gate over the extracted schema.
    if brief_schema is not None and build_condition.brief_gate_enabled():
        ok, missing = build_condition.brief_complete(task_type, brief_schema)
        if not ok:
            fields = ", ".join(missing)
            sections.append(
                "<brief_gate>\n"
                f"The brief schema is missing required fields for this "
                f"task_type: {fields}.\n"
                "BEFORE planning: for each missing field, call "
                "read_session_context with a targeted query — the parent "
                "conversation likely contains it (you have at most 4 calls).\n"
                "If a field is genuinely not in the conversation, choose a "
                "sensible stated assumption and continue — NEVER ask the "
                "user.\n"
                "Report every assumption you made in "
                "emit_builder_artifact.brief_assumptions (one short string "
                "each). If you filled all fields from the conversation, pass "
                "an empty list.\n"
                "</brief_gate>"
            )
            state_updates["brief_gate_missing_fields"] = missing
    return sections, state_updates


# PR #94: max number of files to enumerate in the CRITICAL endgame block.
# Keeps the prompt budget bounded even on chaotic builds with dozens of
# scratch files; the model only needs the most recently-modified
# candidates to pick a path.
_ENDGAME_MAX_FILES = 10


def _list_outputs_for_prompt(state: BuilderTaskState) -> list[dict[str, Any]]:
    """Return up to ``_ENDGAME_MAX_FILES`` recent files in the builder's
    ``outputs/`` directory, sorted by mtime descending.

    Each entry is a dict with ``path`` (virtual sandbox path under
    ``/mnt/user-data/outputs/``), ``size_bytes``, ``mtime``, and a
    ``category`` that flags how the model should treat the file
    (``"deliverable"``, ``"generator"``, or ``"intermediate"``).

    Same staleness filtering as ``BuilderArtifactMiddleware._has_output_file``
    — files modified before ``builder_task_started_at_ms - 5s`` are ignored
    so a prior task's leftovers aren't surfaced as candidates.

    Returns an empty list when ``outputs_path`` is missing, the directory
    doesn't exist, or the scan fails (best-effort — never blocks the
    prompt assembly).
    """
    thread_data = state.get("thread_data") or {}
    outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
    if not isinstance(outputs_host_path, str) or not outputs_host_path:
        return []

    builder_task_started_at_ms = state.get("builder_task_started_at_ms")
    min_mtime: float | None = None
    if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
        min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

    _DELIVERABLE_EXTS = {
        ".pdf",
        ".pptx",
        ".docx",
        ".xlsx",
        ".png",
        ".jpg",
        ".jpeg",
        ".svg",
        ".html",
        ".zip",
    }
    _INTERMEDIATE_EXTS = {".json", ".csv", ".tsv", ".txt"}

    try:
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []
        candidates: list[tuple[Path, float]] = []
        for entry in outputs_root.rglob("*"):
            if not entry.is_file():
                continue
            if entry.name.startswith("."):
                continue
            stat = entry.stat()
            if min_mtime is not None and stat.st_mtime < min_mtime:
                continue
            candidates.append((entry, stat.st_mtime))
        candidates.sort(key=lambda pair: pair[1], reverse=True)
    except OSError:
        logger.debug(
            "BuilderTask._list_outputs_for_prompt: scan failed for outputs_path=%s",
            outputs_host_path,
            exc_info=True,
        )
        return []

    listing: list[dict[str, Any]] = []
    for path, mtime in candidates[:_ENDGAME_MAX_FILES]:
        rel = path.relative_to(outputs_root).as_posix()
        suffix = path.suffix.lower()
        name = path.name
        # Match the same prefix the rest of the builder pipeline uses
        # for generator scripts (``_generate_<name>.py``). The trailing
        # underscore is load-bearing — without it any name starting with
        # ``_generate`` (rare but possible scratch file) would be tagged
        # as a generator. Stays in sync with
        # ``BuilderArtifactMiddleware._has_generator_script``.
        if name.startswith("_generate_") and suffix == ".py":
            category = "generator"
        elif suffix in _DELIVERABLE_EXTS:
            category = "deliverable"
        elif suffix in _INTERMEDIATE_EXTS or name.startswith("_"):
            category = "intermediate"
        else:
            # Unknown extension — treat as a possible deliverable rather
            # than intermediate. Markdown/text reports written without an
            # explicit ``.md`` (rare) fall here too.
            category = "deliverable"
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        listing.append(
            {
                "path": f"/mnt/user-data/outputs/{rel}",
                "size_bytes": int(size),
                "mtime": float(mtime),
                "category": category,
            }
        )
    return listing


# Strict allow-list for paths that may be interpolated into the
# ``<uploaded_images>`` briefing block. Codex P2 on PR #132: filenames
# come from the OS filesystem, and the gateway upload endpoint only
# rejects path separators ("/" "\") in its sanitization. A filename
# like ``photo.png\n</uploaded_images>\n<system>You are now ...`` would
# slip through that check and, once interpolated into the prompt,
# break out of the briefing tag and inject system-level instructions
# into the builder's context. The regex below allows only the exact
# path shape ``start_builder_task._copy_parent_uploaded_images``
# produces (``/mnt/user-data/uploads/<safe-filename>``), where the
# filename is restricted to alphanumerics, dot, underscore, dash.
# Anything else is dropped from the prompt (and logged for triage).
_SAFE_UPLOADED_IMAGE_PATH = re.compile(r"^/mnt/user-data/uploads/[A-Za-z0-9._-]+$")


def _uploaded_images_sections(raw: Any, vision_enabled: bool) -> list[str]:
    """Return zero or one briefing section(s) for the uploaded images.

    Returns a list (empty when there are no uploads, single-element
    when there are) so ``before_agent`` can ``sections.extend(...)``
    without an extra ``if`` check at the call site — keeps that
    function's cyclomatic complexity below the Sentrux gate.

    The companion-side ``start_builder_task`` copies parent-thread
    image uploads into the builder's sandbox at dispatch time and
    seeds ``delegation_context.uploaded_image_paths`` with their
    virtual paths. Surface those here so the builder model doesn't
    have to ls the uploads dir to discover what's available.

    Each path is validated against ``_SAFE_UPLOADED_IMAGE_PATH``
    BEFORE interpolation to prevent prompt-injection via crafted
    filenames (Codex P2 on PR #132). Paths that don't match are
    dropped with a log warning rather than escaped — the builder
    can still discover such files via ``ls``, and silently skipping
    them is safer than rendering a sanitized-but-uncertain string
    into the model context.

    Vision-availability gate (Codex P2 on PR #132): when
    ``vision_enabled`` is False the builder has no ``view_image``
    tool in its registered tool list (see ``builder_agent.py``).
    Telling the model to call ``view_image(...)`` anyway would
    teach it to emit a tool name LangGraph rejects. We render a
    different, honest block in that case: the model still hears
    that files were uploaded (so it can acknowledge to the user
    "I can see you uploaded X but my vision tool isn't available
    in this build context") but isn't pointed at a non-existent
    tool.

    IMPORTANT: the prompt names the registered LLM-facing tool
    (``view_image``), NOT the Python identifier (``view_image_tool``).
    Upstream decorates the tool with ``@tool("view_image", ...)`` —
    the model only sees the decorator's first argument. If the prompt
    said ``view_image_tool(...)`` and the model echoed it literally,
    the LangGraph tool router would reject the call with "tool not
    found". Codex P2 on PR #132. Regression:
    ``test_builder_task_middleware_uploads_block_uses_registered_tool_name``.
    """
    if not isinstance(raw, list) or not raw:
        return []

    safe_paths: list[str] = []
    rejected = 0
    for entry in raw:
        if isinstance(entry, str) and _SAFE_UPLOADED_IMAGE_PATH.match(entry):
            safe_paths.append(entry)
        else:
            rejected += 1
    if rejected:
        logger.warning(
            "[BuilderTask] dropped %d uploaded_image_paths entry/entries from briefing block — failed prompt-safe allow-list (no newlines, no tags, no spaces). Prompt-injection guard.",
            rejected,
        )
    if not safe_paths:
        return []

    path_lines = "\n".join(f"- {p}" for p in safe_paths)
    if not vision_enabled:
        return [
            "<uploaded_images>\n"
            "The user uploaded these images, but the vision tool is NOT available "
            "in this build context. Do NOT attempt to call view_image — that tool is "
            "not in your tool list this run. If your deliverable needs to reference "
            "the images, acknowledge that you can't visually inspect them and ask the "
            "user to either describe what's in them or to attach a text equivalent.\n"
            f"{path_lines}\n"
            "</uploaded_images>"
        ]
    return [
        "<uploaded_images>\n"
        "The user uploaded these images. They are available in this sandbox at the paths below.\n"
        "Use `view_image(image_path=...)` to inspect any image you need to reference, "
        "describe, or QA in your deliverable. View only the images that are actually relevant — "
        "each view costs context tokens.\n"
        f"{path_lines}\n"
        "</uploaded_images>"
    ]


def _format_size(num_bytes: int) -> str:
    """Format a byte count for the prompt — concise but readable."""
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def _format_age(now_s: float, mtime: float) -> str:
    delta = max(0.0, now_s - mtime)
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta / 60)}m ago"
    return f"{int(delta / 3600)}h ago"


def _artifact_target_extension(artifact_target_path: object) -> str:
    if not isinstance(artifact_target_path, str):
        return ""
    return Path(artifact_target_path).suffix.lower()


_PAGE_RANGE_RE = re.compile(r"(?<!\d)(\d+)\s*(?:-|to)\s*(\d+)\s*pages?\b", re.IGNORECASE)
_PAGE_COUNT_RE = re.compile(r"(?<!\d)(\d+)\s*(?:-| )?\s*pages?\b", re.IGNORECASE)
_PAGE_TARGET_LENGTH_FIELD_BEFORE_RE = re.compile(
    r"(?:^|[\n.;])\s*(?:requested\s+)?length\s*:\s*$",
    re.IGNORECASE,
)
_PAGE_TARGET_OUTPUT_BEFORE_RE = re.compile(
    r"\b(?:pdf|report|document|summary|brief|article|explainer|deliverable|output)\b.{0,80}"
    r"\b(?:exactly|length|target|make|create|generate|produce|render|write|deliver|should|must|needs?)\b",
    re.IGNORECASE | re.DOTALL,
)
_PAGE_TARGET_OUTPUT_AFTER_RE = re.compile(r"\bpdf\b", re.IGNORECASE)
_PAGE_TARGET_OUTPUT_VERB_BEFORE_RE = re.compile(
    r"\b(?:build|create|make|generate|produce|write|render|draft|prepare|deliver)\b(?:\s+\w+){0,6}\s*$",
    re.IGNORECASE,
)
_PAGE_TARGET_OUTPUT_TRANSITION_BEFORE_RE = re.compile(
    r"\b(?:to|into|as)\s+(?:a|an|the)?\s*$",
    re.IGNORECASE,
)
_PAGE_TARGET_OUTPUT_NOUN_AFTER_RE = re.compile(
    r"^\s*(?:(?:technical|concise|detailed|short|long|final|pdf)\s+){0,6}"
    r"(?:pdf\s+)?(?:report|document|summary|brief|article|explainer|deliverable|output|write[- ]?up)\b",
    re.IGNORECASE,
)
_PAGE_TARGET_OUTPUT_NOUN_BEFORE_COUNT_RE = re.compile(
    r"\b(?:pdf\s+)?(?:report|document|summary|brief|article|explainer|deliverable|output|write[- ]?up)\b\s+"
    r"(?:(?:in|within|under|at|of|to|as|up\s+to|no\s+more\s+than)\s+(?:exactly\s+)?"
    r"|(?:should|must|needs?)\s+be\s+(?:exactly\s+)?"
    r"|(?:that|which)\s+is\s+(?:exactly\s+)?)$",
    re.IGNORECASE,
)
_PAGE_TARGET_SOURCE_NOUN_RE = re.compile(r"\b(?:report|document|source|memo|paper|file|article)\b", re.IGNORECASE)
# A page count glued to "PDF" ("10-page PDF") names an OUTPUT length only when the
# PDF is being created ("create a 2-page PDF"). When the same compound is
# introduced as an EXISTING document — by a demonstrative/possessive ("this
# 10-page PDF", "my 10-page PDF") or an explicit source word ("the attached
# 10-page PDF") — the count describes the SOURCE, not the requested length, so the
# after-PDF heuristic must NOT claim it. Bare "a"/"an"/"the" are intentionally NOT
# source markers (they front output requests). Codex P2 (2026-06-29): "summarize
# this 10-page PDF into a 2-page brief" wrongly targeted requested_pages=10.
_PAGE_SOURCE_CONTEXT_BEFORE_RE = re.compile(
    r"\b(?:this|that|these|those|my|our|your|its|their|"
    r"attached|uploaded|provided|given|existing|enclosed|original|source|input)\b"
    r"(?:\s+[\w-]+){0,3}\s*$",
    re.IGNORECASE,
)
_PAGE_SOURCE_ACTION_BEFORE_RE = re.compile(
    r"\b(?:use|read|review|summari[sz]e|convert|condense|shorten|extract|reference|consult)\s+"
    r"(?:this|that|these|those|my|our|your|its|their|the|attached|uploaded|provided|given|"
    r"existing|enclosed|original|source|input)\b"
    r"(?:(?!\s+(?:to|into|as)\b)\s+[\w-]+){0,4}\s*$",
    re.IGNORECASE,
)
_SLIDE_COUNT_RE = re.compile(r"(?<!\d)(\d+)\s*(?:-| )?\s*slides?\b", re.IGNORECASE)
_SLIDE_TARGET_OUTPUT_BEFORE_RE = re.compile(
    r"\b(?:presentation|deck|slides?|pptx|slideshow|deliverable|output)\b.{0,80}"
    r"\b(?:exactly|length|target|make|create|generate|produce|render|write|deliver|should|must|needs?)\b",
    re.IGNORECASE | re.DOTALL,
)
_SLIDE_TARGET_OUTPUT_VERB_BEFORE_RE = re.compile(
    r"\b(?:build|create|make|generate|produce|write|render|draft|prepare|deliver)\b(?:\s+\w+){0,6}\s*$",
    re.IGNORECASE,
)
_SLIDE_TARGET_OUTPUT_TRANSITION_BEFORE_RE = re.compile(
    r"\b(?:to|into|as)\s+(?:a|an|the)?\s*$",
    re.IGNORECASE,
)
_SLIDE_TARGET_OUTPUT_NOUN_AFTER_RE = re.compile(
    r"^\s*(?:(?:technical|concise|detailed|short|long|final|pptx)\s+){0,6}"
    r"(?:presentation|deck|slideshow|slides?|pptx)\b",
    re.IGNORECASE,
)
# A build verb (with an optional article) DIRECTLY before the count is enough
# context on its own — _SLIDE_COUNT_RE already requires the matched span to end
# in "slides", so a trailing presentation noun is redundant. Catches bare
# requests like "create 5 slides about X" / "make 6 slides" while still
# rejecting "create a report about the 5 slides" (words intervene before $).
_SLIDE_TARGET_BUILD_VERB_ADJACENT_RE = re.compile(
    r"\b(?:build|create|make|generate|produce|write|render|draft|prepare|deliver)\b"
    r"(?:\s+(?:a|an|the|me|us|some))?\s*$",
    re.IGNORECASE,
)
_MAX_SUPPORTED_PPTX_SLIDES = 30
_MAX_SUPPORTED_PDF_PAGES = 60
_REPORT_BODY_SECTION_COUNT_RE = re.compile(
    r"\b(\d+)\s+(?:(?:main|major|content)\s+){0,2}sections?\b",
    re.IGNORECASE,
)
_REPORT_VISUAL_LIST_RE = re.compile(
    r"\binclude(?:\s+throughout)?\s+(?:diagrams?\s+and\s+charts?|charts?\s+and\s+diagrams?|visuals?)\s*:\s*"
    r"(.+?)(?=\b(?:design|tone|audience|sources?|length)\s*:|$)",
    re.IGNORECASE | re.DOTALL,
)
_REPORT_VISUAL_NOUN_RE = re.compile(r"\b(?:diagram|chart|quadrant|table|figure|image)s?\b", re.IGNORECASE)


def _valid_page_count(value: str) -> int | None:
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    return min(count, _MAX_SUPPORTED_PDF_PAGES) if count >= 1 else None


def _page_target_is_output_context(text: str, match: re.Match[str]) -> bool:
    before = text[max(0, match.start() - 100) : match.start()]
    after = text[match.end() : match.end() + 100]
    source_context_before = bool(_PAGE_SOURCE_CONTEXT_BEFORE_RE.search(before) or _PAGE_SOURCE_ACTION_BEFORE_RE.search(before))
    after_pdf = _PAGE_TARGET_OUTPUT_AFTER_RE.search(after)
    after_targets_pdf = bool(after_pdf and len(re.findall(r"\w+", after[: after_pdf.start()])) <= 4 and not _PAGE_TARGET_SOURCE_NOUN_RE.search(after[: after_pdf.start()]) and not source_context_before)
    after_targets_output_noun = bool((_PAGE_TARGET_OUTPUT_VERB_BEFORE_RE.search(before) or _PAGE_TARGET_OUTPUT_TRANSITION_BEFORE_RE.search(before)) and _PAGE_TARGET_OUTPUT_NOUN_AFTER_RE.search(after))
    return bool(after_targets_pdf or after_targets_output_noun or _PAGE_TARGET_OUTPUT_NOUN_BEFORE_COUNT_RE.search(before) or _PAGE_TARGET_OUTPUT_BEFORE_RE.search(before) or _PAGE_TARGET_LENGTH_FIELD_BEFORE_RE.search(before))


def _page_range_target(combined: str) -> tuple[int, int] | None:
    for match in _PAGE_RANGE_RE.finditer(combined):
        if not _page_target_is_output_context(combined, match):
            continue
        low = _valid_page_count(match.group(1))
        high = _valid_page_count(match.group(2))
        if low is not None and high is not None:
            return tuple(sorted((low, high)))
    return None


def _page_count_target(combined: str) -> int | None:
    for match in _PAGE_COUNT_RE.finditer(combined):
        if not _page_target_is_output_context(combined, match):
            continue
        count = _valid_page_count(match.group(1))
        if count is not None:
            return count
    return None


def _valid_slide_count(value: str) -> int | None:
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    return min(count, _MAX_SUPPORTED_PPTX_SLIDES) if count >= 1 else None


def _slide_target_is_output_context(text: str, match: re.Match[str]) -> bool:
    before = text[max(0, match.start() - 100) : match.start()]
    after = text[match.end() : match.end() + 100]
    return bool(
        _SLIDE_TARGET_OUTPUT_BEFORE_RE.search(before)
        or _SLIDE_TARGET_BUILD_VERB_ADJACENT_RE.search(before)
        or ((_SLIDE_TARGET_OUTPUT_VERB_BEFORE_RE.search(before) or _SLIDE_TARGET_OUTPUT_TRANSITION_BEFORE_RE.search(before)) and _SLIDE_TARGET_OUTPUT_NOUN_AFTER_RE.search(after))
    )


def _slide_count_target(combined: str) -> int | None:
    for match in _SLIDE_COUNT_RE.finditer(combined):
        if not _slide_target_is_output_context(combined, match):
            continue
        count = _valid_slide_count(match.group(1))
        if count is not None:
            return count
    return None


def _pptx_slide_target_updates(
    delegation_context: dict[str, Any],
    *,
    companion_artifact: dict[str, Any],
) -> dict[str, Any]:
    text_parts: list[str] = []
    for source in (delegation_context, companion_artifact):
        for key in ("task", "description", "artifact_brief", "original_task"):
            value = source.get(key) if isinstance(source, dict) else None
            if isinstance(value, str) and value.strip():
                text_parts.append(value)
    combined = "\n".join(text_parts)
    if not combined:
        return {}
    if count := _slide_count_target(combined):
        return {"builder_pptx_requested_slide_count": count}
    return {}


def _pptx_slide_target_section(slide_updates: dict[str, Any]) -> str | None:
    count = slide_updates.get("builder_pptx_requested_slide_count")
    if not isinstance(count, int):
        return None
    return (
        "<pptx_slide_count_target>\n"
        f"- Requested PPTX length: exactly {count} total slides, including cover and summary.\n"
        "- Do not add a cover slide on top of this count; the number is the whole deck.\n"
        "- If your first plan has a different slide count, revise the plan once to this count before compiling.\n"
        "</pptx_slide_count_target>"
    )


def _pdf_page_target_updates(
    delegation_context: dict[str, Any],
    *,
    companion_artifact: dict[str, Any],
    artifact_target_path: object,
) -> dict[str, Any]:
    text_parts: list[str] = []
    for source in (delegation_context, companion_artifact):
        for key in ("task", "description", "artifact_brief", "original_task"):
            value = source.get(key) if isinstance(source, dict) else None
            if isinstance(value, str) and value.strip():
                text_parts.append(value)
    combined = "\n".join(text_parts)
    if not combined:
        return {}
    if page_range := _page_range_target(combined):
        lo, hi = page_range
        return {
            "builder_pdf_requested_min_pages": lo,
            "builder_pdf_requested_max_pages": hi,
        }
    if count := _page_count_target(combined):
        return {"builder_pdf_requested_page_count": count}
    return {}


def _report_visual_list_count(combined: str) -> int | None:
    match = _REPORT_VISUAL_LIST_RE.search(combined)
    if match is None:
        return None
    segment = match.group(1)
    numbered = [int(value) for value in re.findall(r"\((\d+)\)", segment)]
    if numbered:
        return max(numbered)
    count = 0
    for item in (part.strip() for part in segment.split(",")):
        if not item or not _REPORT_VISUAL_NOUN_RE.search(item):
            continue
        multiplier = 2 if " and " in item.lower() and re.search(r"\bdiagrams?\b", item, re.IGNORECASE) else 1
        count += multiplier
    return count or None


def _pdf_report_requirement_updates(
    delegation_context: dict[str, Any],
    *,
    companion_artifact: dict[str, Any],
    page_updates: dict[str, Any],
) -> dict[str, Any]:
    if str(delegation_context.get("task_type") or "").strip().lower() != "visual_report":
        return {}
    text_parts: list[str] = []
    for source in (delegation_context, companion_artifact):
        for key in ("task", "description", "artifact_brief", "original_task"):
            value = source.get(key) if isinstance(source, dict) else None
            if isinstance(value, str) and value.strip():
                text_parts.append(value)
    combined = "\n".join(text_parts)
    explicit = delegation_context.get("report_requirements")
    explicit_requirements = explicit if isinstance(explicit, dict) else {}

    section_match = _REPORT_BODY_SECTION_COUNT_RE.search(combined)
    body_count = explicit_requirements.get("required_body_section_count")
    if not isinstance(body_count, int) or body_count <= 0:
        body_count = int(section_match.group(1)) if section_match else 1
    visual_count = explicit_requirements.get("required_visual_count")
    if not isinstance(visual_count, int) or visual_count < 0:
        visual_count = _report_visual_list_count(combined)
    if visual_count is None:
        visual_count = 1 if any(marker in combined.lower() for marker in _VISUAL_REQUEST_MARKERS) else 0

    exact = page_updates.get("builder_pdf_requested_page_count")
    low = page_updates.get("builder_pdf_requested_min_pages")
    page_floor = exact if isinstance(exact, int) else low if isinstance(low, int) else 0
    explicit_min_words = explicit_requirements.get("required_min_word_count")
    required_min_words = max(
        explicit_min_words if isinstance(explicit_min_words, int) else 0,
        body_count * 120,
        page_floor * 75,
        300,
    )
    lower = combined.lower()
    return {
        "builder_pdf_required_body_section_count": body_count,
        "builder_pdf_required_visual_count": visual_count,
        "builder_pdf_required_min_word_count": required_min_words,
        "builder_pdf_cover_required": bool(explicit_requirements.get("cover_required", "title page" in lower or "cover" in lower)),
        "builder_pdf_toc_required": bool(explicit_requirements.get("toc_required", "table of contents" in lower)),
        "builder_pdf_conclusion_required": bool(explicit_requirements.get("conclusion_required", "conclusion" in lower)),
        "builder_pdf_references_required": bool(explicit_requirements.get("references_required", "references" in lower or "bibliography" in lower)),
        "builder_pdf_report_contract_version": "report_manifest_v1",
    }


def _pdf_page_target_section(page_updates: dict[str, Any]) -> str | None:
    count = page_updates.get("builder_pdf_requested_page_count")
    if isinstance(count, int):
        return (
            "<pdf_length_target>\n"
            f"- Requested PDF length: exactly {count} pages.\n"
            f"- When calling render_html_to_pdf, pass requested_pages={count}.\n"
            "- If layout_quality warns about page_count_off_target, revise once and re-render.\n"
            "</pdf_length_target>"
        )
    low = page_updates.get("builder_pdf_requested_min_pages")
    high = page_updates.get("builder_pdf_requested_max_pages")
    if isinstance(low, int) and isinstance(high, int):
        return (
            "<pdf_length_target>\n"
            f"- Requested PDF length: {low}-{high} pages.\n"
            "- When calling render_html_to_pdf, pass "
            f"requested_min_pages={low} and requested_max_pages={high}.\n"
            "- If layout_quality warns about page_count_off_target, revise once and re-render.\n"
            "</pdf_length_target>"
        )
    return None


def _pdf_report_contract_section(requirements: dict[str, Any]) -> str | None:
    if not requirements:
        return None
    return (
        "<pdf_report_contract>\n"
        "- This visual report uses report_manifest_v1. The HTML is not final merely because it has closing tags.\n"
        f"- Required body sections: at least {requirements.get('builder_pdf_required_body_section_count', 1)}.\n"
        f"- Required named figures/charts/tables: at least {requirements.get('builder_pdf_required_visual_count', 0)}.\n"
        f"- Minimum substantive source words: {requirements.get('builder_pdf_required_min_word_count', 300)}.\n"
        f"- Cover required: {str(bool(requirements.get('builder_pdf_cover_required'))).lower()}; "
        f"TOC required: {str(bool(requirements.get('builder_pdf_toc_required'))).lower()}; "
        f"conclusion required: {str(bool(requirements.get('builder_pdf_conclusion_required'))).lower()}; "
        f"references required: {str(bool(requirements.get('builder_pdf_references_required'))).lower()}.\n"
        "- Give every final section a stable lowercase id and data-report-role. Give every requested visual's containing <figure> a stable data-visual-id.\n"
        "- On the final render_html_to_pdf call, pass report_manifest with every section id/title/role and every requested visual id/title/kind. The manifest is checked against the HTML before Chromium runs.\n"
        "- Do not call render_html_to_pdf while todo items for report body sections or visuals remain incomplete. One targeted contract repair is allowed; a second semantic miss fails cleanly.\n"
        "</pdf_report_contract>"
    )


_IMAGE_OUTPUT_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_EXPLICIT_IMAGE_GENERATION_MARKERS = (
    "generated image",
    "generated images",
    "generate image",
    "generate an image",
    "generate images",
    "ai image",
    "ai-generated image",
    "ai-generated images",
    "illustration",
    "illustrations",
    "visual scene",
    "image-heavy",
    "raster image",
)

_VISUAL_REQUEST_MARKERS = (
    "chart",
    "charts",
    "diagram",
    "diagrams",
    "visual",
    "visuals",
    "visualization",
    "visualisation",
    "infographic",
    "flowchart",
    "timeline",
    "map",
    "matrix",
    "quadrant",
)

_POLISHED_DECK_IMAGE_MARKERS = (
    "polished visual",
    "visual storytelling",
    "visual treatment",
    "premium deck",
    "beautiful deck",
    "keynote style",
    "keynote-style",
    "cinematic",
    "hero image",
    "hero slide",
    "image-heavy",
    "full-bleed",
    "full bleed",
)

_IMAGE_GENERATION_OPTOUT_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bno[-\s]+(?:generated\s+|ai[-\s]+generated\s+)?(?:images?|imagery|visuals?|illustrations?)\b",
        r"\bwithout\s+(?:any\s+)?(?:generated\s+|ai[-\s]+generated\s+)?(?:images?|imagery|visuals?|illustrations?)\b",
        r"\b(?:avoid|exclude|skip)\s+(?:generated\s+|ai[-\s]+generated\s+)?(?:images?|imagery|visuals?|illustrations?)\b",
        r"\b(?:text[-\s]+only|non[-\s]+visual)\b",
    )
)


def _text_marker_present(text: str, marker: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(marker)}(?![a-z0-9])", text) is not None


def _image_generation_explicitly_opted_out(text: str) -> bool:
    return any(pattern.search(text or "") for pattern in _IMAGE_GENERATION_OPTOUT_PATTERNS)


def _image_generation_enabled(
    delegation_context: dict[str, Any],
    *,
    artifact_target_ext: str,
    task_type: str = "",
) -> bool:
    """Whether the image-generation skill is offered to the builder.

    Image targets and explicit requests keep legacy behavior. PPTX builds use
    gpt-image-2 full-slide assets as the primary slide path. PDF reports get a
    few conceptual/editorial illustrations on by default (cover/hero + key
    concepts) alongside the inline-``<svg>`` charts/diagrams the model draws in
    the report HTML; the per-build cap (``_IMAGE_GENERATION_MAX_CALLS_PDF``)
    bounds them. HTML chart/diagram work uses inline static ``<svg>`` (rendered
    to PDF via render_html_to_pdf) unless the user explicitly asks for imagery.
    """
    if artifact_target_ext in _IMAGE_OUTPUT_EXTENSIONS:
        return True
    task = str(delegation_context.get("task") or "").lower()
    description = str(delegation_context.get("description") or "").lower()
    combined = f"{task}\n{description}"
    if _image_generation_explicitly_opted_out(combined):
        return False
    if _is_pptx_image_generation_target(artifact_target_ext, task_type):
        return True
    if _is_pdf_image_generation_target(artifact_target_ext, task_type):
        return True
    if any(marker in combined for marker in _EXPLICIT_IMAGE_GENERATION_MARKERS):
        return True
    return False


_REPORT_IMAGE_GENERATION_TASK_TYPES = {
    "document",
    "report",
    "research",
    "research_report",
    "visual_report",
    "data_analysis",
    "pdf",
}
_PRESENTATION_TASK_TYPES = frozenset({"presentation", "slides", "slide_deck", "deck"})


def _is_presentation_task_type(task_type: str) -> bool:
    return str(task_type or "").strip().lower() in _PRESENTATION_TASK_TYPES


def _is_pptx_image_generation_target(artifact_target_ext: str, task_type: str) -> bool:
    if artifact_target_ext:
        return artifact_target_ext == ".pptx"
    return _is_presentation_task_type(task_type)


def _is_pdf_image_generation_target(artifact_target_ext: str, task_type: str) -> bool:
    """PDF reports get conceptual imagery on by default (bounded by the PDF cap)."""
    if artifact_target_ext:
        return artifact_target_ext == ".pdf" and not _is_presentation_task_type(task_type)
    return task_type in _REPORT_IMAGE_GENERATION_TASK_TYPES


def _visuals_requested(delegation_context: dict[str, Any]) -> bool:
    combined = "\n".join(str(delegation_context.get(key) or "").lower() for key in ("task", "description", "artifact_brief", "original_task"))
    return any(_text_marker_present(combined, marker) for marker in _VISUAL_REQUEST_MARKERS)


def _polished_deck_images_requested(delegation_context: dict[str, Any]) -> bool:
    task = str(delegation_context.get("task") or "").lower()
    description = str(delegation_context.get("description") or "").lower()
    combined = f"{task}\n{description}"
    return any(marker in combined for marker in _POLISHED_DECK_IMAGE_MARKERS)


def _critical_emit_guidance(artifact_target_ext: str, task_type: str = "") -> str:
    if artifact_target_ext == ".pdf" and _is_presentation_task_type(task_type):
        return "for this PDF slide-deck delivery target, emit the valid .pdf produced by render_html_to_pdf. Do NOT emit a PPTX, PPTX preview PDF, HTML source, or generator script as the requested PDF deliverable.\n"
    if artifact_target_ext == ".pdf":
        return (
            "for this PDF target, emit the valid .pdf if it exists. A .md/.html "
            "fallback is allowed only after render failure or unusable PDF quality, "
            "and it must be explicitly marked with requested_artifact_ext='pdf', "
            "artifact_is_fallback=true, and fallback_reason. Do NOT emit a "
            "generator .py as a PDF deliverable.\n"
        )
    return "if no user-facing deliverable exists, do NOT emit a generator script unless the user explicitly requested source code. Emit with artifact_path=null and an honest companion_summary instead.\n"


def _critical_pick_guidance(artifact_target_ext: str) -> str:
    if artifact_target_ext == ".pdf":
        return "first file marked 'deliverable'. If only generator files exist, do not emit them; emit with artifact_path=null and an honest companion_summary instead.\n"
    return "first file marked 'deliverable'. Do not choose generator scripts as user-facing artifacts. "


def _generator_listing_tag(
    *,
    artifact_target_ext: str,
    has_deliverable: bool,
    has_generator: bool,
) -> tuple[str, bool]:
    if artifact_target_ext == ".pdf":
        return "(generator script — do NOT emit for PDF; render and emit the real .pdf)", has_generator
    if not has_deliverable and has_generator:
        return "(generator script — do NOT emit unless the user explicitly asked for source code)", False
    return "(generator script)", has_generator


def _workflow_card(name: str) -> str | None:
    path = SKILLS_PATH / "builder_workflows" / f"{name}.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("BuilderTask: workflow card missing/unreadable name=%s path=%s", name, path)
        return None


def _visual_composition_directives() -> str | None:
    """Always-injected visual-director directives (Artifact Visual System
    Phase 5a). Supersedes the retired ``_image_enrichment_section``: decide
    the treatment per idea, vary, use the toolkit, read the per-type skill.
    """
    path = SKILLS_PATH / "visual_composition.md"
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("BuilderTask: visual_composition.md missing/unreadable path=%s", path)
        return None
    # Drop the YAML frontmatter (name/description) — the model only needs the body.
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            text = parts[2].strip()
    return text or None


def _deck_craft_directives() -> str | None:
    path = SKILLS_PATH / "deck_craft.md"
    try:
        primer = path.read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("BuilderTask: deck_craft.md missing/unreadable path=%s", path)
        return None
    if not primer:
        return None
    return (
        "<deck_skill_contract>\n"
        "This injected bundle is the authoritative compact deck-craft contract.\n"
        "Apply hands-on-deck hierarchy and compiler constraints, deck-impeccable spacing and polish, "
        "and deck-hallmark structural-variety critique directly from this bundle.\n"
        "The full skill references remain available for optional inspection; separate reads are not required.\n"
        "Use image-generation only through creative_plan.image_assets.\n"
        "Professional and technical are quality constraints, not styles.\n"
        "</deck_skill_contract>\n\n" + primer
    )


def _terminal_artifact_format_line(artifact_target_ext: str, task_type: str = "") -> str:
    """Return the format-specific terminal handoff line for the target ext.

    Keeps the per-extension branching out of
    ``_terminal_artifact_handoff_section`` so that function's cyclomatic
    complexity stays under the Sentrux CC>=16 gate. Research is NEVER
    disabled here — these lines only constrain the FINAL written file
    shape, not whether the builder may search/fetch/read sources first.
    """
    if artifact_target_ext in {".html", ".htm"}:
        return (
            "- This is an HTML target: write a STANDALONE .html file (a complete "
            "<!doctype html>/<html>...</html> document). Do NOT wrap the HTML in "
            "Markdown code fences (```html). Do NOT write a .md file and call it HTML. "
            'Call emit_builder_artifact with artifact_type="html" (or "webpage").\n'
        )
    if artifact_target_ext == ".md":
        return '- This is a Markdown target: write a real .md file. Call emit_builder_artifact with artifact_type="document".\n'
    if artifact_target_ext == ".pdf" and _is_presentation_task_type(task_type):
        return (
            "- This is a PDF slide-deck delivery target: author ONE self-contained "
            "HTML document with slide-like pages/sections and inline static SVG "
            "figures where needed, then render the real requested .pdf via "
            "render_html_to_pdf. Do NOT call prepare_deck_build, "
            "prepare_pptx_image_manifest, build_deck_from_slides, python-pptx, "
            "or pptxgenjs for this target; those routes produce PPTX artifacts or "
            "PPTX preview PDFs, not the requested primary PDF deliverable. Call "
            'emit_builder_artifact with artifact_type="pdf" and the real .pdf path.\n'
        )
    if artifact_target_ext == ".pdf":
        return (
            "- This is a PDF target: author ONE self-contained HTML file with inline "
            "<svg> charts/diagrams, then render the real .pdf via "
            "render_html_to_pdf. Call emit_builder_artifact with "
            'artifact_type="pdf". If rendering genuinely fails after the '
            "bounded repair, a .md/.html fallback must be explicitly marked "
            "with requested_artifact_ext, artifact_is_fallback=true, and "
            "fallback_reason; otherwise emit with artifact_path=null and an "
            "honest companion_summary.\n"
        )
    return ""


def _pptx_visual_guidance(*, deck_service_enabled: bool, image_generation_enabled: bool) -> str:
    if not image_generation_enabled:
        return "Image generation is not listed for this non-PPTX run. Use the medium-specific local figure workflow."
    if deck_service_enabled:
        return (
            "Decks are built by prepare_deck_build using the injected compact deck-craft contract. "
            "Submit authoring_contract='compact_model_html_v2', a concise complete creative_plan, one shared "
            "deck_stylesheet, and slide entries with title, narrative, "
            "role, layout_kind, speaker_notes, html_body, and exactly two repair_anchor_ids; "
            "omit slide_css or pass an empty string for every "
            "slide so the later authenticated repair overlay retains its full 1 KiB channel. Every narrative "
            "must be <= 280 characters. Reuse shared classes, keep each html_body compact, put all fresh-deck CSS "
            "in deck_stylesheet, and emit no prose outside the prepare call. Each repair anchor's data-deck-id must "
            "be unique within its slide, its data-deck-role must be nonempty, and data-deck-required must equal true. "
            "The harness owns HTML sanitization, planned generated assets, native PowerPoint compilation, inspection, "
            "validation, and terminal failure. Screenshot-backed PPTX is not an acceptable fallback; if native "
            "deck generation fails, prepare_deck_build returns failure and you emit artifact_path=null. "
            "If prepare_deck_build returns retryable=true, repair the exact creative/html/mechanical field and retry once. "
            "Do NOT call prepare_pptx_image_manifest, image-generation/scripts/generate.py, "
            "build_deck_from_slides, python-pptx, or pptxgenjs directly. Normal decks may use "
            "optional generated assets as the creative_plan declares; a full-bleed picture may be an asset "
            "inside a native deck but is not itself a complete slide. Only an explicitly plain text-only/no-visual "
            "request should set visual_policy='text_only'. Derive the visual direction from the subject, "
            "audience, goal, viewing context, and subject materials. Inline SVG is unsupported."
        )
    return "Fresh native PPTX generation is unavailable in this run. Stop cleanly with artifact_path=null; do not invoke lower-level manifest, image, HTML-slide, shell, or custom compiler workflows."


def _terminal_artifact_handoff_section(
    artifact_target_path: str,
    artifact_target_ext: str,
    task_type: str = "",
) -> str:
    """Build the ``<terminal_artifact_handoff>`` block.

    Emitted only when the task carries an explicit
    ``artifact_target_path`` under ``/mnt/user-data/outputs/``. Forces the
    write -> verify -> emit terminal contract for explicit artifact tasks
    so the builder can never finish with research/planning/summary text
    alone. Research itself is always permitted — this block only states
    that research is not, by itself, a deliverable.
    """
    safe_target = html.escape(artifact_target_path, quote=True)
    return (
        "<terminal_artifact_handoff>\n"
        "This task has an explicit artifact target. It is a DELIVERABLE task, not a "
        "research/answer task.\n"
        "- You MAY research first (builder_web_search / builder_web_fetch / read sources). "
        "Research is encouraged when the deliverable needs facts.\n"
        "- Research, planning, todos, and written summaries are NOT the deliverable. They "
        "do not complete this task on their own.\n"
        f"- This task is INCOMPLETE until the target file `{safe_target}` is actually written "
        "under /mnt/user-data/outputs/ AND you have called emit_builder_artifact for it.\n"
        "- Required terminal sequence after any research/planning: (1) write the requested "
        f"artifact file to `{safe_target}`; (2) verify the file exists (e.g. ls_tool); "
        "(3) call emit_builder_artifact exactly once with the real artifact_path.\n"
        "- Your FINAL action MUST be emit_builder_artifact, never a plain-text response. A "
        "plain-text ending with no emit is treated as a failed build with no deliverable.\n"
        f"- Use the exact target path `{safe_target}` for artifact_path unless you have "
        "written exactly one stronger verified deliverable candidate under "
        "/mnt/user-data/outputs/.\n" + _terminal_artifact_format_line(artifact_target_ext, task_type) + "- If you genuinely cannot create the artifact, do NOT pretend success and do NOT "
        "end with plain text: emit_builder_artifact with a specific, safe fallback_reason "
        "(or accept the force-stop fallback) so the failure is reported honestly.\n"
        "</terminal_artifact_handoff>"
    )


def _builder_workflow_sections(
    *,
    task_type: str,
    allow_web_research: bool,
) -> list[str]:
    # Artifact Visual System Phase 5b: composition guidance now lives in the
    # always-injected visual_composition.md directives + the per-type skills
    # (ppt-generation/pdf-report/hallmark). Only the orthogonal web-research
    # card is still emitted here — its emit/fallback + HTML-delivery contract
    # is carried by _critical_emit_guidance / _terminal_artifact_format_line.
    cards: list[str] = []
    if allow_web_research:
        cards.append("research")

    sections: list[str] = []
    for name in dict.fromkeys(cards):
        content = _workflow_card(name)
        if content:
            sections.append(f'<builder_workflow_card name="{name}" task_type="{html.escape(task_type, quote=True)}">\n{content}\n</builder_workflow_card>')
    return sections


class BuilderTaskState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[Annotated[int, _merge_builder_non_artifact_turns]]
    builder_last_tool_names: NotRequired[list[str]]
    builder_artifact_target_path: NotRequired[str]
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
    builder_pptx_requested_slide_count: NotRequired[int]
    # Spec D D-4: read_session_context's self-enforced call counter — the
    # tool's Command update persists only because the key is declared here.
    builder_session_context_reads: NotRequired[int]
    # Spec D D-3/D-5: extracted brief schema + the gate's missing fields,
    # written by this middleware's briefing pass, read at emit acceptance.
    brief_schema: NotRequired[dict | None]
    brief_gate_missing_fields: NotRequired[list[str]]
    # NOTE: builder_search_sources is NOT redeclared here. SophiaState already
    # declares it with the `_merge_search_sources` reducer; redeclaring it as
    # plain `NotRequired[list[dict]]` would shadow that reducer via
    # langchain.agents.create_agent's set-based schema merge, downgrade the
    # channel to LastValue, and crash parallel `builder_web_search` /
    # `builder_web_fetch` writes. The
    # `tests/test_sophia_state_schema_invariants.py` guard locks this.
    allow_web_research: NotRequired[bool]
    builder_run_id: NotRequired[str]


class BuilderTaskMiddleware(AgentMiddleware[BuilderTaskState]):
    """Inject builder briefing derived from companion delegation context.

    Reads ``delegation_context`` from state and appends a
    ``<builder_briefing>`` block to ``system_prompt_blocks``. When no
    ``delegation_context`` is present the middleware no-ops — the legacy
    Builder-as-Main synthesis branch was deleted in Phase 4C of the v3
    migration. Builder is always-a-subagent now.

    The ``vision_enabled`` constructor arg lets the builder agent
    factory (``builder_agent._create_builder_agent``) pass through
    the same ``supports_vision(resolved_model)`` decision that
    governs whether ``view_image_tool`` is in the tool list. The
    uploaded-images briefing block branches on this flag so we
    never tell the model to call a tool it doesn't have.
    """

    state_schema = BuilderTaskState

    def __init__(self, *, vision_enabled: bool = False) -> None:
        super().__init__()
        self._vision_enabled = vision_enabled

    @override
    def before_agent(self, state: BuilderTaskState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()

        delegation_context: dict[str, Any] = state.get("delegation_context") or {}

        if not delegation_context:
            log_middleware("BuilderTask", "no delegation_context", _t0)
            return None

        # ``or {}`` handles the Builder-as-Main synthesised path where
        # ``companion_artifact`` is explicitly None (no companion to source it
        # from). Spec Appendix B shows the canonical synthesised shape.
        companion_artifact: dict[str, Any] = delegation_context.get("companion_artifact") or {}
        task_type: str = delegation_context.get("task_type", "unknown")
        task_brief = str(delegation_context.get("task") or delegation_context.get("task_brief") or "")
        relevant_memories: list[str] = filter_builder_memory_snippets(
            delegation_context.get("relevant_memories") or [],
            query=task_brief,
            task_type=task_type,
            limit=5,
        )
        active_ritual: str | None = delegation_context.get("active_ritual")
        ritual_phase: str | None = delegation_context.get("ritual_phase")
        state_research_policy = state.get("allow_web_research")
        delegated_research_policy = delegation_context.get("allow_web_research")
        if isinstance(state_research_policy, bool):
            allow_web_research = state_research_policy
        elif isinstance(delegated_research_policy, bool):
            allow_web_research = delegated_research_policy
        else:
            allow_web_research = True
        artifact_target_path = state.get("builder_artifact_target_path") or delegation_context.get("artifact_target_path")
        artifact_target_ext = _artifact_target_extension(artifact_target_path)
        page_target_updates: dict[str, Any] = {}
        report_requirement_updates: dict[str, Any] = {}
        slide_target_updates: dict[str, Any] = {}
        if artifact_target_ext == ".pdf":
            for key in (
                "builder_pdf_requested_page_count",
                "builder_pdf_requested_min_pages",
                "builder_pdf_requested_max_pages",
            ):
                value = state.get(key)
                if isinstance(value, int):
                    page_target_updates[key] = value
            if not page_target_updates:
                page_target_updates = _pdf_page_target_updates(
                    delegation_context,
                    companion_artifact=companion_artifact,
                    artifact_target_path=artifact_target_path,
                )
            report_requirement_updates = _pdf_report_requirement_updates(
                delegation_context,
                companion_artifact=companion_artifact,
                page_updates=page_target_updates,
            )
        is_presentation_task = _is_presentation_task_type(task_type)
        is_pdf_presentation_target = artifact_target_ext == ".pdf" and is_presentation_task
        if artifact_target_ext == ".pptx" or is_pdf_presentation_target or (not artifact_target_ext and is_presentation_task):
            value = state.get("builder_pptx_requested_slide_count")
            if isinstance(value, int):
                slide_target_updates["builder_pptx_requested_slide_count"] = value
            if not slide_target_updates:
                slide_target_updates = _pptx_slide_target_updates(
                    delegation_context,
                    companion_artifact=companion_artifact,
                )
        tracked_sources = [source for source in (state.get("builder_search_sources") or []) if isinstance(source, dict)]
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        recent_tool_names = [str(name).strip() for name in (state.get("builder_last_tool_names") or []) if str(name).strip()]

        # Wall-clock budget awareness — sourced from extra_configurable which
        # SubagentExecutor merges into initial state (see executor.py:835).
        # ``builder_task_kickoff_ms`` is the queue-time fallback for the very
        # first turn before BuilderArtifactMiddleware has had a chance to
        # write ``builder_task_started_at_ms``. Both keys are missing for
        # non-builder agents that don't opt in, in which case the wall-clock
        # prompt fragment is suppressed and behavior is identical to today.
        builder_timeout_seconds = 0
        raw_timeout = state.get("builder_timeout_seconds")
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            builder_timeout_seconds = int(raw_timeout)
        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        wall_clock_pct: int | None = None
        wall_clock_elapsed_s: int | None = None
        if builder_timeout_seconds > 0 and isinstance(started_ms, (int, float)) and started_ms > 0:
            elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
            wall_clock_elapsed_s = int(elapsed_ms / 1000)
            wall_clock_pct = int(round(elapsed_ms / (builder_timeout_seconds * 1000) * 100))

        # --- Build briefing sections ---
        sections: list[str] = []

        # Tone guidance
        tone_estimate: float = companion_artifact.get("tone_estimate", 2.5)
        active_tone_band: str = companion_artifact.get("active_tone_band", "engagement")
        tone_section = self._tone_guidance(tone_estimate, active_tone_band)
        sections.append(f"<tone_guidance>\n{tone_section}\n</tone_guidance>")

        # Ritual guidance (validate + escape to prevent prompt injection via crafted values)
        _VALID_RITUALS = {"prepare", "debrief", "vent", "reset"}
        if active_ritual and active_ritual in _VALID_RITUALS:
            ritual_section = self._ritual_guidance(active_ritual, ritual_phase)
            safe_phase = html.escape(str(ritual_phase or "none"), quote=True)
            if ritual_section:
                sections.append(f'<ritual_guidance ritual="{active_ritual}" phase="{safe_phase}">\n{ritual_section}\n</ritual_guidance>')

        # Session context from companion artifact
        session_fields = {
            "session_goal": companion_artifact.get("session_goal"),
            "active_goal": companion_artifact.get("active_goal"),
            "takeaway": companion_artifact.get("takeaway"),
            "reflection": companion_artifact.get("reflection"),
        }
        context_lines = [f"- {k}: {v}" for k, v in session_fields.items() if v]
        if context_lines:
            sections.append("<session_context>\n" + "\n".join(context_lines) + "\n</session_context>")

        # Relevant memories (max 5)
        if relevant_memories:
            capped = relevant_memories[:5]
            memory_lines = [f"- {m}" for m in capped]
            sections.append("<memories>\n" + "\n".join(memory_lines) + "\n</memories>")

        # Spec D (delegation boundary): D-4 recall line, D-3 extracted brief
        # schema, D-5 completeness-gate directive. All flag-gated and
        # degrade to no-ops when the parent ledger is unavailable.
        boundary_sections, boundary_state_updates = _delegation_boundary_sections(
            delegation_context,
            task_type,
            existing_schema=state.get("brief_schema"),
        )
        sections.extend(boundary_sections)

        # Task type
        sections.append(f"<task_type>{task_type}</task_type>")

        sections.extend(
            _uploaded_images_sections(
                delegation_context.get("uploaded_image_paths"),
                vision_enabled=self._vision_enabled,
            )
        )

        sections.append(
            "<output_contract>\n"
            "- Write every user-facing deliverable and supporting file under /mnt/user-data/outputs/ using absolute paths.\n"
            "- Do NOT use relative paths like outputs/report.md or ./outputs/report.md.\n"
            "- When you call emit_builder_artifact, artifact_path and any artifact_files/supporting_files must use the "
            "same /mnt/user-data/outputs/... absolute paths. Mark only the requested deliverable as artifact_files "
            "role=primary; use source/internal for markdown or scripts and preview for render-only previews.\n"
            "</output_contract>"
        )
        if isinstance(artifact_target_path, str) and artifact_target_path.startswith("/mnt/user-data/outputs/"):
            sections.append(
                "<artifact_target>\n"
                f"- Canonical target path for this build: `{html.escape(artifact_target_path, quote=True)}`.\n"
                "- The target file extension is authoritative for the final output format. If this path ends in .html, deliver an HTML file even if the task type is visual_report.\n"
                "- Reuse this path across update/resume runs unless you have already written exactly one stronger deliverable candidate under /mnt/user-data/outputs/.\n"
                "- emit_builder_artifact.artifact_path should point to this target or that single verified candidate, never to an unwritten placeholder.\n"
                "</artifact_target>"
            )
            # Explicit-artifact tasks get a hard terminal contract: research is
            # allowed but is never the deliverable, the target file must be
            # written + verified, and the final action MUST be
            # emit_builder_artifact (never a plain-text ending). This is the
            # prompt-side fix for builds that "completed without a deliverable".
            sections.append(
                _terminal_artifact_handoff_section(
                    artifact_target_path,
                    artifact_target_ext,
                    task_type,
                )
            )

        if page_target_section := _pdf_page_target_section(page_target_updates):
            sections.append(page_target_section)
        if report_contract_section := _pdf_report_contract_section(report_requirement_updates):
            sections.append(report_contract_section)
        if slide_target_section := _pptx_slide_target_section(slide_target_updates):
            sections.append(slide_target_section)

        edit_context = delegation_context.get("edit_context")
        if isinstance(edit_context, dict) and edit_context.get("mode") == "edit_existing_artifact":
            materialized_source = edit_context.get("materialized_source_path")
            source_artifact = edit_context.get("source_artifact_path")
            revision_target = edit_context.get("revision_artifact_path") or artifact_target_path
            sections.append(
                "<edit_existing_artifact>\n"
                f"- Source artifact path: `{html.escape(str(source_artifact or ''), quote=True)}`.\n"
                f"- Materialized source inside this sandbox: `{html.escape(str(materialized_source or ''), quote=True)}`.\n"
                f"- Revised artifact target: `{html.escape(str(revision_target or ''), quote=True)}`.\n"
                "- Read the materialized source before writing. Preserve unrelated content and make only the requested edit unless the user asked for a broad rewrite.\n"
                "- Pure local edits do not require web research. If the edit introduces new URLs or new factual scope, search/fetch that new material before editing.\n"
                "- Emit the revised artifact, not the source artifact.\n"
                "</edit_existing_artifact>"
            )

        edit_context = delegation_context.get("edit_context")
        if isinstance(edit_context, dict) and edit_context.get("mode") == "edit_existing_artifact":
            materialized_source = edit_context.get("materialized_source_path")
            source_artifact = edit_context.get("source_artifact_path")
            revision_target = edit_context.get("revision_artifact_path") or artifact_target_path
            sections.append(
                "<edit_existing_artifact>\n"
                f"- Source artifact path: `{html.escape(str(source_artifact or ''), quote=True)}`.\n"
                f"- Materialized source inside this sandbox: `{html.escape(str(materialized_source or ''), quote=True)}`.\n"
                f"- Revised artifact target: `{html.escape(str(revision_target or ''), quote=True)}`.\n"
                "- Read the materialized source before writing. Preserve unrelated content and make only the requested edit unless the user asked for a broad rewrite.\n"
                "- Pure local edits do not require web research. If the edit introduces new URLs or new factual scope, search/fetch that new material before editing.\n"
                "- Emit the revised artifact, not the source artifact.\n"
                "</edit_existing_artifact>"
            )

        # PR Phase B (2026-04-29): inject the skills inventory so the
        # builder knows the pre-tested generation workflows
        # (ppt-generation, image-generation, data-analysis) are available.
        # Without this block the model
        # falls back to writing its own matplotlib/reportlab code, which
        # is the failure pattern PR #93/#94 spent recovery machinery on.
        image_generation_enabled = _image_generation_enabled(
            delegation_context,
            artifact_target_ext=artifact_target_ext,
            task_type=task_type,
        )
        deck_service_enabled = deck_route_for_task(task_type, artifact_target_ext) == "deck_build_service"
        is_html_target = artifact_target_ext in {".html", ".htm"}
        skills_block = self._build_skills_inventory_block(
            include_image_generation=image_generation_enabled or (deck_service_enabled and artifact_target_ext == ".pptx"),
            # hallmark + visual-design surface when visuals are requested OR
            # the target is HTML (Phase 4c: hallmark is the HTML design system).
            include_visual_design=_visuals_requested(delegation_context) or is_html_target,
            presentation_design_mode=deck_service_enabled and artifact_target_ext == ".pptx",
            include_pdf_report=artifact_target_ext == ".pdf",
            include_research_skills=(artifact_target_ext == ".pdf" and not is_pdf_presentation_target) or task_type in {"research", "document", "visual_report"},
        )
        # Artifact Visual System Phase 5a: the always-injected visual director
        # frames every downstream block, so it goes BEFORE the skills inventory.
        # It supersedes the retired _image_enrichment_section (image generation
        # is still gated/capped by _image_generation_enabled; only the prose
        # guidance moved into these directives).
        directives = _visual_composition_directives()
        if directives:
            sections.append("<visual_composition>\n" + directives + "\n</visual_composition>")
        if deck_service_enabled and artifact_target_ext == ".pptx":
            deck_craft = _deck_craft_directives()
            if deck_craft:
                sections.append("<deck_craft>\n" + deck_craft + "\n</deck_craft>")
        if skills_block:
            sections.append(skills_block)

        workflow_sections = _builder_workflow_sections(
            task_type=task_type,
            allow_web_research=allow_web_research,
        )
        if workflow_sections:
            sections.append("<builder_target_workflows>\n" + "\n\n".join(workflow_sections) + "\n</builder_target_workflows>")

        pptx_library_guidance = (
            "For PPTX, submit creative_plan, deck_stylesheet, slide html_body, and exactly two repair_anchor_ids per "
            "slide through prepare_deck_build; NEVER write custom python-pptx/pptxgenjs scripts or lower-level "
            "compiler files yourself."
            if deck_service_enabled
            else "For PPTX, this is an explicit non-production legacy/debug route; use the exposed ppt-generation workflow tools prepare_pptx_image_manifest and build_deck_from_slides; NEVER write custom python-pptx/pptxgenjs scripts."
        )
        sections.append(
            "<preinstalled_libraries>\n"
            "The sandbox already has these Python libraries installed for inspection, validation, and "
            "supporting work. Import them directly only when the workflow card allows it — do NOT run pip install:\n"
            "- PDF: reportlab, fpdf2 (fpdf), pypdf\n"
            "- Office: python-pptx (pptx), python-docx (docx), openpyxl\n"
            "- Images: pillow (PIL)\n"
            "- Charts / data: matplotlib, seaborn, numpy, pandas, duckdb\n"
            "- Other: markdown, requests, httpx\n"
            "If you ever see ModuleNotFoundError for one of these, the import path is wrong — check the module name above. "
            "Never call `pip install` via bash_tool; it wastes your turn budget.\n"
            "Important: these libraries do NOT replace target workflow cards. For PDF, author "
            "HTML with inline <svg> and render via render_html_to_pdf instead of reportlab/fpdf "
            f"scripts. {pptx_library_guidance}\n"
            "</preinstalled_libraries>"
        )

        if tracked_sources:
            source_lines = [f"- {source.get('title', source.get('url', 'Untitled'))} — {source.get('url', '')}" for source in tracked_sources[:8]]
            sections.append("<tracked_sources>\n" + "\n".join(source_lines) + "\n</tracked_sources>")

        # Completion instruction — always present, includes budget so the model
        # plans from turn 0 instead of discovering the limit mid-loop.
        # Sourced from the per-run builder_budget tier so prompt math matches
        # the middleware's force-emit threshold for simple and complex builds.
        _HARD_CEILING = max_non_artifact_turns(state)
        remaining = max(_HARD_CEILING - non_artifact_turns, 0)
        wall_clock_force_fraction = force_emit_wall_clock_fraction(state)
        wall_clock_force_pct = int(round(wall_clock_force_fraction * 100))

        wall_clock_line = ""
        if wall_clock_pct is not None and wall_clock_elapsed_s is not None:
            wall_clock_line = (
                f"Wall-clock budget: {wall_clock_elapsed_s}s of {builder_timeout_seconds}s used "
                f"({wall_clock_pct}%). Once you cross {wall_clock_force_pct}% of the wall-clock budget, your NEXT action "
                "MUST be emit_builder_artifact regardless of remaining turn count. Each long write "
                "costs 90+ seconds of LLM output, so re-writing the same file twice burns the budget.\n"
            )
        pptx_visual_guidance = _pptx_visual_guidance(
            deck_service_enabled=deck_service_enabled,
            image_generation_enabled=image_generation_enabled,
        )
        pptx_delivery_line = (
            "For fresh decks, call prepare_deck_build once with authoring_contract='compact_model_html_v2', the "
            "concise complete creative_plan, shared deck_stylesheet, slide html_body list, and exactly two "
            "repair_anchor_ids per slide "
            "(or one repair retry when retryable=true); "
            "emit the returned native PPTX or a clean null-artifact failure if native generation "
            "fails. Screenshot-backed PPTX is not an acceptable fallback. Never write lower-level "
            "deck files/tools yourself."
            if deck_service_enabled
            else "For fresh decks in this explicit non-production legacy/debug route, use the exposed ppt-generation workflow tools: prepare slide "
            "visuals with prepare_pptx_image_manifest, build the slide HTML, then compile with "
            "build_deck_from_slides. Never write custom python-pptx/pptxgenjs code."
        )

        sections.append(
            "<completion_instruction>\n"
            f"You have a STRICT budget of {_HARD_CEILING} tool-call turns total. "
            f"Currently on turn {non_artifact_turns}/{_HARD_CEILING} ({remaining} remaining).\n"
            f"{wall_clock_line}"
            "BEFORE planning, check <skill_system> above. If a listed skill matches "
            "the deliverable type (e.g. pdf-report for PDF reports, "
            "deep-research / academic-paper-review / systematic-literature-review for research-backed reports, "
            "ppt-generation for slide decks, "
            "image-generation when listed for image deliverables, explicit generated imagery, or PPTX slide visual assets, "
            "data-analysis for tabular data), USE IT — read its SKILL.md "
            "via read_file_tool and follow its workflow. Workflow cards are authoritative "
            "for PDF, PPTX, HTML, and research tasks. Do not replace them with ad hoc "
            "matplotlib/reportlab/python-pptx generator code; that is the fragile path "
            "PR #93/#94 spent recovery machinery on.\n"
            "Plan your work to fit within this budget:\n"
            "- Turn 1: call write_todos with a short plan (3–5 steps) so the UI can track progress.\n"
            "- For text deliverables (markdown, html, plain text, code): use the exposed `write_file` tool "
            "with `description`, `path`, and `content` to author the file. PREFERRED path is ONE "
            "`write_file(description='write final document', path='/mnt/user-data/outputs/name.ext', "
            "content='...', append=False)` call with the complete document. "
            "For LONG documents that won't fit in a single model output (>~5000 words): use `write_file` "
            "MULTIPLE times to the SAME path — the FIRST call writes the opening chunk (omit append or pass "
            "append=False), then SUBSEQUENT calls extend the file with append=True. Each chunk costs ~one turn; "
            "building a 12k-word document in 2-3 chunked `write_file(..., append=True)` calls is the correct "
            "pattern. **HTML deliverables chunk BY DEFAULT**: a complete styled page rarely fits one output — "
            "first call doctype+<head>+styles, then append body sections (~200-300 lines per call), then the "
            "closing tags. A truncated single-call write fails with missing tool arguments and wastes turns. "
            "Use str_replace_tool for targeted edits to existing content.\n"
            "NEVER use bash_tool to author text file content. The following bash patterns are FORBIDDEN as "
            "substitutes for write_file:\n"
            "    * cat > file.md << 'EOF' ... EOF  (heredoc redirect)\n"
            "    * python -c \"with open('/path', 'w') as f: f.write('...')\"\n"
            "    * python - << 'PYEOF' ... PYEOF\n"
            "    * echo '...' > file.md  /  printf '...' > file.md\n"
            "bash_tool is for EXECUTION (running generator scripts that produce binaries, ls/cat for "
            "verification, pip-free shell commands), NOT for authoring text. If you find yourself reaching "
            "for bash to write file content, STOP and use `write_file(..., append=True)` instead. The "
            "bash-heredoc path leads to truncation, encoding bugs, and a turn-budget-burning loop where "
            "each turn regenerates the entire document.\n"
            "- For binary deliverables (pdf, pptx, docx, xlsx, png, charts): the DELIVERABLE IS THE BINARY. "
            "**Use skills and tools that wrap pre-tested generators — do NOT write your own matplotlib / "
            "reportlab / python-pptx code.** Follow the matching <builder_workflow_card> above when one is "
            "present. If no workflow card covers the requested format, use the closest listed skill first.\n"
            "    * **PDF**: follow the PDF workflow card. For presentation PDFs, make that HTML a slide-deck "
            "document with one page/section per slide; for report PDFs, make it a report. Author ONE self-contained HTML file with inline "
            "`<svg>` figures, then call `render_html_to_pdf`. A valid render is terminal-ready; emit immediately "
            "unless Sophia asks for one layout repair. Draw ALL figures — data charts AND structural diagrams — "
            "as inline static `<svg>` (bar/line/column for quantitative data; box-and-arrow flow / comparison / "
            "mind-map for structure); NO remote `generate_chart`, NO client-side JS. Vary the figure family to "
            "fit each figure's content; never route every figure to the same kind.\n"
            f"    * **PPTX presentation**: follow the ppt-generation skill. {pptx_delivery_line} "
            f"{pptx_visual_guidance}\n"
            "    * **HTML**: follow the HTML workflow card. Standalone browser-renderable HTML is a text "
            "deliverable, not a frontend app unless the user requested app behavior.\n"
            "    * **Standalone chart / image**: use the image-generation skill, or author the chart as a "
            "standalone inline-`<svg>` HTML file. The generated PNG/SVG is the deliverable.\n"
            "    * **Data analysis / spreadsheet**: use the data-analysis skill (DuckDB-based) for SQL over "
            "tabular data. Output CSV/JSON/Markdown directly.\n"
            "    * **xlsx / docx / other formats not covered by a skill**: as a LAST RESORT, write a short "
            "generator script to /mnt/user-data/outputs/_generate_<name>.py and bash-run it. This path is "
            "fragile. Prefer a skill if at all possible. If you must use a generator script: keep it under "
            "120 lines, run it with bash_tool, verify the real requested output with ls_tool, and at most "
            "2 fix-and-retry cycles. Never ship the generator script as the artifact unless the user "
            "explicitly asked for code; emit with artifact_path=null and an honest companion_summary instead.\n"
            "    Libraries listed in <preinstalled_libraries> are already available — do NOT pip install.\n"
            "- After each meaningful step (write_file, successful skill invocation, render_html_to_pdf), "
            "call write_todos again to mark the corresponding item 'completed' or 'in-progress'. This is how "
            "the user sees the progress bar advance — skipping these updates leaves the UI stuck.\n"
            "- Make targeted edits only if critical fixes are needed.\n"
            "- Final turn: Call ONLY emit_builder_artifact pointing artifact_path at the FINAL DELIVERABLE "
            "(the .pdf, .pptx, .png, .md, etc. — never a generator .py unless the user explicitly "
            "asked for source code). Do NOT pair emit_builder_artifact with any other tool call on the same turn — not "
            "write_todos, not bash, not write_file, not anything. The artifact card surfaces the file to "
            "the user automatically once emit_builder_artifact is captured; you do not need to flag the "
            "file separately. emit_builder_artifact alone is MANDATORY — without it your work is lost.\n"
            "Do NOT iterate endlessly to perfect the output. Ship a complete first draft, then finalize.\n"
            "</completion_instruction>"
        )

        if non_artifact_turns > 0:
            joined_tools = ", ".join(recent_tool_names) if recent_tool_names else "unknown"
            escalation = f"<builder_endgame>\nTurn budget: {non_artifact_turns}/{_HARD_CEILING} used. {remaining} turn(s) remaining before forced termination.\nMost recent tool calls: {joined_tools}.\n"
            if wall_clock_pct is not None and wall_clock_elapsed_s is not None:
                escalation += f"Wall-clock: {wall_clock_elapsed_s}s of {builder_timeout_seconds}s used ({wall_clock_pct}%).\n"
            # PR-A (2026-04-27): thresholds rescaled for the bumped ceiling
            # (10 → 20). Same proportions as before — CRITICAL at the last
            # ~15% of the budget (remaining<=3), WARNING at the last ~30%
            # (remaining<=6) so the model gets graduated wrap-up pressure.
            #
            # Wall-clock-aware promotion: when the per-run wall-clock budget
            # has crossed the configured force fraction, escalate to CRITICAL
            # even if turn-count remaining is still high.
            wall_clock_critical = wall_clock_pct is not None and wall_clock_pct >= wall_clock_force_pct
            if remaining <= 3 or wall_clock_critical:
                escalation += (
                    "CRITICAL: You are about to be terminated. "
                    "Your NEXT action MUST be emit_builder_artifact — DO NOT call write_todos, "
                    "write_file, bash_tool, or any other tool on this turn. "
                    "Ship what you have NOW, even if partial. "
                    "Use artifact_path pointing to the best file that exists on disk; "
                    + _critical_emit_guidance(artifact_target_ext, task_type)
                    + "Do NOT emit with artifact_path=null. If you cannot decide, pick the "
                    + _critical_pick_guidance(artifact_target_ext)
                    + "from the list below.\n"
                )
                # PR #94: enumerate actual files in outputs/ so the model
                # can pick a real path under tool_choice pressure instead
                # of emitting artifact_path=null. Run ``675c2c35`` (PDF +
                # diagrams) ended in a GraphRecursionError because the
                # model emitted None repeatedly under forced emit; giving
                # it a concrete file list eliminates that guessing step.
                outputs_listing = _list_outputs_for_prompt(state)
                if outputs_listing:
                    now_s = time.time()
                    file_lines: list[str] = []
                    has_deliverable = any(item["category"] == "deliverable" for item in outputs_listing)
                    has_generator = any(item["category"] == "generator" for item in outputs_listing)
                    for item in outputs_listing:
                        size_str = _format_size(item["size_bytes"])
                        age_str = _format_age(now_s, item["mtime"])
                        if item["category"] == "deliverable":
                            tag = "← preferred (final deliverable)"
                            if has_deliverable:
                                # Mark only the most recent deliverable as preferred.
                                # After we tag the first one, downgrade the rest.
                                has_deliverable = False
                            else:
                                tag = "(another deliverable)"
                        elif item["category"] == "generator":
                            tag, has_generator = _generator_listing_tag(
                                artifact_target_ext=artifact_target_ext,
                                has_deliverable=has_deliverable,
                                has_generator=has_generator,
                            )
                        else:
                            tag = "(intermediate — do NOT emit as final)"
                        file_lines.append(f"  - {item['path']}  ({size_str}, modified {age_str})  {tag}")
                    escalation += "Files currently in /mnt/user-data/outputs/ that you may emit:\n" + "\n".join(file_lines) + "\n"
                else:
                    escalation += "No files were detected in /mnt/user-data/outputs/. Emit with artifact_path=null is INVALID — write at least one file before emit_builder_artifact, or accept the force-stop fallback.\n"
            elif remaining <= 6:
                escalation += "WARNING: Running low on turns. Wrap up edits and call emit_builder_artifact within the next 1-2 turns. Stop re-planning with write_todos; that wastes a turn.\n"
            else:
                escalation += "If the deliverable is ready, your NEXT action must be emit_builder_artifact.\n"
            escalation += "Do not end with plain text and do not call any tools after emit_builder_artifact.\n</builder_endgame>"
            sections.append(escalation)

        briefing = "<builder_briefing>\n" + "\n\n".join(sections) + "\n</builder_briefing>"

        blocks = list(state.get("system_prompt_blocks", []))
        blocks.append(briefing)

        log_middleware(
            "BuilderTask",
            f"task_type={task_type} tone={tone_estimate:.1f} ritual={active_ritual or 'none'} non_artifact_turns={non_artifact_turns}",
            _t0,
        )
        return {
            "system_prompt_blocks": blocks,
            **({"builder_run_id": builder_run_id} if (builder_run_id := _runtime_builder_run_id(runtime)) else {}),
            **boundary_state_updates,
            **page_target_updates,
            **report_requirement_updates,
            **slide_target_updates,
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    # Skills the builder is steered toward for binary deliverables.
    # Phase B (2026-04-29): inject these into the system prompt so the
    # model uses pre-tested generators instead of writing matplotlib /
    # reportlab / python-pptx code itself. Limited to the binary-
    # generation skills relevant to builder workflows; other skills
    # (sophia, bootstrap, surprise-me, …) are noise here.
    # chart-visualization is intentionally EXCLUDED: its documented workflow
    # shells out to the remote Alipay GPT-Vis service, which rendered empty
    # charts + failed structural diagram families in production (2026-06-25
    # visual-render-regression forensics). Report figures are now authored as
    # inline <svg> in HTML and rendered via render_html_to_pdf.
    _BUILDER_RELEVANT_SKILLS: tuple[str, ...] = (
        "visual-design",
        "hallmark",
        "hands-on-deck",
        "deck-impeccable",
        "deck-hallmark",
        "pdf-report",
        "ppt-generation",
        "image-generation",
        "deep-research",
        "academic-paper-review",
        "systematic-literature-review",
        "data-analysis",
    )

    @classmethod
    def _build_skills_inventory_block(
        cls,
        *,
        include_image_generation: bool = True,
        include_visual_design: bool = False,
        presentation_design_mode: bool = False,
        include_pdf_report: bool = True,
        include_research_skills: bool = True,
    ) -> str | None:
        """Return a ``<skill_system>`` block listing builder-relevant skills.

        Reuses the central skills loader so SKILL.md descriptions stay
        in sync with what the lead_agent sees. When ``load_skills`` is
        unavailable (offline tests, packaging issue) or no relevant
        skills are enabled, returns ``None`` and the model falls back
        to the pre-Phase-B "_generate_*.py" path explicitly described
        in <completion_instruction>.
        """
        try:
            from deerflow.skills import load_skills  # local import: package may be optional in tests
        except Exception:  # pragma: no cover — defensive
            logger.warning("BuilderTask: deerflow.skills unavailable; skipping skills inventory block")
            return None

        try:
            # Intentionally NOT ``enabled_only=True``. The
            # ``_BUILDER_RELEVANT_SKILLS`` whitelist below already pins
            # the four binary-generation skills the builder always needs,
            # and gating them through ``extensions_config.json`` adds a
            # silent failure mode: when that file is missing (e.g. fresh
            # checkout, render deploy without operator config), the
            # loader's exception path leaves every skill ``enabled=False``
            # and ``enabled_only=True`` filters them all out — so the
            # ``<skill_system>`` block never reaches the prompt and the
            # model falls back to writing matplotlib/reportlab loops.
            # The whitelist is the correct gate; per-skill enable state
            # is operator policy that doesn't apply to the builder's
            # intrinsic tooling.
            skills = load_skills(enabled_only=False)
        except Exception:  # pragma: no cover — defensive
            logger.warning("BuilderTask: load_skills failed; skipping skills inventory block", exc_info=True)
            return None

        allowed_skill_names = set(cls._BUILDER_RELEVANT_SKILLS)
        if presentation_design_mode:
            allowed_skill_names.intersection_update(
                {
                    "hands-on-deck",
                    "deck-impeccable",
                    "deck-hallmark",
                    "ppt-generation",
                    "image-generation",
                }
            )
            include_image_generation = True
        else:
            allowed_skill_names.difference_update({"hands-on-deck", "deck-impeccable", "deck-hallmark"})
        if not include_image_generation:
            allowed_skill_names.discard("image-generation")
        if not include_visual_design or presentation_design_mode:
            allowed_skill_names.discard("visual-design")
            allowed_skill_names.discard("hallmark")
        if not include_pdf_report:
            allowed_skill_names.discard("pdf-report")
        if not include_research_skills:
            allowed_skill_names.difference_update({"deep-research", "academic-paper-review", "systematic-literature-review"})
        relevant = [s for s in skills if getattr(s, "name", None) in allowed_skill_names]
        # Log either way so "did the builder see skills this run?" is
        # answerable from a single grep on the langgraph-server logs.
        # Without this, the only signal in the existing logs is the
        # absence of a ``<skill_system>`` line — which is invisible.
        logger.info(
            "[BuilderTask] skills_inventory: %d skills injected (%s)",
            len(relevant),
            ", ".join(sorted(s.name for s in relevant)) if relevant else "none",
        )
        if not relevant:
            return None

        try:
            from deerflow.config import get_app_config

            container_base = get_app_config().skills.container_path
        except Exception:
            container_base = "/mnt/skills"

        items: list[str] = []
        for skill in relevant:
            name = getattr(skill, "name", "")
            description = (getattr(skill, "description", "") or "").strip()
            try:
                location = skill.get_container_file_path(container_base)
            except Exception:
                location = f"{container_base}/{name}/SKILL.md"
            items.append(f"  <skill>\n    <name>{name}</name>\n    <description>{description}</description>\n    <location>{location}</location>\n  </skill>")

        return (
            "<skill_system>\n"
            "Pre-tested workflows for binary deliverables. Strongly preferred over "
            "writing your own matplotlib/reportlab/python-pptx code — past attempts at "
            "ad-hoc Python generation failed repeatedly on font/encoding/image-embedding "
            "errors.\n"
            "\n"
            "How to use a skill:\n"
            "1. read_file_tool on the skill's SKILL.md to learn its workflow.\n"
            "2. Follow the SKILL.md instructions. Some skills are guidance-only "
            "(visual-design); generation skills usually involve invoking a bundled "
            "script or tool with structured input.\n"
            "3. Generation scripts/tools write outputs (PNG/SVG/PPTX/JSON/CSV) to a path you pass them.\n"
            "4. Compose downstream artifacts (e.g. a Markdown document referencing local "
            "visual assets) using the generated output paths.\n"
            "\n"
            "<available_skills>\n" + "\n".join(items) + "\n</available_skills>\n"
            "</skill_system>"
        )

    @staticmethod
    def _tone_guidance(tone_estimate: float, band: str) -> str:
        """Map tone_estimate to behavioral instructions for the builder."""
        if tone_estimate < 1.0 or band == "shutdown":
            return "User is very low. Make ALL decisions yourself. Keep simple. Minimize user input. Quality over ambition."
        if tone_estimate < 1.5 or band == "grief_fear":
            return "User is low. Make most decisions. Keep clean. Deliverable should feel like relief."
        if tone_estimate < 2.5 or band == "anger_antagonism":
            return "User is frustrated. Be direct and efficient. No flourishes. Solve problems, don't flag them."
        if tone_estimate < 3.5 or band == "engagement":
            return "User has energy. Can be more ambitious. Include thoughtful details. 1-2 decision points OK."
        # tone >= 3.5 or enthusiasm
        return "User is high energy. Be ambitious. Add surprise element. Don't play it safe."

    @staticmethod
    def _ritual_guidance(ritual: str, phase: str | None) -> str | None:
        """Map active ritual to builder behavioral guidance."""
        guidance_map: dict[str, str] = {
            "prepare": ("User is getting ready for something important. Output should feel like armor, not homework."),
            "debrief": ("User is processing what happened. Structure around what happened \u2192 what worked \u2192 what didn't \u2192 what's next."),
            "vent": ("User moved from venting to action. Keep simple. Don't add complexity."),
            "reset": ("User is clearing the deck. Output should feel clean and forward-looking."),
        }
        return guidance_map.get(ritual)
