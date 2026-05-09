"""Shared utilities for the Sophia companion agent."""

import logging
import re
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

# Strict allowlist for user identifiers used in Sophia state, memory, and file paths.
#
# Production auth providers may issue UUIDs, cuid/nanoid-style ids, or
# namespaced/email-shaped ids. Keep path separators, traversal markers,
# whitespace, shell metacharacters, and NULs rejected; safe_user_path adds an
# is_relative_to() defense-in-depth check for filesystem use.
_USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._@+:|-]{1,128}$")


def validate_user_id(user_id: str) -> str:
    """Validate a user_id against a strict allowlist pattern.

    Raises ValueError if the user_id contains characters that could
    enable path traversal or other injection attacks.
    """
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("Invalid user_id format")
    if user_id != user_id.strip():
        raise ValueError("Invalid user_id format")
    if any(ch in user_id for ch in ("/", "\\", "\x00")) or ".." in user_id:
        raise ValueError("Invalid user_id format")
    if not _USER_ID_PATTERN.match(user_id):
        raise ValueError("Invalid user_id format")
    return user_id


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
