"""Tests for ``BuilderArtifactMiddleware._build_ceiling_fallback`` — the
deliverable-recovery safety net used by both the hard-ceiling termination
path AND the consecutive-rejection short-circuit path.

Phase 4F (2026-05-16): the markdown deep-dive failure showed the previous
``_PROMOTE_EXTS`` list excluded ``.md`` and other plain-text deliverables,
so the fallback fell through to the apology branch even when a real
``.md`` was sitting in ``outputs/``. These tests lock the regression.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)


def _state_with_outputs(outputs_dir: Path, *, started_ms: int | None = None) -> dict:
    """Build a minimal ``BuilderArtifactState`` pointing at a real outputs dir."""
    return {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_task_started_at_ms": started_ms,
    }


def _write_file(path: Path, content: str = "x", *, mtime_offset_s: float = 0.0) -> None:
    path.write_text(content)
    if mtime_offset_s:
        new_mtime = time.time() + mtime_offset_s
        os.utime(path, (new_mtime, new_mtime))


def test_ceiling_fallback_promotes_markdown(tmp_path: Path) -> None:
    """Phase 4F regression: a ``.md`` written during the run MUST be
    promoted by the ceiling fallback.

    Before this fix the ``_PROMOTE_EXTS`` list contained only binary
    deliverables, so a markdown deep dive would be ignored and the
    fallback fell through to the apology path (``artifact_path=None``,
    ``confidence=0.2``). Production failure on the Zep memory deep
    dive 2026-05-16; see plan §Phase 4F.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    md_path = outputs / "zep_memory_deep_dive.md"
    _write_file(md_path, "# Zep Memory Deep Dive\n\nLong-form content.")

    # ``builder_task_started_at_ms`` slightly in the past so the
    # mtime filter (>= start - 5s) keeps the just-written ``.md``.
    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=29, reason="consecutive_empty_emit_rejections=2"
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/zep_memory_deep_dive.md"
    assert fallback["artifact_type"] == "md"
    # Recovered confidence — NOT the 0.2 apology floor.
    assert fallback["confidence"] >= 0.4
    assert fallback["steps_completed"] == 29


def test_ceiling_fallback_prefers_binary_over_markdown(tmp_path: Path) -> None:
    """A ``.pdf`` written more recently than a ``.md`` MUST win.

    The mtime sort takes precedence — newer wins regardless of extension
    priority order. This locks the ordering contract: extension priority
    is a tiebreaker, not the primary sort key, but for files at the
    same mtime the binary extension lists first.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    md = outputs / "report.md"
    pdf = outputs / "report.pdf"
    # Write markdown FIRST (older mtime), then PDF (newer).
    _write_file(md, "older")
    time.sleep(0.05)
    _write_file(pdf, b"%PDF-1.4 fake".decode("latin-1"))

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=10, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/report.pdf"
    assert fallback["artifact_type"] == "pdf"


def test_ceiling_fallback_promotes_json_too(tmp_path: Path) -> None:
    """Phase 4F: ``.json`` deliverables (data reports, specs) are also recovered."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    json_path = outputs / "spec.json"
    _write_file(json_path, '{"k": "v"}')

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=5, reason="hard_ceiling"
    )
    assert fallback["artifact_path"] == "/mnt/user-data/outputs/spec.json"
    assert fallback["artifact_type"] == "json"


def test_ceiling_fallback_apology_when_no_deliverables(tmp_path: Path) -> None:
    """When outputs/ has nothing promotable (no binary, no text, no generator),
    the fallback returns the apology shape — confidence=0.2, artifact_path=None.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    # Only a hidden / non-promotable file (starts with underscore-non-generator).
    _write_file(outputs / "_scratch.tmp", "ignore me")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=20, reason="hard_ceiling"
    )
    assert fallback["artifact_path"] is None
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_mtime_filter_excludes_stale_md(tmp_path: Path) -> None:
    """A ``.md`` written BEFORE the builder task started must not be promoted —
    it would surface a stale file from a previous run.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    stale = outputs / "old_report.md"
    _write_file(stale, "old run")
    # Backdate the file to well before our "task start".
    os.utime(stale, (time.time() - 3600, time.time() - 3600))

    # Builder task started "now".
    started_ms = int(time.time() * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=8, reason="hard_ceiling"
    )
    # Stale file filtered out → apology fallback.
    assert fallback["artifact_path"] is None
