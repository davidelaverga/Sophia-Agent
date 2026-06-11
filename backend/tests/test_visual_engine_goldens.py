"""G-VIS golden gates for the deterministic visual engine.

G-VIS-1: for every visual kind, a stress fixture (8 items x 60-char labels plus
a long title) must emit ZERO overlapping text bounding boxes. Boxes are derived
from the emitted SVG positions using the same width-estimate math the engine
uses, including rotated bar labels (separating-axis test on oriented boxes).

G-VIS-2: the 10 declared visual kinds rendered over one shared fixture must
produce 10 structurally DISTINCT SVGs (no two identical structural signatures),
with kind-specific structural anchors (real grid for comparison_matrix, chevron
polygons for process_flow, radial hub for concept_map, arrows for
architecture_diagram).
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from collections import Counter

import pytest

from deerflow.sophia.tools.generate_visual_asset import (
    _CHAR_WIDTH_RATIO,
    _CHAR_WIDTH_RATIO_BOLD,
    _palette,
    _svg_for,
    _validate_png,
    _write_png_cairosvg,
    _write_png_pillow,
    _write_png_svglib,
)

KINDS = [
    "bar_chart",
    "line_chart",
    "pie_chart",
    "donut_chart",
    "timeline",
    "process_flow",
    "architecture_diagram",
    "comparison_matrix",
    "quadrant",
    "concept_map",
]

WIDTH, HEIGHT = 960, 540
LONG_TITLE = "Strategic capability assessment covering operational resilience"
_LABEL_STEM = "deliberate expansion across resilient operating segments"
_CLASS_FONT = {"title": 28.0, "label": 14.0, "small": 12.0}
_ROTATE_RE = re.compile(r"rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)")


def _stress_items() -> list[dict[str, object]]:
    # 8 items, each label exactly 60 characters.
    return [{"label": f"{_LABEL_STEM} {i:02d}"[:60].ljust(60, "x"), "value": i + 3} for i in range(8)]


def _tag(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def _float(node: ET.Element, name: str, default: float = 0.0) -> float:
    try:
        return float(node.attrib.get(name, default))
    except (TypeError, ValueError):
        return default


def _font_px(node: ET.Element) -> float:
    raw = node.attrib.get("font-size")
    if raw:
        return float(raw)
    return _CLASS_FONT.get(node.attrib.get("class", ""), 14.0)


def _is_bold(node: ET.Element) -> bool:
    return node.attrib.get("class") == "title" or node.attrib.get("font-weight") == "700"


def _segments(node: ET.Element, font_px: float) -> list[tuple[float, float, str]]:
    x, y = _float(node, "x"), _float(node, "y")
    segments: list[tuple[float, float, str]] = []
    direct = (node.text or "").strip()
    if direct:
        segments.append((x, y, direct))
    current_y = y
    for child in node:
        if _tag(child) != "tspan":
            continue
        dy_raw = (child.attrib.get("dy") or "").strip()
        if dy_raw.endswith("em"):
            current_y += float(dy_raw[:-2]) * font_px
        elif dy_raw:
            current_y += float(dy_raw)
        text = (child.text or "").strip()
        if text:
            segments.append((_float(child, "x", x), current_y, text))
    return segments


def _rotate_point(px: float, py: float, angle_deg: float, cx: float, cy: float) -> tuple[float, float]:
    rad = math.radians(angle_deg)
    dx, dy = px - cx, py - cy
    return (cx + dx * math.cos(rad) - dy * math.sin(rad), cy + dx * math.sin(rad) + dy * math.cos(rad))


def _text_boxes(svg: str) -> list[tuple[list[tuple[float, float]], str]]:
    """Oriented text bounding boxes (4 corners each) using the engine's width math."""
    root = ET.fromstring(svg)
    boxes: list[tuple[list[tuple[float, float]], str]] = []
    for node in root.iter():
        if _tag(node) != "text":
            continue
        font = _font_px(node)
        bold = _is_bold(node)
        ratio = _CHAR_WIDTH_RATIO_BOLD if bold else _CHAR_WIDTH_RATIO
        anchor = node.attrib.get("text-anchor", "start")
        rotation = _ROTATE_RE.search(node.attrib.get("transform", "") or "")
        for sx, sy, text in _segments(node, font):
            w = ratio * font * len(text)
            x0 = sx if anchor == "start" else sx - w if anchor == "end" else sx - w / 2
            top, bottom = sy - 0.78 * font, sy + 0.22 * font
            corners = [(x0, top), (x0 + w, top), (x0 + w, bottom), (x0, bottom)]
            if rotation:
                angle, cx, cy = (float(g) for g in rotation.groups())
                corners = [_rotate_point(px, py, angle, cx, cy) for px, py in corners]
            boxes.append((corners, text))
    return boxes


def _project(corners: list[tuple[float, float]], axis: tuple[float, float]) -> tuple[float, float]:
    dots = [px * axis[0] + py * axis[1] for px, py in corners]
    return min(dots), max(dots)


def _overlaps(a: list[tuple[float, float]], b: list[tuple[float, float]], eps: float = 0.75) -> bool:
    """Separating-axis intersection test for two convex quads."""
    for quad in (a, b):
        for i in range(4):
            x1, y1 = quad[i]
            x2, y2 = quad[(i + 1) % 4]
            edge = (x2 - x1, y2 - y1)
            length = math.hypot(*edge) or 1.0
            axis = (-edge[1] / length, edge[0] / length)
            a_min, a_max = _project(a, axis)
            b_min, b_max = _project(b, axis)
            if a_max <= b_min + eps or b_max <= a_min + eps:
                return False
    return True


def _render(kind: str) -> str:
    return _svg_for(kind, LONG_TITLE, _stress_items(), _palette(None), WIDTH, HEIGHT)


# --- G-VIS-1: zero overlapping text bounding boxes ------------------------------


@pytest.mark.parametrize("kind", KINDS)
def test_g_vis_1_no_overlapping_text_boxes(kind: str) -> None:
    svg = _render(kind)
    boxes = _text_boxes(svg)
    assert boxes, f"{kind} emitted no text"

    collisions = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if _overlaps(boxes[i][0], boxes[j][0]):
                collisions.append((boxes[i][1], boxes[j][1]))
    assert not collisions, f"{kind}: overlapping text boxes: {collisions[:5]}"


@pytest.mark.parametrize("renderer", ["cairosvg", "svglib", "pillow"])
def test_g_vis_1_tri_renderer_smoke(tmp_path, renderer: str) -> None:
    svg = _render("timeline")
    assert "<tspan" in svg  # the fixture must actually exercise wrapped labels
    svg_file = tmp_path / "fixture.svg"
    svg_file.write_text(svg, encoding="utf-8")
    png = tmp_path / f"fixture-{renderer}.png"

    if renderer == "cairosvg":
        success, error = _write_png_cairosvg(svg, png, WIDTH, HEIGHT)
    elif renderer == "svglib":
        success, error = _write_png_svglib(svg_file, png, WIDTH, HEIGHT)
    else:
        success, error = _write_png_pillow(svg, png, WIDTH, HEIGHT)

    if not success and error and error.endswith("_unavailable"):
        pytest.skip(f"{renderer} import unavailable: {error}")
    assert success is True, f"{renderer}: {error}"
    assert _validate_png(png, WIDTH, HEIGHT) == "ok"


# --- G-VIS-2: structural kind de-collapse ---------------------------------------


def _signature(svg: str) -> tuple:
    root = ET.fromstring(svg)
    counts: Counter[str] = Counter()
    for node in root.iter():
        tag = _tag(node)
        if tag == "rect" and node.attrib.get("width") == "100%":
            continue  # canvas background
        if tag == "path":
            fill = node.attrib.get("fill", "")
            counts["path_filled" if fill not in ("", "none") else "path_stroked"] += 1
        elif tag in {"rect", "circle", "ellipse", "line", "polygon", "polyline"}:
            counts[tag] += 1
    return tuple(sorted(counts.items()))


def _shared_fixture() -> list[dict[str, object]]:
    return [{"label": f"Component {i}", "value": i + 2} for i in range(5)]


def _count(svg: str, tag: str) -> int:
    return sum(1 for node in ET.fromstring(svg).iter() if _tag(node) == tag)


def test_g_vis_2_ten_kinds_are_structurally_distinct() -> None:
    fixture = _shared_fixture()
    svgs = {kind: _svg_for(kind, "Quarterly platform overview", fixture, _palette(None), WIDTH, HEIGHT) for kind in KINDS}
    signatures = {kind: _signature(svg) for kind, svg in svgs.items()}

    assert len(set(signatures.values())) == len(KINDS), f"signature collisions: {signatures}"

    matrix = svgs["comparison_matrix"]
    assert 'fill="#14b8a6"' in matrix  # accent header band
    assert _count(matrix, "line") >= 4  # real grid lines
    assert _count(matrix, "rect") >= 2  # header + alternating row tint

    process = svgs["process_flow"]
    assert _count(process, "polygon") >= 5  # one chevron per step
    assert _count(process, "circle") == 0  # visually distinct from timeline dots

    timeline = svgs["timeline"]
    assert _count(timeline, "circle") >= 5
    assert _count(timeline, "polygon") == 0

    concept = svgs["concept_map"]
    assert _count(concept, "ellipse") >= 5  # center hub + satellites
    assert _count(concept, "line") >= 4  # spokes

    architecture = svgs["architecture_diagram"]
    assert _count(architecture, "polyline") >= 1  # orthogonal connectors
    assert _count(architecture, "polygon") >= 1  # arrow heads
    assert _count(architecture, "rect") >= 5  # component boxes
