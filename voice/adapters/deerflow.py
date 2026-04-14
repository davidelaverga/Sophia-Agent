from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator

import httpx

from voice.adapters.base import (
    BackendAdapter,
    BackendEvent,
    BackendRequest,
    BackendStageError,
)
from voice.config import VoiceSettings


logger = logging.getLogger(__name__)

_DEERFLOW_WARMUP_USER_ID = "__voice_warmup__"
_DEERFLOW_WARMUP_TEXT = "Warmup ping. Reply with a short acknowledgment."
_DEERFLOW_STREAM_MODE = ["messages-tuple", "values"]
_DEERFLOW_ON_DISCONNECT = "cancel"
_DEERFLOW_MULTITASK_STRATEGY = "rollback"


class DeerFlowBackendAdapter(BackendAdapter):
    mode = "deerflow"

    def __init__(
        self,
        settings: VoiceSettings,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self._owns_client = client is None
        self._http = client or httpx.AsyncClient(
            base_url=settings.langgraph_base_url,
            timeout=httpx.Timeout(
                connect=settings.readiness_timeout_seconds,
                read=settings.backend_timeout_seconds,
                write=settings.readiness_timeout_seconds,
                pool=settings.readiness_timeout_seconds,
            ),
        )
        self._thread_ids: dict[str, str] = {}
        self._thread_lock = asyncio.Lock()

    async def close(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def probe(self) -> None:
        try:
            response = await self._http.post(
                "/assistants/search",
                json={"graph_id": self.settings.assistant_id, "limit": 1},
                timeout=self.settings.readiness_timeout_seconds,
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise BackendStageError(
                "backend-ready",
                "Timed out while checking DeerFlow readiness.",
                original=exc,
            ) from exc
        except httpx.HTTPError as exc:
            raise BackendStageError(
                "backend-ready",
                "Unable to reach the DeerFlow server for readiness checks.",
                original=exc,
            ) from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise BackendStageError(
                "backend-ready",
                "DeerFlow readiness response was not valid JSON.",
                recoverable=False,
                original=exc,
            ) from exc

        assistant_ids = {
            item.get("graph_id")
            for item in payload
            if isinstance(item, dict) and item.get("graph_id")
        }
        if not assistant_ids:
            raise BackendStageError(
                "backend-ready",
                f"Assistant {self.settings.assistant_id!r} was not found in DeerFlow.",
                recoverable=False,
            )

    async def stream_events(
        self,
        request: BackendRequest,
    ) -> AsyncIterator[BackendEvent]:
        adapter_started = time.perf_counter()
        thread_id = request.thread_id or await self._get_or_create_thread(request.user_id)
        payload = self._build_run_payload(
            text=request.text,
            user_id=request.user_id,
            platform=request.platform,
            ritual=request.ritual,
            context_mode=request.context_mode,
            thread_id=thread_id,
        )

        logger.info(
            "[VOICE:LLM] DEERFLOW_CALL | url=/threads/%s/runs/stream | "
            "assistant_id=%s | user_id=%s | platform=%s | ritual=%s",
            thread_id, self.settings.assistant_id, request.user_id,
            request.platform, request.ritual,
        )

        try:
            async with self._http.stream(
                "POST",
                f"/threads/{thread_id}/runs/stream",
                json=payload,
                timeout=self.settings.backend_timeout_seconds,
            ) as response:
                response.raise_for_status()
                logger.info(
                    "voice.metric metric=deerflow_stream_open_ms user_id=%s value=%.2f thread_id=%s",
                    request.user_id,
                    (time.perf_counter() - adapter_started) * 1000,
                    thread_id,
                )

                # Track SSE event type and accumulate tool call JSON.
                current_event_type = ""
                # Map tool_use id -> {"name": str, "json_parts": list[str]}
                active_tool_calls: dict[str, dict] = {}
                saw_artifact_tool = False
                streamed_artifact: dict[str, object] | None = None
                initial_values_artifact: dict[str, object] | None = None
                first_backend_event_logged = False

                async for line in response.aiter_lines():
                    line = line.strip()

                    # SSE event type line
                    if line.startswith("event:"):
                        current_event_type = line[6:].strip()
                        continue

                    if not line.startswith("data:"):
                        continue

                    raw_data = line[5:].strip()
                    if not raw_data or raw_data == "[DONE]":
                        continue

                    try:
                        data = json.loads(raw_data)
                    except json.JSONDecodeError:
                        yield BackendEvent.error_event(
                            "backend-contract",
                            "Received invalid JSON from the DeerFlow SSE stream.",
                            recoverable=False,
                        )
                        return

                    if not first_backend_event_logged:
                        first_backend_event_logged = True
                        logger.info(
                            "voice.metric metric=deerflow_first_event_ms user_id=%s value=%.2f sse_event=%s",
                            request.user_id,
                            (time.perf_counter() - adapter_started) * 1000,
                            current_event_type or "message",
                        )

                    # Handle error events (SSE event line or data-level)
                    if current_event_type == "error":
                        yield BackendEvent.error_event(
                            "backend-stream",
                            str(data.get("message") if isinstance(data, dict) else data),
                        )
                        return

                    if (
                        isinstance(data, dict)
                        and data.get("type") in ("run_error", "error")
                    ):
                        yield BackendEvent.error_event(
                            "backend-stream",
                            str(data.get("data", data.get("message", str(data)))),
                        )
                        return

                    if current_event_type == "values":
                        values_artifact = self._extract_values_artifact(data)
                        if values_artifact is None:
                            continue

                        if initial_values_artifact is None:
                            initial_values_artifact = values_artifact

                        if (
                            saw_artifact_tool
                            or values_artifact != initial_values_artifact
                        ):
                            logger.info(
                                "voice.artifact source=values streamed_present=%s streamed_matches=%s early=true",
                                streamed_artifact is not None,
                                streamed_artifact == values_artifact,
                            )
                            yield BackendEvent.artifact_payload(values_artifact)
                            return
                        continue

                    # HTTP SSE uses `event: messages` for messages-tuple frames.
                    if current_event_type not in ("messages", "messages-tuple"):
                        continue

                    # data is [msg_dict, metadata_dict]
                    if not isinstance(data, list) or len(data) < 1:
                        continue

                    msg = data[0]
                    if not isinstance(msg, dict):
                        continue

                    msg_type = msg.get("type", "")

                    if msg_type in (
                        "AIMessageChunk",
                        "AIMessage",
                        "ai",
                        "assistant",
                    ):
                        content = msg.get("content", [])
                        if isinstance(content, str) and content:
                            yield BackendEvent.text_chunk(content)
                        elif isinstance(content, list):
                            for block in content:
                                if not isinstance(block, dict):
                                    continue
                                block_type = block.get("type", "")
                                if block_type == "text":
                                    text = block.get("text", "")
                                    if text:
                                        yield BackendEvent.text_chunk(text)
                                elif block_type == "tool_use":
                                    tool_id = block.get("id", "")
                                    tool_name = block.get("name", "")
                                    if tool_name == "emit_artifact":
                                        saw_artifact_tool = True
                                    if tool_id:
                                        active_tool_calls[tool_id] = {
                                            "name": tool_name,
                                            "json_parts": [],
                                        }
                                elif block_type == "input_json_delta":
                                    partial = block.get("partial_json", "")
                                    if partial:
                                        for tc in reversed(
                                            list(active_tool_calls.values())
                                        ):
                                            tc["json_parts"].append(partial)
                                            break

                        tool_call_artifact = self._extract_tool_call_artifact(
                            msg.get("tool_calls")
                        )
                        if tool_call_artifact is not None:
                            streamed_artifact = tool_call_artifact
                            saw_artifact_tool = True
                        elif self._has_emit_artifact_tool_call(msg.get("tool_calls")):
                            saw_artifact_tool = True

                    elif msg_type == "tool":
                        tool_name = msg.get("name", "")
                        if tool_name == "emit_artifact":
                            saw_artifact_tool = True
                            artifact = self._parse_accumulated_artifact(
                                active_tool_calls,
                            )
                            if artifact is not None:
                                streamed_artifact = artifact

                artifact = streamed_artifact
                if artifact is not None:
                    logger.info("voice.artifact source=streamed fallback=true")
                    yield BackendEvent.artifact_payload(artifact)
                elif saw_artifact_tool:
                    logger.error(
                        "voice.artifact source=missing status=contract_error"
                    )
                    yield BackendEvent.error_event(
                        "backend-contract",
                        "emit_artifact tool call produced no parseable artifact.",
                        recoverable=False,
                    )
                    return

        except httpx.TimeoutException as exc:
            self._thread_ids.pop(request.user_id, None)
            logger.error(
                "[VOICE:LLM] DEERFLOW_ERROR | error=timeout | user_id=%s | thread_id=%s",
                request.user_id, thread_id,
            )
            raise BackendStageError(
                "backend-timeout",
                "Timed out while streaming a DeerFlow response.",
                original=exc,
            ) from exc
        except httpx.HTTPStatusError as exc:
            self._thread_ids.pop(request.user_id, None)
            logger.error(
                "[VOICE:LLM] DEERFLOW_ERROR | status_code=%s | user_id=%s | thread_id=%s",
                exc.response.status_code, request.user_id, thread_id,
            )
            raise BackendStageError(
                "backend-request",
                f"DeerFlow responded with HTTP {exc.response.status_code}.",
                original=exc,
            ) from exc
        except httpx.HTTPError as exc:
            self._thread_ids.pop(request.user_id, None)
            logger.error(
                "[VOICE:LLM] DEERFLOW_ERROR | error=%s | user_id=%s | thread_id=%s",
                str(exc), request.user_id, thread_id,
            )
            raise BackendStageError(
                "backend-request",
                "Failed to contact the DeerFlow backend.",
                original=exc,
            ) from exc

    async def warmup(self, request: BackendRequest) -> None:
        warmup_started = time.perf_counter()

        if request.thread_id is None:
            await self._get_or_create_thread(request.user_id)

        warmup_thread_id = await self._create_thread()
        payload = self._build_run_payload(
            text=_DEERFLOW_WARMUP_TEXT,
            user_id=_DEERFLOW_WARMUP_USER_ID,
            platform=request.platform,
            ritual=request.ritual,
            context_mode=request.context_mode,
            thread_id=warmup_thread_id,
        )

        logger.info(
            "[VOICE:LLM] DEERFLOW_WARMUP_START | warmup_thread_id=%s | platform=%s | ritual=%s | context_mode=%s",
            warmup_thread_id,
            request.platform,
            request.ritual,
            request.context_mode,
        )

        try:
            async with self._http.stream(
                "POST",
                f"/threads/{warmup_thread_id}/runs/stream",
                json=payload,
                timeout=self.settings.backend_timeout_seconds,
            ) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue

                    raw_data = line[5:].strip()
                    if not raw_data or raw_data == "[DONE]":
                        continue

                    try:
                        data = json.loads(raw_data)
                    except json.JSONDecodeError:
                        continue

                    if isinstance(data, dict) and data.get("type") in {"run_error", "error"}:
                        message = str(data.get("data", data.get("message", "warmup_error")))
                        raise BackendStageError(
                            "backend-warmup",
                            f"DeerFlow warmup returned an error event: {message}",
                        )

                    if isinstance(data, list) and data:
                        logger.info(
                            "voice.metric metric=deerflow_warmup_ms user_id=%s value=%.2f result=streamed",
                            request.user_id,
                            (time.perf_counter() - warmup_started) * 1000,
                        )
                        return

                    if self._extract_values_artifact(data) is not None:
                        logger.info(
                            "voice.metric metric=deerflow_warmup_ms user_id=%s value=%.2f result=artifact",
                            request.user_id,
                            (time.perf_counter() - warmup_started) * 1000,
                        )
                        return

                logger.info(
                    "voice.metric metric=deerflow_warmup_ms user_id=%s value=%.2f result=empty",
                    request.user_id,
                    (time.perf_counter() - warmup_started) * 1000,
                )
        except httpx.TimeoutException as exc:
            raise BackendStageError(
                "backend-warmup",
                "Timed out while warming the DeerFlow backend.",
                original=exc,
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise BackendStageError(
                "backend-warmup",
                f"DeerFlow warmup responded with HTTP {exc.response.status_code}.",
                original=exc,
            ) from exc
        except httpx.HTTPError as exc:
            raise BackendStageError(
                "backend-warmup",
                "Failed to contact the DeerFlow backend for warmup.",
                original=exc,
            ) from exc

    async def _get_or_create_thread(self, user_id: str) -> str:
        existing = self._thread_ids.get(user_id)
        if existing:
            return existing

        async with self._thread_lock:
            existing = self._thread_ids.get(user_id)
            if existing:
                return existing

            thread_id = await self._create_thread()
            self._thread_ids[user_id] = thread_id
            return thread_id

    async def _create_thread(self) -> str:
        try:
            response = await self._http.post(
                "/threads",
                json={},
                timeout=self.settings.readiness_timeout_seconds,
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise BackendStageError(
                "backend-request",
                "Timed out while creating a DeerFlow thread.",
                original=exc,
            ) from exc
        except httpx.HTTPError as exc:
            raise BackendStageError(
                "backend-request",
                "Failed to create a DeerFlow thread.",
                original=exc,
            ) from exc

        return response.json()["thread_id"]

    def _build_run_payload(
        self,
        *,
        text: str,
        user_id: str,
        platform: str,
        ritual: str | None,
        context_mode: str,
        thread_id: str,
    ) -> dict[str, object]:
        return {
            "assistant_id": self.settings.assistant_id,
            "input": {"messages": [{"role": "user", "content": text}]},
            "config": {
                "recursion_limit": 150,
                "configurable": {
                    "user_id": user_id,
                    "platform": platform,
                    "ritual": ritual,
                    "context_mode": context_mode,
                    "thread_id": thread_id,
                },
            },
            "stream_mode": list(_DEERFLOW_STREAM_MODE),
            "on_disconnect": _DEERFLOW_ON_DISCONNECT,
            "multitask_strategy": _DEERFLOW_MULTITASK_STRATEGY,
        }

    def _parse_accumulated_artifact(
        self, tool_calls: dict[str, dict],
    ) -> dict[str, object] | None:
        """Parse the emit_artifact tool input from accumulated JSON fragments."""
        for tc in tool_calls.values():
            if tc["name"] != "emit_artifact":
                continue
            raw = "".join(tc["json_parts"])
            if not raw.strip():
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
        return None

    def _extract_tool_call_artifact(
        self,
        tool_calls: object,
    ) -> dict[str, object] | None:
        if not isinstance(tool_calls, list):
            return None

        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            if tool_call.get("name") != "emit_artifact":
                continue
            args = tool_call.get("args")
            if isinstance(args, dict) and args:
                return dict(args)

        return None

    def _has_emit_artifact_tool_call(self, tool_calls: object) -> bool:
        if not isinstance(tool_calls, list):
            return False

        return any(
            isinstance(tool_call, dict)
            and tool_call.get("name") == "emit_artifact"
            for tool_call in tool_calls
        )

    def _extract_values_artifact(
        self,
        data: object,
    ) -> dict[str, object] | None:
        if not isinstance(data, dict):
            return None

        artifact = data.get("current_artifact")
        if isinstance(artifact, dict) and artifact:
            return dict(artifact)

        values = data.get("values")
        if not isinstance(values, dict):
            return None

        artifact = values.get("current_artifact")
        if isinstance(artifact, dict) and artifact:
            return dict(artifact)

        return None