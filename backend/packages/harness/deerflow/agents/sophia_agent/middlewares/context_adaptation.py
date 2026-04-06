"""Context adaptation middleware.

Loads the appropriate context mode file (work, gaming, life) and injects
it into system_prompt_blocks.
"""

import logging
import time
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

VALID_MODES = {"work", "gaming", "life"}


class ContextAdaptationState(AgentState):
    skip_expensive: NotRequired[bool]
    context_mode: NotRequired[str]
    system_prompt_blocks: NotRequired[list[str]]


class ContextAdaptationMiddleware(AgentMiddleware[ContextAdaptationState]):
    """Inject context mode guidance."""

    state_schema = ContextAdaptationState

    def __init__(self, context_dir: Path, context_mode: str):
        super().__init__()
        self._context_dir = context_dir
        self._context_mode = context_mode if context_mode in VALID_MODES else "life"
        # Load only the active context file, not all 3
        self._content: str | None = None
        path = context_dir / f"{self._context_mode}.md"
        if path.exists():
            self._content = path.read_text(encoding="utf-8")
        else:
            logger.warning("Context file not found: %s", path)

    @override
    def before_agent(self, state: ContextAdaptationState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("ContextAdaptation", "skipped (crisis)", _t0)
            return None

        if not self._content:
            log_middleware("ContextAdaptation", f"context={self._context_mode}", _t0)
            return {"context_mode": self._context_mode}

        log_middleware("ContextAdaptation", f"context={self._context_mode}", _t0)
        return {
            "context_mode": self._context_mode,
            "system_prompt_blocks": list(state.get("system_prompt_blocks", [])) + [self._content],
        }
