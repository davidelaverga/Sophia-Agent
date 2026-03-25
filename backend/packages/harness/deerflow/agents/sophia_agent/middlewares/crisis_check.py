"""Crisis fast-path middleware.

Detects crisis language in the user's last message and sets state flags
that cause downstream middlewares to short-circuit. Only soul.md and
crisis_redirect.md are injected on the crisis path.
"""

import re
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

CRISIS_SIGNALS = [
    # Direct expressions
    "want to die",
    "wanna die",
    "wana die",
    "kill myself",
    "wanna kill myself",
    "end it all",
    "don't want to be here",
    "dont want to be here",
    "hurt myself",
    "self harm",
    "suicide",
    "not worth living",
    "can't go on",
    "cant go on",
    "want to disappear",
    # Abbreviations / euphemisms
    "kms",
    "ctb",
    # Indirect expressions
    "don't want to be alive",
    "dont want to be alive",
    "better off dead",
    "no reason to live",
    "everyone would be better off without me",
    "thinking about ending it",
    "want to end my life",
    "i want to end it",
    "no point in living",
    "wish i was dead",
    "wish i were dead",
    "i can't do this anymore",
    "i cant do this anymore",
    "i give up on life",
    "take my own life",
    "don't want to exist",
    "dont want to exist",
    "want it to be over",
    "tired of being alive",
    "not worth it anymore",
    "can't take it anymore",
    "cant take it anymore",
]

# Abbreviation signals that must be matched as whole words to avoid
# false positives (e.g. "kms" should not match inside "bookmarks").
_WHOLE_WORD_SIGNALS = frozenset({"kms", "ctb"})

_REPEATED_CHAR_RE = re.compile(r"(.)\1{2,}")
_NON_ALNUM_SPACE_RE = re.compile(r"[^a-z0-9 ]")
_MULTI_SPACE_RE = re.compile(r" {2,}")


def _normalize_text(text: str) -> str:
    """Normalize text for crisis signal matching.

    1. Lowercase
    2. Collapse 3+ repeated characters to 1 (e.g. "dieee" -> "die")
    3. Strip non-alphanumeric characters except spaces
    4. Collapse multiple spaces to single space
    5. Strip leading/trailing whitespace
    """
    text = text.lower()
    text = _REPEATED_CHAR_RE.sub(r"\1", text)
    text = _NON_ALNUM_SPACE_RE.sub("", text)
    text = _MULTI_SPACE_RE.sub(" ", text)
    return text.strip()


# Pre-normalize signals at import time for fast matching.
_NORMALIZED_SIGNALS: list[tuple[str, bool]] = []
for _sig in CRISIS_SIGNALS:
    _norm = _normalize_text(_sig)
    _is_whole_word = _sig in _WHOLE_WORD_SIGNALS
    _NORMALIZED_SIGNALS.append((_norm, _is_whole_word))


def _contains_signal(normalized_content: str) -> bool:
    """Check whether normalized content contains any crisis signal."""
    for signal, whole_word in _NORMALIZED_SIGNALS:
        if whole_word:
            # Match as whole word using word boundary check
            if re.search(r"(?<![a-z0-9])" + re.escape(signal) + r"(?![a-z0-9])", normalized_content):
                return True
        else:
            if signal in normalized_content:
                return True
    return False


class CrisisCheckState(AgentState):
    force_skill: NotRequired[str | None]
    skip_expensive: NotRequired[bool]


class CrisisCheckMiddleware(AgentMiddleware[CrisisCheckState]):
    """Detect crisis language and activate the fast-path."""

    state_schema = CrisisCheckState

    @override
    def before_agent(self, state: CrisisCheckState, runtime: Runtime) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        last_message = messages[-1]
        content = getattr(last_message, "content", "")
        if isinstance(content, list):
            content = " ".join(
                p.get("text", "") for p in content if isinstance(p, dict)
            )
        normalized = _normalize_text(str(content))

        if _contains_signal(normalized):
            return {
                "force_skill": "crisis_redirect",
                "skip_expensive": True,
            }

        return None
