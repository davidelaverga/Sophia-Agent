"""switch_to_builder tool.

<<<<<<< HEAD
Delegates a task to the sophia_builder agent after the companion has
gathered all clarifying information.  Uses SubagentExecutor with a
pre-built builder agent and passes delegation_context through configurable
so BuilderTaskMiddleware can inject tone/ritual guidance.
"""

import json
import logging
import time
import uuid
from dataclasses import replace
=======
Delegates a task to the sophia_builder agent (DeerFlow's lead_agent)
after the companion has gathered all clarifying information. Uses the
DeerFlow SubagentExecutor for background execution with progress streaming.
"""

import logging
import time
import uuid
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
from typing import Annotated, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import SubagentStatus, cleanup_background_task, get_background_task_result

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
) -> str:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief."""

<<<<<<< HEAD
    # ------------------------------------------------------------------
    # 1. Extract companion state
    # ------------------------------------------------------------------
    companion_artifact = {}
    user_id = "default_user"
    active_ritual = None
    ritual_phase = None
    injected_memories: list[str] = []
=======
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
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
    sandbox_state = None
    thread_data = None
    thread_id = None
    parent_model = None
    trace_id = str(uuid.uuid4())[:8]

    if runtime is not None:
<<<<<<< HEAD
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

=======
        sandbox_state = runtime.state.get("sandbox")
        thread_data = runtime.state.get("thread_data")
        thread_id = runtime.context.get("thread_id") if runtime.context else None
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
        metadata = runtime.config.get("metadata", {}) if runtime.config else {}
        parent_model = metadata.get("model_name")
        trace_id = metadata.get("trace_id") or trace_id

<<<<<<< HEAD
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
=======
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
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=thread_id,
        trace_id=trace_id,
<<<<<<< HEAD
        pre_built_agent=builder_agent,
        extra_configurable={"delegation_context": delegation_context},  # merged into initial state
    )

    # ------------------------------------------------------------------
    # 5. Execute + poll
    # ------------------------------------------------------------------
    task_id = tool_call_id or str(uuid.uuid4())[:8]
    executor.execute_async(task, task_id=task_id)
=======
    )

    # Start background execution
    task_id = tool_call_id or str(uuid.uuid4())[:8]
    executor.execute_async(builder_prompt, task_id=task_id)
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
    logger.info("[Builder] Task %s started (trace=%s)", task_id, trace_id)

    # Stream progress via get_stream_writer if available
    try:
        from langgraph.config import get_stream_writer
        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": f"Builder: {task_type}"})
    except Exception:
        writer = None

<<<<<<< HEAD
=======
    # Poll for completion (same pattern as DeerFlow's task_tool)
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
    poll_count = 0
    max_poll_count = (config.timeout_seconds + 60) // 5

    while True:
        result = get_background_task_result(task_id)

        if result is None:
            logger.error("[Builder] Task %s not found", task_id)
            cleanup_background_task(task_id)
<<<<<<< HEAD
            return _format_error("Task disappeared")
=======
            return f"Builder error: task {task_id} disappeared"
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11

        if result.status == SubagentStatus.COMPLETED:
            logger.info("[Builder] Task %s completed after %d polls", task_id, poll_count)
            if writer:
                writer({"type": "task_completed", "task_id": task_id, "result": result.result})
            cleanup_background_task(task_id)
<<<<<<< HEAD

            # Extract builder_result from final state
            builder_result = _extract_builder_result(result)
            return _format_success(builder_result)
=======
            return f"Builder completed: {result.result}"
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11

        elif result.status == SubagentStatus.FAILED:
            logger.error("[Builder] Task %s failed: %s", task_id, result.error)
            if writer:
                writer({"type": "task_failed", "task_id": task_id, "error": result.error})
            cleanup_background_task(task_id)
<<<<<<< HEAD
            return _format_error(result.error or "Unknown error")

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            if writer:
                writer({"type": "task_timed_out", "task_id": task_id})
            cleanup_background_task(task_id)
            return _format_error(f"Timed out after {config.timeout_seconds}s")
=======
            return f"Builder failed: {result.error}"

        elif result.status == SubagentStatus.TIMED_OUT:
            logger.warning("[Builder] Task %s timed out", task_id)
            cleanup_background_task(task_id)
            return f"Builder timed out after {config.timeout_seconds}s"
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11

        time.sleep(5)
        poll_count += 1

        if poll_count > max_poll_count:
            logger.error("[Builder] Task %s polling timed out", task_id)
<<<<<<< HEAD
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
=======
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
>>>>>>> b7efaa7ddc748f1d814b78cb234226064ee38c11
