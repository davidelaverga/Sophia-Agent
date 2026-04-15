"""ChannelManager — consumes inbound messages and dispatches them to the DeerFlow agent via LangGraph Server."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.channels.base import InboundFileReader
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment
from app.channels.session_resolver import resolve_channel_session
from app.channels.store import ChannelStore
from deerflow.config.paths import get_paths
from deerflow.subagents.executor import get_background_task_result

logger = logging.getLogger(__name__)

DEFAULT_LANGGRAPH_URL = "http://localhost:2024"
DEFAULT_GATEWAY_URL = "http://localhost:8001"
DEFAULT_ASSISTANT_ID = "lead_agent"

DEFAULT_RUN_CONFIG: dict[str, Any] = {"recursion_limit": 100}
DEFAULT_RUN_CONTEXT: dict[str, Any] = {
    "thinking_enabled": True,
    "is_plan_mode": False,
    "subagent_enabled": False,
}
STREAM_UPDATE_MIN_INTERVAL_SECONDS = 0.35
THREAD_BUSY_MESSAGE = "I’m still working on your previous message in this chat. Please wait a moment and try again."
BUILDER_NOTIFIER_POLL_INTERVAL_SECONDS = 2.0
BUILDER_NOTIFIER_MAX_WAIT_SECONDS = 20 * 60
_UPLOADS_VIRTUAL_PREFIX = "/mnt/user-data/uploads/"

_TERMINAL_BUILDER_STATUSES = {"completed", "failed", "timed_out"}


def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _merge_dicts(*layers: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for layer in layers:
        if isinstance(layer, Mapping):
            merged.update(layer)
    return merged


def _extract_response_text(result: dict | list) -> str:
    """Extract the last AI message text from a LangGraph runs.wait result.

    ``runs.wait`` returns the final state dict which contains a ``messages``
    list.  Each message is a dict with at least ``type`` and ``content``.

    Handles special cases:
    - Regular AI text responses
    - Clarification interrupts (``ask_clarification`` tool messages)
    - AI messages with tool_calls but no text content
    """
    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        return ""

    # Walk backwards to find usable response text, but stop at the last
    # human message to avoid returning text from a previous turn.
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue

        msg_type = msg.get("type")

        # Stop at the last human message — anything before it is a previous turn
        if msg_type == "human":
            break

        # Check for tool messages from ask_clarification (interrupt case)
        if msg_type == "tool" and msg.get("name") == "ask_clarification":
            content = msg.get("content", "")
            if isinstance(content, str) and content:
                return content

        # Regular AI message with text content
        if msg_type == "ai":
            content = msg.get("content", "")
            if isinstance(content, str) and content:
                return content
            # content can be a list of content blocks
            if isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        parts.append(block)
                text = "".join(parts)
                if text:
                    return text
    return ""


def _extract_text_content(content: Any) -> str:
    """Extract text from a streaming payload content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
                else:
                    nested = block.get("content")
                    if isinstance(nested, str):
                        parts.append(nested)
        return "".join(parts)
    if isinstance(content, Mapping):
        for key in ("text", "content"):
            value = content.get(key)
            if isinstance(value, str):
                return value
    return ""


def _merge_stream_text(existing: str, chunk: str) -> str:
    """Merge either delta text or cumulative text into a single snapshot."""
    if not chunk:
        return existing
    if not existing or chunk == existing:
        return chunk or existing
    if chunk.startswith(existing):
        return chunk
    if existing.endswith(chunk):
        return existing
    return existing + chunk


def _extract_stream_message_id(payload: Any, metadata: Any) -> str | None:
    """Best-effort extraction of the streamed AI message identifier."""
    candidates = [payload, metadata]
    if isinstance(payload, Mapping):
        candidates.append(payload.get("kwargs"))

    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        for key in ("id", "message_id"):
            value = candidate.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _accumulate_stream_text(
    buffers: dict[str, str],
    current_message_id: str | None,
    event_data: Any,
) -> tuple[str | None, str | None]:
    """Convert a ``messages-tuple`` event into the latest displayable AI text."""
    payload = event_data
    metadata: Any = None
    if isinstance(event_data, (list, tuple)):
        if event_data:
            payload = event_data[0]
        if len(event_data) > 1:
            metadata = event_data[1]

    if isinstance(payload, str):
        message_id = current_message_id or "__default__"
        buffers[message_id] = _merge_stream_text(buffers.get(message_id, ""), payload)
        return buffers[message_id], message_id

    if not isinstance(payload, Mapping):
        return None, current_message_id

    payload_type = str(payload.get("type", "")).lower()
    if "tool" in payload_type:
        return None, current_message_id

    text = _extract_text_content(payload.get("content"))
    if not text and isinstance(payload.get("kwargs"), Mapping):
        text = _extract_text_content(payload["kwargs"].get("content"))
    if not text:
        return None, current_message_id

    message_id = _extract_stream_message_id(payload, metadata) or current_message_id or "__default__"
    buffers[message_id] = _merge_stream_text(buffers.get(message_id, ""), text)
    return buffers[message_id], message_id


def _extract_artifacts(result: dict | list) -> list[str]:
    """Extract artifact paths from the last AI response cycle only.

    Instead of reading the full accumulated ``artifacts`` state (which contains
    all artifacts ever produced in the thread), this inspects the messages after
    the last human message and collects file paths from ``present_files`` tool
    calls.  This ensures only newly-produced artifacts are returned.
    """
    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        return []

    artifacts: list[str] = []
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        # Stop at the last human message — anything before it is a previous turn
        if msg.get("type") == "human":
            break
        # Look for AI messages with present_files tool calls
        if msg.get("type") == "ai":
            for tc in msg.get("tool_calls", []):
                if isinstance(tc, dict) and tc.get("name") == "present_files":
                    args = tc.get("args", {})
                    paths = args.get("filepaths", [])
                    if isinstance(paths, list):
                        artifacts.extend(p for p in paths if isinstance(p, str))
    return artifacts


def _format_artifact_text(artifacts: list[str]) -> str:
    """Format artifact paths into a human-readable text block listing filenames."""
    import posixpath

    filenames = [posixpath.basename(p) for p in artifacts]
    if len(filenames) == 1:
        return f"Created File: 📎 {filenames[0]}"
    return "Created Files: 📎 " + "、".join(filenames)


def _human_file_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _build_uploaded_files_block(uploaded_files: list[dict[str, Any]]) -> str:
    if not uploaded_files:
        return ""
    lines = [
        "<uploaded_files>",
        "The following files were uploaded in this message:",
        "",
    ]
    for file_info in uploaded_files:
        filename = str(file_info.get("filename", "uploaded_file"))
        size = int(file_info.get("size", 0) or 0)
        virtual_path = str(file_info.get("virtual_path", ""))
        lines.append(f"- {filename} ({_human_file_size(size)})")
        lines.append(f"  Path: {virtual_path}")
        lines.append("")
    lines.append("Use `read_file` for file contents and `view_image` for image analysis when needed.")
    lines.append("</uploaded_files>")
    return "\n".join(lines)


def _compose_inbound_content(text: str, uploaded_files: list[dict[str, Any]]) -> str:
    upload_block = _build_uploaded_files_block(uploaded_files)
    if not upload_block:
        return text
    if text:
        return f"{upload_block}\n\n{text}"
    return upload_block


def _extract_builder_handoff_task(result: dict | list) -> tuple[str | None, str | None]:
    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        return None, None

    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("type") == "human":
            break
        if msg.get("type") != "tool":
            continue
        if msg.get("name") != "switch_to_builder":
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            continue
        try:
            payload = json.loads(content)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("type") != "builder_handoff":
            continue
        task_id = payload.get("task_id")
        status = payload.get("status")
        if isinstance(task_id, str) and task_id:
            return task_id, status if isinstance(status, str) else None
    return None, None


def _to_builder_status(value: Any) -> str:
    status_value = getattr(value, "value", value)
    return str(status_value).strip().lower()


def _extract_builder_result_payload(task_result: Any) -> dict[str, Any] | None:
    final_state = getattr(task_result, "final_state", None)
    if isinstance(final_state, dict):
        builder_result = final_state.get("builder_result")
        if isinstance(builder_result, dict):
            return builder_result

    ai_messages = getattr(task_result, "ai_messages", None)
    if isinstance(ai_messages, list):
        for msg in reversed(ai_messages):
            if not isinstance(msg, dict):
                continue
            tool_calls = msg.get("tool_calls", [])
            if not isinstance(tool_calls, list):
                continue
            for tool_call in reversed(tool_calls):
                if not isinstance(tool_call, dict):
                    continue
                if tool_call.get("name") != "emit_builder_artifact":
                    continue
                args = tool_call.get("args")
                if isinstance(args, dict):
                    return args
    return None


def _normalize_builder_artifact_path(path: str) -> str | None:
    raw = str(path).strip()
    if not raw:
        return None
    if raw.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return raw
    if raw.startswith("/mnt/user-data/outputs"):
        suffix = raw.removeprefix("/mnt/user-data/outputs").lstrip("/")
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{suffix}" if suffix else None
    if raw.startswith("outputs/"):
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{raw.removeprefix('outputs/')}"
    if raw.startswith("./outputs/"):
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{raw.removeprefix('./outputs/')}"
    if raw.startswith("/mnt/user-data/"):
        return None

    normalized = raw.replace("\\", "/")
    if "/outputs/" in normalized:
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{normalized.rsplit('/outputs/', 1)[1].lstrip('/')}"

    filename = Path(normalized).name.strip()
    if not filename or filename in {".", ".."}:
        return None
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{filename}"


def _extract_builder_artifacts(builder_result: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    primary = builder_result.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = builder_result.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized_path = _normalize_builder_artifact_path(candidate)
        if not normalized_path or normalized_path in seen:
            continue
        seen.add(normalized_path)
        normalized.append(normalized_path)
    return normalized


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _resolve_attachments(thread_id: str, artifacts: list[str]) -> list[ResolvedAttachment]:
    """Resolve virtual artifact paths to host filesystem paths with metadata.

    Only paths under ``/mnt/user-data/outputs/`` are accepted; any other
    virtual path is rejected with a warning to prevent exfiltrating uploads
    or workspace files via IM channels.

    Skips artifacts that cannot be resolved (missing files, invalid paths)
    and logs warnings for them.
    """
    from deerflow.config.paths import get_paths

    attachments: list[ResolvedAttachment] = []
    paths = get_paths()
    outputs_dir = paths.sandbox_outputs_dir(thread_id).resolve()
    for virtual_path in artifacts:
        # Security: only allow files from the agent outputs directory
        if not virtual_path.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            logger.warning("[Manager] rejected non-outputs artifact path: %s", virtual_path)
            continue
        try:
            actual = paths.resolve_virtual_path(thread_id, virtual_path)
            # Verify the resolved path is actually under the outputs directory
            # (guards against path-traversal even after prefix check)
            try:
                actual.resolve().relative_to(outputs_dir)
            except ValueError:
                logger.warning("[Manager] artifact path escapes outputs dir: %s -> %s", virtual_path, actual)
                continue
            if not actual.is_file():
                logger.warning("[Manager] artifact not found on disk: %s -> %s", virtual_path, actual)
                continue
            mime, _ = mimetypes.guess_type(str(actual))
            mime = mime or "application/octet-stream"
            attachments.append(
                ResolvedAttachment(
                    virtual_path=virtual_path,
                    actual_path=actual,
                    filename=actual.name,
                    mime_type=mime,
                    size=actual.stat().st_size,
                    is_image=mime.startswith("image/"),
                )
            )
        except (ValueError, OSError) as exc:
            logger.warning("[Manager] failed to resolve artifact %s: %s", virtual_path, exc)
    return attachments


def _prepare_artifact_delivery(
    thread_id: str,
    response_text: str,
    artifacts: list[str],
) -> tuple[str, list[ResolvedAttachment]]:
    """Resolve attachments and append filename fallbacks to the text response."""
    attachments: list[ResolvedAttachment] = []
    if not artifacts:
        return response_text, attachments

    attachments = _resolve_attachments(thread_id, artifacts)
    resolved_virtuals = {attachment.virtual_path for attachment in attachments}
    unresolved = [path for path in artifacts if path not in resolved_virtuals]

    if unresolved:
        artifact_text = _format_artifact_text(unresolved)
        response_text = (response_text + "\n\n" + artifact_text) if response_text else artifact_text

    # Always include resolved attachment filenames as a text fallback so files
    # remain discoverable even when the upload is skipped or fails.
    if attachments:
        resolved_text = _format_artifact_text([attachment.virtual_path for attachment in attachments])
        response_text = (response_text + "\n\n" + resolved_text) if response_text else resolved_text

    return response_text, attachments


class ChannelManager:
    """Core dispatcher that bridges IM channels to the DeerFlow agent.

    It reads from the MessageBus inbound queue, creates/reuses threads on
    the LangGraph Server, sends messages via ``runs.wait``, and publishes
    outbound responses back through the bus.
    """

    def __init__(
        self,
        bus: MessageBus,
        store: ChannelStore,
        *,
        max_concurrency: int = 5,
        langgraph_url: str = DEFAULT_LANGGRAPH_URL,
        gateway_url: str = DEFAULT_GATEWAY_URL,
        assistant_id: str = DEFAULT_ASSISTANT_ID,
        default_session: dict[str, Any] | None = None,
        channel_sessions: dict[str, Any] | None = None,
        session_resolver: Any | None = None,
        inbound_file_readers: dict[str, InboundFileReader] | None = None,
    ) -> None:
        self.bus = bus
        self.store = store
        self._max_concurrency = max_concurrency
        self._langgraph_url = langgraph_url
        self._gateway_url = gateway_url
        self._assistant_id = assistant_id
        self._default_session = _as_dict(default_session)
        self._channel_sessions = dict(channel_sessions or {})
        self._session_resolver = session_resolver or resolve_channel_session
        self._inbound_file_readers: dict[str, InboundFileReader] = dict(inbound_file_readers or {})
        self._client = None  # lazy init — langgraph_sdk async client
        self._semaphore: asyncio.Semaphore | None = None
        self._conversation_locks: dict[str, asyncio.Lock] = {}
        self._builder_notifier_tasks: dict[str, asyncio.Task] = {}
        self._running = False
        self._task: asyncio.Task | None = None

    def _resolve_session_layer(self, msg: InboundMessage) -> tuple[dict[str, Any], dict[str, Any]]:
        channel_layer = _as_dict(self._channel_sessions.get(msg.channel_name))
        users_layer = _as_dict(channel_layer.get("users"))
        user_layer = _as_dict(users_layer.get(msg.user_id))
        return channel_layer, user_layer

    def _resolve_run_params(self, msg: InboundMessage, thread_id: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
        channel_layer, user_layer = self._resolve_session_layer(msg)
        dynamic_layer: dict[str, Any] = {}
        if self._session_resolver:
            try:
                dynamic_layer = _as_dict(self._session_resolver(msg, thread_id))
            except Exception:
                logger.warning("[Manager] session_resolver failed for channel=%s chat_id=%s", msg.channel_name, msg.chat_id, exc_info=True)

        assistant_id = (
            dynamic_layer.get("assistant_id")
            or user_layer.get("assistant_id")
            or channel_layer.get("assistant_id")
            or self._default_session.get("assistant_id")
            or self._assistant_id
        )
        if not isinstance(assistant_id, str) or not assistant_id.strip():
            assistant_id = self._assistant_id

        run_config = _merge_dicts(
            DEFAULT_RUN_CONFIG,
            self._default_session.get("config"),
            channel_layer.get("config"),
            user_layer.get("config"),
            dynamic_layer.get("config"),
        )

        run_context = _merge_dicts(
            DEFAULT_RUN_CONTEXT,
            self._default_session.get("context"),
            channel_layer.get("context"),
            user_layer.get("context"),
            dynamic_layer.get("context"),
            {"thread_id": thread_id},
        )

        # LangGraph API ≥0.6 rejects requests containing both configurable
        # and context.  When configurable is present, fold context into it so
        # the caller can omit the separate context parameter.
        if "configurable" in run_config:
            for key, value in run_context.items():
                run_config["configurable"].setdefault(key, value)
            run_context = {}

        return assistant_id, run_config, run_context

    @staticmethod
    def _conversation_key(msg: InboundMessage) -> str:
        topic_part = msg.topic_id if msg.topic_id is not None else "__root__"
        return f"{msg.channel_name}:{msg.chat_id}:{topic_part}"

    def _get_conversation_lock(self, msg: InboundMessage) -> asyncio.Lock:
        key = self._conversation_key(msg)
        lock = self._conversation_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._conversation_locks[key] = lock
        return lock

    @staticmethod
    def _build_message_files_metadata(uploaded_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "filename": str(file_info.get("filename", "")),
                "size": int(file_info.get("size", 0) or 0),
                "path": str(file_info.get("virtual_path", "")),
                "status": "uploaded",
            }
            for file_info in uploaded_files
            if isinstance(file_info, dict)
        ]

    def _build_human_message_payload(self, text: str, uploaded_files: list[dict[str, Any]]) -> dict[str, Any]:
        content = _compose_inbound_content(text, uploaded_files)
        payload: dict[str, Any] = {"role": "human", "content": content}
        if uploaded_files:
            payload["additional_kwargs"] = {
                "files": self._build_message_files_metadata(uploaded_files),
            }
        return payload

    def register_inbound_file_reader(self, channel_name: str, reader: InboundFileReader) -> None:
        self._inbound_file_readers[channel_name] = reader

    # -- LangGraph SDK client (lazy) ----------------------------------------

    def _get_client(self):
        """Return the ``langgraph_sdk`` async client, creating it on first use."""
        if self._client is None:
            from langgraph_sdk import get_client

            self._client = get_client(url=self._langgraph_url)
        return self._client

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Start the dispatch loop."""
        if self._running:
            return
        self._running = True
        self._semaphore = asyncio.Semaphore(self._max_concurrency)
        self._task = asyncio.create_task(self._dispatch_loop())
        logger.info("ChannelManager started (max_concurrency=%d)", self._max_concurrency)

    async def stop(self) -> None:
        """Stop the dispatch loop."""
        self._running = False
        notifier_tasks = list(self._builder_notifier_tasks.values())
        for notifier_task in notifier_tasks:
            notifier_task.cancel()
        if notifier_tasks:
            await asyncio.gather(*notifier_tasks, return_exceptions=True)
        self._builder_notifier_tasks.clear()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("ChannelManager stopped")

    # -- dispatch loop -----------------------------------------------------

    async def _dispatch_loop(self) -> None:
        logger.info("[Manager] dispatch loop started, waiting for inbound messages")
        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.get_inbound(), timeout=1.0)
            except TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            logger.info(
                "[Manager] received inbound: channel=%s, chat_id=%s, type=%s, text=%r",
                msg.channel_name,
                msg.chat_id,
                msg.msg_type.value,
                msg.text[:100] if msg.text else "",
            )
            task = asyncio.create_task(self._handle_message(msg))
            task.add_done_callback(self._log_task_error)

    @staticmethod
    def _log_task_error(task: asyncio.Task) -> None:
        """Surface unhandled exceptions from background tasks."""
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.error("[Manager] unhandled error in message task: %s", exc, exc_info=exc)

    async def _handle_message(self, msg: InboundMessage) -> None:
        async with self._semaphore:
            try:
                if msg.msg_type == InboundMessageType.COMMAND:
                    await self._handle_command(msg)
                else:
                    await self._handle_chat(msg)
            except Exception:
                logger.exception(
                    "Error handling message from %s (chat=%s)",
                    msg.channel_name,
                    msg.chat_id,
                )
                await self._send_error(msg, "An internal error occurred. Please try again.")

    # -- chat handling -----------------------------------------------------

    async def _create_thread(self, client, msg: InboundMessage) -> str:
        """Create a new thread on the LangGraph Server and store the mapping."""
        thread = await client.threads.create()
        thread_id = thread["thread_id"]
        self.store.set_thread_id(
            msg.channel_name,
            msg.chat_id,
            thread_id,
            topic_id=msg.topic_id,
            user_id=msg.user_id,
        )
        logger.info("[Manager] new thread created on LangGraph Server: thread_id=%s for chat_id=%s topic_id=%s", thread_id, msg.chat_id, msg.topic_id)
        return thread_id
    @staticmethod
    def _make_safe_upload_filename(filename: str, fallback_index: int) -> str:
        safe = Path(filename).name.strip()
        if not safe or safe in {".", ".."}:
            safe = f"upload_{fallback_index}.bin"
        return safe

    @staticmethod
    def _reserve_upload_path(uploads_dir: Path, filename: str) -> Path:
        candidate = uploads_dir / filename
        if not candidate.exists():
            return candidate
        stem = candidate.stem or "upload"
        suffix = candidate.suffix
        for idx in range(1, 1000):
            candidate = uploads_dir / f"{stem}_{idx}{suffix}"
            if not candidate.exists():
                return candidate
        return uploads_dir / f"{stem}_{int(time.time())}{suffix}"

    async def _read_and_store_inbound_files(self, msg: InboundMessage, thread_id: str) -> list[dict[str, Any]]:
        if not msg.files:
            return []

        reader = self._inbound_file_readers.get(msg.channel_name)
        if reader is None:
            logger.info("[Manager] no inbound file reader for channel=%s; skipping %d file refs", msg.channel_name, len(msg.files))
            return []

        try:
            inbound_files = await reader(msg)
        except Exception:
            logger.exception("[Manager] inbound file reader failed for channel=%s", msg.channel_name)
            return []

        if not inbound_files:
            return []

        paths = get_paths()
        paths.ensure_thread_dirs(thread_id)
        uploads_dir = paths.sandbox_uploads_dir(thread_id)
        sandbox_provider = None

        sandbox_id = None
        sandbox = None
        try:
            from deerflow.sandbox.sandbox_provider import get_sandbox_provider

            sandbox_provider = get_sandbox_provider()
            sandbox_id = sandbox_provider.acquire(thread_id)
            sandbox = sandbox_provider.get(sandbox_id)
        except Exception:
            logger.warning("[Manager] unable to acquire sandbox for inbound file sync; files will stay host-local", exc_info=True)

        stored_files: list[dict[str, Any]] = []
        try:
            for idx, file_info in enumerate(inbound_files, start=1):
                if not isinstance(file_info, dict):
                    continue

                raw_content = file_info.get("content")
                if isinstance(raw_content, str):
                    content = raw_content.encode("utf-8")
                elif isinstance(raw_content, (bytes, bytearray)):
                    content = bytes(raw_content)
                else:
                    continue

                safe_filename = self._make_safe_upload_filename(str(file_info.get("filename", "")), idx)
                target_path = self._reserve_upload_path(uploads_dir, safe_filename)
                target_path.write_bytes(content)

                virtual_path = f"{_UPLOADS_VIRTUAL_PREFIX}{target_path.name}"
                mime_type = file_info.get("mime_type")
                if not isinstance(mime_type, str) or not mime_type:
                    mime_type = mimetypes.guess_type(target_path.name)[0] or "application/octet-stream"

                if sandbox is not None and sandbox_id and sandbox_id != "local":
                    try:
                        sandbox.update_file(virtual_path, content)
                    except Exception:
                        logger.warning("[Manager] failed to sync inbound upload to sandbox: %s", virtual_path, exc_info=True)

                stored_files.append(
                    {
                        "filename": target_path.name,
                        "size": len(content),
                        "virtual_path": virtual_path,
                        "path": virtual_path,
                        "extension": target_path.suffix,
                        "mime_type": mime_type,
                        "status": "uploaded",
                    }
                )
        finally:
            if sandbox_provider is not None and isinstance(sandbox_id, str) and sandbox_id:
                try:
                    sandbox_provider.release(sandbox_id)
                except Exception:
                    logger.warning("[Manager] failed to release sandbox after inbound file sync: %s", sandbox_id, exc_info=True)

        logger.info("[Manager] stored inbound files: channel=%s chat_id=%s count=%d", msg.channel_name, msg.chat_id, len(stored_files))
        return stored_files

    def _schedule_builder_notifier(self, *, msg: InboundMessage, thread_id: str, task_id: str) -> None:
        if not task_id or task_id in self._builder_notifier_tasks:
            return

        task = asyncio.create_task(
            self._run_builder_notifier(
                msg=msg,
                thread_id=thread_id,
                task_id=task_id,
            )
        )
        self._builder_notifier_tasks[task_id] = task
        task.add_done_callback(self._log_task_error)
        task.add_done_callback(lambda _task: self._builder_notifier_tasks.pop(task_id, None))

    async def _run_builder_notifier(self, *, msg: InboundMessage, thread_id: str, task_id: str) -> None:
        started_at = time.monotonic()
        while self._running and (time.monotonic() - started_at) <= BUILDER_NOTIFIER_MAX_WAIT_SECONDS:
            await asyncio.sleep(BUILDER_NOTIFIER_POLL_INTERVAL_SECONDS)
            task_result = get_background_task_result(task_id)
            if task_result is None:
                continue

            status = _to_builder_status(getattr(task_result, "status", None))
            if status in {"pending", "queued", "running", "started"}:
                continue

            if status == "completed":
                builder_result = _extract_builder_result_payload(task_result) or {}
                summary = builder_result.get("companion_summary")
                response_text = summary.strip() if isinstance(summary, str) and summary.strip() else "Your builder task is complete."
                next_action = builder_result.get("user_next_action")
                if isinstance(next_action, str) and next_action.strip():
                    response_text = f"{response_text}\n\nNext step: {next_action.strip()}"
                artifacts = _extract_builder_artifacts(builder_result)
                response_text, attachments = _prepare_artifact_delivery(thread_id, response_text, artifacts)

                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel_name=msg.channel_name,
                        chat_id=msg.chat_id,
                        thread_id=thread_id,
                        text=response_text,
                        artifacts=artifacts,
                        attachments=attachments,
                        thread_ts=msg.thread_ts,
                        metadata={"builder_task_id": task_id, "builder_notification": True},
                    )
                )
                return

            if status in _TERMINAL_BUILDER_STATUSES:
                error = getattr(task_result, "error", None)
                base_text = "Builder task timed out." if status == "timed_out" else "Builder task failed."
                if isinstance(error, str) and error.strip():
                    base_text = f"{base_text}\n\n{error.strip()}"
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel_name=msg.channel_name,
                        chat_id=msg.chat_id,
                        thread_id=thread_id,
                        text=base_text,
                        thread_ts=msg.thread_ts,
                        metadata={"builder_task_id": task_id, "builder_notification": True},
                    )
                )
                return

            logger.info("[Manager] builder notifier observed unknown status=%s task_id=%s", status, task_id)
            return

        logger.info("[Manager] builder notifier timeout reached for task_id=%s", task_id)

    async def _handle_chat(self, msg: InboundMessage) -> None:
        client = self._get_client()
        conversation_lock = self._get_conversation_lock(msg)
        if conversation_lock.locked():
            thread_id = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=msg.topic_id) or ""
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel_name=msg.channel_name,
                    chat_id=msg.chat_id,
                    thread_id=thread_id,
                    text=THREAD_BUSY_MESSAGE,
                    thread_ts=msg.thread_ts,
                )
            )
            return

        async with conversation_lock:
            # Look up existing DeerFlow thread.
            # topic_id may be None (e.g. Telegram private chats) — the store
            # handles this by using the "channel:chat_id" key without a topic suffix.
            thread_id = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=msg.topic_id)
            if thread_id:
                logger.info("[Manager] reusing thread: thread_id=%s for topic_id=%s", thread_id, msg.topic_id)

            # No existing thread found — create a new one
            if thread_id is None:
                thread_id = await self._create_thread(client, msg)

            uploaded_files = await self._read_and_store_inbound_files(msg, thread_id)
            human_message_payload = self._build_human_message_payload(msg.text, uploaded_files)
            assistant_id, run_config, run_context = self._resolve_run_params(msg, thread_id)
            if msg.channel_name == "feishu":
                await self._handle_streaming_chat(
                    client,
                    msg,
                    thread_id,
                    assistant_id,
                    run_config,
                    run_context,
                    human_message_payload,
                )
                return

            logger.info("[Manager] invoking runs.wait(thread_id=%s, text=%r)", thread_id, msg.text[:100])
            run_kwargs: dict[str, Any] = {
                "input": {"messages": [human_message_payload]},
                "config": run_config,
            }
            if run_context:
                run_kwargs["context"] = run_context
            result = await client.runs.wait(
                thread_id,
                assistant_id,
                **run_kwargs,
            )

            response_text = _extract_response_text(result)
            artifacts = _extract_artifacts(result)
            builder_task_id, _builder_status = _extract_builder_handoff_task(result)

            logger.info(
                "[Manager] agent response received: thread_id=%s, response_len=%d, artifacts=%d",
                thread_id,
                len(response_text) if response_text else 0,
                len(artifacts),
            )

            response_text, attachments = _prepare_artifact_delivery(thread_id, response_text, artifacts)

            if not response_text:
                if attachments:
                    response_text = _format_artifact_text([a.virtual_path for a in attachments])
                else:
                    response_text = "(No response from agent)"

            outbound = OutboundMessage(
                channel_name=msg.channel_name,
                chat_id=msg.chat_id,
                thread_id=thread_id,
                text=response_text,
                artifacts=artifacts,
                attachments=attachments,
                thread_ts=msg.thread_ts,
            )
            logger.info("[Manager] publishing outbound message to bus: channel=%s, chat_id=%s", msg.channel_name, msg.chat_id)
            await self.bus.publish_outbound(outbound)

            if msg.channel_name == "telegram" and builder_task_id:
                self._schedule_builder_notifier(msg=msg, thread_id=thread_id, task_id=builder_task_id)

    async def _handle_streaming_chat(
        self,
        client,
        msg: InboundMessage,
        thread_id: str,
        assistant_id: str,
        run_config: dict[str, Any],
        run_context: dict[str, Any],
        human_message_payload: dict[str, Any],
    ) -> None:
        logger.info("[Manager] invoking runs.stream(thread_id=%s, text=%r)", thread_id, msg.text[:100])

        last_values: dict[str, Any] | list | None = None
        streamed_buffers: dict[str, str] = {}
        current_message_id: str | None = None
        latest_text = ""
        last_published_text = ""
        last_publish_at = 0.0
        stream_error: BaseException | None = None

        try:
            stream_kwargs: dict[str, Any] = {
                "input": {"messages": [human_message_payload]},
                "config": run_config,
                "stream_mode": ["messages-tuple", "values"],
            }
            if run_context:
                stream_kwargs["context"] = run_context
            async for chunk in client.runs.stream(
                thread_id,
                assistant_id,
                **stream_kwargs,
            ):
                event = getattr(chunk, "event", "")
                data = getattr(chunk, "data", None)

                if event == "messages-tuple":
                    accumulated_text, current_message_id = _accumulate_stream_text(streamed_buffers, current_message_id, data)
                    if accumulated_text:
                        latest_text = accumulated_text
                elif event == "values" and isinstance(data, (dict, list)):
                    last_values = data
                    snapshot_text = _extract_response_text(data)
                    if snapshot_text:
                        latest_text = snapshot_text

                if not latest_text or latest_text == last_published_text:
                    continue

                now = time.monotonic()
                if last_published_text and now - last_publish_at < STREAM_UPDATE_MIN_INTERVAL_SECONDS:
                    continue

                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel_name=msg.channel_name,
                        chat_id=msg.chat_id,
                        thread_id=thread_id,
                        text=latest_text,
                        is_final=False,
                        thread_ts=msg.thread_ts,
                    )
                )
                last_published_text = latest_text
                last_publish_at = now
        except Exception as exc:
            stream_error = exc
            logger.exception("[Manager] streaming error: thread_id=%s", thread_id)
        finally:
            result = last_values if last_values is not None else {"messages": [{"type": "ai", "content": latest_text}]}
            response_text = _extract_response_text(result)
            artifacts = _extract_artifacts(result)
            response_text, attachments = _prepare_artifact_delivery(thread_id, response_text, artifacts)

            if not response_text:
                if attachments:
                    response_text = _format_artifact_text([attachment.virtual_path for attachment in attachments])
                elif stream_error:
                    response_text = "An error occurred while processing your request. Please try again."
                else:
                    response_text = latest_text or "(No response from agent)"

            logger.info(
                "[Manager] streaming response completed: thread_id=%s, response_len=%d, artifacts=%d, error=%s",
                thread_id,
                len(response_text),
                len(artifacts),
                stream_error,
            )
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel_name=msg.channel_name,
                    chat_id=msg.chat_id,
                    thread_id=thread_id,
                    text=response_text,
                    artifacts=artifacts,
                    attachments=attachments,
                    is_final=True,
                    thread_ts=msg.thread_ts,
                )
            )

    # -- command handling --------------------------------------------------

    async def _handle_command(self, msg: InboundMessage) -> None:
        text = msg.text.strip()
        parts = text.split(maxsplit=1)
        command = parts[0].lower().lstrip("/")

        if command == "new":
            # Create a new thread on the LangGraph Server
            client = self._get_client()
            thread = await client.threads.create()
            new_thread_id = thread["thread_id"]
            self.store.set_thread_id(
                msg.channel_name,
                msg.chat_id,
                new_thread_id,
                topic_id=msg.topic_id,
                user_id=msg.user_id,
            )
            reply = "New conversation started."
        elif command == "status":
            thread_id = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=msg.topic_id)
            reply = f"Active thread: {thread_id}" if thread_id else "No active conversation."
        elif command == "models":
            reply = await self._fetch_gateway("/api/models", "models")
        elif command == "memory":
            reply = await self._fetch_gateway("/api/memory", "memory")
        elif command == "help":
            reply = "Available commands:\n/new — Start a new conversation\n/status — Show current thread info\n/models — List available models\n/memory — Show memory status\n/help — Show this help"
        else:
            reply = f"Unknown command: /{command}. Type /help for available commands."

        outbound = OutboundMessage(
            channel_name=msg.channel_name,
            chat_id=msg.chat_id,
            thread_id=self.store.get_thread_id(msg.channel_name, msg.chat_id) or "",
            text=reply,
            thread_ts=msg.thread_ts,
        )
        await self.bus.publish_outbound(outbound)

    async def _fetch_gateway(self, path: str, kind: str) -> str:
        """Fetch data from the Gateway API for command responses."""
        import httpx

        try:
            async with httpx.AsyncClient() as http:
                resp = await http.get(f"{self._gateway_url}{path}", timeout=10)
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            logger.exception("Failed to fetch %s from gateway", kind)
            return f"Failed to fetch {kind} information."

        if kind == "models":
            names = [m["name"] for m in data.get("models", [])]
            return ("Available models:\n" + "\n".join(f"• {n}" for n in names)) if names else "No models configured."
        elif kind == "memory":
            facts = data.get("facts", [])
            return f"Memory contains {len(facts)} fact(s)."
        return str(data)

    # -- error helper ------------------------------------------------------

    async def _send_error(self, msg: InboundMessage, error_text: str) -> None:
        outbound = OutboundMessage(
            channel_name=msg.channel_name,
            chat_id=msg.chat_id,
            thread_id=self.store.get_thread_id(msg.channel_name, msg.chat_id) or "",
            text=error_text,
            thread_ts=msg.thread_ts,
        )
        await self.bus.publish_outbound(outbound)
