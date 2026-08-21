from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.coreview import (
    GEMINI_COREVIEW_ACTION_TOOL_NAMES,
    GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
    coreview_action_result_summary,
    coreview_browser_action_unavailable_response,
    execute_read_artifact_text_feature_gated,
    read_artifact_text_result_summary,
    redacted_coreview_action_diagnostic,
    redacted_read_artifact_text_diagnostic,
)
from voice.realtime.sophia_backend_tools import (
    SophiaBackendToolConfigurationError,
    builder_lifecycle_contract,
    decorate_realtime_retrieve_memories_result,
    execute_existing_emit_artifact,
    execute_realtime_retrieve_memories,
    execute_realtime_retrieve_memories_unavailable,
    execute_realtime_web_fetch,
    gemini_sophia_function_declarations,
    redacted_retrieve_memories_diagnostic,
    realtime_memory_query_from_args,
    validate_builder_lifecycle_tool_args,
)

GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
GEMINI_START_BUILDER_TASK_TOOL_NAME = "start_builder_task"
GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME = "edit_builder_artifact"
GEMINI_CHECK_ASYNC_TASK_TOOL_NAME = "check_async_task"
GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"
GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME = "cancel_async_task"
GEMINI_LIST_ASYNC_TASKS_TOOL_NAME = "list_async_tasks"
GEMINI_RETRIEVE_MEMORIES_TOOL_NAME = "retrieve_memories"
GEMINI_WEB_FETCH_TOOL_NAME = "web_fetch"
GEMINI_DOGFOOD_TOOL_RESPONSE_ACTION = "gemini_tool_response"
GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS = (
    "Invalid emit_artifact arguments. Provide required string fields and retry."
)
GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES = frozenset(
    {
        GEMINI_EMIT_ARTIFACT_TOOL_NAME,
        GEMINI_START_BUILDER_TASK_TOOL_NAME,
        GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
        GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
        GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
        GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME,
        GEMINI_LIST_ASYNC_TASKS_TOOL_NAME,
        GEMINI_RETRIEVE_MEMORIES_TOOL_NAME,
        GEMINI_WEB_FETCH_TOOL_NAME,
        GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
        *GEMINI_COREVIEW_ACTION_TOOL_NAMES,
    }
)

DEFAULT_LANGGRAPH_URL = "http://localhost:2024"
DEFAULT_REALTIME_MEMORY_RETRIEVAL_TIMEOUT_SECONDS = 8.0
REALTIME_MEMORY_GATEWAY_RESPONSE_SCHEMA = "sophia_realtime_memory_retrieve_response_v1"
REALTIME_MEMORY_GATEWAY_ALLOWED_STATUSES = frozenset(
    {
        "success",
        "no_results",
        "unavailable",
        "error",
        "unauthorized",
        "expired_grant",
        "invalid_request",
        "invalid_query",
    }
)
REALTIME_MEMORY_GATEWAY_REQUIRED_FIELDS = frozenset(
    {"ok", "status", "memories", "count", "provider_status", "provider_reason", "diagnostics"}
)
_EXPLICIT_URL_RE = re.compile(r"https?://[^\s<>\]\)\"']+")
_TRAILING_URL_PUNCTUATION = ".,;:!?)]}\"'"
_POST_INTERRUPT_BUILD_MARKER = "[Sophia/post-interrupt build directive]"
_BUILDER_DIRECT_REQUEST_RE = re.compile(
    r"(?:\bplease\b|\b(?:can|could|would|will)\s+you\b|"
    r"\bi\s+(?:want|need|would\s+like)\s+you\s+to\b|"
    r"\blet(?:'|’)s\b|"
    r"^\s*(?:build|create|make|prepare|generate|draft|write|design|produce|assemble|"
    r"research|investigate|look\s+up|find\s+out|search|verify|fact[- ]check)\b)",
    re.IGNORECASE,
)
_BUILDER_CREATION_ACTION_RE = re.compile(
    r"\b(?:build|create|make|prepare|generate|draft|write|design|produce|assemble|"
    r"update|revise|edit|rework)\b",
    re.IGNORECASE,
)
_BUILDER_DELIVERABLE_RE = re.compile(
    r"\b(?:deck|presentation|slides?|document|report|file|pdf|pptx?|spreadsheet|"
    r"workbook|website|webpage|web\s+page|frontend|visual\s+report|artifact|brief|memo|"
    r"one[- ]pager|plan|proposal)\b",
    re.IGNORECASE,
)
_BUILDER_RESEARCH_ACTION_RE = re.compile(
    r"\b(?:research|investigate|look\s+up|find\s+out|search(?:\s+the)?\s+web|"
    r"verify|fact[- ]check)\b",
    re.IGNORECASE,
)
_BUILDER_DIRECT_DELIVERABLE_RE = re.compile(
    r"\bi\s+(?:want|need|would\s+like)\s+(?:a|an|the|some|\d+)?\s*"
    r"(?:deck|presentation|slides?|document|report|pdf|pptx?|spreadsheet|workbook|"
    r"website|webpage|artifact|brief|memo|one[- ]pager|proposal)\b",
    re.IGNORECASE,
)

logger = logging.getLogger(__name__)


class GeminiDogfoodToolError(ValueError):
    """Raised when a Gemini dogfood tool call cannot be executed safely."""


def is_explicit_builder_request(latest_user_utterance: str | None) -> bool:
    """Return whether the latest complete utterance authorizes builder work."""
    if not isinstance(latest_user_utterance, str):
        return False
    utterance = " ".join(latest_user_utterance.split()).strip()
    if not utterance:
        return False
    if _BUILDER_DIRECT_DELIVERABLE_RE.search(utterance):
        return True
    if not _BUILDER_DIRECT_REQUEST_RE.search(utterance):
        return False
    if _BUILDER_RESEARCH_ACTION_RE.search(utterance):
        return True
    return bool(
        _BUILDER_CREATION_ACTION_RE.search(utterance)
        and _BUILDER_DELIVERABLE_RE.search(utterance)
    )


class GeminiBuilderTaskNotTrackedError(GeminiDogfoodToolError):
    """Raised when a lifecycle call references no task in the trusted session."""

    def __init__(self, task_id: str, tracked_task_ids: list[str], *, placeholder: bool = False) -> None:
        self.task_id = task_id
        self.tracked_task_ids = tracked_task_ids
        self.placeholder = placeholder
        super().__init__(
            "No active build is available for that request."
        )


@dataclass(frozen=True)
class GeminiLiveFunctionCall:
    call_id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class GeminiDogfoodToolExecution:
    call: GeminiLiveFunctionCall
    response: dict[str, Any]
    result_summary: str
    success: bool = True
    error_text: str | None = None
    updated_async_tasks: dict[str, dict[str, Any]] | None = None
    public_artifact: dict[str, Any] | None = None
    diagnostic_metadata: dict[str, Any] | None = None

    def diagnostic(self) -> dict[str, Any]:
        if self.call.name == GEMINI_RETRIEVE_MEMORIES_TOOL_NAME:
            return _retrieve_memories_execution_diagnostic(self)
        if self.call.name == GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME:
            return _read_artifact_text_execution_diagnostic(self)
        if self.call.name == GEMINI_WEB_FETCH_TOOL_NAME:
            return {
                "id": self.call.call_id,
                "name": self.call.name,
                "success": self.success,
                "status": self.response.get("status"),
                "http_status": self.response.get("http_status"),
                "content_chars": self.response.get("content_chars", 0),
                "truncated": bool(self.response.get("truncated")),
                "raw_content_excluded": True,
                "result_summary": self.result_summary,
            }
        if self.call.name in GEMINI_COREVIEW_ACTION_TOOL_NAMES:
            return _coreview_action_execution_diagnostic(self)

        task_id = _task_id_from_response(self.response)
        task_status = _task_status_from_response(self.response)
        diagnostic = {
            "id": self.call.call_id,
            "name": self.call.name,
            "success": self.success,
            "result_summary": self.result_summary,
            "task_id": task_id,
            "task_status": task_status,
            "response": dict(self.response),
        }
        if not self.success:
            diagnostic.update(
                {
                    "execution_rejected": True,
                    "error_text": self.error_text or self.result_summary,
                    "rejection_reason": _string_value(self.response.get("error_type")) or "tool_execution_rejected",
                    "recovery_guidance": _string_value(self.response.get("recovery_guidance")),
                    "tracked_task_ids": _string_list_value(self.response.get("tracked_task_ids")),
                }
            )
        return diagnostic


@dataclass(frozen=True)
class GeminiBuilderLifecycleResult:
    response: dict[str, Any]
    result_summary: str
    updated_async_tasks: dict[str, dict[str, Any]] | None = None


class GeminiBuilderLifecycleHttpBackend:
    """Execute existing builder/lifecycle semantics through LangGraph HTTP.

    The voice runtime cannot import deepagents/langchain modules, so this bridge
    uses the same LangGraph API calls those native lifecycle tools use while
    keeping task identity in the dogfood session's trusted backend state.
    """

    def __init__(self, *, langgraph_url: str | None = None, timeout_seconds: float = 15.0) -> None:
        configured_url = (
            langgraph_url
            or os.getenv("LANGGRAPH_URL")
            or os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
            or DEFAULT_LANGGRAPH_URL
        )
        self._langgraph_url = configured_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    async def execute(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str,
        parent_thread_id: str | None = None,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None = None,
        trace_context: Mapping[str, Any] | None = None,
    ) -> GeminiBuilderLifecycleResult:
        validated = validate_builder_lifecycle_tool_args(tool_name, args)
        resolved_parent_thread_id = _string_value(parent_thread_id) or session_id
        if tool_name == GEMINI_START_BUILDER_TASK_TOOL_NAME:
            return await self._start_builder_task(
                validated,
                session_id=session_id,
                parent_thread_id=resolved_parent_thread_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
                trace_context=trace_context,
            )
        if tool_name == GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME:
            return await self._edit_builder_artifact(
                validated,
                session_id=session_id,
                parent_thread_id=resolved_parent_thread_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
                trace_context=trace_context,
            )
        if tool_name == GEMINI_CHECK_ASYNC_TASK_TOOL_NAME:
            return await self._check_async_task(
                validated,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
            )
        if tool_name == GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME:
            return await self._update_async_task(
                validated,
                session_id=session_id,
                parent_thread_id=resolved_parent_thread_id,
                user_id=user_id,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
                trace_context=trace_context,
            )
        if tool_name == GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME:
            return await self._cancel_async_task(
                validated,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
            )
        if tool_name == GEMINI_LIST_ASYNC_TASKS_TOOL_NAME:
            return await self._list_async_tasks(
                validated,
                async_tasks=async_tasks,
                trace_headers=trace_headers,
            )
        raise GeminiDogfoodToolError(f"Unsupported builder lifecycle tool {tool_name!r}.")

    async def _start_builder_task(
        self,
        args: Mapping[str, Any],
        *,
        session_id: str,
        parent_thread_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
        trace_context: Mapping[str, Any] | None,
    ) -> GeminiBuilderLifecycleResult:
        existing_task_id = _active_builder_task_id(async_tasks)
        if existing_task_id:
            logger.info(
                "gemini.builder_lifecycle.start_builder_task duplicate_suppressed session_id=%s existing_task_id=%s",
                session_id,
                existing_task_id,
            )
            response = {
                "ok": True,
                "tool": GEMINI_START_BUILDER_TASK_TOOL_NAME,
                "started": False,
                "duplicate_guard": True,
                "task_id": existing_task_id,
                "status": async_tasks.get(existing_task_id, {}).get("status", "running"),
                "result_summary": (
                    f"A builder task is already in progress (task_id={existing_task_id}). "
                    "No duplicate task was launched."
                ),
            }
            return GeminiBuilderLifecycleResult(
                response=response,
                result_summary="Duplicate builder launch suppressed by existing async task state.",
            )

        description = str(args["description"]).strip()
        task_type = str(args["task_type"]).strip()
        prefixed_description = _prefixed_description(description, task_type)
        explicit_urls = _extract_explicit_user_urls(description)
        allow_web_research = _should_allow_builder_web_research(task_type, description)
        builder_web_budget = _make_builder_web_budget(task_type)
        builder_budget = _voice_builder_budget(task_type)
        artifact_target_path = _voice_builder_artifact_target_path(description, task_type)
        contract = builder_lifecycle_contract()

        thread = await self._request_json(
            "POST",
            "/threads",
            json_body={},
            headers=trace_headers,
        )
        thread_id = _required_string(thread.get("thread_id"), "LangGraph thread response omitted thread_id.")
        now = _utcnow_iso()
        build_id = f"build_gemini_{thread_id}"
        operation_id = f"op_gemini_{thread_id}"
        voice_trace_id = _string_value((trace_context or {}).get("voice_trace_id"))
        voice_tool_call_id = _string_value((trace_context or {}).get("voice_tool_call_id"))
        voice_tool_run_id = _string_value((trace_context or {}).get("voice_tool_run_id"))
        relay_correlation_id = _string_value((trace_context or {}).get("relay_correlation_id"))
        provider_receive_sequence = (trace_context or {}).get("provider_receive_sequence")
        kickoff_ms = int(time.time() * 1000)
        timeout_seconds = int((builder_budget or {}).get("max_wall_clock_seconds", 0) or 0)
        delegation_context = {
            "task": description,
            "task_brief": description,
            "normalized_brief": description,
            "task_type": task_type,
            "source": "gemini_live_dogfood_start_builder_task",
            "parent_thread_id": parent_thread_id,
            "parent_user_id": user_id,
            "companion_artifact": None,
            "active_ritual": None,
            "ritual_phase": None,
            "memories_for_builder": None,
            "relevant_memories": [],
            "allow_web_research": allow_web_research,
            "search_mode": "autonomous",
            "explicit_user_urls": explicit_urls,
            "builder_web_budget": builder_web_budget,
            "builder_budget": builder_budget,
            "artifact_target_path": artifact_target_path,
            "build_id": build_id,
            "operation_id": operation_id,
            "handoff_resolution": {
                "user_id_source": "trusted_gemini_dogfood_session_user_id",
                "tool_arg_user_id_present": bool(args.get("user_id")),
                "tool_arg_user_id_ignored": bool(args.get("user_id") and args.get("user_id") != user_id),
            },
        }
        run_input = {
            "messages": [{"role": "user", "content": prefixed_description}],
            "delegation_context": delegation_context,
            "allow_web_research": allow_web_research,
            "explicit_user_urls": explicit_urls,
            "builder_web_budget": builder_web_budget,
            "builder_task_kickoff_ms": kickoff_ms,
            "builder_timeout_seconds": timeout_seconds,
            "builder_deadline_epoch_ms": kickoff_ms + (timeout_seconds * 1000) if timeout_seconds else 0,
            "builder_build_id": build_id,
            "builder_operation_id": operation_id,
            "builder_artifact_target_path": artifact_target_path,
        }
        if builder_budget is not None:
            run_input["builder_budget"] = builder_budget
        run = await self._request_json(
            "POST",
            f"/threads/{thread_id}/runs",
            json_body={
                "assistant_id": contract.ASYNC_BUILDER_AGENT_NAME,
                "input": run_input,
                "stream_resumable": True,
                "config": {
                    "metadata": {
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "builder_thread_id": thread_id,
                        "parent_thread_id": parent_thread_id,
                        "task_type": task_type,
                        "channel": "voice",
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": voice_tool_call_id,
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": relay_correlation_id,
                        "provider_receive_sequence": provider_receive_sequence,
                    },
                    "configurable": {
                        "thread_id": thread_id,
                        "user_id": user_id,
                        "parent_thread_id": parent_thread_id,
                        "graph_id": contract.ASYNC_BUILDER_AGENT_NAME,
                        "task_type": task_type,
                        "artifact_target_ext": PurePosixPath(artifact_target_path).suffix.lower(),
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": voice_tool_call_id,
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": relay_correlation_id,
                    }
                },
            },
            headers=trace_headers,
        )
        run_id = _required_string(run.get("run_id"), "LangGraph run response omitted run_id.")
        async_task = {
            "task_id": thread_id,
            "agent_name": contract.ASYNC_BUILDER_AGENT_NAME,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": "running",
            "created_at": now,
            "last_checked_at": now,
            "last_updated_at": now,
            "task_type": task_type,
            "description": description,
            "task_brief": description,
            "demo_mode": False,
            "parent_thread_id": parent_thread_id,
            "artifact_target_path": artifact_target_path,
            "build_id": build_id,
            "operation_id": operation_id,
            "voice_trace_id": voice_trace_id,
            "voice_tool_call_id": voice_tool_call_id,
            "voice_tool_run_id": voice_tool_run_id,
            "relay_correlation_id": relay_correlation_id,
            "provider_receive_sequence": provider_receive_sequence,
        }
        parent_state_persisted = await self._persist_parent_async_task(
            parent_thread_id,
            async_task,
            trace_headers=trace_headers,
        )
        response = {
            "ok": True,
            "tool": GEMINI_START_BUILDER_TASK_TOOL_NAME,
            "started": True,
            "task_id": thread_id,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": "running",
            "task_type": task_type,
            "description": description,
            "task_brief": description,
            "build_id": build_id,
            "operation_id": operation_id,
            "voice_trace_id": voice_trace_id,
            "voice_tool_run_id": voice_tool_run_id,
            "async_task": async_task,
            "trusted_user_id": user_id,
            "tool_arg_user_id_ignored": bool(args.get("user_id") and args.get("user_id") != user_id),
            "runtime": runtime_mode.value,
            "provider": provider,
            "parent_state_persisted": parent_state_persisted,
            "result_summary": f"Launched builder task. task_id: {thread_id}.",
        }
        logger.info(
            "gemini.builder_lifecycle.start_builder_task launched session_id=%s task_id=%s run_id=%s status=%s task_type=%s",
            session_id,
            thread_id,
            run_id,
            response["status"],
            task_type,
        )
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=f"Existing Sophia builder task launched: {thread_id}.",
            updated_async_tasks={thread_id: async_task},
        )

    async def _edit_builder_artifact(
        self,
        args: Mapping[str, Any],
        *,
        session_id: str,
        parent_thread_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
        trace_context: Mapping[str, Any] | None,
    ) -> GeminiBuilderLifecycleResult:
        existing_task_id = _active_builder_task_id(async_tasks)
        if existing_task_id:
            response = {
                "ok": False,
                "tool": GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
                "started": False,
                "rejected": True,
                "error_type": "active_builder_task",
                "task_id": existing_task_id,
                "status": async_tasks.get(existing_task_id, {}).get("status", "running"),
                "recovery_guidance": (
                    "A builder task is still active. Use update_async_task with the active task_id "
                    "for mid-build changes."
                ),
                "result_summary": "edit_builder_artifact rejected because a builder task is already active.",
            }
            return GeminiBuilderLifecycleResult(
                response=response,
                result_summary=str(response["result_summary"]),
            )

        source = _resolve_edit_builder_source(args, async_tasks)
        if source is None:
            response = {
                "ok": False,
                "tool": GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
                "started": False,
                "rejected": True,
                "error_type": "no_durable_source_artifact",
                "recovery_guidance": (
                    "No durable completed builder artifact is available in this voice session. "
                    "Ask which file to edit, or start a fresh build only if the user wants a rebuild."
                ),
                "result_summary": "No durable completed builder artifact is available to edit.",
            }
            return GeminiBuilderLifecycleResult(
                response=response,
                result_summary=str(response["result_summary"]),
            )

        message = str(args["message"]).strip()
        source_path = str(source["artifact_path"])
        revision_path = _revision_artifact_path(source_path, message)
        task_type = _task_type_for_edit_source(source)
        description = _build_edit_existing_artifact_description(
            message=message,
            source_artifact_path=source_path,
            revision_artifact_path=revision_path,
        )
        explicit_urls = _extract_explicit_user_urls(description)
        allow_web_research = _should_allow_builder_web_research(task_type, description)
        builder_web_budget = _make_builder_web_budget(task_type)
        builder_budget = _voice_builder_budget(task_type)
        contract = builder_lifecycle_contract()

        thread = await self._request_json(
            "POST",
            "/threads",
            json_body={},
            headers=trace_headers,
        )
        thread_id = _required_string(thread.get("thread_id"), "LangGraph thread response omitted thread_id.")
        now = _utcnow_iso()
        build_id = f"build_gemini_{thread_id}"
        operation_id = f"op_gemini_{thread_id}"
        voice_trace_id = _string_value((trace_context or {}).get("voice_trace_id"))
        voice_tool_call_id = _string_value((trace_context or {}).get("voice_tool_call_id"))
        voice_tool_run_id = _string_value((trace_context or {}).get("voice_tool_run_id"))
        relay_correlation_id = _string_value((trace_context or {}).get("relay_correlation_id"))
        provider_receive_sequence = (trace_context or {}).get("provider_receive_sequence")
        kickoff_ms = int(time.time() * 1000)
        timeout_seconds = int((builder_budget or {}).get("max_wall_clock_seconds", 0) or 0)
        edit_context = {
            "mode": "edit_existing_artifact",
            "source_artifact_path": source_path,
            "source_task_id": source.get("source_task_id") or args.get("task_id"),
            "source_run_id": source.get("source_run_id"),
            "revision_of_artifact_path": source_path,
            "revision_artifact_path": revision_path,
            "requested_artifact_ext": _artifact_ext_from_path(revision_path),
            "artifact_ext": _artifact_ext_from_path(revision_path),
        }
        delegation_context = {
            "task": description,
            "task_brief": description,
            "normalized_brief": description,
            "task_type": task_type,
            "source": "gemini_live_dogfood_edit_builder_artifact",
            "parent_thread_id": parent_thread_id,
            "parent_user_id": user_id,
            "companion_artifact": None,
            "active_ritual": None,
            "ritual_phase": None,
            "memories_for_builder": None,
            "relevant_memories": [],
            "allow_web_research": allow_web_research,
            "search_mode": "autonomous",
            "explicit_user_urls": explicit_urls,
            "builder_web_budget": builder_web_budget,
            "builder_budget": builder_budget,
            "artifact_target_path": revision_path,
            "build_id": build_id,
            "operation_id": operation_id,
            "edit_context": edit_context,
            "handoff_resolution": {
                "user_id_source": "trusted_gemini_dogfood_session_user_id",
                "tool_arg_user_id_present": bool(args.get("user_id")),
                "tool_arg_user_id_ignored": bool(args.get("user_id") and args.get("user_id") != user_id),
            },
        }
        run_input = {
            "messages": [{"role": "user", "content": _prefixed_description(description, task_type)}],
            "delegation_context": delegation_context,
            "allow_web_research": allow_web_research,
            "explicit_user_urls": explicit_urls,
            "builder_web_budget": builder_web_budget,
            "builder_artifact_target_path": revision_path,
            "builder_edit_context": edit_context,
            "builder_task_kickoff_ms": kickoff_ms,
            "builder_timeout_seconds": timeout_seconds,
            "builder_deadline_epoch_ms": kickoff_ms + (timeout_seconds * 1000) if timeout_seconds else 0,
            "builder_build_id": build_id,
            "builder_operation_id": operation_id,
        }
        if builder_budget is not None:
            run_input["builder_budget"] = builder_budget
        run = await self._request_json(
            "POST",
            f"/threads/{thread_id}/runs",
            json_body={
                "assistant_id": contract.ASYNC_BUILDER_AGENT_NAME,
                "input": run_input,
                "stream_resumable": True,
                "config": {
                    "metadata": {
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "builder_thread_id": thread_id,
                        "parent_thread_id": parent_thread_id,
                        "task_type": task_type,
                        "channel": "voice",
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": voice_tool_call_id,
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": relay_correlation_id,
                        "provider_receive_sequence": provider_receive_sequence,
                    },
                    "configurable": {
                        "thread_id": thread_id,
                        "user_id": user_id,
                        "parent_thread_id": parent_thread_id,
                        "graph_id": contract.ASYNC_BUILDER_AGENT_NAME,
                        "task_type": task_type,
                        "artifact_target_ext": PurePosixPath(revision_path).suffix.lower(),
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": voice_tool_call_id,
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": relay_correlation_id,
                    }
                },
            },
            headers=trace_headers,
        )
        run_id = _required_string(run.get("run_id"), "LangGraph run response omitted run_id.")
        async_task = {
            "task_id": thread_id,
            "agent_name": contract.ASYNC_BUILDER_AGENT_NAME,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": "running",
            "created_at": now,
            "last_checked_at": now,
            "last_updated_at": now,
            "task_type": task_type,
            "description": description,
            "task_brief": description,
            "demo_mode": False,
            "edit_mode": "edit_existing_artifact",
            "parent_thread_id": parent_thread_id,
            "artifact_target_path": revision_path,
            "build_id": build_id,
            "operation_id": operation_id,
            "voice_trace_id": voice_trace_id,
            "voice_tool_call_id": voice_tool_call_id,
            "voice_tool_run_id": voice_tool_run_id,
            "relay_correlation_id": relay_correlation_id,
            "provider_receive_sequence": provider_receive_sequence,
            "source_artifact_path": source_path,
            "revision_of_artifact_path": source_path,
        }
        parent_state_persisted = await self._persist_parent_async_task(
            parent_thread_id,
            async_task,
            trace_headers=trace_headers,
        )
        response = {
            "ok": True,
            "tool": GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
            "started": True,
            "task_id": thread_id,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": "running",
            "task_type": task_type,
            "description": description,
            "task_brief": description,
            "async_task": async_task,
            "source_artifact_path": source_path,
            "revision_of_artifact_path": source_path,
            "artifact_target_path": revision_path,
            "build_id": build_id,
            "operation_id": operation_id,
            "voice_trace_id": voice_trace_id,
            "trusted_user_id": user_id,
            "tool_arg_user_id_ignored": bool(args.get("user_id") and args.get("user_id") != user_id),
            "runtime": runtime_mode.value,
            "provider": provider,
            "parent_state_persisted": parent_state_persisted,
            "result_summary": f"Launched builder artifact edit. task_id: {thread_id}.",
        }
        logger.info(
            "gemini.builder_lifecycle.edit_builder_artifact launched session_id=%s task_id=%s run_id=%s source=%s target=%s",
            session_id,
            thread_id,
            run_id,
            source_path,
            revision_path,
        )
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=f"Existing Sophia builder artifact edit launched: {thread_id}.",
            updated_async_tasks={thread_id: async_task},
        )

    async def _check_async_task(
        self,
        args: Mapping[str, Any],
        *,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        run = await self._request_json(
            "GET",
            f"/threads/{task['thread_id']}/runs/{task['run_id']}",
            headers=trace_headers,
        )
        updated_task, result = await self._reconcile_task_for_run(
            run,
            task,
            trace_headers=trace_headers,
        )
        status = str(result.get("status") or updated_task.get("status") or "unknown")
        response = {
            "ok": True,
            "tool": GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
            "task_id": task["task_id"],
            "thread_id": task["thread_id"],
            "run_id": task["run_id"],
            "status": status,
            "description": updated_task.get("description"),
            "task_brief": updated_task.get("task_brief") or updated_task.get("description"),
            "result": result,
            "async_task": updated_task,
            "result_summary": _status_summary(task["task_id"], status, result),
        }
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=response["result_summary"],
            updated_async_tasks={task["task_id"]: updated_task},
        )

    async def _update_async_task(
        self,
        args: Mapping[str, Any],
        *,
        session_id: str,
        parent_thread_id: str,
        user_id: str,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
        trace_context: Mapping[str, Any] | None,
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        task_parent_thread_id = _string_value(task.get("parent_thread_id"))
        if task_parent_thread_id and task_parent_thread_id != parent_thread_id:
            logger.warning(
                "gemini.builder_lifecycle.update parent_thread_mismatch task_id=%s "
                "task_parent_thread_id=%s session_parent_thread_id=%s",
                task.get("task_id"),
                task_parent_thread_id,
                parent_thread_id,
            )
            response = {
                "ok": False,
                "tool": GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
                "rejected": True,
                "error_type": "builder_parent_thread_mismatch",
                "task_id": task["task_id"],
                "thread_id": task["thread_id"],
                "run_id": task["run_id"],
                "status": task.get("status", "unknown"),
                "async_task": dict(task),
                "recovery_guidance": (
                    "Return to the companion conversation that started this build, "
                    "or start a fresh builder task in the current conversation."
                ),
                "result_summary": (
                    f"Builder task {task['task_id']} belongs to a different companion "
                    "conversation; no update was dispatched."
                ),
            }
            return GeminiBuilderLifecycleResult(
                response=response,
                result_summary=str(response["result_summary"]),
                updated_async_tasks={task["task_id"]: dict(task)},
            )
        resolved_parent_thread_id = task_parent_thread_id or parent_thread_id
        try:
            current_run = await self._request_json(
                "GET",
                f"/threads/{task['thread_id']}/runs/{task['run_id']}",
                headers=trace_headers,
            )
        except GeminiDogfoodToolError:
            logger.warning(
                "gemini.builder_lifecycle.update live_status_unavailable task_id=%s cached_status=%s",
                task.get("task_id"),
                task.get("status"),
            )
        else:
            current_status = str(current_run.get("status") or "unknown").strip().lower()
            if current_status in builder_lifecycle_contract().TERMINAL_TASK_STATUSES:
                updated_task, terminal_result = await self._reconcile_task_for_run(
                    current_run,
                    task,
                    trace_headers=trace_headers,
                )
                terminal_status = str(terminal_result.get("status") or updated_task.get("status") or current_status)
                response = {
                    "ok": False,
                    "tool": GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
                    "rejected": True,
                    "error_type": "builder_task_terminal",
                    "task_id": task["task_id"],
                    "thread_id": task["thread_id"],
                    "run_id": task["run_id"],
                    "status": terminal_status,
                    "result": terminal_result,
                    "async_task": updated_task,
                    "recovery_guidance": (
                        "This build is already terminal. Use edit_builder_artifact for a successful artifact, "
                        "or start_builder_task for a fresh retry after a failed build."
                    ),
                    "result_summary": f"Builder task {task['task_id']} is already {terminal_status}; no update was dispatched.",
                }
                return GeminiBuilderLifecycleResult(
                    response=response,
                    result_summary=str(response["result_summary"]),
                    updated_async_tasks={task["task_id"]: updated_task},
                )

        message = str(args["message"]).strip()
        explicit_urls = _extract_explicit_user_urls(message)
        augmented_message = _voice_post_interrupt_update_message(message, task)
        run_input: dict[str, Any] = {
            "messages": [{"role": "user", "content": augmented_message}],
        }
        if explicit_urls:
            run_input.update(
                {
                    "explicit_user_urls": explicit_urls,
                    "builder_allowed_urls": explicit_urls,
                    "builder_update_required_urls": explicit_urls,
                }
            )
        artifact_target_path = _string_value(task.get("artifact_target_path"))
        if artifact_target_path:
            run_input["builder_artifact_target_path"] = artifact_target_path
        build_id = _string_value(task.get("build_id")) or f"build_gemini_{task['thread_id']}"
        operation_id = _string_value(task.get("operation_id")) or f"op_gemini_{task['thread_id']}"
        task_type = _string_value(task.get("task_type")) or "document"
        voice_trace_id = (
            _string_value((trace_context or {}).get("voice_trace_id"))
            or _string_value(task.get("voice_trace_id"))
        )
        voice_tool_run_id = _string_value((trace_context or {}).get("voice_tool_run_id"))
        run = await self._request_json(
            "POST",
            f"/threads/{task['thread_id']}/runs",
            json_body={
                "assistant_id": task.get("agent_name") or builder_lifecycle_contract().ASYNC_BUILDER_AGENT_NAME,
                "input": run_input,
                "stream_resumable": True,
                "multitask_strategy": "interrupt",
                "config": {
                    "metadata": {
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "builder_thread_id": task["thread_id"],
                        "parent_thread_id": resolved_parent_thread_id,
                        "task_type": task_type,
                        "channel": "voice",
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": _string_value((trace_context or {}).get("voice_tool_call_id")),
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": _string_value((trace_context or {}).get("relay_correlation_id")),
                        "provider_receive_sequence": (trace_context or {}).get("provider_receive_sequence"),
                        "update_operation": True,
                    },
                    "configurable": {
                        "thread_id": task["thread_id"],
                        "user_id": user_id,
                        "parent_thread_id": resolved_parent_thread_id,
                        "graph_id": task.get("agent_name") or builder_lifecycle_contract().ASYNC_BUILDER_AGENT_NAME,
                        "task_type": task_type,
                        "artifact_target_ext": PurePosixPath(artifact_target_path).suffix.lower() if artifact_target_path else "",
                        "build_id": build_id,
                        "operation_id": operation_id,
                        "voice_session_id": session_id,
                        "voice_trace_id": voice_trace_id,
                        "voice_tool_call_id": _string_value((trace_context or {}).get("voice_tool_call_id")),
                        "voice_tool_run_id": voice_tool_run_id,
                        "relay_correlation_id": _string_value((trace_context or {}).get("relay_correlation_id")),
                    },
                },
            },
            headers=trace_headers,
        )
        run_id = _required_string(run.get("run_id"), "LangGraph update run response omitted run_id.")
        updated_task = _updated_task(task, status="running", run_id=run_id, updated=True)
        updated_task["parent_thread_id"] = resolved_parent_thread_id
        if voice_tool_run_id:
            updated_task["voice_tool_run_id"] = voice_tool_run_id
        response = {
            "ok": True,
            "tool": GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
            "task_id": task["task_id"],
            "thread_id": task["thread_id"],
            "run_id": run_id,
            "status": "running",
            "async_task": updated_task,
            "result_summary": f"Updated builder task. task_id: {task['task_id']}.",
        }
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=response["result_summary"],
            updated_async_tasks={task["task_id"]: updated_task},
        )

    async def _cancel_async_task(
        self,
        args: Mapping[str, Any],
        *,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        await self._request_json(
            "POST",
            f"/threads/{task['thread_id']}/runs/{task['run_id']}/cancel",
            json_body=None,
            params={"wait": 0, "action": "interrupt"},
            allow_empty=True,
            headers=trace_headers,
        )
        updated_task = _updated_task(task, status="cancelled", checked=True, updated=True)
        response = {
            "ok": True,
            "tool": GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME,
            "task_id": task["task_id"],
            "thread_id": task["thread_id"],
            "run_id": task["run_id"],
            "status": "cancelled",
            "async_task": updated_task,
            "result_summary": f"Cancelled builder task. task_id: {task['task_id']}.",
        }
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=response["result_summary"],
            updated_async_tasks={task["task_id"]: updated_task},
        )

    async def _list_async_tasks(
        self,
        args: Mapping[str, Any],
        *,
        async_tasks: Mapping[str, dict[str, Any]],
        trace_headers: Mapping[str, str] | None,
    ) -> GeminiBuilderLifecycleResult:
        status_filter = args.get("status_filter") or "all"
        tasks = [dict(task) for task in async_tasks.values() if isinstance(task, Mapping)]
        if status_filter != "all":
            tasks = [task for task in tasks if task.get("status") == status_filter]
        updated_tasks: dict[str, dict[str, Any]] = {}
        summaries: list[dict[str, Any]] = []
        for task in tasks:
            status = str(task.get("status") or "unknown")
            status_result: dict[str, Any] = {"status": status}
            try:
                run = await self._request_json(
                    "GET",
                    f"/threads/{task['thread_id']}/runs/{task['run_id']}",
                    headers=trace_headers,
                )
                task, status_result = await self._reconcile_task_for_run(
                    run,
                    task,
                    trace_headers=trace_headers,
                )
                status = str(status_result.get("status") or task.get("status") or "unknown")
            except GeminiDogfoodToolError:
                # A cached graph-level success without an accepted builder
                # result must never be presented as an artifact success.
                task, status_result = builder_lifecycle_contract().reconcile_builder_task(
                    task,
                    native_status=status,
                )
                status = str(status_result.get("status") or task.get("status") or "unknown")
            updated_tasks[str(task["task_id"])] = task
            summary = {
                "task_id": task.get("task_id"),
                "agent_name": task.get("agent_name"),
                "status": status,
                "task_type": task.get("task_type"),
            }
            task_brief = task.get("task_brief") or task.get("description")
            if task_brief is not None:
                summary["description"] = task.get("description") or task_brief
                summary["task_brief"] = task_brief
            for key in (
                "artifact_path",
                "terminal_status",
                "terminal_reason",
                "failure_code",
                "root_failure_code",
                "root_failure_summary",
                "build_id",
                "operation_id",
                "voice_trace_id",
            ):
                value = status_result.get(key, task.get(key))
                if value is not None:
                    summary[key] = value
            summaries.append(summary)
        response = {
            "ok": True,
            "tool": GEMINI_LIST_ASYNC_TASKS_TOOL_NAME,
            "tasks": summaries,
            "task_count": len(summaries),
            "status_filter": status_filter,
            "result_summary": f"{len(summaries)} tracked builder task(s).",
        }
        return GeminiBuilderLifecycleResult(
            response=response,
            result_summary=response["result_summary"],
            updated_async_tasks=updated_tasks or None,
        )

    async def _reconcile_task_for_run(
        self,
        run: Mapping[str, Any],
        task: Mapping[str, Any],
        *,
        trace_headers: Mapping[str, str] | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        native_status = _required_string(run.get("status"), "LangGraph run response omitted status.")
        values: Mapping[str, Any] = {}
        if native_status in {"success", "error", "failed"}:
            state = await self._request_json(
                "GET",
                f"/threads/{task['thread_id']}/state",
                params={"subgraphs": False},
                headers=trace_headers,
            )
            values = _record_value(state.get("values")) or {}
        updated_task, result = builder_lifecycle_contract().reconcile_builder_task(
            task,
            native_status=native_status,
            thread_values=values,
            native_error=run.get("error"),
        )
        builder_result = values.get("builder_result") if isinstance(values, Mapping) else None
        if isinstance(builder_result, Mapping):
            result["builder_result"] = dict(builder_result)
        messages = values.get("messages") if isinstance(values, Mapping) else None
        if isinstance(messages, list) and messages:
            last = messages[-1]
            result["result"] = last.get("content", "") if isinstance(last, Mapping) else str(last)
        elif result.get("status") == "success":
            result["result"] = "(completed with an accepted artifact and no output messages)"
        if native_status in {"error", "failed"} and not result.get("root_failure_summary"):
            error_detail = run.get("error")
            result["error"] = str(error_detail) if error_detail else "The async builder encountered an error."
        result["native_run_status"] = native_status
        for key in ("task_id", "thread_id", "run_id", "build_id", "operation_id", "voice_trace_id"):
            value = task.get(key)
            if value is not None:
                result[key] = value
        return updated_task, result

    async def _persist_parent_async_task(
        self,
        parent_thread_id: str,
        async_task: Mapping[str, Any],
        *,
        trace_headers: Mapping[str, str] | None,
    ) -> bool:
        """Best-effort early durability for voice-launched builder identity.

        Terminal events update this same state later. Persisting the running
        record now lets artifact authorization and a resumed Sophia session
        identify what the task is about even before completion.
        """
        task_id = _string_value(async_task.get("task_id"))
        if not parent_thread_id or not task_id or not _is_uuid_string(parent_thread_id):
            return False
        try:
            await self._request_json(
                "POST",
                f"/threads/{parent_thread_id}/state",
                json_body={"values": {"async_tasks": {task_id: dict(async_task)}}},
                allow_empty=True,
                headers=trace_headers,
            )
        except GeminiDogfoodToolError:
            logger.warning(
                "gemini.builder_lifecycle.parent_state_persist_failed parent_thread_id=%s task_id=%s",
                parent_thread_id[:12],
                task_id[:12],
                exc_info=True,
            )
            return False
        return True

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, Any] | None = None,
        allow_empty: bool = False,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self._langgraph_url}{path}",
                    json=json_body,
                    params=params,
                    headers=dict(headers or {}),
                )
        except httpx.RequestError as exc:
            raise GeminiDogfoodToolError(
                f"LangGraph builder lifecycle request failed: {exc.__class__.__name__}."
            ) from exc
        if response.status_code >= 400:
            raise GeminiDogfoodToolError(
                f"LangGraph builder lifecycle request failed with HTTP {response.status_code}: {response.text[:300]}"
            )
        if allow_empty and not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise GeminiDogfoodToolError("LangGraph builder lifecycle response was not valid JSON.") from exc
        if not isinstance(payload, Mapping):
            raise GeminiDogfoodToolError("LangGraph builder lifecycle response was not a JSON object.")
        return dict(payload)


class GeminiRealtimeMemoryHttpBackend:
    """Call the gateway-owned dynamic realtime memory retrieval endpoint."""

    def __init__(self, *, timeout_seconds: float = DEFAULT_REALTIME_MEMORY_RETRIEVAL_TIMEOUT_SECONDS) -> None:
        self._timeout_seconds = timeout_seconds

    async def execute(
        self,
        args: Mapping[str, Any],
        *,
        user_id: str,
        session_id: str,
        context_mode: str | None,
        config: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        endpoint_url = _string_value(config.get("endpoint_url")) if isinstance(config, Mapping) else None
        token = _string_value(config.get("token")) if isinstance(config, Mapping) else None
        token_header = (
            _string_value(config.get("token_header"))
            if isinstance(config, Mapping)
            else None
        ) or "X-Sophia-Realtime-Memory-Token"
        callback_metadata = _gateway_callback_metadata(endpoint_url)
        if not endpoint_url or not token:
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_not_configured",
                diagnostics=callback_metadata,
            )

        query = realtime_memory_query_from_args(args)
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    endpoint_url,
                    json={
                        "query": query,
                        "context_mode": context_mode,
                    },
                    headers={token_header: token},
                )
        except httpx.RequestError as exc:
            diagnostics = {
                **callback_metadata,
                "gateway_request_error_type": exc.__class__.__name__,
            }
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_request_failed",
                diagnostics=diagnostics,
            )

        if not 200 <= response.status_code < 300:
            diagnostics = _gateway_response_diagnostics(
                response,
                endpoint_url=endpoint_url,
                include_body_preview=True,
            )
            parsed_error_payload = _try_parse_gateway_json(response)
            if isinstance(parsed_error_payload, Mapping):
                diagnostics.update(_gateway_payload_diagnostics(parsed_error_payload))
            logger.warning(
                "gemini.retrieve_memories.gateway_http_error callback=%s status_code=%s content_type=%s",
                _gateway_callback_label(endpoint_url),
                response.status_code,
                diagnostics.get("gateway_content_type"),
            )
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_http_error",
                diagnostics=diagnostics,
            )

        try:
            payload = response.json()
        except ValueError:
            diagnostics = _gateway_response_diagnostics(
                response,
                endpoint_url=endpoint_url,
                include_body_preview=True,
            )
            logger.warning(
                "gemini.retrieve_memories.gateway_invalid_json callback=%s status_code=%s content_type=%s "
                "body_preview_hash=%s body_preview=%s",
                _gateway_callback_label(endpoint_url),
                response.status_code,
                diagnostics.get("gateway_content_type"),
                diagnostics.get("gateway_body_preview_hash"),
                diagnostics.get("gateway_body_preview"),
            )
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_invalid_json",
                diagnostics=diagnostics,
            )
        if not isinstance(payload, Mapping):
            diagnostics = _gateway_response_diagnostics(
                response,
                endpoint_url=endpoint_url,
                include_body_preview=False,
            )
            diagnostics["gateway_schema_mismatch"] = "non_object"
            logger.warning(
                "gemini.retrieve_memories.gateway_schema_mismatch callback=%s reason=non_object",
                _gateway_callback_label(endpoint_url),
            )
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_schema_mismatch",
                diagnostics=diagnostics,
            )

        payload_dict = dict(payload)
        schema_errors = _gateway_memory_payload_schema_errors(payload_dict)
        if schema_errors:
            diagnostics = _gateway_response_diagnostics(
                response,
                endpoint_url=endpoint_url,
                include_body_preview=False,
            )
            diagnostics.update(_gateway_payload_diagnostics(payload_dict))
            diagnostics["gateway_schema_mismatch"] = ",".join(schema_errors)
            logger.warning(
                "gemini.retrieve_memories.gateway_schema_mismatch callback=%s errors=%s status=%s schema=%s",
                _gateway_callback_label(endpoint_url),
                diagnostics["gateway_schema_mismatch"],
                diagnostics.get("gateway_response_status"),
                diagnostics.get("gateway_response_schema"),
            )
            return execute_realtime_retrieve_memories_unavailable(
                args,
                user_id=user_id,
                context_mode=context_mode,
                provider_reason="gateway_retrieval_schema_mismatch",
                diagnostics=diagnostics,
            )

        result = decorate_realtime_retrieve_memories_result(payload_dict, args=args)
        result["dynamic_retrieval_transport"] = "gateway_http"
        result["session_id"] = session_id
        diagnostics = result.get("diagnostics")
        if isinstance(diagnostics, dict):
            diagnostics["dynamic_retrieval_transport"] = "gateway_http"
            diagnostics["raw_memory_text_excluded"] = True
        return result


def _gateway_callback_metadata(endpoint_url: str | None) -> dict[str, Any]:
    if not endpoint_url:
        return {
            "gateway_callback_host": None,
            "gateway_callback_path": None,
        }
    parsed = urlsplit(endpoint_url)
    return {
        "gateway_callback_host": parsed.netloc or None,
        "gateway_callback_path": parsed.path or None,
    }


def _gateway_callback_label(endpoint_url: str | None) -> str:
    metadata = _gateway_callback_metadata(endpoint_url)
    host = metadata.get("gateway_callback_host") or "unknown-host"
    path = metadata.get("gateway_callback_path") or "unknown-path"
    return f"{host}{path}"


def _gateway_response_diagnostics(
    response: httpx.Response,
    *,
    endpoint_url: str,
    include_body_preview: bool,
) -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        **_gateway_callback_metadata(endpoint_url),
        "gateway_status_code": response.status_code,
        "gateway_content_type": response.headers.get("content-type"),
    }
    if include_body_preview:
        body = response.content or b""
        diagnostics["gateway_body_preview_hash"] = f"sha256:{sha256(body).hexdigest()}"
        diagnostics["gateway_body_preview"] = _redacted_body_preview(body)
    return diagnostics


def _try_parse_gateway_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _gateway_payload_diagnostics(payload: Mapping[str, Any]) -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        "gateway_response_keys": sorted(str(key) for key in payload.keys())[:30],
        "gateway_response_status": _string_value(payload.get("status")),
        "gateway_response_schema": _string_value(payload.get("schema")),
        "gateway_response_provider_status": _string_value(payload.get("provider_status")),
        "gateway_response_provider_reason": _string_value(payload.get("provider_reason")),
    }
    nested_diagnostics = payload.get("diagnostics")
    if isinstance(nested_diagnostics, Mapping):
        diagnostics["gateway_response_diagnostics_schema"] = _string_value(
            nested_diagnostics.get("schema")
        )
    return {key: value for key, value in diagnostics.items() if value is not None}


def _gateway_memory_payload_schema_errors(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    missing = sorted(REALTIME_MEMORY_GATEWAY_REQUIRED_FIELDS.difference(payload.keys()))
    if missing:
        errors.append(f"missing:{'|'.join(missing)}")
    if not isinstance(payload.get("ok"), bool):
        errors.append("ok_not_bool")
    status = _string_value(payload.get("status"))
    if status not in REALTIME_MEMORY_GATEWAY_ALLOWED_STATUSES:
        errors.append("status_invalid")
    memories = payload.get("memories")
    if not isinstance(memories, list):
        errors.append("memories_not_list")
    count = payload.get("count")
    if type(count) is not int or count < 0:
        errors.append("count_not_non_negative_int")
    elif isinstance(memories, list) and count != len(memories):
        errors.append("count_memory_length_mismatch")
    if not _string_value(payload.get("provider_status")):
        errors.append("provider_status_missing")
    if not _string_value(payload.get("provider_reason")):
        errors.append("provider_reason_missing")
    if not isinstance(payload.get("diagnostics"), Mapping):
        errors.append("diagnostics_not_object")
    return errors


def _redacted_body_preview(body: bytes, limit: int = 240) -> str:
    if not body:
        return ""
    decoded = body[:limit].decode("utf-8", errors="replace")
    collapsed = " ".join(decoded.split())
    return re.sub(r"[A-Za-z0-9]", "x", collapsed)[:limit]


class GeminiDogfoodToolExecutor:
    """Backend-owned Gemini Live execution for approved existing Sophia tools."""

    def __init__(
        self,
        *,
        builder_lifecycle_backend: GeminiBuilderLifecycleHttpBackend | None = None,
        memory_backend: GeminiRealtimeMemoryHttpBackend | None = None,
    ) -> None:
        self._builder_lifecycle_backend = builder_lifecycle_backend or GeminiBuilderLifecycleHttpBackend()
        self._memory_backend = memory_backend or GeminiRealtimeMemoryHttpBackend()

    async def execute(
        self,
        call: GeminiLiveFunctionCall,
        *,
        session_id: str,
        parent_thread_id: str | None = None,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]] | None = None,
        context_mode: str | None = None,
        memory_retrieval_config: Mapping[str, Any] | None = None,
        trace_headers: Mapping[str, str] | None = None,
        trace_context: Mapping[str, Any] | None = None,
        builder_start_authorized: bool | None = None,
    ) -> GeminiDogfoodToolExecution:
        if call.name not in GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES:
            allowed = ", ".join(sorted(GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES))
            raise GeminiDogfoodToolError(
                f"Gemini Live requested unsupported Sophia tool {call.name!r}. Approved existing tools: {allowed}."
            )

        if call.name == GEMINI_START_BUILDER_TASK_TOOL_NAME and builder_start_authorized is False:
            result_summary = (
                "No builder was started because the latest user utterance did not contain "
                "a direct request to create a deliverable or conduct research."
            )
            response = {
                "ok": False,
                "tool": call.name,
                "started": False,
                "rejected": True,
                "error_type": "explicit_builder_request_required",
                "result_summary": result_summary,
                "recovery_guidance": (
                    "Continue the conversation normally. If the user may want an artifact, "
                    "ask one concise clarifying question before trying again."
                ),
                "session_id": session_id,
                "runtime": runtime_mode.value,
                "provider": provider,
            }
            return GeminiDogfoodToolExecution(
                call=call,
                response=response,
                result_summary=result_summary,
                success=False,
                error_text=result_summary,
            )

        if call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
            try:
                tool_result, artifact = execute_existing_emit_artifact(call.args)
            except Exception as exc:
                logger.warning(
                    "gemini.emit_artifact.invalid_arguments call_id=%s error_type=%s arg_keys=%s",
                    call.call_id,
                    exc.__class__.__name__,
                    sorted(str(key) for key in call.args.keys()),
                )
                return _invalid_emit_artifact_arguments_execution(
                    call,
                    session_id=session_id,
                    user_id=user_id,
                    runtime_mode=runtime_mode,
                    provider=provider,
                )

            response = {
                "ok": True,
                "tool": call.name,
                "backend_tool_result": tool_result,
                "result_summary": tool_result,
                "artifact_recorded": tool_result == "Artifact recorded.",
                "artifact_keys": sorted(str(key) for key in artifact.keys()),
                "session_id": session_id,
                "user_id": user_id,
                "runtime": runtime_mode.value,
                "provider": provider,
                "public_event_boundary": "SophiaEventNormalizer",
            }
            return GeminiDogfoodToolExecution(
                call=call,
                response=response,
                result_summary="Existing Sophia emit_artifact tool executed.",
                public_artifact=artifact,
            )

        if call.name == GEMINI_RETRIEVE_MEMORIES_TOOL_NAME:
            if memory_retrieval_config:
                response = await self._memory_backend.execute(
                    call.args,
                    user_id=user_id,
                    session_id=session_id,
                    context_mode=context_mode,
                    config=memory_retrieval_config,
                )
            else:
                response = execute_realtime_retrieve_memories(
                    call.args,
                    user_id=user_id,
                    context_mode=context_mode,
                )
            ignored_arg_names = sorted(
                {
                    *[str(name) for name in response.get("ignored_model_arg_names") or []],
                    *[
                        name
                        for name in ("user_id", "categories", "category", "filters", "memory_provider")
                        if name in call.args
                    ],
                }
            )
            response.update(
                {
                    "tool": call.name,
                    "session_id": session_id,
                    "runtime": runtime_mode.value,
                    "provider": provider,
                    "public_event_boundary": "SophiaEventNormalizer",
                    "trusted_user_id_source": response.get("trusted_user_id_source") or "authenticated_session_context",
                    "tool_arg_user_id_ignored": "user_id" in call.args,
                    "ignored_model_arg_names": ignored_arg_names,
                }
            )
            diagnostics = response.get("diagnostics")
            if isinstance(diagnostics, dict):
                diagnostics["trusted_user_id_source"] = response.get(
                    "trusted_user_id_source",
                    "authenticated_session_context",
                )
                diagnostics["ignored_model_arg_names"] = ignored_arg_names
                diagnostics["raw_memory_text_excluded"] = True
            status = str(response.get("status") or "error")
            count = int(response.get("count") or 0)
            return GeminiDogfoodToolExecution(
                call=call,
                response=response,
                result_summary=f"retrieve_memories returned {status} with {count} snippet(s).",
            )

        if call.name == GEMINI_WEB_FETCH_TOOL_NAME:
            response = await execute_realtime_web_fetch(call.args)
            result_summary = str(
                response.get("result_summary") or "The page fetch did not return a result."
            )
            return GeminiDogfoodToolExecution(
                call=call,
                response={
                    **response,
                    "tool": call.name,
                    "session_id": session_id,
                    "runtime": runtime_mode.value,
                    "provider": provider,
                },
                result_summary=result_summary,
                success=bool(response.get("ok")),
                error_text=None if response.get("ok") else result_summary,
            )

        if call.name == GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME:
            started_at = time.perf_counter()
            response = execute_read_artifact_text_feature_gated(
                call.args,
                session_id=session_id,
                user_id=user_id,
                provider=provider,
            )
            latency_ms = max(int((time.perf_counter() - started_at) * 1000), 0)
            result_summary = read_artifact_text_result_summary(response)
            return GeminiDogfoodToolExecution(
                call=call,
                response=response,
                result_summary=result_summary,
                success=bool(response.get("ok")),
                error_text=None if response.get("ok") else str(
                    response.get("safe_reason") or "read_artifact_text_unavailable"
                ),
                diagnostic_metadata={"latency_ms": latency_ms},
            )

        if call.name in GEMINI_COREVIEW_ACTION_TOOL_NAMES:
            response = coreview_browser_action_unavailable_response(call.name, call.args)
            result_summary = coreview_action_result_summary(response)
            return GeminiDogfoodToolExecution(
                call=call,
                response=response,
                result_summary=result_summary,
                success=False,
                error_text=str(response.get("result_summary") or "browser_coreview_tool_bridge_unavailable"),
            )

        try:
            validated_args = validate_builder_lifecycle_tool_args(call.name, call.args)
            lifecycle_result = await self._builder_lifecycle_backend.execute(
                call.name,
                validated_args,
                session_id=session_id,
                parent_thread_id=parent_thread_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
                async_tasks=dict(async_tasks or {}),
                trace_headers=trace_headers,
                trace_context=trace_context,
            )
        except GeminiBuilderTaskNotTrackedError as exc:
            return _recoverable_unknown_task_execution(
                call,
                exc,
                session_id=session_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
            )
        except Exception as exc:
            raise GeminiDogfoodToolError(
                f"Existing Sophia builder/lifecycle tool {call.name!r} rejected the Gemini Live arguments or execution failed: {exc}"
            ) from exc

        lifecycle_ok = bool(lifecycle_result.response.get("ok", True))
        return GeminiDogfoodToolExecution(
            call=call,
            response=lifecycle_result.response,
            result_summary=lifecycle_result.result_summary,
            success=lifecycle_ok,
            error_text=(
                None
                if lifecycle_ok
                else str(
                    lifecycle_result.response.get("result_summary")
                    or lifecycle_result.response.get("error_message")
                    or "builder_lifecycle_rejected"
                )
            ),
            updated_async_tasks=lifecycle_result.updated_async_tasks,
        )


def gemini_dogfood_tool_declarations() -> list[dict[str, object]]:
    try:
        declarations = gemini_sophia_function_declarations()
    except SophiaBackendToolConfigurationError as exc:
        raise GeminiDogfoodToolError(
            "Gemini dogfood tool declaration configuration failed: " f"{exc}"
        ) from exc

    return [
        {
            "functionDeclarations": declarations,
        },
        # Gemini Live's provider-native Search grounding. This works alongside
        # our custom function declarations and needs no additional API secret.
        {"googleSearch": {}},
    ]


def _invalid_emit_artifact_arguments_execution(
    call: GeminiLiveFunctionCall,
    *,
    session_id: str,
    user_id: str,
    runtime_mode: VoiceRuntimeMode,
    provider: str,
) -> GeminiDogfoodToolExecution:
    response = {
        "ok": False,
        "tool": call.name,
        "error_type": "invalid_tool_arguments",
        "result_summary": GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS,
        "recovery_guidance": GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS,
        "artifact_recorded": False,
        "session_id": session_id,
        "user_id": user_id,
        "runtime": runtime_mode.value,
        "provider": provider,
        "public_event_boundary": "SophiaEventNormalizer",
    }
    return GeminiDogfoodToolExecution(
        call=call,
        response=response,
        result_summary=GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS,
        success=False,
        error_text=GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS,
    )


def extract_gemini_live_function_calls(event: Mapping[str, Any]) -> list[GeminiLiveFunctionCall]:
    tool_call = _record_from_any_key(event, "toolCall", "tool_call")
    if tool_call is None:
        return []

    function_calls = _sequence_from_any_key(tool_call, "functionCalls", "function_calls")
    if not function_calls:
        raise GeminiDogfoodToolError("Gemini Live toolCall omitted functionCalls.")

    calls: list[GeminiLiveFunctionCall] = []
    for index, function_call in enumerate(function_calls):
        if not isinstance(function_call, Mapping):
            raise GeminiDogfoodToolError(
                f"Gemini Live functionCalls[{index}] must be a JSON object."
            )

        call_id = _string_value(function_call.get("id"))
        name = _string_value(function_call.get("name"))
        if not call_id:
            raise GeminiDogfoodToolError(
                f"Gemini Live functionCalls[{index}] omitted the required id."
            )
        if not name:
            raise GeminiDogfoodToolError(
                f"Gemini Live functionCalls[{index}] omitted the required name."
            )

        args = _json_object_value(function_call.get("args"))
        if args is None:
            args = _json_object_value(function_call.get("arguments")) or {}
        calls.append(GeminiLiveFunctionCall(call_id=call_id, name=name, args=args))

    return calls


def extract_gemini_tool_call_cancellation_ids(event: Mapping[str, Any]) -> list[str]:
    cancellation = _record_from_any_key(event, "toolCallCancellation", "tool_call_cancellation")
    if cancellation is None:
        return []
    return [call_id for call_id in _sequence_from_any_key(cancellation, "ids") if isinstance(call_id, str)]


def gemini_tool_response_client_action(
    executions: list[GeminiDogfoodToolExecution],
) -> dict[str, Any] | None:
    if not executions:
        return None

    function_responses = [
        {
            "id": execution.call.call_id,
            "name": execution.call.name,
            "response": dict(execution.response),
        }
        for execution in executions
    ]
    return {
        "type": GEMINI_DOGFOOD_TOOL_RESPONSE_ACTION,
        "payload": {"toolResponse": {"functionResponses": function_responses}},
        "tool_call_ids": [execution.call.call_id for execution in executions],
        "tool_names": [execution.call.name for execution in executions],
        "result_summary": "; ".join(execution.result_summary for execution in executions),
    }


def _record_from_any_key(source: Mapping[str, Any], *names: str) -> dict[str, Any] | None:
    for name in names:
        value = _record_value(source.get(name))
        if value is not None:
            return value
    return None


def _sequence_from_any_key(source: Mapping[str, Any], *names: str) -> list[Any]:
    for name in names:
        value = source.get(name)
        if isinstance(value, list):
            return list(value)
        if isinstance(value, tuple):
            return list(value)
    return []


def _json_object_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _is_uuid_string(value: str) -> bool:
    try:
        UUID(value)
    except (TypeError, ValueError):
        return False
    return True


def _utcnow_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _required_string(value: Any, message: str) -> str:
    resolved = _string_value(value)
    if resolved is None:
        raise GeminiDogfoodToolError(message)
    return resolved


def _prefixed_description(description: str, task_type: str) -> str:
    contract = builder_lifecycle_contract()
    prefix = contract.TASK_TYPE_PREFIXES.get(task_type, f"[{task_type}]")
    stripped = description.strip()
    if stripped.startswith(prefix):
        return stripped
    return f"{prefix} {stripped}"


def _extract_explicit_user_urls(text: str) -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    for match in _EXPLICIT_URL_RE.findall(text or ""):
        normalized = match.strip().rstrip(_TRAILING_URL_PUNCTUATION)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def _voice_post_interrupt_update_message(
    message: str,
    task: Mapping[str, Any],
) -> str:
    """Give the direct voice bridge the same resume contract as Companion.

    Voice updates use LangGraph's interrupt strategy so the user can refine a
    build while continuing the conversation. The replacement run must receive
    an explicit resume instruction and the original target; otherwise it sees
    only the addendum and can restart or terminate without a deliverable.
    """

    if _POST_INTERRUPT_BUILD_MARKER in message:
        return message
    target_path = _string_value(task.get("artifact_target_path"))
    task_type = (_string_value(task.get("task_type")) or "document").lower()
    target_line = (
        f"Keep the concrete deliverable target `{target_path}`."
        if target_path
        else "Keep the original concrete deliverable target from the existing build state."
    )
    deck_line = ""
    if task_type == "presentation" or (target_path and target_path.lower().endswith(".pptx")):
        deck_line = (
            " Resume the service-owned presentation lane and call `prepare_deck_build` "
            "exactly once with the complete updated deck intent. Do not substitute "
            "plain text, write_file, python-pptx, or a partial source artifact."
        )
    research_line = (
        "The update contains approved URL targets; fetch the exact new URLs before authoring."
        if _extract_explicit_user_urls(message)
        else "Preserve prior research and completed work from the existing thread history."
    )
    return (
        f"{_POST_INTERRUPT_BUILD_MARKER}\n"
        "You are RESUMING, not restarting, a build interrupted by this update. "
        f"{research_line} {target_line}{deck_line}\n\n"
        "User's update message:\n"
        f"{message}"
    )


def _should_allow_builder_web_research(task_type: str, description: str) -> bool:
    normalized_type = (task_type or "").strip().lower()
    if normalized_type == "research":
        return True
    if normalized_type == "frontend":
        return False
    if normalized_type == "document":
        return True
    if _extract_explicit_user_urls(description):
        return True
    if normalized_type in {"presentation", "visual_report"}:
        task_text = (description or "").lower()
        return any(
            cue in task_text
            for cue in (
                "latest",
                "current",
                "today",
                "recent",
                "verify",
                "research",
                "compare",
                "market",
                "competitor",
                "pricing",
                "trend",
            )
        )
    return False


def _make_builder_web_budget(task_type: str) -> dict[str, int]:
    if (task_type or "").strip().lower() == "research":
        return {"search_limit": 5, "fetch_limit": 8, "search_calls": 0, "fetch_calls": 0}
    return {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0}


def _voice_builder_budget(task_type: str) -> dict[str, Any] | None:
    """Seed the bounded presentation budget for the direct Gemini bridge."""

    if (task_type or "").strip().lower() not in {"presentation", "visual_report"}:
        return None
    raw_max_tokens = os.getenv("SOPHIA_BUILDER_PRESENTATION_BUDGET_AUTHORING_MAX_TOKENS", "16384")
    try:
        authoring_max_tokens = max(1_024, int(raw_max_tokens))
    except ValueError:
        logger.warning(
            "gemini.builder_lifecycle invalid presentation authoring budget=%r; using 16384",
            raw_max_tokens,
        )
        authoring_max_tokens = 16_384
    return {
        "tier": "presentation",
        "max_cost_usd": 12.0,
        "max_total_tokens": 5_000_000,
        "max_non_artifact_turns": 12,
        "force_emit_remaining_turns": 2,
        "soft_warn_at_turn": 6,
        "force_emit_wall_clock_fraction": 0.7,
        "repair_reserve_usd": 0.25,
        "cost_model_key": "claude-sonnet-5",
        "max_wall_clock_seconds": 1_200,
        "prepare_force_at_turn": 2,
        "prepare_force_after_seconds": 15,
        "authoring_deadline_seconds": 720,
        "preflight_timeout_seconds": 15,
        "authoring_max_tokens": authoring_max_tokens,
        "authoring_timeout_seconds": 360,
        "terminal_reserve_seconds": 30,
    }


def _voice_builder_artifact_target_path(description: str, task_type: str) -> str:
    """Choose the canonical output target used by the companion builder."""

    extension = ".pptx" if (task_type or "").strip().lower() == "presentation" else ".pdf"
    return f"/mnt/user-data/outputs/{_slugify_for_filename(description)}{extension}"


def _canonical_output_artifact_path(path: Any) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return None
    normalized = path.strip().replace("\\", "/")
    if normalized.startswith("/mnt/user-data/outputs/"):
        return normalized
    if normalized.startswith("mnt/user-data/outputs/"):
        return f"/{normalized}"
    return None


def _artifact_ext_from_path(path: str | None) -> str | None:
    name = str(path or "").replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in name:
        return None
    suffix = name.rsplit(".", 1)[-1].strip().lower()
    return suffix or None


def _slugify_for_filename(value: str, *, max_len: int = 48) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    return (slug[:max_len].strip(".-") or "artifact")


def _revision_artifact_path(source_artifact_path: str, message: str) -> str:
    source_name = source_artifact_path.replace("\\", "/").rsplit("/", 1)[-1]
    stem = source_name.rsplit(".", 1)[0] if "." in source_name else source_name
    suffix = f".{_artifact_ext_from_path(source_name) or 'md'}"
    revision_id = sha256(f"{source_artifact_path}\n{message}\n{time.time()}".encode("utf-8")).hexdigest()[:8]
    return f"/mnt/user-data/outputs/{_slugify_for_filename(stem)}-revision-{revision_id}{suffix}"


def _direct_artifact_payload_from_task(task: Mapping[str, Any]) -> dict[str, Any] | None:
    artifact_path = _canonical_output_artifact_path(task.get("artifact_path"))
    if not artifact_path:
        return None
    return {
        "artifact_path": artifact_path,
        "artifact_ext": task.get("artifact_ext") or _artifact_ext_from_path(artifact_path),
        "artifact_title": task.get("artifact_title"),
        "task_type": task.get("task_type"),
        "source_task_id": task.get("task_id"),
        "source_run_id": task.get("run_id"),
    }


def _builder_artifact_payload_from_task(task: Mapping[str, Any]) -> dict[str, Any] | None:
    for key in ("builder_result", "artifact"):
        payload = task.get(key)
        if isinstance(payload, Mapping):
            artifact_path = _canonical_output_artifact_path(payload.get("artifact_path"))
            if artifact_path:
                return {
                    **dict(payload),
                    "artifact_path": artifact_path,
                    "artifact_ext": payload.get("artifact_ext") or _artifact_ext_from_path(artifact_path),
                    "task_type": payload.get("task_type") or task.get("task_type"),
                    "source_task_id": payload.get("task_id") or task.get("task_id"),
                    "source_run_id": payload.get("run_id") or task.get("run_id"),
                }
    result = task.get("result")
    if isinstance(result, Mapping):
        nested = result.get("builder_result")
        if isinstance(nested, Mapping):
            artifact_path = _canonical_output_artifact_path(nested.get("artifact_path"))
            if artifact_path:
                return {
                    **dict(nested),
                    "artifact_path": artifact_path,
                    "artifact_ext": nested.get("artifact_ext") or _artifact_ext_from_path(artifact_path),
                    "task_type": nested.get("task_type") or task.get("task_type"),
                    "source_task_id": nested.get("task_id") or task.get("task_id"),
                    "source_run_id": nested.get("run_id") or task.get("run_id"),
                }
    return _direct_artifact_payload_from_task(task)


def _resolve_edit_builder_source(
    args: Mapping[str, Any],
    async_tasks: Mapping[str, dict[str, Any]],
) -> dict[str, Any] | None:
    explicit_path = _canonical_output_artifact_path(args.get("artifact_path"))
    explicit_task_id = _string_value(args.get("task_id"))
    if explicit_path:
        source: dict[str, Any] = {
            "artifact_path": explicit_path,
            "artifact_ext": _artifact_ext_from_path(explicit_path),
            "source_task_id": explicit_task_id,
        }
        if explicit_task_id and isinstance(async_tasks.get(explicit_task_id), Mapping):
            task = async_tasks[explicit_task_id]
            source["task_type"] = task.get("task_type")
            source["source_run_id"] = task.get("run_id")
        return source

    candidates: list[Mapping[str, Any]] = []
    if explicit_task_id and isinstance(async_tasks.get(explicit_task_id), Mapping):
        candidates.append(async_tasks[explicit_task_id])
    candidates.extend(
        task
        for task in async_tasks.values()
        if isinstance(task, Mapping) and task not in candidates
    )
    for task in candidates:
        if str(task.get("status") or "").lower() not in {"success", "completed"}:
            continue
        payload = _builder_artifact_payload_from_task(task)
        if payload is not None:
            return payload
    return None


def _task_type_for_edit_source(source: Mapping[str, Any]) -> str:
    task_type = source.get("task_type")
    if isinstance(task_type, str) and task_type in builder_lifecycle_contract().TASK_TYPE_PREFIXES:
        return task_type
    ext = str(source.get("artifact_ext") or "").lower().lstrip(".")
    if ext == "html":
        return "document"
    if ext == "pdf":
        return "visual_report"
    if ext == "pptx":
        return "presentation"
    return "document"


def _build_edit_existing_artifact_description(
    *,
    message: str,
    source_artifact_path: str,
    revision_artifact_path: str,
) -> str:
    return (
        "Edit an existing completed builder artifact, preserving unrelated content.\n\n"
        f"Source artifact path: {source_artifact_path}\n"
        f"Revised artifact target path: {revision_artifact_path}\n\n"
        "Read the source artifact before making changes. Do not rebuild from scratch unless "
        "the user's edit explicitly asks for a full rewrite. For pure local wording, layout, "
        "or content edits, web research is optional; if the edit introduces new URLs, named "
        "projects, papers, frameworks, companies, factual topics, or source requirements, "
        "search/fetch that new material before editing.\n\n"
        f"User edit request:\n{message}"
    )


def _active_builder_task_id(async_tasks: Mapping[str, dict[str, Any]]) -> str | None:
    contract = builder_lifecycle_contract()
    for task_id, task in async_tasks.items():
        if not isinstance(task, Mapping):
            continue
        if task.get("agent_name") != contract.ASYNC_BUILDER_AGENT_NAME:
            continue
        if task.get("status") not in contract.TERMINAL_TASK_STATUSES:
            return str(task_id)
    return None


def _tracked_task(task_id: str, async_tasks: Mapping[str, dict[str, Any]]) -> dict[str, Any]:
    normalized_task_id = task_id.strip()
    placeholder = _is_placeholder_task_id(normalized_task_id)
    task = None if placeholder else async_tasks.get(normalized_task_id)
    if not isinstance(task, Mapping):
        tracked_task_ids = sorted(str(known_task_id) for known_task_id in async_tasks if str(known_task_id).strip())
        raise GeminiBuilderTaskNotTrackedError(normalized_task_id, tracked_task_ids, placeholder=placeholder)
    return dict(task)


def _is_placeholder_task_id(task_id: str) -> bool:
    normalized = task_id.strip().lower()
    if not normalized:
        return True
    return normalized in {
        "builder-thread-id",
        "thread-id",
        "task-id",
        "builder-task-id",
        "async-task-id",
        "placeholder",
    }


def _recoverable_unknown_task_execution(
    call: GeminiLiveFunctionCall,
    exc: GeminiBuilderTaskNotTrackedError,
    *,
    session_id: str,
    user_id: str,
    runtime_mode: VoiceRuntimeMode,
    provider: str,
) -> GeminiDogfoodToolExecution:
    guidance = (
        "For selected-artifact review status, use the Coreview status action. "
        "Keep any user-facing reply product-level: I don't see an active artifact update right now. "
        "Do not mention internal identifiers or recovery mechanics."
    )
    response = {
        "ok": False,
        "tool": call.name,
        "rejected": True,
        "error_type": "placeholder_task_id" if exc.placeholder else "unknown_task_id",
        "error_message": "No active build is available for that request.",
        "status": "rejected",
        "tracked_task_count": len(exc.tracked_task_ids),
        "recovery_guidance": guidance,
        "session_id": session_id,
        "user_id": user_id,
        "runtime": runtime_mode.value,
        "provider": provider,
        "generic_async_tool_blocked_reason": "placeholder_task_id" if exc.placeholder else "unknown_task_id",
        "generic_async_tool_responded_safely": True,
        "raw_task_id_excluded": True,
        "result_summary": "No active build is available for that request.",
    }
    return GeminiDogfoodToolExecution(
        call=call,
        response=response,
        result_summary=str(response["result_summary"]),
        success=False,
        error_text=str(response["error_message"]),
    )


def _retrieve_memories_execution_diagnostic(
    execution: GeminiDogfoodToolExecution,
) -> dict[str, Any]:
    response = execution.response
    diagnostics = _record_value(response.get("diagnostics")) or {}
    count = int(response.get("count") or 0)
    return {
        "id": execution.call.call_id,
        "name": execution.call.name,
        "success": execution.success,
        "result_summary": execution.result_summary,
        "status": _string_value(response.get("status")) or "error",
        "count": count,
        "has_results": count > 0,
        "latency_ms": diagnostics.get("latency_ms"),
        "query_length": diagnostics.get("query_length"),
        "query_fingerprint": diagnostics.get("query_fingerprint"),
        "query_term_count": diagnostics.get("query_term_count"),
        "raw_query_excluded": diagnostics.get("raw_query_excluded", True),
        "result_categories": diagnostics.get("result_categories") or [],
        "result_text_lengths": diagnostics.get("result_text_lengths") or [],
        "result_fingerprints": _safe_result_fingerprints(diagnostics.get("result_fingerprints")),
        "result_preview_included": diagnostics.get("result_preview_included", False),
        "max_query_terms_matched_count": diagnostics.get("max_query_terms_matched_count"),
        "any_result_exact_query_terms_present": diagnostics.get("any_result_exact_query_terms_present"),
        "provider_status": diagnostics.get("provider_status"),
        "provider_reason": diagnostics.get("provider_reason"),
        "provider_transport": diagnostics.get("provider_transport"),
        "gateway_status_code": diagnostics.get("gateway_status_code"),
        "gateway_content_type": diagnostics.get("gateway_content_type"),
        "gateway_callback_host": diagnostics.get("gateway_callback_host"),
        "gateway_callback_path": diagnostics.get("gateway_callback_path"),
        "gateway_body_preview_hash": diagnostics.get("gateway_body_preview_hash"),
        "gateway_body_preview": diagnostics.get("gateway_body_preview"),
        "gateway_response_status": diagnostics.get("gateway_response_status"),
        "gateway_response_schema": diagnostics.get("gateway_response_schema"),
        "gateway_response_diagnostics_schema": diagnostics.get("gateway_response_diagnostics_schema"),
        "gateway_schema_mismatch": diagnostics.get("gateway_schema_mismatch"),
        "cache_status": diagnostics.get("cache_status"),
        "trusted_user_id_source": diagnostics.get("trusted_user_id_source") or response.get("trusted_user_id_source"),
        "tool_arg_user_id_ignored": bool(response.get("tool_arg_user_id_ignored")),
        "ignored_model_arg_names": list(response.get("ignored_model_arg_names") or []),
        "raw_memory_text_excluded": diagnostics.get("raw_memory_text_excluded", True),
        "response": redacted_retrieve_memories_diagnostic(response),
    }


def _read_artifact_text_execution_diagnostic(
    execution: GeminiDogfoodToolExecution,
) -> dict[str, Any]:
    latency_ms = None
    if isinstance(execution.diagnostic_metadata, Mapping):
        raw_latency_ms = execution.diagnostic_metadata.get("latency_ms")
        if isinstance(raw_latency_ms, int):
            latency_ms = raw_latency_ms
    redacted_response = redacted_read_artifact_text_diagnostic(
        execution.response,
        latency_ms=latency_ms,
    )
    return {
        "id": execution.call.call_id,
        "name": execution.call.name,
        "success": execution.success,
        "result_summary": execution.result_summary,
        "artifact_id": redacted_response.get("artifact_id"),
        "source": redacted_response.get("source"),
        "char_count": redacted_response.get("char_count"),
        "truncated": redacted_response.get("truncated"),
        "status": redacted_response.get("status"),
        "safe_reason": redacted_response.get("safe_reason"),
        "latency_ms": latency_ms,
        "raw_artifact_text_excluded": True,
        "response": redacted_response,
    }


def _coreview_action_execution_diagnostic(
    execution: GeminiDogfoodToolExecution,
) -> dict[str, Any]:
    redacted_response = redacted_coreview_action_diagnostic(execution.response)
    return {
        "id": execution.call.call_id,
        "name": execution.call.name,
        "success": execution.success,
        "result_summary": execution.result_summary,
        "action": redacted_response.get("action"),
        "artifact_id": redacted_response.get("artifact_id"),
        "renderer_kind": redacted_response.get("renderer_kind"),
        "page_index": redacted_response.get("page_index"),
        "page_number": redacted_response.get("page_number"),
        "page_count": redacted_response.get("page_count"),
        "refresh_attempted": redacted_response.get("refresh_attempted"),
        "refresh_result": redacted_response.get("refresh_result"),
        "blocked_reason": redacted_response.get("blocked_reason"),
        "raw_artifact_text_excluded": True,
        "raw_frame_excluded": True,
        "response": redacted_response,
    }


def _safe_result_fingerprints(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    safe_keys = {
        "category",
        "exact_query_terms_present",
        "query_term_count",
        "query_terms_matched_count",
        "rank",
        "score",
        "text_fingerprint",
        "text_length",
    }
    fingerprints: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        fingerprints.append({key: item[key] for key in safe_keys if key in item})
    return fingerprints


def _updated_task(
    task: Mapping[str, Any],
    *,
    status: str,
    run_id: str | None = None,
    checked: bool = False,
    updated: bool = False,
) -> dict[str, Any]:
    now = _utcnow_iso()
    merged = dict(task)
    if run_id is not None:
        merged["run_id"] = run_id
    if merged.get("status") != status:
        merged["last_updated_at"] = now
    elif updated:
        merged["last_updated_at"] = now
    if checked:
        merged["last_checked_at"] = now
    merged["status"] = status
    return merged


def _status_summary(task_id: str, status: str, result: Mapping[str, Any]) -> str:
    if status == "success":
        return f"Builder task {task_id} completed successfully."
    if status in {"error", "failed", "timeout", "timed_out"}:
        detail = None
        if isinstance(result, Mapping):
            detail = (
                result.get("root_failure_summary")
                or result.get("failure_summary")
                or result.get("summary")
                or result.get("error")
                or result.get("terminal_reason")
            )
        return f"Builder task {task_id} ended with {status}: {detail or 'no detail provided'}."
    if status == "cancelled":
        return f"Builder task {task_id} is cancelled."
    return f"Builder task {task_id} is {status}."


def _task_id_from_response(response: Mapping[str, Any]) -> str | None:
    direct = _string_value(response.get("task_id"))
    if direct:
        return direct
    async_task = _record_value(response.get("async_task"))
    if async_task is not None:
        return _string_value(async_task.get("task_id"))
    return None


def _task_status_from_response(response: Mapping[str, Any]) -> str | None:
    direct = _string_value(response.get("status"))
    if direct:
        return direct
    async_task = _record_value(response.get("async_task"))
    if async_task is not None:
        return _string_value(async_task.get("status"))
    return None


def _string_list_value(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]
