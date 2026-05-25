"""Mem0 memory extraction from completed session transcripts.

Uses Claude Haiku + the mem0_extraction.md prompt template to extract
structured observations from a session, then writes each memory to Mem0
via add_memories() with full metadata and status="pending_review".
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import anthropic

from deerflow.sophia.mem0_client import add_memories
from deerflow.sophia.review_metadata_store import upsert_review_metadata

logger = logging.getLogger(__name__)


class ExtractionParseError(RuntimeError):
    """Raised when Claude's extraction response cannot be parsed as a JSON list.

    Caught by ``run_offline_pipeline`` so the session is NOT promoted to the
    ``_processed_sessions`` idempotency set — letting the next pipeline trigger
    retry extraction. Empty-but-valid responses (LLM legitimately said no
    candidates) are NOT raised: those return ``[]`` cleanly and the session is
    marked processed (no point retrying when the LLM said nothing).
    """


# Path to the extraction prompt template
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_EXTRACTION_TEMPLATE_PATH = _PROMPTS_DIR / "mem0_extraction.md"

# Model for all pipeline LLM calls (per spec)
_PIPELINE_MODEL = "claude-haiku-4-5-20251001"


def _load_template() -> str:
    """Load the mem0_extraction.md prompt template."""
    return _EXTRACTION_TEMPLATE_PATH.read_text(encoding="utf-8")


def _format_transcript(messages: list[dict]) -> str:
    """Format messages as 'User: ...' / 'Sophia: ...' pairs."""
    lines = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if not content:
            continue
        if role == "user":
            lines.append(f"User: {content}")
        elif role in ("assistant", "ai"):
            lines.append(f"Sophia: {content}")
    return "\n\n".join(lines)


def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code block fences (```json ... ```) if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        # Remove first line (```json or ```)
        lines = lines[1:]
        # Remove last line if it's ```
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines)
    return stripped.strip()


def extract_session_memories(
    user_id: str,
    session_id: str,
    messages: list[dict],
    session_metadata: dict | None = None,
) -> list[dict]:
    """Extract memories from a completed session transcript.

    Loads the mem0_extraction.md template, fills it with the session
    transcript and metadata, calls Claude Haiku to extract structured
    observations, then writes each memory to Mem0 via add_memories().

    Args:
        user_id: The user ID.
        session_id: The session/run ID.
        messages: List of message dicts with 'role' and 'content' keys.
        session_metadata: Optional dict with keys like 'context_mode',
            'ritual_type', 'platform', 'tone_start', 'tone_end'.

    Returns:
        List of memory dicts that were written to Mem0. Empty list on
        error or if no memories were extracted.
    """
    logger.info(
        "session.finalization extraction_start user_id=%s session_id=%s message_count=%s",
        user_id,
        session_id,
        len(messages),
    )

    if not messages:
        logger.info("Empty transcript for session %s — skipping extraction", session_id)
        return []

    metadata = session_metadata or {}
    session_date = metadata.get("session_date", datetime.now(UTC).strftime("%Y-%m-%d"))

    # Format the transcript
    transcript = _format_transcript(messages)
    if not transcript.strip():
        logger.info("No user/assistant content in session %s — skipping extraction", session_id)
        return []

    # Load and fill the template
    try:
        template = _load_template()
    except FileNotFoundError:
        logger.error("Extraction template not found at %s", _EXTRACTION_TEMPLATE_PATH)
        return []

    # Use manual replacement instead of str.format() because the template
    # contains literal JSON curly braces that would conflict with format().
    replacements = {
        "{transcript}": transcript,
        "{artifacts}": str(metadata.get("artifacts", "None")),
        "{session_date}": session_date,
        "{context_mode}": metadata.get("context_mode", "life"),
        "{ritual_type}": str(metadata.get("ritual_type", "None")),
        "{tone_start}": str(metadata.get("tone_start", "unknown")),
        "{tone_end}": str(metadata.get("tone_end", "unknown")),
        "{session_id}": session_id,
        "{existing_memories}": str(metadata.get("existing_memories", "None")),
    }
    prompt = template
    for placeholder, value in replacements.items():
        prompt = prompt.replace(placeholder, value)

    # Call Claude Haiku via Anthropic SDK
    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=_PIPELINE_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = response.content[0].text
    except Exception:
        logger.error("Anthropic API call failed for session %s", session_id, exc_info=True)
        return []

    # Parse JSON response. Distinguish three outcomes:
    #   1. Empty after fence-strip (LLM returned a bare fence or whitespace) →
    #      return [] cleanly so the pipeline marks the session processed.
    #      Retrying won't help — the LLM said nothing.
    #   2. JSON parse error on non-empty content → raise ExtractionParseError
    #      so the pipeline leaves the session unprocessed and retries on the
    #      next trigger.
    #   3. Successful parse → return the list (possibly empty if LLM said "[]"
    #      explicitly, treated same as case 1).
    cleaned = _strip_markdown_fences(response_text)
    if not cleaned:
        logger.info(
            "[Extraction] empty response — LLM returned no candidates (user_id=%s session_id=%s)",
            user_id,
            session_id,
        )
        return []

    try:
        extracted = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.error(
            "Failed to parse extraction response for session %s: %s",
            session_id,
            response_text[:200] if response_text else "(empty)",
        )
        raise ExtractionParseError(
            f"Extraction JSON parse failed for session {session_id}"
        ) from exc

    if not isinstance(extracted, list):
        logger.error(
            "Extraction response is not a list for session %s (got %s)",
            session_id,
            type(extracted).__name__,
        )
        raise ExtractionParseError(
            f"Extraction response is not a list for session {session_id}"
        )

    logger.info(
        "session.finalization extraction_candidates user_id=%s session_id=%s candidate_count=%s",
        user_id,
        session_id,
        len(extracted),
    )

    candidate_breakdown: dict[str, int] = {}
    for _e in extracted:
        if isinstance(_e, dict):
            _cat = (_e.get("category") or "unknown")
            candidate_breakdown[_cat] = candidate_breakdown.get(_cat, 0) + 1
    _breakdown_str = ",".join(f"{k}:{v}" for k, v in sorted(candidate_breakdown.items()))

    logger.info(
        "[Extraction] user_id=%s session_id=%s candidate_count=%d categories=[%s] first_content=%r",
        user_id,
        session_id,
        len(extracted),
        _breakdown_str,
        (extracted[0].get("content", "")[:80] if extracted and isinstance(extracted[0], dict) else ""),
    )

    # Write each extracted memory to Mem0
    written_memories: list[dict] = []
    platform = metadata.get("platform", "text")
    context_mode = metadata.get("context_mode", "life")

    # Upgrade A: anchor memories to session start time if available.
    #
    # IMPORTANT: do NOT fall back to ``datetime.now()`` when the metadata
    # lacks ``session_start_unix``. Doing so would write the ingestion time
    # as the memory's anchor, re-dating historical turns to "right now" and
    # breaking Mem0 v3 temporal reasoning ("yesterday" / "last week" queries
    # would treat ancient memories as if they just happened). Codex P1 review
    # on PR #130 flagged this as a data-accuracy regression.
    #
    # When the anchor is missing we pass ``timestamp=None`` to
    # ``add_memories``, which simply omits the timestamp kwarg from the Mem0
    # add call. Mem0's server-side default (ingestion time) is no worse than
    # the prior fallback, but we don't actively write a wrong anchor into the
    # metadata that downstream temporal ranking would trust.
    session_start_unix = metadata.get("session_start_unix")
    if session_start_unix is None:
        logger.warning(
            "session.finalization extraction_no_session_anchor user_id=%s session_id=%s "
            "— Mem0 will fall back to ingestion-time for these memories; "
            "relative-time queries may incorrectly date them",
            user_id,
            session_id,
        )

    for entry in extracted:
        if not isinstance(entry, dict) or not entry.get("content"):
            continue

        importance_score = entry.get("importance", 0.5)
        if importance_score >= 0.8:
            importance_label = "structural"
        elif importance_score >= 0.4:
            importance_label = "potential"
        else:
            importance_label = "contextual"

        mem0_metadata = {
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "confidence": entry.get("confidence", 0.5),
            "status": "pending_review",
            "review_status": "pending_review",
            "platform": platform,
            "context_mode": context_mode,
        }

        # Include tone_estimate if present in the entry metadata
        entry_meta = entry.get("metadata", {})
        if entry_meta.get("tone_estimate") is not None:
            mem0_metadata["tone_estimate"] = entry_meta["tone_estimate"]

        # Include ritual_phase if present
        if entry_meta.get("ritual_phase"):
            mem0_metadata["ritual_phase"] = entry_meta["ritual_phase"]

        # Include target_date if present
        if entry.get("target_date"):
            mem0_metadata["target_date"] = entry["target_date"]

        # Include tags if present
        if entry_meta.get("tags"):
            mem0_metadata["tags"] = entry_meta["tags"]

        # Upgrade A: pass timestamp so Mem0 v3 temporal reasoning anchors correctly
        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
            timestamp=session_start_unix,
        )

        # --- Local review_metadata overlay write (recap pipeline fix, PR #130 §I.1) ---
        #
        # Mem0 v3 does NOT propagate event-level ``metadata.status`` onto the
        # persisted memory record. Without this overlay write, our newly-extracted
        # candidates have ``status=None`` when queried back via ``get_all``, so the
        # gateway's ``_hydrate_memories_for_review`` strict ``status==pending_review``
        # filter drops them and the recap UI shows the empty state.
        #
        # ``apply_review_metadata_overlays`` (review_metadata_store.py:408-438) emits
        # ``local:<hash>`` synthetic memories for any overlay entry not matched to a
        # real Mem0 memory — so this write surfaces candidates correctly even when
        # Mem0 v3 deduplicates our content into an existing memory (in which case
        # ``linked_memory_ids`` points to a pre-existing record, and our overlay
        # entry stands alone as the user-facing candidate).
        resolved_memory_id: str | None = None
        resolved_event_id: str | None = None
        if isinstance(result, list) and result:
            first = result[0] if isinstance(result[0], dict) else None
            if first:
                candidate_id = first.get("id")
                if isinstance(candidate_id, str) and candidate_id and not candidate_id.startswith("local:"):
                    resolved_memory_id = candidate_id
                event_candidate = first.get("event_id")
                if isinstance(event_candidate, str) and event_candidate:
                    resolved_event_id = event_candidate

        # Codex P1 review on PR #130 R14: only write the overlay when Mem0 gave us
        # a tracking handle — either a resolved memory_id (sync path or successful
        # event resolution) OR an event_id (queued async write we can reconcile
        # later). When ``add_memories`` returns an empty list — Mem0 client
        # unavailable, ``client.add()`` raised, or ``Mem0EventFailedError`` was
        # caught — both handles are absent. Writing an overlay entry then would
        # surface a "ghost" pending_review candidate in /memories/recent that was
        # never persisted remotely and can never be reconciled, polluting the
        # review UI with false positives. Log + skip + continue the loop instead.
        if not resolved_memory_id and not resolved_event_id:
            logger.warning(
                "session.finalization extraction_overlay_skipped user_id=%s "
                "session_id=%s reason=no_tracking_id category=%s — Mem0 write "
                "produced no memory_id or event_id; overlay would be unreconciliable",
                user_id, session_id, entry.get("category", "fact"),
            )
        else:
            overlay_metadata = dict(mem0_metadata)
            if resolved_event_id and not resolved_memory_id:
                # Capture the event_id so ``reconcile_review_metadata_entries`` (a
                # future backfill worker) can flip ``sync_state="pending"`` →
                # ``"reconciled"`` once Bug A is fixed and
                # ``wait_for_pending_events`` actually resolves these to real
                # memory_ids.
                overlay_metadata["mem0_event_id"] = resolved_event_id

            try:
                upsert_review_metadata(
                    user_id,
                    memory_id=resolved_memory_id,
                    content=entry["content"],
                    metadata=overlay_metadata,
                    session_id=session_id,
                    sync_state="extraction" if resolved_memory_id else "pending",
                )
            except Exception:
                # A corrupted local store must NEVER take down the extraction loop —
                # we already wrote to Mem0, the data is durable, the overlay is
                # best-effort UX scaffolding.
                logger.warning(
                    "session.finalization extraction_overlay_write_failed user_id=%s session_id=%s",
                    user_id, session_id, exc_info=True,
                )

        written_memories.append({
            "content": entry["content"],
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "mem0_result": result,
        })

        logger.info(
            "session.finalization extraction_memory_written user_id=%s session_id=%s category=%s importance=%s",
            user_id,
            session_id,
            entry.get("category", "fact"),
            importance_label,
        )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        user_id,
        session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
