"""Offline pipeline — fires on WebRTC disconnect or 10-minute inactivity.

7 steps, idempotent — safe to run twice. Uses processed_sessions set
to prevent double processing.

Steps:
  1. Smart opener generation
  2. Handoff write
  3. Mem0 extraction (all memories written with status="pending_review")
  4. In-app notification
  5. Trace aggregation
  6. Identity update (every 10 sessions or on structural memory change)
  7. Visual artifact check (if 3+ sessions this week)
"""

from __future__ import annotations

import asyncio
import time

from app.sophia.extraction import extract_memories
from app.sophia.handoffs import load_handoff, write_handoff
from app.sophia.identity import get_session_count, should_update_identity, update_identity_file
from app.sophia.mem0_client import add_memory, invalidate_user_cache
from app.sophia.smart_opener import generate_smart_opener
from app.sophia.trace_logger import aggregate_traces

# Session tracking — prevent double processing
active_threads: dict[str, float] = {}  # {thread_id: last_activity_timestamp}
thread_user_map: dict[str, str] = {}  # {thread_id: user_id}
processed_sessions: set[str] = set()  # {session_id}


async def run_offline_pipeline(user_id: str, session_id: str, thread_id: str) -> None:
    """Run the full 7-step offline pipeline. Idempotent."""
    if session_id in processed_sessions:
        return
    processed_sessions.add(session_id)

    previous_handoff = load_handoff(user_id)
    session_artifacts: list[dict] = []  # TODO: load from thread
    session_memories: list[dict] = []  # TODO: load from Mem0

    # Step 1: Smart opener
    opener = await generate_smart_opener(
        user_id=user_id,
        previous_handoff=previous_handoff,
        session_artifacts=session_artifacts,
        session_memories=session_memories,
    )

    # Step 2: Handoff write
    # TODO(jorge): Generate handoff content via Claude Haiku
    handoff_content = f"---\nsmart_opener: \"{opener}\"\n---\n"
    write_handoff(user_id, handoff_content)

    # Step 3: Mem0 extraction
    memories = await extract_memories(
        user_id=user_id,
        session_id=session_id,
        session_artifacts=session_artifacts,
    )
    for memory in memories:
        metadata = {**memory.get("metadata", {}), "status": "pending_review"}
        add_memory(user_id, [{"role": "user", "content": memory["content"]}], session_id, metadata)
    invalidate_user_cache(user_id)

    # Step 4: In-app notification
    # TODO(jorge): Signal frontend (memory candidates pending review)

    # Step 5: Trace aggregation
    await aggregate_traces(user_id, session_id, session_artifacts)

    # Step 6: Identity update (conditional)
    session_count = get_session_count(user_id)
    if should_update_identity(user_id, session_count):
        await update_identity_file(user_id)

    # Step 7: Visual artifact check (conditional)
    # TODO(jorge): Check sessions this week >= 3, generate visual artifact


async def on_turn_complete(thread_id: str, user_id: str, session_id: str) -> None:
    """Called after every companion turn completes."""
    active_threads[thread_id] = time.time()
    thread_user_map[thread_id] = user_id


async def on_disconnect(thread_id: str) -> None:
    """Called on WebRTC disconnect from SophiaLLM."""
    if thread_id in active_threads:
        user_id = thread_user_map[thread_id]
        session_id = _get_session_id(thread_id)
        if session_id not in processed_sessions:
            asyncio.create_task(run_offline_pipeline(user_id, session_id, thread_id))
        del active_threads[thread_id]


async def inactivity_watcher() -> None:
    """Runs every 5 minutes. Fires offline pipeline for inactive threads."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for thread_id, last_active in list(active_threads.items()):
            if now - last_active > 600:  # 10 minutes
                user_id = thread_user_map[thread_id]
                session_id = _get_session_id(thread_id)
                if session_id not in processed_sessions:
                    asyncio.create_task(run_offline_pipeline(user_id, session_id, thread_id))
                del active_threads[thread_id]


def _get_session_id(thread_id: str) -> str:
    """Derive session_id from thread_id."""
    return f"session_{thread_id}"
