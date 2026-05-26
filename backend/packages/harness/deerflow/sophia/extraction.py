"""Mem0 memory extraction from completed session transcripts.

Uses Claude Haiku + the mem0_extraction.md prompt template to extract
structured observations from a session, then writes each memory to Mem0
via add_memories() with full metadata and status="pending_review".
"""

import json
import logging
import re
from datetime import UTC, datetime
from difflib import SequenceMatcher
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

_EXPLICIT_REMEMBER_PATTERNS = [
    re.compile(r"(?is)\bplease\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bi\s+want\s+you\s+to\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bcould\s+you\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bcan\s+you\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bremember(?:\s+that|\s+this)?\s+(?P<statement>.+)"),
]
_PREFERENCE_LABEL_MARKERS = (
    "preference",
    "preferred",
    "favorite",
    "favourite",
)
_TEST_OR_META_MARKERS = ("test", "segment", "sample", "dummy")
_CREDENTIAL_MARKERS = (
    "password",
    "passcode",
    "credential",
    "credentials",
    "security token",
    "api key",
    "access key",
    "private key",
    "secret",
    "token",
    "otp",
    "2fa",
    "recovery code",
)
_NON_DURABLE_MARKERS = ("temporary", "one-time", "one time", "codename")
_DUPLICATE_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "because",
    "for",
    "in",
    "is",
    "it",
    "my",
    "of",
    "prefers",
    "preferred",
    "preference",
    "the",
    "them",
    "their",
    "to",
    "user",
    "users",
    "with",
}


class MemoryWriteError(RuntimeError):
    """Raised when candidate extraction succeeded but the memory write did not."""


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


def analyze_explicit_remember_messages(messages: list[dict]) -> dict:
    """Return deterministic explicit-remember candidates and safe diagnostics.

    Diagnostics deliberately omit transcript text and candidate content. They
    only carry source identifiers and rejection reasons so production can tell
    whether an explicit user request was intentionally filtered.
    """
    entries: list[dict] = []
    rejections: list[dict] = []
    seen: set[str] = set()

    for index, msg in enumerate(messages):
        if msg.get("role") != "user":
            continue

        statement = _extract_explicit_remember_statement(str(msg.get("content") or ""))
        if not statement:
            continue

        source_metadata = _source_metadata_for_message(messages, index)
        rejection_reason = _explicit_remember_rejection_reason(statement)
        if rejection_reason:
            rejections.append({"reason": rejection_reason, **source_metadata})
            continue

        entry = _explicit_preference_entry_from_statement(statement, source_metadata)
        if entry is None:
            rejections.append({"reason": "low_confidence", **source_metadata})
            continue

        key = _normalize_entry_content(entry["content"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)

    return {
        "entries": entries,
        "rejections": rejections,
        "explicit_count": len(entries) + len(rejections),
    }


def _extract_explicit_remember_statement(text: str) -> str | None:
    if not text:
        return None
    normalized = " ".join(text.strip().split())
    for pattern in _EXPLICIT_REMEMBER_PATTERNS:
        match = pattern.search(normalized)
        if not match:
            continue
        statement = _clean_clause(match.group("statement"))
        return statement or None
    return None


def _source_metadata_for_message(messages: list[dict], index: int) -> dict:
    source_messages = [messages[index]]
    if index + 1 < len(messages) and messages[index + 1].get("role") in {"assistant", "ai"}:
        source_messages.append(messages[index + 1])

    sequences = [
        sequence
        for message in source_messages
        if isinstance((sequence := _message_sequence(message)), int)
    ]
    message_ids = [
        message_id
        for message in source_messages
        if isinstance((message_id := _message_id(message)), str) and message_id
    ]

    metadata: dict[str, object] = {}
    if sequences:
        metadata["sequence_start"] = min(sequences)
        metadata["sequence_end"] = max(sequences)
    if message_ids:
        metadata["source_message_ids"] = message_ids
    return metadata


def _message_sequence(message: dict) -> int | None:
    sequence = message.get("sequence")
    if isinstance(sequence, int):
        return sequence
    metadata = message.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("sequence"), int):
        return metadata["sequence"]
    return None


def _message_id(message: dict) -> str | None:
    message_id = message.get("message_id")
    if isinstance(message_id, str) and message_id:
        return message_id
    metadata = message.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("message_id"), str):
        return metadata["message_id"]
    return None


def _explicit_remember_rejection_reason(statement: str) -> str | None:
    lowered = statement.casefold()
    if any(marker in lowered for marker in _CREDENTIAL_MARKERS):
        return "credential_like"
    if any(marker in lowered for marker in _NON_DURABLE_MARKERS):
        return "temporary_or_test_marker"
    return None


def _explicit_preference_entry_from_statement(
    statement: str,
    source_metadata: dict,
) -> dict | None:
    statement = _clean_clause(statement)
    if not statement:
        return None

    content = _explicit_my_preference_content(statement)
    if content is None:
        content = _explicit_i_prefer_content(statement)
    if content is None:
        return None

    lowered = statement.casefold()
    is_test_or_meta = any(marker in lowered for marker in _TEST_OR_META_MARKERS)
    tags = ["explicit_user_statement", "explicit_remember", "preference"]
    if is_test_or_meta:
        tags.append("test_marker")

    return {
        "content": content,
        "category": "preference",
        "importance": 0.45 if is_test_or_meta else 0.82,
        "confidence": 0.72 if is_test_or_meta else 0.9,
        "target_date": None,
        "metadata": {
            "tags": tags,
            "explicit_remember_source": "deterministic_preference",
            **source_metadata,
        },
    }


def _explicit_my_preference_content(statement: str) -> str | None:
    match = re.search(
        r"(?is)\bmy\s+(?P<label>[a-z0-9][^.!?]{1,90}?)\s+(?:is|are)\s+(?P<value>[^.!?]{1,200})",
        statement,
    )
    if not match:
        return None

    label = _clean_label(match.group("label"))
    if not label or not _is_preference_label(label):
        return None

    value, reason = _split_reason(match.group("value"))
    if not value:
        return None

    content = f"User's {label} is {value}"
    if reason:
        content += f" because {reason}"
    return _sentence(content)


def _explicit_i_prefer_content(statement: str) -> str | None:
    match = re.search(r"(?is)\bi\s+prefer\s+(?P<value>[^.!?]{1,200})", statement)
    if not match:
        return None

    value, reason = _split_reason(match.group("value"))
    if not value:
        return None

    content = f"User prefers {value}"
    if reason:
        content += f" because {reason}"
    return _sentence(content)


def _is_preference_label(label: str) -> bool:
    lowered = label.casefold()
    return any(marker in lowered for marker in _PREFERENCE_LABEL_MARKERS)


def _split_reason(value: str) -> tuple[str | None, str | None]:
    parts = re.split(r"\s+because\s+", _clean_clause(value), maxsplit=1, flags=re.IGNORECASE)
    main = _clean_clause(parts[0]) if parts else None
    reason = _clean_reason(parts[1]) if len(parts) > 1 else None
    return main or None, reason or None


def _clean_clause(value: str) -> str:
    cleaned = " ".join(str(value or "").split())
    cleaned = cleaned.strip().strip("-:;,.!?()[]{}\"'")
    return cleaned


def _clean_label(value: str) -> str:
    label = _clean_clause(value).casefold()
    label = re.sub(r"^(?:the|a|an)\s+", "", label)
    return label


def _clean_reason(value: str) -> str:
    reason = _clean_clause(value)
    replacements = [
        (r"\bhelps me\b", "helps them"),
        (r"\bhelp me\b", "help them"),
        (r"\bmy\b", "their"),
        (r"\bme\b", "them"),
    ]
    for pattern, replacement in replacements:
        reason = re.sub(pattern, replacement, reason, flags=re.IGNORECASE)
    return reason


def _sentence(value: str) -> str:
    cleaned = _clean_clause(value)
    if not cleaned:
        return ""
    return cleaned if cleaned.endswith(".") else f"{cleaned}."


def _normalize_entry_content(content: str | None) -> str:
    return " ".join(str(content or "").casefold().split())


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


def _merge_deterministic_entries(extracted: list, deterministic_entries: list[dict]) -> list[dict]:
    normalized = [entry for entry in extracted if isinstance(entry, dict)]
    existing_content = {
        _normalize_entry_content(str(entry.get("content") or ""))
        for entry in normalized
        if isinstance(entry, dict) and entry.get("content")
    }

    if deterministic_entries:
        normalized = [
            entry
            for entry in normalized
            if not _is_duplicate_of_deterministic_entry(entry, deterministic_entries)
        ]
        existing_content = {
            _normalize_entry_content(str(entry.get("content") or ""))
            for entry in normalized
            if isinstance(entry, dict) and entry.get("content")
        }

    for entry in deterministic_entries:
        if not isinstance(entry, dict):
            continue
        content_key = _normalize_entry_content(str(entry.get("content") or ""))
        if not content_key or content_key in existing_content:
            continue
        existing_content.add(content_key)
        normalized.append(entry)

    return normalized


def _is_duplicate_of_deterministic_entry(entry: dict, deterministic_entries: list[dict]) -> bool:
    content = str(entry.get("content") or "")
    if not content:
        return False
    return any(
        _content_near_duplicate(content, str(deterministic.get("content") or ""))
        for deterministic in deterministic_entries
        if isinstance(deterministic, dict)
    )


def _content_near_duplicate(left: str, right: str) -> bool:
    left_normalized = _normalize_entry_content(left)
    right_normalized = _normalize_entry_content(right)
    if not left_normalized or not right_normalized:
        return False
    if left_normalized == right_normalized:
        return True

    sequence_score = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    if sequence_score >= 0.78:
        return True

    left_tokens = _content_tokens(left_normalized)
    right_tokens = _content_tokens(right_normalized)
    if not left_tokens or not right_tokens:
        return False
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens)) >= 0.65


def _content_tokens(content: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", content.casefold())
        if len(token) > 2 and token not in _DUPLICATE_STOPWORDS
    }


def _filter_policy_rejected_entries(extracted: list[dict]) -> list[dict]:
    filtered: list[dict] = []
    rejection_counts: dict[str, int] = {}

    for entry in extracted:
        if not isinstance(entry, dict):
            continue
        content = str(entry.get("content") or "")
        reason = _candidate_policy_rejection_reason(content)
        if reason:
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            continue
        filtered.append(entry)

    if rejection_counts:
        logger.info(
            "session.finalization extraction_policy_filtered reasons=%s",
            sorted(rejection_counts.items()),
        )

    return filtered


def _candidate_policy_rejection_reason(content: str) -> str | None:
    lowered = content.casefold()
    if any(marker in lowered for marker in _CREDENTIAL_MARKERS):
        return "credential_like"
    if "codename" in lowered or "temporary" in lowered:
        return "non_durable"
    return None


def _emit_deterministic_fallback(
    user_id: str,
    session_id: str,
    deterministic_entries: list[dict],
    metadata: dict,
    *,
    require_memory_write: bool = False,
) -> list[dict]:
    """Write deterministic-only entries (or return []) when the LLM path failed.

    Used by the FileNotFoundError + Anthropic-call-failed branches of
    ``extract_session_memories``. Extracting this dedupes those two branches
    and keeps the orchestrator below the sentrux CC ≥ 16 cap.
    """
    if not deterministic_entries:
        return []
    return _write_extracted_memories(
        user_id=user_id,
        session_id=session_id,
        extracted=deterministic_entries,
        metadata=metadata,
        require_memory_write=require_memory_write,
    )


def _parse_extraction_with_deterministic_fallback(
    *,
    response_text: str,
    session_id: str,
    user_id: str,
    deterministic_entries: list[dict],
    require_memory_write: bool = False,
) -> list | None:
    """Parse the LLM extraction response, falling back to deterministic entries.

    Returns:
      - ``None`` when the LLM legitimately returned no candidates (empty
        after fence-strip). Caller short-circuits with ``return []``.
      - A list (possibly the deterministic_entries fallback) on success.

    Raises:
      ``ExtractionParseError`` when neither the LLM nor deterministic
      extraction produced a usable list — preserves the H.1 retry contract
      so the offline pipeline leaves the session unprocessed for retry
      on the next trigger.

    Three outcomes the orchestrator used to handle inline (now extracted
    to bring ``extract_session_memories`` below the sentrux CC cap):

      1. Empty after fence-strip → return ``None`` (no candidates)
      2. JSON parse error or non-list → deterministic fallback if any,
         else raise ``ExtractionParseError``
      3. Successful list parse → merge with deterministic_entries and return
    """
    cleaned = _strip_markdown_fences(response_text)
    if not cleaned:
        logger.info(
            "[Extraction] empty response — LLM returned no candidates "
            "(user_id=%s session_id=%s)",
            user_id, session_id,
        )
        return None

    try:
        extracted = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.error(
            "Failed to parse extraction response for session %s: %s",
            session_id,
            response_text[:200] if response_text else "(empty)",
        )
        # Merge resolution: prefer deterministic fallback (user-stated
        # preferred name is a critical UX signal we can extract without
        # the LLM), but preserve H.1 retry semantics when NO fallback
        # exists — raise so the pipeline doesn't lock the session in
        # ``_processed_sessions``.
        if not deterministic_entries:
            raise ExtractionParseError(
                f"Extraction JSON parse failed for session {session_id}"
            ) from exc
        extracted = list(deterministic_entries)

    if not isinstance(extracted, list):
        logger.error(
            "Extraction response is not a list for session %s (got %s)",
            session_id, type(extracted).__name__,
        )
        if not deterministic_entries:
            raise ExtractionParseError(
                f"Extraction response is not a list for session {session_id}"
            )
        extracted = list(deterministic_entries)

    # Return the parsed list. The caller in ``extract_session_memories``
    # applies ``_filter_policy_rejected_entries`` and
    # ``_merge_deterministic_entries`` (which dedupes against the LLM result
    # AND folds in any deterministic candidates the LLM didn't surface).
    return extracted


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
    require_memory_write: bool = False,
) -> list[dict]:
    """Write vetted extraction candidates to Mem0 with standard review metadata.

    Merge of main's helper extraction with PR #130's recap-pipeline work:

    - **R8 / R10 session_start_unix anchoring**: pass ``timestamp`` so Mem0 v3
      temporal reasoning anchors correctly. Do NOT fall back to ``now()`` —
      that would re-date historical turns and break relative-time queries.
    - **R13 review_status mirror**: write BOTH ``status`` and ``review_status``.
    - **infer=True (Mem0's default)**: the May 26 prod-test originally flipped
      this to ``False`` to bypass Mem0's double-extraction, but a follow-up
      probe revealed ``infer=False`` writes are invisible to
      ``client.search()`` / ``client.get_all()`` for users with existing
      extracted memories (fetchable only by ID). With ``infer=True``, some
      memories get dedup-linked to existing canonical entries (losing
      custom metadata), but the surviving canonicals ARE searchable. The
      local-overlay retrieval path in ``Mem0RetrievalMiddleware`` is now the
      canonical source of truth for ``status`` / ``category`` / custom
      metadata, so Mem0's stripping no longer breaks per-turn retrieval.
    - **R14 overlay write with tracking-id guard**: writes to the local
      overlay BEFORE relying on Mem0's response, so the recap UI shows
      pending_review candidates and the per-turn retrieval middleware can
      surface them even when Mem0 deduplicates or drops the new content.

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

        # Graft origin/main's source-range / extraction-run / thread-id
        # metadata onto our helper-built dict. These come from either the
        # per-entry ``metadata`` (deterministic explicit-remember entries
        # carry their own ``sequence_start`` / ``source_message_ids``) or
        # from the pipeline-level ``metadata`` argument (LLM-extracted
        # candidates inherit the resumed-range bounds).
        entry_meta = entry.get("metadata", {})
        if not isinstance(entry_meta, dict):
            entry_meta = {}
        for metadata_key in (
            "thread_id",
            "sequence_start",
            "sequence_end",
            "source_message_ids",
            "extraction_run_id",
        ):
            source_value = entry_meta.get(metadata_key)
            if source_value is None:
                source_value = metadata.get(metadata_key)
            if source_value is not None:
                mem0_metadata[metadata_key] = source_value
        if entry_meta.get("explicit_remember_source"):
            mem0_metadata["explicit_remember_source"] = entry_meta["explicit_remember_source"]

        # Use Mem0's default infer=True so the resulting canonical memories
        # are searchable. Mem0 may dedup-link this content to an existing
        # canonical entry (stripping our custom metadata in that case), but
        # the local overlay write below preserves the metadata for retrieval
        # via Mem0RetrievalMiddleware._augment_with_local_overlay. See
        # _write_extracted_memories docstring for the full rationale.
        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
            timestamp=session_start_unix,
        )

        _write_overlay_for_extracted_entry(
            user_id=user_id,
            session_id=session_id,
            entry=entry,
            mem0_metadata=mem0_metadata,
            result=result,
        )
        if require_memory_write and not result:
            raise MemoryWriteError("mem0_write_failed")

        written_memories.append({
            "content": entry["content"],
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "metadata": mem0_metadata,
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
    *,
    require_memory_write: bool = False,
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
    explicit_remember_analysis = analyze_explicit_remember_messages(messages)
    explicit_remember_entries = explicit_remember_analysis["entries"]
    if explicit_remember_analysis["explicit_count"]:
        rejection_reasons: dict[str, int] = {}
        for rejection in explicit_remember_analysis["rejections"]:
            reason = str(rejection.get("reason") or "unknown")
            rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
        logger.info(
            "session.finalization explicit_remember_analyzed user_id=%s session_id=%s explicit_count=%s deterministic_candidates=%s rejection_reasons=%s",
            user_id,
            session_id,
            explicit_remember_analysis["explicit_count"],
            len(explicit_remember_entries),
            sorted(rejection_reasons.items()),
        )
    deterministic_entries = [
        *_extract_explicit_preferred_name_entries(messages),
        *explicit_remember_entries,
    ]

    # Load and fill the template
    try:
        template = _load_template()
    except FileNotFoundError:
        logger.error("Extraction template not found at %s", _EXTRACTION_TEMPLATE_PATH)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extraction_template_missing")
            return []
        return _emit_deterministic_fallback(
            user_id,
            session_id,
            deterministic_entries,
            metadata,
            require_memory_write=require_memory_write,
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
            if require_memory_write:
                raise MemoryWriteError("extractor_failed")
            return []
        return _emit_deterministic_fallback(
            user_id,
            session_id,
            deterministic_entries,
            metadata,
            require_memory_write=require_memory_write,
        )

    # Parse JSON response + apply deterministic fallback in a helper to keep
    # this orchestrator below the sentrux CC ≥ 16 gate. The helper raises
    # ``ExtractionParseError`` when neither the LLM nor the deterministic
    # extractor produced usable output (H.1 retry contract); the empty-but-
    # valid case returns ``None`` so we short-circuit cleanly.
    parsed = _parse_extraction_with_deterministic_fallback(
        response_text=response_text,
        session_id=session_id,
        user_id=user_id,
        deterministic_entries=deterministic_entries,
        require_memory_write=require_memory_write,
    )
    if parsed is None:
        return []
    extracted = _filter_policy_rejected_entries(parsed)
    extracted = _merge_deterministic_entries(extracted, deterministic_entries)

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
        require_memory_write=require_memory_write,
    )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        user_id,
        session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
