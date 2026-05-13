"""TelegramWorkBotChatRelaySink — edits the Work bot placeholder live.

Stage 2A's user-facing payoff: when ``BUILDER_LIVE_STREAM_ENABLED`` is
true, this sink edits the "🔨 Working on your request…" placeholder
that ``TelegramWorkChannel`` posts before dispatch. On terminal events
it shows the final summary; ``TelegramWorkChannel`` retains
responsibility for sending the artifact document (it owns the bytes
download path).

The sink is registered unconditionally in the gateway lifespan but its
``accepts()`` short-circuits when:

- the flag is off (Stage 1 blocking behaviour stays in effect), OR
- ``parent_thread_id`` is set (Builder is a subagent of companion,
  served by Stage 2B's ``CompanionChatRelaySink``), OR
- the thread isn't bound to the ``telegram_work`` channel.

Loop affinity: this sink runs on the gateway loop. The Work bot's
``python-telegram-bot`` ``Bot`` instance is affine to the channel's
``_tg_loop`` polling thread. The sink hops back via
``TelegramWorkChannel._run_bot_call_on_telegram_loop``.

Placeholder registry: ``TelegramWorkChannel._dispatch_build`` calls
``sink.register_placeholder(thread_id, run_id, chat_id, message_id)``
after posting the placeholder and before spawning the stream consumer.
The registry is keyed by ``(thread_id, run_id)`` so two builds running
on the same thread (rapid follow-up DM before the prior build finishes)
don't clobber each other's chat surface — Codex review 2026-05-13.
On gateway restart mid-run, the consumer loses its placeholder mapping
and ``handle()`` falls back to posting a fresh message (already absorbed
by ``_safe_edit``'s except branch on the channel side).

Webhook-source terminals don't carry ``run_id`` in the existing wire
contract, so the sink falls back to the most-recent placeholder for the
thread on lookup. In the normal case the stream-source synthetic
terminal (which DOES carry run_id) has already rendered and dedup'd the
webhook by the time it arrives; the fallback only kicks in for the
rare race where the webhook beats the stream's end.
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


_WORK_CHANNEL_NAME = "telegram_work"
_PLACEHOLDER_LRU_MAX = 1024
_TELEGRAM_TEXT_LIMIT = 4096


# Map tool names to user-facing phase labels. Lower-cased token match
# against tool name. First hit wins.
_TOOL_PHASE_LABELS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"web_search|builder_web_search|tavily|jina|firecrawl"), "🔎 researching"),
    (re.compile(r"web_fetch|builder_web_fetch"), "🔗 fetching source"),
    (re.compile(r"bash"), "🛠️ running scripts"),
    (re.compile(r"write_file|str_replace"), "📝 drafting files"),
    (re.compile(r"read_file"), "📖 reading files"),
    (re.compile(r"image|chart|ppt"), "🎨 generating visuals"),
    (re.compile(r"emit_builder_artifact"), "📦 packaging artifact"),
]


class TelegramWorkBotChatRelaySink:
    """Edit the Work bot placeholder as Builder progresses."""

    name = "telegram_work_chat"

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

        # (thread_id, run_id) -> (chat_id, message_id). Keying by run_id
        # protects against concurrent / back-to-back builds on the same
        # langgraph thread (Codex review 2026-05-13). The Work bot reuses
        # one thread per chat; without run_id keying, a rapid second DM
        # would overwrite the first build's placeholder mapping and
        # cross-render its in-flight events.
        self._placeholders: OrderedDict[tuple[str, str], tuple[str, int]] = OrderedDict()
        self._placeholders_lock = Lock()
        # Track the last text we wrote so we can skip no-op edits — also
        # keyed by (thread_id, run_id).
        self._last_text: dict[tuple[str, str], str] = {}
        # Most-recent run_id per thread, used as fallback when an event
        # arrives without run_id (webhook-source terminals don't carry it
        # in the current wire contract). Stream-source events always do.
        self._latest_run_by_thread: dict[str, str] = {}

    # ---- Registration API (called by TelegramWorkChannel) -----------------

    def register_placeholder(self, thread_id: str, run_id: str, chat_id: str, message_id: int) -> None:
        key = (thread_id, run_id)
        with self._placeholders_lock:
            self._placeholders[key] = (chat_id, message_id)
            self._placeholders.move_to_end(key)
            self._latest_run_by_thread[thread_id] = run_id
            while len(self._placeholders) > _PLACEHOLDER_LRU_MAX:
                evicted_key, _ = self._placeholders.popitem(last=False)
                self._last_text.pop(evicted_key, None)
                # If the evicted entry was the cached "latest" for its
                # thread, drop it so a stale pointer doesn't survive.
                e_thread, _ = evicted_key
                if self._latest_run_by_thread.get(e_thread) == evicted_key[1]:
                    self._latest_run_by_thread.pop(e_thread, None)

    def get_placeholder(self, thread_id: str, run_id: str | None = None) -> tuple[str, int] | None:
        """Look up a placeholder.

        When ``run_id`` is provided, only an exact (thread_id, run_id)
        match returns a hit — a miss returns ``None`` so a new run
        doesn't accidentally inherit the previous run's placeholder via
        fallback. When ``run_id`` is ``None`` (webhook terminals don't
        carry it in the current wire contract), fall back to the
        most-recently-registered placeholder for the thread.
        """
        with self._placeholders_lock:
            if run_id is not None:
                return self._placeholders.get((thread_id, run_id))
            fallback_run = self._latest_run_by_thread.get(thread_id)
            if fallback_run is None:
                return None
            return self._placeholders.get((thread_id, fallback_run))

    # ---- BuilderEventSink protocol ----------------------------------------

    def accepts(self, event: BuilderEvent) -> bool:
        if not self._flag_check():
            return False
        if event.parent_thread_id is not None:
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
        origin = self._lookup_origin(event.thread_id)
        if not origin or origin.get("channel_name") != _WORK_CHANNEL_NAME:
            return False
        return True

    async def handle(self, event: BuilderEvent) -> None:
        text = self._render_text(event)
        if not text:
            return

        placeholder = self.get_placeholder(event.thread_id, event.run_id)
        if not placeholder:
            # The channel didn't register a placeholder for this thread
            # (e.g. webhook for a thread that never entered streaming
            # mode). Skip — Stage 1 delivery already wrote the chat
            # surface in that path.
            return

        chat_id, message_id = placeholder
        # Resolve the effective run_id we're keying state on. When the
        # event carries one, use it directly; otherwise we matched via
        # the latest-run fallback (webhook race) so key the dedup map by
        # that same fallback entry to stay consistent.
        effective_run_id = event.run_id or self._latest_run_by_thread.get(event.thread_id, "")
        text_key = (event.thread_id, effective_run_id)
        if self._last_text.get(text_key) == text:
            return  # no-op edit
        self._last_text[text_key] = text

        channel = self._get_channel()
        if channel is None:
            logger.warning(
                "telegram_work_chat.sink no_channel thread_id=%s",
                event.thread_id,
            )
            return

        try:
            await channel.relay_builder_event_edit(
                chat_id=chat_id,
                message_id=message_id,
                text=text[:_TELEGRAM_TEXT_LIMIT],
            )
        except Exception:
            logger.warning(
                "telegram_work_chat.sink edit_failed thread_id=%s event=%s",
                event.thread_id,
                event.event_type,
                exc_info=True,
            )

        # On terminal with an artifact, deliver the file too — Stage 1's
        # _render_builder_result handled this; the streaming path skips
        # _render_builder_result so the sink takes over.
        if event.is_terminal:
            artifact_filename = event.payload.get("artifact_filename")
            if artifact_filename:
                try:
                    await channel.relay_artifact_document(
                        chat_id=chat_id,
                        thread_id=event.thread_id,
                        filename=str(artifact_filename),
                        caption=event.payload.get("artifact_title"),
                    )
                except Exception:
                    logger.warning(
                        "telegram_work_chat.sink artifact_failed thread_id=%s filename=%s",
                        event.thread_id,
                        artifact_filename,
                        exc_info=True,
                    )

            # Clear placeholder + last_text ONLY on webhook-source
            # terminals. Stream-source synthetic terminals are
            # provisional — a real webhook may arrive within the
            # fanout's TTL window with the rich payload (artifact_url,
            # signed summary), and the fanout will re-dispatch through
            # this sink. Keeping the placeholder alive lets that
            # re-render hit the same Telegram message.
            if event.source == "webhook":
                cleanup_run_id = effective_run_id
                with self._placeholders_lock:
                    self._placeholders.pop((event.thread_id, cleanup_run_id), None)
                    if self._latest_run_by_thread.get(event.thread_id) == cleanup_run_id:
                        self._latest_run_by_thread.pop(event.thread_id, None)
                self._last_text.pop((event.thread_id, cleanup_run_id), None)

    # ---- Internals --------------------------------------------------------

    def _lookup_origin(self, thread_id: str) -> dict[str, Any] | None:
        store = self._get_channel_store()
        if store is None:
            return None
        return store.find_by_thread_id(thread_id, channel_name=_WORK_CHANNEL_NAME)

    def _get_channel(self):
        service = self._get_channel_service()
        if service is None:
            return None
        getter = getattr(service, "get_channel", None)
        if not callable(getter):
            return None
        return getter(_WORK_CHANNEL_NAME)

    def _render_text(self, event: BuilderEvent) -> str:
        et = event.event_type
        payload = event.payload

        if et == "started":
            # Suppressed: TelegramWorkChannel posts the placeholder with
            # exactly this text BEFORE spawning the consumer, so an edit
            # here produces Telegram's `400 Message is not modified` and
            # the `_safe_edit` fallback posts a duplicate message.
            # ``started`` still flows through the fanout — it's what
            # resets the per-thread terminal flag for the new run — we
            # just don't redundantly re-render the placeholder.
            return ""

        if et == "phase":
            name = payload.get("phase_name") or "Working"
            return f"🔨 {name}…"

        if et == "tool_started":
            tool_name = (payload.get("tool_name") or "").lower()
            label = _label_for_tool(tool_name)
            return f"{label}…"

        if et == "tool_completed":
            # Don't churn on every tool completion — the next
            # tool_started will overwrite. Only render if the tool
            # represented a phase-ish boundary worth showing.
            tool_name = (payload.get("tool_name") or "").lower()
            if "emit_builder_artifact" in tool_name:
                return "✅ Wrapping up…"
            return ""

        if et == "completed":
            summary = payload.get("companion_summary") or "Done."
            return summary

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
