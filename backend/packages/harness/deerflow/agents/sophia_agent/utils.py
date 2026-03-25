"""Shared utilities for the Sophia companion agent."""

import re
from pathlib import Path

# Strict allowlist for user identifiers used in file paths
_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_user_id(user_id: str) -> str:
    """Validate a user_id against a strict allowlist pattern.

    Raises ValueError if the user_id contains characters that could
    enable path traversal or other injection attacks.
    """
    if not user_id or not _USER_ID_PATTERN.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")
    return user_id


def safe_user_path(base_dir: Path, user_id: str, *segments: str) -> Path:
    """Build a path under base_dir for a user, rejecting traversal attempts.

    Validates user_id, constructs the path, then verifies the resolved
    path stays within the base directory (defense in depth).
    """
    validate_user_id(user_id)
    target = (base_dir / user_id / Path(*segments) if segments
              else base_dir / user_id)
    resolved = target.resolve()
    base_resolved = base_dir.resolve()
    if not str(resolved).startswith(str(base_resolved) + ("/" if "/" in str(base_resolved) else "\\")):
        # Also check exact match (user_id dir itself)
        if resolved != base_resolved and not resolved.is_relative_to(base_resolved):
            raise ValueError(f"Path traversal detected for user_id: {user_id!r}")
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
