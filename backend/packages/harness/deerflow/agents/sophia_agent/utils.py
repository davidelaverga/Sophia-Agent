"""Shared utilities for the Sophia companion agent."""

import logging
import re
import time
from pathlib import Path

_mw_logger = logging.getLogger("sophia.middleware")


def log_middleware(name: str, context: str, start_time: float) -> None:
    """Log middleware execution with name, context summary, and latency.

    Args:
        name: Middleware class name (e.g. "FileInjectionMiddleware")
        context: Short description of what was added/done (e.g. "3 files injected")
        start_time: Result of time.perf_counter() captured at method entry
    """
    elapsed_ms = (time.perf_counter() - start_time) * 1000
    _mw_logger.info("[%s] %s (%.1fms)", name, context, elapsed_ms)

# Strict allowlist for user identifiers used in file paths
_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_user_id(user_id: str) -> str:
    """Validate a user_id against a strict allowlist pattern.

    Raises ValueError if the user_id contains characters that could
    enable path traversal or other injection attacks.
    """
    if not user_id or not _USER_ID_PATTERN.match(user_id):
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
    last_message = messages[-1]
    content = getattr(last_message, "content", "")
    if isinstance(content, list):
        content = " ".join(
            p.get("text", "") for p in content if isinstance(p, dict)
        )
    return str(content)
