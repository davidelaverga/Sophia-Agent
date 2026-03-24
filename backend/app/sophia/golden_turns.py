"""Golden turn scanning — identifies high-impact turns for GEPA.

Golden turn threshold: tone_delta >= +0.5.
Used by BootstrapFewShot to inject real session examples into voice.md.
"""

from __future__ import annotations

import json
from pathlib import Path


def scan_golden_turns(
    user_id: str,
    min_delta: float = 0.5,
    max_results: int = 5,
) -> list[dict]:
    """Scan trace files for golden turns (tone_delta >= min_delta).

    Returns top turns sorted by tone_delta descending.
    Each turn includes voice_emotion data for BootstrapFewShot.
    """
    traces_dir = Path(f"users/{user_id}/traces")
    if not traces_dir.exists():
        return []

    golden: list[dict] = []

    for trace_file in traces_dir.glob("*.json"):
        data = json.loads(trace_file.read_text())
        for turn in data.get("turns", []):
            if turn.get("tone_delta", 0.0) >= min_delta:
                golden.append(turn)

    golden.sort(key=lambda t: t.get("tone_delta", 0.0), reverse=True)
    return golden[:max_results]
