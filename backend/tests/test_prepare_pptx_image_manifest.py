"""Tests for deterministic PPTX image manifest preparation."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import deerflow.sophia.tools.prepare_pptx_image_manifest as manifest_tool
from deerflow.agents.sophia_agent.builder_tools import build_builder_tools_for_task_type

_OUTPUTS = "/mnt/user-data/outputs/"
_WORKSPACE = "/mnt/user-data/workspace/"


def _runtime(*, outputs: Path, workspace: Path | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        state={
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace) if workspace is not None else str(outputs),
            }
        },
        context={},
        config={},
    )


def _call(**kwargs) -> dict:
    return json.loads(manifest_tool.prepare_pptx_image_manifest.func(**kwargs))


def test_presentation_toolset_offers_manifest_preparer() -> None:
    names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("presentation", vision_enabled=False)]
    assert "prepare_pptx_image_manifest" in names
    assert "build_deck_from_slides" in names

    report_names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("document", vision_enabled=False)]
    assert "prepare_pptx_image_manifest" not in report_names


def test_prepare_pptx_image_manifest_writes_deterministic_schema(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)
    outputs.mkdir()
    (workspace / "slide-01.json").write_text('{"prompt":"professional system map"}', encoding="utf-8")
    (workspace / "slide-02.json").write_text('{"prompt":"restrained rollout diagram"}', encoding="utf-8")

    result = _call(
        runtime=_runtime(outputs=outputs, workspace=workspace),
        prompt_files=[
            f"{_WORKSPACE}slide-01.json",
            f"{_WORKSPACE}slide-02.json",
        ],
    )

    assert result["success"] is True
    assert result["manifest_path"] == f"{_OUTPUTS}assets/slide-visuals.manifest.json"
    assert result["expected_count"] == 2
    assert [item["output_path"] for item in result["items"]] == [
        f"{_OUTPUTS}assets/slide-01.png",
        f"{_OUTPUTS}assets/slide-02.png",
    ]
    assert result["items"][0]["prompt_hash"]
    assert "professional system map" not in json.dumps(result)

    manifest = json.loads((outputs / "assets" / "slide-visuals.manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == "sophia-pptx-image-manifest/v1"
    assert manifest["manifest_author"] == "prepare_pptx_image_manifest"
    assert manifest["items"][0] == {
        "schema_version": "sophia-pptx-image-manifest/v1",
        "slide_index": 1,
        "prompt_file": f"{_WORKSPACE}slide-01.json",
        "output_file": f"{_OUTPUTS}assets/slide-01.png",
        "slide_visual": True,
        "aspect_ratio": "16:9",
    }


def test_prepare_pptx_image_manifest_rejects_missing_prompt(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    outputs.mkdir()
    workspace.mkdir()

    result = _call(
        runtime=_runtime(outputs=outputs, workspace=workspace),
        prompt_files=[f"{_WORKSPACE}missing.json"],
    )

    assert result["success"] is False
    assert result["error_type"] == "manifest_prompt_missing"
    assert "missing.json" in result["error"]


def test_prepare_pptx_image_manifest_rejects_unsafe_paths(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()

    bad_prompt = _call(
        runtime=_runtime(outputs=outputs),
        prompt_files=["/tmp/prompt.json"],
    )
    assert bad_prompt["success"] is False
    assert bad_prompt["error_type"] == "invalid_prompt_file"

    bad_manifest = _call(
        runtime=_runtime(outputs=outputs),
        prompt_files=[f"{_OUTPUTS}prompt.json"],
        manifest_path="/tmp/manifest.json",
    )
    assert bad_manifest["success"] is False
    assert bad_manifest["error_type"] == "invalid_manifest_path"


def test_prepare_pptx_image_manifest_trace_payload_is_sanitized(tmp_path, monkeypatch) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "prompt.json").write_text('{"prompt":"do not leak this raw prompt"}', encoding="utf-8")
    spans: list[dict] = []
    monkeypatch.setattr(
        manifest_tool,
        "_trace_manifest_tool",
        lambda name, **kwargs: spans.append({"name": name, **kwargs}),
    )

    result = _call(
        runtime=_runtime(outputs=outputs),
        prompt_files=[f"{_OUTPUTS}prompt.json"],
    )

    assert result["success"] is True
    dumped = json.dumps(spans)
    assert "do not leak this raw prompt" not in dumped
    assert "prompt_hash" in dumped
    assert {span["name"] for span in spans} >= {
        "Sophia PPTX Visual Prompt Files Prepared",
        "Sophia PPTX Image Manifest Prepared",
    }
