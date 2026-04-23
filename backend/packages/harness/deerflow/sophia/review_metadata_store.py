"""Local review metadata persistence for Sophia memories."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import tempfile
from datetime import UTC, datetime
from difflib import SequenceMatcher
from pathlib import Path

logger = logging.getLogger(__name__)

_STORE_FILENAME = "review_metadata.json"
_STORE_VERSION = 1
_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent
USERS_DIR = _PROJECT_ROOT / "users"
_ISO_DATE_PATTERN = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_LONG_DATE_PATTERN = re.compile(
    r"\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b",
    re.IGNORECASE,
)
_NON_WORD_PATTERN = re.compile(r"[^a-z0-9_\s]")
_MULTISPACE_PATTERN = re.compile(r"\s+")
_STOPWORDS = {
    "a", "an", "and", "about", "at", "during", "for", "from", "has", "have",
    "in", "into", "is", "it", "of", "on", "or", "the", "to", "upcoming",
}
_MATCH_THRESHOLD = 0.72


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_content(content: str | None) -> str:
    return (content or "").strip()


def _content_hash(content: str | None) -> str | None:
    normalized = _normalize_content(content)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _normalize_match_text(content: str | None) -> str:
    normalized = _normalize_content(content).lower()
    normalized = _ISO_DATE_PATTERN.sub(" __date__ ", normalized)
    normalized = _LONG_DATE_PATTERN.sub(" __date__ ", normalized)
    normalized = _NON_WORD_PATTERN.sub(" ", normalized)
    normalized = _MULTISPACE_PATTERN.sub(" ", normalized).strip()
    return normalized


def _tokenize_for_match(content: str | None) -> set[str]:
    tokens = _normalize_match_text(content).split()
    return {
        token
        for token in tokens
        if token == "__date__" or (len(token) > 2 and token not in _STOPWORDS)
    }


def _memory_text(memory: dict) -> str:
    return memory.get("memory") or memory.get("content") or ""


def _memory_category(memory: dict) -> str | None:
    categories = memory.get("categories")
    if isinstance(categories, list) and categories:
        return categories[0]

    category = memory.get("category")
    if isinstance(category, str) and category:
        return category

    metadata = memory.get("metadata")
    if isinstance(metadata, dict):
        metadata_category = metadata.get("category")
        if isinstance(metadata_category, str) and metadata_category:
            return metadata_category

    return None


def _entry_category(entry: dict) -> str | None:
    metadata = entry.get("metadata")
    if isinstance(metadata, dict):
        category = metadata.get("category")
        if isinstance(category, str) and category:
            return category
    return None


def _is_local_memory_id(memory_id: str | None) -> bool:
    return isinstance(memory_id, str) and memory_id.startswith("local:")


def _overlay_timestamp(value: dict) -> str:
    updated_at = value.get("updated_at")
    if isinstance(updated_at, str) and updated_at:
        return updated_at

    created_at = value.get("created_at")
    if isinstance(created_at, str) and created_at:
        return created_at

    return ""


def _match_score(left: str, right: str) -> float:
    left_normalized = _normalize_match_text(left)
    right_normalized = _normalize_match_text(right)
    if not left_normalized or not right_normalized:
        return 0.0

    if left_normalized == right_normalized:
        return 1.0

    left_tokens = _tokenize_for_match(left)
    right_tokens = _tokenize_for_match(right)
    token_score = 0.0
    if left_tokens and right_tokens:
        token_score = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)

    sequence_score = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    return max(token_score, sequence_score)


def _store_path(user_id: str) -> Path:
    return _safe_user_path(USERS_DIR, user_id, "memories", _STORE_FILENAME)


def _safe_user_path(base_dir: Path, user_id: str, *segments: str) -> Path:
    if not user_id or not _USER_ID_PATTERN.match(user_id):
        raise ValueError("Invalid user_id format")

    target = base_dir / user_id / Path(*segments)
    resolved = target.resolve()
    base_resolved = base_dir.resolve()
    if not resolved.is_relative_to(base_resolved):
        raise ValueError("Path traversal detected")
    return target


def _load_store(user_id: str) -> dict:
    path = _store_path(user_id)
    if not path.exists():
        return {"version": _STORE_VERSION, "entries": []}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to read local review metadata store for %s", user_id, exc_info=True)
        return {"version": _STORE_VERSION, "entries": []}

    entries = data.get("entries") if isinstance(data, dict) else []
    if not isinstance(entries, list):
        entries = []

    return {
        "version": _STORE_VERSION,
        "entries": [entry for entry in entries if isinstance(entry, dict)],
    }


def _save_store(user_id: str, store: dict) -> None:
    path = _store_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)

    tmp_fd, tmp_path_str = tempfile.mkstemp(suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_path_str)
    try:
        with open(tmp_fd, "w", encoding="utf-8") as file_obj:
            json.dump(store, file_obj, ensure_ascii=True, indent=2)
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _select_entry(
    entries: list[dict],
    *,
    memory_id: str | None = None,
    content_hash: str | None = None,
    session_id: str | None = None,
) -> dict | None:
    if memory_id:
        exact_matches = [entry for entry in entries if entry.get("memory_id") == memory_id]
        if exact_matches:
            return max(exact_matches, key=lambda entry: entry.get("updated_at", ""))

    if not content_hash:
        return None

    content_matches = [entry for entry in entries if entry.get("content_hash") == content_hash]
    if session_id:
        session_matches = [entry for entry in content_matches if entry.get("session_id") == session_id]
        if session_matches:
            content_matches = session_matches

    if not content_matches:
        return None

    return max(content_matches, key=lambda entry: entry.get("updated_at", ""))


def upsert_review_metadata(
    user_id: str,
    *,
    metadata: dict | None = None,
    memory_id: str | None = None,
    content: str | None = None,
    content_hash: str | None = None,
    session_id: str | None = None,
    sync_state: str | None = None,
) -> dict | None:
    normalized_content = _normalize_content(content)
    resolved_content_hash = content_hash or _content_hash(normalized_content)

    store = _load_store(user_id)
    entries = store["entries"]
    entry = _select_entry(
        entries,
        memory_id=memory_id,
        content_hash=resolved_content_hash,
        session_id=session_id,
    )

    if entry is None and metadata is None and not normalized_content:
        return None

    if entry is None and metadata is None:
        return None

    if entry is None:
        entry = {
            "memory_id": memory_id,
            "content": normalized_content,
            "content_hash": resolved_content_hash,
            "session_id": session_id,
            "metadata": dict(metadata or {}),
            "updated_at": _now_iso(),
        }
        if sync_state:
            entry["sync_state"] = sync_state
        entries.append(entry)
    else:
        if memory_id:
            entry["memory_id"] = memory_id
        if normalized_content:
            entry["content"] = normalized_content
            entry["content_hash"] = resolved_content_hash
        elif resolved_content_hash:
            entry["content_hash"] = resolved_content_hash
        if session_id:
            entry["session_id"] = session_id
        if metadata is not None:
            entry["metadata"] = dict(metadata)
        if sync_state:
            entry["sync_state"] = sync_state
        entry["updated_at"] = _now_iso()

    _save_store(user_id, store)
    return dict(entry)


def remove_review_metadata(
    user_id: str,
    *,
    memory_id: str | None = None,
    content: str | None = None,
    content_hash: str | None = None,
) -> bool:
    resolved_content_hash = content_hash or _content_hash(content)
    store = _load_store(user_id)
    original_entries = store["entries"]

    filtered_entries = [
        entry
        for entry in original_entries
        if not (
            (memory_id and entry.get("memory_id") == memory_id)
            or (resolved_content_hash and entry.get("content_hash") == resolved_content_hash)
        )
    ]

    if len(filtered_entries) == len(original_entries):
        return False

    store["entries"] = filtered_entries
    _save_store(user_id, store)
    return True


def reconcile_review_metadata_entries(user_id: str, memories: list[dict]) -> int:
    store = _load_store(user_id)
    entries = store["entries"]
    changed = 0
    used_memory_ids = {
        entry.get("memory_id")
        for entry in entries
        if isinstance(entry.get("memory_id"), str)
        and entry.get("memory_id")
        and not _is_local_memory_id(entry.get("memory_id"))
    }

    for entry in entries:
        entry_memory_id = entry.get("memory_id")
        if isinstance(entry_memory_id, str) and entry_memory_id and not _is_local_memory_id(entry_memory_id):
            continue

        entry_content = entry.get("content")
        if not isinstance(entry_content, str) or not entry_content.strip():
            continue

        entry_category = _entry_category(entry)
        best_memory_id: str | None = None
        best_score = 0.0

        for memory in memories:
            if not isinstance(memory, dict):
                continue

            memory_id = memory.get("id")
            if not isinstance(memory_id, str) or not memory_id or memory_id.startswith("local:"):
                continue
            if memory_id in used_memory_ids:
                continue

            memory_category = _memory_category(memory)
            if entry_category and memory_category and entry_category != memory_category:
                continue

            score = _match_score(entry_content, _memory_text(memory))
            if score < _MATCH_THRESHOLD or score <= best_score:
                continue

            best_score = score
            best_memory_id = memory_id

        if not best_memory_id:
            continue

        entry["memory_id"] = best_memory_id
        entry["sync_state"] = "reconciled"
        entry["updated_at"] = _now_iso()
        used_memory_ids.add(best_memory_id)
        changed += 1

    if changed:
        _save_store(user_id, store)

    return changed


def apply_review_metadata_overlays(user_id: str, memories: list[dict]) -> list[dict]:
    reconcile_review_metadata_entries(user_id, memories)
    store = _load_store(user_id)
    entries = store["entries"]
    changed = False
    matched_keys: set[str] = set()
    overlaid_memories: list[dict] = []
    local_only_by_id: dict[str, dict] = {}
    local_only_order: list[str] = []

    for memory in memories:
        if not isinstance(memory, dict):
            overlaid_memories.append(memory)
            continue

        memory_id = memory.get("id")
        content = memory.get("memory") or memory.get("content")
        content_hash = _content_hash(content)
        entry = _select_entry(entries, memory_id=memory_id, content_hash=content_hash)

        merged_memory = dict(memory)
        if entry:
            for matched_key in (entry.get("memory_id"), entry.get("content_hash"), content_hash):
                if isinstance(matched_key, str) and matched_key:
                    matched_keys.add(matched_key)

            if memory_id and not entry.get("memory_id"):
                entry["memory_id"] = memory_id
                entry["updated_at"] = _now_iso()
                changed = True

            local_content = entry.get("content")
            if isinstance(local_content, str) and local_content.strip():
                merged_memory["memory"] = local_content
                merged_memory["content"] = local_content

            local_metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else None
            if local_metadata:
                current_metadata = merged_memory.get("metadata") if isinstance(merged_memory.get("metadata"), dict) else {}
                merged_memory["metadata"] = {**current_metadata, **local_metadata}

                category = local_metadata.get("category")
                if category:
                    if merged_memory.get("category") is None:
                        merged_memory["category"] = category
                    if not merged_memory.get("categories"):
                        merged_memory["categories"] = [category]

            if entry.get("session_id"):
                merged_memory["session_id"] = entry.get("session_id")

        overlaid_memories.append(merged_memory)

    for entry in entries:
        entry_key = entry.get("memory_id") or entry.get("content_hash")
        if not isinstance(entry_key, str) or entry_key in matched_keys:
            continue

        local_metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        category = local_metadata.get("category") if isinstance(local_metadata, dict) else None
        local_memory_id = entry.get("memory_id") or f"local:{entry.get('content_hash')}"

        local_memory = {
            "id": local_memory_id,
            "session_id": entry.get("session_id"),
            "memory": entry.get("content", ""),
            "category": category,
            "categories": [category] if category else [],
            "metadata": dict(local_metadata),
            "created_at": entry.get("updated_at"),
            "updated_at": entry.get("updated_at"),
        }

        existing_local = local_only_by_id.get(local_memory_id)
        if existing_local is None:
            local_only_by_id[local_memory_id] = local_memory
            local_only_order.append(local_memory_id)
            continue

        if _overlay_timestamp(local_memory) >= _overlay_timestamp(existing_local):
            local_only_by_id[local_memory_id] = local_memory

    for local_memory_id in local_only_order:
        overlaid_memories.append(local_only_by_id[local_memory_id])

    if changed:
        _save_store(user_id, store)

    return overlaid_memories