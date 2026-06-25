"""Batch (``--manifest``) mode for the image-generation skill (2026-06-24).

Decks generate slide images in ONE parallel batch instead of one serial call
per turn. These tests exercise the skill script directly via subprocess (no
OpenAI calls needed — items fail fast on missing prompt files, which is exactly
the per-item isolation we want to assert).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "public"
    / "image-generation"
    / "scripts"
    / "generate.py"
)


def _run_manifest(manifest: dict, tmp_path: Path) -> tuple[int, dict | None]:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT), "--manifest", str(manifest_path)],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "OPENAI_API_KEY": ""},
    )
    summary = None
    for line in proc.stdout.splitlines():
        if line.startswith("IMAGEGEN_BATCH "):
            summary = json.loads(line[len("IMAGEGEN_BATCH "):])
    return proc.returncode, summary


def test_script_exists() -> None:
    assert _SCRIPT.is_file()


def test_empty_manifest_emits_summary_and_exits_nonzero(tmp_path) -> None:
    code, summary = _run_manifest({"items": []}, tmp_path)
    assert code == 1
    assert summary is not None
    assert summary["images_generated"] == 0
    assert summary.get("error") == "manifest_empty"


def test_per_item_failure_is_isolated(tmp_path) -> None:
    # Two items pointing at nonexistent prompt files: each fails independently,
    # the batch still emits ONE summary, and one bad item never aborts the run.
    manifest = {
        "items": [
            {"prompt_file": str(tmp_path / "nope-1.json"), "output_file": str(tmp_path / "o1.png")},
            {"prompt_file": str(tmp_path / "nope-2.json"), "output_file": str(tmp_path / "o2.png")},
        ],
        "concurrency": 2,
    }
    code, summary = _run_manifest(manifest, tmp_path)
    assert summary is not None
    assert summary["requested"] == 2
    assert summary["images_generated"] == 0
    assert len(summary["items"]) == 2
    assert all(item["success"] is False for item in summary["items"])
    # Output paths are echoed back so the harness can reconcile per-item status.
    assert {item["output_file"] for item in summary["items"]} == {
        str(tmp_path / "o1.png"),
        str(tmp_path / "o2.png"),
    }
    assert code == 1


def test_item_missing_required_fields_is_reported(tmp_path) -> None:
    manifest = {"items": [{"prompt_file": "", "output_file": ""}]}
    _code, summary = _run_manifest(manifest, tmp_path)
    assert summary is not None
    assert summary["items"][0]["success"] is False
    assert summary["items"][0]["error"] == "missing_prompt_or_output"
