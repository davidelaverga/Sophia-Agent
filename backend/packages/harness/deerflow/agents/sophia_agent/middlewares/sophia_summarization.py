"""Sophia-specific summarization middleware.

Extends LangChain's SummarizationMiddleware to:
1. Inject the summary as a system_prompt_block (not a HumanMessage)
2. Extract the emotional arc from emit_artifact tool calls before compression
3. Remove old messages without leaving a HumanMessage that the model echoes

Per spec §04_backend_integration §16:
  Summary block = text summary + emotional arc.
  Preserves emotional continuity through compression.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import AnyMessage, HumanMessage, RemoveMessage, ToolMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from deerflow.agents.sophia_agent.utils import log_middleware

# Legacy summary prefix used by LangChain's default SummarizationMiddleware.
# Older checkpointer state may contain HumanMessages with this prefix that
# we need to clean up to prevent the model from echoing them.
_LEGACY_SUMMARY_PREFIXES = (
    "Here is a summary of the conversation to date:",
    "EXTRACTED CONTEXT:",
    "Earlier in this conversation:",
)


def _is_legacy_summary_message(msg: AnyMessage) -> bool:
    if not isinstance(msg, HumanMessage):
        return False
    if not isinstance(msg.content, str):
        return False
    content = msg.content.lstrip()
    return any(content.startswith(p) for p in _LEGACY_SUMMARY_PREFIXES)

logger = logging.getLogger(__name__)


class SophiaSummarizationState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]


class SophiaSummarizationMiddleware(SummarizationMiddleware):
    """Sophia-enhanced summarization that injects summary as a system_prompt_block.

    Key differences from the base SummarizationMiddleware:
    - Does NOT create a HumanMessage with the summary (which Haiku echoes)
    - Instead removes old messages and adds the summary + emotional arc
      as a system_prompt_block in state
    - Extracts emotional arc from emit_artifact tool calls before compression
    """

    state_schema = SophiaSummarizationState

    @override
    def before_model(self, state: SophiaSummarizationState, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        return self._sophia_summarize(state, sync=True)

    @override
    async def abefore_model(self, state: SophiaSummarizationState, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        return self._sophia_summarize(state, sync=False)

    def _sophia_summarize(self, state: SophiaSummarizationState, *, sync: bool) -> dict[str, Any] | None:
        """Core summarization logic that injects into system_prompt_blocks."""
        _t0 = time.perf_counter()
        messages = state["messages"]
        self._ensure_message_ids(messages)

        # --- Legacy cleanup ---
        # If previous runs left summary HumanMessages in the checkpointer
        # (created by the default LangChain SummarizationMiddleware), remove
        # them now so the model doesn't echo them.
        legacy_removals = [m for m in messages if _is_legacy_summary_message(m)]
        if legacy_removals:
            logger.warning(
                "[SophiaSummarization] cleaning up %d legacy summary HumanMessage(s) from state",
                len(legacy_removals),
            )
            return {
                "messages": [RemoveMessage(id=m.id) for m in legacy_removals if m.id is not None],
            }

        total_tokens = self.token_counter(messages)
        total_messages = len(messages)

        if not self._should_summarize(messages, total_tokens):
            logger.info(
                "[SophiaSummarization] skip: %d messages, ~%d tokens (below threshold)",
                total_messages,
                total_tokens,
            )
            return None

        cutoff_index = self._determine_cutoff_index(messages)
        if cutoff_index <= 0:
            logger.info(
                "[SophiaSummarization] skip: cutoff_index=%d (nothing to compress)",
                cutoff_index,
            )
            return None

        messages_to_summarize, preserved_messages = self._partition_messages(messages, cutoff_index)

        logger.info(
            "[SophiaSummarization] TRIGGERED | total_messages=%d | total_tokens≈%d | "
            "compressing=%d | keeping=%d",
            total_messages,
            total_tokens,
            len(messages_to_summarize),
            len(preserved_messages),
        )

        # Extract emotional arc BEFORE compression (per spec §16)
        # We keep ONLY the emotional arc — never the full narrative summary —
        # because Haiku echoes narrative text from the system prompt regardless
        # of XML tags or guard instructions.  The arc is structured key=value
        # data that the model treats as state, not speakable content.
        emotional_arc = _extract_emotional_arc(messages_to_summarize)
        if emotional_arc:
            logger.info(
                "[SophiaSummarization] emotional_arc extracted: %s",
                emotional_arc.replace("\n", " | "),
            )
        else:
            logger.info("[SophiaSummarization] no emit_artifact tool results found for arc")

        # Build system_prompt_block from emotional arc ONLY (no narrative text).
        # Context continuity comes from Mem0 memories + preserved recent messages.
        blocks = list(state.get("system_prompt_blocks", []))
        if emotional_arc:
            blocks.append(
                "<prior_context_state>\n"
                + emotional_arc
                + "\n</prior_context_state>"
            )

        total_ms = (time.perf_counter() - _t0) * 1000
        log_middleware(
            "SophiaSummarization",
            f"compressed {len(messages_to_summarize)} msgs (dropped narrative), "
            f"kept {len(preserved_messages)} msgs, "
            f"arc={'yes' if emotional_arc else 'no'} "
            f"({total_ms:.0f}ms)",
            _t0,
        )

        return {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *preserved_messages,
            ],
            "system_prompt_blocks": blocks,
        }


# ---------------------------------------------------------------------------
# Artifact arc extraction (per spec §04_backend_integration §16)
# ---------------------------------------------------------------------------


def _extract_emotional_arc(messages: list[AnyMessage]) -> str:
    """Extract emotional arc from emit_artifact tool results in compressed messages.

    Per spec: Before compressing old messages, extract emotional arc from
    their emit_artifact tool call results.
    """
    artifacts: list[dict] = []
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        if getattr(msg, "name", None) != "emit_artifact":
            continue
        try:
            content = msg.content
            if isinstance(content, str):
                parsed = json.loads(content)
            elif isinstance(content, dict):
                parsed = content
            else:
                continue
            if isinstance(parsed, dict) and "tone_estimate" in parsed:
                artifacts.append(parsed)
        except (json.JSONDecodeError, TypeError):
            continue

    if not artifacts:
        return ""

    first = artifacts[0]
    last = artifacts[-1]
    skills = list(dict.fromkeys(a.get("skill_loaded", "unknown") for a in artifacts))

    return (
        f"[Emotional arc of summarized turns]\n"
        f"Tone: {first.get('active_tone_band', '?')} ({first.get('tone_estimate', '?')}) "
        f"→ {last.get('active_tone_band', '?')} ({last.get('tone_estimate', '?')})\n"
        f"Skills activated: {', '.join(skills)}"
    )


def _build_summary_block(summary_text: str, emotional_arc: str) -> str:
    """Build a system_prompt_block from the summary text and emotional arc.

    Per spec: Summary block = text summary + emotional arc.
    Preserves emotional continuity through compression.
    """
    parts = ["<prior_context_state>", summary_text]
    if emotional_arc:
        parts.append("")
        parts.append(emotional_arc)
    parts.append("</prior_context_state>")
    return "\n".join(parts)
