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
from deerflow.sophia.extraction import ExtractionParseError, extract_session_memories
from deerflow.sophia.handoffs import generate_handoff
from deerflow.sophia.identity import maybe_update_identity
from deerflow.sophia.smart_opener import generate_smart_opener
from deerflow.sophia.trace_logger import write_session_trace

logger = logging.getLogger(__name__)

# Two-stage idempotency tracking — sufficient for single-process deployments.
# If multi-process is needed later, upgrade to a file-based marker.
#
# `_processed_sessions`: sessions that have completed extraction successfully
#   (or where extraction returned an empty list — LLM said no candidates, no
#   point retrying). Promoted into this set ONLY at the end of the pipeline.
#
# `_in_flight_sessions`: sessions currently being processed. Acquired at the
#   start (atomically with the processed-set check) and released in `finally`.
#   Prevents two concurrent pipeline calls on the same session_id from
#   double-writing memories or running extraction twice in parallel.
#
# A session that hits an extraction parse error (raised from
# `extract_session_memories` as `ExtractionParseError`) or any other extraction
# exception is intentionally NOT promoted to `_processed_sessions` — so the
# next pipeline trigger (inactivity, explicit end_session, etc.) will retry.
_processed_sessions: set[str] = set()
_in_flight_sessions: set[str] = set()
# `_pending_reruns`: session_id -> thread_state captured from the in-flight-blocked
#   force_reprocess caller. The in-flight run's `finally` block pops the entry
#   (atomically with the _in_flight discard) and re-invokes the pipeline using
#   THAT state, not the first run's stale snapshot. Critical for the common
#   race where /end_session lands on top of an inactivity-triggered run: the
#   end_session caller has newer messages/artifacts in its thread_state, and
#   the deferred rerun must use those rather than the inactivity snapshot.
#
# Three states (use the _NOT_PENDING sentinel to differentiate "pop with
# no rerun queued" from "pop with rerun-state=None"):
#   - session_id absent             -> no rerun queued
#   - session_id present, value=dict -> rerun with that thread_state
#   - session_id present, value=None -> rerun queued but caller didn't
#                                       provide a state; the rerun will
#                                       fetch fresh from LangGraph
#
# Last-writer-wins under concurrent force_reprocess calls — we only need one
# deferred rerun, and the most-recent caller's state is the most representative
# of the user's intent.
_pending_reruns: dict[str, dict[str, Any] | None] = {}
_NOT_PENDING: Any = object()
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
    *,
    force_reprocess: bool = False,
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
        force_reprocess: If True, bypass the ``_processed_sessions`` check and
            re-run the full pipeline even on a session_id that already
            completed. The web ``end_session`` endpoint passes this to refresh
            stale runs (e.g. an earlier inactivity-watcher fire on a thin
            session that has since grown). Inactivity / Telegram triggers keep
            the default ``False`` so they respect idempotency.

    Returns:
        Summary dict with ``status`` and per-step results, e.g.::

            {"status": "completed", "steps": {"trace": "ok", ...}}

    Raises:
        ValueError: If ``user_id`` fails validation.
    """
    # --- Validate user_id at entry ---
    validate_user_id(user_id)

    logger.info(
        "session.finalization pipeline_start user_id=%s session_id=%s thread_id=%s has_thread_state=%s force_reprocess=%s",
        user_id,
        session_id,
        thread_id,
        thread_state is not None,
        force_reprocess,
    )

    # --- Two-stage idempotency check (see _acquire_pipeline_slot for full
    # behavior; extracted to keep this function below sentrux CC threshold). ---
    # Pass our own thread_state as ``pending_thread_state`` so that if THIS
    # call is rejected with "in_flight" + force_reprocess, the in-flight run
    # picks up OUR state for the deferred rerun (not the first run's stale
    # snapshot). Codex P1 review on PR #130 — critical for the /end_session
    # race where the explicit caller has newer messages/artifacts.
    slot = _acquire_pipeline_slot(
        user_id, session_id, thread_id,
        force_reprocess=force_reprocess,
        pending_thread_state=thread_state,
    )
    if slot != "proceed":
        return {"status": slot, "session_id": session_id}

    # `extraction_retryable` gates promotion to `_processed_sessions` at the
    # bottom. Set to True on ExtractionParseError or any other extraction
    # exception so the next pipeline trigger retries.
    try:
        # --- Thread state: fetch from LangGraph if not provided ---
        #
        # Codex P1 review on PR #130: this block MUST NOT early-return.
        # A bare ``return {"status": "error", ...}`` inside the try would
        # bypass the post-finally ``if rerun_queued:`` branch below, silently
        # dropping any explicit force_reprocess request queued while we were
        # in flight. Instead we set ``result`` to the error envelope and let
        # control fall through to the rerun check after finally.
        thread_state = _ensure_thread_state(thread_state, thread_id, user_id, session_id)

        if thread_state is None:
            result = {"status": "error", "reason": "no_thread_state", "session_id": session_id}
        else:
            # Run the 7-step body in a helper to keep this orchestrator below
            # the sentrux CC threshold. ``_run_pipeline_steps`` owns all the
            # per-step try/except + extraction parse-error handling.
            steps, extraction_retryable = _run_pipeline_steps(
                user_id, session_id, thread_id, thread_state,
            )

            # --- PROMOTE to _processed_sessions ONLY if extraction was not retryable.
            # On parse error / other extraction exception, leave the session
            # unprocessed so the next trigger (inactivity, explicit end_session
            # with force_reprocess=True, etc.) gets a chance to retry.
            if not extraction_retryable:
                with _processed_lock:
                    _processed_sessions.add(session_id)

            logger.info(
                "session.finalization pipeline_complete user_id=%s session_id=%s extraction_retryable=%s steps=%s",
                user_id,
                session_id,
                extraction_retryable,
                steps,
            )

            result = {
                "status": "completed",
                "session_id": session_id,
                "steps": steps,
                "extraction_retryable": extraction_retryable,
            }
    finally:
        # Always release the in-flight guard, regardless of how this run
        # exited (success, abort-on-no-thread-state, or unhandled exception).
        # Atomically pop the deferred-rerun entry — if a force_reprocess
        # caller landed while we were in flight, we use THEIR thread_state
        # for the rerun, not ours. Codex P1: the explicit caller (typically
        # /end_session) has the user's newest messages; reusing our first-run
        # state would silently reprocess stale data.
        with _processed_lock:
            _in_flight_sessions.discard(session_id)
            rerun_state = _pending_reruns.pop(session_id, _NOT_PENDING)

    if rerun_state is not _NOT_PENDING:
        logger.info(
            "[Pipeline] honoring queued force_reprocess user_id=%s session_id=%s "
            "has_pending_state=%s — running deferred rerun with second caller's state",
            user_id,
            session_id,
            rerun_state is not None,
        )
        # Tail-call with force_reprocess=True. The recursive call re-acquires
        # the slot normally (the session was just removed from _in_flight,
        # and force_reprocess clears _processed_sessions inside
        # ``_acquire_pipeline_slot``). ``_pending_reruns`` is a dict keyed by
        # session_id, so concurrent force_reprocess requests during the rerun
        # collapse to at most one additional deferred rerun — no unbounded
        # recursion under concurrent traffic.
        #
        # If ``rerun_state`` is None the second caller didn't pass one; the
        # rerun's ``_ensure_thread_state`` will fetch fresh from LangGraph
        # (which gives us the absolute newest state at rerun time — even
        # better than reusing a snapshot).
        return run_offline_pipeline(
            user_id, session_id, thread_id, rerun_state, force_reprocess=True,
        )

    return result


def _run_pipeline_steps(
    user_id: str,
    session_id: str,
    thread_id: str,
    thread_state: dict[str, Any],
) -> tuple[dict[str, str], bool]:
    """Execute the 7 pipeline steps and return ``(steps, extraction_retryable)``.

    Extracted from ``run_offline_pipeline`` so the orchestrator stays below the
    sentrux CC threshold (16). All step-level try/except blocks live here.
    Each step is best-effort — a failure in one does not abort the others.

    ``extraction_retryable`` is True iff the memory extraction step raised
    ``ExtractionParseError`` or any other exception (i.e. the LLM response
    couldn't be processed, so a future pipeline trigger should retry). An
    LLM that legitimately returns ``[]`` is NOT a retry case — the empty
    list propagates and ``extraction_retryable`` stays False.
    """
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

    _sstart = session_metadata.get("session_start_unix")
    logger.info(
        "[Pipeline] user_id=%s session_id=%s session_start_unix=%s session_start_iso=%s platform=%s context_mode=%s",
        user_id,
        session_id,
        _sstart,
        (datetime.fromtimestamp(_sstart, UTC).isoformat() if _sstart else "-"),
        session_metadata.get("platform"),
        session_metadata.get("context_mode"),
    )

    steps: dict[str, str] = {}
    extraction_retryable = False

    # Step 1: Trace logging
    try:
        write_session_trace(user_id, session_id, messages, session_metadata)
        steps["trace"] = "ok"
    except Exception:
        logger.error("Pipeline step 'trace' failed for session %s", session_id, exc_info=True)
        steps["trace"] = "error"

    # Step 2: Memory extraction. ExtractionParseError → retryable; other
    # exceptions → also retryable; empty list (LLM returned no candidates)
    # → not retryable.
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
        extracted_ids = _collect_extracted_ids(extracted_memories)
        logger.info(
            "[Pipeline] extraction_ids user_id=%s session_id=%s mem0_ids_or_events=%s",
            user_id,
            session_id,
            extracted_ids[:20],
        )
    except ExtractionParseError:
        logger.warning(
            "[Pipeline] extraction_parse_error user_id=%s session_id=%s — session left NOT processed for retry",
            user_id,
            session_id,
        )
        steps["extraction"] = "parse_error"
        extraction_retryable = True
    except Exception:
        logger.error("Pipeline step 'extraction' failed for session %s", session_id, exc_info=True)
        steps["extraction"] = "error"
        extraction_retryable = True

    # Step 3: Smart opener generation
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

    # Step 4: Notification (placeholder)
    try:
        logger.info("Memory candidates ready for review (user=%s, session=%s)", user_id, session_id)
        steps["notification"] = "ok"
    except Exception:
        logger.error("Pipeline step 'notification' failed for session %s", session_id, exc_info=True)
        steps["notification"] = "error"

    # Step 5: Handoff generation
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

    # Step 5b: Recap envelope. Channel-originated sessions never trigger the
    # web flow's POST /sessions/{id}/end, so without this step they would have
    # no recap file and the frontend would 404. Skip-if-exists guard keeps the
    # web flow's richer envelope (synthesized via a client-side LLM call) from
    # being overwritten.
    try:
        steps["recap"] = _write_offline_recap(
            user_id, session_id, thread_id, session_metadata, len(messages),
        )
    except Exception:
        logger.error("Pipeline step 'recap' failed for session %s", session_id, exc_info=True)
        steps["recap"] = "error"

    # Step 6: Identity update
    try:
        maybe_update_identity(user_id, extracted_memories)
        steps["identity"] = "ok"
    except Exception:
        logger.error("Pipeline step 'identity' failed for session %s", session_id, exc_info=True)
        steps["identity"] = "error"

    # Step 7: Visual artifact check (placeholder)
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

    return steps, extraction_retryable


def reset_processed_sessions() -> None:
    """Clear all idempotency tracking state. For testing only."""
    with _processed_lock:
        _processed_sessions.clear()
        _in_flight_sessions.clear()
        _pending_reruns.clear()


def _collect_extracted_ids(extracted_memories: list[dict]) -> list[str]:
    """Flatten Mem0 IDs (or event_ids) out of the extraction result.

    Each extracted_memories entry may carry a ``mem0_result`` field that is
    either a list of dicts (one per resolved memory) or a single dict (the
    sync-add path). This helper walks both shapes and collects every
    ``id`` / ``event_id`` it can find, preserving order. Extracted into a
    standalone function to keep ``run_offline_pipeline`` below the sentrux
    CC threshold — the loop-over-list-or-dict logic alone added ~6 branches.
    """
    ids: list[str] = []
    for entry in extracted_memories or []:
        if not isinstance(entry, dict):
            continue
        mem0_res = entry.get("mem0_result")
        if isinstance(mem0_res, list):
            for record in mem0_res:
                if not isinstance(record, dict):
                    continue
                mid = record.get("id") or record.get("event_id")
                if mid:
                    ids.append(mid)
        elif isinstance(mem0_res, dict):
            mid = mem0_res.get("id") or mem0_res.get("event_id")
            if mid:
                ids.append(mid)
    return ids


def _ensure_thread_state(
    thread_state: dict[str, Any] | None,
    thread_id: str,
    user_id: str,
    session_id: str,
) -> dict[str, Any] | None:
    """Return the thread_state to use, fetching from LangGraph if not provided.

    Returns ``None`` if the caller didn't pass a state AND the LangGraph fetch
    failed — the caller (``run_offline_pipeline``) treats this as a transient
    error and writes a ``no_thread_state`` error envelope into ``result`` (so
    control still falls through to the post-finally rerun check).

    Extracted into a helper so ``run_offline_pipeline`` doesn't need an early
    ``return`` inside its try block (which would bypass the rerun_queued
    branch after finally — Codex P1 review on PR #130).
    """
    if thread_state is not None:
        return thread_state
    fetched = _fetch_thread_state(thread_id)
    if fetched is None:
        logger.warning(
            "session.finalization pipeline_abort_no_thread_state user_id=%s session_id=%s thread_id=%s",
            user_id,
            session_id,
            thread_id,
        )
        return None
    logger.info("Fetched thread_state from LangGraph for session %s", session_id)
    return fetched


def _acquire_pipeline_slot(
    user_id: str,
    session_id: str,
    thread_id: str,
    *,
    force_reprocess: bool,
    pending_thread_state: dict[str, Any] | None = None,
) -> str:
    """Atomically check + register the pipeline slot for ``session_id``.

    Returns one of:
        "proceed"            -- caller should run the pipeline; the session
                                is now in ``_in_flight_sessions``.
        "already_processed"  -- session already completed and force=False;
                                caller should short-circuit with the
                                ``already_processed`` status.
        "in_flight"          -- another concurrent call is mid-pipeline;
                                caller should short-circuit. If THIS call had
                                ``force_reprocess=True``, we ALSO write
                                ``pending_thread_state`` into ``_pending_reruns``
                                so the in-flight run's ``finally`` will pop it
                                and re-invoke the pipeline with THAT (newer)
                                state. Critical for the /end_session race:
                                the explicit caller's thread_state has the
                                user's latest messages, the inactivity caller's
                                does not — the rerun MUST use the newer one,
                                not reuse the first run's stale snapshot
                                (Codex P1 review on PR #130).

    The lock is held only for the check + registration; the pipeline runs
    outside it. The release of ``_in_flight_sessions`` happens in the caller's
    ``finally`` block.
    """
    with _processed_lock:
        if session_id in _processed_sessions:
            if not force_reprocess:
                logger.info(
                    "[Pipeline] skipped_already_processed user_id=%s session_id=%s thread_id=%s force_reprocess=%s",
                    user_id,
                    session_id,
                    thread_id,
                    force_reprocess,
                )
                return "already_processed"
            _processed_sessions.discard(session_id)
            logger.info(
                "[Pipeline] force_reprocess clearing processed marker user_id=%s session_id=%s",
                user_id,
                session_id,
            )
        if session_id in _in_flight_sessions:
            if force_reprocess:
                # Last-writer-wins: if multiple force_reprocess requests land
                # while in-flight, the most recent caller's state replaces
                # any earlier captured state. The rerun only fires ONCE
                # regardless of how many requests queued.
                _pending_reruns[session_id] = pending_thread_state
                logger.info(
                    "[Pipeline] queued_rerun_after_in_flight user_id=%s session_id=%s thread_id=%s "
                    "has_pending_state=%s — explicit force_reprocess will run after current in-flight pipeline releases",
                    user_id,
                    session_id,
                    thread_id,
                    pending_thread_state is not None,
                )
            else:
                logger.info(
                    "[Pipeline] skipped_in_flight user_id=%s session_id=%s thread_id=%s",
                    user_id,
                    session_id,
                    thread_id,
                )
            return "in_flight"
        _in_flight_sessions.add(session_id)
        return "proceed"


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
    if session_start_unix is None and (session_id is None or not _messages_have_session_tags(messages)):
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
    untagged_timestamps: list[int] = []
    for msg in messages:
        msg_session_id = _message_session_id(msg)
        ts = _message_timestamp_unix(msg)
        if ts is None:
            continue
        if session_id is None:
            timestamps.append(ts)
        elif msg_session_id == session_id:
            timestamps.append(ts)
        elif msg_session_id is None:
            untagged_timestamps.append(ts)
    if timestamps:
        return min(timestamps)
    return min(untagged_timestamps) if untagged_timestamps else None


def _messages_have_session_tags(messages: list[Any]) -> bool:
    return any(_message_session_id(msg) is not None for msg in messages)


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
        return _normalize_epoch_to_seconds(int(value))
    if not isinstance(value, str) or not value:
        return None
    try:
        return _normalize_epoch_to_seconds(int(float(value)))
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


# Plausibility thresholds for normalising an epoch value to seconds.
# Year 2286 in seconds is ~1e10, so anything <1e10 we treat as seconds.
# Year 2286 in milliseconds is ~1e13, etc. Anything <1970 is invalid
# regardless of unit and falls through unchanged (caller's responsibility).
_EPOCH_SECONDS_MAX = 10**10   # ~year 2286 in seconds
_EPOCH_MILLIS_MAX = 10**13   # ~year 2286 in milliseconds
_EPOCH_MICROS_MAX = 10**16   # ~year 2286 in microseconds


def _normalize_epoch_to_seconds(value: int) -> int:
    """Detect epoch ms / µs / ns and downscale to seconds.

    Codex P1 review on PR #130 R8: JavaScript ``Date.now()`` and many
    web APIs return 13-digit MILLISECOND epochs, but Python's
    ``datetime.fromtimestamp`` expects SECONDS. Passing ms through unchanged
    triggered ``ValueError: year out of range`` inside
    ``_run_pipeline_steps``'s ``[Pipeline] session_start_iso`` log line,
    aborting the entire offline pipeline before extraction or handoff.

    Detection is by magnitude (no client-side hint required): anything
    larger than ~year-2286 in the smaller unit is interpreted as the next
    unit up. Real values from session traffic (post-2024) easily satisfy
    this — values < 1e10 are decades old; > 1e10 means "must be ms or
    finer". Negative or tiny values are left unchanged (caller's
    responsibility — _coerce_timestamp_unix only feeds in unsigned epochs
    from messages / SessionStore / Mem0).
    """
    abs_value = abs(value)
    if abs_value < _EPOCH_SECONDS_MAX:
        return value
    if abs_value < _EPOCH_MILLIS_MAX:
        return value // 1_000
    if abs_value < _EPOCH_MICROS_MAX:
        return value // 1_000_000
    return value // 1_000_000_000


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
