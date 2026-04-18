"""File injection middleware.

Reads markdown files at init and appends their content to system_prompt_blocks.
Supports multiple files with per-file crisis skip control.
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


class FileInjectionState(AgentState):
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]
    # Number of leading blocks in system_prompt_blocks that are stable across
    # turns (safe to cache via Anthropic prompt caching). Set by this
    # middleware and read by PromptAssemblyMiddleware.
    system_prompt_cacheable_prefix_count: NotRequired[int]


class FileInjectionMiddleware(AgentMiddleware[FileInjectionState]):
    """Inject one or more markdown files into system_prompt_blocks.

    Each file entry is a tuple of (path, skip_on_crisis). Files with
    skip_on_crisis=True are excluded during crisis fast-path.
    """

    state_schema = FileInjectionState

    def __init__(self, *file_entries: tuple[Path, bool]):
        """Initialize with file entries.

        Args:
            *file_entries: Each entry is (path, skip_on_crisis).
                          Example: (soul_path, False), (voice_path, True)
        """
        super().__init__()
        self._files: list[tuple[str, bool]] = []
        for path, skip_on_crisis in file_entries:
            if not path.exists():
                raise FileNotFoundError(f"Skill file not found: {path}")
            content = path.read_text(encoding="utf-8")
            self._files.append((content, skip_on_crisis))

    @override
    def before_agent(self, state: FileInjectionState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        is_crisis = state.get("skip_expensive", False)
        blocks = []
        for content, skip_on_crisis in self._files:
            if skip_on_crisis and is_crisis:
                continue
            blocks.append(content)

        if not blocks:
            log_middleware("FileInjection", "skipped (no blocks)", _t0)
            return None
        # NOTE: FileInjectionMiddleware is the FIRST middleware to write blocks.
        # It starts with a fresh list (not extending from state) to prevent
        # accumulation across turns via the LangGraph checkpointer.
        # All subsequent middlewares extend from state, which now contains
        # only the current turn's blocks.
        #
        # The files injected here (soul.md, voice.md, techniques.md) are
        # immutable across a user's lifetime, so we mark them as the cacheable
        # prefix. PromptAssemblyMiddleware uses this count to place Anthropic
        # cache_control after these blocks exactly.
        log_middleware("FileInjection", f"{len(blocks)} files injected (crisis={is_crisis})", _t0)
        return {
            "system_prompt_blocks": blocks,
            "system_prompt_cacheable_prefix_count": len(blocks),
        }
