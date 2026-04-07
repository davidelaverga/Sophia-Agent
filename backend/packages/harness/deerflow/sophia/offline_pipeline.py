"""Sophia offline pipeline orchestrator.

Fires on session end (WebRTC disconnect or 10-minute inactivity) and
processes the completed session through 7 steps:

1. Trace logging
2. Memory extraction
3. Smart opener generation
4. Notification (placeholder)
5. Handoff generation
6. Identity update
7. Visual artifact check (placeholder)

Each step is independent — failure in one does not block the others.
The pipeline is idempotent via a module-level ``_processed_sessions`` set.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import httpx

from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.sophia.extraction import extract_session_memories
from deerflow.sophia.handoffs import generate_handoff
from deerflow.sophia.identity import maybe_update_identity
from deerflow.sophia.smart_opener import generate_smart_opener
from deerflow.sophia.trace_logger import write_session_trace

logger = logging.getLogger(__name__)

# Module-level idempotency guard — sufficient for single-process deployments.
# If multi-process is needed later, upgrade to a file-based marker.
_processed_sessions: set[str] = set()
_processed_lock = threading.Lock()

_LANGGRAPH_URL = os.getenv("LANGGRAPH_URL", "http://localhost:2024")


def _fetch_thread_state(thread_id: str) -> dict[str, Any] | None:
    """Fetch thread state from the LangGraph server.

    Called when ``thread_state`` is not provided by the caller. The
    pipeline already runs in ``asyncio.to_thread``, so a synchronous
    HTTP call is fine.

    Returns the state values dict on success, or ``None`` on failure.
    """
    url = f"{_LANGGRAPH_URL}/threads/{thread_id}/state"
    try:
        resp = httpx.get(url, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        # LangGraph returns {"values": {...state...}, "next": [...], ...}
        values = data.get("values", data)
        if not values.get("messages"):
            logger.warning("Fetched thread state has no messages for thread %s", thread_id)
            return None
        return values
    except Exception:
        logger.warning("Failed to fetch thread state for thread %s", thread_id, exc_info=True)
        return None


def run_offline_pipeline(
    user_id: str,
    session_id: str,
    thread_id: str,
    thread_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the 7-step offline pipeline for a completed session.

    Args:
        user_id: The user identifier (validated at entry).
        session_id: The session identifier (used for idempotency).
        thread_id: The LangGraph thread ID.
        thread_state: Full thread state dict including ``messages`` and
            optionally ``configurable``, ``current_artifact``, etc.
            If ``None``, the pipeline fetches it from the LangGraph
            server using ``thread_id``.

    Returns:
        Summary dict with ``status`` and per-step results, e.g.::

            {"status": "completed", "steps": {"trace": "ok", ...}}

    Raises:
        ValueError: If ``user_id`` fails validation.
    """
    # --- Validate user_id at entry ---
    validate_user_id(user_id)

    # --- Idempotency check (atomic check-and-add to prevent TOCTOU race) ---
    with _processed_lock:
        if session_id in _processed_sessions:
            logger.info("Session %s already processed — skipping", session_id)
            return {"status": "already_processed", "session_id": session_id}
        _processed_sessions.add(session_id)

    # --- Thread state: fetch from LangGraph if not provided ---
    if thread_state is None:
        thread_state = _fetch_thread_state(thread_id)
        if thread_state is None:
            logger.warning(
                "No thread_state for session %s and fetch from LangGraph failed — aborting",
                session_id,
            )
            # Remove from processed set so a retry can succeed after a transient failure
            with _processed_lock:
                _processed_sessions.discard(session_id)
            return {"status": "error", "reason": "no_thread_state", "session_id": session_id}
        logger.info("Fetched thread_state from LangGraph for session %s", session_id)

    # --- Extract data from thread_state ---
    messages = thread_state.get("messages", [])
    session_metadata = _build_session_metadata(thread_state)
    artifacts = _extract_artifacts(thread_state)

    steps: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Step 1: Trace logging
    # ------------------------------------------------------------------
    try:
        write_session_trace(user_id, session_id, messages, session_metadata)
        steps["trace"] = "ok"
    except Exception:
        logger.error("Pipeline step 'trace' failed for session %s", session_id, exc_info=True)
        steps["trace"] = "error"

    # ------------------------------------------------------------------
    # Step 2: Memory extraction
    # ------------------------------------------------------------------
    extracted_memories: list[dict] = []
    try:
        serialized_messages = _serialize_messages(messages)
        extracted_memories = extract_session_memories(
            user_id, session_id, serialized_messages, session_metadata,
        )
        steps["extraction"] = "ok"
    except Exception:
        logger.error("Pipeline step 'extraction' failed for session %s", session_id, exc_info=True)
        steps["extraction"] = "error"

    # ------------------------------------------------------------------
    # Step 3: Smart opener generation
    # ------------------------------------------------------------------
    smart_opener_text: str = ""
    try:
        session_summary = _build_session_summary(messages)
        recent_memories = _format_memories_for_opener(extracted_memories)
        smart_opener_text = generate_smart_opener(
            user_id,
            session_summary,
            recent_memories=recent_memories,
        )
        steps["smart_opener"] = "ok"
    except Exception:
        logger.error("Pipeline step 'smart_opener' failed for session %s", session_id, exc_info=True)
        steps["smart_opener"] = "error"

    # ------------------------------------------------------------------
    # Step 4: Notification (placeholder)
    # ------------------------------------------------------------------
    try:
        logger.info("Memory candidates ready for review (user=%s, session=%s)", user_id, session_id)
        steps["notification"] = "ok"
    except Exception:
        logger.error("Pipeline step 'notification' failed for session %s", session_id, exc_info=True)
        steps["notification"] = "error"

    # ------------------------------------------------------------------
    # Step 5: Handoff generation
    # ------------------------------------------------------------------
    try:
        generate_handoff(
            user_id,
            session_id,
            messages,
            artifacts=artifacts,
            extracted_memories=extracted_memories,
            smart_opener_text=smart_opener_text or None,
        )
        steps["handoff"] = "ok"
    except Exception:
        logger.error("Pipeline step 'handoff' failed for session %s", session_id, exc_info=True)
        steps["handoff"] = "error"

    # ------------------------------------------------------------------
    # Step 6: Identity update
    # ------------------------------------------------------------------
    try:
        maybe_update_identity(user_id, extracted_memories)
        steps["identity"] = "ok"
    except Exception:
        logger.error("Pipeline step 'identity' failed for session %s", session_id, exc_info=True)
        steps["identity"] = "error"

    # ------------------------------------------------------------------
    # Step 7: Visual artifact check (placeholder)
    # ------------------------------------------------------------------
    try:
        sessions_this_week = _count_placeholder_sessions()
        logger.info(
            "Visual artifact check: %d sessions this week (user=%s)",
            sessions_this_week, user_id,
        )
        steps["visual_check"] = "ok"
    except Exception:
        logger.error("Pipeline step 'visual_check' failed for session %s", session_id, exc_info=True)
        steps["visual_check"] = "error"

    # (session_id already added at the top via _processed_lock)

    logger.info(
        "Offline pipeline completed for session %s: %s",
        session_id,
        steps,
    )

    return {
        "status": "completed",
        "session_id": session_id,
        "steps": steps,
    }


def reset_processed_sessions() -> None:
    """Clear the processed-sessions set.  For testing only."""
    _processed_sessions.clear()


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _build_session_metadata(thread_state: dict[str, Any]) -> dict[str, Any]:
    """Extract session-level metadata from thread_state.

    Pulls ``platform``, ``context_mode``, and ``ritual`` from either
    the top-level state dict or a nested ``configurable`` dict.
    """
    configurable = thread_state.get("configurable", {})

    return {
        "platform": (
            thread_state.get("platform")
            or configurable.get("platform", "text")
        ),
        "context_mode": (
            thread_state.get("context_mode")
            or configurable.get("context_mode", "life")
        ),
        "ritual": (
            thread_state.get("active_ritual")
            or configurable.get("ritual")
        ),
    }


def _extract_artifacts(thread_state: dict[str, Any]) -> list[dict]:
    """Collect artifact dicts from thread_state.

    Looks for ``current_artifact`` and ``previous_artifact`` keys, as
    well as a list at ``artifacts``.
    """
    artifacts: list[dict] = []

    if isinstance(thread_state.get("artifacts"), list):
        artifacts.extend(thread_state["artifacts"])

    for key in ("previous_artifact", "current_artifact"):
        art = thread_state.get(key)
        if isinstance(art, dict) and art:
            artifacts.append(art)

    return artifacts


def _serialize_messages(messages: list) -> list[dict]:
    """Convert LangChain BaseMessage objects to plain dicts.

    The extraction module expects ``[{"role": ..., "content": ...}]``.
    """
    result: list[dict] = []
    for msg in messages:
        # Already a dict?
        if isinstance(msg, dict):
            result.append(msg)
            continue

        role = getattr(msg, "type", "unknown")
        content = getattr(msg, "content", "")
        if isinstance(content, list):
            content = " ".join(
                p.get("text", "") for p in content if isinstance(p, dict)
            )

        # Map LangChain types to role strings
        role_map = {"human": "user", "ai": "assistant", "system": "system"}
        result.append({
            "role": role_map.get(role, role),
            "content": str(content),
        })
    return result


def _build_session_summary(messages: list) -> str:
    """Build a short plaintext summary from messages for the smart opener.

    Concatenates user and assistant messages into a compact transcript.
    Returns an empty string if there are no messages.
    """
    if not messages:
        return ""

    lines: list[str] = []
    for msg in messages:
        if isinstance(msg, dict):
            role = msg.get("role", "")
            content = msg.get("content", "")
        else:
            role = getattr(msg, "type", "")
            content = getattr(msg, "content", "")
            if isinstance(content, list):
                content = " ".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )

        content = str(content).strip()
        if not content:
            continue

        if role in ("human", "user"):
            lines.append(f"User: {content}")
        elif role in ("ai", "assistant"):
            lines.append(f"Sophia: {content}")

    return "\n".join(lines)


def _format_memories_for_opener(memories: list[dict]) -> str:
    """Format extracted memories into a string for the smart opener prompt."""
    if not memories:
        return "None available."

    lines: list[str] = []
    for mem in memories:
        content = mem.get("content", mem.get("memory", ""))
        category = mem.get("category", "unknown")
        if content:
            lines.append(f"- [{category}] {content}")
    return "\n".join(lines) if lines else "None available."


def _count_placeholder_sessions() -> int:
    """Placeholder for counting sessions this week.

    Real implementation will count trace files in the user's traces
    directory filtered by date.  For now returns 0.
    """
    return 0
