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

import logging
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.builder_web_policy import extract_explicit_user_urls
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.supabase_mirror import maybe_mirror_file

logger = logging.getLogger(__name__)


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
                # Extract the skill folder name: ``…/skills/<name>/SKILL.md``.
                segment = path.split("/skills/", 1)[1].split("/", 1)[0]
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
                if (
                    f"/skills/{skill_name}/" in cmd
                    or f"/mnt/skills/{skill_name}/" in cmd
                ):
                    logger.info("[BuilderSkill] script_invoked: skill=%s", skill_name)
                    break


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_BUILDER_WRITE_TOOL_NAMES = {"write_file", "write_file_tool"}
_BUILDER_RESEARCH_TOOL_NAMES = {"builder_web_search", "builder_web_fetch"}
_BUILDER_SUBSTANTIVE_TOOL_NAMES = {
    "write_file",
    "write_file_tool",
    "str_replace",
    "str_replace_tool",
    "emit_builder_artifact",
}
_SAFE_BASH_COMMAND_RE = re.compile(
    r"^\s*(?:pwd|ls|find|cat|sed|head|tail|grep|rg|wc|file|du|stat|jq)\b"
)
_BASH_WRITE_MARKER_RE = re.compile(
    r"(?:^|\s)(?:python|node|perl|ruby)\b|[>|]\s*|(?:^|\s)tee\s+|<<"
)
_FILE_TARGET_HINT_MARKER = "[Sophia/post-interrupt build directive]"
_CONCRETE_FILE_TARGET_RE = re.compile(r"Concrete file target:\s*`([^`]+)`")
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
_PROMOTABLE_DELIVERABLE_EXTENSIONS = frozenset({
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
})
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


def _merge_builder_write_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
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


def _merge_builder_write_diagnostic_value(
    merged: dict, key: str, value: object
) -> None:
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


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    if not relative:
        return None

    # Reject path traversal so emit verification/mirroring cannot resolve
    # outside the outputs root (e.g. "/mnt/user-data/outputs/../../etc/passwd").
    relative_path = PurePosixPath(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    return relative_path.as_posix()


def _upload_builder_outputs_to_supabase(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> None:
    """Best-effort upload of the builder's outputs to Supabase Storage.

    PR-E (Phase 2.2): delegates to ``maybe_mirror_file`` which uses SHA-256
    hash deduplication. Files that were already mirrored at write time by
    the tool hooks are skipped automatically. Any failure is logged and
    swallowed so builder flow never regresses.
    """
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return

    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        maybe_mirror_file(str(host_file), thread_id, outputs_host_path)


def _outputs_host_path_from_state(state: dict[str, Any]) -> str | None:
    thread_data = state.get("thread_data") or {}
    return thread_data.get("outputs_path") if isinstance(thread_data, dict) else None


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


def _requested_pdf_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) == ".pdf"


def _recovery_hint(outputs_root: Path, candidates: list[Path]) -> str:
    logger.info(
        "BuilderArtifact: emit_path_missing recovery_candidate_count=%s recovery_accepted=%s",
        len(candidates),
        len(candidates) == 1,
    )
    if len(candidates) != 1:
        return ""
    recovered = candidates[0].relative_to(outputs_root).as_posix()
    return (
        " I found exactly one plausible output candidate in the artifact "
        f"directory: `{_OUTPUTS_VIRTUAL_PREFIX}{recovered}`. If that is the "
        "intended deliverable, call emit_builder_artifact again with that exact path."
    )


def _first_research_tool_index(tool_names: list[str]) -> int:
    indexes = [
        index
        for index, name in enumerate(tool_names)
        if name in _BUILDER_RESEARCH_TOOL_NAMES
    ]
    return indexes[0] if indexes else len(tool_names) + 1


def _first_write_tool_index(tool_names: list[str]) -> int:
    indexes = [
        index
        for index, name in enumerate(tool_names)
        if name in _BUILDER_WRITE_TOOL_NAMES
    ]
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
    return (
        allow_web_research
        and (phase == "completion" or write_file_count > 0)
        and search_count + fetch_count == 0
    )


def _write_tool_names(tool_names: list[str]) -> list[str]:
    return [name for name in tool_names if name in _BUILDER_WRITE_TOOL_NAMES]


def _builder_web_attempt_count(state: dict[str, Any]) -> int:
    budget = state.get("builder_web_budget") or {}
    if not isinstance(budget, dict):
        return 0
    return int(budget.get("search_calls", 0) or 0) + int(budget.get("fetch_calls", 0) or 0)


def _has_builder_search_source(state: dict[str, Any]) -> bool:
    sources = state.get("builder_search_sources") or []
    return any(isinstance(source, dict) and source.get("url") for source in sources)


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
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    builder_research_diagnostics: NotRequired[dict]
    builder_update_epoch: NotRequired[int]
    builder_update_required_urls: NotRequired[list[str]]
    builder_artifact_target_path: NotRequired[str]
    builder_last_successful_output_path: NotRequired[str | None]
    builder_write_diagnostics: NotRequired[Annotated[dict, _merge_builder_write_diagnostics]]
    # PR #94: count consecutive emit attempts rejected for empty/missing
    # ``artifact_path``. When this reaches ``_REJECTION_SHORT_CIRCUIT_AT``
    # we route directly to the hard-ceiling fallback instead of letting
    # the model retry into the LangGraph recursion limit.
    builder_consecutive_empty_emit_rejections: NotRequired[int]
    # Phase 2F.3: idempotency flag. Set once we've injected a path-
    # correction HumanMessage after N consecutive write_file_tool errors,
    # so we don't repeat the correction on every subsequent before_model.
    builder_path_correction_emitted: NotRequired[bool]
    builder_tool_argument_correction_emitted: NotRequired[bool]
    builder_recovered_deliverable_emitted: NotRequired[bool]


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
        history.append(summary)
        return history[-12:]

    @staticmethod
    def _allow_web_research(state: BuilderArtifactState) -> bool:
        delegation = state.get("delegation_context")
        if "allow_web_research" in state or isinstance(delegation, dict):
            return True
        return False

    @staticmethod
    def _research_attempted(state: BuilderArtifactState) -> bool:
        return _builder_web_attempt_count(state) > 0 or _has_builder_search_source(state)

    @staticmethod
    def _planning_completed(state: BuilderArtifactState) -> bool:
        summaries = state.get("builder_tool_turn_summaries") or []
        if any(
            "write_todos" in (summary.get("tool_names") or [])
            for summary in summaries
            if isinstance(summary, dict)
        ):
            return True
        return int(state.get("builder_non_artifact_turns", 0) or 0) > 0

    @classmethod
    def _should_force_research_tool(cls, state: BuilderArtifactState) -> bool:
        return (
            cls._allow_web_research(state)
            and cls._planning_completed(state)
            and not cls._research_attempted(state)
        )

    @classmethod
    def _is_substantive_before_research_tool(cls, state: BuilderArtifactState, tool_call: dict[str, Any]) -> bool:
        if not cls._allow_web_research(state) or cls._research_attempted(state):
            return False
        name = tool_call.get("name")
        if name in _BUILDER_SUBSTANTIVE_TOOL_NAMES:
            return True
        if name in {"bash", "bash_tool"}:
            args = tool_call.get("args") or {}
            command = args.get("command") if isinstance(args, dict) else None
            return not _is_safe_pre_research_bash(command)
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

    # Ceiling enforcement — MUST stay in sync with _HARD_CEILING in after_model
    # and with builder_task.py's _HARD_CEILING. When the model is within this
    # many turns of termination, we force Anthropic tool_choice to emit so the
    # model literally cannot call any other tool. Prompt-level escalation is
    # not reliable mid-retry-loop; the API-level constraint is.
    #
    # PR-B (2026-04-28): bumped ceiling 20 → 30 after run ``c130c516`` (PDF
    # with diagrams) hit the 20-turn cap mid-progress: write→bash→fix cycles
    # for binary deliverables legitimately need 12-15 turns of build pipeline
    # plus initial planning + final emit. At 20 the model ran out of budget
    # while still iterating productively, then got trapped in 3 wasted forced-
    # write turns (LLM emitted near-empty content because the recovery path
    # for binary tasks is bash, not write_file). Soft warn rescaled to 18
    # (60%) and force-emit at remaining<=3 (turn 27+). Wall-clock force-emit
    # at 70% of per-run timeout (1260s of 1800s) is the backstop for runaway
    # text deliverables — those rarely need 30 turns.
    #
    # PR-A history (2026-04-27): bumped 10 → 20 after a research-heavy task
    # in log ``019dcfbf-f219-7d83-86a4-ffb161ebddf7`` proved 10 too tight.
    # PR-C F6 history (2026-04-24): lowered 20 → 10 because the original
    # ceiling let pathological retries burn the budget. PR-A fixes those
    # retries at the source (two-stage forced-emit + empty-path rejection)
    # so the larger budget no longer enables runaway retry loops.
    _FORCE_EMIT_REMAINING = 3
    _CEILING_FOR_FORCE = 30
    _SOFT_WARN_AT = 18
    # Wall-clock fraction of the per-run timeout at which we activate
    # force-emit even if the turn-count ceiling hasn't been hit. Each
    # write_file LLM call costs ~95s on long-form deliverables; with
    # _resolve_builder_limits returning timeout=1800s, 0.70 leaves ~540s of
    # slack — enough for one final write + emit + network buffer.
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
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

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
        return elapsed_ms / (timeout_s * 1000) >= BuilderArtifactMiddleware._FORCE_EMIT_WALL_CLOCK_FRACTION

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
    def _forced_search_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_search."""
        return {"type": "tool", "name": "builder_web_search"}

    @staticmethod
    def _forced_fetch_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_fetch."""
        return {"type": "tool", "name": "builder_web_fetch"}

    def _research_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not self._should_force_research_tool(state):
            return None
        explicit_urls = [
            url for url in (state.get("explicit_user_urls") or []) if str(url).strip()
        ]
        if explicit_urls:
            logger.warning(
                "BuilderArtifact: forcing tool_choice=builder_web_fetch "
                "before artifact writing (explicit_urls=%d)",
                len(explicit_urls),
            )
            return self._forced_fetch_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=builder_web_search "
            "before artifact writing"
        )
        return self._forced_search_tool_choice()

    def _completion_tool_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        turn_force = self._should_force_emit(state)
        clock_force = self._should_force_emit_by_clock(state, runtime)
        if not (turn_force or clock_force):
            return None
        force_reason = _force_reason(turn_force, clock_force)
        non_artifact_turns = state.get("builder_non_artifact_turns")

        if self._has_output_file(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_tool_choice()

        if self._has_generator_script(state):
            return self._generator_recovery_tool_choice(state, non_artifact_turns, force_reason)

        logger.warning(
            "BuilderArtifact: forcing tool_choice=write_file before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, no output file yet — "
            "force prevents phantom-emit loop)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_write_tool_choice()

    def _generator_recovery_tool_choice(
        self,
        state: BuilderArtifactState,
        non_artifact_turns: object,
        force_reason: str,
    ) -> dict[str, Any]:
        if _requested_pdf_artifact(state):
            logger.warning(
                "BuilderArtifact: PDF target has generator script but no deliverable; "
                "forcing write_file to create a Markdown source/fallback instead "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
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
            self._CEILING_FOR_FORCE,
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
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            # No outputs dir configured — assume the model hasn't written
            # anything. Returning False routes through the safer path
            # (force write_file first) instead of forcing a phantom emit.
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            # Ignore stale artifacts from prior builder tasks in the same thread.
            # Keep the same 5s grace used by hard-ceiling promotion.
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                if entry.name.startswith("_") or entry.name.startswith("."):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
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
    def _promotable_output_candidates(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
    ) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [
            p for p in outputs_root.rglob("*")
            if p.is_file()
            and not p.name.startswith("_")
            and p.suffix.lower() in _PROMOTABLE_DELIVERABLE_EXTENSIONS
            and (min_mtime is None or p.stat().st_mtime >= min_mtime)
        ]
        if requested_pdf:
            pdf_candidates = [p for p in candidates if p.suffix.lower() == ".pdf"]
            md_candidates = [p for p in candidates if p.suffix.lower() == ".md"]
            candidates = pdf_candidates or md_candidates
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates

    @staticmethod
    def _generator_output_candidates(state: BuilderArtifactState) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [
            p for p in outputs_root.rglob("*")
            if p.is_file()
            and p.name.startswith("_generate_")
            and p.suffix.lower() == ".py"
            and (min_mtime is None or p.stat().st_mtime >= min_mtime)
        ]
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
        reason: str,
    ) -> tuple[str | None, str]:
        try:
            candidates = BuilderArtifactMiddleware._promotable_output_candidates(
                state,
                requested_pdf=requested_pdf,
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
                "BuilderArtifact: PDF fallback refusing generator script %s "
                "(reason=%s, no pdf_or_markdown deliverable found)",
                promoted_path,
                reason,
            )
            return None
        logger.warning(
            "BuilderArtifact: fallback promoting generator script %s "
            "(reason=%s, no binary deliverable found)",
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
            "companion_summary": (
                "The builder ran long and didn't call emit cleanly, "
                "but the deliverable is on disk — I'm surfacing it now."
            ),
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
            "companion_summary": (
                "I built the generator script but couldn't produce the final "
                "binary cleanly — sharing the script so you have something to "
                "work with."
            ),
            "companion_tone_hint": (
                "Honest and constructive — partial deliverable; offer to debug "
                "if the user shares the error from running it."
            ),
            "user_next_action": (
                "Try running `python <path>` yourself, or send me the error "
                "and I'll fix it."
            ),
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
            "companion_summary": (
                "The builder could not produce a PDF or Markdown fallback. "
                "I did not surface the generator script as a completed PDF."
            ),
            "companion_tone_hint": (
                "Apologetic and direct — PDF rendering did not produce a "
                "deliverable; offer to retry."
            ),
            "user_next_action": "Ask me to retry the PDF build.",
            "confidence": 0.2,
        }

    @staticmethod
    def _generic_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "unknown",
            "artifact_title": "Build task force-stopped",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                f"The builder made {steps_completed} edits but didn't finish cleanly. "
                "No final deliverable was produced."
            ),
            "companion_tone_hint": "Apologetic — builder ran out of budget.",
            "user_next_action": "Tell me what to try differently and I'll run it again.",
            "confidence": 0.2,
        }

    @staticmethod
    def _build_ceiling_fallback(
        state: BuilderArtifactState,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        """Synthesize a ``builder_result`` dict by scanning ``outputs/`` for
        a deliverable to promote.

        Used by both the hard-ceiling termination path
        (``non_artifact_turns >= _CEILING_FOR_FORCE``) and the
        consecutive-rejection short-circuit path (PR #94, when the model
        emits ``artifact_path=None`` repeatedly under forced emit).

        Promotion priority:

        1. Preferred binary deliverable extension (``.pdf/.pptx/.docx/.xlsx/
           .png/.jpg/.jpeg/.svg/.html/.zip``) — confidence=0.5, "recovered".
        2. Generator script (``_generate_*.py``) — confidence=0.4, partial
           deliverable with a "run it yourself" companion summary.
        3. Apology fallback (``artifact_path=None``, confidence=0.2) — when
           neither category matches.

        ``reason`` is included in log lines so traces can distinguish ceiling
        terminations from rejection short-circuits.

        PDF requests are stricter than generic binary fallbacks: a
        ``_generate_*.py`` file is never a successful PDF artifact. If
        ``render_markdown_to_pdf`` cannot produce a PDF, the only acceptable
        degraded deliverable is the Markdown source; otherwise fail truthfully.
        """
        requested_pdf = _requested_pdf_artifact(state)
        promoted_path, promoted_type = BuilderArtifactMiddleware._promoted_deliverable_from_outputs(
            state,
            requested_pdf=requested_pdf,
            reason=reason,
        )
        if promoted_path:
            return BuilderArtifactMiddleware._recovered_deliverable_fallback(
                promoted_path,
                promoted_type,
                steps_completed=steps_completed,
            )
        promoted_generator_path = BuilderArtifactMiddleware._promoted_generator_from_outputs(
            state,
            requested_pdf=requested_pdf,
            reason=reason,
        )
        if promoted_generator_path:
            return BuilderArtifactMiddleware._generator_script_fallback(
                promoted_generator_path,
                steps_completed=steps_completed,
            )
        if requested_pdf:
            return BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
        return BuilderArtifactMiddleware._generic_no_deliverable_fallback(
            steps_completed=steps_completed,
        )

    @staticmethod
    def _upload_fallback_and_fire(
        state: BuilderArtifactState,
        runtime: Runtime,
        fallback: dict[str, Any],
        status: str,
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

        Safe to call when ``fallback["artifact_path"]`` is None:
        ``maybe_mirror_file`` is a no-op for missing paths, and
        ``_upload_builder_outputs_to_supabase`` short-circuits when
        ``outputs_host_path`` or ``thread_id`` is unset. The upload
        helper also documents "Any failure is logged and swallowed so
        builder flow never regresses" — so if the upload raises, the
        webhook still fires (the placeholder is finalized; delivery
        may still degrade to plaintext, which is the pre-Phase-4L
        behavior — i.e. no regression).
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        )
        delegation = state.get("delegation_context")
        parent_thread_id = (
            delegation.get("parent_thread_id") if isinstance(delegation, dict) else None
        )
        builder_thread_id = (
            runtime.context.get("thread_id") if getattr(runtime, "context", None) else None
        )
        upload_thread_id = parent_thread_id or builder_thread_id
        _upload_builder_outputs_to_supabase(
            thread_id=upload_thread_id,
            outputs_host_path=outputs_host_path,
            artifact_args=fallback,
        )
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
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
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
        candidates: list[str] = []
        primary = artifact_args.get("artifact_path")
        if isinstance(primary, str) and primary.strip():
            candidates.append(primary.strip())
        supporting = artifact_args.get("supporting_files")
        if isinstance(supporting, list):
            candidates.extend(
                path for path in supporting
                if isinstance(path, str) and path.strip()
            )

        if not candidates:
            # Reject empty artifact_path under EITHER turn-count pressure
            # (existing) OR wall-clock pressure (new). Both indicate the
            # model is emitting under tool_choice pressure with no real
            # deliverable to point at — let the hard-ceiling fallback
            # promote a real file or surface a deterministic apology.
            if cls._should_force_emit(state) or cls._should_force_emit_by_clock(state, runtime):
                logger.warning(
                    "BuilderArtifact: rejecting empty artifact_path during "
                    "forced-emit (non_artifact_turns=%s) — letting hard "
                    "ceiling fallback promote a real file or surface a "
                    "deterministic apology instead of a phantom emit.",
                    state.get("builder_non_artifact_turns"),
                )
                return False
            # No files referenced AND not under forced-emit pressure —
            # accept (builder may be emitting a text-only or conceptual
            # result).
            return True

        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        thread_id = runtime.context.get("thread_id") if runtime.context else None

        for candidate in candidates:
            relative = _extract_output_relative_path(candidate)
            if relative is None:
                # If the path is under outputs prefix but failed relative-path
                # extraction, treat as invalid (e.g. traversal attempt).
                if isinstance(candidate, str) and candidate.strip().startswith(_OUTPUTS_VIRTUAL_PREFIX):
                    logger.warning(
                        "BuilderArtifact: rejecting invalid outputs artifact path=%s",
                        candidate,
                    )
                    return False
                # Non-virtual path — we can't verify it against the sandbox
                # outputs dir. Accept it and let downstream consumers decide.
                continue

            # 1. Check local disk
            if outputs_host_path:
                host_file = Path(outputs_host_path) / relative
                if host_file.is_file():
                    continue

            # 2. Check Supabase
            if thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative):
                continue

            # Neither local nor remote — missing.
            logger.warning(
                "BuilderArtifact: file missing for emit verification: "
                "path=%s local=%s supabase=%s",
                candidate,
                bool(outputs_host_path and (Path(outputs_host_path) / relative).is_file()),
                bool(thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative)),
            )
            return False

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
            candidates = [
                entry for entry in outputs_root.rglob("*")
                if _is_recovery_candidate(entry, requested_suffix=requested_suffix, min_mtime=min_mtime)
            ]
        except OSError:
            logger.debug(
                "BuilderArtifact: missing-path recovery scan failed outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return ""
        return _recovery_hint(outputs_root, candidates)

    @classmethod
    def _recover_emit_args_from_last_write(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        recovered_path = cls._preferred_successful_deliverable_path(state, runtime)
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

    @staticmethod
    def _successful_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        return [
            path
            for path in (diagnostics.get("successful_output_paths") or [])
            if isinstance(path, str) and _extract_output_relative_path(path) is not None
        ]

    @staticmethod
    def _successful_deliverable_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        explicit = [
            path
            for path in (diagnostics.get("successful_deliverable_output_paths") or [])
            if isinstance(path, str) and _is_user_facing_output_path(path)
        ]
        if explicit:
            return explicit
        return [
            path
            for path in BuilderArtifactMiddleware._successful_output_paths(state)
            if _is_user_facing_output_path(path)
        ]

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
        paths = cls._successful_deliverable_output_paths(state)
        diagnostics = state.get("builder_write_diagnostics") or {}
        target_path = cls._target_artifact_path(state)
        if target_path and _is_user_facing_output_path(target_path):
            target_args = {"artifact_path": target_path}
            if target_path in paths or cls._artifact_files_exist(target_args, state, runtime):
                return target_path

        target_suffix = Path(target_path or "").suffix.lower()
        matching = [
            path for path in paths
            if not target_suffix or Path(path).suffix.lower() == target_suffix
        ]
        if len(matching) == 1:
            return matching[0]

        last_successful = (
            diagnostics.get("last_successful_deliverable_output_path")
            if isinstance(diagnostics, dict)
            else None
        )
        if isinstance(last_successful, str):
            if last_successful in matching:
                return last_successful
            if not matching and last_successful in paths:
                return last_successful

        if len(paths) == 1:
            return paths[0]
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
            "companion_summary": (
                "The builder wrote a deliverable but did not emit it cleanly, "
                "so I recovered the completed file from the output directory."
            ),
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
        if cls._artifact_files_exist(artifact_args, state, runtime):
            return artifact_args
        return cls._recover_emit_args_from_last_write(artifact_args, state, runtime) or artifact_args

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
        return (
            self._research_tool_choice_for_state(state)
            or self._completion_tool_choice_for_state(state, runtime)
        )

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
        if "field required" in lowered and ("content" in lowered or "command" in lowered):
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
            "[BuilderArtifact] %d consecutive write_file_tool runtime errors "
            "detected; stopping build instead of path-correcting error_class=%s",
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
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_runtime_write_failure_emitted": True,
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
        if runtime is not None:
            self._upload_fallback_and_fire(
                state=state,
                runtime=runtime,
                fallback=fallback,
                status="completed",
            )
        return {
            "builder_result": fallback,
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_recovered_deliverable_emitted": True,
            "jump_to": "end",
        }

    def _maybe_promote_recovered_deliverable(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if state.get("builder_recovered_deliverable_emitted") or runtime is None:
            return None
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return None
        if diagnostics.get("last_status") != "success":
            return None
        error_count = int(diagnostics.get("error_count", 0) or 0)
        had_correction = bool(
            state.get("builder_path_correction_emitted")
            or state.get("builder_tool_argument_correction_emitted")
        )
        if error_count < self._PATH_CORRECTION_ERROR_THRESHOLD and not had_correction:
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

    def _write_tool_argument_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any] | None:
        candidate = (
            self._preferred_successful_deliverable_path(state, runtime)
            if runtime is not None
            else None
        )
        if candidate and self._artifact_files_exist({"artifact_path": candidate}, state, runtime):
            return self._recovered_deliverable_update(
                state,
                runtime,
                artifact_path=candidate,
                reason=error_class,
            )

        if state.get("builder_tool_argument_correction_emitted"):
            logger.error(
                "[BuilderArtifact] repeated missing required tool arguments "
                "after correction; stopping build count=%d error_class=%s",
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
                "builder_tool_argument_correction_emitted": True,
                "jump_to": "end",
            }

        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool missing-argument "
            "errors detected — injecting tool-argument correction instead of "
            "path correction. error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/tool-argument correction]\n"
                "Your recent tool call was missing required arguments. "
                "Do not retry the same incomplete call.\n\n"
                "For text deliverables, call `write_file_tool` with BOTH "
                "`path` and `content` arguments, for example "
                "`write_file_tool(path='/mnt/user-data/outputs/report.html', "
                "content='<html>...</html>', append=False)`. For shell work, "
                "call `bash_tool` with a non-empty `command` argument.\n\n"
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
        count = self._count_trailing_write_file_errors(
            messages, self._PATH_CORRECTION_LOOKBACK
        )
        if count < self._PATH_CORRECTION_ERROR_THRESHOLD:
            return None
        diagnostics = state.get("builder_write_diagnostics") or {}
        error_class = (
            diagnostics.get("last_error_class")
            if isinstance(diagnostics, dict)
            else None
        )
        if not isinstance(error_class, str) or not error_class:
            classes = self._trailing_write_file_error_classes(
                messages,
                self._PATH_CORRECTION_LOOKBACK,
            )
            error_class = classes[0] if classes else "write_tool_error"
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
            "[BuilderArtifact] %d consecutive write_file_tool errors detected "
            "— injecting path-correction directive (Phase 2F.3 escape hatch). "
            "error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/path-correction directive]\n"
                f"Your last {count} write_file_tool calls all failed with "
                "errors. This usually means the path you used is not under "
                "/mnt/user-data/outputs/.\n\n"
                "STOP retrying with the same kind of path. Your NEXT "
                "write_file_tool call MUST use an absolute path starting "
                "with `/mnt/user-data/outputs/`, e.g. "
                "`/mnt/user-data/outputs/my-document.md`. If you only had a "
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

    def _post_interrupt_state_hints(
        self, state: BuilderArtifactState, messages: list
    ) -> dict[str, Any]:
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

    def _maybe_reset_turn_budget(
        self, state: BuilderArtifactState
    ) -> dict[str, Any] | None:
        """Phase 2E.1: when an interrupted builder run resumes with a new
        user instruction, reset ``builder_non_artifact_turns`` to 0 so the
        post-update work gets a fresh turn budget. Without this, the
        pre-interrupt research turns count against the post-update writing
        budget and the builder hits the hard ceiling without producing a
        deliverable (production failure 2026-05-21 21:18-21:46 UTC).
        """
        messages = state.get("messages") or []
        if not self._is_post_interrupt_update(messages):
            return None
        current = int(state.get("builder_non_artifact_turns", 0) or 0)
        update = self._post_interrupt_state_hints(state, messages)
        if current > 0:
            logger.info(
                "[BuilderArtifact] post-interrupt update detected — resetting "
                "builder_non_artifact_turns: %d -> 0 (fresh budget for the update)",
                current,
            )
            update["builder_non_artifact_turns"] = 0
        return update or None

    def _combined_before_model_updates(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict | None:
        """Run all before_model state-update probes (Phase 2E.1 turn-budget
        reset + Phase 2F.3 path-correction injection) and merge their
        returns into a single update dict for the langgraph reducer."""
        update: dict[str, Any] = {}
        reset = self._maybe_reset_turn_budget(state)
        if isinstance(reset, dict):
            update.update(reset)
        promotion = self._maybe_promote_recovered_deliverable(
            state,
            runtime,
            reason="successful_write_after_correction",
        )
        if isinstance(promotion, dict):
            update.update(promotion)
            return update
        correction = self._maybe_inject_path_correction(state, runtime)
        if isinstance(correction, dict):
            # Merge: ``messages`` reducer concatenates, scalar flags overwrite.
            for key, value in correction.items():
                update[key] = value
        return update or None

    @hook_config(can_jump_to=["end"])
    @override
    def before_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @hook_config(can_jump_to=["end"])
    @override
    async def abefore_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force tool_choice when ceiling is imminent (two-stage)."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same two-stage logic as wrap_model_call."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return await handler(request)

    def _block_substantive_tool_before_research(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        if not self._is_substantive_before_research_tool(request.state, request.tool_call):
            return None

        tool_name = request.tool_call.get("name") or "unknown"
        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "[BuilderResearchEnforcement] blocked_content_tool_before_research "
            "tool=%s",
            tool_name,
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: research-before-write enforcement blocked this tool call. "
                            "You may keep your plan, but before writing, editing, running "
                            "artifact-generating bash, or emitting the artifact, call "
                            "builder_web_search or builder_web_fetch at least once. If the "
                            "web tool fails or returns weak results, continue afterward with "
                            "the best available context."
                        ),
                        tool_call_id=tool_call_id,
                        name=str(tool_name),
                        status="error",
                    ),
                ],
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
            "[BuilderWriteDiagnostics] tool=%s status=%s path_under_outputs=%s "
            "ext=%s error_class=%s content_shape=%s",
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
            }
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
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block

        if request.tool_call.get("name") != "emit_builder_artifact":
            return self._write_result_command(request, handler(request))

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in wrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        recovery_hint = self._missing_artifact_recovery_hint(args, request.state)
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                            f"{recovery_hint}"
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant — same logic as wrap_tool_call."""
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block

        if request.tool_call.get("name") != "emit_builder_artifact":
            return self._write_result_command(request, await handler(request))

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return await handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return await handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in awrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        recovery_hint = self._missing_artifact_recovery_hint(args, request.state)
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                            f"{recovery_hint}"
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

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
                research_diagnostics = self._update_research_diagnostics(state, tool_names)
                allow_web_research = self._allow_web_research(state)

                if artifact_calls and len(artifact_calls) == len(tool_calls):
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

                    if not self._artifact_files_exist(args, state, runtime):
                        logger.warning(
                            "BuilderArtifact: emit rejected in after_model — "
                            "artifact_path %s not found on disk or in Supabase. "
                            "Builder will retry via wrap_tool_call.",
                            args.get("artifact_path"),
                        )
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1

                        # PR #94: track *empty* artifact_path rejections separately
                        # so we can short-circuit before the LangGraph recursion
                        # limit blows. The model's ``artifact_path=None`` under
                        # forced ``tool_choice`` is a strong signal that further
                        # retries won't help — collapse to the hard-ceiling
                        # fallback after _REJECTION_SHORT_CIRCUIT_AT consecutive
                        # such rejections.
                        primary = args.get("artifact_path")
                        is_empty_path_rejection = not (
                            isinstance(primary, str) and primary.strip()
                        )
                        consecutive_rejections = int(
                            state.get("builder_consecutive_empty_emit_rejections", 0) or 0
                        )
                        if is_empty_path_rejection:
                            consecutive_rejections += 1
                        else:
                            consecutive_rejections = 0

                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "emit_rejected": True,
                                "empty_artifact_path": is_empty_path_rejection,
                            },
                        )
                        write_diagnostics = state.get("builder_write_diagnostics") or {}
                        write_success_count = int(write_diagnostics.get("success_count", 0) or 0)
                        write_error_count = int(write_diagnostics.get("error_count", 0) or 0)
                        if write_success_count == 0 and write_error_count >= 3:
                            logger.warning(
                                "BuilderArtifact: stopping after repeated write failures "
                                "with no successful output write (write_errors=%d)",
                                write_error_count,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason="repeated_write_failures_no_output",
                            )
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
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "jump_to": "end",
                            }

                        if (
                            is_empty_path_rejection
                            and consecutive_rejections >= self._REJECTION_SHORT_CIRCUIT_AT
                        ):
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive "
                                "empty-artifact_path rejections at turn=%d (ceiling=%d) — "
                                "routing to ceiling fallback to avoid GraphRecursionError.",
                                consecutive_rejections,
                                non_artifact_turns,
                                self._CEILING_FOR_FORCE,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=f"consecutive_empty_emit_rejections={consecutive_rejections}",
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
                                status="completed",
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "jump_to": "end",
                            }

                        return {
                            "builder_non_artifact_turns": non_artifact_turns,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_research_diagnostics": research_diagnostics,
                            "builder_consecutive_empty_emit_rejections": consecutive_rejections,
                        }

                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                        },
                    )
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = (
                        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    )
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
                    delegation_for_upload = (
                        state.get("delegation_context")
                        if isinstance(state.get("delegation_context"), dict)
                        else {}
                    )
                    parent_thread_id = (
                        delegation_for_upload.get("parent_thread_id")
                        if isinstance(delegation_for_upload, dict)
                        else None
                    )
                    builder_thread_id = (
                        runtime.context.get("thread_id") if runtime.context else None
                    )
                    upload_thread_id = parent_thread_id or builder_thread_id
                    _upload_builder_outputs_to_supabase(
                        thread_id=upload_thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    self._log_research_diagnostics(
                        phase="completion",
                        diagnostics=research_diagnostics,
                        allow_web_research=allow_web_research,
                        sources_used=args.get("sources_used"),
                    )
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, "
                        f"confidence={args.get('confidence')}",
                        _t0,
                    )
                    # Fire the gateway webhook so the Telegram channel adapter
                    # (and webapp SSE) deliver the artifact bytes to the user.
                    # Replaces the deleted ``SubagentExecutor`` terminal-flip
                    # call site after the Phase-1 async migration.
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
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
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
                builder_task_started_at_ms = state.get("builder_task_started_at_ms")
                if not isinstance(builder_task_started_at_ms, (int, float)) or builder_task_started_at_ms <= 0:
                    builder_task_started_at_ms = int(time.time() * 1000)
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"
                recovered = self._maybe_promote_recovered_deliverable(
                    state,
                    runtime,
                    reason="non_emit_after_successful_deliverable_write",
                )
                if recovered is not None:
                    recovered.update({
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_research_diagnostics": research_diagnostics,
                    })
                    return recovered

                # PR-C F6 (2026-04-24): soft-warn halfway so the model sees
                # an early wrap-up signal in logs (and future trace events).
                # Emitted exactly once per task, at the ``_SOFT_WARN_AT`` turn.
                if non_artifact_turns == self._SOFT_WARN_AT:
                    logger.warning(
                        "BuilderArtifact: soft ceiling warning at turn=%d "
                        "(hard_ceiling=%d, remaining=%d). Builder should wrap up "
                        "— emit_builder_artifact with what's on disk instead of "
                        "continuing to iterate.",
                        non_artifact_turns,
                        self._CEILING_FOR_FORCE,
                        self._CEILING_FOR_FORCE - non_artifact_turns,
                    )

                # Hard ceiling: force end before hitting the recursion limit.
                # Builds that haven't emitted by this point almost never recover
                # — the budget is better spent recovering whatever file is
                # already on disk than letting bash thrash. PR #94 extracted
                # the fallback-construction logic into ``_build_ceiling_fallback``
                # so the consecutive-rejection short-circuit can reuse it.
                _HARD_CEILING = self._CEILING_FOR_FORCE
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
                        status="completed",
                    )
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
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
                    "builder_research_diagnostics": research_diagnostics,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                    # PR #94: any non-emit turn breaks the empty-rejection
                    # streak. Reset so the short-circuit only fires on
                    # *consecutive* empty emits.
                    "builder_consecutive_empty_emit_rejections": 0,
                }

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral \u2014 no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }
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
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status="failed",
                error_message=(
                    "Builder finished without producing a deliverable. "
                    "Want me to try again?"
                ),
            )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
                "builder_consecutive_empty_emit_rejections": 0,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
