"""Mem0 memory middleware — backward-compatible wrapper.

Upgrade E splits memory work into two middlewares:
1. Mem0RetrievalMiddleware (mem0_prefetch.py) — fetches memories early.
2. MemoryInjectionMiddleware (memory_injection.py) — injects them later.

Mem0MemoryMiddleware now delegates to both for backward compatibility.
New code should use the split directly.
"""

from __future__ import annotations

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.middlewares.mem0_prefetch import Mem0RetrievalMiddleware
from deerflow.agents.sophia_agent.middlewares.memory_injection import MemoryInjectionMiddleware
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.mem0_client import warm_up

logger = logging.getLogger(__name__)


class Mem0MemoryState(AgentState):
    skip_expensive: NotRequired[bool]
    active_ritual: NotRequired[str | None]
    active_skill: NotRequired[str]
    context_mode: NotRequired[str]
    injected_memories: NotRequired[list[str]]
    platform: NotRequired[str]
    turn_count: NotRequired[int]
    system_prompt_blocks: NotRequired[list[str]]


class Mem0MemoryMiddleware(AgentMiddleware[Mem0MemoryState]):
    """Backward-compatible wrapper that delegates to Mem0RetrievalMiddleware
    + MemoryInjectionMiddleware."""

    state_schema = Mem0MemoryState

    def __init__(self, user_id: str):
        super().__init__()
        self._retrieval = Mem0RetrievalMiddleware(user_id)
        self._injection = MemoryInjectionMiddleware()
        warm_up()

    @override
    def before_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Memory", "skipped (crisis)", _t0)
            return None

        # Run retrieval
        retrieval_update = self._retrieval.before_agent(state, runtime)
        merged_state: dict = dict(state)
        if retrieval_update:
            merged_state.update(retrieval_update)

        # Run injection on the merged state
        injection_update = self._injection.before_agent(merged_state, runtime)

        # Combine results, stripping empty containers so a blank query still
        # returns None (backward-compatible with pre-split callers).
        combined: dict = {}
        if retrieval_update:
            combined.update(retrieval_update)
        if injection_update:
            combined.update(injection_update)
        # Remove empty lists / dicts that are truthy but carry no payload.
        cleaned = {k: v for k, v in combined.items() if v}
        return cleaned if cleaned else None

    @override
    async def abefore_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Memory", "skipped (crisis)", _t0)
            return None

        # Run async retrieval
        retrieval_update = await self._retrieval.abefore_agent(state, runtime)
        merged_state: dict = dict(state)
        if retrieval_update:
            merged_state.update(retrieval_update)

        # Run injection (sync is fine — it's just formatting)
        injection_update = self._injection.before_agent(merged_state, runtime)

        # Combine results, stripping empty containers so a blank query still
        # returns None (backward-compatible with pre-split callers).
        combined: dict = {}
        if retrieval_update:
            combined.update(retrieval_update)
        if injection_update:
            combined.update(injection_update)
        # Remove empty lists / dicts that are truthy but carry no payload.
        cleaned = {k: v for k, v in combined.items() if v}
        return cleaned if cleaned else None

    @override
    def after_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        """Queue session for offline extraction. Does NOT write per-turn."""
        thread_id = runtime.context.get("thread_id")
        if thread_id:
            logger.debug("Session %s queued for offline Mem0 extraction", thread_id)
        return None
