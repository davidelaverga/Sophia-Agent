"""start_builder_task — deepagents-native async builder dispatch.

Wraps deepagents v0.5 ``AsyncSubAgentMiddleware``'s native dispatch flow with
the discipline ``switch_to_builder`` enforces today: duplicate-launch
protection, live-context embedding, demo-prompt normalization, and trusted
user_id resolution.

The wrapper sits in front of the four native lifecycle tools
(``check_async_task`` / ``update_async_task`` / ``cancel_async_task`` /
``list_async_tasks``); it replaces ``start_async_task`` so the model only ever
sees the enriched-description path. ``AsyncSubAgentMiddleware.tools`` is
filtered in ``sophia_agent.agent._build_async_subagent_middleware`` to drop
``start_async_task`` from the model-visible set.

Dispatch goes through LangGraph SDK's ASGI in-process transport
(``url=None``). The builder receives:

- ``messages``: a single HumanMessage carrying the enriched description.
- ``delegation_context``: dict consumed by ``BuilderTaskMiddleware`` and
  ``BuilderResearchPolicyMiddleware`` for system-prompt assembly + web policy.
- ``allow_web_research`` / ``explicit_user_urls`` / ``builder_web_budget``:
  redundant top-level state seeds so the policy middleware can read either
  surface (matches ``switch_to_builder``'s emission shape).

Companion state is updated atomically via ``Command(update=...)``:

- ``async_tasks[task_id]``: ``AsyncTask`` shape compatible with deepagents'
  internal ``_tasks_reducer`` (we use the project's ``merge_async_tasks``
  reducer in ``state.py`` which is functionally identical).
- ``messages``: a ``ToolMessage`` echoing the LLM's ``tool_call_id`` so
  LangGraph's tool-routing contract is satisfied.

Tests cover dispatch shape, duplicate protection, live-context embedding,
SDK failure fallback, and user_id resolution (mirroring
``test_switch_to_builder_tool.py``).
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import shutil
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

from deerflow.sophia.builder_web_policy import (
    extract_explicit_user_urls,
    make_builder_web_budget,
    should_allow_builder_web_research,
)

# Importing ``deerflow.agents.sophia_agent.state`` (or any module under
# ``deerflow.agents``) at module-load time triggers loading of
# ``deerflow.agents.__init__``, which imports ``make_sophia_agent`` →
# ``agent.py``, which imports back from this module. Using ``TYPE_CHECKING``
# for the type alias and a lazy import for ``validate_user_id`` breaks the
# cycle so direct ``from deerflow.sophia.tools.start_builder_task import …``
# imports work regardless of test/runtime load order.
if TYPE_CHECKING:
    from deerflow.agents.sophia_agent.state import SophiaState
else:
    SophiaState = dict  # runtime fallback for the type alias


def _validate_user_id(user_id: str) -> str:
    """Lazy proxy for ``deerflow.agents.sophia_agent.utils.validate_user_id``.

    Imported lazily to avoid the circular described above.
    """
    from deerflow.agents.sophia_agent.utils import validate_user_id

    return validate_user_id(user_id)

logger = logging.getLogger(__name__)

__all__ = [
    "make_start_builder_task_tool",
    "start_builder_task",
]

_ASYNC_BUILDER_AGENT_NAME = "sophia_builder"

# Terminal builder-task statuses. Anything NOT in this set is treated as
# active (covers ``running``, ``pending``, ``interrupted``, ``queued``,
# ``started``, and any new LangGraph SDK status we haven't seen yet).
# Default-active is the safer behaviour: a duplicate launch is rejected
# whenever we are unsure whether a build is finished.
#
# Codex bot review on PR-A flagged that the previous whitelist
# ``{"queued", "running", "started"}`` missed ``pending`` (which the
# LangGraph SDK can write back into ``async_tasks`` via
# ``check_async_task``) and any other status that lands in the future.
_TERMINAL_TASK_STATUSES = {
    "success",
    "completed",
    "error",
    "failed",
    "cancelled",
    "timeout",
    "timed_out",
}

# Task-type prefix (and short label) the model should embed in the
# ``description`` argument. Per spec section 4.1: ``[document]`` /
# ``[research]`` / etc. The wrapper enforces this even if the model omits the
# prefix — keeps the brief self-describing for the builder's first turn.
_TASK_TYPE_PREFIXES: dict[str, str] = {
    "document": "[document]",
    "research": "[research]",
    "presentation": "[presentation]",
    "frontend": "[frontend]",
    "visual_report": "[visual_report]",
}

_HTML_OUTPUT_RE = re.compile(
    r"\b(?:html\s+(?:document|file|report|summary|brief|article|explainer|page|site|website)"
    r"|(?:document|file|report|summary|brief|article|explainer|page|site|website)\s+(?:as|in)\s+html"
    r"|(?:build|create|make|generate|produce|write)\s+(?:an?\s+)?html\b"
    r"|\.html\b)",
    re.IGNORECASE,
)
_PDF_OUTPUT_RE = re.compile(
    r"\b(?:"
    r"pdf\s+(?:document|file|report|summary|brief|article|explainer|deliverable|artifact|output)"
    r"|(?:document|file|report|summary|brief|article|explainer|deliverable|artifact|output|final|export)"
    r"\s+(?:as|in|to)\s+(?:an?\s+)?pdf"
    r"|(?:build|create|make|generate|produce|write|render|export)\s+(?:an?\s+)?pdf\b"
    r"|(?:build|create|make|generate|produce|write|render|export)\s+[^.?!\n]{0,80}?\s+as\s+(?:an?\s+)?pdf\b"
    r"|\.pdf\b"
    r")",
    re.IGNORECASE,
)
_REQUESTED_OUTPUT_EXTENSION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pdf", _PDF_OUTPUT_RE),
    ("pptx", re.compile(r"\b(?:pptx|powerpoint|slide\s+deck|slides?)\b", re.IGNORECASE)),
    ("docx", re.compile(r"\b(?:docx|word\s+document)\b", re.IGNORECASE)),
    ("xlsx", re.compile(r"\b(?:xlsx|spreadsheet|excel)\b", re.IGNORECASE)),
    ("html", _HTML_OUTPUT_RE),
    ("md", re.compile(r"\b(?:markdown|md)\b", re.IGNORECASE)),
    ("csv", re.compile(r"\bcsv\b", re.IGNORECASE)),
    ("json", re.compile(r"\bjson\b", re.IGNORECASE)),
)
_TASK_TYPE_EXTENSIONS = {
    "document": "md",
    "research": "md",
    "presentation": "pptx",
    "frontend": "html",
    "visual_report": "pdf",
}
_FALLBACK_TASK_SLUG = "build"
_MAX_SLUG_SOURCE_CHARS = 60

# File extensions copied from the parent (companion) thread's uploads
# into the builder's sandbox at dispatch time. Each LangGraph thread gets
# its own sandbox via ``ThreadDataMiddleware``, so the builder cannot
# read the companion's filesystem directly — we copy images across so
# ``view_image_tool`` can inspect them by virtual path. Kept narrow:
# documents go through ``read_user_document`` on the companion side; the
# builder typically generates its own text deliverables and doesn't need
# the user's text files copied over (and shipping a 50 MB PDF across is
# wasteful when the companion already extracted what it needed).
#
# MUST stay a subset of the extensions ``view_image_tool`` actually
# accepts. Upstream rejects ``.gif`` (see
# ``deerflow.tools.builtins.view_image_tool``'s ``valid_extensions``
# check), so copying GIFs across and surfacing them in the builder
# briefing would teach the model to make a guaranteed-failing
# ``view_image_tool(image_path="...gif")`` call. If upstream ever adds
# GIF support, add it here AND verify the builder briefing wording in
# ``BuilderTaskMiddleware`` still matches.
_BUILDER_COPY_IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".webp"}
)


# Strict allow-list for filenames that may be copied into the builder's
# sandbox and later named in its briefing block. Codex P2 on PR #132:
# the gateway upload sanitizer rejects path separators but not
# newlines, angle brackets, or other characters that could break out
# of the ``<uploaded_images>`` prompt tag. Filtering at this boundary
# keeps dangerous names out of ``delegation_context`` entirely, so
# even if the briefing renderer's own allow-list
# (``builder_task._SAFE_UPLOADED_IMAGE_PATH``) were ever bypassed,
# the underlying filesystem entries are already safe.
_SAFE_COPY_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _max_builder_image_bytes() -> int:
    """Per-image size cap for builder-side vision copy.

    Read lazily from ``view_user_image.MAX_VIEWABLE_IMAGE_BYTES`` so the
    companion and builder share a single source of truth — bumping the
    cap there flows through here automatically. Lazy because
    ``view_user_image`` lazy-imports its sandbox helpers (see that
    module's TYPE_CHECKING dance), and we'd rather not invert the
    dependency at module-load time.
    """
    from deerflow.sophia.tools.view_user_image import MAX_VIEWABLE_IMAGE_BYTES

    return MAX_VIEWABLE_IMAGE_BYTES


# Demo-prompt detection. Mirrors ``switch_to_builder``'s heuristic so users
# who say "test builder, make anything" continue to get the deterministic
# small-deliverable flow instead of an open-ended research loop.
_BUILDER_DEMO_MARKERS = (
    "test builder",
    "testing builder",
    "builder flow",
    "builder mode",
    "builder functionality",
    "builder working",
    "show me builder",
    "see builder work",
    "see builder working",
    "feature working",
    "feature in action",
    "sample project",
    "demo builder",
    "quick builder demo",
    "test/exploration mode",
)
_BUILDER_GENERIC_DEMO_MARKERS = (
    "quick draft",
    "make anything",
    "anything simple",
    "just wanna see",
    "just want to see",
    "show me it working",
    "show it working",
)


def _utcnow_iso() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slugify_for_filename(text: str, max_len: int = 40) -> str:
    if not isinstance(text, str):
        return _FALLBACK_TASK_SLUG
    head = text.strip()[:_MAX_SLUG_SOURCE_CHARS]
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", head).strip("-").lower()
    if not cleaned:
        return _FALLBACK_TASK_SLUG
    return cleaned[:max_len].rstrip("-") or _FALLBACK_TASK_SLUG


def _requested_output_extension(description: str | None) -> str | None:
    if not isinstance(description, str) or not description.strip():
        return None
    for ext, pattern in _REQUESTED_OUTPUT_EXTENSION_PATTERNS:
        if pattern.search(description):
            return ext
    return None


def _suggest_artifact_filename(task_type: str | None, description: str | None) -> str:
    ext = _requested_output_extension(description) or _TASK_TYPE_EXTENSIONS.get(task_type or "", "md")
    slug = _slugify_for_filename(description or _FALLBACK_TASK_SLUG)
    return f"{slug}.{ext}"


def _suggest_artifact_target_path(task_type: str | None, description: str | None) -> str:
    return f"/mnt/user-data/outputs/{_suggest_artifact_filename(task_type, description)}"


def _resolve_thread_id(runtime: ToolRuntime[ContextT, SophiaState] | None) -> str | None:
    """Resolve thread_id from runtime context/configurable with contextvar fallback."""
    if runtime is not None:
        if runtime.context and runtime.context.get("thread_id"):
            return runtime.context.get("thread_id")
        if runtime.config:
            configurable = runtime.config.get("configurable", {})
            if configurable.get("thread_id"):
                return configurable.get("thread_id")

    try:
        from langchain_core.runnables.config import var_child_runnable_config

        run_config = var_child_runnable_config.get({})
        return run_config.get("configurable", {}).get("thread_id")
    except Exception:
        return None


def _resolve_memory_snippets(state: SophiaState) -> list[str]:
    """Return human-readable memory snippets for the builder context.

    Preference order:
      1. ``injected_memory_contents`` (explicit human-readable snippets)
      2. ``injected_memories`` values that do not look like opaque IDs
    """
    snippets_raw = state.get("injected_memory_contents") or []
    snippets = [str(item).strip() for item in snippets_raw if str(item).strip()]
    if snippets:
        return snippets

    fallbacks: list[str] = []
    for item in state.get("injected_memories", []) or []:
        text = str(item).strip()
        if len(text) >= 24 and text.count("-") >= 2 and " " not in text:
            continue
        if text:
            fallbacks.append(text)
    return fallbacks


def _latest_emit_artifact_payload(messages: list[Any]) -> dict[str, Any] | None:
    """Return the most recent ``emit_artifact`` payload from AI tool calls."""
    for msg in reversed(messages):
        if not isinstance(msg, AIMessage):
            continue
        for tool_call in reversed(getattr(msg, "tool_calls", []) or []):
            if tool_call.get("name") != "emit_artifact":
                continue
            args = tool_call.get("args")
            if isinstance(args, dict):
                return args
    return None


def _resolve_companion_artifact(
    state: SophiaState,
) -> tuple[dict[str, Any], str, dict[str, bool]]:
    """Resolve freshest companion artifact and provenance diagnostics."""
    latest_emit_artifact = _latest_emit_artifact_payload(state.get("messages", []) or [])
    current_artifact = state.get("current_artifact")
    previous_artifact = state.get("previous_artifact")

    diagnostics = {
        "latest_emit_artifact_present": isinstance(latest_emit_artifact, dict) and bool(latest_emit_artifact),
        "current_artifact_present": isinstance(current_artifact, dict) and bool(current_artifact),
        "previous_artifact_present": isinstance(previous_artifact, dict) and bool(previous_artifact),
    }
    if latest_emit_artifact:
        return latest_emit_artifact, "latest_emit_artifact_tool_call", diagnostics

    if isinstance(current_artifact, dict) and current_artifact:
        return current_artifact, "current_artifact_state", diagnostics

    if isinstance(previous_artifact, dict) and previous_artifact:
        return previous_artifact, "previous_artifact_state", diagnostics

    return {}, "default_empty", diagnostics


def _resolve_user_id(
    runtime: ToolRuntime[ContextT, SophiaState] | None,
    state: SophiaState,
    configured_user_id: str | None = None,
    explicit_tool_arg: str | None = None,
) -> tuple[str, str, dict[str, Any]]:
    """Resolve user_id and return source diagnostics.

    Priority order (highest first):
      1. ``runtime.config.configurable.user_id`` (TRUSTED — set by gateway)
      2. ``runtime.context.user_id`` (TRUSTED — set by gateway)
      3. ``state.user_id`` (TRUSTED — propagated from authenticated runtime)
      4. ``configured_user_id`` (TRUSTED — closure bound at companion build)
      5. ``explicit_tool_arg`` (UNTRUSTED — LLM-supplied; last-resort fallback)
      6. ``"default_user"`` (hard failure; logged WARNING)

    The LLM's tool-call ``user_id`` is NEVER trusted to override an
    authenticated identity. A mismatch is logged WARNING for audit.
    """
    tool_arg_user_id: str | None = None
    configurable_user_id: str | None = None
    context_user_id: str | None = None
    state_user_id: str | None = None

    if isinstance(explicit_tool_arg, str) and explicit_tool_arg.strip():
        tool_arg_user_id = explicit_tool_arg

    if runtime is not None:
        if runtime.config:
            configurable = runtime.config.get("configurable", {}) or {}
            candidate = configurable.get("user_id")
            if isinstance(candidate, str) and candidate.strip():
                configurable_user_id = candidate

        if runtime.context:
            candidate = runtime.context.get("user_id")
            if isinstance(candidate, str) and candidate.strip():
                context_user_id = candidate

    candidate = state.get("user_id")
    if isinstance(candidate, str) and candidate.strip():
        state_user_id = candidate

    trusted_resolved: str | None = None
    trusted_source: str | None = None
    if configurable_user_id:
        trusted_resolved = _validate_user_id(configurable_user_id)
        trusted_source = "runtime.config.configurable.user_id"
    elif context_user_id:
        trusted_resolved = _validate_user_id(context_user_id)
        trusted_source = "runtime.context.user_id"
    elif state_user_id:
        trusted_resolved = _validate_user_id(state_user_id)
        trusted_source = "state.user_id"
    elif configured_user_id:
        trusted_resolved = _validate_user_id(configured_user_id)
        trusted_source = "configured_builder_user_id"

    tool_arg_matches_trusted: bool | None = None
    if tool_arg_user_id is not None and trusted_resolved is not None:
        tool_arg_matches_trusted = _validate_user_id(tool_arg_user_id) == trusted_resolved

    diagnostics: dict[str, Any] = {
        "tool_arg_user_id_present": bool(tool_arg_user_id),
        "tool_arg_user_id_matches_trusted": tool_arg_matches_trusted,
        "configured_user_id_present": bool(configured_user_id),
        "config_user_id_present": bool(configurable_user_id),
        "context_user_id_present": bool(context_user_id),
        "state_user_id_present": bool(state_user_id),
    }

    if trusted_resolved is not None and tool_arg_matches_trusted is False:
        logger.warning(
            "[Builder] tool-arg user_id mismatch with trusted source — tool_arg=%r trusted_source=%s trusted=%r. Ignoring tool_arg (trusted identity wins); verify caller for possible prompt injection.",
            tool_arg_user_id,
            trusted_source,
            trusted_resolved,
        )

    if trusted_resolved is not None:
        return trusted_resolved, trusted_source, diagnostics

    if tool_arg_user_id:
        logger.warning(
            "[Builder] user_id falling back to LLM-supplied tool arg (%r) — all trusted sources empty. This value is NOT authenticated.",
            tool_arg_user_id,
        )
        return _validate_user_id(tool_arg_user_id), "tool_arg_fallback", diagnostics

    logger.warning("[Builder] user_id resolution fell back to 'default_user' — no source (trusted or LLM-supplied) provided a user identifier.")
    return _validate_user_id("default_user"), "default_user", diagnostics


def _is_demo_request(
    description: str,
    task_type: str,
    companion_artifact: dict,
) -> bool:
    """Detect explicit Builder smoke-test turns that should avoid open-ended work."""
    if task_type not in {"frontend", "research", "document"}:
        return False

    artifact_text = " ".join(str(companion_artifact.get(field, "")) for field in ("session_goal", "active_goal", "takeaway"))
    combined = f"{description} {artifact_text}".lower()

    if any(marker in combined for marker in _BUILDER_DEMO_MARKERS):
        return True

    return "builder" in combined and any(marker in combined for marker in _BUILDER_GENERIC_DEMO_MARKERS)


def _build_demo_builder_task() -> str:
    """Return a small Builder task that proves the end-to-end flow quickly."""
    return (
        "Create exactly one markdown file at /mnt/user-data/outputs/builder-demo.md. "
        "Keep it under 180 words and do not ask clarifying questions. "
        "Use default placeholder content that demonstrates Builder completed a task successfully. "
        "Use this structure: '# Builder Demo', '## What Sophia generated', '## Assumptions used', and '## Next step'. "
        "Write the deliverable directly to /mnt/user-data/outputs using that absolute path. "
        "After writing the file, call emit_builder_artifact as your final action with artifact_path='/mnt/user-data/outputs/builder-demo.md', "
        "artifact_type='document', artifact_title='Builder Demo Deliverable', steps_completed=3, "
        "decisions_made=['Used a minimal markdown deliverable', 'Filled missing specs with defaults'], "
        "companion_summary='Created a quick demo deliverable from defaults so the Builder flow can be verified.', "
        "companion_tone_hint='Confident', user_next_action='Open or download the file, then ask for a real deliverable next.', "
        "confidence=0.82. Create no other files and do not run extra commands."
    )


def _normalize_request(
    description: str,
    task_type: str,
    companion_artifact: dict,
) -> tuple[str, str, bool]:
    """Coerce underspecified Builder demo requests into a deterministic task."""
    if not _is_demo_request(description, task_type, companion_artifact):
        return description, task_type, False
    return _build_demo_builder_task(), "document", True


def _build_enriched_description(
    description: str,
    task_type: str,
    *,
    memory_snippets: list[str],
    companion_artifact: dict[str, Any],
    active_ritual: str | None,
    ritual_phase: str | None,
    explicit_user_urls: list[str],
) -> str:
    """Embed live session context into the builder's task description.

    Replaces the old ``delegation_context`` parallel state channel for the
    parts the model sees. The builder's own middlewares (UserIdentity,
    BuilderTask) still load identity / web policy from state — see
    ``_build_delegation_context`` for the state-channel side.
    """
    prefix = _TASK_TYPE_PREFIXES.get(task_type, f"[{task_type}]")
    sections: list[str] = []

    # Lead with the prefix (only if the description doesn't already have one).
    leading = description.lstrip()
    if leading.startswith(prefix):
        sections.append(description.strip())
    else:
        sections.append(f"{prefix} {description.strip()}")

    if memory_snippets:
        formatted = "\n".join(f"- {m}" for m in memory_snippets[:5])
        sections.append(f"Relevant memories from this session:\n{formatted}")

    tone = companion_artifact.get("tone_estimate") if isinstance(companion_artifact, dict) else None
    active_goal = companion_artifact.get("active_goal") if isinstance(companion_artifact, dict) else None
    if tone is not None or (isinstance(active_goal, str) and active_goal.strip()):
        sections.append(f"Current emotional context: tone={tone}, active_goal={(active_goal or '').strip() or 'unspecified'}.")

    if active_ritual:
        sections.append(f"Active ritual: {active_ritual}, phase: {ritual_phase or 'unknown'}.")

    if explicit_user_urls:
        joined = ", ".join(explicit_user_urls)
        sections.append(f"Explicit URLs the user provided (treat as authoritative): {joined}.")

    return "\n\n".join(sections)


def _build_delegation_context(
    *,
    description: str,
    task_type: str,
    artifact_target_path: str,
    companion_artifact: dict[str, Any],
    memory_snippets: list[str],
    active_ritual: str | None,
    ritual_phase: str | None,
    allow_web_research: bool,
    explicit_user_urls: list[str],
    builder_web_budget: dict[str, Any],
    handoff_resolution: dict[str, Any],
) -> dict[str, Any]:
    """Build the ``delegation_context`` dict the builder middlewares read.

    Shape mirrors ``switch_to_builder``'s emission so the builder side
    (BuilderTaskMiddleware, BuilderResearchPolicyMiddleware) is unchanged.
    """
    return {
        "task": description,
        "task_type": task_type,
        "artifact_target_path": artifact_target_path,
        "companion_artifact": companion_artifact,
        "user_identity": None,  # populated by builder's UserIdentityMiddleware
        "relevant_memories": memory_snippets[:5],
        "active_ritual": active_ritual,
        "ritual_phase": ritual_phase,
        "allow_web_research": allow_web_research,
        "search_mode": "autonomous",
        "explicit_user_urls": explicit_user_urls,
        "builder_web_budget": builder_web_budget,
        "handoff_resolution": handoff_resolution,
    }


# Server-trusted filename allow-list for current-turn attachments.
# Codex P2 PR #132 latest iteration: the attached filenames come from
# the frontend chat post-handler. Each name is re-validated through this
# regex before we touch the filesystem so a compromised input source
# (e.g. a future caller that doesn't sanitize) can't slip path traversal
# or prompt-injection characters through to ``_copy_parent_uploaded_images``.
_TRUSTED_ATTACHMENT_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _read_current_turn_attached_files(
    runtime: ToolRuntime[ContextT, SophiaState] | None,
) -> Any:
    """Read the raw per-run attachment list from runtime config/context.

    Codex P2 PR #132 (latest iteration): this field MUST be sourced
    from ``runtime.config["configurable"]`` (the frontend chat client
    writes it there) — a **per-run** channel that LangGraph does NOT
    persist into thread state. The earlier implementation read
    ``state["current_turn_attached_files"]`` from the ``input`` channel,
    which IS persisted under the field's LAST_VALUE reducer. The
    consequence: a later turn that omitted attachments (no
    ``current_turn_attached_files`` in its input) did not clear the
    field — the prior turn's list survived in state, and
    ``_copy_parent_uploaded_images`` re-copied private images from an
    earlier turn into a brand-new builder sandbox. Relying on "omitted
    fields disappear from state" is wrong: omitted fields are simply
    not updated, so the stale value persists.

    ``config.configurable`` (and ``context``) are scoped to a single
    run and never written back to state, so a run that omits the field
    reads a clean empty value — exactly the per-run reset semantics the
    review asked for, with no extra reducer/sentinel plumbing.

    Checks ``config.configurable`` first (where the frontend puts it),
    then ``context`` as a fallback (langgraph-api copies ``context`` →
    ``configurable`` server-side, but a direct ``context``-only caller
    is still honoured).
    """
    if runtime is None:
        return None
    if runtime.config:
        configurable = runtime.config.get("configurable", {}) or {}
        if "current_turn_attached_files" in configurable:
            return configurable.get("current_turn_attached_files")
    if runtime.context:
        candidate = runtime.context.get("current_turn_attached_files")
        if candidate is not None:
            return candidate
    return None


def _extract_current_turn_attachment_filenames(
    runtime: ToolRuntime[ContextT, SophiaState] | None,
) -> frozenset[str]:
    """Return the filenames the user attached on THIS turn.

    Sources the list from ``runtime.config["configurable"]`` via
    ``_read_current_turn_attached_files`` — a per-run channel the
    frontend chat client populates (empty list when no attachments).
    This is the **server-trusted** attachment list — NOT a parse of the
    user message body, which a user could spoof by typing the
    synthesized prompt marker into their own text.

    History: the original implementation parsed the latest HumanMessage
    for the ``[The user has uploaded ...]`` sentinel + bullet
    filenames; Codex P2 flagged that as spoofable, so the trust
    boundary moved to an OOB field. A follow-up Codex P2 flagged that
    routing the field through LangGraph ``input`` (persisted state) left
    it stale across turns that omit attachments — so it now travels on
    the per-run ``config.configurable`` channel instead (see
    ``_read_current_turn_attached_files``).

    Defense in depth: each name is re-validated against
    ``_TRUSTED_ATTACHMENT_FILENAME`` (the same allow-list the frontend
    + the builder-side renderer use) so a misbehaving upstream can't
    introduce path-traversal or prompt-injection characters.

    Returns empty frozenset when:
    - the run didn't include ``current_turn_attached_files`` (e.g. a
      non-frontend client like the LangGraph SDK creating a run
      directly, or any turn with no attachments)
    - the value isn't a list of strings
    - every entry fails the allow-list
    """
    raw = _read_current_turn_attached_files(runtime)
    if not isinstance(raw, list):
        return frozenset()
    safe: set[str] = set()
    for entry in raw:
        if isinstance(entry, str) and _TRUSTED_ATTACHMENT_FILENAME.match(entry):
            safe.add(entry)
    return frozenset(safe)


def _select_copyable_images(
    parent_uploads: Path,
    max_bytes: int,
    parent_thread_id: str,
    allowed_names: frozenset[str] | None,
) -> list[Path]:
    """Pick image files in ``parent_uploads`` eligible for builder copy.

    Filters to image extensions, drops hidden files and unreadable
    entries, and skips anything over ``max_bytes`` (the companion-side
    vision cap — matches what the builder's upstream view_image_tool
    can actually handle). Oversized skips are logged once each so an
    operator can grep "why didn't the builder see my image".

    ``allowed_names`` (Codex P1 PR #132 latest iteration): when non-None,
    only filenames in this set are kept. The set is the intersection of
    "files the user attached on the current turn" (parsed from the
    synthesized ``buildAttachmentPrompt`` block in the latest
    HumanMessage). Without this scoping, every leftover image from
    prior turns in the parent uploads dir would be copied into each
    new builder run, exposing stale/private images to the builder and
    encouraging it to inspect or include them in unrelated tasks. An
    empty frozenset means "user attached nothing this turn" → copy
    nothing. ``None`` means "skip scoping" (legacy callers; tests).

    Extracted from ``_copy_parent_uploaded_images`` so that function's
    cyclomatic complexity stays under Sentrux's CC ≥ 16 gate after the
    Codex P2 oversize guard was added (PR #132).
    """
    eligible: list[Path] = []
    for f in sorted(parent_uploads.iterdir()):
        if not f.is_file() or f.name.startswith("."):
            continue
        if f.suffix.lower() not in _BUILDER_COPY_IMAGE_EXTENSIONS:
            continue
        if not _SAFE_COPY_FILENAME.match(f.name):
            logger.warning(
                "[Builder] skipping image with unsafe filename %r from parent thread %s — "
                "name contains characters outside the [A-Za-z0-9._-] allow-list "
                "(prompt-injection guard).",
                f.name,
                parent_thread_id,
            )
            continue
        if allowed_names is not None and f.name not in allowed_names:
            # Codex P1: this file existed in the parent uploads dir but
            # the user did NOT attach it on THIS turn. Skip silently
            # (no warning — this is the expected, common case for any
            # multi-turn session with prior uploads).
            continue
        try:
            size = f.stat().st_size
        except OSError:
            # Treat stat failures as "skip" — copying a file whose size
            # we can't validate would risk tripping the builder's
            # vision tool on the next turn.
            continue
        if size > max_bytes:
            logger.warning(
                "[Builder] skipping oversized image %s (%d bytes > %d cap) "
                "from parent thread %s — the builder's vision tool would "
                "trip Anthropic's request-size limit.",
                f.name,
                size,
                max_bytes,
                parent_thread_id,
            )
            continue
        eligible.append(f)
    return eligible


def _copy_files_to_builder_sandbox(
    sources: list[Path],
    builder_uploads: Path,
) -> list[str]:
    """Copy each ``sources`` entry into ``builder_uploads``; return virtual paths.

    Ensures the destination dir exists. Per-file copy failures are
    logged and dropped from the returned list so one bad file doesn't
    abort the rest of the dispatch.
    """
    try:
        builder_uploads.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.warning(
            "[Builder] failed to create builder uploads dir %s; skipping image copy",
            builder_uploads,
            exc_info=True,
        )
        return []

    virtual_paths: list[str] = []
    for src in sources:
        dst = builder_uploads / src.name
        try:
            shutil.copy2(src, dst)
        except OSError:
            logger.warning(
                "[Builder] failed to copy uploaded image %s -> %s",
                src,
                dst,
                exc_info=True,
            )
            continue
        virtual_paths.append(f"/mnt/user-data/uploads/{src.name}")
    return virtual_paths


def _materialize_current_turn_images_from_supabase(
    parent_thread_id: str,
    parent_uploads: Path,
    current_turn_attachments: frozenset[str],
) -> None:
    """Fetch whitelisted current-turn IMAGE uploads from the Supabase mirror.

    Cross-service bridge (Codex P1 PR #132 follow-up): in the split
    gateway/langgraph deployment, a freshly attached image exists only on
    the gateway disk + Supabase until the companion calls
    ``view_user_image`` (which materializes it locally). If the user
    instead asks immediately for a builder deliverable, ``start_builder_task``
    runs here in the langgraph container with an empty / missing parent
    uploads dir, so ``_select_copyable_images`` would find nothing and the
    builder would never be told about the image. We pull the whitelisted
    current-turn images into ``parent_uploads`` first so the copy proceeds.

    Best-effort: any failure is logged and skipped. Only image-extension
    names that pass ``_SAFE_COPY_FILENAME`` are fetched (documents are the
    job of ``read_user_document``, not the builder image copy). Files
    already present locally are left untouched.
    """
    from deerflow.sophia.storage import supabase_artifact_store

    if not supabase_artifact_store.is_configured():
        return
    try:
        parent_uploads.mkdir(parents=True, exist_ok=True)
    except OSError:
        return

    for name in current_turn_attachments:
        if not _SAFE_COPY_FILENAME.match(name):
            continue
        if Path(name).suffix.lower() not in _BUILDER_COPY_IMAGE_EXTENSIONS:
            continue
        dest = parent_uploads / name
        if dest.exists():
            continue
        try:
            # Uploads live under the {thread_id}/uploads/ keyspace (Codex P1
            # PR #132) — distinct from builder outputs — so address it with
            # the shared prefix helper the gateway mirror uses.
            object_name = supabase_artifact_store.uploads_object_name(name)
            result = supabase_artifact_store.download_artifact(parent_thread_id, object_name)
        except Exception as exc:  # noqa: BLE001 — best-effort cross-service fetch
            logger.warning(
                "[Builder] Supabase fetch failed for current-turn image %s/%s: %s",
                parent_thread_id,
                name,
                exc,
            )
            continue
        if result is None:
            continue
        content, _content_type = result
        try:
            with open(str(dest), "wb") as fh:
                fh.write(content)
        except OSError as exc:
            logger.warning("[Builder] could not materialize %s from Supabase: %s", name, exc)
            continue
        logger.info(
            "[Builder] materialized current-turn image %s (%d bytes) from Supabase for parent thread %s",
            name,
            len(content),
            parent_thread_id,
        )


def _copy_parent_uploaded_images(
    *,
    parent_thread_id: str | None,
    builder_thread_id: str,
    current_turn_attachments: frozenset[str] | None,
) -> list[str]:
    """Copy image uploads from the parent thread's sandbox into the builder's.

    Returns the list of virtual paths the builder will see (e.g.
    ``["/mnt/user-data/uploads/photo.png"]``). Returns an empty list
    when there's no parent thread, the parent sandbox is empty, or the
    parent uploads dir doesn't exist yet (no uploads happened).

    ``current_turn_attachments`` (Codex P1 PR #132 latest iteration):
    the whitelist of filenames the user attached on THIS turn (parsed
    server-side from the synthesized ``buildAttachmentPrompt`` block in
    the latest HumanMessage). ``None`` skips the scoping entirely
    (legacy callers and tests); empty frozenset means "user attached
    nothing this turn" → copy nothing. The bug this closes: previously
    the loop copied EVERY image in the parent uploads dir, so a builder
    request that had nothing to do with prior uploads would still see
    (and be encouraged to inspect) cat.png from three turns ago.

    Best-effort: a copy failure for one file is logged but doesn't
    abort the dispatch — the build proceeds without that image.
    """
    if not parent_thread_id:
        return []

    # Short-circuit: an explicit empty whitelist means "user attached
    # nothing on this turn" — there's nothing to copy. Checked BEFORE any
    # filesystem work.
    if current_turn_attachments is not None and not current_turn_attachments:
        return []

    from deerflow.config.paths import get_paths

    paths = get_paths()
    parent_uploads = paths.sandbox_uploads_dir(parent_thread_id)

    # Cross-service bridge (Codex P1 PR #132 follow-up): when the user
    # attached images on THIS turn but they only exist on the gateway disk
    # + Supabase (the companion hasn't materialized them locally yet), pull
    # them into the parent uploads dir FIRST so the copy below sees them.
    # Must run BEFORE the is_dir() check — in the split deployment the dir
    # may not exist yet on this container. Scoped to the current-turn
    # whitelist; ``None`` (legacy callers / tests) skips the fetch.
    if current_turn_attachments:
        _materialize_current_turn_images_from_supabase(
            parent_thread_id, parent_uploads, current_turn_attachments
        )

    if not parent_uploads.is_dir():
        return []

    eligible = _select_copyable_images(
        parent_uploads,
        _max_builder_image_bytes(),
        parent_thread_id,
        current_turn_attachments,
    )
    if not eligible:
        return []

    builder_uploads = paths.sandbox_uploads_dir(builder_thread_id)
    virtual_paths = _copy_files_to_builder_sandbox(eligible, builder_uploads)

    if virtual_paths:
        logger.info(
            "[Builder] copied %d uploaded image(s) from parent thread %s to builder thread %s",
            len(virtual_paths),
            parent_thread_id,
            builder_thread_id,
        )
    return virtual_paths


def _has_active_builder_task(state: SophiaState) -> str | None:
    """Return the task_id of any non-terminal builder task in state, else None.

    Uses a terminal-status blacklist (default-active) so any status the
    LangGraph SDK writes that we haven't anticipated is treated as
    "still running" — duplicate launches are rejected conservatively.
    """
    async_tasks = state.get("async_tasks", {}) or {}
    for task_id, task in async_tasks.items():
        if not isinstance(task, dict):
            continue
        if task.get("agent_name") != _ASYNC_BUILDER_AGENT_NAME:
            continue
        if task.get("status") not in _TERMINAL_TASK_STATUSES:
            return str(task_id)
    return None


async def _dispatch_via_asgi(
    *,
    description: str,
    delegation_context: dict[str, Any],
    allow_web_research: bool,
    explicit_user_urls: list[str],
    builder_web_budget: dict[str, Any],
    user_id: str,
    parent_thread_id: str | None,
    parent_model: str | None,
    current_turn_attachments: frozenset[str],
) -> tuple[str, str]:
    """Create a builder thread + run via LangGraph SDK ASGI in-process.

    Returns ``(task_id, run_id)``. Raises on SDK failure — caller decides
    how to surface that to the model (we return a string sentinel).
    """
    from langgraph_sdk import get_client

    client = get_client(url=None)  # ASGI in-process via langgraph.json
    thread = await client.threads.create()
    thread_id = thread["thread_id"]

    # Copy any image uploads from the parent (companion) thread into the
    # builder's freshly-allocated sandbox so ``view_image_tool`` can read
    # them by virtual path. Each LangGraph thread has its own sandbox —
    # the builder cannot read the companion's filesystem directly.
    uploaded_image_paths = _copy_parent_uploaded_images(
        parent_thread_id=parent_thread_id,
        builder_thread_id=thread_id,
        current_turn_attachments=current_turn_attachments,
    )

    # ``parent_thread_id`` and ``parent_user_id`` are also embedded in
    # ``delegation_context`` (state) because langgraph-api 0.8.1 forwards
    # only a subset of ``configurable`` keys to the running graph's
    # ``runtime.config``. We confirmed in production logs (2026-05-06):
    # ``thread_id`` and ``user_id`` propagate, but custom keys such as
    # ``parent_thread_id`` arrive as ``None`` on the builder side. State
    # fields ALWAYS reach the running graph, so the gateway-webhook
    # payload reads from state with a config fallback.
    delegation_with_parent = {
        **delegation_context,
        "parent_thread_id": parent_thread_id,
        "parent_user_id": user_id,
        "uploaded_image_paths": uploaded_image_paths,
    }

    run_input: dict[str, Any] = {
        "messages": [{"role": "user", "content": description}],
        "delegation_context": delegation_with_parent,
        "allow_web_research": allow_web_research,
        "explicit_user_urls": explicit_user_urls,
        "builder_web_budget": builder_web_budget,
        "builder_artifact_target_path": delegation_context.get("artifact_target_path"),
    }

    # ``thread_id`` MUST be in configurable so the builder's
    # ``ThreadDataMiddleware.before_agent`` can locate the per-thread
    # workspace/uploads/outputs directories. The positional ``thread_id``
    # argument to ``runs.create`` only associates the run with a thread on
    # the LangGraph side; it does not propagate to the running graph's
    # ``runtime.config["configurable"]``. We populate it explicitly here.
    run_config: dict[str, Any] = {
        "configurable": {
            "thread_id": thread_id,
            "user_id": user_id,
            # Kept for back-compat with any code that still reads from
            # ``runtime.config["configurable"]``. State carries the
            # canonical value (see ``delegation_with_parent`` above).
            "parent_thread_id": parent_thread_id,
            # Codex P1 review 2026-05-22: explicitly populate
            # ``graph_id`` so tools running inside the builder run can
            # gate behaviour by it (see
            # ``deerflow.sandbox.tools._is_builder_runtime_context``).
            # langgraph_api propagates this server-side for logging
            # but does NOT guarantee it lands in
            # ``runtime.config["configurable"]`` at tool-execution
            # time — explicit is safe.
            "graph_id": _ASYNC_BUILDER_AGENT_NAME,
        }
    }
    if parent_model:
        run_config["configurable"]["model_name"] = parent_model

    run = await client.runs.create(
        thread_id=thread_id,
        assistant_id=_ASYNC_BUILDER_AGENT_NAME,
        input=run_input,
        config=run_config,
        # stream_resumable=True is REQUIRED for the gateway-side
        # ``BuilderProgressSubscriber`` to see events via the HTTP
        # ``runs.join_stream`` consumer. Without it, the run produces
        # events internally but the langgraph server does NOT buffer
        # them for late-joining HTTP subscribers, and ``join_stream``
        # opens a 200 OK connection that never receives a chunk.
        #
        # Asymmetry note: this dispatch uses the SDK ASGI in-process
        # transport (``get_client(url=None)``); the subscriber dispatches
        # over HTTP. The ASGI transport bypasses the resumability buffer
        # the HTTP join_stream consumer depends on. Enabling resumability
        # here is what lets the HTTP path see anything.
        #
        # Regression: ``tests/test_start_builder_task.py::
        # test_dispatch_sets_stream_resumable_true``.
        stream_resumable=True,
    )
    return thread_id, run["run_id"]


async def _start_builder_task_impl(
    description: str,
    task_type: str,
    runtime: ToolRuntime[ContextT, SophiaState] | None,
    *,
    configured_user_id: str | None = None,
    user_id_arg: str | None = None,
) -> str | Command:
    """Async implementation. Mirrors ``switch_to_builder``'s shape but dispatches
    via deepagents-native ASGI transport instead of ``SubagentExecutor``.

    ``tool_call_id`` is read from ``runtime.tool_call_id``. Earlier we declared
    it via ``Annotated[str, InjectedToolCallId]`` on the tool signature, which
    LangChain silently drops when the tool is decorated with
    ``@tool(args_schema=…)`` (the public Pydantic schema doesn't list
    injected args, so the executor has no hook to populate them). The
    deepagents native lifecycle tools (``check_async_task`` etc.) and
    ``lead_agent``'s ``setup_agent_tool`` both source the id from runtime;
    this keeps us on the proven path.
    """
    # Validate ``tool_call_id`` BEFORE dispatch. Without it we cannot
    # construct a Command — LangGraph rejects ToolMessages whose
    # ``tool_call_id`` doesn't match the LLM's. Launching first and falling
    # back to a JSON-string return (the old ``switch_to_builder`` pattern)
    # would orphan the just-created LangGraph thread/run: the lifecycle
    # tools resolve tasks from ``state["async_tasks"]`` which we wouldn't
    # have written. Refuse to launch instead.
    tool_call_id = (
        runtime.tool_call_id
        if runtime is not None and getattr(runtime, "tool_call_id", None)
        else ""
    )
    if not tool_call_id:
        logger.error(
            "[Builder] start_builder_task invoked without tool_call_id "
            "(runtime=%s); refusing to launch (would orphan the builder run).",
            "missing" if runtime is None else "runtime present but tool_call_id empty",
        )
        return (
            "Cannot launch builder task right now: tool_call_id was not "
            "available on the tool runtime. No background work was started; "
            "safe to retry."
        )

    state: SophiaState = runtime.state if runtime is not None else {}  # type: ignore[assignment]
    if state is None:
        state = {}  # type: ignore[assignment]

    trace_id = str(uuid.uuid4())[:8]
    if runtime is not None and runtime.config:
        metadata = runtime.config.get("metadata", {}) or {}
        trace_id = metadata.get("trace_id") or trace_id

    # Duplicate-launch protection — read from native ``async_tasks`` channel.
    existing_task_id = _has_active_builder_task(state)
    if existing_task_id:
        logger.info(
            "[Builder] duplicate start_builder_task suppressed: task_id=%s",
            existing_task_id,
        )
        return (
            f"A builder task is already in progress (task_id={existing_task_id}). "
            f"DO NOT call start_builder_task again — duplicate launches are rejected.\n"
            f"Pick the lifecycle tool that matches the user's intent, then emit_artifact "
            f"ONCE with a short ack and end the turn:\n"
            f"- Modify scope (add/remove/change section, length, format): "
            f"update_async_task(task_id=\"{existing_task_id}\", message=<delta as builder instructions>) "
            f"→ ack like \"Got it, updating the build to include X.\"\n"
            f"- Status / progress check: check_async_task(task_id=\"{existing_task_id}\") "
            f"→ ack like \"Let me check on it now.\"\n"
            f"- User wants to stop the build: cancel_async_task(task_id=\"{existing_task_id}\") "
            f"→ ack like \"Got it, cancelling the build now.\"\n"
            f"- User referenced multiple tasks: list_async_tasks() "
            f"(no status_filter — pending and interrupted are also active; let the "
            f"caller see all builds) → ack like \"Pulling up your in-flight builds.\"\n"
            f"Use the FULL task_id verbatim — never truncate. Do not respond in plain text "
            f"without calling one of these. Never chain two lifecycle tools on the same turn."
        )

    companion_artifact, artifact_source, artifact_diagnostics = _resolve_companion_artifact(state)
    user_id, user_id_source, user_id_diagnostics = _resolve_user_id(
        runtime,
        state,
        configured_user_id=configured_user_id,
        explicit_tool_arg=user_id_arg,
    )
    handoff_resolution = {
        "user_id_source": user_id_source,
        "artifact_source": artifact_source,
        **user_id_diagnostics,
        **artifact_diagnostics,
    }

    active_ritual = state.get("active_ritual")
    ritual_phase = state.get("ritual_phase")
    memory_snippets = _resolve_memory_snippets(state)

    # Demo-prompt normalization preserves the deterministic small-deliverable
    # path users rely on for "test builder, make anything" smoke tests.
    description, task_type, demo_mode = _normalize_request(description, task_type, companion_artifact)

    allow_web_research = should_allow_builder_web_research(task_type, description)
    explicit_user_urls = extract_explicit_user_urls(description)
    builder_web_budget = make_builder_web_budget(task_type)
    artifact_target_path = _suggest_artifact_target_path(task_type, description)

    parent_thread_id = _resolve_thread_id(runtime)
    parent_model = None
    if runtime is not None and runtime.config:
        parent_model = (runtime.config.get("metadata", {}) or {}).get("model_name")

    enriched_description = _build_enriched_description(
        description,
        task_type,
        memory_snippets=memory_snippets,
        companion_artifact=companion_artifact,
        active_ritual=active_ritual,
        ritual_phase=ritual_phase,
        explicit_user_urls=explicit_user_urls,
    )

    delegation_context = _build_delegation_context(
        description=description,
        task_type=task_type,
        artifact_target_path=artifact_target_path,
        companion_artifact=companion_artifact,
        memory_snippets=memory_snippets,
        active_ritual=active_ritual,
        ritual_phase=ritual_phase,
        allow_web_research=allow_web_research,
        explicit_user_urls=explicit_user_urls,
        builder_web_budget=builder_web_budget,
        handoff_resolution=handoff_resolution,
    )

    logger.info(
        "[Builder] start_builder_task dispatching: task_type=%s allow_web_research=%s "
        "demo=%s tone=%s ritual=%s parent_thread=%s parent_model=%s user_id=%s "
        "user_id_source=%s artifact_source=%s explicit_url_count=%s search_limit=%s "
        "fetch_limit=%s target_ext=%s",
        task_type,
        allow_web_research,
        demo_mode,
        companion_artifact.get("tone_estimate"),
        active_ritual,
        parent_thread_id,
        parent_model,
        user_id,
        user_id_source,
        artifact_source,
        len(explicit_user_urls),
        builder_web_budget.get("search_limit"),
        builder_web_budget.get("fetch_limit"),
        Path(artifact_target_path).suffix.lower().lstrip("."),
    )

    # Codex P1/P2 PR #132 (latest iteration): the filenames the user
    # attached on THIS turn. Sourced from the per-run
    # ``runtime.config["configurable"]["current_turn_attached_files"]``
    # channel the frontend chat client populates — server-trusted (not a
    # spoofable parse of the message body) AND per-run (so a turn that
    # omits attachments reads empty instead of inheriting the prior
    # turn's persisted state). See ``_read_current_turn_attached_files``.
    current_turn_attachments = _extract_current_turn_attachment_filenames(runtime)

    try:
        task_id, run_id = await _dispatch_via_asgi(
            description=enriched_description,
            delegation_context=delegation_context,
            allow_web_research=allow_web_research,
            explicit_user_urls=explicit_user_urls,
            builder_web_budget=builder_web_budget,
            user_id=user_id,
            parent_thread_id=parent_thread_id,
            parent_model=parent_model,
            current_turn_attachments=current_turn_attachments,
        )
    except Exception as exc:  # noqa: BLE001 — LangGraph SDK raises untyped errors
        logger.warning("[Builder] ASGI dispatch failed: %s (trace=%s)", exc, trace_id)
        return f"Failed to launch builder task: {exc}. The user can retry; no background work was started."

    now = _utcnow_iso()
    async_task: dict[str, Any] = {
        "task_id": task_id,
        "agent_name": _ASYNC_BUILDER_AGENT_NAME,
        "thread_id": task_id,
        "run_id": run_id,
        "status": "running",
        "created_at": now,
        "last_checked_at": now,
        "last_updated_at": now,
        # Phase-1 extensions (not consumed by deepagents but useful for
        # debugging and Phase-3 BuildAwareness): preserve trace_id and
        # task_type alongside the canonical AsyncTask fields.
        "trace_id": trace_id,
        "task_type": task_type,
        "demo_mode": demo_mode,
        "artifact_target_path": artifact_target_path,
    }

    logger.info(
        "[Builder] start_builder_task launched: task_id=%s run_id=%s trace=%s allow_web_research=%s explicit_url_count=%s search_limit=%s fetch_limit=%s target_ext=%s",
        task_id,
        run_id,
        trace_id,
        allow_web_research,
        len(explicit_user_urls),
        builder_web_budget.get("search_limit"),
        builder_web_budget.get("fetch_limit"),
        Path(artifact_target_path).suffix.lower().lstrip("."),
    )

    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=(f"Launched builder task. task_id: {task_id}. It runs in the background — keep talking to the user. Use check_async_task only when the user asks."),
                    tool_call_id=tool_call_id,
                    name="start_builder_task",
                )
            ],
            "async_tasks": {task_id: async_task},
        }
    )


@tool("start_builder_task", parse_docstring=True)
async def start_builder_task(
    runtime: ToolRuntime,
    description: str,
    task_type: Literal["document", "research", "presentation", "frontend", "visual_report"],
    user_id: str | None = None,
) -> str | Command:
    """Delegate a long build task to Sophia's builder via deepagents async-subagent.

    Use for file creation, research with sources, document / presentation /
    visual_report generation. Do NOT use for emotional conversation,
    reflection, or memory tasks. Returns a task_id immediately; keep talking
    to the user. Call ``check_async_task`` only when the user asks for status.

    Args:
        description: Complete task description with all specs gathered from clarification. Be specific — the builder cannot ask follow-up questions. Include length, audience, tone, format, and any URLs the user provided.
        task_type: Type of deliverable. Determines builder skill loading and web research policy.
        user_id: Diagnostic hint only. Leave None in normal operation; trusted runtime identity always wins.
    """
    return await _start_builder_task_impl(
        description=description,
        task_type=task_type,
        runtime=runtime,
        user_id_arg=user_id,
    )


def make_start_builder_task_tool(configured_user_id: str):
    """Build a ``start_builder_task`` tool with ``user_id`` bound at construction.

    Mirrors ``make_switch_to_builder_tool`` so ``agent.py`` can swap one
    factory call for another. The bound ``configured_user_id`` is used as
    priority-4 in the resolution chain (after runtime config / context /
    state but before LLM tool args).
    """
    bound_user_id = _validate_user_id(configured_user_id)

    @tool("start_builder_task", parse_docstring=True)
    async def configured_start_builder_task(
        runtime: ToolRuntime,
        description: str,
        task_type: Literal["document", "research", "presentation", "frontend", "visual_report"],
        user_id: str | None = None,
    ) -> str | Command:
        """Delegate a long build task to Sophia's builder via deepagents async-subagent.

        Use for file creation, research with sources, document / presentation /
        visual_report generation. Do NOT use for emotional conversation,
        reflection, or memory tasks. Returns a task_id immediately; keep
        talking to the user. Call ``check_async_task`` only when the user asks
        for status.

        Args:
            description: Complete task description with all specs gathered from clarification. Be specific — the builder cannot ask follow-up questions. Include length, audience, tone, format, and any URLs the user provided.
            task_type: Type of deliverable. Determines builder skill loading and web research policy.
            user_id: Diagnostic hint only. Leave None in normal operation; trusted runtime identity always wins.
        """
        return await _start_builder_task_impl(
            description=description,
            task_type=task_type,
            runtime=runtime,
            configured_user_id=bound_user_id,
            user_id_arg=user_id,
        )

    return configured_start_builder_task
