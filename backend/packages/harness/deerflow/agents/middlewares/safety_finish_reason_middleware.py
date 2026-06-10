"""Suppress tool calls from provider safety-terminated model responses."""

from __future__ import annotations

import logging
from typing import Any, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

_SAFETY_VALUES = {
    "content_filter",
    "safety",
    "safety_stop",
    "blocked",
    "refusal",
    "prohibited_content",
}


def _lower_str(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and value else None


def _safety_finish_reason(message: AIMessage) -> tuple[str, str] | None:
    response_metadata = getattr(message, "response_metadata", None) or {}
    additional_kwargs = getattr(message, "additional_kwargs", None) or {}
    candidates = {
        "finish_reason": response_metadata.get("finish_reason") or additional_kwargs.get("finish_reason"),
        "stop_reason": response_metadata.get("stop_reason") or additional_kwargs.get("stop_reason"),
        "block_reason": response_metadata.get("block_reason") or additional_kwargs.get("block_reason"),
    }
    for field, value in candidates.items():
        lowered = _lower_str(value)
        if lowered in _SAFETY_VALUES:
            return field, str(value)
    return None


def _append_text(content: object, text: str) -> str | list:
    if isinstance(content, list):
        return [*content, {"type": "text", "text": f"\n\n{text}"}]
    if isinstance(content, str) and content:
        return f"{content}\n\n{text}"
    return text


class SafetyFinishReasonMiddleware(AgentMiddleware[AgentState]):
    """Strip tool calls when a provider safety signal may have truncated args."""

    @staticmethod
    def _apply(state: AgentState, runtime: Runtime) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None
        last_msg = messages[-1]
        if not isinstance(last_msg, AIMessage) or not getattr(last_msg, "tool_calls", None):
            return None
        reason = _safety_finish_reason(last_msg)
        if reason is None:
            return None
        field, value = reason
        suppressed_names = [call.get("name") or "unknown" for call in last_msg.tool_calls or []]
        logger.warning(
            "Safety finish reason suppressed tool calls field=%s value=%s tools=%s",
            field,
            value,
            suppressed_names,
        )
        additional_kwargs = dict(last_msg.additional_kwargs or {})
        additional_kwargs.pop("tool_calls", None)
        additional_kwargs.pop("function_call", None)
        additional_kwargs["safety_termination"] = {
            "reason_field": field,
            "reason_value": value,
            "suppressed_tool_call_names": suppressed_names,
        }
        content = _append_text(
            last_msg.content,
            (
                "The model provider stopped this response with a safety signal, "
                "so any tool calls from that turn were suppressed."
            ),
        )
        return {
            "messages": [
                last_msg.model_copy(
                    update={
                        "content": content,
                        "tool_calls": [],
                        "additional_kwargs": additional_kwargs,
                    }
                )
            ]
        }

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

