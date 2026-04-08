"""Mem0 memory extraction from completed session transcripts.

Uses Claude Haiku + the mem0_extraction.md prompt template to extract
structured observations from a session, then writes each memory to Mem0
via add_memories() with full metadata and status="pending_review".
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import anthropic

from deerflow.sophia.mem0_client import add_memories

logger = logging.getLogger(__name__)

# Path to the extraction prompt template
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_EXTRACTION_TEMPLATE_PATH = _PROMPTS_DIR / "mem0_extraction.md"

# Model for all pipeline LLM calls (per spec)
_PIPELINE_MODEL = "claude-haiku-4-5-20251001"


def _load_template() -> str:
    """Load the mem0_extraction.md prompt template."""
    return _EXTRACTION_TEMPLATE_PATH.read_text(encoding="utf-8")


def _format_transcript(messages: list[dict]) -> str:
    """Format messages as 'User: ...' / 'Sophia: ...' pairs."""
    lines = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if not content:
            continue
        if role == "user":
            lines.append(f"User: {content}")
        elif role in ("assistant", "ai"):
            lines.append(f"Sophia: {content}")
    return "\n\n".join(lines)


def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code block fences (```json ... ```) if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        # Remove first line (```json or ```)
        lines = lines[1:]
        # Remove last line if it's ```
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines)
    return stripped.strip()


def extract_session_memories(
    user_id: str,
    session_id: str,
    messages: list[dict],
    session_metadata: dict | None = None,
) -> list[dict]:
    """Extract memories from a completed session transcript.

    Loads the mem0_extraction.md template, fills it with the session
    transcript and metadata, calls Claude Haiku to extract structured
    observations, then writes each memory to Mem0 via add_memories().

    Args:
        user_id: The user ID.
        session_id: The session/run ID.
        messages: List of message dicts with 'role' and 'content' keys.
        session_metadata: Optional dict with keys like 'context_mode',
            'ritual_type', 'platform', 'tone_start', 'tone_end'.

    Returns:
        List of memory dicts that were written to Mem0. Empty list on
        error or if no memories were extracted.
    """
    logger.info(
        "session.finalization extraction_start user_id=%s session_id=%s message_count=%s",
        user_id,
        session_id,
        len(messages),
    )

    if not messages:
        logger.info("Empty transcript for session %s — skipping extraction", session_id)
        return []

    metadata = session_metadata or {}
    session_date = metadata.get("session_date", datetime.now(UTC).strftime("%Y-%m-%d"))

    # Format the transcript
    transcript = _format_transcript(messages)
    if not transcript.strip():
        logger.info("No user/assistant content in session %s — skipping extraction", session_id)
        return []

    # Load and fill the template
    try:
        template = _load_template()
    except FileNotFoundError:
        logger.error("Extraction template not found at %s", _EXTRACTION_TEMPLATE_PATH)
        return []

    # Use manual replacement instead of str.format() because the template
    # contains literal JSON curly braces that would conflict with format().
    replacements = {
        "{transcript}": transcript,
        "{artifacts}": str(metadata.get("artifacts", "None")),
        "{session_date}": session_date,
        "{context_mode}": metadata.get("context_mode", "life"),
        "{ritual_type}": str(metadata.get("ritual_type", "None")),
        "{tone_start}": str(metadata.get("tone_start", "unknown")),
        "{tone_end}": str(metadata.get("tone_end", "unknown")),
        "{session_id}": session_id,
        "{existing_memories}": str(metadata.get("existing_memories", "None")),
    }
    prompt = template
    for placeholder, value in replacements.items():
        prompt = prompt.replace(placeholder, value)

    # Call Claude Haiku via Anthropic SDK
    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=_PIPELINE_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = response.content[0].text
    except Exception:
        logger.error("Anthropic API call failed for session %s", session_id, exc_info=True)
        return []

    # Parse JSON response
    try:
        cleaned = _strip_markdown_fences(response_text)
        extracted = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "Failed to parse extraction response for session %s: %s",
            session_id,
            response_text[:200] if response_text else "(empty)",
        )
        return []

    if not isinstance(extracted, list):
        logger.error("Extraction response is not a list for session %s", session_id)
        return []

    logger.info(
        "session.finalization extraction_candidates user_id=%s session_id=%s candidate_count=%s",
        user_id,
        session_id,
        len(extracted),
    )

    # Write each extracted memory to Mem0
    written_memories: list[dict] = []
    platform = metadata.get("platform", "text")
    context_mode = metadata.get("context_mode", "life")

    for entry in extracted:
        if not isinstance(entry, dict) or not entry.get("content"):
            continue

        importance_score = entry.get("importance", 0.5)
        if importance_score >= 0.8:
            importance_label = "structural"
        elif importance_score >= 0.4:
            importance_label = "potential"
        else:
            importance_label = "contextual"

        mem0_metadata = {
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "confidence": entry.get("confidence", 0.5),
            "status": "pending_review",
            "platform": platform,
            "context_mode": context_mode,
        }

        # Include tone_estimate if present in the entry metadata
        entry_meta = entry.get("metadata", {})
        if entry_meta.get("tone_estimate") is not None:
            mem0_metadata["tone_estimate"] = entry_meta["tone_estimate"]

        # Include ritual_phase if present
        if entry_meta.get("ritual_phase"):
            mem0_metadata["ritual_phase"] = entry_meta["ritual_phase"]

        # Include target_date if present
        if entry.get("target_date"):
            mem0_metadata["target_date"] = entry["target_date"]

        # Include tags if present
        if entry_meta.get("tags"):
            mem0_metadata["tags"] = entry_meta["tags"]

        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
        )

        written_memories.append({
            "content": entry["content"],
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "mem0_result": result,
        })

        logger.info(
            "session.finalization extraction_memory_written user_id=%s session_id=%s category=%s importance=%s",
            user_id,
            session_id,
            entry.get("category", "fact"),
            importance_label,
        )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        user_id,
        session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
