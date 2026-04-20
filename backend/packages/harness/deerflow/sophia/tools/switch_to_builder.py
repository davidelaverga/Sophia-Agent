"""switch_to_builder tool.

Delegates a task to the sophia_builder agent after the companion has
gathered all clarifying information. Uses SubagentExecutor with a
pre-built builder agent and passes delegation_context through configurable
so BuilderTaskMiddleware can inject tone/ritual guidance.
"""

import logging
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.sophia.tools._tool_call_id import resolve_tool_call_id
from deerflow.sophia.tools.builder_delivery import build_builder_delivery_payload
from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import (
    SubagentStatus,
    cleanup_background_task,
    get_background_task_result,
)

logger = logging.getLogger(__name__)

TOOL_NAME = "switch_to_builder"

# Per-task-type timeouts (in seconds). The builder needs significantly longer
# than the 120s we used in earlier revisions because research + visual reports
# routinely require dozens of tool calls. The timeout is the only safety net
# that fires when something genuinely goes wrong; companion-facing latency is
# handled by pause/resume (PR G Commit 2), not a shorter timeout.
TASK_TYPE_TIMEOUTS: dict[str, int] = {
    "document": 600,
    "presentation": 900,
    "research": 900,
    "visual_report": 900,
    "frontend": 720,
}
DEFAULT_TIMEOUT_SECONDS = 600

# Builder result status taxonomy used across the companion/builder contract.
# Commit 1 introduces `completed`, `failed_retryable`, and `failed_terminal`.
# `partial` is introduced by Commit 2 (pause/resume). These strings are the
# canonical values that `skills/public/sophia/AGENTS.md` documents.
BUILDER_STATUS_COMPLETED = "completed"
BUILDER_STATUS_PARTIAL = "partial"
BUILDER_STATUS_FAILED_RETRYABLE = "failed_retryable"
BUILDER_STATUS_FAILED_TERMINAL = "failed_terminal"


class SwitchToBuilderInput(BaseModel):
    task: str = Field(
        description="Complete task description with all specs gathered "
                    "from clarification. Be specific — the builder cannot "
                    "ask follow-up questions."
    )
    task_type: Literal["frontend", "presentation", "research", "document", "visual_report"] = Field(
        description="Type of deliverable. Determines builder skill loading."
    )
    retry_attempt: int = Field(
        default=0,
        ge=0,
        le=2,
        description=(
            "0 for the first delegation. Increment to 1 when the user has asked "
            "Sophia to retry after a `failed_retryable` builder result. 2 is "
            "reserved for the rare case of a second retry; after that the "
            "companion should offer alternatives instead of delegating again."
        ),
    )
    resume_from_task_id: str | None = Field(
        default=None,
        description=(
            "Pass the continuation_task_id from a previous `partial` builder "
            "result when the user confirms they want to resume the build. "
            "The builder will receive a <resume_from> briefing that lists the "
            "already-completed files and a summary of what was done so it can "
            "pick up without redoing work. Leave null for a fresh delegation."
        ),
    )


def resolve_builder_timeout(task_type: str) -> int:
    """Return the timeout (seconds) for a given builder task type.

    Unknown task types fall back to ``DEFAULT_TIMEOUT_SECONDS``.
    """
    return TASK_TYPE_TIMEOUTS.get(task_type, DEFAULT_TIMEOUT_SECONDS)


def _build_resume_context_from_previous_task(prev_task_id: str) -> dict | None:
    """Fetch the prior builder task and project its partial result as
    resume context for the next delegation.

    Returns None when no matching task is found (expired or never existed),
    which the caller treats as “no resume context available” so the builder
    still starts, albeit from scratch.
    """
    prev = get_background_task_result(prev_task_id)
    if prev is None:
        logger.warning(
            "[Builder] resume_from_task_id=%s not found; starting without resume context",
            prev_task_id,
        )
        return None

    prev_builder_result: dict = {}
    if prev.final_state and isinstance(prev.final_state, dict):
        candidate = prev.final_state.get("builder_result")
        if isinstance(candidate, dict):
            prev_builder_result = candidate

    # We resume on any prior builder_result that exposes completed files or a
    # summary; that covers `partial` pauses AND the recovered partial paths
    # built from failed/timed-out runs in Commit 1.
    completed_files = prev_builder_result.get("completed_files") or []
    if not completed_files:
        artifact_path = prev_builder_result.get("artifact_path")
        if isinstance(artifact_path, str) and artifact_path.strip():
            completed_files = [artifact_path]
        supporting = prev_builder_result.get("supporting_files") or []
        if isinstance(supporting, list):
            completed_files = list(completed_files) + [
                path for path in supporting if isinstance(path, str) and path.strip()
            ]

    if not completed_files and not prev_builder_result.get("summary_of_done"):
        logger.info(
            "[Builder] resume_from_task_id=%s has no recoverable progress; skipping resume context",
            prev_task_id,
        )
        return None

    return {
        "previous_task_id": prev_task_id,
        "previous_status": prev_builder_result.get("status"),
        "previous_continuation_task_id": prev_builder_result.get("continuation_task_id"),
        "completed_files": completed_files,
        "summary_of_done": prev_builder_result.get("summary_of_done")
        or prev_builder_result.get("companion_summary"),
        "turns_used": prev_builder_result.get("turns_used"),
        "turn_cap": prev_builder_result.get("turn_cap"),
        "previous_artifact_path": prev_builder_result.get("artifact_path"),
    }


@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(
    task: str,
    task_type: str,
    retry_attempt: int = 0,
    resume_from_task_id: str | None = None,
    runtime: ToolRuntime[ContextT, SophiaState] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> Command | str:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief.
    Pass resume_from_task_id only after the user explicitly asks to continue a
    paused (partial) build."""

    resolved_tool_call_id = resolve_tool_call_id(
        runtime,
        tool_call_id,
        tool_name=TOOL_NAME,
    )

    # ------------------------------------------------------------------
    # 1. Extract companion state
    # ------------------------------------------------------------------
    companion_artifact = {}
    user_id = "default_user"
    active_ritual = None
    ritual_phase = None
    injected_memories: list[str] = []
    sandbox_state = None
    thread_data = None
    thread_id = None
    parent_model = None
    trace_id = str(uuid.uuid4())[:8]

    if runtime is not None:
        state = runtime.state or {}

        # Companion artifact — full emotional snapshot
        companion_artifact = (
            state.get("current_artifact")
            or state.get("previous_artifact")
            or {}
        )

        user_id = state.get("user_id", "default_user")
        active_ritual = state.get("active_ritual")
        ritual_phase = state.get("ritual_phase")
        injected_memories = state.get("injected_memories", [])

        # Infrastructure context
        sandbox_state = state.get("sandbox")
        thread_data = state.get("thread_data")

        # thread_id: try runtime.context, then config.configurable
        if runtime.context:
            thread_id = runtime.context.get("thread_id")
        if not thread_id and runtime.config:
            thread_id = runtime.config.get("configurable", {}).get("thread_id")

        metadata = runtime.config.get("metadata", {}) if runtime.config else {}
        parent_model = metadata.get("model_name")
        trace_id = metadata.get("trace_id") or trace_id

    # Fallback: LangChain ContextVar
    if not thread_id:
        try:
            from langchain_core.runnables.config import var_child_runnable_config
            run_config = var_child_runnable_config.get({})
            thread_id = run_config.get("configurable", {}).get("thread_id")
        except Exception:
            pass

    logger.info(
        "[Builder] switch_to_builder called: task_type=%s, retry_attempt=%d, resume_from=%s, tone=%.1f, ritual=%s, thread_id=%s",
        task_type,
        retry_attempt,
        resume_from_task_id,
        companion_artifact.get("tone_estimate", 2.5),
        active_ritual,
        thread_id,
    )

    # ------------------------------------------------------------------
    # 2. Build delegation context (per spec §2.1)
    # ------------------------------------------------------------------
    resume_context = None
    if resume_from_task_id:
        resume_context = _build_resume_context_from_previous_task(resume_from_task_id)

    delegation_context = {
        "task": task,
        "task_type": task_type,
        "retry_attempt": retry_attempt,
        "companion_artifact": companion_artifact,
        "user_identity": None,  # injected by UserIdentityMiddleware in builder chain
        "relevant_memories": injected_memories[:5],
        "active_ritual": active_ritual,
        "ritual_phase": ritual_phase,
        "resume_context": resume_context,
    }

    # ------------------------------------------------------------------
    # 3. Create builder agent
    # ------------------------------------------------------------------
    from deerflow.agents.sophia_agent.builder_agent import _create_builder_agent
    builder_agent = _create_builder_agent(user_id=user_id)

    # ------------------------------------------------------------------
    # 4. Create executor with pre-built agent
    # ------------------------------------------------------------------
    config = get_subagent_config("general-purpose")
    if config is None:
        logger.warning("[Builder] subagent config not found — returning stub")
        return f"Builder task queued: [{task_type}] {task}"

    # Override limits for builder execution. Timeout is chosen per-task-type
    # because research and visual reports routinely need more wall-clock time
    # than a short document edit. See `TASK_TYPE_TIMEOUTS` above.
    timeout_seconds = resolve_builder_timeout(task_type)
    config = replace(config, max_turns=50, timeout_seconds=timeout_seconds, name="sophia_builder")

    executor = SubagentExecutor(
        config=config,
        tools=[],  # tools are already in the pre-built agent
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=thread_id,
        trace_id=trace_id,
        pre_built_agent=builder_agent,
        extra_configurable={"delegation_context": delegation_context},  # merged into initial state
    )

    # ------------------------------------------------------------------
    # 5. Execute + poll
    # ------------------------------------------------------------------
    task_id = resolved_tool_call_id or str(uuid.uuid4())[:8]
    executor.execute_async(task, task_id=task_id)
    logger.info("[Builder] Task %s started (trace=%s)", task_id, trace_id)

    # Stream progress via get_stream_writer if available
    try:
        from langgraph.config import get_stream_writer
        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": f"Builder: {task_type}"})
    except Exception:
        writer = None

    poll_count = 0
    max_poll_count = (config.timeout_seconds + 60) // 5

    while True:
        result = get_background_task_result(task_id)

        if result is None:
            logger.error("[Builder] Task %s not found", task_id)
            cleanup_background_task(task_id)
            return _format_error_command("Task disappeared", resolved_tool_call_id)

        if result.status == SubagentStatus.COMPLETED:
            logger.info("[Builder] Task %s completed after %d polls", task_id, poll_count)
            if writer:
                writer({"type": "task_completed", "task_id": task_id, "result": result.result})

            # Extract builder_result from final state
            builder_result = extract_builder_result_from_subagent_result(result)
            # Tag the status field so the companion can rely on the shared
            # status taxonomy without having to re-derive it from the
            # artifact payload. Existing builders may not set this yet.
            builder_result.setdefault("status", BUILDER_STATUS_COMPLETED)
            builder_delivery = build_builder_delivery_payload(
                thread_id=thread_id,
                builder_result=builder_result,
            )
            title = builder_result.get("artifact_title") or "the deliverable"

            # The builder can now halt itself at the turn cap with a partial
            # result. The subagent finishes cleanly in that case (status
            # COMPLETED), but the builder_result.status tells us to prompt the
            # user to continue or stop instead of presenting a final delivery.
            if builder_result.get("status") == BUILDER_STATUS_PARTIAL:
                cleanup_background_task(task_id)
                return _build_partial_pause_command(
                    task=task,
                    task_type=task_type,
                    task_id=task_id,
                    thread_id=thread_id,
                    builder_result=builder_result,
                    builder_delivery=builder_delivery,
                    tool_call_id=resolved_tool_call_id,
                )

            cleanup_background_task(task_id)
            tool_message = (
                f"Builder completed successfully. {title} is ready, and this reply can attach it for delivery."
                if builder_delivery is not None
                else f"Builder completed successfully. {title} is ready. Present it naturally to the user."
            )
            return Command(
                update={
                    "builder_result": builder_result,
                    "builder_task": {
                        "task": task,
                        "task_type": task_type,
                        "task_id": task_id,
                        "status": "completed",
                    },
                    "builder_delivery": builder_delivery,
                    "messages": [
                        ToolMessage(
                            tool_message,
                            tool_call_id=resolved_tool_call_id,
                            name=TOOL_NAME,
                        )
                    ],
                }
            )

        elif result.status == SubagentStatus.FAILED:
            logger.error("[Builder] Task %s failed: %s", task_id, result.error)
            if writer:
                writer({"type": "task_failed", "task_id": task_id, "error": result.error})
            partial_update = _build_partial_builder_update(
                result=result,
                task=task,
                task_type=task_type,
                task_id=task_id,
                status="failed",
                thread_id=thread_id,
                tool_call_id=resolved_tool_call_id,
                failure_reason=result.error or "Unknown error",
                retry_attempt=retry_attempt,
            )
            cleanup_background_task(task_id)
            if partial_update is not None:
                return partial_update
            return _format_error_command(
                result.error or "Unknown error",
                resolved_tool_call_id,
                retry_attempt=retry_attempt,
            )

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            if writer:
                writer({"type": "task_timed_out", "task_id": task_id})
            partial_update = _build_partial_builder_update(
                result=result,
                task=task,
                task_type=task_type,
                task_id=task_id,
                status="timed_out",
                thread_id=thread_id,
                tool_call_id=resolved_tool_call_id,
                failure_reason=f"Timed out after {config.timeout_seconds}s",
                retry_attempt=retry_attempt,
            )
            cleanup_background_task(task_id)
            if partial_update is not None:
                return partial_update
            return _format_error_command(
                f"Timed out after {config.timeout_seconds}s",
                resolved_tool_call_id,
                retry_attempt=retry_attempt,
            )

        time.sleep(5)
        poll_count += 1

        if poll_count > max_poll_count:
            logger.error("[Builder] Task %s polling timed out", task_id)
            cleanup_background_task(task_id)
            return _format_error_command(
                f"Polling timed out after {poll_count} polls",
                resolved_tool_call_id,
                retry_attempt=retry_attempt,
            )


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def extract_builder_result_from_subagent_result(result) -> dict:
    """Extract builder_result from terminal subagent state or tool-call fallbacks."""
    # Primary path: BuilderArtifactMiddleware stored it in final state
    if result.final_state and result.final_state.get("builder_result"):
        return result.final_state["builder_result"]

    # Fallback: scan AI messages for emit_builder_artifact tool call
    for msg_dict in reversed(result.ai_messages or []):
        for tc in msg_dict.get("tool_calls", []):
            if tc.get("name") == "emit_builder_artifact":
                return tc.get("args", {})
    presented_artifacts = _extract_presented_artifact_paths(result)
    primary_artifact_path = presented_artifacts[0] if presented_artifacts else None
    supporting_files = presented_artifacts[1:] or None
    if primary_artifact_path:
        logger.warning(
            "[Builder] recoverable builder fallback: present_files emitted without emit_builder_artifact task_id=%s artifact=%s",
            getattr(result, "task_id", None),
            primary_artifact_path,
        )

    # Last resort: wrap the text result
    return {
        "artifact_path": primary_artifact_path,
        "artifact_type": _infer_builder_artifact_type(primary_artifact_path),
        "artifact_title": Path(primary_artifact_path).name if primary_artifact_path else "Build task completed",
        "supporting_files": supporting_files,
        "steps_completed": 0,
        "decisions_made": [],
        "companion_summary": result.result or "The build task was completed.",
        "companion_tone_hint": (
            "Share this as a draft because the builder finished without its final packaging step."
            if primary_artifact_path
            else "Neutral"
        ),
        "user_next_action": None,
        "confidence": 0.3,
    }


def _extract_presented_artifact_paths(result) -> list[str]:
    candidates: list[str] = []
    final_state = getattr(result, "final_state", None)
    if isinstance(final_state, dict):
        final_artifacts = final_state.get("artifacts")
        if isinstance(final_artifacts, list):
            candidates.extend(path for path in final_artifacts if isinstance(path, str))

    for msg_dict in reversed(getattr(result, "ai_messages", None) or []):
        if not isinstance(msg_dict, dict):
            continue
        tool_calls = msg_dict.get("tool_calls", [])
        if not isinstance(tool_calls, list):
            continue
        for tc in reversed(tool_calls):
            if not isinstance(tc, dict) or tc.get("name") != "present_files":
                continue
            args = tc.get("args", {})
            if not isinstance(args, dict):
                continue
            filepaths = args.get("filepaths", [])
            if isinstance(filepaths, list):
                candidates.extend(path for path in filepaths if isinstance(path, str))

    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return normalized


def _infer_builder_artifact_type(path: str | None) -> str:
    if not path:
        return "unknown"

    suffix = Path(path).suffix.lower()
    if suffix in {".ppt", ".pptx", ".key"}:
        return "presentation"
    if suffix in {".html", ".htm"}:
        return "webpage"
    if suffix in {".csv", ".json", ".xlsx"}:
        return "data_analysis"
    if suffix in {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs"}:
        return "code"
    return "document"


def _build_partial_pause_command(
    *,
    task: str,
    task_type: str,
    task_id: str,
    thread_id: str | None,
    builder_result: dict,
    builder_delivery: dict | None,
    tool_call_id: str,
) -> Command:
    """Build the Command returned when the builder paused at the turn cap.

    The ToolMessage is explicit about asking the user whether to continue,
    and carries the ``continuation_task_id`` so the companion can round-trip
    it back into ``switch_to_builder(resume_from_task_id=...)`` without
    inventing a new value.
    """
    continuation_task_id = builder_result.get("continuation_task_id") or task_id
    completed_files = builder_result.get("completed_files") or []
    completed_preview = ", ".join(completed_files[:3]) if completed_files else "no files yet"
    summary = (
        builder_result.get("summary_of_done")
        or builder_result.get("companion_summary")
        or ""
    )
    summary_line = f" Summary so far: {summary}" if summary else ""
    delivery_line = (
        " A partial draft is attached for this reply."
        if builder_delivery is not None
        else ""
    )
    tool_message = (
        "Builder paused after hitting the turn cap "
        f"({builder_result.get('turns_used')}/{builder_result.get('turn_cap')})."
        f"{delivery_line} Completed so far: {completed_preview}."
        f"{summary_line} Tell the user: 'We reached the building turn limit. Do you want to continue?' "
        "If they say yes, call switch_to_builder again with the SAME task description and "
        f"resume_from_task_id='{continuation_task_id}'. If they say no, present what we have and stop."
    )
    logger.info(
        "[Builder] partial pause emitted task_id=%s continuation_task_id=%s completed_files=%d",
        task_id,
        continuation_task_id,
        len(completed_files),
    )
    return Command(
        update={
            "builder_result": builder_result,
            "builder_task": {
                "task": task,
                "task_type": task_type,
                "task_id": task_id,
                "status": BUILDER_STATUS_PARTIAL,
                "continuation_task_id": continuation_task_id,
            },
            "builder_delivery": builder_delivery,
            "messages": [
                ToolMessage(
                    tool_message,
                    tool_call_id=tool_call_id,
                    name=TOOL_NAME,
                )
            ],
        }
    )


def _retry_aware_failure_message(*, base: str, retry_attempt: int) -> str:
    """Pick the user-facing phrasing for a builder failure.

    ``retry_attempt == 0`` means this was the first try — we offer a retry.
    ``retry_attempt >= 1`` means the user already asked for a second run and
    it still failed; we flag this as likely technical and offer alternatives
    instead of silently retrying again.
    """
    if retry_attempt <= 0:
        return (
            f"{base} Tell the user: 'Something went wrong during building. "
            "Do you want me to try again?' Do not retry automatically; wait "
            "for the user to confirm."
        )
    return (
        f"{base} The previous retry also failed. Tell the user this looks "
        "like a technical issue and offer alternatives: a partial draft from "
        "what we already have, a text summary, or stopping for now. Do NOT "
        "delegate to the builder again on your own."
    )


def _build_partial_builder_update(
    *,
    result,
    task: str,
    task_type: str,
    task_id: str,
    status: str,
    thread_id: str | None,
    tool_call_id: str,
    failure_reason: str,
    retry_attempt: int = 0,
) -> Command | None:
    builder_result = extract_builder_result_from_subagent_result(result)
    artifact_path = builder_result.get("artifact_path")
    supporting_files = builder_result.get("supporting_files")
    has_recoverable_output = (
        isinstance(artifact_path, str) and bool(artifact_path.strip())
    ) or (
        isinstance(supporting_files, list) and any(isinstance(path, str) and path.strip() for path in supporting_files)
    )
    if not has_recoverable_output:
        return None

    # Partial deliveries are still a best-effort recovery of a failed or
    # timed-out build. The companion should treat them using the same
    # retryable-vs-terminal taxonomy as a hard failure so the retry
    # prompt is consistent across both surfaces.
    builder_status = (
        BUILDER_STATUS_FAILED_RETRYABLE
        if retry_attempt <= 0
        else BUILDER_STATUS_FAILED_TERMINAL
    )
    builder_result["status"] = builder_status

    builder_delivery = build_builder_delivery_payload(
        thread_id=thread_id,
        builder_result=builder_result,
    )
    title = builder_result.get("artifact_title") or "the draft deliverable"
    failure_label = "timed out" if status == "timed_out" else "hit an error"
    base_message = (
        f"Builder {failure_label} before finishing cleanly, but {title} is attached for this reply. "
        f"Tell the user it is a draft or partial result and briefly mention this limitation: {failure_reason}"
        if builder_delivery is not None
        else f"Builder {failure_label} before finishing cleanly, but it produced a partial result for {title}. "
        f"Tell the user it is incomplete and briefly mention this limitation: {failure_reason}"
    )
    tool_message = _retry_aware_failure_message(
        base=base_message,
        retry_attempt=retry_attempt,
    )
    logger.warning(
        "[Builder] returning partial builder result after %s task_id=%s artifact=%s status=%s retry_attempt=%d",
        status,
        task_id,
        artifact_path,
        builder_status,
        retry_attempt,
    )
    return Command(
        update={
            "builder_result": builder_result,
            "builder_task": {
                "task": task,
                "task_type": task_type,
                "task_id": task_id,
                "status": status,
                "error": failure_reason,
            },
            "builder_delivery": builder_delivery,
            "messages": [
                ToolMessage(
                    tool_message,
                    tool_call_id=tool_call_id,
                    name=TOOL_NAME,
                )
            ],
        }
    )


def _format_error_command(
    error: str,
    tool_call_id: str,
    *,
    retry_attempt: int = 0,
) -> Command:
    """Return a Command that surfaces a builder error as a paired ToolMessage.

    LangGraph requires every tool call to have a matching ``ToolMessage`` in
    the response, so a builder failure must travel back as a ToolMessage with
    the originating ``tool_call_id`` rather than a bare string. The ``name``
    is set so downstream message inspection can attribute the failure to
    ``switch_to_builder`` reliably.

    The phrasing branches on ``retry_attempt`` so the companion tells the
    user the right thing (retry prompt vs alternatives). The companion must
    never retry on its own; retry_attempt is only incremented when the user
    explicitly asks to try again.
    """
    base = f"Builder failed: {error}."
    message = _retry_aware_failure_message(
        base=base,
        retry_attempt=retry_attempt,
    )
    return Command(
        update={
            "messages": [
                ToolMessage(
                    message,
                    tool_call_id=tool_call_id,
                    name=TOOL_NAME,
                )
            ],
        }
    )
