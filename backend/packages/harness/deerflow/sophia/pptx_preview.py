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
import os
import shutil
import stat
import subprocess  # noqa: S404 — invoking soffice by absolute path
import tempfile
from pathlib import Path

from deerflow.sophia.process_group import run_process_group

logger = logging.getLogger(__name__)

_SOFFICE_TIMEOUT_SECONDS = 300
PREVIEW_SUFFIX = ".preview.pdf"


def preview_path_for(pptx_path: Path) -> Path:
    """Return the canonical preview sibling path for a deck.

    ``deck.pptx`` → ``deck.preview.pdf`` (NOT ``deck.pdf``: a build may
    legitimately produce both a deck and a same-stem PDF deliverable).
    """
    return pptx_path.with_name(pptx_path.stem + PREVIEW_SUFFIX)


def soffice_available() -> bool:
    return shutil.which("soffice") is not None


def _stage_regular_file(source: Path, target: Path) -> None:
    """Copy one stable, single-link source without following its final path."""

    source_lstat = source.lstat()
    if (
        not stat.S_ISREG(source_lstat.st_mode)
        or source_lstat.st_nlink != 1
    ):
        raise OSError("preview source is not a single-link regular file")
    read_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    read_flags |= getattr(os, "O_NOFOLLOW", 0)
    source_fd = os.open(source, read_flags)
    target_fd: int | None = None
    try:
        before = os.fstat(source_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or (before.st_dev, before.st_ino)
            != (source_lstat.st_dev, source_lstat.st_ino)
        ):
            raise OSError("preview source changed before staging")
        write_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        target_fd = os.open(target, write_flags, 0o600)
        with os.fdopen(source_fd, "rb", closefd=False) as source_stream:
            with os.fdopen(target_fd, "wb", closefd=False) as target_stream:
                shutil.copyfileobj(source_stream, target_stream)
                target_stream.flush()
        after = os.fstat(source_fd)
        staged = os.fstat(target_fd)
        stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        if (
            any(getattr(before, field) != getattr(after, field) for field in stable_fields)
            or staged.st_size != before.st_size
        ):
            raise OSError("preview source changed while staging")
    finally:
        os.close(source_fd)
        if target_fd is not None:
            os.close(target_fd)


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
        # deliverable in outputs/. Stage the source in that private workdir as
        # well: DQ-1 materializations live below a root-owned 0700 temp root,
        # which the isolated LibreOffice UID must not be allowed to traverse.
        timeout = max(1, min(_SOFFICE_TIMEOUT_SECONDS, int(timeout_seconds or _SOFFICE_TIMEOUT_SECONDS)))
        with tempfile.TemporaryDirectory(prefix="pptx-preview-") as tmp_dir:
            staged_source = Path(tmp_dir) / "source.pptx"
            _stage_regular_file(pptx_path, staged_source)
            completed = run_process_group(
                [
                    soffice,
                    "--headless",
                    "--norestore",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    tmp_dir,
                    str(staged_source),
                ],
                timeout=timeout,
                private_read_dirs=[staged_source],
                writable_dirs=[tmp_dir],
                identity_paths=[pptx_path],
            )
            produced = Path(tmp_dir) / "source.pdf"
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
