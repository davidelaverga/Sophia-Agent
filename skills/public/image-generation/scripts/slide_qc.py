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
import sys
from pathlib import Path
from typing import Any

_DEFAULT_QC_MODEL = "claude-sonnet-4-6"

_REVIEWER_PROMPT = """You are a strict slide QC reviewer. You are shown one rendered presentation slide image
and the spec it was meant to satisfy. Reply with JSON only: {"pass": true|false, "reasons": ["..."]}.

Mark "pass": false if ANY of these are true:
- Any text is garbled, misspelled, cut off, overlapping, or hard to read.
- A title, label, or line required by the spec is missing or altered.
- The layout is collapsed, severely unbalanced, or has large empty dead zones.
- It is off-brand: wrong palette, clip-art, emoji, generic AI gradient, glossy 3D, or stock-photo look.
- It clashes stylistically with the reference slide (if one is provided).
Otherwise "pass": true. Be concise; list only real defects.

Slide spec:
{slide_spec}
"""


def _json_result(passed: bool, reasons: list[str]) -> dict[str, Any]:
    return {"pass": bool(passed), "reasons": [str(reason)[:240] for reason in reasons[:5]]}


def _emit(payload: dict[str, Any]) -> int:
    passed = payload.get("pass") is True
    reasons = payload.get("reasons") if isinstance(payload.get("reasons"), list) else []
    print(
        f"[qc] PASS={passed} reasons={json.dumps(reasons, ensure_ascii=False)}",
        file=sys.stderr,
    )
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("pass") is True else 1


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
            return _json_result(False, ["QC reviewer returned non-JSON output"])
        try:
            payload = json.loads(clean[start : end + 1])
        except json.JSONDecodeError:
            return _json_result(False, ["QC reviewer returned invalid JSON"])
    reasons = payload.get("reasons")
    return _json_result(
        payload.get("pass") is True,
        [str(reason) for reason in reasons if isinstance(reason, str)] if isinstance(reasons, list) else [],
    )


def _input_error(image_file: Path, spec_file: Path, reference_image: Path | None) -> dict[str, Any] | None:
    if not image_file.is_file():
        return _json_result(False, [f"slide image missing: {image_file}"])
    if not spec_file.is_file():
        return _json_result(False, [f"slide spec missing: {spec_file}"])
    if reference_image is not None and not reference_image.is_file():
        return _json_result(False, [f"reference image missing: {reference_image}"])
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return _json_result(False, ["slide QC unavailable: ANTHROPIC_API_KEY is not set"])
    return None


def _anthropic_client() -> tuple[Any | None, dict[str, Any] | None]:
    try:
        import anthropic
    except ImportError:
        return None, _json_result(False, ["slide QC unavailable: anthropic SDK is not installed"])
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
    return parse_review(_extract_text(response))


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
