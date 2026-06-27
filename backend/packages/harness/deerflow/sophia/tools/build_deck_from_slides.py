"""Build a .pptx deck from builder-authored slide HTML (deterministic harness step).

Sophia decks are authored as one self-contained HTML file per slide under
``slides/`` (real DOM text + a generated image referenced by a RELATIVE
``../assets/<file>`` path — see ``skills/public/ppt-generation``). This tool is
the deck analog of ``render_html_to_pdf``: the model authors the slide HTML and
calls this ONE deterministic tool; the harness renders each slide to a full-bleed
PNG (headless Chromium, ``render_html_to_png.mjs``) and wraps the PNGs into a
.pptx via the proven ``compile_pptx.mjs`` full-bleed compiler. The model never
writes ``python-pptx``/``pptxgenjs`` code — that improvisation is the live deck
failure (prod 2026-06-26: model never compiled, hard-ceiling timeout).

The slide HTML + ``assets/`` are retained as the editable source of truth.

Deployment: ``node`` + system chromium on the langgraph image; ``playwright-core``
bundled beside the .mjs (``Dockerfile.langgraph``). Override the browser via
``SOPHIA_CHROMIUM_PATH``; override the js dir via ``SOPHIA_ARTIFACT_JS_RUNTIME``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess  # noqa: S404 — node by absolute path + fixed bundled scripts
import tempfile
from pathlib import Path
from typing import Any

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data
from deerflow.sophia.tools.render_html_to_pdf import _host_path_for_virtual_output, _result
from deerflow.sophia.tools.render_markdown_to_pdf import _ensure_relative_to_outputs

logger = logging.getLogger(__name__)

_PER_SLIDE_TIMEOUT_SECONDS = 90
_WRAP_TIMEOUT_SECONDS = 120
_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_DECK_WIDTH = 1920
_DECK_HEIGHT = 1080


def _js_script_path(filename: str) -> Path | None:
    """Locate a bundled .mjs (env override → beside this pkg → container path)."""
    configured = os.getenv("SOPHIA_ARTIFACT_JS_RUNTIME")
    candidates = [
        (Path(configured) / filename) if configured else None,
        Path(__file__).resolve().parents[1] / "js" / filename,
        Path(f"/app/backend/packages/harness/deerflow/sophia/js/{filename}"),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def _ordered_slide_html(slides_host_dir: Path) -> list[Path]:
    """Sorted slide HTML files. Sorting is lexical so authors name them 01-, 02-…"""
    if not slides_host_dir.is_dir():
        return []
    return sorted(
        (p for p in slides_host_dir.iterdir() if p.suffix.lower() in {".html", ".htm"} and p.is_file()),
        key=lambda p: p.name,
    )


def _deck_request_error(output_path: str, slides_virtual: str) -> str | None:
    output_error = _ensure_relative_to_outputs("output_path", output_path)
    if output_error is not None:
        return output_error
    if not output_path.strip().lower().endswith(".pptx"):
        return "output_path must end with .pptx"
    return _ensure_relative_to_outputs("slides_dir", slides_virtual)


def _no_slides_error(slide_files: list[Path], slides_virtual: str) -> str | None:
    if slide_files:
        return None
    return _result(success=False, error_type="no_slides", error=f"No slide .html files found in {slides_virtual}")


def _deck_runtime() -> tuple[str | None, Path | None, Path | None, str | None]:
    node = shutil.which("node")
    if not node:
        return None, None, None, _result(
            success=False,
            error_type="node_unavailable",
            error="node is not available to build the deck.",
        )
    png_script = _js_script_path("render_html_to_png.mjs")
    wrap_script = _js_script_path("compile_pptx.mjs")
    if png_script is None or wrap_script is None:
        return None, None, None, _result(
            success=False,
            error_type="render_script_missing",
            error="deck render/wrap scripts not found on this runtime.",
        )
    return node, png_script, wrap_script, None


def _slide_render_command(node: str, png_script: Path, html: Path, png: Path) -> list[str]:
    return [
        node, str(png_script),
        "--html-file", str(html),
        "--png-file", str(png),
        "--width", str(_DECK_WIDTH),
        "--height", str(_DECK_HEIGHT),
    ]


def _run_slide_render(cmd: list[str], html: Path) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    try:
        completed = subprocess.run(  # noqa: S603 — fixed node + bundled script, file path args only
            cmd, check=False, capture_output=True, text=True, timeout=_PER_SLIDE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        logger.warning("build_deck_from_slides: slide render timed out slide=%s", html.name)
        return None, _result(
            success=False,
            error_type="slide_render_timeout",
            error=f"Slide render exceeded {_PER_SLIDE_TIMEOUT_SECONDS}s: {html.name}",
        )
    return completed, None


def _slide_render_succeeded(completed: subprocess.CompletedProcess[str] | None, png: Path) -> bool:
    return completed is not None and completed.returncode == 0 and png.is_file()


def _slide_render_failure(completed: subprocess.CompletedProcess[str] | None, html: Path, png: Path) -> str | None:
    if _slide_render_succeeded(completed, png):
        return None
    stderr = ((completed.stderr if completed is not None else "") or "").strip()
    logger.warning("build_deck_from_slides: slide render failed slide=%s stderr=%s", html.name, stderr[-300:])
    return _result(
        success=False,
        error_type="slide_render_failed",
        stderr=stderr[-800:] if stderr else None,
        error=f"Chromium failed to render slide {html.name}.",
    )


def _render_slide_pngs(node: str, png_script: Path, slide_files: list[Path], render_dir: Path) -> tuple[list[Path], str | None]:
    render_dir.mkdir(parents=True, exist_ok=True)
    png_paths: list[Path] = []
    for index, html in enumerate(slide_files):
        png = render_dir / f"slide-{index + 1:02d}.png"
        completed, run_error = _run_slide_render(_slide_render_command(node, png_script, html, png), html)
        render_error = run_error or _slide_render_failure(completed, html, png)
        if render_error is not None:
            return [], render_error
        png_paths.append(png)
    return png_paths, None


def _run_wrap_command(wrap_cmd: list[str]) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    try:
        wrapped = subprocess.run(  # noqa: S603 — fixed node + bundled script, file path args only
            wrap_cmd, check=False, capture_output=True, text=True, timeout=_WRAP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return None, _result(success=False, error_type="wrap_timeout", error=f"PPTX wrap exceeded {_WRAP_TIMEOUT_SECONDS}s.")
    return wrapped, None


def _pptx_wrap_succeeded(wrapped: subprocess.CompletedProcess[str] | None, host_pptx: Path) -> bool:
    return wrapped is not None and wrapped.returncode == 0 and host_pptx.is_file()


def _pptx_wrap_failure(wrapped: subprocess.CompletedProcess[str] | None, host_pptx: Path) -> str | None:
    if _pptx_wrap_succeeded(wrapped, host_pptx):
        return None
    stderr = ((wrapped.stderr if wrapped is not None else "") or "").strip()
    logger.warning(
        "build_deck_from_slides: wrap failed rc=%s stderr=%s",
        getattr(wrapped, "returncode", None),
        stderr[-300:],
    )
    return _result(
        success=False,
        error_type="pptx_wrap_failed",
        stderr=stderr[-800:] if stderr else None,
        error="Failed to wrap rendered slides into PPTX.",
    )


def _wrap_slide_pngs(
    *,
    node: str,
    wrap_script: Path,
    host_pptx: Path,
    render_dir: Path,
    png_paths: list[Path],
    title: str | None,
) -> str | None:
    plan = {"title": title or "Sophia presentation", "slides": [{"index": i} for i in range(len(png_paths))]}
    plan_path = render_dir / "_deck_plan.json"
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    wrap_cmd = [
        node, str(wrap_script),
        "--plan-file", str(plan_path),
        "--output-file", str(host_pptx),
        "--slide-images", *[str(p) for p in png_paths],
    ]
    wrapped, run_error = _run_wrap_command(wrap_cmd)
    return run_error or _pptx_wrap_failure(wrapped, host_pptx)


def _deck_render_temp_parent(host_pptx: Path, thread_data: dict[str, Any] | None) -> Path:
    outputs_path = (thread_data or {}).get("outputs_path") if isinstance(thread_data, dict) else None
    if isinstance(outputs_path, str) and outputs_path.strip():
        parent = Path(outputs_path).resolve().parent
    else:
        parent = host_pptx.parent.resolve().parent
    render_parent = parent / ".deck-render"
    render_parent.mkdir(parents=True, exist_ok=True)
    return render_parent


def _build_deck_artifact(
    host_pptx: Path,
    slide_files: list[Path],
    title: str | None,
    thread_data: dict[str, Any] | None,
) -> tuple[list[Path], str | None]:
    node, png_script, wrap_script, runtime_error = _deck_runtime()
    if runtime_error is not None:
        return [], runtime_error
    render_parent = _deck_render_temp_parent(host_pptx, thread_data)
    with tempfile.TemporaryDirectory(prefix=f"{host_pptx.stem}-", dir=render_parent) as render_tmp:
        render_dir = Path(render_tmp)
        png_paths, render_error = _render_slide_pngs(node or "", png_script or Path(), slide_files, render_dir)
        if render_error is not None:
            return [], render_error
        wrap_error = _wrap_slide_pngs(
            node=node or "",
            wrap_script=wrap_script or Path(),
            host_pptx=host_pptx,
            render_dir=render_dir,
            png_paths=png_paths,
            title=title,
        )
    return png_paths, wrap_error


@tool("build_deck_from_slides", parse_docstring=True)
def build_deck_from_slides(
    runtime: ToolRuntime,
    output_path: str,
    title: str | None = None,
    slides_dir: str | None = None,
) -> str:
    """Convert authored slide HTML into a .pptx deck (the deck build step).

    Author one self-contained HTML file per slide (1920×1080) under
    ``/mnt/user-data/outputs/slides/`` with images referenced by RELATIVE
    ``../assets/<file>`` paths, then call this tool. The harness renders each
    slide to a full-bleed PNG and wraps them into the .pptx. Do NOT write
    ``python-pptx``/``pptxgenjs`` code or any deck compiler yourself.

    Args:
        output_path: Absolute /mnt/user-data/outputs/ path for the output .pptx.
        title: Optional deck title (metadata).
        slides_dir: Optional absolute /mnt/user-data/outputs/ slides directory;
            defaults to /mnt/user-data/outputs/slides.
    """
    slides_virtual = slides_dir or f"{_OUTPUTS_VIRTUAL_PREFIX}slides"
    path_error = _deck_request_error(output_path, slides_virtual)
    if path_error is not None:
        return _result(success=False, error_type="invalid_input", error=path_error)
    thread_data = get_thread_data(runtime)
    slides_host = _host_path_for_virtual_output(slides_virtual, thread_data)
    host_pptx = _host_path_for_virtual_output(output_path, thread_data)

    slide_files = _ordered_slide_html(slides_host)
    no_slides_error = _no_slides_error(slide_files, slides_virtual)
    if no_slides_error is not None:
        return no_slides_error

    png_paths, build_error = _build_deck_artifact(host_pptx, slide_files, title, thread_data)
    if build_error is not None:
        return build_error

    size_bytes = host_pptx.stat().st_size
    logger.info(
        "build_deck_from_slides: build_success final_artifact_ext=pptx slide_count=%s size_bytes=%s",
        len(png_paths),
        size_bytes,
    )
    return _result(
        success=True,
        pptx_path=output_path,
        slide_count=len(png_paths),
        size_bytes=size_bytes,
        engine="chromium+pptxgenjs",
        engine_message="rendered slide HTML to full-bleed PNG and wrapped to PPTX",
    )
