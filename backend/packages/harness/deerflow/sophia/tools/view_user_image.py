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


def _is_safe_filename(filename: str) -> bool:
    """Reject anything that smells like a path or traversal attempt."""
    if not filename or filename in {".", ".."}:
        return False
    if "/" in filename or "\\" in filename:
        return False
    if filename.startswith("."):
        return False
    return True


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
