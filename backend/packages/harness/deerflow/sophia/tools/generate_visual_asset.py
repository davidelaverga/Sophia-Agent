"""Deterministic local visual asset generation for Sophia builder artifacts."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from xml.sax.saxutils import escape

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_VISUALS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/visuals/"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_DEFAULT_PALETTE = ("#14b8a6", "#8b5cf6", "#f59e0b", "#ef4444", "#0ea5e9", "#22c55e")


VisualKind = Literal[
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


def _result(*, success: bool, **fields: Any) -> str:
    return json.dumps({"success": success, **fields}, ensure_ascii=False)


def _slug(value: str | None, fallback: str = "visual") -> str:
    stem = PurePosixPath(str(value or fallback)).stem
    slug = _SAFE_NAME_RE.sub("-", stem).strip("-._").lower()
    return (slug or fallback)[:72].strip("-._") or fallback


def _canonical_output_path(output_name: str | None, kind: str, suffix: str) -> str | None:
    raw = str(output_name or "").replace("\\", "/").strip()
    if raw.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        rel = raw[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
        base = PurePosixPath(rel).with_suffix(suffix)
        if not base.parts or ".." in base.parts:
            return None
        if base.parts[0] != "visuals":
            base = PurePosixPath("visuals") / base.name
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{base.as_posix()}"
    name = _slug(raw or kind, kind)
    return f"{_VISUALS_VIRTUAL_PREFIX}{name}{suffix}"


def _host_path_for_virtual_output(virtual_path: str, runtime: ToolRuntime | None) -> Path:
    thread_data = get_thread_data(runtime)
    if thread_data and thread_data.get("outputs_path"):
        rel = virtual_path[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
        outputs_root = Path(str(thread_data["outputs_path"])).resolve()
        host_path = (outputs_root / rel).resolve()
        host_path.relative_to(outputs_root)
        return host_path
    return Path(virtual_path)


def _palette(values: list[str] | None) -> tuple[str, ...]:
    clean = [str(value) for value in values or [] if re.fullmatch(r"#[0-9A-Fa-f]{6}", str(value))]
    return tuple(clean[:8]) or _DEFAULT_PALETTE


def _coerce_items(data: Any, *, max_items: int = 8) -> list[tuple[str, float]]:
    items: list[tuple[str, float]] = []
    if isinstance(data, list):
        for index, item in enumerate(data[:max_items]):
            if isinstance(item, dict):
                label = str(item.get("label") or item.get("name") or item.get("title") or f"Item {index + 1}")
                raw_value = item.get("value") if "value" in item else item.get("y")
            else:
                label = f"Item {index + 1}"
                raw_value = item
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                value = float(index + 1)
            items.append((label[:36], max(value, 0.0)))
    return items or [("A", 3.0), ("B", 5.0), ("C", 4.0)]


def _coerce_text_items(items: Any, *, max_items: int = 8) -> list[str]:
    if isinstance(items, list):
        clean = []
        for index, item in enumerate(items[:max_items]):
            if isinstance(item, dict):
                text = item.get("label") or item.get("title") or item.get("name") or item.get("text")
            else:
                text = item
            value = str(text or f"Step {index + 1}").strip()
            if value:
                clean.append(value[:64])
        if clean:
            return clean
    return ["Discover", "Plan", "Create", "Validate"]


def _svg_shell(width: int, height: int, title: str, body: str) -> str:
    safe_title = escape(title[:96] or "Visual")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{safe_title}">'
        "<defs><style>"
        ".title{font:700 28px Inter,Arial,sans-serif;fill:#111827}"
        ".label{font:500 14px Inter,Arial,sans-serif;fill:#334155}"
        ".small{font:500 12px Inter,Arial,sans-serif;fill:#64748b}"
        ".card{fill:#ffffff;stroke:#d8dee9;stroke-width:1.5}"
        "</style></defs>"
        '<rect width="100%" height="100%" rx="28" fill="#f8fafc"/>'
        f'<text x="40" y="54" class="title">{safe_title}</text>'
        f"{body}</svg>"
    )


def _bar_svg(title: str, data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int) -> str:
    chart_x, chart_y, chart_w, chart_h = 70, 92, width - 120, height - 170
    max_v = max(value for _, value in data) or 1.0
    gap = 12
    bar_w = max(24, (chart_w - gap * (len(data) - 1)) / len(data))
    parts = [f'<line x1="{chart_x}" y1="{chart_y + chart_h}" x2="{chart_x + chart_w}" y2="{chart_y + chart_h}" stroke="#94a3b8"/>']
    for i, (label, value) in enumerate(data):
        h = chart_h * (value / max_v)
        x = chart_x + i * (bar_w + gap)
        y = chart_y + chart_h - h
        color = colors[i % len(colors)]
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{h:.1f}" rx="8" fill="{color}"/>')
        parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{chart_y + chart_h + 24}" class="small" text-anchor="middle">{escape(label)}</text>')
        parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{y - 8:.1f}" class="small" text-anchor="middle">{value:g}</text>')
    return _svg_shell(width, height, title, "".join(parts))


def _line_svg(title: str, data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int) -> str:
    chart_x, chart_y, chart_w, chart_h = 70, 94, width - 120, height - 170
    max_v = max(value for _, value in data) or 1.0
    min_v = min(value for _, value in data)
    span = max(max_v - min_v, 1.0)
    points = []
    for i, (_, value) in enumerate(data):
        x = chart_x + (chart_w * i / max(len(data) - 1, 1))
        y = chart_y + chart_h - ((value - min_v) / span * chart_h)
        points.append((x, y))
    path = " ".join(("M" if i == 0 else "L") + f"{x:.1f},{y:.1f}" for i, (x, y) in enumerate(points))
    parts = [f'<rect x="{chart_x}" y="{chart_y}" width="{chart_w}" height="{chart_h}" class="card" rx="18"/>']
    parts.append(f'<path d="{path}" fill="none" stroke="{colors[0]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
    for i, ((label, value), (x, y)) in enumerate(zip(data, points, strict=False)):
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="7" fill="{colors[i % len(colors)]}"/>')
        parts.append(f'<text x="{x:.1f}" y="{chart_y + chart_h + 24}" class="small" text-anchor="middle">{escape(label)}</text>')
        parts.append(f'<text x="{x:.1f}" y="{y - 12:.1f}" class="small" text-anchor="middle">{value:g}</text>')
    return _svg_shell(width, height, title, "".join(parts))


def _pie_svg(title: str, data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int, *, donut: bool) -> str:
    total = sum(value for _, value in data) or 1.0
    cx, cy, r = width * 0.38, height * 0.54, min(width, height) * 0.27
    start = -math.pi / 2
    parts = []
    for i, (label, value) in enumerate(data):
        angle = (value / total) * 2 * math.pi
        end = start + angle
        x1, y1 = cx + r * math.cos(start), cy + r * math.sin(start)
        x2, y2 = cx + r * math.cos(end), cy + r * math.sin(end)
        large = 1 if angle > math.pi else 0
        color = colors[i % len(colors)]
        parts.append(f'<path d="M{cx:.1f},{cy:.1f} L{x1:.1f},{y1:.1f} A{r:.1f},{r:.1f} 0 {large},1 {x2:.1f},{y2:.1f} Z" fill="{color}"/>')
        legend_y = 130 + i * 30
        parts.append(f'<rect x="{width * 0.68:.1f}" y="{legend_y - 14}" width="18" height="18" rx="5" fill="{color}"/>')
        parts.append(f'<text x="{width * 0.68 + 28:.1f}" y="{legend_y}" class="label">{escape(label)} ({value:g})</text>')
        start = end
    if donut:
        parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.52:.1f}" fill="#f8fafc"/>')
    return _svg_shell(width, height, title, "".join(parts))


def _cards_svg(title: str, items: list[str], colors: tuple[str, ...], width: int, height: int, kind: str) -> str:
    parts = []
    if kind in {"timeline", "process_flow"}:
        y = height * 0.55
        start_x, end_x = 80, width - 80
        parts.append(f'<line x1="{start_x}" y1="{y}" x2="{end_x}" y2="{y}" stroke="#cbd5e1" stroke-width="4"/>')
        for i, item in enumerate(items):
            x = start_x + (end_x - start_x) * i / max(len(items) - 1, 1)
            color = colors[i % len(colors)]
            parts.append(f'<circle cx="{x:.1f}" cy="{y}" r="24" fill="{color}"/>')
            parts.append(f'<text x="{x:.1f}" y="{y + 6}" fill="white" font-size="16" font-weight="700" text-anchor="middle">{i + 1}</text>')
            parts.append(f'<text x="{x:.1f}" y="{y + 56}" class="label" text-anchor="middle">{escape(item)}</text>')
    elif kind == "quadrant":
        cx, cy = width / 2, height / 2 + 15
        parts.append(f'<line x1="90" y1="{cy}" x2="{width-90}" y2="{cy}" stroke="#94a3b8" stroke-width="3"/>')
        parts.append(f'<line x1="{cx}" y1="92" x2="{cx}" y2="{height-70}" stroke="#94a3b8" stroke-width="3"/>')
        positions = [(width * .28, height * .32), (width * .72, height * .32), (width * .28, height * .73), (width * .72, height * .73)]
        for i, item in enumerate(items[:4]):
            x, y = positions[i]
            parts.append(f'<rect x="{x-115:.1f}" y="{y-34:.1f}" width="230" height="68" rx="16" fill="{colors[i % len(colors)]}" opacity="0.16"/>')
            parts.append(f'<text x="{x:.1f}" y="{y+5:.1f}" class="label" text-anchor="middle">{escape(item)}</text>')
    else:
        cols = 2
        card_w, card_h = (width - 130) / cols, 78
        for i, item in enumerate(items):
            row, col = divmod(i, cols)
            x = 50 + col * (card_w + 30)
            y = 100 + row * (card_h + 24)
            color = colors[i % len(colors)]
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{card_w:.1f}" height="{card_h}" class="card" rx="18"/>')
            parts.append(f'<circle cx="{x + 30:.1f}" cy="{y + 39}" r="14" fill="{color}"/>')
            parts.append(f'<text x="{x + 56:.1f}" y="{y + 45}" class="label">{escape(item)}</text>')
    return _svg_shell(width, height, title, "".join(parts))


def _svg_for(kind: str, title: str, data: Any, colors: tuple[str, ...], width: int, height: int) -> str:
    if kind == "bar_chart":
        return _bar_svg(title, _coerce_items(data), colors, width, height)
    if kind == "line_chart":
        return _line_svg(title, _coerce_items(data), colors, width, height)
    if kind in {"pie_chart", "donut_chart"}:
        return _pie_svg(title, _coerce_items(data), colors, width, height, donut=kind == "donut_chart")
    return _cards_svg(title, _coerce_text_items(data), colors, width, height, kind)


def _write_png_preview(svg_path: Path, png_path: Path, width: int, height: int, title: str) -> tuple[bool, str | None]:
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return False, "pillow_unavailable"
    try:
        image = Image.new("RGB", (width, height), "#f8fafc")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((8, 8, width - 8, height - 8), radius=28, outline="#cbd5e1", width=3)
        draw.text((40, 36), title[:96] or svg_path.stem, fill="#111827")
        draw.text((40, height - 52), f"SVG source: {svg_path.name}", fill="#64748b")
        png_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(png_path)
        return True, None
    except Exception as exc:
        return False, exc.__class__.__name__


@tool("generate_visual_asset", parse_docstring=True)
def generate_visual_asset(
    runtime: ToolRuntime,
    visual_type: VisualKind,
    title: str,
    data: list[dict[str, Any]] | list[str] | None = None,
    output_name: str | None = None,
    width: int = 960,
    height: int = 540,
    palette: list[str] | None = None,
) -> str:
    """Create a deterministic local SVG visual asset, plus a PNG preview when possible.

    Use this for charts and diagrams that must be embedded into HTML, PDF, or
    PPTX artifacts. Files are written under /mnt/user-data/outputs/visuals/.

    Args:
        visual_type: The visual family to generate, such as bar_chart,
            timeline, process_flow, or architecture_diagram.
        title: Short public title rendered into the visual.
        data: Chart data or diagram labels. Keep it concise and public-safe.
        output_name: Optional filename or virtual output path. The tool always
            writes under /mnt/user-data/outputs/visuals/.
        width: SVG/PNG width in pixels, between 320 and 2400.
        height: SVG/PNG height in pixels, between 240 and 1600.
        palette: Optional hex colors such as ["#14b8a6", "#f59e0b"].
    """
    if width < 320 or width > 2400 or height < 240 or height > 1600:
        return _result(success=False, error_type="invalid_dimensions")
    svg_virtual = _canonical_output_path(output_name, visual_type, ".svg")
    png_virtual = _canonical_output_path(output_name, visual_type, ".png")
    if svg_virtual is None or png_virtual is None:
        return _result(success=False, error_type="invalid_output_path")

    try:
        svg_path = _host_path_for_virtual_output(svg_virtual, runtime)
        png_path = _host_path_for_virtual_output(png_virtual, runtime)
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        svg = _svg_for(visual_type, str(title or visual_type), data, _palette(palette), width, height)
        svg_path.write_text(svg, encoding="utf-8")
        png_success, png_error = _write_png_preview(svg_path, png_path, width, height, str(title or visual_type))
        payload = {
            "visual_type": visual_type,
            "svg_path": svg_virtual,
            "png_path": png_virtual if png_success else None,
            "width": width,
            "height": height,
            "svg_bytes": svg_path.stat().st_size,
            "png_bytes": png_path.stat().st_size if png_success and png_path.exists() else 0,
            "png_error": png_error,
        }
        return _result(success=True, **payload)
    except Exception as exc:
        return _result(success=False, error_type=exc.__class__.__name__)
