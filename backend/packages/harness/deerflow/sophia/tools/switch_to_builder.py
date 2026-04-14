"""switch_to_builder tool.

Delegates a task to the sophia_builder agent after the companion has
gathered all clarifying information.  Uses SubagentExecutor with a
pre-built builder agent and passes delegation_context through configurable
so BuilderTaskMiddleware can inject tone/ritual guidance.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import replace
from typing import Annotated, Any, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import (
    SubagentStatus,
    cleanup_background_task,
    get_background_task_result,
)

logger = logging.getLogger(__name__)

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

_PROGRESS_TOPIC_RE = re.compile(r"\bTopic:\s*(.+?)(?:\.\s|$)", re.IGNORECASE)
_PROGRESS_ORIGINAL_REQUEST_RE = re.compile(r"\bOriginal request:\s*(.+?)(?:\s+Topic:|$)", re.IGNORECASE)
_PROGRESS_COMMAND_RE = re.compile(
    r"(?:create|make|draft|write|generate|build|research|prepare|design|produce)\s+(.+)",
    re.IGNORECASE,
)
_PROGRESS_LEADING_ARTICLE_RE = re.compile(r"^(?:a|an|the)\s+", re.IGNORECASE)
_PROGRESS_WHITESPACE_RE = re.compile(r"\s+")
_PROGRESS_TRAILING_PUNCTUATION_RE = re.compile(r"[\s.:;,-]+$")
_PROGRESS_MAX_LENGTH = 88


class SwitchToBuilderInput(BaseModel):
    task: str = Field(
        description="Complete task description with all specs gathered "
                    "from clarification. Be specific — the builder cannot "
                    "ask follow-up questions."
    )
    task_type: Literal["frontend", "presentation", "research", "document", "visual_report"] = Field(
        description="Type of deliverable. Determines builder skill loading."
    )


@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(
    task: str,
    task_type: str,
    runtime: ToolRuntime[ContextT, dict[str, Any]] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> Command | str:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief."""

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
        configurable = runtime.config.get("configurable", {}) if runtime.config else {}

        # Companion artifact — full emotional snapshot
        companion_artifact = (
            state.get("current_artifact")
            or state.get("previous_artifact")
            or {}
        )

        user_id = state.get("user_id") or configurable.get("user_id") or "default_user"
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
        parent_model = metadata.get("model_name") or configurable.get("model_name")
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
        "[Builder] switch_to_builder called: task_type=%s, tone=%.1f, ritual=%s, thread_id=%s",
        task_type,
        companion_artifact.get("tone_estimate", 2.5),
        active_ritual,
        thread_id,
    )

    task, task_type, demo_mode = _normalize_builder_request(
        task=task,
        task_type=task_type,
        companion_artifact=companion_artifact,
    )
    progress_description = _build_builder_progress_description(task, task_type, demo_mode)
    if demo_mode:
        logger.info(
            "[Builder] normalized generic demo request to deterministic document flow"
        )

    # ------------------------------------------------------------------
    # 2. Build delegation context (per spec §2.1)
    # ------------------------------------------------------------------
    delegation_context = {
        "task": task,
        "task_type": task_type,
        "companion_artifact": companion_artifact,
        "user_identity": None,  # injected by UserIdentityMiddleware in builder chain
        "relevant_memories": injected_memories[:5],
        "active_ritual": active_ritual,
        "ritual_phase": ritual_phase,
    }

    # ------------------------------------------------------------------
    # 3. Create builder agent
    # ------------------------------------------------------------------
    from deerflow.agents.sophia_agent.builder_agent import _create_builder_agent

    builder_agent = _create_builder_agent(user_id=user_id, model_name=parent_model)

    # ------------------------------------------------------------------
    # 4. Create executor with pre-built agent
    # ------------------------------------------------------------------
    config = get_subagent_config("general-purpose")
    if config is None:
        logger.warning("[Builder] subagent config not found — returning stub")
        return f"Builder task queued: [{task_type}] {task}"

    # Override limits for builder execution
    max_turns, timeout_seconds = _resolve_builder_limits(demo_mode)
    config = replace(
        config,
        max_turns=max_turns,
        timeout_seconds=timeout_seconds,
        name="sophia_builder",
    )

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
        stream_messages=False,
    )

    # ------------------------------------------------------------------
    # 5. Execute + poll
    # ------------------------------------------------------------------
    task_id = tool_call_id or str(uuid.uuid4())[:8]
    response_tool_call_id = tool_call_id or getattr(runtime, "tool_call_id", "") if runtime is not None else tool_call_id
    executor.execute_async(task, task_id=task_id, owner_id=user_id)
    logger.info("[Builder] Task %s started (trace=%s)", task_id, trace_id)

    # Stream progress via get_stream_writer if available
    try:
        from langgraph.config import get_stream_writer
        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": progress_description})
    except Exception:
        writer = None

    poll_count = 0
    max_poll_count = (config.timeout_seconds + 60) // 5

    while True:
        result = get_background_task_result(task_id)

        if result is None:
            logger.error("[Builder] Task %s not found", task_id)
            cleanup_background_task(task_id)
            return _format_error("Task disappeared")

        if result.status == SubagentStatus.COMPLETED:
            logger.info("[Builder] Task %s completed after %d polls", task_id, poll_count)
            if writer:
                writer({
                    "type": "task_completed",
                    "task_id": task_id,
                    "description": progress_description,
                    "result": result.result,
                })
            cleanup_background_task(task_id)

            # Extract builder_result from final state
            builder_result = _extract_builder_result(result)
            if response_tool_call_id:
                return Command(
                    update={
                        "builder_result": builder_result,
                        "builder_task": {
                            "status": "completed",
                            "task_id": task_id,
                            "task_type": task_type,
                        },
                        "messages": [
                            ToolMessage(
                                content=_format_success(builder_result),
                                tool_call_id=response_tool_call_id,
                                name="switch_to_builder",
                            )
                        ],
                    }
                )
            return _format_success(builder_result)

        elif result.status in {SubagentStatus.PENDING, SubagentStatus.RUNNING}:
            if writer:
                writer(
                    {
                        "type": "task_running",
                        "task_id": task_id,
                        "description": progress_description,
                    }
                )

        elif result.status == SubagentStatus.CANCELLED:
            logger.info("[Builder] Task %s cancelled", task_id)
            if writer:
                writer({
                    "type": "task_cancelled",
                    "task_id": task_id,
                    "description": progress_description,
                    "error": result.error,
                })
            cleanup_background_task(task_id)
            return _format_cancelled(result.error)

        elif result.status == SubagentStatus.FAILED:
            logger.error("[Builder] Task %s failed: %s", task_id, result.error)
            if writer:
                writer({
                    "type": "task_failed",
                    "task_id": task_id,
                    "description": progress_description,
                    "error": result.error,
                })
            cleanup_background_task(task_id)
            return _format_error(result.error or "Unknown error")

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            if writer:
                writer({
                    "type": "task_timed_out",
                    "task_id": task_id,
                    "description": progress_description,
                })
            cleanup_background_task(task_id)
            return _format_error(f"Timed out after {config.timeout_seconds}s")

        time.sleep(5)
        poll_count += 1

        if poll_count > max_poll_count:
            logger.error("[Builder] Task %s polling timed out", task_id)
            cleanup_background_task(task_id)
            return _format_error(f"Polling timed out after {poll_count} polls")


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _extract_builder_result(result) -> dict:
    """Extract builder_result from SubagentResult.final_state or ai_messages."""
    # Primary path: BuilderArtifactMiddleware stored it in final state
    if result.final_state and result.final_state.get("builder_result"):
        return result.final_state["builder_result"]

    # Fallback: scan AI messages for emit_builder_artifact tool call
    for msg_dict in reversed(result.ai_messages or []):
        for tc in msg_dict.get("tool_calls", []):
            if tc.get("name") == "emit_builder_artifact":
                return tc.get("args", {})

    # Last resort: wrap the text result
    return {
        "artifact_path": None,
        "artifact_type": "unknown",
        "artifact_title": "Build task completed",
        "steps_completed": 0,
        "decisions_made": [],
        "companion_summary": result.result or "The build task was completed.",
        "companion_tone_hint": "Neutral",
        "user_next_action": None,
        "confidence": 0.3,
    }


def _normalize_builder_request(
    task: str,
    task_type: str,
    companion_artifact: dict,
) -> tuple[str, str, bool]:
    """Coerce underspecified Builder demo requests into a small deterministic task."""
    if not _should_use_demo_builder_task(task, task_type, companion_artifact):
        return task, task_type, False

    return _build_demo_builder_task(), "document", True


def _build_builder_progress_description(task: str, task_type: str, demo_mode: bool) -> str:
    """Return a short user-facing description for Builder lifecycle events."""
    if demo_mode:
        return "Builder: demo document deliverable"

    summary = _extract_progress_summary(task, task_type)
    if not summary:
        summary = task_type.replace("_", " ")

    return f"Builder: {_truncate_progress_summary(summary)}"


def _extract_progress_summary(task: str, task_type: str) -> str:
    normalized_task = _PROGRESS_WHITESPACE_RE.sub(" ", task).strip()
    if not normalized_task:
        return ""

    if task_type == "document":
        topic_match = _PROGRESS_TOPIC_RE.search(normalized_task)
        if topic_match:
            topic = _clean_progress_text(topic_match.group(1))
            if topic:
                return f"document about {topic}"

    original_request_match = _PROGRESS_ORIGINAL_REQUEST_RE.search(normalized_task)
    if original_request_match:
        summary = _summarize_progress_request(original_request_match.group(1))
        if summary:
            return summary

    summary = _summarize_progress_request(normalized_task)
    if summary:
        return summary

    return task_type.replace("_", " ")


def _summarize_progress_request(text: str) -> str:
    cleaned = _clean_progress_text(text)
    if not cleaned:
        return ""

    command_match = _PROGRESS_COMMAND_RE.search(cleaned)
    if command_match:
        cleaned = command_match.group(1)

    cleaned = _PROGRESS_LEADING_ARTICLE_RE.sub("", cleaned).strip()
    return _clean_progress_text(cleaned)


def _clean_progress_text(text: str) -> str:
    cleaned = _PROGRESS_WHITESPACE_RE.sub(" ", text).strip(" \t\r\n\"'")
    cleaned = _PROGRESS_TRAILING_PUNCTUATION_RE.sub("", cleaned)
    return cleaned.strip()


def _truncate_progress_summary(text: str) -> str:
    if len(text) <= _PROGRESS_MAX_LENGTH:
        return text

    truncated = text[: _PROGRESS_MAX_LENGTH - 3].rsplit(" ", 1)[0].strip()
    if not truncated:
        truncated = text[: _PROGRESS_MAX_LENGTH - 3].strip()
    return f"{truncated}..."


def _should_use_demo_builder_task(
    task: str,
    task_type: str,
    companion_artifact: dict,
) -> bool:
    """Detect explicit Builder smoke-test turns that should avoid open-ended frontend work."""
    if task_type not in {"frontend", "research", "document"}:
        return False

    artifact_text = " ".join(
        str(companion_artifact.get(field, ""))
        for field in ("session_goal", "active_goal", "takeaway")
    )
    combined = f"{task} {artifact_text}".lower()

    if any(marker in combined for marker in _BUILDER_DEMO_MARKERS):
        return True

    return "builder" in combined and any(
        marker in combined for marker in _BUILDER_GENERIC_DEMO_MARKERS
    )


def _build_demo_builder_task() -> str:
    """Return a small Builder task that proves the end-to-end flow quickly."""
    return (
        "Create exactly one markdown file named builder-demo.md in the outputs directory. "
        "Keep it under 180 words and do not ask clarifying questions. "
        "Use default placeholder content that demonstrates Builder completed a task successfully. "
        "Use this structure: '# Builder Demo', '## What Sophia generated', '## Assumptions used', and '## Next step'. "
        "After writing the file, call emit_builder_artifact as your final action with artifact_path='outputs/builder-demo.md', "
        "artifact_type='document', artifact_title='Builder Demo Deliverable', steps_completed=3, "
        "decisions_made=['Used a minimal markdown deliverable', 'Filled missing specs with defaults'], "
        "companion_summary='Created a quick demo deliverable from defaults so the Builder flow can be verified.', "
        "companion_tone_hint='Confident', user_next_action='Open or download the file, then ask for a real deliverable next.', "
        "confidence=0.82. Create no other files and do not run extra commands."
    )


def _resolve_builder_limits(demo_mode: bool) -> tuple[int, int]:
    """Return recursion and timeout budgets for the delegated Builder task."""
    if demo_mode:
        return 16, 45
    return 50, 120


def _format_success(builder_result: dict) -> str:
    """Format the builder result for the companion's synthesis turn."""
    summary = builder_result.get("companion_summary", "Build task completed.")
    artifact_title = builder_result.get("artifact_title", "")
    # Return structured JSON so companion can parse if needed,
    # with a human-readable prefix
    return (
        f"Builder completed successfully.\n"
        f"Title: {artifact_title}\n"
        f"Summary: {summary}\n"
        f"Full result: {json.dumps(builder_result)}"
    )


def _format_error(error: str) -> str:
    """Format a builder error for the companion."""
    return f"Builder failed: {error}"


def _format_cancelled(reason: str | None) -> str:
    """Format a cancelled builder task for the companion."""
    resolved_reason = reason or "Execution cancelled by user"
    return f"Builder cancelled: {resolved_reason}"
