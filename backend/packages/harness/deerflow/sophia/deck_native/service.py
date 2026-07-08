from __future__ import annotations

import json
import re
import subprocess  # noqa: S404 - fixed vendored scripts with sanitized args.
import sys
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_native.errors import DeckNativePathError
from deerflow.sophia.deck_native.models import (
    NativeDeckInspectResult,
    NativeDeckLintFixResult,
    NativeDeckPatchResult,
    NativeDeckPreflight,
    NativeDeckRenderResult,
)
from deerflow.sophia.deck_native.paths import hands_on_deck_scripts_dir

_CLI_TIMEOUT_SECONDS = 180
_RENDER_TIMEOUT_SECONDS = 240
_ERROR_TEXT_LIMIT = 1200


class DeckNativeService:
    def __init__(self, *, python_executable: str | None = None, scripts_dir: Path | None = None) -> None:
        self._python = python_executable or sys.executable
        self._scripts_dir = scripts_dir or hands_on_deck_scripts_dir()
        self._deck_cli = self._scripts_dir / "deck.py"
        self._html2patch_cli = self._scripts_dir / "html2patch.py"

    def preflight(self) -> NativeDeckPreflight:
        scripts_dir_exists = self._scripts_dir.is_dir()
        deck_py_exists = self._deck_cli.is_file()
        html2patch_py_exists = self._html2patch_cli.is_file()
        errors: list[str] = []
        if not scripts_dir_exists:
            errors.append("hands-on-deck scripts directory not found")
        if not deck_py_exists:
            errors.append("hands-on-deck script not found: deck.py")
        if not html2patch_py_exists:
            errors.append("hands-on-deck script not found: html2patch.py")
        return NativeDeckPreflight(
            success=scripts_dir_exists and deck_py_exists and html2patch_py_exists,
            scripts_dir_exists=scripts_dir_exists,
            deck_py_exists=deck_py_exists,
            html2patch_py_exists=html2patch_py_exists,
            errors=errors,
        )

    def inspect(self, pptx_path: str, *, slide: int | None = None) -> NativeDeckInspectResult:
        pptx = _path_arg(pptx_path, "pptx_path", suffix=".pptx", must_exist=True)
        raw_json_path = _support_sidecar_path(pptx, f".slide-{slide}.inspect.json" if slide is not None else ".inspect.json")
        inventory_path = _support_sidecar_path(
            pptx,
            f".slide-{slide}.shape-inventory.json" if slide is not None else ".shape-inventory.json",
        )
        command = [self._python, str(self._deck_cli), str(pptx), "inspect", "-o", str(raw_json_path)]
        if slide is not None:
            command.extend(["--slide", str(slide)])
        completed = self._run(command)
        if completed.returncode != 0:
            return NativeDeckInspectResult(
                success=False,
                slide_count=0,
                shape_count=0,
                native_text_shape_count=0,
                picture_shape_count=0,
                full_slide_picture_count=0,
                native_editability_score=0.0,
                shape_inventory_path=None,
                raw_json_path=None,
                errors=_errors(completed),
            )
        try:
            payload = json.loads(raw_json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            return NativeDeckInspectResult(
                success=False,
                slide_count=0,
                shape_count=0,
                native_text_shape_count=0,
                picture_shape_count=0,
                full_slide_picture_count=0,
                native_editability_score=0.0,
                shape_inventory_path=None,
                raw_json_path=str(raw_json_path),
                errors=[f"inspect_json_unreadable: {type(exc).__name__}: {exc}"],
            )
        stats, inventory = _inspect_stats_and_inventory(payload)
        inventory_path.write_text(json.dumps(inventory, indent=2), encoding="utf-8")
        return NativeDeckInspectResult(
            success=True,
            slide_count=stats["slide_count"],
            shape_count=stats["shape_count"],
            native_text_shape_count=stats["native_text_shape_count"],
            picture_shape_count=stats["picture_shape_count"],
            full_slide_picture_count=stats["full_slide_picture_count"],
            native_editability_score=stats["native_editability_score"],
            shape_inventory_path=str(inventory_path),
            raw_json_path=str(raw_json_path),
            errors=[],
        )

    def html_to_patch(
        self,
        *,
        html_paths: list[str],
        base_deck_path: str,
        output_patch_path: str,
    ) -> NativeDeckPatchResult:
        if not html_paths:
            return NativeDeckPatchResult(False, None, None, 0, 1, ["html_paths must not be empty"])
        html = [_path_arg(path, "html_path", suffixes={".html", ".htm"}, must_exist=True) for path in html_paths]
        base = _path_arg(base_deck_path, "base_deck_path", suffix=".pptx", must_exist=True)
        patch = _path_arg(output_patch_path, "output_patch_path", suffix=".json", create_parent=True)
        patch.unlink(missing_ok=True)
        command = [
            self._python,
            str(self._html2patch_cli),
            *(str(path) for path in html),
            "--deck",
            str(base),
            "--layout",
            "Blank",
            "-o",
            str(patch),
        ]
        completed = self._run(command)
        if completed.returncode != 0:
            patch.unlink(missing_ok=True)
            return NativeDeckPatchResult(
                success=False,
                output_pptx_path=None,
                patch_path=None,
                patch_op_count=0,
                validation_error_count=_validation_error_count(completed),
                errors=_errors(completed),
            )
        return NativeDeckPatchResult(
            success=patch.is_file(),
            output_pptx_path=None,
            patch_path=str(patch) if patch.is_file() else None,
            patch_op_count=_patch_op_count(patch),
            validation_error_count=0,
            errors=[] if patch.is_file() else ["html2patch did not write patch output"],
        )

    def apply_patch(
        self,
        *,
        base_deck_path: str,
        patch_path: str,
        output_path: str,
        fix: bool = True,
    ) -> NativeDeckPatchResult:
        base = _path_arg(base_deck_path, "base_deck_path", suffix=".pptx", must_exist=True)
        patch = _path_arg(patch_path, "patch_path", suffix=".json", must_exist=True)
        output = _path_arg(output_path, "output_path", suffix=".pptx", create_parent=True)
        output.unlink(missing_ok=True)
        command = [
            self._python,
            str(self._deck_cli),
            str(base),
            "apply",
            str(patch),
            "-o",
            str(output),
            "--json",
        ]
        if fix:
            command.append("--fix")
        completed = self._run(command)
        if completed.returncode != 0 or not output.is_file():
            output.unlink(missing_ok=True)
            return NativeDeckPatchResult(
                success=False,
                output_pptx_path=None,
                patch_path=str(patch),
                patch_op_count=_patch_op_count(patch),
                validation_error_count=_validation_error_count(completed),
                errors=_errors(completed),
            )
        return NativeDeckPatchResult(
            success=True,
            output_pptx_path=str(output),
            patch_path=str(patch),
            patch_op_count=_patch_op_count(patch),
            validation_error_count=0,
            errors=[],
        )

    def lint_fix(
        self,
        *,
        pptx_path: str,
        touched_slides: list[int] | None = None,
    ) -> NativeDeckLintFixResult:
        pptx = _path_arg(pptx_path, "pptx_path", suffix=".pptx", must_exist=True)
        command = [self._python, str(self._deck_cli), str(pptx), "fix", "--in-place", "--json"]
        touched = [int(slide) for slide in touched_slides or [] if int(slide) >= 0]
        if touched:
            command.extend(["--slides", ",".join(str(slide) for slide in touched)])
        else:
            command.append("--all")
        completed = self._run(command)
        if completed.returncode != 0:
            return NativeDeckLintFixResult(
                success=False,
                lint_issue_count_before=0,
                fix_applied_count=0,
                residue_count=0,
                touched_slide_count=len(touched),
                residue=[],
                errors=_errors(completed),
            )
        try:
            payload = json.loads(completed.stdout)
        except ValueError:
            payload = {}
        fixed = payload.get("fixed") if isinstance(payload.get("fixed"), list) else []
        residue = payload.get("residue") if isinstance(payload.get("residue"), list) else []
        remaining = payload.get("remaining_issue_shapes") if isinstance(payload.get("remaining_issue_shapes"), list) else []
        residue_items = [item for item in residue if isinstance(item, dict)]
        return NativeDeckLintFixResult(
            success=True,
            lint_issue_count_before=len(fixed) + len(residue) + len(remaining),
            fix_applied_count=len(fixed),
            residue_count=len(residue),
            touched_slide_count=len(touched),
            residue=residue_items,
            errors=[],
            issue_kinds=_kind_counts(fixed, "action"),
            residue_kinds=_kind_counts(residue_items, "issue"),
        )

    def render(
        self,
        *,
        pptx_path: str,
        output_dir: str,
        slides: list[int] | None = None,
    ) -> NativeDeckRenderResult:
        pptx = _path_arg(pptx_path, "pptx_path", suffix=".pptx", must_exist=True)
        render_dir = _path_arg(output_dir, "output_dir", create_parent=True)
        render_dir.mkdir(parents=True, exist_ok=True)
        command = [self._python, str(self._deck_cli), str(pptx), "render", "-o", str(render_dir)]
        valid_slides = [int(slide) for slide in slides or [] if int(slide) >= 0]
        if valid_slides:
            command.extend(["--slide", ",".join(str(slide) for slide in valid_slides)])
        completed = self._run(command, timeout=_RENDER_TIMEOUT_SECONDS)
        rendered = len(list(render_dir.glob("slide-*.jpg")))
        return NativeDeckRenderResult(
            success=completed.returncode == 0 and rendered > 0,
            render_dir=str(render_dir) if render_dir.is_dir() else None,
            rendered_slide_count=rendered,
            errors=[] if completed.returncode == 0 else _errors(completed),
        )

    def diff(self, *, before_path: str, after_path: str) -> dict[str, Any]:
        before = _path_arg(before_path, "before_path", suffix=".pptx", must_exist=True)
        after = _path_arg(after_path, "after_path", suffix=".pptx", must_exist=True)
        completed = self._run([self._python, str(self._deck_cli), str(before), "diff", str(after)])
        text = (completed.stdout or completed.stderr or "").strip()
        return {
            "success": completed.returncode == 0,
            "changed": bool(text and text != "No structural differences."),
            "diff_text": text[:_ERROR_TEXT_LIMIT],
            "errors": [] if completed.returncode == 0 else _errors(completed),
        }

    def _run(self, command: list[str], *, timeout: int = _CLI_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[str]:
        _ensure_script(command[1])
        try:
            return subprocess.run(  # noqa: S603 - command is a sanitized argv list.
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self._scripts_dir,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout if isinstance(exc.stdout, str) else ""
            stderr = exc.stderr if isinstance(exc.stderr, str) else ""
            timeout_message = f"hands-on-deck subprocess timed out after {timeout}s"
            return subprocess.CompletedProcess(command, 124, stdout=stdout, stderr=f"{timeout_message}\n{stderr}".strip())


def _ensure_script(path: str) -> None:
    script = Path(path)
    if not script.is_file():
        raise DeckNativePathError(f"hands-on-deck script not found: {script}")


def _path_arg(
    value: str,
    label: str,
    *,
    suffix: str | None = None,
    suffixes: set[str] | None = None,
    must_exist: bool = False,
    create_parent: bool = False,
) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise DeckNativePathError(f"{label} must be a non-empty string path")
    path = Path(value).expanduser()
    normalized_suffix = path.suffix.lower()
    allowed = {suffix.lower()} if suffix else {item.lower() for item in suffixes or set()}
    if allowed and normalized_suffix not in allowed:
        raise DeckNativePathError(f"{label} must end with one of {sorted(allowed)}")
    if must_exist and not path.is_file():
        raise DeckNativePathError(f"{label} does not exist: {path}")
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _support_sidecar_path(pptx: Path, suffix: str) -> Path:
    support_dir = pptx.parent / ".builder" / "deck_native" / "inspect"
    support_dir.mkdir(parents=True, exist_ok=True)
    return support_dir / f"{pptx.stem}{suffix}"


def _errors(completed: subprocess.CompletedProcess[str]) -> list[str]:
    text = "\n".join(part.strip() for part in (completed.stderr, completed.stdout) if part and part.strip())
    if not text:
        return [f"process exited with code {completed.returncode}"]
    return [text[:_ERROR_TEXT_LIMIT]]


def _validation_error_count(completed: subprocess.CompletedProcess[str]) -> int:
    text = f"{completed.stdout}\n{completed.stderr}"
    match = re.search(r"(\d+)\s+validation error", text, re.I)
    if match:
        return int(match.group(1))
    if completed.returncode != 0:
        return 1
    return 0


def _patch_op_count(patch_path: Path) -> int:
    try:
        payload = json.loads(patch_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    ops = payload.get("ops") if isinstance(payload, dict) else None
    return len(ops) if isinstance(ops, list) else 0


def native_mechanical_report(
    *,
    inspect: NativeDeckInspectResult,
    lint_fix: NativeDeckLintFixResult,
    render: NativeDeckRenderResult,
    diff: dict[str, Any],
) -> dict[str, Any]:
    return {
        "inspect_success": inspect.success,
        "native_editability_score": inspect.native_editability_score,
        "native_text_shape_count": inspect.native_text_shape_count,
        "picture_shape_count": inspect.picture_shape_count,
        "full_slide_picture_count": inspect.full_slide_picture_count,
        "lint_fix_success": lint_fix.success,
        "lint_issue_count_before": lint_fix.lint_issue_count_before,
        "lint_fix_applied_count": lint_fix.fix_applied_count,
        "lint_residue_count": lint_fix.residue_count,
        "render_success": render.success,
        "rendered_slide_count": render.rendered_slide_count,
        "diff_success": bool(diff.get("success")),
        "diff_changed": bool(diff.get("changed")),
    }


def _inspect_stats_and_inventory(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    slide_size = payload.get("slide_size") if isinstance(payload.get("slide_size"), list) else [0, 0]
    slide_w = float(slide_size[0] or 0)
    slide_h = float(slide_size[1] or 0)
    slides = payload.get("slides") if isinstance(payload.get("slides"), dict) else {}
    shape_count = 0
    native_text_shape_count = 0
    picture_shape_count = 0
    full_slide_picture_count = 0
    inventory: dict[str, Any] = {"slides": {}}
    text_counts_by_slide: list[int] = []
    for raw_index, raw_shapes in sorted(slides.items(), key=lambda item: int(item[0])):
        slide_index = int(raw_index)
        shapes = raw_shapes if isinstance(raw_shapes, dict) else {}
        text_shapes: list[tuple[str, dict[str, Any]]] = []
        pictures: list[tuple[str, dict[str, Any]]] = []
        compact_shapes: list[dict[str, Any]] = []
        full_slide_pictures = 0
        for shape_id, shape in shapes.items():
            if not isinstance(shape, dict):
                continue
            shape_count += 1
            shape_type = str(shape.get("type") or "")
            is_text = _is_native_text_shape(shape)
            is_picture = shape_type == "PICTURE"
            is_full_slide_picture = False
            if is_text:
                native_text_shape_count += 1
                text_shapes.append((shape_id, shape))
            if is_picture:
                picture_shape_count += 1
                pictures.append((shape_id, shape))
                is_full_slide_picture = _is_full_slide_picture(shape, slide_w=slide_w, slide_h=slide_h)
                if is_full_slide_picture:
                    full_slide_picture_count += 1
                    full_slide_pictures += 1
            compact_shapes.append(
                {
                    "id": shape_id,
                    "name": shape.get("name"),
                    "type": shape_type,
                    "pos": shape.get("pos"),
                    "size": shape.get("size"),
                    "text_preview": _text_preview(shape),
                    "full_slide": is_full_slide_picture if is_picture else False,
                }
            )
        text_shapes.sort(key=lambda item: _shape_top(item[1]))
        pictures.sort(key=lambda item: _shape_area(item[1]), reverse=True)
        text_counts_by_slide.append(len(text_shapes))
        inventory["slides"][f"slide:{slide_index + 1}"] = {
            "native_slide_index": slide_index,
            "shape_count": len(shapes),
            "full_slide_picture_count": full_slide_pictures,
            "title": text_shapes[0][0] if text_shapes else None,
            "body": text_shapes[1][0] if len(text_shapes) > 1 else None,
            "visual": pictures[0][0] if pictures else None,
            "shapes": compact_shapes,
        }
    slide_count = int(payload.get("slide_count") or len(slides))
    has_native_titles = bool(slide_count and len(text_counts_by_slide) >= slide_count and all(count >= 1 for count in text_counts_by_slide))
    has_native_body_text = bool(slide_count and len(text_counts_by_slide) >= slide_count and all(count >= 2 for count in text_counts_by_slide))
    has_non_full_slide_shapes = shape_count > full_slide_picture_count
    has_expected_pictures_not_full_slide_screenshots = picture_shape_count == 0 or picture_shape_count > full_slide_picture_count
    score = min(
        1.0,
        (0.45 if has_native_titles else 0.0)
        + (0.25 if has_native_body_text else 0.0)
        + (0.20 if has_non_full_slide_shapes else 0.0)
        + (0.10 if has_expected_pictures_not_full_slide_screenshots else 0.0),
    )
    inventory["summary"] = {
        "slide_count": slide_count,
        "shape_count": shape_count,
        "native_text_shape_count": native_text_shape_count,
        "picture_shape_count": picture_shape_count,
        "full_slide_picture_count": full_slide_picture_count,
        "native_editability_score": round(score, 3),
    }
    return inventory["summary"], inventory


def _is_native_text_shape(shape: dict[str, Any]) -> bool:
    paragraphs = shape.get("paragraphs")
    if isinstance(paragraphs, list) and any(isinstance(item, dict) and item.get("text") for item in paragraphs):
        return True
    return "TEXT" in str(shape.get("type") or "")


def _is_full_slide_picture(shape: dict[str, Any], *, slide_w: float, slide_h: float) -> bool:
    if slide_w <= 0 or slide_h <= 0:
        return False
    pos = shape.get("pos") if isinstance(shape.get("pos"), list) else [0, 0]
    size = shape.get("size") if isinstance(shape.get("size"), list) else [0, 0]
    left, top = float(pos[0] or 0), float(pos[1] or 0)
    width, height = float(size[0] or 0), float(size[1] or 0)
    return left <= 0.15 and top <= 0.15 and width >= slide_w * 0.94 and height >= slide_h * 0.94


def _text_preview(shape: dict[str, Any]) -> str | None:
    paragraphs = shape.get("paragraphs")
    if not isinstance(paragraphs, list):
        return None
    text = " / ".join(str(item.get("text") or "").strip() for item in paragraphs if isinstance(item, dict) and item.get("text"))
    return text[:160] if text else None


def _shape_top(shape: dict[str, Any]) -> float:
    pos = shape.get("pos") if isinstance(shape.get("pos"), list) else [0, 0]
    return float(pos[1] or 0)


def _shape_area(shape: dict[str, Any]) -> float:
    size = shape.get("size") if isinstance(shape.get("size"), list) else [0, 0]
    return float(size[0] or 0) * float(size[1] or 0)


def _kind_counts(items: list[Any], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        normalized = value.strip().split(":", 1)[0][:80]
        counts[normalized] = counts.get(normalized, 0) + 1
    return counts
