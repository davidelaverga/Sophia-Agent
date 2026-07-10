from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_build.models import DeckBuild

try:  # pragma: no cover - Pillow is present in the backend image, optional in tiny test envs.
    from PIL import Image, ImageStat
except Exception:  # noqa: BLE001
    Image = None  # type: ignore[assignment]
    ImageStat = None  # type: ignore[assignment]

_DARK_STYLE_RE = re.compile(r"\b(dark|charcoal|black|blueprint|terminal|night|command\s+center)\b", re.I)
_OLD_RENDERER_MARKERS = (
    "section-label",
    "system-diagram",
    "closing-synthesis",
    "deck_build_templates_v1",
)
_HARD_RESIDUE_KINDS = {
    "frame_overflow",
    "slide_overflow_text",
    "covered_by_picture",
    "repair_still_failing",
}
_ADVISORY_RESIDUE_KINDS = {"overlap", "slide_overflow_non_text"}
_KNOWN_RESIDUE_KINDS = _HARD_RESIDUE_KINDS | _ADVISORY_RESIDUE_KINDS


@dataclass
class MechanicalGateIssue:
    code: str
    selector: str
    summary: str
    repair_hint: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MechanicalGateResult:
    passed: bool
    failure_code: str | None = None
    failure_summary: str | None = None
    issues: list[MechanicalGateIssue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    slide_render_metrics: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failure_code": self.failure_code,
            "failure_summary": self.failure_summary,
            "issues": [issue.to_dict() for issue in self.issues],
            "warnings": self.warnings,
            "slide_render_metrics": self.slide_render_metrics,
        }


def evaluate_mechanical_gates(deck: DeckBuild, *, rendered_dir: Path | None) -> MechanicalGateResult:
    issues: list[MechanicalGateIssue] = []
    warnings: list[str] = []
    metrics = _render_metrics(rendered_dir)
    issues.extend(_old_renderer_issues(deck))
    issues.extend(_repeated_structure_issues(deck))
    residue_issues, residue_warnings = _native_residue_findings(deck)
    issues.extend(residue_issues)
    warnings.extend(residue_warnings)
    issues.extend(_source_retention_issues(deck))
    issues.extend(_native_contrast_issues(deck))
    issues.extend(_sparse_render_issues(metrics))
    issues.extend(_dark_request_light_render_issues(deck, metrics))
    passed = not issues
    return MechanicalGateResult(
        passed=passed,
        failure_code=None if passed else "deck_mechanical_gate_failed",
        failure_summary=None if passed else "; ".join(issue.summary for issue in issues[:3]),
        issues=issues,
        warnings=warnings,
        slide_render_metrics=metrics,
    )


def _old_renderer_issues(deck: DeckBuild) -> list[MechanicalGateIssue]:
    issues: list[MechanicalGateIssue] = []
    for slide in deck.slides:
        source = slide.html_source or ""
        if any(marker in source for marker in _OLD_RENDERER_MARKERS):
            issues.append(
                MechanicalGateIssue(
                    code="old_renderer_artifact",
                    selector=slide.selector,
                    summary="Slide HTML appears to contain the retired deterministic renderer skeleton.",
                    repair_hint="Author subject-specific slide HTML from the creative plan instead of using the old template structure.",
                )
            )
    return issues


def _repeated_structure_issues(deck: DeckBuild) -> list[MechanicalGateIssue]:
    layout_names = [
        str(getattr(slide.composition_plan, "layout_name", "") or "")
        for slide in deck.slides
        if slide.composition_plan is not None
    ]
    if len(layout_names) < 3:
        return []
    most_common = max((layout_names.count(name), name) for name in set(layout_names) if name)
    if most_common[0] < max(3, len(layout_names) - 1):
        return []
    return [
        MechanicalGateIssue(
            code="repeated_slide_skeleton",
            selector="deck",
            summary=f"Creative plan repeats layout '{most_common[1]}' across too many slides.",
            repair_hint="Vary slide structure, spatial rhythm, and diagram language across the deck.",
        )
    ]


def _native_residue_findings(deck: DeckBuild) -> tuple[list[MechanicalGateIssue], list[str]]:
    report = deck.native_mechanical_report if isinstance(deck.native_mechanical_report, dict) else {}
    residue_count = int(report.get("lint_residue_count") or 0)
    if residue_count <= 0:
        return [], []
    residue_kinds = report.get("lint_residue_kinds")
    kinds = set(str(key) for key in residue_kinds) if isinstance(residue_kinds, dict) else set()
    issues = _residue_kind_issues(kinds)
    warnings: list[str] = []

    residue = report.get("lint_residue") if isinstance(report.get("lint_residue"), list) else []
    for item in residue:
        if not isinstance(item, dict):
            continue
        item_issues, item_warnings = _residue_item_findings(deck, item)
        issues.extend(item_issues)
        warnings.extend(item_warnings)
    return issues, sorted(set(warnings))


def _residue_kind_issues(kinds: set[str]) -> list[MechanicalGateIssue]:
    unknown = sorted(kind for kind in kinds if kind not in _KNOWN_RESIDUE_KINDS)
    issues: list[MechanicalGateIssue] = []
    if unknown:
        issues.append(
            MechanicalGateIssue(
                code="unknown_native_lint_residue",
                selector="deck",
                summary=f"Native lint/fix left unknown residue kinds: {', '.join(unknown[:5])}.",
                repair_hint="Simplify or revise HTML geometry so hands-on-deck can produce clean native shapes.",
            )
        )
    if not kinds:
        issues.append(
            MechanicalGateIssue(
                code="unknown_native_lint_residue",
                selector="deck",
                summary="Native lint/fix reported residue without stable producer-side kinds.",
                repair_hint="Re-run through the pinned native compiler and preserve residue kind metadata.",
            )
        )
    issues.extend(
        [
            MechanicalGateIssue(
                code=f"native_lint_{kind}",
                selector="deck",
                summary=f"Native lint/fix left blocking residue: {kind}.",
                repair_hint="Repair the exact affected source element and re-run prepare_deck_build once.",
            )
            for kind in sorted(kinds & _HARD_RESIDUE_KINDS)
        ]
    )
    return issues


def _residue_item_findings(
    deck: DeckBuild,
    item: dict[str, Any],
) -> tuple[list[MechanicalGateIssue], list[str]]:
    kind = str(item.get("kind") or "")
    selector = f"slide:{int(item.get('slide') or 0) + 1}"
    if kind == "overlap" and float(item.get("overlap_area") or 0.0) >= 0.08:
        return [
            MechanicalGateIssue(
                code="native_lint_severe_overlap",
                selector=selector,
                summary="Native lint/fix left a material shape overlap.",
                repair_hint="Separate or intentionally restack the named semantic elements.",
            )
        ], []
    if kind == "slide_overflow_non_text":
        if _residue_source_role(deck, item) in {"background", "bleed", "decorative"}:
            return [], [f"native_lint_advisory:{kind}"]
        return [
            MechanicalGateIssue(
                code="native_lint_unapproved_bleed",
                selector=selector,
                summary="A non-text shape extends off-slide without an explicit bleed/background role.",
                repair_hint="Keep the shape inside the slide or mark its source role as background, bleed, or decorative.",
            )
        ], []
    if kind in _ADVISORY_RESIDUE_KINDS:
        return [], [f"native_lint_advisory:{kind}"]
    return [], []


def _residue_source_role(deck: DeckBuild, item: dict[str, Any]) -> str | None:
    try:
        selector = f"slide:{int(item.get('slide') or 0) + 1}"
    except (TypeError, ValueError):
        return None
    shape_name = str(item.get("shape") or "")
    for record in _source_records(deck, selector):
        if shape_name in _record_shape_names(record):
            return str(record.get("source_role") or "").strip().lower() or None
    return None


def _source_records(deck: DeckBuild, selector: str) -> list[dict[str, Any]]:
    slides = deck.source_element_map.get("slides") if isinstance(deck.source_element_map, dict) else None
    slide_map = slides.get(selector) if isinstance(slides, dict) else None
    elements = slide_map.get("elements") if isinstance(slide_map, dict) else None
    return [record for record in (elements or {}).values() if isinstance(record, dict)]


def _record_shape_names(record: dict[str, Any]) -> set[str]:
    return {str(name) for name in record.get("shape_names") or []}


def _source_retention_issues(deck: DeckBuild) -> list[MechanicalGateIssue]:
    report = deck.source_retention_report if isinstance(deck.source_retention_report, dict) else {}
    issues: list[MechanicalGateIssue] = []
    for item in report.get("missing_required") or []:
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("source_id") or "unknown")
        issues.append(
            MechanicalGateIssue(
                code="required_source_element_missing",
                selector=str(item.get("selector") or "deck"),
                summary=f"Required semantic element '{source_id}' is missing from the native PPTX.",
                repair_hint="Use supported HTML/CSS and preserve the same data-deck-id through native compilation.",
            )
        )
    for item in report.get("duplicates") or []:
        if not isinstance(item, dict):
            continue
        issues.append(
            MechanicalGateIssue(
                code="duplicate_source_element_id",
                selector=str(item.get("selector") or "deck"),
                summary=f"Duplicate semantic source ID: {item.get('source_id')}",
                repair_hint="Give every semantic element on the slide a unique data-deck-id.",
            )
        )
    return issues


def _native_contrast_issues(deck: DeckBuild) -> list[MechanicalGateIssue]:
    report = deck.native_contrast_report if isinstance(deck.native_contrast_report, dict) else {}
    issues: list[MechanicalGateIssue] = []
    for item in report.get("issues") or []:
        if not isinstance(item, dict) or not item.get("required_semantic"):
            continue
        indeterminate = bool(item.get("indeterminate"))
        issues.append(
            MechanicalGateIssue(
                code="native_text_contrast_indeterminate" if indeterminate else "native_text_contrast_failed",
                selector=str(item.get("selector") or "deck"),
                summary=(
                    f"Required text '{item.get('text_excerpt')}' has no deterministic opaque background."
                    if indeterminate
                    else f"Required text contrast {item.get('contrast_ratio')} is below {item.get('required_ratio')}."
                ),
                repair_hint="Place required text on an opaque compiler-supported fill with a compliant text color.",
            )
        )
    return issues


def _sparse_render_issues(metrics: list[dict[str, Any]]) -> list[MechanicalGateIssue]:
    issues: list[MechanicalGateIssue] = []
    for metric in metrics:
        if metric.get("unreadable"):
            continue
        if float(metric.get("non_background_ratio") or 0.0) < 0.008:
            issues.append(
                MechanicalGateIssue(
                    code="sparse_rendered_slide",
                    selector=str(metric.get("selector") or "slide"),
                    summary="Rendered slide is near-blank and likely mechanically corrupted.",
                    repair_hint="Restore the required semantic elements with supported native HTML/CSS.",
                )
            )
    return issues


def _dark_request_light_render_issues(deck: DeckBuild, metrics: list[dict[str, Any]]) -> list[MechanicalGateIssue]:
    if not _dark_requested(deck):
        return []
    readable = [metric for metric in metrics if not metric.get("unreadable")]
    if not readable:
        return []
    light_count = sum(1 for metric in readable if float(metric.get("mean_luminance") or 0.0) > 205)
    if light_count <= len(readable) / 2:
        return []
    return [
        MechanicalGateIssue(
            code="dark_request_rendered_light",
            selector="deck",
            summary="Dark/technical deck request rendered as majority-light slides.",
            repair_hint="Use an opaque dark slide substrate consistently across the deck.",
        )
    ]


def _dark_requested(deck: DeckBuild) -> bool:
    plan = deck.design_plan
    haystack = " ".join(
        [
            str(deck.style_profile),
            str(getattr(plan, "style_lane", "")),
            str(getattr(plan, "signature", "")),
            str(getattr(plan, "requested_style_terms", "")),
        ]
    )
    return bool(_DARK_STYLE_RE.search(haystack))


def _render_metrics(rendered_dir: Path | None) -> list[dict[str, Any]]:
    if rendered_dir is None or Image is None or ImageStat is None or not rendered_dir.is_dir():
        return []
    metrics: list[dict[str, Any]] = []
    for index, path in enumerate(sorted(rendered_dir.glob("slide-*.*")), start=1):
        if path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        selector = f"slide:{index}"
        try:
            with Image.open(path) as image:
                rgb = image.convert("RGB")
                stat = ImageStat.Stat(rgb)
                mean = sum(stat.mean) / 3.0
                sample = rgb.resize((64, 36))
                bg = sample.getpixel((0, 0))
                pixels = list(sample.get_flattened_data())
                changed = sum(1 for pixel in pixels if _distance(pixel, bg) > 18)
                metrics.append(
                    {
                        "selector": selector,
                        "file": path.name,
                        "mean_luminance": round(mean, 2),
                        "non_background_ratio": round(changed / max(1, len(pixels)), 4),
                    }
                )
        except Exception:  # noqa: BLE001
            metrics.append({"selector": selector, "file": path.name, "unreadable": True})
    return metrics


def _distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5
