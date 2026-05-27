"""Sophia-side ViewImageMiddleware variant.

Upstream ``ViewImageMiddleware`` (deerflow.agents.middlewares.view_image_middleware)
hard-codes its tool-name check to ``"view_image"`` — it only fires when the
previous AIMessage's tool calls include that exact name.

The Sophia companion exposes a narrow wrapper named ``view_user_image``
(filename-scoped to the current thread's uploads + outputs dirs, so the
LLM can't address other threads' filesystems). When that wrapper is what
the model called, the upstream middleware's check returns False and the
captured image is never injected into the next turn — defeating the
purpose of the wrapper.

This subclass recognizes both names. Everything else (state schema,
injection format, completion detection, idempotency) is inherited
unchanged from upstream so future fixes to the injection logic flow
through automatically.

The builder uses upstream ``ViewImageMiddleware`` directly because it
exposes ``view_image_tool`` under its native name — see
``builder_middlewares.py`` for that wiring.
"""

from __future__ import annotations

from typing import override

from langchain_core.messages import AIMessage

from deerflow.agents.middlewares.view_image_middleware import ViewImageMiddleware


class SophiaViewImageMiddleware(ViewImageMiddleware):
    """Recognizes both ``view_image`` and ``view_user_image`` tool calls."""

    _VISION_TOOL_NAMES: frozenset[str] = frozenset({"view_image", "view_user_image"})

    @override
    def _has_view_image_tool(self, message: AIMessage) -> bool:
        if not hasattr(message, "tool_calls") or not message.tool_calls:
            return False
        return any(
            tc.get("name") in self._VISION_TOOL_NAMES
            for tc in message.tool_calls
        )
