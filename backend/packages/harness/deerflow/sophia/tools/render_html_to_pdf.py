"""Render a builder-authored HTML report to PDF via headless Chromium.

Sophia PDF reports are authored as ONE self-contained HTML file with INLINE
``<svg>`` charts/diagrams (deterministic, local — no remote chart service, no
client-side JS) plus the base print CSS. See ``skills/public/pdf-report``.

This tool converts that HTML to PDF using the bundled ``playwright-core`` +
system chromium (the report visual path as of 2026-06-25; the remote
``chart-visualization`` GPT-Vis service rendered empty charts in production and
is no longer used for reports). The result JSON mirrors ``render_markdown_to_pdf``
exactly, so the builder's PDF gates — page-count tolerance, visual-presence via
``image_count`` (chromium rasterizes inline SVG into PDF image XObjects), and
the never-terminal downgrade — all work unchanged.

Deployment: ``node`` + a chromium executable on the langgraph image
(``Dockerfile.langgraph`` installs ``chromium`` and verifies ``playwright-core``
resolves beside the .mjs). Override the browser via ``SOPHIA_CHROMIUM_PATH``.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess  # noqa: S404 — node by absolute path + fixed bundled script
from pathlib import Path

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data
from deerflow.sophia.tools.render_markdown_to_pdf import (
    _ensure_relative_to_outputs,
    _host_path_for_virtual_output,
    _inspect_pdf_layout_with_targets,
    _result,
)

logger = logging.getLogger(__name__)

_RENDER_TIMEOUT_SECONDS = 120
_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _count_inline_svg(host_html: Path) -> int:
    """Count inline ``<svg>`` elements in the report HTML source (R2-2 signal).

    Chromium renders inline SVG as vector ops, not PDF /Image XObjects, so the
    visual-presence gate cannot see them via image_count. The authored source is
    the reliable signal that the report contains charts/diagrams.
    """
    try:
        text = host_html.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    return text.lower().count("<svg")


def _render_script_path() -> Path | None:
    """Locate render_html_to_pdf.mjs (env override → beside this pkg → container)."""
    configured = os.getenv("SOPHIA_ARTIFACT_JS_RUNTIME")
    candidates = [
        (Path(configured) / "render_html_to_pdf.mjs") if configured else None,
        Path(__file__).resolve().parents[1] / "js" / "render_html_to_pdf.mjs",
        Path("/app/backend/packages/harness/deerflow/sophia/js/render_html_to_pdf.mjs"),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def _html_pdf_runtime() -> tuple[str | None, Path | None, str | None]:
    node = shutil.which("node")
    if not node:
        return None, None, _result(
            success=False,
            error_type="node_unavailable",
            error="node is not available to render HTML→PDF.",
        )
    script = _render_script_path()
    if script is None:
        return None, None, _result(
            success=False,
            error_type="render_script_missing",
            error="render_html_to_pdf.mjs not found on this runtime.",
        )
    return node, script, None


def _run_html_pdf_render(
    *,
    node: str,
    script: Path,
    host_html: Path,
    host_pdf: Path,
    html_path: str,
    margin: str | None,
) -> str | None:
    cmd = [node, str(script), "--html-file", str(host_html), "--pdf-file", str(host_pdf)]
    if margin:
        cmd += ["--margin", margin]
    try:
        completed = subprocess.run(  # noqa: S603 — fixed node + bundled script, file path args only
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=_RENDER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        logger.warning("render_html_to_pdf: chromium render timed out html=%s", html_path)
        return _result(
            success=False,
            error_type="render_timeout",
            error=f"Chromium render exceeded {_RENDER_TIMEOUT_SECONDS}s.",
        )
    if completed.returncode == 0 and host_pdf.is_file():
        return None
    stderr = (completed.stderr or "").strip()
    logger.warning(
        "render_html_to_pdf: render_failed rc=%s html=%s stderr=%s",
        completed.returncode,
        html_path,
        stderr[-300:],
    )
    return _result(
        success=False,
        error_type="html_render_failed",
        stderr=stderr[-1000:] if stderr else None,
        error="Chromium failed to render the HTML to PDF.",
    )


def _html_pdf_path_error(html_path: str, pdf_path: str) -> str | None:
    html_error = _ensure_relative_to_outputs("html_path", html_path)
    if html_error is not None:
        return html_error
    return _ensure_relative_to_outputs("pdf_path", pdf_path)


@tool("render_html_to_pdf", parse_docstring=True)
def render_html_to_pdf(
    runtime: ToolRuntime,
    html_path: str,
    pdf_path: str,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
    margin: str | None = None,
) -> str:
    """Render a self-contained HTML report file to PDF via headless Chromium.

    Author the report as ONE HTML file with inline ``<svg>`` charts/diagrams
    (no remote chart service, no client-side JS) plus the base print CSS, then
    call this tool. Returns a JSON result with the rendered ``pdf_path``,
    ``page_count``, and ``image_count``.

    Args:
        html_path: Absolute /mnt/user-data/outputs/ path to the source .html file.
        pdf_path: Absolute /mnt/user-data/outputs/ path for the output .pdf.
        requested_pages: Exact requested page count when the user asked for a length.
        requested_min_pages: Minimum requested pages (range mode).
        requested_max_pages: Maximum requested pages (range mode).
        margin: Optional CSS page margin (e.g. "16mm"); defaults to 16mm.
    """
    path_error = _html_pdf_path_error(html_path, pdf_path)
    if path_error is not None:
        return _result(success=False, error_type="invalid_input", error=path_error)
    thread_data = get_thread_data(runtime)
    host_html = _host_path_for_virtual_output(html_path, thread_data)
    host_pdf = _host_path_for_virtual_output(pdf_path, thread_data)
    if not host_html.is_file():
        return _result(
            success=False,
            error_type="missing_html",
            error=f"HTML source not found: {html_path}",
        )

    node, script, runtime_error = _html_pdf_runtime()
    if runtime_error is not None:
        return runtime_error
    render_error = _run_html_pdf_render(
        node=node or "",
        script=script or Path(),
        host_html=host_html,
        host_pdf=host_pdf,
        html_path=html_path,
        margin=margin,
    )
    if render_error is not None:
        return render_error

    layout = _inspect_pdf_layout_with_targets(
        host_pdf,
        requested_pages=requested_pages,
        requested_min_pages=requested_min_pages,
        requested_max_pages=requested_max_pages,
    )
    # Inline <svg> charts/diagrams are VECTOR in the PDF (drawing ops, not
    # /Image XObjects), so ``image_count`` reads 0 even for a fully-illustrated
    # report (prod 2026-06-26: false "visuals not embedded" reject). Count the
    # authored inline SVG from the source so the visual-presence gate has a
    # vector signal alongside image_count. (R2-2)
    vector_visual_count = _count_inline_svg(host_html)
    size_bytes = host_pdf.stat().st_size
    logger.info(
        "render_html_to_pdf: render_success final_artifact_ext=pdf size_bytes=%s "
        "page_count=%s image_count=%s vector_visual_count=%s layout_quality=%s",
        size_bytes,
        layout.get("page_count"),
        layout.get("image_count"),
        vector_visual_count,
        layout.get("layout_quality"),
    )
    return _result(
        success=True,
        pdf_path=pdf_path,
        size_bytes=size_bytes,
        engine="chromium",
        engine_message="rendered via headless chromium (playwright-core)",
        vector_visual_count=vector_visual_count,
        **layout,
    )
