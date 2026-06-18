"""BuilderMem0RetrievalMiddleware — pre-fetch user memories into Builder state.

Sits in the Builder middleware chain between ``UserIdentityMiddleware``
(which resolves the trusted ``user_id``) and ``BuilderTaskMiddleware``
(which assembles or synthesises ``delegation_context`` and reads memories
when populated).

Why this lives in the Builder chain:

- **Work-bot path (Builder-as-Main)**: there is NO companion to inject
  memories before dispatch. Without this middleware, Builder runs blind
  to the user's relevant memories on the Work-bot DM surface.
- **Companion-subagent path**: ``start_builder_task`` already embeds up
  to 5 ``injected_memory_contents`` into the enriched description. This
  middleware adds an *additional* brief-scoped retrieval so Builder gets
  ~10 relevant snippets total (5 companion-side, broader session;
  5 brief-scoped, this middleware) at sub-second additional latency.

The retrieval is best-effort:

- **Timeout**: 2.0s default. Mem0 hangs do NOT block the run.
- **Failure**: any exception is swallowed and logged; state is returned
  unchanged. The Builder run continues without injected memory.
- **No user_id**: skipped silently (early-bound user_id is the EI/companion
  path, late-bound is the work_bot path — both populate state by the time
  this middleware runs).
- **No query**: skipped (nothing to search for yet — happens when the
  user's first message hasn't been parsed).

Output shape:

The middleware writes BOTH:

1. ``injected_memory_contents``: the list of human-readable snippets,
   matching ``start_builder_task``'s emission shape so existing tests
   and downstream readers see the same key.
2. ``system_prompt_blocks``: appends a ``<memory>`` block so
   ``PromptAssemblyMiddleware`` (at the end of the chain) naturally
   includes it in the assembled system message. No PromptAssembly
   changes required.

Spec: ``docs/specs/sophia_builder_as_main_work_bot_spec.md`` §7.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import extract_last_human_text, log_middleware

# Note: ``search_memories`` is lazy-imported inside ``_safe_search`` rather
# than at module top. Keeps the deerflow_agents → deerflow_sophia_services
# cross-module edge out of sentrux's static import graph (matching the
# lazy-import pattern used by ``start_builder_task``'s ``_dispatch_via_asgi``
# for ``langgraph_sdk.get_client``). The runtime call shape is identical;
# only the import locality changes.

logger = logging.getLogger(__name__)

_DEFAULT_TOP_K = 5
_DEFAULT_TIMEOUT_SECONDS = 2.0
# Cap memory contents at a sane character length per snippet to keep
# the system prompt budget bounded — Mem0 occasionally returns long
# multi-paragraph memories that would dominate the prompt.
_MAX_SNIPPET_CHARS = 600

# Builder retrieval covers the DURABLE build-relevant categories — style
# preferences, static facts (names/places/roles), relationships (the people a
# deliverable might be for), and the user's decisions / commitments / lessons
# (e.g. "decided to delay the launch by two weeks" for a timeline) — and then
# task-history is filtered by CONTENT, not by excluding whole categories. The
# original "preference only" rule starved direct Builder-as-Main runs of useful
# facts/decisions (e.g. "make a card for my daughter" lost the daughter's name);
# the episodic "user requested creation of X" rows that actually cause the
# OpenClaw-vs-Hermes contamination are removed by the policy-content filter below
# (``_candidate_policy_rejection_reason``) regardless of which category they were
# written under. Only the companion-emotional categories (feeling / pattern /
# ritual_context) are left out as noise for a build brief. See
# fix/builder-memory-contamination + codex review on PR #137.
_BUILDER_MEMORY_CATEGORIES = ["preference", "fact", "relationship", "decision", "commitment", "lesson"]
# Mem0 fetches `limit` rows by score and applies the category filter LOCALLY
# afterwards, so asking for only top_k rows means a brief whose top matches are all
# task-history would discard every row and surface zero durable memories even when
# they rank just below. Over-fetch a larger pool, then trim to top_k after the
# category + content filter. See codex review on PR #137.
_BUILDER_SEARCH_POOL = 25


class BuilderMem0RetrievalState(AgentState):
    user_id: NotRequired[str]
    system_prompt_blocks: NotRequired[list[str]]
    injected_memories: NotRequired[list[str]]
    injected_memory_contents: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]


class BuilderMem0RetrievalMiddleware(AgentMiddleware[BuilderMem0RetrievalState]):
    """Pre-fetch top-K user memories and inject into Builder state."""

    state_schema = BuilderMem0RetrievalState

    def __init__(
        self,
        *,
        top_k: int = _DEFAULT_TOP_K,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        super().__init__()
        self.top_k = max(1, int(top_k))
        self.timeout_seconds = max(0.1, float(timeout_seconds))

    # --- sync path -------------------------------------------------------

    @override
    def before_agent(
        self, state: BuilderMem0RetrievalState, runtime: Runtime
    ) -> dict | None:
        """Sync hook: skip retrieval (only async path performs the call).

        The sync path exists so a sync agent invocation doesn't crash, but
        Builder runs are async in production (``runs.wait`` / ``astream``)
        so this hook is rarely hit. Returning None preserves state and
        lets the run proceed without memories — same behaviour as the
        async path on timeout / error.
        """
        return None

    # --- async path ------------------------------------------------------

    @override
    async def abefore_agent(
        self, state: BuilderMem0RetrievalState, runtime: Runtime
    ) -> dict | None:
        _t0 = time.perf_counter()

        user_id = self._resolve_user_id(state, runtime)
        if not user_id:
            log_middleware("BuilderMem0Retrieval", "no user_id — skipping", _t0)
            return None

        query = self._resolve_query(state)
        if not query:
            log_middleware("BuilderMem0Retrieval", "no query — skipping", _t0)
            return None

        results = await self._safe_search(user_id, query)
        if not results:
            # _safe_search logs the specific reason (timeout/error/empty)
            log_middleware("BuilderMem0Retrieval", "no results", _t0)
            return None

        memory_ids, memory_contents = self._collect_snippets(results)
        if not memory_contents:
            log_middleware("BuilderMem0Retrieval", "no usable contents", _t0)
            return None

        update = self._build_state_update(state, memory_ids, memory_contents)
        log_middleware(
            "BuilderMem0Retrieval",
            f"injected {len(memory_contents)} snippets "
            f"(total contents={len(update['injected_memory_contents'])})",
            _t0,
        )
        return update

    # --- async-path helpers ---------------------------------------------

    async def _safe_search(self, user_id: str, query: str) -> list | None:
        """Run search_memories with timeout + error swallow.

        Returns the raw results list, or None on timeout / error / no
        results. Caller logs at log_middleware level; this method emits
        WARNING-level structured-log lines for diagnostics.
        """
        # Lazy import — see module-top note. Keeps the cross-module edge
        # (deerflow_agents → deerflow_sophia_services) out of the static
        # graph. ``mem0_client`` is a sync module so this also defers its
        # import (and the implicit Mem0 SDK warmup thread it spawns at
        # module-load time) until the first real call.
        from deerflow.sophia.mem0_client import search_memories

        # Over-fetch a pool so the category + content filter (applied locally
        # after the score-ranked fetch) still has candidates when the top rows are
        # task-history; we trim back to top_k below.
        pool = max(_BUILDER_SEARCH_POOL, self.top_k)
        try:
            results = await asyncio.wait_for(
                asyncio.to_thread(
                    search_memories,
                    user_id,
                    query,
                    _BUILDER_MEMORY_CATEGORIES,  # durable build-relevant categories; task-history filtered by content below
                    None,  # context_mode — None keeps all
                    pool,  # over-fetch; trimmed to top_k after the category + content filter
                ),
                timeout=self.timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "mem0_retrieval.timeout user_id=%s timeout_s=%.2f query_len=%d",
                user_id,
                self.timeout_seconds,
                len(query),
            )
            return None
        except Exception:
            logger.warning("mem0_retrieval.error user_id=%s", user_id, exc_info=True)
            return None

        if not results:
            return results

        # Two-stage filter at the injection point:
        #   1. category ∈ the durable build-relevant set (Mem0's own category
        #      filter admits blank-category rows as wildcards, so re-enforce it).
        #   2. content is NOT task-history / policy-rejected — this is what keeps a
        #      "user requested creation of X" row (written under any category, incl.
        #      a blank or mislabeled `fact`) from re-contaminating the brief, while
        #      letting durable facts/relationships through. Lexical-only, lazy
        #      import (mirrors the companion + start_builder_task read filters).
        # Then keep only the best top_k (score-ordered) for the prompt budget.
        # See fix/builder-memory-contamination + codex review on PR #137.
        try:
            from deerflow.sophia.extraction import _candidate_policy_rejection_reason
        except Exception:
            _candidate_policy_rejection_reason = None

        def _is_durable(entry: dict) -> bool:
            if entry.get("category") not in _BUILDER_MEMORY_CATEGORIES:
                return False
            if _candidate_policy_rejection_reason is None:
                return True
            try:
                return _candidate_policy_rejection_reason(str(entry.get("content") or "")) is None
            except Exception:
                return True

        durable = [m for m in results if isinstance(m, dict) and _is_durable(m)]
        return durable[: self.top_k]

    @staticmethod
    def _collect_snippets(results: list) -> tuple[list[str], list[str]]:
        """Extract (memory_ids, memory_contents) from raw Mem0 search results.

        Drops non-dict entries silently. Truncates each content snippet
        to ``_MAX_SNIPPET_CHARS`` so a single multi-paragraph memory can't
        dominate the prompt budget.
        """
        memory_ids: list[str] = []
        memory_contents: list[str] = []
        for entry in results:
            if not isinstance(entry, dict):
                continue
            entry_id = entry.get("id")
            if isinstance(entry_id, str) and entry_id:
                memory_ids.append(entry_id)
            entry_content = entry.get("content")
            if isinstance(entry_content, str) and entry_content.strip():
                snippet = entry_content.strip()
                if len(snippet) > _MAX_SNIPPET_CHARS:
                    snippet = snippet[: _MAX_SNIPPET_CHARS - 1] + "…"
                memory_contents.append(snippet)
        return memory_ids, memory_contents

    def _build_state_update(
        self,
        state: BuilderMem0RetrievalState,
        memory_ids: list[str],
        memory_contents: list[str],
    ) -> dict:
        """Build the dict returned from ``abefore_agent``.

        Merges with anything ``start_builder_task`` already injected
        (companion path puts up to 5 snippets in
        ``injected_memory_contents``). Dedup preserves order —
        companion-side snippets first, then ours. Also appends a
        ``<memory>`` block to ``system_prompt_blocks`` so PromptAssembly
        at the end of the chain naturally includes it in the system
        message.
        """
        existing_contents = state.get("injected_memory_contents") or []
        merged_contents = self._dedupe_preserve_order(existing_contents, memory_contents)

        existing_ids = state.get("injected_memories") or []
        merged_ids = self._dedupe_preserve_order(existing_ids, memory_ids)

        block = self._format_memory_block(memory_contents)
        blocks = list(state.get("system_prompt_blocks", []) or [])
        blocks.append(block)

        return {
            "injected_memory_contents": merged_contents,
            "injected_memories": merged_ids,
            "system_prompt_blocks": blocks,
        }

    # --- helpers ----------------------------------------------------------

    @staticmethod
    def _resolve_user_id(state: BuilderMem0RetrievalState, runtime: Runtime) -> str | None:
        """Resolve user_id from state then runtime context/configurable.

        Priority: state.user_id → runtime.context.user_id →
        runtime.config.configurable.user_id. Each lookup is wrapped in a
        small try/except so a missing-attr / wrong-shape runtime never
        crashes the middleware (it's best-effort by design).
        """
        for source in BuilderMem0RetrievalMiddleware._user_id_sources(state, runtime):
            try:
                value = source()
            except Exception:
                continue
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _user_id_sources(
        state: BuilderMem0RetrievalState, runtime: Runtime
    ) -> list:
        """Return an ordered list of zero-arg callables that yield user_id candidates.

        Each callable returns either a non-empty string or None/anything
        else (rejected by the type check in ``_resolve_user_id``). The
        list-of-callables shape keeps ``_resolve_user_id`` linear (one
        loop) instead of a nested-try/except staircase.
        """
        return [
            lambda: state.get("user_id"),
            lambda: ((getattr(runtime, "context", None) or {}).get("user_id"))
            if runtime is not None
            else None,
            lambda: (
                ((getattr(runtime, "config", None) or {}).get("configurable", {}) or {}).get(
                    "user_id"
                )
            )
            if runtime is not None
            else None,
        ]

    @staticmethod
    def _resolve_query(state: BuilderMem0RetrievalState) -> str | None:
        """Pick the best search query from delegation_context or last human msg.

        Priority:
        1. ``delegation_context.normalized_brief`` (post-classification)
        2. ``delegation_context.task_brief`` (companion-set)
        3. Last human message text on state["messages"]
        """
        delegation = state.get("delegation_context") or {}
        if isinstance(delegation, dict):
            for field in ("normalized_brief", "task_brief"):
                value = delegation.get(field)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        # Shared helper — same primitive used by BuilderTaskMiddleware.
        return extract_last_human_text(state.get("messages"))

    @staticmethod
    def _dedupe_preserve_order(existing: list[str], new: list[str]) -> list[str]:
        seen: dict[str, None] = {}
        for item in existing:
            if isinstance(item, str) and item:
                seen.setdefault(item, None)
        for item in new:
            if isinstance(item, str) and item:
                seen.setdefault(item, None)
        return list(seen.keys())

    @staticmethod
    def _format_memory_block(memory_contents: list[str]) -> str:
        """Render a <memory> system-prompt block from the retrieved snippets."""
        lines = "\n".join(f"- {m}" for m in memory_contents[: _DEFAULT_TOP_K])
        return (
            "<memory>\n"
            "Relevant memories about this user (Mem0 brief-scoped retrieval). "
            "Treat as background context — do not echo back unless directly relevant.\n"
            f"{lines}\n"
            "</memory>"
        )
