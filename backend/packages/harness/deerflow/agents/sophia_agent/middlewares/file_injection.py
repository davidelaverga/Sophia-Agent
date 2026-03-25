"""File injection middleware.

Reads markdown files at init and appends their content to system_prompt_blocks.
Supports multiple files with per-file crisis skip control.
"""

import logging
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


class FileInjectionState(AgentState):
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]


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
        is_crisis = state.get("skip_expensive", False)
        blocks = []
        for content, skip_on_crisis in self._files:
            if skip_on_crisis and is_crisis:
                continue
            blocks.append(content)

        if not blocks:
            return None
        return {"system_prompt_blocks": blocks}
