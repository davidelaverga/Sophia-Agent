from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from deerflow.sophia.tools import generate_report_chart as chart_module
from deerflow.sophia.tools.generate_report_chart import generate_report_chart
from deerflow.agents.sophia_agent.builder_tools import build_builder_tools_for_task_type


def _payload(raw: str) -> dict:
    return json.loads(raw)


def _runtime(outputs_path: Path) -> SimpleNamespace:
    return SimpleNamespace(state={"thread_data": {"outputs_path": str(outputs_path)}})


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
            args={"title": "Flow", "data": [{"source": "A", "target": "B", "value": 4}]},
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


def test_generate_report_chart_rejects_empty_args(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(chart_module.shutil, "which", lambda _name: "/usr/bin/node")

    payload = _payload(
        generate_report_chart.func(
            chart_tool="generate_line_chart",
            args={},
            rationale="Trend chart.",
            runtime=_runtime(tmp_path),
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "chart_args_required"
    assert payload["chart_family"] == "time_series"


def test_generate_report_chart_schema_excludes_runtime() -> None:
    schema = generate_report_chart.tool_call_schema.model_json_schema()

    properties = schema.get("properties", {})
    assert "runtime" not in properties
    assert {"chart_tool", "args", "rationale"}.issubset(properties)


def test_report_builder_tool_schemas_generate_for_all_tools() -> None:
    failures = {}
    for tool in build_builder_tools_for_task_type("document", vision_enabled=False):
        try:
            tool.tool_call_schema.model_json_schema()
        except Exception as exc:  # noqa: BLE001 - assertion reports every broken tool.
            failures[getattr(tool, "name", type(tool).__name__)] = f"{type(exc).__name__}: {exc}"

    assert failures == {}
