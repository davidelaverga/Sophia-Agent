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
    _merge_builder_pptx_diagnostics,
    _pptx_skill_read_seen,
    _visual_design_skill_read_seen,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PPT_SCRIPT = _REPO_ROOT / "skills/public/ppt-generation/scripts/generate.py"


def _tool_message(text: str) -> ToolMessage:
    return ToolMessage(content=text, tool_call_id="call-1")


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 180), color=(40, 140, 180)).save(path)


def _write_minimal_pptx(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("_rels/.rels", "<Relationships></Relationships>")
        archive.writestr("ppt/presentation.xml", "<p:presentation></p:presentation>")
        archive.writestr("ppt/slides/slide1.xml", "x" * 2048)


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


def test_pptx_generation_bash_result_records_plan_and_slide_count(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outputs = tmp_path / "outputs"
    workspace.mkdir()
    outputs.mkdir()
    plan_file = workspace / "plan.json"
    plan = {
        "slides": [
            {"title": "One", "image": "/mnt/user-data/outputs/slide-01.png"},
            {"title": "Two"},
        ]
    }
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    request = SimpleNamespace(
        state={
            "thread_data": {
                "workspace_path": str(workspace),
                "outputs_path": str(outputs),
            }
        },
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/ppt-generation/scripts/generate.py "
                    "--plan-file /mnt/user-data/workspace/plan.json "
                    "--output-file /mnt/user-data/outputs/deck.pptx"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Successfully generated presentation with 2 slides (picture_count=1)"),
    )

    assert delta["pptx_generator_slide_count"] == 2
    assert delta["pptx_plan_slide_count"] == 2
    assert delta["pptx_plan_image_ref_count"] == 1
    assert delta["pptx_plan_json"] == plan


def test_chained_pptx_generation_uses_ppt_generator_output_flag(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outputs = tmp_path / "outputs"
    workspace.mkdir()
    outputs.mkdir()
    slide = outputs / "slide-01.png"
    slide.write_bytes(b"png-bytes")
    deck = outputs / "deck.pptx"
    _write_minimal_pptx(deck)
    plan_file = workspace / "plan.json"
    plan_file.write_text(json.dumps({"slides": [{"title": "One", "image_path": str(slide)}]}), encoding="utf-8")
    request = SimpleNamespace(
        state={"thread_data": {"workspace_path": str(workspace), "outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png && "
                    "python /mnt/skills/public/ppt-generation/scripts/generate.py "
                    "--plan-file /mnt/user-data/workspace/plan.json "
                    "--slide-images /mnt/user-data/outputs/slide-01.png "
                    "--output-file /mnt/user-data/outputs/deck.pptx"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Successfully generated image\nSuccessfully generated presentation with 1 slides (picture_count=1)"),
    )

    assert delta["image_generation_success_count"] == 1
    assert delta["image_output_paths"] == ["/mnt/user-data/outputs/slide-01.png"]
    assert delta["pptx_generator_success_count"] == 1
    assert delta["pptx_generator_error_class"] is None
    assert delta["pptx_generator_bytes_total"] == deck.stat().st_size
    assert delta["pptx_output_paths"] == ["/mnt/user-data/outputs/deck.pptx"]
    assert delta["pptx_generator_slide_count"] == 1
    assert delta["pptx_generator_picture_count"] == 1
    assert delta["pptx_plan_slide_count"] == 1


def test_pptx_diagnostic_merge_keeps_latest_absolute_deck_counts() -> None:
    merged = _merge_builder_pptx_diagnostics(
        {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 1,
            "pptx_generator_bytes_total": 128,
            "pptx_generator_slide_count": 5,
            "pptx_generator_picture_count": 4,
            "pptx_plan_slide_count": 5,
            "pptx_plan_image_ref_count": 4,
        },
        {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 1,
            "pptx_generator_bytes_total": 256,
            "pptx_generator_slide_count": 5,
            "pptx_generator_picture_count": 4,
            "pptx_plan_slide_count": 5,
            "pptx_plan_image_ref_count": 4,
        },
    )

    assert merged["pptx_generator_attempt_count"] == 2
    assert merged["pptx_generator_success_count"] == 2
    assert merged["pptx_generator_bytes_total"] == 384
    assert merged["pptx_generator_slide_count"] == 5
    assert merged["pptx_generator_picture_count"] == 4
    assert merged["pptx_plan_slide_count"] == 5
    assert merged["pptx_plan_image_ref_count"] == 4


def test_slide_qc_bash_result_records_verdict_feedback_payload(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--image-file /mnt/user-data/outputs/slide-01.png "
                    "--spec-file /mnt/user-data/workspace/slide-01.txt"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message('{"pass": false, "reasons": ["garbled"]}\nStd Error:\n[qc] PASS=False reasons=["garbled"]'),
    )

    assert delta == {
        "qc_invocation_count": 1,
        "qc_pass_count": 0,
        "qc_failure_count": 1,
        "qc_results": [{"pass": False, "reasons": ["garbled"]}],
        "qc_reasons": ["garbled"],
    }


def test_image_generation_and_slide_qc_bash_result_merge_diagnostics(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    image = outputs / "slide-01.png"
    image.write_bytes(b"png-bytes")
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png "
                    "--aspect-ratio 16:9 && "
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--image-file /mnt/user-data/outputs/slide-01.png "
                    "--spec-file /mnt/user-data/workspace/slide-01.txt"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message('Successfully generated image\n[qc] PASS=False reasons=["garbled"]'),
    )

    assert delta == {
        "image_generation_attempt_count": 1,
        "image_generation_success_count": 1,
        "image_generation_bytes_total": len(b"png-bytes"),
        "image_generation_error_class": None,
        "image_output_paths": ["/mnt/user-data/outputs/slide-01.png"],
        "qc_invocation_count": 1,
        "qc_pass_count": 0,
        "qc_failure_count": 1,
        "qc_results": [{"pass": False, "reasons": ["garbled"]}],
        "qc_reasons": ["garbled"],
    }


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
    assert "plan JSON invalid: invalid_plan_json; re-emit valid JSON matching the deck schema" in result["messages"][0].content
    assert "slides" in result["messages"][0].content


def test_skill_read_flags_latch_after_summary_window_rolls() -> None:
    state: dict = {}
    history = BuilderArtifactMiddleware._append_turn_summary(
        state,
        {
            "turn": 1,
            "tool_names": ["read_file"],
            "pptx_skill_read": True,
            "visual_design_skill_read": True,
        },
    )
    state = {
        "builder_tool_turn_summaries": history,
        "builder_skill_reads": state["builder_skill_reads"],
    }

    for turn in range(2, 16):
        history = BuilderArtifactMiddleware._append_turn_summary(
            state,
            {"turn": turn, "tool_names": ["bash"], "pptx_skill_read": False, "visual_design_skill_read": False},
        )
        state = {
            "builder_tool_turn_summaries": history,
            "builder_skill_reads": state["builder_skill_reads"],
        }

    assert len(state["builder_tool_turn_summaries"]) == 12
    assert state["builder_tool_turn_summaries"][0]["turn"] == 4
    assert _pptx_skill_read_seen(state) is True
    assert _visual_design_skill_read_seen(state) is True


def test_visual_skill_forced_read_stops_after_cap() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
    }

    assert middleware._visual_tool_choice_for_state(state) == {"type": "tool", "name": "read_file"}
    assert state["builder_visual_force_count"] == 1
    assert middleware._visual_tool_choice_for_state(state) == {"type": "tool", "name": "read_file"}
    assert state["builder_visual_force_count"] == 2
    assert middleware._visual_tool_choice_for_state(state) is None


def test_visual_skill_force_cap_ignores_unrelated_read_file_turns() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
        "builder_tool_turn_summaries": [
            {"tool_names": ["read_file"], "visual_design_skill_read": False},
            {"tool_names": ["read_file_tool"], "visual_design_skill_read": False},
        ],
    }

    assert middleware._visual_tool_choice_for_state(state) == {"type": "tool", "name": "read_file"}
    assert state["builder_visual_force_count"] == 1


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


def test_ppt_generation_script_degrades_when_slide_image_missing(tmp_path: Path) -> None:
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

    assert result.returncode == 0
    assert "Slide image missing, using text layout:" in result.stderr
    assert output.exists()
