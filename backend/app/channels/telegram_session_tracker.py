"""Inactivity-driven session finalization for Telegram chats.

Mirrors ``app.gateway.inactivity_watcher`` (which finalizes web sessions on
10-min idle) but keys on Telegram ``chat_id`` instead of LangGraph
``thread_id``. The watcher fires the offline pipeline for each chat that
has gone idle, pauses the persisted session record, and triggers the
"memories ready" review notification (Phase B).

A "session" on Telegram is bounded by the inactivity timer. The first
inbound message after the previous session's finalization mints a fresh
``session_id`` (UUID4) and creates a ``SessionRecord`` so the offline
pipeline can write a valid trace under ``users/{user_id}/traces/{session_id}.json``
and Mem0 candidates land under the right user.

In-memory state resets on server restart. The pipeline's own idempotency
guard prevents double processing if a chat happens to be re-tracked with
the same ``session_id`` after a transient failure.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from deerflow.sophia.session_store import SessionRecord, SessionStore

logger = logging.getLogger(__name__)

# Configurable thresholds (matched to ``inactivity_watcher``).
INACTIVITY_TIMEOUT = 600  # 10 minutes
CHECK_INTERVAL = 60

# In-memory chat tracking. Keyed by chat_id.
_active_chats: dict[str, dict] = {}
_watcher_task: asyncio.Task | None = None
_store = SessionStore()


def _now() -> float:
    return time.time()


def _new_session_id() -> str:
    return uuid.uuid4().hex


def register_activity(
    chat_id: str,
    user_id: str,
    thread_id: str,
    *,
    context_mode: str = "life",
    platform: str = "text",
) -> str:
    """Record activity for ``chat_id``; mint a fresh session if none is live.

    Returns the active ``session_id``. The caller (channel manager) does
    not need to do anything with it — it's returned for tests and for any
    future trace logging that needs to attach a session id to the inbound.
    The web pattern in ``app.gateway.routers.sessions`` keeps session_id
    knowledge on the server side too.
    """
    if not chat_id or not user_id or not thread_id:
        # Defensive: don't track unmappable chats. Manager should always
        # provide all three.
        logger.debug(
            "telegram_session_tracker.register_activity_skipped chat_id=%r user_id=%r thread_id=%r",
            chat_id,
            user_id,
            thread_id,
        )
        return ""

    existing = _active_chats.get(chat_id)
    if existing is not None and existing.get("user_id") == user_id:
        # Same user, same chat, still within the live window — just reset
        # the timer. Keep the existing session_id.
        existing["last_active"] = _now()
        existing["thread_id"] = thread_id
        return existing["session_id"]

    # New session: either nothing tracked, or the prior entry was bound to
    # a different user_id (rebind via /start). The previous session, if
    # any, was either already finalized by the watcher OR will time out
    # naturally — overwriting here is safe because the watcher pops its
    # entry as soon as it fires.
    session_id = _new_session_id()
    _active_chats[chat_id] = {
        "user_id": user_id,
        "session_id": session_id,
        "thread_id": thread_id,
        "context_mode": context_mode,
        "platform": platform,
        "last_active": _now(),
    }

    # Persist the session so the offline pipeline / handoff / sessions
    # router all see a record consistent with the web flow. Best-effort:
    # disk write failures must not break message delivery.
    try:
        _store.create(
            SessionRecord(
                session_id=session_id,
                thread_id=thread_id,
                user_id=user_id,
                status="open",
                preset_type="open",
                context_mode=context_mode,
                platform=platform,
            )
        )
    except Exception:
        logger.warning(
            "telegram_session_tracker.session_create_failed chat_id=%s user_id=%s session_id=%s",
            chat_id,
            user_id,
            session_id,
            exc_info=True,
        )
    logger.info(
        "telegram_session_tracker.session_started chat_id=%s user_id=%s session_id=%s thread_id=%s",
        chat_id,
        user_id,
        session_id,
        thread_id,
    )
    return session_id


def unregister_chat(chat_id: str) -> None:
    """Drop a chat from tracking (e.g. after explicit /new command)."""
    removed = _active_chats.pop(chat_id, None)
    if removed:
        logger.debug("telegram_session_tracker.unregister chat_id=%s", chat_id)


def get_active_chat_count() -> int:
    return len(_active_chats)


def get_session_id(chat_id: str) -> str | None:
    """Return the live session_id for ``chat_id`` or None."""
    info = _active_chats.get(chat_id)
    return info["session_id"] if info else None


def _pause_tracked_session(user_id: str, session_id: str) -> None:
    record = _store.pause(user_id, session_id)
    if record is None:
        logger.debug(
            "telegram_session_tracker.no_session_record_to_pause user_id=%s session_id=%s",
            user_id,
            session_id,
        )


async def _check_inactive_chats() -> None:
    now = _now()
    idle = [
        (cid, info)
        for cid, info in list(_active_chats.items())
        if now - info["last_active"] > INACTIVITY_TIMEOUT
    ]
    for chat_id, info in idle:
        user_id = info["user_id"]
        session_id = info["session_id"]
        thread_id = info["thread_id"]
        logger.info(
            "telegram_session_tracker.idle chat_id=%s user_id=%s session_id=%s thread_id=%s",
            chat_id,
            user_id,
            session_id,
            thread_id,
        )
        try:
            from deerflow.sophia.offline_pipeline import run_offline_pipeline

            await asyncio.to_thread(
                run_offline_pipeline,
                user_id,
                session_id,
                thread_id,
                None,  # thread_state — pipeline fetches from LangGraph if None
            )
        except Exception:
            logger.warning(
                "telegram_session_tracker.pipeline_failed chat_id=%s session_id=%s",
                chat_id,
                session_id,
                exc_info=True,
            )

        try:
            _pause_tracked_session(user_id, session_id)
        except Exception:
            logger.warning(
                "telegram_session_tracker.pause_failed chat_id=%s session_id=%s",
                chat_id,
                session_id,
                exc_info=True,
            )

        # Phase B (review notification) — best-effort. Imported lazily so
        # tests / older deployments without the notifier still load this
        # module fine. Notifier may be sync or async; await if it's a
        # coroutine.
        try:
            from app.channels.telegram_review_notifier import (
                enqueue_review_notification,
            )

            result = enqueue_review_notification(chat_id, user_id, session_id)
            if asyncio.iscoroutine(result):
                await result
        except ImportError:
            # Notifier not yet deployed — fine, Phase A still finalizes.
            logger.debug("telegram_session_tracker.notifier_unavailable")
        except Exception:
            logger.warning(
                "telegram_session_tracker.notify_failed chat_id=%s session_id=%s",
                chat_id,
                session_id,
                exc_info=True,
            )

        _active_chats.pop(chat_id, None)


async def _watcher_loop() -> None:
    logger.info(
        "telegram_session_tracker.started timeout=%ds interval=%ds",
        INACTIVITY_TIMEOUT,
        CHECK_INTERVAL,
    )
    try:
        while True:
            await asyncio.sleep(CHECK_INTERVAL)
            try:
                await _check_inactive_chats()
            except Exception:
                logger.warning("telegram_session_tracker.check_failed", exc_info=True)
    except asyncio.CancelledError:
        logger.info("telegram_session_tracker.stopped")


async def start_watcher() -> None:
    global _watcher_task
    if _watcher_task is not None:
        return
    _watcher_task = asyncio.create_task(_watcher_loop())


async def stop_watcher() -> None:
    global _watcher_task
    if _watcher_task is not None:
        _watcher_task.cancel()
        try:
            await _watcher_task
        except asyncio.CancelledError:
            pass
        _watcher_task = None


def reset_watcher() -> None:
    """Wipe in-memory state. For tests only."""
    _active_chats.clear()
