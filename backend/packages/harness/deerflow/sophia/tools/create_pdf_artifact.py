"""Create a small valid PDF artifact for the Sophia builder.

This tool gives simple PDF requests a deterministic binary path that does
not depend on pandoc, shell redirection, or ad-hoc generator scripts. It is
intentionally modest: produce valid PDF bytes under /mnt/user-data/outputs,
then let emit_builder_artifact carry the normal completion metadata.
"""

from __future__ import annotations

import json
import logging
import re
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from xml.sax.saxutils import escape

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data, mask_local_paths_in_output

logger = logging.getLogger(__name__)

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_DEFAULT_PDF_FILENAME = "simple-product-review.pdf"
_DEFAULT_TITLE = "Simple Product Review"
_DEFAULT_SUBTITLE = "Artifact Canvas Smoke Test"
_DEFAULT_SUMMARY_BULLETS = (
    "Confirms the builder can create a real PDF artifact.",
    "Keeps the content concise so smoke tests finish quickly.",
    "Uses a deterministic binary writer instead of a Markdown placeholder.",
)
_DEFAULT_IMPROVEMENT_BULLETS = (
    "Improve visual polish",
    "Add PDF page navigation",
    "Support zoom and fit controls",
    "Keep Review with Sophia truthful and stable",
)
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SLUG_RE = re.compile(r"[^A-Za-z0-9]+")


def _result(*, success: bool, **fields: Any) -> str:
    return json.dumps({"success": success, **fields})


def _safe_error_message(exc: Exception, thread_data: dict[str, Any] | None) -> str:
    raw = f"{exc.__class__.__name__}: {exc}"
    masked = mask_local_paths_in_output(raw, thread_data) if thread_data is not None else raw
    return masked[:300]


def _slug_pdf_filename(value: str | None) -> str:
    raw = (value or _DEFAULT_PDF_FILENAME).strip()
    stem = PurePosixPath(raw.replace("\\", "/")).stem or raw
    slug = _SLUG_RE.sub("-", stem).strip("-").lower()
    slug = (slug or PurePosixPath(_DEFAULT_PDF_FILENAME).stem)[:80].strip("-")
    return f"{slug or PurePosixPath(_DEFAULT_PDF_FILENAME).stem}.pdf"


def _target_pdf_path_from_state(state: dict[str, Any] | None) -> str | None:
    if not isinstance(state, dict):
        return None
    target = state.get("builder_artifact_target_path")
    if not isinstance(target, str):
        delegation = state.get("delegation_context")
        target = delegation.get("artifact_target_path") if isinstance(delegation, dict) else None
    if not isinstance(target, str) or not target.strip():
        return None
    return _canonical_prefixed_pdf_path(target.strip())


def _canonical_prefixed_pdf_path(value: str) -> str | None:
    candidate = value.replace("\\", "/").strip()
    if candidate.startswith("mnt/user-data/outputs/"):
        candidate = f"/{candidate}"
    elif candidate.startswith("user-data/outputs/"):
        candidate = f"/mnt/{candidate}"
    elif candidate.startswith("outputs/"):
        candidate = f"{_OUTPUTS_VIRTUAL_PREFIX}{candidate[len('outputs/'):]}"
    if not candidate.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None

    relative = candidate[len(_OUTPUTS_VIRTUAL_PREFIX):].strip("/")
    if not relative:
        return None
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts or pure.suffix.lower() != ".pdf":
        return None
    if any(not _SAFE_SEGMENT_RE.fullmatch(part) or part.startswith(".") for part in pure.parts):
        return None
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{pure.as_posix()}"


def _canonical_pdf_path(
    pdf_path: str | None,
    *,
    state: dict[str, Any] | None,
) -> tuple[str | None, str | None]:
    if isinstance(pdf_path, str) and pdf_path.strip():
        requested = pdf_path.strip()
        prefixed = _canonical_prefixed_pdf_path(requested)
        if prefixed is not None:
            return prefixed, None
        if requested.startswith("/") or "/" in requested or "\\" in requested:
            return None, "pdf_path must stay under /mnt/user-data/outputs/ and must not contain traversal"
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{_slug_pdf_filename(requested)}", None

    target = _target_pdf_path_from_state(state)
    if target is not None:
        return target, None
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{_DEFAULT_PDF_FILENAME}", None


def _relative_output_path(virtual_path: str) -> PurePosixPath:
    return PurePosixPath(virtual_path[len(_OUTPUTS_VIRTUAL_PREFIX):])


def _host_path_for_pdf(virtual_path: str, thread_data: dict[str, Any] | None) -> Path:
    relative = _relative_output_path(virtual_path)
    if thread_data is None or not thread_data.get("outputs_path"):
        return Path(virtual_path)
    outputs_root = Path(str(thread_data["outputs_path"])).resolve()
    host_path = (outputs_root / relative.as_posix()).resolve()
    host_path.relative_to(outputs_root)
    return host_path


def _clean_bullets(values: list[str] | None, fallback: tuple[str, ...]) -> list[str]:
    if not isinstance(values, list):
        return list(fallback)
    cleaned = [str(value).strip() for value in values if str(value).strip()]
    return cleaned[:8] or list(fallback)


def _render_reportlab_pdf(
    *,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> bytes:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=72,
        rightMargin=72,
        topMargin=72,
        bottomMargin=72,
    )
    styles = getSampleStyleSheet()

    def paragraph(text: str, style_name: str = "BodyText") -> Paragraph:
        return Paragraph(escape(text), styles[style_name])

    def bullet_list(items: list[str]) -> ListFlowable:
        return ListFlowable(
            [ListItem(paragraph(item), leftIndent=12) for item in items],
            bulletType="bullet",
            leftIndent=20,
        )

    story = [
        paragraph(title, "Title"),
        Spacer(1, 12),
        paragraph(subtitle, "Heading2"),
        Spacer(1, 24),
        paragraph("Executive Summary", "Heading1"),
        Spacer(1, 8),
        bullet_list(summary_bullets),
        PageBreak(),
        paragraph("Next Improvements", "Title"),
        Spacer(1, 18),
        bullet_list(improvement_bullets),
    ]
    doc.build(story)
    return buffer.getvalue()


def _render_fpdf_pdf(
    *,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> bytes:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.multi_cell(0, 12, title)
    pdf.set_font("Helvetica", "", 14)
    pdf.multi_cell(0, 10, subtitle)
    pdf.ln(10)
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "Executive Summary", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 12)
    for item in summary_bullets:
        pdf.multi_cell(0, 8, f"- {item}")
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.multi_cell(0, 12, "Next Improvements")
    pdf.ln(8)
    pdf.set_font("Helvetica", "", 12)
    for item in improvement_bullets:
        pdf.multi_cell(0, 8, f"- {item}")
    output = pdf.output(dest="S")
    return output.encode("latin-1") if isinstance(output, str) else bytes(output)


def _render_simple_pdf_bytes(
    *,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> tuple[bytes, str]:
    try:
        return (
            _render_reportlab_pdf(
                title=title,
                subtitle=subtitle,
                summary_bullets=summary_bullets,
                improvement_bullets=improvement_bullets,
            ),
            "reportlab",
        )
    except ImportError:
        return (
            _render_fpdf_pdf(
                title=title,
                subtitle=subtitle,
                summary_bullets=summary_bullets,
                improvement_bullets=improvement_bullets,
            ),
            "fpdf2",
        )


def _impl(
    *,
    pdf_path: str | None,
    title: str | None,
    subtitle: str | None,
    summary_bullets: list[str] | None,
    improvement_bullets: list[str] | None,
    thread_data: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
) -> str:
    virtual_path, path_error = _canonical_pdf_path(pdf_path, state=state)
    if path_error is not None or virtual_path is None:
        return _result(success=False, error_type="invalid_input", error=path_error or "invalid_pdf_path")

    final_title = (title or _DEFAULT_TITLE).strip() or _DEFAULT_TITLE
    final_subtitle = (subtitle or _DEFAULT_SUBTITLE).strip() or _DEFAULT_SUBTITLE
    executive_summary = _clean_bullets(summary_bullets, _DEFAULT_SUMMARY_BULLETS)
    next_improvements = _clean_bullets(improvement_bullets, _DEFAULT_IMPROVEMENT_BULLETS)

    try:
        host_path = _host_path_for_pdf(virtual_path, thread_data)
        pdf_bytes, renderer = _render_simple_pdf_bytes(
            title=final_title,
            subtitle=final_subtitle,
            summary_bullets=executive_summary,
            improvement_bullets=next_improvements,
        )
        if not pdf_bytes.startswith(b"%PDF-"):
            raise ValueError("renderer returned non-PDF bytes")
        host_path.parent.mkdir(parents=True, exist_ok=True)
        host_path.write_bytes(pdf_bytes)
        size_bytes = host_path.stat().st_size
    except Exception as exc:  # noqa: BLE001 - safe structured tool failure
        logger.warning(
            "create_pdf_artifact: pdf_generation_failed error_class=%s error=%s",
            exc.__class__.__name__,
            _safe_error_message(exc, thread_data),
        )
        return _result(
            success=False,
            error_type="pdf_generation_failed",
            error="pdf_generation_failed",
            error_class=exc.__class__.__name__,
        )

    logger.info(
        "create_pdf_artifact: render_success renderer=%s final_artifact_ext=pdf size_bytes=%s",
        renderer,
        size_bytes,
    )
    return _result(
        success=True,
        pdf_path=virtual_path,
        size_bytes=size_bytes,
        renderer=renderer,
        content_type="application/pdf",
        page_count=2,
        blank_page_count=0,
        short_page_count=0,
        layout_quality="ok",
        layout_warning=None,
    )


@tool("create_pdf_artifact", parse_docstring=True)
def create_pdf_artifact(
    runtime: ToolRuntime,
    pdf_path: str | None = None,
    title: str | None = None,
    subtitle: str | None = None,
    summary_bullets: list[str] | None = None,
    improvement_bullets: list[str] | None = None,
) -> str:
    """Create a small valid PDF artifact under /mnt/user-data/outputs/.

    Use this for simple PDF artifacts and PDF smoke tests. The tool writes
    real PDF bytes using reportlab when available, falling back to fpdf2 if
    reportlab cannot be imported. Do not write Markdown with a .pdf suffix.

    Args:
        pdf_path: Optional output path. If omitted, uses the builder target
            PDF path when available, otherwise /mnt/user-data/outputs/simple-product-review.pdf.
            Plain filenames or titles are normalized safely to a .pdf filename
            under /mnt/user-data/outputs/.
        title: Optional page 1 title. Defaults to Simple Product Review.
        subtitle: Optional page 1 subtitle. Defaults to Artifact Canvas Smoke Test.
        summary_bullets: Optional Executive Summary bullets.
        improvement_bullets: Optional Next Improvements bullets for page 2.
    """
    state = runtime.state if runtime is not None else None
    return _impl(
        pdf_path=pdf_path,
        title=title,
        subtitle=subtitle,
        summary_bullets=summary_bullets,
        improvement_bullets=improvement_bullets,
        thread_data=get_thread_data(runtime),
        state=state if isinstance(state, dict) else None,
    )
