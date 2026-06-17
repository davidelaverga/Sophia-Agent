"""Deterministic local visual asset generation for Sophia builder artifacts."""

from __future__ import annotations

import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from xml.sax.saxutils import escape

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_VISUALS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/visuals/"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_DEFAULT_PALETTE = ("#14b8a6", "#8b5cf6", "#f59e0b", "#ef4444", "#0ea5e9", "#22c55e")
_REGISTRY_FILENAME = ".registry.json"

_LINE_SPACING = 1.25
_CHAR_WIDTH_RATIO = 0.58
_CHAR_WIDTH_RATIO_BOLD = 0.62
_TITLE_FONT = 28


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


class VisualDataError(ValueError):
    """Public-safe input validation error for visual specs."""

    def __init__(self, error_type: str, hint: str) -> None:
        super().__init__(hint)
        self.error_type = error_type
        self.hint = hint


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


def _coerce_chart_point(item: Any) -> tuple[str, float]:
    if not isinstance(item, dict):
        raise VisualDataError(
            "unlabeled_chart_data",
            "every chart data point must be an object with explicit label and value fields",
        )
    label = str(item.get("label") or item.get("name") or item.get("title") or "").strip()
    raw_value = item.get("value") if "value" in item else item.get("y")
    if not label:
        raise VisualDataError(
            "unlabeled_chart_data",
            "every chart data point needs an explicit label; placeholder Item N labels are not allowed",
        )
    try:
        return label, float(raw_value)
    except (TypeError, ValueError) as exc:
        raise VisualDataError(
            "invalid_chart_value",
            "every chart data point needs a numeric value; fabricated fallback values are not allowed",
        ) from exc


def _add_chart_item(
    *,
    items: list[tuple[str, float]],
    grouped: dict[str, float],
    label: str,
    value: float,
    dedupe_labels: bool,
) -> None:
    if dedupe_labels:
        grouped[label] = grouped.get(label, 0.0) + value
    else:
        items.append((label, value))


def _validated_chart_data(data: Any) -> list[Any]:
    if isinstance(data, list) and data:
        return data
    raise VisualDataError(
        "unlabeled_chart_data",
        "chart data must be a non-empty list of objects with explicit label and value fields",
    )


def _chart_value_or_none(value: float, *, drop_nonpositive: bool) -> float | None:
    normalized = max(value, 0.0)
    if drop_nonpositive and normalized <= 0:
        return None
    return normalized


def _max_chart_items_reached(items: list[tuple[str, float]], *, max_items: int, dedupe_labels: bool) -> bool:
    return not dedupe_labels and len(items) >= max_items


def _final_chart_items(
    items: list[tuple[str, float]],
    grouped: dict[str, float],
    *,
    max_items: int,
    dedupe_labels: bool,
) -> list[tuple[str, float]]:
    final_items = list(grouped.items())[:max_items] if dedupe_labels else items
    if final_items:
        return final_items
    raise VisualDataError(
        "unlabeled_chart_data",
        "chart data must contain at least one labeled non-zero point",
    )


def _coerce_items(
    data: Any,
    *,
    max_items: int = 8,
    drop_nonpositive: bool = False,
    dedupe_labels: bool = False,
) -> list[tuple[str, float]]:
    items: list[tuple[str, float]] = []
    grouped: dict[str, float] = {}
    for item in _validated_chart_data(data):
        label, value = _coerce_chart_point(item)
        normalized = _chart_value_or_none(value, drop_nonpositive=drop_nonpositive)
        if normalized is None:
            continue
        _add_chart_item(
            items=items,
            grouped=grouped,
            label=label,
            value=normalized,
            dedupe_labels=dedupe_labels,
        )
        if _max_chart_items_reached(items, max_items=max_items, dedupe_labels=dedupe_labels):
            break
    return _final_chart_items(items, grouped, max_items=max_items, dedupe_labels=dedupe_labels)


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
                clean.append(value[:96])
        if clean:
            return clean
    return ["Discover", "Plan", "Create", "Validate"]


# --- VQ-1: deterministic text-fit engine -------------------------------------


@dataclass(frozen=True)
class FittedText:
    lines: list[str]
    font_px: int
    ellipsized: bool


def _est_width(text: str, font_px: float, bold: bool = False) -> float:
    ratio = _CHAR_WIDTH_RATIO_BOLD if bold else _CHAR_WIDTH_RATIO
    return ratio * font_px * len(text)


def _split_long_word(word: str, max_width_px: float, font_px: float, bold: bool) -> list[str]:
    chars_per_line = max(int(max_width_px / ((_CHAR_WIDTH_RATIO_BOLD if bold else _CHAR_WIDTH_RATIO) * font_px)), 1)
    return [word[i : i + chars_per_line] for i in range(0, len(word), chars_per_line)]


def _wrap_words(text: str, max_width_px: float, font_px: float, bold: bool) -> list[str]:
    lines: list[str] = []
    current = ""
    for raw_word in text.split():
        pieces = _split_long_word(raw_word, max_width_px, font_px, bold) if _est_width(raw_word, font_px, bold) > max_width_px else [raw_word]
        for word in pieces:
            candidate = f"{current} {word}".strip()
            if current and _est_width(candidate, font_px, bold) > max_width_px:
                lines.append(current)
                current = word
            else:
                current = candidate
    if current:
        lines.append(current)
    return lines or [""]


def _font_ladder(font_px: int) -> list[int]:
    ladder = [font_px, max(round(font_px * 6 / 7), 1), max(round(font_px * 11 / 14), 1)]
    seen: list[int] = []
    for size in ladder:
        if size not in seen:
            seen.append(size)
    return seen


def _ellipsize(line: str, max_width_px: float, font_px: float, bold: bool) -> str:
    while line and _est_width(line + "…", font_px, bold) > max_width_px:
        line = line[:-1].rstrip()
    return line + "…"


def _fit_text(text: str, max_width_px: float, font_px: int, max_lines: int, bold: bool = False) -> FittedText:
    normalized = " ".join(str(text or "").split())
    max_width_px = max(max_width_px, 24.0)
    for size in _font_ladder(font_px):
        lines = _wrap_words(normalized, max_width_px, size, bold)
        if len(lines) <= max_lines:
            return FittedText(lines, size, False)
    size = _font_ladder(font_px)[-1]
    lines = _wrap_words(normalized, max_width_px, size, bold)[:max_lines]
    lines[-1] = _ellipsize(lines[-1], max_width_px, size, bold)
    return FittedText(lines, size, True)


def _text_block(x: float, y: float, fitted: FittedText, *, class_name: str = "label", anchor: str = "start", fill: str | None = None, bold: bool = False, extra: str = "") -> str:
    attrs = [f'x="{x:.1f}"', f'y="{y:.1f}"', f'class="{class_name}"', f'font-size="{fitted.font_px}"']
    if anchor != "start":
        attrs.append(f'text-anchor="{anchor}"')
    if fill:
        attrs.append(f'fill="{fill}"')
    if bold:
        attrs.append('font-weight="700"')
    if extra:
        attrs.append(extra)
    spans = [f"<tspan>{escape(fitted.lines[0])}</tspan>"]
    for line in fitted.lines[1:]:
        spans.append(f'<tspan x="{x:.1f}" dy="{_LINE_SPACING}em">{escape(line)}</tspan>')
    return f"<text {' '.join(attrs)}>{''.join(spans)}</text>"


def _plain_text(x: float, y: float, text: Any, font_px: int, *, class_name: str = "small", anchor: str = "middle", fill: str | None = None, bold: bool = False, extra: str = "") -> str:
    return _text_block(x, y, FittedText([str(text)], font_px, False), class_name=class_name, anchor=anchor, fill=fill, bold=bold, extra=extra)


def _centered_text(x: float, center_y: float, fitted: FittedText, **kwargs: Any) -> str:
    spacing = _LINE_SPACING * fitted.font_px
    first_baseline = center_y + 0.35 * fitted.font_px - (len(fitted.lines) - 1) * spacing / 2
    return _text_block(x, first_baseline, fitted, **kwargs)


def _fit_title(title: str, width: int) -> FittedText:
    return _fit_text(title or "Visual", width - 80, _TITLE_FONT, 2, bold=True)


def _body_top(title: FittedText) -> int:
    return 92 + round((len(title.lines) - 1) * _LINE_SPACING * title.font_px)


def _svg_shell(width: int, height: int, title: FittedText, body: str) -> str:
    aria = escape(" ".join(title.lines))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{aria}">'
        "<defs><style>"
        ".title{font-family:Inter,Arial,sans-serif;font-weight:700;fill:#111827}"
        ".label{font-family:Inter,Arial,sans-serif;font-weight:500;fill:#334155}"
        ".small{font-family:Inter,Arial,sans-serif;font-weight:500;fill:#64748b}"
        ".card{fill:#ffffff;stroke:#d8dee9;stroke-width:1.5}"
        "</style></defs>"
        '<rect width="100%" height="100%" rx="28" fill="#f8fafc"/>'
        f"{_text_block(40, 54, title, class_name='title', bold=True)}"
        f"{body}</svg>"
    )


# --- chart bodies -------------------------------------------------------------


def _bar_body(data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    chart_x, chart_w = 70, width - 120
    chart_h = height - top - 78
    axis_y = top + chart_h
    max_v = max(value for _, value in data) or 1.0
    gap = 12
    bar_w = max(24, (chart_w - gap * (len(data) - 1)) / len(data))
    rotate = len(data) > 6
    parts = [f'<line x1="{chart_x}" y1="{axis_y}" x2="{chart_x + chart_w}" y2="{axis_y}" stroke="#94a3b8"/>']
    for i, (label, value) in enumerate(data):
        h = chart_h * (value / max_v)
        x = chart_x + i * (bar_w + gap)
        y = axis_y - h
        cx = x + bar_w / 2
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{h:.1f}" rx="8" fill="{colors[i % len(colors)]}"/>')
        parts.append(_plain_text(cx, y - 8, f"{value:g}", 12))
        if rotate:
            budget = max((height - axis_y - 26) / 0.5, 60.0)
            fitted = _fit_text(label, budget, 12, 1)
            parts.append(_text_block(cx, axis_y + 18, fitted, class_name="small", anchor="end", extra=f'transform="rotate(-30 {cx:.1f} {axis_y + 18:.1f})"'))
        else:
            parts.append(_text_block(cx, axis_y + 22, _fit_text(label, bar_w + gap - 6, 12, 2), class_name="small", anchor="middle"))
    return "".join(parts)


def _line_body(data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    chart_x, chart_w = 70, width - 120
    chart_h = height - top - 78
    chart_y = top
    max_v = max(value for _, value in data) or 1.0
    min_v = min(value for _, value in data)
    span = max(max_v - min_v, 1.0)
    points = []
    for i, (_, value) in enumerate(data):
        x = chart_x + (chart_w * i / max(len(data) - 1, 1))
        y = chart_y + chart_h - ((value - min_v) / span * chart_h)
        points.append((x, y))
    path = " ".join(("M" if i == 0 else "L") + f"{x:.1f},{y:.1f}" for i, (x, y) in enumerate(points))
    slot = max(chart_w / max(len(data) - 1, 1) - 10, 56.0)
    parts = [f'<rect x="{chart_x}" y="{chart_y}" width="{chart_w}" height="{chart_h}" class="card" rx="18"/>']
    parts.append(f'<path d="{path}" fill="none" stroke="{colors[0]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
    for i, ((label, value), (x, y)) in enumerate(zip(data, points, strict=False)):
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="7" fill="{colors[i % len(colors)]}"/>')
        parts.append(_plain_text(x, y - 12, f"{value:g}", 12))
        parts.append(_text_block(x, chart_y + chart_h + 24, _fit_text(label, slot, 12, 2), class_name="small", anchor="middle"))
    return "".join(parts)


def _pie_body(data: list[tuple[str, float]], colors: tuple[str, ...], width: int, height: int, top: int, donut: bool) -> str:
    total = sum(value for _, value in data) or 1.0
    cx, cy, r = width * 0.36, top + (height - top) * 0.52, min(width, height) * 0.27
    legend_x = width * 0.66
    label_budget = width - legend_x - 52
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
        legend_y = top + 38 + i * 30
        parts.append(f'<rect x="{legend_x:.1f}" y="{legend_y - 14}" width="18" height="18" rx="5" fill="{color}"/>')
        parts.append(_text_block(legend_x + 28, legend_y, _fit_text(f"{label} ({value:g})", label_budget, 14, 1), anchor="start"))
        start = end
    if donut:
        parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.52:.1f}" fill="#f8fafc"/>')
    return "".join(parts)


# --- timeline -----------------------------------------------------------------


def _timeline_rows(items: list[str]) -> list[list[str]]:
    if len(items) <= 6:
        return [items]
    first = math.ceil(len(items) / 2)
    return [items[:first], items[first:]]


def _timeline_row(row: list[str], index_offset: int, y: float, colors: tuple[str, ...], width: int) -> str:
    start_x, end_x = 80, width - 80
    n = len(row)
    slot = (end_x - start_x) / max(n - 1, 1) - 16 if n > 1 else float(end_x - start_x)
    parts = [f'<line x1="{start_x}" y1="{y:.1f}" x2="{end_x}" y2="{y:.1f}" stroke="#cbd5e1" stroke-width="4"/>']
    for j, item in enumerate(row):
        global_index = index_offset + j
        x = (start_x + end_x) / 2 if n == 1 else start_x + (end_x - start_x) * j / (n - 1)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="20" fill="{colors[global_index % len(colors)]}"/>')
        parts.append(_plain_text(x, y + 5, global_index + 1, 14, class_name="label", fill="#ffffff", bold=True))
        anchor = "middle" if n == 1 else "start" if j == 0 else "end" if j == n - 1 else "middle"
        fitted = _fit_text(item, slot, 14, 2)
        spacing = _LINE_SPACING * fitted.font_px
        text_y = y + 46 if global_index % 2 == 0 else y - 38 - (len(fitted.lines) - 1) * spacing
        parts.append(_text_block(x, text_y, fitted, anchor=anchor))
    return "".join(parts)


def _timeline_body(items: list[str], colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    rows = _timeline_rows(items)
    fractions = [0.45] if len(rows) == 1 else [0.3, 0.75]
    parts = []
    index_offset = 0
    for row, fraction in zip(rows, fractions, strict=False):
        parts.append(_timeline_row(row, index_offset, top + (height - top) * fraction, colors, width))
        index_offset += len(row)
    return "".join(parts)


# --- cards / quadrant ---------------------------------------------------------


def _cards_body(items: list[str], colors: tuple[str, ...], width: int, height: int, top: int, caption: str | None = None) -> str:
    cols = 3 if len(items) > 6 else 2
    card_w = (width - 100 - 30 * (cols - 1)) / cols
    fitted = [_fit_text(item, card_w - 72, 14, 2) for item in items]
    card_h = 96 if any(len(f.lines) > 1 for f in fitted) else 78
    parts = []
    for i, f in enumerate(fitted):
        row, col = divmod(i, cols)
        x = 50 + col * (card_w + 30)
        y = top + 8 + row * (card_h + 20)
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{card_w:.1f}" height="{card_h}" class="card" rx="18"/>')
        parts.append(f'<circle cx="{x + 30:.1f}" cy="{y + card_h / 2:.1f}" r="14" fill="{colors[i % len(colors)]}"/>')
        parts.append(_centered_text(x + 56, y + card_h / 2, f))
    if caption:
        parts.append(_plain_text(width / 2, height - 16, caption, 12, anchor="middle"))
    return "".join(parts)


def _quadrant_body(items: list[str], colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    cx = width / 2
    cy = top + (height - top) / 2
    parts = [f'<line x1="90" y1="{cy:.1f}" x2="{width - 90}" y2="{cy:.1f}" stroke="#94a3b8" stroke-width="3"/>']
    parts.append(f'<line x1="{cx:.1f}" y1="{top + 6}" x2="{cx:.1f}" y2="{height - 40}" stroke="#94a3b8" stroke-width="3"/>')
    positions = [
        (width * 0.28, top + (height - top) * 0.27),
        (width * 0.72, top + (height - top) * 0.27),
        (width * 0.28, top + (height - top) * 0.76),
        (width * 0.72, top + (height - top) * 0.76),
    ]
    for i, item in enumerate(items[:4]):
        x, y = positions[i]
        parts.append(f'<rect x="{x - 115:.1f}" y="{y - 34:.1f}" width="230" height="68" rx="16" fill="{colors[i % len(colors)]}" opacity="0.16"/>')
        parts.append(_centered_text(x, y, _fit_text(item, 206, 14, 2), anchor="middle"))
    return "".join(parts)


# --- VQ-2: comparison matrix --------------------------------------------------


_MATRIX_LABEL_KEYS = ("label", "name", "title")


def _matrix_row_entry(row: Any, index: int) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(row, dict):
        return None
    label = next((str(row[key]) for key in _MATRIX_LABEL_KEYS if row.get(key)), f"Row {index + 1}")
    cells = {key: value for key, value in row.items() if key not in _MATRIX_LABEL_KEYS}
    return label[:96], cells


def _matrix_table(rows: list[dict[str, Any]] | None, data: Any) -> tuple[list[str], list[tuple[str, dict[str, Any]]]]:
    columns: list[str] = []
    table: list[tuple[str, dict[str, Any]]] = []
    for index, row in enumerate(rows or []):
        entry = _matrix_row_entry(row, index)
        if entry is None:
            continue
        for key in entry[1]:
            if key not in columns and len(columns) < 5:
                columns.append(key)
        table.append(entry)
        if len(table) >= 8:
            break
    if table and columns:
        return columns, table
    items = _coerce_items(data)
    return ["Value"], [(label, {"Value": value}) for label, value in items]


def _matrix_cell_text(value: Any) -> str:
    if value is True or str(value).strip().lower() in {"yes", "y", "true", "✓"}:
        return "✓"
    if value is None or value is False or str(value).strip().lower() in {"no", "n", "false", "-", "–", ""}:
        return "–"
    if isinstance(value, (int, float)):
        return f"{value:g}"
    return str(value)


def _matrix_cell_svg(center_x: float, row_y: float, row_h: float, value: Any, max_lines: int, col_w: float, accent: str) -> str:
    text = _matrix_cell_text(value)
    if text == "✓":
        return _plain_text(center_x, row_y + row_h / 2 + 5, "✓", 15, class_name="label", fill=accent, bold=True)
    if text == "–":
        return _plain_text(center_x, row_y + row_h / 2 + 5, "–", 15, class_name="label", fill="#94a3b8")
    return _centered_text(center_x, row_y + row_h / 2, _fit_text(text, col_w - 20, 13, max_lines), anchor="middle")


def _matrix_body(rows: list[dict[str, Any]] | None, data: Any, colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    columns, table = _matrix_table(rows, data)
    n_cols = len(columns) + 1
    x0, x1 = 50, width - 50
    col_w = (x1 - x0) / n_cols
    row_h = max(28.0, min(44.0, (height - top - 20) / (len(table) + 1)))
    max_lines = 2 if row_h >= 40 else 1
    bottom = top + row_h * (len(table) + 1)
    parts = [f'<rect x="{x0}" y="{top}" width="{x1 - x0}" height="{row_h:.1f}" fill="{colors[0]}"/>']
    for c, column in enumerate(columns):
        center_x = x0 + col_w * (c + 1) + col_w / 2
        parts.append(_centered_text(center_x, top + row_h / 2, _fit_text(column, col_w - 20, 14, 1, bold=True), anchor="middle", fill="#ffffff", bold=True))
    for r, (label, cells) in enumerate(table):
        row_y = top + row_h * (r + 1)
        if r % 2 == 1:
            parts.append(f'<rect x="{x0}" y="{row_y:.1f}" width="{x1 - x0}" height="{row_h:.1f}" fill="#eef2f7"/>')
        parts.append(_centered_text(x0 + 12, row_y + row_h / 2, _fit_text(label, col_w - 24, 13, max_lines)))
        for c, column in enumerate(columns):
            parts.append(_matrix_cell_svg(x0 + col_w * (c + 1) + col_w / 2, row_y, row_h, cells.get(column), max_lines, col_w, colors[0]))
    for c in range(n_cols + 1):
        x = x0 + col_w * c
        parts.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{bottom:.1f}" stroke="#cbd5e1" stroke-width="1"/>')
    for r in range(len(table) + 2):
        y = top + row_h * r
        parts.append(f'<line x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}" stroke="#cbd5e1" stroke-width="1"/>')
    return "".join(parts)


# --- VQ-2: architecture diagram -----------------------------------------------


def _node_index(ref: Any, lookup: dict[str, int], count: int) -> int | None:
    if isinstance(ref, bool):
        return None
    if isinstance(ref, int) and 0 <= ref < count:
        return ref
    if isinstance(ref, str):
        return lookup.get(ref.strip().lower())
    return None


def _edge_pairs(edges: list[dict[str, Any]] | None, labels: list[str]) -> list[tuple[int, int, str]]:
    lookup = {label.strip().lower(): index for index, label in enumerate(labels)}
    pairs: list[tuple[int, int, str]] = []
    for edge in edges or []:
        if not isinstance(edge, dict):
            continue
        source = _node_index(edge.get("from"), lookup, len(labels))
        target = _node_index(edge.get("to"), lookup, len(labels))
        if source is None or target is None or source == target:
            continue
        pairs.append((source, target, str(edge.get("label") or "")[:48]))
    return pairs


def _kahn_layers(count: int, adjacency: dict[int, list[int]], indegree: list[int], layer: list[int]) -> list[int]:
    queue = [node for node in range(count) if indegree[node] == 0]
    seen: list[int] = []
    while queue:
        node = queue.pop(0)
        seen.append(node)
        for neighbor in adjacency.get(node, []):
            layer[neighbor] = max(layer[neighbor], layer[node] + 1)
            indegree[neighbor] -= 1
            if indegree[neighbor] == 0:
                queue.append(neighbor)
    return seen


def _topo_layers(count: int, edges: list[tuple[int, int]]) -> list[list[int]]:
    adjacency: dict[int, list[int]] = {}
    indegree = [0] * count
    for source, target in edges:
        adjacency.setdefault(source, []).append(target)
        indegree[target] += 1
    layer = [0] * count
    seen = _kahn_layers(count, adjacency, indegree, layer)
    remaining = [node for node in range(count) if node not in seen]
    if remaining:
        cycle_layer = (max(layer[node] for node in seen) + 1) if seen else 0
        for node in remaining:
            layer[node] = cycle_layer
    grouped: dict[int, list[int]] = {}
    for node in range(count):
        grouped.setdefault(layer[node], []).append(node)
    return [grouped[key] for key in sorted(grouped)]


def _arch_centers(layers: list[list[int]], width: int, height: int, top: int) -> tuple[dict[int, tuple[float, float]], float]:
    step = (width - 110) / len(layers)
    centers: dict[int, tuple[float, float]] = {}
    for layer_index, layer in enumerate(layers):
        x = 55 + step * layer_index + step / 2
        for position, node in enumerate(layer):
            centers[node] = (x, top + 10 + (height - top - 40) * (position + 1) / (len(layer) + 1))
    return centers, step


def _orth_arrow(source: tuple[float, float], target: tuple[float, float], box_w: float, label: str, label_budget: float) -> str:
    sx = source[0] + box_w / 2
    tx = target[0] - box_w / 2
    mid_x = (sx + tx) / 2
    parts = [f'<polyline points="{sx:.1f},{source[1]:.1f} {mid_x:.1f},{source[1]:.1f} {mid_x:.1f},{target[1]:.1f} {tx - 9:.1f},{target[1]:.1f}" fill="none" stroke="#64748b" stroke-width="2"/>']
    parts.append(f'<polygon points="{tx - 9:.1f},{target[1] - 5:.1f} {tx:.1f},{target[1]:.1f} {tx - 9:.1f},{target[1] + 5:.1f}" fill="#64748b"/>')
    if label and label_budget >= 40:
        parts.append(_text_block(mid_x, (source[1] + target[1]) / 2 - 6, _fit_text(label, label_budget, 11, 1), class_name="small", anchor="middle"))
    return "".join(parts)


def _architecture_body(data: Any, edges: list[dict[str, Any]] | None, colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    labels = _coerce_text_items(data, max_items=12)
    if len(labels) > 8:
        return _cards_body(labels[:8], colors, width, height, top, caption=f"simplified view: {len(labels)} components")
    pairs = _edge_pairs(edges, labels)
    if not pairs:
        pairs = [(index, index + 1, "") for index in range(len(labels) - 1)]
    layers = _topo_layers(len(labels), [(source, target) for source, target, _ in pairs])
    centers, step = _arch_centers(layers, width, height, top)
    box_w = min(step - 22, 190.0)
    box_h = 54.0
    parts = []
    for source, target, label in pairs:
        parts.append(_orth_arrow(centers[source], centers[target], box_w, label, max(step - box_w - 8, 30.0)))
    for index, label in enumerate(labels):
        x, y = centers[index]
        parts.append(f'<rect x="{x - box_w / 2:.1f}" y="{y - box_h / 2:.1f}" width="{box_w:.1f}" height="{box_h}" class="card" rx="12"/>')
        parts.append(f'<line x1="{x - box_w / 2:.1f}" y1="{y + box_h / 2 - 4:.1f}" x2="{x + box_w / 2:.1f}" y2="{y + box_h / 2 - 4:.1f}" stroke="{colors[index % len(colors)]}" stroke-width="3"/>')
        parts.append(_centered_text(x, y - 2, _fit_text(label, box_w - 16, 12, 2), anchor="middle"))
    return "".join(parts)


# --- VQ-2: concept map --------------------------------------------------------


def _concept_edge_labels(edges: list[dict[str, Any]] | None, labels: list[str]) -> dict[int, str]:
    pairs = _edge_pairs(edges, labels)
    found: dict[int, str] = {}
    for source, target, label in pairs:
        if not label:
            continue
        satellite = target if source == 0 else source if target == 0 else None
        if satellite is not None and satellite not in found:
            found[satellite] = label
    return found


def _concept_body(data: Any, edges: list[dict[str, Any]] | None, colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    labels = _coerce_text_items(data, max_items=9)
    satellites = labels[1:]
    cx, cy = width / 2, top + (height - top) / 2
    ring_rx = width / 2 - 160
    ring_ry = max((height - top) / 2 - 64, 70.0)
    spoke_labels = _concept_edge_labels(edges, labels)
    parts = []
    positions: list[tuple[float, float]] = []
    for index in range(len(satellites)):
        angle = -math.pi / 2 + 2 * math.pi * index / max(len(satellites), 1)
        sx, sy = cx + ring_rx * math.cos(angle), cy + ring_ry * math.sin(angle)
        positions.append((sx, sy))
        parts.append(f'<line x1="{cx:.1f}" y1="{cy:.1f}" x2="{sx:.1f}" y2="{sy:.1f}" stroke="#94a3b8" stroke-width="2"/>')
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="110" ry="42" fill="{colors[0]}"/>')
    parts.append(_centered_text(cx, cy, _fit_text(labels[0], 190, 15, 2, bold=True), anchor="middle", fill="#ffffff", bold=True))
    for index, (label, (sx, sy)) in enumerate(zip(satellites, positions, strict=False)):
        parts.append(f'<ellipse cx="{sx:.1f}" cy="{sy:.1f}" rx="88" ry="32" fill="#ffffff" stroke="{colors[(index + 1) % len(colors)]}" stroke-width="2"/>')
        parts.append(_centered_text(sx, sy, _fit_text(label, 150, 12, 2), anchor="middle"))
        spoke_label = spoke_labels.get(index + 1)
        if spoke_label:
            parts.append(_text_block(cx + (sx - cx) * 0.55, cy + (sy - cy) * 0.55 - 6, _fit_text(spoke_label, 90, 11, 1), class_name="small", anchor="middle"))
    return "".join(parts)


# --- VQ-2: process flow chevrons ----------------------------------------------


def _chunks(sequence: list[str], size: int) -> list[list[str]]:
    return [sequence[index : index + size] for index in range(0, len(sequence), size)]


def _process_lanes(groups: list[dict[str, Any]] | None, data: Any) -> tuple[list[tuple[str, list[str]]], bool]:
    lanes: list[tuple[str, list[str]]] = []
    for group in groups or []:
        if not isinstance(group, dict):
            continue
        steps_raw = group.get("items") or group.get("steps")
        if not steps_raw:
            continue
        lanes.append((str(group.get("label") or group.get("name") or "")[:48], _coerce_text_items(steps_raw, max_items=6)))
    if lanes:
        return lanes[:4], True
    items = _coerce_text_items(data)
    return [("", chunk) for chunk in _chunks(items, 5)], False


def _chevron_points(x: float, y: float, w: float, h: float, tip: float, notch: bool) -> str:
    points = [(x, y), (x + w - tip, y), (x + w, y + h / 2), (x + w - tip, y + h), (x, y + h)]
    if notch:
        points.append((x + tip, y + h / 2))
    return " ".join(f"{px:.1f},{py:.1f}" for px, py in points)


def _process_body(data: Any, groups: list[dict[str, Any]] | None, colors: tuple[str, ...], width: int, height: int, top: int) -> str:
    lanes, labeled = _process_lanes(groups, data)
    max_len = max(len(steps) for _, steps in lanes)
    chev_w = (width - 100) / max(max_len, 1)
    chev_h = 58.0
    pitch = min(chev_h + 48, (height - top - 16) / len(lanes))
    parts = []
    global_index = 0
    for lane_index, (lane_label, steps) in enumerate(lanes):
        y = top + 18 + lane_index * pitch
        if lane_label:
            parts.append(_plain_text(50, y - 8, lane_label, 12, anchor="start"))
        for j, step in enumerate(steps):
            x = 50 + j * chev_w
            notch = j > 0 or (not labeled and global_index > 0)
            parts.append(f'<polygon points="{_chevron_points(x, y, chev_w - 4, chev_h, 20, notch)}" fill="{colors[global_index % len(colors)]}"/>')
            parts.append(_centered_text(x + chev_w / 2 + 4, y + chev_h / 2, _fit_text(step, chev_w - 46, 12, 2), anchor="middle", fill="#ffffff"))
            global_index += 1
    return "".join(parts)


# --- dispatch -----------------------------------------------------------------


def _svg_for(
    kind: str,
    title: str,
    data: Any,
    colors: tuple[str, ...],
    width: int,
    height: int,
    rows: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    groups: list[dict[str, Any]] | None = None,
) -> str:
    fitted_title = _fit_title(title, width)
    top = _body_top(fitted_title)
    if kind == "bar_chart":
        body = _bar_body(
            _coerce_items(data, drop_nonpositive=True),
            colors,
            width,
            height,
            top,
        )
    elif kind == "line_chart":
        body = _line_body(_coerce_items(data), colors, width, height, top)
    elif kind in {"pie_chart", "donut_chart"}:
        body = _pie_body(_coerce_items(data), colors, width, height, top, kind == "donut_chart")
    elif kind == "timeline":
        body = _timeline_body(_coerce_text_items(data), colors, width, height, top)
    elif kind == "process_flow":
        body = _process_body(data, groups, colors, width, height, top)
    elif kind == "architecture_diagram":
        body = _architecture_body(data, edges, colors, width, height, top)
    elif kind == "comparison_matrix":
        body = _matrix_body(rows, data, colors, width, height, top)
    elif kind == "concept_map":
        body = _concept_body(data, edges, colors, width, height, top)
    elif kind == "quadrant":
        body = _quadrant_body(_coerce_text_items(data), colors, width, height, top)
    else:
        body = _cards_body(_coerce_text_items(data), colors, width, height, top)
    return _svg_shell(width, height, fitted_title, body)


# --- PNG rendering ------------------------------------------------------------


def _validate_png(png_path: Path, width: int, height: int) -> str:
    try:
        from PIL import Image
    except Exception:  # pragma: no cover - dependency is installed in runtime.
        return "pillow_unavailable"
    try:
        with Image.open(png_path) as image:
            image.verify()
        with Image.open(png_path) as image:
            image.load()
            if image.size != (width, height):
                return f"invalid_dimensions:{image.size[0]}x{image.size[1]}"
            extrema = image.convert("RGB").getextrema()
            if not any(channel_max > channel_min for channel_min, channel_max in extrema):
                return "blank_or_uniform"
    except Exception as exc:
        return exc.__class__.__name__
    return "ok"


def _write_png_cairosvg(svg: str, png_path: Path, width: int, height: int) -> tuple[bool, str | None]:
    try:
        import cairosvg
    except Exception:
        return False, "cairosvg_unavailable"
    try:
        png_path.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(
            bytestring=svg.encode("utf-8"),
            write_to=str(png_path),
            output_width=width,
            output_height=height,
            background_color="#ffffff",
        )
        return True, None
    except Exception as exc:
        return False, exc.__class__.__name__


def _write_png_svglib(svg_path: Path, png_path: Path, width: int, height: int) -> tuple[bool, str | None]:
    try:
        from reportlab.graphics import renderPM
        from svglib.svglib import svg2rlg
    except Exception:
        return False, "svglib_unavailable"
    try:
        png_path.parent.mkdir(parents=True, exist_ok=True)
        drawing = svg2rlg(str(svg_path))
        if drawing is None:
            return False, "svglib_empty_drawing"
        source_width = float(getattr(drawing, "width", width) or width)
        source_height = float(getattr(drawing, "height", height) or height)
        drawing.scale(width / source_width, height / source_height)
        drawing.width = width
        drawing.height = height
        renderPM.drawToFile(drawing, str(png_path), fmt="PNG")
        return True, None
    except Exception as exc:
        if exc.__class__.__name__ == "RenderPMError" and "cannot import" in str(exc):
            return False, "svglib_unavailable"
        return False, exc.__class__.__name__


def _float_attr(node: ET.Element, name: str, default: float = 0.0) -> float:
    try:
        return float(str(node.attrib.get(name, default)).replace("%", ""))
    except (TypeError, ValueError):
        return default


def _safe_color(value: str | None, default: str) -> str:
    if isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", value.strip()):
        return value.strip()
    return default


_PILLOW_CLASS_FONT = {"title": 28.0, "label": 14.0, "small": 12.0}
_PILLOW_CLASS_FILL = {"title": "#111827", "label": "#334155", "small": "#64748b"}


def _node_font_px(node: ET.Element) -> float:
    raw = node.attrib.get("font-size")
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    return _PILLOW_CLASS_FONT.get(node.attrib.get("class", ""), 14.0)


def _parse_dy(raw: str | None, font_px: float) -> float:
    if not raw:
        return 0.0
    raw = raw.strip()
    try:
        if raw.endswith("em"):
            return float(raw[:-2]) * font_px
        return float(raw.replace("px", ""))
    except ValueError:
        return 0.0


def _text_segments(node: ET.Element, font_px: float) -> list[tuple[float, float, str]]:
    x = _float_attr(node, "x")
    y = _float_attr(node, "y")
    segments: list[tuple[float, float, str]] = []
    direct = (node.text or "").strip()
    if direct:
        segments.append((x, y, direct))
    current_y = y
    for child in node:
        if child.tag.rsplit("}", 1)[-1] != "tspan":
            continue
        current_y += _parse_dy(child.attrib.get("dy"), font_px)
        text = (child.text or "").strip()
        if text:
            segments.append((_float_attr(child, "x", x), current_y, text))
    return segments


def _parse_points(raw: str | None) -> list[tuple[float, float]]:
    values = [float(token) for token in re.split(r"[\s,]+", (raw or "").strip()) if token]
    return list(zip(values[0::2], values[1::2], strict=False))


def _pillow_rect(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    raw_w, raw_h = node.attrib.get("width"), node.attrib.get("height")
    x, y = _float_attr(node, "x"), _float_attr(node, "y")
    w = float(ctx["width"]) if raw_w == "100%" else _float_attr(node, "width", ctx["width"])
    h = float(ctx["height"]) if raw_h == "100%" else _float_attr(node, "height", ctx["height"])
    fill = _safe_color(node.attrib.get("fill"), "#ffffff")
    outline = _safe_color(node.attrib.get("stroke"), fill)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=max(_float_attr(node, "rx"), 0), fill=fill, outline=outline)


def _pillow_line(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    draw.line(
        (_float_attr(node, "x1"), _float_attr(node, "y1"), _float_attr(node, "x2"), _float_attr(node, "y2")),
        fill=_safe_color(node.attrib.get("stroke"), "#94a3b8"),
        width=max(int(_float_attr(node, "stroke-width", 1)), 1),
    )


def _pillow_circle(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    cx, cy, r = _float_attr(node, "cx"), _float_attr(node, "cy"), _float_attr(node, "r", 1)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=_safe_color(node.attrib.get("fill"), "#14b8a6"))


def _pillow_ellipse(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    cx, cy = _float_attr(node, "cx"), _float_attr(node, "cy")
    rx, ry = _float_attr(node, "rx", 1), _float_attr(node, "ry", 1)
    outline = _safe_color(node.attrib.get("stroke"), "#94a3b8") if node.attrib.get("stroke") else None
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=_safe_color(node.attrib.get("fill"), "#ffffff"), outline=outline, width=2)


def _pillow_polygon(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    points = _parse_points(node.attrib.get("points"))
    if len(points) >= 3:
        draw.polygon(points, fill=_safe_color(node.attrib.get("fill"), "#14b8a6"))


def _pillow_polyline(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    points = _parse_points(node.attrib.get("points"))
    if len(points) >= 2:
        draw.line(points, fill=_safe_color(node.attrib.get("stroke"), "#64748b"), width=max(int(_float_attr(node, "stroke-width", 1)), 1))


def _pillow_text(draw: Any, node: ET.Element, ctx: dict[str, Any]) -> None:
    from PIL import ImageFont

    font_px = _node_font_px(node)
    font = ImageFont.load_default(size=max(round(font_px), 6))
    anchor_attr = node.attrib.get("text-anchor", "start")
    anchor = {"middle": "ms", "end": "rs"}.get(anchor_attr, "ls")
    default_fill = _PILLOW_CLASS_FILL.get(node.attrib.get("class", ""), "#334155")
    fill = _safe_color(node.attrib.get("fill"), default_fill)
    for x, y, text in _text_segments(node, font_px):
        draw.text((x, y), text, fill=fill, font=font, anchor=anchor)


_PILLOW_HANDLERS = {
    "rect": _pillow_rect,
    "line": _pillow_line,
    "circle": _pillow_circle,
    "ellipse": _pillow_ellipse,
    "polygon": _pillow_polygon,
    "polyline": _pillow_polyline,
    "text": _pillow_text,
}


def _write_png_pillow(svg: str, png_path: Path, width: int, height: int) -> tuple[bool, str | None]:
    """Fallback renderer for Sophia's small deterministic SVG subset.

    CairoSVG remains the production path. This keeps local gates and emergency
    runtimes from falling back to blank placeholder PNGs when native Cairo is
    unavailable. Walks rect/line/circle/ellipse/polygon/polyline/text nodes,
    including wrapped ``<tspan>`` lines emitted by the text-fit engine.
    """
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return False, "pillow_unavailable"
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        return False, exc.__class__.__name__

    image = Image.new("RGB", (width, height), "#f8fafc")
    draw = ImageDraw.Draw(image)
    ctx = {"width": width, "height": height}
    for node in root.iter():
        handler = _PILLOW_HANDLERS.get(node.tag.rsplit("}", 1)[-1])
        if handler is not None:
            handler(draw, node, ctx)

    png_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(png_path, format="PNG")
    return True, None


def _write_png(svg: str, svg_path: Path, png_path: Path, width: int, height: int) -> tuple[bool, str | None, str | None, str]:
    last_error: str | None = None
    last_validation = "not_rendered"
    for engine, writer in (
        ("cairosvg", lambda: _write_png_cairosvg(svg, png_path, width, height)),
        ("svglib", lambda: _write_png_svglib(svg_path, png_path, width, height)),
        ("pillow_svg_subset", lambda: _write_png_pillow(svg, png_path, width, height)),
    ):
        success, error = writer()
        if not success:
            last_error = f"{engine}:{error or 'render_failed'}"
            continue
        validation = _validate_png(png_path, width, height)
        if validation == "ok":
            return True, None, engine, validation
        last_error = f"{engine}:{validation}"
        last_validation = validation
    return False, last_error, None, last_validation


# --- VQ-7: variety guard ------------------------------------------------------


def _registry_host_path(runtime: ToolRuntime | None) -> Path:
    return _host_path_for_virtual_output(f"{_VISUALS_VIRTUAL_PREFIX}{_REGISTRY_FILENAME}", runtime)


def _fingerprint(visual_type: str, title: str, data: Any, rows: Any, edges: Any, groups: Any) -> str:
    normalized_title = " ".join(str(title or "").lower().split())
    try:
        payload = json.dumps({"data": data, "rows": rows, "edges": edges, "groups": groups}, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        payload = str(data)
    digest = hashlib.sha1(f"{normalized_title}\n{payload}".encode()).hexdigest()
    return f"{visual_type}:{digest}"


def _load_registry(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _find_existing_visual(registry: dict[str, Any], fingerprint: str, runtime: ToolRuntime | None) -> str | None:
    existing = registry.get(fingerprint)
    if not isinstance(existing, str):
        return None
    try:
        if _host_path_for_virtual_output(existing, runtime).is_file():
            return existing
    except Exception:
        return None
    return None


def _record_visual(path: Path, registry: dict[str, Any], fingerprint: str, svg_virtual: str) -> None:
    registry[fingerprint] = svg_virtual
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


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
    rows: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    groups: list[dict[str, Any]] | None = None,
) -> str:
    """Create deterministic local SVG and PNG visual assets.

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
        rows: Optional comparison_matrix rows. Each row is a dict with a
            "label" key plus one key per column (values may be booleans,
            numbers, or short text).
        edges: Optional architecture_diagram / concept_map edges. Each edge is
            a dict with "from" and "to" keys (node labels) and an optional
            "label" key.
        groups: Optional process_flow lanes. Each group is a dict with a
            "label" key and an "items" list of step labels.
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
        registry_path = _registry_host_path(runtime)
        fingerprint = _fingerprint(visual_type, title, data, rows, edges, groups)
        registry = _load_registry(registry_path)
        existing_path = _find_existing_visual(registry, fingerprint, runtime)
        if existing_path:
            return _result(
                success=False,
                error_type="duplicate_visual",
                existing_path=existing_path,
                hint="reuse the existing asset or choose a different kind/data",
            )
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            svg = _svg_for(visual_type, str(title or visual_type), data, _palette(palette), width, height, rows=rows, edges=edges, groups=groups)
        except VisualDataError as exc:
            return _result(success=False, error_type=exc.error_type, hint=exc.hint)
        svg_path.write_text(svg, encoding="utf-8")
        _record_visual(registry_path, registry, fingerprint, svg_virtual)
        png_success, png_error, png_engine, png_validation = _write_png(svg, svg_path, png_path, width, height)
        payload = {
            "visual_type": visual_type,
            "svg_path": svg_virtual,
            "png_path": png_virtual if png_success else None,
            "width": width,
            "height": height,
            "svg_bytes": svg_path.stat().st_size,
            "png_bytes": png_path.stat().st_size if png_success and png_path.exists() else 0,
            "png_error": png_error,
            "png_render_engine": png_engine,
            "png_validation_status": png_validation,
        }
        return _result(success=True, **payload)
    except Exception as exc:
        return _result(success=False, error_type=exc.__class__.__name__)
