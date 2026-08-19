"""Manual LangSmith tracing for Sophia's browser-owned Gemini Live sessions.

The production Gemini route owns the provider WebSocket in the browser and
relays provider messages to this service.  That is deliberately different from
the Python-owned ``client.aio.live.connect`` flow supported by
``wrap_gemini_live``.  This module therefore builds the same trace shape with
the low-level RunTree API: one conversation root and one child for each
provider socket event, plus explicit tool and function-response spans.

Tracing is opt-in with ``SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING``.  All payloads
are compacted before they enter LangSmith; provider audio bytes are never
placed in inputs or outputs.  The single combined recording is attached to the
root after the browser closes the session.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)

try:  # Optional so legacy voice and local tests do not require LangSmith.
    from langsmith import Client
    from langsmith.run_trees import RunTree
    from langsmith.schemas import Attachment
except ImportError:  # pragma: no cover - exercised in slim local environments.
    Client = None  # type: ignore[assignment,misc]
    RunTree = None  # type: ignore[assignment,misc]
    Attachment = None  # type: ignore[assignment,misc]


MAX_TRACE_TEXT_CHARS = 400
MAX_TRACE_LIST_ITEMS = 24
MAX_TRACE_DEPTH = 8
MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def langsmith_gemini_live_enabled() -> bool:
    """Return whether manual Gemini Live tracing is configured and usable."""

    return bool(
        _env_bool("SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING", False)
        and os.getenv("LANGSMITH_API_KEY", "").strip()
        and Client is not None
        and RunTree is not None
        and Attachment is not None
    )


def uuid7() -> uuid.UUID:
    """Generate an RFC 9562 UUIDv7 without depending on private SDK helpers."""

    timestamp_ms = time.time_ns() // 1_000_000
    random_bits = int.from_bytes(os.urandom(10), "big")
    value = (timestamp_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (random_bits & ((1 << 12) - 1)) << 64
    value |= 0b10 << 62
    value |= (random_bits >> 12) & ((1 << 62) - 1)
    return uuid.UUID(int=value)


def _safe_text(value: str) -> str:
    if len(value) <= MAX_TRACE_TEXT_CHARS:
        return value
    return f"{value[:MAX_TRACE_TEXT_CHARS]}…"


def _safe_payload(value: Any, *, depth: int = 0, parent_key: str | None = None) -> Any:
    """Remove audio/base64 material and bound provider payload size."""

    if depth >= MAX_TRACE_DEPTH:
        return "<max_depth>"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"byte_length": len(value), "raw_audio_excluded": True}
    if isinstance(value, str):
        if parent_key in {"data", "inlineData", "inline_data"}:
            return {"byte_length": len(value), "raw_audio_excluded": True}
        return _safe_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_TRACE_LIST_ITEMS]:
            key_text = str(key)
            if key_text in {"data", "audio", "audio_bytes", "audioBase64", "audio_base64"}:
                if isinstance(item, (str, bytes, bytearray, memoryview)):
                    result[key_text] = {
                        "byte_length": len(item),
                        "raw_audio_excluded": True,
                    }
                else:
                    result[key_text] = "<audio_excluded>"
                continue
            result[key_text] = _safe_payload(item, depth=depth + 1, parent_key=key_text)
        if len(value) > MAX_TRACE_LIST_ITEMS:
            result["truncated_fields"] = len(value) - MAX_TRACE_LIST_ITEMS
        return result
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        result = [
            _safe_payload(item, depth=depth + 1, parent_key=parent_key)
            for item in items[:MAX_TRACE_LIST_ITEMS]
        ]
        if len(items) > MAX_TRACE_LIST_ITEMS:
            result.append({"truncated_items": len(items) - MAX_TRACE_LIST_ITEMS})
        return result
    return _safe_text(repr(value))


def _event_name(categories: list[str], event: Mapping[str, Any]) -> str:
    if "toolCallCancellation" in categories:
        return "interrupted"
    if "toolCall" in categories:
        return "function_call"
    if "inputTranscription" in categories:
        return "input_transcription"
    if "outputTranscription" in categories:
        return "output_transcription"
    if "error" in categories:
        return "error"
    if "serverContent" in categories:
        server_content = event.get("serverContent", event.get("server_content"))
        if isinstance(server_content, Mapping):
            if server_content.get("interrupted") is True:
                return "interrupted"
            if server_content.get("turnComplete", server_content.get("turn_complete")) is True:
                return "turn_complete"
        if "modelTurnAudio" in categories or "modelTurnText" in categories:
            return "model_response"
        return "server_content"
    return categories[0] if categories else "gemini_socket_event"


class GeminiLiveTraceRecorder:
    """Own a single LangSmith root and its manual Gemini Live child spans."""

    def __init__(
        self,
        *,
        session_id: str,
        user_id: str,
        model: str,
        thread_id: str | None = None,
        client: Any | None = None,
        enabled: bool | None = None,
    ) -> None:
        requested = langsmith_gemini_live_enabled() if enabled is None else enabled
        self.enabled = bool(
            requested
            and Client is not None
            and RunTree is not None
            and Attachment is not None
        )
        self.audio_capture_enabled = self.enabled
        self.session_id = session_id
        self.user_id = user_id
        self.thread_id = thread_id or session_id
        self.model = model
        self.root: Any | None = None
        self.client = client
        self._closed = False
        self._event_count = 0
        self._tool_count = 0
        self._last_provider_sequence: int | None = None

        if not self.enabled:
            return

        if self.client is None:
            self.client = Client(
                api_url=os.getenv("LANGSMITH_ENDPOINT") or None,
                api_key=os.getenv("LANGSMITH_API_KEY") or None,
                workspace_id=os.getenv("LANGSMITH_WORKSPACE_ID") or None,
            )

        metadata = {
            "ls_modality": "audio",
            "runtime": "gemini_live",
            "provider": "google-gemini-live",
            "architecture": "browser_owned_s2s_relay",
            "session_id": session_id,
            "thread_id": self.thread_id,
            "model": model,
            "input_transcription_enabled": True,
            "output_transcription_enabled": True,
        }
        self.root = RunTree(
            name="gemini_live_conversation",
            id=uuid7(),
            run_type="chain",
            project_name=os.getenv("SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT")
            or os.getenv("LANGSMITH_PROJECT")
            or "Sophia",
            inputs={"session_id": session_id, "user_id": user_id},
            extra={"metadata": metadata},
            tags=["sophia", "voice", "gemini_live", "s2s"],
            ls_client=self.client,
            dangerously_allow_filesystem=False,
        )
        self._safe_post(self.root, "root")
        logger.info(
            "gemini.langsmith.trace_started session_id=%s trace_id=%s project=%s",
            session_id,
            self.root.id,
            self.root.session_name,
        )

    @property
    def trace_id(self) -> str | None:
        return str(self.root.id) if self.root is not None else None

    def record_provider_event(
        self,
        event: Mapping[str, Any],
        *,
        categories: list[str],
        provider_receive_sequence: int | None = None,
        provider_relay_sequence: int | None = None,
        provider_received_at: str | None = None,
        relay_correlation_id: str | None = None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        self._event_count += 1
        if provider_receive_sequence is not None:
            self._last_provider_sequence = provider_receive_sequence
        name = _event_name(categories, event)
        metadata = {
            "runtime": "gemini_live",
            "socket_event": True,
            "provider_receive_sequence": provider_receive_sequence,
            "provider_relay_sequence": provider_relay_sequence,
            "provider_received_at": provider_received_at,
            "relay_correlation_id": relay_correlation_id,
            "provider_categories": list(categories),
        }
        child = self.root.create_child(
            name=name,
            run_type="chain",
            run_id=uuid7(),
            inputs={"provider_event": _safe_payload(event)},
            extra={"metadata": metadata},
            tags=["gemini_live", "socket_event", name],
        )
        if "error" in categories:
            child.end(
                outputs={"event_name": name, "provider_categories": list(categories)},
                error="Gemini Live provider error event",
            )
        else:
            child.end(
                outputs={
                    "event_name": name,
                    "provider_categories": list(categories),
                }
            )
        self._safe_post(child, name)

    def record_tool_call(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        success: bool,
        result_summary: str | None = None,
        error: str | None = None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        self._tool_count += 1
        child = self.root.create_child(
            name=f"function_call:{tool_name}",
            run_type="tool",
            run_id=uuid7(),
            inputs={
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "arguments": _safe_payload(arguments or {}),
            },
            extra={
                "metadata": {
                    "runtime": "gemini_live",
                    "socket_event": False,
                    "tool_call_id": tool_call_id,
                }
            },
            tags=["gemini_live", "tool", tool_name],
        )
        child.end(
            outputs={
                "success": success,
                "result_summary": _safe_text(result_summary or ""),
            },
            error=error,
        )
        self._safe_post(child, f"tool:{tool_name}")

    def record_function_response(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        response: Mapping[str, Any] | None,
        success: bool,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        child = self.root.create_child(
            name=f"function_response:{tool_name}",
            run_type="chain",
            run_id=uuid7(),
            inputs={"tool_call_id": tool_call_id, "tool_name": tool_name},
            outputs={"success": success, "response": _safe_payload(response or {})},
            extra={
                "metadata": {
                    "runtime": "gemini_live",
                    "socket_event": True,
                    "function_response": True,
                    "tool_call_id": tool_call_id,
                }
            },
            tags=["gemini_live", "function_response", tool_name],
        )
        child.end()
        self._safe_post(child, f"function_response:{tool_name}")

    def close(
        self,
        *,
        conversation_audio: bytes | None = None,
        conversation_audio_mime_type: str = "audio/webm",
        error: str | None = None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        self._closed = True
        audio_attached = False
        if conversation_audio:
            if len(conversation_audio) <= MAX_AUDIO_ATTACHMENT_BYTES:
                self.root.attachments["conversation_audio"] = Attachment(
                    mime_type=conversation_audio_mime_type,
                    data=conversation_audio,
                )
                audio_attached = True
            else:
                logger.warning(
                    "gemini.langsmith.audio_skipped session_id=%s byte_length=%s reason=attachment_limit",
                    self.session_id,
                    len(conversation_audio),
                )
        self.root.end(
            outputs={
                "session_id": self.session_id,
                "event_count": self._event_count,
                "tool_count": self._tool_count,
                "last_provider_sequence": self._last_provider_sequence,
                "conversation_audio_attached": audio_attached,
            },
            error=error,
            metadata={"trace_status": "completed" if error is None else "error"},
        )
        try:
            self.root.patch(exclude_inputs=False)
            flush = getattr(self.client, "flush", None)
            if callable(flush):
                flush(timeout=10.0)
        except Exception:
            logger.warning(
                "gemini.langsmith.trace_flush_failed session_id=%s trace_id=%s",
                self.session_id,
                self.trace_id,
                exc_info=True,
            )
        logger.info(
            "gemini.langsmith.trace_completed session_id=%s trace_id=%s event_count=%s tool_count=%s audio_attached=%s",
            self.session_id,
            self.trace_id,
            self._event_count,
            self._tool_count,
            audio_attached,
        )

    def _safe_post(self, run: Any, label: str) -> None:
        try:
            run.post()
        except Exception:
            logger.warning(
                "gemini.langsmith.span_post_failed session_id=%s span=%s",
                self.session_id,
                label,
                exc_info=True,
            )
