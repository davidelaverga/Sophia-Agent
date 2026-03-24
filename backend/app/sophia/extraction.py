"""Memory extraction — offline pipeline step 3.

Extracts memories from conversation + artifacts via Claude Haiku
and mem0_extraction.md prompt template. All memories written with
status="pending_review".
"""

from __future__ import annotations

from pathlib import Path

EXTRACTION_PROMPT = Path(__file__).parent / "prompts" / "mem0_extraction.md"


async def extract_memories(
    user_id: str,
    session_id: str,
    session_artifacts: list[dict],
) -> list[dict]:
    """Extract memory candidates from session data.

    Returns list of dicts with 'content' and 'metadata' keys.
    All memories have metadata.status = "pending_review".
    """
    # TODO(jorge): Implement extraction via Claude Haiku + prompt template
    return []
