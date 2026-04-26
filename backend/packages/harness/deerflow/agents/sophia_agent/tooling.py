from __future__ import annotations

import logging

from langchain.tools import BaseTool

from deerflow.config import get_app_config
from deerflow.reflection import resolve_variable

logger = logging.getLogger(__name__)

_SOPHIA_WEB_TOOL_NAMES = ("web_search", "web_fetch")


def load_sophia_web_tools() -> list[BaseTool]:
    """Load the configured DeerFlow-native web tools Sophia should inherit.

    Fails open with an empty list when:
    - No ``config.yaml`` is present (test environments, fresh checkouts).
      ``get_app_config`` raises ``FileNotFoundError`` in that case; we catch
      it so ``make_sophia_agent`` can still construct a working companion
      that simply has no native web tools (it will continue to delegate web
      research to Builder via ``switch_to_builder`` as it did before B1).
    - The config has no ``tools:`` block at all (``config.tools`` is None).
    - A configured tool fails to resolve (missing dependency, broken
      ``use:`` path, etc.). Each tool is resolved independently so a
      single broken provider doesn't disable the others.

    The codex bot review on PR #81 surfaced this: the prior version of this
    function called ``get_app_config()`` unconditionally, which made
    ``make_sophia_agent`` raise ``FileNotFoundError`` in any context
    without a config file. Failing open keeps agent construction
    config-free.
    """
    try:
        config = get_app_config()
    except FileNotFoundError:
        logger.info(
            "Sophia web tools: no config.yaml found; web tools disabled "
            "(companion delegates to Builder for web research)."
        )
        return []
    except Exception:
        logger.warning(
            "Sophia web tools: failed to load app config; web tools disabled.",
            exc_info=True,
        )
        return []

    tool_configs = getattr(config, "tools", None) or []
    tools: list[BaseTool] = []
    seen: set[str] = set()

    for tool_config in tool_configs:
        name = getattr(tool_config, "name", None)
        if name not in _SOPHIA_WEB_TOOL_NAMES or name in seen:
            continue
        try:
            tools.append(resolve_variable(tool_config.use, BaseTool))
            seen.add(name)
        except Exception:
            logger.warning(
                "Sophia web tools: failed to resolve %s; skipping.",
                name,
                exc_info=True,
            )

    logger.info(
        "Loaded %d Sophia web tool(s): %s",
        len(tools),
        ", ".join(sorted(seen)) or "none",
    )
    return tools
