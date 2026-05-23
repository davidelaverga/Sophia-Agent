"""Memory injection middleware — formats prefetched memories into prompt blocks.

Upgrade E splits the old Mem0MemoryMiddleware into two parts:
1. Mem0RetrievalMiddleware (mem0_prefetch.py) — fetches memories early.
2. MemoryInjectionMiddleware (this file) — formats and injects them later.

This middleware should sit after BuildAwarenessMiddleware so the memory
block lands in the assembled system message near the end of the prompt.
"""

from __future__ import annotations

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

_VOICE_MEMORY_LIMIT = 4
_DEFAULT_MEMORY_LIMIT = 10


class MemoryInjectionState(AgentState):
    skip_expensive: NotRequired[bool]
    platform: NotRequired[str]
    prefetched_memories: NotRequired[list[dict]]
    prefetched_memory_ids: NotRequired[list[str]]
    injected_memories: NotRequired[list[str]]
    system_prompt_blocks: NotRequired[list[str]]


class MemoryInjectionMiddleware(AgentMiddleware[MemoryInjectionState]):
    """Read prefetched memories from state and inject as a system prompt block."""

    state_schema = MemoryInjectionState

    @override
    def before_agent(self, state: MemoryInjectionState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("MemoryInjection", "skipped (crisis)", _t0)
            return None

        results = state.get("prefetched_memories")
        if not results:
            log_middleware("MemoryInjection", "skipped (no prefetched memories)", _t0)
            return None

        platform = state.get("platform")
        memory_limit = _VOICE_MEMORY_LIMIT if platform in ("voice", "ios_voice") else _DEFAULT_MEMORY_LIMIT

        memory_lines = []
        memory_ids = []
        for mem in results[:memory_limit]:
            content = mem.get("content", "")
            if content:
                memory_lines.append(f"- {content}")
            if mem.get("id"):
                memory_ids.append(mem["id"])

        if not memory_lines:
            log_middleware("MemoryInjection", "skipped (empty contents)", _t0)
            return None

        block = "<memories>\n" + "\n".join(memory_lines) + "\n</memories>"

        inj_categories: dict[str, int] = {}
        for mem in results[:memory_limit]:
            cat = (mem.get("category") or "unknown")
            inj_categories[cat] = inj_categories.get(cat, 0) + 1
        inj_breakdown = ",".join(f"{k}:{v}" for k, v in sorted(inj_categories.items()))

        logger.info(
            "[MemoryInjection] user_id=%s platform=%s injected_count=%d ids=%s categories=[%s] first_content=%r",
            state.get("user_id", "-"),
            platform or "-",
            len(memory_lines),
            memory_ids[:10],
            inj_breakdown,
            (memory_lines[0][:80] if memory_lines else ""),
        )

        log_middleware("MemoryInjection", f"{len(memory_lines)} memories injected", _t0)
        return {
            "injected_memories": memory_ids,
            "injected_memory_contents": memory_lines,
            "system_prompt_blocks": list(state.get("system_prompt_blocks", [])) + [block],
        }
