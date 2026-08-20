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
import re
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
_LANGSMITH_HANDOFF_HEADER_NAMES = frozenset({"langsmith-trace", "baggage"})
_BUILDER_LIFECYCLE_TOOLS = frozenset(
    {
        "start_builder_task",
        "edit_builder_artifact",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    }
)
_TERMINAL_BUILDER_STATUSES = frozenset(
    {"success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"}
)
_SPOKEN_READY_CLAIM_PATTERNS = (
    re.compile(
        r"\b(?:the|your|this|that|my)?\s*"
        r"(?:slide\s+deck|deck|presentation|slides?|artifact|document|file)\s+"
        r"(?:is|are|'s|'re|has\s+been|have\s+been)\s+"
        r"(?:now\s+|all\s+)?(?:ready|complete|completed|done|finished)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:it\s+is|it's|that\s+is|that's)\s+"
        r"(?:now\s+|all\s+)?(?:ready|complete|completed|done|finished)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have))\s+"
        r"(?:completed|finished)\s+(?:the|your|this)\s+"
        r"(?:slide\s+deck|deck|presentation|slides?|artifact|document|file)\b",
        re.IGNORECASE,
    ),
)
_SPOKEN_READY_NEGATION_PATTERN = re.compile(
    r"\b(?:not|isn't|isnt|isn’t|aren't|arent|aren’t|wasn't|wasnt|wasn’t|"
    r"won't|wont|won’t|will\s+not|not\s+yet|still\s+(?:building|running|working))\b"
    r".{0,48}\b(?:ready|complete|completed|done|finished)\b",
    re.IGNORECASE,
)
_SPOKEN_READY_FUTURE_PATTERN = re.compile(
    r"\b(?:when|once|until|before)\b.{0,72}\b(?:ready|complete|completed|done|finished)\b"
    r"|\b(?:will|should)\s+be\s+(?:ready|complete|completed|done|finished)\b",
    re.IGNORECASE,
)


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


def _string_value(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _mapping_value(value: Mapping[str, Any], *keys: str) -> Mapping[str, Any] | None:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, Mapping):
            return candidate
    return None


def _output_transcription_text(event: Mapping[str, Any]) -> str | None:
    server_content = _mapping_value(event, "serverContent", "server_content")
    if server_content is None:
        return None
    transcription = _mapping_value(
        server_content,
        "outputTranscription",
        "output_transcription",
    )
    return _string_value(transcription.get("text")) if transcription is not None else None


def _provider_turn_complete(event: Mapping[str, Any]) -> bool:
    server_content = _mapping_value(event, "serverContent", "server_content")
    if server_content is None:
        return False
    return server_content.get("turnComplete", server_content.get("turn_complete")) is True


def _is_spoken_ready_claim(text: str | None) -> bool:
    if not text:
        return False
    if _SPOKEN_READY_NEGATION_PATTERN.search(text) or _SPOKEN_READY_FUTURE_PATTERN.search(text):
        return False
    return any(pattern.search(text) is not None for pattern in _SPOKEN_READY_CLAIM_PATTERNS)


def _builder_trace_summary(response: Mapping[str, Any] | None) -> dict[str, Any]:
    response = response or {}
    result = response.get("result") if isinstance(response.get("result"), Mapping) else {}
    task = response.get("async_task") if isinstance(response.get("async_task"), Mapping) else {}
    builder_result = result.get("builder_result") if isinstance(result.get("builder_result"), Mapping) else {}
    summary: dict[str, Any] = {}
    for key in (
        "task_id",
        "thread_id",
        "run_id",
        "build_id",
        "operation_id",
        "voice_trace_id",
        "task_type",
        "status",
        "terminal_status",
        "terminal_reason",
        "failure_code",
        "root_failure_code",
    ):
        value = next(
            (
                source.get(key)
                for source in (response, result, task, builder_result)
                if source.get(key) is not None
            ),
            None,
        )
        if value is not None:
            summary[key] = _safe_payload(value)
    artifact_path = next(
        (
            source.get("artifact_path") or source.get("artifact_url")
            for source in (result, task, builder_result, response)
            if source.get("artifact_path") or source.get("artifact_url")
        ),
        None,
    )
    summary["artifact_present"] = bool(_string_value(artifact_path))
    return summary


def _builder_gate_records(
    tool_name: str,
    response: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if tool_name not in {"check_async_task", "list_async_tasks"} or not isinstance(response, Mapping):
        return []
    if tool_name == "list_async_tasks":
        raw_records = response.get("tasks")
        records = [dict(item) for item in raw_records or [] if isinstance(item, Mapping)]
    else:
        merged = dict(response)
        if isinstance(response.get("async_task"), Mapping):
            merged.update(response["async_task"])
        if isinstance(response.get("result"), Mapping):
            merged.update(response["result"])
        records = [merged]

    gates: list[dict[str, Any]] = []
    for record in records:
        status = str(record.get("status") or "unknown").strip().lower()
        builder_result = record.get("builder_result") if isinstance(record.get("builder_result"), Mapping) else {}
        artifact_path = (
            _string_value(record.get("artifact_path"))
            or _string_value(record.get("artifact_url"))
            or _string_value(builder_result.get("artifact_path"))
            or _string_value(builder_result.get("artifact_url"))
        )
        ready_status = status in {"success", "completed"}
        artifact_valid = bool(ready_status and artifact_path)
        evidence_failure_code = (
            "ARTIFACT_EVIDENCE_MISSING" if ready_status and not artifact_valid else None
        )
        gates.append(
            {
                "tool_name": tool_name,
                "task_id": _string_value(record.get("task_id")),
                "thread_id": _string_value(record.get("thread_id")),
                "run_id": _string_value(record.get("run_id")),
                "build_id": _string_value(record.get("build_id")),
                "operation_id": _string_value(record.get("operation_id")),
                "voice_trace_id": _string_value(record.get("voice_trace_id")),
                "artifact_status": status,
                "terminal_status_observed": status in _TERMINAL_BUILDER_STATUSES,
                "ready_status_observed": ready_status,
                "artifact_present": bool(artifact_path),
                "artifact_valid": artifact_valid,
                "announced_ready": False,
                "announcement_allowed": artifact_valid,
                "decision": "allow" if artifact_valid else "suppress",
                "failure_code": _string_value(record.get("failure_code"))
                or evidence_failure_code,
                "false_ready": False,
            }
        )
    return gates


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
        self._latest_artifact_gate_batch: list[dict[str, Any]] = []
        self._latest_artifact_gate_recorded_at: float | None = None
        self._last_ready_claim_text: str | None = None
        self._ready_claim_count = 0
        self._false_ready_claim_count = 0

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
        if "outputTranscription" in categories:
            self._record_spoken_ready_claim(
                event,
                provider_receive_sequence=provider_receive_sequence,
                relay_correlation_id=relay_correlation_id,
            )
        if _provider_turn_complete(event):
            self._last_ready_claim_text = None

    def record_tool_call(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        success: bool,
        result_summary: str | None = None,
        error: str | None = None,
        response: Mapping[str, Any] | None = None,
    ) -> None:
        child = self.start_tool_call(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            arguments=arguments,
        )
        self.finish_tool_call(
            child,
            tool_name=tool_name,
            success=success,
            result_summary=result_summary,
            error=error,
            response=response,
        )

    def start_tool_call(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        provider_receive_sequence: int | None = None,
        relay_correlation_id: str | None = None,
    ) -> Any | None:
        """Post an open tool span before awaiting its backend side effect."""

        if not self.enabled or self.root is None or self._closed:
            return None
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
                    "provider_receive_sequence": provider_receive_sequence,
                    "relay_correlation_id": relay_correlation_id,
                }
            },
            tags=["gemini_live", "tool", tool_name],
        )
        self._safe_post(child, f"tool_open:{tool_name}")
        return child

    def finish_tool_call(
        self,
        child: Any | None,
        *,
        tool_name: str,
        success: bool,
        result_summary: str | None = None,
        error: str | None = None,
        response: Mapping[str, Any] | None = None,
    ) -> None:
        if child is None:
            return
        outputs: dict[str, Any] = {
            "success": success,
            "result_summary": _safe_text(result_summary or ""),
        }
        if tool_name in _BUILDER_LIFECYCLE_TOOLS:
            outputs["builder_lifecycle"] = _builder_trace_summary(response)
        child.end(
            outputs=outputs,
            error=error,
        )
        self._safe_patch(child, f"tool:{tool_name}")

    def handoff_headers(self, run: Any | None = None) -> dict[str, str]:
        """Return only LangSmith's distributed-trace headers for HTTP handoff."""

        source = run or self.root
        if not self.enabled or source is None or self._closed:
            return {}
        try:
            raw = source.to_headers()
        except Exception:
            logger.warning(
                "gemini.langsmith.trace_headers_failed session_id=%s trace_id=%s",
                self.session_id,
                self.trace_id,
                exc_info=True,
            )
            return {}
        if not isinstance(raw, Mapping):
            return {}
        return {
            str(key): str(value)
            for key, value in raw.items()
            if str(key).lower() in _LANGSMITH_HANDOFF_HEADER_NAMES and isinstance(value, str)
        }

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
        self._record_artifact_announcement_gates(tool_name, response)

    def _record_artifact_announcement_gates(
        self,
        tool_name: str,
        response: Mapping[str, Any] | None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        if tool_name not in {"check_async_task", "list_async_tasks"}:
            return
        gates = _builder_gate_records(tool_name, response)
        gate_batch: list[dict[str, Any]] = []
        for gate in gates:
            child = self.root.create_child(
                name="artifact.announcement_gate",
                run_type="chain",
                run_id=uuid7(),
                inputs={
                    "task_id": gate.get("task_id"),
                    "build_id": gate.get("build_id"),
                    "observed_status": gate.get("artifact_status"),
                },
                extra={
                    "metadata": {
                        "runtime": "gemini_live",
                        "voice_trace_id": self.trace_id,
                        "task_id": gate.get("task_id"),
                        "build_id": gate.get("build_id"),
                        "operation_id": gate.get("operation_id"),
                    }
                },
                tags=["sophia", "voice", "artifact", "announcement_gate"],
            )
            child.end(
                outputs=_safe_payload(gate),
                error=(
                    "ARTIFACT_EVIDENCE_MISSING"
                    if gate.get("ready_status_observed") and not gate.get("artifact_valid")
                    else None
                ),
            )
            self._safe_post(child, "artifact.announcement_gate")
            enriched_gate = dict(gate)
            enriched_gate["gate_run_id"] = str(child.id)
            gate_batch.append(enriched_gate)
        self._latest_artifact_gate_batch = gate_batch
        self._latest_artifact_gate_recorded_at = time.monotonic() if gate_batch else None
        self._last_ready_claim_text = None

    def _record_spoken_ready_claim(
        self,
        event: Mapping[str, Any],
        *,
        provider_receive_sequence: int | None,
        relay_correlation_id: str | None,
    ) -> None:
        if not self.enabled or self.root is None or self._closed:
            return
        transcript = _output_transcription_text(event)
        if not _is_spoken_ready_claim(transcript):
            return
        normalized = " ".join((transcript or "").lower().split())
        previous = self._last_ready_claim_text
        if previous and (normalized.startswith(previous) or previous.startswith(normalized)):
            return
        self._last_ready_claim_text = normalized

        gates = self._latest_artifact_gate_batch
        gate = gates[0] if len(gates) == 1 else {}
        evidence_unambiguous = len(gates) == 1
        announcement_allowed = bool(evidence_unambiguous and gate.get("announcement_allowed"))
        if not gates:
            failure_code = "ARTIFACT_GATE_MISSING"
        elif not evidence_unambiguous:
            failure_code = "ARTIFACT_GATE_AMBIGUOUS"
        elif gate.get("failure_code"):
            failure_code = str(gate["failure_code"])
        elif not gate.get("artifact_valid"):
            failure_code = "ARTIFACT_NOT_READY"
        else:
            failure_code = None
        evidence_age_ms = (
            max(int((time.monotonic() - self._latest_artifact_gate_recorded_at) * 1000), 0)
            if self._latest_artifact_gate_recorded_at is not None
            else None
        )
        outputs = {
            "announced_ready": True,
            "announcement_allowed": announcement_allowed,
            "decision": "allow" if announcement_allowed else "violation",
            "false_ready": not announcement_allowed,
            "failure_code": failure_code,
            "evidence_record_count": len(gates),
            "evidence_age_ms": evidence_age_ms,
            "evidence_tool_name": gate.get("tool_name"),
            "evidence_status": gate.get("artifact_status"),
            "artifact_valid": bool(gate.get("artifact_valid")),
            "task_id": gate.get("task_id"),
            "thread_id": gate.get("thread_id"),
            "run_id": gate.get("run_id"),
            "build_id": gate.get("build_id"),
            "operation_id": gate.get("operation_id"),
            "gate_run_id": gate.get("gate_run_id"),
        }
        child = self.root.create_child(
            name="voice.ready_spoken",
            run_type="chain",
            run_id=uuid7(),
            inputs={
                "transcript": _safe_text(transcript or ""),
                "provider_receive_sequence": provider_receive_sequence,
                "relay_correlation_id": relay_correlation_id,
            },
            extra={
                "metadata": {
                    "runtime": "gemini_live",
                    "voice_trace_id": self.trace_id,
                    "provider_receive_sequence": provider_receive_sequence,
                    "relay_correlation_id": relay_correlation_id,
                    "task_id": gate.get("task_id"),
                    "build_id": gate.get("build_id"),
                    "gate_run_id": gate.get("gate_run_id"),
                }
            },
            tags=["sophia", "voice", "artifact", "ready_spoken"],
        )
        child.end(
            outputs=_safe_payload(outputs),
            error="FALSE_READY" if not announcement_allowed else None,
        )
        self._safe_post(child, "voice.ready_spoken")
        self._ready_claim_count += 1
        if not announcement_allowed:
            self._false_ready_claim_count += 1

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
                "ready_claim_count": self._ready_claim_count,
                "false_ready_claim_count": self._false_ready_claim_count,
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

    def _safe_patch(self, run: Any, label: str) -> None:
        try:
            run.patch()
        except Exception:
            logger.warning(
                "gemini.langsmith.span_patch_failed session_id=%s span=%s",
                self.session_id,
                label,
                exc_info=True,
            )
