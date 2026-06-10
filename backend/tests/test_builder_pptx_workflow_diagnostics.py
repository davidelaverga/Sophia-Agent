from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import ToolMessage
from PIL import Image

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PPT_SCRIPT = _REPO_ROOT / "skills/public/ppt-generation/scripts/generate.py"


def _tool_message(text: str) -> ToolMessage:
    return ToolMessage(content=text, tool_call_id="call-1")


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 180), color=(40, 140, 180)).save(path)


def test_image_generation_bash_result_records_output_bytes(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    image = outputs / "slide-01.jpg"
    image.write_bytes(b"jpeg-bytes")
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.jpg "
                    "--aspect-ratio 16:9"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Successfully generated image"),
    )

    assert delta == {
        "image_generation_attempt_count": 1,
        "image_generation_success_count": 1,
        "image_generation_bytes_total": len(b"jpeg-bytes"),
        "image_generation_error_class": None,
        "image_output_paths": ["/mnt/user-data/outputs/slide-01.jpg"],
    }


def test_image_generation_bash_result_parses_machine_readable_failure(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.jpg "
                    "--aspect-ratio 16:9"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("IMAGEGEN_FAIL reason=org_not_verified\nOpenAI image generation failed"),
    )

    assert delta["image_generation_attempt_count"] == 1
    assert delta["image_generation_success_count"] == 0
    assert delta["image_generation_error_class"] == "org_not_verified"


def test_pptx_generation_bash_result_classifies_missing_output(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/ppt-generation/scripts/generate.py "
                    "--plan-file /mnt/user-data/workspace/plan.json "
                    "--slide-images /mnt/user-data/outputs/slide-01.jpg "
                    "--output-file /mnt/user-data/outputs/deck.pptx"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Error while generating presentation: FileNotFoundError: Slide image not found"),
    )

    assert delta["pptx_generator_attempt_count"] == 1
    assert delta["pptx_generator_success_count"] == 0
    assert delta["pptx_generator_bytes_total"] == 0
    assert delta["pptx_generator_error_class"] == "missing_slide_image"


def test_failed_image_generation_after_correction_does_not_force_fallback(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_non_artifact_turns": 5,
        "builder_pptx_skill_correction_emitted": True,
        "builder_pptx_diagnostics": {
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 0,
            "image_generation_error_class": "api_error",
        },
    }

    result = BuilderArtifactMiddleware().before_model(state, SimpleNamespace(context={}))

    assert result is None


def test_invalid_plan_json_gets_pptx_plan_correction(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_diagnostics": {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 0,
            "pptx_generator_error_class": "invalid_plan_json",
        },
    }

    result = BuilderArtifactMiddleware().before_model(state, SimpleNamespace(context={}))

    assert result is not None
    assert result["builder_pptx_plan_correction_emitted"] is True
    assert "presentation-plan correction" in result["messages"][0].content
    assert "slides" in result["messages"][0].content


def test_ppt_generation_script_can_create_no_image_deck(tmp_path: Path) -> None:
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "title": "No Image Deck",
                "aspect_ratio": "16:9",
                "slides": [
                    {"title": "One", "subtitle": "Opening"},
                    {"title": "Two", "key_points": ["A", "B"]},
                ],
            }
        ),
        encoding="utf-8",
    )
    output = tmp_path / "deck.pptx"

    result = subprocess.run(
        [
            sys.executable,
            str(_PPT_SCRIPT),
            "--plan-file",
            str(plan),
            "--output-file",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode == 0
    assert output.exists()
    assert output.stat().st_size > 1024
    assert "Successfully generated presentation with 2 slides" in result.stdout


def test_ppt_generation_script_embeds_plan_chart_image(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    chart = outputs / "visuals" / "chart.png"
    _write_png(chart)
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "title": "Visual Deck",
                "aspect_ratio": "16:9",
                "slides": [
                    {
                        "title": "Architecture",
                        "key_points": ["Capture", "Plan", "Execute"],
                        "chart_path": "/mnt/user-data/outputs/visuals/chart.png",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    output = outputs / "deck.pptx"

    result = subprocess.run(
        [
            sys.executable,
            str(_PPT_SCRIPT),
            "--plan-file",
            str(plan),
            "--output-file",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr
    assert "picture_count=1" in result.stdout
    with zipfile.ZipFile(output) as archive:
        assert any(name.startswith("ppt/media/") for name in archive.namelist())


def test_ppt_generation_script_exits_nonzero_when_slide_image_missing(tmp_path: Path) -> None:
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"aspect_ratio": "16:9", "slides": [{"title": "One"}]}), encoding="utf-8")
    output = tmp_path / "deck.pptx"

    result = subprocess.run(
        [
            sys.executable,
            str(_PPT_SCRIPT),
            "--plan-file",
            str(plan),
            "--slide-images",
            str(tmp_path / "missing.jpg"),
            "--output-file",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode == 1
    assert "FileNotFoundError" in result.stderr
    assert "Slide image not found" in result.stderr
    assert not output.exists()
