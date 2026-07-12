"""PPTX → PDF canvas-preview rendering via headless LibreOffice.

The webapp has no native PPTX renderer (``.pptx`` is download-only in the
artifact canvas), so a finished deck used to surface as a metadata
placeholder when the user clicked "review in canvas". This module renders a
``<deck>.preview.pdf`` sibling next to the emitted ``.pptx`` so the existing
PDF canvas (paging, zoom, page rail, voice page commands) can display the
deck while the download button still serves the original PowerPoint file.

Deployment requirement:
    ``soffice`` (LibreOffice Impress) must be on PATH. On Debian/Ubuntu
    containers: ``apt-get install -y libreoffice-impress``. When soffice is
    absent the preview is skipped silently and the canvas falls back to the
    download-only card — never fail the build over a preview.
"""

from __future__ import annotations

import logging
import shutil
import subprocess  # noqa: S404 — invoking soffice by absolute path
import tempfile
from pathlib import Path

from deerflow.sophia.process_group import run_process_group

logger = logging.getLogger(__name__)

_SOFFICE_TIMEOUT_SECONDS = 120
PREVIEW_SUFFIX = ".preview.pdf"


def preview_path_for(pptx_path: Path) -> Path:
    """Return the canonical preview sibling path for a deck.

    ``deck.pptx`` → ``deck.preview.pdf`` (NOT ``deck.pdf``: a build may
    legitimately produce both a deck and a same-stem PDF deliverable).
    """
    return pptx_path.with_name(pptx_path.stem + PREVIEW_SUFFIX)


def soffice_available() -> bool:
    return shutil.which("soffice") is not None


def maybe_render_pptx_preview(
    pptx_path: Path,
    *,
    timeout_seconds: int | None = None,
) -> Path | None:
    """Best-effort render of a PDF preview for ``pptx_path``.

    Returns the preview path on success, ``None`` on any failure. Never
    raises — preview generation must not affect build completion.
    """
    try:
        if not pptx_path.is_file():
            return None
        soffice = shutil.which("soffice")
        if soffice is None:
            logger.info(
                "[PptxPreview] soffice not on PATH — skipping canvas preview "
                "for %s (install libreoffice-impress to enable)",
                pptx_path.name,
            )
            return None
        target = preview_path_for(pptx_path)
        # LibreOffice writes <stem>.pdf into --outdir; convert in a temp dir
        # and move into place so we never clobber a legitimate <stem>.pdf
        # deliverable in outputs/.
        timeout = max(1, min(_SOFFICE_TIMEOUT_SECONDS, int(timeout_seconds or _SOFFICE_TIMEOUT_SECONDS)))
        with tempfile.TemporaryDirectory(prefix="pptx-preview-") as tmp_dir:
            completed = run_process_group(
                [
                    soffice,
                    "--headless",
                    "--norestore",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    tmp_dir,
                    str(pptx_path),
                ],
                timeout=timeout,
            )
            produced = Path(tmp_dir) / (pptx_path.stem + ".pdf")
            if completed.returncode != 0 or not produced.is_file():
                logger.warning(
                    "[PptxPreview] conversion failed returncode=%s stderr=%s",
                    completed.returncode,
                    (completed.stderr or "").strip()[:500],
                )
                return None
            shutil.move(str(produced), str(target))
        size = target.stat().st_size
        if size <= 0:
            target.unlink(missing_ok=True)
            return None
        logger.info(
            "[PptxPreview] rendered canvas preview %s bytes=%d",
            target.name,
            size,
        )
        return target
    except subprocess.TimeoutExpired:
        logger.warning(
            "[PptxPreview] conversion timed out for %s",
            pptx_path.name,
        )
        return None
    except Exception:  # noqa: BLE001 — preview is strictly best-effort
        logger.warning("[PptxPreview] unexpected failure", exc_info=True)
        return None
