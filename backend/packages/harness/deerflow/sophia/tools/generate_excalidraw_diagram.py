"""Official-Excalidraw-compatible diagram asset generation for Sophia."""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from xml.sax.saxutils import escape

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_VISUALS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/visuals/"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_DEFAULT_PALETTE = ("#2563eb", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444")

DiagramKind = Literal[
    "architecture",
    "process_flow",
    "timeline",
    "system_map",
    "comparison",
    "concept_map",
    "cycle",
    "sequence",
]


def _result(*, success: bool, **fields: Any) -> str:
    return json.dumps({"success": success, **fields}, ensure_ascii=False)


def _slug(value: str | None, fallback: str = "diagram") -> str:
    stem = PurePosixPath(str(value or fallback)).stem
    slug = _SAFE_NAME_RE.sub("-", stem).strip("-._").lower()
    return (slug or fallback)[:72].strip("-._") or fallback


def _canonical_output_path(output_name: str | None, suffix: str) -> str | None:
    raw = str(output_name or "").replace("\\", "/").strip()
    if raw.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        rel = raw[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
        base = PurePosixPath(rel).with_suffix(suffix)
        if not base.parts or ".." in base.parts:
            return None
        if base.parts[0] != "visuals":
            base = PurePosixPath("visuals") / base.name
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{base.as_posix()}"
    return f"{_VISUALS_VIRTUAL_PREFIX}{_slug(raw, 'diagram')}{suffix}"


def _host_path_for_virtual_output(virtual_path: str, runtime: ToolRuntime | None) -> Path:
    thread_data = get_thread_data(runtime)
    if thread_data and thread_data.get("outputs_path"):
        rel = virtual_path[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
        outputs_root = Path(str(thread_data["outputs_path"])).resolve()
        host_path = (outputs_root / rel).resolve()
        host_path.relative_to(outputs_root)
        return host_path
    return Path(virtual_path)


def _clean_nodes(nodes: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    clean: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, node in enumerate(nodes or [], start=1):
        if not isinstance(node, dict):
            continue
        label = str(node.get("label") or node.get("title") or node.get("name") or "").strip()
        if not label:
            continue
        node_id = str(node.get("id") or f"n{index}").strip() or f"n{index}"
        node_id = re.sub(r"[^A-Za-z0-9_]+", "_", node_id).strip("_") or f"n{index}"
        if node_id in seen:
            node_id = f"{node_id}-{index}"
        seen.add(node_id)
        clean.append(
            {
                "id": node_id,
                "label": label[:120],
                "group": str(node.get("group") or node.get("role") or "").strip()[:64],
            }
        )
    return clean[:14]


def _clean_edges(edges: list[dict[str, Any]] | None, node_ids: set[str]) -> list[dict[str, str]]:
    clean: list[dict[str, str]] = []
    for edge in edges or []:
        if not isinstance(edge, dict):
            continue
        source = re.sub(r"[^A-Za-z0-9_]+", "_", str(edge.get("from") or edge.get("source") or "").strip()).strip("_")
        target = re.sub(r"[^A-Za-z0-9_]+", "_", str(edge.get("to") or edge.get("target") or "").strip()).strip("_")
        if source not in node_ids or target not in node_ids or source == target:
            continue
        clean.append(
            {
                "from": source,
                "to": target,
                "label": str(edge.get("label") or edge.get("kind") or "").strip()[:80],
            }
        )
    return clean[:24]


def _positions(kind: str, count: int, width: int, height: int) -> list[tuple[float, float]]:
    if count <= 0:
        return []
    top = 128
    bottom = height - 82
    left = 94
    right = width - 274
    if kind in {"process_flow", "timeline", "sequence"}:
        step = (right - left) / max(count - 1, 1)
        return [(left + step * i, height * 0.48) for i in range(count)]
    if kind in {"cycle", "concept_map", "system_map"}:
        cx = width / 2 - 70
        cy = height / 2 + 24
        radius = min(width, height) * 0.31
        return [
            (cx + math.cos((2 * math.pi * i / count) - math.pi / 2) * radius, cy + math.sin((2 * math.pi * i / count) - math.pi / 2) * radius)
            for i in range(count)
        ]
    if kind == "comparison":
        rows = math.ceil(count / 2)
        return [
            (left + (i % 2) * ((right - left) * 0.62), top + (i // 2) * ((bottom - top) / max(rows - 1, 1)))
            for i in range(count)
        ]
    columns = min(3, count)
    rows = math.ceil(count / columns)
    x_gap = (right - left) / max(columns - 1, 1)
    y_gap = (bottom - top) / max(rows - 1, 1)
    return [(left + (i % columns) * x_gap, top + (i // columns) * y_gap) for i in range(count)]


def _wrap_label(text: str, max_chars: int = 22, max_lines: int = 3) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word[:max_chars]
        if len(lines) >= max_lines - 1:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    return lines or [text[:max_chars]]


def _excalidraw_scene(
    *,
    title: str,
    kind: str,
    nodes: list[dict[str, str]],
    edges: list[dict[str, str]],
    width: int,
    height: int,
    positions: list[tuple[float, float]],
) -> dict[str, Any]:
    elements: list[dict[str, Any]] = []
    node_lookup = {node["id"]: (x, y) for node, (x, y) in zip(nodes, positions, strict=False)}
    for edge_index, edge in enumerate(edges):
        start = node_lookup.get(edge["from"])
        end = node_lookup.get(edge["to"])
        if start is None or end is None:
            continue
        x1, y1 = start
        x2, y2 = end
        elements.append(
            {
                "id": f"edge-{edge_index}",
                "type": "arrow",
                "x": x1 + 82,
                "y": y1 + 34,
                "width": x2 - x1,
                "height": y2 - y1,
                "angle": 0,
                "strokeColor": "#475569",
                "backgroundColor": "transparent",
                "fillStyle": "hachure",
                "strokeWidth": 2,
                "roughness": 1,
                "opacity": 100,
                "points": [[0, 0], [x2 - x1, y2 - y1]],
                "endArrowhead": "arrow",
            }
        )
    for node_index, (node, (x, y)) in enumerate(zip(nodes, positions, strict=False)):
        color = _DEFAULT_PALETTE[node_index % len(_DEFAULT_PALETTE)]
        elements.append(
            {
                "id": f"node-{node['id']}",
                "type": "rectangle",
                "x": x,
                "y": y,
                "width": 180,
                "height": 74,
                "angle": 0,
                "strokeColor": color,
                "backgroundColor": "#ffffff",
                "fillStyle": "solid",
                "strokeWidth": 2,
                "roughness": 1,
                "opacity": 100,
                "roundness": {"type": 3},
            }
        )
        elements.append(
            {
                "id": f"text-{node['id']}",
                "type": "text",
                "x": x + 14,
                "y": y + 15,
                "width": 152,
                "height": 44,
                "angle": 0,
                "strokeColor": "#0f172a",
                "backgroundColor": "transparent",
                "fillStyle": "solid",
                "strokeWidth": 1,
                "roughness": 1,
                "opacity": 100,
                "text": node["label"],
                "fontSize": 18,
                "fontFamily": 1,
                "textAlign": "center",
                "verticalAlign": "middle",
                "containerId": f"node-{node['id']}",
            }
        )
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "sophia-builder",
        "elements": elements,
        "appState": {
            "viewBackgroundColor": "#f8fafc",
            "name": title,
            "exportBackground": True,
            "width": width,
            "height": height,
            "diagramType": kind,
        },
        "files": {},
    }


def _svg(
    *,
    title: str,
    kind: str,
    nodes: list[dict[str, str]],
    edges: list[dict[str, str]],
    width: int,
    height: int,
    positions: list[tuple[float, float]],
) -> str:
    node_lookup = {node["id"]: (x, y) for node, (x, y) in zip(nodes, positions, strict=False)}
    chunks = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        "<defs>",
        '<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker>',
        '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#0f172a" flood-opacity="0.12"/></filter>',
        "</defs>",
        '<rect width="100%" height="100%" rx="28" fill="#f8fafc"/>',
        f'<text x="48" y="62" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700">{escape(title[:90])}</text>',
        f'<text x="48" y="94" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="15">{escape(kind.replace("_", " ").title())}</text>',
    ]
    for edge in edges:
        start = node_lookup.get(edge["from"])
        end = node_lookup.get(edge["to"])
        if start is None or end is None:
            continue
        x1, y1 = start[0] + 90, start[1] + 37
        x2, y2 = end[0] + 90, end[1] + 37
        chunks.append(
            f'<path d="M{x1:.1f},{y1:.1f} C{(x1+x2)/2:.1f},{y1:.1f} {(x1+x2)/2:.1f},{y2:.1f} {x2:.1f},{y2:.1f}" fill="none" stroke="#475569" stroke-width="2.4" stroke-linecap="round" marker-end="url(#arrow)"/>'
        )
        if edge.get("label"):
            chunks.append(
                f'<text x="{(x1+x2)/2:.1f}" y="{(y1+y2)/2 - 8:.1f}" fill="#334155" font-family="Inter, Arial, sans-serif" font-size="13" text-anchor="middle">{escape(edge["label"])}</text>'
            )
    for index, (node, (x, y)) in enumerate(zip(nodes, positions, strict=False)):
        color = _DEFAULT_PALETTE[index % len(_DEFAULT_PALETTE)]
        chunks.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="180" height="74" rx="16" fill="#ffffff" stroke="{color}" stroke-width="2.5" filter="url(#shadow)"/>'
        )
        for line_index, line in enumerate(_wrap_label(node["label"])):
            chunks.append(
                f'<text x="{x+90:.1f}" y="{y+29+(line_index*19):.1f}" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="650" text-anchor="middle">{escape(line)}</text>'
            )
        if node.get("group"):
            chunks.append(
                f'<text x="{x+90:.1f}" y="{y+64:.1f}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="11" text-anchor="middle">{escape(node["group"])}</text>'
            )
    chunks.append("</svg>")
    return "".join(chunks)


def _write_png_pillow(
    *,
    png_path: Path,
    title: str,
    kind: str,
    nodes: list[dict[str, str]],
    edges: list[dict[str, str]],
    width: int,
    height: int,
    positions: list[tuple[float, float]],
) -> tuple[bool, str | None]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:  # noqa: BLE001
        return False, exc.__class__.__name__

    try:
        image = Image.new("RGB", (width, height), "#f8fafc")
        draw = ImageDraw.Draw(image)
        try:
            title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 30)
            label_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 17)
            small_font = ImageFont.truetype("DejaVuSans.ttf", 12)
        except OSError:
            title_font = label_font = small_font = ImageFont.load_default()
        draw.text((48, 34), title[:90], fill="#0f172a", font=title_font)
        draw.text((48, 76), kind.replace("_", " ").title(), fill="#64748b", font=small_font)
        node_lookup = {node["id"]: (x, y) for node, (x, y) in zip(nodes, positions, strict=False)}
        for edge in edges:
            start = node_lookup.get(edge["from"])
            end = node_lookup.get(edge["to"])
            if start is None or end is None:
                continue
            x1, y1 = start[0] + 90, start[1] + 37
            x2, y2 = end[0] + 90, end[1] + 37
            draw.line((x1, y1, x2, y2), fill="#475569", width=3)
            angle = math.atan2(y2 - y1, x2 - x1)
            arrow = [
                (x2, y2),
                (x2 - 14 * math.cos(angle - 0.45), y2 - 14 * math.sin(angle - 0.45)),
                (x2 - 14 * math.cos(angle + 0.45), y2 - 14 * math.sin(angle + 0.45)),
            ]
            draw.polygon(arrow, fill="#475569")
            if edge.get("label"):
                draw.text(((x1 + x2) / 2, (y1 + y2) / 2 - 18), edge["label"], fill="#334155", font=small_font, anchor="mm")
        for index, (node, (x, y)) in enumerate(zip(nodes, positions, strict=False)):
            color = _DEFAULT_PALETTE[index % len(_DEFAULT_PALETTE)]
            rect = (x, y, x + 180, y + 74)
            draw.rounded_rectangle(rect, radius=16, fill="#ffffff", outline=color, width=3)
            lines = _wrap_label(node["label"])
            total_height = len(lines) * 18
            for line_index, line in enumerate(lines):
                draw.text(
                    (x + 90, y + 37 - total_height / 2 + line_index * 19),
                    line,
                    fill="#0f172a",
                    font=label_font,
                    anchor="mm",
                )
        image.save(png_path, format="PNG")
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, exc.__class__.__name__


def _write_png(
    svg: str,
    png_path: Path,
    *,
    title: str,
    kind: str,
    nodes: list[dict[str, str]],
    edges: list[dict[str, str]],
    width: int,
    height: int,
    positions: list[tuple[float, float]],
) -> tuple[bool, str | None, str | None]:
    try:
        import cairosvg

        cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=str(png_path))
        return True, "cairosvg", None
    except Exception as exc:  # noqa: BLE001
        first_error = exc.__class__.__name__
    pillow_success, pillow_error = _write_png_pillow(
        png_path=png_path,
        title=title,
        kind=kind,
        nodes=nodes,
        edges=edges,
        width=width,
        height=height,
        positions=positions,
    )
    if pillow_success:
        return True, "pillow", None
    return False, None, f"{first_error};pillow:{pillow_error}"


def _diagram_runtime_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "js"


def _compile_diagram_script() -> Path:
    return _diagram_runtime_dir() / "compile_diagram.mjs"


def _node_binary() -> str | None:
    return shutil.which("node")


def _svg_number(value: str | None, fallback: float = 0.0) -> float:
    try:
        return float(str(value or "").removesuffix("px"))
    except ValueError:
        return fallback


def _svg_canvas_size(root: ET.Element) -> tuple[int, int]:
    width = int(_svg_number(root.attrib.get("width"), 1280))
    height = int(_svg_number(root.attrib.get("height"), 720))
    return max(width, 1), max(height, 1)


def _draw_svg_rect(draw: Any, element: ET.Element) -> None:
    if "%" in element.attrib.get("width", "") or "%" in element.attrib.get("height", ""):
        return
    x = _svg_number(element.attrib.get("x"))
    y = _svg_number(element.attrib.get("y"))
    width = _svg_number(element.attrib.get("width"))
    height = _svg_number(element.attrib.get("height"))
    if width <= 0 or height <= 0:
        return
    fill = element.attrib.get("fill", "#ffffff")
    stroke = element.attrib.get("stroke", "#334155")
    draw.rounded_rectangle([x, y, x + width, y + height], radius=16, fill=fill, outline=stroke, width=2)


def _svg_polyline_points(raw_points: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for raw in raw_points.split():
        try:
            px, py = raw.split(",", 1)
            points.append((float(px), float(py)))
        except ValueError:
            continue
    return points


def _draw_svg_polyline(draw: Any, element: ET.Element) -> None:
    points = _svg_polyline_points(element.attrib.get("points", ""))
    if len(points) >= 2:
        draw.line(points, fill="#334155", width=3)


def _draw_svg_text(draw: Any, element: ET.Element, font: Any) -> None:
    text = "".join(element.itertext()).strip()
    if not text:
        return
    x = _svg_number(element.attrib.get("x"))
    y = _svg_number(element.attrib.get("y"))
    if element.attrib.get("text-anchor") == "middle":
        bbox = draw.textbbox((0, 0), text, font=font)
        x -= (bbox[2] - bbox[0]) / 2
    draw.text((x, y - 10), text, fill="#0f172a", font=font)


def _draw_svg_element(draw: Any, element: ET.Element, font: Any) -> None:
    tag = element.tag.rsplit("}", 1)[-1]
    if tag == "rect":
        _draw_svg_rect(draw, element)
    elif tag == "polyline":
        _draw_svg_polyline(draw, element)
    elif tag == "text":
        _draw_svg_text(draw, element, font)


def _write_png_from_svg_with_pillow(svg_path: Path, png_path: Path) -> tuple[bool, str | None]:
    try:
        from PIL import Image, ImageDraw, ImageFont

        root = ET.fromstring(svg_path.read_text(encoding="utf-8"))
        image = Image.new("RGB", _svg_canvas_size(root), "#f8fafc")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default()
        for element in root.iter():
            _draw_svg_element(draw, element, font)
        png_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(png_path)
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, exc.__class__.__name__


def _write_png_from_svg(svg_path: Path, png_path: Path) -> tuple[bool, str | None, str | None]:
    try:
        import cairosvg

        png_path.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path))
        return True, "cairosvg", None
    except Exception as exc:  # noqa: BLE001
        cairo_error = exc.__class__.__name__
    pillow_success, pillow_error = _write_png_from_svg_with_pillow(svg_path, png_path)
    if pillow_success:
        return True, "pillow_svg_fallback", cairo_error
    return False, None, f"{cairo_error};pillow:{pillow_error}"


def _mermaid_quote(label: str) -> str:
    return '"' + label.replace('"', "'") + '"'


def _mermaid_from_nodes(kind: str, nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> str:
    direction = "TD" if kind in {"timeline", "sequence"} else "LR"
    lines = [f"flowchart {direction}"]
    for node in nodes:
        lines.append(f"  {node['id']}[{_mermaid_quote(node['label'])}]")
    if edges:
        for edge in edges:
            label = f"|{edge['label']}|" if edge.get("label") else ""
            lines.append(f"  {edge['from']} -->{label} {edge['to']}")
    else:
        for left, right in zip(nodes, nodes[1:], strict=False):
            lines.append(f"  {left['id']} --> {right['id']}")
    return "\n".join(lines)


def _compile_mermaid_diagram(
    *,
    mermaid: str,
    title: str,
    excalidraw_path: Path,
    svg_path: Path,
    width: int,
    height: int,
) -> tuple[bool, str | None]:
    node = _node_binary()
    script = _compile_diagram_script()
    if node is None:
        return False, "node_unavailable"
    if not script.is_file():
        return False, "compile_diagram_missing"
    with tempfile.TemporaryDirectory(prefix="sophia-diagram-") as tmp_dir:
        mermaid_path = Path(tmp_dir) / "diagram.mmd"
        mermaid_path.write_text(mermaid, encoding="utf-8")
        completed = subprocess.run(
            [
                node,
                str(script),
                "--mermaid",
                str(mermaid_path),
                "--svg",
                str(svg_path),
                "--scene",
                str(excalidraw_path),
                "--title",
                title,
                "--width",
                str(width),
                "--height",
                str(height),
            ],
            cwd=str(_diagram_runtime_dir()),
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()[-1:] or ["diagram_compile_failed"]
        return False, detail[0][:180]
    return True, None


@tool("generate_excalidraw_diagram", parse_docstring=True)
def generate_excalidraw_diagram(
    runtime: ToolRuntime,
    diagram_type: DiagramKind,
    title: str,
    nodes: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    mermaid: str | None = None,
    output_name: str | None = None,
    width: int = 1280,
    height: int = 720,
    theme: str | None = None,
) -> str:
    """Create an Excalidraw-compatible technical diagram asset.

    Use this for architecture diagrams, process flows, timelines, system
    maps, comparison diagrams, concept maps, cycles, and sequences. Prefer
    passing a Mermaid definition in `mermaid`; older nodes/edges calls are
    converted to Mermaid before rendering. The tool writes a .excalidraw scene
    plus SVG/PNG render assets under /mnt/user-data/outputs/visuals/. Embed the
    PNG in PDF/PPTX, or the SVG in HTML. Do not use this for numeric charts;
    use chart/data tools instead.

    Args:
        diagram_type: Diagram family to generate.
        title: Short diagram title.
        nodes: Optional semantic nodes with id and label fields.
        edges: Optional directed relationships with from/to/label fields.
        mermaid: Optional Mermaid graph definition. Prefer this for technical
            diagrams; do not include Markdown fences.
        output_name: Optional output name or virtual output path.
        width: Output width in pixels, between 640 and 2400.
        height: Output height in pixels, between 360 and 1600.
        theme: Optional theme label for diagnostics.
    """
    if width < 640 or width > 2400 or height < 360 or height > 1600:
        return _result(success=False, error_type="invalid_dimensions")
    clean_nodes = _clean_nodes(nodes)
    mermaid_text = str(mermaid or "").strip()
    if not mermaid_text:
        if len(clean_nodes) < 2:
            return _result(success=False, error_type="insufficient_nodes", hint="provide Mermaid or at least two labeled nodes")
        node_ids = {node["id"] for node in clean_nodes}
        clean_edges = _clean_edges(edges, node_ids)
        if edges and not clean_edges:
            return _result(success=False, error_type="invalid_edges", hint="edge from/to ids must match node ids")
        mermaid_text = _mermaid_from_nodes(diagram_type, clean_nodes, clean_edges)
    elif mermaid_text.startswith("```"):
        return _result(success=False, error_type="invalid_mermaid", hint="pass raw Mermaid only; do not include Markdown fences")
    node_ids = {node["id"] for node in clean_nodes}
    clean_edges = _clean_edges(edges, node_ids) if clean_nodes else []
    excalidraw_virtual = _canonical_output_path(output_name, ".excalidraw")
    svg_virtual = _canonical_output_path(output_name, ".svg")
    png_virtual = _canonical_output_path(output_name, ".png")
    if not excalidraw_virtual or not svg_virtual or not png_virtual:
        return _result(success=False, error_type="invalid_output_path")
    try:
        excalidraw_path = _host_path_for_virtual_output(excalidraw_virtual, runtime)
        svg_path = _host_path_for_virtual_output(svg_virtual, runtime)
        png_path = _host_path_for_virtual_output(png_virtual, runtime)
        for path in (excalidraw_path, svg_path, png_path):
            path.parent.mkdir(parents=True, exist_ok=True)
        compiled, compile_error = _compile_mermaid_diagram(
            title=title,
            mermaid=mermaid_text,
            excalidraw_path=excalidraw_path,
            svg_path=svg_path,
            width=width,
            height=height,
        )
        if not compiled:
            return _result(success=False, error_type="invalid_mermaid", hint=compile_error or "Mermaid could not be converted")
        png_success, png_engine, png_error = _write_png_from_svg(svg_path, png_path)
        return _result(
            success=True,
            visual_type=diagram_type,
            diagram_type=diagram_type,
            excalidraw_path=excalidraw_virtual,
            svg_path=svg_virtual,
            png_path=png_virtual if png_success else None,
            width=width,
            height=height,
            node_count=len(clean_nodes),
            edge_count=len(clean_edges),
            svg_bytes=svg_path.stat().st_size,
            png_bytes=png_path.stat().st_size if png_success and png_path.exists() else 0,
            png_render_engine=png_engine,
            png_error=png_error,
            png_validation_status="ok" if png_success else "png_render_failed",
            validation_status="ok" if png_success else "png_render_failed",
            theme=theme,
            layout_engine="mermaid_to_excalidraw",
        )
    except Exception as exc:  # noqa: BLE001
        return _result(success=False, error_type=exc.__class__.__name__)
