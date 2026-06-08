from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.sophia.tools.emit_builder_artifact import (
    BuilderArtifactInput,
    emit_builder_artifact,
)

VALID_HTML = (
    "<!doctype html><html><head><title>Sophia Workspace Demo</title>"
    "<style>body{font-family:Inter,sans-serif}.card{border:1px solid #ddd}</style>"
    "</head><body><main><h1>Sophia Workspace Demo</h1>"
    "<section class='card'><p>A polished browser-renderable landing page.</p></section>"
    "</main></body></html>"
)


def _state_with_html_target(outputs_dir: Path) -> dict:
    return {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/sophia-workspace-demo.html",
        "builder_task_started_at_ms": int((time.time() - 10) * 1000),
    }


def _runtime():
    return SimpleNamespace(context={"thread_id": "builder-thread"})


def test_emit_builder_artifact_accepts_html_artifact_type() -> None:
    payload = BuilderArtifactInput(
        artifact_path="/mnt/user-data/outputs/sophia-workspace-demo.html",
        artifact_type="html",
        artifact_title="Sophia Workspace Demo",
        steps_completed=3,
        decisions_made=["Built a standalone HTML artifact"],
        companion_summary="The HTML artifact is ready.",
        companion_tone_hint="Confident",
        user_next_action="Open it in canvas.",
        confidence=0.9,
    )

    assert payload.artifact_type == "html"
    result = emit_builder_artifact.invoke(payload.model_dump())
    emitted = json.loads(result)
    assert emitted["artifact_path"].endswith(".html")
    assert emitted["artifact_type"] == "html"


def test_explicit_html_artifact_accepts_valid_standalone_html(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.html").write_text(VALID_HTML, encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.html", "artifact_type": "html"}

    assert BuilderArtifactMiddleware._artifact_files_exist(args, state, _runtime()) is True
    assert args["artifact_path"] == "/mnt/user-data/outputs/sophia-workspace-demo.html"
    assert args["requested_artifact_ext"] == "html"
    assert args["artifact_ext"] == "html"
    assert args["artifact_is_fallback"] is False


def test_explicit_html_artifact_rejects_markdown_fallback(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.md").write_text("# Demo\n\nMarkdown fallback.", encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.md", "artifact_type": "document"}

    assert BuilderArtifactMiddleware._artifact_files_exist(args, state, _runtime()) is False


def test_html_markdown_emit_diagnostic_uses_invalid_extension_code(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.md").write_text("# Demo\n\nMarkdown fallback.", encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.md", "artifact_type": "document"}

    diagnostic = BuilderArtifactMiddleware._emit_rejection_diagnostics(args, state, _runtime())

    assert diagnostic["failure_code"] == "html_invalid_artifact_extension"
    assert diagnostic["failure_stage"] == "emit_rejected"
    assert diagnostic["emit_attempted"] is True
    assert "Markdown fallback" not in repr(diagnostic)


def test_explicit_html_artifact_rejects_code_fenced_html(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.html").write_text(f"```html\n{VALID_HTML}\n```", encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.html", "artifact_type": "html"}

    assert BuilderArtifactMiddleware._artifact_files_exist(args, state, _runtime()) is False


def test_html_fenced_emit_diagnostic_uses_markdown_fence_code(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.html").write_text(f"```html\n{VALID_HTML}\n```", encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.html", "artifact_type": "html"}

    diagnostic = BuilderArtifactMiddleware._emit_rejection_diagnostics(args, state, _runtime())

    assert diagnostic["failure_code"] == "html_markdown_fence"
    assert diagnostic["sanitized_emit_args"]["artifact_path"] == "sophia-workspace-demo.html"
    assert VALID_HTML not in repr(diagnostic)


def test_missing_html_emit_diagnostic_uses_artifact_file_missing_code(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    state = _state_with_html_target(outputs)
    args = {"artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.html", "artifact_type": "html"}

    diagnostic = BuilderArtifactMiddleware._emit_rejection_diagnostics(args, state, _runtime())

    assert diagnostic["failure_code"] == "artifact_file_missing"
    assert diagnostic["artifact_target_exists"] is False


def test_missing_supporting_file_emit_diagnostic_uses_supporting_file_code(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.html").write_text(VALID_HTML, encoding="utf-8")
    state = _state_with_html_target(outputs)
    args = {
        "artifact_path": "/mnt/user-data/outputs/sophia-workspace-demo.html",
        "artifact_type": "html",
        "supporting_files": ["/mnt/user-data/outputs/missing.css"],
    }

    diagnostic = BuilderArtifactMiddleware._emit_rejection_diagnostics(args, state, _runtime())

    assert diagnostic["failure_code"] == "supporting_file_missing"
    assert diagnostic["sanitized_emit_args"]["supporting_files"] == {
        "count": 1,
        "paths": ["missing.css"],
    }


def test_explicit_html_ceiling_fallback_promotes_valid_html(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.html").write_text(VALID_HTML, encoding="utf-8")
    state = _state_with_html_target(outputs)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state,
        steps_completed=12,
        reason="hard_ceiling",
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/sophia-workspace-demo.html"
    assert fallback["artifact_ext"] == "html"
    assert fallback["artifact_is_fallback"] is False


def test_explicit_html_ceiling_fallback_fails_with_specific_reason(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "sophia-workspace-demo.md").write_text("# Demo\n\nMarkdown fallback.", encoding="utf-8")
    state = _state_with_html_target(outputs)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state,
        steps_completed=12,
        reason="hard_ceiling",
    )

    assert fallback["artifact_path"] is None
    assert fallback["artifact_type"] == "html"
    assert fallback["requested_artifact_ext"] == "html"
    assert fallback["fallback_reason"] == "html_generation_failed"
    assert fallback["confidence"] == 0.2
