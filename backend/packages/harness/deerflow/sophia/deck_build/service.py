from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess  # noqa: S404 - fixed Python script path with sanitized args.
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from langchain.tools import ToolRuntime

from deerflow.sandbox.tools import get_thread_data, replace_virtual_path
from deerflow.sophia.deck_build.evaluator import DeckEvaluator
from deerflow.sophia.deck_build.models import DeckBuild, DeckBuildResult, DeckSlideSpec
from deerflow.sophia.deck_build.storage import save_deck_build
from deerflow.sophia.deck_build.templates import slide_html_virtual_path, write_slide_html
from deerflow.sophia.deck_build.tracing import basename, deck_span, finish_span, safe_excerpt
from deerflow.sophia.tools.build_deck_from_slides import build_deck_from_slides
from deerflow.sophia.tools.prepare_pptx_image_manifest import create_pptx_image_manifest_core
from deerflow.sophia.tools.render_markdown_to_pdf import _ensure_relative_to_outputs

_OUTPUTS = "/mnt/user-data/outputs/"
_ASSETS = f"{_OUTPUTS}assets"
_PROMPTS = f"{_ASSETS}/prompts"
_MANIFEST = f"{_ASSETS}/slide-visuals.manifest.json"
_SCHEMA = "sophia-deck-build/v1"
_BANNED_STYLE_RE = re.compile(r"\b(chalkboard|blackboard|whiteboard|handwritten|sketch|cyberpunk|neon)\b", re.I)
_BANNED_TEXT_RE = re.compile(r"THE TEXT READS|title reads|large readable text|paragraph text|axis labels?|formula", re.I)
_TEXT_ONLY_REQUEST_RE = re.compile(
    r"\b(?:plain\s+text[-\s]?only|text[-\s]?only|no[-\s]?image|no\s+images?"
    r"|no\s+visuals?|without\s+(?:images?|visuals?)|with\s+no\s+(?:images?|visuals?))\b",
    re.I,
)


DeckCompiler = Callable[[ToolRuntime, str, str, str], dict[str, Any]]


class DeckBuildService:
    def __init__(
        self,
        *,
        image_batch_runner: Callable[[str, ToolRuntime], dict[str, Any]] | None = None,
        deck_compiler: DeckCompiler | None = None,
        evaluator: DeckEvaluator | None = None,
    ) -> None:
        self._image_batch_runner = image_batch_runner or self._run_image_batch_subprocess
        self._deck_compiler = deck_compiler or _compile_with_build_deck_from_slides
        self._evaluator = evaluator or DeckEvaluator()

    def prepare_and_build(
        self,
        *,
        runtime: ToolRuntime,
        deck_title: str,
        slides: list[dict[str, Any]],
        output_path: str,
        register: str = "professional_technical",
        visual_policy: str = "required",
        style_profile: dict[str, Any] | None = None,
    ) -> DeckBuildResult:
        build_id = f"deck-{uuid.uuid4().hex[:12]}"
        now = _now()
        deck = DeckBuild(
            build_id=build_id,
            schema_version=_SCHEMA,
            user_id=_state_value(runtime, "user_id"),
            thread_id=str(_state_value(runtime, "thread_id") or ""),
            parent_thread_id=_state_value(runtime, "parent_thread_id"),
            run_id=_state_value(runtime, "run_id"),
            task_id=_state_value(runtime, "task_id"),
            requested_slide_count=len(slides),
            status="planned",
            register=register,
            visual_policy=visual_policy,
            style_profile=style_profile or {},
            deck_title=deck_title,
            output_path=output_path,
            slides=[],
            expected_visual_count=len(slides) if visual_policy == "required" else 0,
            created_at=now,
            updated_at=now,
        )
        try:
            self._validate_inputs(deck, slides, output_path, runtime)
            deck.slides = self._build_slide_specs(slides, visual_policy=visual_policy)
            with deck_span(
                "deck.ir.validate",
                runtime=runtime,
                build_id=build_id,
                visual_policy=visual_policy,
                status=deck.status,
                slide_count=len(slides),
                inputs={
                    "slide_count": len(slides),
                    "register": register,
                    "visual_policy": visual_policy,
                    "layout_kinds": [slide.layout_kind for slide in deck.slides],
                    "slide_roles": [slide.role for slide in deck.slides],
                },
            ) as run:
                finish_span(run, {"valid": True, "failure_code": None, "issue_count": 0, "hard_issue_count": 0})
            if visual_policy == "required":
                self._write_prompt_files(deck, runtime)
                self._prepare_manifest(deck, runtime)
                summary = self._run_visual_batch(deck, runtime)
                self._apply_batch_summary(deck, runtime, summary)
                self._verify_visuals(deck, runtime)
            else:
                for slide in deck.slides:
                    slide.visual_required = False
                    slide.visual_status = "skipped"
            self._render_slide_html(deck, runtime)
            self._compile_pptx(deck, runtime)
            self._evaluate(deck, runtime)
            deck.status = "evaluated"
            deck.updated_at = _now()
            deck_path = save_deck_build(deck, runtime)
            return self._success_result(deck, deck_path, runtime)
        except DeckBuildFailure as exc:
            deck.status = "failed_terminal"
            deck.failure_code = exc.code
            deck.failure_summary = exc.summary
            deck.updated_at = _now()
            deck_path = save_deck_build(deck, runtime)
            self._trace_terminal(deck, runtime, success=False, deck_path=deck_path, retryable=exc.retryable)
            return self._failure_result(deck, deck_path, exc, runtime)

    def _validate_inputs(self, deck: DeckBuild, slides: list[dict[str, Any]], output_path: str, runtime: ToolRuntime) -> None:
        if not 1 <= len(slides) <= 30:
            raise DeckBuildFailure("invalid_deck_ir", "Deck slide count must be between 1 and 30.", retryable=True)
        requested_slide_count = _requested_slide_count_from_state(runtime)
        if requested_slide_count and requested_slide_count != len(slides):
            raise DeckBuildFailure(
                "invalid_deck_ir",
                f"Deck IR has {len(slides)} slides, but the request targeted {requested_slide_count}.",
                retryable=True,
            )
        path_error = _ensure_relative_to_outputs("output_path", output_path)
        if path_error or not output_path.lower().endswith(".pptx"):
            raise DeckBuildFailure("invalid_deck_ir", path_error or "output_path must end with .pptx", retryable=True)
        if deck.visual_policy not in {"required", "text_only"}:
            raise DeckBuildFailure("invalid_deck_ir", "visual_policy must be required or text_only.", retryable=True)
        if deck.visual_policy == "text_only" and not _explicit_text_only_requested(runtime):
            raise DeckBuildFailure(
                "invalid_deck_ir",
                "visual_policy='text_only' requires an explicit plain/text-only/no-visual request.",
                retryable=True,
            )

    def _build_slide_specs(self, slides: list[dict[str, Any]], *, visual_policy: str) -> list[DeckSlideSpec]:
        specs: list[DeckSlideSpec] = []
        for index, raw in enumerate(slides, start=1):
            title = _clean_text(raw.get("title"))
            narrative = _clean_text(raw.get("narrative"))
            visual_prompt = _clean_text(raw.get("visual_prompt")) or None
            if not title or len(title) > 90:
                raise DeckBuildFailure("invalid_deck_ir", f"Slide {index} title is required and must be <= 90 chars.", retryable=True)
            if not narrative or len(narrative) > 280:
                raise DeckBuildFailure("invalid_deck_ir", f"Slide {index} narrative is required and must be <= 280 chars.", retryable=True)
            if visual_policy == "required":
                if not visual_prompt:
                    raise DeckBuildFailure("invalid_deck_ir", f"Slide {index} requires a visual_prompt.", retryable=True)
                if _BANNED_TEXT_RE.search(visual_prompt) or _BANNED_STYLE_RE.search(visual_prompt):
                    raise DeckBuildFailure(
                        "invalid_deck_ir",
                        f"Slide {index} visual_prompt requests image-baked text or an unrequested style.",
                        retryable=True,
                    )
            specs.append(
                DeckSlideSpec(
                    selector=f"slide:{index}",
                    index=index,
                    role=_clean_text(raw.get("role")) or ("cover" if index == 1 else "context"),
                    layout_kind=_clean_text(raw.get("layout_kind")) or ("cover_hero" if index == 1 else "single_visual_focus"),
                    title=title,
                    narrative=narrative,
                    visual_prompt=visual_prompt,
                    speaker_notes=_clean_text(raw.get("speaker_notes")) or None,
                    visual_required=visual_policy == "required",
                )
            )
        return specs

    def _write_prompt_files(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        with deck_span(
            "deck.prompt_files.write",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={"slide_count": len(deck.slides), "output_dir": "assets/prompts"},
        ) as run:
            basenames: list[str] = []
            hashes: list[str] = []
            for slide in deck.slides:
                prompt_path = f"{_PROMPTS}/slide-{slide.index:02d}.json"
                host = _host_path(prompt_path, runtime)
                host.parent.mkdir(parents=True, exist_ok=True)
                payload = {
                    "prompt": slide.visual_prompt,
                    "style": deck.style_profile or {"register": deck.register},
                    "composition": _composition_for_layout(slide.layout_kind),
                    "constraints": [
                        "No slide title, no narrative paragraph, no footer, no page chrome.",
                        "Avoid large readable text inside the image.",
                        "Use restrained professional technical aesthetic unless the user requested another register.",
                    ],
                    "technical": {"aspect_ratio": "16:9", "quality": "high", "slide_visual": True},
                }
                encoded = json.dumps(payload, indent=2)
                host.write_text(encoded, encoding="utf-8")
                slide.visual_prompt_path = prompt_path
                basenames.append(host.name)
                hashes.append(hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16])
            deck.status = "visual_specs_ready"
            finish_span(run, {"prompt_count": len(basenames), "prompt_basenames": basenames, "prompt_hashes": hashes})

    def _prepare_manifest(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        prompt_files = [slide.visual_prompt_path or "" for slide in deck.slides]
        with deck_span(
            "deck.image_manifest.prepare",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={"prompt_count": len(prompt_files), "manifest_file": basename(_MANIFEST)},
        ) as run:
            result = create_pptx_image_manifest_core(
                thread_data=get_thread_data(runtime),
                prompt_files=prompt_files,
                manifest_path=_MANIFEST,
                manifest_author="DeckBuildService",
                trace=False,
            )
            finish_span(
                run,
                {
                    "success": bool(result.get("success")),
                    "manifest_author": "DeckBuildService",
                    "item_count": result.get("expected_count", 0),
                    "output_basenames": [basename(item.get("output_path")) for item in result.get("items", [])],
                    "schema_version": result.get("schema_version"),
                },
            )
            if not result.get("success"):
                raise DeckBuildFailure(str(result.get("error_type") or "invalid_deck_ir"), str(result.get("error") or "manifest failed"), retryable=True)
            for slide, item in zip(deck.slides, result.get("items", []), strict=True):
                slide.visual_asset_path = item.get("output_path")

    def _run_visual_batch(self, deck: DeckBuild, runtime: ToolRuntime) -> dict[str, Any]:
        deck.status = "visual_batch_running"
        started = time.perf_counter()
        with deck_span(
            "deck.image_batch.run",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={
                "requested": deck.expected_visual_count,
                "concurrency": os.getenv("SOPHIA_IMAGE_GEN_CONCURRENCY", "2"),
                "sdk_timeout_seconds": os.getenv("SOPHIA_IMAGE_GEN_TIMEOUT", "240"),
                "sdk_max_retries": os.getenv("SOPHIA_IMAGE_GEN_MAX_RETRIES", "1"),
                "manifest_file": basename(_MANIFEST),
            },
        ) as run:
            summary = self._image_batch_runner(_MANIFEST, runtime)
            summary.setdefault("duration_ms", int((time.perf_counter() - started) * 1000))
            finish_span(run, _safe_batch_summary(summary))
            if not summary.get("summary_present", True):
                raise DeckBuildFailure("deck_visual_batch_startup_failed", "Image batch did not emit IMAGEGEN_BATCH.", retryable=False)
            if not summary.get("complete"):
                if summary.get("requested") is None:
                    summary["requested"] = deck.expected_visual_count
                return summary
            return summary

    def _apply_batch_summary(self, deck: DeckBuild, runtime: ToolRuntime, summary: dict[str, Any]) -> None:
        items = summary.get("items") if isinstance(summary.get("items"), list) else []
        by_output = {str(item.get("output_file")): item for item in items if isinstance(item, dict)}
        for slide in deck.slides:
            item = by_output.get(str(slide.visual_asset_path or ""))
            if item and item.get("success"):
                slide.visual_status = "generated"
            else:
                slide.visual_status = "failed"
                slide.visual_error_class = str((item or {}).get("error_class") or summary.get("error_class") or "image_generation_failed")
            with deck_span(
                "deck.image_batch.item",
                runtime=runtime,
                build_id=deck.build_id,
                visual_policy=deck.visual_policy,
                status=deck.status,
                slide_count=len(deck.slides),
                run_type="tool",
                inputs={
                    "item_index": slide.index,
                    "selector": slide.selector,
                    "prompt_file": basename(slide.visual_prompt_path),
                    "prompt_hash": _file_hash(_host_path(slide.visual_prompt_path or "", runtime)),
                    "output_file": basename(slide.visual_asset_path),
                    "slide_visual": True,
                },
            ) as run:
                finish_span(
                    run,
                    {
                        "success": slide.visual_status == "generated",
                        "error_class": slide.visual_error_class,
                        "output_bytes": _file_size(_host_path(slide.visual_asset_path or "", runtime)),
                    },
                )

    def _verify_visuals(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        successful = 0
        missing = 0
        for slide in deck.slides:
            exists = bool(slide.visual_asset_path and _host_path(slide.visual_asset_path, runtime).is_file())
            if slide.visual_status == "generated" and exists:
                successful += 1
            else:
                missing += 1
        deck.successful_visual_count = successful
        deck.missing_visual_count = missing
        with deck_span(
            "deck.visuals.verify",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            inputs={},
        ) as run:
            complete = deck.expected_visual_count == successful and missing == 0
            finish_span(
                run,
                {
                    "visual_policy": deck.visual_policy,
                    "expected_visual_count": deck.expected_visual_count,
                    "successful_visual_count": successful,
                    "referenced_visual_count": deck.referenced_visual_count,
                    "missing_visual_count": missing,
                    "complete": complete,
                },
            )
        if deck.expected_visual_count != successful or missing:
            raise DeckBuildFailure("deck_visuals_incomplete", "Required slide visuals are incomplete.", retryable=False)
        deck.status = "visuals_complete"

    def _render_slide_html(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        with deck_span(
            "deck.slide_html.render",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={"slide_count": len(deck.slides), "template_names": [slide.layout_kind for slide in deck.slides]},
        ) as run:
            for slide in deck.slides:
                virtual = slide_html_virtual_path(slide)
                host = _host_path(virtual, runtime)
                write_slide_html(slide, deck, host)
                slide.html_source_path = virtual
                slide.gate_results["chrome_detected"] = False
            deck.referenced_visual_count = deck.expected_visual_count if deck.visual_policy == "required" else 0
            deck.status = "slides_rendered"
            finish_span(
                run,
                {
                    "html_source_count": len(deck.slides),
                    "html_basenames": [basename(slide.html_source_path) for slide in deck.slides],
                    "selectors": [slide.selector for slide in deck.slides],
                },
            )

    def _compile_pptx(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        with deck_span(
            "deck.pptx.compile",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={"slide_count": len(deck.slides), "output_file": basename(deck.output_path)},
        ) as run:
            result = self._deck_compiler(
                runtime,
                deck.output_path,
                deck.deck_title,
                "/mnt/user-data/outputs/slides",
            )
            finish_span(
                run,
                {
                    "success": bool(result.get("success")),
                    "pptx_path": result.get("pptx_path"),
                    "size_bytes": result.get("size_bytes"),
                    "engine": result.get("engine"),
                    "overflow_slide_count": len(result.get("overflow_slides") or []),
                },
            )
            if not result.get("success"):
                raise DeckBuildFailure(str(result.get("error_type") or "deck_compile_failed"), str(result.get("error") or "PPTX compile failed."), retryable=False)
            deck.pptx_path = result.get("pptx_path")
            deck.compile_overflow_slides = [entry for entry in (result.get("overflow_slides") or []) if isinstance(entry, dict)]
            deck.status = "compiled"

    def _evaluate(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        output_host = _host_path(deck.output_path, runtime)
        with deck_span(
            "deck.evaluate",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            inputs={},
        ) as run:
            evaluation = self._evaluator.evaluate(deck, output_host_path=output_host)
            finish_span(
                run,
                {
                    "passed": evaluation.passed,
                    "hard_failure_count": len(evaluation.hard_failures),
                    "soft_warning_count": len(evaluation.soft_warnings),
                    "checks": list({issue.check for issue in [*evaluation.hard_failures, *evaluation.soft_warnings]}),
                    "quality_warning": evaluation.quality_warning,
                },
            )
        if not evaluation.passed:
            raise DeckBuildFailure(
                "deck_quality_failed",
                "; ".join(issue.detail for issue in evaluation.hard_failures[:3]) or "Deck quality gate failed.",
                retryable=False,
            )
        deck.quality_warning = evaluation.quality_warning

    def _trace_terminal(self, deck: DeckBuild, runtime: ToolRuntime, *, success: bool, deck_path: str, retryable: bool) -> None:
        with deck_span(
            "deck.terminal",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            inputs={},
        ) as run:
            finish_span(
                run,
                {
                    "terminal": True,
                    "status": "success" if success else "failed",
                    "failure_code": deck.failure_code,
                    "retryable": retryable,
                    "artifact_path": deck.pptx_path if success else None,
                    "deck_build_path": deck_path,
                },
            )

    def _trace_emit_decision(self, deck: DeckBuild, runtime: ToolRuntime, *, success: bool, retryable: bool) -> None:
        with deck_span(
            "deck.emit.decision",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            inputs={},
        ) as run:
            finish_span(
                run,
                {
                    "emit_allowed": success,
                    "artifact_path": deck.pptx_path if success else None,
                    "failure_code": deck.failure_code,
                    "failure_summary": safe_excerpt(deck.failure_summary),
                    "retryable": retryable,
                    "expected_visual_count": deck.expected_visual_count,
                    "successful_visual_count": deck.successful_visual_count,
                    "referenced_visual_count": deck.referenced_visual_count,
                    "missing_visual_count": deck.missing_visual_count,
                    "quality_warning": deck.quality_warning,
                },
            )

    def _success_result(self, deck: DeckBuild, deck_path: str, runtime: ToolRuntime) -> DeckBuildResult:
        self._trace_terminal(deck, runtime, success=True, deck_path=deck_path, retryable=False)
        self._trace_emit_decision(deck, runtime, success=True, retryable=False)
        return DeckBuildResult(
            success=True,
            build_id=deck.build_id,
            deck_build_path=deck_path,
            pptx_path=deck.pptx_path,
            slide_count=len(deck.slides),
            expected_visual_count=deck.expected_visual_count,
            successful_visual_count=deck.successful_visual_count,
            referenced_visual_count=deck.referenced_visual_count,
            missing_visual_count=deck.missing_visual_count,
            quality_status="warning" if deck.quality_warning else "passed",
            quality_warning=deck.quality_warning,
            warnings=[deck.quality_warning] if deck.quality_warning else [],
        )

    def _failure_result(
        self,
        deck: DeckBuild,
        deck_path: str,
        exc: "DeckBuildFailure",
        runtime: ToolRuntime,
    ) -> DeckBuildResult:
        self._trace_emit_decision(deck, runtime, success=False, retryable=exc.retryable)
        return DeckBuildResult(
            success=False,
            build_id=deck.build_id,
            deck_build_path=deck_path,
            slide_count=len(deck.slides),
            expected_visual_count=deck.expected_visual_count,
            successful_visual_count=deck.successful_visual_count,
            referenced_visual_count=deck.referenced_visual_count,
            missing_visual_count=deck.missing_visual_count,
            failure_code=exc.code,
            failure_summary=exc.summary,
            retryable=exc.retryable,
        )

    def _run_image_batch_subprocess(self, manifest_path: str, runtime: ToolRuntime) -> dict[str, Any]:
        script = _image_script_path()
        if script is None:
            return {"summary_present": False, "complete": False, "error_class": "image_script_not_found", "raw_error_excerpt": "image generation script not found"}
        env = os.environ.copy()
        thread_data = get_thread_data(runtime) or {}
        if thread_data.get("outputs_path"):
            env["SOPHIA_OUTPUTS_HOST_PATH"] = str(thread_data["outputs_path"])
        if thread_data.get("workspace_path"):
            env["SOPHIA_WORKSPACE_HOST_PATH"] = str(thread_data["workspace_path"])
        env.update(_current_image_trace_env(runtime))
        timeout = _deck_image_batch_timeout_seconds(manifest_path, runtime)
        try:
            completed = subprocess.run(  # noqa: S603
                [sys.executable, str(script), "--manifest", manifest_path],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _timeout_stream_text(getattr(exc, "stdout", None) or getattr(exc, "output", None))
            stderr = _timeout_stream_text(getattr(exc, "stderr", None))
            return {
                "summary_present": False,
                "complete": False,
                "exit_code": 124,
                "error_class": "timeout",
                "raw_error_excerpt": safe_excerpt(
                    f"image batch subprocess timed out after {timeout}s; "
                    f"stdout_chars={len(stdout)} stderr_chars={len(stderr)} "
                    f"{(stderr or stdout).strip()}"
                ),
            }
        summary = _parse_batch_summary(completed.stdout)
        if summary is None:
            return {
                "summary_present": False,
                "complete": False,
                "exit_code": completed.returncode,
                "error_class": "batch_summary_missing",
                "raw_error_excerpt": safe_excerpt((completed.stderr or completed.stdout or "").strip()),
            }
        summary["summary_present"] = True
        summary["exit_code"] = completed.returncode
        return summary


class DeckBuildFailure(Exception):
    def __init__(self, code: str, summary: str, *, retryable: bool) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary
        self.retryable = retryable


def _state_value(runtime: Any, key: str) -> Any:
    state = getattr(runtime, "state", None)
    return state.get(key) if isinstance(state, dict) else None


def _compile_with_build_deck_from_slides(
    runtime: ToolRuntime,
    output_path: str,
    title: str,
    slides_dir: str,
) -> dict[str, Any]:
    raw = build_deck_from_slides.func(
        runtime=runtime,
        output_path=output_path,
        title=title,
        slides_dir=slides_dir,
    )
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return {"success": False, "error_type": "deck_compile_failed", "error": "Compiler returned non-JSON output."}
    return payload if isinstance(payload, dict) else {"success": False, "error_type": "deck_compile_failed", "error": "Compiler returned invalid output."}


def _requested_slide_count_from_state(runtime: ToolRuntime) -> int:
    state = getattr(runtime, "state", None)
    if not isinstance(state, dict):
        return 0
    sources: list[Any] = [state, state.get("delegation_context"), state.get("builder_task")]
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in ("builder_pptx_requested_slide_count", "target_slide_count", "requested_slide_count"):
            try:
                value = int(source.get(key) or 0)
            except (TypeError, ValueError):
                value = 0
            if value > 0:
                return value
    return 0


def _explicit_text_only_requested(runtime: ToolRuntime) -> bool:
    state = getattr(runtime, "state", None)
    if not isinstance(state, dict):
        return False
    haystack_parts: list[str] = []
    for source in (state, state.get("delegation_context"), state.get("builder_task"), state.get("artifact_request")):
        if not isinstance(source, dict):
            continue
        for key in ("user_request", "request", "prompt", "task", "task_brief", "title", "description", "artifact_title", "task_title"):
            value = source.get(key)
            if isinstance(value, str):
                haystack_parts.append(value)
    return bool(_TEXT_ONLY_REQUEST_RE.search("\n".join(haystack_parts)))


def _current_image_trace_env(runtime: ToolRuntime) -> dict[str, str]:
    env: dict[str, str] = {}
    try:
        from langsmith.run_helpers import get_current_run_tree

        run_tree = get_current_run_tree()
        dotted_order = getattr(run_tree, "dotted_order", None)
        trace_id = getattr(run_tree, "trace_id", None)
        run_id = getattr(run_tree, "id", None)
        if dotted_order:
            env["SOPHIA_PARENT_DOTTED_ORDER"] = str(dotted_order)
        if trace_id:
            env["SOPHIA_PARENT_TRACE_ID"] = str(trace_id)
        if run_id:
            env["SOPHIA_PARENT_RUN_ID"] = str(run_id)
    except Exception:  # noqa: BLE001 - tracing env must never block generation.
        pass
    thread_id = _state_value(runtime, "thread_id")
    if thread_id:
        env["SOPHIA_THREAD_ID"] = str(thread_id)
    return env


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _manifest_item_count_for_timeout(manifest_path: str, runtime: ToolRuntime) -> int:
    try:
        host_path = _host_path(manifest_path, runtime)
        payload = json.loads(host_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    items = payload.get("items") if isinstance(payload, dict) else None
    return len(items) if isinstance(items, list) else 0


def _deck_image_batch_timeout_seconds(manifest_path: str, runtime: ToolRuntime) -> int:
    override = os.getenv("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT")
    if override and override.strip():
        return _int_env("SOPHIA_DECK_IMAGE_BATCH_TIMEOUT", 1800)
    per_image_timeout = _int_env("SOPHIA_IMAGE_GEN_TIMEOUT", 240)
    concurrency = _int_env("SOPHIA_IMAGE_GEN_CONCURRENCY", 2)
    item_count = max(1, _manifest_item_count_for_timeout(manifest_path, runtime))
    waves = max(1, (item_count + concurrency - 1) // concurrency)
    return max(per_image_timeout + 30, waves * per_image_timeout + 30)


def _timeout_stream_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _host_path(virtual_path: str, runtime: ToolRuntime) -> Path:
    return Path(replace_virtual_path(virtual_path, get_thread_data(runtime)))


def _composition_for_layout(layout_kind: str) -> str:
    return {
        "cover_hero": "hero visual with one confident focal system metaphor",
        "visual_left_text_right": "visual weighted to the left with clean negative space",
        "text_left_visual_right": "visual weighted to the right with clean negative space",
        "comparison_two_column": "two balanced visual fields with mostly text-free contrast",
        "timeline_flow": "clear process flow with shapes and spatial progression",
        "closing_summary": "calm synthesis visual with restrained emphasis",
    }.get(layout_kind, "single technical visual focus with restrained professional composition")


def _image_script_path() -> Path | None:
    candidates = [
        Path("/mnt/skills/public/image-generation/scripts/generate.py"),
        Path("/app/skills/public/image-generation/scripts/generate.py"),
        Path(__file__).resolve().parents[6] / "skills/public/image-generation/scripts/generate.py",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _parse_batch_summary(stdout: str) -> dict[str, Any] | None:
    for line in stdout.splitlines():
        if line.startswith("IMAGEGEN_BATCH "):
            try:
                return json.loads(line.removeprefix("IMAGEGEN_BATCH ").strip())
            except ValueError:
                return None
    return None


def _safe_batch_summary(summary: dict[str, Any]) -> dict[str, Any]:
    payload = dict(summary)
    if "raw_error_excerpt" in payload:
        payload["raw_error_excerpt"] = safe_excerpt(payload["raw_error_excerpt"])
    return payload


def _file_hash(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        return None


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None
