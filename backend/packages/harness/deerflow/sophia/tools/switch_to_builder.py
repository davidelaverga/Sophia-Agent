"""switch_to_builder tool.

Delegates a task to the sophia_builder agent (DeerFlow's lead_agent)
after the companion has gathered all clarifying information. Uses the
DeerFlow SubagentExecutor for background execution with progress streaming.
"""

import logging
import time
import uuid
from dataclasses import replace
from typing import Annotated, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import SubagentStatus, cleanup_background_task, get_background_task_result

logger = logging.getLogger(__name__)


class SwitchToBuilderInput(BaseModel):
    task: str = Field(description="Complete task description with all clarified specs.")
    task_type: Literal["frontend", "presentation", "research", "document", "visual_report"] = Field(
        description="Type of builder task."
    )


@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(
    task: str,
    task_type: str,
    runtime: ToolRuntime[ContextT, SophiaState] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> str:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief."""

    # Extract companion context for the builder
    companion_context = _extract_companion_context(runtime)
    logger.info(
        "[Builder] switch_to_builder called: task_type=%s, context_keys=%s",
        task_type, list(companion_context.keys()),
    )

    # Build the builder prompt with companion context
    builder_prompt = _build_prompt(task, task_type, companion_context)

    # Get the general-purpose subagent config (builder uses lead_agent capabilities)
    config = get_subagent_config("general-purpose")
    if config is None:
        logger.warning("[Builder] general-purpose subagent config not found — returning stub")
        return f"Builder task queued: [{task_type}] {task}"

    # Extract parent context for sandbox/thread access
    sandbox_state = None
    thread_data = None
    thread_id = None
    parent_model = None
    trace_id = str(uuid.uuid4())[:8]

    if runtime is not None:
        sandbox_state = runtime.state.get("sandbox")
        thread_data = runtime.state.get("thread_data")
        thread_id = runtime.context.get("thread_id") if runtime.context else None
        metadata = runtime.config.get("metadata", {}) if runtime.config else {}
        parent_model = metadata.get("model_name")
        trace_id = metadata.get("trace_id") or trace_id

    # Get available tools (excluding task tool to prevent nesting)
    try:
        from deerflow.tools import get_available_tools
        tools = get_available_tools(model_name=parent_model, subagent_enabled=False)
    except Exception:
        logger.warning("[Builder] Failed to load tools, using empty list")
        tools = []

    # Create executor
    executor = SubagentExecutor(
        config=config,
        tools=tools,
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=thread_id,
        trace_id=trace_id,
    )

    # Start background execution
    task_id = tool_call_id or str(uuid.uuid4())[:8]
    executor.execute_async(builder_prompt, task_id=task_id)
    logger.info("[Builder] Task %s started (trace=%s)", task_id, trace_id)

    # Stream progress via get_stream_writer if available
    try:
        from langgraph.config import get_stream_writer
        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": f"Builder: {task_type}"})
    except Exception:
        writer = None

    # Poll for completion (same pattern as DeerFlow's task_tool)
    poll_count = 0
    max_poll_count = (config.timeout_seconds + 60) // 5

    while True:
        result = get_background_task_result(task_id)

        if result is None:
            logger.error("[Builder] Task %s not found", task_id)
            cleanup_background_task(task_id)
            return f"Builder error: task {task_id} disappeared"

        if result.status == SubagentStatus.COMPLETED:
            logger.info("[Builder] Task %s completed after %d polls", task_id, poll_count)
            if writer:
                writer({"type": "task_completed", "task_id": task_id, "result": result.result})
            cleanup_background_task(task_id)
            return f"Builder completed: {result.result}"

        elif result.status == SubagentStatus.FAILED:
            logger.error("[Builder] Task %s failed: %s", task_id, result.error)
            if writer:
                writer({"type": "task_failed", "task_id": task_id, "error": result.error})
            cleanup_background_task(task_id)
            return f"Builder failed: {result.error}"

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            cleanup_background_task(task_id)
            return f"Builder timed out after {config.timeout_seconds}s"

        time.sleep(5)
        poll_count += 1

        if poll_count > max_poll_count:
            logger.error("[Builder] Task %s polling timed out", task_id)
            return f"Builder polling timed out after {poll_count} polls"


def _extract_companion_context(runtime) -> dict:
    """Extract relevant companion state for the builder."""
    if runtime is None or not hasattr(runtime, "state"):
        return {}

    state = runtime.state
    context = {}

    # User identity
    identity_blocks = [
        b for b in state.get("system_prompt_blocks", [])
        if "<user_identity>" in b
    ]
    if identity_blocks:
        context["user_identity"] = identity_blocks[0]

    # Current session context
    artifact = state.get("current_artifact") or state.get("previous_artifact") or {}
    if artifact:
        context["session_goal"] = artifact.get("session_goal", "")
        context["tone_estimate"] = artifact.get("tone_estimate", 2.5)

    # Injected memories
    memory_blocks = [
        b for b in state.get("system_prompt_blocks", [])
        if "<memories>" in b
    ]
    if memory_blocks:
        context["memories"] = memory_blocks[0]

    # Platform and context mode
    context["platform"] = state.get("platform", "text")
    context["context_mode"] = state.get("context_mode", "life")

    return context


def _build_prompt(task: str, task_type: str, context: dict) -> str:
    """Build the builder prompt with companion context."""
    parts = [
        f"## Builder Task\n**Type:** {task_type}\n**Task:** {task}",
    ]

    if context.get("user_identity"):
        parts.append(f"\n## User Context\n{context['user_identity']}")

    if context.get("session_goal"):
        parts.append(f"\n## Session Context\nGoal: {context['session_goal']}")
        parts.append(f"Tone: {context.get('tone_estimate', '?')}")
        parts.append(f"Platform: {context.get('platform', 'text')}")
        parts.append(f"Context: {context.get('context_mode', 'life')}")

    if context.get("memories"):
        parts.append(f"\n## Relevant Memories\n{context['memories']}")

    return "\n".join(parts)
