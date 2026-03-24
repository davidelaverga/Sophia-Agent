"""SessionStateMiddleware — reads latest handoff, injects smart opener on turn 1.

Position 8 in chain. Reads users/{user_id}/handoffs/latest.md.
On turn_count == 0, injects the smart_opener from handoff YAML frontmatter.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class SessionStateMiddleware:
    """Inject session continuity: handoff context + smart opener."""

    runs_during_crisis = False

    def __init__(self, user_id: str):
        self._user_id = user_id

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        handoff_path = Path(f"users/{self._user_id}/handoffs/latest.md")
        if not handoff_path.exists():
            return state

        content = handoff_path.read_text()
        state.setdefault("system_prompt_blocks", []).append(content)

        # Smart opener: inject on first turn only
        if state.get("turn_count", 0) == 0:
            opener = self._extract_smart_opener(content)
            if opener:
                state.setdefault("system_prompt_blocks", []).append(
                    f"<first_turn_instruction>Open with: {opener}</first_turn_instruction>"
                )

        return state

    @staticmethod
    def _extract_smart_opener(handoff_content: str) -> str | None:
        """Extract smart_opener from YAML frontmatter."""
        if not handoff_content.startswith("---"):
            return None
        try:
            end = handoff_content.index("---", 3)
            frontmatter = handoff_content[3:end]
            for line in frontmatter.splitlines():
                if line.strip().startswith("smart_opener:"):
                    return line.split(":", 1)[1].strip().strip('"').strip("'")
        except ValueError:
            pass
        return None
