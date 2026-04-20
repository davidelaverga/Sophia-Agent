"""Defensive monkeypatches for langchain core/agents.

langchain==1.2.3 ships a bug in
``langchain.agents.factory._fetch_last_ai_and_tool_messages`` where the
local ``last_ai_index`` variable is only assigned inside the loop that
scans for the most recent ``AIMessage``. When ``state["messages"]`` has
no ``AIMessage`` (which can happen transiently in our chain, for example
right after a tool Command updates the message list, or when a middleware
hook returns a messages update that temporarily hides the AI turn), the
routing edge ``tools_to_model`` blows up with::

    UnboundLocalError: cannot access local variable 'last_ai_index'
    where it is not associated with a value

That UnboundLocalError is raised *after* ``switch_to_builder`` has already
scheduled the background builder task, so the builder keeps running
successfully while the companion SSE run fails. The voice adapter then
translates the SSE error into ``task_failed`` and the user sees
"An internal error occurred" even though the builder is still producing
output.

This patch makes the helper degrade gracefully: when no AIMessage is
found, return an empty AIMessage and an empty tool_messages list so the
routing edge falls through to ``model_destination`` instead of crashing.

The patch is idempotent and safe to import multiple times.
"""

from __future__ import annotations

import logging
from typing import cast

logger = logging.getLogger(__name__)

_PATCH_FLAG = "_deerflow_unbound_index_patched"


def _install_fetch_last_ai_patch() -> None:
    try:
        from langchain.agents import factory as _factory
        from langchain_core.messages import AIMessage, AnyMessage, ToolMessage
    except Exception:  # pragma: no cover - import-time safety net
        logger.debug("Skipping langchain factory patch: import failed", exc_info=True)
        return

    if getattr(_factory, _PATCH_FLAG, False):
        return

    def _safe_fetch_last_ai_and_tool_messages(
        messages: list[AnyMessage],
    ) -> tuple[AIMessage, list[ToolMessage]]:
        last_ai_index: int | None = None
        last_ai_message: AIMessage | None = None

        for i in range(len(messages) - 1, -1, -1):
            if isinstance(messages[i], AIMessage):
                last_ai_index = i
                last_ai_message = cast("AIMessage", messages[i])
                break

        if last_ai_index is None or last_ai_message is None:
            # Degenerate state: tools_to_model invoked but no AIMessage was
            # found in messages. Return sentinels so the routing edge can
            # continue back to the model instead of raising UnboundLocalError.
            logger.warning(
                "tools_to_model invoked with no AIMessage in state; "
                "returning empty sentinels (messages=%d).",
                len(messages),
            )
            return AIMessage(content="", tool_calls=[]), []

        tool_messages = [
            m for m in messages[last_ai_index + 1 :] if isinstance(m, ToolMessage)
        ]
        return last_ai_message, tool_messages

    _factory._fetch_last_ai_and_tool_messages = _safe_fetch_last_ai_and_tool_messages
    setattr(_factory, _PATCH_FLAG, True)
    logger.info(
        "Installed defensive patch for langchain.agents.factory._fetch_last_ai_and_tool_messages"
    )


def install_langchain_patches() -> None:
    """Apply all defensive langchain patches. Safe to call multiple times."""
    _install_fetch_last_ai_patch()


install_langchain_patches()
