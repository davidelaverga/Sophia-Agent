"""Conditional identity file updater for the offline pipeline.

Reads the user's current identity.md, recent memories, and the
identity_file_update.md prompt template, then calls Claude Haiku to
produce an updated identity file.  The update is triggered when:

- 10+ sessions have elapsed since the last update, OR
- any extracted memory has ``importance == "structural"``, OR
- ``force=True`` is passed.

Both identity.md and the marker file are written atomically (temp file +
rename) to prevent partial writes on crash.
"""

from __future__ import annotations

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)

# How many new sessions before a periodic update is triggered
_SESSION_UPDATE_INTERVAL = 10

# Marker filename stored in each user directory
_MARKER_FILENAME = ".identity_last_update"

# Prompt template location (relative to this file)
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def maybe_update_identity(
    user_id: str,
    extracted_memories: list[dict] | None = None,
    force: bool = False,
) -> bool:
    """Conditionally update the user's identity file.

    Args:
        user_id: The user identifier (validated for path safety).
        extracted_memories: Memories extracted by the extraction step.
            Each dict may contain an ``importance`` key.
        force: If ``True``, always run the update regardless of other
            trigger conditions.

    Returns:
        ``True`` if the identity file was updated, ``False`` otherwise.
    """
    extracted_memories = extracted_memories or []

    try:
        traces_dir = safe_user_path(USERS_DIR, user_id, "traces")
    except ValueError:
        logger.warning("Invalid user_id for identity update: %s", user_id)
        return False

    session_count = _count_sessions(traces_dir)
    last_update_count = _read_marker(user_id)
    sessions_since_update = session_count - last_update_count

    has_structural = any(
        mem.get("importance") == "structural" or
        (isinstance(mem.get("metadata"), dict) and mem["metadata"].get("importance") == "structural")
        for mem in extracted_memories
    )

    triggered = force or has_structural or sessions_since_update >= _SESSION_UPDATE_INTERVAL

    if not triggered:
        logger.debug(
            "Identity update skipped for %s (sessions_since=%d, structural=%s, force=%s)",
            user_id, sessions_since_update, has_structural, force,
        )
        return False

    # Determine trigger reason for the template
    if force:
        trigger_reason = "forced"
    elif has_structural:
        trigger_reason = "structural_memory"
    else:
        trigger_reason = f"session_count ({sessions_since_update} sessions)"

    try:
        return _run_update(
            user_id=user_id,
            session_count=session_count,
            sessions_since_update=sessions_since_update,
            trigger_reason=trigger_reason,
            extracted_memories=extracted_memories,
        )
    except Exception:
        logger.warning(
            "Identity update failed for user %s", user_id, exc_info=True,
        )
        return False


def _run_update(
    user_id: str,
    session_count: int,
    sessions_since_update: int,
    trigger_reason: str,
    extracted_memories: list[dict],
) -> bool:
    """Execute the identity update: read inputs, call LLM, write outputs."""
    # Read current identity file (may not exist yet)
    identity_path = safe_user_path(USERS_DIR, user_id, "identity.md")
    current_identity = ""
    if identity_path.exists():
        current_identity = identity_path.read_text(encoding="utf-8")

    # Load prompt template
    template_path = _PROMPTS_DIR / "identity_file_update.md"
    if not template_path.exists():
        logger.error("Identity update template not found: %s", template_path)
        return False
    template = template_path.read_text(encoding="utf-8")

    # Format memories for the template
    memories_text = _format_memories(extracted_memories)

    # Fill template placeholders
    prompt = template.replace("{current_identity}", current_identity or "(No existing identity file)")
    prompt = prompt.replace("{recent_handoffs}", "(Not available in this pipeline step)")
    prompt = prompt.replace("{mem0_memories_by_category}", memories_text)
    prompt = prompt.replace("{current_date}", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    prompt = prompt.replace("{sessions_since_update}", str(sessions_since_update))
    prompt = prompt.replace("{update_trigger}", trigger_reason)

    # Call Claude Haiku
    import anthropic

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )

    # Extract text from response
    result_text = ""
    for block in response.content:
        if hasattr(block, "text"):
            result_text += block.text

    # Extract the identity file content from between markers
    identity_content = _extract_identity_content(result_text)
    if not identity_content:
        logger.warning("Could not parse identity content from LLM response for user %s", user_id)
        return False

    # Atomic write: identity file
    _atomic_write(identity_path, identity_content)

    # Atomic write: marker file
    _write_marker(user_id, session_count)

    logger.info(
        "Identity updated for user %s (trigger=%s, sessions=%d)",
        user_id, trigger_reason, session_count,
    )
    return True


def _count_sessions(traces_dir: Path) -> int:
    """Count JSON trace files in the traces directory."""
    if not traces_dir.exists():
        return 0
    return sum(1 for f in traces_dir.iterdir() if f.suffix == ".json" and f.is_file())


def _read_marker(user_id: str) -> int:
    """Read the last-update session count from the marker file."""
    try:
        marker_path = safe_user_path(USERS_DIR, user_id, _MARKER_FILENAME)
        if marker_path.exists():
            content = marker_path.read_text(encoding="utf-8").strip()
            return int(content)
    except (ValueError, OSError):
        pass
    return 0


def _write_marker(user_id: str, session_count: int) -> None:
    """Write the current session count to the marker file atomically."""
    marker_path = safe_user_path(USERS_DIR, user_id, _MARKER_FILENAME)
    _atomic_write(marker_path, str(session_count))


def _atomic_write(path: Path, content: str) -> None:
    """Write content to a file atomically via temp file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path_str = tempfile.mkstemp(
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with open(tmp_fd, "w", encoding="utf-8") as f:
            f.write(content)
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _format_memories(memories: list[dict]) -> str:
    """Format extracted memories as text for the prompt template."""
    if not memories:
        return "(No recent memories available)"

    lines = []
    for mem in memories:
        category = mem.get("category", "")
        content = mem.get("content", mem.get("memory", ""))
        importance = mem.get("importance", "")
        if isinstance(mem.get("metadata"), dict):
            importance = importance or mem["metadata"].get("importance", "")
            category = category or mem["metadata"].get("category", "")
        category = category or "unknown"
        line = f"- [{category}] {content}"
        if importance:
            line += f" (importance: {importance})"
        lines.append(line)
    return "\n".join(lines)


def _extract_identity_content(text: str) -> str:
    """Extract content between ---IDENTITY_FILE--- and ---END_IDENTITY_FILE--- markers."""
    start_marker = "---IDENTITY_FILE---"
    end_marker = "---END_IDENTITY_FILE---"

    start_idx = text.find(start_marker)
    if start_idx == -1:
        # Fall back to using the full response if no markers found
        stripped = text.strip()
        return stripped if stripped else ""

    start_idx += len(start_marker)
    end_idx = text.find(end_marker, start_idx)
    if end_idx == -1:
        # Marker opened but not closed — use everything after start
        return text[start_idx:].strip()

    return text[start_idx:end_idx].strip()
