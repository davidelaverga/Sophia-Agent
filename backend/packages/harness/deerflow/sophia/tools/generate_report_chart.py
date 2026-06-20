"""Report chart wrapper around the chart-visualization skill."""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import httpx
from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data

logger = logging.getLogger(__name__)

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_VISUALS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/visuals/"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_URL_RE = re.compile(r"https?://[^\s\"'<>]+")

ChartTool = Literal[
    "generate_area_chart",
    "generate_bar_chart",
    "generate_boxplot_chart",
    "generate_column_chart",
    "generate_district_map",
    "generate_dual_axes_chart",
    "generate_fishbone_diagram",
    "generate_flow_diagram",
    "generate_funnel_chart",
    "generate_histogram_chart",
    "generate_line_chart",
    "generate_liquid_chart",
    "generate_mind_map",
    "generate_network_graph",
    "generate_organization_chart",
    "generate_path_map",
    "generate_pie_chart",
    "generate_pin_map",
    "generate_radar_chart",
    "generate_sankey_chart",
    "generate_scatter_chart",
    "generate_treemap_chart",
    "generate_venn_chart",
    "generate_violin_chart",
    "generate_word_cloud_chart",
]

_CHART_TOOL_FAMILIES: dict[str, str] = {
    "generate_area_chart": "time_series",
    "generate_line_chart": "time_series",
    "generate_dual_axes_chart": "time_series",
    "generate_bar_chart": "comparison",
    "generate_column_chart": "comparison",
    "generate_histogram_chart": "distribution",
    "generate_boxplot_chart": "distribution",
    "generate_violin_chart": "distribution",
    "generate_pie_chart": "part_to_whole",
    "generate_treemap_chart": "part_to_whole",
    "generate_scatter_chart": "relationship",
    "generate_sankey_chart": "flow",
    "generate_venn_chart": "relationship",
    "generate_district_map": "map",
    "generate_pin_map": "map",
    "generate_path_map": "map",
    "generate_organization_chart": "hierarchy",
    "generate_mind_map": "hierarchy",
    "generate_network_graph": "relationship",
    "generate_radar_chart": "multivariate",
    "generate_funnel_chart": "process",
    "generate_liquid_chart": "progress",
    "generate_word_cloud_chart": "text_frequency",
    "generate_fishbone_diagram": "cause_effect",
    "generate_flow_diagram": "flow",
}


def _result(*, success: bool, **fields: Any) -> str:
    return json.dumps({"success": success, **fields}, ensure_ascii=False)


def _slug(value: str | None, fallback: str = "report-chart") -> str:
    stem = PurePosixPath(str(value or fallback)).stem
    slug = _SAFE_NAME_RE.sub("-", stem).strip("-._").lower()
    return (slug or fallback)[:72].strip("-._") or fallback


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[6]


def _chart_script_path() -> Path | None:
    candidates = (
        _repo_root() / "skills" / "public" / "chart-visualization" / "scripts" / "generate.js",
        Path("/mnt/skills/public/chart-visualization/scripts/generate.js"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _thread_outputs_root(runtime: ToolRuntime | None) -> Path | None:
    thread_data = get_thread_data(runtime)
    outputs_path = thread_data.get("outputs_path") if thread_data else None
    if not outputs_path:
        return None
    return Path(str(outputs_path)).resolve()


def _host_path_for_visual(virtual_path: str, runtime: ToolRuntime | None) -> Path:
    outputs_root = _thread_outputs_root(runtime)
    if outputs_root is None:
        raise ValueError("thread_outputs_unavailable")
    rel = virtual_path[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
    host_path = (outputs_root / rel).resolve()
    host_path.relative_to(outputs_root)
    host_path.parent.mkdir(parents=True, exist_ok=True)
    return host_path


def _canonical_chart_paths(output_name: str | None, chart_tool: str) -> tuple[str, str]:
    raw = str(output_name or "").replace("\\", "/").strip()
    if raw.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        rel = raw[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
        base = PurePosixPath(rel)
        if not base.parts or ".." in base.parts:
            raise ValueError("unsafe_output_name")
        if base.parts[0] != "visuals":
            base = PurePosixPath("visuals") / base.name
        stem_path = PurePosixPath("visuals") / PurePosixPath(base).name
    else:
        stem_path = PurePosixPath("visuals") / _slug(raw or chart_tool, "report-chart")
    image_path = f"{_OUTPUTS_VIRTUAL_PREFIX}{stem_path.with_suffix('.png').as_posix()}"
    spec_path = f"{_OUTPUTS_VIRTUAL_PREFIX}{stem_path.with_suffix('.chart.json').as_posix()}"
    return image_path, spec_path


def _extract_first_url(text: str) -> str | None:
    match = _URL_RE.search(text)
    if not match:
        return None
    return match.group(0).rstrip(").,")


def _download_chart_image(url: str, image_host_path: Path) -> tuple[int, str | None]:
    with httpx.Client(follow_redirects=True, timeout=30.0) as client:
        response = client.get(url)
        response.raise_for_status()
        content_type = response.headers.get("content-type")
        image_host_path.write_bytes(response.content)
        return len(response.content), content_type


def _input_error(chart_tool: str, args: dict[str, Any], family: str | None) -> str | None:
    if family is None:
        return _result(
            success=False,
            error_type="unsupported_chart_tool",
            chart_tool=chart_tool,
            hint="Choose one of the chart-visualization generate_* tools.",
        )
    if not isinstance(args, dict) or not args:
        return _result(
            success=False,
            error_type="chart_args_required",
            chart_tool=chart_tool,
            chart_family=family,
            hint="Pass exact labeled data and chart arguments in args.",
        )
    return None


def _runtime_error(chart_tool: str, family: str) -> tuple[str | None, Path | None, str | None]:
    node = shutil.which("node")
    if not node:
        return None, None, _result(
            success=False,
            error_type="node_unavailable",
            chart_tool=chart_tool,
            chart_family=family,
            hint="Node.js is required for the chart-visualization skill.",
        )
    script_path = _chart_script_path()
    if script_path is None:
        return node, None, _result(
            success=False,
            error_type="chart_script_unavailable",
            chart_tool=chart_tool,
            chart_family=family,
            hint="chart-visualization/scripts/generate.js could not be found.",
        )
    return node, script_path, None


def _resolved_output_paths(
    output_name: str | None,
    chart_tool: str,
    family: str,
    runtime: ToolRuntime | None,
) -> tuple[str | None, str | None, Path | None, Path | None, str | None]:
    try:
        image_path, spec_path = _canonical_chart_paths(output_name, chart_tool)
        image_host_path = _host_path_for_visual(image_path, runtime)
        spec_host_path = _host_path_for_visual(spec_path, runtime)
        return image_path, spec_path, image_host_path, spec_host_path, None
    except ValueError as exc:
        return None, None, None, None, _result(
            success=False,
            error_type=str(exc) or "chart_path_error",
            chart_tool=chart_tool,
            chart_family=family,
            hint="Use an output_name under /mnt/user-data/outputs/visuals/.",
        )


def _write_chart_spec(
    spec_host_path: Path,
    *,
    chart_tool: str,
    args: dict[str, Any],
    family: str,
    rationale: str,
    spec_path: str,
) -> None:
    spec = {
        "tool": chart_tool,
        "args": args,
        "sophia": {
            "source": "generate_report_chart",
            "chart_family": family,
            "rationale": rationale,
        },
    }
    spec_host_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(
        "[SophiaReportChart] chart_tool=%s chart_family=%s rationale=%s spec_path=%s",
        chart_tool,
        family,
        " ".join(str(rationale or "").split())[:240],
        spec_path,
    )


def _run_chart_script(node: str, script_path: Path, spec_host_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed node executable + script path, JSON spec file arg only.
        [node, str(script_path), str(spec_host_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=45,
    )


def _generation_error_payload(
    *,
    completed: subprocess.CompletedProcess[str],
    chart_tool: str,
    family: str,
    spec_path: str,
) -> tuple[str | None, str | None]:
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if completed.returncode != 0:
        return None, _result(
            success=False,
            error_type="chart_generation_failed",
            chart_tool=chart_tool,
            chart_family=family,
            spec_path=spec_path,
            stderr=stderr[-1000:] if stderr else None,
            hint="Review the chart args against the chart-visualization reference for this tool.",
        )
    chart_url = _extract_first_url(stdout)
    if not chart_url:
        return None, _result(
            success=False,
            error_type="chart_url_missing",
            chart_tool=chart_tool,
            chart_family=family,
            spec_path=spec_path,
            stdout=stdout[-1000:] if stdout else None,
            hint="The chart service did not return a downloadable image URL.",
        )
    return chart_url, None


def _download_result_payload(
    *,
    chart_tool: str,
    family: str,
    rationale: str,
    chart_url: str,
    image_path: str,
    spec_path: str,
    image_host_path: Path,
) -> str:
    try:
        image_bytes, content_type = _download_chart_image(chart_url, image_host_path)
    except Exception as exc:
        logger.warning("[SophiaReportChart] chart_download_failed url=%s", chart_url, exc_info=True)
        return _result(
            success=False,
            error_type="chart_download_failed",
            chart_tool=chart_tool,
            chart_family=family,
            chart_url=chart_url,
            spec_path=spec_path,
            hint=f"Chart rendered remotely but could not be downloaded locally: {type(exc).__name__}",
        )
    return _result(
        success=True,
        chart_tool=chart_tool,
        chart_family=family,
        rationale=rationale,
        chart_url=chart_url,
        image_path=image_path,
        png_path=image_path,
        spec_path=spec_path,
        image_bytes=image_bytes,
        content_type=content_type,
    )


@tool("generate_report_chart", parse_docstring=True)
def generate_report_chart(
    chart_tool: ChartTool,
    args: dict[str, Any],
    rationale: str,
    output_name: str | None = None,
    runtime: ToolRuntime | None = None,
) -> str:
    """Generate a local chart image for PDF/report artifacts.

    Use this report-only wrapper when a PDF or Markdown report needs a richer
    chart than the compact deterministic chart tool provides. Choose the chart
    tool from the chart-visualization taxonomy, pass the exact labeled data in
    args, and explain the choice in rationale. The tool saves the chart spec
    and downloads the rendered chart under /mnt/user-data/outputs/visuals/.

    Args:
        chart_tool: Chart-visualization tool name, e.g. generate_line_chart,
            generate_sankey_chart, generate_treemap_chart, or generate_radar_chart.
        args: Exact chart-visualization arguments, including data, labels, title,
            and style/theme fields needed by the selected chart tool.
        rationale: Brief reason this chart family fits the report evidence.
        output_name: Optional output filename or /mnt/user-data/outputs/... path.
        runtime: Tool runtime supplied by LangGraph.
    """

    family = _CHART_TOOL_FAMILIES.get(chart_tool)
    error = _input_error(chart_tool, args, family)
    if error is not None:
        return error
    assert family is not None
    node, script_path, error = _runtime_error(chart_tool, family)
    if error is not None:
        return error
    assert node is not None and script_path is not None
    image_path, spec_path, image_host_path, spec_host_path, error = _resolved_output_paths(
        output_name,
        chart_tool,
        family,
        runtime,
    )
    if error is not None:
        return error
    assert image_path is not None and spec_path is not None
    assert image_host_path is not None and spec_host_path is not None
    _write_chart_spec(
        spec_host_path,
        chart_tool=chart_tool,
        args=args,
        family=family,
        rationale=rationale,
        spec_path=spec_path,
    )
    chart_url, error = _generation_error_payload(
        completed=_run_chart_script(node, script_path, spec_host_path),
        chart_tool=chart_tool,
        family=family,
        spec_path=spec_path,
    )
    if error is not None:
        return error
    assert chart_url is not None
    return _download_result_payload(
        chart_tool=chart_tool,
        family=family,
        rationale=rationale,
        chart_url=chart_url,
        image_path=image_path,
        spec_path=spec_path,
        image_host_path=image_host_path,
    )
