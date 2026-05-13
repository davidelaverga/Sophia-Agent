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

        # (parent_thread_id, run_id) -> (chat_id, message_id). Keyed on
        # PARENT (the companion's thread) not the builder's, because that's
        # what the channel_store maps to a Telegram chat. The run_id half
        # of the key prevents back-to-back builds on the same parent
        # thread from clobbering each other's chat surface (Codex review
        # 2026-05-13). Companion duplicate-launch protection makes the
        # truly concurrent case rare, but rapid retries through retry
        # buttons can still trigger it.
        self._placeholders: OrderedDict[tuple[str, str], tuple[str, int]] = OrderedDict()
        self._placeholders_lock = Lock()
        # Track the last text we wrote so we can skip no-op edits — keyed
        # by (parent_thread_id, run_id).
        self._last_text: dict[tuple[str, str], str] = {}
        # Most-recent run_id per parent_thread_id, used as fallback when
        # an event arrives without run_id (webhook-source terminals).
        self._latest_run_by_parent: dict[str, str] = {}

    # ---- BuilderEventSink protocol ----------------------------------------

    def accepts(self, event: BuilderEvent) -> bool:
        """Return True iff this event should land on the EI bot chat surface.

        Logs a named reason at DEBUG on every skip so production-side
        silence ("user never saw progress") can be diagnosed from a
        single grep on the gateway logs. Without this, every False path
        was indistinguishable from "no events ever fired".
        """
        reason = self._classify_skip(event)
        if reason is not None:
            logger.debug(
                "telegram_ei_chat.accepts.skip reason=%s parent_thread_id=%s event_type=%s run_id=%s",
                reason,
                event.parent_thread_id,
                event.event_type,
                event.run_id,
            )
            return False
        logger.debug(
            "telegram_ei_chat.accepts.ok parent_thread_id=%s event_type=%s run_id=%s",
            event.parent_thread_id,
            event.event_type,
            event.run_id,
        )
        return True

    def _classify_skip(self, event: BuilderEvent) -> str | None:
        """Return a skip-reason string, or None when the event is accepted.

        Extracted from ``accepts`` so the public method stays a flat
        log-then-return: keeps cyclomatic complexity well under sentrux's
        CC ≥ 16 threshold even with the added observability.
        """
        if not self._flag_check():
            return "flag_off"
        if event.parent_thread_id is None:
            return "no_parent"
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
            return "unsupported_event"
        origin = self._lookup_origin(event.parent_thread_id)
        if not origin:
            return "parent_not_bound"
        if origin.get("channel_name") != _EI_CHANNEL_NAME:
            return "wrong_channel"
        return None

    async def handle(self, event: BuilderEvent) -> None:
        logger.info(
            "telegram_ei_chat.handle.entered event_type=%s source=%s parent_thread_id=%s run_id=%s",
            event.event_type,
            event.source,
            event.parent_thread_id,
            event.run_id,
        )
        text = self._render_text(event)
        if not text:
            logger.debug(
                "telegram_ei_chat.render.empty event_type=%s",
                event.event_type,
            )
            return

        parent_thread_id = event.parent_thread_id
        assert parent_thread_id is not None  # accepts() short-circuits when None

        # Resolve the effective run_id we'll key state on. Stream events
        # carry the canonical value; webhook terminals fall back to the
        # most-recent registered run for this parent thread.
        effective_run_id = event.run_id or self._latest_run_by_parent.get(parent_thread_id)
        text_key = (parent_thread_id, effective_run_id or "")

        # Dedup no-op edits before any IO.
        if self._last_text.get(text_key) == text:
            return

        channel = self._get_channel()
        if channel is None:
            logger.warning(
                "telegram_ei_chat.no_channel parent_thread_id=%s",
                parent_thread_id,
            )
            return

        placeholder = self._get_placeholder(parent_thread_id, event.run_id)
        if placeholder is None:
            await self._post_new_placeholder(channel, event, parent_thread_id, text)
            return

        await self._edit_existing_placeholder(channel, event, parent_thread_id, placeholder, text, text_key)

        if event.is_terminal and event.source == "webhook" and effective_run_id is not None:
            self._clear_terminal_state(parent_thread_id, effective_run_id)

    async def _post_new_placeholder(
        self,
        channel,
        event: BuilderEvent,
        parent_thread_id: str,
        text: str,
    ) -> None:
        """Post a fresh placeholder for the first event of a (parent, run) pair.

        Only auto-creates when the event carries a ``run_id``
        (stream-source) — webhook terminals without a matching prior
        placeholder would otherwise spawn a post-hoc bubble for a build
        whose progress we never showed.
        """
        if event.run_id is None:
            logger.debug(
                "telegram_ei_chat.post.skip reason=webhook_without_run_id parent_thread_id=%s",
                parent_thread_id,
            )
            return
        origin = self._lookup_origin(parent_thread_id)
        if not origin:
            # Race: the parent_thread_id was bound when accepts() ran
            # but is gone now. Skip; next event will re-check.
            logger.warning(
                "telegram_ei_chat.post.skip reason=parent_unbound_at_post parent_thread_id=%s",
                parent_thread_id,
            )
            return
        chat_id = str(origin.get("chat_id") or "")
        if not chat_id:
            logger.warning(
                "telegram_ei_chat.post.skip reason=empty_chat_id parent_thread_id=%s",
                parent_thread_id,
            )
            return

        # Prefer claiming the EI bot's existing "Working on it..." running
        # reply over posting a fresh placeholder. Production observation
        # 2026-05-13: without this claim the chat stacked
        # running-reply + sink-placeholder + companion's text in quick
        # succession; the sink-placeholder was visually buried and users
        # perceived "no streaming" even when edits were firing.
        claimed_message_id = self._claim_running_reply(channel, chat_id)
        if claimed_message_id is not None:
            await self._adopt_running_reply(
                channel=channel,
                parent_thread_id=parent_thread_id,
                run_id=event.run_id,
                chat_id=chat_id,
                message_id=claimed_message_id,
                text=text,
            )
            return

        logger.info(
            "telegram_ei_chat.post.attempt parent_thread_id=%s run_id=%s chat_id=%s text_preview=%s",
            parent_thread_id,
            event.run_id,
            chat_id,
            text[:80].replace("\n", " "),
        )
        try:
            message_id = await channel.relay_builder_event_post(
                chat_id=chat_id,
                text=text[:_TELEGRAM_TEXT_LIMIT],
            )
        except Exception:
            logger.warning(
                "telegram_ei_chat.post.failed parent_thread_id=%s reason=exception",
                parent_thread_id,
                exc_info=True,
            )
            return
        if message_id is None:
            # post failed silently inside the channel adapter; log and let
            # next event retry.
            logger.warning(
                "telegram_ei_chat.post.failed parent_thread_id=%s reason=channel_returned_none",
                parent_thread_id,
            )
            return
        logger.info(
            "telegram_ei_chat.post.ok parent_thread_id=%s run_id=%s chat_id=%s message_id=%s",
            parent_thread_id,
            event.run_id,
            chat_id,
            message_id,
        )
        self._register_placeholder(parent_thread_id, event.run_id, chat_id, message_id)
        self._last_text[(parent_thread_id, event.run_id)] = text

    @staticmethod
    def _claim_running_reply(channel, chat_id: str) -> int | None:
        """Pop the channel's pending running reply if available.

        Returns None when the channel doesn't expose the claim API
        (older versions) or has no pending reply for this chat.
        """
        claim = getattr(channel, "claim_pending_running_reply", None)
        if not callable(claim):
            return None
        try:
            return claim(chat_id)
        except Exception:
            logger.debug("telegram_ei_chat.claim.failed chat_id=%s", chat_id, exc_info=True)
            return None

    async def _adopt_running_reply(
        self,
        *,
        channel,
        parent_thread_id: str,
        run_id: str,
        chat_id: str,
        message_id: int,
        text: str,
    ) -> None:
        """Take ownership of the EI bot's existing running-reply message.

        Edits "Working on it..." in place with the first stream event's
        text (typically the ``started`` event's "🔨 Working on your
        request…") and registers the message as our placeholder so
        subsequent events edit the same message.
        """
        logger.info(
            "telegram_ei_chat.claim.ok parent_thread_id=%s run_id=%s chat_id=%s message_id=%s",
            parent_thread_id,
            run_id,
            chat_id,
            message_id,
        )
        try:
            await channel.relay_builder_event_edit(
                chat_id=chat_id,
                message_id=message_id,
                text=text[:_TELEGRAM_TEXT_LIMIT],
            )
        except Exception:
            logger.warning(
                "telegram_ei_chat.claim.edit_failed parent_thread_id=%s reason=exception",
                parent_thread_id,
                exc_info=True,
            )
            # Don't register — leave the placeholder unclaimed so the
            # next event retries via the regular post-new path.
            return
        self._register_placeholder(parent_thread_id, run_id, chat_id, message_id)
        self._last_text[(parent_thread_id, run_id)] = text

    async def _edit_existing_placeholder(
        self,
        channel,
        event: BuilderEvent,
        parent_thread_id: str,
        placeholder: tuple[str, int],
        text: str,
        text_key: tuple[str, str],
    ) -> None:
        """Edit the in-place placeholder; update the dedup cache first.

        Updating ``self._last_text`` before the IO keeps the dedup
        accurate even when the edit raises (the user sees the same text
        on retry instead of double-edits).
        """
        chat_id, message_id = placeholder
        self._last_text[text_key] = text
        logger.info(
            "telegram_ei_chat.edit.attempt parent_thread_id=%s run_id=%s chat_id=%s message_id=%s event_type=%s",
            parent_thread_id,
            event.run_id,
            chat_id,
            message_id,
            event.event_type,
        )
        try:
            await channel.relay_builder_event_edit(
                chat_id=chat_id,
                message_id=message_id,
                text=text[:_TELEGRAM_TEXT_LIMIT],
            )
        except Exception:
            logger.warning(
                "telegram_ei_chat.edit.failed parent_thread_id=%s event=%s reason=exception",
                parent_thread_id,
                event.event_type,
                exc_info=True,
            )
            return
        logger.debug(
            "telegram_ei_chat.edit.ok parent_thread_id=%s run_id=%s message_id=%s",
            parent_thread_id,
            event.run_id,
            message_id,
        )

    def _clear_terminal_state(self, parent_thread_id: str, effective_run_id: str) -> None:
        """Drop placeholder + dedup entry on webhook-source terminals.

        Stream-source synthetic terminals are provisional — a real
        webhook may arrive within the fanout's TTL with the rich payload
        (artifact_url, summary). We keep the placeholder alive in that
        case so the webhook re-render hits the same Telegram message.
        Mirrors the Work bot sink's source-aware dedup.
        """
        cleanup_key = (parent_thread_id, effective_run_id)
        with self._placeholders_lock:
            self._placeholders.pop(cleanup_key, None)
            if self._latest_run_by_parent.get(parent_thread_id) == effective_run_id:
                self._latest_run_by_parent.pop(parent_thread_id, None)
        self._last_text.pop(cleanup_key, None)

    # ---- Placeholder bookkeeping ------------------------------------------

    def _register_placeholder(self, parent_thread_id: str, run_id: str, chat_id: str, message_id: int) -> None:
        key = (parent_thread_id, run_id)
        with self._placeholders_lock:
            self._placeholders[key] = (chat_id, message_id)
            self._placeholders.move_to_end(key)
            self._latest_run_by_parent[parent_thread_id] = run_id
            while len(self._placeholders) > _PLACEHOLDER_LRU_MAX:
                evicted_key, _ = self._placeholders.popitem(last=False)
                self._last_text.pop(evicted_key, None)
                e_parent, e_run = evicted_key
                if self._latest_run_by_parent.get(e_parent) == e_run:
                    self._latest_run_by_parent.pop(e_parent, None)

    def _get_placeholder(self, parent_thread_id: str, run_id: str | None = None) -> tuple[str, int] | None:
        """Look up a placeholder.

        Exact-match-only when ``run_id`` is provided so a new run doesn't
        inherit a previous run's bubble via fallback. ``None`` falls back
        to the most-recent placeholder for the parent (webhook case).
        """
        with self._placeholders_lock:
            if run_id is not None:
                return self._placeholders.get((parent_thread_id, run_id))
            fallback_run = self._latest_run_by_parent.get(parent_thread_id)
            if fallback_run is None:
                return None
            return self._placeholders.get((parent_thread_id, fallback_run))

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
