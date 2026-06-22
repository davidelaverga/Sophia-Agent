"""Bounded visual QC for Sophia image-forward PPTX slides.

This helper performs one multimodal review of a rendered slide image against
the slide spec. It intentionally does not loop or repair; callers decide
whether to regenerate once or fall back to deterministic slide composition.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

_DEFAULT_QC_MODEL = "claude-sonnet-4-6"

_REVIEWER_PROMPT = """You are a strict slide QC reviewer. You are shown one rendered presentation slide and the
spec it must satisfy. Reply with JSON only: {"pass": true|false, "reasons": ["..."]}.

Fail (pass=false) if ANY is true:

Reliability:
- Any text is garbled, misspelled, cut off, overlapping, or hard to read.
- A title, label, or value required by the spec is missing or altered.
- The cover/this slide has no clearly legible title.

Design (the six axes):
- Philosophy: it looks like a generic template, not a deliberate slide for THIS topic.
- Hierarchy: a viewer cannot tell in two seconds what is primary vs secondary.
- Execution: misaligned, cramped, low-contrast, or visually sloppy.
- Specificity: placeholder, vague, or filler content instead of the real subject.
- Restraint: cluttered; elements that do not earn their place.
- Brand: wrong palette, clip-art, emoji, generic AI gradient, glossy 3D, or stock-photo look;
  or it clashes stylistically with the reference slide.

Otherwise pass=true. List only real defects, concisely.

Slide spec:
{slide_spec}
"""


def _json_result(passed: bool, reasons: list[str]) -> dict[str, Any]:
    return {"pass": bool(passed), "reasons": [str(reason)[:240] for reason in reasons[:5]]}


def _qc_parse_advisory_result(reason: str) -> dict[str, Any]:
    return {
        "pass": False,
        "advisory": True,
        "parser_error": True,
        "reasons": [reason[:240]],
    }


def _qc_unavailable_result(reason: str) -> dict[str, Any]:
    return {"pass": False, "skipped": True, "reasons": [reason[:240]]}


def _emit(payload: dict[str, Any]) -> int:
    passed = payload.get("pass") is True
    reasons = payload.get("reasons") if isinstance(payload.get("reasons"), list) else []
    print(
        f"[qc] PASS={passed} reasons={json.dumps(reasons, ensure_ascii=False)}",
        file=sys.stderr,
    )
    print(json.dumps(payload, ensure_ascii=False))
    if payload.get("pass") is True or payload.get("skipped") is True or payload.get("advisory") is True:
        return 0
    return 1


def _image_block(image_path: Path) -> dict[str, Any]:
    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    media_type = mimetypes.guess_type(str(image_path))[0] or "image/png"
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        },
    }


def _extract_text(response: Any) -> str:
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts).strip()


def parse_review(text: str) -> dict[str, Any]:
    clean = (text or "").strip()
    try:
        payload = json.loads(clean)
    except json.JSONDecodeError:
        start = clean.find("{")
        end = clean.rfind("}")
        if start < 0 or end <= start:
            return _qc_parse_advisory_result("QC reviewer returned non-JSON output")
        try:
            payload = json.loads(clean[start : end + 1])
        except json.JSONDecodeError:
            return _qc_parse_advisory_result("QC reviewer returned invalid JSON")
    reasons = payload.get("reasons")
    return _json_result(
        payload.get("pass") is True,
        [str(reason) for reason in reasons if isinstance(reason, str)] if isinstance(reasons, list) else [],
    )


def _ocr_text(image_file: Path) -> str:
    tesseract = shutil.which("tesseract")
    if not tesseract:
        return ""
    try:
        completed = subprocess.run(
            [tesseract, str(image_file), "stdout", "--psm", "6"],
            check=False,
            capture_output=True,
            text=True,
            timeout=12,
        )
    except Exception:
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout or ""


def _raster_layout_reasons(image_file: Path) -> list[str]:
    text = _ocr_text(image_file).upper()
    if not text:
        return []
    reasons: list[str] = []
    if "THE TEXT READS" in text:
        reasons.append("Generated bitmap still contains literal prompt text: THE TEXT READS")
    return reasons


def _combine_with_raster_checks(result: dict[str, Any], image_file: Path) -> dict[str, Any]:
    reasons = _raster_layout_reasons(image_file)
    if not reasons:
        return result
    combined = list(result.get("reasons") or [])
    combined.extend(reasons)
    return _json_result(False, [str(reason) for reason in combined])


def _input_error(image_file: Path, spec_file: Path, reference_image: Path | None) -> dict[str, Any] | None:
    if not image_file.is_file():
        return _json_result(False, [f"slide image missing: {image_file}"])
    if not spec_file.is_file():
        return _json_result(False, [f"slide spec missing: {spec_file}"])
    if reference_image is not None and not reference_image.is_file():
        return _json_result(False, [f"reference image missing: {reference_image}"])
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return _qc_unavailable_result("slide QC skipped: ANTHROPIC_API_KEY is not set")
    return None


def _anthropic_client() -> tuple[Any | None, dict[str, Any] | None]:
    try:
        import anthropic
    except ImportError:
        return None, _qc_unavailable_result("slide QC skipped: anthropic SDK is not installed")
    return anthropic.Anthropic(), None


def _review_content(image_file: Path, spec_file: Path, reference_image: Path | None) -> list[dict[str, Any]]:
    slide_spec = spec_file.read_text(encoding="utf-8").strip()
    content: list[dict[str, Any]] = [
        {"type": "text", "text": _REVIEWER_PROMPT.replace("{slide_spec}", slide_spec)},
        _image_block(image_file),
    ]
    if reference_image is not None:
        content.extend([
            {"type": "text", "text": "Reference slide:"},
            _image_block(reference_image),
        ])
    return content


def review_slide(
    *,
    image_file: Path,
    spec_file: Path,
    reference_image: Path | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    if error := _input_error(image_file, spec_file, reference_image):
        return error
    client, error = _anthropic_client()
    if error:
        return error
    content = _review_content(image_file, spec_file, reference_image)

    try:
        response = client.messages.create(
            model=model or os.environ.get("SOPHIA_SLIDE_QC_MODEL", _DEFAULT_QC_MODEL),
            max_tokens=400,
            temperature=0,
            messages=[{"role": "user", "content": content}],
        )
    except Exception as exc:  # noqa: BLE001 - QC fails closed, never loops.
        return _json_result(False, [f"slide QC call failed: {exc.__class__.__name__}"])
    return _combine_with_raster_checks(parse_review(_extract_text(response)), image_file)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one bounded QC pass on a rendered slide image")
    parser.add_argument("--image-file", required=True, help="Rendered slide PNG/JPEG to inspect")
    parser.add_argument("--spec-file", required=True, help="Text/JSON spec the slide was meant to satisfy")
    parser.add_argument("--reference-image", default=None, help="Optional first slide/reference image")
    parser.add_argument("--model", default=None, help="Reviewer model override; default SOPHIA_SLIDE_QC_MODEL")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    return _emit(
        review_slide(
            image_file=Path(args.image_file),
            spec_file=Path(args.spec_file),
            reference_image=Path(args.reference_image) if args.reference_image else None,
            model=args.model,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
