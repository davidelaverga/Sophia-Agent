"""LLM error handling middleware with lightweight retries and fallbacks."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage
from langgraph.errors import GraphBubbleUp

logger = logging.getLogger(__name__)

_RETRIABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_QUOTA_PATTERNS = ("insufficient_quota", "quota", "billing", "credit", "payment")
_AUTH_PATTERNS = ("authentication", "unauthorized", "invalid api key", "invalid_api_key", "forbidden")
_BUSY_PATTERNS = ("server busy", "temporarily unavailable", "try again", "overloaded", "rate limit")


class LLMErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Retry transient model errors and surface user-facing fallback messages."""

    def __init__(self, *, retry_max_attempts: int = 2, retry_base_delay_ms: int = 500) -> None:
        super().__init__()
        self.retry_max_attempts = max(1, retry_max_attempts)
        self.retry_base_delay_ms = max(0, retry_base_delay_ms)

    @staticmethod
    def _detail(exc: BaseException) -> str:
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message.strip():
                    return message.strip()
        return str(exc).strip() or exc.__class__.__name__

    @staticmethod
    def _status_code(exc: BaseException) -> int | None:
        for attr in ("status_code", "status"):
            value = getattr(exc, attr, None)
            if isinstance(value, int):
                return value
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        return status if isinstance(status, int) else None

    @classmethod
    def _classify(cls, exc: BaseException) -> tuple[bool, str]:
        detail = cls._detail(exc).lower()
        status = cls._status_code(exc)
        if any(pattern in detail for pattern in _QUOTA_PATTERNS):
            return False, "quota"
        if any(pattern in detail for pattern in _AUTH_PATTERNS):
            return False, "auth"
        if status in _RETRIABLE_STATUS_CODES:
            return True, "transient"
        if any(pattern in detail for pattern in _BUSY_PATTERNS):
            return True, "busy"
        if exc.__class__.__name__ in {"APITimeoutError", "APIConnectionError", "ReadError", "RemoteProtocolError"}:
            return True, "transient"
        return False, "generic"

    @classmethod
    def _fallback_message(cls, exc: BaseException, reason: str) -> AIMessage:
        if reason == "quota":
            content = (
                "The configured model provider rejected this request because the account is "
                "out of quota, billing is unavailable, or usage is restricted. Please fix "
                "the provider account and try again."
            )
        elif reason == "auth":
            content = (
                "The configured model provider rejected this request because authentication "
                "or access is invalid. Please check the provider credentials and try again."
            )
        elif reason in {"busy", "transient"}:
            content = "The configured model provider is temporarily unavailable. Please wait a moment and continue."
        else:
            content = f"LLM request failed: {cls._detail(exc)}"
        return AIMessage(
            content=content,
            additional_kwargs={
                "deerflow_error_fallback": True,
                "error_type": exc.__class__.__name__,
                "error_reason": reason,
                "error_detail": cls._detail(exc)[:500],
            },
        )

    def _retry_delay_seconds(self, attempt: int) -> float:
        return min(8.0, (self.retry_base_delay_ms / 1000.0) * (2 ** max(0, attempt - 1)))

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        attempt = 1
        while True:
            try:
                return handler(request)
            except GraphBubbleUp:
                raise
            except Exception as exc:  # noqa: BLE001 - provider SDKs raise many shapes.
                retriable, reason = self._classify(exc)
                if retriable and attempt < self.retry_max_attempts:
                    delay = self._retry_delay_seconds(attempt)
                    logger.warning("Transient LLM error; retrying in %.2fs: %s", delay, self._detail(exc))
                    time.sleep(delay)
                    attempt += 1
                    continue
                logger.warning("LLM call failed reason=%s detail=%s", reason, self._detail(exc), exc_info=exc)
                return self._fallback_message(exc, reason)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        attempt = 1
        while True:
            try:
                return await handler(request)
            except GraphBubbleUp:
                raise
            except Exception as exc:  # noqa: BLE001 - provider SDKs raise many shapes.
                retriable, reason = self._classify(exc)
                if retriable and attempt < self.retry_max_attempts:
                    delay = self._retry_delay_seconds(attempt)
                    logger.warning("Transient LLM error; retrying in %.2fs: %s", delay, self._detail(exc))
                    await asyncio.sleep(delay)
                    attempt += 1
                    continue
                logger.warning("LLM call failed reason=%s detail=%s", reason, self._detail(exc), exc_info=exc)
                return self._fallback_message(exc, reason)
