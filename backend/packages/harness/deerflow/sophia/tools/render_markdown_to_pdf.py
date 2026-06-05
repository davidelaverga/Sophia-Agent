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
from typing import Any

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data, mask_local_paths_in_output, replace_virtual_path

try:  # pragma: no cover - import availability varies by runtime image
    from pypdf import PdfReader
except Exception:  # noqa: BLE001
    PdfReader = None  # type: ignore[assignment]

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
_SHORT_PAGE_WORD_THRESHOLD = 80
_DEFAULT_MAX_PAGES = 15


def _ensure_relative_to_outputs(label: str, path: str) -> str | None:
    """Return an error message if ``path`` is outside the outputs virtual root.

    Mirrors the traversal-rejection logic in
    ``BuilderArtifactMiddleware._extract_output_relative_path``. We don't
    silently rewrite the path — the model has to use the right prefix or
    the artifact won't be delivered.
    """
    if not isinstance(path, str) or not path.strip():
        return f"{label}: empty or non-string path"
    normalized = path.strip().replace("\\", "/")
    outputs_prefix = _OUTPUTS_VIRTUAL_PREFIX.replace("\\", "/")
    if not outputs_prefix.endswith("/"):
        outputs_prefix += "/"
    if not normalized.startswith(outputs_prefix):
        return (
            f"{label}: must start with {_OUTPUTS_VIRTUAL_PREFIX} "
            f"(got: {path.strip()!r}). Files outside that prefix won't be "
            "delivered to the user."
        )
    relative_part = normalized[len(outputs_prefix):]
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


def _host_path_for_virtual_output(path: str, thread_data: dict[str, Any] | None) -> Path:
    if thread_data is None:
        return Path(path)
    return Path(replace_virtual_path(path, thread_data))


def _mask_local_output(text: str, thread_data: dict[str, Any] | None) -> str:
    return mask_local_paths_in_output(text, thread_data) if thread_data is not None else text


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


def _page_word_count(page: Any) -> int:
    text = page.extract_text() or ""
    return len([word for word in text.split() if word.strip()])


def _layout_quality(page_count: int, blank_count: int, short_count: int) -> tuple[str, str | None]:
    if page_count <= 0:
        return "unknown", "pdf_layout_unreadable"
    if blank_count >= page_count:
        return "unusable", "all_pages_blank"
    if blank_count > 0:
        return "warning", "blank_pages_detected"
    if page_count > _DEFAULT_MAX_PAGES and short_count > 0:
        return "warning", "sparse_long_pdf"
    return "ok", None


def _inspect_pdf_layout(pdf_file: Path) -> dict[str, int | str | None]:
    if PdfReader is None:
        return {
            "page_count": 0,
            "blank_page_count": 0,
            "short_page_count": 0,
            "layout_quality": "unknown",
            "layout_warning": "pypdf_unavailable",
        }
    try:
        reader = PdfReader(str(pdf_file))
        counts = [_page_word_count(page) for page in reader.pages]
    except Exception:  # noqa: BLE001
        logger.warning("render_markdown_to_pdf: layout_inspection_failed", exc_info=True)
        return {
            "page_count": 0,
            "blank_page_count": 0,
            "short_page_count": 0,
            "layout_quality": "unknown",
            "layout_warning": "pdf_layout_unreadable",
        }
    page_count = len(counts)
    blank_count = sum(1 for count in counts if count <= 1)
    short_count = sum(1 for count in counts if 1 < count < _SHORT_PAGE_WORD_THRESHOLD)
    quality, warning = _layout_quality(page_count, blank_count, short_count)
    return {
        "page_count": page_count,
        "blank_page_count": blank_count,
        "short_page_count": short_count,
        "layout_quality": quality,
        "layout_warning": warning,
    }


def _path_validation_error(markdown_path: str, pdf_path: str) -> str | None:
    md_check = _ensure_relative_to_outputs("markdown_path", markdown_path)
    if md_check is not None:
        return md_check
    return _ensure_relative_to_outputs("pdf_path", pdf_path)


def _missing_markdown_result(markdown_path: str) -> str:
    return _result(
        success=False,
        error=f"markdown source not found: {markdown_path}",
        error_type="missing_input",
    )


def _pandoc_missing_result() -> str:
    logger.warning(
        "render_markdown_to_pdf: capability_check pandoc_available=false "
        "xelatex_available=%s lualatex_available=%s wkhtmltopdf_available=%s "
        "error_type=pandoc_missing",
        shutil.which("xelatex") is not None,
        shutil.which("lualatex") is not None,
        shutil.which("wkhtmltopdf") is not None,
    )
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


def _log_pandoc_capability(engine: str | None, engine_msg: str) -> None:
    logger.info(
        "render_markdown_to_pdf: capability_check pandoc_available=true "
        "xelatex_available=%s lualatex_available=%s wkhtmltopdf_available=%s "
        "selected_engine=%s message=%s",
        shutil.which("xelatex") is not None,
        shutil.which("lualatex") is not None,
        shutil.which("wkhtmltopdf") is not None,
        engine or "pandoc_default",
        engine_msg,
    )


def _pandoc_command(
    *,
    pandoc_bin: str,
    markdown_path: str,
    pdf_path: str,
    md_file: Path,
    pdf_file: Path,
    engine: str | None,
) -> tuple[list[str], list[str]]:
    cmd = [
        pandoc_bin,
        "--standalone",
        "--from=markdown+smart+yaml_metadata_block",
        str(md_file),
        "-o",
        str(pdf_file),
    ]
    public_cmd = [
        "--standalone",
        "--from=markdown+smart+yaml_metadata_block",
        markdown_path,
        "-o",
        pdf_path,
    ]
    if engine is not None:
        cmd.append(f"--pdf-engine={engine}")
        public_cmd.append(f"--pdf-engine={engine}")
    return cmd, public_cmd


def _run_pandoc(cmd: list[str]) -> subprocess.CompletedProcess[str] | str:
    try:
        return subprocess.run(  # noqa: S603 — pandoc binary path is from shutil.which
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


def _pandoc_error_result(
    *,
    completed: subprocess.CompletedProcess[str],
    engine: str | None,
    public_cmd: list[str],
    thread_data: dict[str, Any] | None,
) -> str:
    logger.warning(
        "render_markdown_to_pdf: render_failed error_type=pandoc_error "
        "selected_engine=%s returncode=%s",
        engine or "pandoc_default",
        completed.returncode,
    )
    return _result(
        success=False,
        error=(
            f"pandoc exited with code {completed.returncode}. "
            f"stderr: {_mask_local_output(completed.stderr.strip(), thread_data)[:1500]}"
        ),
        error_type="pandoc_error",
        engine=engine or "default",
        command=" ".join(public_cmd),
    )


def _pandoc_no_output_result(pdf_path: str) -> str:
    return _result(
        success=False,
        error=(
            f"pandoc reported success but PDF was not written to {pdf_path}. "
            "This is unexpected; check filesystem permissions."
        ),
        error_type="pandoc_no_output",
    )


def _pdf_size(pdf_file: Path) -> int:
    try:
        return pdf_file.stat().st_size
    except OSError:
        return -1


def _pdf_success_result(
    *,
    pdf_path: str,
    pdf_file: Path,
    engine: str | None,
    engine_msg: str,
) -> str:
    size_bytes = _pdf_size(pdf_file)
    layout = _inspect_pdf_layout(pdf_file)
    logger.info(
        "render_markdown_to_pdf: render_success selected_engine=%s "
        "final_artifact_ext=%s size_bytes=%s page_count=%s "
        "blank_page_count=%s short_page_count=%s layout_quality=%s "
        "layout_warning=%s",
        engine or "pandoc_default",
        pdf_file.suffix.lower().lstrip(".") or "unknown",
        size_bytes,
        layout.get("page_count"),
        layout.get("blank_page_count"),
        layout.get("short_page_count"),
        layout.get("layout_quality"),
        layout.get("layout_warning"),
    )
    return _result(
        success=True,
        pdf_path=pdf_path,
        size_bytes=size_bytes,
        engine=engine or "default",
        engine_message=engine_msg,
        **layout,
    )


def _impl(
    markdown_path: str,
    pdf_path: str,
    pdf_engine: str | None,
    thread_data: dict[str, Any] | None = None,
) -> str:
    """Concrete pandoc invocation. Tested independently of the @tool wrapper."""
    # ---- Path validation -----------------------------------------------
    path_error = _path_validation_error(markdown_path, pdf_path)
    if path_error is not None:
        return _result(success=False, error=path_error, error_type="invalid_input")

    md_file = _host_path_for_virtual_output(markdown_path, thread_data)
    if not md_file.is_file():
        return _missing_markdown_result(markdown_path)

    # ---- Pandoc availability --------------------------------------------
    pandoc_bin = shutil.which("pandoc")
    if pandoc_bin is None:
        return _pandoc_missing_result()

    engine, engine_msg = _resolve_pdf_engine(pdf_engine)
    _log_pandoc_capability(engine, engine_msg)

    pdf_file = _host_path_for_virtual_output(pdf_path, thread_data)
    pdf_file.parent.mkdir(parents=True, exist_ok=True)

    # ---- Invocation -----------------------------------------------------
    cmd, public_cmd = _pandoc_command(
        pandoc_bin=pandoc_bin,
        markdown_path=markdown_path,
        pdf_path=pdf_path,
        md_file=md_file,
        pdf_file=pdf_file,
        engine=engine,
    )
    completed = _run_pandoc(cmd)
    if isinstance(completed, str):
        return completed

    if completed.returncode != 0:
        return _pandoc_error_result(
            completed=completed,
            engine=engine,
            public_cmd=public_cmd,
            thread_data=thread_data,
        )

    if not pdf_file.is_file():
        return _pandoc_no_output_result(pdf_path)

    # ---- Success --------------------------------------------------------
    return _pdf_success_result(
        pdf_path=pdf_path,
        pdf_file=pdf_file,
        engine=engine,
        engine_msg=engine_msg,
    )


@tool("render_markdown_to_pdf", parse_docstring=True)
def render_markdown_to_pdf(
    runtime: ToolRuntime,
    markdown_path: str,
    pdf_path: str,
    pdf_engine: str | None = None,
) -> str:
    """Convert a Markdown file to a PDF using pandoc.

    Use this for any PDF deliverable. Compose your Markdown source first
    (writing it via write_file_tool) — including image embeds for charts
    you generated with the chart-visualization skill — then call this
    tool to produce the PDF. Both paths must be under
    ``/mnt/user-data/outputs/``.

    DO NOT write your own ``_generate_*.py`` script using matplotlib or
    reportlab to produce a PDF. That pattern is unreliable. This tool
    encapsulates a known-working pipeline.

    On success, returns a JSON object with ``success: true``, the PDF path,
    and safe layout metrics (page_count, blank_page_count,
    short_page_count, layout_quality). After success, call
    emit_builder_artifact with ``artifact_path`` set to the PDF path unless
    Sophia injects a one-time layout repair instruction.

    On failure, returns ``success: false`` with a descriptive error
    type (``pandoc_missing``, ``pandoc_error``, ``pandoc_timeout``,
    ``invalid_input``, ``missing_input``). For pandoc_missing, fall
    back to shipping the Markdown source directly as the artifact
    (``artifact_type='document'``, ``artifact_path`` to the .md file)
    with confidence<=0.5 and explain the limitation in
    ``companion_tone_hint``.

    Args:
        markdown_path: Absolute path to the Markdown source file under
            /mnt/user-data/outputs/.
        pdf_path: Absolute path where the PDF should be written. Must be
            under /mnt/user-data/outputs/.
        pdf_engine: Optional pandoc PDF engine override, such as xelatex,
            lualatex, or wkhtmltopdf.
    """
    return _impl(
        markdown_path=markdown_path,
        pdf_path=pdf_path,
        pdf_engine=pdf_engine,
        thread_data=get_thread_data(runtime),
    )
