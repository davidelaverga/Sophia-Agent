"""Delegation ledger — append-only per-session record of companion turns.

Spec D (Delegation Boundary) D-1: the durable record everything else reads.
One JSONL line per companion turn capturing the user's verbatim text (capped),
a defensive subset of that turn's ``emit_artifact`` payload, and a
deterministic ``deliverable_intent`` marker. The ledger is:

- the digest source for ``start_builder_task`` enrichment (D-2),
- the extraction input for the builder-side brief schema (D-3),
- the backing store for the builder's ``read_session_context`` tool (D-4),
- compaction-immune: ``SophiaSummarizationMiddleware``'s
  ``RemoveMessage(REMOVE_ALL_MESSAGES)`` wipes state, never this file.

Topology (Render split): the companion, ``start_builder_task``, and the
builder all run langgraph-side, so the local file covers the core
write→read flow. Session DELETION runs gateway-side on a separate
ephemeral disk — every append therefore mirrors the whole file to
Supabase Storage under ``{thread_id}/ledger/session.jsonl`` (best-effort,
fire-and-forget at the call site) so the gateway delete path can reach it
and a langgraph restart doesn't lose mid-session context.

Privacy (Spec D AD-6): ledger CONTENT never appears in logs — IDs, turn
numbers, and byte counts only. Session deletion deletes the ledger.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)

# Verbatim user text is capped per entry: the spec's assumption that
# oversized pastes are composer-attachment-bound was refuted (no
# text→attachment swap exists), so the cap lives here. 4k chars covers
# virtually all conversational turns; beyond it the entry carries
# ``user_text_truncated: true``.
_USER_TEXT_CAP_CHARS = 4_000

# Subset of emit_artifact args worth carrying per turn (harvested
# defensively — keys included only when present and non-empty).
_ARTIFACT_SUBSET_KEYS = (
    "session_goal",
    "takeaway",
    "active_goal",
    "tone_estimate",
    "current_task",
)

# Deterministic deliverable-intent markers (D-1). Substring match against
# the lowercased user text. Deliberately broad: the digest (D-2) SELECTS on
# this flag, so a false positive costs a digest line while a false negative
# can drop a stated requirement.
_DELIVERABLE_INTENT_MARKERS: tuple[str, ...] = (
    "build",
    "deck",
    "slide",
    "pdf",
    "document",
    "report",
    "page",
    "section",
    "include",
    "exclude",
    "format",
    "style",
    "chart",
    "image",
    "title",
    "audience",
    "deliverable",
    "spreadsheet",
    "website",
)

# A lifecycle tool call on the turn is deliverable intent by definition.
_LIFECYCLE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "start_builder_task",
        "update_async_task",
        "cancel_async_task",
        "edit_builder_artifact",
    }
)

# Digest caps (D-2) — code constants pinned by tests, not env-tunable.
_DIGEST_CAP_CHARS = 1_400
_DIGEST_LINE_CAP_CHARS = 200
_DIGEST_RECENT_TURNS = 5
# Below this many entries the digest is omitted entirely — G-DEL-2's
# "short sessions unaffected" made deterministic.
DIGEST_MIN_ENTRIES = 4


def ledger_enabled() -> bool:
    """SOPHIA_DELEGATION_LEDGER flag (default on)."""
    raw = os.environ.get("SOPHIA_DELEGATION_LEDGER", "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def digest_enabled() -> bool:
    """SOPHIA_DELEGATION_DIGEST flag (default on)."""
    raw = os.environ.get("SOPHIA_DELEGATION_DIGEST", "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def ledger_path(user_id: str, session_id: str) -> Path:
    """Path of the per-session ledger file (validates user_id, rejects traversal)."""
    return safe_user_path(USERS_DIR, user_id, "traces", f"{session_id}.ledger.jsonl")


def deliverable_intent(user_text: str, tool_names: list[str] | None = None) -> bool:
    """Deterministic deliverable-intent predicate for a companion turn."""
    if tool_names and any(name in _LIFECYCLE_TOOL_NAMES for name in tool_names):
        return True
    lowered = (user_text or "").lower()
    return any(marker in lowered for marker in _DELIVERABLE_INTENT_MARKERS)


def _artifact_subset(artifact_args: dict[str, Any] | None) -> dict[str, Any]:
    """Defensive harvest of the per-turn emit_artifact payload subset."""
    if not isinstance(artifact_args, dict):
        return {}
    subset: dict[str, Any] = {}
    for key in _ARTIFACT_SUBSET_KEYS:
        value = artifact_args.get(key)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        subset[key] = value
    return subset


def build_entry(
    turn_number: int,
    user_text: str,
    artifact_args: dict[str, Any] | None,
    tool_names: list[str] | None = None,
) -> dict[str, Any]:
    """Build one ledger entry for a companion turn."""
    text = user_text or ""
    truncated = len(text) > _USER_TEXT_CAP_CHARS
    entry: dict[str, Any] = {
        "turn_number": int(turn_number),
        "timestamp": datetime.now(UTC).isoformat(),
        "user_text": text[:_USER_TEXT_CAP_CHARS],
        "artifact": _artifact_subset(artifact_args),
        "deliverable_intent": deliverable_intent(text, tool_names),
    }
    if truncated:
        entry["user_text_truncated"] = True
    return entry


def append_turn(user_id: str, session_id: str, entry: dict[str, Any]) -> bool:
    """Append one entry to the session ledger. Never raises.

    Restart-overwrite guard: when the local file is absent but a Supabase
    mirror exists (langgraph restarted mid-session), the mirror is
    materialized FIRST so this append extends the full record instead of
    starting a fresh file whose next whole-file mirror upsert would
    overwrite the longer pre-restart copy.
    """
    try:
        path = ledger_path(user_id, session_id)
        if not path.exists():
            _materialize_from_mirror(user_id, session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        logger.info(
            "[DelegationLedger] append ok turn=%s bytes=%d",
            entry.get("turn_number"),
            len(line),
        )
        return True
    except Exception:  # noqa: BLE001 — a ledger failure never blocks a reply
        logger.warning("[DelegationLedger] append_failed", exc_info=True)
        return False


def read_ledger(user_id: str, session_id: str) -> list[dict[str, Any]]:
    """Read all entries, skipping malformed lines. Returns [] on any failure."""
    try:
        path = ledger_path(user_id, session_id)
        if not path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    entries.append(parsed)
        return entries
    except Exception:  # noqa: BLE001 — reads are best-effort everywhere
        logger.warning("[DelegationLedger] read_failed", exc_info=True)
        return []


def read_ledger_with_fallback(user_id: str, session_id: str) -> list[dict[str, Any]]:
    """Local-first read; on a local miss, materialize the Supabase mirror."""
    entries = read_ledger(user_id, session_id)
    if entries:
        return entries
    if _materialize_from_mirror(user_id, session_id):
        return read_ledger(user_id, session_id)
    return []


def next_turn_number(user_id: str, session_id: str, state_turn_count: int) -> int:
    """Compaction-immune turn numbering.

    ``turn_count`` is derived from the live message list
    (``TurnCountMiddleware``), which ``RemoveMessage(REMOVE_ALL_MESSAGES)``
    collapses — post-compaction it restarts near zero. The ledger itself is
    the durable counter: continue from the last recorded entry, falling
    back to state only when the ledger is empty.
    """
    entries = read_ledger(user_id, session_id)
    if entries:
        last = entries[-1].get("turn_number")
        if isinstance(last, int):
            return last + 1
    return int(state_turn_count) + 1


def ledger_stats(entries: list[dict[str, Any]]) -> dict[str, int]:
    """Counts the builder-side extraction trigger (D-3) consumes."""
    return {
        "turns": len(entries),
        "deliverable_intent_turns": sum(
            1 for entry in entries if entry.get("deliverable_intent")
        ),
    }


def delete_ledger_local(user_id: str, session_id: str) -> bool:
    """Best-effort local unlink (single-disk dev; no-op miss in prod split)."""
    try:
        ledger_path(user_id, session_id).unlink(missing_ok=True)
        return True
    except Exception:  # noqa: BLE001 — deletion is best-effort per caller contract
        logger.warning("[DelegationLedger] local_delete_failed", exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Supabase mirror (cross-service durability + gateway-reachable deletion)
# ---------------------------------------------------------------------------


def _store():
    """Import the Supabase store lazily (optional dependency at runtime)."""
    try:
        from deerflow.sophia.storage import supabase_artifact_store
    except Exception:  # noqa: BLE001 — storage module optional
        return None
    if not supabase_artifact_store.is_configured():
        return None
    return supabase_artifact_store


def mirror_ledger(user_id: str, session_id: str) -> bool:
    """Best-effort whole-file upsert of the ledger to Supabase.

    Keyed by ``{session_id}/ledger/session.jsonl`` (session_id == thread_id
    everywhere). Designed to run on a fire-and-forget task — never call it
    inline on the companion turn path.
    """
    store = _store()
    if store is None:
        return False
    try:
        path = ledger_path(user_id, session_id)
        if not path.is_file():
            return False
        content = path.read_bytes()
        result = store.upload_artifact(
            session_id,
            store.ledger_object_name(),
            content,
            content_type="application/x-ndjson",
        )
        if result is None:
            return False
        logger.info(
            "[DelegationLedger] mirror ok thread=%s bytes=%d", session_id, len(content)
        )
        return True
    except Exception:  # noqa: BLE001 — mirroring is strictly best-effort
        logger.warning("[DelegationLedger] mirror_failed thread=%s", session_id, exc_info=True)
        return False


def _materialize_from_mirror(user_id: str, session_id: str) -> bool:
    """Download the mirrored ledger into the local file. Best-effort."""
    store = _store()
    if store is None:
        return False
    try:
        result = store.download_artifact(session_id, store.ledger_object_name())
    except Exception:  # noqa: BLE001 — best-effort cross-service fetch
        logger.warning(
            "[DelegationLedger] mirror_download_failed thread=%s", session_id, exc_info=True
        )
        return False
    if result is None:
        return False
    content, _content_type = result
    try:
        path = ledger_path(user_id, session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(content)
    except Exception:  # noqa: BLE001 — disk write best-effort
        logger.warning("[DelegationLedger] materialize_failed", exc_info=True)
        return False
    logger.info(
        "[DelegationLedger] materialized from mirror thread=%s bytes=%d",
        session_id,
        len(content),
    )
    return True


# ---------------------------------------------------------------------------
# Build digest (D-2) — deterministic, zero model calls
# ---------------------------------------------------------------------------


def _digest_line(entry: dict[str, Any]) -> str:
    """Render one entry as ``t{n}: <takeaway-or-user_text>`` (line-capped)."""
    artifact = entry.get("artifact") or {}
    takeaway = artifact.get("takeaway") if isinstance(artifact, dict) else None
    text = takeaway if isinstance(takeaway, str) and takeaway.strip() else entry.get("user_text", "")
    collapsed = " ".join(str(text).split())
    if len(collapsed) > _DIGEST_LINE_CAP_CHARS:
        collapsed = collapsed[: _DIGEST_LINE_CAP_CHARS - 1] + "…"
    return f"t{entry.get('turn_number')}: {collapsed}"


def _goal_evolution_header(entries: list[dict[str, Any]]) -> str | None:
    """``Session goal: <first>`` or ``Session goal: <first> → <latest>``."""
    goals = [
        str((entry.get("artifact") or {}).get("session_goal") or "").strip()
        for entry in entries
        if isinstance(entry.get("artifact"), dict)
    ]
    goals = [goal for goal in goals if goal]
    if not goals:
        return None
    first, latest = goals[0], goals[-1]
    if first == latest:
        return f"Session goal: {first}"
    return f"Session goal: {first} → {latest}"


def _select_digest_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All deliverable-intent entries ∪ the last N, deduped, oldest-first."""
    recent_numbers = {
        entry.get("turn_number") for entry in entries[-_DIGEST_RECENT_TURNS:]
    }
    selected = [
        entry
        for entry in entries
        if entry.get("deliverable_intent") or entry.get("turn_number") in recent_numbers
    ]
    return selected


def build_digest(
    entries: list[dict[str, Any]],
    cap_chars: int = _DIGEST_CAP_CHARS,
    min_entries: int = DIGEST_MIN_ENTRIES,
) -> str | None:
    """Render the bounded conversation digest, or None for short sessions.

    Deterministic drop order when over the cap: recent-only
    (non-deliverable) lines drop first, oldest first; then deliverable
    lines, oldest first. The goal-evolution header is never dropped.

    ``min_entries`` defaults to the short-session threshold (G-DEL-2);
    the update-delta path passes 1 — a single turn since dispatch is
    still worth relaying to a running build.
    """
    if len(entries) < min_entries:
        return None
    selected = _select_digest_entries(entries)
    if not selected:
        return None

    header = _goal_evolution_header(entries)
    lines = [(entry, _digest_line(entry)) for entry in selected]

    def _total(active: list[tuple[dict[str, Any], str]]) -> int:
        body = "\n".join(line for _e, line in active)
        return len(body) + (len(header) + 1 if header else 0)

    while lines and _total(lines) > cap_chars:
        drop_index = next(
            (i for i, (entry, _line) in enumerate(lines) if not entry.get("deliverable_intent")),
            0,
        )
        lines.pop(drop_index)

    if not lines and not header:
        return None
    body = "\n".join(line for _e, line in lines)
    return f"{header}\n{body}" if header else body
