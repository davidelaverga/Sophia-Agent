from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit

import httpx

from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_backend_tools import (
    SophiaBackendToolConfigurationError,
    builder_lifecycle_contract,
    decorate_realtime_retrieve_memories_result,
    execute_existing_emit_artifact,
    execute_realtime_retrieve_memories,
    execute_realtime_retrieve_memories_unavailable,
    gemini_sophia_function_declarations,
    redacted_retrieve_memories_diagnostic,
    realtime_memory_query_from_args,
    validate_builder_lifecycle_tool_args,
)

GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
GEMINI_START_BUILDER_TASK_TOOL_NAME = "start_builder_task"
GEMINI_CHECK_ASYNC_TASK_TOOL_NAME = "check_async_task"
GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"
GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME = "cancel_async_task"
GEMINI_LIST_ASYNC_TASKS_TOOL_NAME = "list_async_tasks"
GEMINI_RETRIEVE_MEMORIES_TOOL_NAME = "retrieve_memories"
GEMINI_DOGFOOD_TOOL_RESPONSE_ACTION = "gemini_tool_response"
GEMINI_INVALID_EMIT_ARTIFACT_ARGUMENTS = (
    "Invalid emit_artifact arguments. Provide required string fields and retry."
)
GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES = frozenset(
    {
        GEMINI_EMIT_ARTIFACT_TOOL_NAME,
        GEMINI_START_BUILDER_TASK_TOOL_NAME,
        GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
        GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
        GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME,
        GEMINI_LIST_ASYNC_TASKS_TOOL_NAME,
        GEMINI_RETRIEVE_MEMORIES_TOOL_NAME,
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

logger = logging.getLogger(__name__)


class GeminiDogfoodToolError(ValueError):
    """Raised when a Gemini dogfood tool call cannot be executed safely."""


class GeminiBuilderTaskNotTrackedError(GeminiDogfoodToolError):
    """Raised when a lifecycle call references no task in the trusted session."""

    def __init__(self, task_id: str, tracked_task_ids: list[str]) -> None:
        self.task_id = task_id
        self.tracked_task_ids = tracked_task_ids
        super().__init__(
            f"No tracked task exists for task_id {task_id!r} in this trusted Gemini dogfood session."
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

    def diagnostic(self) -> dict[str, Any]:
        if self.call.name == GEMINI_RETRIEVE_MEMORIES_TOOL_NAME:
            return _retrieve_memories_execution_diagnostic(self)

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
        self._langgraph_url = (langgraph_url or os.getenv("LANGGRAPH_URL") or DEFAULT_LANGGRAPH_URL).rstrip("/")
        self._timeout_seconds = timeout_seconds

    async def execute(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
    ) -> GeminiBuilderLifecycleResult:
        validated = validate_builder_lifecycle_tool_args(tool_name, args)
        if tool_name == GEMINI_START_BUILDER_TASK_TOOL_NAME:
            return await self._start_builder_task(
                validated,
                session_id=session_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
                async_tasks=async_tasks,
            )
        if tool_name == GEMINI_CHECK_ASYNC_TASK_TOOL_NAME:
            return await self._check_async_task(validated, async_tasks=async_tasks)
        if tool_name == GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME:
            return await self._update_async_task(validated, async_tasks=async_tasks)
        if tool_name == GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME:
            return await self._cancel_async_task(validated, async_tasks=async_tasks)
        if tool_name == GEMINI_LIST_ASYNC_TASKS_TOOL_NAME:
            return await self._list_async_tasks(validated, async_tasks=async_tasks)
        raise GeminiDogfoodToolError(f"Unsupported builder lifecycle tool {tool_name!r}.")

    async def _start_builder_task(
        self,
        args: Mapping[str, Any],
        *,
        session_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
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
        contract = builder_lifecycle_contract()

        thread = await self._request_json("POST", "/threads", json_body={})
        thread_id = _required_string(thread.get("thread_id"), "LangGraph thread response omitted thread_id.")
        now = _utcnow_iso()
        delegation_context = {
            "task": description,
            "task_brief": description,
            "normalized_brief": description,
            "task_type": task_type,
            "source": "gemini_live_dogfood_start_builder_task",
            "parent_thread_id": session_id,
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
        }
        run = await self._request_json(
            "POST",
            f"/threads/{thread_id}/runs",
            json_body={
                "assistant_id": contract.ASYNC_BUILDER_AGENT_NAME,
                "input": run_input,
                "config": {
                    "configurable": {
                        "thread_id": thread_id,
                        "user_id": user_id,
                        "parent_thread_id": session_id,
                    }
                },
            },
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
            "demo_mode": False,
            "trace_id": f"gemini-{thread_id[:8]}",
        }
        response = {
            "ok": True,
            "tool": GEMINI_START_BUILDER_TASK_TOOL_NAME,
            "started": True,
            "task_id": thread_id,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": "running",
            "task_type": task_type,
            "async_task": async_task,
            "trusted_user_id": user_id,
            "tool_arg_user_id_ignored": bool(args.get("user_id") and args.get("user_id") != user_id),
            "runtime": runtime_mode.value,
            "provider": provider,
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

    async def _check_async_task(
        self,
        args: Mapping[str, Any],
        *,
        async_tasks: Mapping[str, dict[str, Any]],
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        run = await self._request_json("GET", f"/threads/{task['thread_id']}/runs/{task['run_id']}")
        status = _required_string(run.get("status"), "LangGraph run response omitted status.")
        result = await self._check_result_for_status(run, task)
        updated_task = _updated_task(task, status=status, checked=True)
        response = {
            "ok": True,
            "tool": GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
            "task_id": task["task_id"],
            "thread_id": task["thread_id"],
            "run_id": task["run_id"],
            "status": status,
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
        async_tasks: Mapping[str, dict[str, Any]],
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        run = await self._request_json(
            "POST",
            f"/threads/{task['thread_id']}/runs",
            json_body={
                "assistant_id": task.get("agent_name") or builder_lifecycle_contract().ASYNC_BUILDER_AGENT_NAME,
                "input": {"messages": [{"role": "user", "content": str(args["message"])}]},
                "multitask_strategy": "interrupt",
            },
        )
        run_id = _required_string(run.get("run_id"), "LangGraph update run response omitted run_id.")
        updated_task = _updated_task(task, status="running", run_id=run_id, updated=True)
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
    ) -> GeminiBuilderLifecycleResult:
        task = _tracked_task(str(args["task_id"]), async_tasks)
        await self._request_json(
            "POST",
            f"/threads/{task['thread_id']}/runs/{task['run_id']}/cancel",
            json_body=None,
            params={"wait": 0, "action": "interrupt"},
            allow_empty=True,
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
    ) -> GeminiBuilderLifecycleResult:
        status_filter = args.get("status_filter") or "all"
        tasks = [dict(task) for task in async_tasks.values() if isinstance(task, Mapping)]
        if status_filter != "all":
            tasks = [task for task in tasks if task.get("status") == status_filter]
        updated_tasks: dict[str, dict[str, Any]] = {}
        summaries: list[dict[str, Any]] = []
        for task in tasks:
            status = str(task.get("status") or "unknown")
            if status not in builder_lifecycle_contract().TERMINAL_TASK_STATUSES:
                try:
                    run = await self._request_json("GET", f"/threads/{task['thread_id']}/runs/{task['run_id']}")
                    status = _required_string(run.get("status"), "LangGraph run response omitted status.")
                    task = _updated_task(task, status=status, checked=True)
                except GeminiDogfoodToolError:
                    pass
            updated_tasks[str(task["task_id"])] = task
            summaries.append(
                {
                    "task_id": task.get("task_id"),
                    "agent_name": task.get("agent_name"),
                    "status": status,
                    "task_type": task.get("task_type"),
                }
            )
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

    async def _check_result_for_status(self, run: Mapping[str, Any], task: Mapping[str, Any]) -> dict[str, Any]:
        status = str(run.get("status") or "unknown")
        result: dict[str, Any] = {"status": status, "thread_id": task["thread_id"]}
        if status == "success":
            state = await self._request_json("GET", f"/threads/{task['thread_id']}/state", params={"subgraphs": False})
            values = _record_value(state.get("values")) or {}
            messages = values.get("messages") if isinstance(values, Mapping) else None
            if isinstance(messages, list) and messages:
                last = messages[-1]
                result["result"] = last.get("content", "") if isinstance(last, Mapping) else str(last)
            else:
                result["result"] = "(completed with no output messages)"
            builder_result = values.get("builder_result") if isinstance(values, Mapping) else None
            if isinstance(builder_result, Mapping):
                result["builder_result"] = dict(builder_result)
        elif status == "error":
            error_detail = run.get("error")
            result["error"] = str(error_detail) if error_detail else "The async builder encountered an error."
        return result

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, Any] | None = None,
        allow_empty: bool = False,
    ) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self._langgraph_url}{path}",
                    json=json_body,
                    params=params,
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
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]] | None = None,
        context_mode: str | None = None,
        memory_retrieval_config: Mapping[str, Any] | None = None,
    ) -> GeminiDogfoodToolExecution:
        if call.name not in GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES:
            allowed = ", ".join(sorted(GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES))
            raise GeminiDogfoodToolError(
                f"Gemini Live requested unsupported Sophia tool {call.name!r}. Approved existing tools: {allowed}."
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

        try:
            validated_args = validate_builder_lifecycle_tool_args(call.name, call.args)
            lifecycle_result = await self._builder_lifecycle_backend.execute(
                call.name,
                validated_args,
                session_id=session_id,
                user_id=user_id,
                runtime_mode=runtime_mode,
                provider=provider,
                async_tasks=dict(async_tasks or {}),
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

        return GeminiDogfoodToolExecution(
            call=call,
            response=lifecycle_result.response,
            result_summary=lifecycle_result.result_summary,
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
        }
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
    task = async_tasks.get(task_id.strip())
    if not isinstance(task, Mapping):
        tracked_task_ids = sorted(str(known_task_id) for known_task_id in async_tasks if str(known_task_id).strip())
        raise GeminiBuilderTaskNotTrackedError(task_id, tracked_task_ids)
    return dict(task)


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
        "No tracked task exists for that task_id in this trusted session. Do not invent task ids. "
        "For a new build/create/generate/research request, call start_builder_task first. "
        "If the user is asking about an existing task and you lost the identifier, call list_async_tasks."
    )
    response = {
        "ok": False,
        "tool": call.name,
        "rejected": True,
        "error_type": "unknown_task_id",
        "error_message": str(exc),
        "task_id": exc.task_id,
        "status": "rejected",
        "tracked_task_ids": exc.tracked_task_ids,
        "recovery_guidance": guidance,
        "session_id": session_id,
        "user_id": user_id,
        "runtime": runtime_mode.value,
        "provider": provider,
        "result_summary": f"Lifecycle tool rejected: no tracked task exists for task_id {exc.task_id!r}.",
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
        error = result.get("error") if isinstance(result, Mapping) else None
        return f"Builder task {task_id} ended with {status}: {error or 'no detail provided'}."
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
