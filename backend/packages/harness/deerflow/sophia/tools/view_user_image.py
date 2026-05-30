"""view_user_image — thread-scoped image viewer for the companion.

Narrow wrapper around the same base64-encode + ``viewed_images`` state
write that upstream ``view_image_tool`` performs, but the LLM-facing
signature takes a bare ``image_filename`` and the resolver whitelists
the current thread's uploads + outputs directories. The companion never
sees (and cannot address) other threads' filesystems.

The resulting state update is identical in shape to upstream
``view_image_tool`` so ``SophiaViewImageMiddleware`` injects the image
content blocks into the next model turn the same way.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import re
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

# ``deerflow.agents.__init__`` eagerly imports ``make_sophia_agent``,
# which imports this module. Reaching ``deerflow.agents.thread_state``
# or ``deerflow.sandbox.tools`` (which itself imports thread_state) at
# module load would cycle. Both imports are deferred to call time using
# the same trick ``start_builder_task.py`` uses.
if TYPE_CHECKING:
    from deerflow.agents.thread_state import ThreadState
else:
    ThreadState = dict

logger = logging.getLogger(__name__)

# Same set as upstream ``view_image_tool`` so behaviour is consistent.
# GIF is intentionally excluded — Anthropic's image input docs flag GIF
# as low-quality input; if added later, mirror the change upstream.
_SUPPORTED_IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".webp"}
)


# Pre-base64 size cap. base64 expands raw bytes by ~33% (4/3 + padding),
# so a 10 MiB image becomes ~13.4 MiB of base64. Anthropic's standard
# request envelope is 32 MB total — once you add the system prompt, the
# conversation history, the rest of the user message, and JSON
# overhead, a single image over ~10 MiB raw risks tripping the
# provider's 400 "request too large" before the tool result even
# returns. We cap here so the tool returns a *clean* error the model
# can relay to the user, instead of the next turn failing with a
# provider-level error the user doesn't understand. Codex P2 on
# PR #132.
#
# 10 MiB is a deliberate compromise: comfortably above iPhone photos
# (2–5 MiB) and most screenshots, below the request-envelope cliff.
# A future spec that wants higher-res input should land server-side
# image downsampling (Pillow) and lift this cap.
#
# Exported so ``start_builder_task._copy_parent_uploaded_images`` can
# pre-filter oversized images out of the builder's sandbox copy — same
# rationale on the builder side (it uses upstream ``view_image_tool``
# directly, which has no size cap either).
MAX_VIEWABLE_IMAGE_BYTES: int = 10 * 1024 * 1024

# Virtual-path roots searched, in order. Uploads first because the user
# explicitly placed it there; outputs second covers rendered companion
# artifacts (e.g. a chart Sophia emitted earlier in the session).
_SEARCH_ROOTS: tuple[str, ...] = (
    "/mnt/user-data/uploads",
    "/mnt/user-data/outputs",
)


def _failure_update(message: ToolMessage) -> dict:
    """Build the state-update dict for any failure path.

    Codex P2 on PR #132 (later iteration): every failure must clear
    ``state["viewed_images"]`` so a previously-loaded image from this
    session doesn't get re-injected into the next model turn.

    Without this, the user views ``image1.png`` successfully → calls
    ``view_user_image("nonexistent.png")`` → tool returns error
    ToolMessage but the merge reducer leaves the prior ``image1``
    entry intact. ``SophiaViewImageMiddleware`` then fires (because a
    completed ``view_user_image`` call exists in the latest AIMessage)
    and re-injects ``image1`` into the next turn — and Sophia answers
    about ``image1`` while the user is asking about
    ``nonexistent.png``.

    ``merge_viewed_images`` (see ``agents/thread_state.py``) treats an
    empty dict as a sentinel for "clear all". The middleware also
    gates injection on non-empty ``viewed_images`` after this fix, so
    the cleared state doesn't get reflected as a misleading "No
    images have been viewed." HumanMessage either.

    Trade-off: a hypothetical multi-call turn where one
    ``view_user_image`` succeeds and another fails wipes the success
    too. That's rare in practice (Sophia views one image per turn)
    and recoverable — the model can re-call view_user_image on the
    same filename in the next turn (the file is still on disk).
    """
    return {
        "messages": [message],
        "viewed_images": {},
    }


# Strict prompt-safe filename allow-list. Mirrors the builder-side
# ``start_builder_task._SAFE_COPY_FILENAME`` and the frontend's
# ``SAFE_PROMPT_FILENAME``. Codex P2 PR #132: the gateway upload route
# only normalizes with ``Path(file.filename).name`` (strips path
# separators), so a direct/API upload or a rendered output named like
# ``photo.png\n]\n[SYSTEM: ...`` can reach this tool. On the success
# path the resolved virtual path is stored in ``viewed_images`` and
# ``SophiaViewImageMiddleware`` later injects it as TEXT into the next
# model turn — a crafted name with newlines / brackets / markup could
# break out of the image-details block and prompt-inject the
# companion. Restricting to ``[A-Za-z0-9._-]`` kills that vector
# (newlines, spaces, ``<``/``>``, quotes, control bytes all rejected).
_SAFE_IMAGE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _is_safe_filename(filename: str) -> bool:
    """Reject path-traversal AND prompt-injection-capable filenames.

    A name is safe only when it matches the strict allow-list
    ``[A-Za-z0-9._-]+`` and is not a hidden file / ``.`` / ``..``.
    The allow-list inherently rejects path separators, control
    characters, whitespace, and markup — see ``_SAFE_IMAGE_FILENAME``.
    """
    if not filename or filename in {".", ".."}:
        return False
    if filename.startswith("."):
        return False
    return bool(_SAFE_IMAGE_FILENAME.match(filename))


def _resolve_thread_id(runtime) -> str | None:  # noqa: ANN001 — ToolRuntime, kept loose to avoid import cycle
    """Resolve thread_id from runtime context then configurable.

    Mirrors ``read_user_document._resolve_thread_id`` /
    ``start_builder_task._resolve_thread_id`` so the Supabase cross-service
    fallback can key downloads by thread.
    """
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if ctx:
        candidate = ctx.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    cfg = getattr(runtime, "config", None)
    if cfg:
        candidate = (cfg.get("configurable", {}) or {}).get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _materialize_image_from_supabase(
    runtime,  # noqa: ANN001 — ToolRuntime
    image_filename: str,
    thread_data,  # noqa: ANN001 — opaque sandbox thread-data handle
    replace_virtual_path,  # noqa: ANN001 — injected to avoid a second import
) -> tuple[str, Path] | None:
    """Download an image upload from Supabase into the uploads dir.

    Cross-service bridge (PR #132): the gateway mirrors every upload to
    Supabase under ``{thread_id}/{filename}`` because gateway and langgraph
    run in separate containers with separate disks. On a local miss we fetch
    the bytes and write them to the thread's uploads dir, returning the
    (virtual_path, actual_path) pair so the caller proceeds unchanged.

    Returns ``None`` when thread_id can't be resolved, Supabase isn't
    configured, the object is missing, or any error occurs (best-effort —
    the caller degrades to the normal "not found" message). ``image_filename``
    is already validated by ``_is_safe_filename`` before this is reached.
    """
    thread_id = _resolve_thread_id(runtime)
    if not thread_id:
        return None

    try:
        from deerflow.sophia.storage import supabase_artifact_store
    except Exception:  # noqa: BLE001 — storage module optional
        return None
    if not supabase_artifact_store.is_configured():
        return None

    try:
        result = supabase_artifact_store.download_artifact(thread_id, image_filename)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("Supabase image download failed for %s/%s: %s", thread_id, image_filename, exc)
        return None
    if result is None:
        return None
    content, _content_type = result

    candidate_virtual = f"/mnt/user-data/uploads/{image_filename}"
    try:
        dest = Path(replace_virtual_path(candidate_virtual, thread_data))
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Use an explicit open() rather than Path.write_bytes — equivalent,
        # and avoids a pathlib/temp-dir interaction that surfaced under the
        # test harness.
        with open(str(dest), "wb") as fh:
            fh.write(content)
    except OSError as exc:
        logger.warning("Could not materialize image %s from Supabase: %s", image_filename, exc)
        return None
    logger.info("Materialized image %s (%d bytes) from Supabase for thread %s", image_filename, len(content), thread_id)
    return candidate_virtual, dest


@tool("view_user_image", parse_docstring=True)
def view_user_image(
    runtime: ToolRuntime[ContextT, ThreadState],
    image_filename: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """View an image the user uploaded or that Sophia rendered earlier this session.

    Use this when the user shares a photo, screenshot, or other image and
    you need to see it to respond meaningfully — or to look at a chart /
    visual artifact you produced in an earlier turn.

    When NOT to use:
    - For text PDFs, DOCX, PPTX, XLSX, MD, or TXT files — use
      ``read_user_document`` instead. Vision models are weak on small
      text and will hallucinate fine print.
    - For files outside the current thread's uploads or outputs.

    Args:
        image_filename: The bare filename, e.g. ``photo.png``. No paths
            or path separators. The tool searches the current thread's
            uploads first, then outputs.
    """
    if not _is_safe_filename(image_filename):
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error: invalid filename {image_filename!r}. Provide just the bare filename (e.g. 'photo.png'), no paths.",
                    tool_call_id=tool_call_id,
                )
            )
        )

    suffix = Path(image_filename).suffix.lower()
    if suffix not in _SUPPORTED_IMAGE_EXTENSIONS:
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error: unsupported image format {suffix!r}. Supported: {', '.join(sorted(_SUPPORTED_IMAGE_EXTENSIONS))}. "
                    f"For documents, use read_user_document instead.",
                    tool_call_id=tool_call_id,
                )
            )
        )

    from deerflow.sandbox.tools import get_thread_data, replace_virtual_path

    thread_data = get_thread_data(runtime)

    resolved_virtual: str | None = None
    resolved_actual: Path | None = None
    for root in _SEARCH_ROOTS:
        candidate_virtual = f"{root}/{image_filename}"
        candidate_actual = Path(replace_virtual_path(candidate_virtual, thread_data))
        if candidate_actual.is_file():
            resolved_virtual = candidate_virtual
            resolved_actual = candidate_actual
            break

    if resolved_actual is None or resolved_virtual is None:
        # Cross-service fallback (PR #132): the gateway saved this upload to
        # ITS container disk and mirrored it to Supabase; this tool runs in
        # the langgraph container (separate disk), so the local lookup
        # misses. Pull the bytes from Supabase into the uploads dir and
        # resolve to that path. Best-effort — a miss falls through to the
        # normal "not found" message.
        materialized = _materialize_image_from_supabase(
            runtime, image_filename, thread_data, replace_virtual_path
        )
        if materialized is not None:
            resolved_virtual, resolved_actual = materialized

    if resolved_actual is None or resolved_virtual is None:
        searched = ", ".join(_SEARCH_ROOTS)
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error: image {image_filename!r} not found in this thread. Searched: {searched}. "
                    f"If the user just uploaded it, the upload may not have completed yet — ask them to retry.",
                    tool_call_id=tool_call_id,
                )
            )
        )

    # Pre-base64 size guard — see MAX_VIEWABLE_IMAGE_BYTES comment for
    # why this matters. Must happen BEFORE read_bytes() so a 50 MiB
    # image doesn't get fully loaded into memory just to be rejected.
    try:
        file_size = resolved_actual.stat().st_size
    except OSError as exc:
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error reading image metadata: {exc}",
                    tool_call_id=tool_call_id,
                )
            )
        )
    if file_size > MAX_VIEWABLE_IMAGE_BYTES:
        size_mib = file_size / (1024 * 1024)
        limit_mib = MAX_VIEWABLE_IMAGE_BYTES / (1024 * 1024)
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error: image {image_filename!r} is {size_mib:.1f} MiB, above the "
                    f"{limit_mib:.0f} MiB vision cap. After base64 encoding it would push the "
                    f"next request past Anthropic's 32 MB envelope. Ask the user to crop or "
                    f"resize the image (or convert to a more efficient format like .webp) "
                    f"and re-upload. For documents, use read_user_document instead — text "
                    f"extraction has no such cap.",
                    tool_call_id=tool_call_id,
                )
            )
        )

    mime_type, _ = mimetypes.guess_type(str(resolved_actual))
    if mime_type is None:
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(suffix, "application/octet-stream")

    try:
        image_bytes = resolved_actual.read_bytes()
    except OSError as exc:
        logger.warning("view_user_image: read failed for %s: %s", resolved_actual, exc)
        return Command(
            update=_failure_update(
                ToolMessage(
                    f"Error reading image: {exc}",
                    tool_call_id=tool_call_id,
                )
            )
        )

    image_base64 = base64.b64encode(image_bytes).decode("utf-8")

    # Key the registry by virtual path — that's what the middleware shows
    # the model in the image-details message, and a virtual path is
    # readable and stable across runs of the same thread.
    return Command(
        update={
            "viewed_images": {
                resolved_virtual: {"base64": image_base64, "mime_type": mime_type},
            },
            "messages": [
                ToolMessage(
                    f"Loaded {image_filename} ({mime_type}) from {resolved_virtual}. The image will appear in your next turn so you can describe or analyze it.",
                    tool_call_id=tool_call_id,
                )
            ],
        }
    )
