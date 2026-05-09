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
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.mem0_client import search_memories

logger = logging.getLogger(__name__)

_DEFAULT_TOP_K = 5
_DEFAULT_TIMEOUT_SECONDS = 2.0
# Cap memory contents at a sane character length per snippet to keep
# the system prompt budget bounded — Mem0 occasionally returns long
# multi-paragraph memories that would dominate the prompt.
_MAX_SNIPPET_CHARS = 600


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

        try:
            results = await asyncio.wait_for(
                asyncio.to_thread(
                    search_memories,
                    user_id,
                    query,
                    None,  # categories — None keeps all
                    None,  # context_mode — None keeps all
                    self.top_k,
                ),
                timeout=self.timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "mem0_retrieval.timeout user_id=%s timeout_s=%.2f query_len=%d",
                user_id,
                self.timeout_seconds,
                len(query),
            )
            log_middleware("BuilderMem0Retrieval", "timeout", _t0)
            return None
        except Exception:
            logger.warning(
                "mem0_retrieval.error user_id=%s",
                user_id,
                exc_info=True,
            )
            log_middleware("BuilderMem0Retrieval", "error", _t0)
            return None

        if not results:
            log_middleware("BuilderMem0Retrieval", "no results", _t0)
            return None

        memory_ids: list[str] = []
        memory_contents: list[str] = []
        for entry in results:
            if not isinstance(entry, dict):
                continue
            entry_id = entry.get("id")
            entry_content = entry.get("content")
            if isinstance(entry_id, str) and entry_id:
                memory_ids.append(entry_id)
            if isinstance(entry_content, str) and entry_content.strip():
                snippet = entry_content.strip()
                if len(snippet) > _MAX_SNIPPET_CHARS:
                    snippet = snippet[: _MAX_SNIPPET_CHARS - 1] + "…"
                memory_contents.append(snippet)

        if not memory_contents:
            log_middleware("BuilderMem0Retrieval", "no usable contents", _t0)
            return None

        # Merge with anything start_builder_task already injected (companion
        # path puts up to 5 snippets here). Deduplicate by content while
        # preserving order — companion-side snippets first, then ours.
        existing_contents = state.get("injected_memory_contents") or []
        merged_contents = self._dedupe_preserve_order(existing_contents, memory_contents)

        existing_ids = state.get("injected_memories") or []
        merged_ids = self._dedupe_preserve_order(existing_ids, memory_ids)

        # Append a <memory> block to system_prompt_blocks. PromptAssembly
        # at the end of the chain joins these into the system message.
        block = self._format_memory_block(memory_contents)
        blocks = list(state.get("system_prompt_blocks", []) or [])
        blocks.append(block)

        log_middleware(
            "BuilderMem0Retrieval",
            f"injected {len(memory_contents)} snippets (total contents={len(merged_contents)})",
            _t0,
        )

        return {
            "injected_memory_contents": merged_contents,
            "injected_memories": merged_ids,
            "system_prompt_blocks": blocks,
        }

    # --- helpers ----------------------------------------------------------

    @staticmethod
    def _resolve_user_id(state: BuilderMem0RetrievalState, runtime: Runtime) -> str | None:
        """Resolve user_id from state then runtime context/configurable."""
        candidate = state.get("user_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

        if runtime is not None:
            try:
                ctx = getattr(runtime, "context", None) or {}
                if isinstance(ctx, dict):
                    candidate = ctx.get("user_id")
                    if isinstance(candidate, str) and candidate.strip():
                        return candidate.strip()
            except Exception:
                pass
            try:
                config = getattr(runtime, "config", None) or {}
                configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
                if isinstance(configurable, dict):
                    candidate = configurable.get("user_id")
                    if isinstance(candidate, str) and candidate.strip():
                        return candidate.strip()
            except Exception:
                pass
        return None

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

        # Walk messages backward for the last human turn. Supports both
        # raw dict messages (from runs.wait input) and BaseMessage objects.
        for msg in reversed(state.get("messages") or []):
            text = BuilderMem0RetrievalMiddleware._extract_human_text(msg)
            if text:
                return text
        return None

    @staticmethod
    def _extract_human_text(msg: Any) -> str | None:
        """Return the text content of ``msg`` iff it's a human message."""
        # LangChain BaseMessage shape (e.g. HumanMessage instance).
        msg_type = getattr(msg, "type", None) or getattr(msg, "role", None)
        content = getattr(msg, "content", None)

        if msg_type is None and isinstance(msg, dict):
            msg_type = msg.get("type") or msg.get("role")
            content = msg.get("content")

        if msg_type not in {"human", "user"}:
            return None

        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
                elif isinstance(block, str):
                    parts.append(block)
            text = "".join(parts).strip()
            if text:
                return text
        return None

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
