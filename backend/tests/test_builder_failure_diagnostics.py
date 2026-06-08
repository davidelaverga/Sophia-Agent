from __future__ import annotations

from types import SimpleNamespace

from deerflow.sophia.builder_failure_diagnostics import (
    BUILDER_FAILURE_DIAGNOSTICS_SCHEMA,
    build_builder_failure_diagnostics,
    sanitize_emit_args,
    summarize_outputs,
)


def test_diagnostic_model_redacts_raw_content_and_signed_urls(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "index.html").write_text(
        "<!doctype html><html><body><main>Safe summary only</main></body></html>",
        encoding="utf-8",
    )

    diagnostic = build_builder_failure_diagnostics(
        state={"thread_data": {"outputs_path": str(outputs)}},
        runtime=SimpleNamespace(context={"thread_id": "task-1", "run_id": "run-1"}),
        artifact_args={
            "artifact_path": "/mnt/user-data/outputs/index.html",
            "artifact_type": "html",
            "artifact_title": "Demo",
            "content": "<!doctype html><html><body>secret body</body></html>",
            "artifact_url": "https://example.supabase.co/signed-token",
        },
        failure_stage="emit_rejected",
        failure_reason="Builder rejected HTML output because it was wrapped in Markdown fences.",
        failure_code="html_markdown_fence",
        emit_attempted=True,
        signed_url_created=False,
    )

    assert diagnostic["schema"] == BUILDER_FAILURE_DIAGNOSTICS_SCHEMA
    assert diagnostic["signed_url_created"] is False
    assert diagnostic["raw_content_excluded"] is True
    rendered = repr(diagnostic)
    assert "secret body" not in rendered
    assert "signed-token" not in rendered
    assert "artifact_url" not in diagnostic.get("sanitized_emit_args", {})


def test_output_summary_includes_relative_size_extension_only(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    html = outputs / "report.html"
    html.write_text(
        "<!doctype html><html><body><h1>Report</h1></body></html>",
        encoding="utf-8",
    )

    summary = summarize_outputs(outputs)

    assert len(summary) == 1
    assert summary[0]["relative_path"] == "report.html"
    assert summary[0]["extension"] == "html"
    assert summary[0]["size_bytes"] == html.stat().st_size
    assert summary[0]["exists"] is True
    assert "mtime" in summary[0]
    rendered = repr(summary)
    assert "<h1>Report</h1>" not in rendered


def test_missing_task_and_run_ids_are_safe(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()

    diagnostic = build_builder_failure_diagnostics(
        state={"thread_data": {"outputs_path": str(outputs)}},
        runtime=None,
        failure_stage="generation",
        failure_reason="Builder finished without producing a deliverable artifact.",
        failure_code="builder_completed_without_deliverable",
    )

    assert diagnostic["schema"] == BUILDER_FAILURE_DIAGNOSTICS_SCHEMA
    assert "task_id" not in diagnostic
    assert "run_id" not in diagnostic
    assert diagnostic["secrets_excluded"] is True


def test_sanitize_emit_args_keeps_safe_paths_and_counts_supporting_files():
    args = {
        "artifact_path": "/mnt/user-data/outputs/site/index.html",
        "supporting_files": [
            "/mnt/user-data/outputs/site/app.css",
            "https://example.supabase.co/signed-url",
        ],
        "source_artifact_path": "/mnt/user-data/outputs/source.html",
        "revision_of_artifact_path": "../private/source.html",
        "content": "<html>raw</html>",
        "confidence": "0.82",
    }

    sanitized = sanitize_emit_args(args)

    assert sanitized == {
        "artifact_path": "site/index.html",
        "supporting_files": {"count": 2, "paths": ["site/app.css"]},
        "source_artifact_path": "source.html",
        "confidence": 0.82,
    }
