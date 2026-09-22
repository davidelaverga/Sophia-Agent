"""Shared utilities for the Sophia companion agent."""

import logging
import time
from pathlib import Path

_mw_logger = logging.getLogger("sophia.middleware")


def _extract_text_content(content: object) -> list[str]:
    if content is None:
        return []

    if isinstance(content, str):
        return [content]

    if isinstance(content, dict):
        parts: list[str] = []
        for key in ("text", "content", "value", "input"):
            if key in content:
                parts.extend(_extract_text_content(content[key]))
        return parts

    if isinstance(content, (list, tuple)):
        parts: list[str] = []
        for item in content:
            parts.extend(_extract_text_content(item))
        return parts

    return []


def log_middleware(name: str, context: str, start_time: float) -> None:
    """Log middleware execution with name, context summary, and latency.

    Args:
        name: Middleware class name (e.g. "FileInjectionMiddleware")
        context: Short description of what was added/done (e.g. "3 files injected")
        start_time: Result of time.perf_counter() captured at method entry
    """
    elapsed_ms = (time.perf_counter() - start_time) * 1000
    _mw_logger.info("[%s] %s (%.2fms)", name, context, elapsed_ms)

# Re-exported from deerflow.sophia.user_id, which owns the definition. It moved
# there so callers that must not import the agent stack -- the voice service
# signs its LangGraph requests and needs this validator -- can reach it without
# pulling in deerflow/agents/__init__ and therefore langgraph. Every existing
# caller of these names keeps working unchanged.
from deerflow.sophia.user_id import _USER_ID_PATTERN, validate_user_id  # noqa: E402, F401


def safe_user_path(base_dir: Path, user_id: str, *segments: str) -> Path:
    """Build a path under base_dir for a user, rejecting traversal attempts.

    Validates user_id, constructs the path, then verifies the resolved
    path stays within the base directory (defense in depth).
    Uses Path.is_relative_to() for cross-platform correctness.
    """
    validate_user_id(user_id)
    target = (base_dir / user_id / Path(*segments) if segments
              else base_dir / user_id)
    resolved = target.resolve()
    base_resolved = base_dir.resolve()
    if not resolved.is_relative_to(base_resolved):
        raise ValueError("Path traversal detected")
    return target


def extract_last_message_text(messages: list) -> str:
    """Extract text content from the last message in a list.

    Handles both plain string content and multimodal list-of-dicts content
    format from LangChain messages. Returns empty string if no messages
    or no text content found.
    """
    if not messages:
        return ""

    preferred_messages = [
        message
        for message in reversed(messages)
        if getattr(message, "type", None) in ("human", "user")
    ]
    candidates = preferred_messages or list(reversed(messages))

    for message in candidates:
        content = getattr(message, "content", "")
        parts = [part.strip() for part in _extract_text_content(content) if part and part.strip()]
        if parts:
            return " ".join(parts)

    return ""


# ---------------------------------------------------------------------------
# Shared "last human message" extraction (Builder synthesis + Mem0 retrieval).
#
# Two builder middlewares need the same primitive: walk a messages list
# backwards, find the latest human turn, and return its text. Keeping the
# logic inline in each middleware bumps both functions over CC=15 (sentrux
# threshold). Splitting into small helpers below keeps each piece at CC<=5
# and lets both call sites share a single 1-line wrapper.
# ---------------------------------------------------------------------------


def _read_msg_role_and_content(msg) -> tuple[str | None, object]:
    """Read role + content from a LangChain BaseMessage OR a dict.

    Supports both the LangChain object shape (``msg.type`` / ``msg.content``)
    and the raw dict shape (``msg["type"]`` or ``msg["role"]``) used by
    LangGraph SDK ``runs.wait`` results and channel-adapter inputs.
    """
    msg_type = getattr(msg, "type", None) or getattr(msg, "role", None)
    content = getattr(msg, "content", None)
    if msg_type is None and isinstance(msg, dict):
        msg_type = msg.get("type") or msg.get("role")
        content = msg.get("content")
    return msg_type, content


def _flatten_message_text(content: object) -> str | None:
    """Return the trimmed text of ``content`` or None when empty.

    Handles plain strings AND content-block lists (the multimodal shape
    Anthropic uses, e.g. ``[{"type": "text", "text": "..."}]``). Drops
    blocks that aren't text.
    """
    if isinstance(content, str):
        text = content.strip()
        return text or None
    if isinstance(content, list):
        parts = [_block_text_or_empty(block) for block in content]
        text = "".join(parts).strip()
        return text or None
    return None


def _block_text_or_empty(block) -> str:
    if isinstance(block, dict) and block.get("type") == "text":
        return str(block.get("text", ""))
    if isinstance(block, str):
        return block
    return ""


def extract_last_human_text(messages) -> str | None:
    """Return the trimmed text of the last human message, or None.

    Used by ``BuilderTaskMiddleware`` (synthesise delegation_context from
    the user's first message) and ``BuilderMem0RetrievalMiddleware``
    (build the Mem0 search query when no delegation_context exists yet).
    Both call sites collapsed into this one helper to stay under
    sentrux's complexity threshold.
    """
    for msg in reversed(messages or []):
        msg_type, content = _read_msg_role_and_content(msg)
        if msg_type not in {"human", "user"}:
            continue
        text = _flatten_message_text(content)
        if text:
            return text
    return None
