"""File injection middleware.

Generic middleware that reads a markdown file at init and appends its content
to system_prompt_blocks on each turn. Instantiated multiple times for soul.md,
voice.md, techniques.md.
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
    """Inject a markdown file's content into system_prompt_blocks."""

    state_schema = FileInjectionState

    def __init__(self, path: Path, skip_on_crisis: bool = False):
        super().__init__()
        self._skip_on_crisis = skip_on_crisis
        if not path.exists():
            raise FileNotFoundError(f"Skill file not found: {path}")
        self._content = path.read_text(encoding="utf-8")
        self._path = path

    @override
    def before_agent(self, state: FileInjectionState, runtime: Runtime) -> dict | None:
        if self._skip_on_crisis and state.get("skip_expensive", False):
            return None

        return {"system_prompt_blocks": [self._content]}
