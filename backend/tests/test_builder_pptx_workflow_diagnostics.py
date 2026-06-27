from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

from langchain.agents.middleware.types import ExtendedModelResponse, ModelResponse
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _deck_plan_validation_problems,
    _maybe_attach_image_trace_env,
    _merge_builder_pptx_diagnostics,
    _pptx_skill_read_seen,
    _qc_result_presence_problem,
    _slide_qc_results_from_text,
    _slide_type,
    _validate_deck_plan,
    _visual_asset_result_delta,
    _visual_design_skill_read_seen,
    _wire_plan_visual_assets,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PPT_SCRIPT = _REPO_ROOT / "skills/public/ppt-generation/scripts/generate.py"


def _tool_message(text: str) -> ToolMessage:
    return ToolMessage(content=text, tool_call_id="call-1")


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 180), color=(40, 140, 180)).save(path)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _write_minimal_pptx(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("_rels/.rels", "<Relationships></Relationships>")
        archive.writestr("ppt/presentation.xml", "<p:presentation></p:presentation>")
        archive.writestr("ppt/slides/slide1.xml", "x" * 2048)


def test_report_chart_tool_result_records_visual_asset_path() -> None:
    delta = _visual_asset_result_delta(
        _tool_message(
            json.dumps(
                {
                    "success": True,
                    "chart_tool": "generate_sankey_chart",
                    "image_path": "/mnt/user-data/outputs/visuals/flow.png",
                    "image_bytes": 128,
                }
            )
        )
    )

    assert delta is not None
    assert delta["visual_asset_success_count"] == 1
    assert delta["visual_asset_bytes_total"] == 128
    assert delta["visual_asset_paths"] == ["/mnt/user-data/outputs/visuals/flow.png"]
    assert delta["visual_png_paths"] == ["/mnt/user-data/outputs/visuals/flow.png"]


def test_slide_qc_presence_unavailable_is_advisory() -> None:
    results = _slide_qc_results_from_text(
        json.dumps(
            {
                "pass": False,
                "skipped": True,
                "reasons": [
                    "slide QC skipped: ANTHROPIC_API_KEY is not set",
                    "deterministic presence OCR skipped: tesseract is not installed",
                ],
                "presence_skipped": True,
                "presence_unavailable": True,
                "presence_reasons": [
                    "deterministic presence OCR skipped: tesseract is not installed"
                ],
            }
        )
    )

    assert results == [
        {
            "pass": False,
            "reasons": [
                "slide QC skipped: ANTHROPIC_API_KEY is not set",
                "deterministic presence OCR skipped: tesseract is not installed",
            ],
            "skipped": True,
            "presence_skipped": True,
            "presence_unavailable": True,
            "presence_reasons": [
                "deterministic presence OCR skipped: tesseract is not installed"
            ],
        }
    ]
    assert _qc_result_presence_problem(1, results[0]) is None


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
        "image_output_records": [
            {
                "image_ref": "/mnt/user-data/outputs/slide-01.jpg",
                "image_basename": "slide-01.jpg",
                "image_hash": _sha256_bytes(b"jpeg-bytes"),
                "slide_index": 1,
            }
        ],
    }


def test_image_generation_bash_command_gets_builder_trace_env() -> None:
    request = SimpleNamespace(
        state={
            "delegation_context": {"thread_id": "thread-1"},
            "builder_task": {"run_id": "run-1"},
        },
        runtime=SimpleNamespace(config={"metadata": {"trace_id": "trace-1"}}),
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png"
                )
            },
        },
    )

    _maybe_attach_image_trace_env(request)

    command = request.tool_call["args"]["command"]
    assert command.startswith(
        "export SOPHIA_PARENT_TRACE_ID=trace-1 SOPHIA_PARENT_RUN_ID=run-1 SOPHIA_THREAD_ID=thread-1; "
    )
    assert "image-generation/scripts/generate.py" in command


def test_attach_image_trace_env_exports_for_chained_generation() -> None:
    request = SimpleNamespace(
        state={
            "thread_id": "thread-1",
            "builder_task": {"run_id": "run-1"},
        },
        runtime=SimpleNamespace(config={"metadata": {"trace_id": "trace-1"}}),
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png && "
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-02.json "
                    "--output-file /mnt/user-data/outputs/slide-02.png"
                )
            },
        },
    )

    _maybe_attach_image_trace_env(request)

    command = request.tool_call["args"]["command"]
    assert command.startswith("export SOPHIA_PARENT_TRACE_ID=trace-1 ")
    assert " SOPHIA_PARENT_RUN_ID=run-1 " in command
    assert " SOPHIA_THREAD_ID=thread-1; python " in command
    assert command.count("image-generation/scripts/generate.py") == 2


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


def test_chained_preflight_and_image_generation_records_both_diagnostics(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    image_1 = outputs / "slide-01.png"
    image_1.write_bytes(b"png-1")
    image_2 = outputs / "slide-02.png"
    image_2.write_bytes(b"png-2-bytes")
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py --preflight && "
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png "
                    "--slide-visual && "
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-02.json "
                    "--output-file /mnt/user-data/outputs/slide-02.png "
                    "--slide-visual"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message('{"preflight": "ok"}\nSuccessfully generated image'),
    )

    assert delta["image_generation_preflight"] == "ok"
    assert delta["image_generation_attempt_count"] == 2
    assert delta["image_generation_success_count"] == 2
    assert delta["image_generation_bytes_total"] == len(b"png-1") + len(b"png-2-bytes")
    assert delta["image_generation_error_class"] is None
    assert delta["image_output_paths"] == [
        "/mnt/user-data/outputs/slide-01.png",
        "/mnt/user-data/outputs/slide-02.png",
    ]


def test_failed_preflight_in_chain_does_not_count_unrun_generation(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py --preflight && "
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png "
                    "--slide-visual"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message('{"preflight": "failed", "reason": "env_missing"}'),
    )

    assert delta == {
        "image_generation_preflight": "failed",
        "image_generation_skip_reason": "env_missing",
    }


def test_chained_image_generation_records_successful_paths_when_later_output_missing(tmp_path: Path) -> None:
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
                    "--output-file /mnt/user-data/outputs/slide-01.png && "
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-02.json "
                    "--output-file /mnt/user-data/outputs/slide-02.png"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Successfully generated first image\nIMAGEGEN_FAIL reason=api_error"),
    )

    assert delta["image_generation_attempt_count"] == 2
    assert delta["image_generation_success_count"] == 1
    assert delta["image_generation_bytes_total"] == len(b"png-bytes")
    assert delta["image_generation_error_class"] == "api_error"
    assert delta["image_output_paths"] == ["/mnt/user-data/outputs/slide-01.png"]


def test_adjacent_shell_separators_split_image_generation_segments(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    image_1 = outputs / "slide-01.png"
    image_1.write_bytes(b"png-1")
    image_2 = outputs / "slide-02.png"
    image_2.write_bytes(b"png-2")
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-01.json "
                    "--output-file /mnt/user-data/outputs/slide-01.png&&"
                    "python /mnt/skills/public/image-generation/scripts/generate.py "
                    "--prompt-file /mnt/user-data/workspace/slide-02.json "
                    "--output-file /mnt/user-data/outputs/slide-02.png"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message("Successfully generated first image\nSuccessfully generated second image"),
    )

    assert delta["image_generation_attempt_count"] == 2
    assert delta["image_generation_success_count"] == 2
    assert delta["image_generation_bytes_total"] == len(b"png-1") + len(b"png-2")
    assert delta["image_output_paths"] == [
        "/mnt/user-data/outputs/slide-01.png",
        "/mnt/user-data/outputs/slide-02.png",
    ]


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


def test_pptx_generation_bash_result_parses_pptxgenjs_slide_count(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outputs = tmp_path / "outputs"
    workspace.mkdir()
    outputs.mkdir()
    deck = outputs / "deck.pptx"
    _write_minimal_pptx(deck)
    plan_file = workspace / "plan.json"
    plan = {"slides": [{"title": "One"}, {"title": "Two"}, {"title": "Three"}]}
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
        _tool_message(
            "[compile_pptx] wrote /mnt/user-data/outputs/deck.pptx slides=3 pictures=3\n"
            "Successfully generated presentation with PptxGenJS"
        ),
    )

    assert delta["pptx_generator_success_count"] == 1
    assert delta["pptx_generator_slide_count"] == 3
    assert delta["pptx_plan_slide_count"] == 3


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


def test_pptx_generation_bash_result_records_title_presence_diagnostics(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    deck = outputs / "deck.pptx"
    _write_minimal_pptx(deck)
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "node /app/backend/packages/harness/deerflow/sophia/js/compile_pptx.mjs "
                    "--plan-file /mnt/user-data/workspace/plan.json "
                    "--output-file /mnt/user-data/outputs/deck.pptx"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message(
            "Successfully generated presentation with 1 slides (picture_count=1)\n"
            "PPTXGEN slide_diagnostics: slide=1 type=cover image_forward=true "
            "title_present=true title_overlay=true"
        ),
    )

    assert delta["pptx_slide_title_results"] == [
        {
            "slide": 1,
            "type": "cover",
            "image_forward": True,
            "title_present": True,
            "title_overlay": True,
        }
    ]


def test_validate_deck_plan_does_not_require_qc_for_each_image_slide() -> None:
    plan = {
        "slides": [
            {"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png", "visual_style": "clean_flat_vector"},
            {
                "type": "content",
                "subtype": "architecture",
                "title": "Flow",
                "caption": "The flow keeps every handoff explicit.",
                "image_path": "/mnt/user-data/outputs/slide-2.png",
                "visual_style": "clean_flat_vector",
            },
        ]
    }

    problems = _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-1.png"},
            ],
        },
    )

    assert problems == []


def test_validate_deck_plan_accepts_image_forward_with_title_and_qc() -> None:
    plan = {
        "slides": [
            {"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png", "visual_style": "clean_flat_vector"},
            {
                "type": "content",
                "subtype": "architecture",
                "title": "Flow",
                "caption": "The flow keeps every handoff explicit.",
                "image_path": "/mnt/user-data/outputs/slide-2.png",
                "visual_style": "clean_flat_vector",
            },
        ]
    }

    problems = _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-1.png"},
                {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-2.png"},
            ],
        },
    )

    assert problems == []


def test_validate_deck_plan_accepts_qc_coverage_by_image_hash(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    image = outputs / "regenerated.png"
    image.write_bytes(b"same-image-bytes")
    image_hash = _sha256_bytes(b"same-image-bytes")
    plan = {
        "slides": [
            {
                "type": "cover",
                "title": "Launch",
                "image_path": "/mnt/user-data/outputs/regenerated.png",
                "visual_style": "clean_flat_vector",
            }
        ]
    }

    problems = _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_image_records": [
                {
                    "slide_index": 1,
                    "image_ref": "/mnt/user-data/outputs/old-name.png",
                    "image_basename": "old-name.png",
                    "image_hash": image_hash,
                    "qc_result": {"pass": True, "reasons": []},
                }
            ],
        },
        {"thread_data": {"outputs_path": str(outputs)}},
    )

    assert problems == []


def test_deck_plan_validation_ignores_metadata_when_no_package_evidence_exists() -> None:
    plan = {
        "slides": [
            {"type": "cover", "title": "Launch"},
            {
                "type": "content",
                "title": "Benchmark chart",
                "visual_path": "/mnt/user-data/outputs/visuals/benchmark-chart.png",
            },
        ]
    }
    diagnostics = {
        "pptx_plan_json": plan,
        "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
    }
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation", "task": "Create a visual deck"},
        "builder_pptx_diagnostics": diagnostics,
    }

    assert _deck_plan_validation_problems(state) == []
    assert "data_chart" not in diagnostics["pptx_plan_json"]["slides"][1]
    assert "builder_pptx_plan_deterministic_repair_attempted" not in state


def test_deck_plan_validation_autowires_generated_slide_images_without_qc_gate(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    slide = visuals / "slide-02.png"
    _write_png(slide)
    plan = {
        "slides": [
            {
                "type": "cover",
                "title": "Launch",
                "image_path": "/mnt/user-data/outputs/visuals/slide-01.png",
                "visual_style": "clean_flat_vector",
            },
            {
                "type": "content",
                "title": "Benchmark chart",
                "subtype": "chart",
                "caption": "The benchmark trend is visible inside the baked slide image.",
            },
        ]
    }
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation", "task": "Create a visual deck"},
        "builder_pptx_diagnostics": {
            "image_output_paths": ["/mnt/user-data/outputs/visuals/slide-02.png"],
        },
        "thread_data": {"outputs_path": str(outputs)},
    }

    assert _wire_plan_visual_assets(plan["slides"], state) is True
    assert plan["slides"][1]["image"] == "/mnt/user-data/outputs/visuals/slide-02.png"
    assert "data_chart" not in plan["slides"][1]
    assert plan["slides"][1]["visual_style"] == "clean_flat_vector"
    assert _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [{"pass": True, "presence_pass": True, "title_present": True}],
        },
        state,
    ) == []


def test_validate_deck_plan_does_not_require_qc_for_chart_like_slide_images() -> None:
    plan = {
        "slides": [
            {
                "type": "cover",
                "title": "Launch",
                "image_path": "/mnt/user-data/outputs/slide-1.png",
                "visual_style": "clean_flat_vector",
            },
            {
                "type": "content",
                "title": "Benchmark chart",
                "subtype": "chart",
                "caption": "The benchmark trend is visible inside the baked slide image.",
                "image_path": "/mnt/user-data/outputs/slide-2.png",
                "visual_style": "clean_flat_vector",
            },
        ]
    }

    assert _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [{"pass": True, "presence_pass": True, "title_present": True}],
        },
    ) == []


def test_validate_deck_plan_excludes_deterministic_chart_refs_from_slide_qc() -> None:
    plan = {
        "slides": [
            {
                "type": "cover",
                "title": "Launch",
                "image_path": "/mnt/user-data/outputs/slide-1.png",
                "visual_style": "clean_flat_vector",
            },
            {
                "type": "content",
                "title": "Benchmark chart",
                "subtype": "chart",
                "caption": "Revenue is up and churn is down.",
                "image": "/mnt/user-data/outputs/visuals/benchmark-chart.png",
            },
        ]
    }

    assert _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [{"pass": True, "presence_pass": True, "title_present": True}],
        },
    ) == []


def test_deck_plan_validation_does_not_repair_missing_image_refs_from_unused_outputs() -> None:
    diagnostics = {
        "pptx_plan_json": {
            "slides": [
                {"type": "cover", "title": "Launch"},
                {"type": "content", "title": "Architecture"},
            ]
        },
        "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
        "image_output_paths": ["/mnt/user-data/outputs/visuals/architecture.png"],
    }
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation", "task": "Create a visual deck"},
        "builder_pptx_diagnostics": diagnostics,
    }

    problems = _deck_plan_validation_problems(state)

    assert problems == []
    assert diagnostics["pptx_plan_json"]["slides"][1].get("image_path") is None
    assert "builder_pptx_plan_deterministic_repair_attempted" not in state


def test_validate_deck_plan_treats_skipped_qc_as_unavailable() -> None:
    plan = {
        "slides": [
            {"type": "cover", "title": "Launch", "image_path": "/mnt/user-data/outputs/slide-1.png", "visual_style": "clean_flat_vector"},
        ]
    }

    problems = _validate_deck_plan(
        plan,
        {
            "pptx_slide_title_results": [{"slide": 1, "title_present": True}],
            "qc_results": [
                    {
                        "pass": False,
                        "skipped": True,
                        "presence_pass": True,
                        "title_present": True,
                        "caption_present": True,
                        "reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"],
                        "image_path": "/mnt/user-data/outputs/slide-1.png",
                    },
            ],
        },
    )

    assert problems == []


def test_validate_deck_plan_rejects_stat_slides_without_images() -> None:
    diagnostics = {"pptx_slide_title_results": [{"slide": 1, "title_present": True}]}

    for stat_slide in (
        {"type": "stat", "title": "Momentum", "stat": "87%", "label": "adoption"},
        {
            "type": "content",
            "subtype": "stat",
            "title": "Momentum",
            "value": "87%",
            "label": "adoption",
        },
    ):
        plan = {"slides": [{"type": "cover", "title": "Launch"}, stat_slide]}

        assert _validate_deck_plan(plan, diagnostics) == [
            "Slide 1 is missing its generated slide image.",
            "Slide 2 is missing its generated slide image.",
        ]


def test_validate_deck_plan_requires_images_for_compiler_alias_slides() -> None:
    diagnostics = {"pptx_slide_title_results": [{"slide": 1, "title_present": True}]}

    plan = {
        "slides": [
            {"type": "cover", "title": "Launch"},
            {"type": "quote", "title": "Customer voice", "quote": "Adoption is accelerating."},
            {"type": "divider", "title": "Architecture"},
            {"type": "conclusion", "title": "Takeaways", "bullets": ["Ship", "Measure"]},
        ]
    }

    assert _validate_deck_plan(plan, diagnostics) == [
        "Slide 1 is missing its generated slide image.",
        "Slide 2 is missing its generated slide image.",
        "Slide 3 is missing its generated slide image.",
        "Slide 4 is missing its generated slide image.",
    ]

    assert [_slide_type(slide) for slide in plan["slides"]] == [
        "cover",
        "statement",
        "section",
        "summary",
    ]


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
        "qc_results": [{"pass": False, "reasons": ["garbled"], "image_path": "/mnt/user-data/outputs/slide-01.png"}],
        "qc_reasons": ["garbled"],
    }


def test_slide_qc_bash_result_preserves_skipped_json_payload(tmp_path: Path) -> None:
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
        _tool_message(
            '{"pass": false, "skipped": true, "reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"]}\n'
            'Std Error:\n[qc] PASS=False reasons=["slide QC skipped: ANTHROPIC_API_KEY is not set"]'
        ),
    )

    assert delta == {
        "qc_invocation_count": 1,
        "qc_pass_count": 0,
        "qc_failure_count": 0,
        "qc_results": [
            {
                "pass": False,
                "reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"],
                "skipped": True,
                "image_path": "/mnt/user-data/outputs/slide-01.png",
            }
        ],
        "qc_reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"],
    }


def test_slide_qc_bash_result_pads_chained_skipped_qc_as_unavailable(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--spec-file /mnt/user-data/workspace/slide-01.txt "
                    "--image-file /mnt/user-data/outputs/slide-01.png && "
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--spec-file /mnt/user-data/workspace/slide-02.txt "
                    "--image-file /mnt/user-data/outputs/slide-02.png"
                )
            },
        },
    )
    reason = "slide QC skipped: ANTHROPIC_API_KEY is not set"

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message(
            f'{{"pass": false, "skipped": true, "reasons": ["{reason}"]}}\n'
            f'Std Error:\n[qc] PASS=False reasons=["{reason}"]'
        ),
    )

    assert delta == {
        "qc_invocation_count": 2,
        "qc_pass_count": 0,
        "qc_failure_count": 0,
        "qc_results": [
            {
                "pass": False,
                "reasons": [reason],
                "skipped": True,
                "image_path": "/mnt/user-data/outputs/slide-01.png",
            },
            {
                "pass": False,
                "reasons": [reason],
                "skipped": True,
                "image_path": "/mnt/user-data/outputs/slide-02.png",
            },
        ],
        "qc_reasons": [reason],
    }


def test_slide_qc_bash_result_marks_missing_verdict_as_advisory(tmp_path: Path) -> None:
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

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(request, _tool_message("totally invalid output"))

    assert delta == {
        "qc_invocation_count": 1,
        "qc_pass_count": 0,
        "qc_failure_count": 0,
        "qc_results": [
            {
                "pass": False,
                "reasons": ["QC subprocess did not emit a parseable verdict"],
                "advisory": True,
                "parser_error": True,
                "image_path": "/mnt/user-data/outputs/slide-01.png",
            }
        ],
        "qc_reasons": ["QC subprocess did not emit a parseable verdict"],
    }


def test_slide_qc_bash_result_maps_chained_invocations_to_their_images(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    request = SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs)}},
        tool_call={
            "name": "bash",
            "args": {
                "command": (
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--spec-file /mnt/user-data/workspace/slide-01.txt "
                    "--image-file /mnt/user-data/outputs/slide-01.png && "
                    "python /mnt/skills/public/image-generation/scripts/slide_qc.py "
                    "--spec-file /mnt/user-data/workspace/slide-02.txt "
                    "--image-file /mnt/user-data/outputs/slide-02.png"
                )
            },
        },
    )

    delta = BuilderArtifactMiddleware._pptx_bash_result_delta(
        request,
        _tool_message(
            "\n".join(
                [
                    '[qc] PASS=True reasons=[]',
                    '[qc] PASS=True reasons=[]',
                ]
            )
        ),
    )

    assert delta["qc_invocation_count"] == 2
    assert delta["qc_pass_count"] == 2
    assert delta["qc_failure_count"] == 0
    assert delta["qc_results"] == [
        {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-01.png"},
        {"pass": True, "reasons": [], "image_path": "/mnt/user-data/outputs/slide-02.png"},
    ]


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
    image_hash = _sha256_bytes(b"png-bytes")
    qc_result = {
        "pass": False,
        "reasons": ["garbled"],
        "image_path": "/mnt/user-data/outputs/slide-01.png",
        "image_hash": image_hash,
    }

    assert delta == {
        "image_generation_attempt_count": 1,
        "image_generation_success_count": 1,
        "image_generation_bytes_total": len(b"png-bytes"),
        "image_generation_error_class": None,
        "image_output_paths": ["/mnt/user-data/outputs/slide-01.png"],
        "image_output_records": [
            {
                "image_ref": "/mnt/user-data/outputs/slide-01.png",
                "image_basename": "slide-01.png",
                "image_hash": image_hash,
                "slide_index": 1,
            }
        ],
        "qc_invocation_count": 1,
        "qc_pass_count": 0,
        "qc_failure_count": 1,
        "qc_results": [qc_result],
        "qc_image_records": [
            {
                "image_ref": "/mnt/user-data/outputs/slide-01.png",
                "image_basename": "slide-01.png",
                "image_hash": image_hash,
                "slide_index": 1,
                "qc_result": qc_result,
            }
        ],
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


def test_invalid_plan_json_no_longer_injects_plan_correction(tmp_path: Path) -> None:
    # Phase 0 §2.6: the retired slide-plan-JSON correction is deleted — there is
    # no plan JSON in the HTML-slide deck flow. A stale ``invalid_plan_json``
    # diagnostic must NOT inject the old "re-emit plan JSON / run the PPT generator"
    # directive (the steering that deadlocked prod decks on 2026-06-27).
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

    # No plan-correction is injected for this state (no drift, no images ready).
    if result is not None:
        content = result["messages"][0].content if result.get("messages") else ""
        assert "presentation-plan correction" not in content
        assert "--plan-file" not in content
        assert "image_path" not in content
        assert "builder_pptx_plan_correction_emitted" not in result


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
    assert "builder_visual_force_count" not in state
    state["builder_visual_force_count"] = 1
    assert middleware._visual_tool_choice_for_state(state) == {"type": "tool", "name": "read_file"}
    assert state["builder_visual_force_count"] == 1
    state["builder_visual_force_count"] = 2
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
    assert "builder_visual_force_count" not in state


def test_visual_skill_force_count_persists_from_wrap_model_call_update() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
    }
    captured = {}
    request = SimpleNamespace(
        state=state,
        runtime=None,
        model=object(),
    )

    def _override(**kwargs):
        captured["tool_choice"] = kwargs["tool_choice"]
        return SimpleNamespace(state=state, runtime=None, model=object())

    request.override = _override

    result = middleware.wrap_model_call(request, lambda _request: AIMessage(content="reading"))

    assert isinstance(result, Command)
    assert captured["tool_choice"] == {"type": "tool", "name": "read_file"}
    assert result.update["builder_visual_force_count"] == 1
    assert result.update["messages"][0].content == "reading"
    assert "builder_visual_force_count" not in state


def test_visual_skill_force_count_persists_for_model_response() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
    }
    request = SimpleNamespace(
        state=state,
        runtime=None,
        model=object(),
    )
    request.override = lambda **_kwargs: request
    model_response = ModelResponse(result=[AIMessage(content="reading")])

    result = middleware.wrap_model_call(request, lambda _request: model_response)

    assert isinstance(result, ExtendedModelResponse)
    assert result.model_response is model_response
    assert result.command is not None
    assert result.command.update["builder_visual_force_count"] == 1


def test_visual_skill_force_count_merges_existing_extended_model_response_command() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
    }
    request = SimpleNamespace(
        state=state,
        runtime=None,
        model=object(),
    )
    request.override = lambda **_kwargs: request
    model_response = ModelResponse(result=[AIMessage(content="reading")])
    extended = ExtendedModelResponse(
        model_response=model_response,
        command=Command(update={"existing": True}),
    )

    result = middleware.wrap_model_call(request, lambda _request: extended)

    assert isinstance(result, ExtendedModelResponse)
    assert result.model_response is model_response
    assert result.command is not None
    assert result.command.update["existing"] is True
    assert result.command.update["builder_visual_force_count"] == 1


def test_visual_skill_force_count_uses_persisted_state_to_stop_after_cap() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "delegation_context": {"task": "Create a visual presentation with diagrams"},
        "builder_visual_force_count": 2,
    }
    request = SimpleNamespace(
        state=state,
        runtime=None,
        model=object(),
        override=lambda **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected override")),
    )
    expected = AIMessage(content="fallback")

    result = middleware.wrap_model_call(request, lambda received: expected)

    assert result is expected


def test_ppt_generation_script_rejects_no_image_deck(tmp_path: Path) -> None:
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "title": "Image Deck",
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

    assert result.returncode == 1
    assert "Slide 1 is missing its generated slide image" in result.stderr
    assert not output.exists()


def test_ppt_generation_script_rejects_chart_path_as_slide_image(tmp_path: Path) -> None:
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

    assert result.returncode == 1
    assert "Slide 1 is missing its generated slide image" in result.stderr
    assert not output.exists()


def test_ppt_generation_script_rejects_missing_slide_image(tmp_path: Path) -> None:
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
    assert "Slide 1 image not found:" in result.stderr
    assert not output.exists()
