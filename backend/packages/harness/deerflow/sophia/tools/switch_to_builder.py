"""switch_to_builder tool.

Queues a delegated task for the Sophia builder subagent and returns a
structured handoff payload immediately. Completion is handled by companion-side
state middleware that polls background task status.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import time
import uuid
from dataclasses import replace
from typing import Annotated, Any, Literal

from deepagents import AsyncSubAgent
from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.state import SophiaState, merge_async_tasks
from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.sophia.builder_web_policy import (
    extract_explicit_user_urls,
    make_builder_web_budget,
    should_allow_builder_web_research,
)
from deerflow.subagents import SubagentExecutor, get_subagent_config
from deerflow.subagents.executor import SubagentStatus, cleanup_background_task, get_background_task_result

logger = logging.getLogger(__name__)

__all__ = [
    "SubagentExecutor",
    "SubagentStatus",
    "cleanup_background_task",
    "get_background_task_result",
    "get_subagent_config",
    "make_switch_to_builder_tool",
    "switch_to_builder",
    "time",
]

_ASYNC_BUILDER_AGENT_NAME = "sophia_builder"

_NON_TERMINAL_TASK_STATUSES = {"queued", "running", "started"}

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
    user_id: str | None = Field(
        default=None,
        description=(
            "Optional diagnostic hint. NEVER trusted to override authenticated "
            "identity: if the gateway/runtime already supplies a user_id, that "
            "trusted value is used and this field is ignored (a mismatch is "
            "logged for audit). Accepted only as a last-resort fallback when "
            "every trusted source is missing, strictly to avoid 'default_user'. "
            "Leave as None in normal operation."
        ),
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


def _resolve_user_id(
    runtime: ToolRuntime[ContextT, SophiaState] | None,
    state: SophiaState,
    configured_user_id: str | None = None,
    explicit_tool_arg: str | None = None,
) -> tuple[str, str, dict[str, Any]]:
    """Resolve user_id and return source diagnostics.

    The LLM's tool-call arguments are NEVER trusted to override an
    authenticated identity — a prompt-injected or hallucinated ``user_id``
    must not swap the builder into another user's Mem0 / identity /
    ownership scope. Trusted sources (gateway-propagated runtime config,
    runtime context, state populated from those, and the closure bound at
    companion construction) always win.

    Priority order (highest first):
      1. ``runtime.config.configurable.user_id`` (TRUSTED — set by gateway)
      2. ``runtime.context.user_id`` (TRUSTED — set by gateway)
      3. ``state.user_id`` (TRUSTED — propagated from authenticated runtime)
      4. ``configured_user_id`` (TRUSTED — closure bound at companion
         construction time via ``make_switch_to_builder_tool(user_id)``; this
         is the authenticated user when the companion is built per-request)
      5. ``explicit_tool_arg`` (UNTRUSTED — LLM-supplied; accepted ONLY as a
         last-resort fallback when every trusted source is empty, to avoid
         hitting ``default_user``). Emits WARNING on use.
      6. ``"default_user"`` literal — hard failure; WARNING logged.

    Audit path: whenever ``explicit_tool_arg`` is supplied but a trusted
    source wins AND the two values differ, a WARNING is logged. This
    surfaces possible prompt-injection attempts even though they are
    neutralised (ignored) by the precedence rule above.
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

    # Select the trusted resolution first (ignoring the tool arg).
    trusted_resolved: str | None = None
    trusted_source: str | None = None
    if configurable_user_id:
        trusted_resolved = validate_user_id(configurable_user_id)
        trusted_source = "runtime.config.configurable.user_id"
    elif context_user_id:
        trusted_resolved = validate_user_id(context_user_id)
        trusted_source = "runtime.context.user_id"
    elif state_user_id:
        trusted_resolved = validate_user_id(state_user_id)
        trusted_source = "state.user_id"
    elif configured_user_id:
        trusted_resolved = validate_user_id(configured_user_id)
        trusted_source = "configured_builder_user_id"

    # Record whether the LLM's tool arg agrees with the trusted identity (for
    # audit / prompt-injection detection). When no trusted source exists,
    # ``tool_arg_user_id_matches_trusted`` is None.
    tool_arg_matches_trusted: bool | None = None
    if tool_arg_user_id is not None and trusted_resolved is not None:
        tool_arg_matches_trusted = (
            validate_user_id(tool_arg_user_id) == trusted_resolved
        )

    diagnostics: dict[str, Any] = {
        "tool_arg_user_id_present": bool(tool_arg_user_id),
        "tool_arg_user_id_matches_trusted": tool_arg_matches_trusted,
        "configured_user_id_present": bool(configured_user_id),
        "config_user_id_present": bool(configurable_user_id),
        "context_user_id_present": bool(context_user_id),
        "state_user_id_present": bool(state_user_id),
    }

    # If a trusted source won AND the tool arg disagrees with it, flag it.
    # The tool arg is NOT used — the trusted source wins — but we surface the
    # discrepancy because it may indicate a prompt-injection attempt.
    if trusted_resolved is not None and tool_arg_matches_trusted is False:
        logger.warning(
            "[Builder] tool-arg user_id mismatch with trusted source — "
            "tool_arg=%r trusted_source=%s trusted=%r. Ignoring tool_arg "
            "(trusted identity wins); verify caller for possible prompt "
            "injection.",
            tool_arg_user_id,
            trusted_source,
            trusted_resolved,
        )

    if trusted_resolved is not None:
        return trusted_resolved, trusted_source, diagnostics

    # No trusted source — only now may we fall back to the LLM-supplied arg,
    # strictly to avoid hitting ``default_user``. Log WARNING because this
    # path means gateway identity propagation AND the agent-construction
    # closure both failed — an ops signal.
    if tool_arg_user_id:
        logger.warning(
            "[Builder] user_id falling back to LLM-supplied tool arg (%r) — "
            "all trusted sources empty (runtime.config, runtime.context, "
            "state, configured_builder_user_id). This value is NOT "
            "authenticated; verify gateway is propagating user_id into "
            "configurable and that make_switch_to_builder_tool is bound.",
            tool_arg_user_id,
        )
        return validate_user_id(tool_arg_user_id), "tool_arg_fallback", diagnostics

    logger.warning(
        "[Builder] user_id resolution fell back to 'default_user' — no source "
        "(trusted or LLM-supplied) provided a user identifier. This is a "
        "hard failure signal; verify runtime.config.configurable, "
        "runtime.context, state, and make_switch_to_builder_tool binding."
    )
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


def _build_builder_async_subagent_spec() -> AsyncSubAgent:
    """Return the Deep Agents v0.5 async-subagent spec for Sophia Builder.

    PR-H keeps the current in-process SubagentExecutor runtime for production
    execution, but records task metadata in the same `async_tasks` shape used
    by Deep Agents v0.5. This lets PR-I add polling/progress behavior without
    changing the public switch_to_builder handoff contract again.
    """
    return AsyncSubAgent(
        name=_ASYNC_BUILDER_AGENT_NAME,
        description="Runs Sophia builder deliverable tasks in the background.",
        graph_id="sophia_builder",
    )


def _build_async_task_metadata(
    *,
    task_id: str,
    thread_id: str | None,
    delegated_at: str,
) -> dict[str, str]:
    """Build a Deep Agents v0.5-compatible async task state entry."""
    spec = _build_builder_async_subagent_spec()
    return {
        "task_id": task_id,
        "agent_name": spec["name"],
        # Deep Agents async task_id is a remote thread_id. Our PR-H bridge uses
        # the parent thread_id when available and falls back to the builder
        # task_id; PR-I can replace this with native Agent Protocol IDs.
        "thread_id": thread_id or task_id,
        "run_id": task_id,
        "status": "running",
        "created_at": delegated_at,
        "last_checked_at": delegated_at,
        "last_updated_at": delegated_at,
    }


def _build_queued_payload(
    *,
    task_id: str,
    task_type: str,
    trace_id: str,
    builder_task: dict[str, Any],
    delegation_context: dict[str, Any],
    handoff_resolution: dict[str, Any],
) -> dict[str, Any]:
    return {
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


def _build_queued_command(
    *,
    payload: dict[str, Any],
    tool_call_id: str,
    async_task: dict[str, str],
    existing_async_tasks: dict[str, dict] | None = None,
) -> Command:
    """Return control immediately with state updated for async builder tracking."""
    task_id = payload["task_id"]
    return Command(
        update={
            "builder_task": payload["builder_task"],
            "builder_result": None,
            "delegation_context": payload["delegation_context"],
            "active_mode": "builder",
            "async_tasks": merge_async_tasks(existing_async_tasks, {task_id: async_task}),
            "messages": [
                ToolMessage(
                    content=json.dumps(payload),
                    tool_call_id=tool_call_id or task_id,
                    name="switch_to_builder",
                )
            ],
        }
    )


def _switch_to_builder_impl(
    task: str,
    task_type: str,
    runtime: ToolRuntime[ContextT, SophiaState] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    configured_user_id: str | None = None,
    user_id_arg: str | None = None,
) -> str | Command:
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
    task, task_type, demo_mode = _normalize_builder_request(
        task=task,
        task_type=task_type,
        companion_artifact=companion_artifact,
    )
    progress_description = _build_builder_progress_description(task, task_type, demo_mode)
    if demo_mode:
        logger.info("[Builder] normalized generic demo request to deterministic document flow")

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
    max_turns, timeout_seconds = _resolve_builder_limits(demo_mode)
    config = replace(
        config,
        max_turns=max_turns,
        timeout_seconds=timeout_seconds,
        name="sophia_builder",
    )

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
    delegated_at = _utcnow_iso()
    try:
        executor.execute_async(task, task_id=task_id, owner_id=user_id, description=progress_description)
    except TypeError:
        try:
            executor.execute_async(task, task_id=task_id, owner_id=user_id)
        except TypeError:
            executor.execute_async(task, task_id=task_id)
    logger.info("[Builder] Task %s started (trace=%s)", task_id, trace_id)

    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        writer({"type": "task_started", "task_id": task_id, "description": progress_description})
    except Exception:
        pass

    builder_task = {
        "task_id": task_id,
        "description": progress_description,
        "task_type": task_type,
        "delegated_at": delegated_at,
        "status": "queued",
        "trace_id": trace_id,
        "handoff_resolution": handoff_resolution,
    }

    payload = _build_queued_payload(
        task_id=task_id,
        task_type=task_type,
        trace_id=trace_id,
        builder_task=builder_task,
        delegation_context=delegation_context,
        handoff_resolution=handoff_resolution,
    )
    async_task = _build_async_task_metadata(
        task_id=task_id,
        thread_id=thread_id,
        delegated_at=delegated_at,
    )
    return _build_queued_command(
        payload=payload,
        tool_call_id=tool_call_id,
        async_task=async_task,
        existing_async_tasks=state.get("async_tasks"),
    )


@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(
    task: str,
    task_type: str,
    user_id: str | None = None,
    runtime: ToolRuntime[ContextT, SophiaState] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> str | Command:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief.
    ``user_id`` is a diagnostic-only hint — it is NEVER used when the runtime
    supplies an authenticated user. Leave it as None in normal operation."""

    return _switch_to_builder_impl(
        task=task,
        task_type=task_type,
        runtime=runtime,
        tool_call_id=tool_call_id,
        user_id_arg=user_id,
    )


def make_switch_to_builder_tool(configured_user_id: str):
    bound_user_id = validate_user_id(configured_user_id)

    @tool("switch_to_builder", args_schema=SwitchToBuilderInput)
    def configured_switch_to_builder(
        task: str,
        task_type: str,
        user_id: str | None = None,
        runtime: ToolRuntime[ContextT, SophiaState] | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str | Command:
        """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
        something requiring file creation or multi-step execution.
        Do NOT call for emotional conversation, reflection, or memory tasks.
        Before calling this, ensure you have complete specs — ask any clarifying
        questions first, then delegate with the complete brief.
        ``user_id`` is a diagnostic-only hint — it is NEVER used when the runtime
        supplies an authenticated user. Leave it as None in normal operation."""

        return _switch_to_builder_impl(
            task=task,
            task_type=task_type,
            runtime=runtime,
            tool_call_id=tool_call_id,
            configured_user_id=bound_user_id,
            user_id_arg=user_id,
        )

    return configured_switch_to_builder


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
    """Detect explicit Builder smoke-test turns that should avoid open-ended work."""
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


def _resolve_builder_limits(demo_mode: bool) -> tuple[int, int]:
    """Return recursion and timeout budgets for the delegated Builder task.

    Budget must be large enough for Sonnet to generate multi-page documents
    with images/charts and still call emit_builder_artifact. A single streamed
    LLM turn can easily take 90-150s for a 5-page PDF, so the overall budget
    needs substantial headroom above one turn.

    `max_turns` is forwarded to LangGraph as `recursion_limit`. Because the
    Sophia middleware chain yields multiple graph super-steps per logical
    tool call (~5 per turn with before/after hooks + prompt assembly), we
    size the budget well above the _HARD_CEILING=12 prompt guidance so the
    agent does not abort with GraphRecursionError on a normal deliverable.
    """
    if demo_mode:
        return 40, 45

    return 150, 600
