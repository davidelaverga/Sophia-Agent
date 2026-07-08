from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess  # noqa: S404 - fixed Python script path with sanitized args.
import sys
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langchain.tools import ToolRuntime

from deerflow.sandbox.tools import get_thread_data, replace_virtual_path
from deerflow.sophia.deck_build.evaluator import DeckEvaluator
from deerflow.sophia.deck_build.models import DeckBuild, DeckBuildResult, DeckSlideSpec
from deerflow.sophia.deck_build.storage import save_deck_build
from deerflow.sophia.deck_build.templates import slide_html_virtual_path, write_slide_html
from deerflow.sophia.deck_build.tracing import (
    DEFAULT_ARTIFACT_TARGET_EXT,
    DEFAULT_DECK_COMPILE_MODE,
    DEFAULT_DECK_ROUTE,
    FORBIDDEN_SCREENSHOT_COMPILE_MODES,
    HTML_SCREENSHOT_DEBUG_COMPILE_MODE,
    NATIVE_DECK_COMPILE_MODE,
    NATIVE_UNAVAILABLE_DECK_COMPILE_MODE,
    basename,
    deck_span,
    finish_span,
    safe_excerpt,
    stable_hash,
)
from deerflow.sophia.deck_native import DeckNativeService, native_mechanical_report
from deerflow.sophia.deck_native.errors import DeckNativePathError
from deerflow.sophia.deck_native.models import (
    NativeDeckInspectResult,
    NativeDeckLintFixResult,
    NativeDeckPatchResult,
    NativeDeckPreflight,
    NativeDeckRenderResult,
)
from deerflow.sophia.deck_native.policy import classify_native_deck_substrate
from deerflow.sophia.tools.build_deck_from_slides import build_deck_from_slides
from deerflow.sophia.tools.prepare_pptx_image_manifest import create_pptx_image_manifest_core
from deerflow.sophia.tools.render_markdown_to_pdf import _ensure_relative_to_outputs

_OUTPUTS = "/mnt/user-data/outputs/"
_ASSETS = f"{_OUTPUTS}assets"
_PROMPTS = f"{_ASSETS}/prompts"
_SLIDES = f"{_OUTPUTS}slides"
_MANIFEST = f"{_ASSETS}/slide-visuals.manifest.json"
_NATIVE = f"{_OUTPUTS}deck_native"
_NATIVE_BASE = f"{_NATIVE}/base.pptx"
_NATIVE_PATCH = f"{_NATIVE}/deck.patch.json"
_NATIVE_RENDER_DIR = f"{_NATIVE}/rendered"
_SCHEMA = "sophia-deck-build/v1"
_BANNED_STYLE_RE = re.compile(r"\b(chalkboard|blackboard|whiteboard|handwritten|sketch|cyberpunk|neon)\b", re.I)
_BANNED_TEXT_RE = re.compile(r"THE TEXT READS|title reads|large readable text|paragraph text|axis labels?|formula", re.I)
_NEGATED_BANNED_TERM_RE = re.compile(r"(?:\bno\b|\bnot\b|\bwithout\b|\bavoid\b|\bnever\b|\bdo\s+not\b)\W*$", re.I)
_TEXT_ONLY_REQUEST_RE = re.compile(
    r"\b(?:plain\s+text[-\s]?only|text[-\s]?only|no[-\s]?image|no\s+images?"
    r"|no\s+visuals?|without\s+(?:images?|visuals?)|with\s+no\s+(?:images?|visuals?))\b",
    re.I,
)
_REQUEST_CONTEXT_TEXT_KEYS = (
    "user_request",
    "request",
    "prompt",
    "task",
    "task_brief",
    "title",
    "description",
    "artifact_title",
    "task_title",
)
_SERIAL_REPAIR_MAX_ATTEMPTS = 2
_NON_REPAIRABLE_IMAGE_ERROR_CLASSES = {
    "auth_invalid",
    "content_blocked",
    "egress_blocked",
    "file_not_found",
    "image_script_not_found",
    "import_error",
    "invalid_reference_image",
    "invalid_size",
    "manifest_empty",
    "manifest_prompt_missing",
    "manifest_unreadable",
    "missing_api_key",
    "missing_prompt_or_output",
    "org_not_verified",
    "permission_denied",
    "process_exit",
    "python_not_found",
    "quota_exceeded",
    "sandbox_path_rejected",
    "shell_error",
}


DeckCompiler = Callable[[ToolRuntime, str, str, str], dict[str, Any]]
ImageSingleRunner = Callable[[DeckSlideSpec, ToolRuntime, int], dict[str, Any]]


class DeckBuildService:
    def __init__(
        self,
        *,
        image_batch_runner: Callable[[str, ToolRuntime], dict[str, Any]] | None = None,
        image_single_runner: ImageSingleRunner | None = None,
        deck_compiler: DeckCompiler | None = None,
        native_service: DeckNativeService | None = None,
        evaluator: DeckEvaluator | None = None,
    ) -> None:
        self._image_batch_runner = image_batch_runner or self._run_image_batch_subprocess
        self._image_single_runner = image_single_runner or self._run_image_single_subprocess
        self._deck_compiler = deck_compiler or _compile_with_build_deck_from_slides
        self._native_service = native_service or DeckNativeService()
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
            deck_route=DEFAULT_DECK_ROUTE,
            deck_compile_mode=DEFAULT_DECK_COMPILE_MODE,
            native_required=True,
            legacy_screenshot_debug=False,
            native_editability_score=0.0,
            created_at=now,
            updated_at=now,
        )
        try:
            self._validate_inputs(deck, slides, output_path, runtime)
            deck.slides = self._build_slide_specs(
                slides,
                visual_policy=visual_policy,
                runtime=runtime,
                style_profile=deck.style_profile,
            )
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
                with _deck_trace_runtime_context(runtime, deck):
                    summary = self._run_visual_batch(deck, runtime)
                    self._apply_batch_summary(deck, runtime, summary)
                    self._repair_visuals_after_batch(deck, runtime, summary)
                self._verify_visuals(deck, runtime)
            else:
                for slide in deck.slides:
                    slide.visual_required = False
                    slide.visual_status = "skipped"
                deck.image_generation_status = "skipped"
                deck.primary_image_batch_status = "skipped"
            self._render_slide_html(deck, runtime)
            self._compile_pptx(deck, runtime)
            self._evaluate(deck, runtime)
            deck.status = "evaluated"
            _finalize_image_generation_status(deck, success=True)
            self._assert_deck_success_allowed(deck, runtime)
            deck.updated_at = _now()
            deck_path = save_deck_build(deck, runtime)
            return self._success_result(deck, deck_path, runtime, success_allowed_checked=True)
        except DeckBuildFailure as exc:
            deck.status = "failed_terminal"
            deck.failure_code = exc.code
            deck.failure_summary = exc.summary
            if deck.visual_policy == "required" and deck.slides:
                self._refresh_visual_counts(deck, runtime)
            _finalize_image_generation_status(deck, success=False)
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

    def _build_slide_specs(
        self,
        slides: list[dict[str, Any]],
        *,
        visual_policy: str,
        runtime: ToolRuntime,
        style_profile: dict[str, Any],
    ) -> list[DeckSlideSpec]:
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
                unrequested_style_terms = _unrequested_banned_style_terms(visual_prompt, runtime, style_profile)
                if _contains_unnegated_match(_BANNED_TEXT_RE, visual_prompt) or unrequested_style_terms:
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
        for slide in deck.slides:
            prompt_path = f"{_PROMPTS}/slide-{slide.index:02d}.json"
            host = _host_path(prompt_path, runtime)
            host.parent.mkdir(parents=True, exist_ok=True)
            style = {
                "register": deck.register,
                "visual_style": "clean_flat_vector",
                "aesthetic": "restrained_professional_technical",
            }
            style.update(deck.style_profile or {})
            payload = {
                "prompt": slide.visual_prompt,
                "style": style,
                "composition": _composition_for_layout(slide.layout_kind),
                "constraints": [
                    "No slide title, no narrative paragraph, no footer, no page chrome.",
                    "Avoid large readable text inside the image.",
                    "Use restrained professional technical aesthetic unless the user requested another register.",
                    "Use clean flat vector composition and avoid unrequested stylized or playful modes.",
                ],
                "technical": {"aspect_ratio": "16:9", "quality": "high", "slide_visual": True},
            }
            host.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            slide.visual_prompt_path = prompt_path
        deck.status = "visual_specs_ready"

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
            raw_items = result.get("items") if isinstance(result.get("items"), list) else []
            items = [item for item in raw_items if isinstance(item, dict)]
            finish_span(
                run,
                {
                    "success": bool(result.get("success")),
                    "manifest_author": "DeckBuildService",
                    "item_count": result.get("expected_count", 0),
                    "prompt_count": len(prompt_files),
                    "prompt_basenames": [basename(item.get("prompt_file")) for item in items],
                    "prompt_hashes": [item.get("prompt_hash") for item in items if item.get("prompt_hash")],
                    "prompt_chars_total": sum(int(item.get("prompt_chars") or 0) for item in items),
                    "output_basenames": [basename(item.get("output_path")) for item in items],
                    "schema_version": result.get("schema_version"),
                },
            )
            if not result.get("success"):
                raise DeckBuildFailure(str(result.get("error_type") or "invalid_deck_ir"), str(result.get("error") or "manifest failed"), retryable=True)
            for slide, item in zip(deck.slides, result.get("items", []), strict=True):
                slide.visual_asset_path = item.get("output_path")
            self._clear_expected_visual_outputs(deck, runtime)

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
                "sdk_timeout_seconds": os.getenv("SOPHIA_IMAGE_GEN_TIMEOUT", "120"),
                "sdk_max_retries": os.getenv("SOPHIA_IMAGE_GEN_MAX_RETRIES", "1"),
                "manifest_file": basename(_MANIFEST),
            },
        ) as run:
            summary = self._image_batch_runner(_MANIFEST, runtime)
            summary.setdefault("duration_ms", int((time.perf_counter() - started) * 1000))
            if not summary.get("summary_present", True):
                summary = self._reconcile_missing_batch_summary(deck, runtime, summary)
            self._record_primary_batch_state(deck, summary)
            finish_span(run, _safe_batch_summary(summary))
            if not summary.get("summary_present", True) and not summary.get("batch_attempted"):
                raise DeckBuildFailure("deck_visual_batch_startup_failed", "Image batch did not emit IMAGEGEN_BATCH.", retryable=False)
            if not summary.get("complete"):
                if summary.get("requested") is None:
                    summary["requested"] = deck.expected_visual_count
                return summary
            return summary

    def _clear_expected_visual_outputs(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        for slide in deck.slides:
            if not slide.visual_asset_path:
                continue
            try:
                host = _host_path(slide.visual_asset_path, runtime)
                if host.is_file():
                    host.unlink()
            except OSError:
                continue

    def _record_primary_batch_state(self, deck: DeckBuild, summary: dict[str, Any]) -> None:
        error_class = summary.get("error_class")
        if not error_class:
            histogram = summary.get("error_class_histogram")
            if isinstance(histogram, dict) and histogram:
                error_class = next(iter(histogram))
        if error_class:
            deck.primary_image_batch_error_class = str(error_class)
            deck.image_generation_reason = str(error_class)
        if str(error_class or "") == "timeout":
            deck.batch_timeout_count += 1
        if summary.get("complete"):
            deck.primary_image_batch_status = "success"
        elif summary.get("batch_attempted") or summary.get("summary_present", True):
            deck.primary_image_batch_status = "partial" if int(summary.get("images_generated") or 0) > 0 else "failed"
        else:
            deck.primary_image_batch_status = "failed"
        if summary.get("partial_batch_salvaged"):
            deck.partial_batch_salvaged = True

    def _reconcile_missing_batch_summary(
        self,
        deck: DeckBuild,
        runtime: ToolRuntime,
        summary: dict[str, Any],
    ) -> dict[str, Any]:
        progress_items = summary.get("items") if isinstance(summary.get("items"), list) else []
        error_class = str(summary.get("error_class") or "batch_summary_missing")
        batch_attempted = error_class == "timeout" or bool(progress_items)
        if not batch_attempted:
            return {**summary, "batch_attempted": False}
        progress_by_output = {
            str(item.get("output_file")): item
            for item in progress_items
            if isinstance(item, dict) and item.get("output_file")
        }
        items: list[dict[str, Any]] = []
        succeeded = 0
        histogram: dict[str, int] = {}
        with deck_span(
            "deck.image_batch.timeout_reconcile",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={
                "summary_error_class": error_class,
                "progress_item_count": len(progress_items),
                "expected_visual_count": deck.expected_visual_count,
            },
        ) as run:
            for slide in deck.slides:
                output_file = str(slide.visual_asset_path or "")
                progress = progress_by_output.get(output_file, {})
                output_bytes = _file_size(_host_path(output_file, runtime)) if output_file else None
                exists = bool(output_bytes and output_bytes > 0)
                success = exists or (bool(progress.get("success")) and exists)
                item_error_class = None if success else str(progress.get("error_class") or error_class or "timeout")
                if success:
                    succeeded += 1
                else:
                    histogram[item_error_class or "unknown"] = histogram.get(item_error_class or "unknown", 0) + 1
                item = {
                    "item_index": slide.index,
                    "output_file": output_file,
                    "success": success,
                    "bytes": output_bytes or 0,
                    "duration_ms": progress.get("duration_ms"),
                    "error_class": item_error_class,
                }
                raw_error = progress.get("raw_error_excerpt") or summary.get("raw_error_excerpt")
                if raw_error and not success:
                    item["raw_error_excerpt"] = safe_excerpt(raw_error)
                items.append({key: value for key, value in item.items() if value not in (None, "")})
            reconciled = {
                **summary,
                "summary_present": False,
                "batch_attempted": True,
                "requested": deck.expected_visual_count,
                "images_generated": succeeded,
                "failed": max(0, deck.expected_visual_count - succeeded),
                "complete": succeeded == deck.expected_visual_count,
                "items": items,
                "error_class": error_class,
                "error_class_histogram": histogram,
                "partial_batch_salvaged": succeeded > 0,
            }
            finish_span(
                run,
                {
                    "batch_attempted": True,
                    "partial_batch_salvaged": succeeded > 0,
                    "successful_visual_count": succeeded,
                    "missing_visual_count": max(0, deck.expected_visual_count - succeeded),
                    "error_class": error_class,
                },
            )
            return reconciled

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

    def _repair_visuals_after_batch(self, deck: DeckBuild, runtime: ToolRuntime, summary: dict[str, Any]) -> None:
        missing = self._slides_needing_repair(deck, runtime)
        if not missing:
            return
        if not _batch_summary_allows_serial_repair(summary):
            deck.image_generation_reason = _primary_error_class(summary) or deck.image_generation_reason
            return
        attempts = 0
        repaired = 0
        stopped_error_class: str | None = None
        with deck_span(
            "deck.image_repair.run",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            inputs={
                "missing_visual_count": len(missing),
                "max_attempts_per_visual": _SERIAL_REPAIR_MAX_ATTEMPTS,
                "batch_error_class": _primary_error_class(summary),
            },
        ) as run:
            for slide in missing:
                for attempt_no in range(1, _SERIAL_REPAIR_MAX_ATTEMPTS + 1):
                    attempts += 1
                    result = self._image_single_runner(slide, runtime, attempt_no)
                    result_error_class = str(result.get("error_class") or "")
                    output_exists = bool(slide.visual_asset_path and (_file_size(_host_path(slide.visual_asset_path, runtime)) or 0) > 0)
                    success = bool(result.get("success")) and output_exists
                    deck.serial_repair_count += 1
                    with deck_span(
                        "deck.image_repair.item",
                        runtime=runtime,
                        build_id=deck.build_id,
                        visual_policy=deck.visual_policy,
                        status=deck.status,
                        slide_count=len(deck.slides),
                        run_type="tool",
                        inputs={
                            "mode": "serial_repair",
                            "repair_attempt_no": attempt_no,
                            "item_index": slide.index,
                            "selector": slide.selector,
                            "prompt_file": basename(slide.visual_prompt_path),
                            "prompt_hash": _file_hash(_host_path(slide.visual_prompt_path or "", runtime)),
                            "output_file": basename(slide.visual_asset_path),
                            "allowed_manifest_output": True,
                        },
                    ) as item_run:
                        finish_span(
                            item_run,
                            {
                                "success": success,
                                "error_class": None if success else result_error_class or "image_generation_failed",
                                "exit_code": result.get("exit_code"),
                                "duration_ms": result.get("duration_ms"),
                                "output_bytes": (
                                    _file_size(_host_path(slide.visual_asset_path, runtime))
                                    if slide.visual_asset_path
                                    else None
                                ),
                                "raw_error_excerpt": safe_excerpt(result.get("raw_error_excerpt")),
                            },
                        )
                    if success:
                        slide.visual_status = "generated"
                        slide.visual_error_class = None
                        repaired += 1
                        break
                    slide.visual_status = "failed"
                    slide.visual_error_class = result_error_class or "image_generation_failed"
                    deck.image_generation_reason = slide.visual_error_class
                    if slide.visual_error_class in _NON_REPAIRABLE_IMAGE_ERROR_CLASSES:
                        stopped_error_class = slide.visual_error_class
                        break
                if stopped_error_class:
                    break
            successful, remaining_missing = self._refresh_visual_counts(deck, runtime)
            if attempts and remaining_missing == 0:
                deck.primary_image_batch_status = "repaired"
            finish_span(
                run,
                {
                    "attempt_count": attempts,
                    "repaired_visual_count": repaired,
                    "successful_visual_count": successful,
                    "remaining_missing_visual_count": remaining_missing,
                    "stopped_error_class": stopped_error_class,
                },
            )

    def _slides_needing_repair(self, deck: DeckBuild, runtime: ToolRuntime) -> list[DeckSlideSpec]:
        slides: list[DeckSlideSpec] = []
        for slide in deck.slides:
            output_exists = bool(slide.visual_asset_path and (_file_size(_host_path(slide.visual_asset_path, runtime)) or 0) > 0)
            if slide.visual_status != "generated" or not output_exists:
                slides.append(slide)
        return slides

    def _refresh_visual_counts(self, deck: DeckBuild, runtime: ToolRuntime) -> tuple[int, int]:
        successful = 0
        missing = 0
        for slide in deck.slides:
            exists = bool(slide.visual_asset_path and (_file_size(_host_path(slide.visual_asset_path, runtime)) or 0) > 0)
            if slide.visual_status == "generated" and exists:
                successful += 1
            else:
                missing += 1
        deck.successful_visual_count = successful
        deck.missing_visual_count = missing
        return successful, missing

    def _verify_visuals(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        successful, missing = self._refresh_visual_counts(deck, runtime)
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
            _clear_slide_html_directory(_host_path(_SLIDES, runtime))
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
        preflight = self._trace_native_requirement(deck, runtime)
        if not preflight.success:
            deck.deck_compile_mode = NATIVE_UNAVAILABLE_DECK_COMPILE_MODE
            raise DeckBuildFailure(
                "deck_native_unavailable",
                _native_error_summary(preflight.errors, "Native deck service is unavailable."),
                retryable=False,
            )
        try:
            self._compile_native_pptx(deck, runtime)
        except DeckNativePathError as exc:
            deck.deck_compile_mode = NATIVE_UNAVAILABLE_DECK_COMPILE_MODE
            raise DeckBuildFailure(
                "deck_native_unavailable",
                safe_excerpt(exc) or "Native deck service is unavailable.",
                retryable=False,
            ) from exc

    def _trace_native_requirement(self, deck: DeckBuild, runtime: ToolRuntime):
        deck.native_required = True
        deck.legacy_screenshot_debug = _legacy_screenshot_debug_allowed(runtime)
        preflight = _native_preflight(self._native_service)
        with deck_span(
            "deck.native.requirement",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={},
        ) as run:
            finish_span(
                run,
                {
                    "native_required": True,
                    "legacy_screenshot_debug_allowed": deck.legacy_screenshot_debug,
                    "preflight_success": preflight.success,
                    "scripts_dir_exists": preflight.scripts_dir_exists,
                    "deck_py_exists": preflight.deck_py_exists,
                    "html2patch_py_exists": preflight.html2patch_py_exists,
                    "error_count": len(preflight.errors),
                    "deck_compile_mode_before": deck.deck_compile_mode,
                },
            )
        return preflight

    def _compile_screenshot_debug_pptx(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        deck.deck_compile_mode = HTML_SCREENSHOT_DEBUG_COMPILE_MODE
        deck.legacy_screenshot_debug = True
        deck.native_editability_score = 0.0
        deck.native_text_shape_count = 0
        deck.picture_shape_count = 0
        deck.full_slide_picture_count = len(deck.slides)
        deck.quality_warning = _merge_warning(deck.quality_warning, "screenshot_deck_debug_only")
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
                _SLIDES,
            )
            finish_span(
                run,
                {
                    "success": bool(result.get("success")),
                    "deck_route": deck.deck_route,
                    "deck_compile_mode": deck.deck_compile_mode,
                    "artifact_target_ext": DEFAULT_ARTIFACT_TARGET_EXT,
                    "pptx_file": basename(result.get("pptx_path")),
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

    def _compile_native_pptx(self, deck: DeckBuild, runtime: ToolRuntime) -> None:
        deck.deck_compile_mode = NATIVE_DECK_COMPILE_MODE
        base_host = _host_path(_NATIVE_BASE, runtime)
        patch_host = _host_path(_NATIVE_PATCH, runtime)
        output_host = _host_path(deck.output_path, runtime)
        render_host = _host_path(_NATIVE_RENDER_DIR, runtime)
        html_hosts = [_host_path(slide.html_source_path or "", runtime) for slide in deck.slides]
        _write_native_base_deck(base_host)
        with deck_span(
            "deck.native.html2patch",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"html_count": len(html_hosts), "base_file": basename(str(base_host)), "patch_file": basename(str(patch_host))},
        ) as run:
            html2patch = self._native_service.html_to_patch(
                html_paths=[str(path) for path in html_hosts],
                base_deck_path=str(base_host),
                output_patch_path=str(patch_host),
            )
            finish_span(run, _native_patch_span_outputs(html2patch))
        if not html2patch.success:
            code = "deck_native_startup_failed" if _native_startup_error(html2patch.errors) else "deck_native_html2patch_failed"
            raise DeckBuildFailure(code, _native_error_summary(html2patch.errors, "Native html2patch failed."), retryable=False)
        with deck_span(
            "deck.native.patch_apply",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"patch_file": basename(html2patch.patch_path), "output_file": basename(deck.output_path), "fix": True},
        ) as run:
            applied = self._native_service.apply_patch(
                base_deck_path=str(base_host),
                patch_path=str(patch_host),
                output_path=str(output_host),
                fix=True,
            )
            finish_span(run, _native_patch_span_outputs(applied))
        if not applied.success:
            code = "deck_native_patch_validation_failed" if applied.validation_error_count else "deck_native_patch_apply_failed"
            raise DeckBuildFailure(code, _native_error_summary(applied.errors, "Native patch apply failed."), retryable=False)
        with deck_span(
            "deck.native.inspect",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"pptx_file": basename(deck.output_path)},
        ) as run:
            inspected = self._native_service.inspect(str(output_host))
            finish_span(run, _native_inspect_span_outputs(inspected))
        if not inspected.success:
            raise DeckBuildFailure("deck_native_inspect_failed", _native_error_summary(inspected.errors, "Native inspect failed."), retryable=False)
        self._record_native_inspect(deck, inspected)
        if (deck.native_editability_score or 0.0) < 0.60:
            raise DeckBuildFailure(
                "deck_native_editability_failed",
                f"Native editability score {deck.native_editability_score:.2f} is below the 0.60 D1 gate.",
                retryable=False,
            )
        touched_slides = [slide.index - 1 for slide in deck.slides]
        with deck_span(
            "deck.native.lint_fix",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"touched_slide_count": len(touched_slides)},
        ) as run:
            lint_fix = self._native_service.lint_fix(pptx_path=str(output_host), touched_slides=touched_slides)
            finish_span(run, _native_lint_fix_span_outputs(lint_fix))
        if not lint_fix.success:
            raise DeckBuildFailure("deck_native_lint_fix_failed", _native_error_summary(lint_fix.errors, "Native lint/fix failed."), retryable=False)
        if lint_fix.residue_count:
            deck.quality_warning = _merge_warning(deck.quality_warning, "native_lint_residue")
        for slide in deck.slides:
            slide.gate_results["native_editability_score"] = deck.native_editability_score
            slide.gate_results["lint_residue_count"] = lint_fix.residue_count
        with deck_span(
            "deck.native.render",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"pptx_file": basename(deck.output_path), "slide_count": len(touched_slides)},
        ) as run:
            rendered = self._native_service.render(pptx_path=str(output_host), output_dir=str(render_host), slides=touched_slides)
            finish_span(run, _native_render_span_outputs(rendered))
        if not rendered.success:
            raise DeckBuildFailure("deck_native_render_failed", _native_error_summary(rendered.errors, "Native render failed."), retryable=False)
        with deck_span(
            "deck.native.diff",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={"before_file": basename(str(base_host)), "after_file": basename(deck.output_path)},
        ) as run:
            diff = self._native_service.diff(before_path=str(base_host), after_path=str(output_host))
            finish_span(run, {"success": bool(diff.get("success")), "changed": bool(diff.get("changed")), "error_count": len(diff.get("errors") or [])})
        if not diff.get("success"):
            deck.quality_warning = _merge_warning(deck.quality_warning, "native_diff_unavailable")
        deck.native_mechanical_report = native_mechanical_report(
            inspect=inspected,
            lint_fix=lint_fix,
            render=rendered,
            diff=diff,
        )
        with deck_span(
            "deck.native.mechanical_report",
            runtime=runtime,
            build_id=deck.build_id,
            visual_policy=deck.visual_policy,
            status=deck.status,
            slide_count=len(deck.slides),
            run_type="tool",
            deck_compile_mode=deck.deck_compile_mode,
            inputs={},
        ) as run:
            finish_span(run, deck.native_mechanical_report)
        deck.pptx_path = deck.output_path
        deck.compile_overflow_slides = []
        deck.status = "compiled"

    def _record_native_inspect(self, deck: DeckBuild, inspected: NativeDeckInspectResult) -> None:
        deck.native_editability_score = inspected.native_editability_score
        deck.native_text_shape_count = inspected.native_text_shape_count
        deck.picture_shape_count = inspected.picture_shape_count
        deck.full_slide_picture_count = inspected.full_slide_picture_count
        inventory = _load_native_shape_inventory(inspected.shape_inventory_path)
        deck.native_shape_inventory = inventory
        for slide in deck.slides:
            slide_inventory = inventory.get(slide.selector) if isinstance(inventory, dict) else None
            if isinstance(slide_inventory, dict):
                slide.gate_results["native_shape_inventory"] = {
                    "native_slide_index": slide_inventory.get("native_slide_index"),
                    "title": slide_inventory.get("title"),
                    "body": slide_inventory.get("body"),
                    "visual": slide_inventory.get("visual"),
                }

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
            evaluation = self._evaluator.evaluate(
                deck,
                output_host_path=output_host,
                allowed_style_terms=_requested_banned_style_terms(runtime, deck.style_profile),
            )
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
        deck.quality_warning = _merge_warning(deck.quality_warning, evaluation.quality_warning)

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
                    "artifact_file": basename(deck.pptx_path) if success else None,
                    "deck_build_file": basename(deck_path),
                    "deck_route": deck.deck_route,
                    "deck_compile_mode": deck.deck_compile_mode,
                    "native_required": deck.native_required,
                    "legacy_screenshot_debug": deck.legacy_screenshot_debug,
                    "native_editability_score": deck.native_editability_score,
                    "native_text_shape_count": deck.native_text_shape_count,
                    "picture_shape_count": deck.picture_shape_count,
                    "full_slide_picture_count": deck.full_slide_picture_count,
                    "quality_warning": deck.quality_warning,
                    "failure_summary": safe_excerpt(deck.failure_summary),
                    "image_generation_status": deck.image_generation_status,
                    "image_generation_reason": deck.image_generation_reason,
                    "primary_image_batch_status": deck.primary_image_batch_status,
                    "primary_image_batch_error_class": deck.primary_image_batch_error_class,
                    "serial_repair_count": deck.serial_repair_count,
                    "batch_timeout_count": deck.batch_timeout_count,
                    "partial_batch_salvaged": deck.partial_batch_salvaged,
                    "native_mechanical_report": deck.native_mechanical_report,
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
                    "artifact_file": basename(deck.pptx_path) if success else None,
                    "deck_route": deck.deck_route,
                    "deck_compile_mode": deck.deck_compile_mode,
                    "native_required": deck.native_required,
                    "legacy_screenshot_debug": deck.legacy_screenshot_debug,
                    "native_editability_score": deck.native_editability_score,
                    "native_text_shape_count": deck.native_text_shape_count,
                    "picture_shape_count": deck.picture_shape_count,
                    "full_slide_picture_count": deck.full_slide_picture_count,
                    "failure_code": deck.failure_code,
                    "failure_summary": safe_excerpt(deck.failure_summary),
                    "retryable": retryable,
                    "expected_visual_count": deck.expected_visual_count,
                    "successful_visual_count": deck.successful_visual_count,
                    "referenced_visual_count": deck.referenced_visual_count,
                    "missing_visual_count": deck.missing_visual_count,
                    "quality_warning": deck.quality_warning,
                    "image_generation_status": deck.image_generation_status,
                    "image_generation_reason": deck.image_generation_reason,
                    "primary_image_batch_status": deck.primary_image_batch_status,
                    "primary_image_batch_error_class": deck.primary_image_batch_error_class,
                    "serial_repair_count": deck.serial_repair_count,
                    "batch_timeout_count": deck.batch_timeout_count,
                    "partial_batch_salvaged": deck.partial_batch_salvaged,
                    "native_mechanical_report": deck.native_mechanical_report,
                },
            )

    def _success_result(
        self,
        deck: DeckBuild,
        deck_path: str,
        runtime: ToolRuntime,
        *,
        success_allowed_checked: bool = False,
    ) -> DeckBuildResult:
        if not success_allowed_checked:
            self._assert_deck_success_allowed(deck, runtime)
        _finalize_image_generation_status(deck, success=True)
        self._trace_terminal(deck, runtime, success=True, deck_path=deck_path, retryable=False)
        self._trace_emit_decision(deck, runtime, success=True, retryable=False)
        return DeckBuildResult(
            success=True,
            build_id=deck.build_id,
            deck_build_path=deck_path,
            pptx_path=deck.pptx_path,
            deck_route=deck.deck_route,
            deck_compile_mode=deck.deck_compile_mode,
            native_required=deck.native_required,
            legacy_screenshot_debug=deck.legacy_screenshot_debug,
            native_editability_score=deck.native_editability_score,
            native_text_shape_count=deck.native_text_shape_count,
            picture_shape_count=deck.picture_shape_count,
            full_slide_picture_count=deck.full_slide_picture_count,
            slide_count=len(deck.slides),
            expected_visual_count=deck.expected_visual_count,
            successful_visual_count=deck.successful_visual_count,
            referenced_visual_count=deck.referenced_visual_count,
            missing_visual_count=deck.missing_visual_count,
            quality_status="warning" if deck.quality_warning else "passed",
            quality_warning=deck.quality_warning,
            warnings=[deck.quality_warning] if deck.quality_warning else [],
            image_generation_status=deck.image_generation_status,
            image_generation_reason=deck.image_generation_reason,
            primary_image_batch_status=deck.primary_image_batch_status,
            primary_image_batch_error_class=deck.primary_image_batch_error_class,
            serial_repair_count=deck.serial_repair_count,
            batch_timeout_count=deck.batch_timeout_count,
            partial_batch_salvaged=deck.partial_batch_salvaged,
            native_mechanical_report=deck.native_mechanical_report,
        )

    def _assert_deck_success_allowed(self, deck: DeckBuild, runtime: ToolRuntime | None = None) -> None:
        if deck.deck_compile_mode in FORBIDDEN_SCREENSHOT_COMPILE_MODES:
            raise DeckBuildFailure(
                "deck_screenshot_compile_forbidden",
                "Screenshot-backed PPTX is not an allowed fresh-deck output.",
                retryable=False,
            )
        if deck.deck_compile_mode != NATIVE_DECK_COMPILE_MODE:
            raise DeckBuildFailure(
                "deck_native_compile_required",
                "Fresh PPTX decks must compile through the native PowerPoint substrate.",
                retryable=False,
            )
        verdict = classify_native_deck_substrate(
            slide_count=len(deck.slides),
            native_editability_score=deck.native_editability_score,
            native_text_shape_count=deck.native_text_shape_count,
            picture_shape_count=deck.picture_shape_count,
            full_slide_picture_count=deck.full_slide_picture_count,
            native_shape_inventory=deck.native_shape_inventory,
        )
        if runtime is not None:
            with deck_span(
                "deck.native.substrate_classify",
                runtime=runtime,
                build_id=deck.build_id,
                visual_policy=deck.visual_policy,
                status=deck.status,
                slide_count=len(deck.slides),
                run_type="tool",
                deck_compile_mode=deck.deck_compile_mode,
                inputs={
                    "slide_count": len(deck.slides),
                    "native_editability_score": deck.native_editability_score,
                    "native_text_shape_count": deck.native_text_shape_count,
                    "picture_shape_count": deck.picture_shape_count,
                    "full_slide_picture_count": deck.full_slide_picture_count,
                },
            ) as run:
                finish_span(
                    run,
                    {
                        "passed": verdict.passed,
                        "verdict": verdict.verdict,
                        "hard_failure_code": verdict.hard_failure_code,
                        "warnings": verdict.warnings,
                    },
                )
        if verdict.warnings:
            deck.quality_warning = _merge_warning(deck.quality_warning, *verdict.warnings)
        for slide in deck.slides:
            slide.gate_results["native_substrate_verdict"] = verdict.verdict
            slide.gate_results["native_substrate_warnings"] = list(verdict.warnings)
        if not verdict.passed:
            raise DeckBuildFailure(
                verdict.hard_failure_code or "deck_native_substrate_failed",
                verdict.hard_failure_summary or "Native deck substrate gate failed.",
                retryable=False,
            )
        if deck.quality_warning and "screenshot_deck" in deck.quality_warning:
            raise DeckBuildFailure(
                "deck_screenshot_compile_forbidden",
                "Screenshot-backed PPTX is not an allowed fresh-deck output.",
                retryable=False,
            )

    def _failure_result(
        self,
        deck: DeckBuild,
        deck_path: str,
        exc: DeckBuildFailure,
        runtime: ToolRuntime,
    ) -> DeckBuildResult:
        self._trace_emit_decision(deck, runtime, success=False, retryable=exc.retryable)
        return DeckBuildResult(
            success=False,
            build_id=deck.build_id,
            deck_build_path=deck_path,
            deck_route=deck.deck_route,
            deck_compile_mode=deck.deck_compile_mode,
            native_required=deck.native_required,
            legacy_screenshot_debug=deck.legacy_screenshot_debug,
            native_editability_score=deck.native_editability_score,
            native_text_shape_count=deck.native_text_shape_count,
            picture_shape_count=deck.picture_shape_count,
            full_slide_picture_count=deck.full_slide_picture_count,
            slide_count=len(deck.slides),
            expected_visual_count=deck.expected_visual_count,
            successful_visual_count=deck.successful_visual_count,
            referenced_visual_count=deck.referenced_visual_count,
            missing_visual_count=deck.missing_visual_count,
            failure_code=exc.code,
            failure_summary=exc.summary,
            retryable=exc.retryable,
            image_generation_status=deck.image_generation_status,
            image_generation_reason=deck.image_generation_reason,
            primary_image_batch_status=deck.primary_image_batch_status,
            primary_image_batch_error_class=deck.primary_image_batch_error_class,
            serial_repair_count=deck.serial_repair_count,
            batch_timeout_count=deck.batch_timeout_count,
            partial_batch_salvaged=deck.partial_batch_salvaged,
            quality_status="failed",
            quality_warning=deck.quality_warning,
            warnings=[deck.quality_warning] if deck.quality_warning else [],
            native_mechanical_report=deck.native_mechanical_report,
        )

    def _run_image_batch_subprocess(self, manifest_path: str, runtime: ToolRuntime) -> dict[str, Any]:
        script = _image_script_path()
        if script is None:
            return {"summary_present": False, "complete": False, "error_class": "image_script_not_found", "raw_error_excerpt": "image generation script not found"}
        env = _image_subprocess_env(runtime)
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
                "items": _parse_batch_item_progress(stdout),
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
                "items": _parse_batch_item_progress(completed.stdout),
                "raw_error_excerpt": safe_excerpt((completed.stderr or completed.stdout or "").strip()),
            }
        summary["summary_present"] = True
        summary["exit_code"] = completed.returncode
        return summary

    def _run_image_single_subprocess(self, slide: DeckSlideSpec, runtime: ToolRuntime, attempt_no: int) -> dict[str, Any]:
        script = _image_script_path()
        if script is None:
            return {"success": False, "error_class": "image_script_not_found", "raw_error_excerpt": "image generation script not found"}
        if not slide.visual_prompt_path or not slide.visual_asset_path:
            return {"success": False, "error_class": "missing_prompt_or_output"}
        started = time.perf_counter()
        timeout = _image_single_timeout_seconds()
        try:
            completed = subprocess.run(  # noqa: S603
                [
                    sys.executable,
                    str(script),
                    "--prompt-file",
                    slide.visual_prompt_path,
                    "--output-file",
                    slide.visual_asset_path,
                    "--aspect-ratio",
                    "16:9",
                    "--slide-visual",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=_image_subprocess_env(runtime),
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _timeout_stream_text(getattr(exc, "stdout", None) or getattr(exc, "output", None))
            stderr = _timeout_stream_text(getattr(exc, "stderr", None))
            return {
                "success": False,
                "exit_code": 124,
                "error_class": "timeout",
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "raw_error_excerpt": safe_excerpt(
                    f"serial image repair attempt {attempt_no} timed out after {timeout}s; "
                    f"stdout_chars={len(stdout)} stderr_chars={len(stderr)} "
                    f"{(stderr or stdout).strip()}"
                ),
            }
        output_bytes = _file_size(_host_path(slide.visual_asset_path, runtime))
        success = completed.returncode == 0 and bool(output_bytes and output_bytes > 0)
        return {
            "success": success,
            "exit_code": completed.returncode,
            "error_class": None if success else _image_generation_error_class_from_output(completed.stderr, completed.stdout, completed.returncode),
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "bytes": output_bytes or 0,
            "raw_error_excerpt": safe_excerpt((completed.stderr or completed.stdout or "").strip()),
        }


class DeckBuildFailure(Exception):
    def __init__(self, code: str, summary: str, *, retryable: bool) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary
        self.retryable = retryable


def _state_value(runtime: Any, key: str) -> Any:
    state = getattr(runtime, "state", None)
    return state.get(key) if isinstance(state, dict) else None


def _truthy_env(name: str) -> bool:
    return (os.getenv(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}


def _native_preflight(native_service: Any) -> NativeDeckPreflight:
    preflight = getattr(native_service, "preflight", None)
    if callable(preflight):
        result = preflight()
        if isinstance(result, NativeDeckPreflight):
            return result
        if isinstance(result, dict):
            return NativeDeckPreflight(
                success=bool(result.get("success")),
                scripts_dir_exists=bool(result.get("scripts_dir_exists")),
                deck_py_exists=bool(result.get("deck_py_exists")),
                html2patch_py_exists=bool(result.get("html2patch_py_exists")),
                errors=[str(item) for item in result.get("errors", []) if item],
            )
    return NativeDeckPreflight(
        success=True,
        scripts_dir_exists=True,
        deck_py_exists=True,
        html2patch_py_exists=True,
        errors=[],
    )


def _legacy_screenshot_debug_allowed(runtime: ToolRuntime) -> bool:
    if not _truthy_env("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG"):
        return False
    return not _is_production_runtime(runtime)


def _is_production_runtime(runtime: ToolRuntime) -> bool:
    if any(os.getenv(name) for name in ("RENDER", "RENDER_SERVICE_ID", "RENDER_SERVICE_NAME")):
        return True
    for key in ("SOPHIA_ENV", "SOPHIA_RUNTIME_ENV", "APP_ENV", "ENV", "ENVIRONMENT"):
        if (os.getenv(key, "") or "").strip().lower() == "production":
            return True
    value = _state_value(runtime, "environment") or _state_value(runtime, "runtime_env")
    return str(value or "").strip().lower() == "production"


def _native_startup_error(errors: list[str]) -> bool:
    text = "\n".join(errors).lower()
    return any(
        marker in text
        for marker in (
            "playwright is required",
            "hands-on-deck script not found",
            "no module named",
            "python-pptx is required",
            "chromium",
            "browser",
        )
    )


def _native_error_summary(errors: list[str], fallback: str) -> str:
    if not errors:
        return fallback
    return safe_excerpt(errors[0], limit=600) or fallback


def _merge_warning(*warnings: str | None) -> str | None:
    parts: list[str] = []
    for warning in warnings:
        if not warning:
            continue
        for part in str(warning).split(";"):
            clean = part.strip()
            if clean and clean not in parts:
                parts.append(clean)
    return "; ".join(parts) if parts else None


def _write_native_base_deck(path: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    path.parent.mkdir(parents=True, exist_ok=True)
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    presentation.save(path)


def _native_patch_span_outputs(result: NativeDeckPatchResult) -> dict[str, Any]:
    return {
        "success": result.success,
        "patch_file": basename(result.patch_path),
        "output_file": basename(result.output_pptx_path),
        "patch_op_count": result.patch_op_count,
        "validation_error_count": result.validation_error_count,
        "error_count": len(result.errors),
        "error_excerpt": safe_excerpt(result.errors[0]) if result.errors else None,
    }


def _native_inspect_span_outputs(result: NativeDeckInspectResult) -> dict[str, Any]:
    return {
        "success": result.success,
        "slide_count": result.slide_count,
        "shape_count": result.shape_count,
        "native_text_shape_count": result.native_text_shape_count,
        "picture_shape_count": result.picture_shape_count,
        "full_slide_picture_count": result.full_slide_picture_count,
        "native_editability_score": result.native_editability_score,
        "shape_inventory_file": basename(result.shape_inventory_path),
        "raw_json_file": basename(result.raw_json_path),
        "error_count": len(result.errors),
        "error_excerpt": safe_excerpt(result.errors[0]) if result.errors else None,
    }


def _native_lint_fix_span_outputs(result: NativeDeckLintFixResult) -> dict[str, Any]:
    return {
        "success": result.success,
        "lint_issue_count_before": result.lint_issue_count_before,
        "fix_applied_count": result.fix_applied_count,
        "residue_count": result.residue_count,
        "touched_slide_count": result.touched_slide_count,
        "issue_kinds": result.issue_kinds,
        "residue_kinds": result.residue_kinds,
        "error_count": len(result.errors),
        "error_excerpt": safe_excerpt(result.errors[0]) if result.errors else None,
    }


def _native_render_span_outputs(result: NativeDeckRenderResult) -> dict[str, Any]:
    return {
        "success": result.success,
        "render_dir": basename(result.render_dir),
        "rendered_slide_count": result.rendered_slide_count,
        "error_count": len(result.errors),
        "error_excerpt": safe_excerpt(result.errors[0]) if result.errors else None,
    }


def _load_native_shape_inventory(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    slides = payload.get("slides") if isinstance(payload, dict) else None
    return slides if isinstance(slides, dict) else {}


@contextlib.contextmanager
def _deck_trace_runtime_context(runtime: ToolRuntime, deck: DeckBuild) -> Iterator[None]:
    state = getattr(runtime, "state", None)
    if not isinstance(state, dict):
        yield
        return
    sentinel = object()
    patch = {
        "current_deck_build_id": deck.build_id,
        "current_deck_route": deck.deck_route,
        "current_deck_compile_mode": deck.deck_compile_mode,
        "current_deck_artifact_target_ext": DEFAULT_ARTIFACT_TARGET_EXT,
    }
    previous = {key: state.get(key, sentinel) for key in patch}
    state.update(patch)
    try:
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is sentinel:
                state.pop(key, None)
            else:
                state[key] = old_value


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


def _contains_unnegated_match(pattern: re.Pattern[str], value: str) -> bool:
    return bool(_unnegated_matches(pattern, value))


def _unnegated_matches(pattern: re.Pattern[str], value: str) -> set[str]:
    matches: set[str] = set()
    for match in pattern.finditer(value):
        prefix = value[max(0, match.start() - 32) : match.start()]
        if _NEGATED_BANNED_TERM_RE.search(prefix):
            continue
        matches.add(match.group(0).lower())
    return matches


def _unrequested_banned_style_terms(value: str, runtime: ToolRuntime, style_profile: dict[str, Any]) -> set[str]:
    style_terms = _unnegated_matches(_BANNED_STYLE_RE, value)
    if not style_terms:
        return set()
    requested_style_terms = _requested_banned_style_terms(runtime, style_profile)
    return style_terms - requested_style_terms


def _requested_banned_style_terms(runtime: ToolRuntime, style_profile: dict[str, Any]) -> set[str]:
    requested_style_text = _normalize_style_text(
        "\n".join(
            [
                _request_context_text(runtime),
                "\n".join(_string_values(style_profile)),
            ]
        )
    )
    return _unnegated_matches(_BANNED_STYLE_RE, requested_style_text)


def _normalize_style_text(value: str) -> str:
    return re.sub(r"[_-]+", " ", value.lower())


def _request_context_text(runtime: ToolRuntime) -> str:
    state = getattr(runtime, "state", None)
    if not isinstance(state, dict):
        return ""
    haystack_parts: list[str] = []
    for source in (state, state.get("delegation_context"), state.get("builder_task"), state.get("artifact_request")):
        if not isinstance(source, dict):
            continue
        for key in _REQUEST_CONTEXT_TEXT_KEYS:
            value = source.get(key)
            if isinstance(value, str):
                haystack_parts.append(value)
    return "\n".join(haystack_parts)


def _string_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        values: list[str] = []
        for item in value.values():
            values.extend(_string_values(item))
        return values
    if isinstance(value, (list, tuple, set)):
        values = []
        for item in value:
            values.extend(_string_values(item))
        return values
    return []


def _clear_slide_html_directory(slides_dir: Path) -> None:
    if not slides_dir.exists():
        return
    for path in slides_dir.glob("*.html"):
        if path.is_file():
            path.unlink()


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
    return bool(_TEXT_ONLY_REQUEST_RE.search(_request_context_text(runtime)))


def _finalize_image_generation_status(deck: DeckBuild, *, success: bool) -> None:
    if deck.visual_policy != "required":
        deck.image_generation_status = deck.image_generation_status or "skipped"
        deck.primary_image_batch_status = deck.primary_image_batch_status or "skipped"
        return
    if success:
        deck.image_generation_status = "success_after_repair" if deck.serial_repair_count > 0 else "success"
        deck.image_generation_reason = None
        if deck.serial_repair_count > 0:
            deck.primary_image_batch_status = "repaired"
        else:
            deck.primary_image_batch_status = deck.primary_image_batch_status or "success"
        return
    if deck.successful_visual_count > 0:
        deck.image_generation_status = "partial"
    else:
        deck.image_generation_status = "failed"
    deck.image_generation_reason = (
        deck.image_generation_reason
        or deck.primary_image_batch_error_class
        or deck.failure_code
        or "image_generation_failed"
    )
    deck.primary_image_batch_status = deck.primary_image_batch_status or "failed"
    deck.primary_image_batch_error_class = deck.primary_image_batch_error_class or deck.image_generation_reason


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
    session_id = (
        _state_value(runtime, "session_id")
        or _state_value(runtime, "parent_thread_id")
        or _state_value(runtime, "companion_session_id")
    )
    if session_id:
        env["SOPHIA_SESSION_ID"] = str(session_id)
    task_id = _state_value(runtime, "task_id") or _state_value(runtime, "builder_task_id")
    if task_id:
        env["SOPHIA_TASK_ID"] = str(task_id)
    run_id = _state_value(runtime, "run_id") or _state_value(runtime, "builder_run_id")
    if run_id:
        env["SOPHIA_RUN_ID"] = str(run_id)
    user_id_hash = stable_hash(_state_value(runtime, "user_id"))
    if user_id_hash:
        env["SOPHIA_USER_ID_HASH"] = user_id_hash
    build_id = _state_value(runtime, "current_deck_build_id") or _state_value(runtime, "deck_build_id")
    if build_id:
        env["SOPHIA_BUILD_ID"] = str(build_id)
        env["SOPHIA_DECK_BUILD_ID"] = str(build_id)
    env["SOPHIA_DECK_ROUTE"] = str(
        _state_value(runtime, "current_deck_route")
        or _state_value(runtime, "deck_route")
        or DEFAULT_DECK_ROUTE
    )
    env["SOPHIA_DECK_COMPILE_MODE"] = str(
        _state_value(runtime, "current_deck_compile_mode")
        or _state_value(runtime, "deck_compile_mode")
        or DEFAULT_DECK_COMPILE_MODE
    )
    env["SOPHIA_ARTIFACT_TARGET_EXT"] = str(
        _state_value(runtime, "current_deck_artifact_target_ext")
        or _state_value(runtime, "artifact_target_ext")
        or DEFAULT_ARTIFACT_TARGET_EXT
    )
    return env


def _image_subprocess_env(runtime: ToolRuntime) -> dict[str, str]:
    env = os.environ.copy()
    thread_data = get_thread_data(runtime) or {}
    if thread_data.get("outputs_path"):
        env["SOPHIA_OUTPUTS_HOST_PATH"] = str(thread_data["outputs_path"])
    if thread_data.get("workspace_path"):
        env["SOPHIA_WORKSPACE_HOST_PATH"] = str(thread_data["workspace_path"])
    env.update(_current_image_trace_env(runtime))
    return env


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _nonnegative_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


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
    per_image_timeout = _int_env("SOPHIA_IMAGE_GEN_TIMEOUT", 120)
    max_retries = _nonnegative_int_env("SOPHIA_IMAGE_GEN_MAX_RETRIES", 1)
    concurrency = _int_env("SOPHIA_IMAGE_GEN_CONCURRENCY", 2)
    item_count = max(1, _manifest_item_count_for_timeout(manifest_path, runtime))
    waves = max(1, (item_count + concurrency - 1) // concurrency)
    return max(_image_single_timeout_seconds(), waves * per_image_timeout * (max_retries + 1) + 60)


def _image_single_timeout_seconds() -> int:
    per_image_timeout = _int_env("SOPHIA_IMAGE_GEN_TIMEOUT", 120)
    max_retries = _nonnegative_int_env("SOPHIA_IMAGE_GEN_MAX_RETRIES", 1)
    return per_image_timeout * (max_retries + 1) + 30


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


def _parse_batch_item_progress(stdout: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if not line.startswith("IMAGEGEN_BATCH_ITEM "):
            continue
        try:
            payload = json.loads(line.removeprefix("IMAGEGEN_BATCH_ITEM ").strip())
        except ValueError:
            continue
        if isinstance(payload, dict):
            if "raw_error_excerpt" in payload:
                payload["raw_error_excerpt"] = safe_excerpt(payload["raw_error_excerpt"])
            items.append(payload)
    return items


def _image_generation_error_class_from_output(stderr: str, stdout: str, returncode: int) -> str:
    text = f"{stderr}\n{stdout}"
    match = re.search(r"IMAGEGEN_FAIL\s+reason=([A-Za-z0-9_:-]+)", text)
    if match:
        return match.group(1)
    if returncode == 2:
        return "process_exit"
    if "timed out" in text.lower() or "timeout" in text.lower():
        return "timeout"
    if "no bytes" in text.lower() or "empty output" in text.lower():
        return "empty_output"
    return "api_error"


def _summary_error_classes(summary: dict[str, Any]) -> set[str]:
    classes: set[str] = set()
    error_class = summary.get("error_class")
    if error_class:
        classes.add(str(error_class))
    histogram = summary.get("error_class_histogram")
    if isinstance(histogram, dict):
        classes.update(str(key) for key in histogram if key)
    items = summary.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get("error_class"):
                classes.add(str(item.get("error_class")))
    return classes


def _primary_error_class(summary: dict[str, Any]) -> str | None:
    classes = _summary_error_classes(summary)
    if classes:
        return sorted(classes)[0]
    return None


def _batch_summary_allows_serial_repair(summary: dict[str, Any]) -> bool:
    if summary.get("complete"):
        return False
    classes = _summary_error_classes(summary)
    if classes.intersection(_NON_REPAIRABLE_IMAGE_ERROR_CLASSES):
        return False
    if summary.get("summary_present", True):
        return bool(int(summary.get("requested") or 0) > int(summary.get("images_generated") or 0))
    return bool(summary.get("batch_attempted"))


def _safe_batch_summary(summary: dict[str, Any]) -> dict[str, Any]:
    payload = dict(summary)
    if "raw_error_excerpt" in payload:
        payload["raw_error_excerpt"] = safe_excerpt(payload["raw_error_excerpt"])
    items = payload.get("items")
    if isinstance(items, list):
        safe_items: list[Any] = []
        for item in items:
            if not isinstance(item, dict):
                safe_items.append(item)
                continue
            safe_item = dict(item)
            if "raw_error_excerpt" in safe_item:
                safe_item["raw_error_excerpt"] = safe_excerpt(safe_item["raw_error_excerpt"])
            for path_key in ("output_file", "output_path", "prompt_file"):
                if path_key in safe_item:
                    safe_item[path_key] = basename(safe_item[path_key])
            safe_items.append(safe_item)
        payload["items"] = safe_items
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
