"""Owner identifier validation, shared by every service that signs a request.

This lives under `deerflow.sophia` rather than inside the companion agent
because it is needed by callers that must not import the agent stack. The
voice service signs its LangGraph requests with `langgraph_service_auth`,
which validates the owner before minting; importing that through
`deerflow.agents.sophia_agent.utils` would drag in `deerflow/agents/__init__`
and therefore the checkpointer, lead_agent and langgraph itself, none of which
ship in the voice image.

`deerflow.agents.sophia_agent.utils` re-exports these names, so every existing
caller keeps working unchanged.
"""

from __future__ import annotations

import re

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
