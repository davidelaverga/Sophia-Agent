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
from typing import Annotated, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.sophia.tools.builder_delivery import build_builder_delivery_payload
from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import (
    SubagentStatus,
    cleanup_background_task,
    get_background_task_result,
)

logger = logging.getLogger(__name__)


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
    runtime: ToolRuntime[ContextT, SophiaState] | None = None,
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
        "[Builder] switch_to_builder called: task_type=%s, tone=%.1f, ritual=%s, thread_id=%s",
        task_type,
        companion_artifact.get("tone_estimate", 2.5),
        active_ritual,
        thread_id,
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
    config = replace(config, max_turns=50, timeout_seconds=120, name="sophia_builder")

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
    task_id = tool_call_id or str(uuid.uuid4())[:8]
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
            return _format_error("Task disappeared")

        if result.status == SubagentStatus.COMPLETED:
            logger.info("[Builder] Task %s completed after %d polls", task_id, poll_count)
            if writer:
                writer({"type": "task_completed", "task_id": task_id, "result": result.result})
            cleanup_background_task(task_id)

            # Extract builder_result from final state
            builder_result = _extract_builder_result(result)
            builder_delivery = build_builder_delivery_payload(
                thread_id=thread_id,
                builder_result=builder_result,
            )
            title = builder_result.get("artifact_title") or "the deliverable"
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
                    "messages": [ToolMessage(tool_message, tool_call_id=tool_call_id)],
                }
            )

        elif result.status == SubagentStatus.FAILED:
            logger.error("[Builder] Task %s failed: %s", task_id, result.error)
            if writer:
                writer({"type": "task_failed", "task_id": task_id, "error": result.error})
            cleanup_background_task(task_id)
            return _format_error(result.error or "Unknown error")

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            if writer:
                writer({"type": "task_timed_out", "task_id": task_id})
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

def _format_error(error: str) -> str:
    """Format a builder error for the companion."""
    return f"Builder failed: {error}"
