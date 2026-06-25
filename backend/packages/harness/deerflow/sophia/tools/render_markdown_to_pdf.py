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
import re
import shutil
import subprocess  # noqa: S404 — invoking pandoc by absolute path
from datetime import date
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

# Vendored pandoc LaTeX template (pandoc 2.17.1.1 default.latex + guarded
# Sophia customizations). The tool runs IN-PROCESS in the langgraph
# container, so a package-relative path is valid at runtime.
_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets" / "sophia.latex"

# Named themes — every variable is also $if$-guarded in the template, so a
# partial or absent set never breaks compilation. Colors and fonts are
# compiled from skills/public/sophia/brand/tokens.md. The brand fonts are
# TeX Gyre (texlive-fonts-extra); the template guards each with
# \IfFontExistsTF and falls back to Latin Modern, so an image without
# texlive-fonts-extra still renders.
#
#   ink #1F2A37 · body #3A4658 · muted #6B7787 · surface #F5F7FA
#   line #E3E8EF · blue #2E5AAC · teal #2A9D8F
_BRAND_HEADINGFONT = "TeX Gyre Heros"      # sans, headings
_BRAND_BODYFONT = "TeX Gyre Pagella"       # serif, body
_BRAND_MONOFONT = "TeX Gyre Cursor"        # mono
_PDF_THEMES: dict[str, dict[str, str]] = {
    "boardroom": {
        "accentcolor": "2E5AAC",
        "headingcolor": "1F2A37",
        "titlepagecolor": "1F2A37",
        "titlepagetextcolor": "F5F7FA",
        "mainfont": _BRAND_BODYFONT,
        "sansfont": _BRAND_HEADINGFONT,
        "monofont": _BRAND_MONOFONT,
    },
    "minimal": {
        "accentcolor": "2E5AAC",
        "headingcolor": "1F2A37",
        "titlepagecolor": "F5F7FA",
        "titlepagetextcolor": "1F2A37",
        "mainfont": _BRAND_BODYFONT,
        "sansfont": _BRAND_HEADINGFONT,
        "monofont": _BRAND_MONOFONT,
    },
    "warm": {
        "accentcolor": "2A9D8F",
        "headingcolor": "1F2A37",
        "titlepagecolor": "F5F7FA",
        "titlepagetextcolor": "1F2A37",
        "mainfont": _BRAND_BODYFONT,
        "sansfont": _BRAND_HEADINGFONT,
        "monofont": _BRAND_MONOFONT,
    },
}
_DEFAULT_PDF_THEME = "minimal"

# Documents longer than this (word count of the Markdown source) get an
# automatic --toc --toc-depth=2.
_TOC_WORD_THRESHOLD = 3500

# Frontmatter keys the cheap parser extracts (theme + cover-page fields).
_FRONTMATTER_KEYS = {
    "title",
    "subtitle",
    "author",
    "date",
    "sophia-theme",
    "sophia-cover",
    "coverimage",
    "cover-image",
    "cover_image",
}


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


def _pdf_object(value: Any) -> Any:
    getter = getattr(value, "get_object", None)
    if callable(getter):
        try:
            return getter()
        except Exception:  # noqa: BLE001
            return value
    return value


def _page_image_count(page: Any) -> int:
    try:
        images = getattr(page, "images", None)
        if images:
            return len(images)
    except Exception:  # noqa: BLE001
        pass

    try:
        resources = _pdf_object(page.get("/Resources", {}))
        xobjects = _pdf_object(resources.get("/XObject", {})) if hasattr(resources, "get") else {}
    except Exception:  # noqa: BLE001
        return 0

    count = 0
    if hasattr(xobjects, "values"):
        for item in xobjects.values():
            xobject = _pdf_object(item)
            subtype = xobject.get("/Subtype") if hasattr(xobject, "get") else None
            if subtype == "/Image":
                count += 1
            elif subtype == "/Form":
                count += _page_image_count(xobject)
    return count


def _layout_quality(
    page_count: int,
    blank_count: int,
    short_count: int,
    *,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> tuple[str, str | None]:
    if page_count <= 0:
        return "unknown", "pdf_layout_unreadable"
    if blank_count >= page_count:
        return "unusable", "all_pages_blank"
    if blank_count > 0:
        return "warning", "blank_pages_detected"
    if requested_pages is not None and page_count != requested_pages:
        return "warning", "page_count_off_target"
    if requested_min_pages is not None and page_count < requested_min_pages:
        return "warning", "page_count_off_target"
    if requested_max_pages is not None and page_count > requested_max_pages:
        return "warning", "page_count_off_target"
    if page_count > _DEFAULT_MAX_PAGES and short_count > 0:
        return "warning", "sparse_long_pdf"
    return "ok", None


def _inspect_pdf_layout(
    pdf_file: Path,
    *,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> dict[str, int | str | None]:
    if PdfReader is None:
        return {
            "page_count": 0,
            "blank_page_count": 0,
            "short_page_count": 0,
            "image_count": 0,
            "layout_quality": "unknown",
            "layout_warning": "pypdf_unavailable",
            "requested_page_count": requested_pages,
            "requested_min_pages": requested_min_pages,
            "requested_max_pages": requested_max_pages,
        }
    try:
        reader = PdfReader(str(pdf_file))
        counts = [_page_word_count(page) for page in reader.pages]
        image_count = sum(_page_image_count(page) for page in reader.pages)
    except Exception:  # noqa: BLE001
        logger.warning("render_markdown_to_pdf: layout_inspection_failed", exc_info=True)
        return {
            "page_count": 0,
            "blank_page_count": 0,
            "short_page_count": 0,
            "image_count": 0,
            "layout_quality": "unknown",
            "layout_warning": "pdf_layout_unreadable",
            "requested_page_count": requested_pages,
            "requested_min_pages": requested_min_pages,
            "requested_max_pages": requested_max_pages,
        }
    page_count = len(counts)
    blank_count = sum(1 for count in counts if count <= 1)
    short_count = sum(1 for count in counts if 1 < count < _SHORT_PAGE_WORD_THRESHOLD)
    quality, warning = _layout_quality(
        page_count,
        blank_count,
        short_count,
        requested_pages=requested_pages,
        requested_min_pages=requested_min_pages,
        requested_max_pages=requested_max_pages,
    )
    return {
        "page_count": page_count,
        "blank_page_count": blank_count,
        "short_page_count": short_count,
        "image_count": image_count,
        "layout_quality": quality,
        "layout_warning": warning,
        "requested_page_count": requested_pages,
        "requested_min_pages": requested_min_pages,
        "requested_max_pages": requested_max_pages,
    }


def _inspect_pdf_layout_with_targets(
    pdf_file: Path,
    *,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> dict[str, int | str | None]:
    try:
        return _inspect_pdf_layout(
            pdf_file,
            requested_pages=requested_pages,
            requested_min_pages=requested_min_pages,
            requested_max_pages=requested_max_pages,
        )
    except TypeError:
        # Some tests and older embedders monkeypatch _inspect_pdf_layout with
        # the historical one-arg callable. Preserve compatibility and still
        # attach page-target fields to the payload.
        layout = dict(_inspect_pdf_layout(pdf_file))
        layout.setdefault("requested_page_count", requested_pages)
        layout.setdefault("requested_min_pages", requested_min_pages)
        layout.setdefault("requested_max_pages", requested_max_pages)
        page_count = layout.get("page_count")
        blank_count = layout.get("blank_page_count")
        short_count = layout.get("short_page_count")
        if isinstance(page_count, int) and isinstance(blank_count, int) and isinstance(short_count, int):
            quality, warning = _layout_quality(
                page_count,
                blank_count,
                short_count,
                requested_pages=requested_pages,
                requested_min_pages=requested_min_pages,
                requested_max_pages=requested_max_pages,
            )
            if warning == "page_count_off_target":
                layout["layout_quality"] = quality
                layout["layout_warning"] = warning
        return layout


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


def _resolve_pdf_template() -> Path | None:
    """Return the vendored template path, or None (with a warning) if absent.

    None means "render with pandoc's built-in default template" — the exact
    pre-template behavior — so a packaging mistake degrades styling, never
    deliverability.
    """
    if _TEMPLATE_PATH.is_file():
        return _TEMPLATE_PATH
    logger.warning(
        "render_markdown_to_pdf: template_missing path=%s; rendering with pandoc's default template",
        _TEMPLATE_PATH,
    )
    return None


def _frontmatter_meta(md_file: Path) -> dict[str, str]:
    """Cheap line-based parse of a leading ``---`` YAML block.

    Only flat ``key: value`` lines are read (no yaml dependency, no nested
    structures). Returns {} when there is no well-formed leading block.
    """
    try:
        text = md_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta: dict[str, str] = {}
    for line in lines[1:200]:
        stripped = line.strip()
        if stripped in {"---", "..."}:
            return meta
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip().strip("\"'")
        if key in _FRONTMATTER_KEYS and value:
            meta[key] = value
    # No closing fence — not a frontmatter block.
    return {}


def _resolve_theme_name(theme_param: str | None, meta: dict[str, str]) -> str:
    """Resolve the theme: explicit param → frontmatter sophia-theme → default.

    Unknown names fall back to the default with a warning — never an error.
    """
    candidate = (theme_param or meta.get("sophia-theme") or _DEFAULT_PDF_THEME).strip().lower()
    if candidate not in _PDF_THEMES:
        logger.warning(
            "render_markdown_to_pdf: unknown_theme %r; falling back to %r",
            candidate,
            _DEFAULT_PDF_THEME,
        )
        return _DEFAULT_PDF_THEME
    return candidate


def _cover_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _source_ref_host_paths(
    refs: list[str],
    *,
    md_file: Path,
    thread_data: dict[str, Any] | None,
) -> set[Path]:
    outputs_path = (thread_data or {}).get("outputs_path")
    outputs_root = Path(outputs_path).resolve() if isinstance(outputs_path, str) and outputs_path else None
    paths: set[Path] = set()
    for raw_ref in refs:
        ref = raw_ref.strip().strip("\"'")
        if not ref or ref.startswith(("http://", "https://", "data:")):
            continue
        if ref.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            paths.add(_host_path_for_virtual_output(ref, thread_data).resolve())
            continue
        candidate = Path(ref)
        if candidate.is_absolute():
            paths.add(candidate.resolve())
            continue
        paths.add((md_file.parent / candidate).resolve())
        if outputs_root is not None:
            paths.add((outputs_root / candidate).resolve())
    return paths


def _cover_frontmatter_refs(meta: dict[str, str]) -> list[str]:
    refs: list[str] = []
    for key in ("sophia-cover", "coverimage", "cover-image", "cover_image"):
        value = meta.get(key)
        if value:
            refs.append(value)
    return refs


def _cover_image_path(md_file: Path, thread_data: dict[str, Any] | None, meta: dict[str, str]) -> Path | None:
    """Current-source generated cover graphic under outputs/visuals.

    VQ-5: the image-generation skill writes PDF covers as
    ``visuals/cover-<desc>.png``; when one exists it rides the title page via
    the template's ``$coverimage$`` hook. The cover must be tied to this
    source, either by Markdown/frontmatter reference or by source-stem slug.
    Best-effort — any error means no cover, never a failed render.
    """
    outputs_path = (thread_data or {}).get("outputs_path")
    if not isinstance(outputs_path, str) or not outputs_path:
        return None
    try:
        visuals = Path(outputs_path) / "visuals"
        candidates = sorted(
            (p for p in visuals.glob("cover-*.png") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return None
    if not candidates:
        return None

    referenced_paths = _source_ref_host_paths(
        [*_source_image_refs(md_file), *_cover_frontmatter_refs(meta)],
        md_file=md_file,
        thread_data=thread_data,
    )
    for candidate in candidates:
        if candidate.resolve() in referenced_paths:
            return candidate

    source_slug = _cover_slug(md_file.stem)
    for candidate in candidates:
        if _cover_slug(candidate.stem.removeprefix("cover-")) == source_slug:
            return candidate
    return None


def _theme_variables(theme_name: str, meta: dict[str, str]) -> list[str]:
    """Build the ``-V key=value`` pandoc arguments for a theme.

    Frontmatter wins by pandoc semantics anyway (metadata overrides -V), but
    we only inject author/date when absent so we never even compete. The
    cover page is requested only when the document has a title.
    """
    theme = _PDF_THEMES.get(theme_name, _PDF_THEMES[_DEFAULT_PDF_THEME])
    variables: list[str] = []
    for key, value in theme.items():
        variables += ["-V", f"{key}={value}"]
    if meta.get("title"):
        variables += ["-V", "titlepage=true"]
    if not meta.get("author"):
        variables += ["-V", "author=Sophia"]
    if not meta.get("date"):
        variables += ["-V", f"date={date.today().isoformat()}"]
    return variables


def _source_word_count(md_file: Path) -> int:
    try:
        text = md_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    return len(text.split())


def _pandoc_command(
    *,
    pandoc_bin: str,
    markdown_path: str,
    pdf_path: str,
    md_file: Path,
    pdf_file: Path,
    engine: str | None,
    resource_dirs: list[Path] | None = None,
    template_path: Path | None = None,
    extra_vars: list[str] | None = None,
    toc: bool = False,
) -> tuple[list[str], list[str]]:
    source_format = "html" if md_file.suffix.lower() in {".html", ".htm"} else "markdown+smart+yaml_metadata_block"
    cmd = [
        pandoc_bin,
        "--standalone",
        f"--from={source_format}",
        str(md_file),
        "-o",
        str(pdf_file),
    ]
    public_cmd = [
        "--standalone",
        f"--from={source_format}",
        markdown_path,
        "-o",
        pdf_path,
    ]
    if resource_dirs:
        # Pandoc resolves relative image refs against the resource path, NOT
        # the input file's directory. Without this, the workflow-card-prescribed
        # `![Diagram](visuals/diagram.png)` silently drops the image (pandoc
        # warns on stderr but exits 0) and the PDF ships text-only.
        resource_path = ":".join(str(d) for d in resource_dirs)
        cmd.append(f"--resource-path={resource_path}")
        public_cmd.append("--resource-path=<outputs>")
    if engine is not None:
        cmd.append(f"--pdf-engine={engine}")
        public_cmd.append(f"--pdf-engine={engine}")
    if template_path is not None:
        cmd.append(f"--template={template_path}")
        public_cmd.append(f"--template={template_path.name}")
    if extra_vars:
        cmd.extend(extra_vars)
        public_cmd.extend(extra_vars)
    if toc:
        cmd.extend(["--toc", "--toc-depth=2"])
        public_cmd.extend(["--toc", "--toc-depth=2"])
    return cmd, public_cmd


def _run_pandoc(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str] | str:
    try:
        return subprocess.run(  # noqa: S603 — pandoc binary path is from shutil.which
            cmd,
            capture_output=True,
            text=True,
            timeout=_PANDOC_TIMEOUT_SECONDS,
            check=False,
            cwd=str(cwd) if cwd is not None else None,
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


def _rewrite_virtual_image_refs(md_file: Path, thread_data: dict[str, Any] | None) -> Path:
    if thread_data is None:
        return md_file
    outputs_path = thread_data.get("outputs_path")
    if not isinstance(outputs_path, str) or not outputs_path:
        return md_file
    try:
        text = md_file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = md_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return md_file

    rewritten = text.replace(_OUTPUTS_VIRTUAL_PREFIX, f"{Path(outputs_path).resolve().as_posix()}/")
    if rewritten == text:
        return md_file
    normalized = md_file.with_name(f".{md_file.stem}.pandoc{md_file.suffix}")
    normalized.write_text(rewritten, encoding="utf-8")
    return normalized


_IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)", re.MULTILINE)
_HTML_IMAGE_REF_RE = re.compile(r"<img[^>]+src=[\"']([^\"']+)", re.IGNORECASE)
_MISSING_RESOURCE_RE = re.compile(r"Could not fetch resource ['\"]?([^'\":\n]+)", re.IGNORECASE)


def _source_image_refs(md_file: Path) -> list[str]:
    """Image references declared in the source (markdown + inline HTML)."""
    try:
        text = md_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    refs = _IMAGE_REF_RE.findall(text) + _HTML_IMAGE_REF_RE.findall(text)
    return [ref for ref in refs if ref.strip()]


def _missing_resources_from_stderr(stderr: str) -> list[str]:
    return sorted({match.strip() for match in _MISSING_RESOURCE_RE.findall(stderr or "")})


def _pdf_success_result(
    *,
    pdf_path: str,
    pdf_file: Path,
    engine: str | None,
    engine_msg: str,
    source_image_ref_count: int = 0,
    missing_resources: list[str] | None = None,
    thread_data: dict[str, Any] | None = None,
    template_used: bool = False,
    theme: str | None = None,
    template_fallback: bool = False,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> str:
    size_bytes = _pdf_size(pdf_file)
    layout = _inspect_pdf_layout_with_targets(
        pdf_file,
        requested_pages=requested_pages,
        requested_min_pages=requested_min_pages,
        requested_max_pages=requested_max_pages,
    )
    images_missing = source_image_ref_count > 0 and int(layout.get("image_count") or 0) == 0
    masked_missing = [
        _mask_local_output(item, thread_data) for item in (missing_resources or [])
    ]
    logger.info(
        "render_markdown_to_pdf: render_success selected_engine=%s "
        "final_artifact_ext=%s size_bytes=%s page_count=%s "
        "blank_page_count=%s short_page_count=%s image_count=%s "
        "source_image_ref_count=%s images_missing=%s missing_resources=%s "
        "layout_quality=%s layout_warning=%s requested_pages=%s requested_min_pages=%s requested_max_pages=%s "
        "template_used=%s theme=%s template_fallback=%s",
        engine or "pandoc_default",
        pdf_file.suffix.lower().lstrip(".") or "unknown",
        size_bytes,
        layout.get("page_count"),
        layout.get("blank_page_count"),
        layout.get("short_page_count"),
        layout.get("image_count"),
        source_image_ref_count,
        images_missing,
        ",".join(masked_missing) or "none",
        layout.get("layout_quality"),
        layout.get("layout_warning"),
        layout.get("requested_page_count"),
        layout.get("requested_min_pages"),
        layout.get("requested_max_pages"),
        template_used,
        theme,
        template_fallback,
    )
    extra: dict[str, Any] = {
        "source_image_ref_count": source_image_ref_count,
        "images_missing": images_missing,
    }
    if masked_missing:
        extra["missing_resources"] = masked_missing
    if images_missing:
        extra["images_missing_hint"] = (
            "The source references images but none were embedded in the PDF. "
            "Verify the image paths exist under /mnt/user-data/outputs/ and "
            "re-render before emitting."
        )
    # Missing / dead image references become a layout warning so the builder
    # spends one bounded repair turn fixing them (regenerate or drop the dead
    # ref) before emit — never ship a report with a broken/empty figure.
    if (images_missing or masked_missing) and layout.get("layout_quality") in {"ok", None, "unknown"}:
        layout["layout_quality"] = "warning"
        layout["layout_warning"] = "images_missing" if images_missing else "missing_image_resources"
    return _result(
        success=True,
        pdf_path=pdf_path,
        size_bytes=size_bytes,
        engine=engine or "default",
        engine_message=engine_msg,
        template_used=template_used,
        theme=theme,
        template_fallback=template_fallback,
        **layout,
        **extra,
    )


def _impl(
    markdown_path: str,
    pdf_path: str,
    pdf_engine: str | None,
    thread_data: dict[str, Any] | None = None,
    theme: str | None = None,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> str:
    """Concrete pandoc invocation. Tested independently of the @tool wrapper."""
    # ---- Path validation -----------------------------------------------
    path_error = _path_validation_error(markdown_path, pdf_path)
    if path_error is not None:
        return _result(success=False, error=path_error, error_type="invalid_input")

    md_file = _host_path_for_virtual_output(markdown_path, thread_data)
    if not md_file.is_file():
        return _missing_markdown_result(markdown_path)
    pandoc_source_file = _rewrite_virtual_image_refs(md_file, thread_data)

    # ---- Pandoc availability --------------------------------------------
    pandoc_bin = shutil.which("pandoc")
    if pandoc_bin is None:
        return _pandoc_missing_result()

    engine, engine_msg = _resolve_pdf_engine(pdf_engine)
    _log_pandoc_capability(engine, engine_msg)

    pdf_file = _host_path_for_virtual_output(pdf_path, thread_data)
    pdf_file.parent.mkdir(parents=True, exist_ok=True)

    # Relative image refs (e.g. ``visuals/diagram.png``) must resolve against
    # the source file's directory and the outputs root — pandoc resolves them
    # against the resource path / cwd, not the input file location.
    source_dir = md_file.parent
    resource_dirs = [source_dir]
    outputs_path = (thread_data or {}).get("outputs_path")
    if isinstance(outputs_path, str) and outputs_path:
        outputs_root = Path(outputs_path).resolve()
        if outputs_root != source_dir:
            resource_dirs.append(outputs_root)

    # ---- Template + theme -------------------------------------------------
    # The vendored template is best-effort: when missing we render exactly
    # the pre-template command (no vars, no toc). Theme resolution never
    # errors — unknown names fall back to the default theme.
    template_path = _resolve_pdf_template()
    theme_name: str | None = None
    extra_vars: list[str] = []
    toc = False
    if template_path is not None:
        meta = _frontmatter_meta(md_file)
        theme_name = _resolve_theme_name(theme, meta)
        extra_vars = _theme_variables(theme_name, meta)
        toc = _source_word_count(md_file) > _TOC_WORD_THRESHOLD
        cover = _cover_image_path(md_file, thread_data, meta)
        if cover is not None:
            # VQ-5: generated cover graphic on the title page. Forces the
            # titlepage on — a cover image without a cover page is invisible.
            extra_vars.extend(["-V", f"coverimage={cover.as_posix()}"])
            if "titlepage=true" not in " ".join(extra_vars):
                extra_vars.extend(["-V", "titlepage=true"])

    # ---- Invocation -----------------------------------------------------
    cmd, public_cmd = _pandoc_command(
        pandoc_bin=pandoc_bin,
        markdown_path=markdown_path,
        pdf_path=pdf_path,
        md_file=pandoc_source_file,
        pdf_file=pdf_file,
        engine=engine,
        resource_dirs=resource_dirs,
        template_path=template_path,
        extra_vars=extra_vars,
        toc=toc,
    )
    completed = _run_pandoc(cmd, cwd=source_dir)
    if isinstance(completed, str):
        return completed

    template_used = template_path is not None
    template_fallback = False
    if completed.returncode != 0 and template_path is not None:
        # A template-induced failure must never make rendering worse than
        # the pre-template baseline: retry ONCE with today's exact plain
        # command (no template, no theme vars, no toc).
        logger.warning(
            "render_markdown_to_pdf: template_render_failed returncode=%s theme=%s; retrying once without template",
            completed.returncode,
            theme_name,
        )
        cmd, public_cmd = _pandoc_command(
            pandoc_bin=pandoc_bin,
            markdown_path=markdown_path,
            pdf_path=pdf_path,
            md_file=pandoc_source_file,
            pdf_file=pdf_file,
            engine=engine,
            resource_dirs=resource_dirs,
        )
        completed = _run_pandoc(cmd, cwd=source_dir)
        if isinstance(completed, str):
            return completed
        template_used = False
        template_fallback = completed.returncode == 0

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
        source_image_ref_count=len(_source_image_refs(pandoc_source_file)),
        missing_resources=_missing_resources_from_stderr(completed.stderr),
        thread_data=thread_data,
        template_used=template_used,
        theme=theme_name if template_used else None,
        template_fallback=template_fallback,
        requested_pages=requested_pages,
        requested_min_pages=requested_min_pages,
        requested_max_pages=requested_max_pages,
    )


@tool("render_markdown_to_pdf", parse_docstring=True)
def render_markdown_to_pdf(
    runtime: ToolRuntime,
    markdown_path: str,
    pdf_path: str,
    pdf_engine: str | None = None,
    theme: str | None = None,
    requested_pages: int | None = None,
    requested_min_pages: int | None = None,
    requested_max_pages: int | None = None,
) -> str:
    """Convert a Markdown file to a PDF using pandoc.

    Use this for any PDF deliverable. Compose your Markdown source first
    (writing it via write_file_tool) — including image embeds for charts
    you generated with the chart-visualization skill — then call this
    tool to produce the PDF. Both paths must be under
    ``/mnt/user-data/outputs/``.

    Rendering uses a styled template with named themes. Adding ``title:``
    (and optionally ``subtitle:``) YAML frontmatter to the source produces
    a colored cover page; a table of contents is added automatically for
    long documents.

    DO NOT write your own ``_generate_*.py`` script using matplotlib or
    reportlab to produce a PDF. That pattern is unreliable. This tool
    encapsulates a known-working pipeline.

    On success, returns a JSON object with ``success: true``, the PDF path,
    and safe layout metrics (page_count, blank_page_count,
    short_page_count, layout_quality). If the user requested an exact
    or ranged page count, pass requested_pages or requested_min_pages /
    requested_max_pages so page_count_off_target can trigger one repair.
    After success, call
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
        theme: Optional visual theme, one of boardroom (navy/serif, formal
            reports), minimal (slate/sans, the default), or warm
            (terracotta, personal documents). Can also be set with a
            sophia-theme key in the source's YAML frontmatter; this
            parameter wins when both are present.
        requested_pages: Exact page count requested by the user, when any.
        requested_min_pages: Lower bound for a requested page range, when any.
        requested_max_pages: Upper bound for a requested page range, when any.
    """
    return _impl(
        markdown_path=markdown_path,
        pdf_path=pdf_path,
        pdf_engine=pdf_engine,
        thread_data=get_thread_data(runtime),
        theme=theme,
        requested_pages=requested_pages,
        requested_min_pages=requested_min_pages,
        requested_max_pages=requested_max_pages,
    )
