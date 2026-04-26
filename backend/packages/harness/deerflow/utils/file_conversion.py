"""File conversion utilities.

Converts document files (PDF, PPT, Excel, Word) to Markdown using markitdown.
No FastAPI or HTTP dependencies — pure utility functions.
"""

import asyncio
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# File extensions that should be converted to markdown
CONVERTIBLE_EXTENSIONS = {
    ".pdf",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".doc",
    ".docx",
}


async def convert_file_to_markdown(file_path: Path) -> Path | None:
    """Convert a file to markdown using markitdown.

    Args:
        file_path: Path to the file to convert.

    Returns:
        Path to the markdown file if conversion was successful, None otherwise.
    """
    try:
        from markitdown import MarkItDown

        md = MarkItDown()
        result = md.convert(str(file_path))

        # Save as .md file with same name
        md_path = file_path.with_suffix(".md")
        md_path.write_text(result.text_content, encoding="utf-8")

        logger.info(f"Converted {file_path.name} to markdown: {md_path.name}")
        return md_path
    except Exception as e:
        logger.error(f"Failed to convert {file_path.name} to markdown: {e}")
        return None


async def convert_bytes_to_markdown_text(content: bytes, *, filename: str) -> str | None:
    """Convert raw bytes (e.g. from a channel attachment) to markdown text.

    Writes the bytes to a per-call tempdir under their original filename so
    markitdown can route to the correct extension-specific converter, then
    runs the synchronous ``MarkItDown.convert`` on a worker thread to avoid
    blocking the dispatch loop. Returns the extracted text, or ``None`` if
    markitdown is unavailable, raises, or yields empty content. The tempdir
    is removed on context exit (success or failure).
    """

    def _run() -> str | None:
        try:
            from markitdown import MarkItDown
        except Exception:
            logger.exception("markitdown not available")
            return None
        with tempfile.TemporaryDirectory(prefix="dfattach_") as tmp:
            target = Path(tmp) / (Path(filename).name or "attachment.bin")
            try:
                target.write_bytes(content)
            except OSError:
                logger.exception("failed writing attachment bytes for %s", filename)
                return None
            try:
                result = MarkItDown().convert(str(target))
            except Exception:
                logger.exception("markitdown failed for %s", filename)
                return None
            text = (getattr(result, "text_content", "") or "").strip()
            return text or None

    return await asyncio.to_thread(_run)
