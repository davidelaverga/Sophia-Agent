"""Inactivity watcher — auto-fires the offline pipeline for idle sessions.

Tracks active threads and their last message timestamp. When a thread
has been idle for more than 10 minutes, fires the offline pipeline
asynchronously and removes the thread from tracking.

Thread tracking is in-memory (resets on server restart). The pipeline's
own idempotency guard prevents double processing.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

# Configurable thresholds
INACTIVITY_TIMEOUT = 600  # 10 minutes in seconds
CHECK_INTERVAL = 60  # Check every 60 seconds

# In-memory thread tracking
_active_threads: dict[str, dict] = {}
_watcher_task: asyncio.Task | None = None


def register_activity(
    thread_id: str,
    user_id: str,
    session_id: str,
    context_mode: str = "life",
) -> None:
    """Register or update activity for a thread.

    Called from the gateway when a Sophia request arrives.
    """
    _active_threads[thread_id] = {
        "user_id": user_id,
        "session_id": session_id,
        "context_mode": context_mode,
        "last_active": time.time(),
    }
    logger.debug("Activity registered: thread=%s user=%s", thread_id, user_id)


def unregister_thread(thread_id: str) -> None:
    """Remove a thread from tracking (e.g., on explicit session end)."""
    removed = _active_threads.pop(thread_id, None)
    if removed:
        logger.debug("Thread unregistered: %s", thread_id)


def get_active_thread_count() -> int:
    """Return the number of currently tracked threads."""
    return len(_active_threads)


async def _check_inactive_threads() -> None:
    """Check for idle threads and fire the offline pipeline for each."""
    now = time.time()
    idle_threads = [
        (tid, info)
        for tid, info in list(_active_threads.items())
        if now - info["last_active"] > INACTIVITY_TIMEOUT
    ]

    for thread_id, info in idle_threads:
        user_id = info["user_id"]
        session_id = info["session_id"]
        logger.info(
            "Thread %s idle for >%ds — firing offline pipeline (user=%s, session=%s)",
            thread_id, INACTIVITY_TIMEOUT, user_id, session_id,
        )
        try:
            from deerflow.sophia.offline_pipeline import run_offline_pipeline

            await asyncio.to_thread(
                run_offline_pipeline,
                user_id,
                session_id,
                thread_id,
                None,  # thread_state — pipeline handles missing state
            )
        except Exception:
            logger.warning(
                "Offline pipeline failed for idle thread %s", thread_id, exc_info=True,
            )
        finally:
            _active_threads.pop(thread_id, None)


async def _watcher_loop() -> None:
    """Background loop that checks for inactive threads periodically."""
    logger.info("Inactivity watcher started (timeout=%ds, interval=%ds)", INACTIVITY_TIMEOUT, CHECK_INTERVAL)
    try:
        while True:
            await asyncio.sleep(CHECK_INTERVAL)
            try:
                await _check_inactive_threads()
            except Exception:
                logger.warning("Inactivity check failed", exc_info=True)
    except asyncio.CancelledError:
        logger.info("Inactivity watcher stopped")


async def start_watcher() -> None:
    """Start the inactivity watcher background task."""
    global _watcher_task
    if _watcher_task is not None:
        return  # Already running
    _watcher_task = asyncio.create_task(_watcher_loop())


async def stop_watcher() -> None:
    """Stop the inactivity watcher gracefully."""
    global _watcher_task
    if _watcher_task is not None:
        _watcher_task.cancel()
        try:
            await _watcher_task
        except asyncio.CancelledError:
            pass
        _watcher_task = None


def reset_watcher() -> None:
    """Clear all tracked threads (for testing)."""
    _active_threads.clear()
