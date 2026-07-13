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
from deerflow.sophia.report_contract import ReportBuildManifest, inspect_report_source

_OUTPUTS_PREFIX = "/mnt/user-data/outputs/"


def _call(**kwargs) -> dict:
    """Invoke the underlying tool function and parse its JSON result."""
    result = render_html.render_html_to_pdf.func(**kwargs)
    parsed = json.loads(result)
    assert isinstance(parsed, dict)
    return parsed


def _fake_runtime(state: dict | None = None) -> SimpleNamespace:
    # get_thread_data reads runtime.state["thread_data"]; content is irrelevant
    # because we monkeypatch the host-path resolver in every test.
    return SimpleNamespace(state={"thread_data": {}, **(state or {})}, context={}, config={})


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
        # Markdown/text sources are not valid Chromium inputs for this tool; the
        # builder must author real HTML first so failed attempts get a repair turn.
        (f"{_OUTPUTS_PREFIX}report.md", f"{_OUTPUTS_PREFIX}out.pdf", "html_path"),
        # Under outputs but wrong extension — Chromium would write PDF bytes to
        # an .html name and the emit path could stamp it artifact_ext=pdf.
        (f"{_OUTPUTS_PREFIX}report.html", f"{_OUTPUTS_PREFIX}report.html", "pdf_path"),
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


def test_rejects_symlinked_html_source_outside_outputs(staged, tmp_path):
    secret = tmp_path / "secret.html"
    secret.write_text("<html><body>outside outputs</body></html>")
    link = staged / "report.html"
    try:
        link.symlink_to(secret)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert "escapes the outputs directory" in result["error"]


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


def test_visual_report_requires_manifest_before_chromium(staged, monkeypatch):
    (staged / "report.html").write_text("<html><body><section>Draft</section></body></html>")
    called = False

    def _unexpected_runtime():
        nonlocal called
        called = True
        return None, None, None

    monkeypatch.setattr(render_html, "_html_pdf_runtime", _unexpected_runtime)
    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )

    assert result["success"] is False
    assert result["error_type"] == "report_manifest_required"
    assert result["retryable"] is True
    assert called is False


def test_report_manifest_is_model_visible_but_runtime_is_injected() -> None:
    tool = render_html.render_html_to_pdf
    schema = tool.tool_call_schema.model_json_schema()

    assert tool._injected_args_keys == frozenset({"runtime"})
    assert "report_manifest" in schema["properties"]
    assert "runtime" not in schema["properties"]


def test_report_contract_rejects_missing_sections_and_visuals_before_render(staged, monkeypatch):
    (staged / "report.html").write_text(
        "<html><body><section id='cover' class='cover' data-report-role='cover'>Cover</section>"
        "<nav id='toc' class='toc'><a href='#architecture'>Architecture</a></nav>"
        "<section id='summary' data-report-role='summary'>Summary only</section></body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run for an incomplete source"))
    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 2,
                "builder_pdf_required_visual_count": 1,
                "builder_pdf_required_min_word_count": 300,
                "builder_pdf_cover_required": True,
                "builder_pdf_toc_required": True,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [
                {"id": "cover", "title": "Cover", "role": "cover"},
                {"id": "architecture", "title": "Architecture", "role": "body"},
                {"id": "trade-offs", "title": "Trade-offs", "role": "body"},
            ],
            "visuals": [{"id": "memory-pipeline", "title": "Memory pipeline", "kind": "diagram"}],
            "cover_required": True,
            "toc_required": True,
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["error_type"] == "report_contract_failed"
    assert result["missing_section_ids"] == ["architecture", "trade-offs"]
    assert result["missing_visual_ids"] == ["memory-pipeline"]
    assert "report_manifest.minimum_word_count" in result["report_contract_problems"]


def test_report_contract_requires_manifest_ids_on_semantic_sections(staged, monkeypatch):
    prose = " ".join(["analysis"] * 320)
    (staged / "report.html").write_text(
        "<html><body>"
        "<div id='architecture'>Wrapper with the required id</div>"
        f"<section id='unrelated' data-report-role='body'><p>{prose}</p></section>"
        "</body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run for an invalid section contract"))

    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 1,
                "builder_pdf_required_min_word_count": 300,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [{"id": "architecture", "title": "Architecture", "role": "body"}],
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["error_type"] == "report_contract_failed"
    assert result["missing_section_ids"] == ["architecture"]
    assert "report_manifest.sections[0].id:architecture" in result["report_contract_problems"]


@pytest.mark.parametrize("hidden_attribute", ["hidden", "aria-hidden='true'", "style='display:none'", "style='visibility: hidden !important'"])
def test_report_contract_excludes_hidden_text_from_minimum_word_count(staged, monkeypatch, hidden_attribute):
    hidden_prose = " ".join(["invisible"] * 350)
    (staged / "report.html").write_text(
        "<html><body>"
        "<section id='architecture' data-report-role='body'><h2>Architecture</h2>"
        f"<div {hidden_attribute}><p>{hidden_prose}</p></div>"
        "<p>Visible summary.</p></section>"
        "</body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run when visible prose is incomplete"))

    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 1,
                "builder_pdf_required_min_word_count": 300,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [{"id": "architecture", "title": "Architecture", "role": "body"}],
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["error_type"] == "report_contract_failed"
    assert result["source_word_count"] < 20
    assert "report_manifest.minimum_word_count" in result["report_contract_problems"]


def test_report_contract_excludes_stylesheet_hidden_semantics_and_text(staged, monkeypatch):
    hidden_prose = " ".join(["invisible"] * 350)
    (staged / "report.html").write_text(
        "<html><head><style>section.pad { display: none; }</style></head><body>"
        f"<section id='architecture' class='pad' data-report-role='body'><p>{hidden_prose}</p>"
        "<figure data-visual-id='memory-pipeline'>Hidden visual</figure></section>"
        "<p>Visible summary.</p>"
        "</body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run for stylesheet-hidden content"))

    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 1,
                "builder_pdf_required_visual_count": 1,
                "builder_pdf_required_min_word_count": 300,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [{"id": "architecture", "title": "Architecture", "role": "body"}],
            "visuals": [{"id": "memory-pipeline", "title": "Memory pipeline", "kind": "diagram"}],
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["missing_section_ids"] == ["architecture"]
    assert result["missing_visual_ids"] == ["memory-pipeline"]
    assert result["found_body_section_count"] == 0
    assert result["source_word_count"] < 10
    assert "report_manifest.minimum_word_count" in result["report_contract_problems"]


def test_report_contract_excludes_print_media_hidden_semantics_and_text(staged, monkeypatch):
    hidden_prose = " ".join(["invisible"] * 350)
    (staged / "report.html").write_text(
        "<html><head><style>@media screen { .screen-only { display: none; } }"
        "@media print, speech { .report .pad { opacity: 0%; } }</style></head><body>"
        "<main class='report'>"
        f"<section id='architecture' class='pad' data-report-role='body'><p>{hidden_prose}</p></section>"
        "<section id='visible' class='screen-only' data-report-role='body'>Visible in print.</section>"
        "</main></body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run for print-hidden content"))

    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 2,
                "builder_pdf_required_min_word_count": 300,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [
                {"id": "architecture", "title": "Architecture", "role": "body"},
                {"id": "visible", "title": "Visible", "role": "body"},
            ],
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["missing_section_ids"] == ["architecture"]
    assert result["found_body_section_count"] == 1
    assert result["source_word_count"] < 10
    assert "report_manifest.minimum_word_count" in result["report_contract_problems"]


def test_report_contract_ignores_screen_only_style_elements_for_print(tmp_path):
    report = tmp_path / "report.html"
    prose = " ".join(["analysis"] * 120)
    report.write_text(
        "<html><head><style media='screen'>.pad { display: none; }</style></head><body>"
        f"<section id='architecture' class='pad' data-report-role='body'><p>{prose}</p></section>"
        "</body></html>",
        encoding="utf-8",
    )
    manifest = ReportBuildManifest.model_validate(
        {
            "sections": [{"id": "architecture", "title": "Architecture", "role": "body"}],
            "cover_required": False,
            "minimum_word_count": 100,
        }
    )

    result = inspect_report_source(report, manifest)

    assert result["report_contract_status"] == "accepted"
    assert result["missing_section_ids"] == []
    assert result["found_body_section_count"] == 1
    assert result["source_word_count"] >= 100


def test_report_contract_rejects_unmodeled_visibility_selectors(staged, monkeypatch):
    prose = " ".join(["analysis"] * 350)
    (staged / "report.html").write_text(
        "<html><head><style>@media print { .pad:first-child { display: none; } }</style></head><body>"
        f"<section id='architecture' class='pad' data-report-role='body'><p>{prose}</p></section>"
        "</body></html>"
    )
    monkeypatch.setattr(render_html, "_html_pdf_runtime", lambda: pytest.fail("Chromium must not run for unmodeled visibility selectors"))

    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_required_body_section_count": 1,
                "builder_pdf_required_min_word_count": 300,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [{"id": "architecture", "title": "Architecture", "role": "body"}],
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is False
    assert result["unsupported_visibility_selectors"] == [".pad:first-child"]
    assert "report_manifest.stylesheet_visibility_selector" in result["report_contract_problems"]


def test_complete_report_contract_renders_with_state_page_targets(staged, monkeypatch, tmp_path):
    prose = " ".join(["analysis"] * 340)
    (staged / "report.html").write_text(
        "<html><body>"
        "<section id='cover' class='cover' data-report-role='cover'>Cover</section>"
        "<nav id='toc' class='toc'><a href='#architecture'>Architecture</a><a href='#conclusion'>Conclusion</a></nav>"
        f"<section id='architecture' data-report-role='body'><h2>Architecture</h2><p>{prose}</p>"
        "<figure data-visual-id='memory-pipeline'><svg><rect width='10' height='10'/></svg></figure></section>"
        "<section id='conclusion' data-report-role='conclusion'>Conclusion</section>"
        "<section id='references' data-report-role='references'>References</section>"
        "</body></html>"
    )
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(_cmd, **_kwargs):
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="vector_visual_count=1")

    captured = {}
    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)
    monkeypatch.setattr(
        render_html,
        "_inspect_pdf_layout_with_targets",
        lambda _host_pdf, **kwargs: captured.update(kwargs) or {"page_count": 12, "image_count": 0, "layout_quality": "ok"},
    )
    result = _call(
        runtime=_fake_runtime(
            {
                "builder_artifact_target_path": f"{_OUTPUTS_PREFIX}out.pdf",
                "delegation_context": {"task_type": "visual_report"},
                "builder_pdf_requested_min_pages": 12,
                "builder_pdf_requested_max_pages": 16,
                "builder_pdf_required_body_section_count": 1,
                "builder_pdf_required_visual_count": 1,
                "builder_pdf_required_min_word_count": 300,
                "builder_pdf_cover_required": True,
                "builder_pdf_toc_required": True,
                "builder_pdf_conclusion_required": True,
                "builder_pdf_references_required": True,
            }
        ),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        report_manifest={
            "sections": [
                {"id": "cover", "title": "Cover", "role": "cover"},
                {"id": "architecture", "title": "Architecture", "role": "body"},
                {"id": "conclusion", "title": "Conclusion", "role": "conclusion"},
                {"id": "references", "title": "References", "role": "references"},
            ],
            "visuals": [{"id": "memory-pipeline", "title": "Memory pipeline", "kind": "diagram"}],
            "cover_required": True,
            "toc_required": True,
            "conclusion_required": True,
            "references_required": True,
            "minimum_word_count": 300,
        },
    )

    assert result["success"] is True
    assert result["report_contract_status"] == "accepted"
    assert result["cover_present"] is True
    assert result["found_visual_count"] == 1
    assert captured["requested_min_pages"] == 12
    assert captured["requested_max_pages"] == 16


# ---- Subprocess invocation + result shaping --------------------------------


def _wire_node(monkeypatch, tmp_path):
    monkeypatch.setattr(render_html.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(render_html, "_render_script_path", lambda: tmp_path / "render_html_to_pdf.mjs")


def test_success_result_shape(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text("<html><body><svg><rect width='10' height='10'/></svg></body></html>")
    _wire_node(monkeypatch, tmp_path)

    captured = {}

    def _fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        # Simulate the node renderer writing the PDF.
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="[render_html_to_pdf] wrote out.pdf bytes=12")

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)
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

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)
    monkeypatch.setattr(render_html, "_inspect_pdf_layout_with_targets", lambda host_pdf, **kw: {"page_count": 1, "image_count": 0})

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

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)

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

    def _timeout(cmd):
        raise subprocess.TimeoutExpired(cmd, render_html._RENDER_TIMEOUT_SECONDS)

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _timeout)

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


def test_html_pdf_visual_evidence_requires_rendered_count_for_manifest_visuals(tmp_path):
    pdf = tmp_path / "out.pdf"
    marker_only = {
        "builder_pdf_render_result": {
            "expected_visual_count": 2,
            "found_visual_count": 2,
            "image_count": 0,
            "vector_visual_count": 0,
        }
    }
    partially_rendered = {
        "builder_pdf_render_result": {
            "expected_visual_count": 2,
            "found_visual_count": 2,
            "image_count": 0,
            "vector_visual_count": 1,
        }
    }
    fully_rendered = {
        "builder_pdf_render_result": {
            "expected_visual_count": 2,
            "found_visual_count": 2,
            "image_count": 1,
            "vector_visual_count": 1,
        }
    }

    assert _pdf_contains_visual_evidence(pdf, marker_only) is False
    assert _pdf_contains_visual_evidence(pdf, partially_rendered) is False
    assert _pdf_contains_visual_evidence(pdf, fully_rendered) is True


def test_render_html_to_pdf_reports_vector_visual_count(staged, monkeypatch, tmp_path):
    # The renderer counts visible inline <svg> figures in the source so the
    # visual gate has a vector signal even when chromium keeps SVG as vector
    # (image_count=0).
    (staged / "report.html").write_text("<html><body><figure><svg><rect width='10' height='10'/></svg></figure><figure><svg><circle cx='5' cy='5' r='4'/></svg></figure></body></html>")
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(cmd, **kwargs):
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)
    monkeypatch.setattr(render_html, "_inspect_pdf_layout_with_targets", lambda host_pdf, **kw: {"page_count": 3, "image_count": 0})
    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )
    assert result["success"] is True
    assert result["image_count"] == 0  # chromium keeps SVG vector
    assert result["vector_visual_count"] == 2  # two inline <svg> figures counted


def test_render_html_to_pdf_ignores_hidden_comment_and_sprite_svg(staged):
    (staged / "report.html").write_text(
        "<html><body>"
        "<!-- <svg><rect width='100' height='100'/></svg> -->"
        "<svg style='display:none'><rect width='100' height='100'/></svg>"
        "<div style='display:none'><svg><rect width='100' height='100'/></svg></div>"
        "<figure hidden><svg><rect width='100' height='100'/></svg></figure>"
        "<svg><defs><symbol id='icon'><path d='M0 0h1v1z'/></symbol></defs></svg>"
        "<svg aria-hidden='true'><circle cx='5' cy='5' r='4'/></svg>"
        "<figure><svg><path d='M0 0h10v10z'/></svg></figure>"
        "</body></html>"
    )

    assert render_html._count_inline_svg(staged / "report.html") == 1


def test_render_html_to_pdf_prefers_computed_svg_visibility(staged, monkeypatch, tmp_path):
    (staged / "report.html").write_text(
        "<style>.sprite{display:none}</style><svg class='sprite'><path d='M0 0h10v10z'/></svg>",
        encoding="utf-8",
    )
    _wire_node(monkeypatch, tmp_path)

    def _fake_run(cmd, **kwargs):
        (staged / "out.pdf").write_bytes(b"%PDF-1.7 fake")
        return SimpleNamespace(
            returncode=0,
            stdout="",
            stderr="[render_html_to_pdf] wrote out.pdf bytes=12 vector_visual_count=0",
        )

    monkeypatch.setattr(render_html, "_run_html_pdf_renderer_process", _fake_run)
    monkeypatch.setattr(
        render_html,
        "_inspect_pdf_layout_with_targets",
        lambda host_pdf, **kw: {"page_count": 1, "image_count": 0},
    )

    result = _call(
        runtime=_fake_runtime(),
        html_path=f"{_OUTPUTS_PREFIX}report.html",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
    )

    assert result["success"] is True
    assert result["vector_visual_count"] == 0


def test_render_html_to_pdf_counts_semi_transparent_svg_but_not_zero_opacity(staged):
    # Codex P2 (2026-06-29): a visible semi-transparent figure (opacity:0.85) must
    # count; only EXACTLY zero opacity is hidden. The prior `"opacity:0" in style`
    # substring check wrongly hid fractional opacities.
    (staged / "report.html").write_text(
        "<html><body>"
        "<figure><svg style='opacity:0.85'><path d='M0 0h10v10z'/></svg></figure>"
        "<figure><svg style='opacity:0.5'><rect width='10' height='10'/></svg></figure>"
        "<svg style='opacity:0'><circle cx='5' cy='5' r='4'/></svg>"
        "<svg style='opacity:0.0'><circle cx='5' cy='5' r='4'/></svg>"
        "</body></html>"
    )

    assert render_html._count_inline_svg(staged / "report.html") == 2


def test_render_html_to_pdf_counts_self_closing_svg_marks(staged):
    # Codex review 4601262227 worried self-closing <path/>/<circle/>/<rect/> bypass
    # the counter via handle_startendtag. Verified FALSE: HTMLParser's default
    # handle_startendtag delegates to handle_starttag, so self-closing marks (bare
    # and inside <g>) ARE counted. Lock that behavior (the counter was refactored
    # in db74b179 for hidden-container tracking).
    (staged / "report.html").write_text("<html><body><svg><path d='M0 0h10v10z'/></svg><svg><circle cx='5' cy='5' r='4'/></svg><figure><svg><g><rect width='10' height='10'/></g></svg></figure></body></html>")
    assert render_html._count_inline_svg(staged / "report.html") == 3


def test_render_html_to_pdf_ignores_svg_hidden_via_container_group(staged):
    # Codex P2 (review 4600605339): marks wrapped in a hidden SVG container group
    # (<g style="display:none"> / <g opacity="0"> / nested) must NOT count — only
    # the descendant's own attrs + the <svg> hidden flag were checked before, so a
    # hidden sprite could satisfy vector_visual_count with no visible figure.
    (staged / "report.html").write_text(
        "<html><body>"
        "<svg><g style='display:none'><path d='M0 0h10v10z'/></g></svg>"
        "<svg><g opacity='0'><rect width='10' height='10'/></g></svg>"
        "<svg><g><g style='display:none'><circle cx='5' cy='5' r='4'/></g></g></svg>"
        "<svg><a style='visibility:hidden'><path d='M0 0h4v4z'/></a></svg>"
        # The one genuinely-visible figure: a renderable <g> with real marks.
        "<figure><svg><g><path d='M0 0h10v10z'/></g></svg></figure>"
        "</body></html>"
    )

    assert render_html._count_inline_svg(staged / "report.html") == 1


def test_chromium_html_renderers_block_external_subresources():
    pdf_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs"
    png_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_png.mjs"
    for script in (pdf_script, png_script):
        source = script.read_text(encoding="utf-8")
        assert "javaScriptEnabled: false" in source
        assert 'await page.route("**/*"' in source
        assert "blockedbyclient" in source
        assert 'url.startsWith("file:")' in source
        assert "outputRootForHtml" in source
        assert "blockedSubresources" in source
        assert "blocked non-output render assets" in source


def test_html_pdf_renderer_rejects_missing_local_subresources():
    pdf_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs"
    source = pdf_script.read_text(encoding="utf-8")
    assert "missingLocalResources" in source
    assert "missing local render assets" in source
    assert "!fs.existsSync(localPath)" in source


def test_html_pdf_renderer_encodes_entry_document_file_url():
    pdf_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs"
    source = pdf_script.read_text(encoding="utf-8")

    assert "page.goto(pathToFileURL(path.resolve(args.htmlFile)).href" in source
    assert "page.goto(`file://${path.resolve(args.htmlFile)}`" not in source


def test_html_pdf_renderer_allows_only_generated_visual_images():
    pdf_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs"
    source = pdf_script.read_text(encoding="utf-8")

    assert 'resourceType !== "image"' in source
    assert 'path.join(outputRoot, "visuals")' in source
    assert 'path.join(fs.realpathSync(outputRoot), "visuals")' in source


def test_html_pdf_renderer_counts_vectors_using_print_media():
    pdf_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs"
    source = pdf_script.read_text(encoding="utf-8")

    assert 'await page.emulateMedia({ media: "print" });' in source
    assert source.index('await page.emulateMedia({ media: "print" });') < source.index("vectorVisualCount = await page.evaluate")


def test_slide_png_renderer_sets_viewport_on_browser_context():
    png_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_png.mjs"
    source = png_script.read_text(encoding="utf-8")
    assert "const context = await browser.newContext({\n      javaScriptEnabled: false,\n      viewport: { width, height },\n      deviceScaleFactor: scale," in source
    assert "const page = await context.newPage();" in source
    assert "context.newPage({\n      viewport" not in source


def test_slide_png_renderer_encodes_entry_document_file_url():
    png_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_png.mjs"
    source = png_script.read_text(encoding="utf-8")

    assert "page.goto(pathToFileURL(path.resolve(args.htmlFile)).href" in source
    assert "page.goto(`file://${path.resolve(args.htmlFile)}`" not in source


def test_slide_png_renderer_rejects_missing_images():
    png_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_png.mjs"
    source = png_script.read_text(encoding="utf-8")

    assert 'resourceType !== "image"' in source
    assert "blockedSubresources.push(`${resourceType}:${requestUrl}`)" in source
    assert 'route.abort("failed")' in source
    assert "missing local render assets" in source
    assert "fulfill({ status: 200" not in source


def test_slide_png_renderer_allows_only_generated_raster_assets():
    png_script = Path(render_html.__file__).resolve().parents[1] / "js" / "render_html_to_png.mjs"
    source = png_script.read_text(encoding="utf-8")

    assert "isAllowedRenderRequest(url, htmlFile, outputRoot, resourceType)" in source
    assert 'resourceType !== "image"' in source
    assert 'path.join(outputRoot, "assets")' in source
    assert "fs.realpathSync(assetRoot)" in source
    assert "ALLOWED_ASSET_EXTENSIONS" in source
    assert 'new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])' in source
    assert "fs.realpathSync(outputRoot));" not in source
