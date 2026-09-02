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

import anthropic

from deerflow.sophia.mem0_client import add_memories

logger = logging.getLogger(__name__)

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

    sequences = [sequence for message in source_messages if isinstance((sequence := _message_sequence(message)), int)]
    message_ids = [message_id for message in source_messages if isinstance((message_id := _message_id(message)), str) and message_id]

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
    existing_content = {_normalize_entry_content(str(entry.get("content") or "")) for entry in normalized if isinstance(entry, dict) and entry.get("content")}

    if deterministic_entries:
        normalized = [entry for entry in normalized if not _is_duplicate_of_deterministic_entry(entry, deterministic_entries)]
        existing_content = {_normalize_entry_content(str(entry.get("content") or "")) for entry in normalized if isinstance(entry, dict) and entry.get("content")}

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
    return any(_content_near_duplicate(content, str(deterministic.get("content") or "")) for deterministic in deterministic_entries if isinstance(deterministic, dict))


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
    return {token for token in re.findall(r"[a-z0-9]+", content.casefold()) if len(token) > 2 and token not in _DUPLICATE_STOPWORDS}


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


def _write_extracted_memories(
    *,
    user_id: str,
    session_id: str,
    extracted: list,
    metadata: dict,
    require_memory_write: bool = False,
) -> list[dict]:
    """Write vetted extraction candidates to Mem0 with standard review metadata."""
    written_memories: list[dict] = []
    platform = metadata.get("platform", "text")
    context_mode = metadata.get("context_mode", "life")

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

        entry_meta = entry.get("metadata", {})
        if not isinstance(entry_meta, dict):
            entry_meta = {}

        mem0_metadata = {
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "confidence": entry.get("confidence", 0.5),
            "status": "pending_review",
            "platform": platform,
            "context_mode": context_mode,
        }
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

        # Include tone_estimate if present in the entry metadata
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

        # Include safe source marker for deterministic preferred-name candidates.
        if entry_meta.get("preferred_name_source"):
            mem0_metadata["preferred_name_source"] = entry_meta["preferred_name_source"]

        if entry_meta.get("explicit_remember_source"):
            mem0_metadata["explicit_remember_source"] = entry_meta["explicit_remember_source"]

        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
        )
        if require_memory_write and not result:
            raise MemoryWriteError("mem0_write_failed")

        written_memories.append(
            {
                "content": entry["content"],
                "category": entry.get("category", "fact"),
                "importance": importance_label,
                "importance_score": importance_score,
                "metadata": mem0_metadata,
                "mem0_result": result,
            }
        )

        logger.info(
            "session.finalization extraction_memory_written user_id=%s session_id=%s category=%s importance=%s",
            user_id,
            session_id,
            entry.get("category", "fact"),
            importance_label,
        )

    return written_memories


def extract_session_memories(
    user_id: str,
    session_id: str,
    messages: list[dict],
    session_metadata: dict | None = None,
    *,
    require_memory_write: bool = False,
    candidate_only: bool = False,
) -> list[dict]:
    """Extract memories from a completed session transcript.

    Loads the mem0_extraction.md template, fills it with the session
    transcript and metadata, and calls Claude Haiku to extract structured
    observations.  ``candidate_only=True`` returns vetted candidates without
    calling Mem0; MEM00's durable extraction worker is the sole user of that
    mode.  The default preserves the pre-cutover legacy path.

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
    log_user_id = user_id
    log_session_id = session_id
    if candidate_only:
        from deerflow.sophia.memory_governance.refs import keyed_ref

        log_user_id = keyed_ref("owner", user_id)
        log_session_id = keyed_ref("session", session_id)
    logger.info(
        "session.finalization extraction_start user_id=%s session_id=%s message_count=%s",
        log_user_id,
        log_session_id,
        len(messages),
    )

    if not messages:
        logger.info("Empty transcript for session %s — skipping extraction", log_session_id)
        return []

    metadata = session_metadata or {}
    session_date = metadata.get("session_date", datetime.now(UTC).strftime("%Y-%m-%d"))

    # Format the transcript
    transcript = _format_transcript(messages)
    if not transcript.strip():
        logger.info("No user/assistant content in session %s — skipping extraction", log_session_id)
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
            log_user_id,
            log_session_id,
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
        if candidate_only:
            return deterministic_entries
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
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
        logger.error("Anthropic API call failed for session %s", log_session_id, exc_info=True)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_failed")
            return []
        if candidate_only:
            return deterministic_entries
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
            require_memory_write=require_memory_write,
        )

    # Parse JSON response
    try:
        cleaned = _strip_markdown_fences(response_text)
        extracted = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "Failed to parse extraction response for session %s: %s",
            log_session_id,
            "content_excluded" if candidate_only else (response_text[:200] if response_text else "(empty)"),
        )
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_invalid_response")
            return []
        extracted = deterministic_entries

    if not isinstance(extracted, list):
        logger.error("Extraction response is not a list for session %s", log_session_id)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_invalid_response")
            return []
        extracted = deterministic_entries

    extracted = _filter_policy_rejected_entries(extracted)
    extracted = _merge_deterministic_entries(extracted, deterministic_entries)

    logger.info(
        "session.finalization extraction_candidates user_id=%s session_id=%s candidate_count=%s",
        log_user_id,
        log_session_id,
        len(extracted),
    )

    if candidate_only:
        return extracted

    # Write each extracted memory to Mem0
    written_memories = _write_extracted_memories(
        user_id=user_id,
        session_id=session_id,
        extracted=extracted,
        metadata=metadata,
        require_memory_write=require_memory_write,
    )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        log_user_id,
        log_session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
