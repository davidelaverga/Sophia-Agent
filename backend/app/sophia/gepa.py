"""GEPA — Guided Evolutionary Prompt Architecture.

Rules (from CLAUDE.md):
1. soul.md is NEVER a GEPA target — excluded by exclusion list
2. Trace files are ground truth — never modified
3. Global/shared files require human (Davide) review before deployment
4. Tone regression is a hard block — no worse-than-baseline variants
5. Schema version increments on any structural change to prompt files

First target (Week 6): voice.md
Metrics: tone_delta (primary) × Claude-isms (secondary) × ritual coherence (tertiary)
"""

from __future__ import annotations

from pathlib import Path

# Files that are NEVER optimized by GEPA
EXCLUSION_LIST = frozenset([
    "soul.md",  # permanently immutable
])


def run_gepa_pass(
    target_file: str,
    traces_path: str,
) -> dict:
    """Run a single GEPA optimization pass on a target prompt file.

    Returns:
        {"variant": str, "tone_delta_avg": float, "approved": bool}
    """
    if target_file in EXCLUSION_LIST:
        raise ValueError(f"{target_file} is in the GEPA exclusion list and cannot be optimized.")

    # TODO(jorge): Implement GEPA optimization:
    # 1. Load traces from traces_path
    # 2. Generate synthetic eval dataset
    # 3. Optimize target file for tone_delta
    # 4. Check constraint gates (no regression, no Claude-isms increase)
    # 5. Flag for human review
    return {
        "variant": "",
        "tone_delta_avg": 0.0,
        "approved": False,
    }
