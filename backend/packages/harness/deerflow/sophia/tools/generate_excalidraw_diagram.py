"""Graphviz-backed connected-node diagram asset generation for Sophia.

The model supplies STRUCTURE (nodes/edges/kind); this tool applies the Sophia
brand STYLE deterministically and renders via the `dot` binary to SVG + PNG.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_VISUALS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/visuals/"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

# Brand diagram palette (compiled from skills/public/sophia/brand/tokens.md).
# group -> (fill, border)
DIAGRAM = {
    "primary": ("#DBEAFE", "#2E5AAC"),
    "process": ("#DCFCE7", "#2A9D8F"),
    "data": ("#EDE9FE", "#7C3AED"),
    "accent": ("#FEF3C7", "#D4AF37"),
    "neutral": ("#F1F5F9", "#6B7787"),
}
INK, EDGE, EDGE_EMPH = "#1F2A37", "#6B7787", "#2E5AAC"
RANKDIR = {"flow": "TB", "architecture": "TB", "lifecycle": "LR", "tree": "TB"}

# Legacy diagram_type values -> new kind.
_KIND_ALIASES = {
    "flow": "flow",
    "architecture": "architecture",
    "lifecycle": "lifecycle",
    "tree": "tree",
    "process_flow": "flow",
    "timeline": "lifecycle",
    "sequence": "lifecycle",
    "cycle": "lifecycle",
    "system_map": "architecture",
    "concept_map": "architecture",
    "comparison": "tree",
}

DiagramKind = Literal[
    "flow",
    "architecture",
    "lifecycle",
    "tree",
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
        group = str(node.get("group") or node.get("role") or "").strip().lower()
        if group not in DIAGRAM:
            group = "neutral"
        clean.append({"id": node_id, "label": label[:40], "group": group})
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
                "emphasis": "1" if edge.get("emphasis") else "",
            }
        )
    return clean[:24]


def _dot_label(text: str) -> str:
    """Escape a label for a DOT double-quoted string.

    Backslashes and quotes are escaped; literal "\\n" and real newlines become
    DOT line breaks (\\n, which graphviz renders natively). Whitespace runs
    within a line are collapsed.
    """
    value = str(text).replace("\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")]
    escaped = [line.replace("\\", "\\\\").replace('"', '\\"') for line in lines]
    return "\\n".join(part for part in escaped if part != "") or " "


def _xml(text: str) -> str:
    """Minimal XML escape for the HTML-like graphviz title label."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_dot(
    nodes: list[dict[str, str]],
    edges: list[dict[str, str]],
    kind: str,
    title: str,
) -> str:
    rankdir = RANKDIR.get(kind, "TB")
    lines = ["digraph G {"]
    lines.append(f"  rankdir={rankdir};")
    lines.append("  bgcolor=white;")
    lines.append("  labelloc=t;")
    if title.strip():
        lines.append(f'  label=<<b>{_xml(title.strip()[:90])}</b>>;')
        lines.append('  fontname="Helvetica";')
        lines.append("  fontsize=16;")
        lines.append(f'  fontcolor="{INK}";')
    lines.append("  nodesep=0.45;")
    lines.append("  ranksep=0.55;")
    lines.append("  pad=0.3;")
    lines.append(
        '  node [shape=box, style="rounded,filled", fontname="Helvetica", '
        'fontsize=11, penwidth=1.6, margin="0.20,0.12", color="#94A3B8"];'
    )
    lines.append(f'  edge [fontname="Helvetica", fontsize=9, color="{EDGE}", arrowsize=0.8];')
    for node in nodes:
        fill, border = DIAGRAM.get(node["group"], DIAGRAM["neutral"])
        lines.append(
            f'  "{node["id"]}" [label="{_dot_label(node["label"])}", '
            f'fillcolor="{fill}", color="{border}", fontcolor="{INK}"];'
        )
    for edge in edges:
        attrs = []
        if edge.get("label"):
            attrs.append(f'label="{_dot_label(edge["label"])}"')
        if edge.get("emphasis"):
            attrs.append(f'color="{EDGE_EMPH}"')
            attrs.append("penwidth=1.8")
        suffix = f" [{', '.join(attrs)}]" if attrs else ""
        lines.append(f'  "{edge["from"]}" -> "{edge["to"]}"{suffix};')
    lines.append("}")
    return "\n".join(lines)


def _enrich_svg(svg_text: str) -> str:
    """Inject modern fonts + a soft drop-shadow on node shapes.

    Defensive: any failure falls back to the raw graphviz SVG.
    """
    try:
        style_block = (
            "<defs>"
            '<filter id="sophiaShadow" x="-20%" y="-20%" width="140%" height="140%">'
            '<feDropShadow dx="0" dy="2" stdDeviation="2.5" '
            'flood-color="#1F2A37" flood-opacity="0.16"/></filter>'
            "<style>text { font-family: 'Calibri','Helvetica Neue',sans-serif; }"
            " .node polygon, .node path, .node ellipse "
            "{ filter: url(#sophiaShadow); stroke-linejoin: round; }</style>"
            "</defs>"
        )
        marker = re.search(r"<svg\b[^>]*>", svg_text)
        if not marker:
            return svg_text
        insert_at = marker.end()
        return svg_text[:insert_at] + style_block + svg_text[insert_at:]
    except Exception:  # noqa: BLE001
        return svg_text


def _render_dot(dot_source: str, svg_path: Path, png_path: Path) -> str | None:
    """Render the DOT source to SVG + PNG. Returns an error_type or None."""
    dot_bin = shutil.which("dot")
    if dot_bin is None:
        return "graphviz_unavailable"
    with tempfile.TemporaryDirectory(prefix="sophia-diagram-") as tmp_dir:
        dot_file = Path(tmp_dir) / "diagram.dot"
        dot_file.write_text(dot_source, encoding="utf-8")
        for args in (
            [dot_bin, "-Tsvg", str(dot_file), "-o", str(svg_path)],
            [dot_bin, "-Tpng", "-Gdpi=150", str(dot_file), "-o", str(png_path)],
        ):
            completed = subprocess.run(
                args, capture_output=True, text=True, timeout=45, check=False
            )
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "").strip().splitlines()[-1:]
                return (detail[0] if detail else "graphviz_render_failed")[:180]
    try:
        enriched = _enrich_svg(svg_path.read_text(encoding="utf-8"))
        svg_path.write_text(enriched, encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return None


@tool("generate_excalidraw_diagram", parse_docstring=True)
def generate_excalidraw_diagram(
    runtime: ToolRuntime,
    diagram_type: DiagramKind,
    title: str,
    nodes: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    kind: str | None = None,
    output_name: str | None = None,
    mermaid: str | None = None,
    theme: str | None = None,
) -> str:
    """Create a brand-styled connected-node diagram (graphviz-backed).

    You supply the STRUCTURE — labeled nodes and directed edges — and the tool
    applies the Sophia brand STYLE deterministically, then renders via graphviz
    (`dot`) to both SVG and PNG under /mnt/user-data/outputs/visuals/. Embed the
    PNG in PDF/PPTX, or the SVG in HTML. Use this for architecture diagrams,
    process flows, lifecycles, and trees. Do not use it for numeric charts; use
    the chart/data tools instead.

    Args:
        diagram_type: Diagram family (controls rankdir). Legacy values such as
            process_flow/timeline/sequence are accepted and mapped.
        title: Short diagram title.
        nodes: Semantic nodes — each {id, label, group?} where group is one of
            primary | process | data | accent | neutral.
        edges: Directed relationships — each {from, to, label?, emphasis?}.
        kind: Optional explicit kind (flow | architecture | lifecycle | tree).
            Overrides diagram_type when provided.
        output_name: Optional output name or virtual output path.
        mermaid: Deprecated and ignored. Pass nodes/edges instead.
        theme: Optional theme label for diagnostics.
    """
    resolved_kind = _KIND_ALIASES.get(str(kind or diagram_type or "flow").strip().lower(), "flow")
    clean_nodes = _clean_nodes(nodes)
    if len(clean_nodes) < 2:
        return _result(
            success=False,
            error_type="insufficient_nodes",
            hint="provide at least two labeled nodes/edges; the mermaid path is removed",
        )
    node_ids = {node["id"] for node in clean_nodes}
    clean_edges = _clean_edges(edges, node_ids)
    if edges and not clean_edges:
        return _result(success=False, error_type="invalid_edges", hint="edge from/to ids must match node ids")

    svg_virtual = _canonical_output_path(output_name, ".svg")
    png_virtual = _canonical_output_path(output_name, ".png")
    if not svg_virtual or not png_virtual:
        return _result(success=False, error_type="invalid_output_path")
    try:
        svg_path = _host_path_for_virtual_output(svg_virtual, runtime)
        png_path = _host_path_for_virtual_output(png_virtual, runtime)
        for path in (svg_path, png_path):
            path.parent.mkdir(parents=True, exist_ok=True)
        dot_source = build_dot(clean_nodes, clean_edges, resolved_kind, title)
        render_error = _render_dot(dot_source, svg_path, png_path)
        if render_error:
            return _result(success=False, error_type=render_error)
        png_ok = png_path.exists()
        return _result(
            success=True,
            visual_type=resolved_kind,
            diagram_type=resolved_kind,
            svg_path=svg_virtual,
            png_path=png_virtual if png_ok else None,
            svg_bytes=svg_path.stat().st_size,
            png_bytes=png_path.stat().st_size if png_ok else 0,
            node_count=len(clean_nodes),
            edge_count=len(clean_edges),
            validation_status="ok",
            layout_engine="graphviz",
            theme=theme,
        )
    except Exception as exc:  # noqa: BLE001
        return _result(success=False, error_type=exc.__class__.__name__)
