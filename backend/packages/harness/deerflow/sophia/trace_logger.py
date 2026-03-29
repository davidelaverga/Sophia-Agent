"""Trace logger for writing per-session trace files.

Iterates over a completed session's messages, extracts per-turn data
from emit_artifact tool calls, and writes a JSON trace file that serves
as ground truth for GEPA and tone analysis.

Trace files are written atomically (temp file + rename) to prevent
partial writes on crash.
"""

from __future__ import annotations

import json
import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)

# Default tone estimate when no previous turn data is available
_DEFAULT_TONE_ESTIMATE = 2.5

# Golden turn threshold per CLAUDE.md
_GOLDEN_TURN_THRESHOLD = 0.5


def write_session_trace(
    user_id: str,
    session_id: str,
    messages: list[Any],
    session_metadata: dict[str, Any] | None = None,
) -> Path:
    """Write per-turn trace records for a completed session to a JSON file.

    Args:
        user_id: The user identifier (validated for path safety).
        session_id: The session identifier used in turn IDs and filename.
        messages: List of LangChain BaseMessage objects from the session.
        session_metadata: Optional dict with keys like ``platform``,
            ``context_mode``, ``ritual`` that are copied into every
            trace record.

    Returns:
        Path to the written trace file.

    Raises:
        ValueError: If ``user_id`` fails validation or causes path
            traversal.
    """
    metadata = session_metadata or {}

    trace_path = safe_user_path(USERS_DIR, user_id, "traces", f"{session_id}.json")

    turns = _extract_turns(session_id, messages, metadata)

    trace_doc = {
        "session_id": session_id,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "turns": turns,
    }

    # Atomic write: temp file in the same directory then rename
    trace_path.parent.mkdir(parents=True, exist_ok=True)

    tmp_fd, tmp_path_str = tempfile.mkstemp(
        suffix=".tmp",
        dir=str(trace_path.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with open(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(trace_doc, f, indent=2, ensure_ascii=False)
        tmp_path.replace(trace_path)
    except BaseException:
        # Clean up temp file on any failure
        tmp_path.unlink(missing_ok=True)
        raise

    logger.info("Trace written: %s (%d turns)", trace_path, len(turns))
    return trace_path


def _extract_turns(
    session_id: str,
    messages: list[Any],
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    """Walk messages and build a trace record for each emit_artifact tool call."""
    turns: list[dict[str, Any]] = []
    turn_number = 0
    previous_tone: float = _DEFAULT_TONE_ESTIMATE

    for msg in messages:
        tool_calls = getattr(msg, "tool_calls", None)
        if not tool_calls:
            continue

        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            if tc.get("name") != "emit_artifact":
                continue

            args = tc.get("args", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, TypeError):
                    args = {}

            turn_number += 1
            tone_after = _safe_float(args.get("tone_estimate"), previous_tone)
            tone_delta = round(tone_after - previous_tone, 4)

            record = {
                "turn_id": f"sess_{session_id}_turn_{turn_number}",
                "timestamp": _extract_timestamp(msg),
                "tone_before": previous_tone,
                "tone_after": tone_after,
                "tone_delta": tone_delta,
                "is_golden_turn": tone_delta >= _GOLDEN_TURN_THRESHOLD,
                "voice_emotion_primary": args.get("voice_emotion_primary", ""),
                "voice_emotion_secondary": args.get("voice_emotion_secondary", ""),
                "voice_speed": args.get("voice_speed", ""),
                "skill_loaded": args.get("skill_loaded", ""),
                "active_tone_band": args.get("active_tone_band", ""),
                "ritual": metadata.get("ritual"),
                "platform": metadata.get("platform", ""),
                "context_mode": metadata.get("context_mode", ""),
                "memory_injected": metadata.get("memory_injected", []),
                "prompt_versions": metadata.get(
                    "prompt_versions",
                    {"voice_md": 1, "tone_guidance_md": 1, "active_skill_md": 1},
                ),
            }

            turns.append(record)
            previous_tone = tone_after

    return turns


def _extract_timestamp(msg: Any) -> str:
    """Best-effort ISO-8601 timestamp from a message."""
    # LangChain messages may carry response_metadata or additional_kwargs
    for attr in ("response_metadata", "additional_kwargs"):
        meta = getattr(msg, attr, None)
        if isinstance(meta, dict) and "timestamp" in meta:
            return str(meta["timestamp"])
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any, default: float) -> float:
    """Convert value to float, falling back to default on failure."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
