"""DelegationLedgerMiddleware — per-turn companion hook for the Spec D ledger.

Appends one entry per completed companion turn to the append-only
per-session ledger (``deerflow.sophia.delegation_ledger``). Sits in the
companion chain immediately after ``ArtifactMiddleware`` — so this turn's
``current_artifact`` is already rotated in — and BEFORE summarization is
appended, so entries are written from un-wiped messages.

Hook contract:
- ``after_agent``/``aafter_agent`` fire once per user turn, including
  turns where ``ArtifactMiddleware`` jumps to "end" (agent-exit hooks
  still run — same mechanism Mem0's offline queueing relies on).
- The local append is sub-millisecond and never raises.
- The Supabase mirror runs on a fire-and-forget task (strong-ref set,
  discard-on-done — the BuilderProgressMiddleware ``_POST_TASKS``
  pattern). NEVER await it inline: that would add 100-300ms per turn.

Privacy (Spec D AD-6): no conversation content in logs — IDs and counts
only (enforced in ``delegation_ledger``'s logging vocabulary).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import extract_last_human_text
from deerflow.sophia import delegation_ledger

logger = logging.getLogger(__name__)

# Strong refs to in-flight mirror tasks so they survive GC; bounded via
# add_done_callback(discard) — see BuilderProgressMiddleware._POST_TASKS.
_MIRROR_TASKS: set[asyncio.Task] = set()


def _resolve_user_id(state: AgentState, runtime: Runtime) -> str | None:
    """state (UserIdentityMiddleware) → config.configurable → context."""
    candidate = state.get("user_id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    config = getattr(runtime, "config", None) or {}
    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    candidate = configurable.get("user_id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    context = getattr(runtime, "context", None) or {}
    candidate = context.get("user_id") if isinstance(context, dict) else None
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


def _resolve_thread_id(runtime: Runtime) -> str | None:
    """context → config.configurable (read_user_document pattern)."""
    context = getattr(runtime, "context", None) or {}
    if isinstance(context, dict):
        candidate = context.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    config = getattr(runtime, "config", None) or {}
    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    candidate = configurable.get("thread_id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


def _last_ai_tool_names(messages: list[Any]) -> list[str]:
    """Tool names on the latest AI message (deliverable-intent lifecycle branch)."""
    for msg in reversed(messages or []):
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", []) or []
        return [tc.get("name", "") for tc in tool_calls if isinstance(tc, dict)]
    return []


class DelegationLedgerMiddleware(AgentMiddleware[AgentState]):
    """Append one ledger entry per companion turn (Spec D D-1)."""

    def _append_entry(self, state: AgentState, runtime: Runtime) -> tuple[str, str] | None:
        """Build + append this turn's entry. Returns (user_id, thread_id) on success."""
        if not delegation_ledger.ledger_enabled():
            return None
        user_id = _resolve_user_id(state, runtime)
        thread_id = _resolve_thread_id(runtime)
        if not user_id or not thread_id:
            logger.info(
                "[DelegationLedger] skip: unresolved ids (user=%s thread=%s)",
                bool(user_id),
                bool(thread_id),
            )
            return None

        messages = state.get("messages", []) or []
        user_text = extract_last_human_text(messages) or ""
        entry = delegation_ledger.build_entry(
            delegation_ledger.next_turn_number(
                user_id, thread_id, int(state.get("turn_count", 0) or 0)
            ),
            user_text,
            state.get("current_artifact"),
            _last_ai_tool_names(messages),
        )
        if not delegation_ledger.append_turn(user_id, thread_id, entry):
            return None
        return user_id, thread_id

    def after_agent(self, state: AgentState, runtime: Runtime) -> dict | None:
        """Sync path: local append only (tests / sync graph execution)."""
        self._append_entry(state, runtime)
        return None

    async def aafter_agent(self, state: AgentState, runtime: Runtime) -> dict | None:
        """Async path: local append + fire-and-forget Supabase mirror."""
        appended = self._append_entry(state, runtime)
        if appended is None:
            return None
        user_id, thread_id = appended
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Correction wave 2026-06-12: a silent mirror skip leaves the
            # gateway-side deletion path and restart durability blind for
            # the session — degraded, so say so (once per occurrence).
            logger.warning(
                "[DelegationLedger] mirror skipped: no running event loop thread=%s",
                thread_id,
            )
            return None
        # mirror_ledger does blocking I/O (httpx.Client) — run it off-loop.
        task = loop.create_task(
            asyncio.to_thread(delegation_ledger.mirror_ledger, user_id, thread_id)
        )
        _MIRROR_TASKS.add(task)
        task.add_done_callback(_MIRROR_TASKS.discard)
        return None
