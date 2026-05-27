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

# Virtual-path roots searched, in order. Uploads first because the user
# explicitly placed it there; outputs second covers rendered companion
# artifacts (e.g. a chart Sophia emitted earlier in the session).
_SEARCH_ROOTS: tuple[str, ...] = (
    "/mnt/user-data/uploads",
    "/mnt/user-data/outputs",
)


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
            update={
                "messages": [
                    ToolMessage(
                        f"Error: invalid filename {image_filename!r}. Provide just the bare filename (e.g. 'photo.png'), no paths.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
        )

    suffix = Path(image_filename).suffix.lower()
    if suffix not in _SUPPORTED_IMAGE_EXTENSIONS:
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        f"Error: unsupported image format {suffix!r}. Supported: {', '.join(sorted(_SUPPORTED_IMAGE_EXTENSIONS))}. "
                        f"For documents, use read_user_document instead.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
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
            update={
                "messages": [
                    ToolMessage(
                        f"Error: image {image_filename!r} not found in this thread. Searched: {searched}. "
                        f"If the user just uploaded it, the upload may not have completed yet — ask them to retry.",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
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
            update={
                "messages": [
                    ToolMessage(
                        f"Error reading image: {exc}",
                        tool_call_id=tool_call_id,
                    )
                ]
            }
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
