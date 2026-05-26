"""Mem0 memory extraction from completed session transcripts.

Uses Claude Haiku + the mem0_extraction.md prompt template to extract
structured observations from a session, then writes each memory to Mem0
via add_memories() with full metadata and status="pending_review".
"""

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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


def _extract_explicit_preferred_name_entries(messages: list[dict]) -> list[dict]:
    """Create deterministic preferred-name candidates from explicit user statements."""
    entries: list[dict] = []
    seen: set[str] = set()
    for msg in messages:
        if msg.get("role") != "user":
            continue
        name = _extract_explicit_preferred_name_from_text(str(msg.get("content") or ""))
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                "content": f"Preferred name: {name}. Explicit user statement.",
                "category": "fact",
                "importance": 0.95,
                "confidence": 0.98,
                "target_date": None,
                "metadata": {
                    "tags": ["preferred_name", "explicit_user_statement"],
                    "preferred_name_source": "explicit_user_statement",
                },
            }
        )
    return entries


def _extract_explicit_preferred_name_from_text(text: str) -> str | None:
    if not text:
        return None
    patterns = [
        r"(?i)\bmy\s+name\s+is\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\bcall\s+me\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\brefer\s+to\s+me\s+as\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\bi\s+go\s+by\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        cleaned = _clean_explicit_preferred_name(match.group(1))
        if cleaned:
            return cleaned
    return None


def _clean_explicit_preferred_name(value: str) -> str | None:
    name = value.strip().strip("-:.,;()[]{}\"'")
    name = re.split(r"[.,;:!?]\s+", name, maxsplit=1)[0]
    name = re.split(
        r"\s+(?:no|not|please|from|instead|because|when|if|but|could|can|remember|going|for)\b",
        name,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip()
    if not name or len(name) > 60:
        return None
    if any(ch in name for ch in ("/", "\\", "\x00", "<", ">", "{", "}")):
        return None
    if not re.fullmatch(r"[A-Za-z][A-Za-z'_-]*(?:\s+[A-Za-z][A-Za-z'_-]*){0,2}", name):
        return None
    lowered = name.lower()
    stop_words = {
        "user",
        "unknown",
        "anonymous",
        "none",
        "null",
        "n/a",
        "na",
        "me",
        "you",
        "on",
        "the",
        "a",
        "an",
        "this",
        "that",
        "it",
        "important",
        "tomorrow",
        "today",
        "later",
        "thing",
        "one",
        "someone",
        "list",
        "about",
        "launch",
    }
    if lowered in stop_words or any(part in stop_words for part in lowered.split()):
        return None
    if name.islower():
        return " ".join(part[:1].upper() + part[1:] for part in name.split())
    return name


def _merge_preferred_name_entries(extracted: list, deterministic_entries: list[dict]) -> list[dict]:
    normalized = [entry for entry in extracted if isinstance(entry, dict)]
    if not deterministic_entries:
        return normalized

    existing_names = {
        name.casefold()
        for entry in normalized
        if (name := _preferred_name_from_memory_content(str(entry.get("content") or "")))
    }
    for entry in deterministic_entries:
        name = _preferred_name_from_memory_content(str(entry.get("content") or ""))
        if not name:
            continue
        key = name.casefold()
        if key in existing_names:
            continue
        existing_names.add(key)
        normalized.append(entry)
    return normalized


def _preferred_name_from_memory_content(text: str) -> str | None:
    explicit = re.search(r"(?i)\bpreferred\s+name\s*:\s*([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b", text)
    if explicit:
        return _clean_explicit_preferred_name(explicit.group(1))
    return _extract_explicit_preferred_name_from_text(text)


def _importance_label(score: float) -> str:
    """Map an importance score [0..1] to its three-tier label."""
    if score >= 0.8:
        return "structural"
    if score >= 0.4:
        return "potential"
    return "contextual"


def _build_mem0_metadata_for_entry(
    entry: dict, *, platform: str, context_mode: str
) -> tuple[dict, str, float]:
    """Build the per-candidate Mem0 metadata dict + return (metadata, label, score).

    Includes R13's ``review_status`` mirror and all optional metadata fields
    (tone_estimate, ritual_phase, target_date, tags, preferred_name_source).
    """
    importance_score = entry.get("importance", 0.5)
    importance_label = _importance_label(importance_score)

    mem0_metadata: dict[str, Any] = {
        "category": entry.get("category", "fact"),
        "importance": importance_label,
        "importance_score": importance_score,
        "confidence": entry.get("confidence", 0.5),
        "status": "pending_review",
        "review_status": "pending_review",  # R13 mirror — gateway filter uses either field
        "platform": platform,
        "context_mode": context_mode,
    }

    entry_meta = entry.get("metadata", {})
    if not isinstance(entry_meta, dict):
        entry_meta = {}

    if entry_meta.get("tone_estimate") is not None:
        mem0_metadata["tone_estimate"] = entry_meta["tone_estimate"]
    if entry_meta.get("ritual_phase"):
        mem0_metadata["ritual_phase"] = entry_meta["ritual_phase"]
    if entry.get("target_date"):
        mem0_metadata["target_date"] = entry["target_date"]
    if entry_meta.get("tags"):
        mem0_metadata["tags"] = entry_meta["tags"]
    if entry_meta.get("preferred_name_source"):
        mem0_metadata["preferred_name_source"] = entry_meta["preferred_name_source"]

    return mem0_metadata, importance_label, importance_score


def _resolve_tracking_handles(result: Any) -> tuple[str | None, str | None]:
    """Extract (memory_id, event_id) from an ``add_memories`` result.

    R14 contract: returns ``(None, None)`` when no handle is available —
    caller MUST skip the overlay write to avoid ghost candidates.
    """
    if not isinstance(result, list) or not result:
        return None, None
    first = result[0] if isinstance(result[0], dict) else None
    if not first:
        return None, None
    resolved_memory_id: str | None = None
    resolved_event_id: str | None = None
    candidate_id = first.get("id")
    if isinstance(candidate_id, str) and candidate_id and not candidate_id.startswith("local:"):
        resolved_memory_id = candidate_id
    event_candidate = first.get("event_id")
    if isinstance(event_candidate, str) and event_candidate:
        resolved_event_id = event_candidate
    return resolved_memory_id, resolved_event_id


def _write_overlay_for_extracted_entry(
    *,
    user_id: str,
    session_id: str,
    entry: dict,
    mem0_metadata: dict,
    result: Any,
) -> None:
    """Write the local review_metadata overlay with R14 tracking-id guard.

    Skips silently (with a grep-friendly warning) when Mem0 returned neither
    a memory_id nor an event_id — see ``_resolve_tracking_handles``.
    """
    resolved_memory_id, resolved_event_id = _resolve_tracking_handles(result)
    if not resolved_memory_id and not resolved_event_id:
        logger.warning(
            "session.finalization extraction_overlay_skipped user_id=%s "
            "session_id=%s reason=no_tracking_id category=%s — Mem0 write "
            "produced no memory_id or event_id; overlay would be unreconciliable",
            user_id, session_id, entry.get("category", "fact"),
        )
        return

    overlay_metadata = dict(mem0_metadata)
    if resolved_event_id and not resolved_memory_id:
        # Stash event_id so a future ``reconcile_review_metadata_entries``
        # worker can backfill the resolved memory_id once events resolve.
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
        # we already wrote to Mem0, the data is durable; the overlay is
        # best-effort UX scaffolding.
        logger.warning(
            "session.finalization extraction_overlay_write_failed user_id=%s session_id=%s",
            user_id, session_id, exc_info=True,
        )


def _write_extracted_memories(
    *,
    user_id: str,
    session_id: str,
    extracted: list,
    metadata: dict,
) -> list[dict]:
    """Write vetted extraction candidates to Mem0 with standard review metadata.

    Merge of main's helper extraction with PR #130's recap-pipeline work:

    - **R8 / R10 session_start_unix anchoring**: pass ``timestamp`` so Mem0 v3
      temporal reasoning anchors correctly. Do NOT fall back to ``now()`` —
      that would re-date historical turns and break relative-time queries.
    - **R13 review_status mirror**: write BOTH ``status`` and ``review_status``.
    - **wait_for_events=False** (cherry-picked from fix/mem0-v3-recap-regression):
      skip wait_for_pending_events here — the recap UI reads from the local
      overlay below, blocking on event polling is wasted runtime.
    - **R14 overlay write with tracking-id guard**: only write when Mem0
      returned a tracking handle.

    Sub-concerns are extracted into helpers (``_build_mem0_metadata_for_entry``,
    ``_resolve_tracking_handles``, ``_write_overlay_for_extracted_entry``) to
    keep this function below the sentrux CC threshold.
    """
    written_memories: list[dict] = []
    platform = metadata.get("platform", "text")
    context_mode = metadata.get("context_mode", "life")

    # R8 / R10: anchor to the session start time if available; warn on miss
    # so a relative-time regression is grep-able in production logs.
    session_start_unix = metadata.get("session_start_unix")
    if session_start_unix is None:
        logger.warning(
            "session.finalization extraction_no_session_anchor user_id=%s session_id=%s "
            "— Mem0 will fall back to ingestion-time for these memories; "
            "relative-time queries may incorrectly date them",
            user_id, session_id,
        )

    for entry in extracted:
        if not isinstance(entry, dict) or not entry.get("content"):
            continue

        mem0_metadata, importance_label, importance_score = _build_mem0_metadata_for_entry(
            entry, platform=platform, context_mode=context_mode,
        )

        # wait_for_events=False: recap UI reads from the local overlay; blocking
        # on Mem0 event polling here is wasted runtime under Bug A SDK-shape mismatch.
        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
            timestamp=session_start_unix,
            wait_for_events=False,
        )

        _write_overlay_for_extracted_entry(
            user_id=user_id,
            session_id=session_id,
            entry=entry,
            mem0_metadata=mem0_metadata,
            result=result,
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
            user_id, session_id, entry.get("category", "fact"), importance_label,
        )

    return written_memories


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
    deterministic_entries = _extract_explicit_preferred_name_entries(messages)

    # Load and fill the template
    try:
        template = _load_template()
    except FileNotFoundError:
        logger.error("Extraction template not found at %s", _EXTRACTION_TEMPLATE_PATH)
        if not deterministic_entries:
            return []
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
        )

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
        if not deterministic_entries:
            return []
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
        )

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
        # Merge resolution: prefer main's deterministic fallback when
        # available (a user-stated preferred name is a critical UX signal
        # we can extract without the LLM), but preserve our H.1 retry
        # semantics when NO fallback exists — raise so the pipeline leaves
        # the session unprocessed and retries on the next trigger instead
        # of silently locking the session in ``_processed_sessions``.
        if deterministic_entries:
            extracted = list(deterministic_entries)
        else:
            raise ExtractionParseError(
                f"Extraction JSON parse failed for session {session_id}"
            ) from exc

    if not isinstance(extracted, list):
        logger.error(
            "Extraction response is not a list for session %s (got %s)",
            session_id,
            type(extracted).__name__,
        )
        # Same merge: deterministic fallback if available, otherwise raise.
        if deterministic_entries:
            extracted = list(deterministic_entries)
        else:
            raise ExtractionParseError(
                f"Extraction response is not a list for session {session_id}"
            )

    # Main's contract: always merge deterministic preferred-name entries
    # into the result. ``_merge_preferred_name_entries`` dedupes — if the
    # LLM already produced an equivalent name entry, the deterministic one
    # is folded in; otherwise it's added.
    extracted = _merge_preferred_name_entries(extracted, deterministic_entries)

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

    # Write each extracted memory to Mem0 via the shared helper. All R13/R14
    # logic (anchor timestamp, review_status mirror, wait_for_events=False,
    # local overlay write with tracking-id guard) lives inside
    # ``_write_extracted_memories``.
    written_memories = _write_extracted_memories(
        user_id=user_id,
        session_id=session_id,
        extracted=extracted,
        metadata=metadata,
    )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        user_id,
        session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
