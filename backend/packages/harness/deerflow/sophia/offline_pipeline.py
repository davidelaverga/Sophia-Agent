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

import json
import logging
import os
import threading
from datetime import UTC, datetime
from typing import Any

import httpx

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path, validate_user_id
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

    logger.info(
        "session.finalization pipeline_start user_id=%s session_id=%s thread_id=%s has_thread_state=%s",
        user_id,
        session_id,
        thread_id,
        thread_state is not None,
    )

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
                "session.finalization pipeline_abort_no_thread_state user_id=%s session_id=%s thread_id=%s",
                user_id,
                session_id,
                thread_id,
            )
            # Remove from processed set so a retry can succeed after a transient failure
            with _processed_lock:
                _processed_sessions.discard(session_id)
            return {"status": "error", "reason": "no_thread_state", "session_id": session_id}
        logger.info("Fetched thread_state from LangGraph for session %s", session_id)

    # --- Extract data from thread_state ---
    messages = thread_state.get("messages", [])
    session_metadata = _build_session_metadata(thread_state, user_id=user_id, session_id=session_id)
    artifacts = _extract_artifacts(thread_state)

    logger.info(
        "session.finalization pipeline_context user_id=%s session_id=%s message_count=%s artifact_count=%s platform=%s context_mode=%s ritual=%s",
        user_id,
        session_id,
        len(messages),
        len(artifacts),
        session_metadata.get("platform"),
        session_metadata.get("context_mode"),
        session_metadata.get("ritual"),
    )

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
        logger.info(
            "session.finalization pipeline_extraction_complete user_id=%s session_id=%s memory_count=%s",
            user_id,
            session_id,
            len(extracted_memories),
        )
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
    # Step 5b: Recap envelope
    # ------------------------------------------------------------------
    # Channel-originated sessions (Telegram today, iOS / future channels
    # tomorrow) never trigger the web flow's POST /sessions/{id}/end, so
    # without this step they would have no ``users/{user_id}/recaps/{session_id}.json``
    # and the frontend ``/recap/<session>`` page would 404. The recap we
    # write here is sparse (status="processing", recap_artifacts=null) —
    # the frontend's ``hydratePayloadWithRemoteMemories`` then pulls the
    # Mem0 candidates from ``/api/memory/recent?session_id=...`` and shows
    # them.  Idempotency guard: never overwrite an existing file, because
    # the web flow writes a richer envelope with takeaway / reflection
    # synthesized via a client-side LLM call.
    try:
        steps["recap"] = _write_offline_recap(
            user_id, session_id, thread_id, session_metadata, len(messages),
        )
    except Exception:
        logger.error(
            "Pipeline step 'recap' failed for session %s", session_id, exc_info=True,
        )
        steps["recap"] = "error"

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
        "session.finalization pipeline_complete user_id=%s session_id=%s steps=%s",
        user_id,
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


def _write_offline_recap(
    user_id: str,
    session_id: str,
    thread_id: str,
    session_metadata: dict[str, Any],
    turn_count: int,
) -> str:
    """Write a minimal recap envelope so ``/recap/<session>`` can load.

    Mirrors the shape of ``_build_session_recap_payload`` in
    ``app/gateway/routers/sophia.py`` so the frontend reads both
    web-originated and offline-originated recaps through the same
    contract.  Status is always ``"processing"`` and ``recap_artifacts``
    is ``null`` — those fields require a synchronous LLM synthesis the
    offline pipeline doesn't perform.  The frontend treats this case
    correctly: it hydrates the memory candidates from
    ``/api/memory/recent`` and shows them; takeaway / reflection are
    blank for offline-only sessions.

    Idempotent: returns ``"skipped_exists"`` when a recap is already on
    disk (web flow writes a richer one and must always win).  Raises on
    filesystem errors so the caller's try/except can record them.
    """
    recap_path = safe_user_path(USERS_DIR, user_id, "recaps", f"{session_id}.json")
    if recap_path.exists():
        logger.info(
            "Recap already exists for %s/%s — skipping offline write", user_id, session_id,
        )
        return "skipped_exists"

    started_at: str | None = None
    try:
        from deerflow.sophia.session_store import SessionStore

        record = SessionStore().get(user_id, session_id)
        if record is not None:
            started_at = record.created_at
    except Exception:
        logger.warning(
            "session.finalization recap_session_lookup_failed user=%s session=%s",
            user_id, session_id, exc_info=True,
        )

    payload = {
        "session_id": session_id,
        "thread_id": thread_id,
        "session_type": "open",
        "context_mode": session_metadata.get("context_mode", "life"),
        "started_at": started_at,
        "ended_at": datetime.now(UTC).isoformat(),
        "turn_count": turn_count,
        "status": "processing",
        # Empty dict (NOT None) so the frontend's mapper doesn't early-null-
        # return on the recap envelope. With ``None`` the page treats the
        # whole recap as unrenderable and the hydration step that pulls
        # Mem0 candidates from ``/api/memory/recent`` never runs.
        "recap_artifacts": {},
    }
    recap_path.parent.mkdir(parents=True, exist_ok=True)
    recap_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info(
        "Recap written for user %s session %s at %s", user_id, session_id, recap_path,
    )
    return "ok"


def _build_session_metadata(
    thread_state: dict[str, Any],
    *,
    user_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Extract session-level metadata from thread_state.

    Pulls ``platform``, ``context_mode``, ``ritual``, and the current
    session's ``session_start_unix`` from either the persisted session
    record, session-scoped messages, or top-level thread state.
    """
    configurable = thread_state.get("configurable", {})

    session_start_unix = _lookup_session_start_unix(user_id, session_id)
    messages = thread_state.get("messages", [])
    if session_start_unix is None:
        session_start_unix = _earliest_message_timestamp(messages, session_id=session_id)
    if session_start_unix is None and session_id is None:
        session_start_unix = _earliest_message_timestamp(messages)

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
        "session_start_unix": session_start_unix,
    }


def _lookup_session_start_unix(user_id: str | None, session_id: str | None) -> int | None:
    if not user_id or not session_id:
        return None
    try:
        from deerflow.sophia.session_store import SessionStore

        record = SessionStore().get(user_id, session_id)
    except Exception:
        logger.warning(
            "session.finalization metadata_session_lookup_failed user=%s session=%s",
            user_id,
            session_id,
            exc_info=True,
        )
        return None
    if record is None:
        return None
    return _coerce_timestamp_unix(getattr(record, "created_at", None))


def _earliest_message_timestamp(messages: list[Any], session_id: str | None = None) -> int | None:
    timestamps: list[int] = []
    for msg in messages:
        if session_id is not None and _message_session_id(msg) != session_id:
            continue
        ts = _message_timestamp_unix(msg)
        if ts is not None:
            timestamps.append(ts)
    return min(timestamps) if timestamps else None


def _message_session_id(msg: Any) -> str | None:
    for container in _message_metadata_containers(msg):
        raw = container.get("session_id") or container.get("run_id")
        if raw:
            return str(raw)
    return None


def _message_timestamp_unix(msg: Any) -> int | None:
    for container in _message_metadata_containers(msg):
        for key in ("timestamp", "created_at", "created"):
            if key not in container:
                continue
            ts = _coerce_timestamp_unix(container.get(key))
            if ts is not None:
                return ts
    return _coerce_timestamp_unix(getattr(msg, "timestamp", None))


def _message_metadata_containers(msg: Any) -> list[dict]:
    containers: list[dict] = []
    if isinstance(msg, dict):
        containers.append(msg)
        for key in ("metadata", "additional_kwargs", "response_metadata", "data"):
            value = msg.get(key)
            if isinstance(value, dict):
                containers.append(value)
    else:
        for attr in ("metadata", "additional_kwargs", "response_metadata"):
            value = getattr(msg, attr, None)
            if isinstance(value, dict):
                containers.append(value)
    return containers


def _coerce_timestamp_unix(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        pass
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return int(parsed.timestamp())
    except ValueError:
        return None


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


_ROLE_MAP = {"human": "user", "ai": "assistant", "system": "system"}


def _flatten_content(content: Any) -> str:
    """Reduce content to a plain string for transcript / extraction use.

    Channel adapters (Telegram, Slack) deliver multimodal user turns as
    Anthropic content-block lists: ``[{"type": "text", "text": "..."},
    {"type": "image", ...}]``. The extractor only inspects text, so we
    join the text blocks and drop the rest. Plain strings pass through
    unchanged.
    """
    if isinstance(content, list):
        return " ".join(
            p.get("text", "")
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return str(content or "")


def _serialize_messages(messages: list) -> list[dict]:
    """Normalize messages to ``[{"role": ..., "content": ...}]``.

    Handles three shapes:

    1. **LangChain ``BaseMessage`` objects** — uses ``msg.type``
       (``"human"`` / ``"ai"`` / ``"system"``).
    2. **LangChain JSON-serialized dicts** — what ``GET /threads/{id}/state``
       returns from the LangGraph server: ``{"type": "human", "content": ...}``
       (no ``role`` key).
    3. **Channel-adapter raw dicts** — what ``ChannelManager`` builds for
       the agent input: ``{"role": "human", "content": ...}``.

    The dict branch tries ``role`` first, then falls back to ``type``.
    Without the fallback, every message fetched via LangGraph's HTTP
    state endpoint stays with a blank role after serialization, then
    ``extraction._format_transcript`` drops them all (it only accepts
    ``role == "user"`` / ``"assistant"`` / ``"ai"``). That was the
    production bug where 6+ Telegram messages produced 0 memories
    even after the original role-normalization fix landed.
    """
    result: list[dict] = []
    for msg in messages:
        if isinstance(msg, dict):
            role = msg.get("role") or msg.get("type", "")
            content = msg.get("content")
            if content is None and isinstance(msg.get("data"), dict):
                content = msg["data"].get("content", "")
        else:
            role = getattr(msg, "type", "unknown")
            content = getattr(msg, "content", "")
        result.append({
            "role": _ROLE_MAP.get(role, role),
            "content": _flatten_content(content),
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
