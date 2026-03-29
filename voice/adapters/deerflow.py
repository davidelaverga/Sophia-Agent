from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterable

import httpx

from voice.adapters.base import (
    BackendAdapter,
    BackendEvent,
    BackendRequest,
    BackendStageError,
)
from voice.config import VoiceSettings


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
            response = await self._http.get(
                "/assistants",
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
            item.get("assistant_id")
            for item in payload
            if isinstance(item, dict) and item.get("assistant_id")
        }
        if assistant_ids and self.settings.assistant_id not in assistant_ids:
            raise BackendStageError(
                "backend-ready",
                f"Assistant {self.settings.assistant_id!r} was not found in DeerFlow.",
                recoverable=False,
            )

    async def stream_events(
        self,
        request: BackendRequest,
    ) -> AsyncIterator[BackendEvent]:
        thread_id = await self._get_or_create_thread(request.user_id)
        payload = {
            "assistant_id": self.settings.assistant_id,
            "input": {"messages": [{"role": "user", "content": request.text}]},
            "config": {
                "configurable": {
                    "user_id": request.user_id,
                    "platform": request.platform,
                    "ritual": request.ritual,
                    "context_mode": request.context_mode,
                }
            },
        }

        try:
            async with self._http.stream(
                "POST",
                f"/threads/{thread_id}/runs/stream",
                json=payload,
                timeout=self.settings.backend_timeout_seconds,
            ) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue

                    raw_event = line[6:].strip()
                    if not raw_event or raw_event == "[DONE]":
                        continue

                    try:
                        event = json.loads(raw_event)
                    except json.JSONDecodeError:
                        yield BackendEvent.error_event(
                            "backend-contract",
                            "Received invalid JSON from the DeerFlow SSE stream.",
                            recoverable=False,
                        )
                        return

                    if event.get("type") in {"error", "run_error"}:
                        yield BackendEvent.error_event(
                            "backend-stream",
                            str(event.get("data") or event),
                        )
                        return

                    chunk = self._extract_ai_chunk(event)
                    if chunk:
                        yield BackendEvent.text_chunk(chunk)

                    artifact = self._extract_artifact(event)
                    if artifact is not None:
                        yield BackendEvent.artifact_payload(artifact)
        except httpx.TimeoutException as exc:
            self._thread_ids.pop(request.user_id, None)
            raise BackendStageError(
                "backend-timeout",
                "Timed out while streaming a DeerFlow response.",
                original=exc,
            ) from exc
        except httpx.HTTPStatusError as exc:
            self._thread_ids.pop(request.user_id, None)
            raise BackendStageError(
                "backend-request",
                f"DeerFlow responded with HTTP {exc.response.status_code}.",
                original=exc,
            ) from exc
        except httpx.HTTPError as exc:
            self._thread_ids.pop(request.user_id, None)
            raise BackendStageError(
                "backend-request",
                "Failed to contact the DeerFlow backend.",
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

            thread_id = response.json()["thread_id"]
            self._thread_ids[user_id] = thread_id
            return thread_id

    def _extract_ai_chunk(self, event: dict[str, object]) -> str:
        if event.get("type") != "messages-tuple":
            return ""

        data = self._normalize_tuple_data(event.get("data"))
        if not isinstance(data, dict):
            return ""

        if data.get("type") not in {"ai", "assistant"}:
            return ""

        content = data.get("content", "")
        if isinstance(content, str):
            return content

        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
            return "".join(parts)

        return ""

    def _extract_artifact(self, event: dict[str, object]) -> dict[str, object] | None:
        if event.get("type") != "messages-tuple":
            return None

        data = self._normalize_tuple_data(event.get("data"))
        if not isinstance(data, dict):
            return None

        if data.get("type") != "tool" or data.get("name") != "emit_artifact":
            return None

        content = data.get("content")
        if isinstance(content, dict):
            return content
        if isinstance(content, str) and content.strip():
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                return None
            if isinstance(parsed, dict):
                return parsed
        return None

    def _normalize_tuple_data(self, data: object) -> object:
        if isinstance(data, dict):
            return data

        if isinstance(data, Iterable) and not isinstance(data, (str, bytes)):
            parts = list(data)
            if len(parts) == 2 and isinstance(parts[1], dict):
                return parts[1]

        return data