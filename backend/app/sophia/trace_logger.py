"""Trace logging — writes per-turn trace data to users/{user_id}/traces/.

Starts Week 2, runs continuously. By Week 6: 4+ weeks of data for GEPA.
Trace files are ground truth — never modified.
"""

from __future__ import annotations

import json
from pathlib import Path

TRACE_SCHEMA_VERSION = 1


def write_turn_trace(
    user_id: str,
    session_id: str,
    turn_number: int,
    trace_data: dict,
) -> None:
    """Write a single turn trace to the session trace file."""
    traces_dir = Path(f"users/{user_id}/traces")
    traces_dir.mkdir(parents=True, exist_ok=True)

    trace_file = traces_dir / f"{session_id}.json"

    # Load existing traces or start fresh
    turns: list[dict] = []
    if trace_file.exists():
        existing = json.loads(trace_file.read_text())
        turns = existing.get("turns", [])

    trace_entry = {
        "turn_id": f"sess_{session_id}_turn_{turn_number}",
        "tone_before": trace_data.get("tone_before", 0.0),
        "tone_after": trace_data.get("tone_after", 0.0),
        "tone_delta": trace_data.get("tone_after", 0.0) - trace_data.get("tone_before", 0.0),
        "is_golden_turn": False,
        "voice_emotion_primary": trace_data.get("voice_emotion_primary", ""),
        "voice_emotion_secondary": trace_data.get("voice_emotion_secondary", ""),
        "voice_speed": trace_data.get("voice_speed", "normal"),
        "skill_loaded": trace_data.get("skill_loaded", ""),
        "active_tone_band": trace_data.get("active_tone_band", ""),
        "ritual": trace_data.get("ritual"),
        "platform": trace_data.get("platform", "voice"),
        "context_mode": trace_data.get("context_mode", "life"),
        "memory_injected": trace_data.get("memory_injected", []),
        "prompt_versions": trace_data.get("prompt_versions", {}),
    }

    # Mark golden turns (tone_delta >= +0.5)
    if trace_entry["tone_delta"] >= 0.5:
        trace_entry["is_golden_turn"] = True

    turns.append(trace_entry)

    trace_file.write_text(json.dumps({"schema_version": TRACE_SCHEMA_VERSION, "turns": turns}, indent=2))


async def aggregate_traces(
    user_id: str,
    session_id: str,
    session_artifacts: list[dict],
) -> None:
    """Aggregate turn-level traces into session summary (offline pipeline step 5)."""
    # TODO(jorge): Implement trace aggregation from artifacts
    pass
