from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import ToolMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.builder_tools import (
    assert_deck_tool_contract,
    build_builder_tools_for_task_type,
    deck_build_service_enabled,
)
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.sandbox.tools import replace_virtual_path
from deerflow.sophia.deck_build import service as deck_service
from deerflow.sophia.deck_build.service import DeckBuildService
from deerflow.sophia.deck_build.storage import load_deck_build
from deerflow.sophia.tools.prepare_deck_build import prepare_deck_build

_OUTPUTS = "/mnt/user-data/outputs/"


def _runtime(outputs: Path, *, user_request: str = "Build a visual 3 slide deck") -> SimpleNamespace:
    outputs.mkdir(parents=True, exist_ok=True)
    workspace = outputs.parent / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(
        state={
            "thread_id": "builder-thread",
            "parent_thread_id": "companion-thread",
            "user_id": "user-1",
            "task_id": "task-1",
            "builder_pptx_requested_slide_count": 3,
            "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "delegation_context": {"request": user_request},
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(workspace),
            },
        },
        context={"thread_id": "builder-thread"},
        config={},
    )


def _slides(count: int = 3) -> list[dict]:
    roles = ["cover", "architecture", "closing"]
    layouts = ["cover_hero", "single_visual_focus", "closing_summary"]
    return [
        {
            "title": f"Slide {index} System Story",
            "narrative": "A concise technical narrative explains the point with calm professional framing.",
            "role": roles[index - 1],
            "layout_kind": layouts[index - 1],
            "visual_prompt": f"Professional technical visual metaphor for slide {index}",
            "speaker_notes": "Optional notes.",
        }
        for index in range(1, count + 1)
    ]


def _fake_compiler(calls: list[dict]):
    def compile_deck(runtime, output_path: str, title: str, slides_dir: str) -> dict:
        calls.append({"output_path": output_path, "title": title, "slides_dir": slides_dir})
        host = Path(replace_virtual_path(output_path, runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"fake pptx")
        slide_count = len(list((host.parent / "slides").glob("*.html")))
        return {
            "success": True,
            "pptx_path": output_path,
            "size_bytes": host.stat().st_size,
            "engine": "fake",
            "slide_count": slide_count,
            "overflow_slides": [],
        }

    return compile_deck


def _fake_batch(runtime: SimpleNamespace, *, create_outputs: bool = True, complete: bool = True):
    def run_batch(manifest_path: str, tool_runtime) -> dict:
        manifest_host = Path(replace_virtual_path(manifest_path, tool_runtime.state["thread_data"]))
        manifest = json.loads(manifest_host.read_text(encoding="utf-8"))
        items = []
        for item in manifest["items"]:
            output_file = item["output_file"]
            if create_outputs:
                host = Path(replace_virtual_path(output_file, tool_runtime.state["thread_data"]))
                host.parent.mkdir(parents=True, exist_ok=True)
                host.write_bytes(b"png")
            items.append({"output_file": output_file, "success": create_outputs, "error_class": None if create_outputs else "api_error"})
        return {
            "summary_present": True,
            "complete": complete and create_outputs,
            "requested": len(items),
            "images_generated": len(items) if create_outputs else 0,
            "failed": 0 if create_outputs else len(items),
            "items": items,
            "error_class_histogram": {},
        }

    return run_batch


def test_deck_build_service_required_deck_writes_manifest_html_pptx_and_build_json(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    compiler_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        deck_compiler=_fake_compiler(compiler_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is True
    assert result.pptx_path == f"{_OUTPUTS}deck.pptx"
    assert result.expected_visual_count == 3
    assert result.successful_visual_count == 3
    assert result.referenced_visual_count == 3
    assert compiler_calls == [{"output_path": f"{_OUTPUTS}deck.pptx", "title": "Technical Deck", "slides_dir": f"{_OUTPUTS}slides"}]
    outputs = tmp_path / "outputs"
    prompt_files = sorted((outputs / "assets" / "prompts").glob("slide-*.json"))
    assert len(prompt_files) == 3
    prompt_payload = json.loads(prompt_files[0].read_text(encoding="utf-8"))
    assert prompt_payload["style"]["visual_style"] == "clean_flat_vector"
    assert prompt_payload["style"]["aesthetic"] == "restrained_professional_technical"
    assert "clean flat vector" in prompt_payload["constraints"][-1]
    assert "handwritten" not in json.dumps(prompt_payload).lower()
    manifest = json.loads((outputs / "assets" / "slide-visuals.manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_author"] == "DeckBuildService"
    assert len(manifest["items"]) == 3
    assert len(list((outputs / "slides").glob("*.html"))) == 3
    build = json.loads((outputs / "deck_build" / "build.json").read_text(encoding="utf-8"))
    assert build["schema_version"] == "sophia-deck-build/v1"
    assert build["status"] == "evaluated"
    assert "Professional technical visual metaphor" in build["slides"][0]["visual_prompt"]
    loaded = load_deck_build(result.deck_build_path, runtime)
    assert loaded is not None
    assert loaded.build_id == result.build_id
    assert loaded.slides[0].selector == "slide:1"


def test_deck_build_service_clears_stale_slide_html_before_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    slides_dir = tmp_path / "outputs" / "slides"
    slides_dir.mkdir(parents=True)
    (slides_dir / "99-stale.html").write_text("<html>stale</html>", encoding="utf-8")
    compiled_slide_names: list[list[str]] = []

    def compile_deck(tool_runtime, output_path: str, _title: str, rendered_slides_dir: str) -> dict:
        host_slides = Path(replace_virtual_path(rendered_slides_dir, tool_runtime.state["thread_data"]))
        compiled_slide_names.append(sorted(path.name for path in host_slides.glob("*.html")))
        host = Path(replace_virtual_path(output_path, tool_runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"fake pptx")
        return {
            "success": True,
            "pptx_path": output_path,
            "size_bytes": host.stat().st_size,
            "engine": "fake",
            "overflow_slides": [],
        }

    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        deck_compiler=compile_deck,
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is True
    assert "99-stale.html" not in compiled_slide_names[0]
    assert compiled_slide_names[0] == ["01-cover.html", "02-architecture.html", "03-closing.html"]


def test_deck_build_service_nested_output_path_evaluates_against_outputs_root(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        deck_compiler=_fake_compiler([]),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Nested Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}decks/foo.pptx",
    )

    assert result.success is True
    assert result.pptx_path == f"{_OUTPUTS}decks/foo.pptx"
    assert (tmp_path / "outputs" / "slides" / "01-cover.html").is_file()
    assert (tmp_path / "outputs" / "decks" / "foo.pptx").is_file()


def test_deck_build_service_compiler_overflow_fails_quality_gate(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")

    def overflow_compiler(tool_runtime, output_path: str, _title: str, _slides_dir: str) -> dict:
        host = Path(replace_virtual_path(output_path, tool_runtime.state["thread_data"]))
        host.parent.mkdir(parents=True, exist_ok=True)
        host.write_bytes(b"fake pptx")
        return {
            "success": True,
            "pptx_path": output_path,
            "size_bytes": host.stat().st_size,
            "engine": "fake",
            "overflow_slides": [{"slide": 2, "overflow_px": 48}],
        }

    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        deck_compiler=overflow_compiler,
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Overflow Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.failure_code == "deck_quality_failed"
    assert "overflows" in (result.failure_summary or "")


def test_deck_build_service_invalid_required_visual_prompt_fails_before_batch(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    batch_called = False

    def batch_runner(_manifest_path, _runtime):
        nonlocal batch_called
        batch_called = True
        return {}

    service = DeckBuildService(image_batch_runner=batch_runner, deck_compiler=_fake_compiler([]))
    slides = _slides()
    slides[1]["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.failure_code == "invalid_deck_ir"
    assert batch_called is False
    assert not (tmp_path / "outputs" / "deck.pptx").exists()


def test_deck_build_service_allows_negated_visual_prompt_guardrails(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        deck_compiler=_fake_compiler([]),
    )
    slides = _slides()
    slides[0]["visual_prompt"] = "Professional system visual, no axis labels, without formulas, not neon."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is True


def test_deck_build_service_rejects_positive_banned_visual_prompt_terms(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    batch_called = False

    def batch_runner(_manifest_path, _runtime):
        nonlocal batch_called
        batch_called = True
        return {}

    service = DeckBuildService(image_batch_runner=batch_runner, deck_compiler=_fake_compiler([]))
    slides = _slides()
    slides[0]["visual_prompt"] = "Neon system diagram with axis labels and formula callouts."

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.failure_code == "invalid_deck_ir"
    assert batch_called is False


def test_deck_build_service_missing_batch_summary_fails_without_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    compiler_calls: list[dict] = []

    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: {"summary_present": False, "complete": False},
        deck_compiler=_fake_compiler(compiler_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.failure_code == "deck_visual_batch_startup_failed"
    assert compiler_calls == []
    assert not (tmp_path / "outputs" / "slides").exists()


def test_deck_image_batch_timeout_scales_by_manifest_count_and_concurrency(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    manifest_host = tmp_path / "outputs" / "assets" / "slide-visuals.manifest.json"
    manifest_host.parent.mkdir(parents=True)
    manifest_host.write_text(
        json.dumps({"items": [{"output_file": f"{_OUTPUTS}assets/slide-{index:02d}.png"} for index in range(1, 31)]}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOPHIA_IMAGE_GEN_TIMEOUT", "240")
    monkeypatch.setenv("SOPHIA_IMAGE_GEN_CONCURRENCY", "2")
    monkeypatch.delenv("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT", raising=False)

    timeout = deck_service._deck_image_batch_timeout_seconds(f"{_OUTPUTS}assets/slide-visuals.manifest.json", runtime)

    assert timeout == 3630


def test_deck_image_batch_timeout_override_wins(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    monkeypatch.setenv("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT", "999")

    timeout = deck_service._deck_image_batch_timeout_seconds(f"{_OUTPUTS}missing.manifest.json", runtime)

    assert timeout == 999


def test_deck_image_batch_subprocess_timeout_is_structured(tmp_path: Path, monkeypatch) -> None:
    runtime = _runtime(tmp_path / "outputs")
    script = tmp_path / "generate.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    manifest_host = tmp_path / "outputs" / "assets" / "slide-visuals.manifest.json"
    manifest_host.parent.mkdir(parents=True)
    manifest_host.write_text(json.dumps({"items": [{"output_file": f"{_OUTPUTS}assets/slide-01.png"}]}), encoding="utf-8")
    monkeypatch.setattr(deck_service, "_image_script_path", lambda: script)

    def timeout_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd=["python"], timeout=10, output="partial stdout", stderr="provider hung")

    monkeypatch.setattr(deck_service.subprocess, "run", timeout_run)

    result = DeckBuildService()._run_image_batch_subprocess(f"{_OUTPUTS}assets/slide-visuals.manifest.json", runtime)

    assert result["summary_present"] is False
    assert result["complete"] is False
    assert result["exit_code"] == 124
    assert result["error_class"] == "timeout"
    assert "timed out" in result["raw_error_excerpt"]


def test_deck_build_service_incomplete_visuals_fail_before_compile(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    compiler_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime, create_outputs=False, complete=False),
        deck_compiler=_fake_compiler(compiler_calls),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.failure_code == "deck_visuals_incomplete"
    assert result.successful_visual_count == 0
    assert result.missing_visual_count == 3
    assert compiler_calls == []


def test_deck_build_service_text_only_requires_explicit_request_and_compiles_without_visuals(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs", user_request="Please build a plain text-only 3 slide deck with no visuals.")
    compiler_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: (_ for _ in ()).throw(AssertionError("no image batch")),
        deck_compiler=_fake_compiler(compiler_calls),
    )
    slides = _slides()
    for slide in slides:
        slide["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Text Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        visual_policy="text_only",
    )

    assert result.success is True
    assert result.expected_visual_count == 0
    assert result.successful_visual_count == 0
    assert compiler_calls
    assert not (tmp_path / "outputs" / "assets" / "prompts").exists()


def test_deck_build_service_text_only_accepts_delegated_task_brief(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs", user_request="")
    runtime.state["delegation_context"] = {"task": "Build a plain text-only deck with no images for the review."}
    compiler_calls: list[dict] = []
    service = DeckBuildService(
        image_batch_runner=lambda _manifest_path, _runtime: (_ for _ in ()).throw(AssertionError("no image batch")),
        deck_compiler=_fake_compiler(compiler_calls),
    )
    slides = _slides()
    for slide in slides:
        slide["visual_prompt"] = ""

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Text Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        visual_policy="text_only",
    )

    assert result.success is True
    assert compiler_calls
    assert not (tmp_path / "outputs" / "assets" / "prompts").exists()


def test_prepare_deck_build_tool_schema_excludes_runtime() -> None:
    schema = prepare_deck_build.tool_call_schema.model_json_schema()

    properties = schema.get("properties", {})
    assert "runtime" not in properties
    assert {"deck_title", "slides", "output_path", "register", "visual_policy"}.issubset(properties)


def test_presentation_toolset_uses_prepare_deck_build_by_default(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)

    names = [getattr(tool, "name", "") for tool in build_builder_tools_for_task_type("presentation", vision_enabled=False)]

    assert deck_build_service_enabled() is True
    assert "prepare_deck_build" in names
    assert "prepare_pptx_image_manifest" not in names
    assert "build_deck_from_slides" not in names


def test_presentation_toolset_uses_legacy_only_when_explicitly_disabled(monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")

    tools = build_builder_tools_for_task_type("presentation", vision_enabled=False)
    names = [getattr(tool, "name", "") for tool in tools]
    contract = assert_deck_tool_contract(tools, task_type="presentation", artifact_target_ext=".pptx")

    assert deck_build_service_enabled() is False
    assert contract is not None
    assert contract["route"] == "legacy_html_slide_to_pptx"
    assert "prepare_deck_build" not in names
    assert "prepare_pptx_image_manifest" in names
    assert "build_deck_from_slides" in names


def test_prepare_deck_build_failure_is_terminal_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    runtime = _runtime(tmp_path / "outputs")
    request = SimpleNamespace(
        tool_call={"id": "tc-deck", "name": "prepare_deck_build", "args": {}},
        state=runtime.state,
        runtime=runtime,
    )
    payload = {
        "success": False,
        "build_id": "deck-1",
        "deck_build_path": f"{_OUTPUTS}deck_build/build.json",
        "failure_code": "deck_visual_batch_startup_failed",
        "failure_summary": "Image batch did not emit IMAGEGEN_BATCH.",
        "retryable": False,
        "slide_count": 3,
        "expected_visual_count": 3,
        "successful_visual_count": 0,
        "referenced_visual_count": 0,
        "missing_visual_count": 3,
        "quality_status": "failed",
    }
    result = ToolMessage(content=json.dumps(payload), tool_call_id="tc-deck", name="prepare_deck_build")
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)

    command = BuilderArtifactMiddleware()._prepare_deck_build_result_command(request, result)

    assert isinstance(command, Command)
    assert command.goto == "end"
    assert command.update["builder_result"]["artifact_path"] is None
    assert command.update["builder_result"]["failure_code"] == "deck_visual_batch_startup_failed"
    diagnostics = command.update["builder_pptx_diagnostics"]
    assert diagnostics["deck_build_id"] == "deck-1"
    assert diagnostics["missing_expected_visual_count"] == 3
