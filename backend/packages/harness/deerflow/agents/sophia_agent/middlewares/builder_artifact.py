"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).
"""

import logging
import re
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime
from pypdf import PdfReader

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.storage import supabase_artifact_store

logger = logging.getLogger(__name__)


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_OUTPUTS_LITERAL_RE = re.compile(r"['\"](?P<path>/mnt/user-data/outputs/[^'\"]+)['\"]")
_EXACT_PAGE_COUNT_RE = re.compile(r"\bexactly\s+(\d+)\s+pages?\b", re.IGNORECASE)
_PAGE_COUNT_RE = re.compile(r"\b(\d+)[- ]page\b", re.IGNORECASE)
_TEXT_DELIVERABLE_EXTENSIONS = {
    ".md",
    ".markdown",
    ".html",
    ".htm",
    ".txt",
}
_PROMOTABLE_ARTIFACT_EXTENSIONS = (
    ".pdf",
    ".pptx",
    ".docx",
    ".xlsx",
    ".html",
    ".htm",
    ".md",
    ".markdown",
    ".zip",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".txt",
    ".csv",
    ".json",
)
_PROMOTABLE_ARTIFACT_EXTENSION_PRIORITY = {
    extension: index for index, extension in enumerate(_PROMOTABLE_ARTIFACT_EXTENSIONS)
}


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    return relative or None


def _resolve_output_host_file(
    outputs_host_path: str | None,
    artifact_path: str | None,
) -> Path | None:
    relative = _extract_output_relative_path(artifact_path)
    if relative is None or not outputs_host_path:
        return None
    return Path(outputs_host_path) / relative


def _resolve_builder_hard_ceiling(state: AgentState) -> int:
    delegation_context = state.get("delegation_context")
    task = delegation_context.get("task") if isinstance(delegation_context, dict) else None
    if isinstance(task, str) and "pdf" in task.lower() and (
        _EXACT_PAGE_COUNT_RE.search(task) or _PAGE_COUNT_RE.search(task)
    ):
        return 8
    return 20


def _expected_artifact_path_from_state(state: AgentState) -> str | None:
    delegation_context = state.get("delegation_context")
    task = delegation_context.get("task") if isinstance(delegation_context, dict) else None
    if not isinstance(task, str) or not task.strip():
        return None

    for match in _OUTPUTS_LITERAL_RE.finditer(task):
        candidate = match.group("path")
        if not _is_internal_builder_supporting_path(candidate):
            return candidate
    return None


def _expected_text_artifact_ready(state: AgentState) -> bool:
    artifact_path = _expected_artifact_path_from_state(state)
    if artifact_path is None or Path(artifact_path).suffix.lower() not in _TEXT_DELIVERABLE_EXTENSIONS:
        return False

    thread_data = state.get("thread_data") or {}
    outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
    host_file = _resolve_output_host_file(outputs_host_path, artifact_path)
    if host_file is None or not host_file.exists():
        return False

    builder_task_started_at_ms = state.get("builder_task_started_at_ms")
    if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
        min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
        if host_file.stat().st_mtime < min_mtime:
            return False

    last_tool_names = state.get("builder_last_tool_names") or []
    if not isinstance(last_tool_names, list):
        return False
    return any(name in {"write_file", "write_todos"} for name in last_tool_names)


def _candidate_generator_scripts(outputs_root: Path, artifact_args: dict[str, Any]) -> list[Path]:
    candidates: list[Path] = []
    seen: set[Path] = set()

    primary = artifact_args.get("artifact_path")
    primary_relative = _extract_output_relative_path(primary) if isinstance(primary, str) else None
    if primary_relative is not None:
        primary_path = outputs_root / primary_relative
        if primary_path.suffix.lower() == ".py" and primary_path.exists():
            seen.add(primary_path)
            candidates.append(primary_path)

    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        for item in supporting:
            if not isinstance(item, str):
                continue
            relative = _extract_output_relative_path(item)
            if relative is None:
                continue
            path = outputs_root / relative
            if path.suffix.lower() != ".py" or "_generate" not in path.name:
                continue
            if path.exists() and path not in seen:
                seen.add(path)
                candidates.append(path)

    for path in sorted(outputs_root.glob("_generate*.py")):
        if path not in seen:
            seen.add(path)
            candidates.append(path)

    return candidates


def _infer_missing_loop_target(block_lines: list[str]) -> str:
    block_text = "".join(block_lines)
    pair_candidates = [
        ("bp", "bt"),
        ("label", "value"),
        ("title", "body"),
        ("name", "description"),
        ("left", "right"),
        ("key", "value"),
    ]
    for left, right in pair_candidates:
        if re.search(rf"\b{left}\b", block_text) and re.search(rf"\b{right}\b", block_text):
            return f"{left}, {right}"

    scalar_candidates = ("t", "line", "item", "entry", "row", "value", "note", "month", "wl")
    for candidate in scalar_candidates:
        if re.search(rf"\b{candidate}\b", block_text):
            return candidate

    return "_builder_item"


def _repair_missing_literal_for_loops(source: str) -> tuple[str | None, int]:
    lines = source.splitlines(keepends=True)
    repaired = 0
    index = 0

    while index < len(lines):
        match = re.match(
            r"^(?P<indent>[ \t]*)(?P<target>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[\s*$",
            lines[index],
        )
        if match is None:
            index += 1
            continue

        indent = match.group("indent")
        indent_width = len(indent)

        closing_index = index + 1
        while closing_index < len(lines):
            closing_line = lines[closing_index]
            if closing_line.lstrip(" \t") != closing_line:
                line_indent_width = len(closing_line) - len(closing_line.lstrip(" \t"))
                if line_indent_width < indent_width:
                    break
            if closing_line.startswith(indent) and closing_line.strip() == "]:":
                break
            closing_index += 1

        if closing_index >= len(lines) or lines[closing_index].strip() != "]:":
            index += 1
            continue

        block_index = closing_index + 1
        block_lines: list[str] = []
        while block_index < len(lines):
            line = lines[block_index]
            stripped = line.strip()
            if not stripped:
                block_lines.append(line)
                block_index += 1
                continue

            line_indent_width = len(line) - len(line.lstrip(" \t"))
            if line_indent_width <= indent_width:
                break
            block_lines.append(line)
            block_index += 1

        if not block_lines:
            index += 1
            continue

        loop_target = _infer_missing_loop_target(block_lines)
        lines[index] = f"{indent}for {loop_target} in [\n"
        lines[closing_index] = f"{indent}]:\n"
        repaired += 1
        index = block_index

    if repaired == 0:
        return None, 0
    return "".join(lines), repaired


def _candidate_recovery_sources(source: str, host_outputs_prefix: str) -> list[tuple[str, str]]:
    variants: list[tuple[str, str]] = []
    seen_sources: set[str] = set()

    patched = source.replace(_OUTPUTS_VIRTUAL_PREFIX, host_outputs_prefix)
    for label, candidate in (("patched", patched),):
        if candidate in seen_sources:
            continue
        seen_sources.add(candidate)
        variants.append((label, candidate))

    repaired_source, repaired_count = _repair_missing_literal_for_loops(patched)
    if repaired_source is not None and repaired_source not in seen_sources:
        seen_sources.add(repaired_source)
        variants.append((f"patched+repaired-loops:{repaired_count}", repaired_source))

    return variants


def _extract_public_output_paths_from_source(source: str) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for match in _OUTPUTS_LITERAL_RE.finditer(source):
        candidate = match.group("path")
        if _is_internal_builder_supporting_path(candidate) or candidate in seen:
            continue
        seen.add(candidate)
        paths.append(candidate)
    return paths


def _promote_internal_primary_artifact(
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> tuple[dict[str, Any], str | None]:
    primary = artifact_args.get("artifact_path")
    promoted_args = dict(artifact_args)
    if not _is_internal_builder_supporting_path(primary):
        return promoted_args, None
    if not outputs_host_path:
        return promoted_args, None

    outputs_root = Path(outputs_host_path)
    seen_paths: set[str] = set()
    for generator_script in _candidate_generator_scripts(outputs_root, artifact_args):
        try:
            source = generator_script.read_text(encoding="utf-8")
        except OSError:
            continue

        for candidate in _extract_public_output_paths_from_source(source):
            if candidate in seen_paths:
                continue
            seen_paths.add(candidate)

            candidate_args = dict(artifact_args)
            candidate_args["artifact_path"] = candidate
            if not _materialize_missing_primary_artifact(outputs_host_path, candidate_args):
                continue

            host_file = _resolve_output_host_file(outputs_host_path, candidate)
            if host_file is not None and host_file.exists():
                return candidate_args, candidate

    return promoted_args, None


def _is_internal_builder_supporting_path(artifact_path: str | None) -> bool:
    if not isinstance(artifact_path, str) or not artifact_path.strip():
        return False

    normalized = artifact_path.strip().replace("\\", "/")
    lowered = normalized.lower()
    name = Path(normalized).name.lower()

    return (
        "/__pycache__/" in lowered
        or name.endswith(".pyc")
        or (name.startswith("_") and name.endswith(".py"))
    )


def _is_allowed_internal_primary_code_artifact(
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> bool:
    artifact_type = artifact_args.get("artifact_type")
    if not isinstance(artifact_type, str) or artifact_type.lower() != "code":
        return False

    artifact_path = artifact_args.get("artifact_path")
    if not _is_internal_builder_supporting_path(artifact_path):
        return False

    host_file = _resolve_output_host_file(outputs_host_path, artifact_path)
    return (
        host_file is not None
        and host_file.is_file()
        and host_file.suffix.lower() == ".py"
        and host_file.name.startswith("_")
    )


def _sanitize_builder_artifact_args(artifact_args: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    sanitized = dict(artifact_args)
    supporting = artifact_args.get("supporting_files")
    if not isinstance(supporting, list):
        return sanitized, []

    public_supporting: list[str] = []
    removed_supporting: list[str] = []
    for item in supporting:
        if not isinstance(item, str):
            continue
        if _is_internal_builder_supporting_path(item):
            removed_supporting.append(item)
            continue
        public_supporting.append(item)

    if public_supporting:
        sanitized["supporting_files"] = public_supporting
    else:
        sanitized.pop("supporting_files", None)

    return sanitized, removed_supporting


def _materialize_missing_primary_artifact(
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> bool:
    primary_host_file = _resolve_output_host_file(outputs_host_path, artifact_args.get("artifact_path"))
    if primary_host_file is None:
        return True
    if primary_host_file.exists():
        return True
    if not outputs_host_path:
        return False

    outputs_root = Path(outputs_host_path)
    outputs_root.mkdir(parents=True, exist_ok=True)
    host_outputs_prefix = outputs_root.as_posix().rstrip("/") + "/"

    for generator_script in _candidate_generator_scripts(outputs_root, artifact_args):
        recovery_script = outputs_root / f".__recover__{generator_script.name}"
        try:
            source = generator_script.read_text(encoding="utf-8")
            for variant_label, candidate_source in _candidate_recovery_sources(source, host_outputs_prefix):
                try:
                    compile(candidate_source, str(recovery_script), "exec")
                except SyntaxError as exc:
                    logger.warning(
                        "Builder artifact recovery source is still invalid path=%s variant=%s line=%s error=%s",
                        generator_script,
                        variant_label,
                        exc.lineno,
                        exc.msg,
                    )
                    continue

                recovery_script.write_text(candidate_source, encoding="utf-8")
                completed = subprocess.run(
                    [sys.executable, str(recovery_script)],
                    cwd=str(outputs_root),
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=False,
                )
                if completed.returncode != 0:
                    logger.warning(
                        "Builder artifact recovery script failed path=%s variant=%s returncode=%s stdout=%s stderr=%s",
                        generator_script,
                        variant_label,
                        completed.returncode,
                        completed.stdout.strip(),
                        completed.stderr.strip(),
                    )
                    continue
                if primary_host_file.exists():
                    logger.info(
                        "Recovered missing builder artifact by executing generator script path=%s variant=%s artifact=%s",
                        generator_script,
                        variant_label,
                        primary_host_file,
                    )
                    return True
        except Exception as exc:  # noqa: BLE001 - recovery is best effort
            logger.warning(
                "Builder artifact recovery failed path=%s error=%s",
                generator_script,
                exc,
            )
        finally:
            recovery_script.unlink(missing_ok=True)

    return primary_host_file.exists()


def _expected_pdf_page_count(state: AgentState) -> int | None:
    delegation_context = state.get("delegation_context")
    if not isinstance(delegation_context, dict):
        return None

    task_text = delegation_context.get("task")
    if not isinstance(task_text, str) or not task_text.strip():
        return None

    exact_match = _EXACT_PAGE_COUNT_RE.search(task_text)
    if exact_match is not None:
        return int(exact_match.group(1))

    generic_match = _PAGE_COUNT_RE.search(task_text)
    if generic_match is not None:
        return int(generic_match.group(1))

    return None


def _validate_pdf_page_count(
    state: AgentState,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> str | None:
    primary_host_file = _resolve_output_host_file(outputs_host_path, artifact_args.get("artifact_path"))
    if primary_host_file is None or primary_host_file.suffix.lower() != ".pdf" or not primary_host_file.exists():
        return None

    expected_page_count = _expected_pdf_page_count(state)
    if expected_page_count is None:
        return None

    observed_page_count = len(PdfReader(str(primary_host_file)).pages)
    if observed_page_count == expected_page_count:
        return None

    return (
        "emit_builder_artifact rejected: the PDF does not satisfy the required page count. "
        f"Expected exactly {expected_page_count} pages but found {observed_page_count} at {artifact_args.get('artifact_path')}. "
        "Adjust or regenerate the PDF so it has exactly the required number of pages, verify it with pypdf, and then call emit_builder_artifact again. "
        "Do not call emit_builder_artifact again until you have changed the generator or regenerated the PDF. "
        "If content is overflowing, tighten layout or simplify sections instead of adding pages."
    )


def _infer_promoted_artifact_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".html", ".htm"}:
        return "html"
    if suffix in {".md", ".markdown"}:
        return "markdown"
    return suffix.lstrip(".") or "unknown"


def _find_recent_public_output_artifact(
    outputs_host_path: str | None,
    *,
    builder_task_started_at_ms: int | float | None,
) -> tuple[str | None, str]:
    if not outputs_host_path:
        return None, "unknown"

    outputs_root = Path(outputs_host_path)
    if not outputs_root.is_dir():
        return None, "unknown"

    candidates = [
        path
        for path in outputs_root.rglob("*")
        if path.is_file()
        and not path.name.startswith(".")
        and not _is_internal_builder_supporting_path(path.as_posix())
        and path.suffix.lower() in _PROMOTABLE_ARTIFACT_EXTENSION_PRIORITY
    ]

    if builder_task_started_at_ms:
        min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
        candidates = [path for path in candidates if path.stat().st_mtime >= min_mtime]

    if not candidates:
        return None, "unknown"

    candidates.sort(
        key=lambda path: (
            _PROMOTABLE_ARTIFACT_EXTENSION_PRIORITY.get(
                path.suffix.lower(),
                len(_PROMOTABLE_ARTIFACT_EXTENSIONS),
            ),
            -path.stat().st_mtime,
        )
    )
    best = candidates[0]
    relative = best.relative_to(outputs_root).as_posix()
    return f"/mnt/user-data/outputs/{relative}", _infer_promoted_artifact_type(best)


def _upload_builder_outputs_to_supabase(
    user_id: str | None,
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> None:
    """Best-effort upload of the builder's outputs to Supabase Storage.

    Silently no-ops when Supabase is not configured, when user_id/thread_id or
    the outputs host path are missing, or when individual files cannot be read.
    Any failure is logged and swallowed so builder flow never regresses.
    """
    if not supabase_artifact_store.is_configured():
        return
    if not user_id or not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing user_id=%s thread_id=%s outputs_host_path=%s",
            user_id,
            thread_id,
            outputs_host_path,
        )
        return

    sanitized_args, removed_supporting_files = _sanitize_builder_artifact_args(artifact_args)
    if removed_supporting_files:
        logger.info(
            "Skipping internal builder supporting file uploads thread_id=%s files=%s",
            thread_id,
            ", ".join(removed_supporting_files),
        )

    candidates: list[str] = []
    primary = sanitized_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = sanitized_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        try:
            content = host_file.read_bytes()
        except FileNotFoundError:
            logger.warning(
                "Supabase upload skipped; local file missing thread_id=%s path=%s",
                thread_id,
                host_file,
            )
            continue
        except OSError as exc:
            logger.warning(
                "Supabase upload skipped; read error thread_id=%s path=%s error=%s",
                thread_id,
                host_file,
                exc,
            )
            continue

        try:
            supabase_artifact_store.upload_artifact(
                user_id=user_id,
                thread_id=thread_id,
                filename=relative,
                content=content,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort upload
            logger.warning(
                "Supabase upload failed; continuing without remote copy thread_id=%s path=%s error=%s",
                thread_id,
                relative,
                exc,
            )


class BuilderArtifactState(AgentState):
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_emit_rejection_count: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]


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
    def _last_turn_rejected_emit(state: BuilderArtifactState) -> bool:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        if not history:
            return False
        return bool(history[-1].get("rejected_emit_builder_artifact"))

    # Ceiling enforcement — MUST stay in sync with _resolve_builder_hard_ceiling
    # in after_model and with builder_task.py's _resolve_builder_hard_ceiling.
    # When the model is within this
    # many turns of termination, we force Anthropic tool_choice to emit so the
    # model literally cannot call any other tool. Prompt-level escalation is
    # not reliable mid-retry-loop; the API-level constraint is.
    _FORCE_EMIT_REMAINING = 2

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        if BuilderArtifactMiddleware._last_turn_rejected_emit(state):
            return False
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        if non_artifact_turns > 0 and _expected_text_artifact_ready(state):
            return True
        remaining = _resolve_builder_hard_ceiling(state) - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force emit_builder_artifact tool_choice when ceiling is imminent."""
        if self._should_force_emit(request.state):
            ceiling = _resolve_builder_hard_ceiling(request.state)
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s)",
                request.state.get("builder_non_artifact_turns"),
                ceiling,
            )
            request = request.override(tool_choice=self._forced_tool_choice())
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same logic as wrap_model_call."""
        if self._should_force_emit(request.state):
            ceiling = _resolve_builder_hard_ceiling(request.state)
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s)",
                request.state.get("builder_non_artifact_turns"),
                ceiling,
            )
            request = request.override(tool_choice=self._forced_tool_choice())
        return await handler(request)

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
                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_builder_artifact"]
                tool_names = self._tool_names(tool_calls)

                if artifact_calls and len(artifact_calls) == len(tool_calls):
                    args = artifact_calls[-1].get("args", {})
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = (
                        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    )
                    thread_id = runtime.context.get("thread_id") if runtime.context else None
                    builder_task_started_at_ms = state.get("builder_task_started_at_ms")
                    if not isinstance(builder_task_started_at_ms, (int, float)) or builder_task_started_at_ms <= 0:
                        builder_task_started_at_ms = int(time.time() * 1000)
                    original_primary = args.get("artifact_path") if isinstance(args, dict) else None
                    args, promoted_primary = _promote_internal_primary_artifact(outputs_host_path, args)
                    if promoted_primary is not None:
                        logger.info(
                            "BuilderArtifact: promoted internal artifact_path thread_id=%s from=%s to=%s",
                            thread_id,
                            original_primary,
                            promoted_primary,
                        )
                    if _is_internal_builder_supporting_path(args.get("artifact_path")) and not _is_allowed_internal_primary_code_artifact(
                        outputs_host_path,
                        args,
                    ):
                        raise FileNotFoundError(
                            "Builder emitted only an internal helper artifact_path: "
                            f"{args.get('artifact_path')}"
                        )
                    if not _materialize_missing_primary_artifact(outputs_host_path, args):
                        primary_host_file = _resolve_output_host_file(outputs_host_path, args.get("artifact_path"))
                        raise FileNotFoundError(
                            f"Builder emitted artifact_path but the file is missing: {primary_host_file or args.get('artifact_path')}"
                        )
                    pdf_validation_error = _validate_pdf_page_count(state, outputs_host_path, args)
                    if pdf_validation_error is not None:
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                        rejection_count = int(state.get("builder_emit_rejection_count", 0) or 0) + 1
                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": False,
                                "rejected_emit_builder_artifact": True,
                                "emit_rejection_count": rejection_count,
                            },
                        )
                        tool_messages = [
                            ToolMessage(
                                content=pdf_validation_error,
                                tool_call_id=tool_call["id"],
                                name="emit_builder_artifact",
                                status="error",
                            )
                            for tool_call in artifact_calls
                            if tool_call.get("id")
                        ]
                        log_middleware("BuilderArtifact", "rejected builder artifact emit due to PDF page mismatch", _t0)
                        return {
                            "messages": tool_messages,
                            # A rejected emit needs a fresh repair budget rather than another forced emit.
                            "builder_non_artifact_turns": 0,
                            "builder_emit_rejection_count": rejection_count,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_task_started_at_ms": builder_task_started_at_ms,
                        }
                    sanitized_args, removed_supporting_files = _sanitize_builder_artifact_args(args)
                    if removed_supporting_files:
                        logger.info(
                            "BuilderArtifact: stripped internal supporting files from builder result thread_id=%s files=%s",
                            thread_id,
                            ", ".join(removed_supporting_files),
                        )
                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                        },
                    )
                    supabase_user_id = (
                        runtime.context.get("user_id") if runtime.context else None
                    )
                    _upload_builder_outputs_to_supabase(
                        user_id=supabase_user_id,
                        thread_id=thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=sanitized_args,
                    )
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={sanitized_args.get('artifact_type')}, "
                        f"confidence={sanitized_args.get('confidence')}",
                        _t0,
                    )
                    return {
                        "builder_result": sanitized_args,
                        "builder_non_artifact_turns": 0,
                        "builder_emit_rejection_count": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
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

                # Hard ceiling: force end before hitting the recursion limit.
                # Binary deliverables (PDF/PPTX/DOCX) frequently need:
                #   1. write_todos
                #   2. write_file (generator script)
                #   3. bash (run) — may fail and need retries
                #   4. bash (verify / ls)
                #   5. emit_builder_artifact
                # On a tricky script, retries can eat 6-8 turns easily.
                # 20 gives bash room to recover; below that we were force-stopping
                # on healthy builds that just had one or two failed runs.
                _HARD_CEILING = _resolve_builder_hard_ceiling(state)
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    promoted_path: str | None = None
                    promoted_type = "unknown"
                    try:
                        thread_data_local = state.get("thread_data") or {}
                        outputs_host_path_local = (
                            thread_data_local.get("outputs_path")
                            if isinstance(thread_data_local, dict)
                            else None
                        )
                        promoted_path, promoted_type = _find_recent_public_output_artifact(
                            outputs_host_path_local,
                            builder_task_started_at_ms=builder_task_started_at_ms,
                        )
                    except Exception as exc:  # noqa: BLE001 — best-effort only
                        logger.warning(
                            "BuilderArtifact: ceiling fallback scan failed error=%s",
                            exc,
                        )

                    if promoted_path:
                        fallback = {
                            "artifact_path": promoted_path,
                            "artifact_type": promoted_type,
                            "artifact_title": "Build task completed (recovered)",
                            "steps_completed": non_artifact_turns,
                            "decisions_made": [],
                            "companion_summary": (
                                "The builder ran long and didn't call emit cleanly, "
                                "but the deliverable is on disk — I'm surfacing it now."
                            ),
                            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
                            "user_next_action": "Open the file and let me know if it lands.",
                            "confidence": 0.5,
                        }
                    else:
                        fallback = {
                            "artifact_path": None,
                            "artifact_type": "unknown",
                            "artifact_title": "Build task force-stopped",
                            "steps_completed": non_artifact_turns,
                            "decisions_made": [],
                            "companion_summary": (
                                f"The builder made {non_artifact_turns} edits but didn't finish cleanly. "
                                "No final deliverable was produced."
                            ),
                            "companion_tone_hint": "Apologetic — builder ran out of budget.",
                            "user_next_action": "Tell me what to try differently and I'll run it again.",
                            "confidence": 0.2,
                        }
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_emit_rejection_count": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
                        "jump_to": "end",
                    }

                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_emit_rejection_count": 0,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                }

            # AI message with NO tool calls -- recover a recent public artifact if one exists.
            thread_data_local = state.get("thread_data") or {}
            outputs_host_path_local = (
                thread_data_local.get("outputs_path") if isinstance(thread_data_local, dict) else None
            )
            builder_task_started_at_ms = state.get("builder_task_started_at_ms")
            promoted_path, promoted_type = _find_recent_public_output_artifact(
                outputs_host_path_local,
                builder_task_started_at_ms=builder_task_started_at_ms,
            )
            if promoted_path:
                fallback = {
                    "artifact_path": promoted_path,
                    "artifact_type": promoted_type,
                    "artifact_title": "Build task completed (recovered)",
                    "steps_completed": 0,
                    "decisions_made": [],
                    "companion_summary": (
                        "The builder finished without calling emit_builder_artifact cleanly, "
                        "but the deliverable is on disk and is being surfaced now."
                    ),
                    "companion_tone_hint": "Reassuring -- deliverable recovered after plain-text completion.",
                    "user_next_action": "Open the file and confirm whether it matches the request.",
                    "confidence": 0.5,
                }
            else:
                fallback = {
                    "artifact_path": None,
                    "artifact_type": "unknown",
                    "artifact_title": "Build task completed",
                    "steps_completed": 0,
                    "decisions_made": [],
                    "companion_summary": "The build task was completed.",
                    "companion_tone_hint": "Neutral -- no builder context available.",
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
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_emit_rejection_count": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
