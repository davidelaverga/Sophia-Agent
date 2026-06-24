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

_IMAGE_MAGIC_PREFIXES = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"RIFF",  # WEBP starts RIFF....WEBP; checked with a secondary marker below.
)


class ChartDownloadInvalidImage(ValueError):
    """Raised when a chart endpoint returns non-image bytes."""

    def __init__(self, *, content_type: str | None, byte_count: int) -> None:
        super().__init__("chart_download_invalid_image")
        self.content_type = content_type
        self.byte_count = byte_count


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


def _existing_chart_tool(spec_host_path: Path) -> str | None:
    if not spec_host_path.is_file():
        return None
    try:
        payload = json.loads(spec_host_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    tool_name = payload.get("tool") if isinstance(payload, dict) else None
    return tool_name.strip() if isinstance(tool_name, str) and tool_name.strip() else None


def _chart_collision_suffix(chart_tool: str) -> str:
    value = chart_tool.removeprefix("generate_")
    return _slug(value.removesuffix("_chart") or value, "chart")


def _collision_safe_chart_paths(
    *,
    output_name: str | None,
    chart_tool: str,
    image_path: str,
    spec_path: str,
    spec_host_path: Path,
    runtime: ToolRuntime | None,
) -> tuple[str, str, Path, Path]:
    existing_tool = _existing_chart_tool(spec_host_path)
    if existing_tool in {None, chart_tool}:
        return image_path, spec_path, _host_path_for_visual(image_path, runtime), spec_host_path

    base = PurePosixPath(_extract_output_name_for_collision(output_name, image_path))
    collision_name = f"{base.stem}-{_chart_collision_suffix(chart_tool)}"
    image_path, spec_path = _canonical_chart_paths(collision_name, chart_tool)
    image_host_path = _host_path_for_visual(image_path, runtime)
    spec_host_path = _host_path_for_visual(spec_path, runtime)
    logger.info(
        "[SophiaReportChart] chart_path_collision avoided existing_tool=%s "
        "new_tool=%s spec_path=%s",
        existing_tool,
        chart_tool,
        spec_path,
    )
    return image_path, spec_path, image_host_path, spec_host_path


def _extract_output_name_for_collision(output_name: str | None, image_path: str) -> str:
    raw = str(output_name or "").replace("\\", "/").strip()
    if raw:
        return PurePosixPath(raw).stem
    relative = image_path[len(_OUTPUTS_VIRTUAL_PREFIX) :].strip("/")
    return PurePosixPath(relative).stem or "report-chart"


def _extract_first_url(text: str) -> str | None:
    match = _URL_RE.search(text)
    if not match:
        return None
    return match.group(0).rstrip(").,")


def _bytes_look_like_image(content: bytes) -> bool:
    if not content:
        return False
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return True
    return any(content.startswith(prefix) for prefix in _IMAGE_MAGIC_PREFIXES if prefix != b"RIFF")


def _valid_image_response(content: bytes, content_type: str | None) -> bool:
    normalized_type = str(content_type or "").split(";", 1)[0].strip().lower()
    if normalized_type.startswith("image/"):
        return True
    return _bytes_look_like_image(content)


def _download_chart_image(url: str, image_host_path: Path) -> tuple[int, str | None]:
    with httpx.Client(follow_redirects=True, timeout=30.0) as client:
        response = client.get(url)
        response.raise_for_status()
        content_type = response.headers.get("content-type")
        content = response.content
        if not _valid_image_response(content, content_type):
            raise ChartDownloadInvalidImage(
                content_type=content_type,
                byte_count=len(content),
            )
        image_host_path.write_bytes(content)
        return len(content), content_type


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
        image_path, spec_path, image_host_path, spec_host_path = _collision_safe_chart_paths(
            output_name=output_name,
            chart_tool=chart_tool,
            image_path=image_path,
            spec_path=spec_path,
            spec_host_path=spec_host_path,
            runtime=runtime,
        )
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
    source: str = "generate_report_chart",
) -> None:
    spec = {
        "tool": chart_tool,
        "args": args,
        "sophia": {
            "source": source,
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
    except ChartDownloadInvalidImage as exc:
        logger.warning(
            "[SophiaReportChart] chart_download_invalid_image url=%s content_type=%s bytes=%d",
            chart_url,
            exc.content_type,
            exc.byte_count,
        )
        return _result(
            success=False,
            error_type="chart_download_invalid_image",
            chart_tool=chart_tool,
            chart_family=family,
            chart_url=chart_url,
            spec_path=spec_path,
            content_type=exc.content_type,
            image_bytes=exc.byte_count,
            hint="The chart service returned a non-image response; retry with simpler chart args or a deterministic chart.",
        )
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


def _generate_chart_impl(
    runtime: ToolRuntime,
    chart_tool: ChartTool,
    chart_args: dict[str, Any],
    rationale: str,
    output_name: str | None = None,
    *,
    source: str = "generate_report_chart",
) -> str:
    family = _CHART_TOOL_FAMILIES.get(chart_tool)
    error = _input_error(chart_tool, chart_args, family)
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
        args=chart_args,
        family=family,
        rationale=rationale,
        spec_path=spec_path,
        source=source,
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


@tool("generate_chart", parse_docstring=True)
def generate_chart(
    runtime: ToolRuntime,
    chart_type: ChartTool,
    data: dict[str, Any],
    output_name: str | None = None,
    rationale: str = "",
) -> str:
    """Generate a local chart PNG for PDF/report artifacts.

    Use this report-only chart tool for quantitative, comparative,
    distributional, trend, ranking, composition, or flow-volume evidence.
    Choose a chart_type from the chart-visualization taxonomy, pass exact
    labeled chart arguments in data, and embed the returned png_path in the
    Markdown before calling render_markdown_to_pdf.

    Args:
        chart_type: Chart-visualization tool name, e.g. generate_bar_chart,
            generate_line_chart, generate_sankey_chart, generate_radar_chart.
        data: Exact chart-visualization arguments, including data, labels, title,
            and style/theme fields needed by the selected chart type.
        output_name: Optional output filename or /mnt/user-data/outputs/... path.
        rationale: Brief reason this chart family fits the report evidence.
    """

    return _generate_chart_impl(
        runtime=runtime,
        chart_tool=chart_type,
        chart_args=data,
        rationale=rationale or f"{chart_type} fits the available report evidence.",
        output_name=output_name,
        source="generate_chart",
    )


@tool("generate_report_chart", parse_docstring=True)
def generate_report_chart(
    runtime: ToolRuntime,
    chart_tool: ChartTool,
    chart_args: dict[str, Any],
    rationale: str,
    output_name: str | None = None,
) -> str:
    """Generate a local chart image for PDF/report artifacts.

    Deprecated compatibility wrapper. Prefer generate_chart in the builder
    report toolset. Choose the chart tool from the chart-visualization taxonomy,
    pass the exact labeled data in chart_args, and explain the choice in
    rationale. The tool saves the chart spec and downloads the rendered chart
    under /mnt/user-data/outputs/visuals/.

    Args:
        chart_tool: Chart-visualization tool name, e.g. generate_line_chart,
            generate_sankey_chart, generate_treemap_chart, or generate_radar_chart.
        chart_args: Exact chart-visualization arguments, including data, labels, title,
            and style/theme fields needed by the selected chart tool.
        rationale: Brief reason this chart family fits the report evidence.
        output_name: Optional output filename or /mnt/user-data/outputs/... path.
    """

    return _generate_chart_impl(
        runtime=runtime,
        chart_tool=chart_tool,
        chart_args=chart_args,
        rationale=rationale,
        output_name=output_name,
        source="generate_report_chart",
    )
