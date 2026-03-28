"""Smart opener generation for Sophia's next session.

Generates a single warm opening sentence using Claude Haiku and the
smart_opener_assembly.md prompt template. The opener is embedded in the
handoff YAML frontmatter and delivered by SessionStateMiddleware on
the first turn of the next session.
"""

import logging
from pathlib import Path

import anthropic

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_TEMPLATE_PATH = _PROMPTS_DIR / "smart_opener_assembly.md"

_FALLBACK_OPENER = "How are you doing today?"


def _load_template() -> str:
    """Load the smart opener prompt template from disk."""
    return _TEMPLATE_PATH.read_text(encoding="utf-8")


def generate_smart_opener(
    user_id: str,
    session_summary: str,
    recent_memories: str | None = None,
    last_handoff: str | None = None,
    days_since_last_session: int = 0,
) -> str:
    """Generate a single-sentence smart opener for the next session.

    Loads the smart_opener_assembly.md template, fills placeholders with
    session context, and calls Claude Haiku to produce one warm opening
    sentence. Returns a fallback opener on any failure.

    Args:
        user_id: The user identifier (for logging).
        session_summary: Summary of the just-completed session.
        recent_memories: Formatted Mem0 memories string, or None.
        last_handoff: Content of the previous handoff file, or None.
        days_since_last_session: Days since the user's previous session.

    Returns:
        A single sentence opener string, stripped of quotes and whitespace.
    """
    if not session_summary:
        return _FALLBACK_OPENER

    try:
        template = _load_template()
    except FileNotFoundError:
        logger.warning("Smart opener template not found at %s", _TEMPLATE_PATH)
        return _FALLBACK_OPENER

    prompt = template.replace("{session_summary}", session_summary)
    prompt = prompt.replace("{recent_memories}", recent_memories or "None available.")
    prompt = prompt.replace("{last_handoff}", last_handoff or "No previous handoff (first session).")
    prompt = prompt.replace("{days_since_last_session}", str(days_since_last_session))

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
            messages=[{"role": "user", "content": prompt}],
        )

        # Extract text from response
        opener = ""
        for block in response.content:
            if hasattr(block, "text"):
                opener = block.text
                break

        # Strip quotes and whitespace
        opener = opener.strip().strip("\"'").strip()

        if not opener:
            return _FALLBACK_OPENER

        return opener

    except Exception:
        logger.warning(
            "Smart opener generation failed for user %s, using fallback",
            user_id,
            exc_info=True,
        )
        return _FALLBACK_OPENER
