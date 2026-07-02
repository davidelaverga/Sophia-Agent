"""Terminal-thread guard for the deepagents-native ``update_async_task``.

Phase 2B of the post-PR-#129 follow-up. The model-side fix in PR #129
correctly teaches the companion to call ``update_async_task`` on
modification cues mid-build — but when the user's update arrives AFTER
the builder has already reached terminal status (success / completed /
error / cancelled / etc.), the native ``update_async_task`` still
creates a new run on the just-finished builder thread.

The new run inherits a message history that already contains the
completed ``tool_use`` → ``tool_result`` → ``emit_builder_artifact``
sequence. The builder model then loops in ``DanglingToolCallMiddleware``
for minutes (~3.5 min in the 2026-05-20 19:53–19:57 incident),
locking the single worker (or, post-2A, one of the 10 workers) and
producing no useful output for the user.

This wrapper:

- Pre-screens the target ``task_id`` against
  ``async_tasks[task_id]["status"]`` (the cached status maintained by
  ``BuildAwarenessMiddleware``).
- If the cache says terminal — redirect with the directive ToolMessage,
  no SDK dispatch.
- If the cache says non-terminal — perform a **live** SDK re-check
  against the run before delegating. The cache can be up to
  ``BuildAwarenessMiddleware._REFRESH_TTL_SECONDS`` (~10s) stale, plus
  the model's own 2-3s decision latency on top, so a run that finished
  during the window can still appear running here. The live check
  closes this race. SDK failures fall back to the cache and delegate
  (fail-open — we never block on SDK transport issues).
- Otherwise delegates to the deepagents-native ``update_async_task``
  implementation (the wrapper holds a reference to it).

Registration mirrors the ``start_builder_task`` pattern in
``deerflow.agents.sophia_agent.agent``: the native tool is filtered out
of ``AsyncSubAgentMiddleware.tools`` and the wrapper is registered in
its place. The wrapped name is identical (``update_async_task``) so the
model's tool-selection from PR #129 remains valid.
"""

import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_core.tools.base import ToolException
from langgraph.types import Command

from deerflow.sophia.builder_web_policy import extract_explicit_user_urls
from deerflow.sophia.tools.start_builder_task import _TERMINAL_TASK_STATUSES

# NOTE: this module deliberately does NOT use `from __future__ import
# annotations`. LangChain's tool-runtime injection introspects parameter
# annotations to identify ToolRuntime-typed args (the marker for "inject
# this from the execution context, not from the model's tool_call"). With
# `from __future__ import annotations`, every annotation becomes a forward-
# reference STRING and the introspection comparison `annotation is
# ToolRuntime` fails — LangChain then calls the wrapper with only the
# args_schema fields and Python raises `TypeError: ... missing 1 required
# positional argument: 'runtime'`. This was the production failure at
# 2026-05-21 19:28 UTC. Keep annotations evaluated at runtime here.

logger = logging.getLogger(__name__)


def _unique_urls(urls: list[str] | tuple[str, ...] | None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for url in urls or []:
        normalized = str(url).strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _update_run_input(message: str, explicit_update_urls: list[str]) -> dict[str, Any]:
    run_input: dict[str, Any] = {"messages": [{"role": "user", "content": message}]}
    urls = _unique_urls(explicit_update_urls)
    if urls:
        run_input["explicit_user_urls"] = urls
        run_input["builder_allowed_urls"] = urls
        run_input["builder_update_required_urls"] = urls
    return run_input


def _native_update_context(native_callable: Any) -> tuple[dict[str, Any], Any] | None:
    closure = getattr(native_callable, "__closure__", None)
    names = getattr(getattr(native_callable, "__code__", None), "co_freevars", ())
    if not closure or not names:
        return None
    nonlocals = {
        name: cell.cell_contents
        for name, cell in zip(names, closure, strict=False)
    }
    agent_map = nonlocals.get("agent_map")
    clients = nonlocals.get("clients")
    if isinstance(agent_map, dict) and clients is not None:
        return agent_map, clients
    return None


def _updated_task_entry(
    tracked: dict[str, Any],
    run_id: str,
    delegation_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    task_id = str(tracked.get("task_id") or tracked.get("thread_id") or "")
    task = dict(tracked)
    task.update({
        "task_id": task_id,
        "agent_name": tracked["agent_name"],
        "thread_id": tracked["thread_id"],
        "run_id": run_id,
        "status": "running",
        "created_at": str(tracked.get("created_at") or now),
        "last_checked_at": str(tracked.get("last_checked_at") or now),
        "last_updated_at": now,
    })
    if task_type := _resolve_effective_task_type(tracked, delegation_context):
        task["task_type"] = task_type
    if target_ext := _resolve_artifact_target_ext(tracked, delegation_context):
        task["artifact_target_ext"] = target_ext
    return task


def _update_task_command(
    tracked: dict[str, Any],
    run_id: str,
    tool_call_id: str | None,
    delegation_context: dict[str, Any] | None = None,
) -> Command:
    task = _updated_task_entry(tracked, run_id, delegation_context)
    msg = f"Updated async subagent. task_id: {tracked['task_id']}"
    return Command(
        update={
            "messages": [ToolMessage(msg, tool_call_id=tool_call_id)],
            "async_tasks": {tracked["task_id"]: task},
        }
    )


def _update_run_config(
    runtime: ToolRuntime | None,
    tracked: dict[str, Any],
    delegation_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    configurable: dict[str, Any] = {
        "thread_id": tracked["thread_id"],
        "graph_id": tracked["agent_name"],
    }
    if task_type := _resolve_effective_task_type(tracked, delegation_context):
        configurable["task_type"] = task_type
    if target_ext := _resolve_artifact_target_ext(tracked, delegation_context):
        configurable["artifact_target_ext"] = target_ext
    runtime_config = getattr(runtime, "config", None)
    if isinstance(runtime_config, dict):
        source = runtime_config.get("configurable")
        if isinstance(source, dict):
            for key in ("user_id", "parent_thread_id", "model_name"):
                value = source.get(key)
                if isinstance(value, str) and value:
                    configurable[key] = value
    return {"configurable": configurable}


def _dispatch_update_with_url_state_sync(
    *,
    native_func: Any,
    task_id: str,
    message: str,
    explicit_update_urls: list[str],
    runtime: ToolRuntime,
    state: dict[str, Any] | None,
) -> Command | str | None:
    context = _native_update_context(native_func)
    tracked = _resolve_tracked(state, task_id)
    if context is None or tracked is None:
        return None
    agent_map, clients = context
    delegation_context = _state_delegation_context(state)
    try:
        spec = agent_map[tracked["agent_name"]]
        client = clients.get_sync(tracked["agent_name"])
        run = client.runs.create(
            thread_id=tracked["thread_id"],
            assistant_id=spec["graph_id"],
            input=_update_run_input(message, explicit_update_urls),
            config=_update_run_config(runtime, tracked, delegation_context),
            multitask_strategy="interrupt",
        )
    except Exception as exc:  # noqa: BLE001 - match native tool failure semantics.
        logger.warning("Failed to update async subagent '%s': %s", tracked.get("agent_name"), exc)
        return f"Failed to update async subagent: {exc}"
    return _update_task_command(tracked, run["run_id"], runtime.tool_call_id, delegation_context)


async def _dispatch_update_with_url_state_async(
    *,
    native_coroutine: Any,
    task_id: str,
    message: str,
    explicit_update_urls: list[str],
    runtime: ToolRuntime,
    state: dict[str, Any] | None,
) -> Command | str | None:
    context = _native_update_context(native_coroutine)
    tracked = _resolve_tracked(state, task_id)
    if context is None or tracked is None:
        return None
    agent_map, clients = context
    delegation_context = _state_delegation_context(state)
    try:
        spec = agent_map[tracked["agent_name"]]
        client = clients.get_async(tracked["agent_name"])
        run = await client.runs.create(
            thread_id=tracked["thread_id"],
            assistant_id=spec["graph_id"],
            input=_update_run_input(message, explicit_update_urls),
            config=_update_run_config(runtime, tracked, delegation_context),
            multitask_strategy="interrupt",
        )
    except Exception as exc:  # noqa: BLE001 - match native tool failure semantics.
        logger.warning("Failed to update async subagent '%s': %s", tracked.get("agent_name"), exc)
        return f"Failed to update async subagent: {exc}"
    return _update_task_command(tracked, run["run_id"], runtime.tool_call_id, delegation_context)


async def _fetch_live_status(tracked: dict[str, Any]) -> str | None:
    """Fetch live run status from the LangGraph SDK to defeat cache staleness.

    Returns the live status string on success, or ``None`` on any failure
    (SDK transport error, missing identifiers, non-dict response). Caller
    treats ``None`` as "no live signal — fall back to cached status",
    NEVER as "terminal". This is fail-open by design: an unreachable SDK
    must not block a legitimate update_async_task dispatch.

    Mirrors ``BuildAwarenessMiddleware._refresh_task_status`` — same
    in-process ASGI client (``url=None``), same exception-swallow
    semantics, same dict-shape tolerance.
    """
    thread_id = tracked.get("thread_id") or tracked.get("task_id")
    run_id = tracked.get("run_id")
    if not thread_id or not run_id:
        return None
    try:
        from langgraph_sdk import get_client  # local import: avoids hard dep at module load

        client = get_client(url=None)  # ASGI in-process
        run = await client.runs.get(thread_id=thread_id, run_id=run_id)
    except Exception:  # noqa: BLE001 — never let SDK errors raise out of the wrapper
        logger.debug(
            "update_async_task_wrapper: live status check failed for task_id=%s",
            tracked.get("task_id"),
            exc_info=True,
        )
        return None
    if isinstance(run, dict):
        status = run.get("status")
        if isinstance(status, str):
            return status
    return None


def _canonical_task_id(task_id: str, tracked: dict[str, Any]) -> str:
    """Return the canonical task_id for state writes and prose.

    The model may pass a task_id with leading/trailing whitespace. The
    ``async_tasks`` dict is keyed by the **canonical** (stripped) id —
    every code path that writes to ``async_tasks`` in deepagents-native
    and ``start_builder_task`` uses ``tracked["task_id"]`` as the key
    (see ``deepagents/middleware/async_subagents.py:547,586,637,669``).
    If we wrote back under the raw key, the original canonical entry
    would stay non-terminal and ``_has_active_builder_task`` would still
    see an active build → reject the follow-up ``start_builder_task``
    (codex P2 review 2026-05-21, whitespace-tolerance class).

    Prefers ``tracked["task_id"]`` (entries always carry their own id by
    convention); falls back to the stripped input as a defensive default.
    """
    canonical = tracked.get("task_id")
    if isinstance(canonical, str) and canonical:
        return canonical
    if isinstance(task_id, str):
        return task_id.strip()
    return task_id  # exotic shape — leave it alone


# Successful terminal statuses (artifact was delivered to the user).
# The complement — error / failed / cancelled / timeout / timed_out — is
# also terminal but means NO deliverable exists. Codex P2 review
# 2026-05-22: the redirect prose must branch on this distinction
# because telling the model "build on the prior artifact" when no prior
# artifact exists guides it to reference a non-existent file.
_SUCCESSFUL_TERMINAL_STATUSES = frozenset({"success", "completed"})


def _success_v2_strategy(task_type: str, prior_path: str | None, task_id: str) -> str:
    """Edit strategy for SUCCESSFUL terminal builds — the user got the prior
    artifact and now wants edits / additions."""
    if prior_path:
        return (
            f"The prior artifact lives at `{prior_path}`. Your NEXT tool call "
            f"MUST be edit_builder_artifact(message=..., "
            f"artifact_path=\"{prior_path}\", task_id=\"{task_id}\"). The edit "
            f"tool materializes the existing artifact into a new builder sandbox, "
            f"requires the builder to read it, build on what's already there, "
            f"preserves unrelated content, and emits a versioned revised artifact."
        )
    return (
        f"Your NEXT tool call MUST be edit_builder_artifact(message=..., "
        f"task_id=\"{task_id}\"). The tool will resolve the latest durable "
        f"artifact metadata from trusted session state. If it reports that no "
        f"source artifact is available, tell the user plainly and ask which file "
        f"to edit."
    )


def _failed_v2_strategy(task_type: str, status: str) -> str:
    """Fresh-start strategy for FAILED terminal builds (error / failed /
    cancelled / timeout / timed_out) — no prior artifact exists, so the
    model must NOT reference one."""
    return (
        f"The previous attempt ended in `{status}` — NO deliverable was "
        f"produced. Do NOT instruct the new build to read / edit any prior "
        f"artifact; there isn't one.\n"
        f"\n"
        f"Your NEXT tool call MUST be start_builder_task(description=..., "
        f"task_type=\"{task_type}\") with a COMPLETE brief that re-states the "
        f"user's original requirements PLUS the addition / change they just "
        f"asked for. The new build starts from a clean slate."
    )


def _prior_artifact_path_from_tracked(tracked: dict[str, Any]) -> str | None:
    prior_path = tracked.get("artifact_path")
    if isinstance(prior_path, str) and prior_path.strip():
        return prior_path
    builder_result = tracked.get("builder_result")
    if not isinstance(builder_result, dict):
        return None
    candidate = builder_result.get("artifact_path")
    return candidate if isinstance(candidate, str) and candidate.strip() else None


def _terminal_redirect_parts(
    *,
    status: str,
    task_type: str,
    prior_path: str | None,
    canonical_id: str,
) -> tuple[str, str, str]:
    if status in _SUCCESSFUL_TERMINAL_STATUSES:
        return (
            f"The previous {task_type} artifact has already been delivered to "
            f"the user (Telegram / web). The user has it.",
            _success_v2_strategy(task_type, prior_path, canonical_id),
            "Got it — revising the delivered artifact now.",
        )
    return (
        f"The previous attempt is in `{status}` state — NO artifact was "
        f"delivered to the user. Do NOT tell the user they have the prior "
        f"version; they don't.",
        _failed_v2_strategy(task_type, status),
        "Got it — the previous build didn't complete. Starting a fresh "
        "one with your request included.",
    )


def _terminal_redirect_message(
    task_id: str,
    tracked: dict[str, Any],
    delegation_context: dict[str, Any] | None = None,
) -> str:
    """Build the directive ToolMessage returned to the model when the target
    builder has already reached terminal status.

    The interpolated task_id is normalized to the canonical form so any
    follow-up tool calls (e.g. the model copying it into a description)
    use the canonical id, not the whitespace-padded raw form.

    Phase 2E.3: if the tracked entry carries an ``artifact_path`` (the
    prior builder run delivered a real artifact), the redirect prose
    NAMES that path and instructs the new build to READ + EDIT the
    existing file rather than re-running full research from scratch.

    Codex P2 review 2026-05-22: terminal includes `error` / `failed` /
    `cancelled` / `timeout` / `timed_out` where NO artifact was
    delivered. The successful vs failed branches give different
    guidance so the model doesn't claim a non-existent artifact was
    delivered to the user.

    Codex P1 review 2026-05-22: ``task_type`` is now resolved via
    ``_safe_task_type`` so the redirect always names a value in
    ``_CANONICAL_TASK_TYPES`` (document / research / presentation /
    frontend / visual_report). The prior ``or "build"`` default
    produced an invalid value that would fail
    ``start_builder_task``'s ``StartBuilderTaskInput`` validation —
    especially common after a mid-build update_async_task interrupt
    that rewrites ``async_tasks[task_id]`` without preserving
    ``task_type``. ``delegation_context`` is now threaded through
    callers so the lookup can fall back to it.
    """
    status = tracked.get("status", "unknown")
    task_type = _safe_task_type(tracked, delegation_context)
    canonical_id = _canonical_task_id(task_id, tracked)
    delivery_line, v2_strategy, ack_example = _terminal_redirect_parts(
        status=status,
        task_type=task_type,
        prior_path=_prior_artifact_path_from_tracked(tracked),
        canonical_id=canonical_id,
    )

    return (
        f"The builder task (task_id={canonical_id}) has already reached terminal "
        f"status (status={status}). update_async_task CANNOT modify a finished "
        f"build — its dispatch would create a new run on a thread whose "
        f"message history is already complete, looping the builder on dangling "
        f"tool calls.\n"
        f"\n"
        f"{delivery_line}\n"
        f"\n"
        f"{v2_strategy}\n"
        f"\n"
        f"emit_artifact ONCE on the same turn with takeaway like "
        f"\"{ack_example}\"\n"
        f"\n"
        f"Do NOT call update_async_task again on this task_id — it is terminal."
    )


# Sentinel substring used to detect whether a message has already been
# augmented by ``_augment_update_message``. Must be stable across calls
# because we want idempotency: the model may retry or compose multi-turn
# updates and we don't want the directive duplicated.
_FILE_TARGET_HINT_MARKER = "[Sophia/post-interrupt build directive]"


# Mapping from start_builder_task's task_type to a canonical artifact
# extension. Used by ``_suggest_artifact_filename`` to give the builder a
# concrete file target on post-interrupt resume.
_TASK_TYPE_EXTENSIONS = {
    "document": "md",
    "research": "md",
    "presentation": "pptx",
    "frontend": "html",
    "visual_report": "pdf",
}

_HTML_OUTPUT_RE = re.compile(
    r"\b(?:html\s+(?:artifact|document|file|report|summary|brief|article|explainer|page|site|website)"
    r"|(?:artifact|document|file|report|summary|brief|article|explainer|page|site|website)\s+(?:as|in)\s+html"
    r"|(?:build|create|make|generate|produce|write)\s+(?:an?\s+)?html\b"
    r"|\.html\b)",
    re.IGNORECASE,
)
_PDF_OUTPUT_RE = re.compile(
    r"\b(?:"
    r"pdf\s+(?:document|file|report|summary|brief|article|explainer|deliverable|artifact|output)"
    r"|(?:document|file|report|summary|brief|article|explainer|presentation|slides?|deck|deliverable|artifact|output|final|export)"
    r"\s+(?:as|in|to)\s+(?:an?\s+)?pdf"
    r"|(?:build|create|make|generate|produce|write|render|export)\s+(?:an?\s+)?pdf\b"
    r"|(?:build|create|make|generate|produce|write|render|export)\s+[^.?!\n]{0,80}?\s+as\s+(?:an?\s+)?pdf\b"
    r"|\.pdf\b"
    r")",
    re.IGNORECASE,
)
_PPTX_OUTPUT_RE = re.compile(
    r"\b(?:pptx|powerpoint|power\s*point|slide\s+deck|slides?)\b",
    re.IGNORECASE,
)
_REQUESTED_OUTPUT_EXTENSION_PATTERNS = (
    ("pptx", _PPTX_OUTPUT_RE),
    ("pdf", _PDF_OUTPUT_RE),
    ("docx", re.compile(r"\b(?:docx|word\s+document)\b", re.IGNORECASE)),
    ("xlsx", re.compile(r"\b(?:xlsx|spreadsheet|excel)\b", re.IGNORECASE)),
    ("html", _HTML_OUTPUT_RE),
    ("md", re.compile(r"\b(?:markdown|md)\b", re.IGNORECASE)),
    ("csv", re.compile(r"\bcsv\b", re.IGNORECASE)),
    ("json", re.compile(r"\bjson\b", re.IGNORECASE)),
)

_FALLBACK_TASK_SLUG = "build"
_MAX_SLUG_SOURCE_CHARS = 60


def _slugify_for_filename(text: str, max_len: int = 40) -> str:
    """Produce a deterministic, filesystem-safe slug from free-form text.

    Lowercase, ASCII alphanumerics + hyphens only, max length capped. Used
    to derive a stable suggested filename across retries: same input →
    same slug → same filename. The builder model uses this as a concrete
    anchor instead of inventing scratch names like ``test.md``.
    """
    if not isinstance(text, str):
        return _FALLBACK_TASK_SLUG
    # Take the first chunk so the slug remains short even for verbose briefs.
    head = text.strip()[:_MAX_SLUG_SOURCE_CHARS]
    # Lowercase + non-alphanumeric → hyphen.
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


def _suggest_artifact_filename(
    task_type: str | None, description: str | None
) -> str:
    """Build a concrete filename to suggest to the builder after an interrupt.

    Format: ``{slug-of-description}.{ext-from-task_type}``. Deterministic so
    the model can converge on the same target across retries. Falls back to
    ``build.md`` when both inputs are missing.
    """
    ext = _requested_output_extension(description) or _TASK_TYPE_EXTENSIONS.get(task_type or "", "md")
    slug = _slugify_for_filename(description or _FALLBACK_TASK_SLUG)
    return f"{slug}.{ext}"


def _extract_str(d: dict[str, Any] | None, key: str) -> str | None:
    """Return ``d[key]`` only if it's a non-empty string; else None.
    Used to thread tolerantly through possibly-malformed state dicts
    without verbose isinstance ladders at every callsite."""
    if not isinstance(d, dict):
        return None
    value = d.get(key)
    return value if isinstance(value, str) and value else None


# Codex P1 review 2026-05-22: binary deliverables (.pptx / .pdf) don't get
# told to use write_file_tool — they need a generator script run via bash.
# 2026-05-30 update: branch on the concrete target extension, not task_type,
# because visual_report can still be an HTML deliverable.
_BINARY_OUTPUT_TASK_TYPES = frozenset({"presentation", "visual_report"})
_TEXT_TARGET_EXTENSIONS = frozenset({
    "html",
    "htm",
    "md",
    "txt",
    "json",
    "csv",
    "yaml",
    "yml",
    "js",
    "ts",
    "css",
})
_BINARY_TARGET_EXTENSIONS = frozenset({
    "pdf",
    "pptx",
    "docx",
    "xlsx",
    "png",
    "jpg",
    "jpeg",
})

# Canonical task_type values accepted by ``start_builder_task``'s
# ``StartBuilderTaskInput`` schema. The terminal-redirect prose must
# only suggest values from this set so the model's follow-up
# ``start_builder_task(task_type=...)`` call passes validation.
# Codex P1 review 2026-05-22: the prior ``or "build"`` default
# produced an invalid value that would fail validation.
_CANONICAL_TASK_TYPES = frozenset({
    "document",
    "research",
    "presentation",
    "frontend",
    "visual_report",
})
_DEFAULT_TASK_TYPE = "document"  # safest generic; markdown output


def _safe_task_type(
    tracked: dict[str, Any] | None,
    delegation_context: dict[str, Any] | None,
) -> str:
    """Resolve a task_type that is guaranteed to be in
    ``_CANONICAL_TASK_TYPES``. Tries tracked first, then
    delegation_context, and only returns a value that's canonical at
    each step. If neither has a valid value, falls back to
    ``"document"`` (the safest generic).

    Critical: the prior ``tracked.get("task_type") or "build"`` default
    produced ``"build"``, which is NOT in the canonical set —
    ``start_builder_task`` would reject failed-run retries with a
    validation error.

    Importantly, if ``tracked["task_type"]`` is a non-canonical value
    (state corruption, schema drift), we ALSO fall through to
    delegation_context rather than getting stuck on the garbage value.
    """
    for source in (tracked, delegation_context):
        candidate = _extract_str(source, "task_type")
        if candidate in _CANONICAL_TASK_TYPES:
            return candidate
    return _DEFAULT_TASK_TYPE


def _resolve_effective_task_type(
    tracked: dict[str, Any] | None,
    delegation_context: dict[str, Any] | None,
) -> str | None:
    """Same lookup priority as ``_resolve_target_path``: tracked entry
    first, then delegation_context. Returned for use by directive
    branching below."""
    return _extract_str(tracked, "task_type") or _extract_str(
        delegation_context, "task_type"
    )


def _normal_target_ext(value: str | None) -> str | None:
    if not value:
        return None
    ext = value.strip().lower()
    if not ext:
        return None
    if not ext.startswith("."):
        ext = f".{ext}"
    return ext if re.fullmatch(r"\.[a-z0-9]{1,12}", ext) else None


def _resolve_artifact_target_ext(
    tracked: dict[str, Any] | None,
    delegation_context: dict[str, Any] | None,
) -> str | None:
    for source in (tracked, delegation_context):
        target_ext = _normal_target_ext(_extract_str(source, "artifact_target_ext"))
        if target_ext:
            return target_ext
    target_path = _extract_str(tracked, "artifact_target_path") or _extract_str(
        delegation_context, "artifact_target_path"
    )
    return _normal_target_ext(Path(target_path or "").suffix)


def _resolve_target_path(
    tracked: dict[str, Any] | None,
    delegation_context: dict[str, Any] | None,
) -> str:
    """Resolve the concrete file path to inject into the augmented message.

    Priority:
      1. ``tracked["artifact_path"]`` — the prior run delivered something
         on disk; continue editing exactly that.
      2. ``tracked["artifact_target_path"]`` or
         ``delegation_context["artifact_target_path"]`` — the canonical
         target selected at initial launch before any deliverable existed.
      3. Derived ``/mnt/user-data/outputs/<slug>.<ext>`` from the
         delegation_context's original task brief + task_type.
    """
    prior_path = _extract_str(tracked, "artifact_path")
    if prior_path:
        return prior_path
    tracked_target = _extract_str(tracked, "artifact_target_path")
    if tracked_target:
        return tracked_target
    delegated_target = _extract_str(delegation_context, "artifact_target_path")
    if delegated_target:
        return delegated_target
    task_type = _resolve_effective_task_type(tracked, delegation_context)
    description = _extract_str(delegation_context, "task")
    suggested = _suggest_artifact_filename(task_type, description)
    return f"/mnt/user-data/outputs/{suggested}"


def _target_extension(target_path: str | None) -> str:
    return Path(target_path or "").suffix.lower().lstrip(".")


def _target_uses_text_writer(target_path: str, task_type: str | None) -> bool:
    ext = _target_extension(target_path)
    if ext in _TEXT_TARGET_EXTENSIONS:
        return True
    if ext in _BINARY_TARGET_EXTENSIONS:
        return False
    return task_type not in _BINARY_OUTPUT_TASK_TYPES


def _file_target_directive_block(target_path: str, task_type: str | None) -> str:
    """Build the "Concrete file target" + HARD rules block, branched by the
    concrete target extension. Binary deliverables (.pptx/.pdf) cannot be
    authored by ``write_file_tool`` directly (it writes text bytes only), while
    HTML reports remain text deliverables even when task_type is visual_report.

    Codex P1 review 2026-05-22: the prior universal "MUST use
    write_file_tool" rule was incompatible with binary task_types.
    """
    target_ext = _target_extension(target_path)
    if target_ext == "pptx":
        return (
            f"Concrete file target: `{target_path}`. This is a PPTX slide-deck "
            "update. The deliverable must come from the ppt-generation HTML-slide "
            "to PPTX workflow, not ad hoc python-pptx/write_file loops.\n"
            "\n"
            "HARD rules:\n"
            "  - Read `/mnt/skills/public/ppt-generation/SKILL.md` if needed, "
            "then create one generated visual asset per slide, including the cover, "
            "unless the user explicitly requested a plain text-only/no-visual deck.\n"
            "  - Prepare prompt JSON files and run one manifest batch with "
            "`/mnt/skills/public/image-generation/scripts/generate.py --manifest <path>` "
            "into `/mnt/user-data/outputs/assets/`; if the readable batch fails or "
            "is partial, repair only the failed or missing images serially with the "
            "same prompt and output paths.\n"
            "  - Write one 1920x1080 HTML file per slide under "
            "`/mnt/user-data/outputs/slides/`; each normal slide must reference its "
            "generated asset via a relative `../assets/<file>` path and carry text "
            "as DOM text rather than baked into the generated visual.\n"
            "  - Compile with "
            "`build_deck_from_slides(output_path=\"/mnt/user-data/outputs/<deck>.pptx\", title=\"...\")` "
            "only after all expected generated visuals exist and are referenced.\n"
            "  - Do NOT call `write_file` to author the PPTX binary and do NOT "
            "create Python deck scripts as the user-ready artifact.\n"
            "  - Emit only after a valid `.pptx` exists under "
            "`/mnt/user-data/outputs/`. If complete visuals cannot be produced after "
            "bounded batch plus serial recovery, report the failure honestly instead "
            "of emitting a source, no-image, or partial deck."
        )
    if target_ext == "pdf":
        return (
            f"Concrete file target: `{target_path}`. This is a PDF report/document "
            "update. Repair the HTML source under `/mnt/user-data/outputs/`, then "
            "render the PDF with `render_html_to_pdf`.\n"
            "\n"
            "HARD rules:\n"
            "  - Do NOT create reportlab, weasyprint, chart-visualization, or "
            "ad hoc binary generator scripts for this PDF path.\n"
            "  - Keep charts/diagrams as visible inline static SVG or local output "
            "assets referenced by the HTML source; do not rely on browser scripts "
            "or unavailable chart tools.\n"
            "  - Call `render_html_to_pdf(html_path=..., pdf_path=...)` with the "
            "final `pdf_path` under `/mnt/user-data/outputs/`.\n"
            "  - After the PDF exists, call `emit_builder_artifact` with "
            f"`{target_path}` (or the final rendered PDF path) and STOP."
        )
    if not _target_uses_text_writer(target_path, task_type):
        return (
            f"Concrete file target: `{target_path}`. The deliverable for "
            f"`{task_type or 'this task'}` is a BINARY file — author a generator script "
            f"(e.g. Python with python-pptx, reportlab, weasyprint, or the "
            f"chart-visualization / ppt-generation skill scripts) and run "
            f"it via `bash_tool`. The script may live anywhere; only the "
            f"final binary path matters.\n"
            f"\n"
            f"HARD rules:\n"
            f"  - The final deliverable path MUST be under "
            f"`/mnt/user-data/outputs/`.\n"
            f"  - DO NOT call `write_file` to author the binary "
            f"content directly — that tool writes text bytes only. Use it "
            f"for the generator SCRIPT, not the binary output.\n"
            f"  - After the binary file is on disk under "
            f"`/mnt/user-data/outputs/`, call `emit_builder_artifact` with "
            f"`{target_path}` (or your chosen final path) and STOP."
        )
    return (
        f"Concrete file target: `{target_path}`. Write the final document to "
        f"that exact path (or, for very long documents, open with "
        f"`write_file(description=..., path=..., content=..., append=False)` and extend via "
        f"`append=True` chunks — same path each time).\n"
        f"\n"
        f"If the target is HTML, charts and diagrams should be embedded or "
        f"linked from supporting files, but the final artifact is still the "
        f"HTML file named above.\n"
        f"\n"
        f"HARD rules:\n"
        f"  - All `write_file` paths MUST start with "
        f"`/mnt/user-data/outputs/`.\n"
        f"  - DO NOT create `test.md`, `test2.md`, or any scratch filename.\n"
        f"  - After the file is complete, call `emit_builder_artifact` with "
        f"`{target_path}` (or your chosen final path) and STOP."
    )


_DELTA_DIGEST_CAP_CHARS = 700


def _delta_digest_block(
    state: dict | None,
    delegation_context: dict[str, Any] | None,
) -> str:
    """Spec D D-2: digest of companion turns SINCE dispatch, for a running build.

    Reads the delegation ledger (this wrapper runs companion-side, so the
    current session's ledger is local) and renders entries with
    ``turn_number > dispatched_at_turn`` — both sides of that comparison
    use LEDGER numbering, which survives compaction. Returns "" whenever
    anything is missing — the directive is unchanged in that case.
    """
    from deerflow.sophia import delegation_ledger

    if not isinstance(delegation_context, dict) or not delegation_ledger.digest_enabled():
        return ""
    dispatched_at_turn = delegation_context.get("dispatched_at_turn")
    parent_thread_id = delegation_context.get("parent_thread_id")
    user_id = None
    if isinstance(state, dict):
        user_id = state.get("user_id")
    user_id = user_id or delegation_context.get("parent_user_id")
    if not isinstance(dispatched_at_turn, int) or not parent_thread_id or not user_id:
        return ""
    entries = delegation_ledger.read_ledger(str(user_id), str(parent_thread_id))
    delta = [
        entry
        for entry in entries
        if isinstance(entry.get("turn_number"), int)
        and entry["turn_number"] > dispatched_at_turn
    ]
    if not delta:
        return ""
    digest = delegation_ledger.build_digest(
        delta, cap_chars=_DELTA_DIGEST_CAP_CHARS, min_entries=1
    )
    if not digest:
        return ""
    return f"[Conversation since dispatch]\n{digest}\n\n"


def _augment_update_message(
    message: str,
    tracked: dict[str, Any] | None,
    delegation_context: dict[str, Any] | None,
    state: dict | None = None,
) -> str:
    """PREFIX the user's update message with a "resume not restart" directive
    that gives the builder a concrete file target and steers it away from
    creating scratch files (``test.md``, ``test2.md``, etc.) and from
    re-running research it already completed pre-interrupt.

    Phase 2F.1 (2026-05-22): the original Phase 2E.2 directive was appended
    AFTER the user's message. Empirically the model anchored on the user's
    text (at the top of the new HumanMessage) and the directive at the
    bottom was overridden by the original system prompt's "research then
    write" workflow — see plan file Phase 2F root-cause analysis. This
    version prefixes the directive AND names a deterministic target
    filename derived from the original task brief.

    Idempotent: if the marker is already present in ``message``, the
    function returns ``message`` unchanged so a retry / double-dispatch
    doesn't pile up directives.
    """
    if not isinstance(message, str) or _FILE_TARGET_HINT_MARKER in message:
        return message

    target_path = _resolve_target_path(tracked, delegation_context)
    task_type = _resolve_effective_task_type(tracked, delegation_context)
    target_block = _file_target_directive_block(target_path, task_type)
    explicit_update_urls = extract_explicit_user_urls(message)
    if explicit_update_urls:
        research_block = (
            "This update contains explicit URL(s). They are approved fetch "
            "targets. Before editing the deliverable, use builder_web_fetch "
            "on the exact new URL(s), or builder_web_search if fetch is "
            "unavailable, then incorporate the findings.\n"
        )
    else:
        research_block = (
            "Preserve and reuse prior research from the message history above. "
            "If this update introduces a new named project, paper, framework, "
            "company, market, factual topic, or source requirement, call "
            "builder_web_search or builder_web_fetch for that new material "
            "before editing the deliverable.\n"
        )

    delta_block = _delta_digest_block(state, delegation_context)
    directive = (
        f"{_FILE_TARGET_HINT_MARKER}\n"
        f"You are RESUMING (not restarting) a build that was interrupted by "
        f"this update message. {research_block}"
        f"\n"
        f"{delta_block}"
        f"{target_block}\n"
        f"\n"
        f"User's update message:\n"
        f"{message}"
    )
    return directive


def _resolve_tracked(state: dict | None, task_id: str) -> dict | None:
    """Look up the tracked task entry from ``state["async_tasks"]``.

    Returns the entry dict on success, ``None`` if the state shape is
    unexpected or the task is not tracked. Tolerates both the exact
    ``task_id`` and a stripped variant (matches the deepagents-native
    ``_resolve_tracked_task`` lookup semantics).
    """
    if not isinstance(state, dict):
        return None
    tasks = state.get("async_tasks") or {}
    if not isinstance(tasks, dict):
        return None
    key = task_id.strip() if isinstance(task_id, str) else task_id
    tracked = tasks.get(task_id) or tasks.get(key)
    return tracked if isinstance(tracked, dict) else None


def _state_delegation_context(state: dict | None) -> dict[str, Any] | None:
    """Extract ``delegation_context`` from ``state`` if it's a dict.
    Threaded into ``_terminal_redirect_message`` callers so the
    task_type fallback (codex P1 review 2026-05-22) can pick the
    correct value when the tracked entry has dropped it."""
    if not isinstance(state, dict):
        return None
    dc = state.get("delegation_context")
    return dc if isinstance(dc, dict) else None


def _cache_redirect_if_terminal(task_id: str, state: dict | None) -> str | None:
    """If the cached status is terminal, log + return the redirect string.
    Otherwise return ``None`` so the caller delegates to the native dispatch.
    Used by both sync and async paths.
    """
    tracked = _resolve_tracked(state, task_id)
    if tracked is None or tracked.get("status") not in _TERMINAL_TASK_STATUSES:
        return None
    logger.info(
        "[Builder] update_async_task redirected: task_id=%s "
        "status=%s (terminal — directing model to edit_builder_artifact/start_builder_task by outcome)",
        task_id,
        tracked.get("status"),
    )
    return _terminal_redirect_message(
        task_id, tracked, _state_delegation_context(state)
    )


async def _live_terminal_redirect(
    task_id: str, state: dict | None
) -> tuple[str, dict[str, dict]] | None:
    """Async-only second-pass check used when the cache says non-terminal.
    Re-checks live SDK status to defeat cache staleness
    (BuildAwarenessMiddleware TTL ~10s + model decision latency ~3s).

    Returns:
        - ``(redirect_msg, async_tasks_update)`` tuple when the live status
          is terminal but the cached status was not. The caller MUST persist
          the state update — otherwise the model's follow-up lifecycle call
          will read the stale non-terminal cache via
          ``_has_active_builder_task`` and reject the revision or relaunch as
          a duplicate (codex P1 review, 2026-05-21).
        - ``None`` when there is nothing to redirect: no tracked task,
          cache already terminal (handled by the cache-only helper), live
          status is non-terminal, or the SDK call failed (fail-open).
    """
    tracked = _resolve_tracked(state, task_id)
    if tracked is None:
        return None  # Unknown task — let native return its own error.
    if tracked.get("status") in _TERMINAL_TASK_STATUSES:
        return None  # Already handled by the cache-only path.
    live_status = await _fetch_live_status(tracked)
    if live_status not in _TERMINAL_TASK_STATUSES:
        return None  # Still running or SDK failed — delegate.

    tracked_now = {**tracked, "status": live_status}
    canonical_id = _canonical_task_id(task_id, tracked_now)
    logger.info(
        "[Builder] update_async_task redirected (live-check caught "
        "stale cache): raw_task_id=%r canonical_task_id=%s cached_status=%s "
        "live_status=%s",
        task_id,
        canonical_id,
        tracked.get("status"),
        live_status,
    )
    redirect = _terminal_redirect_message(
        task_id, tracked_now, _state_delegation_context(state)
    )
    # Key the state update by the CANONICAL id so the reducer merges into
    # the existing entry rather than creating a phantom whitespace-keyed
    # duplicate (codex P2 review 2026-05-21).
    return redirect, {canonical_id: tracked_now}


def make_update_async_task_wrapper(native_tool: StructuredTool) -> StructuredTool:
    """Build a terminal-thread-guarded wrapper around the deepagents-native
    ``update_async_task`` tool.

    The wrapper holds a reference to the native tool's underlying ``func`` /
    ``coroutine`` so it can delegate on the non-terminal path without
    re-implementing the SDK dispatch logic that lives in
    ``deepagents.middleware.async_subagents``.
    """
    if native_tool is None:
        raise ValueError(
            "make_update_async_task_wrapper requires the native "
            "update_async_task StructuredTool — pass the instance from "
            "AsyncSubAgentMiddleware.tools before filtering it out."
        )
    if native_tool.name != "update_async_task":
        raise ValueError(
            f"Expected native tool named 'update_async_task', got "
            f"{native_tool.name!r}."
        )

    native_func = native_tool.func
    native_coroutine = native_tool.coroutine

    def update_async_task(
        task_id: str,
        message: str,
        runtime: ToolRuntime,
    ):
        # Sync path: cache-only check. The live SDK call is async-only;
        # production langgraph always uses the async coroutine below. Sync
        # is exercised by tests only. Mirrors BuildAwareness's sync/async
        # asymmetry (sync `before_agent` is cache-only; async refreshes).
        state = runtime.state if runtime is not None else {}
        redirect = _cache_redirect_if_terminal(task_id, state)
        if redirect is not None:
            return redirect
        if native_func is None:
            raise ToolException(
                "Native update_async_task sync func is unavailable; call this "
                "tool from the async path or upgrade deepagents."
            )
        # Phase 2E.2: augment the user's message with a file-target directive
        # so the post-interrupt builder doesn't create scratch files.
        augmented = _augment_update_message(
            message,
            _resolve_tracked(state, task_id),
            state.get("delegation_context") if isinstance(state, dict) else None,
            state=state if isinstance(state, dict) else None,
        )
        explicit_update_urls = extract_explicit_user_urls(message)
        state_result = _dispatch_update_with_url_state_sync(
            native_func=native_func,
            task_id=task_id,
            message=augmented,
            explicit_update_urls=explicit_update_urls,
            runtime=runtime,
            state=state,
        )
        if state_result is not None:
            return state_result
        return native_func(task_id=task_id, message=augmented, runtime=runtime)

    async def aupdate_async_task(
        task_id: str,
        message: str,
        runtime: ToolRuntime,
    ):
        state = runtime.state if runtime is not None else {}

        # Cache-only first: if the cached status is already terminal,
        # ``start_builder_task._has_active_builder_task`` will return None
        # on the follow-up lifecycle call (because terminal statuses are
        # filtered), so the model can revise or retry without us touching
        # state here. Plain string return is sufficient.
        cache_redirect = _cache_redirect_if_terminal(task_id, state)
        if cache_redirect is not None:
            return cache_redirect

        # Live SDK re-check: the cache may be ~10s stale plus model
        # decision latency. If live status is terminal but cached is not,
        # we MUST persist the fresh status into ``async_tasks`` —
        # otherwise the model's follow-up lifecycle tool reads the stale
        # cache via ``_has_active_builder_task`` and rejects the revision
        # or retry as a duplicate (codex P1 review 2026-05-21).
        live_result = await _live_terminal_redirect(task_id, state)
        if live_result is not None:
            redirect_msg, async_tasks_update = live_result
            tool_call_id = getattr(runtime, "tool_call_id", None) if runtime is not None else None
            if tool_call_id:
                return Command(
                    update={
                        "messages": [
                            ToolMessage(redirect_msg, tool_call_id=tool_call_id)
                        ],
                        "async_tasks": async_tasks_update,
                    }
                )
            # Degraded fallback when tool_call_id is unavailable (rare —
            # only in synthetic / test contexts). The redirect text still
            # reaches the model via the tool's normal return path, but the
            # state update is lost; the follow-up lifecycle tool may then
            # reject the revision or retry as a duplicate. Production always
            # provides tool_call_id (set by the LangGraph tool executor).
            logger.warning(
                "[Builder] live-terminal redirect could not persist state "
                    "update (no tool_call_id on runtime); edit_builder_artifact "
                    "may reject the revision on stale cache."
                )
            return redirect_msg

        if native_coroutine is None:
            raise ToolException(
                "Native update_async_task coroutine is unavailable."
            )
        # Phase 2E.2: augment the user's message with a file-target directive
        # so the post-interrupt builder continues writing to the correct
        # /mnt/user-data/outputs/ path instead of inventing scratch filenames.
        # Production failure 2026-05-21 21:18 UTC: without this hint the
        # builder loops on write_file(test.md), write_file(test2.md), etc.
        augmented = _augment_update_message(
            message,
            _resolve_tracked(state, task_id),
            state.get("delegation_context") if isinstance(state, dict) else None,
            state=state if isinstance(state, dict) else None,
        )
        explicit_update_urls = extract_explicit_user_urls(message)
        state_result = await _dispatch_update_with_url_state_async(
            native_coroutine=native_coroutine,
            task_id=task_id,
            message=augmented,
            explicit_update_urls=explicit_update_urls,
            runtime=runtime,
            state=state,
        )
        if state_result is not None:
            return state_result
        return await native_coroutine(
            task_id=task_id, message=augmented, runtime=runtime
        )

    return StructuredTool.from_function(
        name=native_tool.name,
        func=update_async_task,
        coroutine=aupdate_async_task,
        description=native_tool.description,
        infer_schema=False,
        args_schema=native_tool.args_schema,
    )
