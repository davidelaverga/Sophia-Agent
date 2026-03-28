"""Session state middleware.

Reads the user's handoff file and extracts the smart opener for first-turn
injection. On turn_count == 0, injects a first-turn instruction block.

The opener is only delivered when the user's message is a low-signal greeting
(e.g., "hey", "hi", "hello"). When the user leads with substantive content,
Sophia should respond to THAT, not the canned opener.
"""

import logging
import re
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import extract_last_message_text, safe_user_path

logger = logging.getLogger(__name__)

# Greetings that count as "low-signal" — opener should be delivered
_GREETING_PATTERNS = re.compile(
    r"^(hey|hi|hello|hola|sup|yo|what's up|whats up|howdy|hii+|heyy+|good morning|good evening|good afternoon|gm|"
    r"how are you|how's it going|hows it going|what's good|how you doing)[\s!?.,:;]*$",
    re.IGNORECASE,
)


class SessionStateState(AgentState):
    turn_count: NotRequired[int]
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]
    messages: NotRequired[list]


class SessionStateMiddleware(AgentMiddleware[SessionStateState]):
    """Inject smart opener on first turn from handoff file."""

    state_schema = SessionStateState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id

    def _extract_smart_opener(self, content: str) -> str | None:
        """Extract smart_opener from YAML frontmatter."""
        match = re.search(r"^smart_opener:\s*[\"']?(.+?)[\"']?\s*$", content, re.MULTILINE)
        if match:
            return match.group(1).strip()
        return None

    @staticmethod
    def _is_greeting(text: str) -> bool:
        """Return True if the message is a low-signal greeting."""
        return bool(_GREETING_PATTERNS.match(text.strip()))

    @override
    def before_agent(self, state: SessionStateState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        turn_count = state.get("turn_count", 0)
        if turn_count != 0:
            return None

        try:
            handoff_path = safe_user_path(USERS_DIR, self._user_id, "handoffs", "latest.md")
        except ValueError:
            logger.warning("Invalid user_id for session state: %s", self._user_id)
            return None

        if not handoff_path.exists():
            return None

        try:
            content = handoff_path.read_text(encoding="utf-8")
            opener = self._extract_smart_opener(content)
            if opener:
                # Check if user's message is a low-signal greeting
                user_msg = extract_last_message_text(state.get("messages", []))
                is_greeting = self._is_greeting(user_msg)

                if is_greeting:
                    # Low-signal greeting → deliver the smart opener
                    block = (
                        "<first_turn_instruction>\n"
                        f"This is the first turn of a new session. Open with: \"{opener}\"\n"
                        "Deliver this as your opening line before the user says anything.\n"
                        "</first_turn_instruction>"
                    )
                else:
                    # User led with real content → provide opener as context only
                    block = (
                        "<session_context>\n"
                        f"Planned opener for this session: \"{opener}\"\n"
                        "However, the user already opened with something specific. "
                        "Respond to what they said. Use the opener context to inform "
                        "your understanding but do NOT deliver it as a greeting.\n"
                        "</session_context>"
                    )

                blocks = list(state.get("system_prompt_blocks", []))
                blocks.append(block)
                return {"system_prompt_blocks": blocks}
        except Exception:
            logger.warning("Failed to read handoff for user %s", self._user_id, exc_info=True)

        return None
