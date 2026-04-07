"""Session handoff generation for Sophia.

Generates the handoff markdown document written to
users/{user_id}/handoffs/latest.md. The handoff includes YAML frontmatter
with a smart_opener field that SessionStateMiddleware parses on the next
session's first turn.

The handoff is always overwritten, never accumulated (per spec).
"""

import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import anthropic

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_TEMPLATE_PATH = _PROMPTS_DIR / "session_state_assembly.md"

_FALLBACK_HANDOFF_BODY = (
    "## Summary\n"
    "Brief session with limited context available.\n\n"
    "## Tone Arc\n"
    "Insufficient data.\n\n"
    "## Next Steps\n"
    "- Continue from where we left off.\n\n"
    "## Decisions\n"
    "No decisions this session.\n\n"
    "## Open Threads\n"
    "None identified.\n\n"
    "## What Worked / What Didn't\n"
    "Insufficient data.\n\n"
    "## Feeling\n"
    "Session too brief to characterize."
)


def _load_template() -> str:
    """Load the session state assembly prompt template."""
    return _TEMPLATE_PATH.read_text(encoding="utf-8")


def _format_messages_as_transcript(messages: list) -> str:
    """Format LangChain messages into a readable transcript.

    Handles both plain string content and multimodal list-of-dicts content.
    """
    if not messages:
        return "(empty session)"

    lines = []
    for msg in messages:
        role = getattr(msg, "type", "unknown")
        content = getattr(msg, "content", "")
        if isinstance(content, list):
            content = " ".join(
                p.get("text", "") for p in content if isinstance(p, dict)
            )
        content = str(content).strip()
        if content:
            label = "User" if role == "human" else "Sophia" if role == "ai" else role.title()
            lines.append(f"{label}: {content}")
    return "\n".join(lines) if lines else "(empty session)"


def _format_artifacts(artifacts: list[dict] | None) -> str:
    """Format artifact dicts into a readable summary for the prompt."""
    if not artifacts:
        return "No artifacts available."

    lines = []
    for i, art in enumerate(artifacts, 1):
        parts = [f"Turn {i}:"]
        for key in ("tone_estimate", "tone_target", "active_tone_band",
                     "skill_loaded", "session_goal", "active_goal",
                     "next_step", "reflection", "ritual_phase"):
            val = art.get(key)
            if val is not None:
                parts.append(f"  {key}: {val}")
        lines.append("\n".join(parts))
    return "\n\n".join(lines)


def _format_memories(memories: list[dict] | None) -> str:
    """Format extracted memory dicts for the prompt."""
    if not memories:
        return "No memories extracted yet."

    lines = []
    for mem in memories:
        content = mem.get("content", mem.get("memory", ""))
        category = mem.get("category", "unknown")
        if content:
            lines.append(f"- [{category}] {content}")
    return "\n".join(lines) if lines else "No memories extracted yet."


def _build_frontmatter(
    session_id: str,
    smart_opener: str,
    session_date: str | None = None,
) -> str:
    """Build YAML frontmatter block for the handoff file.

    The smart_opener field must be parseable by the regex in
    SessionStateMiddleware._extract_smart_opener():
        ^smart_opener:\\s*[\"']?(.+?)[\"']?\\s*$
    """
    now = datetime.now(UTC)
    date_str = session_date or now.strftime("%Y-%m-%d")
    iso_ts = now.isoformat()

    return (
        "---\n"
        f"schema_version: 1\n"
        f"session_id: {session_id}\n"
        f"created: {iso_ts}\n"
        f"session_date: {date_str}\n"
        f"smart_opener: \"{smart_opener.replace(chr(34), '').replace(chr(39), '')}\"\n"
        "---\n"
    )


def generate_handoff(
    user_id: str,
    session_id: str,
    messages: list,
    artifacts: list[dict] | None = None,
    extracted_memories: list[dict] | None = None,
    smart_opener_text: str | None = None,
) -> Path:
    """Generate and write the session handoff file.

    Loads the session_state_assembly.md template, formats the session
    transcript, calls Claude Haiku to generate the handoff body, prepends
    YAML frontmatter with the smart_opener, and writes atomically to
    users/{user_id}/handoffs/latest.md.

    Args:
        user_id: The user identifier.
        session_id: The session identifier.
        messages: List of LangChain message objects from the session.
        artifacts: List of emit_artifact dicts from the session.
        extracted_memories: Memories extracted by the extraction step.
        smart_opener_text: Pre-generated smart opener, or None for fallback.

    Returns:
        Path to the written handoff file.

    Raises:
        ValueError: If user_id is invalid (path traversal attempt).
    """
    handoff_path = safe_user_path(USERS_DIR, user_id, "handoffs", "latest.md")

    opener = smart_opener_text or "How are you doing today?"
    session_date = datetime.now(UTC).strftime("%Y-%m-%d")

    # Generate the handoff body via LLM, or use fallback
    handoff_body = _generate_handoff_body(
        messages=messages,
        artifacts=artifacts,
        extracted_memories=extracted_memories,
        session_id=session_id,
        session_date=session_date,
    )

    # Assemble the full file
    frontmatter = _build_frontmatter(
        session_id=session_id,
        smart_opener=opener,
        session_date=session_date,
    )
    full_content = frontmatter + "\n" + handoff_body

    # Atomic write: temp file + rename
    handoff_path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_path_str = tempfile.mkstemp(
        dir=str(handoff_path.parent),
        suffix=".tmp",
        prefix="handoff_",
    )
    temp_path = Path(temp_path_str)
    try:
        with open(temp_fd, "w", encoding="utf-8") as f:
            f.write(full_content)
        temp_path.replace(handoff_path)
    except Exception:
        # Clean up temp file on failure
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    logger.info("Handoff written for user %s session %s at %s", user_id, session_id, handoff_path)
    return handoff_path


def _generate_handoff_body(
    messages: list,
    artifacts: list[dict] | None,
    extracted_memories: list[dict] | None,
    session_id: str,
    session_date: str,
) -> str:
    """Call Claude Haiku to generate the handoff markdown body.

    Falls back to a minimal handoff on any failure.
    """
    if not messages:
        return _FALLBACK_HANDOFF_BODY

    try:
        template = _load_template()
    except FileNotFoundError:
        logger.warning("Session state template not found at %s", _TEMPLATE_PATH)
        return _FALLBACK_HANDOFF_BODY

    # Fill template placeholders
    transcript = _format_messages_as_transcript(messages)
    artifacts_text = _format_artifacts(artifacts)
    memories_text = _format_memories(extracted_memories)

    prompt = template.replace("{previous_handoff}", "No previous handoff available.")
    prompt = prompt.replace("{artifacts}", artifacts_text)
    prompt = prompt.replace("{mem0_session_memories}", memories_text)
    prompt = prompt.replace("{mem0_cross_platform_memories}", "None available.")
    prompt = prompt.replace("{session_date}", session_date)
    prompt = prompt.replace("{context_mode}", "life")
    prompt = prompt.replace("{ritual_type}", "none")
    prompt = prompt.replace("{turn_count}", str(len(messages)))
    prompt = prompt.replace("{iso_timestamp}", datetime.now(UTC).isoformat())
    prompt = prompt.replace("{final_tone}", "unknown")

    # Append the transcript as additional context
    prompt += f"\n\n## Session Transcript\n{transcript}"

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )

        body = ""
        for block in response.content:
            if hasattr(block, "text"):
                body = block.text
                break

        body = body.strip()
        if not body:
            return _FALLBACK_HANDOFF_BODY

        return body

    except Exception:
        logger.warning(
            "Handoff body generation failed for session %s, using fallback",
            session_id,
            exc_info=True,
        )
        return _FALLBACK_HANDOFF_BODY
