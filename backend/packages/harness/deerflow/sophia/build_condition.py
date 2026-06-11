"""Build-to-condition support (Spec VQ-6 + VQ-10).

The builder iterates until a HARNESS-OWNED completion condition is satisfied
or the iteration cap is hit. This module owns the pieces that are not
middleware bookkeeping:

* the shared iteration cap (``SOPHIA_BUILDER_MAX_ITERATIONS``, default 3;
  setting it to 1 restores the per-gate one-shot behavior),
* preview rasterization for repair turns (``pdftoppm`` over the pptx
  preview / the rendered PDF) and the vision content blocks carrying the
  review checklist (adapted from the Anthropic pptx skill's thumbnail
  validation),
* the advisory holistic pass (Haiku + vision over the rasters) — strictly
  bounded: it may consume at most one iteration and can never spin the loop.

Actor/evaluator separation: the builder builds; these helpers judge
ARTIFACTS (rasters + harness diagnostics), never the builder's claims.
"""

from __future__ import annotations

import base64
import logging
import os
import shutil
import subprocess  # noqa: S404 — pdftoppm by resolved path
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_MAX_ITERATIONS = 3
_PDFTOPPM_TIMEOUT_SECONDS = 60
_RASTER_DPI = "110"
_RASTER_MAX_PAGES = 3

# Adapted verbatim-in-spirit from the Anthropic/Composio pptx skill's
# thumbnail-validation instructions — the checklist the model reviews the
# rasters against on a repair turn.
PREVIEW_REVIEW_CHECKLIST = (
    "Review the attached preview page(s) of YOUR OWN rendered deliverable "
    "before fixing and re-emitting. Check every page for:\n"
    "- Text cutoff: text cut off by header bars, shapes, or page/slide edges\n"
    "- Text overlap: text overlapping other text or shapes (figure labels "
    "especially)\n"
    "- Positioning: content too close to boundaries or other elements\n"
    "- Contrast: insufficient contrast between text and backgrounds\n"
    "- Hero/cover: a generated hero (deck) or cover (PDF) image present where "
    "the build requires one\n"
    "- Caption truth: every figure matches its caption/title\n"
    "Fix what you find (regenerate the offending figures/sections), then emit "
    "again."
)


def iteration_cap() -> int:
    """Shared repair-iteration cap (VQ-10). Env-tunable; 1 = legacy one-shot."""
    raw = os.environ.get("SOPHIA_BUILDER_MAX_ITERATIONS", "").strip()
    try:
        value = int(raw) if raw else _DEFAULT_MAX_ITERATIONS
    except ValueError:
        value = _DEFAULT_MAX_ITERATIONS
    return max(1, value)


# ---------------------------------------------------------------------------
# Brief-completeness gate (Spec D D-5)
# ---------------------------------------------------------------------------

# Required brief-schema fields per task_type. ``*`` in a tuple entry means
# "at least one of the alternatives" — encoded as a nested tuple.
_REQUIRED_BRIEF_FIELDS: dict[str, tuple[Any, ...]] = {
    "presentation": ("audience", "purpose", "format_and_length", ("must_include", "sources_and_examples")),
    "visual_report": ("audience", "purpose", "format_and_length", ("must_include", "sources_and_examples")),
    "document": ("audience", "purpose", "format_and_length", ("must_include", "sources_and_examples")),
    "frontend": ("purpose", "format_and_length", "must_include"),
    "code": ("purpose", "format_and_length", "must_include"),
}


def brief_gate_enabled() -> bool:
    """SOPHIA_DELEGATION_BRIEF_GATE flag (default on)."""
    raw = os.environ.get("SOPHIA_DELEGATION_BRIEF_GATE", "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _brief_field_present(schema: dict[str, Any], field: str) -> bool:
    value = schema.get(field)
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return bool(value)
    return value is not None


def brief_complete(task_type: str, brief_schema: dict[str, Any] | None) -> tuple[bool, list[str]]:
    """Pure predicate: is the extracted brief schema complete for this task_type?

    Returns ``(ok, missing_fields)``. No schema (extraction skipped/failed)
    or an unknown task_type → ``(True, [])`` — the gate only ever acts on
    a schema that exists, so extraction failure can never block a build.
    """
    if not isinstance(brief_schema, dict):
        return True, []
    required = _REQUIRED_BRIEF_FIELDS.get(str(task_type or "").strip().lower())
    if not required:
        return True, []
    missing: list[str] = []
    for requirement in required:
        if isinstance(requirement, tuple):
            if not any(_brief_field_present(brief_schema, field) for field in requirement):
                missing.append("|".join(requirement))
        elif not _brief_field_present(brief_schema, requirement):
            missing.append(requirement)
    return (not missing), missing


def brief_gate_unmet_conditions(state: dict[str, Any], artifact: dict[str, Any]) -> list[str]:
    """Honesty stamp at emit acceptance (Spec D D-5 — "never silent").

    When the gate flagged missing fields and the model neither recovered
    them (zero ``read_session_context`` calls) nor stated assumptions
    (empty ``brief_assumptions``), the gaps ship NAMED in the existing
    ``unmet_conditions[]`` payload field. Zero loop risk — observability
    only, no rejection.
    """
    missing = state.get("brief_gate_missing_fields") or []
    if not missing:
        return []
    assumptions = artifact.get("brief_assumptions")
    if isinstance(assumptions, list) and assumptions:
        return []
    if int(state.get("builder_session_context_reads", 0) or 0) > 0:
        return []
    return [f"brief_incomplete:{field}" for field in missing]


def iterations_used(state: dict[str, Any]) -> int:
    return int(state.get("build_iterations", 0) or 0)


def iteration_available(state: dict[str, Any]) -> bool:
    return iterations_used(state) < iteration_cap()


def rasterize_preview_pages(pdf_path: Path, max_pages: int = _RASTER_MAX_PAGES) -> list[bytes]:
    """First pages of ``pdf_path`` as PNG bytes via pdftoppm. Best-effort.

    Returns [] when poppler is unavailable or rasterization fails — a repair
    turn without rasters still carries the textual rejection reason.
    """
    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm is None:
        logger.info("[BuildCondition] pdftoppm not on PATH — repair turn proceeds without rasters")
        return []
    if not pdf_path.is_file():
        return []
    try:
        with tempfile.TemporaryDirectory(prefix="vq-raster-") as tmp_dir:
            prefix = Path(tmp_dir) / "page"
            completed = subprocess.run(  # noqa: S603 — binary from shutil.which
                [
                    pdftoppm,
                    "-png",
                    "-f",
                    "1",
                    "-l",
                    str(max_pages),
                    "-r",
                    _RASTER_DPI,
                    str(pdf_path),
                    str(prefix),
                ],
                capture_output=True,
                timeout=_PDFTOPPM_TIMEOUT_SECONDS,
                check=False,
            )
            if completed.returncode != 0:
                logger.warning(
                    "[BuildCondition] pdftoppm failed rc=%s stderr=%s",
                    completed.returncode,
                    (completed.stderr or b"")[:300],
                )
                return []
            pages = sorted(Path(tmp_dir).glob("page*.png"))
            return [page.read_bytes() for page in pages[:max_pages]]
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("[BuildCondition] rasterization failed", exc_info=True)
        return []


def preview_review_blocks(pdf_path: Path) -> list[dict[str, Any]]:
    """Anthropic-native content blocks: checklist text + preview page images.

    Empty list when no rasters could be produced (callers then fall back to
    the plain-text rejection message).
    """
    rasters = rasterize_preview_pages(pdf_path)
    if not rasters:
        return []
    blocks: list[dict[str, Any]] = [{"type": "text", "text": PREVIEW_REVIEW_CHECKLIST}]
    for png in rasters:
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(png).decode("ascii"),
                },
            }
        )
    return blocks


def advisory_enabled() -> bool:
    return os.environ.get("SOPHIA_BUILDER_VQ_ADVISORY", "1").strip().lower() not in {"0", "false", "off"}


def advisory_review(pdf_path: Path) -> str | None:
    """ONE advisory holistic pass (VQ-10): Haiku + vision over the rasters.

    Condition-only judgment — returns findings text for the repair prompt or
    ``None`` for "no findings / unavailable". Strictly best-effort: any error
    means None; the caller charges at most one iteration for acting on it.
    """
    if not advisory_enabled():
        return None
    rasters = rasterize_preview_pages(pdf_path, max_pages=2)
    if not rasters:
        return None
    try:
        from langchain_anthropic import ChatAnthropic
        from langchain_core.messages import HumanMessage

        model = ChatAnthropic(
            model="claude-haiku-4-5-20251001",
            api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            max_tokens=600,
            timeout=45.0,
            max_retries=0,
        )
        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "You are reviewing rendered pages of a generated deliverable. "
                    "Judge ONLY: legibility (no cutoff/overlapping text), layout "
                    "coherence, and whether figures look complete. Reply with "
                    "either exactly 'PASS' or a short bullet list of concrete "
                    "defects (max 5 bullets, each actionable)."
                ),
            }
        ]
        for png in rasters:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64.b64encode(png).decode("ascii"),
                    },
                }
            )
        reply = model.invoke([HumanMessage(content=content)])
        text = reply.text() if callable(getattr(reply, "text", None)) else str(reply.content)
        text = (text or "").strip()
        if not text or text.upper().startswith("PASS"):
            return None
        return text[:1500]
    except Exception:  # noqa: BLE001 — advisory is strictly best-effort
        logger.warning("[BuildCondition] advisory review failed", exc_info=True)
        return None
