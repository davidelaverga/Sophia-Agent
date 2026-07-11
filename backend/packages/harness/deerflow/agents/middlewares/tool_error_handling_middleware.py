"""Tool error handling middleware and shared runtime middleware builders."""

import logging
from collections.abc import Awaitable, Callable
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

logger = logging.getLogger(__name__)

_MISSING_TOOL_CALL_ID = "missing_tool_call_id"
_MAX_VALIDATION_ERRORS = 5
_MAX_VALIDATION_SUMMARY_CHARS = 500


def _validation_location(value: object) -> str:
    parts: list[str] = []
    for segment in value if isinstance(value, (list, tuple)) else ():
        if isinstance(segment, int):
            if parts:
                parts[-1] = f"{parts[-1]}[{segment}]"
            else:
                parts.append(f"[{segment}]")
        else:
            parts.append(str(segment))
    return ".".join(parts) or "arguments"


def _validation_error_summary(exc: Exception) -> str | None:
    errors_method = getattr(exc, "errors", None)
    if not callable(errors_method):
        return None
    try:
        errors = errors_method(
            include_url=False,
            include_context=False,
            include_input=False,
        )
    except TypeError:
        return None
    except Exception:
        return None
    summaries = [f"{_validation_location(item.get('loc'))}: {str(item.get('msg') or 'invalid value')}" for item in errors[:_MAX_VALIDATION_ERRORS] if isinstance(item, dict)]
    if not summaries:
        return None
    return "; ".join(summaries)[:_MAX_VALIDATION_SUMMARY_CHARS]


class ToolErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Convert tool exceptions into error ToolMessages so the run can continue."""

    def _build_error_message(self, request: ToolCallRequest, exc: Exception) -> ToolMessage:
        tool_name = str(request.tool_call.get("name") or "unknown_tool")
        tool_call_id = str(request.tool_call.get("id") or _MISSING_TOOL_CALL_ID)
        detail = str(exc).strip() or exc.__class__.__name__
        if len(detail) > 500:
            detail = detail[:497] + "..."

        stage = "argument_validation" if exc.__class__.__name__ in {"ValidationError", "SchemaError"} else "tool_execution"
        validation_summary = _validation_error_summary(exc) if stage == "argument_validation" else None
        if tool_name == "prepare_deck_build":
            content = (
                "The authoritative deck build arguments failed typed validation." + (f" Validation summary: {validation_summary}" if validation_summary else "")
                if stage == "argument_validation"
                else "The authoritative deck build tool failed during execution."
            )
        else:
            content = f"Error: Tool '{tool_name}' failed with {exc.__class__.__name__}: {detail}. Continue with available context, or choose an alternative tool."
        return ToolMessage(
            content=content,
            tool_call_id=tool_call_id,
            name=tool_name,
            status="error",
            additional_kwargs={
                "tool_error": {
                    "error_class": exc.__class__.__name__,
                    "retryable": stage == "argument_validation",
                    "stage": stage,
                    **({"validation_summary": validation_summary} if validation_summary else {}),
                }
            },
        )

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        try:
            return handler(request)
        except GraphBubbleUp:
            # Preserve LangGraph control-flow signals (interrupt/pause/resume).
            raise
        except Exception as exc:
            logger.exception("Tool execution failed (sync): name=%s id=%s", request.tool_call.get("name"), request.tool_call.get("id"))
            return self._build_error_message(request, exc)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        try:
            return await handler(request)
        except GraphBubbleUp:
            # Preserve LangGraph control-flow signals (interrupt/pause/resume).
            raise
        except Exception as exc:
            logger.exception("Tool execution failed (async): name=%s id=%s", request.tool_call.get("name"), request.tool_call.get("id"))
            return self._build_error_message(request, exc)


def _build_runtime_middlewares(
    *,
    include_uploads: bool,
    include_dangling_tool_call_patch: bool,
    lazy_init: bool = True,
) -> list[AgentMiddleware]:
    """Build shared base middlewares for agent execution."""
    from deerflow.agents.middlewares.llm_error_handling_middleware import LLMErrorHandlingMiddleware
    from deerflow.agents.middlewares.safety_finish_reason_middleware import SafetyFinishReasonMiddleware
    from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
    from deerflow.sandbox.middleware import SandboxMiddleware

    middlewares: list[AgentMiddleware] = [
        ThreadDataMiddleware(lazy_init=lazy_init),
        SandboxMiddleware(lazy_init=lazy_init),
    ]

    if include_uploads:
        from deerflow.agents.middlewares.uploads_middleware import UploadsMiddleware

        middlewares.insert(1, UploadsMiddleware())

    if include_dangling_tool_call_patch:
        from deerflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware

        middlewares.append(DanglingToolCallMiddleware())

    middlewares.append(ToolErrorHandlingMiddleware())
    middlewares.append(LLMErrorHandlingMiddleware())
    middlewares.append(SafetyFinishReasonMiddleware())
    return middlewares


def build_lead_runtime_middlewares(*, lazy_init: bool = True) -> list[AgentMiddleware]:
    """Middlewares shared by lead agent runtime before lead-only middlewares."""
    return _build_runtime_middlewares(
        include_uploads=True,
        include_dangling_tool_call_patch=True,
        lazy_init=lazy_init,
    )


def build_subagent_runtime_middlewares(*, lazy_init: bool = True) -> list[AgentMiddleware]:
    """Middlewares shared by subagent runtime before subagent-only middlewares."""
    return _build_runtime_middlewares(
        include_uploads=False,
        include_dangling_tool_call_patch=False,
        lazy_init=lazy_init,
    )
