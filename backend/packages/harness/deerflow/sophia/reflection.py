"""Reflect flow — generates voice context and visual parts from user memories.

Called by the gateway reflect endpoint. Uses Claude Haiku to synthesize
a spoken summary and structured visual data from the user's Mem0 memories.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def generate_reflection(
    user_id: str,
    query: str,
    period: str = "overall",
) -> dict:
    """Generate a reflection with voice context and visual parts.

    Args:
        user_id: The user identifier.
        query: What the user wants to reflect on.
        period: Time scope — "this_week", "this_month", or "overall".

    Returns:
        Dict with ``voice_context`` (str) and ``visual_parts`` (list[dict]).
    """
    # 1. Gather memories from Mem0
    memories_text = _gather_memories(user_id, query)

    # 2. Load and fill prompt template
    template_path = _PROMPTS_DIR / "reflect_prompt.md"
    if not template_path.exists():
        logger.warning("Reflect prompt template not found: %s", template_path)
        return {
            "voice_context": f"I looked at your memories about {query}, but I don't have enough context yet.",
            "visual_parts": [],
        }

    template = template_path.read_text(encoding="utf-8")
    prompt = template.replace("{query}", query)
    prompt = prompt.replace("{period}", period)
    prompt = prompt.replace("{memories}", memories_text)
    prompt = prompt.replace("{user_id}", user_id)

    # 3. Call Claude Haiku
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text if response.content else ""
    except Exception:
        logger.warning("Anthropic call failed for reflect", exc_info=True)
        return {
            "voice_context": f"I tried to reflect on {query}, but something went wrong. Let's talk about it directly.",
            "visual_parts": [],
        }

    # 4. Parse response
    return _parse_reflect_response(raw, query)


def _gather_memories(user_id: str, query: str) -> str:
    """Search Mem0 for relevant memories and format as text."""
    try:
        from deerflow.sophia.mem0_client import search_memories

        results = search_memories(user_id=user_id, query=query)
        if not results:
            return "(No memories available)"
        lines = []
        for mem in results[:15]:
            content = mem.get("content", mem.get("memory", ""))
            if content:
                lines.append(f"- {content}")
        return "\n".join(lines) if lines else "(No memories available)"
    except Exception:
        logger.warning("Memory search failed for reflect", exc_info=True)
        return "(Memory search unavailable)"


def _parse_reflect_response(raw: str, query: str) -> dict:
    """Parse the LLM response into voice_context + visual_parts."""
    # Try to extract JSON if the response contains it
    voice_context = raw
    visual_parts = []

    # Look for JSON block in response
    if "```json" in raw:
        try:
            json_start = raw.index("```json") + 7
            json_end = raw.index("```", json_start)
            parsed = json.loads(raw[json_start:json_end].strip())
            if isinstance(parsed, dict):
                voice_context = parsed.get("voice_context", raw)
                visual_parts = parsed.get("visual_parts", [])
                return {"voice_context": voice_context, "visual_parts": visual_parts}
        except (ValueError, json.JSONDecodeError):
            pass

    # Try parsing the whole response as JSON
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {
                "voice_context": parsed.get("voice_context", raw),
                "visual_parts": parsed.get("visual_parts", []),
            }
    except json.JSONDecodeError:
        pass

    # Fallback: entire response is voice context, no visual parts
    return {"voice_context": voice_context, "visual_parts": visual_parts}
