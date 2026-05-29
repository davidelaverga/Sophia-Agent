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

from deerflow.agents.middlewares.view_image_middleware import (
    ViewImageMiddleware,
    ViewImageMiddlewareState,
)


class ClearOnInjectViewImageMiddleware(ViewImageMiddleware):
    """Upstream ``ViewImageMiddleware`` + clear-after-inject.

    Codex P2 PR #132 (latest iteration) — accumulation guard.

    The upstream injector returns ``{"messages": [human_msg]}`` but
    leaves ``state["viewed_images"]`` populated, so each follow-up
    ``view_image`` / ``view_user_image`` call's update MERGES (via
    ``merge_viewed_images``) into the prior entries. Three or four
    near-10 MiB images later the model request exceeds Anthropic's
    32 MB envelope; even before that, the model re-reasons over
    stale images not relevant to the current turn.

    Fix: after injecting the HumanMessage with image blocks, clear
    ``viewed_images`` via the reducer's empty-dict sentinel. The
    just-injected base64 lives in conversation history (the
    HumanMessage), so the model still sees the image this turn.
    Subsequent view-image calls write into the cleared dict →
    REPLACE semantics, no accumulation.

    Trade-off: if the model wants to reference the SAME image many
    turns later it has to re-call the tool. That's cheap — the file
    is still on disk, one base64 round-trip per re-view.

    Used directly by the BUILDER chain (which calls the upstream
    ``view_image`` tool) and extended by ``SophiaViewImageMiddleware``
    on the COMPANION side (which adds ``view_user_image`` recognition
    + skip-on-empty).
    """

    @override
    def _inject_image_message(
        self, state: ViewImageMiddlewareState
    ) -> dict | None:
        update = super()._inject_image_message(state)
        if update is None:
            return None
        return {**update, "viewed_images": {}}


class SophiaViewImageMiddleware(ClearOnInjectViewImageMiddleware):
    """Recognizes both ``view_image`` and ``view_user_image`` tool calls.

    Inherits the clear-after-inject behaviour from
    ``ClearOnInjectViewImageMiddleware``.

    Also skips injection entirely when ``viewed_images`` is empty
    (Codex P2 on PR #132 later iteration). The companion-side
    ``view_user_image`` clears ``viewed_images`` on every failure path
    so a stale image from a previous successful call doesn't survive
    into the next turn's injection. Without this middleware-side
    skip, an empty ``viewed_images`` would still satisfy upstream's
    ``_should_inject_image_message`` (it only checks for view-tool
    calls, not for image presence) and the upstream
    ``_create_image_details_message`` would synthesize a misleading
    "No images have been viewed." HumanMessage into the next turn.
    """

    _VISION_TOOL_NAMES: frozenset[str] = frozenset({"view_image", "view_user_image"})

    @override
    def _has_view_image_tool(self, message: AIMessage) -> bool:
        if not hasattr(message, "tool_calls") or not message.tool_calls:
            return False
        return any(
            tc.get("name") in self._VISION_TOOL_NAMES
            for tc in message.tool_calls
        )

    @override
    def _should_inject_image_message(
        self, state: ViewImageMiddlewareState
    ) -> bool:
        # Defense in depth (Codex P2 PR #132 later iteration). The
        # tool-side failure path clears ``viewed_images: {}``; this
        # check ensures the cleared state doesn't reflect as a "No
        # images have been viewed." injection.
        #
        # The check sits BEFORE the parent's tool-call / completion
        # checks so the early-return is cheap and unambiguous: if
        # there's nothing to inject, there's nothing to inject —
        # regardless of which tool calls were in the latest AIMessage.
        viewed_images = state.get("viewed_images") or {}
        if not viewed_images:
            return False
        return super()._should_inject_image_message(state)
