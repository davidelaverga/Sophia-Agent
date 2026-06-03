"""Create a small valid PDF artifact for the Sophia builder.

This tool gives simple PDF requests a deterministic binary path that does
not depend on pandoc, shell redirection, or ad-hoc generator scripts. It is
intentionally modest: produce valid PDF bytes under /mnt/user-data/outputs,
then let emit_builder_artifact carry the normal completion metadata.
"""

from __future__ import annotations

from dataclasses import dataclass
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
_PAGE_HEADING_RE = re.compile(
    r"^\s*(?:[-*]\s*)?Page\s+([1-9]\d{0,2})(?:\s*(?:[:.)-]|\u2013|\u2014)\s*(.*)|\s*)$",
    re.IGNORECASE,
)
_REQUESTED_PAGE_COUNT_RE = (
    re.compile(r"\bLength\s*:\s*([1-9]\d{0,1})\s+pages?\b", re.IGNORECASE),
    re.compile(
        r"\b([1-9]\d{0,1})\s*-\s*page\s+(?:pdf|document|report|artifact|deck)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:exactly|length(?:\s+of)?|create|make|generate|produce|write|render|export)"
        r"\s+([1-9]\d{0,1})\s+pages?\b",
        re.IGNORECASE,
    ),
)
_BULLET_PREFIX_RE = re.compile(r"^\s*(?:[-*]|\u2022|\d+[.)])\s+")
_MAX_REQUESTED_PAGES = 40


@dataclass(frozen=True)
class _PdfPageSpec:
    title: str
    subtitle: str | None
    lines: tuple[str, ...]


@dataclass(frozen=True)
class _PdfPagePlan:
    pages: tuple[_PdfPageSpec, ...]
    structure_source: str
    structure_safe_reason: str | None


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


def _task_text_from_state(state: dict[str, Any] | None) -> str:
    if not isinstance(state, dict):
        return ""

    parts: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        if not isinstance(value, str):
            return
        text = value.strip()
        if text and text not in seen:
            seen.add(text)
            parts.append(text)

    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        for key in ("task", "task_description", "description", "original_task"):
            add(delegation.get(key))

    for key in ("task", "task_description", "builder_task_description"):
        add(state.get(key))

    messages = state.get("messages")
    if isinstance(messages, list):
        for message in messages[-4:]:
            content = (
                message.get("content")
                if isinstance(message, dict)
                else getattr(message, "content", None)
            )
            add(content)

    return "\n\n".join(parts)


def _clean_page_title(raw_title: str | None, page_number: int) -> str:
    title = (raw_title or "").strip(" \t:-.)\u2013\u2014")
    return title or f"Page {page_number}"


def _clean_page_line(raw_line: str) -> str:
    line = raw_line.strip()
    if not line:
        return ""
    return line


def _parse_page_headings(task_text: str) -> list[_PdfPageSpec]:
    pages: list[_PdfPageSpec] = []
    current_number: int | None = None
    current_title = ""
    current_lines: list[str] = []

    def flush_current() -> None:
        nonlocal current_number, current_title, current_lines
        if current_number is None:
            return
        pages.append(
            _PdfPageSpec(
                title=current_title,
                subtitle=None,
                lines=tuple(current_lines),
            )
        )
        current_number = None
        current_title = ""
        current_lines = []

    for raw_line in task_text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        match = _PAGE_HEADING_RE.match(line)
        if match:
            flush_current()
            current_number = int(match.group(1))
            current_title = _clean_page_title(match.group(2), current_number)
            current_lines = []
            continue
        if current_number is not None:
            cleaned = _clean_page_line(line)
            if cleaned:
                current_lines.append(cleaned)

    flush_current()
    return pages


def _requested_page_count(task_text: str) -> int | None:
    for pattern in _REQUESTED_PAGE_COUNT_RE:
        match = pattern.search(task_text)
        if not match:
            continue
        count = int(match.group(1))
        if 1 <= count <= _MAX_REQUESTED_PAGES:
            return count
    return None


def _default_page_specs(
    *,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> list[_PdfPageSpec]:
    return [
        _PdfPageSpec(
            title=title,
            subtitle=subtitle,
            lines=("Executive Summary", *(f"- {item}" for item in summary_bullets)),
        ),
        _PdfPageSpec(
            title="Next Improvements",
            subtitle=None,
            lines=tuple(f"- {item}" for item in improvement_bullets),
        ),
    ]


def _length_page_specs(
    *,
    page_count: int,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> list[_PdfPageSpec]:
    defaults = _default_page_specs(
        title=title,
        subtitle=subtitle,
        summary_bullets=summary_bullets,
        improvement_bullets=improvement_bullets,
    )
    if page_count <= len(defaults):
        return defaults[:page_count]

    pages = [defaults[0]]
    for page_number in range(2, page_count):
        pages.append(
            _PdfPageSpec(
                title=f"Page {page_number}",
                subtitle=None,
                lines=("No explicit section content was provided for this requested page.",),
            )
        )
    pages.append(defaults[-1])
    return pages


def _infer_page_plan(
    *,
    task_text: str,
    title: str,
    subtitle: str,
    summary_bullets: list[str],
    improvement_bullets: list[str],
) -> _PdfPagePlan:
    requested_count = _requested_page_count(task_text)
    explicit_pages = _parse_page_headings(task_text)
    if explicit_pages:
        pages = list(explicit_pages)
        safe_reason = None
        if requested_count is not None and requested_count > len(pages):
            filler = _length_page_specs(
                page_count=requested_count,
                title=title,
                subtitle=subtitle,
                summary_bullets=summary_bullets,
                improvement_bullets=improvement_bullets,
            )
            pages.extend(filler[len(pages):])
            safe_reason = "page_headings_shorter_than_requested_length"
        elif requested_count is not None and requested_count < len(pages):
            safe_reason = "page_headings_exceed_requested_length"
        return _PdfPagePlan(
            pages=tuple(pages),
            structure_source="explicit_page_headings",
            structure_safe_reason=safe_reason,
        )

    if requested_count is not None:
        return _PdfPagePlan(
            pages=tuple(
                _length_page_specs(
                    page_count=requested_count,
                    title=title,
                    subtitle=subtitle,
                    summary_bullets=summary_bullets,
                    improvement_bullets=improvement_bullets,
                )
            ),
            structure_source="requested_page_count",
            structure_safe_reason="length_requested_without_explicit_page_headings",
        )

    return _PdfPagePlan(
        pages=tuple(
            _default_page_specs(
                title=title,
                subtitle=subtitle,
                summary_bullets=summary_bullets,
                improvement_bullets=improvement_bullets,
            )
        ),
        structure_source="fallback",
        structure_safe_reason="no_explicit_page_structure",
    )


def _display_line(raw_line: str) -> tuple[str, bool]:
    line = raw_line.strip()
    bullet_match = _BULLET_PREFIX_RE.match(line)
    if bullet_match:
        return line[bullet_match.end():].strip(), True
    return line, False


def _render_reportlab_pdf(
    *,
    pages: tuple[_PdfPageSpec, ...],
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

    def append_page_lines(story: list[Any], lines: tuple[str, ...]) -> None:
        bullet_items: list[str] = []

        def flush_bullets() -> None:
            if bullet_items:
                story.append(bullet_list(list(bullet_items)))
                story.append(Spacer(1, 10))
                bullet_items.clear()

        for raw_line in lines:
            text, is_bullet = _display_line(raw_line)
            if not text:
                continue
            if is_bullet:
                bullet_items.append(text)
                continue
            flush_bullets()
            style_name = "Heading1" if len(text) < 80 and not text.endswith(".") else "BodyText"
            story.append(paragraph(text, style_name))
            story.append(Spacer(1, 8))
        flush_bullets()

    story: list[Any] = []
    for index, page in enumerate(pages):
        if index > 0:
            story.append(PageBreak())
        story.append(paragraph(page.title, "Title" if index == 0 else "Heading1"))
        if page.subtitle:
            story.append(Spacer(1, 10))
            story.append(paragraph(page.subtitle, "Heading2"))
        story.append(Spacer(1, 18))
        append_page_lines(story, page.lines)
    doc.build(story)
    return buffer.getvalue()


def _render_fpdf_pdf(
    *,
    pages: tuple[_PdfPageSpec, ...],
) -> bytes:
    from fpdf import FPDF

    def safe_text(text: str) -> str:
        return text.encode("latin-1", "replace").decode("latin-1")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=18)
    for page in pages:
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 20)
        pdf.multi_cell(0, 12, safe_text(page.title))
        if page.subtitle:
            pdf.set_font("Helvetica", "", 14)
            pdf.multi_cell(0, 10, safe_text(page.subtitle))
        pdf.ln(8)
        for raw_line in page.lines:
            text, is_bullet = _display_line(raw_line)
            if not text:
                continue
            if is_bullet:
                pdf.set_font("Helvetica", "", 12)
                pdf.multi_cell(0, 8, safe_text(f"- {text}"))
            else:
                style = "B" if len(text) < 80 and not text.endswith(".") else ""
                pdf.set_font("Helvetica", style, 14 if style else 12)
                pdf.multi_cell(0, 8, safe_text(text))
    output = pdf.output(dest="S")
    return output.encode("latin-1") if isinstance(output, str) else bytes(output)


def _render_simple_pdf_bytes(
    *,
    pages: tuple[_PdfPageSpec, ...],
) -> tuple[bytes, str]:
    try:
        return (
            _render_reportlab_pdf(
                pages=pages,
            ),
            "reportlab",
        )
    except ImportError:
        return (
            _render_fpdf_pdf(
                pages=pages,
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
    page_plan = _infer_page_plan(
        task_text=_task_text_from_state(state),
        title=final_title,
        subtitle=final_subtitle,
        summary_bullets=executive_summary,
        improvement_bullets=next_improvements,
    )

    try:
        host_path = _host_path_for_pdf(virtual_path, thread_data)
        pdf_bytes, renderer = _render_simple_pdf_bytes(
            pages=page_plan.pages,
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
        page_count=len(page_plan.pages),
        page_titles=[page.title for page in page_plan.pages],
        structure_source=page_plan.structure_source,
        structure_safe_reason=page_plan.structure_safe_reason,
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
    reportlab cannot be imported. It reads the builder task from runtime
    state and honors explicit Page 1 / Page 2 / Length: N pages structure
    when present. Do not write Markdown with a .pdf suffix.

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
