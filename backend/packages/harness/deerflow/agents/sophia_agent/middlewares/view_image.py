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

The builder exposes ``view_image_tool`` under its native name and uses
``ClearOnInjectViewImageMiddleware`` so repeated image views replace
stale base64-bearing messages — see ``builder_middlewares.py`` for that
wiring.
"""

from __future__ import annotations

import uuid
from typing import override

from langchain_core.messages import AIMessage, RemoveMessage

from deerflow.agents.middlewares.view_image_middleware import (
    ViewImageMiddleware,
    ViewImageMiddlewareState,
)

# Marker stamped into ``additional_kwargs`` of every image HumanMessage this
# middleware injects, so a later turn can find and prune the prior ones.
# Codex P2 PR #132 (accumulation guard, persistent-channel half).
_INJECTED_IMAGE_MARKER = "sophia_injected_image"


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

    Fix has TWO halves:

    1. ``viewed_images`` clear — after injecting the HumanMessage with
       image blocks, clear ``viewed_images`` via the reducer's
       empty-dict sentinel. Subsequent view-image calls write into the
       cleared dict → REPLACE semantics for the state channel.

    2. Persistent-channel prune (Codex P2 PR #132, later iteration) —
       clearing ``viewed_images`` alone is NOT enough: the base64
       HumanMessage that ``super()._inject_image_message`` appends lives
       in the persistent ``messages`` channel (``add_messages`` reducer),
       so it survives into every later model call. Two or three
       near-10 MiB views would still blow Anthropic's 32 MB request
       envelope despite the intended REPLACE semantics. So we ALSO stamp
       each injected image message with a marker + stable id and, on each
       new injection, emit ``RemoveMessage(id=...)`` for every PRIOR
       injected image message in history. The reducer drops the old
       base64-bearing messages while appending the fresh one — only the
       current turn's images ever live in context.

    The just-injected base64 still lives in this turn's history (the new
    HumanMessage), so the model sees the image this turn.

    Trade-off: if the model wants to reference the SAME image many turns
    later it has to re-call the tool. That's cheap — the file is still on
    disk, one base64 round-trip per re-view.

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

        # Stamp the freshly-injected image message(s) with the marker +
        # a stable id so a future turn can prune them.
        injected = update.get("messages") or []
        for msg in injected:
            try:
                if not getattr(msg, "id", None):
                    msg.id = f"sophia-img-{uuid.uuid4().hex}"
                msg.additional_kwargs[_INJECTED_IMAGE_MARKER] = True
            except (AttributeError, TypeError):
                # Defensive: if the message shape is unexpected, skip
                # tagging — the viewed_images clear below still applies.
                continue

        # Prune every PRIOR injected image message from the persistent
        # ``messages`` channel so accumulated base64 can't pile up across
        # turns. RemoveMessage(id=...) is honored by the ``add_messages``
        # reducer. We never prune the ones we just added (different ids).
        new_ids = {getattr(m, "id", None) for m in injected}
        removals = [
            RemoveMessage(id=mid)
            for mid in self._prior_injected_image_ids(state)
            if mid not in new_ids
        ]

        return {
            **update,
            "messages": [*removals, *injected],
            "viewed_images": {},
        }

    def _prior_injected_image_ids(
        self, state: ViewImageMiddlewareState
    ) -> list[str]:
        """Return ids of image messages this middleware injected earlier.

        Identified by the ``_INJECTED_IMAGE_MARKER`` stamp in
        ``additional_kwargs`` (plus a non-empty id, required for
        ``RemoveMessage``). Messages without the marker — ordinary user
        text, tool results, AI turns — are never touched.
        """
        ids: list[str] = []
        for msg in state.get("messages", []) or []:
            kwargs = getattr(msg, "additional_kwargs", None) or {}
            if kwargs.get(_INJECTED_IMAGE_MARKER) and getattr(msg, "id", None):
                ids.append(msg.id)
        return ids


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
