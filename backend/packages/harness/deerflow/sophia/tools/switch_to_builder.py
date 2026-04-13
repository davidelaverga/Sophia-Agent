"""switch_to_builder tool.

Queues a delegated task for the Sophia builder subagent and returns a
structured handoff payload immediately. Completion is handled by companion-side
state middleware that polls background task status.
"""

import datetime as dt
import json
import logging
import uuid
from dataclasses import replace
from typing import Annotated, Any, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import AIMessage
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.sophia.builder_web_policy import (
    extract_explicit_user_urls,
    make_builder_web_budget,
    should_allow_builder_web_research,
)
from deerflow.subagents import SubagentExecutor, get_subagent_config

logger = logging.getLogger(__name__)

_NON_TERMINAL_TASK_STATUSES = {"queued", "running", "started"}


class SwitchToBuilderInput(BaseModel):
    task: str = Field(
        description="Complete task description with all specs gathered "
        "from clarification. Be specific — the builder cannot "
        "ask follow-up questions."
    )
    task_type: Literal["frontend", "presentation", "research", "document", "visual_report"] = Field(
        description="Type of deliverable. Determines builder skill loading."
    )


def _utcnow_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


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
    """Return human-readable memory snippets for builder context.

    Preference order:
      1. `injected_memory_contents` (new explicit snippets)
      2. `injected_memories` values that do not look like opaque IDs
    """
    snippets_raw = state.get("injected_memory_contents") or []
    snippets = [str(item).strip() for item in snippets_raw if str(item).strip()]
    if snippets:
        return snippets

    fallbacks = []
    for item in state.get("injected_memories", []) or []:
        text = str(item).strip()
        # Heuristic: skip UUID-like IDs from Mem0 when no content list exists.
        if len(text) >= 24 and text.count("-") >= 2 and " " not in text:
            continue
        if text:
            fallbacks.append(text)
    return fallbacks


def _resolve_user_id(runtime: ToolRuntime[ContextT, SophiaState] | None, state: SophiaState) -> tuple[str, str, dict[str, bool]]:
    """Resolve user_id and return source diagnostics."""
    configurable_user_id: str | None = None
    context_user_id: str | None = None
    state_user_id: str | None = None

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

    diagnostics = {
        "config_user_id_present": bool(configurable_user_id),
        "context_user_id_present": bool(context_user_id),
        "state_user_id_present": bool(state_user_id),
    }

    if configurable_user_id:
        return validate_user_id(configurable_user_id), "runtime.config.configurable.user_id", diagnostics
    if context_user_id:
        return validate_user_id(context_user_id), "runtime.context.user_id", diagnostics
    if state_user_id:
        return validate_user_id(state_user_id), "state.user_id", diagnostics
    return validate_user_id("default_user"), "default_user", diagnostics


def _latest_emit_artifact_payload(messages: list[Any]) -> dict[str, Any] | None:
    """Return the most recent emit_artifact payload from AI tool calls."""
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


def _resolve_companion_artifact(state: SophiaState) -> tuple[dict[str, Any], str, dict[str, bool]]:
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


def _build_duplicate_payload(existing_task: dict, task_type: str, trace_id: str) -> dict:
    task_id = existing_task.get("task_id")
    return {
        "type": "builder_handoff",
        "status": "already_running",
        "task_id": task_id,
        "task_type": existing_task.get("task_type", task_type),
        "trace_id": trace_id,
        "queued_at": existing_task.get("delegated_at"),
        "acknowledgement": "A builder task is already in progress. Continuing with the existing task.",
        "builder_task": existing_task,
    }


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

    state: SophiaState = runtime.state or {} if runtime is not None else {}
    trace_id = str(uuid.uuid4())[:8]
    if runtime is not None and runtime.config:
        metadata = runtime.config.get("metadata", {})
        trace_id = metadata.get("trace_id") or trace_id

    # Duplicate-launch protection: never start a second builder task while one is active.
    existing_task = state.get("builder_task") or {}
    if existing_task.get("status") in _NON_TERMINAL_TASK_STATUSES and existing_task.get("task_id"):
        logger.info(
            "[Builder] duplicate switch_to_builder suppressed: task_id=%s status=%s",
            existing_task.get("task_id"),
            existing_task.get("status"),
        )
        return json.dumps(_build_duplicate_payload(existing_task, task_type, trace_id))

    companion_artifact, artifact_source, artifact_diagnostics = _resolve_companion_artifact(state)
    user_id, user_id_source, user_id_diagnostics = _resolve_user_id(runtime, state)
    handoff_resolution = {
        "user_id_source": user_id_source,
        "artifact_source": artifact_source,
        **user_id_diagnostics,
        **artifact_diagnostics,
    }
    active_ritual = state.get("active_ritual")
    ritual_phase = state.get("ritual_phase")
    memory_snippets = _resolve_memory_snippets(state)
    allow_web_research = should_allow_builder_web_research(task_type, task)
    explicit_user_urls = extract_explicit_user_urls(task)
    builder_web_budget = make_builder_web_budget(task_type)
    sandbox_state = state.get("sandbox")
    thread_data = state.get("thread_data")
    thread_id = _resolve_thread_id(runtime)
    parent_model = None
    if runtime is not None and runtime.config:
        parent_model = (runtime.config.get("metadata", {}) or {}).get("model_name")

    logger.info(
        "[Builder] switch_to_builder queued: task_type=%s tone=%.1f ritual=%s thread_id=%s model=%s user_id=%s user_id_source=%s artifact_source=%s",
        task_type,
        companion_artifact.get("tone_estimate", 2.5),
        active_ritual,
        thread_id,
        parent_model,
        user_id,
        user_id_source,
        artifact_source,
    )
    logger.info(
        "[Builder] handoff resolution: config_user_id_present=%s context_user_id_present=%s state_user_id_present=%s latest_emit_artifact_present=%s current_artifact_present=%s previous_artifact_present=%s",
        handoff_resolution["config_user_id_present"],
        handoff_resolution["context_user_id_present"],
        handoff_resolution["state_user_id_present"],
        handoff_resolution["latest_emit_artifact_present"],
        handoff_resolution["current_artifact_present"],
        handoff_resolution["previous_artifact_present"],
    )

    delegation_context = {
        "task": task,
        "task_type": task_type,
        "companion_artifact": companion_artifact,
        "user_identity": None,  # provided by UserIdentityMiddleware in builder chain
        "relevant_memories": memory_snippets[:5],
        "active_ritual": active_ritual,
        "ritual_phase": ritual_phase,
        "allow_web_research": allow_web_research,
        "search_mode": "autonomous",
        "explicit_user_urls": explicit_user_urls,
        "builder_web_budget": builder_web_budget,
        "handoff_resolution": handoff_resolution,
    }

    from deerflow.agents.sophia_agent.builder_agent import _create_builder_agent

    builder_agent = _create_builder_agent(user_id=user_id, model_name=parent_model)

    config = get_subagent_config("general-purpose")
    if config is None:
        logger.error("[Builder] subagent config not found; cannot start builder task")
        return json.dumps(
            {
                "type": "builder_handoff",
                "status": "failed",
                "task_id": None,
                "task_type": task_type,
                "trace_id": trace_id,
                "acknowledgement": "Unable to start the builder right now.",
                "error": "Subagent config 'general-purpose' not found.",
            }
        )

    # Builder execution guardrails
    config = replace(config, max_turns=50, timeout_seconds=120, name="sophia_builder")

    executor = SubagentExecutor(
        config=config,
        tools=[],
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=thread_id,
        trace_id=trace_id,
        pre_built_agent=builder_agent,
        extra_configurable={"delegation_context": delegation_context},
    )

    task_id = tool_call_id or str(uuid.uuid4())[:8]
    executor.execute_async(task, task_id=task_id)

    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": f"Builder: {task_type}"})
    except Exception:
        pass

    builder_task = {
        "task_id": task_id,
        "description": task,
        "task_type": task_type,
        "delegated_at": _utcnow_iso(),
        "status": "queued",
        "trace_id": trace_id,
        "handoff_resolution": handoff_resolution,
    }

    payload = {
        "type": "builder_handoff",
        "status": "queued",
        "task_id": task_id,
        "task_type": task_type,
        "trace_id": trace_id,
        "queued_at": builder_task["delegated_at"],
        "acknowledgement": "Builder task queued and running in the background.",
        "builder_task": builder_task,
        "delegation_context": delegation_context,
        "handoff_resolution": handoff_resolution,
    }
    return json.dumps(payload)
