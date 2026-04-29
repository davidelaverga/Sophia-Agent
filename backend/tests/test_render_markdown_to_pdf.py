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
import subprocess
from pathlib import Path

# Use the underlying ``_impl`` rather than the ``@tool``-wrapped variant.
# The wrapper's args_schema validation is exercised by langchain itself;
# our tests focus on the behavior of the implementation.
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
