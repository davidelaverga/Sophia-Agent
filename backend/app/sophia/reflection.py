"""Reflect flow — POST /api/sophia/{user_id}/reflect.

Multi-query Mem0 retrieval: patterns + feelings + lessons + tone trajectory.
Returns voice_context (spoken by Sophia) + visual_parts (rendered by frontend).
"""

from __future__ import annotations

from pathlib import Path

REFLECT_PROMPT = Path(__file__).parent / "prompts" / "reflect_prompt.md"


async def generate_reflection(
    user_id: str,
    query: str,
    period: str,
) -> dict:
    """Generate reflection response via Claude Haiku + prompt template.

    Returns:
        {"voice_context": str, "visual_parts": list[dict]}
    """
    # TODO(jorge): Implement multi-query Mem0 retrieval + Claude Haiku
    return {
        "voice_context": "",
        "visual_parts": [],
    }
