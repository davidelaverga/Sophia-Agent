"""read_session_context — the builder's floor beneath the brief (Spec D D-4).

A brief is a summary, and summaries are lossy by nature. When the builder
hits a gap mid-build — a missing audience, exact numbers, the precise
phrasing of a style constraint — this tool pulls the exact turns from the
PARENT companion session's delegation ledger instead of guessing or
shipping a hole.

Scope discipline (clone of ``read_user_document``): the tool takes NO
user or session parameters. The parent session is resolved server-side
from ``state["delegation_context"]`` (canonical — state always reaches
the running graph) with a ``runtime.config.configurable`` fallback
(``parent_thread_id``/``user_id`` seeded by ``start_builder_task``).
``validate_user_id`` + ``safe_user_path`` inside the ledger module make
cross-session addressing structurally impossible.

Budget: capped at 4 calls per build, self-enforced via the
``builder_session_context_reads`` state counter (declared on
``BuilderTaskState``). A pure local read — no budget-cost fold; its
tokens are already counted by the budget middleware.
"""

from __future__ import annotations

import logging
import os
import re
from typing import TYPE_CHECKING, Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

from deerflow.sophia import delegation_ledger

if TYPE_CHECKING:
    from deerflow.agents.thread_state import ThreadState
else:
    ThreadState = dict

logger = logging.getLogger(__name__)

_READS_CAP = 4
_HIT_TEXT_CAP_CHARS = 600
_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


def read_tool_enabled() -> bool:
    """SOPHIA_DELEGATION_READ_TOOL flag (default on)."""
    raw = os.environ.get("SOPHIA_DELEGATION_READ_TOOL", "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _resolve_parent_scope(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
) -> tuple[str, str] | None:
    """Resolve (parent_user_id, parent_thread_id) server-side, or None.

    ``delegation_context`` in state is canonical (langgraph-api 0.8.x
    forwards only a subset of custom ``configurable`` keys — verified in
    production; see start_builder_task's delegation_with_parent comment).
    Config is the fallback.
    """
    if runtime is None:
        return None
    state = getattr(runtime, "state", None) or {}
    delegation = state.get("delegation_context") if isinstance(state, dict) else None
    user_id = None
    thread_id = None
    if isinstance(delegation, dict):
        user_id = delegation.get("parent_user_id")
        thread_id = delegation.get("parent_thread_id")
    if not (isinstance(user_id, str) and user_id.strip()) or not (
        isinstance(thread_id, str) and thread_id.strip()
    ):
        config = getattr(runtime, "config", None) or {}
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
        user_id = user_id if isinstance(user_id, str) and user_id.strip() else configurable.get("user_id")
        thread_id = (
            thread_id
            if isinstance(thread_id, str) and thread_id.strip()
            else configurable.get("parent_thread_id")
        )
    if isinstance(user_id, str) and user_id.strip() and isinstance(thread_id, str) and thread_id.strip():
        return user_id.strip(), thread_id.strip()
    return None


def _tokenize(text: str) -> set[str]:
    return set(_TOKEN_PATTERN.findall((text or "").lower()))


def _entry_haystack(entry: dict[str, Any]) -> str:
    parts = [str(entry.get("user_text", ""))]
    artifact = entry.get("artifact")
    if isinstance(artifact, dict):
        parts.extend(str(value) for value in artifact.values() if isinstance(value, str))
    return " ".join(parts)


def _score_entry(query_tokens: set[str], entry: dict[str, Any]) -> int:
    """BM25-lite: token-overlap count between the query and the entry."""
    if not query_tokens:
        return 0
    return len(query_tokens & _tokenize(_entry_haystack(entry)))


def _render_hit(entry: dict[str, Any]) -> str:
    text = " ".join(str(entry.get("user_text", "")).split())
    if len(text) > _HIT_TEXT_CAP_CHARS:
        text = text[: _HIT_TEXT_CAP_CHARS - 1] + "…"
    line = f"t{entry.get('turn_number')} ({entry.get('timestamp', '')}): {text}"
    artifact = entry.get("artifact")
    if isinstance(artifact, dict) and artifact:
        rendered = ", ".join(
            f"{key}={value}" for key, value in artifact.items() if value is not None
        )
        if rendered:
            line += f"\n  [turn context: {rendered}]"
    return line


def _tool_reply(text: str, tool_call_id: str, reads_used: int | None = None) -> Command:
    update: dict[str, Any] = {
        "messages": [ToolMessage(text, tool_call_id=tool_call_id)]
    }
    if reads_used is not None:
        update["builder_session_context_reads"] = reads_used
    return Command(update=update)


@tool("read_session_context", parse_docstring=True)
async def read_session_context(
    runtime: ToolRuntime[ContextT, ThreadState],
    query: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_results: int = 5,
) -> Command:
    """Search the parent conversation for details the brief may have dropped.

    The build brief is a summary of a longer conversation. When the brief
    is ambiguous or missing a detail the user likely stated — audience,
    exact figures, style constraints, exclusions — call this BEFORE
    assuming. Returns the matching conversation turns verbatim.

    Budget: at most 4 calls per build. Make queries targeted (e.g.
    "audience", "Q3 numbers", "style preferences") rather than broad.

    Args:
        query: Keywords to search for in the parent conversation, e.g.
            "audience" or "Q3 revenue numbers".
        max_results: Maximum matching turns to return (1-10, default 5).
    """
    state = getattr(runtime, "state", None) or {}
    reads_used = int(state.get("builder_session_context_reads", 0) or 0)
    if reads_used >= _READS_CAP:
        return _tool_reply(
            f"Call cap reached ({_READS_CAP} per build). Proceed with the brief as-is; "
            "for any field genuinely not in the conversation, choose a sensible "
            "stated assumption and report it in emit_builder_artifact.brief_assumptions.",
            tool_call_id,
        )

    scope = _resolve_parent_scope(runtime)
    if scope is None:
        return _tool_reply(
            "The parent session is not resolvable from this build's context — "
            "proceed with the brief and state assumptions where needed.",
            tool_call_id,
            reads_used + 1,
        )
    user_id, parent_thread_id = scope

    try:
        entries = delegation_ledger.read_ledger_with_fallback(user_id, parent_thread_id)
    except Exception:  # noqa: BLE001 — never abort the build turn on a read error
        logger.warning("[ReadSessionContext] ledger_read_failed", exc_info=True)
        entries = []
    if not entries:
        return _tool_reply(
            "No conversation record is available for the parent session — "
            "proceed with the brief and state assumptions where needed.",
            tool_call_id,
            reads_used + 1,
        )

    try:
        max_results = max(1, min(int(max_results), 10))
    except (TypeError, ValueError):
        max_results = 5

    query_tokens = _tokenize(query)
    scored = [
        (score, index, entry)
        for index, entry in enumerate(entries)
        if (score := _score_entry(query_tokens, entry)) > 0
    ]
    # Highest overlap first; recency (higher index) breaks ties.
    scored.sort(key=lambda item: (-item[0], -item[1]))
    hits = [entry for _score, _index, entry in scored[:max_results]]

    logger.info(
        "[ReadSessionContext] query_tokens=%d hits=%d reads_used=%d/%d",
        len(query_tokens),
        len(hits),
        reads_used + 1,
        _READS_CAP,
    )

    if not hits:
        return _tool_reply(
            f"No conversation turns matched {query!r}. Try different keywords, or "
            "proceed with a stated assumption for this detail.",
            tool_call_id,
            reads_used + 1,
        )

    rendered = "\n".join(_render_hit(entry) for entry in hits)
    remaining = _READS_CAP - (reads_used + 1)
    return _tool_reply(
        f"Matching turns from the parent conversation (most relevant first):\n"
        f"{rendered}\n\n[{remaining} read_session_context call(s) remaining this build.]",
        tool_call_id,
        reads_used + 1,
    )
