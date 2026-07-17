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

from deerflow.sophia.process_group import run_native_process

logger = logging.getLogger(__name__)

_DEFAULT_MAX_ITERATIONS = 3
_PDFTOPPM_TIMEOUT_SECONDS = 60
_RASTER_DPI = "110"
_RASTER_MAX_PAGES = 6

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


def _raster_max_pages() -> int:
    raw = os.environ.get("SOPHIA_BUILDER_VISION_REVIEW_MAX_PAGES", "").strip()
    try:
        return max(1, int(raw)) if raw else _RASTER_MAX_PAGES
    except ValueError:
        return _RASTER_MAX_PAGES


def _pdf_page_count(pdf_path: Path) -> int | None:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf_path)).pages)
    except Exception:
        return None


def _sample_pages(page_count: int | None, max_pages: int) -> list[int]:
    if not page_count or page_count <= max_pages:
        return list(range(1, (page_count or max_pages) + 1))
    candidates = {1, 2, page_count - 1, page_count}
    middle = max(1, page_count // 2)
    candidates.update({middle - 1, middle, middle + 1})
    return sorted(page for page in candidates if 1 <= page <= page_count)[:max_pages]


def rasterize_preview_pages(pdf_path: Path, max_pages: int | None = None) -> list[bytes]:
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
    page_cap = max_pages or _raster_max_pages()
    page_count = _pdf_page_count(pdf_path)
    pages_to_render = _sample_pages(page_count, page_cap)
    try:
        with tempfile.TemporaryDirectory(prefix="vq-raster-") as tmp_dir:
            output: list[bytes] = []
            for page in pages_to_render:
                prefix = Path(tmp_dir) / f"page-{page}"
                completed = run_native_process(
                    [
                        pdftoppm,
                        "-png",
                        "-f",
                        str(page),
                        "-l",
                        str(page),
                        "-r",
                        _RASTER_DPI,
                        str(pdf_path),
                        str(prefix),
                    ],
                    capture_output=True,
                    timeout=_PDFTOPPM_TIMEOUT_SECONDS,
                    check=False,
                    writable_dirs=[tmp_dir],
                    identity_paths=[pdf_path],
                )
                if completed.returncode != 0:
                    logger.warning(
                        "[BuildCondition] pdftoppm failed page=%s rc=%s stderr=%s",
                        page,
                        completed.returncode,
                        (completed.stderr or b"")[:300],
                    )
                    continue
                produced = sorted(Path(tmp_dir).glob(f"page-{page}*.png"))
                if produced:
                    output.append(produced[0].read_bytes())
            return output
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


def _review_model_name() -> str | None:
    explicit = os.environ.get("SOPHIA_BUILDER_VISION_REVIEW_MODEL", "").strip()
    if explicit:
        return explicit
    try:
        from deerflow.agents.sophia_agent.vision_gate import supports_vision
        from deerflow.config.app_config import get_app_config

        for model in get_app_config().models:
            name = getattr(model, "name", None)
            provider_model = getattr(model, "model", None)
            for candidate in (name, provider_model):
                if isinstance(candidate, str) and supports_vision(candidate):
                    return name if isinstance(name, str) else candidate
    except Exception:
        logger.warning("[BuildCondition] vision review model discovery failed", exc_info=True)
    return None


def _model_invoke(messages: list[Any]) -> Any:
    model_name = _review_model_name()
    if not model_name:
        raise RuntimeError("vision_review_model_unavailable")
    from deerflow.models.factory import create_chat_model

    return create_chat_model(name=model_name, max_tokens=800, timeout=60.0, max_retries=0).invoke(messages)


def _parse_review_verdict(text: str) -> dict[str, Any] | None:
    clean = (text or "").strip()
    if not clean:
        return None
    if clean.upper().startswith("PASS"):
        return {"verdict": "pass", "findings": []}
    try:
        import json

        start = clean.find("{")
        end = clean.rfind("}")
        if start >= 0 and end > start:
            payload = json.loads(clean[start : end + 1])
            verdict = str(payload.get("verdict") or "").lower()
            findings = payload.get("findings")
            if verdict in {"pass", "repair", "severe_fail"}:
                return {
                    "verdict": verdict,
                    "findings": [str(item)[:240] for item in findings if isinstance(item, str)][:5]
                    if isinstance(findings, list)
                    else [],
                }
    except Exception:
        pass
    return {"verdict": "repair", "findings": [clean[:500]]}


def rendered_artifact_review(pdf_path: Path) -> dict[str, Any] | None:
    """ONE rendered-artifact vision pass over PDF/PPTX preview rasters.

    Condition-only judgment — returns findings text for the repair prompt or
    ``None`` for "no findings / unavailable". Strictly best-effort: any error
    means None; the caller charges at most one iteration for acting on it.
    """
    if not advisory_enabled():
        logger.info("[BuilderVQ] review_attempted=false skip_reason=disabled")
        return None
    rasters = rasterize_preview_pages(pdf_path, max_pages=_raster_max_pages())
    if not rasters:
        logger.info(
            "[BuilderVQ] review_attempted=false skip_reason=no_rasters artifact=%s",
            pdf_path.name,
        )
        return None
    logger.info(
        "[BuilderVQ] review_attempted=true artifact=%s sampled_pages=%d",
        pdf_path.name,
        len(rasters),
    )
    try:
        from langchain_core.messages import HumanMessage

        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "You are reviewing rendered pages of a generated deliverable. "
                    "Judge ONLY visible artifact quality: legibility, contrast, "
                    "text overlap, clipped/cutoff charts or labels, empty/sparse "
                    "pages, and whether slides/pages look polished enough for a "
                    "professional deliverable. Reply as JSON only: "
                    "{\"verdict\":\"pass|repair|severe_fail\",\"findings\":[\"...\"]}. "
                    "Use severe_fail only when the artifact is unusable or mostly blank."
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
        reply = _model_invoke([HumanMessage(content=content)])
        text = reply.text() if callable(getattr(reply, "text", None)) else str(reply.content)
        verdict = _parse_review_verdict(text)
        if not verdict or verdict["verdict"] == "pass":
            logger.info(
                "[BuilderVQ] verdict=pass sampled_pages=%d findings_count=0",
                len(rasters),
            )
            return None
        findings = verdict.get("findings")
        findings_count = len(findings) if isinstance(findings, list) else 0
        logger.warning(
            "[BuilderVQ] verdict=%s sampled_pages=%d findings_count=%d",
            verdict.get("verdict"),
            len(rasters),
            findings_count,
        )
        return verdict
    except Exception:  # noqa: BLE001 — advisory is strictly best-effort
        logger.warning(
            "[BuilderVQ] review_attempted=true skip_reason=review_failed",
            exc_info=True,
        )
        return None


def advisory_review(pdf_path: Path) -> str | None:
    """Backward-compatible wrapper for older tests/callers."""
    result = rendered_artifact_review(pdf_path)
    if not result:
        return None
    findings = result.get("findings")
    if isinstance(findings, list) and findings:
        return "\n".join(f"- {item}" for item in findings[:5])
    return str(result.get("verdict") or "repair")
