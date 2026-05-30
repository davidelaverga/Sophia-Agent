"""read_user_document — thread-scoped text reader for the companion.

Counterpart to ``view_user_image``: handles the non-vision side of the
spec §6 routing rule (images → vision, documents → text). Reads either
a bare text file (``.md`` / ``.txt`` / ``.csv`` / ``.json`` / ...) or
runs ``markitdown`` to extract text from common document formats
(PDF / DOCX / PPTX / XLSX / etc.).

Vision-via-OCR is intentionally NOT the path here — vision models
hallucinate small text. For any document the user wants summarized,
quoted, or reasoned about, the companion reads the text directly.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

from deerflow.config.paths import get_paths
from deerflow.utils.file_conversion import (
    CONVERTIBLE_EXTENSIONS,
    convert_file_to_markdown,
)

# Same circular-import dodge as ``start_builder_task.py`` /
# ``view_user_image.py`` — see those modules for the rationale.
if TYPE_CHECKING:
    from deerflow.agents.thread_state import ThreadState
else:
    ThreadState = dict

logger = logging.getLogger(__name__)


# Files we read directly as UTF-8 text without running markitdown.
_DIRECT_TEXT_EXTENSIONS: frozenset[str] = frozenset(
    {".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml"}
)

# Max bytes returned to the model — bounded so a giant CSV doesn't blow
# the context window. The companion can re-request a different file if
# truncated content isn't enough.
_MAX_BYTES_RETURNED = 64_000

# Same search order as view_user_image: uploads first, then outputs.
_SEARCH_ROOT_NAMES: tuple[str, ...] = ("uploads", "outputs")


# Strict prompt-safe / path-safe filename allow-list. Mirrors
# ``view_user_image._SAFE_IMAGE_FILENAME`` and the builder-side
# ``start_builder_task._TRUSTED_ATTACHMENT_FILENAME``. Codex P2 PR #132:
# the loose guard (separators + dotfiles only) let an embedded NUL or
# other control char through (e.g. the model copies ``report<NUL>.pdf``
# from user text). ``_resolve_document_path`` then calls
# ``candidate.is_file()``, and Python raises ``ValueError: embedded null
# byte`` — an uncaught exception that aborts the whole turn instead of
# returning a clean tool error. Restricting to ``[A-Za-z0-9._-]`` rejects
# NUL, control bytes, whitespace, separators, and markup before any Path
# is constructed.
_SAFE_DOCUMENT_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _is_safe_filename(filename: str) -> bool:
    """Reject path-traversal, control-character, and markup filenames.

    A name is safe only when it matches the strict allow-list
    ``[A-Za-z0-9._-]+`` and is not a hidden file / ``.`` / ``..``. The
    allow-list inherently rejects path separators, NUL / control bytes,
    whitespace, and markup — see ``_SAFE_DOCUMENT_FILENAME``.
    """
    if not filename or filename in {".", ".."}:
        return False
    if filename.startswith("."):
        return False
    return bool(_SAFE_DOCUMENT_FILENAME.match(filename))


def _resolve_thread_id(runtime: ToolRuntime[ContextT, ThreadState] | None) -> str | None:
    """Resolve thread_id from runtime context/configurable.

    Mirrors the resolution pattern in ``start_builder_task._resolve_thread_id``
    so behaviour is consistent with the rest of the companion tooling.
    """
    if runtime is None:
        return None
    if runtime.context:
        candidate = runtime.context.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    if runtime.config:
        configurable = runtime.config.get("configurable", {})
        candidate = configurable.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _resolve_document_path(thread_id: str, filename: str) -> Path | None:
    """Find ``filename`` in this thread's uploads then outputs dir."""
    paths = get_paths()
    for root_name in _SEARCH_ROOT_NAMES:
        if root_name == "uploads":
            candidate = paths.sandbox_uploads_dir(thread_id) / filename
        else:
            candidate = paths.sandbox_outputs_dir(thread_id) / filename
        if candidate.is_file():
            return candidate
    return None


def _materialize_from_supabase(thread_id: str, filename: str) -> Path | None:
    """Download a thread upload from Supabase into the local uploads dir.

    Cross-service bridge (PR #132): the gateway upload route mirrors every
    uploaded file to Supabase Storage under ``{thread_id}/{filename}``
    because the gateway and this langgraph runtime are separate containers
    with separate disks. When the local lookup misses, fetch the bytes here
    and write them to ``sandbox_uploads_dir(thread_id)`` so the rest of the
    tool (text read / markitdown conversion) proceeds unchanged.

    Returns the local path on success, ``None`` when Supabase is not
    configured, the object is missing, or any error occurs (best-effort —
    the caller degrades to the normal "not found" tool message).

    ``filename`` is already validated by ``_is_safe_filename`` before this
    is reached, so it is a bare ``[A-Za-z0-9._-]+`` name — safe to join.
    """
    try:
        from deerflow.sophia.storage import supabase_artifact_store
    except Exception:  # noqa: BLE001 — storage module optional
        return None

    if not supabase_artifact_store.is_configured():
        return None

    try:
        result = supabase_artifact_store.download_artifact(thread_id, filename)
    except Exception as exc:  # noqa: BLE001 — best-effort cross-service fetch
        logger.warning("Supabase download failed for %s/%s: %s", thread_id, filename, exc)
        return None
    if result is None:
        return None
    content, _content_type = result

    try:
        uploads_dir = get_paths().sandbox_uploads_dir(thread_id)
        uploads_dir.mkdir(parents=True, exist_ok=True)
        dest = uploads_dir / filename
        # Explicit open() rather than Path.write_bytes — equivalent, and
        # avoids a pathlib/temp-dir interaction seen under the test harness.
        with open(str(dest), "wb") as fh:
            fh.write(content)
    except OSError as exc:
        logger.warning("Could not materialize %s from Supabase: %s", filename, exc)
        return None
    logger.info("Materialized %s (%d bytes) from Supabase for thread %s", filename, len(content), thread_id)
    return dest


def _truncate_for_context(text: str) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= _MAX_BYTES_RETURNED:
        return text
    truncated = encoded[:_MAX_BYTES_RETURNED].decode("utf-8", errors="ignore")
    return (
        truncated
        + f"\n\n[...truncated; original file was {len(encoded)} bytes, returned first {_MAX_BYTES_RETURNED}]"
    )


@tool("read_user_document", parse_docstring=True)
async def read_user_document(
    runtime: ToolRuntime[ContextT, ThreadState],
    document_filename: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """Read the text content of a user-uploaded document.

    Use for any document the user wants summarized, quoted, or reasoned
    about — vision models hallucinate fine print, so always prefer
    text-reading over view_user_image for textual content. Supported:
    PDF, DOCX, PPTX, XLSX, MD, TXT, CSV, JSON, YAML.

    When NOT to use:
    - For images (.jpg/.jpeg/.png/.webp) — use ``view_user_image``.

    Args:
        document_filename: The bare filename, e.g. ``report.pdf``. No
            paths or path separators. The tool searches the current
            thread's uploads first, then outputs.
    """
    if not _is_safe_filename(document_filename):
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        f"Error: invalid filename {document_filename!r}. Provide just the bare filename (e.g. 'report.pdf'), no paths.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    thread_id = _resolve_thread_id(runtime)
    if not thread_id:
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        "Error: could not resolve current thread_id. This tool requires a thread context.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    path = _resolve_document_path(thread_id, document_filename)
    if path is None:
        # Cross-service fallback (PR #132): the gateway wrote this upload to
        # ITS container disk and mirrored it to Supabase; this tool runs in
        # the langgraph container (separate disk), so the local lookup misses.
        # Pull the bytes from Supabase into this thread's uploads dir, then
        # re-resolve. Best-effort: any miss falls through to the clean
        # "not found" message below.
        path = _materialize_from_supabase(thread_id, document_filename)
    if path is None:
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        f"Error: document {document_filename!r} not found in this thread's uploads or outputs. "
                        f"If the user just uploaded it, the upload may not have completed yet — ask them to retry.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    suffix = path.suffix.lower()

    if suffix in _DIRECT_TEXT_EXTENSIONS:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.warning("read_user_document: read failed for %s: %s", path, exc)
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            f"Error reading document: {exc}",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        _truncate_for_context(text),
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    if suffix in CONVERTIBLE_EXTENSIONS:
        try:
            md_path = await convert_file_to_markdown(path)
        except Exception as exc:  # noqa: BLE001 — markitdown raises untyped errors
            logger.warning("read_user_document: conversion failed for %s: %s", path, exc)
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            f"Error converting document: {exc}",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        if md_path is None:
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            f"Error: could not extract text from {document_filename!r}. The file may be corrupt or empty.",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        try:
            text = md_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            f"Error reading converted document: {exc}",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        _truncate_for_context(text),
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    supported = sorted(_DIRECT_TEXT_EXTENSIONS | CONVERTIBLE_EXTENSIONS)
    return Command(
        update={
            "messages": [
                ToolMessage(
                    f"Error: unsupported document format {suffix!r}. Supported: {', '.join(supported)}. "
                    f"For images (.jpg/.jpeg/.png/.webp), use view_user_image instead.",
                    tool_call_id=tool_call_id,
                )
            ]
        }
    )
