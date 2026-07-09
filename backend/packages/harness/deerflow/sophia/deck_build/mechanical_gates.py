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
_KNOWN_RESIDUE_KINDS = {
    "overflow",
    "off_slide",
    "covered_by",
    "unreadable",
    "font_size",
    "overlap",
    "z_order",
    "text_clipped",
}


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
    issues.extend(_native_residue_issues(deck))
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


def _native_residue_issues(deck: DeckBuild) -> list[MechanicalGateIssue]:
    report = deck.native_mechanical_report if isinstance(deck.native_mechanical_report, dict) else {}
    lint = report.get("lint_fix") if isinstance(report.get("lint_fix"), dict) else {}
    residue_count = int(lint.get("residue_count") or 0)
    if residue_count <= 0:
        return []
    residue_kinds = lint.get("residue_kinds")
    kinds = set(str(key) for key in residue_kinds) if isinstance(residue_kinds, dict) else set()
    unknown = sorted(kind for kind in kinds if kind not in _KNOWN_RESIDUE_KINDS)
    if not unknown:
        return []
    return [
        MechanicalGateIssue(
            code="unknown_native_lint_residue",
            selector="deck",
            summary=f"Native lint/fix left unknown residue kinds: {', '.join(unknown[:5])}.",
            repair_hint="Simplify or revise HTML geometry so hands-on-deck can produce clean native shapes.",
        )
    ]


def _sparse_render_issues(metrics: list[dict[str, Any]]) -> list[MechanicalGateIssue]:
    issues: list[MechanicalGateIssue] = []
    for metric in metrics:
        if metric.get("unreadable"):
            continue
        if float(metric.get("non_background_ratio") or 0.0) < 0.025:
            issues.append(
                MechanicalGateIssue(
                    code="sparse_rendered_slide",
                    selector=str(metric.get("selector") or "slide"),
                    summary="Rendered slide appears nearly blank or visually sparse.",
                    repair_hint="Add meaningful native visual structure, hierarchy, and support shapes while keeping semantic text native.",
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
                pixels = list(sample.getdata())
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
