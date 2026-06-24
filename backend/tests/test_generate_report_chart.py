from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from deerflow.sophia.tools import generate_report_chart as chart_module
from deerflow.sophia.tools.generate_report_chart import generate_chart, generate_report_chart
from deerflow.agents.sophia_agent.builder_tools import build_builder_tools_for_task_type
from langgraph.prebuilt.tool_node import _get_all_injected_args


def _payload(raw: str) -> dict:
    return json.loads(raw)


def _runtime(outputs_path: Path) -> SimpleNamespace:
    return SimpleNamespace(state={"thread_data": {"outputs_path": str(outputs_path)}})


class _FakeResponse:
    def __init__(self, *, content: bytes, content_type: str | None = None) -> None:
        self.content = content
        self.headers = {"content-type": content_type} if content_type is not None else {}

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def get(self, _url: str) -> _FakeResponse:
        return self._response


def test_generate_report_chart_writes_spec_and_downloads_png(tmp_path, monkeypatch) -> None:
    script = tmp_path / "generate.js"
    script.write_text("// fake", encoding="utf-8")
    monkeypatch.setattr(chart_module, "_chart_script_path", lambda: script)
    monkeypatch.setattr(chart_module.shutil, "which", lambda _name: "/usr/bin/node")

    def fake_run(command, **kwargs):
        spec_path = Path(command[-1])
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        assert spec["tool"] == "generate_sankey_chart"
        assert spec["args"]["title"] == "Flow"
        assert spec["sophia"]["chart_family"] == "flow"
        return subprocess.CompletedProcess(command, 0, stdout="https://charts.example/flow.png\n", stderr="")

    def fake_download(url: str, image_host_path: Path):
        assert url == "https://charts.example/flow.png"
        image_host_path.write_bytes(b"png-bytes")
        return len(b"png-bytes"), "image/png"

    monkeypatch.setattr(chart_module.subprocess, "run", fake_run)
    monkeypatch.setattr(chart_module, "_download_chart_image", fake_download)

    payload = _payload(
        generate_report_chart.func(
            chart_tool="generate_sankey_chart",
            chart_args={"title": "Flow", "data": [{"source": "A", "target": "B", "value": 4}]},
            rationale="A sankey chart shows flow volume across stages.",
            output_name="flow",
            runtime=_runtime(tmp_path),
        )
    )

    assert payload["success"] is True
    assert payload["chart_tool"] == "generate_sankey_chart"
    assert payload["chart_family"] == "flow"
    assert payload["png_path"] == "/mnt/user-data/outputs/visuals/flow.png"
    assert payload["spec_path"] == "/mnt/user-data/outputs/visuals/flow.chart.json"
    assert (tmp_path / "visuals" / "flow.png").read_bytes() == b"png-bytes"
    assert (tmp_path / "visuals" / "flow.chart.json").is_file()


def test_download_chart_image_rejects_non_image_response(tmp_path, monkeypatch) -> None:
    target = tmp_path / "chart.png"
    monkeypatch.setattr(
        chart_module.httpx,
        "Client",
        lambda **_kwargs: _FakeClient(
            _FakeResponse(content=b"<html>blocked</html>", content_type="text/html")
        ),
    )

    try:
        chart_module._download_chart_image("https://charts.example/bad.png", target)
    except chart_module.ChartDownloadInvalidImage as exc:
        assert exc.content_type == "text/html"
        assert exc.byte_count == len(b"<html>blocked</html>")
    else:  # pragma: no cover - assertion branch
        raise AssertionError("expected ChartDownloadInvalidImage")

    assert not target.exists()


def test_download_result_payload_reports_invalid_image(tmp_path, monkeypatch) -> None:
    def invalid_download(_url: str, _image_host_path: Path):
        raise chart_module.ChartDownloadInvalidImage(
            content_type="application/json",
            byte_count=42,
        )

    monkeypatch.setattr(chart_module, "_download_chart_image", invalid_download)

    payload = _payload(
        chart_module._download_result_payload(
            chart_tool="generate_bar_chart",
            family="comparison",
            rationale="Compare scenarios.",
            chart_url="https://charts.example/error.png",
            image_path="/mnt/user-data/outputs/visuals/error.png",
            spec_path="/mnt/user-data/outputs/visuals/error.chart.json",
            image_host_path=tmp_path / "error.png",
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "chart_download_invalid_image"
    assert payload["content_type"] == "application/json"
    assert payload["image_bytes"] == 42


def test_generate_report_chart_rejects_empty_args(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(chart_module.shutil, "which", lambda _name: "/usr/bin/node")

    payload = _payload(
        generate_report_chart.func(
            chart_tool="generate_line_chart",
            chart_args={},
            rationale="Trend chart.",
            runtime=_runtime(tmp_path),
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "chart_args_required"
    assert payload["chart_family"] == "time_series"


def test_chart_paths_avoid_cross_family_spec_collision(tmp_path) -> None:
    visuals = tmp_path / "visuals"
    visuals.mkdir()
    (visuals / "flow.chart.json").write_text(
        json.dumps({"tool": "generate_sankey_chart"}),
        encoding="utf-8",
    )

    image_path, spec_path, image_host_path, spec_host_path, error = chart_module._resolved_output_paths(
        "flow",
        "generate_bar_chart",
        "comparison",
        _runtime(tmp_path),
    )

    assert error is None
    assert image_path == "/mnt/user-data/outputs/visuals/flow-bar.png"
    assert spec_path == "/mnt/user-data/outputs/visuals/flow-bar.chart.json"
    assert image_host_path == visuals / "flow-bar.png"
    assert spec_host_path == visuals / "flow-bar.chart.json"


def test_generate_report_chart_schema_excludes_runtime() -> None:
    schema = generate_report_chart.tool_call_schema.model_json_schema()

    properties = schema.get("properties", {})
    assert "runtime" not in properties
    assert {"chart_tool", "chart_args", "rationale"}.issubset(properties)


def test_generate_report_chart_runtime_is_langgraph_injected() -> None:
    injected = _get_all_injected_args(generate_report_chart)

    assert injected.runtime == "runtime"
    assert "runtime" in injected.all_injected_keys


def test_generate_chart_schema_excludes_runtime() -> None:
    schema = generate_chart.tool_call_schema.model_json_schema()

    properties = schema.get("properties", {})
    assert "runtime" not in properties
    assert {"chart_type", "data", "rationale"}.issubset(properties)
    assert "chart_tool" not in properties
    assert "chart_args" not in properties


def test_generate_chart_runtime_is_langgraph_injected() -> None:
    injected = _get_all_injected_args(generate_chart)

    assert injected.runtime == "runtime"
    assert "runtime" in injected.all_injected_keys


def test_report_builder_tool_schemas_generate_for_all_tools() -> None:
    failures = {}
    for tool in build_builder_tools_for_task_type("document", vision_enabled=False):
        try:
            tool.tool_call_schema.model_json_schema()
        except Exception as exc:  # noqa: BLE001 - assertion reports every broken tool.
            failures[getattr(tool, "name", type(tool).__name__)] = f"{type(exc).__name__}: {exc}"

    assert failures == {}
