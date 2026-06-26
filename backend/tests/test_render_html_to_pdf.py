"""Tests for the ``render_html_to_pdf`` builder tool.

The tool wraps a headless-Chromium (playwright-core) node subprocess that
converts a builder-authored, self-contained HTML report — with inline ``<svg>``
figures — into a PDF. It is the report visual path as of 2026-06-25, replacing
the markdown→pandoc renderer and the remote ``generate_chart`` service (which
rendered empty charts in production).

The tool's job is input validation, error shaping, and returning the same JSON
result shape as ``render_markdown_to_pdf`` so the builder's PDF gates
(page-count tolerance, visual-presence via ``image_count``, never-terminal
downgrade) keep working unchanged.

Chromium + playwright-core are not installed in local dev, so the subprocess is
mocked for the unit tests. A node-level smoke (skipped unless node + chromium +
playwright-core are present) exercises the real renderer end to end.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import deerflow.sophia.tools.render_html_to_pdf as render_html
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _PDF_CREATION_TOOL_NAMES,
    _REPORT_PDF_RENDER_TOOL_NAME,
    BuilderArtifactMiddleware,
    _pdf_contains_visual_evidence,
)

_OUTPUTS_PREFIX = "/mnt/user-data/outputs/"


def _call(**kwargs) -> dict:
    """Invoke the underlying tool function and parse its JSON result."""
    result = render_html.render_html_to_pdf.func(**kwargs)
    parsed = json.loads(result)
    assert isinstance(parsed, dict)
    return parsed


def _fake_runtime() -> SimpleNamespace:
    # get_thread_data reads runtime.state["thread_data"]; content is irrelevant
    # because we monkeypatch the host-path resolver in every test.
    return SimpleNamespace(state={"thread_data": {}}, context={}, config={})


@pytest.fixture
def staged(tmp_path, monkeypatch):
    """Map the virtual /mnt/user-data/outputs/ prefix onto a tmp dir."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()

    def _map(path: str, _thread_data) -> Path:
        rel = path.removeprefix(_OUTPUTS_PREFIX)
        return outputs / rel

    monkeypatch.setattr(render_html, "_host_path_for_virtual_output", _map)
    return outputs


# ---- Input validation ------------------------------------------------------


@pytest.mark.parametrize(
    ("html_path", "pdf_path", "error_part"),
    [
        (f"{_OUTPUTS_PREFIX}report.html", "/tmp/elsewhere.pdf", "pdf_path"),
        ("/etc/passwd", f"{_OUTPUTS_PREFIX}out.pdf", "html_path"),
        (f"{_OUTPUTS_PREFIX}../secret.html", f"{_OUTPUTS_PREFIX}out.pdf", "traversal"),
    ],
)
def test_rejects_paths_outside_outputs(staged, html_path, pdf_path, error_part):
    result = _call(
        runtime=_fake_runtime(),
        html_path=html_path,
        pdf_path=pdf_path,
    )
    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert error_part in result["error"]


def test_missing_html_source(staged, monkeypatch):
    monkeypatch.setattr(render_html.shutil, "which", lambda _: "/usr/bin/node")
    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}does-not-exist.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is False
    assert result["error_type"] == "missing_html"


def test_node_unavailable(staged, monkeypatch):
    (staged / "report.html").write_text("<html><body>hi</body></html>")
    monkeypatch.setattr(render_html.shutil, "which", lambda _: None)
    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is False
    assert result["error_type"] == "node_unavailable"


def test_render_script_missing(staged, monkeypatch):
    (staged / "report.html").write_text("<html><body>hi</body></html>")
    monkeypatch.setattr(render_html.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(render_html, "_render_script_path", lambda: None)
    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is False
    assert result["error_type"] == "render_script_missing"


# ---- Subprocess invocation + result shaping --------------------------------


def _wire_node(monkeypatch, tmp_path):
    monkeypatch.setattr(render_html.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(render_html, "_render_script_path", lambda: tmp_path / "render_html_to_pdf.mjs")


def test_success_result_shape(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text("<html><body><svg></svg></body></html>")
    _wire_node(monkeypatch, tmp_path)

    captured = {}

    def _fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        # Simulate the node renderer writing the PDF.
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="[render_html_to_pdf] wrote out.pdf bytes=12")

    monkeypatch.setattr(render_html.subprocess, "run", _fake_run)
    # Inline SVG rasterizes into PDF image XObjects → image_count > 0.
    monkeypatch.setattr(
        render_html,
        "_inspect_pdf_layout_with_targets",
        lambda host_pdf, **kw: {"page_count": 3, "image_count": 2, "layout_quality": "ok"},
    )

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        requested_pages=3,
    )

    assert result["success"] is True
    assert result["engine"] == "chromium"
    assert result["pdf_path"] == f"{_OUTPUTS_PREFIX}out.pdf"
    assert result["page_count"] == 3
    # image_count drives _pdf_contains_visual_evidence so inline-SVG reports pass.
    assert result["image_count"] == 2
    assert result["size_bytes"] > 0
    # The node command points at the html/pdf host paths.
    assert "--html-file" in captured["cmd"] and "--pdf-file" in captured["cmd"]


def test_margin_flag_is_passed(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text("<html><body>hi</body></html>")
    _wire_node(monkeypatch, tmp_path)
    captured = {}

    def _fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(render_html.subprocess, "run", _fake_run)
    monkeypatch.setattr(
        render_html, "_inspect_pdf_layout_with_targets", lambda host_pdf, **kw: {"page_count": 1, "image_count": 0}
    )

    _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        margin="20mm",
    )
    assert "--margin" in captured["cmd"]
    assert "20mm" in captured["cmd"]


def test_render_failure_returns_structured_error(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text("<html><body>hi</body></html>")
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="Error: chromium crashed")

    monkeypatch.setattr(render_html.subprocess, "run", _fake_run)

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is False
    assert result["error_type"] == "html_render_failed"
    assert "chromium crashed" in (result.get("stderr") or "")


def test_timeout_returns_structured_error(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text("<html><body>hi</body></html>")
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 120)

    monkeypatch.setattr(render_html.subprocess, "run", _fake_run)

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is False
    assert result["error_type"] == "render_timeout"


# ---- Node-level smoke (real renderer) --------------------------------------


def _chromium_path() -> str | None:
    env = os.getenv("SOPHIA_CHROMIUM_PATH")
    if env and Path(env).exists():
        return env
    for candidate in ("/usr/bin/chromium", "/usr/bin/chromium-browser"):
        if Path(candidate).exists():
            return candidate
    return shutil.which("chromium") or shutil.which("chromium-browser")


def _smoke_available() -> bool:
    script = render_html._render_script_path()
    if script is None or shutil.which("node") is None or _chromium_path() is None:
        return False
    # playwright-core must resolve beside the .mjs.
    return (script.parent / "node_modules" / "playwright-core").exists()


@pytest.mark.skipif(not _smoke_available(), reason="node + chromium + playwright-core not available")
def test_node_smoke_renders_inline_svg_pdf(staged, monkeypatch):
    """End-to-end: a tiny HTML+<svg> renders to a real multi-page-capable PDF."""
    html = (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        "svg{width:300px;height:200px}</style></head><body>"
        "<h1>Smoke report</h1>"
        "<figure><svg viewBox='0 0 300 200' xmlns='http://www.w3.org/2000/svg'>"
        "<rect x='10' y='10' width='80' height='150' fill='#2f6df6'/>"
        "<rect x='110' y='60' width='80' height='100' fill='#16a36a'/></svg></figure>"
        "</body></html>"
    )
    (staged / "report.html").write_text(html)

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )

    assert result["success"] is True, result
    assert result["engine"] == "chromium"
    assert (staged / "out.pdf").stat().st_size > 0
    assert result["page_count"] >= 1
    # chromium rasterizes the inline SVG into PDF image XObjects.
    assert result["image_count"] >= 1


# ---- gate wiring: HTML→PDF reuses the markdown-PDF gates --------------------


def test_render_html_to_pdf_is_a_pdf_creation_tool():
    # Result-capture + attempt-detection both key off this set, so an
    # HTML-rendered .pdf flows into the same builder_pdf_render_result channel.
    assert _REPORT_PDF_RENDER_TOOL_NAME == "render_html_to_pdf"
    assert "render_html_to_pdf" in _PDF_CREATION_TOOL_NAMES


def test_forced_pdf_render_targets_the_html_tool():
    # The retired render_markdown_to_pdf is not offered to the report build, so
    # the forced tool_choice must name render_html_to_pdf.
    choice = BuilderArtifactMiddleware._forced_pdf_render_tool_choice()
    assert choice == {"type": "tool", "name": "render_html_to_pdf"}


def test_html_pdf_visual_evidence_accepts_image_or_vector(tmp_path):
    # Visual evidence comes from the render result. Rasterized images count
    # (image_count) AND inline-SVG vector figures count (vector_visual_count) —
    # the R2-2 fix: an inline-SVG report reads image_count=0 but is visual-present.
    pdf = tmp_path / "out.pdf"
    by_image = {"builder_pdf_render_result": {"image_count": 2, "vector_visual_count": 0, "page_count": 4}}
    by_vector = {"builder_pdf_render_result": {"image_count": 0, "vector_visual_count": 3, "page_count": 4}}
    neither = {"builder_pdf_render_result": {"image_count": 0, "vector_visual_count": 0, "page_count": 4}}
    assert _pdf_contains_visual_evidence(pdf, by_image) is True
    assert _pdf_contains_visual_evidence(pdf, by_vector) is True  # R2-2: no false reject
    assert _pdf_contains_visual_evidence(pdf, neither) is False


def test_render_html_to_pdf_reports_vector_visual_count(staged, monkeypatch, tmp_path):
    # The renderer counts inline <svg> in the source so the visual gate has a
    # vector signal even when chromium keeps SVG as vector (image_count=0).
    (staged / "report.html").write_text(
        "<html><body><figure><svg></svg></figure><figure><svg></svg></figure></body></html>"
    )
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(cmd, **kwargs):
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(render_html.subprocess, "run", _fake_run)
    monkeypatch.setattr(
        render_html, "_inspect_pdf_layout_with_targets", lambda host_pdf, **kw: {"page_count": 3, "image_count": 0}
    )
    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is True
    assert result["image_count"] == 0  # chromium keeps SVG vector
    assert result["vector_visual_count"] == 2  # two inline <svg> figures counted
