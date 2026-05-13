"""TelegramEIBotChatRelaySink — live progress in the EI bot chat.

Stage 2B's user-facing payoff: when Sophia (companion mode) launches a
builder via ``start_builder_task`` and ``BUILDER_LIVE_STREAM_ENABLED`` is
true, this sink shows live progress in the EI bot Telegram DM
(``@Sophia_EI_bot``) while the build runs — phase hints like
"🔎 researching…" and "🛠️ running scripts…" — instead of going dark
until the completion card lands.

Unlike the Work bot sink, the EI bot path has no pre-dispatch hook in
the channel adapter where a placeholder can be posted (dispatch happens
inside the companion graph via ``start_builder_task``). The sink posts
a fresh placeholder lazily on the FIRST renderable event it sees for a
parent_thread_id, then edits it in place on subsequent events.

Completion delivery (the artifact file + caption) remains owned by
``TelegramChannel._on_builder_completion`` via the channel ``MessageBus``
subscription — this sink only renders the progress trail and does NOT
deliver the file. Keeping the two paths independent means a sink
regression never blocks the final deliverable, and the spec's §11.3
"EI bot completion delivery migration" stays a separate future PR.

Loop affinity: this sink runs on the gateway loop. The EI bot's PTB
``Bot`` is affine to ``TelegramChannel._tg_loop``. Calls hop via
``TelegramChannel.relay_builder_event_{post,edit}``.
"""

from __future__ import annotations

import logging
import re
from collections import OrderedDict
from threading import Lock
from typing import Any

from app.gateway.builder_events.flags import is_live_stream_enabled
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


_EI_CHANNEL_NAME = "telegram"  # matches TelegramChannel.name
_PLACEHOLDER_LRU_MAX = 1024
_TELEGRAM_TEXT_LIMIT = 4096


# Map tool names to user-facing phase labels. Same vocabulary as the
# Work bot sink — the two surfaces should feel consistent to users who
# move between them. First regex hit wins.
_TOOL_PHASE_LABELS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"web_search|builder_web_search|tavily|jina|firecrawl"), "🔎 researching"),
    (re.compile(r"web_fetch|builder_web_fetch"), "🔗 fetching source"),
    (re.compile(r"bash"), "🛠️ running scripts"),
    (re.compile(r"write_file|str_replace"), "📝 drafting files"),
    (re.compile(r"read_file"), "📖 reading files"),
    (re.compile(r"image|chart|ppt"), "🎨 generating visuals"),
    (re.compile(r"emit_builder_artifact"), "📦 packaging artifact"),
]


class TelegramEIBotChatRelaySink:
    """Render live Builder progress into the EI bot chat (lazy placeholder)."""

    name = "telegram_ei_chat"

    def __init__(
        self,
        *,
        get_channel_service=None,
        get_channel_store=None,
        flag_check=is_live_stream_enabled,
    ) -> None:
        # Deps are injectable for tests.
        self._get_channel_service = get_channel_service or _default_channel_service
        self._get_channel_store = get_channel_store or _default_channel_store
        self._flag_check = flag_check

        # parent_thread_id -> (chat_id, message_id). Keyed on PARENT (the
        # companion's thread) not the builder's, because that's what the
        # channel_store maps to a Telegram chat. One placeholder per
        # parent thread per concurrent build.
        self._placeholders: OrderedDict[str, tuple[str, int]] = OrderedDict()
        self._placeholders_lock = Lock()
        # Track the last text we wrote so we can skip no-op edits.
        self._last_text: dict[str, str] = {}

    # ---- BuilderEventSink protocol ----------------------------------------

    def accepts(self, event: BuilderEvent) -> bool:
        if not self._flag_check():
            return False
        if event.parent_thread_id is None:
            # Stage 2A's Work bot sink owns the parent_thread_id=None path.
            return False
        if event.event_type not in {
            "started",
            "phase",
            "tool_started",
            "tool_completed",
            "completed",
            "failed",
            "cancelled",
            "timed_out",
        }:
            return False
        origin = self._lookup_origin(event.parent_thread_id)
        if not origin or origin.get("channel_name") != _EI_CHANNEL_NAME:
            return False
        return True

    async def handle(self, event: BuilderEvent) -> None:
        text = self._render_text(event)
        if not text:
            return

        parent_thread_id = event.parent_thread_id
        assert parent_thread_id is not None  # accepts() short-circuits when None

        # Dedup no-op edits before any IO.
        if self._last_text.get(parent_thread_id) == text:
            return

        channel = self._get_channel()
        if channel is None:
            logger.warning(
                "telegram_ei_chat.sink no_channel parent_thread_id=%s",
                parent_thread_id,
            )
            return

        placeholder = self._get_placeholder(parent_thread_id)
        if placeholder is None:
            # First renderable event for this parent — post a fresh
            # placeholder message so subsequent events can edit it in place.
            origin = self._lookup_origin(parent_thread_id)
            if not origin:
                # Race: the parent_thread_id was bound when accepts() ran
                # but is gone now. Skip; next event will re-check.
                return
            chat_id = str(origin.get("chat_id") or "")
            if not chat_id:
                return
            try:
                message_id = await channel.relay_builder_event_post(
                    chat_id=chat_id,
                    text=text[:_TELEGRAM_TEXT_LIMIT],
                )
            except Exception:
                logger.warning(
                    "telegram_ei_chat.sink post_failed parent_thread_id=%s",
                    parent_thread_id,
                    exc_info=True,
                )
                return
            if message_id is None:
                # post failed silently; let next event retry.
                return
            self._register_placeholder(parent_thread_id, chat_id, message_id)
            self._last_text[parent_thread_id] = text
            return

        # Edit the existing placeholder.
        chat_id, message_id = placeholder
        self._last_text[parent_thread_id] = text
        try:
            await channel.relay_builder_event_edit(
                chat_id=chat_id,
                message_id=message_id,
                text=text[:_TELEGRAM_TEXT_LIMIT],
            )
        except Exception:
            logger.warning(
                "telegram_ei_chat.sink edit_failed parent_thread_id=%s event=%s",
                parent_thread_id,
                event.event_type,
                exc_info=True,
            )

        # Clear placeholder + last_text ONLY on webhook-source terminals.
        # Stream-source synthetic terminals are provisional — a real
        # webhook may arrive within the fanout's TTL with the rich
        # payload (artifact_url, summary). Mirrors the Work bot sink's
        # source-aware dedup.
        if event.is_terminal and event.source == "webhook":
            with self._placeholders_lock:
                self._placeholders.pop(parent_thread_id, None)
            self._last_text.pop(parent_thread_id, None)

    # ---- Placeholder bookkeeping ------------------------------------------

    def _register_placeholder(self, parent_thread_id: str, chat_id: str, message_id: int) -> None:
        with self._placeholders_lock:
            self._placeholders[parent_thread_id] = (chat_id, message_id)
            self._placeholders.move_to_end(parent_thread_id)
            while len(self._placeholders) > _PLACEHOLDER_LRU_MAX:
                evicted, _ = self._placeholders.popitem(last=False)
                self._last_text.pop(evicted, None)

    def _get_placeholder(self, parent_thread_id: str) -> tuple[str, int] | None:
        with self._placeholders_lock:
            return self._placeholders.get(parent_thread_id)

    # ---- Internals --------------------------------------------------------

    def _lookup_origin(self, parent_thread_id: str) -> dict[str, Any] | None:
        store = self._get_channel_store()
        if store is None:
            return None
        return store.find_by_thread_id(parent_thread_id, channel_name=_EI_CHANNEL_NAME)

    def _get_channel(self):
        service = self._get_channel_service()
        if service is None:
            return None
        getter = getattr(service, "get_channel", None)
        if not callable(getter):
            return None
        return getter(_EI_CHANNEL_NAME)

    def _render_text(self, event: BuilderEvent) -> str:
        et = event.event_type
        payload = event.payload

        if et == "started":
            return "🔨 Working on your request…"

        if et == "phase":
            name = payload.get("phase_name") or "Working"
            return f"🔨 {name}…"

        if et == "tool_started":
            tool_name = (payload.get("tool_name") or "").lower()
            label = _label_for_tool(tool_name)
            return f"{label}…"

        if et == "tool_completed":
            tool_name = (payload.get("tool_name") or "").lower()
            if "emit_builder_artifact" in tool_name:
                return "✅ Wrapping up…"
            return ""

        if et == "completed":
            # Brief edit so the user sees the live trail end. The
            # artifact file + full summary still arrive via
            # TelegramChannel._on_builder_completion (bus path) — keeping
            # the two flows independent so a sink regression never
            # suppresses the final deliverable.
            summary = payload.get("companion_summary")
            if summary:
                return summary
            return "✅ Done — delivering your file…"

        if et in {"failed", "timed_out", "cancelled"}:
            err = payload.get("error_message") or "Couldn't finish that one."
            return f"Hit a snag: {err}"

        return ""


def _label_for_tool(tool_name: str) -> str:
    for pat, label in _TOOL_PHASE_LABELS:
        if pat.search(tool_name):
            return label
    return f"⚙️ {tool_name or 'working'}"


# ---- Default DI shims (resolved at call time, not import time) ------------


def _default_channel_service():
    from app.channels.service import get_channel_service

    return get_channel_service()


def _default_channel_store():
    service = _default_channel_service()
    if service is None:
        return None
    return getattr(service, "store", None)
