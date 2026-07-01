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
from html.parser import HTMLParser
from pathlib import Path
from posixpath import normpath

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
_SVG_STRUCTURAL_TAGS = {
    "clippath",
    "defs",
    "desc",
    "filter",
    "lineargradient",
    "mask",
    "metadata",
    "pattern",
    "radialgradient",
    "script",
    "style",
    "symbol",
    "title",
}
_SVG_VISIBLE_CONTENT_TAGS = {
    "circle",
    "ellipse",
    "foreignobject",
    "image",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "text",
    "use",
}
# Renderable SVG container groups that can carry display:none / opacity:0 / hidden
# on themselves and hide everything inside. The hidden state must propagate to
# descendant content (a hidden <g> sprite must NOT satisfy the visual gate).
_SVG_CONTAINER_TAGS = {
    "g",
    "a",
    "switch",
}


def _attrs_hidden(attrs: list[tuple[str, str | None]]) -> bool:
    attr_map = {str(key).lower(): (value or "") for key, value in attrs}
    if "hidden" in attr_map or attr_map.get("aria-hidden", "").lower() == "true":
        return True
    style = attr_map.get("style", "").replace(" ", "").lower()
    if "display:none" in style or "visibility:hidden" in style:
        return True
    if "opacity:" in style:
        # Only EXACTLY zero opacity hides. The prior `"opacity:0" in style`
        # substring check wrongly matched fractional values like opacity:0.85,
        # so a visible semi-transparent <svg> was counted as hidden and an
        # illustrated report could be false-rejected as having no figures
        # (Codex P2, 2026-06-29).
        opacity_val = style.split("opacity:", 1)[1].split(";", 1)[0]
        try:
            if float(opacity_val) == 0:
                return True
        except ValueError:
            pass
    if attr_map.get("width") in {"0", "0px"} or attr_map.get("height") in {"0", "0px"}:
        return True
    # SVG presentation attributes (the style-less form, e.g. `<g opacity="0">` /
    # `<g visibility="hidden">` / `<g display="none">`) hide the same way as the
    # CSS properties above (Codex P2, review 4600605339).
    if attr_map.get("display", "").strip().lower() == "none":
        return True
    if attr_map.get("visibility", "").strip().lower() in {"hidden", "collapse"}:
        return True
    opacity_attr = attr_map.get("opacity")
    if opacity_attr is not None and opacity_attr.strip() != "":
        try:
            if float(opacity_attr) == 0:
                return True
        except ValueError:
            pass
    return False


class _VisibleInlineSvgCounter(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.count = 0
        self._html_stack: list[dict[str, str | bool]] = []
        self._stack: list[dict[str, object]] = []

    def _current_svg_hidden(self) -> bool:
        """Effective hidden state at the cursor inside the current <svg>.

        Walks the open SVG container groups (innermost wins) and falls back to
        the <svg>'s own hidden flag — so a <path> inside a hidden <g> / <defs> /
        <mask> is NOT counted even though its own attrs are clean (Codex P2,
        review 4600605339).
        """
        current = self._stack[-1]
        containers = current["containers"]
        if containers:
            return bool(containers[-1]["hidden"])
        return bool(current["hidden"])

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.lower()
        if tag_name == "svg":
            parent_hidden = (
                self._current_svg_hidden()
                if self._stack
                else bool(self._html_stack[-1]["hidden"])
                if self._html_stack
                else False
            )
            self._stack.append(
                {
                    "hidden": parent_hidden or _attrs_hidden(attrs),
                    "containers": [],
                    "visible_content_count": 0,
                }
            )
            return
        if not self._stack:
            parent_hidden = bool(self._html_stack[-1]["hidden"]) if self._html_stack else False
            self._html_stack.append(
                {
                    "tag": tag_name,
                    "hidden": parent_hidden or _attrs_hidden(attrs),
                }
            )
            return
        current = self._stack[-1]
        parent_hidden = self._current_svg_hidden()
        # Structural tags (defs/mask/symbol/…) never render — their whole subtree
        # is hidden. Renderable container groups (g/a/switch) hide their subtree
        # only when their own attrs hide them (or a parent already did).
        if tag_name in _SVG_STRUCTURAL_TAGS:
            current["containers"].append({"tag": tag_name, "hidden": True})
            return
        if tag_name in _SVG_CONTAINER_TAGS:
            current["containers"].append({"tag": tag_name, "hidden": parent_hidden or _attrs_hidden(attrs)})
            return
        if tag_name in _SVG_VISIBLE_CONTENT_TAGS and not parent_hidden and not _attrs_hidden(attrs):
            current["visible_content_count"] = int(current["visible_content_count"]) + 1

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()
        if not self._stack:
            for index in range(len(self._html_stack) - 1, -1, -1):
                if self._html_stack[index]["tag"] == tag_name:
                    del self._html_stack[index:]
                    break
            return
        if tag_name == "svg":
            current = self._stack.pop()
            if not current["hidden"] and int(current["visible_content_count"]) > 0:
                self.count += 1
            return
        if tag_name in _SVG_STRUCTURAL_TAGS or tag_name in _SVG_CONTAINER_TAGS:
            containers = self._stack[-1]["containers"]
            for index in range(len(containers) - 1, -1, -1):
                if containers[index]["tag"] == tag_name:
                    del containers[index:]
                    break


def _count_inline_svg(host_html: Path) -> int:
    """Count visible inline ``<svg>`` figures in the report HTML source.

    Chromium renders inline SVG as vector ops, not PDF /Image XObjects, so the
    visual-presence gate cannot see them via image_count. Count rendered-looking
    SVGs only so hidden sprites, icon definitions, and comments do not satisfy
    visual-report gates.
    """
    try:
        text = host_html.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    parser = _VisibleInlineSvgCounter()
    try:
        parser.feed(text)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed builder HTML falls back to no vector evidence.
        return 0
    return parser.count


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


def _html_pdf_command(node: str, script: Path, host_html: Path, host_pdf: Path, margin: str | None) -> list[str]:
    cmd = [node, str(script), "--html-file", str(host_html), "--pdf-file", str(host_pdf)]
    if margin:
        cmd += ["--margin", margin]
    return cmd


def _html_pdf_render_succeeded(completed: subprocess.CompletedProcess[str] | None, host_pdf: Path) -> bool:
    return completed is not None and completed.returncode == 0 and host_pdf.is_file()


def _html_pdf_render_failure(completed: subprocess.CompletedProcess[str] | None, host_pdf: Path, html_path: str) -> str | None:
    if _html_pdf_render_succeeded(completed, host_pdf):
        return None
    stderr = ((completed.stderr if completed is not None else "") or "").strip()
    logger.warning(
        "render_html_to_pdf: render_failed rc=%s html=%s stderr=%s",
        getattr(completed, "returncode", None),
        html_path,
        stderr[-300:],
    )
    return _result(
        success=False,
        error_type="html_render_failed",
        stderr=stderr[-1000:] if stderr else None,
        error="Chromium failed to render the HTML to PDF.",
    )


def _run_html_pdf_render(
    *,
    node: str,
    script: Path,
    host_html: Path,
    host_pdf: Path,
    html_path: str,
    margin: str | None,
) -> str | None:
    try:
        completed = subprocess.run(  # noqa: S603 — fixed node + bundled script, file path args only
            _html_pdf_command(node, script, host_html, host_pdf, margin),
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
    return _html_pdf_render_failure(completed, host_pdf, html_path)


def _html_pdf_path_error(html_path: str, pdf_path: str) -> str | None:
    html_error = _ensure_relative_to_outputs("html_path", html_path)
    if html_error is not None:
        return html_error
    pdf_error = _ensure_relative_to_outputs("pdf_path", pdf_path)
    if pdf_error is not None:
        return pdf_error
    # The Chromium path expects browser-renderable HTML. If a builder accidentally
    # passes an existing Markdown/text source, Chromium may still produce a blank
    # or unstyled PDF instead of giving the model a useful repair signal.
    if not html_path.strip().lower().endswith((".html", ".htm")):
        return (
            f"html_path: must end with .html or .htm (got: {html_path.strip()!r}). "
            "Author a self-contained HTML report before calling render_html_to_pdf."
        )
    # Chromium writes PDF bytes regardless of the output filename, and the
    # authoritative PDF emit path can later stamp this file as artifact_ext=pdf —
    # so a non-.pdf name (e.g. report.html) would deliver a PDF under the wrong
    # extension. Require the .pdf suffix up front (parity with build_deck_from_slides
    # requiring .pptx). Codex P2 (2026-06-30).
    if not pdf_path.strip().lower().endswith(".pdf"):
        return (
            f"pdf_path: must end with .pdf (got: {pdf_path.strip()!r}). "
            "Chromium writes PDF bytes; a non-.pdf name would deliver a PDF "
            "under the wrong extension."
        )
    return None


def _output_relative_parts(virtual_path: str) -> tuple[str, ...]:
    normalized = virtual_path.strip().replace("\\", "/")
    relative = normpath(normalized.removeprefix(_OUTPUTS_VIRTUAL_PREFIX)).lstrip("/")
    return tuple(part for part in relative.split("/") if part and part != ".")


def _host_outputs_root_for_virtual_path(host_path: Path, virtual_path: str) -> Path:
    root = Path(host_path)
    for _part in _output_relative_parts(virtual_path):
        root = root.parent
    return root


def _resolved_host_path_error(label: str, virtual_path: str, host_path: Path) -> str | None:
    outputs_root = _host_outputs_root_for_virtual_path(host_path, virtual_path)
    try:
        resolved_root = outputs_root.resolve(strict=True)
    except OSError:
        resolved_root = outputs_root.resolve(strict=False)
    try:
        resolved_path = host_path.resolve(strict=host_path.exists())
    except OSError:
        resolved_path = host_path.resolve(strict=False)
    if not resolved_path.is_relative_to(resolved_root):
        return (
            f"{label}: resolved host path escapes the outputs directory. "
            "Symlinks or redirected paths outside /mnt/user-data/outputs are not allowed."
        )
    return None


def _html_pdf_host_path_error(
    *,
    html_path: str,
    host_html: Path,
    pdf_path: str,
    host_pdf: Path,
) -> str | None:
    html_error = _resolved_host_path_error("html_path", html_path, host_html)
    if html_error is not None:
        return html_error
    return _resolved_host_path_error("pdf_path", pdf_path, host_pdf)


def _missing_html_result(host_html: Path, html_path: str) -> str | None:
    if host_html.is_file():
        return None
    return _result(
        success=False,
        error_type="missing_html",
        error=f"HTML source not found: {html_path}",
    )


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
    host_path_error = _html_pdf_host_path_error(
        html_path=html_path,
        host_html=host_html,
        pdf_path=pdf_path,
        host_pdf=host_pdf,
    )
    if host_path_error is not None:
        return _result(success=False, error_type="invalid_input", error=host_path_error)
    missing_html = _missing_html_result(host_html, html_path)
    if missing_html is not None:
        return missing_html

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
