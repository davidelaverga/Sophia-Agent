"""Render a Markdown file to PDF via pandoc.

This tool exists to remove **code generation** from the binary-deliverable
path. Before Phase B, the builder produced PDFs by writing
``_generate_<name>.py`` (matplotlib + reportlab) and running it via bash —
a pattern that frequently failed on font / encoding / image-embedding
errors. The recovery machinery (PR #93/#94) caught those failures but
delivered only generator scripts, not real PDFs.

Phase B's pattern:
    1. Use the ``chart-visualization`` skill (Node.js + AntV) for any
       diagrams — produces PNG/SVG via a pre-tested renderer.
    2. Compose a Markdown source file with image embeds.
    3. Call this tool to convert Markdown → PDF in one step using
       pandoc. Pandoc is mature, handles unicode/fonts/images correctly,
       and has been battle-tested across millions of documents.

The model never writes PDF-generation code; we always go through this
tool. Failures are surfaced as structured errors (pandoc missing,
syntax issue, etc.) so the model can fall back to shipping the
Markdown directly when the deployment env doesn't have pandoc.

Deployment requirement:
    pandoc must be on PATH. On Debian/Ubuntu containers:
        apt-get install -y pandoc texlive-xetex
    The ``texlive-xetex`` package gives ``--pdf-engine=xelatex``, which
    handles unicode and embedded fonts cleanly. Without it, the tool
    falls back to pandoc's default engine (still works for ASCII /
    basic Latin docs).
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess  # noqa: S404 — invoking pandoc by absolute path
from pathlib import Path

from langchain_core.tools import tool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Output paths must stay under the sandbox outputs prefix so artifact
# delivery (Supabase mirror, signed-URL minting) treats them as
# user-facing deliverables. Mirrors the contract enforced in
# ``BuilderArtifactMiddleware._extract_output_relative_path``.
_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"

# Pandoc invocation timeout. Pandoc is fast on small docs (< 5s for a
# 10-page report) but xelatex compilation can be slow on first run
# (font cache warmup). 90s is generous; the per-turn timeout in
# ``SubagentExecutor`` (300s) gives further headroom.
_PANDOC_TIMEOUT_SECONDS = 90


class RenderMarkdownToPdfInput(BaseModel):
    markdown_path: str = Field(
        description=(
            "Absolute path to the Markdown source file (must exist and be readable). "
            "Prefer paths under /mnt/user-data/outputs/ for visibility in the artifact pipeline."
        ),
    )
    pdf_path: str = Field(
        description=(
            "Absolute path where the PDF should be written. MUST start with "
            "/mnt/user-data/outputs/ — files outside that prefix won't be "
            "delivered to the user. The builder should pass the same path "
            "to ``emit_builder_artifact.artifact_path`` after this tool succeeds."
        ),
    )
    pdf_engine: str | None = Field(
        default=None,
        description=(
            "Optional pandoc PDF engine override (e.g. 'xelatex', 'lualatex', "
            "'wkhtmltopdf'). Default is xelatex when available, else pandoc's "
            "auto-select. Most users should leave this unset."
        ),
    )


def _ensure_relative_to_outputs(label: str, path: str) -> str | None:
    """Return an error message if ``path`` is outside the outputs virtual root.

    Mirrors the traversal-rejection logic in
    ``BuilderArtifactMiddleware._extract_output_relative_path``. We don't
    silently rewrite the path — the model has to use the right prefix or
    the artifact won't be delivered.
    """
    if not isinstance(path, str) or not path.strip():
        return f"{label}: empty or non-string path"
    normalized = path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return (
            f"{label}: must start with {_OUTPUTS_VIRTUAL_PREFIX} "
            f"(got: {normalized!r}). Files outside that prefix won't be "
            "delivered to the user."
        )
    relative_part = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):]
    # Reject traversal attempts (parity with builder_artifact).
    if ".." in relative_part.split("/"):
        return f"{label}: path traversal ('..') is not allowed: {normalized!r}"
    return None


def _result(*, success: bool, **fields) -> str:
    """Return a JSON-serialized result message for the tool call.

    The structured shape lets BuilderArtifactMiddleware (and any future
    consumers) parse outcomes without relying on natural-language scraping
    of the model's response.
    """
    payload = {"success": success, **fields}
    return json.dumps(payload)


def _resolve_pdf_engine(explicit: str | None) -> tuple[str | None, str]:
    """Pick a PDF engine for pandoc.

    Returns (engine_name_or_None, message). When ``engine_name`` is None,
    pandoc auto-selects (works for basic ASCII content). When set to
    ``xelatex``, pandoc uses it for unicode/font handling.
    """
    if explicit:
        if shutil.which(explicit) is None:
            return None, (
                f"requested pdf_engine={explicit!r} not on PATH; falling back "
                "to pandoc's default engine"
            )
        return explicit, f"using pdf_engine={explicit}"

    # Default preference order: xelatex (best unicode), lualatex, wkhtmltopdf.
    # If none are on PATH, let pandoc auto-select (will use pdflatex if
    # installed; may fail on unicode docs without xelatex).
    for candidate in ("xelatex", "lualatex", "wkhtmltopdf"):
        if shutil.which(candidate) is not None:
            return candidate, f"auto-selected pdf_engine={candidate}"
    return None, "no preferred PDF engine on PATH; using pandoc's default"


def _impl(markdown_path: str, pdf_path: str, pdf_engine: str | None) -> str:
    """Concrete pandoc invocation. Tested independently of the @tool wrapper."""
    # ---- Path validation -----------------------------------------------
    md_check = _ensure_relative_to_outputs("markdown_path", markdown_path)
    if md_check is not None:
        # Markdown source can technically live anywhere readable, but we
        # require outputs/ for consistency with the builder workflow.
        # Loosen this if a real use case appears.
        return _result(success=False, error=md_check, error_type="invalid_input")

    pdf_check = _ensure_relative_to_outputs("pdf_path", pdf_path)
    if pdf_check is not None:
        return _result(success=False, error=pdf_check, error_type="invalid_input")

    md_file = Path(markdown_path)
    if not md_file.is_file():
        return _result(
            success=False,
            error=f"markdown source not found: {markdown_path}",
            error_type="missing_input",
        )

    # ---- Pandoc availability --------------------------------------------
    pandoc_bin = shutil.which("pandoc")
    if pandoc_bin is None:
        return _result(
            success=False,
            error=(
                "pandoc binary not found on PATH. Install with "
                "`apt-get install pandoc texlive-xetex` (Linux) or "
                "`brew install pandoc` (macOS). "
                "Fallback: ship the Markdown source directly as the "
                "artifact (set artifact_type='document', artifact_path "
                "to the .md file) and explain the limitation in "
                "companion_tone_hint."
            ),
            error_type="pandoc_missing",
        )

    engine, engine_msg = _resolve_pdf_engine(pdf_engine)
    logger.info("render_markdown_to_pdf: %s", engine_msg)

    pdf_file = Path(pdf_path)
    pdf_file.parent.mkdir(parents=True, exist_ok=True)

    # ---- Invocation -----------------------------------------------------
    cmd: list[str] = [
        pandoc_bin,
        "--standalone",  # produce a self-contained document
        "--from=markdown+smart+yaml_metadata_block",
        str(md_file),
        "-o",
        str(pdf_file),
    ]
    if engine is not None:
        cmd.append(f"--pdf-engine={engine}")

    try:
        completed = subprocess.run(  # noqa: S603 — pandoc binary path is from shutil.which
            cmd,
            capture_output=True,
            text=True,
            timeout=_PANDOC_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _result(
            success=False,
            error=(
                f"pandoc timed out after {_PANDOC_TIMEOUT_SECONDS}s. The "
                "Markdown source may be unusually large or the PDF engine "
                "is rebuilding its font cache. Retry once; if it persists, "
                "ship the Markdown source as the artifact."
            ),
            error_type="pandoc_timeout",
        )
    except OSError as exc:  # pragma: no cover — defensive
        return _result(
            success=False,
            error=f"pandoc invocation failed: {exc}",
            error_type="pandoc_oserror",
        )

    if completed.returncode != 0:
        # Pandoc errors are usually about LaTeX issues (missing
        # packages, unicode chars without xelatex, broken image paths).
        # Return stderr so the model can decide whether to retry with a
        # different engine, fix the markdown, or ship the .md.
        return _result(
            success=False,
            error=(
                f"pandoc exited with code {completed.returncode}. "
                f"stderr: {completed.stderr.strip()[:1500]}"
            ),
            error_type="pandoc_error",
            engine=engine or "default",
            command=" ".join(cmd[1:]),  # omit the binary path itself
        )

    if not pdf_file.is_file():
        return _result(
            success=False,
            error=(
                f"pandoc reported success but PDF was not written to {pdf_path}. "
                "This is unexpected; check filesystem permissions."
            ),
            error_type="pandoc_no_output",
        )

    # ---- Success --------------------------------------------------------
    try:
        size_bytes = pdf_file.stat().st_size
    except OSError:
        size_bytes = -1

    return _result(
        success=True,
        pdf_path=str(pdf_file),
        size_bytes=size_bytes,
        engine=engine or "default",
        engine_message=engine_msg,
    )


@tool(args_schema=RenderMarkdownToPdfInput)
def render_markdown_to_pdf(markdown_path: str, pdf_path: str, pdf_engine: str | None = None) -> str:
    """Convert a Markdown file to a PDF using pandoc.

    Use this for any PDF deliverable. Compose your Markdown source first
    (writing it via write_file_tool) — including image embeds for charts
    you generated with the chart-visualization skill — then call this
    tool to produce the PDF. Both paths must be under
    ``/mnt/user-data/outputs/``.

    DO NOT write your own ``_generate_*.py`` script using matplotlib or
    reportlab to produce a PDF. That pattern is unreliable. This tool
    encapsulates a known-working pipeline.

    On success, returns a JSON object with ``success: true`` and the
    PDF path. After success, call emit_builder_artifact with
    ``artifact_path`` set to the PDF path.

    On failure, returns ``success: false`` with a descriptive error
    type (``pandoc_missing``, ``pandoc_error``, ``pandoc_timeout``,
    ``invalid_input``, ``missing_input``). For pandoc_missing, fall
    back to shipping the Markdown source directly as the artifact
    (``artifact_type='document'``, ``artifact_path`` to the .md file)
    with confidence<=0.5 and explain the limitation in
    ``companion_tone_hint``.
    """
    return _impl(markdown_path=markdown_path, pdf_path=pdf_path, pdf_engine=pdf_engine)
