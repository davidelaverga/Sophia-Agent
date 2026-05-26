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
The pipeline is idempotent via durable processed_until checkpoints plus a
module-level ``_processed_sessions`` guard for same-process duplicate ranges.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path, validate_user_id
from deerflow.sophia.extraction import (
    ExtractionParseError,
    analyze_explicit_remember_messages,
    extract_session_memories,
)
from deerflow.sophia.handoffs import generate_handoff
from deerflow.sophia.identity import maybe_update_identity
from deerflow.sophia.mem0_client import reconcile_review_metadata_with_mem0
from deerflow.sophia.session_store import (
    SessionMessageRecord,
    SessionStore,
    canonical_visible_messages,
)
from deerflow.sophia.smart_opener import generate_smart_opener
from deerflow.sophia.trace_logger import write_session_trace

logger = logging.getLogger(__name__)

# Two-stage idempotency tracking — sufficient for single-process deployments.
# Origin/main introduced durable ``processed_until`` checkpoints in
# ``SessionStore`` (``memory_processed_until_sequence`` /
# ``recap_processed_until_sequence``) that OWN cross-process safety; the
# module-level sets below remain authoritative for same-process in-flight /
# duplicate-range protection.
#
# `_processed_sessions`: sessions that have completed extraction successfully
#   (or where extraction returned an empty list — LLM said no candidates, no
#   point retrying). Keyed by bare session_id. Cross-process safety for
#   incremental range tracking is owned by SessionStore's
#   ``memory_processed_until_sequence`` / ``recap_processed_until_sequence``
#   checkpoints — the orchestrator short-circuits to ``no_new_messages``
#   when SessionStore reports the scope is empty BEFORE adding to this set,
#   so a transcript that grows after a previous run is still picked up.
#   Promoted into this set ONLY at the end of the pipeline.
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

# Safety cap on the deferred-rerun iterative loop (Codex P2 R15). 16 covers
# any realistic concurrent /end_session burst — the typical race only queues
# one deferred rerun per primary run. Beyond this we log + bail rather than
# loop indefinitely under a misbehaving client.
_MAX_DEFERRED_RERUN_ITERATIONS = 16

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

    # Codex P2 review on PR #130 R15: the deferred-rerun dispatch used to
    # recursively call ``run_offline_pipeline`` again. Sustained concurrent
    # ``force_reprocess`` requests against the same session_id could build
    # unbounded Python stack depth, eventually hitting the recursion limit
    # and dropping pipeline work. The iterative loop below has identical
    # semantics — body runs, finally pops the rerun queue, if a rerun was
    # queued we loop with the new state — without growing the stack.
    #
    # The first iteration honors the caller's ``force_reprocess`` flag;
    # subsequent iterations (deferred reruns) always run with
    # ``force_reprocess=True`` since that's the explicit-end-session intent
    # captured at the time the second caller landed.
    #
    # ``_MAX_DEFERRED_RERUN_ITERATIONS`` is a safety net against pathological
    # queueing patterns (e.g. a misbehaving client looping force_reprocess
    # at high frequency). 16 iterations covers any realistic burst — the
    # /end_session race only ever queues one deferred rerun per primary run.
    accumulated_exception: BaseException | None = None  # FIRST exception wins
    final_result: dict[str, Any] | None = None
    current_thread_state = thread_state
    current_force_reprocess = force_reprocess

    for iteration in range(_MAX_DEFERRED_RERUN_ITERATIONS):
        # --- Single SessionStore scope load per iteration ---
        # We use the scope for TWO independent decisions: (a) the durable
        # no-new-messages short-circuit and (b) bypassing the in-memory
        # ``_processed_sessions`` set when the resumed session has grown.
        extraction_scope = _load_incremental_extraction_scope(user_id, session_id)
        has_durable_record = extraction_scope is not None
        has_new_messages = bool(extraction_scope and extraction_scope["selected_messages"])

        # --- Durable no-new-messages short-circuit ---
        # SessionStore record exists AND ``memory_processed_until_sequence``
        # is caught up to ``current_max_sequence``. This is the resumed-
        # session-with-no-growth case: nothing to do. ``force_reprocess`` does
        # NOT bypass this — there's still literally nothing to reprocess.
        if has_durable_record and not has_new_messages and not current_force_reprocess:
            logger.info(
                "session.finalization no_new_messages user_id=%s session_id=%s "
                "last_processed=%s current_max=%s",
                user_id, session_id,
                extraction_scope["last_processed_sequence"],
                extraction_scope["current_max_sequence"],
            )
            final_result = {
                "status": "no_new_messages",
                "session_id": session_id,
                "steps": {"extraction": "no_new_messages"},
                "extraction_range": _scope_range_for_result(extraction_scope),
            }
            break

        # --- Two-stage idempotency check (see _acquire_pipeline_slot for full
        # behavior; extracted to keep this function below sentrux CC threshold). ---
        # Pass our own thread_state as ``pending_thread_state`` so that if THIS
        # call is rejected with "in_flight" + force_reprocess, the in-flight run
        # picks up OUR state for the deferred rerun (not the first run's stale
        # snapshot). Codex P1 review on PR #130 — critical for the /end_session
        # race where the explicit caller has newer messages/artifacts.
        #
        # Incremental-resume bypass (Codex P1 review on PR #130 merge): when
        # SessionStore confirms new messages exist for a session that's already
        # in ``_processed_sessions`` (resumed session, user kept talking after
        # the first pipeline run finished), bypass the ``already_processed``
        # short-circuit the same way explicit ``force_reprocess`` does.
        # Otherwise a resumed session would skip extraction permanently unless
        # the caller passed ``force_reprocess=True``, which breaks normal
        # incremental processing.
        slot = _acquire_pipeline_slot(
            user_id, session_id, thread_id,
            force_reprocess=current_force_reprocess or has_new_messages,
            pending_thread_state=current_thread_state,
        )
        if slot != "proceed":
            # Only possible on the first iteration (subsequent iterations are
            # deferred reruns that just released the in-flight slot). If we hit
            # this on an iteration > 0 it's a race with a third concurrent
            # caller — let them own the rerun and return the slot envelope.
            iteration_result: dict[str, Any] | None = {
                "status": slot, "session_id": session_id
            }
            if final_result is None:
                final_result = iteration_result
            break

        # `extraction_retryable` gates promotion to `_processed_sessions` at
        # the bottom. Set to True on ExtractionParseError or any other
        # extraction exception so the next pipeline trigger retries.
        iteration_result = None
        # Codex P1 review on PR #130 R12: if the pipeline body raises, we MUST
        # still honor any deferred force_reprocess queued by a second caller
        # (typically /end_session landing while inactivity_watcher was already
        # running). Capture the exception, let control fall through to the
        # rerun queue, then re-raise after the loop. The primary caller still
        # sees the original exception; the second caller's intent is honored
        # via the next iteration's side effects (memories, recap, handoff).
        iteration_exception: BaseException | None = None
        try:
            # --- Thread state: fetch from LangGraph if not provided ---
            #
            # Codex P1 review on PR #130: this block MUST NOT early-return.
            # A bare ``return {"status": "error", ...}`` inside the try would
            # bypass the post-finally rerun check below, silently dropping any
            # explicit force_reprocess request queued while we were in flight.
            # Instead we set ``iteration_result`` to the error envelope and let
            # control fall through to the rerun check after finally.
            resolved_thread_state = _ensure_thread_state(
                current_thread_state, thread_id, user_id, session_id
            )

            if resolved_thread_state is None:
                iteration_result = {
                    "status": "error",
                    "reason": "no_thread_state",
                    "session_id": session_id,
                }
            else:
                # Load the incremental extraction scope ONCE per iteration so
                # we can (a) short-circuit when there are no new messages and
                # (b) include the ``extraction_range`` block in the completion
                # envelope below.
                pre_scope = _load_incremental_extraction_scope(user_id, session_id)
                if pre_scope is not None and not pre_scope["selected_messages"]:
                    # Short-circuit: skip the 7-step body, don't promote to
                    # ``_processed_sessions``, but DO release the in-flight
                    # slot in ``finally`` below so a later turn that grows
                    # the transcript can re-enter the pipeline.
                    logger.info(
                        "session.finalization no_new_messages user_id=%s session_id=%s last_processed=%s current_max=%s",
                        user_id, session_id,
                        pre_scope["last_processed_sequence"],
                        pre_scope["current_max_sequence"],
                    )
                    iteration_result = {
                        "status": "no_new_messages",
                        "session_id": session_id,
                        "steps": {"extraction": "no_new_messages"},
                        "extraction_range": _scope_range_for_result(pre_scope),
                    }
                else:
                    # Run the 7-step body in a helper to keep this orchestrator
                    # below the sentrux CC threshold. ``_run_pipeline_steps`` owns
                    # all the per-step try/except + extraction parse-error handling.
                    steps, extraction_retryable = _run_pipeline_steps(
                        user_id, session_id, thread_id, resolved_thread_state,
                    )

                    # --- PROMOTE to _processed_sessions ONLY if extraction was not
                    # retryable. On parse error / other extraction exception, leave
                    # the session unprocessed so the next trigger (inactivity,
                    # explicit end_session with force_reprocess=True, etc.) gets a
                    # chance to retry.
                    if not extraction_retryable:
                        with _processed_lock:
                            _processed_sessions.add(session_id)

                    logger.info(
                        "session.finalization pipeline_complete user_id=%s "
                        "session_id=%s extraction_retryable=%s steps=%s",
                        user_id, session_id, extraction_retryable, steps,
                    )

                    iteration_result = {
                        "status": "completed",
                        "session_id": session_id,
                        "steps": steps,
                        "extraction_retryable": extraction_retryable,
                        "extraction_range": _scope_range_for_result(pre_scope),
                    }
        except Exception as exc:
            # Capture for re-raise AFTER the loop (P1 R12). Do NOT catch
            # BaseException — KeyboardInterrupt / SystemExit should propagate
            # immediately without trying to run a rerun.
            iteration_exception = exc
            logger.exception(
                "Pipeline body raised for session %s (iteration=%d) — will "
                "still honor any queued force_reprocess before re-raising",
                session_id, iteration,
            )
            iteration_result = {
                "status": "error",
                "reason": "pipeline_exception",
                "session_id": session_id,
                "error_type": type(exc).__name__,
            }
        finally:
            # Always release the in-flight guard, regardless of how this
            # iteration exited. Atomically pop the deferred-rerun entry — if
            # a force_reprocess caller landed while we were in flight, we
            # use THEIR thread_state for the next iteration (not this
            # iteration's stale snapshot). Codex P1: the explicit caller
            # (typically /end_session) has the user's newest messages;
            # reusing the first-run state would silently reprocess stale data.
            with _processed_lock:
                _in_flight_sessions.discard(session_id)
                rerun_state = _pending_reruns.pop(session_id, _NOT_PENDING)

        # Preserve the FIRST exception so the primary caller sees their
        # failure (matches the recursive-version semantics — intermediate
        # exceptions are logged but not propagated).
        if iteration_exception is not None and accumulated_exception is None:
            accumulated_exception = iteration_exception

        # Always update final_result so the LAST iteration's outcome is
        # returned (matches recursive-version semantics — a successful
        # deferred rerun replaces the primary's error result if the primary
        # itself didn't raise).
        final_result = iteration_result

        if rerun_state is _NOT_PENDING:
            # No more queued reruns — exit the loop normally.
            break

        # Queued rerun: loop again with the second caller's state +
        # force_reprocess=True. ``_pending_reruns`` is a dict keyed by
        # session_id, so concurrent force_reprocess requests during the
        # rerun collapse to at most one additional deferred rerun per
        # iteration — bounded growth, not unbounded.
        #
        # If ``rerun_state`` is None the second caller didn't pass one; the
        # next iteration's ``_ensure_thread_state`` will fetch fresh from
        # LangGraph (which gives us the absolute newest state at rerun
        # time — even better than reusing a snapshot).
        logger.info(
            "[Pipeline] honoring queued force_reprocess user_id=%s "
            "session_id=%s iteration=%d has_pending_state=%s "
            "primary_exception=%s — looping with second caller's state",
            user_id, session_id, iteration + 1,
            rerun_state is not None,
            type(accumulated_exception).__name__ if accumulated_exception else None,
        )
        current_thread_state = rerun_state
        current_force_reprocess = True
    else:
        # Iteration cap exhausted — log + bail. Pathological queueing pattern
        # (a misbehaving client looping force_reprocess at high frequency)
        # is the only way to reach this branch.
        logger.warning(
            "[Pipeline] deferred rerun loop hit safety cap user_id=%s "
            "session_id=%s iterations=%d — dropping further queued reruns",
            user_id, session_id, _MAX_DEFERRED_RERUN_ITERATIONS,
        )
        # Clear any straggler rerun entry so it doesn't haunt the next
        # primary trigger.
        with _processed_lock:
            _pending_reruns.pop(session_id, None)

    if accumulated_exception is not None:
        raise accumulated_exception
    return final_result


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
        _safe_session_start_iso(_sstart),
        session_metadata.get("platform"),
        session_metadata.get("context_mode"),
    )

    steps: dict[str, str] = {}
    extraction_retryable = False
    extraction_scope = _load_incremental_extraction_scope(user_id, session_id)

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
        extraction_run_id = f"extract-{uuid.uuid4()}"
        if extraction_scope is not None:
            serialized_messages = [
                _message_record_to_extraction_message(message)
                for message in extraction_scope["selected_messages"]
            ]
            source_message_ids = [
                message.message_id
                for message in extraction_scope["selected_messages"]
                if message.message_id
            ]
            session_metadata.update(
                {
                    "thread_id": thread_id,
                    "sequence_start": extraction_scope["range_start"],
                    "sequence_end": extraction_scope["range_end"],
                    "source_message_ids": source_message_ids,
                    "extraction_run_id": extraction_run_id,
                }
            )
        else:
            serialized_messages = _serialize_messages(messages)
            session_metadata.update(
                {
                    "thread_id": thread_id,
                    "extraction_run_id": extraction_run_id,
                }
            )
        extracted_memories = extract_session_memories(
            user_id,
            session_id,
            serialized_messages,
            session_metadata,
            require_memory_write=True,
        )
        # Best-effort: reconcile any local-overlay review metadata to Mem0
        # (no-op in v3 mode but kept on the success path so future v2-style
        # consumers see the side effect).
        try:
            reconcile_review_metadata_with_mem0(user_id)
        except Exception:
            logger.warning(
                "session.finalization reconcile_review_metadata_failed user_id=%s session_id=%s",
                user_id, session_id, exc_info=True,
            )
        if extraction_scope is not None:
            _mark_memory_extraction_success(
                extraction_scope,
                extraction_run_id=extraction_run_id,
                diagnostics=_build_memory_extraction_diagnostics(
                    serialized_messages,
                    extracted_memories,
                ),
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
        if extraction_scope is not None:
            _mark_memory_extraction_failure(extraction_scope)
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


def _load_incremental_extraction_scope(user_id: str, session_id: str) -> dict[str, Any] | None:
    """Load the durable unprocessed transcript range, if SessionStore has it."""
    try:
        store = SessionStore()
        record = store.get(user_id, session_id)
        if record is None:
            return None
        visible_messages = canonical_visible_messages(store.list_messages(user_id, session_id))
    except Exception:
        logger.warning(
            "session.finalization durable_scope_unavailable user_id=%s session_id=%s",
            user_id,
            session_id,
            exc_info=True,
        )
        return None

    last_processed = max(0, int(record.memory_processed_until_sequence or 0))
    current_max = max((message.sequence for message in visible_messages), default=0)
    selected_messages = [
        message
        for message in visible_messages
        if last_processed < message.sequence <= current_max
    ]
    range_start = selected_messages[0].sequence if selected_messages else None
    range_end = selected_messages[-1].sequence if selected_messages else None

    return {
        "store": store,
        "record": record,
        "user_id": user_id,
        "session_id": session_id,
        "selected_messages": selected_messages,
        "last_processed_sequence": last_processed,
        "current_max_sequence": current_max,
        "range_start": range_start,
        "range_end": range_end,
    }


def _scope_range_for_result(extraction_scope: dict[str, Any] | None) -> dict[str, int | None] | None:
    if extraction_scope is None:
        return None
    return {
        "last_processed_sequence": extraction_scope["last_processed_sequence"],
        "current_max_sequence": extraction_scope["current_max_sequence"],
        "sequence_start": extraction_scope["range_start"],
        "sequence_end": extraction_scope["range_end"],
    }


def _message_record_to_extraction_message(message: SessionMessageRecord) -> dict[str, Any]:
    return {
        "role": message.role,
        "content": message.content,
        "sequence": message.sequence,
        "message_id": message.message_id,
        "metadata": {
            "sequence": message.sequence,
            "message_id": message.message_id,
            "created_at": message.created_at,
            "source": message.source,
        },
    }


def _build_memory_extraction_diagnostics(
    serialized_messages: list[dict[str, Any]],
    extracted_memories: list[dict],
) -> dict[str, Any]:
    explicit_analysis = analyze_explicit_remember_messages(serialized_messages)
    rejection_reasons: dict[str, int] = {}
    for rejection in explicit_analysis["rejections"]:
        reason = str(rejection.get("reason") or "unknown")
        rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1

    candidate_count = len(extracted_memories)
    no_candidate_reason: str | None = None
    if candidate_count == 0:
        no_candidate_reason = "no_candidate"
        if explicit_analysis["rejections"]:
            no_candidate_reason = "policy_filtered"

    return {
        "candidate_count": candidate_count,
        "explicit_remember_count": explicit_analysis["explicit_count"],
        "explicit_remember_candidate_count": len(explicit_analysis["entries"]),
        "explicit_remember_rejection_reasons": rejection_reasons,
        "no_candidate_reason": no_candidate_reason,
    }


def _mark_memory_extraction_success(
    extraction_scope: dict[str, Any],
    *,
    extraction_run_id: str,
    diagnostics: dict[str, Any] | None = None,
) -> None:
    range_end = extraction_scope.get("range_end")
    if not isinstance(range_end, int):
        return
    store = extraction_scope["store"]
    record_metadata = dict(extraction_scope["record"].metadata or {})
    if diagnostics is not None:
        record_metadata["last_memory_extraction_diagnostics"] = {
            "range_start": extraction_scope.get("range_start"),
            "range_end": range_end,
            **diagnostics,
        }
    store.update(
        extraction_scope["user_id"],
        extraction_scope["session_id"],
        memory_processed_until_sequence=range_end,
        recap_processed_until_sequence=max(
            int(extraction_scope.get("current_max_sequence") or range_end),
            int(extraction_scope["record"].recap_processed_until_sequence or 0),
        ),
        last_memory_extraction_at=datetime.now(UTC).isoformat(),
        last_recap_extraction_at=datetime.now(UTC).isoformat(),
        last_memory_extraction_run_id=extraction_run_id,
        memory_extraction_status="completed",
        memory_extraction_error_code=None,
        memory_extraction_range_start=extraction_scope.get("range_start"),
        memory_extraction_range_end=range_end,
        metadata=record_metadata,
    )


def _mark_memory_extraction_failure(extraction_scope: dict[str, Any]) -> None:
    try:
        store = extraction_scope["store"]
        store.update(
            extraction_scope["user_id"],
            extraction_scope["session_id"],
            memory_extraction_status="error",
            memory_extraction_error_code="extraction_failed",
            memory_extraction_range_start=extraction_scope.get("range_start"),
            memory_extraction_range_end=extraction_scope.get("range_end"),
        )
    except Exception:
        logger.warning(
            "session.finalization extraction_failure_checkpoint_failed user_id=%s session_id=%s",
            extraction_scope.get("user_id"),
            extraction_scope.get("session_id"),
            exc_info=True,
        )


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
    """Coerce a heterogeneous timestamp value to a unix-seconds int.

    Accepts int / float (seconds, ms, µs, ns — auto-normalised via
    ``_normalize_epoch_to_seconds``), numeric strings (same units), and
    ISO-8601 strings. Returns ``None`` for anything unparseable, including
    non-finite floats (``inf``, ``-inf``, ``nan``).

    Codex P1 review on PR #130 R13: ``int(float('inf'))`` raises
    ``OverflowError``, ``int(float('nan'))`` raises ``ValueError``, and
    these used to propagate up through ``_message_timestamp_unix`` and
    ``_build_session_metadata``, aborting the entire ``run_offline_pipeline``
    BEFORE any per-step try/except could catch them. Since this function
    consumes user-input-shaped data (message metadata, SessionStore records,
    Mem0 payloads), it must defensively reject non-finite values rather
    than let them crash the pipeline.
    """
    if isinstance(value, bool):
        # ``bool`` is a subclass of ``int`` — exclude it explicitly so
        # ``True``/``False`` don't get coerced to 1/0 unix seconds.
        return None
    if isinstance(value, (int, float)):
        # Reject non-finite floats (inf, -inf, nan) before int() conversion.
        # ``math.isfinite`` is False for those three; True for all real ints.
        if isinstance(value, float) and not math.isfinite(value):
            return None
        try:
            return _normalize_epoch_to_seconds(int(value))
        except (OverflowError, ValueError):
            # Defense in depth — math.isfinite should already have caught
            # everything that can crash int() on a numeric.
            return None
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed_float = float(value)
    except ValueError:
        parsed_float = None
    if parsed_float is not None:
        # Same non-finite guard for string-numeric inputs — ``float("inf")``
        # and ``float("nan")`` parse cleanly and would crash int() below.
        if not math.isfinite(parsed_float):
            return None
        try:
            return _normalize_epoch_to_seconds(int(parsed_float))
        except (OverflowError, ValueError):
            return None
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


def _safe_session_start_iso(sstart: Any) -> str:
    """Defensively convert a session_start epoch to an ISO-8601 string for logging.

    Codex P2 review on PR #130 R12: the ``[Pipeline] session_start_iso``
    log expression ``datetime.fromtimestamp(sstart, UTC).isoformat()``
    runs BEFORE the step-level try/except blocks. If ``sstart`` is a
    truly out-of-range value that ``_coerce_timestamp_unix`` /
    ``_normalize_epoch_to_seconds`` couldn't tame (e.g. a negative
    overflow, ``float('inf')``, a non-numeric value smuggled past type
    coercion via dict shape drift), ``datetime.fromtimestamp`` raises
    ``OverflowError`` or ``OSError`` — and that exception aborts the
    entire pipeline run before any extraction / handoff / recap step
    gets a chance to run.

    Observability lines MUST NEVER abort the pipeline. This helper
    swallows the conversion error and emits a recognizable
    ``invalid:<value>`` token in the log so an operator grepping for
    bad timestamps still sees the offending value, without taking the
    rest of the pipeline down.
    """
    if not sstart:
        return "-"
    try:
        return datetime.fromtimestamp(sstart, UTC).isoformat()
    except (OverflowError, OSError, ValueError, TypeError):
        return f"invalid:{sstart!r}"


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
