"""Smart opener generation — offline pipeline step 1.

A single warm sentence injected by SessionStateMiddleware on
turn_count == 0 only. Stored in handoff YAML frontmatter.

Prompt template: prompts/smart_opener_assembly.md
NOTE: smart_opener_assembly.md must NOT reference {cross_platform_memories}.
"""

from __future__ import annotations

from pathlib import Path

OPENER_PROMPT = Path(__file__).parent / "prompts" / "smart_opener_assembly.md"


async def generate_smart_opener(
    user_id: str,
    previous_handoff: str | None,
    session_artifacts: list[dict],
    session_memories: list[dict],
) -> str:
    """Generate the smart opener for the next session via Claude Haiku."""
    # TODO(jorge): Implement via Anthropic SDK + prompt template
    return "How are you doing today?"
