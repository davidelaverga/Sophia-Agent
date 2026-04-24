from __future__ import annotations

import logging

from langchain.tools import BaseTool

from deerflow.config import get_app_config
from deerflow.reflection import resolve_variable

logger = logging.getLogger(__name__)

_SOPHIA_WEB_TOOL_NAMES = ("web_search", "web_fetch")


def load_sophia_web_tools() -> list[BaseTool]:
    """Load the configured DeerFlow-native web tools Sophia should inherit."""

    config = get_app_config()
    tools: list[BaseTool] = []
    seen: set[str] = set()

    for tool_config in config.tools:
        if tool_config.name not in _SOPHIA_WEB_TOOL_NAMES or tool_config.name in seen:
            continue
        tools.append(resolve_variable(tool_config.use, BaseTool))
        seen.add(tool_config.name)

    logger.info("Loaded %d Sophia web tool(s): %s", len(tools), ", ".join(sorted(seen)) or "none")
    return tools
