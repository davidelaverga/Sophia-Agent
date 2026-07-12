"""Tests for the ``render_markdown_to_pdf`` builder tool.

The tool wraps a pandoc subprocess to convert Markdown to PDF. Pandoc
is mature and battle-tested; the tool's job is input validation, error
shaping, and falling back gracefully when pandoc isn't available.

These tests cover:

- Input validation (paths must be under /mnt/user-data/outputs/, no
  traversal, source file must exist).
- Pandoc-missing handling: returns a structured error so the model can
  fall back to shipping the Markdown source.
- Pandoc subprocess invocation: correct command shape, engine
  resolution, return-code handling, timeout handling, output-missing
  detection.
- Successful path returns ``success=true`` with the written PDF path
  and size.

Pandoc is not installed in our local dev environment, so subprocess
behavior is mocked. The tests still exercise the full validation +
result-shaping logic.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

# Use the underlying ``_impl`` rather than the ``@tool``-wrapped variant.
# The wrapper's args_schema validation is exercised by langchain itself;
# our tests focus on the behavior of the implementation.
import deerflow.sophia.tools.render_markdown_to_pdf as render_pdf
from deerflow.sophia.tools.render_markdown_to_pdf import _impl

_OUTPUTS_PREFIX = "/mnt/user-data/outputs/"


def _parse(result: str) -> dict:
    """Parse the JSON string the tool returns."""
    parsed = json.loads(result)
    assert isinstance(parsed, dict)
    return parsed


def _stage_md(tmp_outputs: Path, name: str = "report.md", content: str = "# Hello\n") -> Path:
    """Write a markdown file under the staged outputs dir and return its virtual path."""
    md_real = tmp_outputs / name
    md_real.write_text(content)
    return md_real


# ---- Input validation ------------------------------------------------------


def test_rejects_markdown_path_outside_outputs(tmp_path):
    out = tmp_path / "outputs"
    out.mkdir()
    md = tmp_path / "scratch" / "report.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("# Hi")

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert "must start with" in result["error"]


def test_rejects_pdf_path_outside_outputs(tmp_path):
    out = tmp_path / "outputs"
    out.mkdir()
    _stage_md(out)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        # PDF path is outside outputs prefix.
        pdf_path=str(tmp_path / "elsewhere.pdf"),
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert "pdf_path" in result["error"]


def test_rejects_traversal_in_pdf_path():
    """Parity with builder_artifact's traversal guard."""
    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}../../etc/passwd.pdf",
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert "traversal" in result["error"]


def test_rejects_traversal_in_markdown_path():
    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}../sensitive.md",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"
    assert "traversal" in result["error"]


def test_rejects_empty_path():
    result = _parse(_impl(
        markdown_path="",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "invalid_input"


# ---- Source file existence -------------------------------------------------


def test_rejects_missing_markdown_source():
    """Even a well-formed virtual path must point to an actual file."""
    # Note: _impl resolves the virtual path as if it were a real path on
    # disk — for this test we just need the file to NOT exist.
    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}does-not-exist.md",
        pdf_path=f"{_OUTPUTS_PREFIX}out.pdf",
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "missing_input"
    assert "not found" in result["error"]


# ---- Pandoc availability ---------------------------------------------------


def test_returns_pandoc_missing_error_when_binary_absent(tmp_path, monkeypatch):
    """When pandoc isn't on PATH the tool returns a structured error
    that instructs the model to fall back to shipping the Markdown."""
    # Use real paths for the markdown file (under tmp_path) but pretend
    # the virtual prefix maps to it. Simplest: stage the markdown file
    # at an absolute path that satisfies the prefix check.
    virtual_md = tmp_path / "mnt" / "user-data" / "outputs" / "report.md"
    virtual_md.parent.mkdir(parents=True, exist_ok=True)
    virtual_md.write_text("# Hello\n")

    # The path validator only checks that the path starts with the
    # virtual prefix. The file existence check uses Path(...).is_file()
    # which respects the actual filesystem path. We pass paths that
    # look like virtual paths but resolve to our tmp staging.
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda _bin: None,
    )

    # We need _impl to find the file. Hack: monkeypatch Path.is_file to
    # read from our tmp_path mirror. Cleaner: patch the prefix constant
    # to point at our tmp dir.
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf._OUTPUTS_VIRTUAL_PREFIX",
        str(tmp_path / "mnt" / "user-data" / "outputs") + "/",
    )

    result = _parse(_impl(
        markdown_path=str(virtual_md),
        pdf_path=str(tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"),
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "pandoc_missing"
    # Error message must direct the model toward the Markdown fallback.
    assert "ship the Markdown source" in result["error"].lower() or "ship the markdown" in result["error"].lower()


# ---- Pandoc subprocess invocation -----------------------------------------


def _stage_for_subprocess_test(tmp_path, monkeypatch):
    """Common setup: stage a markdown file and remap the virtual prefix."""
    virtual_md = tmp_path / "mnt" / "user-data" / "outputs" / "report.md"
    virtual_md.parent.mkdir(parents=True, exist_ok=True)
    virtual_md.write_text("# Hermes Memory\n")

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf._OUTPUTS_VIRTUAL_PREFIX",
        str(tmp_path / "mnt" / "user-data" / "outputs") + "/",
    )
    return virtual_md


def test_invokes_pandoc_with_correct_command_shape(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    # Pretend pandoc + xelatex are available.
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        # Simulate pandoc writing the PDF.
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["pdf_path"] == str(pdf_path)
    assert result["size_bytes"] > 0

    # Command structure assertions.
    cmd = captured["cmd"]
    assert cmd[0] == "/fake/pandoc"
    assert "--standalone" in cmd
    assert "--from=markdown+smart+yaml_metadata_block" in cmd
    assert str(md) in cmd
    assert "-o" in cmd
    assert str(pdf_path) in cmd
    # Engine auto-selected to xelatex (first preference on PATH).
    assert "--pdf-engine=xelatex" in cmd
    # Subprocess invariants.
    assert captured["kwargs"]["timeout"] > 0
    assert captured["kwargs"]["check"] is False


def test_resolves_virtual_output_paths_with_thread_data(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    outputs.mkdir(parents=True)
    (outputs / "report.md").write_text("# Report\n")
    virtual_md = f"{_OUTPUTS_PREFIX}report.md"
    virtual_pdf = f"{_OUTPUTS_PREFIX}report.pdf"
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=virtual_md,
        pdf_path=virtual_pdf,
        pdf_engine=None,
        thread_data=thread_data,
    ))

    assert result["success"] is True
    assert result["pdf_path"] == virtual_pdf
    assert str(outputs / "report.md") in captured["cmd"]
    assert str(outputs / "report.pdf") in captured["cmd"]
    assert (outputs / "report.pdf").is_file()


def test_rewrites_virtual_image_refs_before_pandoc(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    (visuals / "chart.png").write_bytes(b"png-bytes")
    (outputs / "report.md").write_text(
        "# Report\n\n![Chart](/mnt/user-data/outputs/visuals/chart.png)\n",
        encoding="utf-8",
    )
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    monkeypatch.setattr(
        render_pdf,
        "_inspect_pdf_layout",
        lambda _path: {
            "page_count": 2,
            "blank_page_count": 0,
            "short_page_count": 0,
            "image_count": 1,
            "layout_quality": "ok",
            "layout_warning": None,
        },
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}report.pdf",
        pdf_engine=None,
        thread_data=thread_data,
    ))

    source_arg = next(Path(arg) for arg in captured["cmd"] if str(arg).endswith(".pandoc.md"))
    assert source_arg.name == ".report.pandoc.md"
    assert f"{outputs.resolve().as_posix()}/visuals/chart.png" in source_arg.read_text(encoding="utf-8")
    assert result["success"] is True
    assert result["image_count"] == 1


def test_success_payload_includes_pdf_layout_metrics(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(cmd, **kwargs):
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)
    monkeypatch.setattr(
        render_pdf,
        "_inspect_pdf_layout",
        lambda _path: {
            "page_count": 12,
            "blank_page_count": 0,
            "short_page_count": 1,
            "image_count": 0,
            "layout_quality": "ok",
            "layout_warning": None,
        },
    )

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["page_count"] == 12
    assert result["blank_page_count"] == 0
    assert result["short_page_count"] == 1
    assert result["layout_quality"] == "ok"


def test_pdf_layout_inspection_flags_sparse_long_documents(tmp_path, monkeypatch):
    pdf_path = tmp_path / "sparse.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    class _Page:
        def __init__(self, text: str):
            self._text = text

        def extract_text(self):
            return self._text

    class _Reader:
        def __init__(self, _path: str):
            self.pages = [
                _Page("normal " * 120),
                _Page("2 / 18"),
                *[_Page("short " * 20) for _ in range(16)],
            ]

    monkeypatch.setattr(render_pdf, "PdfReader", _Reader)

    result = render_pdf._inspect_pdf_layout(pdf_path)

    assert result["page_count"] == 18
    assert result["blank_page_count"] == 1
    assert result["short_page_count"] == 16
    assert result["layout_quality"] == "warning"
    assert result["layout_warning"] == "blank_pages_detected"


def test_pdf_layout_inspection_flags_sparse_long_pdf_without_blank_pages(tmp_path, monkeypatch):
    pdf_path = tmp_path / "thin.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    class _Page:
        def __init__(self, text: str):
            self._text = text

        def extract_text(self):
            return self._text

    class _Reader:
        def __init__(self, _path: str):
            self.pages = [_Page("short " * 20) for _ in range(16)]

    monkeypatch.setattr(render_pdf, "PdfReader", _Reader)

    result = render_pdf._inspect_pdf_layout(pdf_path)

    assert result["page_count"] == 16
    assert result["blank_page_count"] == 0
    assert result["short_page_count"] == 16
    assert result["layout_quality"] == "warning"
    assert result["layout_warning"] == "sparse_long_pdf"


def test_explicit_pdf_engine_overrides_default(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    captured: dict = {}

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = cmd
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _C:
            returncode = 0
            stderr = ""
            stdout = ""

        return _C()

    monkeypatch.setattr("subprocess.run", fake_run)

    _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine="lualatex",
    ))

    assert "--pdf-engine=lualatex" in captured["cmd"]


def test_pandoc_nonzero_returncode_returns_structured_error(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(*_args, **_kwargs):
        class _C:
            returncode = 43
            stderr = "! Undefined control sequence.\n! \\fakecommand"
            stdout = ""

        return _C()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "pandoc_error"
    assert "exited with code 43" in result["error"]
    assert "Undefined control sequence" in result["error"]


def test_pandoc_timeout_returns_structured_error(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="pandoc", timeout=90)

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "pandoc_timeout"


def test_pandoc_success_but_no_output_file_returns_error(tmp_path, monkeypatch):
    """Defensive: pandoc shouldn't lie about success, but if it does, we catch it."""
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(*_args, **_kwargs):
        class _C:
            returncode = 0
            stderr = ""
            stdout = ""

        return _C()  # PDF NOT written

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is False
    assert result["error_type"] == "pandoc_no_output"


def test_engine_falls_back_to_default_when_no_engine_on_path(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    # Only pandoc itself is on PATH; no LaTeX engines.
    def _which(binary):
        return "/fake/pandoc" if binary == "pandoc" else None

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        _which,
    )

    captured: dict = {}

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = cmd
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _C:
            returncode = 0
            stderr = ""
            stdout = ""

        return _C()

    monkeypatch.setattr("subprocess.run", fake_run)

    _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    # No --pdf-engine flag when none of the preferred engines are on PATH.
    assert not any(arg.startswith("--pdf-engine=") for arg in captured["cmd"])


def test_explicit_engine_falls_back_when_not_on_path(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    def _which(binary):
        # Only pandoc itself; the user asked for "wkhtmltopdf" which
        # isn't on PATH.
        return "/fake/pandoc" if binary == "pandoc" else None

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        _which,
    )

    captured: dict = {}

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = cmd
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _C:
            returncode = 0
            stderr = ""
            stdout = ""

        return _C()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine="wkhtmltopdf",
    ))

    # Returns success — engine just falls back, doesn't error.
    assert result["success"] is True
    # No --pdf-engine flag because the requested engine wasn't on PATH
    # and no fallback engine was either.
    assert not any(arg.startswith("--pdf-engine=") for arg in captured["cmd"])


def test_creates_pdf_parent_directory_if_missing(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    # Nested output path that doesn't exist yet.
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "subdir" / "report.pdf"
    assert not pdf_path.parent.exists()

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(*_args, **_kwargs):
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _C:
            returncode = 0
            stderr = ""
            stdout = ""

        return _C()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    # mkdir(parents=True) ran before pandoc invocation.
    assert pdf_path.parent.exists()


# ---- Image-embedding regression (prod 2026-06-10: text-only PDFs) ----------
#
# Pandoc resolves relative image refs against its resource path / cwd, NOT
# the input file's directory. The pdf workflow card prescribes
# ``![Diagram](visuals/diagram.png)``, so without cwd + --resource-path the
# image silently drops (pandoc warns on stderr but exits 0) and the PDF
# ships text-only with image_count=0.


def test_pandoc_runs_with_source_cwd_and_resource_path(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    outputs.mkdir(parents=True)
    (outputs / "report.md").write_text("![Chart](visuals/chart.png)\n")
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}report.pdf",
        pdf_engine=None,
        thread_data=thread_data,
    ))

    assert result["success"] is True
    # cwd anchored at the markdown source dir so relative refs resolve.
    assert captured["kwargs"]["cwd"] == str(outputs.resolve())
    # --resource-path covers the source dir (single entry when it IS the
    # outputs root).
    resource_args = [arg for arg in captured["cmd"] if arg.startswith("--resource-path=")]
    assert len(resource_args) == 1
    assert str(outputs.resolve()) in resource_args[0]


def test_success_flags_images_missing_when_source_refs_dropped(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    md.write_text("# Doc\n\n![Chart](visuals/chart.png)\n\n<img src=\"visuals/two.png\">\n")
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(cmd, **kwargs):
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = (
                "[WARNING] Could not fetch resource visuals/chart.png\n"
                "[WARNING] Could not fetch resource visuals/two.png\n"
            )
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)
    monkeypatch.setattr(
        render_pdf,
        "_inspect_pdf_layout",
        lambda _path: {
            "page_count": 4,
            "blank_page_count": 0,
            "short_page_count": 0,
            "image_count": 0,
            "layout_quality": "ok",
            "layout_warning": None,
        },
    )

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["source_image_ref_count"] == 2
    assert result["images_missing"] is True
    assert "images_missing_hint" in result
    assert result["missing_resources"] == [
        "visuals/chart.png",
        "visuals/two.png",
    ]


def test_success_does_not_flag_images_when_embedded(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    md.write_text("# Doc\n\n![Chart](visuals/chart.png)\n")
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    def fake_run(cmd, **kwargs):
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)
    monkeypatch.setattr(
        render_pdf,
        "_inspect_pdf_layout",
        lambda _path: {
            "page_count": 4,
            "blank_page_count": 0,
            "short_page_count": 0,
            "image_count": 1,
            "layout_quality": "ok",
            "layout_warning": None,
        },
    )

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["source_image_ref_count"] == 1
    assert result["images_missing"] is False
    assert "images_missing_hint" not in result
    assert "missing_resources" not in result


# ---- Vendored template + themes (PR: builder PDF visual quality) -----------
#
# The tool ships a vendored pandoc LaTeX template
# (deerflow/sophia/assets/sophia.latex) plus three named themes. The
# template is applied on the FIRST pandoc attempt; if that attempt fails,
# the tool retries ONCE with today's exact plain command (no template, no
# vars, no toc) so a template bug can never make PDF rendering worse than
# the pre-template baseline.


def _fake_run_writing_pdf(pdf_path: Path, captured_cmds: list):
    """Build a fake subprocess.run that records each cmd and writes the PDF."""

    def fake_run(cmd, **kwargs):
        captured_cmds.append(list(cmd))
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    return fake_run


def test_template_asset_exists_and_keeps_stock_blocks():
    """The vendored template must exist and keep the load-bearing pandoc
    blocks (highlighting, tables, fontspec branch) while staying inside
    the container's texlive package whitelist (no tikz/tcolorbox)."""
    template = render_pdf._resolve_pdf_template()
    assert template is not None
    assert template.name == "sophia.latex"
    text = template.read_text(encoding="utf-8")
    # Stock pandoc blocks preserved.
    assert "$highlighting-macros$" in text
    assert "longtable" in text
    assert "booktabs" in text
    assert "\\setmainfont" in text
    assert "hyperref" in text
    # Sophia customizations, all guarded.
    assert "$if(titlepage)$" in text
    assert "$if(accentcolor)$" in text
    assert "$if(headingcolor)$" in text
    assert "$if(titlepagecolor)$" in text
    assert "$if(titlepagetextcolor)$" in text
    assert "fancyhdr" in text
    assert "titlesec" in text
    assert "\\nopagecolor" in text
    # Artifact Visual System Phase 3b: tcolorbox (statbox callout) is now an
    # intentional, \\IfFileExists-guarded part of the brand template — it
    # ships with texlive-latex-extra (in the image). tikz/fontawesome/
    # sourcesanspro remain off the whitelist.
    assert "tcolorbox" in text
    assert "statbox" in text
    assert "tikz" not in text
    assert "fontawesome" not in text
    assert "sourcesanspro" not in text


def test_template_and_default_theme_vars_present(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["template_used"] is True
    assert result["template_fallback"] is False
    assert result["theme"] == "minimal"

    assert len(calls) == 1
    cmd = calls[0]
    template_args = [arg for arg in cmd if arg.startswith("--template=")]
    assert len(template_args) == 1
    assert template_args[0].endswith("sophia.latex")
    # Default theme is minimal.
    assert "-V" in cmd
    assert "accentcolor=2E5AAC" in cmd
    assert "headingcolor=1F2A37" in cmd
    assert "titlepagecolor=F5F7FA" in cmd
    assert "titlepagetextcolor=1F2A37" in cmd
    assert "mainfont=TeX Gyre Pagella" in cmd
    assert "sansfont=TeX Gyre Heros" in cmd
    # No frontmatter → defaults injected, but NO cover page without a title.
    assert "author=Sophia" in cmd
    assert any(arg.startswith("date=") for arg in cmd)
    assert "titlepage=true" not in cmd


def test_explicit_theme_param_overrides_frontmatter_theme(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    md.write_text("---\ntitle: Q3 Board Pack\nsophia-theme: warm\n---\n\n# Summary\n")
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
        theme="boardroom",
    ))

    assert result["success"] is True
    assert result["theme"] == "boardroom"
    cmd = calls[0]
    assert "accentcolor=2E5AAC" in cmd
    assert "headingcolor=1F2A37" in cmd
    assert "mainfont=TeX Gyre Pagella" in cmd
    assert "sansfont=TeX Gyre Heros" in cmd
    # Frontmatter theme (warm) must NOT leak through.
    assert "accentcolor=2A9D8F" not in cmd
    # Title present in frontmatter → cover page requested.
    assert "titlepage=true" in cmd


def test_frontmatter_theme_selected_when_param_absent(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    md.write_text("---\nsophia-theme: warm\n---\n\n# Doc\n")
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["theme"] == "warm"
    cmd = calls[0]
    assert "accentcolor=2A9D8F" in cmd
    assert "mainfont=TeX Gyre Pagella" in cmd


def test_frontmatter_author_and_date_suppress_default_vars(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    md.write_text("---\ntitle: Notes\nauthor: Davide\ndate: 2026-06-01\n---\n\n# Doc\n")
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    cmd = calls[0]
    # Frontmatter wins — the tool must not inject competing -V values.
    assert "author=Sophia" not in cmd
    assert not any(arg.startswith("date=") for arg in cmd)
    assert "titlepage=true" in cmd


def test_toc_added_only_for_long_documents(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )

    # Long document (> 3500 words) → automatic TOC.
    md.write_text("# Long Doc\n\n" + ("lorem ipsum dolor sit amet " * 720))
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))
    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))
    assert result["success"] is True
    assert "--toc" in calls[0]
    assert "--toc-depth=2" in calls[0]

    # Short document → no TOC flags.
    md.write_text("# Short Doc\n\nJust a couple of words.\n")
    calls.clear()
    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))
    assert result["success"] is True
    assert "--toc" not in calls[0]
    assert "--toc-depth=2" not in calls[0]


def test_template_failure_retries_once_without_template(tmp_path, monkeypatch):
    """A template-induced LaTeX failure must degrade to today's exact plain
    command — template bugs can never make rendering worse than baseline."""
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        if len(calls) == 1:
            class _Fail:
                returncode = 1
                stderr = "! LaTeX Error: something template-shaped."
                stdout = ""

            return _Fail()
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake")

        class _Ok:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Ok()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert len(calls) == 2
    assert any(arg.startswith("--template=") for arg in calls[0])
    # Retry is the plain pre-template command: no template, no vars, no toc.
    assert not any(arg.startswith("--template=") for arg in calls[1])
    assert "-V" not in calls[1]
    assert "--toc" not in calls[1]
    assert result["success"] is True
    assert result["template_used"] is False
    assert result["template_fallback"] is True
    assert result["theme"] is None


def test_missing_template_renders_once_without_template(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    monkeypatch.setattr(render_pdf, "_resolve_pdf_template", lambda: None)
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["template_used"] is False
    assert result["template_fallback"] is False
    assert result["theme"] is None
    assert len(calls) == 1
    assert not any(arg.startswith("--template=") for arg in calls[0])
    assert "-V" not in calls[0]


def test_unknown_theme_falls_back_to_default(tmp_path, monkeypatch):
    md = _stage_for_subprocess_test(tmp_path, monkeypatch)
    pdf_path = tmp_path / "mnt" / "user-data" / "outputs" / "out.pdf"

    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("subprocess.run", _fake_run_writing_pdf(pdf_path, calls))

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(pdf_path),
        pdf_engine=None,
        theme="vaporwave",
    ))

    # Never errors — silently styled with the default theme.
    assert result["success"] is True
    assert result["theme"] == "minimal"
    assert "accentcolor=2E5AAC" in calls[0]


@pytest.mark.skipif(
    shutil.which("pandoc") is None or shutil.which("xelatex") is None,
    reason="pandoc/xelatex not installed",
)
def test_integration_renders_themed_pdf_end_to_end(tmp_path, monkeypatch):
    """Real pandoc + xelatex smoke: a two-heading themed document renders
    through the vendored template without falling back."""
    outputs = tmp_path / "mnt" / "user-data" / "outputs"
    outputs.mkdir(parents=True)
    md = outputs / "themed.md"
    md.write_text(
        "---\n"
        "title: Quarterly Review\n"
        "subtitle: Sophia render smoke\n"
        "sophia-theme: boardroom\n"
        "---\n\n"
        "# Summary\n\nBody text with **bold** and a list:\n\n- one\n- two\n\n"
        "# Details\n\nMore text under the second heading.\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf._OUTPUTS_VIRTUAL_PREFIX",
        str(outputs) + "/",
    )

    result = _parse(_impl(
        markdown_path=str(md),
        pdf_path=str(outputs / "themed.pdf"),
        pdf_engine=None,
    ))

    assert result["success"] is True
    assert result["template_used"] is True
    assert result["template_fallback"] is False
    assert result["theme"] == "boardroom"
    assert (outputs / "themed.pdf").stat().st_size > 0


# ---- Template parse guard (prod 2026-06-11: rc=5 from a $if$ token in a
# header COMMENT — pandoc's template engine reads every $ in the file,
# LaTeX comments included) -----------------------------------------------


def _template_path() -> Path:
    return Path(render_pdf.__file__).resolve().parent.parent / "assets" / "sophia.latex"


def test_template_has_no_bare_dollar_directives():
    """The exact prod bug class: `$if$` (no parens) anywhere — including
    comments — is a doctemplates parse error."""
    text = _template_path().read_text(encoding="utf-8")
    import re as _re

    # Only $if$/$for$ REQUIRE parentheses in doctemplates; $endif$/$else$/
    # $endfor$/$sep$ are legal bare closers.
    bare = _re.findall(r"\$(?:if|for)\$", text)
    assert bare == [], f"bare template directives found (parse error in pandoc): {bare}"


@pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")
def test_template_parses_with_real_pandoc(tmp_path):
    """Full doctemplates parse via whatever pandoc is on PATH (CI installs
    pandoc; the container smoke validates the exact 2.17 version)."""
    md = tmp_path / "t.md"
    md.write_text("# Title\n\nbody\n")
    out = tmp_path / "t.tex"
    for vars_ in (
        [],
        ["-V", "titlepage=true", "-V", "accentcolor=1F6FB2", "-V", "coverimage=/tmp/x.png"],
        ["--toc", "--toc-depth=2"],
    ):
        completed = subprocess.run(
            ["pandoc", "--standalone", str(md), "-o", str(out), f"--template={_template_path()}", *vars_],
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0, f"template failed with {vars_}: {completed.stderr[:400]}"


# ---- VQ-5 cover image plumbing ----------------------------------------------


def test_cover_image_variable_passed_when_cover_exists(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    (outputs / "report.md").write_text(
        "---\n"
        "title: Report\n"
        "sophia-cover: /mnt/user-data/outputs/visuals/cover-launch.png\n"
        "---\n\n"
        "# Report\n"
    )
    (visuals / "cover-launch.png").write_bytes(b"\x89PNG fake")
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}report.pdf",
        pdf_engine=None,
        thread_data=thread_data,
    ))

    assert result["success"] is True
    joined = " ".join(captured["cmd"])
    assert "coverimage=" in joined and "cover-launch.png" in joined
    assert "titlepage=true" in joined


def test_stale_cover_image_is_not_reused_without_source_tie(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    (outputs / "report.md").write_text("---\ntitle: Report\n---\n\n# Report\n")
    (visuals / "cover-previous-report.png").write_bytes(b"\x89PNG stale")
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}report.pdf",
        pdf_engine=None,
        thread_data=thread_data,
    ))

    assert result["success"] is True
    assert "coverimage=" not in " ".join(captured["cmd"])


def test_no_cover_variable_without_cover_file(tmp_path, monkeypatch):
    outputs = tmp_path / "thread" / "outputs"
    outputs.mkdir(parents=True)
    (outputs / "report.md").write_text("# Report\n")
    thread_data = {
        "workspace_path": str(tmp_path / "thread" / "workspace"),
        "uploads_path": str(tmp_path / "thread" / "uploads"),
        "outputs_path": str(outputs),
    }
    monkeypatch.setattr(
        "deerflow.sophia.tools.render_markdown_to_pdf.shutil.which",
        lambda binary: f"/fake/{binary}",
    )
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4 fake")

        class _Completed:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Completed()

    monkeypatch.setattr("subprocess.run", fake_run)

    result = _parse(_impl(
        markdown_path=f"{_OUTPUTS_PREFIX}report.md",
        pdf_path=f"{_OUTPUTS_PREFIX}report.pdf",
        pdf_engine=None,
        thread_data=thread_data,
    ))

    assert result["success"] is True
    assert "coverimage=" not in " ".join(captured["cmd"])
